/*
 * publoader operator dashboard.
 *
 * One classic script, no build step, no dependencies. Runs under a CSP with no
 * 'unsafe-inline', so every handler is attached with addEventListener and every
 * value is written with textContent; there is no innerHTML anywhere in this
 * file, which is what keeps operator-supplied strings (extension names, worker
 * names, error text) from becoming script.
 *
 * It is deliberately NOT an ES module: jsdom cannot execute module scripts at
 * all, and being able to drive this page under jsdom is worth more than the file
 * count. Sections are marked with banner comments instead.
 *
 * Shape of the thing:
 *   store        one client-side state object with subscribe/notify
 *   Resource     a fetched thing with loading/ready/error states, polling,
 *                and optimistic mutation with rollback
 *   live()       a region that redraws itself when its resources change
 *   NAV          the sidebar registry: destination, group, scope, tabs
 *   routing      #/<section>[/<param>][/<tab>]; the URL is the whole view state
 *
 * Authentication is the session cookie set by POST /api/v1/admin/session; the
 * admin token is never held in JS beyond the login submit.
 *
 * What the page offers is decided by GET /api/v1/admin/whoami: every destination
 * names the scope its view needs, and every control that mutates something is
 * either absent or visibly disabled without the scope behind it. That is
 * presentation only; the server checks the same scopes on every request, and
 * the integration suite asserts the refusals rather than trusting this file.
 */

"use strict";

const API = "/api/v1/admin";
const CSRF_HEADER = "x-requested-with";
const CSRF_VALUE = "publoader-dash";
const SUMMARY_MS = 10_000;
const WILDCARD = "*";
const NAV_KEY = "publoader.nav.collapsed";

// ---------------------------------------------------------------------- store

/**
 * The single client-side store. Views never read the DOM to find out what is
 * going on; they read this and subscribe to it, which is what lets one mutation
 * update every affected region without a reload.
 */
const store = {
  actor: null,
  role: null,
  userId: null,
  email: null,
  /** Scope set from GET /whoami. Empty until it answers. */
  scopes: [],
  /** "root" | "api-token" | "session". */
  kind: null,
  /** { section, param, tab }; parsed from the hash, the source of view truth. */
  route: { section: null, param: null, tab: null },
  navCollapsed: false,
  navOpen: false,
  /** Per-view filter state, kept here so a redraw does not lose it. */
  filters: {
    queueKind: "",
    queueState: "",
    queueDedupeKey: "",
    queueAttemptMin: "",
    queueAttemptMax: "",
    queueExtension: "",
    queueLanguage: "",
    queueQ: "",
    /** Keyset cursors already walked, so "Back" does not need a second scheme. */
    queueCursors: [],
    /**
     * The queue read as chapters. Separate keys from the row view above rather
     * than shared ones: the two answer different questions ("what is stuck" vs
     * "what is about to be published") and an operator switching tabs to check
     * the other should not find their filter rewritten.
     */
    queueChapterKind: "",
    queueChapterState: "PENDING",
    queueChapterQuery: "",
    queueChapterExtension: "",
    queueChapterLanguage: "",
    queueChapterCursors: [],
    /** What a run found, on the run detail page. */
    runChapterSet: "updated",
    runChapterQuery: "",
    runChapterSegment: "",
    runChapterPage: 0,
    /** The chapter archives (uploaded / edited / unavailable / deleted). */
    chapterExtension: "",
    chapterLanguage: "",
    chapterNumber: "",
    chapterSearch: "",
    /**
     * Cursors per archive, not one list: a cursor minted while reading
     * `uploaded` names a row `deleted` has never seen, so one shared list would
     * page the wrong table the moment a tab changed.
     */
    chapterCursors: {},
    untrackedState: "NEW",
    activitySeverity: "all",
    activityHours: 72,
    activityQuery: "",
    activityExtension: "",
    activityLimit: 100,
    /** Errors view: "without" | "with" | "only"; cleared entries hidden by default. */
    errorsCleared: "without",
    auditQuery: "",
    auditActor: "",
    auditAction: "",
    auditSince: "",
    auditUntil: "",
    auditOffset: 0,
  },
};

const subscribers = new Set();

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function notify(keys) {
  for (const fn of [...subscribers]) {
    try {
      fn(keys);
    } catch (err) {
      console.error("subscriber failed", err);
    }
  }
}

function setState(patch) {
  Object.assign(store, patch);
  notify(Object.keys(patch));
}

function setFilter(patch) {
  Object.assign(store.filters, patch);
  notify(["filters"]);
}

/**
 * Does the signed-in principal hold `required`?
 *
 * This mirrors `hasScope` in src/core/api/scopes.ts, including that write
 * implies append implies read within an area. Two copies of one rule is a
 * liability, so be clear about which is which: the server's copy is the
 * control, and this one exists only to decide what to draw. Getting this wrong
 * can hide a control the operator is entitled to, or show one that 403s; it
 * can never grant anything.
 */
function can(required) {
  for (const held of store.scopes) {
    if (held === WILDCARD || held === required) return true;
    const [area, verb] = held.split(":");
    if (verb === "write" && (required === `${area}:read` || required === `${area}:append`)) return true;
    if (verb === "append" && required === `${area}:read`) return true;
  }
  return false;
}

/**
 * Account administration needs the OWNER role on top of the scope, because an
 * api-token is never OWNER however broadly it is scoped (see requireOwner).
 * Checking both here is what keeps the owner-only destinations off the page for
 * a wildcard token that would still fail every request behind them.
 */
const isOwner = () => store.role === "OWNER" && can("users:admin");

/** Pushing to MangaDex from the untracked view is operator-level, not scoped. */
const isOperator = () => store.role === "OWNER" || store.role === "ADMIN";

// ------------------------------------------------------------------ resources

class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    // The parsed body, for the callers that need more than the first line;
 // the bundle preflight returns a list of reasons under a 422, and showing
    // only `error` would hide all but one of them.
    this.body = body ?? null;
  }
}

/**
 * One fetched thing, with the four states every list on this page has to be able
 * to show: loading, ready, empty (ready with nothing in it), and failed.
 *
 * `refreshing` is separate from `loading` on purpose. A poll over data already
 * on screen must not replace the table with a skeleton, that is a flash of
 * nothing every ten seconds, so it dims what is there instead.
 */
class Resource {
  constructor(name, fetcher) {
    this.name = name;
    this.fetcher = fetcher;
    this.status = "idle";
    this.data = null;
    this.error = null;
    this.at = 0;
    this.subs = new Set();
    this.inflight = null;
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit() {
    for (const fn of [...this.subs]) {
      try {
        fn(this);
      } catch (err) {
        console.error(`resource ${this.name} subscriber failed`, err);
      }
    }
  }

  async load({ force = false, quiet = false } = {}) {
    if (this.inflight) return this.inflight;
    // A redraw that re-reads a resource it already has must not re-request it,
    // or every keystroke in a filter box becomes a round trip.
    if (!force && this.status === "ready") return this.data;
    this.status = this.data === null ? "loading" : "refreshing";
    if (!quiet) this.emit();
    this.inflight = (async () => {
      try {
        this.data = await this.fetcher();
        this.status = "ready";
        this.error = null;
        this.at = Date.now();
      } catch (err) {
        // A 401 has already dropped the page back to the login screen; leaving
        // an error state behind would render it under the login layer.
        if (err instanceof ApiError && err.status === 401) throw err;
        this.status = "error";
        this.error = err;
      } finally {
        this.inflight = null;
        this.emit();
      }
      return this.data;
    })();
    try {
      return await this.inflight;
    } catch {
      return this.data;
    }
  }

  /**
   * Apply a change locally, then send it; and put the old value back if the
   * server refuses.
   *
   * Worth the machinery for the small edits (approve, skip, disable, rename)
   * where waiting for a round trip before anything moves reads as a dead click.
   * Anything that creates or destroys a thing goes through `act` instead, where
   * the pending state is on the button and there is nothing to guess at.
   */
  async optimistic(next, send) {
    const before = this.data;
    this.data = next(this.data);
    this.status = "ready";
    this.emit();
    try {
      const result = await send();
      await this.load({ force: true, quiet: true });
      return result;
    } catch (err) {
      this.data = before;
      this.status = "ready";
      this.emit();
      throw err;
    }
  }
}

/**
 * Every admin call goes through here: same-origin credentials (the session
 * cookie), the CSRF header the server demands on cookie-authenticated writes,
 * and a single place that drops back to the login screen on 401.
 */
async function api(path, opts) {
  const options = opts || {};
  const init = {
    method: options.method || "GET",
    credentials: "same-origin",
    headers: { [CSRF_HEADER]: CSRF_VALUE, accept: "application/json", ...(options.headers || {}) },
  };
  if (options.body !== undefined) {
    if (options.raw) {
      init.body = options.body;
    } else {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
  }

  const res = await fetch(API + path, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.status === 401 && !options.allow401) {
    showLogin(store.actor ? "Session expired. Sign in again." : "");
    throw new ApiError(401, "not authenticated");
  }
  const message = (data && (data.error || data.message)) || `${res.status} ${res.statusText}`;
  // A missing scope is a configuration answer, not a transient failure: naming
  // the scope is the difference between "it broke" and "your credential needs
  // runs:write". Probes pass `quiet` because a 403 is their expected answer.
  if (res.status === 403 && !options.quiet) {
    const scope = /^missing scope:\s*(\S+)/.exec(message);
    if (scope) toast(`Not permitted; this credential is missing the "${scope[1]}" scope.`, false);
  }
  if (!res.ok) throw new ApiError(res.status, message, data);
  return data;
}

/**
 * Ask the server what this principal is and may do.
 *
 * The page needs the whole scope set to decide what to draw: a CONTRIBUTOR must
 * not be shown a Workers destination that answers 403 on every request, and an
 * operator must not have a button hidden from them because the SPA guessed from
 * a role name.
 *
 * On failure the principal keeps whatever the session payload claimed and no
 * scopes, which renders the smallest possible surface. That is the right way to
 * fail: an operator who sees too few destinations reloads, whereas one who sees
 * too many learns by clicking.
 */
async function loadWhoami() {
  try {
    const me = await api("/whoami", { allow401: true, quiet: true });
    setState({
      scopes: Array.isArray(me.scopes) ? me.scopes : [],
      kind: me.kind ?? null,
      ...(me.role ? { role: me.role } : {}),
    });
  } catch {
    setState({ scopes: [], kind: null });
  }
}

// ---------------------------------------------------------------- DOM helpers

const $ = (id) => document.getElementById(id);

/**
 * Minimal element builder. `on*` keys become listeners, `text` becomes
 * textContent, `data-*` and everything else become attributes.
 */
function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "style") Object.assign(node.style, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  append(node, kids);
  return node;
}

function append(node, kids) {
  for (const kid of kids.flat(4)) {
    if (kid == null || kid === false || kid === "") continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
}

/**
 * Replace a node's children, dropping the conditional blanks.
 *
 * Always use this instead of `node.replaceChildren(...)` when any argument can
 * be null. `replaceChildren` takes `(Node or DOMString)`, so a null argument is
 * not skipped; it is stringified, and the page gets a literal "null" text node.
 * That is what put a "null" in front of every page title: the crumb argument is
 * null whenever the route has no parameter, which is most of the time.
 */
function setChildren(node, ...kids) {
  node.replaceChildren();
  append(node, kids);
}

/**
 * Icons, as inline SVG paths. Built with createElementNS rather than markup so
 * this file keeps its property that nothing is ever parsed as HTML.
 */
const ICONS = {
  overview: "M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm9 0h7v-9h-7v9Zm0-16v5h7V4h-7Z",
  runs: "M5 4l14 8-14 8V4Z",
  queues: "M4 7h16M4 12h16M4 17h10",
  activity: "M3 12h4l3 8 4-16 3 8h4",
  errors: "M12 4l9 16H3l9-16Zm0 5v6m0 3v.5",
  extensions: "M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm12.5 0v7m-3.5-3.5h7",
  chapters: "M6 3h8l4 4v14H6V3Zm8 0v4h4M9 12h6m-6 3.5h6",
  tracked: "M6 4h12v16l-6-4-6 4V4Z",
  chapters: "M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Zm4 3.5h7m-7 3.5h7",
  untracked: "M12 3l9 5v8l-9 5-9-5V8l9-5Zm0 6v4m0 3v.5",
  workers: "M4 17h16M6 17V9l6-4 6 4v8M10 17v-4h4v4",
  users: "M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-7 9c0-3.3 3.1-6 7-6s7 2.7 7 6",
  tokens: "M14 4a6 6 0 1 1-4.6 9.9L4 19v2h3v-2h2v-2h2l1.5-1.5A6 6 0 0 1 14 4Zm2.5 3.5h.01",
  permissions: "M6 11V8a6 6 0 0 1 12 0v3m-13 0h14v9H5v-9Zm7 3.5v2",
  audit: "M7 3h7l5 5v13H7V3Zm7 0v5h5M10 13h7m-7 4h7",
  system: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8 3.5-1.8.6-.7 1.7 1 1.6-1.6 1.6-1.6-1-1.7.7L13 19h-2l-.6-1.8-1.7-.7-1.6 1L5.5 16l1-1.6-.7-1.7L4 12v-2l1.8-.6.7-1.7-1-1.6L7.1 4.5l1.6 1 1.7-.7L11 3h2l.6 1.8 1.7.7 1.6-1 1.6 1.6-1 1.6.7 1.7L20 10v2Z",
  chevron: "M15 6l-6 6 6 6",
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6L6 18",
};

function icon(name, cls = "nav-icon") {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.setAttribute("class", cls);
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", ICONS[name] ?? ICONS.overview);
  svg.append(path);
  return svg;
}

const card = (title, ...kids) =>
  el("section", { class: "card" }, title ? el("h2", { text: title }) : null, ...kids);
const row = (...kids) => el("div", { class: "row" }, ...kids);

/**
 * A table that survives a phone.
 *
 * Every cell carries its column name in `data-label`, which is what lets the
 * stylesheet restack the rows as cards below 620px instead of showing a column
 * of unlabelled values. Wider than that it scrolls inside `.scroll`: never
 * taking the page sideways with it.
 */
function table(headers, rows, { empty, stack = true } = {}) {
  if (!rows.length) return emptyState(empty ?? "Nothing here.");
  return el(
    "div",
    { class: "scroll" },
    el(
      "table",
      { class: stack ? "stack" : null },
      el("thead", {}, el("tr", {}, headers.map((h) => el("th", { text: h })))),
      el(
        "tbody",
        {},
        rows.map((cells) =>
          el(
            "tr",
            {},
            cells.map((cell, index) => {
              const label = headers[index] || "";
              if (Array.isArray(cell)) {
                return el("td", { class: "actions row tight", "data-label": label }, cell);
              }
              if (cell && cell.nodeType) return el("td", { "data-label": label }, cell);
              return el("td", {
                "data-label": label,
                text: cell == null || cell === "" ? "-" : cell,
              });
            }),
          ),
        ),
      ),
    ),
  );
}

/** A definition list, for the "one thing, in full" panels. */
function defs(pairs) {
  return el(
    "dl",
    { class: "defs" },
    pairs
      .filter(Boolean)
      .map(([key, value]) => [
        el("dt", { text: key }),
        el("dd", {}, value && value.nodeType ? value : String(value ?? "-")),
      ]),
  );
}

const STATE_TONE = {
  // Enrolment tokens: PENDING is the one that matters; an unused token is a
  // live credential, so it is warned rather than greyed out.
  PENDING: "warn",
  USED: "ok",
  EXPIRED: "",
  REVOKED: "bad",
  PROCESSED: "ok",
  SUCCEEDED: "ok",
  COMMITTED: "ok",
  DONE: "ok",
  ACTIVE: "ok",
  TRACKED: "ok",
  CREATED: "ok",
  FAILED: "bad",
  DEAD_LETTER: "bad",
  QUARANTINED: "bad",
  REVOKED: "bad",
  CANCELLED: "warn",
  SKIPPED: "warn",
  DRAINED: "warn",
  EXECUTING: "busy",
  INGESTING: "busy",
  RUNNING: "busy",
  LEASED: "busy",
  CREATING: "busy",
  PENDING: "warn",
  enabled: "ok",
  approved: "ok",
  disabled: "bad",
  pending: "warn",
  OWNER: "busy",
};

const chip = (value) => el("span", { class: `chip ${STATE_TONE[value] || ""}`.trim(), text: value ?? "-" });

function fmtTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

/** Compact "how long ago", used where staleness is the signal. */
function ago(value) {
  if (!value) return "never";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "-";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/** Human-readable countdown; negative means the deadline has already passed. */
function duration(seconds) {
  const abs = Math.abs(Math.round(seconds));
  const parts =
    abs < 60
      ? `${abs}s`
      : abs < 3600
        ? `${Math.floor(abs / 60)}m ${abs % 60}s`
        : abs < 86_400
          ? `${Math.floor(abs / 3600)}h ${Math.floor((abs % 3600) / 60)}m`
          : `${Math.floor(abs / 86_400)}d ${Math.floor((abs % 86_400) / 3600)}h`;
  return seconds < 0 ? `${parts} ago` : `in ${parts}`;
}

const truncate = (text, max = 160) =>
  typeof text === "string" && text.length > max ? `${text.slice(0, max)}…` : text;

const mdTitleLink = (id, label) =>
  el("a", {
    href: `https://mangadex.org/title/${encodeURIComponent(id)}`,
    target: "_blank",
    rel: "noreferrer noopener",
    text: label ?? id,
  });

const mdChapterLink = (id, label) =>
  el("a", {
    href: `https://mangadex.org/chapter/${encodeURIComponent(id)}`,
    target: "_blank",
    rel: "noreferrer noopener",
    text: label ?? id,
  });

/** An internal link. A real anchor, so middle-click and "copy link" work. */
const routeLink = (hash, label, attrs = {}) => el("a", { href: hash, text: label, ...attrs });

function emptyState(message, ...extra) {
  return el(
    "div",
    { class: "empty" },
    typeof message === "string" ? el("p", { text: message }) : message,
    ...extra,
  );
}

/** A skeleton shaped like the table it is standing in for, so nothing shifts. */
function skeletonTable(rows = 5, cols = 4) {
  return el(
    "div",
    { class: "scroll" },
    el(
      "table",
      {},
      el(
        "tbody",
        {},
        Array.from({ length: rows }, () =>
          el(
            "tr",
            {},
            Array.from({ length: cols }, () =>
              el("td", {}, el("div", { class: "skeleton skeleton-line", text: "-" })),
            ),
          ),
        ),
      ),
    ),
  );
}

function skeletonGrid(count = 4) {
  return el(
    "div",
    { class: "grid tight" },
    Array.from({ length: count }, () =>
      el(
        "div",
        { class: "stat" },
        el("div", { class: "n skeleton", text: "00" }),
        el("div", { class: "k skeleton", text: "loading" }),
      ),
    ),
  );
}

function errorState(resource) {
  const message = resource.error?.message ?? "request failed";
  return el(
    "div",
    { class: "empty" },
    el("h3", { text: "That did not load" }),
    el("p", { class: "error", text: message }),
    el(
      "div",
      { class: "retry-row" },
      el("button", {
        type: "button",
        text: "Try again",
        onclick: (event) => {
          const button = event.currentTarget;
          button.dataset.pending = "true";
          void resource.load({ force: true });
        },
      }),
    ),
  );
}

/**
 * A button that is visibly disabled, and says why, when the principal lacks
 * `scope`.
 *
 * Disabling beats hiding for a destructive action a colleague might expect to
 * find: a greyed-out "Remove" that explains it needs `tracked:write` tells a
 * contributor the operation exists and who to ask, whereas an absent button
 * reads as a missing feature. The tooltip names the scope because that is the
 * only actionable part of the answer.
 */
function gatedButton(scope, attrs) {
  const allowed = can(scope);
  return el("button", {
    ...attrs,
    type: "button",
    disabled: !allowed || attrs.disabled === true,
    title: allowed ? (attrs.title ?? null) : `Needs the "${scope}" scope, which this account does not hold.`,
    onclick: allowed ? attrs.onclick : undefined,
  });
}

/**
 * Hand the browser a generated file. Used for the series-map export and
 * anything else the operator needs to round-trip through a text editor, so
 * "export, edit, paste back" never involves a file in git or a shell on the
 * host.
 */
function download(filename, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers; a turn of
  // the event loop is enough for it to have started.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Prev/next pager over `total` rows. */
function pager(total, page, size, onChange) {
  const pages = Math.max(1, Math.ceil(total / size));
  const clamped = Math.min(Math.max(page, 0), pages - 1);
  return row(
    el("button", { type: "button", text: "‹ Prev", disabled: clamped === 0, onclick: () => onChange(clamped - 1) }),
    el("span", { class: "dim small", text: `Page ${clamped + 1} of ${pages} · ${total} row(s)` }),
    el("button", {
      type: "button",
      text: "Next ›",
      disabled: clamped >= pages - 1,
      onclick: () => onChange(clamped + 1),
    }),
  );
}

// ------------------------------------------------------------------- feedback

function toast(message, ok = true) {
  const node = el("div", { class: `toast ${ok ? "ok" : "bad"}`, text: message });
  $("toasts").append(node);
  setTimeout(() => node.remove(), 6000);
}

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

let lastFocused = null;

/**
 * A modal that behaves like one: focus moves in, Tab cycles inside it, Escape
 * closes it, and focus goes back where it came from.
 *
 * `<dialog>` gives Escape and the backdrop for free but does not trap Tab in
 * every engine, so the keydown handler below does.
 */
function openModal(title, body) {
  const dialog = $("modal");
  lastFocused = document.activeElement;
  $("modal-title").textContent = title;
  $("modal-body").replaceChildren(body);
  if (!dialog.open) dialog.showModal();
  const first = dialog.querySelector(FOCUSABLE);
  (first ?? dialog).focus?.();
  return dialog;
}

function closeModal() {
  const dialog = $("modal");
  if (dialog.open) dialog.close();
  $("modal-body").replaceChildren();
  lastFocused?.focus?.();
  lastFocused = null;
}

function trapTab(event) {
  const dialog = $("modal");
  if (event.key !== "Tab" || !dialog.open) return;
  const nodes = [...dialog.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * A confirmation that has to be read rather than dismissed, for the actions
 * whose consequences are public. Returns a promise so the caller reads like the
 * `window.confirm` it replaces.
 */
function confirmDialog({ title, lead, points = [], confirmLabel, danger = true }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(value);
    };
    const body = el(
      "div",
      {},
      el("p", { text: lead }),
      points.length ? el("ul", { class: "errors" }, points.map((p) => el("li", { text: p }))) : null,
      el(
        "div",
        { class: "row end" },
        el("button", { type: "button", text: "Cancel", onclick: () => finish(false) }),
        el("button", {
          type: "button",
          class: danger ? "danger" : "primary",
          text: confirmLabel,
          onclick: () => finish(true),
        }),
      ),
    );
    const dialog = openModal(title, body);
    dialog.addEventListener("close", () => finish(false), { once: true });
  });
}

/**
 * Wrap a mutating call: show the button as pending, toast the outcome, and
 * reload whatever the change affected.
 */
async function act(label, fn, { button, refresh = [] } = {}) {
  const wasDisabled = button?.disabled ?? false;
  if (button) {
    button.dataset.pending = "true";
    button.disabled = true;
  }
  try {
    const result = await fn();
    toast(`${label}: ok`);
    for (const resource of refresh) void resource.load({ force: true });
    return result;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return undefined;
    toast(`${label}: ${err.message}`, false);
    return undefined;
  } finally {
    if (button) {
      delete button.dataset.pending;
      // Restore rather than enable: a scope-gated button was disabled before
      // this ran and must stay that way.
      button.disabled = wasDisabled;
    }
  }
}

// ------------------------------------------------------------- reactive regions

/** Teardowns for the currently mounted view, run on every navigation. */
let teardowns = [];
const onTeardown = (fn) => teardowns.push(fn);

function teardownView() {
  for (const fn of teardowns.splice(0)) {
    try {
      fn();
    } catch (err) {
      console.error("teardown failed", err);
    }
  }
}

/**
 * A region that redraws itself whenever any of its resources changes.
 *
 * This is the whole reactivity story: a mutation reloads a resource, the
 * resource emits, and every region bound to it redraws; no full-page reload,
 * and no view having to know which other views care.
 */
function live(resources, render, { reserve = 0, skeleton } = {}) {
  const host = el("div", { class: "live" });
  if (reserve) host.style.setProperty("--reserve", `${reserve}px`);

  const draw = () => {
    const loading = resources.some((r) => r.status === "loading" || r.status === "idle");
    const failed = resources.find((r) => r.status === "error");
    host.dataset.refreshing = String(resources.some((r) => r.status === "refreshing"));
    if (failed) return setChildren(host, errorState(failed));
    if (loading) return setChildren(host, skeleton ? skeleton() : skeletonTable());
    // setChildren, not replaceChildren: a view whose render returns nothing for
    // an empty payload would otherwise paint the string "undefined".
    return setChildren(host, render(...resources.map((r) => r.data)));
  };

  for (const resource of resources) onTeardown(resource.subscribe(draw));
  draw();
  for (const resource of resources) void resource.load();
  return host;
}

/** A region that redraws when named store keys change. */
function liveState(keys, render) {
  const host = el("div", { class: "live" });
  const draw = () => setChildren(host, render());
  onTeardown(
    subscribe((changed) => {
      if (changed.some((key) => keys.includes(key))) draw();
    }),
  );
  draw();
  return host;
}

// ------------------------------------------------------------- the nav registry

/**
 * Every destination in the sidebar: its group, its icon, the scope its view
 * needs to render at all, and the tabs inside it.
 *
 * A principal that lacks the scope never sees the destination; a CONTRIBUTOR
 * gets Overview, Extensions, Tracked and Untracked and nothing else. Hiding is
 * cosmetic and must be read that way: the server checks the same scope on every
 * endpoint behind every destination, and the integration suite asserts the
 * refusals rather than trusting this list. What it buys is that an operator is
 * never offered a control that cannot work.
 *
 * `param: true` means the section addresses one thing as well as a list, so
 * `#/extensions/mangaplus/series-map` and `#/audit/<id>` are routable. The
 * router tells a param from a tab by checking the tab ids first.
 */
const NAV = [
  {
    id: "overview",
    label: "Overview",
    group: null,
    icon: "overview",
    scope: "stats:read",
    tabs: [
      ["platform", "Platform"],
      ["mangadex", "MangaDex"],
    ],
    blurb: "Platform state, queue depths and the upload side's session.",
  },
  {
    id: "runs",
    label: "Runs",
    group: "Work",
    icon: "runs",
    scope: "runs:read",
    param: true,
    tabs: [
      ["recent", "Recent"],
      ["dead-letter", "Dead letter"],
    ],
    blurb: "Scrape runs and the jobs they fanned out into.",
  },
  {
    id: "queues",
    label: "Queues",
    group: "Work",
    icon: "queues",
    scope: "runs:read",
    // Chapters first, and that ordering is the default landing tab: the question
    // asked of this page far more often than any other is "what is about to go
    // up, and in what order". Tasks is the same rows keyed on queue mechanics;
 // one click away, and where incident work still happens.
    tabs: [
      ["chapters", "Chapters"],
      ["tasks", "Tasks"],
      ["depth", "Depth"],
    ],
    blurb: "What is about to be sent to MangaDex, and the durable rows behind it.",
  },
  {
    id: "activity",
    label: "Activity",
    group: "Work",
    icon: "activity",
    scope: "runs:read",
    blurb: "Runs, jobs, upload tasks, quarantine and audit in one timeline.",
  },
  {
    id: "errors",
    label: "Errors",
    group: "Work",
    icon: "errors",
    scope: "runs:read",
    tabs: [
      ["failures", "Failures"],
      ["quarantine", "Quarantine"],
    ],
    blurb: "Everything that failed, newest first.",
  },
  {
    id: "extensions",
    label: "Extensions",
    group: "Catalogue",
    icon: "extensions",
    scope: "extensions:read",
    param: true,
    // These are sections of ONE extension, not of the list: `#/extensions` is a
    // list with no tabs, and `#/extensions/<name>/config` is a tab of that
    // extension. Without this the list would canonicalise to
    // `#/extensions/overview`, a hash that names a tab the list does not have.
    tabsForParam: true,
    tabs: [
      ["overview", "Overview"],
      ["series-map", "Series map"],
      ["schedule", "Schedule"],
      ["config", "Config"],
      ["versions", "Versions"],
    ],
    blurb: "Published bundles, and everything about one extension.",
  },
  // Its own `chapters:read` rather than `runs:read`: reading this destination
  // is reading the public catalogue, and the three actions it offers end in a
  // MangaDex write, so it is gated separately from "may look at what the
  // platform is doing". Queueing one needs `chapters:write` AND the ADMIN role.
  {
    id: "chapters",
    label: "Chapters",
    group: "Catalogue",
    icon: "chapters",
    scope: "chapters:read",
    param: true,
    tabs: [
      ["uploaded", "On MangaDex"],
      ["unavailable", "Unavailable"],
      ["deleted", "Deleted"],
      ["edited", "Edited"],
    ],
    blurb: "Every chapter this platform has published, and what has happened to it since.",
  },
  {
    id: "tracked",
    label: "Tracked",
    group: "Catalogue",
    icon: "tracked",
    scope: "tracked:read",
    blurb: "The series map across every extension.",
  },
  {
    id: "untracked",
    label: "Untracked",
    group: "Catalogue",
    icon: "untracked",
    scope: "untracked:read",
    param: true,
    blurb: "Series the scrapers found that MangaDex does not have yet.",
  },
  {
    id: "workers",
    label: "Workers",
    group: "Fleet",
    icon: "workers",
    scope: "workers:read",
    tabs: [
      ["fleet", "Fleet"],
      ["enrolment", "Enrolment"],
    ],
    blurb: "The hosts that run extensions, and how to add one.",
  },
  // Account administration and credential minting are the two things an ADMIN
  // cannot do, and they need the OWNER role rather than a scope: a wildcard api
  // token holds users:admin but is never OWNER.
  {
    id: "users",
    label: "Users",
    group: "Admin",
    icon: "users",
    owner: true,
    tabs: [
      ["accounts", "Accounts"],
      ["sessions", "Sessions"],
      ["signups", "Signups"],
    ],
    blurb: "Operator accounts, their roles and their live sessions.",
  },
  {
    id: "tokens",
    label: "Tokens",
    group: "Admin",
    icon: "tokens",
    owner: true,
    tabs: [
      ["issued", "Issued"],
      ["mint", "Mint"],
    ],
    blurb: "Scoped per-client credentials.",
  },
  {
    id: "permissions",
    label: "Permissions",
    group: "Admin",
    icon: "permissions",
    owner: true,
    blurb: "What each role may do on this deployment.",
  },
  {
    id: "audit",
    label: "Audit",
    group: "Admin",
    icon: "audit",
    scope: "audit:read",
    param: true,
    blurb: "Who did what, and with which arguments.",
  },
  {
    id: "system",
    label: "System",
    group: "Admin",
    icon: "system",
    scope: "settings:read",
    tabs: [
      ["schema", "Schema"],
      ["mangadex", "MangaDex"],
      ["cards", "Unavailable cards"],
      ["backup", "Backup"],
    ],
    blurb: "The things that used to need a shell on the host.",
  },
  // Two views that live in their own ES modules (dashboard/sysops.js and
  // dashboard/docs.js). They are loaded on demand, see `lazyView`, so this
  // file stays a classic script while they stay modules.
  {
    id: "maintenance",
    label: "Maintenance",
    group: "Admin",
    icon: "system",
    scope: "bundles:read",
    blurb: "Fetch extension code from GitHub, install a bundle, restart a service.",
    module: "/dash/sysops.js",
    export: "viewSysops",
  },
  {
    id: "docs",
    label: "Docs",
    group: "Admin",
    icon: "audit",
    scope: "stats:read",
    blurb: "The operator handbook that ships with this build.",
    module: "/dash/docs.js",
    export: "viewDocs",
  },
];

const NAV_BY_ID = new Map(NAV.map((entry) => [entry.id, entry]));

const navAllowed = (entry) => (entry.owner ? isOwner() : !entry.scope || can(entry.scope));
const visibleNav = () => NAV.filter(navAllowed);

// -------------------------------------------------------------------- routing

/**
 * `#/<section>[/<param>][/<tab>]`.
 *
 * The URL is the whole view state, so every view is linkable and the back button
 * works without any history bookkeeping of our own. A tab is told from a param
 * by checking the section's own tab ids first; ids are uuids and extension
 * names, tab ids are a closed set of kebab words, so there is nothing to
 * disambiguate in practice.
 */
function parseRoute(hash = window.location.hash) {
  const raw = String(hash || "").replace(/^#\/?/, "");
  const legacy = translateLegacy(hash);
  if (legacy) return legacy;

  const parts = raw.split("/").filter(Boolean).map(decodeURIComponent);
  const section = parts[0] ?? null;
  const entry = NAV_BY_ID.get(section);
  if (!entry) return { section: null, param: null, tab: null };

  const tabIds = (entry.tabs ?? []).map(([id]) => id);
  let param = null;
  let tab = null;
  if (parts[1] != null) {
    if (tabIds.includes(parts[1]) && !(entry.param && parts[2] != null)) tab = parts[1];
    else if (entry.param) param = parts[1];
  }
  if (parts[2] != null && tabIds.includes(parts[2])) tab = parts[2];
  return { section, param, tab };
}

/**
 * Permalinks minted by earlier versions of this page, kept working.
 *
 * `#run/<id>`, `#audit/<id>` and `#tab/<name>` are pasted in chat and pinned in
 * runbooks; a link that has been shared is not ours to break.
 */
function translateLegacy(hash) {
  const match = /^#([a-z-]+)\/([\w:@.-]+)$/.exec(String(hash || ""));
  if (!match) return null;
  const [, type, id] = match;
  if (type === "tab") return NAV_BY_ID.has(id) ? { section: id, param: null, tab: null } : null;
  const mapped = {
    run: { section: "runs", param: id, tab: null },
    audit: { section: "audit", param: id, tab: null },
    "upload-task": { section: "queues", param: null, tab: "tasks" },
    submission: { section: "errors", param: null, tab: "quarantine" },
    job: { section: "errors", param: null, tab: "failures" },
  };
  return mapped[type] ?? null;
}

function routeTo(section, param, tab) {
  const parts = [section, param, tab].filter((p) => p != null && p !== "");
  return `#/${parts.map(encodeURIComponent).join("/")}`;
}

function navigate(hash, { replace = false } = {}) {
  if (hash === window.location.hash) return void renderRoute();
  if (replace) {
    window.history.replaceState(null, "", hash);
    renderRoute();
  } else {
    window.location.hash = hash;
  }
}

/**
 * Resolve the hash into a route this principal can actually open, and say so
 * when it cannot.
 */
function resolveRoute() {
  const wanted = parseRoute();
  const visible = visibleNav();
  if (!visible.length) return { section: null, param: null, tab: null };

  let entry = wanted.section ? NAV_BY_ID.get(wanted.section) : null;
  if (entry && !navAllowed(entry)) {
    toast(`That link points at ${entry.label}, which this account cannot open.`, false);
    entry = null;
  }
  // Land on the first destination this principal can use rather than assuming
  // Overview: a narrowly-scoped credential may not hold stats:read, and
  // defaulting to a view that 403s is the exact failure this gating removes.
  // Falling through rather than returning is deliberate; the fallback needs its
  // default tab filled in too, or the first URL of the session is a hash that
  // names no tab and does not match the one the view actually renders.
  const fellBack = !entry;
  if (fellBack) entry = visible[0];

  // A param from a route we refused belongs to a different section, so it is
  // dropped rather than carried onto the fallback.
  const param = entry.param && !fellBack ? wanted.param : null;
  const tabIds = entry.tabsForParam && !param ? [] : (entry.tabs ?? []).map(([id]) => id);
  return {
    section: entry.id,
    param,
    tab: tabIds.includes(wanted.tab) ? wanted.tab : (tabIds[0] ?? null),
  };
}

// ----------------------------------------------------------------- auth & shell

function showLogin(message) {
  stopSummaryPolling();
  teardownView();
  closeMenus();
  if ($("modal").open) $("modal").close();
  setState({ actor: null, role: null, userId: null, email: null, scopes: [], kind: null });
  $("app").hidden = true;
  $("login").hidden = false;
  $("login-error").textContent = message || "";
  $("login-token").value = "";
  $("login-password").value = "";
  $("login-link-sent").hidden = true;
  $("login-link-submit").disabled = false;
  $("view").replaceChildren();
  $("login-email").focus();
  // Also reached on a mid-session 401, so refresh what the page offers.
  void applyLoginMethods();
}

async function showApp(session) {
  setState({
    actor: session.actor,
    role: session.role,
    userId: session.userId ?? null,
    email: session.email ?? null,
  });
  $("login").hidden = true;
  $("app").hidden = false;
  await loadWhoami();
  renderIdentity();
  startSummaryPolling();
}

/** Render only the methods this deployment actually offers. */
async function applyLoginMethods() {
  try {
    const methods = await api("/session/methods", { allow401: true });
    $("login-discord-wrap").hidden = !methods.discord;
    $("login-link-form").hidden = !methods.magicLink;
    $("login-signups").hidden = !((methods.discord || methods.magicLink) && methods.signups);
  } catch {
    // A deployment that cannot answer still offers password + token login.
    $("login-discord-wrap").hidden = true;
    $("login-link-form").hidden = true;
  }
}

async function submitLogin(event, body, clear) {
  event.preventDefault();
  const button = event.submitter ?? event.target.querySelector('button[type="submit"]');
  $("login-error").textContent = "";
  if (button) {
    button.dataset.pending = "true";
    button.disabled = true;
  }
  try {
    const res = await api("/session", { method: "POST", body, allow401: true });
    clear();
    await showApp(res);
    renderRoute();
  } catch (err) {
    $("login-error").textContent = err.message;
  } finally {
    if (button) {
      delete button.dataset.pending;
      button.disabled = false;
    }
  }
}

const loginWithPassword = (event) =>
  submitLogin(
    event,
    { email: $("login-email").value.trim(), password: $("login-password").value },
    () => {
      $("login-password").value = "";
    },
  );

const loginWithToken = (event) =>
  submitLogin(
    event,
    // Trimmed like the actor beside it: a token is pasted, and a paste from a
    // terminal or password manager routinely brings a trailing newline with it.
    { token: $("login-token").value.trim(), actor: $("login-actor").value.trim() || undefined },
    () => {
      $("login-token").value = "";
    },
  );

/**
 * Ask for an emailed sign-in link.
 *
 * The server answers the same way whether or not the address has an account,
 * otherwise this endpoint would tell an anonymous caller who has one, so the
 * confirmation here is deliberately non-committal, and the button is left
 * disabled afterwards so a second click does not look like a way to find out.
 */
async function requestMagicLink(event) {
  event.preventDefault();
  const email = $("login-email").value.trim();
  const sent = $("login-link-sent");
  if (!email) {
    $("login-error").textContent = "Enter your email address first.";
    $("login-email").focus();
    return;
  }
  const button = $("login-link-submit");
  $("login-error").textContent = "";
  sent.hidden = true;
  button.dataset.pending = "true";
  button.disabled = true;
  try {
    const res = await api("/session/magic-link/request", {
      method: "POST",
      body: { email },
      allow401: true,
    });
    sent.textContent = res?.message ?? "If that address has an account, a sign-in link is on its way.";
    sent.hidden = false;
  } catch (err) {
    $("login-error").textContent = err.message;
    button.disabled = false;
  } finally {
    delete button.dataset.pending;
  }
}

/**
 * Take the sign-in secret out of the URL fragment, if there is one.
 *
 * The emailed link carries the secret after the `#` precisely so it never
 * reaches a server: not this one's request log, not a proxy's, and not a
 * Referer header. It is stripped from the address bar before anything is done
 * with it, so a reload or a shared screenshot cannot replay it.
 */
function takeMagicToken() {
  const match = /^#token=([\w.~-]+)$/.exec(window.location.hash || "");
  if (!match) return null;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return match[1];
}

/** Redeem a link. Returns the session payload, or null with the login screen up. */
async function redeemMagicToken(token) {
  try {
    return await api("/session/magic-link", { method: "POST", body: { token }, allow401: true });
  } catch (err) {
    showLogin(err.message);
    return null;
  }
}

/**
 * A session that got in with an emailed link has no password behind it, which
 * means every future sign-in needs another email. Say so once, on arrival, with
 * the fix one click away rather than buried in the profile menu.
 */
function promptForPasswordIfMissing(session) {
  if (session.hasPassword !== false || !store.userId) return;
  toast("Signed in with an email link; set a password to stop needing one.", true);
  passwordDialog({ id: store.userId, email: store.email ?? store.actor }, null);
}

async function logout() {
  try {
    await api("/session", { method: "DELETE", allow401: true });
  } finally {
    showLogin("Signed out.");
  }
}

/** What each role is for, named in the profile menu so the limits are not a surprise. */
const ROLE_BLURB = {
  OWNER: "Full control plane, including operator accounts, client tokens and database backups.",
  ADMIN: "Full control plane except operator accounts and client tokens.",
  CONTRIBUTOR:
    "Series-map curation and untracked triage. Adding mappings is allowed; changing or removing " +
    "an existing one needs an operator.",
};

function renderIdentity() {
  const role = store.role;
  $("whoami").textContent = store.actor ?? "";
  const badge = $("role-badge");
  badge.textContent = role ? role.toLowerCase() : "";
  badge.className = `badge ${role ? role.toLowerCase() : ""}`.trim();
  $("profile-detail").textContent =
    `${store.email ?? store.actor ?? "signed in"}${store.kind === "root" ? " · break-glass admin token" : ""}` +
    `${role ? `: ${ROLE_BLURB[role] ?? ""}` : ""}`;
}

// -------------------------------------------------------------- header summary

/**
 * The platform's state, live in the header: paused or running, how many workers
 * are up, how much is in flight, and when the last run was.
 *
 * Polled only while the tab is visible. A dashboard left open on a second
 * monitor overnight should not be the busiest client the API has.
 */
const summary = new Resource("summary", async () => {
  const [stats, runs] = await Promise.all([
    can("stats:read") ? api("/stats", { quiet: true }).catch(() => null) : Promise.resolve(null),
    can("runs:read") ? api("/runs?limit=1", { quiet: true }).catch(() => null) : Promise.resolve(null),
  ]);
  return { stats, lastRun: runs?.runs?.[0] ?? null };
});

let summaryTimer = null;

function startSummaryPolling() {
  stopSummaryPolling();
  summary.subscribe(renderSummary);
  void summary.load({ force: true });
  summaryTimer = setInterval(() => {
    if (!document.hidden && store.actor) void summary.load({ force: true, quiet: true });
  }, SUMMARY_MS);
}

function stopSummaryPolling() {
  if (summaryTimer) clearInterval(summaryTimer);
  summaryTimer = null;
}

const IN_FLIGHT_JOB_STATES = ["QUEUED", "LEASED", "EXECUTING", "INGESTING", "RUNNING"];

function renderSummary() {
  const data = summary.data;
  const stats = data?.stats ?? null;
  const pill = $("pause-pill");

  if (!stats) {
    pill.textContent = can("stats:read") ? "…" : "n/a";
    pill.className = "pill";
  } else {
    pill.textContent = stats.paused ? "paused" : "running";
    pill.className = stats.paused ? "pill warn" : "pill ok";
  }

  const workers = stats?.workers ?? {};
  const active = workers.ACTIVE ?? 0;
  const total = Object.values(workers).reduce((sum, n) => sum + n, 0);
  $("sum-workers").textContent = stats ? `${active}/${total}` : "-";

  const jobs = stats?.jobs ?? {};
  const inFlight = IN_FLIGHT_JOB_STATES.reduce((sum, state) => sum + (jobs[state] ?? 0), 0);
  $("sum-jobs").textContent = stats ? String(inFlight) : "-";

  const queued = (stats?.uploadTasks ?? [])
    .filter((t) => t.state === "PENDING" || t.state === "LEASED")
    .reduce((sum, t) => sum + t.count, 0);
  const queueNode = $("sum-queue");
  queueNode.textContent = stats ? String(queued) : "-";
  queueNode.className = `summary-n${stats && (stats.quarantined ?? 0) > 0 ? " bad" : ""}`;

  const run = data?.lastRun ?? null;
  $("sum-run").textContent = run
    ? `${run.extension} · ${String(run.state).toLowerCase()} · ${ago(run.updatedAt ?? run.createdAt)}`
    : can("runs:read")
      ? "none yet"
      : "-";

  // Outstanding failures are the one number in the header that is a problem
  // rather than a fact, so the count also lands on the Errors destination as a
  // badge. It counts what nobody has dealt with yet, NOT every failure on
  // record: a badge that nagged about failures the operator had already cleared
  // would teach them to ignore the badge.
  //
  // Only redrawn when it has actually changed: this runs on every poll, and
  // rebuilding the sidebar takes the keyboard focus with it; a ten-second timer
  // that steals focus mid-Tab makes the whole menu unusable without a mouse.
  const outstanding = navBadgeCount(stats);
  if (outstanding !== lastNavBadge) {
    lastNavBadge = outstanding;
    renderNav();
  }
}

// ----------------------------------------------------------------- the sidebar

/** Last outstanding-failure count drawn on the nav, so a poll can skip a rebuild. */
let lastNavBadge = 0;

/**
 * The Errors badge number: failures nobody has cleared.
 *
 * Falls back to the raw quarantine count when `errorsOutstanding` is absent, so
 * a dashboard served from a newer bundle than the core still shows a badge
 * instead of a silent zero.
 */
function navBadgeCount(stats) {
  return stats?.errorsOutstanding?.total ?? stats?.quarantined ?? 0;
}

function renderNav() {
  const nav = $("nav");
  if (!nav) return;
  const groups = [];
  for (const entry of visibleNav()) {
    const name = entry.group ?? "";
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.items.push(entry);
    else groups.push({ name, items: [entry] });
  }

  const outstanding = navBadgeCount(summary.data?.stats);

  nav.replaceChildren(
    ...groups.map((group) =>
      el(
        "div",
        { class: "nav-group" },
        group.name ? el("h2", { text: group.name }) : null,
        el(
          "ul",
          {},
          group.items.map((entry) => {
            const current = entry.id === store.route.section;
            const count = entry.id === "errors" && outstanding > 0 ? outstanding : null;
            return el(
              "li",
              {},
              el(
                "a",
                {
                  href: routeTo(entry.id, null, null),
                  title: entry.label,
                  "aria-current": current ? "page" : null,
                  onclick: () => closeDrawer(),
                },
                icon(entry.icon),
                el("span", { class: "nav-label", text: entry.label }),
                count
                  ? el("span", {
                      class: "nav-count bad",
                      text: String(count),
                      "aria-label": `${count} quarantined`,
                    })
                  : null,
              ),
            );
          }),
        ),
      ),
    ),
  );
}

function applyNavCollapsed(collapsed) {
  document.body.classList.toggle("nav-collapsed", collapsed);
  const button = $("nav-collapse");
  button.setAttribute("aria-expanded", String(!collapsed));
  button.setAttribute("aria-label", collapsed ? "Expand navigation" : "Collapse navigation");
  button.replaceChildren(
    icon("chevron", "nav-icon"),
    el("span", { class: "nav-collapse-label", text: "Collapse" }),
  );
  if (collapsed) button.querySelector("svg")?.setAttribute("transform", "rotate(180 12 12)");
  try {
    window.localStorage.setItem(NAV_KEY, collapsed ? "1" : "0");
  } catch {
    // Private browsing or a blocked origin: the preference simply does not
    // survive the reload. Nothing here depends on it.
  }
}

function openDrawer() {
  document.body.classList.add("nav-open");
  $("nav-scrim").hidden = false;
  $("sidebar").removeAttribute("inert");
  $("nav-toggle").setAttribute("aria-expanded", "true");
  $("sidebar").querySelector("a")?.focus();
  setState({ navOpen: true });
}

function closeDrawer() {
  if (!document.body.classList.contains("nav-open")) return;
  document.body.classList.remove("nav-open");
  $("nav-scrim").hidden = true;
  $("nav-toggle").setAttribute("aria-expanded", "false");
  setState({ navOpen: false });
  applyDrawerInert();
}

/**
 * A drawer that is off-canvas must not be reachable with Tab. `inert` is the
 * only thing that takes a whole subtree out of the tab order without hiding it
 * from the layout mid-transition.
 */
function applyDrawerInert() {
  const drawer = window.matchMedia?.("(max-width: 860px)")?.matches ?? false;
  const sidebar = $("sidebar");
  if (drawer && !document.body.classList.contains("nav-open")) sidebar.setAttribute("inert", "");
  else sidebar.removeAttribute("inert");
}

function toggleProfileMenu(open) {
  const menu = $("profile-menu");
  const wanted = open ?? menu.hidden;
  menu.hidden = !wanted;
  $("profile-toggle").setAttribute("aria-expanded", String(wanted));
  if (wanted) menu.querySelector(FOCUSABLE)?.focus();
}

function closeMenus() {
  toggleProfileMenu(false);
  closeDrawer();
}

// ------------------------------------------------------------------- the tabs

/**
 * Tabs inside a page, for that page's sections. Selecting one navigates, so the
 * tab is in the URL and a deep link restores it.
 */
function renderTabs(entry) {
  const host = $("tabs");
  const tabs = entry?.tabs ?? [];
  if (!tabs.length || store.route.param) {
    // A detail view (`#/audit/<id>`) is not one of the section's tabs, and
    // offering them there would navigate away from the thing being read.
    host.replaceChildren();
    return;
  }
  host.replaceChildren(
    ...tabs.map(([id, label]) =>
      el("button", {
        type: "button",
        role: "tab",
        id: `tab-${id}`,
        "aria-selected": String(id === store.route.tab),
        "aria-controls": "view",
        tabindex: id === store.route.tab ? "0" : "-1",
        text: label,
        onclick: () => navigate(routeTo(entry.id, null, id)),
        onkeydown: (event) => moveTabFocus(event, tabs, entry),
      }),
    ),
  );
}

/** Arrow keys move between tabs, which is what a tablist is supposed to do. */
function moveTabFocus(event, tabs, entry) {
  const keys = { ArrowLeft: -1, ArrowRight: 1, Home: "first", End: "last" };
  const move = keys[event.key];
  if (move === undefined) return;
  event.preventDefault();
  const ids = tabs.map(([id]) => id);
  const index = ids.indexOf(store.route.tab);
  const next =
    move === "first" ? 0 : move === "last" ? ids.length - 1 : (index + move + ids.length) % ids.length;
  navigate(routeTo(entry.id, null, ids[next]));
  $(`tab-${ids[next]}`)?.focus();
}

// -------------------------------------------------------------- the view host

/** Section id -> render(route) -> Node. Populated by the view sections below. */
const VIEWS = {};

const MODULES = new Map();

/**
 * What a module view is given so it does not have to reach into this file.
 *
 * dashboard/sysops.js and dashboard/docs.js are real ES modules with their own
 * fallbacks for every one of these, so the contract is "pass what you have".
 * Passing the shell's own helpers is what makes them look like the rest of the
 * page rather than like a widget embedded in it.
 */
const moduleHost = () => ({
  el,
  api,
  card,
  row,
  table,
  chip,
  defs,
  toast,
  can,
  // `confirm` is deliberately NOT passed. The module views call it
  // synchronously, `if (!confirm(msg)) return;`, and this shell's
  // `confirmDialog` is a promise, which is always truthy: handing it over would
  // turn every confirmation in those views into a no-op that always proceeds.
  // Their own fallback is `window.confirm`, which actually blocks.
  selectTab: (id) => navigate(routeTo(id, null, null)),
});

/**
 * A view that lives in its own module, fetched the first time it is opened.
 *
 * `import()` works from a classic script, which is the whole reason this file can
 * stay one; the modules stay modules, this stays drivable under jsdom, and
 * neither has to become the other. The cost is that the view arrives a frame
 * late, so it gets the same skeleton as any other async region.
 */
function lazyView(entry) {
  const host = el("div", { class: "live" });
  host.replaceChildren(skeletonTable(5, 3));
  let live = true;
  onTeardown(() => {
    live = false;
  });

  void (async () => {
    try {
      let mod = MODULES.get(entry.module);
      if (!mod) {
        mod = await import(entry.module);
        MODULES.set(entry.module, mod);
      }
      const build = mod[entry.export] ?? mod.default;
      if (typeof build !== "function") {
        throw new Error(`${entry.module} exports no ${entry.export}()`);
      }
      const node = await build(moduleHost());
      // The operator may have navigated on while this was in flight.
      if (live) host.replaceChildren(node);
    } catch (err) {
      console.error(`failed to load ${entry.module}`, err);
      if (!live) return;
      host.replaceChildren(
        card(
          entry.label,
          el("p", { class: "error", text: `This view could not be loaded: ${err.message}` }),
          el("p", {
            class: "dim small",
            text: `It lives in ${entry.module}, which the API serves from the dashboard directory. A 404 here means the build did not copy it alongside app.js.`,
          }),
        ),
      );
    }
  })();
  return host;
}

/**
 * Draw the whole shell for the current hash: sidebar selection, page heading,
 * tabs, and the view itself.
 *
 * Every navigation tears down the previous view's subscriptions first, so a
 * resource that is no longer on screen stops redrawing anything.
 */
function renderRoute() {
  if (!store.actor) return;
  const route = resolveRoute();
  setState({ route });
  teardownView();
  closeMenus();

  const entry = route.section ? NAV_BY_ID.get(route.section) : null;
  renderNav();
  renderTabs(entry);
  renderPageHead(entry, route);

  const host = $("view");
  if (!entry) {
    // Reachable for a credential scoped for one machine job (say bundles:write
    // for CI). Say what it holds rather than showing an empty page.
    host.replaceChildren(
      card(
        "Nothing to show",
        el("p", {
          text:
            "This credential holds no scope that the dashboard renders a view for. It can still be " +
            "used against the API directly.",
        }),
        el("p", { class: "dim", text: `Scopes: ${store.scopes.join(", ") || "none"}` }),
      ),
    );
    return;
  }

  // The canonical hash for where we ended up. Replacing rather than pushing
  // keeps "#/system" -> "#/system/schema" out of the back button's way.
  const canonical = routeTo(route.section, route.param, route.tab);
  if (window.location.hash !== canonical) window.history.replaceState(null, "", canonical);

  try {
    host.replaceChildren(entry.module ? lazyView(entry) : VIEWS[entry.id](route));
  } catch (err) {
    console.error(err);
    host.replaceChildren(card("Error", el("p", { class: "error", text: String(err.message ?? err) })));
  }
}

function renderPageHead(entry, route) {
  const head = $("page-head");
  if (!entry) return void head.replaceChildren();
  setChildren(
    head,
    route.param
      ? el(
          "p",
          { class: "crumb" },
          routeLink(routeTo(entry.id, null, null), entry.label),
          " / ",
          el("span", { text: truncate(route.param, 60) }),
        )
      : null,
    el("h1", { text: route.param ? truncate(route.param, 60) : entry.label }),
    entry.blurb && !route.param ? el("p", { class: "blurb", text: entry.blurb }) : null,
  );
}

// ------------------------------------------------------------------------ boot

async function boot() {
  $("login-form").addEventListener("submit", loginWithPassword);
  $("login-link-form").addEventListener("submit", requestMagicLink);
  $("login-token-form").addEventListener("submit", loginWithToken);
  $("login-token-toggle").addEventListener("click", () => {
    const form = $("login-token-form");
    form.hidden = !form.hidden;
    $("login-token-toggle").setAttribute("aria-expanded", String(!form.hidden));
    if (!form.hidden) $("login-token").focus();
  });

  $("logout").addEventListener("click", logout);
  $("profile-toggle").addEventListener("click", () => toggleProfileMenu());
  $("profile-account").addEventListener("click", () => {
    toggleProfileMenu(false);
    void accountDialog();
  });
  $("nav-toggle").addEventListener("click", () =>
    document.body.classList.contains("nav-open") ? closeDrawer() : openDrawer(),
  );
  $("nav-scrim").addEventListener("click", closeDrawer);
  $("nav-collapse").addEventListener("click", () => {
    const collapsed = !document.body.classList.contains("nav-collapsed");
    applyNavCollapsed(collapsed);
    setState({ navCollapsed: collapsed });
  });
  // The skip link cannot be left to the browser: the whole view state lives in
  // the hash, so navigating to `#view` would be read as a route and bounce the
  // operator to the default destination. Moving focus is the part that matters.
  document.querySelector(".skip-link")?.addEventListener("click", (event) => {
    event.preventDefault();
    $("view").focus();
  });
  $("nav-toggle").replaceChildren(icon("menu", null));
  $("modal-close").replaceChildren(icon("close", null));
  $("modal-close").addEventListener("click", closeModal);
  $("modal").addEventListener("keydown", trapTab);
  // Escape on a <dialog> fires `cancel`; the close handler is what restores
  // focus, so both routes end up in the same place.
  $("modal").addEventListener("close", () => {
    $("modal-body").replaceChildren();
    lastFocused?.focus?.();
    lastFocused = null;
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("profile-menu").hidden) {
      toggleProfileMenu(false);
      $("profile-toggle").focus();
    }
    if (document.body.classList.contains("nav-open")) {
      closeDrawer();
      $("nav-toggle").focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!$("profile-menu").hidden && !$("topbar-end-hit")) {
      const within = event.target.closest?.("#profile-menu, #profile-toggle");
      if (!within) toggleProfileMenu(false);
    }
  });

  // Restore the sidebar's remembered state before anything is drawn, so it does
  // not visibly collapse a frame after load.
  let collapsed = false;
  try {
    collapsed = window.localStorage.getItem(NAV_KEY) === "1";
  } catch {
    collapsed = false;
  }
  applyNavCollapsed(collapsed);
  store.navCollapsed = collapsed;
  applyDrawerInert();
  window.matchMedia?.("(max-width: 860px)")?.addEventListener?.("change", applyDrawerInert);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && store.actor) void summary.load({ force: true });
  });
  // Pasted permalinks and the back button take the same path. Only while signed
  // in: a hash change on the login screen must not try to open anything.
  window.addEventListener("hashchange", () => {
    if (store.actor) renderRoute();
  });
  // The module views ask to be navigated with an event rather than importing the
  // router, so that they work with or without a shell. Honour it.
  document.addEventListener("publoader:navigate", (event) => {
    const target = event.detail?.tab;
    if (target && NAV_BY_ID.has(target)) navigate(routeTo(target, null, null));
  });

  // An emailed sign-in link lands here with its secret in the fragment. Redeem
  // it before asking about an existing session: arriving with a link is an
  // explicit instruction to sign in as whoever that link belongs to.
  const magic = takeMagicToken();
  if (magic) {
    const redeemed = await redeemMagicToken(magic);
    if (!redeemed) return;
    await showApp(redeemed);
    renderRoute();
    promptForPasswordIfMissing(redeemed);
    return;
  }

  // The session cookie is HttpOnly, so the only way to know whether we are
  // signed in, and as whom, is to ask the API.
  let me;
  try {
    me = await api("/session", { allow401: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return showLogin("");
    showLogin(err.message);
    return;
  }
  await showApp(me);
  renderRoute();
  // Not the dialog this time; a returning session has already been told once,
  // and a modal on every page load is a thing people learn to dismiss.
  if (me.hasPassword === false) {
    toast("This account has no password; it can only sign in by email link.", false);
  }
}

// ============================================================================
// Views
// ============================================================================
//
// Each view is `render(route) -> Node`. Anything that fetches goes through a
// Resource created here, so navigating away tears its subscription down, and
// anything that mutates reloads the resources it affected; which is what makes
// one change show up everywhere it matters without a reload.

// ------------------------------------------------------------------- overview

/**
 * Job states that still owe something, worst first. Anything not on this list
 * (SUCCEEDED, CANCELLED, and any state added later) is settled and folds away;
 * listing the open ones rather than excluding the closed ones means a state
 * this dashboard has never heard of surfaces instead of vanishing.
 */
const OUTSTANDING_JOB_STATES = ["DEAD_LETTER", "RUNNING", "LEASED", "PENDING"];

/**
 * Jobs as work outstanding, on the same terms as the upload queue below it:
 * what still needs to happen up front, what already happened behind a
 * disclosure. SUCCEEDED grows without bound and drowns the four numbers an
 * operator opens this page to read.
 */
function outstandingJobsCard(jobs) {
  const entries = Object.entries(jobs).filter(([, count]) => count > 0);
  const open = entries
    .filter(([state]) => OUTSTANDING_JOB_STATES.includes(state))
    .sort(
      (a, b) => OUTSTANDING_JOB_STATES.indexOf(a[0]) - OUTSTANDING_JOB_STATES.indexOf(b[0]),
    );
  const settled = entries.filter(([state]) => !OUTSTANDING_JOB_STATES.includes(state));
  const settledTotal = settled.reduce((sum, [, count]) => sum + count, 0);

  return card(
    "Jobs outstanding",
    entries.length
      ? el(
          "div",
          {},
          open.length
            ? el(
                "div",
                { class: "grid tight" },
                open.map(([state, count]) =>
                  el(
                    "div",
                    { class: "stat" },
                    el("div", { class: "n", text: String(count) }),
                    el("div", { class: "k" }, chip(state)),
                  ),
                ),
              )
            : emptyState("Nothing outstanding; every job has finished."),
          settled.length
            ? el(
                "details",
                {},
                el("summary", { text: `Settled (${settledTotal.toLocaleString()})` }),
                table(
                  ["State", "Count"],
                  settled
                    .slice()
                    .sort((a, b) => a[0].localeCompare(b[0]))
                    .map(([state, count]) => [chip(state), String(count)]),
                  { empty: "Nothing has finished yet." },
                ),
              )
            : null,
        )
      : emptyState("No jobs have been created yet."),
  );
}

VIEWS.overview = (route) => {
  if (route.tab === "mangadex") return mangadexPanel();

  const stats = new Resource("stats", () => api("/stats"));
  onTeardown(summary.subscribe(() => void stats.load({ force: true, quiet: true })));

  const pauseControls = liveState(["scopes"], () => {
    const minutes = el("input", {
      type: "number",
      id: "pause-minutes",
      min: "1",
      max: "1440",
      value: "60",
      "aria-label": "Pause duration in minutes",
    });
    if (!can("settings:write")) {
      return el("p", {
        class: "dim",
        text: 'Pausing and resuming needs the "settings:write" scope, which this account does not hold.',
      });
    }
    return row(
      el("label", { class: "inline", for: "pause-minutes", text: "For" }),
      minutes,
      el("span", { class: "dim small", text: "minutes" }),
      el("button", {
        type: "button",
        text: "Pause",
        onclick: (event) =>
          act("pause", () => api("/pause", { method: "POST", body: { minutes: Number(minutes.value) || 60 } }), {
            button: event.currentTarget,
            refresh: [stats, summary],
          }),
      }),
      el("button", {
        type: "button",
        text: "Pause indefinitely",
        onclick: async (event) => {
          const button = event.currentTarget;
          if (!(await confirmDialog({
            title: "Pause the platform",
            lead: "Nothing will be scheduled and no job will be leased until somebody resumes it explicitly.",
            points: ["There is no timer to fall back on; an indefinite pause outlives everyone's memory of it."],
            confirmLabel: "Pause indefinitely",
          }))) {
            return;
          }
          await act("pause", () => api("/pause", { method: "POST", body: {} }), {
            button,
            refresh: [stats, summary],
          });
        },
      }),
      el("button", {
        type: "button",
        class: "primary",
        text: "Resume",
        onclick: (event) =>
          act("resume", () => api("/resume", { method: "POST", body: {} }), {
            button: event.currentTarget,
            refresh: [stats, summary],
          }),
      }),
    );
  });

  const counts = (title, entries, emptyText) =>
    card(
      title,
      entries.length
        ? el(
            "div",
            { class: "grid tight" },
            entries.map(([key, value]) =>
              el(
                "div",
                { class: "stat" },
                el("div", { class: "n", text: String(value) }),
                el("div", { class: "k", text: key }),
              ),
            ),
          )
        : el("p", { class: "dim", text: emptyText }),
    );

  return el(
    "div",
    {},
    card(
      "Platform",
      live(
        [stats],
        (data) =>
          el(
            "div",
            {},
            data.paused
              ? el("div", { class: "banner", text: "Scheduling is paused. No new jobs will be leased." })
              : el("p", { class: "ok-text", text: "Scheduling is running." }),
            pauseControls,
          ),
        { reserve: 96, skeleton: () => el("div", { class: "skeleton skeleton-line", style: { height: "70px" } }) },
      ),
    ),
    live(
      [stats],
      (data) =>
        el(
          "div",
          {},
          outstandingJobsCard(data.jobs || {}),
          counts("Workers by status", Object.entries(data.workers || {}), "No worker has ever enrolled."),
          card(
            "Upload queue: outstanding",
            (data.uploadTasks || []).length
              ? outstandingTasks(data.uploadTasks, {
                  emptyText: "Nothing outstanding; every queued upload has been published.",
                })
              : emptyState("Nothing has ever been queued for upload."),
          ),
          card(
            "Quarantine",
            data.quarantined
              ? el(
                  "div",
                  {},
                  el("p", { class: "error", text: `${data.quarantined} quarantined result submission(s).` }),
                  row(routeLink(routeTo("errors", null, "quarantine"), "Open the quarantine →")),
                )
              : el("p", { class: "dim", text: "Nothing is quarantined." }),
          ),
        ),
      { reserve: 320, skeleton: () => el("div", {}, skeletonGrid(4), skeletonTable(3, 3)) },
    ),
  );
};

/**
 * MangaDex session state. An expired session is why the upload queue stops
 * draining, which is the only reason it is worth a view of its own.
 */
function mangadexPanel() {
  const auth = new Resource("mangadex-auth", () => api("/mangadex/auth", { quiet: true }));

  return card(
    "MangaDex session",
    live(
      [auth],
      (data) => {
        const status = !data.hasAccess
          ? "no saved session"
          : data.expired
            ? "expired"
            : data.expiresInSeconds === null
              ? "saved, expiry unknown"
              : "active";
        return el(
          "div",
          {},
          row(
            chip(status === "active" ? "ACTIVE" : status === "expired" ? "FAILED" : "pending"),
            el("span", {
              class: "dim",
              text:
                data.expiresInSeconds === null
                  ? data.hasAccess
                    ? "Access token present; its expiry could not be read."
                    : "The next upload will authenticate from the configured credentials."
                  : `Access token expires ${duration(data.expiresInSeconds)} (${fmtTime(data.expiresAt)}).`,
            }),
          ),
          el("p", {
            class: "dim",
            text: `Refresh token ${data.hasRefresh ? "present" : "absent"}. Tokens are never shown here.`,
          }),
          row(
            gatedButton("settings:write", {
              class: "danger",
              text: "Clear saved session",
              onclick: async (event) => {
                const button = event.currentTarget;
                if (!(await confirmDialog({
                  title: "Forget the saved MangaDex session",
                  lead: "The next upload re-authenticates from the configured credentials.",
                  points: [
                    "In-flight uploads may fail once and retry.",
                    "This does not revoke anything on MangaDex's side.",
                  ],
                  confirmLabel: "Forget it",
                }))) {
                  return;
                }
                await act("mangadex_auth.clear", () => api("/mangadex/auth/clear", { method: "POST", body: {} }), {
                  button,
                  refresh: [auth],
                });
              },
            }),
          ),
        );
      },
      { reserve: 150, skeleton: () => el("div", { class: "skeleton skeleton-line", style: { height: "120px" } }) },
    ),
  );
}

// ----------------------------------------------------------------------- runs

VIEWS.runs = (route) => {
  if (route.param) return runDetail(route.param);
  if (route.tab === "dead-letter") return deadLetterPanel();

  const runs = new Resource("runs", () => api("/runs?limit=50"));

  return card(
    "Recent runs",
    live(
      [runs],
      ({ runs: rows }) =>
        table(
          ["Extension", "Kind", "State", "Chapters found", "Segments", "Triggered by", "Created", "Error"],
          rows.map((run) => [
            routeLink(routeTo("runs", run.id, null), run.extension),
            run.kind,
            chip(run.state),
            // null means no segment has committed an envelope yet, which is not
            // the same as a run that found nothing, so it reads "-", not "0".
            run.chaptersFound == null
              ? "-"
              : el(
                  "span",
                  {},
                  el("strong", { text: String(run.chaptersFound) }),
                  run.chaptersSeen == null
                    ? null
                    : el("span", { class: "dim small", text: ` of ${run.chaptersSeen} seen` }),
                ),
            String(run.segmentsTotal),
            run.triggeredBy,
            fmtTime(run.createdAt),
            truncate(run.error, 80),
          ]),
          { empty: "No run has been created yet. Trigger one from an extension." },
        ),
      { reserve: 260, skeleton: () => skeletonTable(6, 8) },
    ),
  );
};

function deadLetterPanel() {
  const dead = new Resource("dead-letter", () => api("/dead-letter"));
  return card(
    "Dead letter",
    el("p", {
      class: "dim",
      text: "Jobs that exhausted their attempt budget. Replaying one gives it a fresh budget on the same segment.",
    }),
    live(
      [dead],
      ({ jobs }) =>
        table(
          ["Extension", "Class", "Attempts", "Last error", "Updated", ""],
          jobs.map((job) => [
            job.extension,
            chip(job.errorClass || "DEAD_LETTER"),
            `${job.attempt}/${job.maxAttempts}`,
            truncate(job.lastError, 120),
            fmtTime(job.updatedAt),
            [
              routeLink(routeTo("runs", job.runId, null), "Open run", { class: "button-link inline" }),
              gatedButton("runs:write", {
                class: "primary",
                text: "Replay",
                onclick: (event) =>
                  act("job.retry", () => api(`/jobs/${job.id}/retry`, { method: "POST", body: {} }), {
                    button: event.currentTarget,
                    refresh: [dead, summary],
                  }),
              }),
            ],
          ]),
          { empty: "Nothing is dead-lettered." },
        ),
      { reserve: 200, skeleton: () => skeletonTable(4, 6) },
    ),
  );
}

/** One run and every segment it fanned out into. */
function runDetail(runId) {
  const run = new Resource(`run:${runId}`, async () => (await api(`/runs/${encodeURIComponent(runId)}`)).run);

  return live(
    [run],
    (data) =>
      el(
        "div",
        {},
        card(
          null,
          row(chip(data.state), el("span", { class: "dim", text: `${data.kind} · ${data.extension}` })),
          defs([
            ["Run", el("code", { text: data.id })],
            ["Extension", `${data.extension} @ ${data.extensionVersion}`],
            ["Bundle", el("code", { text: data.bundleSha256 ?? "-" })],
            ["Triggered by", data.triggeredBy || "-"],
            ["Created", fmtTime(data.createdAt)],
            ["Started", fmtTime(data.startedAt)],
            ["Completed", fmtTime(data.completedAt)],
            ["Error", data.error || "-"],
          ]),
          row(
            routeLink(routeTo("extensions", data.extension, "overview"), "Open the extension", {
              class: "button-link inline",
            }),
            copyLinkButton(routeTo("runs", data.id, null)),
          ),
        ),
        card(
          "Jobs",
          table(
            ["Segment", "State", "Attempts", "Lease holder", "Lease expires", "Last error", ""],
            (data.jobs || []).map((job) => [
              `${job.segmentIndex + 1}/${job.segmentTotal}`,
              chip(job.state),
              `${job.attempt}/${job.maxAttempts}`,
              job.leaseWorkerId ? el("code", { text: job.leaseWorkerId.slice(0, 8) }) : "-",
              fmtTime(job.leaseExpiresAt),
              truncate(job.lastError, 200),
              [
                gatedButton("runs:write", {
                  text: "Cancel",
                  onclick: (event) =>
                    act("job.cancel", () => api(`/jobs/${job.id}/cancel`, { method: "POST", body: {} }), {
                      button: event.currentTarget,
                      refresh: [run, summary],
                    }),
                }),
                gatedButton("runs:write", {
                  text: "Retry",
                  onclick: (event) =>
                    act("job.retry", () => api(`/jobs/${job.id}/retry`, { method: "POST", body: {} }), {
                      button: event.currentTarget,
                      refresh: [run, summary],
                    }),
                }),
              ],
            ]),
            { empty: "This run produced no segments." },
          ),
        ),
        runChaptersCard(runId),
      ),
    { reserve: 400, skeleton: () => el("div", {}, skeletonTable(8, 2), skeletonTable(4, 6)) },
  );
}

// ------------------------------------------------- what a run actually found

const RUN_CHAPTER_PAGE = 100;

/**
 * The chapters an extension reported on one run.
 *
 * This is the envelope the worker submitted, read back; not a copy of it. The
 * run/job/segment model above says whether the scrape worked; this says what it
 * found.
 *
 * Two sets, because an envelope carries two different things and conflating
 * them would misreport both. `updated` is what the extension flagged as new or
 * changed, and is the set the processor turns into upload and edit tasks. `all`
 * is the optional whole-catalogue snapshot that drives removal detection; many
 * extensions do not send one, and the summary says so rather than showing an
 * empty list that reads as "found nothing".
 */
/**
 * Which run's filters are currently in the store. Opening a DIFFERENT run must
 * not inherit the last one's search and page number (page 4 of a run with one
 * page is an empty table), but a redraw of the SAME run, a job cancel refreshes
 * the detail resource, must not wipe what the operator just typed.
 */
let runChapterFilterFor = null;

function runChaptersCard(runId) {
  if (runChapterFilterFor !== runId) {
    runChapterFilterFor = runId;
    // Assigned directly rather than through setFilter: this runs inside a
    // render, and notifying subscribers mid-render would redraw the region
    // currently being built.
    Object.assign(store.filters, { runChapterQuery: "", runChapterSegment: "", runChapterPage: 0 });
  }

  const f = () => store.filters;
  const set = () => f().runChapterSet;

  const summary = new Resource(`run-chapters-summary:${runId}`, () =>
    api(`/runs/${encodeURIComponent(runId)}/chapters/summary?set=${encodeURIComponent(set())}`),
  );

  const listQuery = () => {
    const q = new URLSearchParams({
      set: set(),
      limit: String(RUN_CHAPTER_PAGE),
      offset: String(f().runChapterPage * RUN_CHAPTER_PAGE),
    });
    if (f().runChapterQuery) q.set("q", f().runChapterQuery);
    if (f().runChapterSegment !== "") q.set("segmentIndex", f().runChapterSegment);
    return q;
  };
  const chapters = new Resource(`run-chapters:${runId}`, () =>
    api(`/runs/${encodeURIComponent(runId)}/chapters?${listQuery()}`),
  );

  const reload = () => {
    void summary.load({ force: true });
    void chapters.load({ force: true });
  };
  /** Any change to what is being asked for invalidates the page number. */
  const refilter = (patch) => {
    setFilter({ ...patch, runChapterPage: 0 });
    reload();
  };

  const setPicker = el(
    "select",
    {
      id: "run-chapter-set",
      onchange: (event) => refilter({ runChapterSet: event.target.value }),
    },
    el("option", { value: "updated", text: "New or changed", selected: set() === "updated" }),
    el("option", { value: "all", text: "Full catalogue snapshot", selected: set() === "all" }),
  );

  const search = el("input", {
    id: "run-chapter-q",
    type: "search",
    value: f().runChapterQuery,
    placeholder: "series, title, number or source id",
    onchange: (event) => refilter({ runChapterQuery: event.target.value.trim() }),
  });

  return card(
    "Chapters found",
    el("p", {
      class: "dim small",
      text:
        "Read straight out of the result envelopes this run's workers submitted; the extension's own " +
        "report, in the order it reported it, before the processor decided anything.",
    }),
    live([summary], (data) => runChapterSummary(data, refilter), {
      reserve: 120,
      skeleton: () => skeletonGrid(4),
    }),
    row(
      el("span", { class: "row tight" }, el("label", { class: "inline", for: "run-chapter-set", text: "Set" }), setPicker),
      el("span", { class: "row tight" }, el("label", { class: "inline", for: "run-chapter-q", text: "Search" }), search),
      el("button", {
        type: "button",
        text: "Clear",
        onclick: () => refilter({ runChapterQuery: "", runChapterSegment: "" }),
      }),
    ),
    live(
      [chapters],
      (data) => {
        const rows = data.chapters ?? [];
        return el(
          "div",
          {},
          table(
            ["#", "Series", "Chapter", "Volume", "Title", "Lang", "Released", "Segment", ""],
            rows.map((entry) => {
              const c = entry.chapter ?? {};
              return [
                String(entry.position),
                c.mdMangaId
                  ? mdTitleLink(c.mdMangaId, c.mangaName || c.mangaId || c.mdMangaId)
                  : (c.mangaName ?? c.mangaId ?? "-"),
                c.chapterNumber ?? "-",
                c.chapterVolume ?? "-",
                truncate(c.chapterTitle, 80),
                c.chapterLanguage ?? "-",
                fmtTime(c.chapterTimestamp),
                String(entry.segmentIndex + 1),
                [
                  c.chapterUrl
                    ? el("a", {
                        href: c.chapterUrl,
                        target: "_blank",
                        rel: "noreferrer noopener",
                        class: "button-link inline",
                        text: "Source",
                      })
                    : null,
                  // Present only once the chapter exists on MangaDex; an
                  // envelope reports what the source has, not what we uploaded.
                  c.mdChapterId
                    ? routeLink(routeTo("chapters", c.mdChapterId, null), "On MangaDex", {
                        class: "button-link inline",
                      })
                    : null,
                ],
              ];
            }),
            {
              empty:
                set() === "all"
                  ? "This run's extension sent no full-catalogue snapshot. Only some extensions do; removal detection is skipped without one."
                  : "No chapter in this run matches. A completed run with nothing here found nothing new.",
            },
          ),
          pager(data.total ?? 0, f().runChapterPage, RUN_CHAPTER_PAGE, (page) => {
            setFilter({ runChapterPage: page });
            void chapters.load({ force: true });
          }),
        );
      },
      { reserve: 300, skeleton: () => skeletonTable(6, 9) },
    ),
  );
}

/** Coverage and the per-series breakdown, above the chapter list. */
function runChapterSummary(data, refilter) {
  const totals = data.totals ?? {};
  const segments = data.segments ?? [];
  const byManga = data.byManga ?? [];

  return el(
    "div",
    {},
    el(
      "div",
      { class: "grid tight" },
      el(
        "div",
        { class: "stat" },
        el("div", { class: "n", text: String(totals.updated ?? 0) }),
        el("div", { class: "k", text: "new or changed" }),
      ),
      el(
        "div",
        { class: "stat" },
        el("div", { class: "n", text: totals.all == null ? "-" : String(totals.all) }),
        el("div", { class: "k", text: "seen in catalogue" }),
      ),
      el(
        "div",
        { class: "stat" },
        el("div", { class: "n", text: String(data.mangaTitles ?? 0) }),
        el("div", { class: "k", text: data.mangaCapped ? "titles (capped)" : "titles" }),
      ),
      el(
        "div",
        { class: "stat" },
        el("div", { class: "n", text: `${data.segmentsReported ?? 0}/${data.segmentsTotal ?? 0}` }),
        el("div", { class: "k", text: "segments reported" }),
      ),
    ),
    // The one line that decides whether the list below can be trusted as whole.
    data.complete
      ? null
      : el("p", {
          class: "warn-text small",
          text:
            `${(data.segmentsTotal ?? 0) - (data.segmentsReported ?? 0)} segment(s) have not committed a ` +
            "result yet, so this is a partial picture of the run.",
        }),
    segments.length > 1
      ? el(
          "details",
          {},
          el("summary", { text: "By segment" }),
          table(
            ["Segment", "Key", "Job state", "New or changed", "Seen", "Submitted"],
            segments.map((segment) => [
              el("button", {
                type: "button",
                class: "linkish",
                text: String(segment.segmentIndex + 1),
                title: "Show only this segment's chapters",
                onclick: () => refilter({ runChapterSegment: String(segment.segmentIndex) }),
              }),
              segment.segmentKey ?? "-",
              chip(segment.jobState),
              segment.updated == null ? "not reported" : String(segment.updated),
              segment.all == null ? "-" : String(segment.all),
              fmtTime(segment.submittedAt),
            ]),
            { empty: "This run has no segments." },
          ),
        )
      : null,
    byManga.length
      ? el(
          "details",
          {},
          el("summary", { text: `By series (${byManga.length})` }),
          table(
            ["Series", "Chapters", ""],
            byManga.map((entry) => [
              entry.mdMangaId
                ? mdTitleLink(entry.mdMangaId, entry.mangaName || entry.mangaId || entry.mdMangaId)
                : (entry.mangaName ?? entry.mangaId ?? "-"),
              String(entry.count),
              [
                el("button", {
                  type: "button",
                  text: "Filter",
                  onclick: () => refilter({ runChapterQuery: entry.mangaName ?? entry.mangaId ?? "" }),
                }),
              ],
            ]),
            { empty: "No series." },
          ),
        )
      : null,
  );
}

/** Copy a link to what is on screen. A fragment is never sent to the server. */
function copyLinkButton(hash) {
  return el("button", {
    type: "button",
    text: "Copy link",
    title: "A link that opens this for anyone who can sign in",
    onclick: async () => {
      const url = `${window.location.origin}${window.location.pathname}${hash}`;
      try {
        await navigator.clipboard.writeText(url);
        toast("link copied");
      } catch {
        // Falling back to the address bar still gives them something to copy.
        navigate(hash);
        toast("clipboard blocked; the link is in the address bar", false);
      }
    },
  });
}

// --------------------------------------------------------------------- queues

const UPLOAD_TASK_KINDS = ["UPLOAD", "EDIT", "DELETE", "UNAVAILABLE"];
const UPLOAD_TASK_STATES = ["PENDING", "LEASED", "DONE", "FAILED", "DEAD_LETTER"];

/**
 * The MangaDex upload queues; the replacement for the legacy `queue_peek` and
 * `queue_clear` IPC commands, and for `restart_workers`: nothing here restarts a
 * process, because every unit of work is a durable row that can be requeued.
 */
/**
 * The MangaDex upload queues.
 *
 * Driven by `/queues/*`, which is the endpoint family that models the queue as
 * rows an operator may act on rather than a read-only depth chart. Everything
 * destructive here goes through the server's own guards rather than a local
 * guess: a LEASED row belongs to a live uploader and is refused with a 409, and
 * purge refuses to run without a dry run first.
 *
 * Paging is keyset, not offset. The queue drains while it is being read, so an
 * offset page skips rows that moved and repeats rows that did not; which for a
 * queue view means a task can silently never appear on any page.
 */
VIEWS.queues = (route) => {
  const f = () => store.filters;

  const queryString = (extra = {}) => {
    // Newest first. The server's default is the claim order (what drains next);
    // a queue is read here to see what has just arrived, and the page that
    // matters is the one at the recent end.
    const q = new URLSearchParams({ limit: "100", sort: "desc" });
    if (f().queueKind) q.set("kind", f().queueKind);
    if (f().queueState) q.set("state", f().queueState);
    if (f().queueDedupeKey) q.set("dedupeKey", f().queueDedupeKey);
    if (f().queueAttemptMin !== "") q.set("attemptMin", f().queueAttemptMin);
    if (f().queueAttemptMax !== "") q.set("attemptMax", f().queueAttemptMax);
    if (f().queueExtension) q.set("extension", f().queueExtension);
    if (f().queueLanguage) q.set("language", f().queueLanguage);
    if (f().queueQ) q.set("q", f().queueQ);
    for (const [k, v] of Object.entries(extra)) if (v != null) q.set(k, v);
    return q;
  };

  /** The filter as the bulk endpoints take it; same names, no paging keys. */
  const activeFilter = () => {
    const filter = {};
    if (f().queueKind) filter.kind = f().queueKind;
    if (f().queueState) filter.state = f().queueState;
    if (f().queueDedupeKey) filter.dedupeKey = f().queueDedupeKey;
    if (f().queueAttemptMin !== "") filter.attemptMin = Number(f().queueAttemptMin);
    if (f().queueAttemptMax !== "") filter.attemptMax = Number(f().queueAttemptMax);
    if (f().queueExtension) filter.extension = f().queueExtension;
    if (f().queueLanguage) filter.language = f().queueLanguage;
    if (f().queueQ) filter.q = f().queueQ;
    return filter;
  };

  const cursorNow = () => {
    const walked = f().queueCursors;
    return walked.length ? walked[walked.length - 1] : null;
  };

  const tasks = new Resource("queue-tasks", () =>
    api(`/queues/tasks?${queryString({ cursor: cursorNow() })}`),
  );

  if (route.tab === "depth") return queueDepthPanel();
  if (route.tab === "chapters") return queueChaptersPanel();

  // Selection is by id and survives a refresh, but only for rows still present:
  // acting on an id that has drained away is how a bulk action reports failures
  // the operator did not cause.
  const selected = new Set();
  const reconcile = (rows) => {
    const present = new Set(rows.map((r) => r.id));
    for (const id of [...selected]) if (!present.has(id)) selected.delete(id);
  };

  const reload = () => {
    void tasks.load({ force: true });
  };
  const resetPaging = () => {
    setFilter({ queueCursors: [] });
    selected.clear();
    reload();
  };

  const filterCard = queueFilterCard(resetPaging);

  return el(
    "div",
    {},
    filterCard,
    card(
      null,
      live(
        [tasks],
        (data) => {
          const rows = data.tasks ?? [];
          reconcile(rows);
          return el(
            "div",
            {},
            queueBulkBar(selected, activeFilter, rows, tasks, reload),
            queueTable(rows, selected, tasks, reload),
            queuePager(data, tasks, selected),
          );
        },
        { reserve: 320, skeleton: () => skeletonTable(8, 8) },
      ),
    ),
  );
};

/**
 * Outstanding upload-task states, worst first.
 *
 * Attention before motion before waiting: DEAD_LETTER and FAILED are the two
 * that will not move again without an operator, so they lead. DONE is not on
 * this list at all; see `outstandingTasks`.
 */
const OUTSTANDING_TASK_STATES = ["DEAD_LETTER", "FAILED", "LEASED", "PENDING"];

/** The non-empty, non-DONE entries of a depth summary, worst first. */
function outstandingDepths(counts) {
  return counts
    .filter((entry) => entry.state !== "DONE" && entry.count > 0)
    .sort(
      (a, b) =>
        OUTSTANDING_TASK_STATES.indexOf(a.state) - OUTSTANDING_TASK_STATES.indexOf(b.state) ||
        a.kind.localeCompare(b.kind),
    );
}

/**
 * One depth tile that is also the way into the rows behind it.
 *
 * A real anchor so middle-click and "copy link" still work; the filter is set
 * on the way through because the hash carries a section and tab, not a filter.
 * Opening it in a new tab therefore lands on the unfiltered Tasks list, which
 * is the honest degradation: a wrong filter would be worse than none.
 */
function queueDepthTile(entry) {
  return el(
    "a",
    {
      class: "stat linked",
      href: routeTo("queues", null, "tasks"),
      title: `Open the ${entry.count} ${entry.state} ${entry.kind} task(s)`,
      onclick: () => setFilter({ queueKind: entry.kind, queueState: entry.state, queueCursors: [] }),
    },
    el("div", { class: "n", text: String(entry.count) }),
    el("div", { class: "k" }, `${entry.kind} · `, chip(entry.state)),
  );
}

/**
 * What the queue still owes, and (folded away) what it has already settled.
 *
 * DONE is deliberately not a tile. It is both the largest number here and the
 * only one nobody can act on, so a queue that has published forty thousand
 * chapters and has three stuck ones read as a wall of completed work with the
 * problem buried in it. The completed count is still available, one disclosure
 * down, because "did that kind ever go through at all" is a real question; it
 * is just never the first one.
 */
function outstandingTasks(counts, { emptyText }) {
  const outstanding = outstandingDepths(counts);
  const done = counts.filter((entry) => entry.state === "DONE" && entry.count > 0);
  const doneTotal = done.reduce((sum, entry) => sum + entry.count, 0);

  return el(
    "div",
    {},
    outstanding.length
      ? el("div", { class: "grid tight" }, outstanding.map(queueDepthTile))
      : emptyState(emptyText),
    done.length
      ? el(
          "details",
          {},
          el("summary", { text: `Completed (${doneTotal.toLocaleString()})` }),
          table(
            ["Kind", "Completed"],
            done
              .slice()
              .sort((a, b) => a.kind.localeCompare(b.kind))
              .map((entry) => [entry.kind, String(entry.count)]),
            { empty: "Nothing has completed yet." },
          ),
        )
      : null,
  );
}

/** Depth by kind and state, from the same summary the list returns. */
function queueDepthPanel() {
  const depths = new Resource("queue-depths", () => api("/queues"));
  return card(
    "Outstanding by kind and state",
    live(
      [depths],
      (data) => {
        const counts = data.summary ?? [];
        return counts.length
          ? outstandingTasks(counts, {
              emptyText: "Nothing outstanding; every queued upload has been published.",
            })
          : emptyState("No upload task has ever been queued.");
      },
      { reserve: 120, skeleton: () => skeletonGrid(6) },
    ),
  );
}

/**
 * The queue as chapters: what is about to be published, in the order it will
 * be.
 *
 * The Tasks tab shows the same rows keyed on queue mechanics, dedupe key,
 * attempt count, last error, which is the right view during an incident and
 * the wrong one for the question asked far more often: what is going up next,
 * and is any of it wrong? A dedupe key of `1015117|142|en` names a chapter only
 * to someone willing to decode it.
 *
 * `position` comes from the server and is the place in the claim order across
 * everything matching the filter, so "14" means fourteenth in the queue, not
 * fourteenth on this page. The rows are listed newest first (`sort=desc`),
 * which reverses the claim query's ORDER BY but not `position`: the number
 * still counts from the front of the queue, so a page here typically runs
 * downwards through it.
 */
function queueChaptersPanel() {
  const f = () => store.filters;

  const cursorNow = () => {
    const walked = f().queueChapterCursors;
    return walked.length ? walked[walked.length - 1] : null;
  };

  const queryString = () => {
    // Newest first, as on the Tasks tab; `position` is unaffected and still
    // counts from the front of the claim order.
    const q = new URLSearchParams({ limit: "100", sort: "desc" });
    if (f().queueChapterKind) q.set("kind", f().queueChapterKind);
    if (f().queueChapterState) q.set("state", f().queueChapterState);
    if (f().queueChapterQuery) q.set("q", f().queueChapterQuery);
    if (f().queueChapterExtension) q.set("extension", f().queueChapterExtension);
    if (f().queueChapterLanguage) q.set("language", f().queueChapterLanguage);
    const cursor = cursorNow();
    if (cursor) q.set("cursor", cursor);
    return q;
  };

  const chapters = new Resource("queue-chapters", () => api(`/queues/chapters?${queryString()}`));
  const reload = () => void chapters.load({ force: true });
  const refilter = (patch) => {
    setFilter({ ...patch, queueChapterCursors: [] });
    reload();
  };

  const picker = (id, label, values, key, { all = "all" } = {}) =>
    el(
      "span",
      { class: "row tight" },
      el("label", { class: "inline", for: id, text: label }),
      el(
        "select",
        { id, onchange: (event) => refilter({ [key]: event.target.value }) },
        el("option", { value: "", text: all, selected: store.filters[key] === "" }),
        values.map((value) => el("option", { value, text: value, selected: value === store.filters[key] })),
      ),
    );

  /** An exact-match text facet; the same pair the Tasks tab offers. */
  const facet = (id, label, key, placeholder) =>
    el(
      "span",
      { class: "row tight" },
      el("label", { class: "inline", for: id, text: label }),
      el("input", {
        id,
        type: "text",
        value: store.filters[key],
        placeholder,
        onchange: (event) => refilter({ [key]: event.target.value.trim() }),
      }),
    );

  const search = el("input", {
    id: "queue-chapter-q",
    type: "search",
    value: f().queueChapterQuery,
    placeholder: "series, title, number or either MangaDex id",
    onchange: (event) => refilter({ queueChapterQuery: event.target.value.trim() }),
  });

  return el(
    "div",
    {},
    card(
      "Filter",
      row(
        picker("queue-chapter-kind", "Kind", UPLOAD_TASK_KINDS, "queueChapterKind"),
        picker("queue-chapter-state", "State", UPLOAD_TASK_STATES, "queueChapterState", { all: "any state" }),
        el(
          "span",
          { class: "row tight" },
          el("label", { class: "inline", for: "queue-chapter-q", text: "Search" }),
          search,
        ),
        facet("queue-chapter-extension", "Extension", "queueChapterExtension", "exact name"),
        facet("queue-chapter-language", "Language", "queueChapterLanguage", "exact code, e.g. en"),
        el("button", {
          type: "button",
          text: "Reset",
          onclick: () =>
            refilter({
              queueChapterKind: "",
              queueChapterState: "PENDING",
              queueChapterQuery: "",
              queueChapterExtension: "",
              queueChapterLanguage: "",
            }),
        }),
      ),
      el("p", {
        class: "dim small",
        text:
          "PENDING by default, because “what is going to be uploaded” is the question. Rows are in the " +
          "order the uploader will claim them, earliest due first, which is the same order a reorder " +
          "on the Tasks tab rewrites.",
      }),
    ),
    card(
      null,
      live(
        [chapters],
        (data) => {
          const rows = data.chapters ?? [];
          return el(
            "div",
            {},
            table(
              ["#", "Kind", "Series", "Chapter", "Volume", "Title", "Lang", "Due", "State", ""],
              rows.map((row_) => {
                const editable = row_.state === "PENDING";
                const leased = row_.state === "LEASED";
                return [
                  String(row_.position),
                  row_.kind,
                  row_.mdMangaId
                    ? mdTitleLink(row_.mdMangaId, row_.mangaName || row_.mangaId || row_.mdMangaId)
                    : (row_.mangaName ?? row_.mangaId ?? "-"),
                  row_.chapterNumber ?? "-",
                  row_.chapterVolume ?? "-",
                  // An EDIT task's interest is what it CHANGES, so show that
                  // rather than the title it happens to be carrying.
                  row_.kind === "EDIT" && row_.editPayload
                    ? el("span", {
                        class: "small",
                        text: Object.entries(row_.editPayload)
                          .map(([key, value]) => `${key} → ${value === null ? "(cleared)" : String(value)}`)
                          .join(", "),
                      })
                    : truncate(row_.chapterTitle, 60),
                  row_.chapterLanguage ?? "-",
                  fmtTime(row_.notBefore),
                  chip(row_.state),
                  [
                    gatedButton("runs:write", {
                      text: "Edit",
                      disabled: !editable,
                      title: leased
                        ? "An uploader holds this task; it cannot be edited while it is leased"
                        : editable
                          ? "Correct the chapter before it is sent"
                          : `${row_.state} tasks cannot be edited`,
                      onclick: () => queueEditDialog(row_, chapters, reload),
                    }),
                    gatedButton("runs:write", {
                      text: "Run next",
                      disabled: !editable,
                      title: "Move to the front of the claim order",
                      onclick: (event) =>
                        void act(
                          "queue.reorder",
                          () =>
                            api("/queues/reorder", {
                              method: "POST",
                              body: { ids: [row_.id], mode: "front" },
                            }),
                          { button: event.currentTarget, refresh: [chapters] },
                        ),
                    }),
                    // The chapter's own page, when it already exists on
                    // MangaDex; every kind but UPLOAD acts on a live chapter.
                    row_.mdChapterId
                      ? routeLink(routeTo("chapters", row_.mdChapterId, null), "History", {
                          class: "button-link inline",
                        })
                      : null,
                  ],
                ];
              }),
              {
                empty:
                  f().queueChapterState === "PENDING"
                    ? "Nothing is queued for MangaDex. The uploader has drained everything it was given."
                    : "No queued chapter matches this filter.",
              },
            ),
            queueChapterPager(data, chapters),
          );
        },
        { reserve: 320, skeleton: () => skeletonTable(8, 10) },
      ),
    ),
  );
}

/** Keyset paging, same scheme as the Tasks tab and for the same reason. */
function queueChapterPager(data, chapters) {
  const walked = store.filters.queueChapterCursors;
  const go = (cursors) => {
    setFilter({ queueChapterCursors: cursors });
    void chapters.load({ force: true });
  };

  return el(
    "div",
    { class: "row pager" },
    el("span", {
      class: "dim small",
      text: `${data.chapters?.length ?? 0} shown of ${data.total ?? 0} matching · claim order: ${data.order ?? "unknown"}`,
    }),
    el("span", { class: "grow" }),
    el("button", {
      type: "button",
      text: "← Back",
      disabled: walked.length === 0,
      onclick: () => go(walked.slice(0, -1)),
    }),
    el("button", {
      type: "button",
      text: "Next →",
      disabled: !data.nextCursor,
      onclick: () => go([...walked, data.nextCursor]),
    }),
  );
}

function queueFilterCard(onChange) {
  const text = (id, label, key, attrs = {}) => {
    const input = el("input", {
      id,
      type: attrs.type ?? "text",
      value: store.filters[key],
      placeholder: attrs.placeholder,
      min: attrs.min,
      max: attrs.max,
      onchange: (event) => {
        setFilter({ [key]: event.target.value });
        onChange();
      },
    });
    return el("span", { class: "row tight" }, el("label", { class: "inline", for: id, text: label }), input);
  };

  const picker = (id, label, values, key) =>
    el(
      "span",
      { class: "row tight" },
      el("label", { class: "inline", for: id, text: label }),
      el(
        "select",
        {
          id,
          onchange: (event) => {
            setFilter({ [key]: event.target.value });
            onChange();
          },
        },
        el("option", { value: "", text: "all", selected: store.filters[key] === "" }),
        values.map((value) =>
          el("option", { value, text: value, selected: value === store.filters[key] }),
        ),
      ),
    );

  return card(
    "Filter",
    row(
      picker("queue-kind", "Kind", UPLOAD_TASK_KINDS, "queueKind"),
      picker("queue-state", "State", UPLOAD_TASK_STATES, "queueState"),
      text("queue-dedupe", "Dedupe key", "queueDedupeKey", { placeholder: "substring or % wildcard" }),
      text("queue-attempt-min", "Attempts ≥", "queueAttemptMin", { type: "number", min: "0", max: "1000" }),
      text("queue-attempt-max", "≤", "queueAttemptMax", { type: "number", min: "0", max: "1000" }),
      el("button", {
        type: "button",
        text: "Clear",
        onclick: () => {
          setFilter({
            queueKind: "",
            queueState: "",
            queueDedupeKey: "",
            queueAttemptMin: "",
            queueAttemptMax: "",
            queueExtension: "",
            queueLanguage: "",
            queueQ: "",
          });
          onChange();
        },
      }),
    ),
    // Filters over the queued chapter itself. Separated from the row above
    // because they answer a different question; that one narrows by the state
    // of the work, this one by which chapter the work is about, which for an
    // EDIT or UNAVAILABLE row is the only handle an operator has.
    row(
      text("queue-q", "Search", "queueQ", {
        placeholder: "series, title, number or either MangaDex id",
      }),
      text("queue-extension", "Extension", "queueExtension", { placeholder: "exact name" }),
      text("queue-language", "Language", "queueLanguage", { placeholder: "exact code, e.g. en" }),
    ),
    row(
      gatedButton("runs:write", {
        text: "Requeue stale leases",
        title: "Only touches tasks whose lease has already expired",
        onclick: (event) =>
          act(
            "upload_task.requeue_stale",
            async () => {
              const res = await api("/upload-tasks/requeue-stale", { method: "POST", body: {} });
              toast(`${res.requeued} stale lease(s) requeued`);
              return res;
            },
            { button: event.currentTarget, refresh: [summary] },
          ),
      }),
      isOperator()
        ? gatedButton("runs:write", {
            text: "Add a task by hand",
            onclick: () => queueManualAddDialog(),
          })
        : null,
      gatedButton("runs:write", {
        class: "danger",
        text: "Purge…",
        title: "Delete every row matching the current filter",
        onclick: () => queuePurgeDialog(onChange),
      }),
    ),
    el("p", {
      class: "dim small",
      text:
        "Requeueing stale leases only touches tasks whose lease has already expired; a task a live uploader " +
        "still holds is left alone, and every action here refuses a LEASED row for the same reason.",
    }),
  );
}

/** Bulk actions over the ticked rows, or over the whole filter. */
function queueBulkBar(selected, activeFilter, rows, tasks, reload) {
  const count = selected.size;
  const ids = () => [...selected];

  const bulk = (label, action, run) =>
    gatedButton("runs:write", {
      class: action === "remove" ? "danger" : null,
      text: label,
      disabled: count === 0,
      onclick: async (event) => {
        const button = event.currentTarget;
        if (
          action === "remove" &&
          !(await confirmDialog({
            title: `Delete ${count} queue row(s)`,
            lead: "The rows are deleted permanently. Nothing is sent to MangaDex.",
            points: [
              "A LEASED row is refused: an uploader is holding it right now.",
              "A DONE row is refused unless you tick “include completed”; DONE plus its upload log is what stops a chapter being uploaded twice.",
            ],
            confirmLabel: "Delete them",
          }))
        ) {
          return;
        }
        const result = await act(label.toLowerCase(), () => run(ids()), {
          button,
          refresh: [tasks, summary],
        });
        if (result) {
          reportQueueOutcome(result);
          selected.clear();
          reload();
        }
      },
    });

  return el(
    "div",
    { class: "row bulk-bar" },
    el("span", {
      class: count ? null : "dim",
      text: count ? `${count} selected` : "Tick rows to act on them",
    }),
    bulk("Retry", "retry", (ids) => api("/queues/retry", { method: "POST", body: { ids } })),
    bulk("Remove", "remove", (ids) =>
      api("/queues/remove", { method: "POST", body: { ids, confirm: true } }),
    ),
    gatedButton("runs:write", {
      text: "Run next",
      disabled: count === 0,
      title: "Move to the front of the claim order",
      onclick: (event) =>
        void act("queue.reorder", () => api("/queues/reorder", { method: "POST", body: { ids: ids(), mode: "front" } }), {
          button: event.currentTarget,
          refresh: [tasks],
        }).then((r) => {
          if (r) {
            selected.clear();
            reload();
          }
        }),
    }),
    gatedButton("runs:write", {
      text: "Run last",
      disabled: count === 0,
      onclick: (event) =>
        void act("queue.reorder", () => api("/queues/reorder", { method: "POST", body: { ids: ids(), mode: "back" } }), {
          button: event.currentTarget,
          refresh: [tasks],
        }).then((r) => {
          if (r) {
            selected.clear();
            reload();
          }
        }),
    }),
    gatedButton("runs:write", {
      text: "Defer…",
      disabled: count === 0,
      title: "Hold these rows for a while before they can be claimed",
      onclick: () => queueDeferDialog(ids(), tasks, () => {
        selected.clear();
        reload();
      }),
    }),
    el("span", { class: "grow" }),
    el("button", {
      type: "button",
      text: rows.length && count === rows.length ? "Select none" : "Select all on this page",
      disabled: rows.length === 0,
      onclick: () => {
        if (count === rows.length) selected.clear();
        else for (const row of rows) selected.add(row.id);
        reload();
      },
    }),
  );
}

/**
 * Per-row results, reported rather than summarised.
 *
 * The bulk endpoints answer 200 with a per-id verdict: a request where four rows
 * moved and one was LEASED is a success and a partial failure at once, and
 * collapsing that to "ok" loses the only part the operator has to act on.
 */
function reportQueueOutcome(result) {
  const results = Array.isArray(result.results) ? result.results : [];
  const refused = results.filter((r) => !r.ok && r.reason);
  if (refused.length === 0) {
    toast(`${result.changed ?? results.length} row(s) updated`);
    return;
  }
  toast(`${result.changed ?? 0} updated, ${refused.length} refused`, false);
  openModal(
    "Some rows were refused",
    el(
      "div",
      {},
      el("p", {
        class: "dim small",
        text: "The rest of the request was applied. These rows were not, and why:",
      }),
      el(
        "ul",
        { class: "errors" },
        refused.slice(0, 50).map((r) => el("li", { text: `${r.id}: ${r.reason}` })),
      ),
      el("div", { class: "row end" }, el("button", { type: "button", text: "Close", onclick: closeModal })),
    ),
  );
}

/**
 * Which chapter a queue row is about.
 *
 * The dedupe key beside this column is the MangaDex chapter UUID for every kind
 * except UPLOAD (see `taskDedupeKey`), so without this a scheduled edit or
 * takedown is an unreadable identifier and the only way to learn what it
 * touches is to open rows one at a time. The fields come from the list
 * endpoint's `identity` projection, not from the `chapter` payload, which stays
 * server-side.
 */
function queueChapterCell(identity) {
  const id = identity ?? {};
  // "0" is a real chapter number and a real volume, so this tests for absence,
  // not for falsiness.
  const has = (value) => value !== null && value !== undefined && value !== "";
  const series = has(id.mangaName) ? id.mangaName : id.mdMangaId;

  if (!has(series) && !has(id.chapterNumber) && !has(id.chapterTitle)) {
    return el("span", {
      class: "dim",
      text: id.mdChapterId ? "no series or chapter on the payload" : "payload carries no identity",
      title:
        "The queued payload has none of the fields this column reads. Open the row to see it in full.",
    });
  }

  const facets = [];
  if (has(id.chapterVolume)) facets.push(`Vol. ${id.chapterVolume}`);
  if (has(id.chapterLanguage)) facets.push(id.chapterLanguage);
  if (has(id.extension)) facets.push(id.extension);

  return el(
    "div",
    {},
    el(
      "div",
      {},
      has(id.mdMangaId)
        ? mdTitleLink(id.mdMangaId, truncate(has(id.mangaName) ? id.mangaName : id.mdMangaId, 60))
        : el("strong", { text: truncate(has(series) ? series : "unknown series", 60) }),
    ),
    el(
      "div",
      { class: "dim" },
      has(id.chapterNumber)
        ? has(id.mdChapterId)
          ? mdChapterLink(id.mdChapterId, `Ch. ${id.chapterNumber}`)
          : `Ch. ${id.chapterNumber}`
        : null,
      facets.length ? `${has(id.chapterNumber) ? " · " : ""}${facets.join(" · ")}` : null,
    ),
    has(id.chapterTitle) ? el("div", { class: "dim", text: truncate(id.chapterTitle, 60) }) : null,
  );
}

function queueTable(rows, selected, tasks, reload) {
  return table(
    ["", "Kind", "State", "Chapter", "Dedupe key", "Attempts", "Not before", "Last error", ""],
    rows.map((task) => {
      const retryable = task.state === "FAILED" || task.state === "DEAD_LETTER";
      const editable = task.state === "PENDING";
      const leased = task.state === "LEASED";
      return [
        el("input", {
          type: "checkbox",
          checked: selected.has(task.id),
          "aria-label": `Select ${task.dedupeKey}`,
          onchange: (event) => {
            if (event.target.checked) selected.add(task.id);
            else selected.delete(task.id);
            reload();
          },
        }),
        task.kind,
        chip(task.state),
        queueChapterCell(task.identity),
        el("code", { text: task.dedupeKey }),
        `${task.attempt}/${task.maxAttempts}`,
        fmtTime(task.notBefore),
        truncate(task.lastError, 160),
        [
          gatedButton("runs:write", {
            class: retryable ? "primary" : null,
            text: "Retry",
            disabled: !retryable,
            title: retryable ? "Requeue now with a fresh attempt budget" : `${task.state} tasks cannot be retried`,
            onclick: (event) =>
              act("queue.retry", () => api(`/queues/tasks/${task.id}/retry`, { method: "POST", body: {} }), {
                button: event.currentTarget,
                refresh: [tasks, summary],
              }),
          }),
          gatedButton("runs:write", {
            text: "Edit",
            disabled: !editable,
            title: leased
              ? "An uploader holds this task; it cannot be edited while it is leased"
              : editable
                ? "Change when it runs, or its attempt budget"
                : `${task.state} tasks cannot be edited`,
            onclick: () => queueEditDialog(task, tasks, reload),
          }),
          gatedButton("runs:write", {
            class: "danger",
            text: "Remove",
            disabled: leased,
            title: leased
              ? "An uploader holds this task; requeue stale leases first"
              : "Delete this row permanently",
            onclick: async (event) => {
              const button = event.currentTarget;
              if (
                !(await confirmDialog({
                  title: `Delete this ${task.kind} row`,
                  lead: `${task.dedupeKey} will never be sent to MangaDex.`,
                  points:
                    task.state === "DONE"
                      ? ["This row is DONE: it and its upload log are what stop the chapter being uploaded twice."]
                      : ["This cannot be undone from here."],
                  confirmLabel: "Delete it",
                }))
              ) {
                return;
              }
              const done = await act(
                "queue.remove",
                () =>
                  api(`/queues/tasks/${task.id}${task.state === "DONE" ? "?includeCompleted=true" : ""}`, {
                    method: "DELETE",
                  }),
                { button, refresh: [tasks, summary] },
              );
              if (done) reload();
            },
          }),
        ],
      ];
    }),
    { empty: "No upload task matches this filter." },
  );
}

/** Keyset paging: forward by the cursor the server issued, back by history. */
function queuePager(data, tasks, selected) {
  const walked = store.filters.queueCursors;
  const go = (cursors) => {
    setFilter({ queueCursors: cursors });
    selected.clear();
    void tasks.load({ force: true });
  };

  return el(
    "div",
    { class: "row pager" },
    el("span", {
      class: "dim small",
      text: `${data.tasks?.length ?? 0} shown of ${data.total ?? 0} matching · claim order: ${data.order ?? "unknown"}`,
    }),
    el("span", { class: "grow" }),
    el("button", {
      type: "button",
      text: "← Back",
      disabled: walked.length === 0,
      onclick: () => go(walked.slice(0, -1)),
    }),
    el("button", {
      type: "button",
      text: "Next →",
      // No cursor means this is the last page; the server says so rather than
      // the client inferring it from a short page, which is wrong when the page
      // size happens to divide the total.
      disabled: !data.nextCursor,
      onclick: () => go([...walked, data.nextCursor]),
    }),
  );
}

function queueDeferDialog(ids, tasks, done) {
  const amount = el("input", { id: "defer-amount", type: "number", min: "1", value: "15" });
  const unit = el(
    "select",
    { id: "defer-unit" },
    el("option", { value: "60", text: "minutes" }),
    el("option", { value: "3600", text: "hours" }),
    el("option", { value: "86400", text: "days" }),
  );

  openModal(
    `Defer ${ids.length} row(s)`,
    el(
      "div",
      {},
      el("p", {
        class: "dim small",
        text:
          "The rows stay queued and become claimable again after the delay. Deferring is how you hold work " +
          "back without deleting it; the attempt budget is untouched.",
      }),
      row(el("label", { class: "inline", for: "defer-amount", text: "Hold for" }), amount, unit),
      el(
        "div",
        { class: "row end" },
        el("button", { type: "button", text: "Cancel", onclick: closeModal }),
        gatedButton("runs:write", {
          class: "primary",
          text: "Defer them",
          onclick: async (event) => {
            const seconds = Math.round(Number(amount.value) * Number(unit.value));
            if (!Number.isFinite(seconds) || seconds < 1) {
              toast("enter a positive delay", false);
              return;
            }
            const result = await act(
              "queue.defer",
              () =>
                api("/queues/reorder", {
                  method: "POST",
                  body: { ids, mode: "defer", deferSeconds: seconds },
                }),
              { button: event.currentTarget, refresh: [tasks] },
            );
            if (result) {
              reportQueueOutcome(result);
              closeModal();
              done();
            }
          },
        }),
      ),
    ),
  );
}

/**
 * The chapter fields worth a labelled input.
 *
 * These are the ones a bad regex or a mis-split chapter actually lands in; the
 * number, the volume, the title, the language. Everything else on the payload
 * (ids, urls, timestamps, the artifact list) is machine-set and is edited in the
 * raw JSON below, where getting it wrong is at least obviously deliberate.
 */
const CHAPTER_FORM_FIELDS = [
  ["chapterNumber", "Chapter number", "e.g. 12, 12.5, or blank for a oneshot"],
  ["chapterVolume", "Volume", "blank if the source gives none"],
  ["chapterTitle", "Title", ""],
  ["chapterLanguage", "Language", "source language code"],
];

/**
 * Edit a queued task before it is uploaded.
 *
 * This is the point where a chapter can still be corrected: the row is PENDING,
 * no MangaDex upload session has been opened, and `PATCH /queues/tasks/:id`
 * takes the whole chapter payload. Pause the platform and the queue holds, so a
 * run can be reviewed in full before any of it is sent.
 *
 * Only a PENDING row is editable, and that is enforced server-side; if an
 * uploader claims this task while the dialog is open the save comes back 409
 * rather than racing it.
 */
function queueEditDialog(task, tasks, reload) {
  const notBefore = el("input", {
    id: "edit-not-before",
    type: "datetime-local",
    value: toLocalInput(task.notBefore),
  });
  const maxAttempts = el("input", {
    id: "edit-max-attempts",
    type: "number",
    min: "1",
    max: "50",
    value: String(task.maxAttempts ?? 3),
  });

  const body = el("div", {});
  const status = el("p", { class: "field-error" });
  // The list endpoint omits `chapter` (it is large and worker-supplied), so the
  // payload is fetched per row rather than assumed to be on the table data.
  const detail = new Resource(`queue-task:${task.id}`, () => api(`/queues/tasks/${task.id}`));

  const draw = (chapter) => {
    const fields = new Map();
    for (const [key, label, hint] of CHAPTER_FORM_FIELDS) {
      fields.set(
        key,
        el("input", {
          id: `edit-${key}`,
          type: "text",
          value: chapter[key] ?? "",
          placeholder: hint,
          "aria-label": label,
        }),
      );
    }

    const raw = el("textarea", {
      id: "edit-chapter-json",
      rows: "12",
      spellcheck: "false",
      "aria-label": "Full chapter payload, JSON",
    });
    raw.value = JSON.stringify(chapter, null, 2);

    // The form fields are a view onto the JSON, not a second source of truth:
    // typing in one updates the other, so a save can never depend on which of
    // the two the operator happened to use last.
    const syncToRaw = () => {
      let parsed;
      try {
        parsed = JSON.parse(raw.value || "{}");
      } catch {
        return;
      }
      for (const [key, input] of fields) parsed[key] = input.value === "" ? null : input.value;
      raw.value = JSON.stringify(parsed, null, 2);
    };
    for (const input of fields.values()) input.addEventListener("change", syncToRaw);
    raw.addEventListener("change", () => {
      try {
        const parsed = JSON.parse(raw.value || "{}");
        for (const [key, input] of fields) input.value = parsed[key] ?? "";
        status.textContent = "";
      } catch (err) {
        status.textContent = `Invalid JSON: ${err.message}`;
      }
    });

    setChildren(
      body,
      el("p", { class: "dim small", text: task.dedupeKey }),
      el("p", {
        class: "dim small",
        text:
          "Only a PENDING row can be edited. If an uploader claims it while this dialog is open the save is " +
          "refused rather than racing it.",
      }),
      el("h3", { text: "Chapter" }),
      ...CHAPTER_FORM_FIELDS.flatMap(([key, label]) => [
        el("label", { for: `edit-${key}`, text: label }),
        fields.get(key),
      ]),
      el("h3", { text: "Full payload" }),
      el("p", {
        class: "dim small",
        text: "Everything the uploader will send. The fields above are a view onto this.",
      }),
      raw,
      status,
      el("h3", { text: "Scheduling" }),
      el("label", { for: "edit-not-before", text: "Not before" }),
      notBefore,
      el("label", { for: "edit-max-attempts", text: "Attempt budget" }),
      maxAttempts,
      el(
        "div",
        { class: "row end" },
        el("button", { type: "button", text: "Cancel", onclick: closeModal }),
        gatedButton("runs:write", {
          class: "primary",
          text: "Save",
          onclick: async (event) => {
            syncToRaw();
            const patch = {};
            let parsed;
            try {
              parsed = JSON.parse(raw.value || "{}");
            } catch (err) {
              status.textContent = `Invalid JSON: ${err.message}`;
              return;
            }
            if (JSON.stringify(parsed) !== JSON.stringify(chapter)) patch.chapter = parsed;
            if (notBefore.value) patch.notBefore = new Date(notBefore.value).toISOString();
            const budget = Number(maxAttempts.value);
            if (Number.isFinite(budget) && budget !== task.maxAttempts) patch.maxAttempts = budget;
            if (Object.keys(patch).length === 0) {
              toast("nothing changed", false);
              return;
            }
            const result = await act(
              "queue.edit",
              () => api(`/queues/tasks/${task.id}`, { method: "PATCH", body: patch }),
              { button: event.currentTarget, refresh: [tasks] },
            );
            if (result) {
              closeModal();
              reload();
            }
          },
        }),
      ),
    );
  };

  onTeardown(
    detail.subscribe(() => {
      if (detail.status === "error") {
        setChildren(
          body,
          el("p", { class: "error", text: `Could not read this task: ${detail.error?.message ?? "unknown error"}` }),
        );
      } else if (detail.data) {
        draw(detail.data.task?.chapter ?? {});
      }
    }),
  );
  setChildren(body, el("div", { class: "skeleton skeleton-line", style: { height: "180px" } }));
  void detail.load();

  openModal(`Edit ${task.kind} task`, body);
}

/**
 * Queue a task by hand.
 *
 * ADMIN-only on the server, because a hand-made row goes to MangaDex with the
 * platform's credentials without any extension having produced it. The chapter
 * payload is JSON on purpose: it is the same shape the processor writes, and
 * inventing a form for it would guess at fields the uploader validates anyway.
 */
function queueManualAddDialog() {
  const kind = el(
    "select",
    { id: "add-kind" },
    UPLOAD_TASK_KINDS.map((k) => el("option", { value: k, text: k })),
  );
  const chapter = el("textarea", {
    id: "add-chapter",
    rows: "12",
    spellcheck: "false",
    value: JSON.stringify(
      { mdMangaId: "", mdChapterId: "", chapterNumber: "1", language: "en", extensionName: "" },
      null,
      2,
    ),
  });
  const status = el("div", {});

  openModal(
    "Add a task by hand",
    el(
      "div",
      {},
      el("p", {
        class: "dim small",
        text:
          "This goes to MangaDex under the platform's account without an extension having produced it, which is " +
          "why it needs the ADMIN role. The payload is validated server-side; anything it refuses is listed below.",
      }),
      el("label", { for: "add-kind", text: "Kind" }),
      kind,
      el("label", { for: "add-chapter", text: "Chapter payload (JSON)" }),
      chapter,
      status,
      el(
        "div",
        { class: "row end" },
        el("button", { type: "button", text: "Cancel", onclick: closeModal }),
        gatedButton("runs:write", {
          class: "primary",
          text: "Queue it",
          onclick: async (event) => {
            let parsed;
            try {
              parsed = JSON.parse(chapter.value);
            } catch (err) {
              setChildren(status, el("p", { class: "error", text: `Not valid JSON: ${err.message}` }));
              return;
            }
            const result = await act(
              "queue.add",
              () => api("/queues/tasks", { method: "POST", body: { kind: kind.value, chapter: parsed } }),
              { button: event.currentTarget },
            );
            if (result) closeModal();
          },
        }),
      ),
    ),
  );
}

/**
 * Purge every row matching the current filter.
 *
 * The dry run is not a courtesy, it is the contract: the endpoint defaults to
 * `dryRun: true` and refuses to delete without an explicit confirm, so this
 * dialog cannot offer a one-click purge even if it wanted to.
 */
function queuePurgeDialog(afterPurge) {
  const includeCompleted = el("input", { type: "checkbox", id: "purge-done" });
  const preview = el("div", {});
  let previewed = null;

  const body = (dryRun) => {
    const out = { dryRun, includeCompleted: includeCompleted.checked };
    const filter = {};
    if (store.filters.queueKind) filter.kind = store.filters.queueKind;
    if (store.filters.queueState) filter.state = store.filters.queueState;
    if (store.filters.queueDedupeKey) filter.dedupeKey = store.filters.queueDedupeKey;
    if (store.filters.queueAttemptMin !== "") filter.attemptMin = Number(store.filters.queueAttemptMin);
    if (store.filters.queueAttemptMax !== "") filter.attemptMax = Number(store.filters.queueAttemptMax);
    return { ...out, ...filter };
  };

  const applyButton = gatedButton("runs:write", {
    class: "danger",
    text: "Purge them",
    disabled: true,
    onclick: async (event) => {
      if (
        !(await confirmDialog({
          title: `Purge ${previewed ?? 0} row(s)`,
          lead: "Every row matching the current filter is deleted permanently.",
          points: [
            "LEASED rows are never deleted; an uploader is holding them.",
            includeCompleted.checked
              ? "DONE rows ARE included: their upload logs are what stop a chapter being uploaded twice."
              : "DONE rows are excluded.",
          ],
          confirmLabel: "Purge them",
        }))
      ) {
        return;
      }
      const result = await act(
        "queue.purge",
        () => api("/queues/purge", { method: "POST", body: { ...body(false), confirm: true } }),
        { button: event.currentTarget, refresh: [summary] },
      );
      if (result) {
        toast(`${result.deleted ?? 0} row(s) purged`);
        closeModal();
        // Reload the list in place. A full page reload would also work and is
        // what this did first, but it throws away the operator's filter; which
        // is the very thing they just purged against and will want to re-check.
        afterPurge();
      }
    },
  });

  openModal(
    "Purge the queue",
    el(
      "div",
      {},
      el("p", {
        class: "dim small",
        text: "Purge acts on the filter currently set on the Queues page, not on the ticked rows.",
      }),
      el("label", { class: "assign-row", for: "purge-done" }, includeCompleted, el("span", { text: "Include DONE rows" })),
      el("p", {
        class: "dim small",
        text:
          "A DONE row plus its upload log is what stops a chapter being uploaded to MangaDex twice. Deleting " +
          "them makes a re-run upload duplicates.",
      }),
      row(
        el("button", {
          type: "button",
          text: "Dry run",
          onclick: async (event) => {
            const result = await act("queue.purge.dry_run", () => api("/queues/purge", { method: "POST", body: body(true) }), {
              button: event.currentTarget,
            });
            if (!result) return;
            // `wouldDelete`, not `matched`: matched counts everything the filter
            // selects INCLUDING rows the purge protects, and quoting that number
            // back would promise a deletion the server will refuse to perform.
            previewed = result.wouldDelete ?? 0;
            applyButton.disabled = previewed === 0;
            setChildren(
              preview,
              el("p", {
                class: previewed ? "error" : "dim",
                text: previewed
                  ? `${previewed} row(s) would be deleted.`
                  : "Nothing deletable matches this filter.",
              }),
              // The gap between the two is the point: it is what the operator's
              // filter selected and the purge will not touch.
              result.protectedRows
                ? el("p", {
                    class: "dim small",
                    text: `${result.protectedRows} matching row(s) are protected and will be left alone (LEASED, or DONE while "include DONE" is off).`,
                  })
                : null,
              result.capped
                ? el("p", {
                    class: "dim small",
                    text: `Capped at ${result.cap} rows per purge; repeat to continue.`,
                  })
                : null,
              Array.isArray(result.breakdown) && result.breakdown.length
                ? el(
                    "ul",
                    { class: "errors" },
                    result.breakdown.map((s) => el("li", { text: `${s.kind} · ${s.state}: ${s.count}` })),
                  )
                : null,
            );
          },
        }),
        applyButton,
        el("button", { type: "button", text: "Cancel", onclick: closeModal }),
      ),
      preview,
    ),
  );
}

/** ISO → the value a `datetime-local` input accepts, in local time. */
function toLocalInput(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

// ------------------------------------------------------------------- chapters

/**
 * What this platform has on MangaDex, and the three things that can be done to
 * a chapter after it is published.
 *
 * Nothing here talks to MangaDex. Every action queues an UploadTask and the
 * page says so; core-uploader is the only process with write credentials, and
 * a dashboard that claimed "deleted" the moment the request returned would be
 * describing something that has not happened yet. The buttons therefore report
 * "queued", link to the queue row, and the detail view shows what MangaDex
 * currently says next to what our own tables think.
 */
const CHAPTER_ARCHIVE_LABELS = {
  uploaded: "Uploaded",
  unavailable: "Unavailable since",
  deleted: "Deleted",
  edited: "Last edited",
};

VIEWS.chapters = (route) => {
  if (route.param) return chapterDetail(route.param);
  const archive = route.tab ?? "uploaded";
  const f = () => store.filters;
  const cursors = () => f().chapterCursors[archive] ?? [];

  const queryString = () => {
    const q = new URLSearchParams({ archive, limit: "50" });
    if (f().chapterExtension) q.set("extension", f().chapterExtension);
    if (f().chapterLanguage) q.set("language", f().chapterLanguage);
    if (f().chapterNumber) q.set("chapterNumber", f().chapterNumber);
    if (f().chapterSearch) q.set("search", f().chapterSearch);
    const walked = cursors();
    if (walked.length) q.set("cursor", walked[walked.length - 1]);
    return q;
  };

  /** The filter as the bulk endpoints take it; same names, no paging keys. */
  const activeFilter = () => {
    const filter = { archive };
    if (f().chapterExtension) filter.extension = f().chapterExtension;
    if (f().chapterLanguage) filter.language = f().chapterLanguage;
    if (f().chapterNumber) filter.chapterNumber = f().chapterNumber;
    if (f().chapterSearch) filter.search = f().chapterSearch;
    return filter;
  };

  const chapters = new Resource(`chapters:${archive}`, () => api(`/chapters?${queryString()}`));
  const extensions = new Resource(`chapter-extensions:${archive}`, () =>
    api(`/chapters/extensions?archive=${archive}`),
  );

  const reload = () => void chapters.load({ force: true });
  const resetPaging = () => {
    setFilter({ chapterCursors: { ...f().chapterCursors, [archive]: [] } });
    selected.clear();
    reload();
  };
  const page = (walked) => {
    setFilter({ chapterCursors: { ...f().chapterCursors, [archive]: walked } });
    selected.clear();
    reload();
  };

  // Selection is by MangaDex chapter id and survives a refresh, but only for
  // rows still on screen: acting on an id that has scrolled out of the filter is
  // how a bulk action reports refusals the operator did not cause.
  const selected = new Set();
  const reconcile = (rows) => {
    const present = new Set(rows.map((r) => r.mdChapterId));
    for (const id of [...selected]) if (!present.has(id)) selected.delete(id);
  };
  // Whether the buttons act on the ticked rows or on everything the filter
  // matches. One toggle rather than two sets of buttons, because the difference
  // is the *scope* of an action and not a different action.
  const scope = { wholeFilter: false };

  return el(
    "div",
    {},
    chapterFilterCard(extensions, resetPaging),
    reconcileCard(archive, reload),
    card(
      null,
      live(
        [chapters],
        (data) => {
          const rows = data.chapters ?? [];
          reconcile(rows);
          return el(
            "div",
            {},
            chapterBulkBar(selected, scope, rows, data, activeFilter, archive, reload),
            chapterTable(rows, archive, selected, reload),
            chapterPager(data, cursors(), page),
          );
        },
        { reserve: 320, skeleton: () => skeletonTable(8, 7) },
      ),
    ),
  );
};

/**
 * Bring our record of the chapters back in line with what MangaDex actually
 * holds.
 *
 * On `uploaded` as well as the two archives, because it writes all three now:
 * the adoption pass records the live chapters MangaDex has that this platform
 * never uploaded, and `uploaded` is the table that is missing them. Still not
 * on `edited`, which it does not touch.
 *
 * Check first, then apply, and never the other way round: the check is the only
 * thing that says how many rows are about to move, and unlike the bulk actions
 * above this one cannot be previewed row by row afterwards; an archived row
 * has left `uploaded_chapters`.
 */
function reconcileCard(archive, reload) {
  if (archive !== "unavailable" && archive !== "deleted" && archive !== "uploaded") {
    return el("span", {});
  }
  const output = el("div", { class: "dim small" });
  let checked = null;

  const render = (report) => {
    checked = report;
    const groups = (report.groups ?? []).filter(
      (g) => g.carded > 0 || g.hiddenOnMangadex > 0 || g.untracked > 0,
    );
    setChildren(
      output,
      el("div", {}, [
        el("div", {
          text:
            `${report.unavailableRecorded} unavailable and ${report.deletedRecorded} deleted ` +
            `chapter(s) are not in the archives ` +
            `(found ${report.unavailableFound} and ${report.deletedFound}; the rest are already recorded).`,
        }),
        el("div", {
          text:
            `${report.untrackedFound ?? 0} live chapter(s) on MangaDex have no row here at all; ` +
            `${report.idsRecorded ?? 0} of them would recover a publisher chapter id.`,
        }),
        ...groups.map((g) =>
          el("div", {
            text:
              `${g.extension}: ${g.carded} of ${g.total} already carded on MangaDex, ${g.recorded} new` +
              (g.untracked > 0 ? `, ${g.untracked} of ${g.live} live untracked` : "") +
              (g.hiddenOnMangadex > 0 ? `, ${g.hiddenOnMangadex} live but unserved` : ""),
          }),
        ),
        // An adopted row with no chapter id is the quiet failure here: it shows
        // up in the listing and still leaves the extension re-fetching the
        // chapter forever, so say so rather than let the count imply success.
        ...groups
          .filter((g) => g.untracked > 0 && !g.idRule)
          .map((g) =>
            el("div", {
              text:
                `${g.extension}: no chapter id can be read from its chapter URLs, so adopted rows ` +
                "will carry none and those chapters stay outside postedChapterIds.",
            }),
          ),
        report.hiddenOnMangadex?.length
          ? el("div", {
              text:
                `${report.hiddenOnMangadex.length} chapter(s) carry no card but MangaDex will not ` +
                "serve them; never archived. Queue them unavailable if that is what you want.",
            })
          : el("span", {}),
      ]),
    );
  };

  /**
   * Record the live chapters MangaDex has that no table here knows about.
   *
   * The deletion sweep and the carded-archiving pass are both switched off:
   * this button's label promises one thing, and the sweep in particular is the
   * slow half, one MangaDex call per row it cannot rule out.
   */
  const adoptButton = () =>
    el("button", {
      type: "button",
      class: "primary",
      text: "Track them",
      onclick: async (event) => {
        const button = event.currentTarget;
        if (!checked) {
          toast("Check first; nothing should be written before you have seen the count.", false);
          return;
        }
        const adopting = checked.untrackedFound ?? 0;
        if (adopting === 0) {
          toast("Nothing to track; every live chapter on MangaDex already has a row.", true);
          return;
        }
        // Naming the extensions that recovered no id is the point of the
        // dialog: those rows land visible but still outside postedChapterIds,
        // and that is the half an operator would otherwise never learn.
        const blind = (checked.groups ?? [])
          .filter((g) => g.untracked > 0 && !g.idRule)
          .map((g) => g.extension);
        if (
          !(await confirmDialog({
            title: "Track the chapters MangaDex has and we do not",
            lead: `${adopting} live chapter(s) will be recorded as uploaded.`,
            points: [
              "Nothing is sent to MangaDex; this only corrects our record of it.",
              "Only chapters no table here knows about are added; a chapter this platform " +
                "actually uploaded keeps the row it already has, with its publisher-side ids.",
              `${checked.idsRecorded ?? 0} of them recover a publisher chapter id, which is what ` +
                "stops the extension re-fetching the chapter on every run.",
              blind.length
                ? `No chapter id can be read from the URLs of: ${blind.join(", ")}. Those rows will ` +
                  "be added without one, so those chapters stay outside postedChapterIds."
                : "Every one of them recovers a chapter id.",
            ],
            confirmLabel: "Add the rows",
          }))
        ) {
          return;
        }
        await act(
          "chapters.reconcile.adopt",
          async () => {
            render(
              await api("/chapters/reconcile", {
                method: "POST",
                body: { dryRun: false, skipDeleted: true, skipUnavailable: true },
              }),
            );
            checked = null;
            // The listing below now has rows it did not have a moment ago.
            reload();
          },
          { button },
        );
      },
    });

  /**
   * Move the chapters MangaDex has carded or dropped into their archives.
   *
   * `skipAdopt` because this button is offered on the unavailable and deleted
   * archives: adopting here would write thousands of rows into a third table
   * the operator is not looking at. The uploaded archive has its own button.
   */
  const archiveButton = () =>
    el("button", {
      type: "button",
      class: "primary",
      text: "Record them",
      onclick: async (event) => {
        const button = event.currentTarget;
        if (!checked) {
          toast("Check first; nothing should be written before you have seen the count.", false);
          return;
        }
        const moving = checked.unavailableRecorded + checked.deletedRecorded;
        if (
          !(await confirmDialog({
            title: "Record what MangaDex changed",
            lead: `${moving} chapter(s) will move into the unavailable and deleted archives.`,
            points: [
              "Nothing is sent to MangaDex; this only corrects our record of it.",
              "Rows that move leave uploaded_chapters, so a chapter lives in exactly one table.",
              "Chapters already archived keep the date they were first recorded.",
              `The ${checked.untrackedFound ?? 0} untracked live chapter(s) are NOT written here; ` +
                "that is the Uploaded archive's own button.",
            ],
            confirmLabel: "Move the rows",
          }))
        ) {
          return;
        }
        await act(
          "chapters.reconcile.apply",
          async () => {
            render(
              await api("/chapters/reconcile", {
                method: "POST",
                body: { dryRun: false, skipAdopt: true },
              }),
            );
            checked = null;
            // The listing below now has rows it did not have a moment ago.
            reload();
          },
          { button },
        );
      },
    });

  return card(
    "Reconcile with MangaDex",
    el(
      "div",
      {},
      el("p", {
        class: "dim small",
        text:
          "These tables record what the workers did as they did it, so they describe this " +
          "platform's own history rather than the catalogue. Check reads MangaDex and reports " +
          "the whole drift; the button beside it writes only the table you are looking at." +
          (archive === "uploaded"
            ? " Here that is the live chapters MangaDex has for our groups that we have never " +
              "had a row for -- mostly chapters the previous uploader posted. Tracking them is " +
              "not only about this listing: their ids are what an extension is given as " +
              "postedChapterIds, and until they are recorded it re-fetches those chapters on " +
              "every run."
            : " Here that is the chapters already carrying an unavailable card and the ones " +
              "MangaDex no longer has."),
      }),
      el(
        "div",
        { class: "row" },
        el("button", {
          type: "button",
          text: "Check",
          onclick: (event) =>
            act(
              "chapters.reconcile.check",
              async () => render(await api("/chapters/reconcile", { method: "POST", body: { dryRun: true } })),
              { button: event.currentTarget },
            ),
        }),
        // One button per archive, each running only the pass that writes the
        // table being looked at. A single "do everything" button would have
        // meant clicking "Record them" on the deleted archive and silently
        // writing several thousand rows into `uploaded`, which is not what the
        // label says and not what the operator is looking at.
        archive === "uploaded" ? adoptButton() : archiveButton(),
      ),
      output,
    ),
  );
}

/**
 * Bulk actions over the ticked chapters, or over everything the filter matches.
 *
 * Every one of these opens the same preview-then-apply dialog rather than
 * firing: the server's dry run is not optional decoration, it is how an operator
 * sees the actual list of public pages they are about to change.
 */
function chapterBulkBar(selected, scope, rows, data, activeFilter, archive, reload) {
  const count = selected.size;
  const total = data.total ?? 0;
  const targeting = scope.wholeFilter ? total : count;

  const bulk = (label, action, danger) =>
    gatedButton("chapters:write", {
      class: danger ? "danger" : null,
      text: label,
      disabled: targeting === 0,
      title:
        targeting === 0
          ? "Tick some chapters, or switch to the whole filter"
          : `Preview this over ${targeting} chapter(s) first`,
      onclick: () =>
        chapterBulkDialog({
          action,
          archive,
          target: scope.wholeFilter ? { filter: activeFilter() } : { ids: [...selected] },
          targeting,
          done: () => {
            selected.clear();
            reload();
          },
        }),
    });

  return el(
    "div",
    { class: "row bulk-bar" },
    el("span", {
      class: targeting ? null : "dim",
      text: scope.wholeFilter
        ? `Acting on all ${total} matching this filter`
        : count
          ? `${count} selected`
          : "Tick chapters to act on them",
    }),
    bulk("Edit…", "edit", false),
    bulk("Mark unavailable…", "unavailable", false),
    bulk("Delete…", "delete", true),
    el("span", { class: "grow" }),
    el(
      "label",
      { class: "inline", for: "chapter-whole-filter" },
      el("input", {
        id: "chapter-whole-filter",
        type: "checkbox",
        checked: scope.wholeFilter,
        onchange: (event) => {
          scope.wholeFilter = event.target.checked;
          reload();
        },
      }),
      " whole filter",
    ),
    el("button", {
      type: "button",
      text: rows.length && count === rows.length ? "Select none" : "Select all on this page",
      disabled: rows.length === 0 || scope.wholeFilter,
      onclick: () => {
        if (count === rows.length) selected.clear();
        else for (const entry of rows) selected.add(entry.mdChapterId);
        reload();
      },
    }),
  );
}

function chapterFilterCard(extensions, onChange) {
  const text = (id, label, key, placeholder) =>
    el(
      "span",
      { class: "row tight" },
      el("label", { class: "inline", for: id, text: label }),
      el("input", {
        id,
        type: "text",
        value: store.filters[key],
        placeholder,
        onchange: (event) => {
          setFilter({ [key]: event.target.value });
          onChange();
        },
      }),
    );

  return card(
    "Filter",
    row(
      // The extension list is a resource of its own so the picker offers what
      // this archive actually holds, with counts; an extension that has never
      // published is not a useful filter option.
      live(
        [extensions],
        (data) =>
          el(
            "span",
            { class: "row tight" },
            el("label", { class: "inline", for: "chapter-extension", text: "Extension" }),
            el(
              "select",
              {
                id: "chapter-extension",
                onchange: (event) => {
                  setFilter({ chapterExtension: event.target.value });
                  onChange();
                },
              },
              el("option", {
                value: "",
                text: "all",
                selected: store.filters.chapterExtension === "",
              }),
              (data.extensions ?? []).map((entry) =>
                el("option", {
                  value: entry.extension,
                  text: `${entry.extension || "(unattributed)"} · ${entry.count}`,
                  selected: entry.extension === store.filters.chapterExtension,
                }),
              ),
            ),
          ),
        { reserve: 32, skeleton: () => el("span", { class: "dim small", text: "extensions…" }) },
      ),
      text("chapter-search", "Search", "chapterSearch", "title, name, or any id"),
      text("chapter-number", "Chapter", "chapterNumber", "exact, e.g. 12.5"),
      text("chapter-language", "Language", "chapterLanguage", "e.g. en"),
      el("button", {
        type: "button",
        text: "Clear",
        onclick: () => {
          setFilter({
            chapterExtension: "",
            chapterLanguage: "",
            chapterNumber: "",
            chapterSearch: "",
          });
          onChange();
        },
      }),
    ),
    el("p", {
      class: "dim small",
      text:
        "Search matches the series name, the chapter title and any of the four ids, so a chapter id " +
        "pasted from a MangaDex URL or a Discord embed finds its row.",
    }),
  );
}

function chapterTable(rows, archive, selected, reload) {
  return table(
    ["", "Series", "Chapter", "Language", "Extension", CHAPTER_ARCHIVE_LABELS[archive] ?? "When", ""],
    rows.map((entry) => [
      el("input", {
        type: "checkbox",
        checked: selected.has(entry.mdChapterId),
        "aria-label": `Select ${entry.mangaName ?? entry.mdChapterId} ${chapterLabel(entry)}`,
        onchange: (event) => {
          if (event.target.checked) selected.add(entry.mdChapterId);
          else selected.delete(entry.mdChapterId);
          reload();
        },
      }),
      routeLink(routeTo("chapters", entry.mdChapterId, null), truncate(entry.mangaName || "-", 48)),
      chapterLabel(entry),
      entry.chapterLanguage || "-",
      entry.extension || "-",
      fmtTime(entry.at),
      [
        el("a", {
          class: "button-link inline",
          href: `https://mangadex.org/chapter/${encodeURIComponent(entry.mdChapterId)}`,
          target: "_blank",
          rel: "noreferrer noopener",
          text: "MangaDex",
        }),
        entry.editCount > 0 ? el("span", { class: "dim small", text: `${entry.editCount} edit(s)` }) : null,
      ],
    ]),
    {
      empty:
        archive === "uploaded"
          ? "No chapter has been published yet, or none matches this filter."
          : "Nothing in this archive matches.",
    },
  );
}

/** "Vol. 2 Ch. 12.5; Title", degrading to whichever parts exist. */
function chapterLabel(entry) {
  const number = entry.chapterNumber ? `Ch. ${entry.chapterNumber}` : "Oneshot";
  const volume = entry.chapterVolume ? `Vol. ${entry.chapterVolume} ` : "";
  return truncate(`${volume}${number}${entry.chapterTitle ? `: ${entry.chapterTitle}` : ""}`, 72);
}

function chapterPager(data, walked, go) {
  return el(
    "div",
    { class: "row pager" },
    el("span", {
      class: "dim small",
      text: `${data.chapters?.length ?? 0} shown of ${data.total ?? 0} matching · ${data.order ?? ""}`,
    }),
    el("span", { class: "grow" }),
    el("button", {
      type: "button",
      text: "← Back",
      disabled: walked.length === 0,
      onclick: () => go(walked.slice(0, -1)),
    }),
    el("button", {
      type: "button",
      text: "Next →",
      disabled: !data.nextCursor,
      onclick: () => go([...walked, data.nextCursor]),
    }),
  );
}

/**
 * One chapter: our record of it, what MangaDex says about it right now, what is
 * already queued against it, and its edit history.
 *
 * The live column is the one that decides anything. Our row is a mirror written
 * when the chapter was published and may be days stale, while the operator is
 * about to change a public catalogue entry; so where the two disagree, the
 * page shows both rather than picking one.
 */
function chapterDetail(mdChapterId) {
  const detail = new Resource(`chapter:${mdChapterId}`, () =>
    api(`/chapters/${encodeURIComponent(mdChapterId)}`),
  );

  return live(
    [detail],
    (data) => {
      const chapter = data.chapter ?? {};
      const archives = data.archives ?? {};
      return el(
        "div",
        {},
        card(
          null,
          row(
            archives.deleted ? chip("DELETED") : null,
            archives.unavailable ? chip("UNAVAILABLE") : null,
            archives.uploaded ? chip("UPLOADED") : null,
            archives.edited ? chip("EDITED") : null,
            el("span", {
              class: "dim",
              text: `${chapter.extension || "unattributed"} · ${chapterLabel(chapter)}`,
            }),
          ),
          defs([
            ["Series", chapter.mangaName || "-"],
            ["MangaDex chapter", el("code", { text: mdChapterId })],
            ["MangaDex title", chapter.mdMangaId ? mdTitleLink(chapter.mdMangaId, chapter.mdMangaId) : "-"],
            ["Group", chapter.mdGroupId ? el("code", { text: chapter.mdGroupId }) : "-"],
            ["Language", chapter.chapterLanguage || "-"],
            ["Source chapter id", chapter.chapterId ? el("code", { text: chapter.chapterId }) : "-"],
            ["Source URL", chapter.chapterUrl || "-"],
            ["Published by the source", fmtTime(chapter.chapterTimestamp)],
            ["Source expiry", fmtTime(chapter.chapterExpire)],
            ["Uploaded", fmtTime(archives.uploaded)],
            ["Marked unavailable", fmtTime(archives.unavailable)],
            ["Deleted", fmtTime(archives.deleted)],
          ]),
          row(
            el("a", {
              class: "button-link inline",
              href: data.links?.chapter ?? `https://mangadex.org/chapter/${encodeURIComponent(mdChapterId)}`,
              target: "_blank",
              rel: "noreferrer noopener",
              text: "Open on MangaDex",
            }),
            chapter.chapterUrl
              ? el("a", {
                  class: "button-link inline",
                  href: chapter.chapterUrl,
                  target: "_blank",
                  rel: "noreferrer noopener",
                  text: "Open the source",
                })
              : null,
            copyLinkButton(routeTo("chapters", mdChapterId, null)),
          ),
        ),
        chapterActionsCard(data, detail),
        chapterMangadexCard(data),
        chapterTasksCard(data),
        chapterEditsCard(data),
      );
    },
    { reserve: 420, skeleton: () => el("div", {}, skeletonTable(10, 2), skeletonTable(4, 4)) },
  );
}

/**
 * The three verbs, with the reason they are unavailable rather than a button
 * that 403s. `actionsBlockedReason` comes from the server, so the page and the
 * endpoint cannot disagree about who may do this.
 */
function chapterActionsCard(data, detail) {
  const blocked = data.actionsBlockedReason;
  const already = Boolean(data.archives?.unavailable);

  return card(
    "Change this chapter on MangaDex",
    el("p", {
      class: "dim small",
      text:
        "Each of these queues one upload task. core-uploader, the only process holding MangaDex " +
        "credentials, picks it up within a few seconds and the result appears under Queues.",
    }),
    blocked ? el("p", { class: "error", text: blocked }) : null,
    row(
      gatedButton("chapters:write", {
        text: "Edit metadata…",
        disabled: Boolean(blocked),
        onclick: () => chapterEditDialog(data, detail),
      }),
      gatedButton("chapters:write", {
        text: already ? "Regenerate the unavailable card…" : "Mark unavailable…",
        disabled: Boolean(blocked),
        title: already
          ? "Renders a fresh card and posts it over the one already on this chapter"
          : "Replaces the chapter's page with a card explaining the publisher removed it",
        onclick: () => chapterUnavailableDialog(data, detail, already),
      }),
      gatedButton("chapters:write", {
        class: "danger",
        text: "Delete from MangaDex…",
        disabled: Boolean(blocked),
        onclick: () => chapterDeleteDialog(data, detail),
      }),
    ),
  );
}

function chapterMangadexCard(data) {
  const md = data.mangadex;
  if (!md) {
    return card(
      "On MangaDex now",
      el("p", { class: "error", text: data.mangadexError ?? "MangaDex could not be read." }),
      el("p", {
        class: "dim small",
        text:
          "Actions still work: they are queued for the uploader, which reads MangaDex itself when it " +
          "runs them.",
      }),
    );
  }
  return card(
    "On MangaDex now",
    defs([
      ["Volume", md.volume || "-"],
      ["Chapter", md.chapter || "-"],
      ["Title", md.title || "-"],
      ["Language", md.translatedLanguage || "-"],
      ["External URL", md.externalUrl || "; (none: this chapter has pages)"],
      ["Groups", (md.groups ?? []).join(", ") || "-"],
      ["Version", String(md.version ?? "-")],
      ["Created", fmtTime(md.createdAt)],
    ]),
  );
}

function chapterTasksCard(data) {
  const tasks = data.tasks ?? [];
  return card(
    "Queued against this chapter",
    table(
      ["Kind", "State", "Attempts", "Due", "Last error"],
      tasks.map((task) => [
        task.kind,
        chip(task.state),
        `${task.attempt}/${task.maxAttempts}`,
        fmtTime(task.notBefore),
        truncate(task.lastError, 160),
      ]),
      { empty: "Nothing is queued for this chapter." },
    ),
    tasks.length
      ? routeLink(routeTo("queues", null, "tasks"), "Open the queue", { class: "button-link inline" })
      : null,
  );
}

function chapterEditsCard(data) {
  const edits = data.edits ?? [];
  if (!edits.length) return null;
  return card(
    "Edit history",
    table(
      ["When", "Changed to", "From"],
      edits
        .slice()
        .reverse()
        .map((edit) => [
          fmtTime(edit.editedAt),
          truncate(JSON.stringify(edit.new ?? {}), 160),
          truncate(JSON.stringify(edit.old ?? {}), 160),
        ]),
      { empty: "No edits recorded." },
    ),
  );
}

/**
 * Queue an edit of the chapter's MangaDex metadata.
 *
 * Prefilled from what MangaDex currently holds, falling back to our row when it
 * could not be read; and only the fields the operator actually changed are
 * sent, so an unrelated value cannot be pinned to a stale prefill.
 */
function chapterEditDialog(data, detail) {
  const md = data.mangadex ?? {};
  const stored = data.chapter ?? {};
  const initial = {
    volume: md.volume ?? stored.chapterVolume ?? "",
    chapter: md.chapter ?? stored.chapterNumber ?? "",
    title: md.title ?? stored.chapterTitle ?? "",
    translatedLanguage: md.translatedLanguage ?? stored.chapterLanguage ?? "",
    externalUrl: md.externalUrl ?? stored.chapterUrl ?? "",
    groups: (md.groups ?? (stored.mdGroupId ? [stored.mdGroupId] : [])).join(", "),
  };

  const inputs = {};
  const field = (key, label, hint) => {
    const id = `chapter-edit-${key}`;
    inputs[key] = el("input", { id, type: "text", value: initial[key] });
    return [
      el("label", { for: id, text: label }),
      inputs[key],
      hint ? el("p", { class: "dim small", text: hint }) : null,
    ];
  };

  const body = el(
    "div",
    {},
    el("p", {
      class: "dim small",
      text:
        "Only the fields you change are sent. The uploader lays them over whatever MangaDex holds at " +
        "the moment it runs, because PUT /chapter replaces the whole resource and needs the current " +
        "version.",
    }),
    field("chapter", "Chapter number", "Blank clears it; a oneshot has no number."),
    field("volume", "Volume", ""),
    field("title", "Title", ""),
    field("translatedLanguage", "Language", "A MangaDex language code, e.g. en, ja, pt-br."),
    field("externalUrl", "External URL", "The publisher link readers are sent to."),
    field("groups", "Groups", "Comma-separated MangaDex group ids."),
    el(
      "div",
      { class: "row end" },
      el("button", { type: "button", text: "Cancel", onclick: closeModal }),
      gatedButton("chapters:write", {
        class: "primary",
        text: "Queue the edit",
        onclick: async (event) => {
          const payload = {};
          for (const key of ["chapter", "volume", "title", "translatedLanguage", "externalUrl"]) {
            const value = inputs[key].value.trim();
            if (value === String(initial[key] ?? "").trim()) continue;
            // An emptied field is a deliberate clear, which MangaDex expresses
            // as null. Language is the exception: a chapter always has one, so
            // blanking it means "leave it alone" rather than "remove it".
            if (value === "") {
              if (key === "translatedLanguage") continue;
              payload[key] = null;
            } else {
              payload[key] = value;
            }
          }
          const groups = inputs.groups.value
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
          if (groups.join(", ") !== initial.groups) payload.groups = groups;

          if (Object.keys(payload).length === 0) {
            toast("nothing changed", false);
            return;
          }
          const result = await act(
            "chapter.edit",
            () =>
              api(`/chapters/${encodeURIComponent(data.mdChapterId)}`, {
                method: "PATCH",
                body: payload,
              }),
            { button: event.currentTarget, refresh: [detail, summary] },
          );
          if (result) {
            reportChapterQueued(result);
            closeModal();
          }
        },
      }),
    ),
  );

  openModal("Edit chapter metadata", body);
}

/**
 * Queue "replace this chapter with an unavailable card", with the card itself
 * on screen first.
 *
 * The preview is rendered by the server from the same function the uploader
 * uses, so what is approved here is what gets posted. It is an `<img>` rather
 * than a fetch because the endpoint answers PNG bytes and the session cookie
 * carries it; the CSP allows `img-src 'self'`.
 */
function chapterUnavailableDialog(data, detail, already) {
  const note = el("textarea", {
    id: "chapter-note",
    rows: "3",
    maxlength: "600",
    placeholder: "Leave blank for the standard wording.",
  });

  const preview = el("img", {
    class: "card-preview",
    alt: "Preview of the card that will be posted as this chapter's only page",
    src: previewSrc(data.mdChapterId, ""),
  });

  const refresh = () => {
    preview.src = previewSrc(data.mdChapterId, note.value.trim());
  };

  const body = el(
    "div",
    {},
    el("p", {
      text: already
        ? "This chapter already carries an unavailable card. Queueing this renders a fresh one and " +
          "posts it over the old page."
        : "The chapter keeps its place on MangaDex. Its page becomes the card below, and the " +
          "publisher link is repointed away from the dead chapter URL.",
    }),
    el("label", { for: "chapter-note", text: "Footer note" }),
    note,
    row(el("button", { type: "button", text: "Refresh the preview", onclick: refresh })),
    preview,
    el(
      "div",
      { class: "row end" },
      el("button", { type: "button", text: "Cancel", onclick: closeModal }),
      gatedButton("chapters:write", {
        class: "primary",
        text: already ? "Queue a fresh card" : "Queue it",
        onclick: async (event) => {
          const result = await act(
            "chapter.unavailable",
            () =>
              api(`/chapters/${encodeURIComponent(data.mdChapterId)}/unavailable`, {
                method: "POST",
                // `force` is what makes this repeatable: without it the uploader
                // treats an already-archived chapter as done and changes nothing.
                body: { force: already, ...(note.value.trim() ? { footerNote: note.value.trim() } : {}) },
              }),
            { button: event.currentTarget, refresh: [detail, summary] },
          );
          if (result) {
            reportChapterQueued(result);
            closeModal();
          }
        },
      }),
    ),
  );

  openModal(already ? "Regenerate the unavailable card" : "Mark this chapter unavailable", body);
}

function previewSrc(mdChapterId, note) {
  const q = new URLSearchParams();
  if (note) q.set("footerNote", note);
  // Cache-busting is belt-and-braces, the endpoint sends no-store, but an
  // `<img>` whose src did not change is not re-fetched at all.
  q.set("t", String(Date.now()));
  return `${API}/chapters/${encodeURIComponent(mdChapterId)}/card.png?${q}`;
}

function chapterDeleteDialog(data, detail) {
  const reason = el("input", { id: "chapter-reason", type: "text", maxlength: "500" });
  const body = el(
    "div",
    {},
    el("p", {
      text:
        "Deleting removes the chapter from MangaDex outright. Readers lose it, and nothing here can " +
        "bring it back; the archive row records what was removed, not the pages.",
    }),
    el("ul", { class: "errors" }, [
      el("li", { text: "Marking it unavailable keeps the entry and explains the takedown instead." }),
      el("li", { text: "The change is queued; the uploader performs it within seconds." }),
    ]),
    el("label", { for: "chapter-reason", text: "Reason (recorded in the audit trail)" }),
    reason,
    el(
      "div",
      { class: "row end" },
      el("button", { type: "button", text: "Cancel", onclick: closeModal }),
      gatedButton("chapters:write", {
        class: "danger",
        text: "Queue the delete",
        onclick: async (event) => {
          const result = await act(
            "chapter.delete",
            () =>
              api(`/chapters/${encodeURIComponent(data.mdChapterId)}`, {
                method: "DELETE",
                body: { confirm: true, ...(reason.value.trim() ? { reason: reason.value.trim() } : {}) },
              }),
            { button: event.currentTarget, refresh: [detail, summary] },
          );
          if (result) {
            reportChapterQueued(result);
            closeModal();
          }
        },
      }),
    ),
  );

  openModal("Delete this chapter from MangaDex", body);
}

/**
 * One dialog for all three bulk actions: fill in what changes, **preview**, then
 * apply.
 *
 * The preview is the server's own dry run, and the apply button stays disabled
 * until it has been seen. That is not UI ceremony duplicating a server check,
 * the server would refuse a live call without `{dryRun: false, confirm: true}`
 * anyway, it is making the safe order the only order the page offers, so the
 * list of public pages about to change is always read before it changes.
 */
function chapterBulkDialog({ action, archive, target, targeting, done }) {
  const inputs = {};
  const field = (key, label, hint, attrs = {}) => {
    const id = `chapter-bulk-${key}`;
    inputs[key] = el("input", { id, type: "text", ...attrs });
    return [
      el("label", { for: id, text: label }),
      inputs[key],
      hint ? el("p", { class: "dim small", text: hint }) : null,
    ];
  };

  const force = el("input", { id: "chapter-bulk-force", type: "checkbox" });
  const body = el("div", {});
  const preview = el("div", {});

  const specifics =
    action === "edit"
      ? el(
          "div",
          {},
          el("p", {
            class: "dim small",
            text:
              "Only the fields a set of chapters can share. A title, a chapter number or a source URL " +
              "belongs to one chapter, so those stay on the single-chapter form.",
          }),
          field("volume", "Volume", "Blank leaves it alone, and “-” is not a clear; use the single-chapter form to clear."),
          field("translatedLanguage", "Language", "A MangaDex language code, e.g. en, ja, pt-br."),
          field("groups", "Groups", "Comma-separated MangaDex group ids."),
        )
      : action === "unavailable"
        ? el(
            "div",
            {},
            el("p", {
              text:
                "Each chapter keeps its place on MangaDex; its page becomes the card and its publisher " +
                "link is repointed. Cards are rendered per chapter from that chapter's own details.",
            }),
            el("label", { class: "inline", for: "chapter-bulk-force" }, force, " re-card chapters that already have one"),
            ...field("footerNote", "Footer note", "Replaces the standard wording on every card in this batch.", {
              maxlength: "600",
            }),
          )
        : el(
            "div",
            {},
            el("p", {
              text:
                "Deleting removes these chapters from MangaDex outright. Readers lose them and nothing " +
                "here brings them back.",
            }),
            ...field("reason", "Reason (recorded against every chapter in the audit trail)", "", {
              maxlength: "500",
            }),
          );

  /** The action-specific half of the request body. */
  const changes = () => {
    if (action === "edit") {
      const out = {};
      const volume = inputs.volume.value.trim();
      const language = inputs.translatedLanguage.value.trim();
      const groups = inputs.groups.value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (volume) out.volume = volume;
      if (language) out.translatedLanguage = language;
      if (groups.length) out.groups = groups;
      return { changes: out };
    }
    if (action === "unavailable") {
      const note = inputs.footerNote.value.trim();
      return { force: force.checked, ...(note ? { footerNote: note } : {}) };
    }
    const reason = inputs.reason.value.trim();
    return reason ? { reason } : {};
  };

  const call = (extra) =>
    api(`/chapters/bulk/${action}`, { method: "POST", body: { ...target, ...changes(), ...extra } });

  const applyButton = gatedButton("chapters:write", {
    class: action === "delete" ? "danger" : "primary",
    text: "Preview first",
    disabled: true,
    onclick: async (event) => {
      const result = await act(`chapter.bulk_${action}`, () => call({ dryRun: false, confirm: true }), {
        button: event.currentTarget,
      });
      if (result) {
        reportChapterBulk(result);
        closeModal();
        done();
      }
    },
  });

  const previewButton = gatedButton("chapters:read", {
    text: "Preview",
    onclick: async (event) => {
      const result = await act("chapter.bulk_preview", () => call({ dryRun: true }), {
        button: event.currentTarget,
      });
      if (!result) return;
      applyButton.disabled = !can("chapters:write") || result.wouldQueue === 0;
      applyButton.textContent =
        result.wouldQueue === 0
          ? "Nothing to queue"
          : `Queue ${result.wouldQueue} chapter(s)`;
      setChildren(preview, chapterBulkPreview(result, archive));
    },
  });

  setChildren(
    body,
    el("p", {
      class: "dim small",
      text: target.filter
        ? `Every chapter matching the current filter (${targeting} right now).`
        : `${targeting} selected chapter(s).`,
    }),
    specifics,
    el("div", { class: "row end" }, previewButton, applyButton, el("button", { type: "button", text: "Cancel", onclick: closeModal })),
    preview,
  );

  openModal(
    action === "edit"
      ? "Edit these chapters on MangaDex"
      : action === "unavailable"
        ? "Mark these chapters unavailable"
        : "Delete these chapters from MangaDex",
    body,
  );
}

/** The dry run, rendered: what would happen to each chapter, and what would not. */
function chapterBulkPreview(result, archive) {
  const blocked = (result.results ?? []).filter((item) => !item.ok);
  return el(
    "div",
    {},
    el("h3", { text: "Preview" }),
    defs([
      ["Matching the filter", String(result.matched ?? result.resolved ?? 0)],
      ["Would be queued", String(result.wouldQueue ?? 0)],
      ["Blocked", String(blocked.length)],
    ]),
    result.capped
      ? el("p", {
          class: "error",
          text: `More chapters match than the ${result.cap}-chapter cap. This queues the first ${result.cap}; run it again for the rest.`,
        })
      : null,
    table(
      ["Series", "Chapter", "Language", "Would happen"],
      (result.results ?? []).slice(0, 100).map((item) => [
        truncate(item.mangaName || item.mdChapterId, 40),
        item.chapterNumber ? `Ch. ${item.chapterNumber}` : "-",
        item.chapterLanguage || "-",
        item.ok ? chip("queued") : el("span", { class: "dim small", text: item.reason ?? item.outcome }),
      ]),
      { empty: `Nothing in the ${archive} archive matched.` },
    ),
    (result.results ?? []).length > 100
      ? el("p", { class: "dim small", text: `…and ${result.results.length - 100} more.` })
      : null,
  );
}

/**
 * Per-chapter results, reported rather than summarised; a batch where eight
 * chapters queued and two were refused is a success and a partial failure at
 * once, and collapsing that to "ok" loses the only part worth acting on.
 */
function reportChapterBulk(result) {
  const refused = (result.results ?? []).filter((item) => !item.ok);
  if (refused.length === 0) {
    toast(`${result.queued} chapter(s) queued`);
    return;
  }
  toast(`${result.queued} queued, ${refused.length} refused`, false);
  openModal(
    "Some chapters were refused",
    el(
      "div",
      {},
      el("p", { class: "dim small", text: "The rest of the batch was queued. These were not, and why:" }),
      el(
        "ul",
        { class: "errors" },
        refused
          .slice(0, 50)
          .map((item) =>
            el("li", { text: `${item.mangaName ?? item.mdChapterId}: ${item.reason ?? item.outcome}` }),
          ),
      ),
      el("div", { class: "row end" }, el("button", { type: "button", text: "Close", onclick: closeModal })),
    ),
  );
}

/** Say what was queued; including that a completed task was reset in place. */
function reportChapterQueued(result) {
  const parts = [`${result.action} queued`];
  if (result.superseded) parts.push("a previously completed task for this chapter was reused");
  for (const warning of result.warnings ?? []) parts.push(warning);
  toast(parts.join(" · "));
}

// ------------------------------------------------------------------- activity

const SEVERITY_TONE = { error: "bad", warn: "warn", info: "" };
const ACTIVITY_WINDOWS = [
  [1, "last hour"],
  [6, "last 6 hours"],
  [24, "last 24 hours"],
  [72, "last 3 days"],
  [168, "last week"],
  [720, "last 30 days"],
];

/**
 * Every application-level event the platform recorded, newest first: runs, jobs
 * (including the last error of a job that is still retrying), upload tasks,
 * quarantined submissions, and the audit trail.
 *
 * Everything here is a durable row, which is why it can be filtered, linked to,
 * and read months later. Process stdout is not here, a stack trace from a crash
 * loop or a prisma connection warning, because nothing writes it to
 * the database. That still lives in `docker logs` on the host.
 */
VIEWS.activity = () => {
  const feed = new Resource("activity", () => {
    const f = store.filters;
    const query = new URLSearchParams({
      severity: f.activitySeverity,
      hours: String(f.activityHours),
      limit: String(f.activityLimit),
    });
    if (f.activityQuery) query.set("q", f.activityQuery);
    if (f.activityExtension) query.set("extension", f.activityExtension);
    return api(`/activity?${query}`);
  });

  const picker = (id, label, options, current, key) =>
    el(
      "span",
      { class: "row tight" },
      el("label", { for: id, class: "inline", text: label }),
      el(
        "select",
        {
          id,
          onchange: (event) => {
            setFilter({ [key]: event.target.value });
            void feed.load({ force: true });
          },
        },
        options.map(([value, text]) =>
          el("option", { value: String(value), text, selected: String(value) === String(current) }),
        ),
      ),
    );

  // The search box lives outside the reactive region on purpose: a redraw that
  // replaced it would take the caret with it.
  const search = el("input", {
    id: "activity-q",
    type: "search",
    value: store.filters.activityQuery,
    placeholder: "text in the subject or message",
    "aria-label": "Filter activity by text",
  });
  const apply = () => {
    setFilter({ activityQuery: search.value.trim() });
    void feed.load({ force: true });
  };
  // Enter rather than every keystroke: each search is a server round trip over
  // five tables.
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") apply();
  });

  return el(
    "div",
    {},
    card(
      "Filter",
      el("p", {
        class: "dim small",
        text:
          "Application events only; container stdout is not captured here and is still read with " +
          "docker logs on the host.",
      }),
      row(
        picker(
          "activity-severity",
          "Severity",
          [
            ["all", "everything"],
            ["error", "errors only"],
            ["warn", "warnings"],
            ["info", "informational"],
          ],
          store.filters.activitySeverity,
          "activitySeverity",
        ),
        picker("activity-hours", "Window", ACTIVITY_WINDOWS, store.filters.activityHours, "activityHours"),
        picker(
          "activity-limit",
          "Rows",
          [25, 50, 100, 250, 500].map((n) => [n, String(n)]),
          store.filters.activityLimit,
          "activityLimit",
        ),
        search,
        el("button", { type: "button", text: "Search", onclick: apply }),
        el("button", {
          type: "button",
          text: "Clear",
          onclick: () => {
            search.value = "";
            setFilter({ activityQuery: "", activityExtension: "" });
            void feed.load({ force: true });
          },
        }),
      ),
      liveState(["filters"], () =>
        store.filters.activityExtension
          ? el("p", { class: "dim small", text: `Filtered to extension ${store.filters.activityExtension}.` })
          : el("span", {}),
      ),
    ),
    card(
      null,
      live(
        [feed],
        (data) =>
          el(
            "div",
            {},
            (data.omittedSources || []).length
              ? el("div", {
                  class: "banner",
                  text: `Audit events are not shown: ${data.omittedSources.map((o) => o.reason).join("; ")}.`,
                })
              : null,
            table(
              ["When", "Severity", "Subject", "Message", ""],
              data.activity.map((entry) => [
                el(
                  "div",
                  {},
                  el("div", { text: fmtTime(entry.at) }),
                  el("div", { class: "dim small", text: ago(entry.at) }),
                ),
                el("span", { class: `chip ${SEVERITY_TONE[entry.severity]}`.trim(), text: entry.severity }),
                el(
                  "div",
                  {},
                  el("div", { text: entry.subject }),
                  el("div", { class: "dim small", text: entry.kind }),
                ),
                truncate(entry.message, 300) || "-",
                activityActions(entry),
              ]),
              { empty: "Nothing happened in this window. Widen it, or clear the filters." },
            ),
          ),
        { reserve: 340, skeleton: () => skeletonTable(9, 5) },
      ),
    ),
  );
};

/**
 * Per-row actions: open the thing the row is about, and copy a link that lands
 * somebody else on it.
 */
function activityActions(entry) {
  // A job's own id opens nothing actionable; its run shows every sibling
  // segment and the retry buttons, so that is what the link points at.
  const hash =
    entry.source === "job" && entry.runId
      ? routeTo("runs", entry.runId, null)
      : entry.source === "run"
        ? routeTo("runs", entry.id, null)
        : entry.source === "audit"
          ? routeTo("audit", entry.id, null)
          : entry.source === "upload-task"
            ? routeTo("queues", null, "tasks")
            : routeTo("errors", null, "quarantine");

  return [routeLink(hash, "Open", { class: "button-link inline" }), copyLinkButton(hash)];
}

// --------------------------------------------------------------------- errors

/**
 * The failure list, and the controls that empty it.
 *
 * This view is a to-do list rather than a log: an operator who has read a
 * failure and dealt with it clears the entry and it stops being shown, so what
 * remains is what still needs attention. Nothing is deleted; the row itself is
 * untouched, "Cleared" lists what was acknowledged and by whom, and Restore puts
 * an entry back. A failure that happens AGAIN reappears on its own, because the
 * acknowledgement is recorded against the failure's timestamp (see
 * core/observability/errorFeed.ts).
 */
VIEWS.errors = (route) => {
  if (route.tab === "quarantine") return quarantinePanel();

  const errors = new Resource("errors", () =>
    api(`/errors?limit=100&cleared=${encodeURIComponent(store.filters.errorsCleared)}`),
  );

  // Outside the reactive region, like the Activity search box: a redraw that
  // replaced it would take the caret and the half-typed note with it.
  const note = el("input", {
    id: "errors-note",
    type: "text",
    maxlength: 500,
    placeholder: "why this is fine (optional)",
    "aria-label": "Note to attach when clearing",
  });

  const clear = (body, label, button) =>
    act(label, () => api("/errors/clear", { method: "POST", body: { ...body, note: note.value.trim() || undefined } }), {
      button,
      refresh: [errors, summary],
    }).then((result) => {
      if (!result) return;
      note.value = "";
      // Entries that were not actually failing are reported, not swallowed: a
      // row from a stale poll is the common case and the operator should know
      // their click did nothing.
      for (const skip of result.skipped ?? []) toast(`${skip.id.slice(0, 8)}: ${skip.reason}`, false);
    });

  const restore = (body, label, button) =>
    act(label, () => api("/errors/restore", { method: "POST", body }), { button, refresh: [errors, summary] });

  const showing = store.filters.errorsCleared;

  return el(
    "div",
    {},
    card(
      "Failures",
      el("p", {
        class: "dim small",
        text:
          "Dead-lettered jobs, failed upload tasks and quarantined submissions in one time-ordered list, so " +
          "triage starts here instead of in docker logs. Clearing an entry hides it from this list only; the " +
          "job, task or submission is untouched, and anything that fails again comes back.",
      }),
      row(
        el("label", { class: "inline", for: "errors-cleared", text: "Show" }),
        el(
          "select",
          {
            id: "errors-cleared",
            onchange: (event) => {
              setFilter({ errorsCleared: event.target.value });
              void errors.load({ force: true });
            },
          },
          [
            ["without", "outstanding only"],
            ["with", "outstanding and cleared"],
            ["only", "cleared only"],
          ].map(([value, text]) => el("option", { value, text, selected: value === showing })),
        ),
        el("label", { class: "inline", for: "errors-note", text: "Note" }),
        note,
        gatedButton("runs:write", {
          text: "Clear all",
          title: "Acknowledge every outstanding failure in this list",
          onclick: async (event) => {
            const button = event.currentTarget;
            const outstanding = summary.data?.stats?.errorsOutstanding?.total ?? null;
            const ok = await confirmDialog({
              title: "Clear every outstanding failure?",
              lead:
                outstanding === null
                  ? "Every failure currently in the feed will be marked as dealt with."
                  : `${outstanding} outstanding failure(s) will be marked as dealt with.`,
              points: [
                "Nothing is deleted: jobs, upload tasks and submissions keep their state, and Activity still shows every failure.",
                "Anything that fails again reappears here as new.",
                "Restore puts entries back, individually or all at once.",
              ],
              confirmLabel: "Clear all",
              danger: false,
            });
            if (ok) await clear({ all: true }, "clear all errors", button);
          },
        }),
        showing === "without"
          ? null
          : gatedButton("runs:write", {
              text: "Restore all",
              title: "Put every cleared entry back in the outstanding list",
              onclick: (event) => restore({ all: true }, "restore all errors", event.currentTarget),
            }),
      ),
    ),
    card(
      null,
      live(
        [errors],
        ({ errors: rows, clearedHidden }) =>
          el(
            "div",
            {},
            clearedHidden > 0 && showing === "without"
              ? el("p", {
                  class: "dim small",
                  text: `${clearedHidden} cleared entr${clearedHidden === 1 ? "y is" : "ies are"} hidden. Switch "Show" to review them.`,
                })
              : null,
            table(
              ["When", "Kind", "Subject", "Message", ""],
              rows.map((entry) => [
                el(
                  "div",
                  {},
                  el("div", { text: fmtTime(entry.at) }),
                  el("div", { class: "dim small", text: ago(entry.at) }),
                ),
                el(
                  "div",
                  {},
                  chip(String(entry.kind).split(":")[1] ?? entry.kind),
                  entry.cleared ? chip("cleared") : null,
                ),
                el(
                  "div",
                  {},
                  el("div", { text: entry.subject }),
                  el("div", { class: "dim small", text: entry.kind }),
                  entry.cleared
                    ? el("div", {
                        class: "dim small",
                        text:
                          `cleared by ${entry.cleared.by} ${ago(entry.cleared.at)}` +
                          (entry.cleared.note ? `: ${entry.cleared.note}` : ""),
                      })
                    : null,
                ),
                truncate(entry.message, 280),
                entry.cleared
                  ? gatedButton("runs:write", {
                      text: "Restore",
                      onclick: (event) =>
                        restore(
                          { refs: [{ source: entry.source, id: entry.id }] },
                          "restore error",
                          event.currentTarget,
                        ),
                    })
                  : gatedButton("runs:write", {
                      text: "Clear",
                      title: "Mark this failure as read and dealt with",
                      onclick: (event) =>
                        clear({ refs: [{ source: entry.source, id: entry.id }] }, "clear error", event.currentTarget),
                    }),
              ]),
              {
                empty:
                  showing === "only"
                    ? "Nothing has been cleared."
                    : "Nothing is outstanding. Every failure has been dealt with, or nothing has failed.",
              },
            ),
          ),
        { reserve: 320, skeleton: () => skeletonTable(8, 5) },
      ),
    ),
  );
};

function quarantinePanel() {
  const quarantine = new Resource("quarantine", () => api("/quarantine"));
  return card(
    "Quarantined result submissions",
    el("p", {
      class: "dim small",
      text:
        "Envelopes rejected by schema or policy validation. Repeat offenders from one worker are the signal " +
        "to drain it.",
    }),
    live(
      [quarantine],
      ({ quarantined }) =>
        table(
          ["Job", "Worker", "Reject reason", "Received"],
          quarantined.map((item) => [
            el("code", { text: item.jobId }),
            el("code", { text: (item.workerId || "").slice(0, 8) }),
            truncate(item.rejectReason, 240),
            fmtTime(item.createdAt),
          ]),
          { empty: "Nothing is quarantined." },
        ),
      { reserve: 260, skeleton: () => skeletonTable(6, 4) },
    ),
  );
}

// ----------------------------------------------------------------- extensions

VIEWS.extensions = (route) => {
  if (route.param) return extensionDetail(route.param, route.tab ?? "overview");

  const extensions = new Resource("extensions", () => api("/extensions"));
  const removal = new Resource("removal-mode", () =>
    can("settings:read") ? api("/removal-mode", { quiet: true }) : Promise.resolve(null),
  );

  return el(
    "div",
    {},
    can("settings:read")
      ? card(
          "Chapter removal mode",
          live([removal], (data) => (data ? removalModeControls(data, removal) : el("span", {})), {
            reserve: 40,
            skeleton: () => el("div", { class: "skeleton skeleton-line", style: { height: "34px" } }),
          }),
        )
      : null,
    can("bundles:write") ? publishCard(extensions) : null,
    card(
      "Published bundles",
      live(
        [extensions],
        (data) =>
          table(
            ["Extension", "Version", "sha256", "Published", "State", ""],
            data.extensions.map((ext) => [
              routeLink(routeTo("extensions", ext.name, "overview"), ext.name),
              ext.version,
              el("code", { text: (ext.sha256 || "").slice(0, 12) }),
              fmtTime(ext.publishedAt),
              chip(ext.disabled ? "disabled" : "enabled"),
              [
                gatedButton("runs:write", { text: "Run", onclick: (e) => triggerRun(ext.name, "UPDATE", e.currentTarget) }),
                gatedButton("runs:write", { text: "Force", onclick: (e) => triggerRun(ext.name, "FORCE", e.currentTarget) }),
                gatedButton("runs:write", {
                  class: "danger",
                  text: "Clean",
                  onclick: (e) => triggerRun(ext.name, "CLEAN", e.currentTarget),
                }),
                gatedButton("extensions:write", {
                  text: ext.disabled ? "Enable" : "Disable",
                  onclick: (event) =>
                    act(
                      `extension.${ext.disabled ? "enable" : "disable"}`,
                      () =>
                        api(
                          `/extensions/${encodeURIComponent(ext.name)}/${ext.disabled ? "enable" : "disable"}`,
                          { method: "POST", body: {} },
                        ),
                      { button: event.currentTarget, refresh: [extensions, summary] },
                    ),
                }),
              ],
            ]),
            {
              empty:
                "No bundle is published, so nothing can run. Publish an extension bundle to get started.",
            },
          ),
        { reserve: 240, skeleton: () => skeletonTable(5, 6) },
      ),
    ),
  );
};

function removalModeControls(removal, resource) {
  const modeSelect = el(
    "select",
    { id: "removal-mode", "aria-label": "Chapter removal mode" },
    removal.validModes.map((mode) => el("option", { value: mode, text: mode, selected: mode === removal.mode })),
  );
  return row(
    el("label", { class: "inline", for: "removal-mode", text: "When a chapter disappears from the source" }),
    modeSelect,
    gatedButton("settings:write", {
      text: "Save",
      onclick: (event) =>
        act("removal-mode.set", () => api("/removal-mode", { method: "POST", body: { mode: modeSelect.value } }), {
          button: event.currentTarget,
          refresh: [resource],
        }),
    }),
  );
}

async function triggerRun(extension, kind, button) {
  if (
    kind === "CLEAN" &&
    !(await confirmDialog({
      title: `Start a CLEAN run for ${extension}`,
      lead: "A clean run re-reads the extension's entire back catalogue.",
      points: [
        "It can queue deletions for chapters it no longer sees.",
        "That is destructive on MangaDex and is not undone by cancelling the run.",
      ],
      confirmLabel: "Start the clean run",
    }))
  ) {
    return;
  }
  await act(`run.${kind}`, () => api("/runs", { method: "POST", body: { extension, kind } }), {
    button,
    refresh: [summary],
  });
}

// ------------------------------------------------------- bundle publishing (zip)

/**
 * CRC-32, table-driven. Needed because a zip entry carries its own checksum and
 * the archive is rejected outright without a correct one.
 */
const CRC_TABLE = (() => {
  const lookup = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    lookup[i] = c >>> 0;
  }
  return lookup;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a STORED (uncompressed) zip from picked files, in the browser.
 *
 * This is what makes "publish an extension directory" possible without a shell:
 * the directory picker hands us the files, and the publish endpoint wants a zip.
 * Store-only keeps it to one page of code with no dependency; the publish path
 * hashes and stores the archive rather than caring how well it compresses, and
 * AdmZip on the server reads stored entries like any other.
 *
 * Entry names are made relative to the picked directory, which also fixes the
 * single most common publish mistake: zipping the directory itself, so
 * manifest.json ends up one level down and the server cannot find it.
 */
async function zipStored(files) {
  const encoder = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;

  const u16 = (value) => [value & 0xff, (value >>> 8) & 0xff];
  const u32 = (value) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const crc = crc32(data);
    // Flag 0x0800 declares the name is UTF-8. Time/date are left at zero: a
    // bundle is identified by its sha256, so a fabricated mtime would only make
    // two byte-identical publishes hash differently.
    const header = [
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(name.length), ...u16(0),
    ];
    local.push(new Uint8Array(header), name, data);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
        ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
        ...u32(offset),
      ]),
      name,
    );
    offset += header.length + name.length + data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);
  return new Blob([...local, ...central, eocd], { type: "application/zip" });
}

/** Strip the picked directory's own name so manifest.json lands at the root. */
function relativeEntries(fileList) {
  const files = [...fileList];
  const paths = files.map((file) => file.webkitRelativePath || file.name);
  const root = paths[0]?.includes("/") ? `${paths[0].split("/")[0]}/` : "";
  return files
    .map((file, index) => ({ name: (paths[index] ?? file.name).slice(root.length), blob: file }))
    // Editor droppings and VCS metadata have no business in a published bundle,
    // and node_modules would blow past the 64 MiB body limit.
    .filter(
      (entry) =>
        entry.name &&
        !entry.name.startsWith(".git/") &&
        !entry.name.includes("/node_modules/") &&
        !entry.name.endsWith(".DS_Store") &&
        !entry.name.endsWith(".pyc"),
    );
}

/**
 * Publish a bundle: drop a zip, pick a zip, or pick the extension directory.
 *
 * Publishing runs a preflight first and shows the verdict inline. The reason is
 * not convenience: a publish is a code-execution change on every worker that
 * runs this extension, so an operator should be looking at the parsed manifest,
 * name, version, entrypoint, whether it replaces what is live, before they
 * confirm, not reading a 422 afterwards.
 */
function publishCard(extensions) {
  const file = el("input", { type: "file", id: "bundle-file", accept: ".zip,application/zip" });
  const dir = el("input", { type: "file", id: "bundle-dir" });
  // Not settable via the attribute allow-list in `el`, and only meaningful on
  // browsers that implement it; the zip picker next to it is the fallback.
  dir.webkitdirectory = true;
  dir.multiple = true;

  const status = el("div", { id: "bundle-status" });
  let pending = null;

  const setPending = async (blob, label) => {
    pending = { blob, label };
    status.replaceChildren(
      el("p", { class: "dim", text: `Checking ${label} (${(blob.size / 1024).toFixed(0)} KiB)…` }),
      el("div", { class: "skeleton skeleton-line", style: { height: "60px" } }),
    );
    const buffer = await blob.arrayBuffer();
    let verdict;
    try {
      verdict = await api("/bundles/inspect", {
        method: "POST",
        raw: true,
        body: buffer,
        headers: { "content-type": "application/zip" },
        quiet: true,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      // The preflight answers 422 with the reasons in the body; ApiError only
      // carries the first line, so re-read it for the full list.
      verdict = err.body ?? { ok: false, errors: [err.message] };
    }
    status.replaceChildren(publishVerdict(verdict, label, (button) => publishNow(pending, button)));
  };

  const publishNow = async (chosen, button) => {
    if (!chosen) return;
    const buffer = await chosen.blob.arrayBuffer();
    const published = await act(
      "bundle.publish",
      () =>
        api("/bundles", {
          method: "POST",
          raw: true,
          body: buffer,
          headers: { "content-type": "application/zip" },
        }),
      { button, refresh: [extensions] },
    );
    if (published) {
      toast(`published ${published.extension}@${published.version}`);
      status.replaceChildren();
    }
  };

  const drop = el("div", {
    class: "dropzone",
    id: "bundle-drop",
    tabindex: "0",
    role: "button",
    "aria-label": "Drop an extension bundle zip here, or press Enter to choose one",
    text: "Drop a bundle .zip here",
    onclick: () => file.click(),
    onkeydown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        file.click();
      }
    },
    ondragover: (event) => {
      event.preventDefault();
      drop.classList.add("over");
    },
    ondragleave: () => drop.classList.remove("over"),
    ondrop: (event) => {
      event.preventDefault();
      drop.classList.remove("over");
      const dropped = event.dataTransfer?.files?.[0];
      if (!dropped) return toast("nothing usable was dropped", false);
      if (!/\.zip$/i.test(dropped.name)) {
        // Directory drops arrive as entries rather than files and would need a
        // recursive FileSystemEntry walk; the directory picker below already
        // does that job, so point at it instead of half-supporting the drop.
        return toast("drop a .zip, or use “Choose directory” for an unzipped extension", false);
      }
      void setPending(dropped, dropped.name);
    },
  });

  file.addEventListener("change", () => {
    const chosen = file.files?.[0];
    if (chosen) void setPending(chosen, chosen.name);
  });

  dir.addEventListener("change", async () => {
    const entries = relativeEntries(dir.files ?? []);
    if (!entries.length) return toast("that directory has no files", false);
    if (!entries.some((entry) => entry.name === "manifest.json")) {
      return toast("no manifest.json at the top level of that directory", false);
    }
    status.replaceChildren(el("p", { class: "dim", text: `Zipping ${entries.length} file(s)…` }));
    void setPending(await zipStored(entries), `${entries.length} file(s)`);
  });

  return card(
    "Publish an extension bundle",
    el("p", {
      class: "dim small",
      text:
        "Publishing replaces what every worker runs for this extension. The manifest is validated " +
        "before anything is written, and nothing is published until you confirm.",
    }),
    drop,
    row(
      el("label", { for: "bundle-file", class: "inline", text: "or a zip:" }),
      file,
      el("label", { for: "bundle-dir", class: "inline", text: "or a directory:" }),
      dir,
    ),
    status,
  );
}

/** The preflight result: the parsed manifest, or every reason it was refused. */
function publishVerdict(verdict, label, onPublish) {
  if (!verdict.ok) {
    return el(
      "div",
      {},
      el("p", { class: "error", text: `${label} cannot be published:` }),
      el("ul", { class: "errors" }, (verdict.errors || ["unreadable archive"]).map((line) => el("li", { text: line }))),
    );
  }

  const m = verdict.manifest;
  return el(
    "div",
    {},
    el("p", { class: "ok-text", text: `${label} validates as ${m.name}@${m.version}.` }),
    verdict.replacesSameVersion
      ? el("div", {
          class: "banner",
          text:
            `Version ${m.version} is already published. Publishing replaces its bytes, and jobs already ` +
            "pinned to the old sha256 will not be able to fetch it. Bump the version to keep both.",
        })
      : null,
    defs([
      ["Extension", m.name],
      ["Version", m.version],
      ["Runtime", m.runtime || `inferred from publoader_api ${m.publoaderApi}`],
      ["Entrypoint", m.entrypoint],
      ["Languages", (m.languages ?? []).join(", ")],
      ["Allowed hosts", (m.allowedHosts ?? []).join(", ")],
      ["MangaDex group", m.mangadexGroupId],
      ["Minimum worker trust", m.minTrust],
      ["Files in archive", String(verdict.entries)],
      [
        "Currently published",
        verdict.currentlyPublished
          ? `${verdict.currentlyPublished.version} (${verdict.currentlyPublished.sha256.slice(0, 12)}), ${fmtTime(verdict.currentlyPublished.publishedAt)}`
          : "nothing yet",
      ],
    ]),
    row(
      el("button", {
        type: "button",
        class: "primary",
        text: `Publish ${m.name}@${m.version}`,
        onclick: (event) => onPublish(event.currentTarget),
      }),
    ),
  );
}

// -------------------------------------------------- one extension, in full

function extensionDetail(name, tab) {
  const encoded = encodeURIComponent(name);
  if (tab === "series-map") return seriesMapPanel(name);
  if (tab === "schedule") return schedulePanel(name);
  if (tab === "config") return configPanel(name);
  if (tab === "versions") return versionsPanel(name);

  // Tabs are suppressed for a param route, so a detail view carries its own.
  const activity = new Resource(`activity:${name}`, () =>
    api(`/extensions/${encoded}/activity?limit=10`, { quiet: true }),
  );

  return el(
    "div",
    {},
    extensionTabs(name, "overview"),
    live(
      [activity],
      (data) =>
        el(
          "div",
          {},
          card(
            "Bundle",
            data.bundle
              ? el("p", {
                  class: "dim",
                  text:
                    `Published ${data.bundle.version} (${data.bundle.sha256.slice(0, 12)}) ` +
                    `${fmtTime(data.bundle.publishedAt)}` +
                    `${data.bundle.sourceCommit ? ` from commit ${data.bundle.sourceCommit.slice(0, 12)}` : ""}.`,
                })
              : el("p", { class: "error", text: "No bundle is published for this extension, so it cannot run." }),
            row(
              gatedButton("runs:write", { text: "Run", onclick: (e) => triggerRun(name, "UPDATE", e.currentTarget) }),
              gatedButton("runs:write", { text: "Force", onclick: (e) => triggerRun(name, "FORCE", e.currentTarget) }),
              gatedButton("runs:write", {
                class: "danger",
                text: "Clean",
                onclick: (e) => triggerRun(name, "CLEAN", e.currentTarget),
              }),
            ),
          ),
          card(
            "Curation",
            el(
              "div",
              { class: "grid tight" },
              [
                ["tracked series", String(data.tracked)],
                ...Object.entries(data.untracked || {}).map(([k, v]) => [`untracked ${k}`, String(v)]),
              ].map(([key, value]) =>
                el(
                  "div",
                  { class: "stat" },
                  el("div", { class: "n", text: value }),
                  el("div", { class: "k", text: key }),
                ),
              ),
            ),
          ),
          /*
           * Runs, jobs, upload tasks and quarantine on one screen. The value is
           * the join: "the scrape succeeds but nothing reaches MangaDex" is
           * invisible in any single list and obvious here, because the runs are
           * green and the upload tasks are red side by side.
           */
          card(
            "Recent activity",
            el("h3", { text: "Runs" }),
            table(
              ["Kind", "State", "Segments", "Triggered by", "Created", "Error"],
              data.runs.map((run) => [
                routeLink(routeTo("runs", run.id, null), run.kind),
                chip(run.state),
                String(run.segmentsTotal),
                run.triggeredBy,
                fmtTime(run.createdAt),
                truncate(run.error, 80),
              ]),
              { empty: "This extension has never run." },
            ),
            el("h3", { text: "Jobs" }),
            table(
              ["Segment", "State", "Attempts", "Class", "Last error", "Updated"],
              data.jobs.map((job) => [
                `${job.segmentIndex + 1}/${job.segmentTotal}`,
                chip(job.state),
                `${job.attempt}/${job.maxAttempts}`,
                job.errorClass || "-",
                truncate(job.lastError, 120),
                fmtTime(job.updatedAt),
              ]),
              { empty: "No jobs yet." },
            ),
            el("h3", { text: "Upload tasks" }),
            el("p", {
              class: "dim small",
              text:
                "Matched on the chapter payload's extension name, so tasks queued before that field existed " +
                "are absent.",
            }),
            table(
              ["Kind", "State", "Dedupe key", "Attempt", "Last error", "Updated"],
              data.uploadTasks.map((task) => [
                task.kind,
                chip(task.state),
                el("code", { text: task.dedupeKey }),
                String(task.attempt),
                truncate(task.lastError, 120),
                fmtTime(task.updatedAt),
              ]),
              { empty: "No upload task has been attributed to this extension." },
            ),
            el("h3", { text: "Quarantined submissions" }),
            table(
              ["Job", "Worker", "Reject reason", "Received"],
              data.quarantined.map((item) => [
                el("code", { text: item.jobId }),
                el("code", { text: (item.workerId || "").slice(0, 8) }),
                truncate(item.rejectReason, 200),
                fmtTime(item.createdAt),
              ]),
              { empty: "Nothing from this extension is quarantined." },
            ),
          ),
        ),
      { reserve: 520, skeleton: () => el("div", {}, skeletonGrid(3), skeletonTable(6, 6)) },
    ),
  );
}

/**
 * The detail view's own tab strip.
 *
 * The shell hides the section tabs for a param route, they would navigate away
 * from the thing being read, so a detail view that has sections draws them
 * itself, pointing at `#/extensions/<name>/<tab>`.
 */
function extensionTabs(name, current) {
  const tabs = NAV_BY_ID.get("extensions").tabs;
  return el(
    "div",
    { class: "tabs", role: "tablist", "aria-label": `Sections of ${name}` },
    tabs.map(([id, label]) =>
      el("button", {
        type: "button",
        role: "tab",
        id: `tab-${id}`,
        "aria-selected": String(id === current),
        text: label,
        onclick: () => navigate(routeTo("extensions", name, id)),
      }),
    ),
  );
}

/**
 * Weekday labels, Monday first.
 *
 * The index IS the contract value (Monday=0, Python's `weekday()`), which the
 * previous version of this panel got wrong: it listed Sunday first and sent the
 * array index, so picking "Wednesday" in the UI scheduled Thursday. Keeping the
 * label list and the wire value in one array is what makes that class of bug
 * unrepresentable rather than merely fixed.
 */
const SCHEDULE_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function formatScheduleSlot(slot) {
  const at = `${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")}`;
  const days = (slot.days || []).length
    ? slot.days.map((d) => (SCHEDULE_WEEKDAYS[d] || `day ${d}`).slice(0, 3)).join(", ")
    : "Every day";
  return `${at} · ${days}`;
}

function schedulePanel(name) {
  const schedules = new Resource(`schedules:${name}`, () =>
    api(`/schedules/${encodeURIComponent(name)}`, { quiet: true }),
  );

  /**
   * The add/replace form. Returned as a node plus a `read()`, so the two
   * buttons below it cannot disagree about what the operator typed.
   */
  const slotForm = () => {
    const hour = el("input", { id: "sched-hour", type: "number", min: "0", max: "23", value: "3" });
    const minute = el("input", { id: "sched-minute", type: "number", min: "0", max: "59", value: "0" });
    const kind = el(
      "select",
      { id: "sched-kind" },
      el("option", { value: "UPDATE", text: "update: the ordinary incremental run" }),
      el("option", { value: "CLEAN", text: "clean: full catalogue, computes removals" }),
      el("option", { value: "FORCE", text: "force" }),
    );
    const label = el("input", { id: "sched-label", type: "text", maxlength: "80", placeholder: "note (optional)" });
    // Checkboxes rather than a multi-select: "every day" has to be the visible
    // resting state, and an empty multi-select reads as "nothing selected yet",
    // not as "all of them".
    const dayBoxes = SCHEDULE_WEEKDAYS.map((dayName, index) =>
      el("label", { class: "inline" }, el("input", { type: "checkbox", value: String(index) }), el("span", { text: dayName.slice(0, 3) })),
    );
    const read = () => {
      const days = dayBoxes
        .map((box, index) => (box.querySelector("input").checked ? index : null))
        .filter((d) => d !== null);
      const body = { hour: Number(hour.value), minute: Number(minute.value), days, kind: kind.value };
      if (label.value.trim()) body.label = label.value.trim();
      return body;
    };
    const node = el(
      "div",
      {},
      row(
        el("label", { class: "inline", for: "sched-hour", text: "Hour" }),
        hour,
        el("label", { class: "inline", for: "sched-minute", text: "Minute" }),
        minute,
        el("label", { class: "inline", for: "sched-kind", text: "Kind" }),
        kind,
        el("label", { class: "inline", for: "sched-label", text: "Label" }),
        label,
      ),
      row(el("span", { class: "dim small", text: "Days (none ticked = every day)" }), ...dayBoxes),
    );
    return { node, read };
  };

  return el(
    "div",
    {},
    extensionTabs(name, "schedule"),
    card(
      "Schedule (UTC)",
      live(
        [schedules],
        (data) => {
          const entries = data.entries || [];
          const manifest = data.manifest || [];
          const form = slotForm();

          const rows = entries.map((slot, index) => [
            String(index + 1),
            formatScheduleSlot(slot),
            slot.kind.toLowerCase(),
            slot.label || "-",
            slot.enabled ? "on" : "off",
            [
              gatedButton("extensions:write", {
                text: slot.enabled ? "Switch off" : "Switch on",
                onclick: (event) =>
                  act(
                    "schedule.toggle",
                    () =>
                      api(`/schedules/${encodeURIComponent(name)}/${encodeURIComponent(slot.id)}`, {
                        method: "PATCH",
                        body: { enabled: !slot.enabled },
                      }),
                    { button: event.currentTarget, refresh: [schedules] },
                  ),
              }),
              gatedButton("extensions:write", {
                class: "danger",
                text: "Remove",
                onclick: (event) =>
                  act(
                    "schedule.remove",
                    () =>
                      api(`/schedules/${encodeURIComponent(name)}/${encodeURIComponent(slot.id)}`, {
                        method: "DELETE",
                      }),
                    { button: event.currentTarget, refresh: [schedules] },
                  ),
              }),
            ],
          ]);

          return el(
            "div",
            {},
            el("p", {
              class: "dim small",
              text:
                data.source === "operator"
                  ? "These slots replace the manifest schedule entirely. Reset to fall back to it."
                  : manifest.length
                    ? "Running the manifest schedule. Adding a slot copies these in first, so none of them stop."
                    : "No manifest schedule and no slots: this extension only runs when triggered by hand.",
            }),
            el("p", {
              class: "dim small",
              text: `Manifest: ${manifest.map((s) => `${formatScheduleSlot(s)} (${s.kind.toLowerCase()})`).join("  |  ") || "none"}`,
            }),
            table(["#", "When", "Kind", "Label", "State", ""], rows, {
              empty: "No slots of its own; the manifest schedule above is what runs.",
            }),
            el("h3", { text: "Add a slot" }),
            form.node,
            row(
              gatedButton("extensions:write", {
                class: "primary",
                text: "Add slot",
                onclick: (event) =>
                  act(
                    "schedule.add",
                    () => api(`/schedules/${encodeURIComponent(name)}`, { method: "POST", body: form.read() }),
                    { button: event.currentTarget, refresh: [schedules] },
                  ),
              }),
              gatedButton("extensions:write", {
                text: "Replace whole schedule",
                title: "Delete every slot above and keep only this one",
                onclick: (event) =>
                  act(
                    "schedule.set",
                    () => api(`/schedules/${encodeURIComponent(name)}`, { method: "PUT", body: form.read() }),
                    { button: event.currentTarget, refresh: [schedules] },
                  ),
              }),
              gatedButton("extensions:write", {
                class: "danger",
                text: "Reset to manifest",
                disabled: entries.length === 0,
                title: entries.length ? null : "There are no slots to reset",
                onclick: (event) =>
                  act("schedule.reset", () => api(`/schedules/${encodeURIComponent(name)}`, { method: "DELETE" }), {
                    button: event.currentTarget,
                    refresh: [schedules],
                  }),
              }),
            ),
          );
        },
        { reserve: 200, skeleton: () => el("div", { class: "skeleton skeleton-line", style: { height: "160px" } }) },
      ),
    ),
  );
}

/**
 * Report what a config save actually stored.
 *
 * `PUT /extensions/:name/config` answers 200 with per-relation counts and a
 * `rejected[]` of rows its constraints refused; a language code outside the
 * MangaDex allowlist, an alias pointing at itself. A 200 therefore means "stored
 * what was valid", not "stored everything", and treating the two alike is how an
 * operator ends up believing an alias is live when the server dropped it.
 *
 * Deliberately not a toast: a rejection list has to stay on screen long enough to
 * fix the document it came from.
 */
function renderConfigOutcome(host, result) {
  const rejected = Array.isArray(result.rejected) ? result.rejected : [];
  const counts =
    `Stored ${result.aliases ?? 0} alias(es), ${result.multiChapters ?? 0} multi-chapter ` +
    `number(s), ${result.languages ?? 0} language override(s).`;

  setChildren(
    host,
    el("p", { class: rejected.length ? "error" : "dim small", text: counts }),
    rejected.length
      ? el(
          "div",
          {},
          el("p", {
            class: "error",
            text: `${rejected.length} row(s) were REFUSED and are not saved:`,
          }),
          el(
            "ul",
            { class: "errors" },
            rejected.map((row) =>
              el("li", {
                text:
                  `${row.option}: ${row.key}` +
                  (row.value === undefined ? "" : ` → ${row.value}`) +
                  `: ${row.reason}`,
              }),
            ),
          ),
        )
      : null,
    // Names what stayed in the free-form blob, so a typo'd key does not read as
    // an accepted setting.
    Array.isArray(result.passthroughKeys) && result.passthroughKeys.length
      ? el("p", {
          class: "dim small",
          text: `Kept as free-form extension settings: ${result.passthroughKeys.join(", ")}.`,
        })
      : null,
  );
}

/**
 * One editable row of a key→value(s) relation.
 *
 * Returns its own node plus a `read()`, so the parent can collect the current
 * state without the list having to re-render on every keystroke; re-rendering
 * is what takes the caret with it.
 */
function relationRow(spec, initial, onRemove) {
  const key = el("input", {
    type: "text",
    value: initial.key ?? "",
    placeholder: spec.keyPlaceholder,
    "aria-label": spec.keyLabel,
  });
  const value = el("input", {
    type: "text",
    value: initial.value ?? "",
    placeholder: spec.valuePlaceholder,
    "aria-label": spec.valueLabel,
    list: spec.valueList,
  });
  const problem = el("span", { class: "field-error small" });

  const validate = () => {
    const message = spec.validate?.(key.value.trim(), value.value.trim()) ?? "";
    problem.textContent = message;
    return message === "";
  };
  key.addEventListener("input", validate);
  value.addEventListener("input", validate);
  validate();

  const node = el(
    "div",
    { class: "relation-row" },
    key,
    el("span", { class: "dim", text: spec.separator ?? "→" }),
    value,
    el("button", { type: "button", class: "danger", text: "Remove", onclick: () => onRemove(node) }),
    problem,
  );
  return { node, read: () => ({ key: key.value.trim(), value: value.value.trim() }), validate };
}

/**
 * An editable list for one of the three typed relations.
 *
 * Each is a separate table with its own constraints: an alias has exactly one
 * master, and a language code must be one MangaDex accepts. A free-text blob
 * could express neither, so a typo only surfaced when the server rejected it.
 */
function relationList(spec, initialRows) {
  const rows = [];
  const host = el("div", { class: "relation-list" });

  const removeRow = (node) => {
    const index = rows.findIndex((r) => r.node === node);
    if (index >= 0) {
      rows.splice(index, 1);
      node.remove();
    }
    if (rows.length === 0) host.append(emptyHint);
  };

  const emptyHint = el("p", { class: "dim small", text: spec.empty });

  const addRow = (initial = {}) => {
    emptyHint.remove();
    const row = relationRow(spec, initial, removeRow);
    rows.push(row);
    host.append(row.node);
    return row;
  };

  for (const initial of initialRows) addRow(initial);
  if (rows.length === 0) host.append(emptyHint);

  return {
    node: el(
      "div",
      { class: "relation" },
      el("h3", { text: spec.title }),
      el("p", { class: "dim small", text: spec.blurb }),
      host,
      row(
        el("button", {
          type: "button",
          text: spec.addLabel,
          onclick: () => addRow().node.querySelector("input")?.focus(),
        }),
      ),
    ),
    /** Non-empty rows only: a blank pair the operator abandoned is not a row. */
    read: () => rows.map((r) => r.read()).filter((r) => r.key !== "" || r.value !== ""),
    problems: () => rows.filter((r) => !r.validate()).length,
  };
}

/**
 * Typed editors for the three normalised relations, plus the free-form remainder.
 *
 * The whole document still goes over the wire as one PUT, because that endpoint
 * has replace semantics and splitting it into three would make a partial save
 * possible; and `same` and `multi_chapters` decide what gets DELETED from
 * MangaDex, so a half-applied config is worse than a refused one.
 */
function configPanel(name) {
  const config = new Resource(`config:${name}`, () => api(`/extensions/${encodeURIComponent(name)}/config`));
  const writable = can("extensions:write");

  return el(
    "div",
    {},
    extensionTabs(name, "config"),
    card(
      "Override options",
      live(
        [config],
        (data) => {
          const allowed = data.mangadexLanguages ?? [];
          const status = el("div", {});

          // `same` is master → many aliases; the table stores one row per alias,
          // and that is the shape an operator edits, so it is flattened here
          // rather than presented as a list-of-lists.
          const aliasRows = Object.entries(data.same ?? {}).flatMap(([master, aliases]) =>
            (aliases ?? []).map((alias) => ({ key: master, value: alias })),
          );
          const multiRows = Object.entries(data.multi_chapters ?? {}).flatMap(([chapter, numbers]) =>
            (numbers ?? []).map((n) => ({ key: chapter, value: n })),
          );
          const languageRows = Object.entries(data.custom_language ?? {}).map(([source, md]) => ({
            key: source,
            value: md,
          }));

          const aliases = relationList(
            {
              title: "Chapter aliases",
              blurb:
                "Duplicate chapters on the source that are the same chapter. The master is kept; every alias is " +
                "treated as it and is a candidate for deletion from MangaDex.",
              addLabel: "Add an alias",
              empty: "No aliases.",
              keyLabel: "Master chapter id",
              valueLabel: "Alias chapter id",
              keyPlaceholder: "master chapter id",
              valuePlaceholder: "alias chapter id",
              validate: (key, value) => {
                if (!key || !value) return "both ids are required";
                if (key === value) return "an alias cannot be its own master";
                return "";
              },
            },
            aliasRows,
          );

          const multi = relationList(
            {
              title: "Multi-chapter numbers",
              blurb: "One source chapter that covers several chapter numbers.",
              addLabel: "Add a number",
              empty: "No multi-chapter numbers.",
              keyLabel: "Chapter id",
              valueLabel: "Chapter number",
              keyPlaceholder: "chapter id",
              valuePlaceholder: "chapter number",
              validate: (key, value) => (key && value ? "" : "both fields are required"),
            },
            multiRows,
          );

          const languages = relationList(
            {
              title: "Language overrides",
              blurb:
                "Map a source language code onto the MangaDex one. Only codes MangaDex accepts are allowed; " +
                "the same list the server validates against.",
              addLabel: "Add a language",
              empty: "No language overrides.",
              keyLabel: "Source language",
              valueLabel: "MangaDex language",
              keyPlaceholder: "source code",
              valuePlaceholder: "MangaDex code",
              valueList: "md-languages",
              validate: (key, value) => {
                if (!key || !value) return "both codes are required";
                if (allowed.length && !allowed.includes(value.toLowerCase())) {
                  return `“${value}” is not a MangaDex language code`;
                }
                return "";
              },
            },
            languageRows,
          );

          // Everything the platform does not model. Still JSON, deliberately: it
          // is extension-private and the dashboard has no schema for it.
          const passthrough = el("textarea", {
            id: "config-passthrough",
            rows: "10",
            spellcheck: "false",
            readonly: !writable,
            "aria-label": "Extension-private settings, JSON",
          });
          passthrough.value = JSON.stringify(data.passthrough ?? {}, null, 2);
          const passthroughError = el("p", { class: "field-error" });

          const readPassthrough = () => {
            try {
              const parsed = JSON.parse(passthrough.value || "{}");
              if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                passthroughError.textContent = "Extension settings must be a JSON object.";
                return null;
              }
              passthroughError.textContent = "";
              return parsed;
            } catch (err) {
              passthroughError.textContent = `Invalid JSON: ${err.message}`;
              return null;
            }
          };

          const build = () => {
            const rest = readPassthrough();
            if (rest === null) return null;
            const bad = aliases.problems() + multi.problems() + languages.problems();
            if (bad > 0) {
              setChildren(
                status,
                el("p", { class: "error", text: `${bad} row(s) are not valid; fix them before saving.` }),
              );
              return null;
            }

            const same = {};
            for (const { key, value } of aliases.read()) (same[key] ??= []).push(value);
            const multiChapters = {};
            for (const { key, value } of multi.read()) (multiChapters[key] ??= []).push(value);
            const customLanguage = {};
            for (const { key, value } of languages.read()) customLanguage[key] = value.toLowerCase();

            // Empty relations are sent as `{}` rather than omitted. The endpoint
            // replaces rather than merges, so an omitted key and an empty one
            // mean the same thing there; but being explicit is what makes
            // "I deleted every alias" a saveable intention rather than a
            // document that happens to lack a key.
            return { ...rest, same, multi_chapters: multiChapters, custom_language: customLanguage };
          };

          return el(
            "div",
            {},
            el("p", {
              class: "dim small",
              text: writable
                ? "The database is the source of truth. Saving replaces the whole document."
                : 'Read-only: editing extension configuration needs the "extensions:write" scope.',
            }),
            el("datalist", { id: "md-languages" }, allowed.map((code) => el("option", { value: code }))),
            aliases.node,
            multi.node,
            languages.node,
            el("h3", { text: "Extension-private settings" }),
            el("p", {
              class: "dim small",
              text:
                "Anything the platform does not model; this extension reads it itself, so it stays free-form.",
            }),
            passthrough,
            passthroughError,
            status,
            row(
              gatedButton("extensions:write", {
                class: "primary",
                text: "Save",
                onclick: async (event) => {
                  const document_ = build();
                  if (!document_) return undefined;
                  const result = await act(
                    "extension_config.set",
                    () =>
                      api(`/extensions/${encodeURIComponent(name)}/config`, {
                        method: "PUT",
                        body: { overrideOptions: document_ },
                      }),
                    { button: event.currentTarget, refresh: [config] },
                  );
                  // The PUT answers 200 with a per-row verdict. Discarding it
                  // made a save that DROPPED rows the server refused read as
                  // unqualified success.
                  if (result) renderConfigOutcome(status, result);
                  return result;
                },
              }),
              el("button", {
                type: "button",
                text: "Reload",
                title: "Discard these edits and re-read the stored config",
                onclick: () => void config.load({ force: true }),
              }),
            ),
          );
        },
        { reserve: 260, skeleton: () => el("div", { class: "skeleton skeleton-line", style: { height: "220px" } }) },
      ),
    ),
  );
}

/**
 * Every version ever published for this extension, and the way back from a bad
 * release: yanking one makes `latest()` resolve to the previous non-yanked
 * version, without touching the core or deleting anything.
 */
function versionsPanel(name) {
  const versions = new Resource(`versions:${name}`, () =>
    api(`/bundles/${encodeURIComponent(name)}/versions`, { quiet: true }),
  );

  return el(
    "div",
    {},
    extensionTabs(name, "versions"),
    card(
      "Published versions",
      el("p", {
        class: "dim small",
        text:
          "Yanking a version rolls back what workers fetch. Jobs already pinned to the yanked sha keep " +
          "running unless you also cancel them; pinning is what makes a run reproducible.",
      }),
      live(
        [versions],
        (data) =>
          table(
            ["Version", "sha256", "Source commit", "Published", "State", ""],
            data.versions.map((v) => [
              v.version,
              el("code", { text: v.sha256.slice(0, 12) }),
              v.sourceCommit ? el("code", { text: v.sourceCommit.slice(0, 12) }) : "-",
              fmtTime(v.publishedAt),
              chip(v.yanked ? "REVOKED" : "ACTIVE"),
              [
                gatedButton("bundles:write", {
                  class: "danger",
                  text: "Yank",
                  disabled: v.yanked,
                  title: v.yanked ? "Already yanked" : "Stop workers fetching this version",
                  onclick: async (event) => {
                    const button = event.currentTarget;
                    const cancel = await confirmDialog({
                      title: `Yank ${name}@${v.version}`,
                      lead: "Workers will fall back to the previous non-yanked version on their next lease.",
                      points: [
                        "Jobs already pinned to this sha256 keep running.",
                        "Nothing is deleted; a yank is reversible by republishing.",
                      ],
                      confirmLabel: "Yank it",
                    });
                    if (!cancel) return;
                    await act(
                      "bundle.yank",
                      () =>
                        api(`/bundles/${encodeURIComponent(name)}/${encodeURIComponent(v.version)}/yank`, {
                          method: "POST",
                          body: {},
                        }),
                      { button, refresh: [versions] },
                    );
                  },
                }),
              ],
            ]),
            { empty: "Nothing has been published for this extension." },
          ),
        { reserve: 220, skeleton: () => skeletonTable(4, 6) },
      ),
    ),
  );
}

// ------------------------------------------------------------- the series map

const TRACKED_PAGE = 50;

/** `externalId,mdMangaId`: the one format the paste box and the export share. */
/**
 * One line of the paste/export format.
 *
 * The namespace is emitted only when the row has one, because the two-column
 * form is what every existing map uses and the server treats a missing
 * namespace as the default catalogue. Emitting an empty leading field would
 * round-trip as a literal empty namespace instead.
 */
const mapLine = (item) =>
  item.namespace ? `${item.namespace},${item.mangaId},${item.mdMangaId}` : `${item.mangaId},${item.mdMangaId}`;

function seriesMapPanel(name) {
  const tracked = new Resource(`tracked:${name}`, () =>
    api(`/extensions/${encodeURIComponent(name)}/tracked`),
  );
  return el(
    "div",
    {},
    extensionTabs(name, "series-map"),
    trackedCard(name, tracked),
    bulkCurationCard(name, tracked),
    // Last on the page on purpose: it is what an operator reaches for after
    // making the edits above, not before.
    mapSyncCard(name),
  );
}

/**
 * The tracked map for one extension: searchable, paged, and exportable.
 *
 * Searching and paging happen in the browser over the whole set rather than
 * per-request. That is a deliberate trade: the rows are tiny, the batch ceiling
 * is 2000 of them, and having every row in hand is what lets Export produce a
 * complete file and lets the bulk editor preview a removal without a round
 * trip.
 */
/**
 * Repoint one external id at a different MangaDex title.
 *
 * Its own dialog rather than an inline field, because this is the one edit on
 * this page that silently changes where future chapters land: the series keeps
 * publishing, the uploads just start arriving on a different title. Needs
 * `tracked:write`: `tracked:append` can add a mapping but must not move one,
 * which is why a contributor sees this button refused rather than absent.
 */
function repointDialog(name, item, tracked) {
  const encoded = encodeURIComponent(name);
  const target = el("input", {
    id: "repoint-md-id",
    type: "text",
    value: item.mdMangaId,
    placeholder: "MangaDex UUID",
  });

  openModal(
    `Repoint ${item.mangaId}`,
    el(
      "div",
      {},
      el("p", {
        class: "dim small",
        text:
          item.namespace
            ? `Catalogue “${item.namespace}”. Chapters for this id will be uploaded to whichever title it points at, from the next run onwards.`
            : "Chapters for this id will be uploaded to whichever title it points at, from the next run onwards.",
      }),
      el("p", { class: "dim small" }, "Currently: ", mdTitleLink(item.mdMangaId)),
      el("label", { for: "repoint-md-id", text: "New MangaDex id" }),
      target,
      el("p", {
        class: "dim small",
        text: "Nothing on MangaDex is changed or deleted; only where future chapters are sent.",
      }),
      el(
        "div",
        { class: "row end" },
        el("button", { type: "button", text: "Cancel", onclick: closeModal }),
        gatedButton("tracked:write", {
          class: "primary",
          text: "Repoint it",
          onclick: async (event) => {
            const next = target.value.trim();
            if (!next) return void toast("a MangaDex id is required", false);
            if (next === item.mdMangaId) return void toast("that is where it already points", false);
            const ok = await act(
              "tracked_manga.set",
              () =>
                api(`/extensions/${encoded}/tracked`, {
                  method: "PUT",
                  body: {
                    mangaId: item.mangaId,
                    mdMangaId: next,
                    ...(item.namespace ? { namespace: item.namespace } : {}),
                  },
                }),
              { button: event.currentTarget, refresh: [tracked] },
            );
            if (ok) closeModal();
          },
        }),
      ),
    ),
  );
}

function trackedCard(name, tracked) {
  const encoded = encodeURIComponent(name);
  let page = 0;

  // Outside the reactive region so a redraw does not take the caret with it.
  const search = el("input", {
    id: "tracked-search",
    type: "search",
    placeholder: "filter by external id, MangaDex id, or source",
    "aria-label": "Filter tracked mappings",
  });
  const mangaId = el("input", { id: "tracked-manga-id", type: "text", placeholder: "external manga id" });
  const mdMangaId = el("input", { id: "tracked-md-id", type: "text", placeholder: "MangaDex UUID" });
  // Free text rather than a picker: the first row of a new catalogue has to be
  // addable before that catalogue exists in the list.
  const namespaceInput = el("input", {
    id: "tracked-namespace",
    type: "text",
    placeholder: "default",
    list: "tracked-namespaces",
    "aria-label": "Catalogue",
  });

  const body = live(
    [tracked],
    (data) => {
      const rows = data.tracked;
      const needle = search.value.trim().toLowerCase();
      const matches = needle
        ? rows.filter((item) =>
            [item.mangaId, item.mdMangaId, item.source, item.namespace].some((field) => (field || "").toLowerCase().includes(needle)),
          )
        : rows;
      const pages = Math.max(1, Math.ceil(matches.length / TRACKED_PAGE));
      page = Math.min(page, pages - 1);
      const slice = matches.slice(page * TRACKED_PAGE, page * TRACKED_PAGE + TRACKED_PAGE);

      return el(
        "div",
        {},
        // Suggestions for the Catalogue box. A datalist rather than a select so a
        // brand-new catalogue can still be typed in.
        el(
          "datalist",
          { id: "tracked-namespaces" },
          (data.namespaces ?? []).filter(Boolean).map((ns) => el("option", { value: ns })),
        ),
        table(
          ["Catalogue", "External id", "MangaDex id", "Source", "Added", ""],
          slice.map((item) => [
            // "default" rather than blank: an empty cell reads as missing data,
            // and the flat id space is a real answer.
            item.namespace ? el("code", { text: item.namespace }) : el("span", { class: "dim", text: "default" }),
            item.mangaId,
            mdTitleLink(item.mdMangaId),
            item.source,
            fmtTime(item.createdAt),
            [
              gatedButton("tracked:write", {
                text: "Repoint",
                title: "Point this external id at a different MangaDex title",
                onclick: () => repointDialog(name, item, tracked),
              }),
              gatedButton("tracked:write", {
                class: "danger",
                text: "Remove",
                onclick: async (event) => {
                  const button = event.currentTarget;
                  if (!(await confirmDialog({
                    title: `Stop tracking ${item.mangaId}`,
                    lead: "Its chapters stop being uploaded from the next run onwards.",
                    points: ["This does not touch MangaDex; the title and its existing chapters stay."],
                    confirmLabel: "Stop tracking it",
                  }))) {
                    return;
                  }
                  // Optimistic: the row goes immediately and comes back if the
                  // server refuses, which it will for tracked:append.
                  await act(
                    "tracked_manga.remove",
                    () =>
                      tracked.optimistic(
                        (current) => ({
                          ...current,
                          // Identity is (namespace, mangaId): filtering on the id
                          // alone would drop the same id in every catalogue.
                          tracked: current.tracked.filter(
                            (r) => !(r.mangaId === item.mangaId && (r.namespace ?? "") === (item.namespace ?? "")),
                          ),
                        }),
                        () =>
                          api(
                            `/extensions/${encoded}/tracked/${encodeURIComponent(item.mangaId)}` +
                              (item.namespace ? `?namespace=${encodeURIComponent(item.namespace)}` : ""),
                            { method: "DELETE" },
                          ),
                      ),
                    { button },
                  );
                },
              }),
            ],
          ]),
          {
            empty: needle
              ? `Nothing matches “${needle}”. ${rows.length} mapping(s) in total.`
              : "This extension tracks nothing yet. Add a mapping above, or paste a batch below.",
          },
        ),
        matches.length > TRACKED_PAGE
          ? pager(matches.length, page, TRACKED_PAGE, (next) => {
              page = next;
              tracked.emit();
            })
          : el("p", { class: "dim small", text: `${matches.length} of ${rows.length} mapping(s).` }),
      );
    },
    { reserve: 260, skeleton: () => skeletonTable(6, 5) },
  );

  search.addEventListener("input", () => {
    page = 0;
    tracked.emit();
  });

  return card(
    "Tracked series",
    row(
      el("label", { class: "inline", for: "tracked-manga-id", text: "External id" }),
      mangaId,
      el("label", { class: "inline", for: "tracked-md-id", text: "MangaDex id" }),
      mdMangaId,
      el("label", { class: "inline", for: "tracked-namespace", text: "Catalogue" }),
      namespaceInput,
      gatedButton("tracked:append", {
        class: "primary",
        text: "Add mapping",
        onclick: (event) => {
          const externalId = mangaId.value.trim();
          const target = mdMangaId.value.trim();
          const namespace = namespaceInput.value.trim();
          if (!externalId || !target) {
            return void toast("both ids are required", false);
          }
          // Captured now: `currentTarget` is null by the time the confirmation
          // below resolves, and `act` needs the button to show as pending.
          const button = event.currentTarget;
          const send = () =>
            act(
              "tracked_manga.set",
              () =>
                api(`/extensions/${encoded}/tracked`, {
                  method: "PUT",
                  body: {
                    mangaId: externalId,
                    mdMangaId: target,
                    // Omitted rather than sent empty: the server normalises a
                    // missing namespace to the default catalogue.
                    ...(namespace ? { namespace } : {}),
                  },
                }),
              { button, refresh: [tracked] },
            ).then((ok) => {
              if (ok) {
                mangaId.value = "";
                mdMangaId.value = "";
                // The catalogue is deliberately kept: adding several rows to one
                // catalogue is the common case, and re-typing it every time is
                // how a row lands in the wrong one.
              }
            });

          /**
           * The button says Add, but the endpoint is a PUT: an external id that
           * is already mapped is repointed, and it used to happen silently on
           * the first click. Repointing is the one edit on this page with no
           * visible consequence and a large invisible one — the series keeps
           * publishing, its chapters just start landing on a different title —
           * so a typo in the id field could quietly redirect a live series.
           *
           * The whole map is already in hand for the search and export below,
           * so the collision is caught here rather than reported afterwards.
           */
          const clash = (tracked.data?.tracked ?? []).find(
            (r) => r.mangaId === externalId && (r.namespace || "") === namespace,
          );
          if (!clash) return void send();

          const where = namespace ? `${externalId} in ${namespace}` : externalId;
          if (clash.mdMangaId === target) {
            // Not an error the server would reject, just nothing to do; saying
            // so beats a success toast for a write that changed nothing.
            return void toast(`${where} is already mapped to that title.`, false);
          }
          if (!can("tracked:write")) {
            // `tracked:append` may add but not move one. Say it here rather
            // than letting a confirmed repoint come back 403.
            return void toast(
              `${where} is already mapped to ${clash.mdMangaId}; repointing needs the "tracked:write" scope.`,
              false,
            );
          }
          return void confirmDialog({
            title: "That external id is already mapped",
            lead: `${where} is already mapped to ${clash.mdMangaId}.`,
            points: [
              `Adding it again repoints it to ${target}.`,
              "The series keeps publishing; new chapters just start landing on the other title.",
              "Chapters already uploaded stay where they are.",
            ],
            confirmLabel: "Repoint it",
          }).then((confirmed) => {
            if (confirmed) void send();
          });
        },
      }),
    ),
    el("p", {
      class: "dim small",
      text: can("tracked:write")
        ? "An external id that is already mapped is not added twice: you are asked to confirm the repoint first."
        : 'Adding a new mapping is allowed. Repointing one that already exists needs the "tracked:write" scope, and is refused with the id it is currently mapped to.',
    }),
    row(
      search,
      el("button", {
        type: "button",
        text: "Export map",
        title: "Download every mapping in the same format the bulk editor accepts",
        onclick: () => {
          const rows = tracked.data?.tracked ?? [];
          const text = [
            `# publoader tracked map for ${name}`,
            `# exported ${new Date().toISOString()}; ${rows.length} mapping(s)`,
            "# externalId,mdMangaId",
            ...rows.map(mapLine),
            "",
          ].join("\n");
          download(`${name}-tracked-map.csv`, text, "text/csv");
        },
      }),
    ),
    body,
  );
}

/**
 * Bulk curation: paste lines, see exactly what would happen, then apply.
 *
 * The dry run is not optional and not a checkbox. A paste of 200 lines can add,
 * repoint, no-op and fail in the same batch, and repointing a series silently
 * redirects uploads to a different MangaDex title; so the operator confirms
 * against a per-row verdict rather than against their own reading of the paste.
 * "Apply" only exists once a preview has come back.
 */
function bulkCurationCard(name, tracked) {
  const encoded = encodeURIComponent(name);
  const canWrite = can("tracked:write");

  const mode = el(
    "select",
    { id: "bulk-mode", "aria-label": "Bulk operation" },
    el("option", { value: "set", text: "Add or repoint (externalId,mdMangaId per line)" }),
    el("option", { value: "remove", text: "Remove (one external id per line)", disabled: !canWrite }),
  );
  const text = el("textarea", {
    id: "bulk-text",
    spellcheck: "false",
    placeholder: "abc123,3f1e...-uuid\ndef456,7a2b...-uuid\n# comments and a header row are ignored",
    "aria-label": "Mappings to apply",
  });
  const preview = el("div", { id: "bulk-preview" });
  const applyRow = el("div", {});

  const OUTCOME_TONE = {
    added: "ok",
    updated: "warn",
    unchanged: "",
    removed: "warn",
    not_found: "warn",
    rejected_needs_write: "bad",
    invalid: "bad",
  };

  const clear = () => {
    preview.replaceChildren();
    applyRow.replaceChildren();
  };

  const renderSummary = (summaryData, parseErrors, onApply) => {
    preview.replaceChildren(
      el(
        "div",
        { class: "grid tight" },
        [
          ["added", summaryData.added],
          ["repointed", summaryData.updated],
          ["unchanged", summaryData.unchanged],
          ["removed", summaryData.removed],
          ["rejected", summaryData.failed],
        ].map(([key, value]) =>
          el(
            "div",
            { class: "stat" },
            el("div", { class: "n", text: String(value) }),
            el("div", { class: "k", text: key }),
          ),
        ),
      ),
      parseErrors.length
        ? el(
            "div",
            {},
            el("h3", { text: `${parseErrors.length} line(s) could not be read` }),
            table(
              ["Line", "Text", "Why"],
              parseErrors.map((e) => [String(e.line), el("code", { text: e.text }), e.reason]),
            ),
          )
        : null,
      el("h3", { text: "Per-row outcome" }),
      table(
        ["External id", "MangaDex id", "Outcome", "Detail"],
        summaryData.results.map((result) => [
          result.mangaId,
          result.mdMangaId || "-",
          el("span", { class: `chip ${OUTCOME_TONE[result.outcome] || ""}`.trim(), text: result.outcome }),
          result.detail || "",
        ]),
      ),
    );

    applyRow.replaceChildren(
      summaryData.added + summaryData.updated + summaryData.removed === 0
        ? el("p", { class: "dim", text: "Nothing would change, so there is nothing to apply." })
        : row(
            el("button", {
              type: "button",
              class: "primary",
              text: `Apply; ${summaryData.added} added, ${summaryData.updated} repointed, ${summaryData.removed} removed`,
              onclick: (event) => onApply(event.currentTarget),
            }),
            el("button", { type: "button", text: "Discard preview", onclick: clear }),
          ),
    );
  };

  /**
   * The request body for the current mode. Removal takes one external id per
   * line, so the `#`-comment convention is honoured here too; a contributor who
   * learned it from the paste box should not find it silently ignored.
   */
  const payload = () =>
    mode.value === "remove"
      ? {
          remove: text.value
            .split(/\r?\n/)
            .map((line) => line.split("#")[0].trim())
            .filter(Boolean),
        }
      : { text: text.value };

  /**
   * Both modes preview through the server's own dry run, including removals.
   *
   * Judging removals in the browser would mean a second implementation of a rule
   * the store already owns, and the two would drift. Asking the server means the
   * preview is by construction the same judgement the apply will make.
   */
  const runPreview = async (button) => {
    clear();
    if (!text.value.trim()) return void toast("paste something first", false);
    const body = payload();
    button.dataset.pending = "true";
    button.disabled = true;

    // Not wrapped in `act`: a preview is not an outcome, and "ok" toasted over a
    // table that says three rows were rejected is actively misleading.
    let dry;
    try {
      dry = await api(`/extensions/${encoded}/tracked/batch`, {
        method: "POST",
        body: { ...body, dryRun: true },
      });
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        preview.replaceChildren(el("p", { class: "error", text: `Preview failed: ${err.message}` }));
      }
      return;
    } finally {
      delete button.dataset.pending;
      button.disabled = false;
    }

    renderSummary(dry, dry.parseErrors || [], async (applyButton) => {
      const applied = await act(
        "tracked_manga.batch",
        () => api(`/extensions/${encoded}/tracked/batch`, { method: "POST", body }),
        { button: applyButton, refresh: [tracked] },
      );
      if (applied) {
        clear();
        text.value = "";
      }
    });
  };

  mode.addEventListener("change", () => {
    clear();
    text.placeholder =
      mode.value === "remove"
        ? "abc123\ndef456\n# one external id per line"
        : "abc123,3f1e...-uuid\ndef456,7a2b...-uuid\n# comments and a header row are ignored";
  });

  return card(
    "Bulk curation",
    el("p", {
      class: "dim small",
      text:
        "Paste lines of externalId,mdMangaId; order-insensitive, with # comments and a header row ignored. " +
        "Up to 2000 rows. Nothing is written until you apply a preview.",
    }),
    row(el("label", { class: "inline", for: "bulk-mode", text: "Operation" }), mode),
    text,
    row(
      gatedButton("tracked:append", {
        class: "primary",
        text: "Preview changes",
        onclick: (event) => void runPreview(event.currentTarget),
      }),
      el("button", {
        type: "button",
        text: "Paste from clipboard",
        onclick: async () => {
          try {
            text.value = await navigator.clipboard.readText();
            clear();
          } catch {
            toast("clipboard blocked; paste into the box directly", false);
          }
        },
      }),
    ),
    !canWrite
      ? el("p", {
          class: "dim small",
          text:
            'Batch remove and batch repoint need the "tracked:write" scope. Rows that would change an existing ' +
            "mapping are reported as rejected in the preview, with the id they are currently mapped to.",
        })
      : null,
    preview,
    applyRow,
  );
}

// -------------------------------------------------- publishing the map to git

/**
 * Run the series-map write-back to GitHub by hand.
 *
 * core-api already does this on a weekly timer, and that cadence is what keeps
 * the files honest without anyone having to think about it. This card exists
 * for the gap the cadence leaves: an operator who has just repointed a series
 * or pruned a batch of mappings would otherwise either wait up to a week or go
 * find a shell to run `publoader-admin maps sync` from. The endpoint and the
 * CLI have both been there since the timer was written; only the button was
 * missing, which is what makes the weekly job look broken to anyone who checks
 * the repo the day after an edit.
 *
 * `name` limits the run to one extension; null runs every extension, which is
 * what the timer does.
 *
 * Preview-then-commit is deliberate rather than a single button. This writes to
 * somebody's repository unattended, and the preview names each file, the repo
 * it lives in and the exact delta; so what the operator confirms is a diff they
 * have read, not a verb they have trusted.
 */
function mapSyncCard(name) {
  const writable = can("tracked:write");
  const results = el("div", {});
  /**
   * Kept outside the click handlers so its state survives a preview and the
   * commit that follows: force is meant to be switched on in answer to a
   * refusal the operator has just read, not ticked before they know whether the
   * shrink guard is going to fire at all.
   */
  const force = el("input", { type: "checkbox", id: `map-sync-force${name ? `-${name}` : ""}` });

  const requestBody = (dryRun) => ({
    dryRun,
    force: force.checked,
    extensions: name ? [name] : [],
  });

  /**
   * Render one report. The per-extension status is the whole value of this
   * card: `unchanged`, `skipped` and `refused` are all non-failures with very
   * different meanings, and a bare "ok" would hide the one of them an operator
   * has to act on.
   */
  const draw = (report, dryRun) => {
    const outcomes = report.outcomes ?? [];
    setChildren(
      results,
      report.skippedReason
        ? el("p", { class: "error", text: `Nothing to do: ${report.skippedReason}` })
        : null,
      outcomes.length
        ? table(
            ["Extension", "Status", "Repo", "Mappings", "Delta", "Commit", "Detail"],
            outcomes.map((o) => [
              o.extension,
              o.status,
              o.repo ?? "-",
              String(o.mappings ?? 0),
              `+${o.added ?? 0} -${o.removed ?? 0}`,
              o.commit ? String(o.commit).slice(0, 7) : "-",
              o.detail ?? "",
            ]),
            { empty: "No extension has tracked mappings." },
          )
        : null,
      el("p", {
        class: report.failed ? "error" : "dim small",
        text:
          `${dryRun ? "Would write" : "Wrote"} ${report.written ?? 0} file(s)` +
          (report.failed ? `, ${report.failed} failed.` : "."),
      }),
    );
  };

  const previewButton = el("button", {
    type: "button",
    text: "Preview",
    disabled: !writable,
    onclick: async (event) => {
      const report = await act(
        "map_sync.preview",
        () => api("/maps/sync", { method: "POST", body: requestBody(true) }),
        { button: event.currentTarget },
      );
      if (report) draw(report, true);
    },
  });

  const commitButton = el("button", {
    type: "button",
    class: "primary",
    text: "Sync now",
    disabled: !writable,
    onclick: async (event) => {
      const confirmed = await confirmDialog({
        title: "Write the series map to GitHub",
        lead: name
          ? `This commits ${name}'s map file to its extensions repo.`
          : "This commits every extension's map file to its extensions repo.",
        points: [
          "The database is the authority: each file is rewritten from what is tracked now.",
          "A map file that is not already in the repo is skipped, never created.",
          force.checked
            ? "Force is ON, so a write that drops more than half of a file's mappings will NOT be refused."
            : "A write that would drop more than half of a file's mappings is refused.",
          "Preview first if you have not; this is a commit to a repository other people read.",
        ],
        confirmLabel: "Commit it",
      });
      if (!confirmed) return;
      const report = await act(
        "map_sync.run",
        () => api("/maps/sync", { method: "POST", body: requestBody(false) }),
        { button: event.currentTarget },
      );
      if (report) draw(report, false);
    },
  });

  return card(
    "Publish to GitHub",
    el("p", {
      class: "dim small",
      text:
        (name ? `Write ${name}'s ` : "Write each extension's ") +
        "map file back to its extensions repo. This is the same job core-api runs weekly, for a change " +
        "that should not wait for it. A run with nothing to say makes no commit.",
    }),
    writable
      ? null
      : el("p", { class: "dim small", text: 'Running the sync needs the "tracked:write" scope.' }),
    el(
      "label",
      { class: "assign-row", for: force.id },
      force,
      el("span", { text: "Force (allow a write that removes more than half of a file's mappings)" }),
    ),
    row(previewButton, commitButton),
    results,
  );
}

// -------------------------------------------------------------------- tracked

/**
 * The series map across every extension.
 *
 * There is no cross-extension endpoint, the map is addressed per extension, so
 * this is an index rather than a merged table: it names each extension, counts
 * what it tracks, and links into the map that can actually be edited.
 */
VIEWS.tracked = () => {
  const counts = new Resource("tracked-counts", async () => {
    const list = await api("/extensions");
    const rows = await Promise.all(
      list.extensions.map(async (ext) => {
        try {
          const { tracked } = await api(`/extensions/${encodeURIComponent(ext.name)}/tracked`, { quiet: true });
          return { name: ext.name, count: tracked.length, newest: tracked[tracked.length - 1] ?? null };
        } catch {
          // One unreadable extension must not empty the whole index.
          return { name: ext.name, count: null, newest: null };
        }
      }),
    );
    return rows;
  });

  return el(
    "div",
    {},
    card(
      "Series map by extension",
      el("p", {
        class: "dim small",
        text: "Open an extension to search, export, edit and bulk-paste its mappings.",
      }),
      live(
        [counts],
        (rows) =>
          table(
            ["Extension", "Mappings", "Most recent", ""],
            rows.map((r) => [
              r.name,
              r.count === null ? "unreadable" : String(r.count),
              r.newest ? `${r.newest.mangaId} · ${fmtTime(r.newest.createdAt)}` : "-",
              [routeLink(routeTo("extensions", r.name, "series-map"), "Open map", { class: "button-link inline" })],
            ]),
            { empty: "No extension is published, so there is no map to curate yet." },
          ),
        { reserve: 200, skeleton: () => skeletonTable(4, 4) },
      ),
    ),
    // The all-extensions run belongs here rather than on one extension's page:
    // this is the only view that is about the map as a whole.
    mapSyncCard(null),
  );
};

// -------------------------------------------------------------------- workers

/**
 * Pin a worker to a set of extensions, or let it take anything.
 *
 * The stored list is what the lease query filters on, so a change takes effect on
 * that worker's next poll; no re-enrolment, no restart. The empty list means
 * "anything", which is right for a dedicated host and wrong for a community one,
 * so the dialog states which of the two you are choosing rather than leaving an
 * empty set of checkboxes to be read either way.
 *
 * The extension list comes from what is actually published: offering a name no
 * bundle exists for would let an operator pin a worker to nothing and see only an
 * idle host with no explanation.
 */
function assignExtensionsDialog(worker, workers) {
  const extensions = new Resource("extensions:for-assign", () => api("/extensions"));
  const body = el("div", {});

  const draw = (data) => {
    const published = (data.extensions ?? []).map((e) => e.name ?? e).filter(Boolean).sort();
    const assigned = new Set(worker.extensions ?? []);
    // A name a worker holds that is no longer published still has to be shown, or
    // saving the dialog would silently drop it.
    const orphaned = [...assigned].filter((name) => !published.includes(name)).sort();
    const boxes = new Map();

    const anyRadio = el("input", { type: "radio", name: "assign-mode", id: "assign-any", checked: assigned.size === 0 });
    const someRadio = el("input", { type: "radio", name: "assign-mode", id: "assign-some", checked: assigned.size > 0 });

    const checkboxList = el(
      "div",
      { class: "assign-list" },
      [...published, ...orphaned].map((name) => {
        const box = el("input", {
          type: "checkbox",
          id: `assign-ext-${name}`,
          checked: assigned.has(name),
          onchange: () => {
            // Ticking anything means "only these", so keep the radios honest
            // rather than letting the two controls disagree.
            if ([...boxes.values()].some((b) => b.checked)) someRadio.checked = true;
            else anyRadio.checked = true;
          },
        });
        boxes.set(name, box);
        return el(
          "label",
          { class: "assign-row", for: `assign-ext-${name}` },
          box,
          el("span", { text: name }),
          orphaned.includes(name)
            ? el("span", { class: "dim small", text: "; no longer published" })
            : null,
        );
      }),
    );

    const chosen = () => (anyRadio.checked ? [] : [...boxes].filter(([, b]) => b.checked).map(([n]) => n));

    setChildren(
      body,
      el("p", {
        class: "dim small",
        text: `Takes effect on ${worker.name}'s next poll. No restart or re-enrolment.`,
      }),
      el("label", { class: "assign-row", for: "assign-any" }, anyRadio, el("span", { text: "Anything; take work from every extension" })),
      el("label", { class: "assign-row", for: "assign-some" }, someRadio, el("span", { text: "Only the extensions ticked below" })),
      published.length || orphaned.length
        ? checkboxList
        : el("p", { class: "dim", text: "No extension has been published yet, so there is nothing to pin to." }),
      el(
        "div",
        { class: "row end" },
        el("button", { type: "button", text: "Cancel", onclick: closeModal }),
        gatedButton("workers:write", {
          class: "primary",
          text: "Save assignment",
          onclick: async (event) => {
            const list = chosen();
            if (!anyRadio.checked && list.length === 0) {
              toast("tick at least one extension, or choose Anything", false);
              return;
            }
            const ok = await act(
              "worker.extensions.set",
              () =>
                api(`/workers/${worker.id}/extensions`, { method: "PUT", body: { extensions: list } }),
              { button: event.currentTarget, refresh: [workers] },
            );
            if (ok) closeModal();
          },
        }),
      ),
    );
  };

  onTeardown(extensions.subscribe(() => {
    if (extensions.status === "error") {
      setChildren(body, el("p", { class: "error", text: `Could not list extensions: ${extensions.error?.message ?? "unknown error"}` }));
    } else if (extensions.data) {
      draw(extensions.data);
    }
  }));
  setChildren(body, el("div", { class: "skeleton skeleton-line", style: { height: "120px" } }));
  void extensions.load();

  openModal(`Extensions for ${worker.name}`, body);
}

VIEWS.workers = (route) => {
  if (route.tab === "enrolment") return enrolmentPanel();

  const workers = new Resource("workers", () => api("/workers"));
  onTeardown(summary.subscribe(() => void workers.load({ force: true, quiet: true })));

  const lifecycle = (worker, action, label, danger) =>
    gatedButton("workers:write", {
      class: danger ? "danger" : null,
      text: label,
      onclick: async (event) => {
        const button = event.currentTarget;
        if (
          danger &&
          !(await confirmDialog({
            title: `Revoke ${worker.name}`,
            lead: "Its token stops working immediately and it cannot lease any more work.",
            points: ["Re-enrolling needs a fresh one-time enrolment token."],
            confirmLabel: "Revoke it",
          }))
        ) {
          return;
        }
        await act(
          `worker.${action}`,
          () =>
            workers.optimistic(
              (current) => ({
                ...current,
                workers: current.workers.map((w) =>
                  w.id === worker.id
                    ? { ...w, status: action === "drain" ? "DRAINED" : action === "activate" ? "ACTIVE" : "REVOKED" }
                    : w,
                ),
              }),
              () => api(`/workers/${worker.id}/${action}`, { method: "POST", body: {} }),
            ),
          { button, refresh: [summary] },
        );
      },
    });

  return card(
    "Fleet",
    live(
      [workers],
      (data) =>
        table(
          ["Worker", "Status", "Trust", "Heartbeat", "Agent", "Extensions", ""],
          data.workers.map((worker) => [
            el(
              "div",
              {},
              el("div", { text: worker.name }),
              el("div", { class: "dim small", text: worker.id }),
            ),
            chip(worker.status),
            worker.trust,
            ago(worker.lastHeartbeatAt),
            worker.agentVersion,
            el(
              "div",
              {},
              el("div", {
                text: (worker.extensions || []).join(", ") || "any",
                class: (worker.extensions || []).length ? null : "dim",
              }),
              gatedButton("workers:write", {
                class: "button-link inline",
                text: "Change",
                onclick: () => assignExtensionsDialog(worker, workers),
              }),
            ),
            [
              lifecycle(worker, "drain", "Drain", false),
              lifecycle(worker, "activate", "Activate", false),
              lifecycle(worker, "revoke", "Revoke", true),
            ],
          ]),
          {
            empty: el(
              "div",
              {},
              el("h3", { text: "No worker has enrolled" }),
              el("p", { text: "Nothing can run until at least one host is enrolled." }),
              el(
                "div",
                { class: "retry-row" },
                routeLink(routeTo("workers", null, "enrolment"), "Enrol a worker →", {
                  class: "button-link inline",
                }),
              ),
            ),
          },
        ),
      { reserve: 240, skeleton: () => skeletonTable(4, 7) },
    ),
  );
};

function enrolmentPanel() {
  const trust = el(
    "select",
    { id: "enroll-trust" },
    el("option", { value: "COMMUNITY", text: "COMMUNITY" }),
    el("option", { value: "TRUSTED", text: "TRUSTED" }),
  );
  const note = el("input", { id: "enroll-note", type: "text", maxlength: "256", placeholder: "who this is for" });
  const ttl = el("input", { id: "enroll-ttl", type: "number", min: "1", max: "720", value: "24" });
  const name = el("input", { id: "enroll-name", type: "text", value: "publoader-worker-1", maxlength: "128" });

  return card(
    "Enrol a worker",
    el("p", {
      class: "dim small",
      text:
        "A one-time token that enrols exactly one worker. It is shown once, so copy the compose snippet " +
        "before closing the dialog.",
    }),
    el("label", { for: "enroll-trust", text: "Trust tier" }),
    trust,
    el("label", { for: "enroll-note", text: "Note" }),
    note,
    el("label", { for: "enroll-ttl", text: "Token TTL (hours)" }),
    ttl,
    el("label", { for: "enroll-name", text: "Worker name (for the snippet)" }),
    name,
    row(
      gatedButton("enroll:write", {
        class: "primary",
        text: "Mint enrolment token",
        onclick: async (event) => {
          const minted = await act(
            "enroll-token.create",
            () =>
              api("/enroll-tokens", {
                method: "POST",
                body: {
                  trust: trust.value,
                  note: note.value || undefined,
                  ttlHours: Number(ttl.value) || 24,
                },
              }),
            { button: event.currentTarget, refresh: [enrollTokens] },
          );
          if (minted) showEnrollToken(minted, name.value.trim() || "publoader-worker-1");
        },
      }),
    ),
    enrollTokenList(),
  );
}

/** Shared so minting can refresh the list it just added a row to. */
const enrollTokens = new Resource("enroll-tokens", () => api("/enroll-tokens"));

/**
 * Every token minted, and what became of it.
 *
 * The plaintext is deliberately absent; only a hash is stored and it was shown
 * once. The useful fact here is the status: a PENDING token is a credential
 * somebody can still enrol a worker with, which is the one an operator may want
 * to withdraw.
 */
function enrollTokenList() {
  return card(
    "Enrolment tokens",
    el("p", {
      class: "dim small",
      text:
        "The token itself is never shown again; only its fate. A token stays usable until it is used, " +
        "revoked, or expires.",
    }),
    live(
      [enrollTokens],
      (data) =>
        table(
          ["Status", "Trust", "Note", "Used by", "Created", "Expires", ""],
          (data.tokens ?? []).map((t) => [
            chip(t.status),
            t.trust,
            t.note || el("span", { class: "dim", text: "-" }),
            t.usedByWorkerName
              ? el("span", {}, t.usedByWorkerName)
              : el("span", { class: "dim", text: "-" }),
            `${fmtTime(t.createdAt)} (${ago(t.createdAt)})`,
            t.status === "PENDING"
              ? `${fmtTime(t.expiresAt)} (${ago(t.expiresAt)})`
              : el("span", { class: "dim", text: fmtTime(t.expiresAt) }),
            t.status === "PENDING"
              ? gatedButton("enroll:write", {
                  class: "danger",
                  text: "Revoke",
                  title: "Stop this token being usable, without waiting for it to expire",
                  onclick: async (event) => {
                    const button = event.currentTarget;
                    if (
                      !(await confirmDialog({
                        title: "Revoke this enrolment token",
                        lead: "Anyone holding it will no longer be able to enrol a worker with it.",
                        points: ["A host that has already enrolled is unaffected; it holds a permanent token."],
                        confirmLabel: "Revoke it",
                      }))
                    ) {
                      return;
                    }
                    await act("enroll_token.revoke", () => api(`/enroll-tokens/${t.id}/revoke`, { method: "POST", body: {} }), {
                      button,
                      refresh: [enrollTokens],
                    });
                  },
                })
              : "",
          ]),
          { empty: "No enrolment token has been minted yet." },
        ),
      { reserve: 200, skeleton: () => skeletonTable(4, 7) },
    ),
  );
}

function showEnrollToken(minted, workerName) {
  // The image must be one that actually exists: this snippet is pasted straight
  // onto a host, and a name nobody published turns "enrol a worker" into a pull
  // failure with no clue that the dashboard invented the tag. WORKER_IMAGE comes
  // from the server so the snippet tracks the deployed release rather than a
  // constant that goes stale here; which is exactly what this fallback did when
  // it was a pinned version, quietly handing out an image two releases old.
  // `latest` cannot rot; a version literal in a browser bundle can and did.
  const image = minted.workerImage || "ardax/publoader-worker:latest";
  const snippet = [
    "# publoader worker; one-time enrolment token",
    `# expires ${fmtTime(minted.expiresAt)}; it enrols exactly one worker.`,
    "#",
    "# The token is traded once for a permanent one kept in the named volume.",
    "# Losing that volume means asking the operator for a new enrolment token.",
    "#",
    // The tag below is whatever this deployment was told to advertise, which is
    // not necessarily the newest release; a core that has not been upgraded in
    // a while advertises what it knew at the time. Saying so beats a worker host
    // silently starting on an old image because the snippet looked current.
    `# Image below (${image}) is what this control plane advertises.`,
    "# Check for a newer production release before pasting, and prefer it:",
    "#   docker pull ardax/publoader-worker:latest",
    "#   docker image inspect ardax/publoader-worker:latest --format '{{index .RepoTags 0}}'",
    "# Releases: https://hub.docker.com/r/ardax/publoader-worker/tags",
    "services:",
    "  publoader-worker:",
    `    image: ${image}`,
    "    restart: unless-stopped",
    "    environment:",
    `      CORE_URL: ${window.location.origin}`,
    `      ENROLL_TOKEN: ${minted.token}`,
    `      WORKER_NAME: ${workerName}`,
    "    volumes:",
    "      - publoader-worker-state:/var/lib/publoader-worker",
    "volumes:",
    "  publoader-worker-state:",
  ].join("\n");

  openModal(
    "One-time enrolment token",
    el(
      "div",
      {},
      el("p", {
        class: "error",
        text: "Shown once. It is not recoverable; copy it now, and send it over a private channel.",
      }),
      el("pre", { text: snippet }),
      row(
        el("button", {
          type: "button",
          class: "primary",
          text: "Copy compose snippet",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(snippet);
              toast("copied to clipboard");
            } catch {
              toast("clipboard blocked; select the text manually", false);
            }
          },
        }),
        el("button", { type: "button", text: "Done", onclick: closeModal }),
      ),
    ),
  );
}

// ------------------------------------------------------------------ untracked

const UNTRACKED_STATES = ["NEW", "CREATING", "CREATED", "TRACKED", "FAILED", "SKIPPED"];

VIEWS.untracked = (route) => {
  if (route.param) return untrackedDetail(route.param);

  const queue = new Resource("untracked", () =>
    api(`/untracked?state=${encodeURIComponent(store.filters.untrackedState)}&limit=200`),
  );

  const filter = el(
    "select",
    {
      id: "untracked-state",
      "aria-label": "Untracked state filter",
      onchange: (event) => {
        setFilter({ untrackedState: event.target.value });
        void queue.load({ force: true });
      },
    },
    UNTRACKED_STATES.map((value) =>
      el("option", { value, text: value, selected: value === store.filters.untrackedState }),
    ),
  );

  return el(
    "div",
    {},
    card("Filter", row(el("label", { class: "inline", for: "untracked-state", text: "State" }), filter)),
    card(
      null,
      live(
        [queue],
        (data) =>
          table(
            ["Series", "Extension", "Lang", "State", "Attempts", "Result", ""],
            data.untracked.map((item) => [
              el(
                "div",
                {},
                el("div", {}, routeLink(routeTo("untracked", item.id, null), item.mangaName)),
                el("a", {
                  href: item.mangaUrl,
                  target: "_blank",
                  rel: "noreferrer noopener",
                  class: "dim small",
                  text: truncate(item.mangaUrl, 70),
                }),
              ),
              item.extension,
              item.mangaLanguage,
              chip(item.state),
              String(item.attempts),
              item.mdMangaId ? mdTitleLink(item.mdMangaId, "on MangaDex") : truncate(item.lastError, 100),
              [
                routeLink(routeTo("untracked", item.id, null), "Open", { class: "button-link inline" }),
                untrackedApproveButton(item, queue),
                gatedButton("untracked:write", {
                  text: "Skip",
                  onclick: (event) =>
                    act("untracked.skip", () => api(`/untracked/${item.id}/skip`, { method: "POST", body: {} }), {
                      button: event.currentTarget,
                      refresh: [queue],
                    }),
                }),
              ],
            ]),
            {
              empty: `Nothing is in the ${store.filters.untrackedState} state. The scrapers add rows here when they find a series MangaDex does not have.`,
            },
          ),
        { reserve: 300, skeleton: () => skeletonTable(7, 7) },
      ),
    ),
  );
};

function untrackedApproveButton(item, refresh) {
  return gatedButton("untracked:write", {
    class: "primary",
    text: "Approve",
    disabled: item.state !== "NEW" && item.state !== "FAILED",
    title:
      item.state === "NEW" || item.state === "FAILED"
        ? "Create the MangaDex title"
        : `${item.state} rows cannot be approved`,
    onclick: async (event) => {
      const button = event.currentTarget;
      if (!(await confirmDialog({
        title: `Create a MangaDex title for “${item.mangaName}”`,
        lead: "This publishes a real, public title on MangaDex.",
        points: [
          `Title: ${item.mangaName}`,
          `Language: ${item.mangaLanguage}`,
          "It cannot be undone from here; correcting it afterwards means editing the title on MangaDex.",
          "Check the details first if the scraper may have picked up a bad name.",
        ],
        confirmLabel: "Create the title",
      }))) {
        return;
      }
      await act(
        "untracked.approve",
        async () => {
          const res = await api(`/untracked/${item.id}/approve`, { method: "POST", body: {} });
          if (res && res.mdMangaId) toast(`created https://mangadex.org/title/${res.mdMangaId}`);
          return res;
        },
        { button, refresh: [refresh, summary].filter(Boolean) },
      );
    },
  });
}

/**
 * One untracked series, with its details editable.
 *
 * The scrapers guess a title from a page, and they guess wrong often enough that
 * approving without a chance to correct the name is how a bad title ends up
 * public. So: fix the local row here first, approve second; and for a row whose
 * title already exists, push the correction to MangaDex explicitly, behind a
 * confirmation that says out loud that the entry is public.
 */
function untrackedDetail(id) {
  const detail = new Resource(`untracked:${id}`, async () => {
    try {
      const body = await api(`/untracked/${encodeURIComponent(id)}`, { quiet: true });
      return { row: body.untracked ?? body, mangadex: body.mangadex ?? null, detailEndpoint: true };
    } catch (err) {
      if (err.status !== 404) throw err;
      // The per-row endpoint is newer than this page. Until it lands the row is
      // still readable from the queue listing, so degrade to that and say which
      // half is missing rather than showing an error for a series that exists.
      const { untracked } = await api("/untracked?limit=500");
      const found = untracked.find((r) => r.id === id);
      if (!found) throw new ApiError(404, `no untracked series with id ${id}`);
      return { row: found, mangadex: null, detailEndpoint: false };
    }
  });

  return live(
    [detail],
    (data) => {
      const item = data.row;
      const skippable = item.state === "NEW" || item.state === "FAILED";
      return el(
        "div",
        {},
        !data.detailEndpoint
          ? el("div", {
              class: "banner quiet",
              text:
                "This build has no per-row endpoint yet, so the row was read from the queue listing and the " +
                "current MangaDex title fields cannot be shown.",
            })
          : null,
        card(
          null,
          item.state === "TRACKED" || item.state === "CREATED"
            ? el("div", {
                class: "banner info",
                text: "A MangaDex title already exists for this series. Local edits do not reach it until you apply them.",
              })
            : null,
          defs([
            ["State", chip(item.state)],
            ["Extension", item.extension],
            ["External id", el("code", { text: item.mangaId })],
            ["Attempts", String(item.attempts)],
            ["MangaDex title", item.mdMangaId ? mdTitleLink(item.mdMangaId, item.mdMangaId) : "not created yet"],
            ["First seen", fmtTime(item.createdAt)],
            ["Updated", fmtTime(item.updatedAt)],
            item.lastError ? ["Last error", el("span", { class: "error", text: item.lastError })] : null,
            data.mangadex?.title ? ["Live MangaDex title", data.mangadex.title] : null,
          ]),
          row(copyLinkButton(routeTo("untracked", id, null))),
        ),
        untrackedEditCard(item, detail, data),
        card(
          "Actions",
          row(
            untrackedApproveButton(item, detail),
            gatedButton("untracked:write", {
              text: "Skip",
              disabled: !skippable,
              title: skippable ? null : `${item.state} rows cannot be skipped`,
              onclick: (event) =>
                act("untracked.skip", () => api(`/untracked/${item.id}/skip`, { method: "POST", body: {} }), {
                  button: event.currentTarget,
                  refresh: [detail],
                }),
            }),
            routeLink(routeTo("untracked", null, null), "Back to the queue", { class: "button-link inline" }),
          ),
        ),
      );
    },
    { reserve: 420, skeleton: () => el("div", {}, skeletonTable(7, 2), skeletonTable(4, 2)) },
  );
}

/** ISO-ish language tags, the shape MangaDex accepts: `en`, `pt-br`, `zh-hk`. */
const LANGUAGE_RE = /^[a-z]{2,3}(-[a-z]{2,8})?$/;

function untrackedEditCard(item, detail, data) {
  const writable = can("untracked:write");
  const canApply = isOperator();

  const nameInput = el("input", {
    id: "untracked-name",
    type: "text",
    maxlength: "512",
    value: item.mangaName,
    readonly: !writable,
    required: true,
  });
  const langInput = el("input", {
    id: "untracked-lang",
    type: "text",
    maxlength: "8",
    value: item.mangaLanguage,
    readonly: !writable,
    required: true,
    placeholder: "en",
  });
  const urlInput = el("input", {
    id: "untracked-url",
    type: "url",
    maxlength: "2048",
    value: item.mangaUrl,
    readonly: !writable,
    required: true,
  });
  for (const input of [nameInput, langInput, urlInput]) input.style.width = "100%";

  const errors = {
    mangaName: el("p", { class: "field-error", id: "untracked-name-error" }),
    mangaLanguage: el("p", { class: "field-error", id: "untracked-lang-error" }),
    mangaUrl: el("p", { class: "field-error", id: "untracked-url-error" }),
  };

  /** Validate in the browser so a typo is caught before it becomes a request. */
  const validate = () => {
    const values = {
      mangaName: nameInput.value.trim(),
      mangaLanguage: langInput.value.trim().toLowerCase(),
      mangaUrl: urlInput.value.trim(),
    };
    const problems = {};
    if (!values.mangaName) problems.mangaName = "A title is required.";
    else if (values.mangaName.length > 512) problems.mangaName = "At most 512 characters.";
    if (!LANGUAGE_RE.test(values.mangaLanguage)) {
      problems.mangaLanguage = "A language tag like en, pt-br or zh-hk.";
    }
    try {
      const url = new URL(values.mangaUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        problems.mangaUrl = "Must be an http or https URL.";
      }
    } catch {
      problems.mangaUrl = "Must be a complete URL, including https://.";
    }

    for (const [field, node] of Object.entries(errors)) {
      node.textContent = problems[field] ?? "";
      const input = field === "mangaName" ? nameInput : field === "mangaLanguage" ? langInput : urlInput;
      input.setAttribute("aria-invalid", problems[field] ? "true" : "false");
      input.setAttribute("aria-describedby", node.id);
    }
    return Object.keys(problems).length ? null : values;
  };

  for (const input of [nameInput, langInput, urlInput]) {
    input.addEventListener("input", () => {
      if (input.getAttribute("aria-invalid") === "true") validate();
    });
  }

  const changed = (values) =>
    values.mangaName !== item.mangaName ||
    values.mangaLanguage !== item.mangaLanguage ||
    values.mangaUrl !== item.mangaUrl;

  const save = async (button) => {
    const values = validate();
    if (!values) return void toast("fix the highlighted fields first", false);
    if (!changed(values)) return void toast("nothing changed");
    await act(
      "untracked.update",
      () =>
        detail.optimistic(
          (current) => ({ ...current, row: { ...current.row, ...values } }),
          async () => {
            try {
              return await api(`/untracked/${encodeURIComponent(item.id)}`, { method: "PATCH", body: values });
            } catch (err) {
              if (err.status === 404) {
                throw new ApiError(
                  404,
                  "this build has no PATCH /untracked/:id endpoint yet, so the correction was not saved",
                );
              }
              throw err;
            }
          },
        ),
      { button },
    );
  };

  const applyToMangadex = async (button) => {
    const values = validate();
    if (!values) return void toast("fix the highlighted fields first", false);
    if (changed(values)) return void toast("save the local row first, then apply it", false);
    if (!(await confirmDialog({
      title: "Change the public MangaDex entry",
      lead: `This edits the live title at mangadex.org/title/${item.mdMangaId} for everyone.`,
      points: [
        `Title becomes: ${values.mangaName}`,
        `Original language: ${values.mangaLanguage}`,
        `Source link: ${values.mangaUrl}`,
        "MangaDex keeps its own edit history; this is visible to their staff and cannot be undone from here.",
      ],
      confirmLabel: "Apply to MangaDex",
    }))) {
      return;
    }
    await act(
      "untracked.apply_to_mangadex",
      async () => {
        try {
          return await api(`/untracked/${encodeURIComponent(item.id)}/apply-to-mangadex`, {
            method: "POST",
            body: {},
            quiet: true,
          });
        } catch (err) {
          if (err.status === 403) {
            throw new ApiError(403, "refused: pushing to MangaDex is limited to owners and admins");
          }
          if (err.status === 404) {
            throw new ApiError(404, "this build has no apply-to-mangadex endpoint yet");
          }
          throw err;
        }
      },
      { button, refresh: [detail] },
    );
  };

  // The SERVER's reason wins. It is computed by the same code that guards the
  // POST, so it already accounts for cases this file cannot see, a create in
  // flight, an instance holding no MangaDex credentials, an api-token principal,
 // and a locally-derived reason that disagreed would either offer a button that
  // 403s or hide one that would have worked. The local derivation stays only as a
  // fallback for a build whose GET predates the field.
  const applyReason =
    data.applyBlockedReason ??
    (!item.mdMangaId
      ? "There is no MangaDex title yet; approve the series first."
      : !canApply
        ? "Pushing a change to the public MangaDex entry is limited to owners and admins. A contributor can " +
          "correct the local row and ask an operator to apply it."
        : null);

  // Whether this row has already been pushed, and whether anything differs now.
  // Without these the button reads identically on a row applied an hour ago with
  // nothing outstanding and on one that has never been applied; so the safe move
  // looks like pressing it, and the cost of guessing wrong is a redundant public
  // edit to someone else's catalogue under our shared account.
  const applied = data.appliedToMangaDex ?? null;
  const pending = Array.isArray(data.pendingChanges) ? data.pendingChanges : [];
  const nothingToApply = applied !== null && pending.length === 0;

  return card(
    "Details",
    el("p", {
      class: "dim small",
      text: writable
        ? "Correct what the scraper read off the source page. Saving changes the local row only."
        : 'Read-only: correcting a row needs the "untracked:write" scope.',
    }),
    el("label", { for: "untracked-name", text: "Title" }),
    nameInput,
    errors.mangaName,
    el("label", { for: "untracked-lang", text: "Original language" }),
    langInput,
    errors.mangaLanguage,
    el("label", { for: "untracked-url", text: "Source URL" }),
    urlInput,
    errors.mangaUrl,
    row(
      gatedButton("untracked:write", {
        class: "primary",
        text: "Save local row",
        onclick: (event) => void save(event.currentTarget),
      }),
      el("button", {
        type: "button",
        text: "Revert",
        onclick: () => {
          nameInput.value = item.mangaName;
          langInput.value = item.mangaLanguage;
          urlInput.value = item.mangaUrl;
          validate();
        },
      }),
      el("button", {
        type: "button",
        id: "apply-to-mangadex",
        class: "danger",
        // Says which act it is. "Apply" on an already-applied row with nothing
        // outstanding invites a public no-op edit.
        text: nothingToApply ? "Re-apply to MangaDex" : "Apply to MangaDex",
        disabled: Boolean(applyReason),
        title: applyReason ?? (nothingToApply ? "Nothing differs from the live entry." : undefined),
        onclick: applyReason ? undefined : (event) => void applyToMangadex(event.currentTarget),
      }),
    ),
    applyReason ? el("p", { class: "dim small", text: applyReason }) : null,
    // When it was last pushed, and by whom. Read off the row, so it survives
    // audit-log pruning.
    applied
      ? el("p", {
          class: "dim small",
          text:
            `Applied to MangaDex ${fmtTime(applied.at)} (${ago(applied.at)})` +
            (applied.actor ? ` by ${applied.actor}` : "") +
            (pending.length === 0
              ? ", nothing differs from the live entry."
              : `, ${pending.length} field(s) differ now.`),
        })
      : null,
    data.mangadex
      ? el(
          "div",
          {},
          el("h3", { text: "Live on MangaDex" }),
          defs(
            Object.entries(data.mangadex).map(([key, value]) => [
              key,
              typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "-"),
            ]),
          ),
        )
      : null,
  );
}

// ---------------------------------------------------------------------- audit

const AUDIT_PAGE = 100;

VIEWS.audit = (route) => (route.param ? auditDetail(route.param) : auditSearch());

/**
 * The audit trail, searchable.
 *
 * Paging back through a fixed number of rows only answers "what happened
 * recently". The questions that actually come up are retrospective; "who
 * changed the removal mode?", "when did this series get repointed, and by
 * whom?"; and they need a search that reaches into the detail JSON, which is
 * where the arguments of every audited action are recorded and the only place
 * they exist.
 */
function auditSearch() {
  const results = new Resource("audit", () => {
    const f = store.filters;
    const query = new URLSearchParams({ limit: String(AUDIT_PAGE), offset: String(f.auditOffset) });
    if (f.auditQuery) query.set("q", f.auditQuery);
    if (f.auditActor) query.set("actor", f.auditActor);
    if (f.auditAction) query.set("action", f.auditAction);
    if (f.auditSince) query.set("since", new Date(f.auditSince).toISOString());
    if (f.auditUntil) query.set("until", new Date(f.auditUntil).toISOString());
    return api(`/audit/search?${query}`);
  });

  const search = el("input", {
    id: "audit-q",
    type: "search",
    value: store.filters.auditQuery,
    placeholder: "actor, action, subject, or anything in the detail",
    "aria-label": "Search the audit log",
  });
  const actorBox = el("input", {
    id: "audit-actor",
    type: "search",
    value: store.filters.auditActor,
    placeholder: "actor",
    "aria-label": "Filter by actor",
  });
  const actionBox = el("input", {
    id: "audit-action",
    type: "search",
    value: store.filters.auditAction,
    placeholder: "action",
    "aria-label": "Filter by action",
  });
  const sinceBox = el("input", {
    id: "audit-since",
    type: "date",
    value: store.filters.auditSince,
    "aria-label": "Only events on or after this date",
  });
  const untilBox = el("input", {
    id: "audit-until",
    type: "date",
    value: store.filters.auditUntil,
    "aria-label": "Only events on or before this date",
  });

  const apply = () => {
    setFilter({
      auditQuery: search.value.trim(),
      auditActor: actorBox.value.trim(),
      auditAction: actionBox.value.trim(),
      auditSince: sinceBox.value,
      // Inclusive of the chosen day: a date input yields midnight, and "until
      // the 3rd" meaning "up to 00:00 on the 3rd" surprises everybody.
      auditUntil: untilBox.value ? `${untilBox.value}T23:59:59` : "",
      auditOffset: 0,
    });
    void results.load({ force: true });
  };
  for (const box of [search, actorBox, actionBox]) {
    box.addEventListener("keydown", (event) => {
      if (event.key === "Enter") apply();
    });
  }
  for (const box of [sinceBox, untilBox]) box.addEventListener("change", apply);

  return el(
    "div",
    {},
    card(
      "Search",
      row(
        el("label", { for: "audit-q", class: "inline", text: "Anything" }),
        search,
        el("label", { for: "audit-actor", class: "inline", text: "Actor" }),
        actorBox,
        el("label", { for: "audit-action", class: "inline", text: "Action" }),
        actionBox,
      ),
      row(
        el("label", { for: "audit-since", class: "inline", text: "From" }),
        sinceBox,
        el("label", { for: "audit-until", class: "inline", text: "To" }),
        untilBox,
        el("button", { type: "button", class: "primary", text: "Search", onclick: apply }),
        el("button", {
          type: "button",
          text: "Clear",
          onclick: () => {
            for (const box of [search, actorBox, actionBox, sinceBox, untilBox]) box.value = "";
            setFilter({
              auditQuery: "",
              auditActor: "",
              auditAction: "",
              auditSince: "",
              auditUntil: "",
              auditOffset: 0,
            });
            void results.load({ force: true });
          },
        }),
        el("button", {
          type: "button",
          text: "Export results",
          title: "Download the matching events as JSON",
          onclick: () =>
            download(
              `publoader-audit-${new Date().toISOString().slice(0, 10)}.json`,
              JSON.stringify(results.data?.events ?? [], null, 2),
              "application/json",
            ),
        }),
      ),
      el("p", {
        class: "dim small",
        text:
          "Search is a case-insensitive substring over the actor, action, subject and the detail JSON, so " +
          "partial ids and partial action names both work. To open one event, use its Open link; that " +
          "resolves by id however old the event is.",
      }),
    ),
    card(
      null,
      live(
        [results],
        (data) =>
          el(
            "div",
            {},
            el("p", { class: "dim small", text: `${data.total} matching event(s).` }),
            table(
              ["When", "Actor", "Action", "Subject", "Detail", ""],
              data.events.map((event) => [
                el(
                  "div",
                  {},
                  el("div", { text: fmtTime(event.createdAt) }),
                  el("div", { class: "dim small", text: ago(event.createdAt) }),
                ),
                event.actor,
                // Clicking an action name is the fastest way to ask "what else
                // did this?".
                el("button", {
                  type: "button",
                  class: "linkish",
                  text: event.action,
                  title: `Filter to ${event.action}`,
                  onclick: () => {
                    actionBox.value = event.action;
                    apply();
                  },
                }),
                event.subject,
                event.detail ? truncate(JSON.stringify(event.detail), 160) : "-",
                [routeLink(routeTo("audit", event.id, null), "Open", { class: "button-link inline" })],
              ]),
              { empty: "No event matches these filters." },
            ),
            data.total > AUDIT_PAGE
              ? pager(data.total, Math.floor(store.filters.auditOffset / AUDIT_PAGE), AUDIT_PAGE, (page) => {
                  setFilter({ auditOffset: page * AUDIT_PAGE });
                  void results.load({ force: true });
                })
              : null,
          ),
        { reserve: 340, skeleton: () => skeletonTable(9, 6) },
      ),
    ),
  );
}

/**
 * One audit event, by id.
 *
 * What a copied permalink resolves to. `GET /audit?id=` looks the event up by
 * primary key, so its age does not matter and it cannot be pushed off the end
 * of a page.
 */
function auditDetail(id) {
  const event = new Resource(`audit:${id}`, async () => {
    const res = await api(`/audit?id=${encodeURIComponent(id)}&limit=1`);
    return res.events?.[0] ?? null;
  });

  return live(
    [event],
    (data) => {
      if (!data) {
        return card(
          "Audit event",
          emptyState(
            el(
              "div",
              {},
              el("h3", { text: "No event with that id" }),
              el("p", { class: "dim", text: `Nothing in the audit log has the id ${id}.` }),
              el("p", {
                class: "dim small",
                text: "Audit rows are never deleted, so the likeliest explanation is a truncated or mistyped id.",
              }),
            ),
            el(
              "div",
              { class: "retry-row" },
              routeLink(routeTo("audit", null, null), "Back to the audit search", { class: "button-link inline" }),
            ),
          ),
        );
      }
      return el(
        "div",
        {},
        card(
          null,
          defs([
            ["Event", el("code", { text: data.id })],
            ["When", `${fmtTime(data.createdAt)} · ${ago(data.createdAt)}`],
            ["Actor", data.actor],
            ["Action", el("code", { text: data.action })],
            ["Subject", data.subject ? el("code", { text: data.subject }) : "-"],
          ]),
          row(
            el("button", {
              type: "button",
              text: "Everything by this actor",
              onclick: () => {
                setFilter({ auditQuery: "", auditActor: data.actor, auditAction: "", auditOffset: 0 });
                navigate(routeTo("audit", null, null));
              },
            }),
            el("button", {
              type: "button",
              text: "Everything with this action",
              onclick: () => {
                setFilter({ auditQuery: "", auditActor: "", auditAction: data.action, auditOffset: 0 });
                navigate(routeTo("audit", null, null));
              },
            }),
            copyLinkButton(routeTo("audit", data.id, null)),
            routeLink(routeTo("audit", null, null), "Back to search", { class: "button-link inline" }),
          ),
        ),
        card(
          "Detail",
          data.detail == null
            ? el("p", { class: "dim", text: "This action recorded no arguments." })
            : el("pre", { text: JSON.stringify(data.detail, null, 2) }),
          // The arguments of an audited action exist nowhere else, so make them
          // trivially exportable rather than a select-and-copy exercise.
          data.detail == null
            ? null
            : row(
                el("button", {
                  type: "button",
                  text: "Download this event",
                  onclick: () =>
                    download(`audit-${data.id}.json`, JSON.stringify(data, null, 2), "application/json"),
                }),
              ),
        ),
      );
    },
    { reserve: 340, skeleton: () => el("div", {}, skeletonTable(5, 2), skeletonTable(6, 1)) },
  );
}

// --------------------------------------------------------------------- system

VIEWS.system = (route) => {
  if (route.tab === "mangadex") return mangadexPanel();
  if (route.tab === "cards") return unavailableCardsPanel();
  if (route.tab === "backup") return backupPanel();

  /*
   * Is the database schema the one this build expects? The answer used to
   * require `docker compose run migrate status` on the host, and it is read as
   * "should I be worried?"; so it leads with a verdict rather than with a table
   * of names.
   */
  const schema = new Resource("schema", () => api("/schema"));

  return card(
    "Schema & migrations",
    live(
      [schema],
      (data) => {
        const verdict = !data.historyAvailable
          ? { tone: "warn", text: "This database has no prisma migration history." }
          : data.failed?.length
            ? { tone: "bad", text: `${data.failed.length} migration(s) failed or were rolled back.` }
            : data.current === null
              ? { tone: "warn", text: "Pending migrations cannot be detected in this build." }
              : data.current
                ? { tone: "ok", text: "The schema is up to date." }
                : { tone: "bad", text: `${data.pending.length} migration(s) have not been applied.` };

        return el(
          "div",
          {},
          el("p", { class: verdict.tone === "ok" ? "ok-text" : "error", text: verdict.text }),
          data.note ? el("p", { class: "dim small", text: data.note }) : null,
          (data.pending || []).length
            ? el(
                "div",
                {},
                el("div", {
                  class: "banner",
                  text:
                    "Migrations are applied by the one-shot `migrate` service at deploy time, not from here; " +
                    "running DDL from the API process is deliberately impossible. See docs/operations.md → " +
                    "Upgrade the core.",
                }),
                table(["Not yet applied"], data.pending.map((name) => [name])),
              )
            : null,
          el("h3", { text: "History" }),
          table(
            ["Migration", "State", "Applied", "Note"],
            (data.applied || []).map((m) => [
              m.name,
              el("span", { class: `chip ${m.failed ? "bad" : "ok"}`, text: m.failed ? "failed" : "applied" }),
              fmtTime(m.appliedAt),
              m.rolledBackAt ? `rolled back ${fmtTime(m.rolledBackAt)}` : "-",
            ]),
            { empty: "No migration has been recorded." },
          ),
        );
      },
      {
        reserve: 300,
        skeleton: () => el("div", {}, el("div", { class: "skeleton skeleton-line" }), skeletonTable(5, 4)),
      },
    ),
  );
};

/**
 * Re-post the card image on chapters that are already marked unavailable.
 *
 * The card is rendered at the moment the uploader runs, from that chapter's
 * own details and this build's fonts and layout. So every card on MangaDex is
 * a fossil of the build that posted it, and when the renderer changes — a font
 * that was missing, wording that was wrong, a layout that clipped long titles —
 * the only fix for the pages already up is to render them again and post them
 * over the top. That is the whole job of this panel.
 *
 * Three targets, because the three occasions are genuinely different: one
 * chapter somebody complained about, a handful an operator picked out of the
 * archive, or every card on the site after a renderer fix. The first two are
 * one request; the last pages through the archive on the primary key until the
 * server stops returning a continuation, so it terminates and reports as it
 * goes rather than timing out behind a spinner.
 */
function unavailableCardsPanel() {
  const target = { mode: "all", id: "", series: "", seriesName: "", running: false, cancel: false };
  const selected = new Set();
  const filters = { extension: "", language: "", search: "" };
  const cursors = [];

  /** The filter, as the query string both listings and the sweep body share. */
  const activeFilter = () => {
    const filter = {};
    if (filters.extension) filter.extension = filters.extension;
    if (filters.language) filter.language = filters.language;
    return filter;
  };

  const extensions = new Resource("recard-extensions", () =>
    api("/chapters/extensions?archive=unavailable"),
  );
  const seriesList = new Resource("recard-series", () => {
    const q = new URLSearchParams({ archive: "unavailable", limit: "100" });
    if (filters.extension) q.set("extension", filters.extension);
    if (filters.language) q.set("language", filters.language);
    if (filters.search) q.set("search", filters.search);
    return api(`/chapters/series?${q}`);
  });
  const listing = new Resource("recard-listing", () => {
    const q = new URLSearchParams({ archive: "unavailable", limit: "50" });
    if (filters.extension) q.set("extension", filters.extension);
    if (filters.language) q.set("language", filters.language);
    if (filters.search) q.set("search", filters.search);
    if (cursors.length) q.set("cursor", cursors[cursors.length - 1]);
    return api(`/chapters?${q}`);
  });

  const note = el("textarea", {
    id: "recard-note",
    rows: "2",
    maxlength: "600",
    placeholder: "Leave blank for the standard wording.",
  });
  const progress = el("div", { class: "dim small" });
  const preview = el("div", {});
  const modes = el("div", {});
  const buttons = el("div", { class: "row" });

  /** The request body for the current target, or null when it is not answerable. */
  const bodyFor = () => {
    if (target.mode === "one") {
      const id = target.id.trim();
      return id ? { ids: [id] } : null;
    }
    if (target.mode === "selected") {
      return selected.size ? { ids: [...selected] } : null;
    }
    if (target.mode === "series") {
      const id = target.series.trim();
      // Extension and language ride along when they are set, because the list
      // this title was picked out of was narrowed by them: a sweep wider than
      // the list it was chosen from would act on chapters never shown.
      return id ? { filter: { ...activeFilter(), mdMangaId: id } } : null;
    }
    const filter = activeFilter();
    if (filters.search) filter.search = filters.search;
    return { filter };
  };

  const footerNote = () => {
    const text = note.value.trim();
    return text ? { footerNote: text } : {};
  };

  const call = (extra) =>
    api("/chapters/unavailable/recard", {
      method: "POST",
      body: { ...bodyFor(), ...footerNote(), ...extra },
    });

  const say = (text, bad = false) => {
    progress.className = bad ? "error" : "dim small";
    progress.textContent = text;
  };

  /**
   * The filter changed, so every listing that was narrowed by it is stale and
   * every selection made under it may no longer be shown. Reloading only the
   * mounted list keeps a mode switch from paying for the other one's fetch.
   */
  const refilter = () => {
    cursors.length = 0;
    selected.clear();
    if (target.mode === "selected") void listing.load({ force: true });
    if (target.mode === "series") void seriesList.load({ force: true });
    redraw();
  };

  const runPreview = async (button) => {
    if (!bodyFor()) {
      say("Nothing is targeted yet.", true);
      return;
    }
    const result = await act("chapters.recard.preview", () => call({ dryRun: true }), { button });
    if (!result) return;
    setChildren(preview, recardPreview(result, target.mode));
    say(
      target.mode === "all" || target.mode === "series"
        ? `${result.matched} unavailable chapter(s) match; this sweep would queue ${result.wouldQueue} ` +
            `in the first pass of ${result.resolved}` +
            (result.nextAfterId ? ", and keep going until every one has been reached." : ".")
        : `${result.wouldQueue} of ${result.resolved} chapter(s) would be queued.`,
    );
  };

  /**
   * The live run. For a picked set that is one request; for the whole archive
   * it is a request per page, continued by `nextAfterId`.
   *
   * The loop is here rather than on the server because a sweep over thousands
   * of chapters is minutes of database writes, and an HTTP request that long is
   * a request that dies to a proxy timeout having queued an amount nobody can
   * name. Paging makes every page an answered request, and the count below is
   * true at every moment rather than only at the end.
   */
  const runApply = async () => {
    const body = bodyFor();
    if (!body) {
      say("Nothing is targeted yet.", true);
      return;
    }
    const mode = target.mode;
    const scope =
      mode === "all"
        ? "every unavailable chapter matching the filter"
        : mode === "series"
          ? `every unavailable chapter of ${target.seriesName || target.series}`
          : `${body.ids.length} chapter(s)`;
    if (
      !(await confirmDialog({
        title: "Re-post these card images",
        lead: `A fresh card will be rendered and posted over the current page of ${scope}.`,
        points: [
          "Each chapter keeps its place, its metadata and its date; only the page image changes.",
          "One upload task per chapter, drained by core-uploader at MangaDex's pace.",
          "Chapters that have never been carded are skipped, not carded for the first time.",
        ],
        confirmLabel: "Queue the re-cards",
        danger: false,
      }))
    ) {
      return;
    }

    // Snapshotted, not re-read per page: the sweep outlives the form, and a
    // continuation sent against a target the operator changed halfway through
    // is a request that means nothing.
    const request = { ...body, ...footerNote(), dryRun: false, confirm: true };

    target.running = true;
    target.cancel = false;
    redraw();
    let queued = 0;
    let refused = 0;
    let afterId = null;
    try {
      for (;;) {
        const result = await api("/chapters/unavailable/recard", {
          method: "POST",
          body: { ...request, ...(afterId ? { afterId } : {}) },
        });
        queued += result.queued ?? 0;
        refused += result.refused ?? 0;
        setChildren(preview, recardPreview(result, mode));
        afterId = result.nextAfterId ?? null;
        say(
          `${queued} queued, ${refused} skipped` +
            (afterId ? ` — still sweeping (${result.matched} match in total)…` : " — done."),
        );
        if (!afterId || target.cancel) break;
      }
      toast(
        `${queued} chapter(s) queued for a fresh card` + (refused ? `, ${refused} skipped` : ""),
        refused === 0,
      );
      if (target.cancel) say(`Stopped after ${queued} queued; the rest were left alone.`);
    } catch (err) {
      say(`Stopped after ${queued} queued: ${err.message}`, true);
    } finally {
      target.running = false;
      selected.clear();
      redraw();
    }
    if (mode === "selected") void listing.load({ force: true });
    if (mode === "series") void seriesList.load({ force: true });
  };

  /** The picker, only mounted for the targets that name something. */
  const picker = () =>
    target.mode === "series"
      ? seriesPicker()
      : target.mode === "selected"
      ? live(
          [listing],
          (data) => {
            const rows = data.chapters ?? [];
            const present = new Set(rows.map((entry) => entry.mdChapterId));
            for (const id of [...selected]) if (!present.has(id)) selected.delete(id);
            return el(
              "div",
              {},
              el("div", { class: "row" }, [
                el("span", {
                  class: "dim small",
                  text: `${selected.size} selected · ${rows.length} shown of ${data.total ?? 0}`,
                }),
                el("span", { class: "grow" }),
                el("button", {
                  type: "button",
                  text: rows.length && selected.size === rows.length ? "Select none" : "Select all on this page",
                  disabled: rows.length === 0,
                  onclick: () => {
                    if (selected.size === rows.length) selected.clear();
                    else for (const entry of rows) selected.add(entry.mdChapterId);
                    void listing.load({ force: true });
                  },
                }),
              ]),
              table(
                ["", "Series", "Chapter", "Language", "Extension", "Marked unavailable"],
                rows.map((entry) => [
                  el("input", {
                    type: "checkbox",
                    checked: selected.has(entry.mdChapterId),
                    "aria-label": `Select ${entry.mangaName ?? entry.mdChapterId} ${chapterLabel(entry)}`,
                    onchange: (event) => {
                      if (event.target.checked) selected.add(entry.mdChapterId);
                      else selected.delete(entry.mdChapterId);
                      redrawButtons();
                    },
                  }),
                  routeLink(routeTo("chapters", entry.mdChapterId, null), truncate(entry.mangaName || "-", 40)),
                  chapterLabel(entry),
                  entry.chapterLanguage || "-",
                  entry.extension || "-",
                  fmtTime(entry.at),
                ]),
                { empty: "No chapter in the unavailable archive matches this filter." },
              ),
              chapterPager(data, cursors, (walked) => {
                cursors.length = 0;
                cursors.push(...walked);
                selected.clear();
                void listing.load({ force: true });
              }),
            );
          },
          { reserve: 300, skeleton: () => skeletonTable(6, 6) },
        )
      : el("span", {});

  const filterRow = () =>
    row(
      live(
        [extensions],
        (data) =>
          el(
            "span",
            { class: "row tight" },
            el("label", { class: "inline", for: "recard-extension", text: "Extension" }),
            el(
              "select",
              {
                id: "recard-extension",
                onchange: (event) => {
                  filters.extension = event.target.value;
                  refilter();
                },
              },
              el("option", { value: "", text: "all", selected: filters.extension === "" }),
              (data.extensions ?? []).map((entry) =>
                el("option", {
                  value: entry.extension,
                  text: `${entry.extension || "(unattributed)"} · ${entry.count}`,
                  selected: entry.extension === filters.extension,
                }),
              ),
            ),
          ),
        { reserve: 32, skeleton: () => el("span", { class: "dim small", text: "extensions…" }) },
      ),
      el("span", { class: "row tight" }, [
        el("label", { class: "inline", for: "recard-search", text: "Search" }),
        el("input", {
          id: "recard-search",
          type: "text",
          value: filters.search,
          placeholder: "title, name, or any id",
          onchange: (event) => {
            filters.search = event.target.value;
            refilter();
          },
        }),
      ]),
      el("span", { class: "row tight" }, [
        el("label", { class: "inline", for: "recard-language", text: "Language" }),
        el("input", {
          id: "recard-language",
          type: "text",
          value: filters.language,
          placeholder: "e.g. en",
          onchange: (event) => {
            filters.language = event.target.value;
            refilter();
          },
        }),
      ]),
    );

  const modeRadio = (mode, label, hint) =>
    el(
      "label",
      { class: "inline", for: `recard-mode-${mode}` },
      el("input", {
        id: `recard-mode-${mode}`,
        type: "radio",
        name: "recard-mode",
        checked: target.mode === mode,
        disabled: target.running,
        onchange: (event) => {
          if (!event.target.checked) return;
          target.mode = mode;
          cardImage.hidden = true;
          setChildren(preview);
          say("");
          redraw();
          if (mode === "selected") void listing.load();
          if (mode === "series") void seriesList.load();
        },
      }),
      ` ${label}`,
      el("span", { class: "dim small", text: ` — ${hint}` }),
    );

  /**
   * The card image itself, kept as one element rather than rebuilt.
   *
   * Rendering it is a server-side render of a real PNG, so it is asked for when
   * the operator asks — the same "Refresh the preview" button the single-chapter
   * dialog has — and not once per keystroke in the id box.
   */
  const cardImage = el("img", {
    class: "card-preview",
    alt: "The card that would be posted as this chapter's only page",
    hidden: true,
  });

  const showCard = () => {
    const id = target.id.trim();
    cardImage.hidden = !id;
    if (id) cardImage.src = previewSrc(id, note.value.trim());
  };

  /**
   * The series target: a title picked out of the archive, or an id pasted in.
   *
   * Both, because the two ways an operator arrives here are different. Somebody
   * reports that one title's cards are wrong and the id is in the URL they were
   * sent; or a renderer fix landed and the question is which titles carry the
   * most stale cards, which is what the list answers and no id in hand can.
   */
  const seriesField = () =>
    target.mode === "series"
      ? el(
          "div",
          {},
          el("label", { for: "recard-series-id", text: "MangaDex title id" }),
          el("input", {
            id: "recard-series-id",
            type: "text",
            value: target.series,
            placeholder: "paste it from the title URL, or pick one below",
            oninput: (event) => {
              target.series = event.target.value;
              target.seriesName = "";
              redrawButtons();
            },
          }),
          el("p", {
            class: "dim small",
            text:
              "Every chapter of this title in the unavailable archive gets a fresh card, " +
              "narrowed by the filter below where one is set.",
          }),
        )
      : el("span", {});

  const seriesPicker = () =>
    live(
      [seriesList],
      (data) => {
        const rows = data.series ?? [];
        return el(
          "div",
          {},
          el("div", { class: "row" }, [
            el("span", {
              class: "dim small",
              text: target.series
                ? `Targeting ${target.seriesName || target.series}`
                : `${rows.length} title(s) with cards up${data.capped ? ", the largest shown" : ""}`,
            }),
          ]),
          table(
            ["", "Series", "Cards up", "Extension", "Most recent"],
            rows.map((entry) => [
              el("input", {
                type: "radio",
                name: "recard-series-pick",
                checked: target.series.trim() === entry.mdMangaId,
                "aria-label": `Target ${entry.mangaName ?? entry.mdMangaId}`,
                onchange: (event) => {
                  if (!event.target.checked) return;
                  target.series = entry.mdMangaId;
                  target.seriesName = entry.mangaName ?? "";
                  setChildren(preview);
                  say("");
                  redraw();
                },
              }),
              truncate(entry.mangaName || entry.mdMangaId, 40),
              String(entry.count),
              (entry.extensions ?? []).map((name) => name || "(unattributed)").join(", ") || "-",
              fmtTime(entry.at),
            ]),
            { empty: "No title in the unavailable archive matches this filter." },
          ),
        );
      },
      { reserve: 300, skeleton: () => skeletonTable(5, 6) },
    );

  const oneChapterField = () =>
    target.mode === "one"
      ? el(
          "div",
          {},
          el("label", { for: "recard-chapter-id", text: "MangaDex chapter id" }),
          el("input", {
            id: "recard-chapter-id",
            type: "text",
            value: target.id,
            placeholder: "paste it from the chapter URL",
            oninput: (event) => {
              target.id = event.target.value;
              redrawButtons();
            },
          }),
          row(
            el("button", {
              type: "button",
              text: "Refresh the preview",
              onclick: showCard,
            }),
            el("span", {
              class: "dim small",
              text: "Renders the exact image this would post, footer note included.",
            }),
          ),
          cardImage,
        )
      : el("span", {});

  const redrawButtons = () => {
    const ready = Boolean(bodyFor()) && !target.running;
    setChildren(
      buttons,
      gatedButton("chapters:read", {
        text: "Preview",
        disabled: !ready,
        title: ready ? "Resolve the target and report what would be queued" : "Nothing is targeted yet",
        onclick: (event) => runPreview(event.currentTarget),
      }),
      gatedButton("chapters:write", {
        class: "primary",
        text:
          target.mode === "all"
            ? "Re-post every card…"
            : target.mode === "series"
              ? "Re-post this series' cards…"
              : "Re-post these cards…",
        disabled: !ready,
        onclick: () => runApply(),
      }),
      target.running
        ? el("button", {
            type: "button",
            text: "Stop after this page",
            onclick: () => {
              target.cancel = true;
              say("Stopping after the page in flight…");
            },
          })
        : null,
    );
  };

  const redraw = () => {
    setChildren(
      modes,
      oneChapterField(),
      seriesField(),
      target.mode === "one" ? el("span", {}) : filterRow(),
      picker(),
    );
    redrawButtons();
  };

  redraw();

  return el(
    "div",
    {},
    card(
      "Re-post unavailable card images",
      el("p", {
        class: "dim small",
        text:
          "A card is rendered when it is posted, so every card on MangaDex is a fossil of the build " +
          "that put it there. After a fix to the renderer — a missing font, wrong wording, a clipped " +
          "title — this is what brings the pages already up in line with it.",
      }),
      el("p", {
        class: "dim small",
        text:
          "Each chapter keeps its place, its metadata and the date it went unavailable; the fresh card " +
          "carries that original date rather than today's. Only chapters already in the unavailable " +
          "archive are touched: this never cards a chapter for the first time.",
      }),
      el(
        "div",
        { class: "row" },
        modeRadio("all", "Every unavailable chapter", "optionally narrowed by the filter below"),
        modeRadio("series", "One series", "every card this title has up"),
        modeRadio("selected", "Pick from the archive", "tick the ones to re-post"),
        modeRadio("one", "One chapter", "by MangaDex chapter id"),
      ),
      modes,
      el("label", { for: "recard-note", text: "Footer note" }),
      note,
      el("p", {
        class: "dim small",
        text: "Replaces the standard explanatory paragraph on every card this queues.",
      }),
      buttons,
      progress,
      preview,
    ),
  );
}

/** What one page of a re-card resolved to, previewed or already queued. */
function recardPreview(result, mode) {
  const blocked = (result.results ?? []).filter((item) => !item.ok);
  return el(
    "div",
    {},
    el("h3", { text: result.dryRun ? "Preview" : "Queued" }),
    defs([
      ["Unavailable chapters matching", String(result.matched ?? 0)],
      ["This page", String(result.resolved ?? result.requested ?? 0)],
      [result.dryRun ? "Would be queued" : "Queued", String(result.wouldQueue ?? result.queued ?? 0)],
      ["Skipped", String(blocked.length)],
    ]),
    result.nextAfterId
      ? el("p", {
          class: "dim small",
          text:
            mode === "all" || mode === "series"
              ? "More chapters remain after this page; the sweep continues automatically until none do."
              : "More chapters remain after this page.",
        })
      : null,
    table(
      ["Series", "Chapter", "Unavailable since", result.dryRun ? "Would happen" : "Outcome"],
      (result.results ?? []).slice(0, 100).map((item) => [
        truncate(item.mangaName || item.mdChapterId, 40),
        item.chapterNumber ? `Ch. ${item.chapterNumber}` : "-",
        item.unavailableAt ? fmtTime(item.unavailableAt) : "-",
        item.ok
          ? chip(result.dryRun ? "queued" : item.outcome)
          : el("span", { class: "dim small", text: item.reason ?? item.outcome }),
      ]),
      { empty: "Nothing in the unavailable archive matched." },
    ),
    (result.results ?? []).length > 100
      ? el("p", { class: "dim small", text: `…and ${result.results.length - 100} more.` })
      : null,
  );
}

function backupPanel() {
  // The dump contains every password hash and the saved MangaDex session, so the
  // link only exists for a principal the server will actually serve it to.
  if (!isOwner()) {
    return card(
      "Database backup",
      el("p", {
        class: "dim",
        text:
          "Taking a backup needs the OWNER role. A dump contains every operator password hash, every client " +
          "token hash and the saved MangaDex session, which makes it a credential-theft primitive rather than " +
          "a read; so it sits at the bar for account administration.",
      }),
    );
  }
  return card(
    "Database backup",
    el("p", {
      class: "dim small",
      text:
        "Streams a pg_dump of the whole database in custom format (-Fc), the same shape docs/operations.md " +
        "documents; so a dump taken here and one taken on the host restore identically with pg_restore.",
    }),
    el("div", {
      class: "banner",
      text:
        "The download contains operator password hashes, client token hashes and the saved MangaDex session. " +
        "Treat the file as a credential: encrypt it at rest and keep it off shared storage.",
    }),
    row(
      // A plain link, not fetch(): the browser streams a multi-GB response to
      // disk, whereas fetch would buffer it in the tab first.
      el("a", { class: "button-link inline", href: `${API}/backup`, download: "", text: "Download backup" }),
    ),
    el("p", {
      class: "dim small",
      text:
        "Large databases take a while and the browser shows no progress until bytes arrive. If it answers " +
        "503, this container has no postgres client tools and the backup has to be taken on the host.",
    }),
  );
}

// ---------------------------------------------------------------------- users

/** Assignable roles, most privileged first. Mirrors ASSIGNABLE_ROLES in routes/users.ts. */
const ROLES = [
  ["OWNER", "OWNER, full control, including accounts and backups"],
  ["ADMIN", "ADMIN, full control plane, no account administration"],
  ["CONTRIBUTOR", "CONTRIBUTOR; series map and untracked triage only"],
];

VIEWS.users = (route) => {
  if (route.tab === "sessions") return sessionsPanel();
  if (route.tab === "signups") return signupsPanel();

  const users = new Resource("users", () => api("/users"));

  const inviteEmail = el("input", { id: "invite-email", type: "email", placeholder: "them@example.com" });
  const inviteRole = el(
    "select",
    { id: "invite-role", "aria-label": "Role for the invited account" },
    ROLES.map(([value, label]) => el("option", { value, text: label, selected: value === "ADMIN" })),
  );

  return el(
    "div",
    {},
    card(
      "Invite an operator",
      el("p", {
        class: "dim small",
        text:
          "Creates an approved account and emails it a single-use sign-in link. The invitee sets their own " +
          "password once they are in; until they do, another emailed link is their only way back.",
      }),
      el("p", {
        class: "dim small",
        text:
          "CONTRIBUTOR is the role to hand someone outside the operator group: they can add series mappings " +
          "and triage untracked series, and cannot reach runs, workers, credentials or settings. An ADMIN can " +
          "publish bundles, which is code execution on every worker.",
      }),
      row(
        el("label", { class: "inline", for: "invite-email", text: "Email" }),
        inviteEmail,
        el("label", { class: "inline", for: "invite-role", text: "Role" }),
        inviteRole,
        el("button", {
          type: "button",
          class: "primary",
          text: "Invite",
          onclick: (event) => {
            if (!inviteEmail.value.trim()) return void toast("an email is required", false);
            return act(
              "admin_user.invite",
              () =>
                api("/users", {
                  method: "POST",
                  body: { email: inviteEmail.value.trim(), role: inviteRole.value },
                }),
              { button: event.currentTarget, refresh: [users] },
            ).then((result) => {
              if (!result) return;
              inviteEmail.value = "";
              // The account is created either way; whether the invite reached
              // an inbox is the part an owner has to know about.
              if (!result.emailed) {
                toast(`invited, but no email went out: ${result.emailError ?? "unknown reason"}`, false);
              }
            });
          },
        }),
      ),
    ),
    card(
      "Accounts",
      live(
        [users],
        (data) =>
          table(
            ["Account", "Role", "State", "Credentials", "Last login", ""],
            data.users.map((user) => [
              el(
                "div",
                {},
                el("div", { text: user.email }),
                user.discordUsername
                  ? el("div", { class: "dim small", text: `discord: ${user.discordUsername}` })
                  : null,
              ),
              // "tuned" is worth a glance in the table: an account that is not
              // simply its role is the one whose access nobody remembers.
              el(
                "div",
                { class: "row tight" },
                chip(user.role),
                (user.extraScopes?.length ?? 0) + (user.deniedScopes?.length ?? 0) > 0
                  ? el("span", {
                      class: "chip",
                      text: "tuned",
                      title: [
                        user.extraScopes?.length ? `granted: ${user.extraScopes.join(", ")}` : null,
                        user.deniedScopes?.length ? `denied: ${user.deniedScopes.join(", ")}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · "),
                    })
                  : null,
              ),
              chip(user.approved ? "approved" : "pending"),
              // Both can be true, that is the point of linking, so this is a
              // list, not a ladder. Neither means the account has only ever
              // been reachable by an emailed sign-in link.
              [user.hasPassword ? "password" : null, user.discordId ? "discord" : null]
                .filter(Boolean)
                .join(" + ") || "email link only",
              user.lastLoginAt ? ago(user.lastLoginAt) : "never",
              [
                !user.approved
                  ? el("button", {
                      type: "button",
                      class: "primary",
                      text: "Approve",
                      onclick: (event) =>
                        act(
                          "admin_user.approve",
                          () =>
                            users.optimistic(
                              (current) => ({
                                ...current,
                                users: current.users.map((u) => (u.id === user.id ? { ...u, approved: true } : u)),
                              }),
                              () => api(`/users/${user.id}/approve`, { method: "POST", body: {} }),
                            ),
                          { button: event.currentTarget },
                        ),
                    })
                  : null,
                roleSelect(user, users),
                // The recovery path for an invite that never arrived. Only
                // useful once the account is approved; before that there is
                // nothing for the link to sign them in to.
                user.approved
                  ? el("button", {
                      type: "button",
                      text: "Email sign-in link",
                      onclick: (event) =>
                        act(
                          "admin_user.magic_link",
                          () => api(`/users/${user.id}/magic-link`, { method: "POST", body: {} }),
                          { button: event.currentTarget },
                        ),
                    })
                  : null,
                el("button", { type: "button", text: "Set password", onclick: () => passwordDialog(user, users) }),
                // Per-account tuning. Offered for everyone except owners, who
                // hold every scope regardless of what the lists say.
                user.role !== "OWNER"
                  ? el("button", {
                      type: "button",
                      text: "Permissions",
                      onclick: () => userPermissionsDialog(user, users),
                    })
                  : null,
                // The recovery path for a Discord account nobody holds any
                // more; without it that operator account is stranded.
                user.discordId
                  ? el("button", {
                      type: "button",
                      text: "Unlink Discord",
                      onclick: async (event) => {
                        const button = event.currentTarget;
                        const confirmed = await confirmDialog({
                          title: `Unlink Discord from ${user.email}`,
                          lead: `${user.discordUsername ?? "The linked account"} will no longer sign them in.`,
                          points: user.hasPassword
                            ? ["Their email and password still work."]
                            : ["This account has no password, so an emailed sign-in link becomes their only way in."],
                          confirmLabel: "Unlink it",
                          danger: false,
                        });
                        if (!confirmed) return;
                        await act(
                          "admin_user.discord_unlink",
                          () => api(`/users/${user.id}/discord`, { method: "DELETE" }),
                          { button, refresh: [users] },
                        );
                      },
                    })
                  : null,
                el("button", {
                  type: "button",
                  class: "danger",
                  text: "Delete",
                  onclick: async (event) => {
                    const button = event.currentTarget;
                    const confirmed = await confirmDialog({
                      title: `Delete ${user.email}`,
                      lead: "The account is removed and its sessions are revoked immediately.",
                      points: ["Anything they did stays in the audit log under their name."],
                      confirmLabel: "Delete the account",
                    });
                    if (!confirmed) return;
                    await act("admin_user.delete", () => api(`/users/${user.id}`, { method: "DELETE" }), {
                      button,
                      refresh: [users],
                    });
                  },
                }),
              ].filter(Boolean),
            ]),
            { empty: "No operator account exists yet." },
          ),
        { reserve: 260, skeleton: () => skeletonTable(4, 6) },
      ),
    ),
  );
};

/**
 * Change one account's role. Confirms on the way up (granting authority) and on
 * the way down (taking it away mid-session), because both surprise somebody.
 */
function roleSelect(user, users) {
  return el(
    "select",
    {
      "aria-label": `Role for ${user.email}`,
      onchange: async (event) => {
        const select = event.target;
        const role = select.value;
        if (role === user.role) return;
        const confirmed = await confirmDialog({
          title: role === "OWNER" ? `Make ${user.email} an OWNER` : `Change ${user.email} to ${role}`,
          lead:
            role === "OWNER"
              ? "They will be able to manage every account, mint client tokens, and download database backups."
              : "Their existing sessions keep working, with the new and narrower authority from their next request.",
          points: ROLE_BLURB[role] ? [ROLE_BLURB[role]] : [],
          confirmLabel: role === "OWNER" ? "Make them an owner" : `Change to ${role}`,
          danger: role === "OWNER",
        });
        if (!confirmed) {
          // Snap back so the control never shows a role that was not applied.
          select.value = user.role;
          return;
        }
        await act("admin_user.role", () => api(`/users/${user.id}/role`, { method: "POST", body: { role } }), {
          refresh: [users],
        });
      },
    },
    ROLES.map(([value]) => el("option", { value, text: value, selected: value === user.role })),
  );
}

function passwordDialog(user, users) {
  const password = el("input", {
    id: "new-password",
    type: "password",
    minlength: "12",
    autocomplete: "new-password",
  });
  password.style.width = "100%";
  const status = el("p", { class: "field-error" });

  openModal(
    `Set password · ${user.email}`,
    el(
      "div",
      {},
      el("p", { class: "dim small", text: "Minimum 12 characters. Any existing password is replaced." }),
      el("label", { for: "new-password", text: "New password" }),
      password,
      status,
      row(
        el("button", {
          type: "button",
          class: "primary",
          text: "Save",
          onclick: async (event) => {
            if (password.value.length < 12) {
              status.textContent = "Password must be at least 12 characters.";
              password.setAttribute("aria-invalid", "true");
              return;
            }
            const ok = await act(
              "admin_user.password",
              () => api(`/users/${user.id}/password`, { method: "POST", body: { password: password.value } }),
              { button: event.currentTarget, refresh: users ? [users] : [] },
            );
            password.value = "";
            if (ok) closeModal();
          },
        }),
        el("button", { type: "button", text: "Cancel", onclick: closeModal }),
      ),
    ),
  );
}

// ---------------------------------------------------------------- permissions

/**
 * A checkbox per scope, grouped by area.
 *
 * Grouping is not decoration: the flat taxonomy is 21 entries and the question
 * being answered is nearly always about an area ("may they touch chapters at
 * all?"), so a flat list makes the reader do the sorting every time. Each box
 * carries its description as a title, because a checkbox labelled
 * `tracked:append` alone assumes the reader already knows the answer they came
 * to look up.
 *
 * Returns handles rather than a bare node: the caller needs to read the
 * selection back and to set it from a preset.
 */
function scopePicker(scopes, { selected = [], idPrefix = "scope", onchange } = {}) {
  const boxes = new Map();
  const areas = new Map();
  for (const scope of scopes) {
    const area = scope.name.split(":")[0];
    if (!areas.has(area)) areas.set(area, []);
    areas.get(area).push(scope);
  }
  const chosen = new Set(selected);

  const node = el(
    "div",
    { class: "grid" },
    [...areas].map(([area, list]) =>
      el(
        "div",
        { class: "stat" },
        el("div", { class: "k", text: area }),
        list.map((scope) => {
          const id = `${idPrefix}-${scope.name}`;
          const box = el("input", {
            type: "checkbox",
            id,
            value: scope.name,
            checked: chosen.has(scope.name),
            ...(onchange ? { onchange } : {}),
          });
          boxes.set(scope.name, box);
          return el(
            "div",
            { class: "row tight", title: scope.description },
            box,
            el("label", { class: "inline", for: id, text: scope.name }),
          );
        }),
      ),
    ),
  );

  return {
    node,
    get: () => [...boxes].filter(([, box]) => box.checked).map(([name]) => name),
    set: (wanted) => {
      const set = new Set(wanted);
      for (const [name, box] of boxes) box.checked = set.has(name);
      onchange?.();
    },
  };
}

/**
 * What each role means here.
 *
 * The wildcard is shown as itself rather than expanded into 21 boxes: OWNER
 * holds scopes that do not exist yet, and a checklist would quietly claim
 * otherwise.
 */
VIEWS.permissions = () => {
  const catalogue = new Resource("permissions", () => api("/permissions"));

  return el(
    "div",
    {},
    card(
      "Roles",
      el("p", {
        class: "dim small",
        text:
          "A role's baseline is what every account in it starts with. Changing one takes effect on sessions that " +
          "are already open, within a few seconds — nobody has to sign in again. Individual accounts can be tuned " +
          "further from the Users page.",
      }),
      live(
        [catalogue],
        (data) =>
          el(
            "div",
            {},
            data.roles.map((role) => rolePanel(role, data, catalogue)),
          ),
        {
          reserve: 400,
          skeleton: () => el("div", {}, el("div", { class: "skeleton skeleton-line" }), skeletonGrid(6)),
        },
      ),
    ),
  );
};

/** One role's editor, or its read-only statement when it is not tunable. */
function rolePanel(role, data, catalogue) {
  const heading = el(
    "div",
    { class: "row" },
    el("h3", { text: role.role }),
    chip(role.custom ? "customised" : role.tunable ? "shipped default" : "fixed"),
    role.updatedBy ? el("span", { class: "dim small", text: `last changed by ${role.updatedBy}` }) : null,
  );

  if (!role.tunable) {
    return el(
      "div",
      { class: "stat" },
      heading,
      el("p", {
        class: "dim small",
        text:
          "OWNER holds every scope, including ones added by future releases, and cannot be narrowed. It is the " +
          "role that edits permissions, so leaving it editable would let one mistake lock this deployment out of " +
          "its own control plane.",
      }),
      el("div", { class: "row tight" }, chip("*")),
    );
  }

  const picker = scopePicker(data.scopes, { selected: role.scopes, idPrefix: `role-${role.role}` });

  return el(
    "div",
    { class: "stat" },
    heading,
    row(
      el("span", { class: "dim small", text: "Presets:" }),
      Object.entries(data.presets).map(([preset, list]) =>
        el("button", {
          type: "button",
          text: preset,
          title: list.join(", "),
          onclick: () => picker.set(list),
        }),
      ),
      el("button", { type: "button", text: "shipped default", onclick: () => picker.set(role.defaults) }),
      el("button", { type: "button", text: "clear", onclick: () => picker.set([]) }),
    ),
    picker.node,
    row(
      el("button", {
        type: "button",
        class: "primary",
        text: "Save baseline",
        onclick: async (event) => {
          const scopes = picker.get();
          const removed = role.scopes.filter((s) => s !== "*" && !scopes.includes(s));
          const confirmed = await confirmDialog({
            title: `Change what ${role.role} may do`,
            lead: `Every ${role.role} on this deployment will hold exactly these ${scopes.length} scope(s).`,
            points: [
              ...(removed.length ? [`Removed: ${removed.join(", ")}`] : []),
              ...(scopes.length === 0 ? ["Nobody in this role will be able to do anything."] : []),
              "Sessions already open pick this up within a few seconds.",
            ],
            confirmLabel: "Change the role",
          });
          if (!confirmed) return;
          await act(
            "permissions.role",
            () => api(`/permissions/roles/${role.role}`, { method: "PUT", body: { scopes } }),
            { button: event.currentTarget, refresh: [catalogue] },
          );
        },
      }),
      role.custom
        ? el("button", {
            type: "button",
            text: "Reset to shipped default",
            onclick: async (event) => {
              await act("permissions.role.reset", () => api(`/permissions/roles/${role.role}`, { method: "DELETE" }), {
                button: event.currentTarget,
                refresh: [catalogue],
              });
            },
          })
        : null,
    ),
  );
}

/**
 * Tune one account on top of its role.
 *
 * Grants and denials are separate pickers rather than one tri-state list,
 * because they answer different questions and denial is the dangerous one:
 * making an operator pick it out of a shared control would be how somebody
 * removes an ability they meant to add.
 */
function userPermissionsDialog(user, users) {
  const status = el("p", { class: "field-error" });
  const body = el("div", {});
  openModal(`Permissions · ${user.email}`, body);

  void (async () => {
    const [catalogue, current] = await Promise.all([api("/permissions"), api(`/users/${user.id}/permissions`)]);
    if (!catalogue || !current) return;

    if (!current.tunable) {
      setChildren(
        body,
        el("p", {
          text:
            "This account is an OWNER: it holds every scope by construction and ignores grants and denials. " +
            "Change its role first if it should be restricted.",
        }),
        row(el("button", { type: "button", text: "Close", onclick: closeModal })),
      );
      return;
    }

    const known = new Set(catalogue.scopes.map((s) => s.name));
    const all = (list, extra) => {
      const out = new Set();
      for (const s of list) {
        if (s === "*") {
          for (const name of known) out.add(name);
          continue;
        }
        if (!known.has(s)) continue;
        out.add(s);
        for (const implied of extra(s)) if (known.has(implied)) out.add(implied);
      }
      return [...out];
    };
    // Mirrors expandScopes/denialClosure in src/core/api/scopes.ts. A grant
    // closes downward (a write carries its read); a denial closes upward (
    // refusing the read has to refuse the write, which would imply it back).
    const expand = (list) =>
      all(list, (s) => {
        const [area, verb] = s.split(":");
        if (verb === "write") return [`${area}:read`, `${area}:append`];
        if (verb === "append") return [`${area}:read`];
        return [];
      });
    const refuse = (list) =>
      all(list, (s) => {
        const [area, verb] = s.split(":");
        if (verb === "read") return [`${area}:append`, `${area}:write`];
        if (verb === "append") return [`${area}:write`];
        return [];
      });

    const effective = el("div", { class: "row tight" });
    const refreshPreview = () => {
      const granted = [...new Set([...current.baseline, ...grant.get()])];
      const denied = new Set(refuse(deny.get()));
      const result = denied.size ? expand(granted).filter((s) => !denied.has(s)) : granted;
      setChildren(effective, result.length ? result.map((s) => chip(s)) : el("span", { class: "dim", text: "none" }));
    };

    const grant = scopePicker(catalogue.scopes, {
      selected: current.extraScopes,
      idPrefix: "grant",
      onchange: () => refreshPreview(),
    });
    const deny = scopePicker(catalogue.scopes, {
      selected: current.deniedScopes,
      idPrefix: "deny",
      onchange: () => refreshPreview(),
    });

    setChildren(
      body,
      el("p", {
        class: "dim small",
        text:
          `${user.email} is a ${current.role}, which grants: ${current.baseline.join(", ") || "nothing"}. ` +
          "Everything below is on top of that.",
      }),
      el("h3", { text: "Granted beyond the role" }),
      grant.node,
      el("h3", { text: "Denied despite the role" }),
      el("p", {
        class: "dim small",
        text: "Denials are applied last and win. This is how you express “an ADMIN, but not bundles”.",
      }),
      deny.node,
      el("h3", { text: "Effective" }),
      effective,
      status,
      row(
        el("button", {
          type: "button",
          class: "primary",
          text: "Save",
          onclick: async (event) => {
            const extraScopes = grant.get();
            const deniedScopes = deny.get();
            const both = extraScopes.filter((s) => deniedScopes.includes(s));
            if (both.length) {
              status.textContent = `Cannot both grant and deny: ${both.join(", ")}`;
              return;
            }
            status.textContent = "";
            const saved = await act(
              "permissions.user",
              () => api(`/users/${user.id}/permissions`, { method: "PUT", body: { extraScopes, deniedScopes } }),
              { button: event.currentTarget, refresh: users ? [users] : [] },
            );
            if (saved) closeModal();
          },
        }),
        el("button", {
          type: "button",
          text: "Clear tuning",
          onclick: () => {
            grant.set([]);
            deny.set([]);
          },
        }),
        el("button", { type: "button", text: "Cancel", onclick: closeModal }),
      ),
    );
    refreshPreview();
  })();
}

function sessionsPanel() {
  const sessions = new Resource("sessions", () => api("/sessions"));
  return card(
    "Live sessions",
    el("p", { class: "dim small", text: "Revoking takes effect on the session's next request." }),
    live(
      [sessions],
      (data) =>
        table(
          ["Actor", "Account", "Role", "Signed in", "Expires", ""],
          data.sessions.map((session) => [
            session.actor,
            session.email,
            chip(session.role),
            fmtTime(session.createdAt),
            fmtTime(session.expiresAt),
            [
              el("button", {
                type: "button",
                class: "danger",
                text: "Revoke",
                onclick: async (event) => {
                  const button = event.currentTarget;
                  const confirmed = await confirmDialog({
                    title: `Sign ${session.actor} out`,
                    lead: "Their session stops working on its next request.",
                    points: [
                      "They can sign in again immediately unless the account is also deleted or unapproved.",
                    ],
                    confirmLabel: "Revoke the session",
                  });
                  if (!confirmed) return;
                  await act("admin_session.revoke", () => api(`/sessions/${session.id}`, { method: "DELETE" }), {
                    button,
                    refresh: [sessions],
                  });
                },
              }),
            ],
          ]),
          { empty: "Nobody is signed in." },
        ),
      { reserve: 220, skeleton: () => skeletonTable(4, 6) },
    ),
  );
}

function signupsPanel() {
  const signups = new Resource("signups", () => api("/settings/signups"));
  return card(
    "Self-signup",
    live(
      [signups],
      (data) => {
        const toggle = el("input", {
          type: "checkbox",
          id: "signups-enabled",
          checked: data.enabled,
          onchange: (event) => {
            const enabled = event.target.checked;
            return act(
              "settings.signups",
              () =>
                signups.optimistic(
                  (current) => ({ ...current, enabled }),
                  () => api("/settings/signups", { method: "POST", body: { enabled } }),
                ),
              {},
            );
          },
        });
        return el(
          "div",
          {},
          row(
            toggle,
            el("label", {
              class: "inline",
              for: "signups-enabled",
              text: "Allow new Discord logins to create accounts",
            }),
          ),
          el("p", {
            class: "dim small",
            text:
              "New accounts always land unapproved and with the ADMIN role; somebody has to approve them on " +
              "the Accounts tab before they can sign in.",
          }),
        );
      },
      { reserve: 70, skeleton: () => el("div", { class: "skeleton skeleton-line", style: { height: "50px" } }) },
    ),
  );
}

// --------------------------------------------------------------------- tokens

/**
 * Scoped per-client credentials (`pa_…`). OWNER-only, because minting a token
 * can grant any scope; the server enforces that on every endpoint here, so a
 * hidden destination is a convenience, not the control.
 *
 * The secret is shown exactly once, in a modal, and there is no endpoint that
 * can reveal it again; that is why the copy button and the warning are not
 * optional polish.
 */
VIEWS.tokens = (route) => {
  const tokens = new Resource("tokens", () => api("/tokens"));
  if (route.tab === "mint") return mintPanel(tokens);

  const tokenState = (token) => {
    if (token.revoked) return "REVOKED";
    if (token.expiresAt && new Date(token.expiresAt) <= new Date()) return "FAILED";
    return "ACTIVE";
  };

  return card(
    "Issued tokens",
    el("p", {
      class: "dim small",
      text: "Last-used is throttled to one write per token per minute, so treat it as approximate.",
    }),
    live(
      [tokens],
      (data) =>
        table(
          ["Client", "State", "Scopes", "Created by", "Created", "Last used", "Expires", ""],
          data.tokens.map((token) => [
            el("div", {}, el("div", { text: token.name }), el("div", { class: "dim small", text: token.id })),
            chip(tokenState(token)),
            el("div", { class: "row tight" }, token.scopes.map((scope) => chip(scope))),
            token.createdBy,
            fmtTime(token.createdAt),
            token.lastUsedAt ? ago(token.lastUsedAt) : "never",
            token.expiresAt ? fmtTime(token.expiresAt) : "never",
            [
              token.revoked
                ? null
                : el("button", {
                    type: "button",
                    class: "danger",
                    text: "Revoke",
                    onclick: async (event) => {
                      const button = event.currentTarget;
                      const confirmed = await confirmDialog({
                        title: `Revoke “${token.name}”`,
                        lead: "It stops working immediately and cannot be restored.",
                        points: ["Rotation means minting the replacement first, then revoking this one."],
                        confirmLabel: "Revoke it",
                      });
                      if (!confirmed) return;
                      await act(
                        "api_token.revoke",
                        () => api(`/tokens/${token.id}/revoke`, { method: "POST", body: {} }),
                        { button, refresh: [tokens] },
                      );
                    },
                  }),
            ].filter(Boolean),
          ]),
          {
            empty: el(
              "div",
              {},
              el("h3", { text: "No client token exists" }),
              el("p", { text: "Machine clients, the Discord bot, CI, monitoring, each want their own." }),
              el(
                "div",
                { class: "retry-row" },
                routeLink(routeTo("tokens", null, "mint"), "Mint one →", { class: "button-link inline" }),
              ),
            ),
          },
        ),
      { reserve: 240, skeleton: () => skeletonTable(4, 8) },
    ),
  );
};

function mintPanel(tokens) {
  const catalogue = new Resource("token-scopes", () => api("/tokens/scopes"));

  return card(
    "Mint a client token",
    el("p", {
      class: "dim small",
      text:
        "One token per client, carrying only the scopes that client needs; a leaked credential is then " +
        "confined to its area. No token can mint another token or manage accounts, however broadly it is scoped.",
    }),
    live(
      [catalogue],
      (data) => {
        const name = el("input", { id: "token-name", type: "text", maxlength: "128", placeholder: "discord-bot" });
        const ttl = el("input", {
          id: "token-ttl",
          type: "number",
          min: "1",
          max: "3650",
          placeholder: "never expires",
        });

        // Grouped by area so "everything runs-related" is one glance rather than
        // a scan of a flat 15-item list.
        const boxes = new Map();
        const areas = new Map();
        for (const scope of data.scopes) {
          const area = scope.split(":")[0];
          if (!areas.has(area)) areas.set(area, []);
          areas.get(area).push(scope);
        }

        const setScopes = (wanted) => {
          const set = new Set(wanted);
          for (const [scope, box] of boxes) box.checked = set.has(scope);
        };

        return el(
          "div",
          {},
          row(
            el("label", { class: "inline", for: "token-name", text: "Client name" }),
            name,
            el("label", { class: "inline", for: "token-ttl", text: "Expires after (days)" }),
            ttl,
          ),
          row(
            el("span", { class: "dim small", text: "Presets:" }),
            Object.entries(data.presets).map(([preset, list]) =>
              el("button", {
                type: "button",
                text: preset,
                title: list.join(", "),
                onclick: () => {
                  setScopes(list);
                  toast(`${preset}: ${list.length} scope(s) selected`);
                },
              }),
            ),
            el("button", { type: "button", text: "clear", onclick: () => setScopes([]) }),
          ),
          el(
            "div",
            { class: "grid" },
            [...areas].map(([area, list]) =>
              el(
                "div",
                { class: "stat" },
                el("div", { class: "k", text: area }),
                list.map((scope) => {
                  const box = el("input", { type: "checkbox", id: `scope-${scope}`, value: scope });
                  boxes.set(scope, box);
                  return el(
                    "div",
                    { class: "row tight" },
                    box,
                    el("label", { class: "inline", for: `scope-${scope}`, text: scope }),
                  );
                }),
              ),
            ),
          ),
          row(
            el("button", {
              type: "button",
              class: "primary",
              text: "Mint token",
              onclick: async (event) => {
                const chosen = [...boxes].filter(([, box]) => box.checked).map(([scope]) => scope);
                if (!name.value.trim()) return void toast("give the token a name first", false);
                if (!chosen.length) return void toast("select at least one scope", false);
                const days = ttl.value === "" ? undefined : Number(ttl.value);
                if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) {
                  return void toast("expiry must be between 1 and 3650 days", false);
                }
                const minted = await act(
                  "api_token.mint",
                  () =>
                    api("/tokens", {
                      method: "POST",
                      body: { name: name.value.trim(), scopes: chosen, ...(days ? { ttlDays: days } : {}) },
                    }),
                  { button: event.currentTarget, refresh: [tokens] },
                );
                if (minted) {
                  showMintedToken(minted);
                  name.value = "";
                  ttl.value = "";
                  setScopes([]);
                }
              },
            }),
          ),
        );
      },
      {
        reserve: 300,
        skeleton: () => el("div", {}, el("div", { class: "skeleton skeleton-line" }), skeletonGrid(6)),
      },
    ),
  );
}

function showMintedToken(minted) {
  openModal(
    `Client token · ${minted.name}`,
    el(
      "div",
      {},
      el("p", {
        class: "error",
        text:
          "Shown once. Nothing can reveal it again; copy it now and hand it over through a private channel. " +
          "If you lose it, revoke this token and mint another.",
      }),
      el("pre", { text: minted.token }),
      el("p", { class: "dim small", text: `Scopes: ${minted.scopes.join(", ")}` }),
      el("p", {
        class: "dim small",
        text: minted.expiresAt ? `Expires ${fmtTime(minted.expiresAt)}.` : "Does not expire.",
      }),
      row(
        el("button", {
          type: "button",
          class: "primary",
          text: "Copy token",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(minted.token);
              toast("copied to clipboard");
            } catch {
              toast("clipboard blocked; select the text manually", false);
            }
          },
        }),
        el("button", { type: "button", text: "Done", onclick: closeModal }),
      ),
    ),
  );
}

// --------------------------------------------------------------- your account

/**
 * The signed-in principal's own view of itself: which credential this is, what
 * it may do, and, for a session backed by an account, the two credentials it
 * can manage for itself without going through the Users view, which an ADMIN
 * cannot open.
 *
 * Asks the API rather than reading `store`: the credential set changes under
 * this page's feet (linking Discord finishes in a redirect, a password is set
 * from a dialog), and a stale "no password" here is the one thing that would
 * send somebody looking for a button that is already done.
 */
async function accountDialog() {
  let me = null;
  try {
    me = await api("/session", { allow401: true });
  } catch {
    // Fall back to what the shell already knows; the credential rows are
    // simply omitted rather than guessed at.
  }

  const credentials = [];
  if (me) {
    credentials.push(me.hasPassword ? "password" : null);
    credentials.push(me.discordLinked ? `discord: ${me.discordUsername ?? "linked"}` : null);
    if (!me.hasPassword && !me.discordLinked && me.magicLink) credentials.push("email sign-in link only");
  }

  const body = el(
    "div",
    {},
    defs([
      ["Actor", store.actor ?? "-"],
      ["Account", store.email ?? "-"],
      ["Role", store.role ? chip(store.role) : "-"],
      [
        "Credential",
        store.kind === "root"
          ? "the break-glass ADMIN_TOKEN, bound to the seeded owner account"
          : store.kind === "api-token"
            ? "a scoped client token"
            : "a browser session",
      ],
      ...(me ? [["Sign-in methods", credentials.filter(Boolean).join(" · ") || "none"]] : []),
      ["Scopes", store.scopes.length ? store.scopes.join(", ") : "none"],
    ]),
    store.role ? el("p", { class: "dim small", text: ROLE_BLURB[store.role] ?? "" }) : null,
    me && me.hasPassword === false
      ? el("p", {
          class: "dim small",
          text:
            "This account has no password. Every sign-in needs another emailed link until you set one.",
        })
      : null,
    store.userId
      ? row(
          el("button", {
            type: "button",
            class: me && me.hasPassword === false ? "primary" : "",
            text: me && me.hasPassword === false ? "Set a password" : "Change my password",
            onclick: () => passwordDialog({ id: store.userId, email: store.email ?? store.actor }, null),
          }),
          // Linking is a full-page redirect to Discord and back, so it is a
          // link, not a fetch: the round-trip has to survive leaving the page.
          me && me.discordAvailable && !me.discordLinked
            ? el("a", {
                class: "button-link",
                href: `${API}/oauth/discord/link`,
                text: "Link my Discord account",
              })
            : null,
          me && me.discordLinked
            ? el("button", {
                type: "button",
                text: "Unlink Discord",
                onclick: async (event) => {
                  const button = event.currentTarget;
                  const confirmed = await confirmDialog({
                    title: "Unlink Discord",
                    lead: `${me.discordUsername ?? "The linked account"} will no longer sign you in.`,
                    points: me.hasPassword
                      ? ["Your email and password still work."]
                      : ["This account has no password, so an emailed sign-in link becomes the only way in."],
                    confirmLabel: "Unlink it",
                  });
                  if (!confirmed) return;
                  const ok = await act(
                    "admin_user.discord_unlink",
                    () => api(`/users/${store.userId}/discord`, { method: "DELETE" }),
                    { button },
                  );
                  if (ok) {
                    closeModal();
                    void accountDialog();
                  }
                },
              })
            : null,
        )
      : el("p", {
          class: "dim small",
          text: "This credential is not an operator account, so it has no password to set.",
        }),
  );
  openModal("Your account", body);
}

void boot();
