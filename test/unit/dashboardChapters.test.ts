// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The three chapter views, actually rendered.
 *
 * `dashboard/app.js` is 7 000 lines of vanilla JavaScript that nothing
 * type-checks and, until this file, nothing executed. The server-side tests
 * assert it is *served*; `dashboardModules.test.ts` covers the two views that
 * live in their own ES modules. The shell itself, where a mistyped helper name
 * is a blank card and a green suite, had no coverage at all.
 *
 * So this drives the real file under jsdom against a stubbed API: sign in as an
 * owner, navigate to each new destination, and assert the chapters actually
 * appear. It is a smoke test by design; it proves the views mount, ask the
 * endpoints this branch added, and put the returned chapters on the page. It
 * deliberately does not assert layout.
 *
 * app.js is a classic script for exactly this reason (see its header comment):
 * jsdom cannot execute module scripts, so it is evaluated here the way a browser
 * would evaluate it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
   The DOM lib is deliberately kept out of this program (see the same note in
   dashboardModules.test.ts), so the jsdom globals are loosely typed in this
   file only. */
const doc: any = (globalThis as any).document;
const win: any = globalThis;
/* eslint-enable @typescript-eslint/no-explicit-any */

// Resolved from the working directory, not from `import.meta.url`: under the
// jsdom environment that URL is an http one, and readFileSync wants a path.
const DASHBOARD = resolve(process.cwd(), "src/core/api/dashboard");
const APP_JS = join(DASHBOARD, "app.js");
const INDEX_HTML = join(DASHBOARD, "index.html");

const MD_CHAPTER = "1c2d3e4f-0000-4000-8000-000000000001";
const MD_MANGA = "9a1b1c1d-0000-4000-8000-000000000000";

/** Canned API responses, keyed by the path prefix the view requests. */
function apiRoutes(): { match: RegExp; body: unknown | ((init?: { body?: string }) => unknown) }[] {
  return [
    { match: /\/session$/, body: { actor: "ardax", role: "OWNER", userId: "u1", email: "a@b.c" } },
    {
      match: /\/whoami$/,
      body: { kind: "session", name: "ardax", role: "OWNER", scopes: ["*"], csrfHeader: "x-requested-with", csrfValue: "publoader-dash" },
    },
    { match: /\/stats$/, body: { paused: false, workers: {}, jobs: {}, uploadTasks: [] } },
    {
      match: /\/runs\?limit=1/,
      body: { runs: [{ id: "r1", extension: "mangaplus", state: "PROCESSED", createdAt: "2026-08-01T00:00:00Z" }] },
    },
    {
      match: /\/runs\?limit=50/,
      body: {
        runs: [
          {
            id: "r1",
            extension: "mangaplus",
            kind: "UPDATE",
            state: "PROCESSED",
            segmentsTotal: 1,
            triggeredBy: "scheduler",
            createdAt: "2026-08-01T00:00:00Z",
            error: null,
            chaptersFound: 41,
            chaptersSeen: 902,
          },
        ],
      },
    },
    {
      match: /\/runs\/r1\/chapters\/summary/,
      body: {
        run: { id: "r1", extension: "mangaplus" },
        set: "updated",
        segments: [{ jobId: "j1", segmentIndex: 0, segmentKey: "seg0", jobState: "SUCCEEDED", updated: 2, all: null, untrackedManga: 0, submittedAt: "2026-08-01T00:00:00Z" }],
        segmentsTotal: 1,
        segmentsReported: 1,
        complete: true,
        totals: { updated: 2, all: null, untrackedManga: 0 },
        byManga: [{ mdMangaId: MD_MANGA, mangaId: "m1", mangaName: "Sakamoto Days", count: 2 }],
        mangaTitles: 1,
        mangaCapped: false,
      },
    },
    {
      match: /\/runs\/r1\/chapters\?/,
      body: {
        run: { id: "r1", extension: "mangaplus", state: "PROCESSED" },
        set: "updated",
        total: 2,
        limit: 100,
        offset: 0,
        order: "segmentIndex,position",
        chapters: [
          {
            jobId: "j1",
            segmentIndex: 0,
            segmentKey: "seg0",
            position: 1,
            chapter: { mangaName: "Sakamoto Days", mdMangaId: MD_MANGA, chapterNumber: "142", chapterTitle: "The Duel", chapterLanguage: "en", chapterUrl: "https://example.test/1", mdChapterId: null },
          },
          {
            jobId: "j1",
            segmentIndex: 0,
            segmentKey: "seg0",
            position: 2,
            chapter: { mangaName: "Sakamoto Days", mdMangaId: MD_MANGA, chapterNumber: "143", chapterTitle: null, chapterLanguage: "en", mdChapterId: MD_CHAPTER },
          },
        ],
      },
    },
    {
      match: /\/runs\/r1$/,
      body: {
        run: {
          id: "r1",
          extension: "mangaplus",
          extensionVersion: "1.0.0",
          bundleSha256: "a".repeat(64),
          kind: "UPDATE",
          state: "PROCESSED",
          createdAt: "2026-08-01T00:00:00Z",
          jobs: [],
        },
      },
    },
    {
      match: /\/queues\/chapters/,
      body: {
        total: 2,
        limit: 100,
        nextCursor: null,
        order: "notBefore,createdAt,id",
        states: ["PENDING"],
        summary: [],
        chapters: [
          {
            id: "t1",
            kind: "UPLOAD",
            state: "PENDING",
            dedupeKey: "src-1|142|en",
            attempt: 0,
            maxAttempts: 5,
            notBefore: "2026-08-01T00:00:00Z",
            position: 1,
            mangaName: "Sakamoto Days",
            mdMangaId: MD_MANGA,
            chapterNumber: "142",
            chapterVolume: "17",
            chapterTitle: "The Duel",
            chapterLanguage: "en",
            mdChapterId: null,
            editPayload: null,
            pageCount: 18,
          },
          {
            id: "t2",
            kind: "EDIT",
            state: "PENDING",
            dedupeKey: MD_CHAPTER,
            attempt: 0,
            maxAttempts: 5,
            notBefore: "2026-08-01T00:01:00Z",
            position: 2,
            mangaName: "Sakamoto Days",
            mdMangaId: MD_MANGA,
            chapterNumber: "141",
            chapterTitle: "Old title",
            chapterLanguage: "en",
            mdChapterId: MD_CHAPTER,
            editPayload: { title: "Corrected title" },
            pageCount: 0,
          },
        ],
      },
    },
    { match: /\/chapters\/extensions/, body: { table: "uploaded", extensions: [{ extension: "mangaplus", count: 902 }] } },
    {
      // Ordered before the series listing: its path starts the same way.
      match: /\/chapters\/series\/[^/]+\/recheck/,
      body: (init?: { body?: string }) => {
        const sent = JSON.parse(init?.body ?? "{}");
        return {
          dryRun: sent.dryRun !== false,
          action: "RECHECK",
          extension: "mangaplus",
          mangaId: "100191",
          removalMode: "unavailable",
          onMangadex: 41,
          carded: 3,
          candidates: 38,
          publishesCatalogue: true,
          ...(sent.dryRun === false ? { ok: true, runId: "run-recheck-1", created: true } : {}),
          note: "note",
        };
      },
    },
    {
      match: /\/chapters\/series/,
      body: {
        archive: "unavailable",
        limit: 100,
        capped: false,
        series: [
          {
            mdMangaId: MD_MANGA,
            mangaName: "Sakamoto Days",
            extensions: ["mangaplus"],
            count: 12,
            at: "2026-03-04T05:06:07Z",
          },
        ],
      },
    },
    {
      // Answers from the request, because the property under test is that the
      // panel keeps calling while a continuation comes back.
      match: /\/chapters\/unavailable\/recard/,
      body: (init?: { body?: string }) => {
        const sent = JSON.parse(init?.body ?? "{}");
        const continued = Boolean(sent.afterId);
        const results = [
          {
            mdChapterId: MD_CHAPTER,
            ok: true,
            outcome: sent.dryRun === false ? "queued" : "would_queue",
            mangaName: "Sakamoto Days",
            chapterNumber: "141",
            chapterLanguage: "en",
            unavailableAt: "2026-03-04T05:06:07Z",
          },
        ];
        return sent.dryRun === false
          ? {
              ok: true,
              dryRun: false,
              action: "RECARD",
              sweep: "sweep-1",
              matched: 7,
              requested: continued ? 3 : 4,
              queued: continued ? 3 : 4,
              refused: 0,
              nextAfterId: continued ? null : "row-4",
              results,
            }
          : {
              dryRun: true,
              action: "RECARD",
              matched: 7,
              resolved: 4,
              wouldQueue: 4,
              blocked: 0,
              batch: 200,
              nextAfterId: "row-4",
              results,
            };
      },
    },
    {
      match: new RegExp(`/chapters/${MD_CHAPTER}$`),
      body: {
        // The shape `GET /chapters/:mdChapterId` actually returns: the id at the
        // top level, the four archives with the instant each recorded, the live
        // MangaDex read (or the reason it failed), and any queue rows keyed on
        // this chapter.
        mdChapterId: MD_CHAPTER,
        chapter: {
          mdChapterId: MD_CHAPTER,
          extension: "mangaplus",
          chapterNumber: "141",
          chapterVolume: "17",
          chapterTitle: "Old title",
          chapterLanguage: "en",
          mangaName: "Sakamoto Days",
          mdMangaId: MD_MANGA,
          mdGroupId: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
          chapterId: null,
          chapterUrl: null,
        },
        archives: {
          uploaded: "2026-06-01T00:00:00Z",
          unavailable: null,
          deleted: null,
          edited: "2026-07-01T00:00:00Z",
        },
        edits: [{ editedAt: "2026-07-01T00:00:00Z", old: { title: "Typo" }, new: { title: "Old title" } }],
        mangadex: null,
        mangadexError: "no MangaDex credentials on this instance",
        tasks: [],
        links: {
          chapter: `https://mangadex.org/chapter/${MD_CHAPTER}`,
          manga: `https://mangadex.org/title/${MD_MANGA}`,
          source: null,
        },
        actionsBlockedReason: null,
      },
    },
    {
      match: /\/chapters\?/,
      body: {
        table: "uploaded",
        total: 1,
        limit: 50,
        offset: 0,
        tables: ["uploaded", "edited", "unavailable", "deleted"],
        chapters: [
          {
            mdChapterId: MD_CHAPTER,
            extensionName: "mangaplus",
            chapterNumber: "141",
            chapterVolume: "17",
            chapterTitle: "Old title",
            chapterLanguage: "en",
            mangaName: "Sakamoto Days",
            mdMangaId: MD_MANGA,
            at: "2026-07-01T00:00:00Z",
          },
        ],
      },
    },
  ];
}

/** Every path the stub was asked for, so a test can assert what a view fetched. */
let requested: string[] = [];

function installFetch(): void {
  const routes = apiRoutes();
  win.fetch = vi.fn(async (url: string, init?: { body?: string }) => {
    const path = String(url);
    requested.push(path);
    const route = routes.find((r) => r.match.test(path));
    // A route may answer from the request rather than with a constant, which is
    // what lets a paged endpoint be stubbed as a page sequence.
    const body = route ? (typeof route.body === "function" ? route.body(init) : route.body) : {};
    return {
      // `ok` is what api() branches on; a stub without it makes every call throw
      // "200 OK" and the page falls back to the sign-in layer.
      ok: Boolean(route),
      status: route ? 200 : 404,
      statusText: route ? "OK" : "Not Found",
      text: async () => JSON.stringify(body),
    };
  });
}

/** Let the view's promises settle; resources fetch, then redraw. */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const text = (): string => doc.getElementById("view").textContent ?? "";

async function goto(hash: string): Promise<void> {
  win.location.hash = hash;
  // jsdom fires hashchange asynchronously; app.js listens for it.
  await settle();
}

describe("dashboard chapter views", () => {
  beforeEach(async () => {
    requested = [];
    const html = readFileSync(INDEX_HTML, "utf8");
    // Body only: the <head> would pull app.js and style.css over the network,
    // and the script is evaluated by hand below. The markup is this repo's own
    // checked-in file, not input; this is the shipped page, which is the point.
    const body = html.split("<body>")[1]?.split("</body>")[0];
    if (!body) throw new Error("index.html has no <body>: the dashboard shell cannot be mounted");
    doc.body.innerHTML = body;
    win.location.hash = "";
    installFetch();

    // jsdom implements <dialog> as an element but not its modal methods, so the
    // real `showModal()` every dialog in app.js calls throws asynchronously out
    // of a click handler; which vitest reports as an unhandled error and exits
    // non-zero even though the assertions below pass. Stubbing the two methods
    // to the `open` attribute they set is enough for the tests here, which read
    // a dialog's rendered content rather than its modality.
    // Typed structurally rather than as HTMLDialogElement: this tsconfig's lib
    // is ES2023 with no DOM, which is why `win` above is `any` too.
    interface DialogLike {
      showModal?: () => void;
      close?: () => void;
      setAttribute: (name: string, value: string) => void;
      removeAttribute: (name: string) => void;
    }
    const dialogs = win.HTMLDialogElement?.prototype as DialogLike | undefined;
    if (dialogs && typeof dialogs.showModal !== "function") {
      dialogs.showModal = function showModal(this: DialogLike): void {
        this.setAttribute("open", "");
      };
      dialogs.close = function close(this: DialogLike): void {
        this.removeAttribute("open");
      };
    }

    // Evaluated rather than imported. app.js is deliberately a classic script
    // (jsdom cannot execute module scripts) ending in `void boot()`, so this is
    // how a browser runs it and `boot()` is exactly the entry point under test.
    // The source is this repo's own file read from disk; nothing is interpolated
    // into it.
    new Function(readFileSync(APP_JS, "utf8")).call(win);
    await settle(10);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("signs in and shows the new Chapters destination in the sidebar", () => {
    expect(doc.getElementById("app").hidden).toBe(false);
    expect(doc.getElementById("nav").textContent).toContain("Chapters");
  });

  it("shows how many chapters each run found, in the runs list", async () => {
    await goto("#/runs/recent");
    expect(text()).toContain("Chapters found");
    expect(text()).toContain("41");
    expect(text()).toContain("of 902 seen");
  });

  it("lists the chapters a run found, with the per-series breakdown", async () => {
    await goto("#/runs/r1");
    expect(requested.some((path) => path.includes("/runs/r1/chapters?"))).toBe(true);
    expect(requested.some((path) => path.includes("/runs/r1/chapters/summary"))).toBe(true);
    expect(text()).toContain("Chapters found");
    // The chapters themselves, not just the counts.
    expect(text()).toContain("The Duel");
    expect(text()).toContain("143");
    // And the coverage line that says the list can be trusted as whole.
    expect(text()).toContain("segments reported");
  });

  it("lists the queue as chapters, numbered in claim order", async () => {
    await goto("#/queues/chapters");
    expect(requested.some((path) => path.includes("/queues/chapters"))).toBe(true);
    const view = text();
    expect(view).toContain("Sakamoto Days");
    expect(view).toContain("142");
    // An EDIT row shows what it will change rather than the title it carries.
    expect(view).toContain("title → Corrected title");
    expect(view).toContain("claim order");
  });

  it("defaults the Queues page to the chapter view", async () => {
    await goto("#/queues");
    await settle();
    // The tab is resolved into the canonical hash, so a bookmark of `#/queues`
    // lands on the chapter list rather than the row list.
    expect(win.location.hash).toBe("#/queues/chapters");
  });

  it("browses the chapter archive and opens one chapter in full", async () => {
    await goto("#/chapters");
    expect(text()).toContain("Sakamoto Days");
    expect(text()).toContain("Old title");

    await goto(`#/chapters/${MD_CHAPTER}`);
    const view = text();
    // The three actions, each of which queues a task rather than writing.
    expect(view).toContain("Edit metadata…");
    expect(view).toContain("Mark unavailable…");
    expect(view).toContain("Delete from MangaDex…");
    // What the platform holds, what is already queued against it, and how it
    // got to its current state; the three things the detail view joins.
    expect(view).toContain("Sakamoto Days");
    expect(view).toContain("Queued against this chapter");
    expect(view).toContain("Edit history");
  });

  /** The dialog's "Edit metadata…" button, once the detail view has drawn. */
  async function openEditForm(): Promise<void> {
    await goto(`#/chapters/${MD_CHAPTER}`);
    const button = [...doc.querySelectorAll("button")].find(
      (b: { textContent: string }) => b.textContent === "Edit metadata…",
    );
    expect(button).toBeTruthy();
    button.click();
    await settle();
  }

  it("opens the correction form prefilled with what MangaDex currently holds", async () => {
    await openEditForm();

    const dialog = doc.getElementById("modal-body");
    // The form is explicit that it queues rather than writes, because the whole
    // point of the design is that core-uploader is the only writer.
    expect(dialog.textContent).toContain("Only the fields you change are sent");
    expect(doc.getElementById("chapter-edit-chapter").value).toBe("141");
    expect(doc.getElementById("chapter-edit-title").value).toBe("Old title");
    expect(doc.getElementById("chapter-edit-translatedLanguage").value).toBe("en");
  });

  it("sends only the fields that changed, as a MangaDex-shaped body", async () => {
    await openEditForm();

    doc.getElementById("chapter-edit-title").value = "Corrected title";
    [...doc.querySelectorAll("#modal-body button")]
      .find((b: { textContent: string }) => b.textContent === "Queue the edit")
      .click();
    await settle();

    const call = win.fetch.mock.calls.find(
      ([url, init]: [string, { method?: string }]) =>
        String(url).includes(`/chapters/${MD_CHAPTER}`) && init?.method === "PATCH",
    );
    expect(call).toBeTruthy();
    // `volume` and `chapter` were left alone, so they are not in the body; a
    // form that submitted all of them would write "unchanged" edits into the
    // chapter's permanent history.
    expect(JSON.parse(call[1].body)).toEqual({ title: "Corrected title" });
  });

  /**
   * The re-card panel under Admin → System.
   *
   * It is the one control in the dashboard whose apply step is a LOOP: a sweep
   * of the whole archive is a request per page, continued by `nextAfterId`
   * until the server stops returning one. A panel that fired once and reported
   * "done" would silently leave most of the archive un-recarded, which is the
   * failure this covers.
   */
  describe("re-posting unavailable card images", () => {
    /** Click a button by its label, anywhere in the mounted view. */
    const click = (label: string): void => {
      const button = [...doc.querySelectorAll("button")].find(
        (b: { textContent: string }) => b.textContent === label,
      );
      expect(button, `no button labelled ${label}`).toBeTruthy();
      button.click();
    };

    const recardCalls = () =>
      win.fetch.mock.calls.filter(([url]: [string]) => String(url).includes("/unavailable/recard"));

    it("offers the four targets and previews the whole archive by default", async () => {
      await goto("#/system/cards");
      const view = text();
      expect(view).toContain("Re-post unavailable card images");
      expect(view).toContain("Every unavailable chapter");
      expect(view).toContain("One series");
      expect(view).toContain("Pick from the archive");
      expect(view).toContain("One chapter");

      click("Preview");
      await settle();

      const [, init] = recardCalls()[0];
      // A preview is a dry run naming a filter, never an id list, and never a
      // live write.
      expect(JSON.parse(init.body)).toEqual({ filter: {}, dryRun: true });
      expect(text()).toContain("7");
    });

    it("keeps sweeping until the server stops handing back a continuation", async () => {
      await goto("#/system/cards");
      click("Re-post every card…");
      await settle();
      // The confirm dialog stands between the click and any write.
      click("Queue the re-cards");
      await settle(20);

      const live = recardCalls().filter(
        ([, init]: [string, { body: string }]) => JSON.parse(init.body).dryRun === false,
      );
      // Two pages: the stub returns a continuation for the first call and none
      // for the second, so a panel that fired once would stop at 4 of 7.
      expect(live).toHaveLength(2);
      expect(JSON.parse(live[0][1].body)).toEqual({ filter: {}, dryRun: false, confirm: true });
      expect(JSON.parse(live[1][1].body).afterId).toBe("row-4");
      expect(text()).toContain("done");
    });

    it("re-cards a single chapter named by its MangaDex id", async () => {
      await goto("#/system/cards");
      doc.getElementById("recard-mode-one").checked = true;
      doc.getElementById("recard-mode-one").dispatchEvent(new win.Event("change"));
      await settle();

      const field = doc.getElementById("recard-chapter-id");
      field.value = MD_CHAPTER;
      field.dispatchEvent(new win.Event("input"));
      await settle();

      // The exact image, rendered by the same code that posts it, so an
      // operator approves what actually goes up.
      click("Refresh the preview");
      expect(doc.querySelector(".card-preview").src).toContain(`/chapters/${MD_CHAPTER}/card.png`);

      click("Preview");
      await settle();
      expect(JSON.parse(recardCalls()[0][1].body)).toEqual({ ids: [MD_CHAPTER], dryRun: true });
    });

    it("re-cards exactly the chapters ticked in the picker", async () => {
      await goto("#/system/cards");
      doc.getElementById("recard-mode-selected").checked = true;
      doc.getElementById("recard-mode-selected").dispatchEvent(new win.Event("change"));
      await settle();
      // The archive listing, not the uploaded one: this panel only ever touches
      // chapters that already carry a card.
      expect(requested.some((path) => path.includes("archive=unavailable"))).toBe(true);

      const box = doc.querySelector('#view input[type="checkbox"]');
      box.checked = true;
      box.dispatchEvent(new win.Event("change"));
      await settle();

      click("Preview");
      await settle();
      expect(JSON.parse(recardCalls()[0][1].body)).toEqual({
        ids: [MD_CHAPTER],
        dryRun: true,
      });
    });

    /**
     * The series target, which is the one somebody reaches for after a reader
     * reports that a title's pages are wrong.
     *
     * It is a filter sweep, not an id list: a title with four hundred chapters
     * is more than one page, so it has to page like the whole-archive target
     * and not like the picker.
     */
    const pickSeriesMode = async (): Promise<void> => {
      doc.getElementById("recard-mode-series").checked = true;
      doc.getElementById("recard-mode-series").dispatchEvent(new win.Event("change"));
      await settle();
    };

    it("lists the titles with cards up, largest first", async () => {
      await goto("#/system/cards");
      await pickSeriesMode();
      // The unavailable archive specifically: the re-check panel on the same
      // tab asks the same endpoint about the uploaded one.
      expect(
        requested.some(
          (path) => path.includes("/chapters/series?") && path.includes("archive=unavailable"),
        ),
      ).toBe(true);
      const view = text();
      expect(view).toContain("Sakamoto Days");
      // The count is the reason to pick this title over another one.
      expect(view).toContain("12");
    });

    it("re-cards one title picked out of that list", async () => {
      await goto("#/system/cards");
      await pickSeriesMode();

      const pick = doc.querySelector('#view input[type="radio"][name="recard-series-pick"]');
      pick.checked = true;
      pick.dispatchEvent(new win.Event("change"));
      await settle();

      click("Preview");
      await settle();
      expect(JSON.parse(recardCalls()[0][1].body)).toEqual({
        filter: { mdMangaId: MD_MANGA },
        dryRun: true,
      });
    });

    it("takes a title id pasted in, and sweeps it to the end", async () => {
      await goto("#/system/cards");
      await pickSeriesMode();

      const field = doc.getElementById("recard-series-id");
      field.value = MD_MANGA;
      field.dispatchEvent(new win.Event("input"));
      await settle();

      click("Re-post this series' cards…");
      await settle();
      click("Queue the re-cards");
      await settle(20);

      const live = recardCalls().filter(
        ([, init]: [string, { body: string }]) => JSON.parse(init.body).dryRun === false,
      );
      // Same two-page continuation as the whole-archive sweep: a series is a
      // filter, so stopping at the first page would leave the title half done.
      expect(live).toHaveLength(2);
      expect(JSON.parse(live[0][1].body)).toEqual({
        filter: { mdMangaId: MD_MANGA },
        dryRun: false,
        confirm: true,
      });
      expect(JSON.parse(live[1][1].body).afterId).toBe("row-4");
    });

    it("carries the extension filter into the series sweep it was chosen under", async () => {
      await goto("#/system/cards");
      await pickSeriesMode();

      const picker = doc.getElementById("recard-extension");
      picker.value = "mangaplus";
      picker.dispatchEvent(new win.Event("change"));
      await settle();

      const field = doc.getElementById("recard-series-id");
      field.value = MD_MANGA;
      field.dispatchEvent(new win.Event("input"));
      await settle();

      click("Preview");
      await settle();
      expect(JSON.parse(recardCalls()[0][1].body)).toEqual({
        filter: { extension: "mangaplus", mdMangaId: MD_MANGA },
        dryRun: true,
      });
    });
  });

  /**
   * The re-check panel, which shares the tab with the re-card one.
   *
   * It is the question before a card exists: a run only visits series that
   * published something, so a quiet series can lose its back catalogue with
   * nothing noticing. The property worth holding is that the panel never starts
   * a run without an explicit confirmation, and never starts one at all from
   * the preview button.
   */
  describe("re-checking a series at the publisher", () => {
    const click = (label: string): void => {
      const button = [...doc.querySelectorAll("button")].find(
        (b: { textContent: string }) => b.textContent === label,
      );
      expect(button, `no button labelled ${label}`).toBeTruthy();
      button.click();
    };

    const recheckCalls = () =>
      win.fetch.mock.calls.filter(([url]: [string]) => String(url).includes("/recheck"));

    const pickSeries = async (): Promise<void> => {
      const pick = doc.querySelector('#view input[type="radio"][name="recheck-series-pick"]');
      expect(pick, "no series to pick").toBeTruthy();
      pick.checked = true;
      pick.dispatchEvent(new win.Event("change"));
      await settle();
    };

    it("lists published series, not just the ones with cards up", async () => {
      await goto("#/system/cards");
      expect(text()).toContain("Re-check a series at the publisher");
      // The uploaded archive: a series worth re-checking need not have anything
      // marked unavailable yet.
      expect(
        requested.some(
          (path) => path.includes("/chapters/series?") && path.includes("archive=uploaded"),
        ),
      ).toBe(true);
    });

    it("reports what a re-check would cover without starting one", async () => {
      await goto("#/system/cards");
      await pickSeries();

      click("What would this cover?");
      await settle();

      const [url, init] = recheckCalls()[0];
      expect(String(url)).toContain(`/chapters/series/${MD_MANGA}/recheck`);
      // A preview names the extension to ask and starts nothing.
      expect(JSON.parse(init.body)).toEqual({ extension: "mangaplus", dryRun: true });
      const view = text();
      expect(view).toContain("mangaplus");
      expect(view).toContain("38");
      expect(view).toContain("Nothing has been started");
    });

    it("starts the run only after the confirmation", async () => {
      await goto("#/system/cards");
      await pickSeries();

      click("Start the re-check…");
      await settle();
      // Still nothing sent: the dialog stands between the click and the run.
      expect(recheckCalls()).toHaveLength(0);

      click("Start the re-check");
      await settle(20);

      const live = recheckCalls().filter(
        ([, init]: [string, { body: string }]) => JSON.parse(init.body).dryRun === false,
      );
      expect(live).toHaveLength(1);
      expect(JSON.parse(live[0][1].body)).toEqual({
        extension: "mangaplus",
        dryRun: false,
        confirm: true,
      });
      expect(text()).toContain("run-recheck-1");
    });
  });
});
