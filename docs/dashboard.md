# The operator dashboard

Date: 2026-07-30
Audience: anyone who has to drive publoader without a shell on the host.

The dashboard is served by `core-api` itself, at `https://publoader.ardax.dev/`
(and `/dash`). It is the same admin API the CLI and the Discord bot use, with a
login screen in front of it — there is no second backend, no separate
deployment, and no CORS surface. Every button maps to one documented endpoint;
anything the dashboard can do, `padmin` can do, and vice versa.

The design goal is **self-sufficiency**: an operator should be able to answer
"what is broken and why" and then fix it, without `docker exec`. Where that is
not true, it is listed explicitly at the bottom of this page.

---

## Signing in

Three methods, in the order you should prefer them:

| Method | For | Notes |
|---|---|---|
| Email + password | Day-to-day | Minimum 12 characters. An OWNER sets it from **Users → Accounts**, and anyone signed in can change their own from **the profile menu → Your account**. There is no self-service reset for a password you cannot sign in with. |
| MangaDex | Signing in as the MangaDex account you already upload with | A form, not a redirect — see the caveat below. Only accounts an OWNER invited by MangaDex username, or members of a group in `MANGADEX_ALLOWED_GROUP_IDS`, are admitted. New accounts land unapproved. |
| Admin token | Break-glass | The `ADMIN_TOKEN`, exchanged for a session cookie. Use it when the accounts table is the problem. It is never stored in the browser. |

### Why MangaDex login is a form and not a button

MangaDex documents two OAuth client types and has shipped one. Public clients —
the `authorization_code` flow, the redirect out to `auth.mangadex.org` and back,
the thing that would make this a one-click "Sign in with MangaDex" button — are
[not yet available](https://api.mangadex.org/docs/02-authentication/). What
exists is the *personal* client: a `password` grant, and "[only the account that
owns a personal client can be used with
it](https://api.mangadex.org/docs/02-authentication/personal-clients/)."

Two consequences you have to live with until that changes:

- **Your MangaDex password is posted to core-api.** It is forwarded to MangaDex
  to obtain a token, and is never stored, never logged, and not held after the
  request. There is no grant that avoids this today.
- **Every operator needs their own personal API client.** One client cannot
  authenticate the team. Each person creates one under **Settings → API
  Clients** on mangadex.org, waits for staff approval, and enters the id and
  secret once at their first login — it is stored encrypted (AES-256-GCM, keyed
  off `SESSION_SECRET`) and reused after that. The single exception is the
  account that owns the deployment's own `MANGADEX_CLIENT_ID`, which reuses it.

Rotating `SESSION_SECRET` (or `ADMIN_TOKEN`, when `SESSION_SECRET` is unset)
makes stored client secrets unreadable. That is not a failure: the next login
asks for the secret again.

### Who is allowed in

The gate fails closed, in this order:

1. **A bound MangaDex account UUID** is the operator. A rename on MangaDex's
   side follows the account rather than losing it.
2. **An unclaimed invite for that username** binds on first login. An OWNER
   creates it from **Users → Accounts** by naming the MangaDex username. A row
   already bound to a *different* UUID is refused — releasing a username on
   MangaDex must not hand over the account that used to hold it.
3. **Otherwise, self-signup**, and only when `MANGADEX_ALLOWED_GROUP_IDS` names
   a scanlation group the account belongs to *and* the signup toggle is on. It
   still lands unapproved. With no group configured there is nothing to verify
   against, so signups are refused however the toggle is set.

The group check applies to established accounts too, not just signups: someone
who leaves the group stops being able to sign in.

The session is an HttpOnly, `SameSite=Strict` cookie backed by a revocable row,
so signing someone out actually ends their access rather than asking their
browser to forget. Sessions expire after `SESSION_TTL_MINUTES`; an OWNER can
revoke any live one from the Users view.

Login is rate limited to 5 attempts per minute per IP, and every rejected
attempt is audited (`session.login.rejected`).

---

## Roles

Three roles. They differ in *authority*, and the dashboard renders accordingly.

| | OWNER | ADMIN | CONTRIBUTOR |
|---|---|---|---|
| Runs, jobs, queues, workers | yes | yes | — |
| Extensions, schedules, bundles | yes | yes | read-only catalogue |
| Pause / resume, settings | yes | yes | — |
| Series map: add a new mapping | yes | yes | yes |
| Series map: repoint or remove an existing mapping | yes | yes | — |
| Untracked queue: approve / skip | yes | yes | yes |
| Audit log | yes | yes | — |
| Accounts, sessions, client tokens | yes | — | — |
| Database backup | yes | — | — |

**CONTRIBUTOR is the role to hand a community volunteer.** It exists so the
tedious, valuable job — mapping external series ids to MangaDex titles and
working the untracked queue — can be delegated without also delegating the
ability to trigger runs, read the audit log, or change where existing uploads
go. A contributor can *add* facts to the series map; they cannot *change* one,
because repointing a mapping silently redirects a series' uploads to a
different MangaDex title, and removing one silently stops them.

**ADMIN is full operational authority minus account administration.** An admin
runs the platform but cannot grant access to it: no inviting, no promoting, no
setting anyone else's password, no minting client tokens, no reading the
accounts list. That is the only privilege boundary between operators, and it is
enforced per endpoint, not by hiding buttons.

Roles are enforced server-side on every request. The UI hiding a section is a
convenience so nobody clicks into a wall of 403s — never the control itself.

---

## Navigation

Three levels, and each one is in the URL.

**A persistent left sidebar** is the main menu. Destinations are grouped by what
you are doing rather than by which endpoint serves them:

| Group | Destinations |
|---|---|
| — | Overview |
| **Work** | Runs, Queues, Activity, Errors |
| **Catalogue** | Extensions, Tracked, Untracked |
| **Fleet** | Workers |
| **Admin** | Users, Tokens, Audit, System, Maintenance, Docs |

Each entry declares the scope its view needs and is simply absent without it —
a contributor's sidebar is Overview, Extensions, Tracked, Untracked and Docs. The
current entry carries `aria-current="page"` and is marked three ways (fill,
brighter text, a left rule), because "which page am I on" should not require
reading. The sidebar collapses to icons with the button at its foot, and
remembers that in `localStorage`. Below 860px it becomes a drawer: a hamburger in
the header opens it, a tap outside or Escape closes it, and while closed it is
`inert` so Tab cannot walk into it.

**Tabs inside a page** are that page's own sections — Overview's Platform and
MangaDex, System's Schema / MangaDex / Backup, one extension's Overview / Series
map / Schedule / Config / Versions. They are a tablist: arrow keys, Home and End
move between them.

**A header** carries the platform's live state on the left — paused or running,
active/total workers, jobs in flight, uploads queued, and the last run with how
long ago it was — polled from `GET /admin/stats` every ten seconds and **only
while the browser tab is visible**, so a dashboard left open overnight is not the
busiest client the API has. On the right is the signed-in actor with a role
badge; its menu holds "Your account" (which credential this is, what it may do,
and setting your own password) and Sign out.

### The URL is the view

Routing is hash-based, `#/<destination>[/<thing>][/<tab>]`:

```
#/overview/platform                      the default landing view
#/runs/dead-letter                       a tab within a destination
#/runs/<runId>                           one run and all its segments
#/extensions/mangaplus/series-map        one extension, one of its tabs
#/untracked/<id>                         one untracked series, editable
#/audit/<id>                             one audit event
#/system/backup
```

Every link is a real `<a href>`, so middle-click, "copy link address" and the
back button all behave. A pasted link restores the sidebar selection **and** the
active tab. Links minted by older versions (`#run/<id>`, `#audit/<id>`,
`#tab/queues`) are translated rather than broken. A link into a destination the
signed-in account cannot open says so in a toast and lands on the first one it
can, instead of rendering a view that 403s.

A fragment is never sent to the server, so pasting a permalink into chat cannot
leak an id into an access log.

---

## The views

| View | Needs | Answers |
|---|---|---|
| **Overview** | `stats:read` | *Platform*: paused or running, with pause-for-N-minutes / pause indefinitely / resume; jobs by state, workers by status, upload tasks, and the quarantine count. *MangaDex*: the upload side's saved session and its expiry, with "clear saved session". The first screen in an incident. |
| **Runs** | `runs:read` | *Recent*: the last 50 runs, each linking to its own page — every segment with attempts, lease holder, lease expiry and last error, plus per-job cancel and retry. *Dead letter*: jobs that exhausted their attempt budget, with replay. |
| **Queues** | `runs:read` | *Tasks*: the MangaDex upload queues filtered by kind and state, with retry, cancel, and "requeue stale leases" (which only touches leases that have already expired). *Depth*: the same queues counted by kind and state. |
| **Activity** | `runs:read` | One time-ordered feed merged across runs, jobs, upload tasks, quarantine and the audit log, filtered by severity, time window, extension and free text. Every row links to the thing it is about and offers a permalink. |
| **Errors** | `runs:read` | *Failures*: everything that failed, newest first, across all three sources. *Quarantine*: result envelopes the core refused to believe — the security-relevant queue, not just an error queue. A non-zero quarantine count also shows as a red badge on Errors in the sidebar. |
| **Extensions** | `extensions:read` | The published-bundle list, the chapter removal mode, and the publish drop zone. Opening one gives *Overview* (its bundle, its curation counts, and its runs, jobs, upload tasks and quarantine on one screen — the join is the point: green runs beside red upload tasks is the diagnosis), *Series map*, *Schedule*, *Config*, and *Versions* (every version ever published, with yank). |
| **Tracked** | `tracked:read` | The series map across every extension: how many mappings each has and the most recent one, linking into the map that can be edited. There is no cross-extension endpoint, so this is an index rather than a merged table. |
| **Untracked** | `untracked:read` | Series an extension reported that have no mapping yet, filtered by state. Opening one gives its details **editable** — see below. Approve creates the MangaDex title; skip never does. |
| **Workers** | `workers:read` | *Fleet*: status, trust tier, heartbeat, agent version, which extensions each worker takes, with drain / activate / revoke. *Enrolment*: mint a one-time token and copy the compose snippet that uses it. |
| **Users** | OWNER | *Accounts*: invite, approve, change role, set a password, delete. *Sessions*: who is signed in, with revoke. *Signups*: the self-signup gate. |
| **Tokens** | OWNER | *Issued*: every `pa_…` client credential with its scopes, creator, last use and expiry, with revoke. *Mint*: scopes grouped by area, with the shipped presets. |
| **Audit** | `audit:read` | Who did what, searchable by actor, action, subject, free text and date range — and one event at a time by id. |
| **System** | `settings:read` | *Schema*: is this database the schema this build expects. *MangaDex*: the saved session. *Backup*: a `pg_dump` download (OWNER only). |
| **Maintenance** | `bundles:read` | Compare each live bundle against its GitHub branch, install a bundle, restart a service. Lives in `dashboard/sysops.js`. |
| **Docs** | `stats:read` | The operator handbook that ships with this build, rendered in the page. Lives in `dashboard/docs.js`. |

Runbooks for the triage-shaped ones — stuck upload tasks, a bad MangaDex
session, issuing and rotating client tokens — are in
[operations.md](operations.md).

---

## Curating the series map

An extension reports chapters against *its own* manga ids. The series map
(`tracked_manga`) is what turns those into MangaDex titles, and it is the one
table where a wrong row means uploading to the wrong series. It lives under
**Extensions → (an extension) → Open**.

The table is searchable (external id, MangaDex id, or source) and paged 50 rows
at a time, so an extension with a few thousand mappings is still navigable.

Four ways to edit it:

1. **One row at a time.** Add or repoint a single mapping.
2. **Paste a list.** Lines of `externalId,mangadexTitleId`. Whitespace, tabs,
   semicolons and pipes all work as separators; `#` starts a comment; a header
   row is skipped; and the two columns may be in either order, because the
   parser identifies the MangaDex id by its UUID shape. Every line is judged
   and reported individually — pasting 200 lines and being told which three
   were wrong is the point. At most 2000 rows per batch.
3. **Remove**, one row or in bulk. Requires `tracked:write`.
4. **Export.** Downloads every mapping in exactly the format the paste box
   accepts. That closes the loop: export, edit in whatever you like, paste back,
   preview, apply — no file in git and no shell on the host at any point.

Per-row outcomes:

| Outcome | Meaning |
|---|---|
| `added` | New mapping created. |
| `updated` | Existing mapping repointed — the response says what it was before. |
| `unchanged` | Already mapped to exactly that title. |
| `removed` | Mapping deleted. |
| `rejected_needs_write` | The row would change or remove an existing mapping and the caller only holds `tracked:append`. |
| `not_found` | Asked to remove a mapping that does not exist. |
| `invalid` | Not a MangaDex id, or the same external id listed twice with different targets (the last one is used, and the duplicate is flagged). |

**Preview before you commit.** The dashboard never applies a paste directly: it
runs a dry run first, shows the per-row verdict, and only then offers an Apply
button labelled with the counts. `dryRun` reports what the batch would do and
writes nothing:

```bash
curl -sX POST "$API/api/v1/admin/extensions/mangaplus/tracked/batch" \
  -H "authorization: Bearer $PUBLOADER_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"dryRun": true, "text": "12345,4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb"}'
```

The preview covers **additions, repoints and removals** — every row is judged
exactly as the real batch would judge it, and the write transaction is skipped
entirely. Both dashboard modes go through it, so there is no second
implementation of the rules to drift out of step.

Worth knowing what this replaced, because the old shape is a trap worth
recognising if you see it elsewhere: the dry run used to apply the batch for real
and then delete the rows it had inserted. That undid the additions and left every
*repoint* in place — so previewing a paste could silently redirect a series'
uploads to a different MangaDex title, and the uncommitted mappings were briefly
visible to the scheduler. A preview that writes is not a preview.

A preview leaves no audit entry, because nothing happened. A real batch leaves
one (`tracked_manga.batch`) with the counts.

---

## Publishing a bundle

**Extensions → Publish an extension bundle.** Drop a `.zip`, choose one, or
choose the extension *directory* — the browser zips it for you, stripping the
directory's own name so `manifest.json` lands at the archive root. That last
part matters because zipping the folder instead of its contents is the single
most common publish mistake, and it used to surface as "bundle missing
manifest.json".

Nothing is published on drop. The archive goes to
`POST /api/v1/admin/bundles/inspect` first, which parses the manifest and
answers with either the reasons it cannot be published — one line per bad
field — or the facts you need before authorising it:

- name, version, runtime, entrypoint, languages, allowed hosts, group id;
- what is currently published, and whether this replaces the same version.

Only then does a **Publish** button appear. This is deliberate friction: a
publish is a code-execution change on every worker that runs the extension, so
the operator should be reading the parsed manifest before they confirm rather
than a 422 afterwards.

The preflight is advisory. `POST /api/v1/admin/bundles` re-validates everything
and remains the decision of record, so a preflight that drifts can only ever be
less helpful — never permissive.

---

## The Activity feed, and what it is not

**Activity** merges five tables into one timeline: runs, jobs (including the
last error of a job that is still retrying), upload tasks, result submissions,
and audit events. Filter by severity, time window, extension, or free text over
the subject and message.

Be precise about what this replaces. **It covers application-level events — every
row in it is a durable database row.** That is why it can be filtered, linked
to, and read back months later, and it is why triage now starts in a browser
instead of in a terminal.

**Container stdout is not here and cannot be.** A stack trace from a crash loop,
a Prisma engine that failed to load, anything a process emitted before it could
reach the database — none of that is written to Postgres, so no endpoint can
serve it. That still lives in `docker logs` on the host:

```bash
docker compose logs -f --tail=200 core-uploader
```

The intended workflow is to start in Activity, find the run, job or task id, and
then reach for `docker logs` only if the row does not already explain itself.
Most of the time it does — the point of the feed is that `lastError` and
`rejectReason` are already in front of you.

Each row carries a **permalink** (`Copy link`) of the form
`https://…/dash#/runs/<id>`. Opening one selects the right destination and the
right row; a link into a destination the recipient's role cannot open says so
instead of failing with a 403.

Audit events are included only for a principal holding `audit:read`. When they
are withheld the feed says so in a banner rather than quietly returning a
shorter list, because "the platform has been quiet" and "you cannot see half of
this" must not look alike.

---

## Opening one audit event

Copy the link on an audit row and it opens `#/audit/<id>`: a detail view with the
actor, the action, the subject, the timestamp (absolute and relative), and the
event's `detail` JSON pretty-printed, plus one-click "everything by this actor"
and "everything with this action", and a download of the event as JSON.

That detail matters because the `detail` column is the only place the *arguments*
of an audited action are recorded. "Who changed the removal mode, and to what"
is answerable nowhere else.

This used to be broken, and the shape of the bug is worth keeping written down.
The permalink set a client-side filter and searched the most recent page in the
browser, and `GET /admin/audit` accepted only `limit` — so an event that had
since been pushed off that page could never be found, and the id was not a
searchable field at all. A copied link reliably answered "no matching events" as
the log grew. `GET /admin/audit` now takes filters:

| Parameter | Meaning |
|---|---|
| `id` | Exactly one event, by primary key. This is what a permalink uses. |
| `actor`, `action`, `subject` | Case-insensitive substring, so partial names work. |
| `since`, `until` | ISO instants, inclusive on both ends. |
| `limit` | Capped at 500, default 100. |
| `offset` | For a "page 4 of 40" control. |
| `cursor` | The id of the last row of the previous page. Stable while events are still being written, which offset is not; an unknown cursor is a 400, because an empty page would read as "there is nothing older". |

The response adds `total` (so paging can be honest about how much there is) and
`nextCursor` (null on the last page, so a caller stops without an extra empty
request). Ordering is on `(createdAt, id)` rather than `createdAt` alone, so two
events recorded in the same millisecond cannot swap places between pages. Every
filter is served by an index that already exists — `id` is the primary key,
`createdAt` and `action` each carry one — and the substring filters could not use
an index whatever we added, which is why they stay bounded by `limit` and the
time window.

The free-text search on the Audit list still goes to `GET /admin/audit/search`,
because that one reaches into the serialised `detail`, which the filters above
deliberately do not.

---

## Correcting an untracked series

The scrapers guess a title from a source page, and they guess wrong often enough
that approving without a chance to correct it is how a bad title ends up public
on MangaDex. So `#/untracked/<id>` shows the row with **Title**, **Original
language** and **Source URL** editable:

- **Save local row** (`untracked:write`) corrects the local row only, and says
  so. Validation happens in the browser first — a title is required, the language
  must look like `en`, `pt-br` or `zh-hk`, the URL must be complete and http(s) —
  so a typo never becomes a request, and each field says what is wrong. The
  server validates again, including that the URL's host is in the extension's
  `allowed_hosts`; a refusal is shown with the server's own reason and the
  optimistic edit is rolled back.
- **Apply to MangaDex** pushes the title and links to an already-created title.
  It is owner/admin-level, and it is behind a confirmation that says out loud
  that this edits the live entry *for everyone*, lists exactly what will change,
  and notes that MangaDex keeps its own edit history and this cannot be undone
  from here.
- A **CONTRIBUTOR** can do the first and not the second. The button is disabled
  rather than hidden, and the reason is written both in its tooltip and in the
  page: pushing to the public entry is limited to owners and admins, and a
  contributor should correct the local row and ask an operator to apply it. A
  disabled control that explains itself tells them the operation exists and who
  to ask; an absent one reads as a missing feature.
- The button is also disabled, with a different reason, when there is no MangaDex
  title yet — approve the series first.

The order this is designed around is: **fix the details, then approve.** A row
whose title already exists shows a banner saying local edits do not reach
MangaDex until they are applied.

---

## How the UI decides what to show

On sign-in the dashboard calls `GET /api/v1/admin/whoami`, which returns the
principal's kind, role and **scope set**. Every section declares the scope it
needs, so the tab strip is built from what the server has already said it will
allow. A contributor does not see a Workers tab that would 403.

Two consequences worth knowing:

- If a call is refused anyway, the error names the missing scope
  (`missing scope: runs:write`) and the dashboard raises a toast saying so.
  Guessing which permission you lack is never necessary.
- `whoami` discloses nothing secret: no token, no session id, no password
  state. It answers "what may this credential do", which the caller already
  knows implicitly.

### Reactivity

There is one client-side store with subscribe/notify, and every fetched thing is
a resource with four states the page can actually show: loading, ready, empty,
failed. Consequences you will notice:

- **A mutation updates every affected view.** Pausing the platform from Overview
  moves the header pill and the Overview banner together, with no reload.
- **A poll over data already on screen dims it rather than replacing it with a
  skeleton**, so nothing flashes every ten seconds.
- **Small edits are optimistic and roll back.** Approving an account, draining a
  worker or removing a mapping moves immediately and comes back if the server
  refuses — which it does, for instance, when a contributor tries to remove a
  mapping that needs `tracked:write`.
- **Space is reserved before data arrives**, so the page does not jump under
  your pointer.
- **A failed load names the reason and offers "Try again"** in place of that one
  panel; it never empties the page.
- **Every list has an empty state that says what would put something in it**,
  rather than showing a blank table.

### Responsiveness

Usable down to a phone. The sidebar becomes a drawer; below 620px tables restack
as cards, with each cell labelled from its column header. A wide table always
scrolls inside its own container — the page body never scrolls sideways at any
width. Touch targets are at least 40px once there is no pointer to be precise
with.

### Files

`dashboard/app.js` is one classic script with no build step: the shell, the
store, the router and most views. It is deliberately not a module, because jsdom
cannot execute module scripts and being able to drive this page headlessly is
worth more than the file count. `dashboard/sysops.js`, `dashboard/docs.js` and
`dashboard/markdown.js` **are** ES modules, loaded on demand with `import()` when
their destination is first opened; the shell hands them its own `el`, `api`,
`card`, `row`, `table`, `toast` and `can` so they look like the rest of the page.
Anything with a supported extension in `src/core/api/dashboard/` is served, so a
new module needs no server change.

---

## Security contract

The dashboard is the only browser-facing surface, so it is deliberately boring:

- **No inline scripts or styles.** Served under `default-src 'self'` with no
  `'unsafe-inline'`, `frame-ancestors 'none'`, and `X-Frame-Options: DENY`.
- **No `innerHTML`, anywhere.** Every operator-supplied string — extension
  names, worker names, error text — is written with `textContent`, which is what
  keeps a chapter title from becoming script. There is a test asserting the
  served `app.js` contains no `innerHTML` sink and no inline handler.
- **Cookie-authenticated writes carry `x-requested-with: publoader-dash`.**
  `SameSite=Strict` is the first line of CSRF defence; a header no cross-origin
  form or image tag can set is the second. Bearer clients are exempt and should
  not send it.
- **`connect-src 'self'`.** Even a tampered asset cannot exfiltrate what it can
  read.

See [security-trust-model.md](security-trust-model.md) §1.3a for the full
control matrix and §3a for what each credential's leak would cost.

---

## What still needs host access

Being honest about the edges, because a dashboard that *claims* to cover
everything is worse than one with a documented boundary.

| Task | Why it is not a button | Do this instead |
|---|---|---|
| **Reading container logs** | Work runs in containers, and on remote worker hosts the core cannot read. There is no log API by design; logs are structured JSON on stdout for the host's log stack. | `docker compose logs -f core-uploader`. Start from Activity or `padmin errors` to find the run/job id, then correlate. |
| **Restoring a backup, and scheduled backups** | Taking a backup *is* in the UI — **System → Database backup**, see [operations.md](operations.md). Restoring is not: it means stopping the services that would write during it, and nothing that can take the API down should be reachable through the API. Recurring backups belong in cron on the host, not in a browser tab someone has to remember to open. | The restore procedure and the scheduled `pg_dump` in [operations.md](operations.md) → "Backup and restore". |
| **Upgrading the core or a worker** | Replacing an image is the host's job; a container must not rewrite and re-exec itself (that was a legacy failure mode). | `docker compose pull && up -d` per [deployment.md](deployment.md) → "Upgrading". |
| **Rotating a secret in `.env`** | `ADMIN_TOKEN`, `SESSION_SECRET`, the MangaDex credentials and the tunnel token are environment, not database. | [operations.md](operations.md) → "Rotate secrets". Note that clearing the *saved MangaDex session* IS in the UI — that is database state, and it is the fix for a stale token pair. |
| **Applying a migration** | The runtime image has no Prisma CLI on purpose: a long-lived service must not carry a tool that can rewrite the database. | The one-shot `migrate` compose service. The System view tells you *whether* you need to — it reports pending and failed migrations. |
| **Restarting, stopping or recreating a container** | This needs the Docker socket, and `/var/run/docker.sock` is deliberately **not** mounted into any container. A process that can talk to that socket can start a privileged container and mount the host filesystem — it is root on the host, so exposing it to an internet-facing service would trade every other control on this page for a convenience. It will not be added. | `docker compose restart core-uploader` on the host. In practice you rarely need it: there is no `restart_workers` equivalent because every unit of work is a durable row, so the fix for stuck work is **Queues → Requeue stale leases** or a job replay, not a restart. |
| **Anything at all when `core-api` is down** | The dashboard *is* `core-api`. A control plane cannot repair the process serving it. | The host. Check `docker compose ps` and `docker compose logs core-api`; `/healthz` (liveness) and `/readyz` (database reachable) are the two probes worth curling first. |

Everything else — pausing, scheduling, curating the series map, triaging
queues, publishing a bundle, enrolling a worker, minting and revoking
credentials, managing accounts — is in the dashboard.

---

## Documentation map

This document is one of the set below. Start at
[architecture-guide.md](architecture-guide.md) if you are new to the platform.

| Document | One line |
| --- | --- |
| [architecture-guide.md](architecture-guide.md) | How it works: the planes, one run traced end to end, the job state machine, and why exactly-once holds |
| [development.md](development.md) | Local setup, running services from source, the Prisma workflow, the test layers, debugging a failing job |
| [api-reference.md](api-reference.md) | Every HTTP endpoint, its required scope, and its meaningful failures |
| [data-model.md](data-model.md) | Every table, column, index, and invariant |
| [extension-guide.md](extension-guide.md) | Writing an extension: the v2 contract, the manifest, the sandbox, publishing |
| [glossary.md](glossary.md) | Every load-bearing term, with the file that defines it |
| [security-trust-model.md](security-trust-model.md) | Threat model, control matrix, secrets inventory, and what a worker can and cannot do |
| [deployment.md](deployment.md) | Standing up the core and worker hosts, the tunnel and WAF, upgrades, backups |
| [operations.md](operations.md) | Day-2 runbooks: triage, worker lifecycle, secret rotation, dead letters, incidents |
| [dashboard.md](dashboard.md) | The operator dashboard: signing in, the roles, the navigation model, every view, and what still needs host access |
| [migration-guide.md](migration-guide.md) | Staged Mongo/SQLite to Postgres cutover, with a rollback at every stage |
| [ipc-to-api-mapping.md](ipc-to-api-mapping.md) | Which endpoint replaced each legacy IPC command |
| [bot.md](bot.md) | Discord bot setup, the admin-gating model, and the command reference |
| [webhooks.md](webhooks.md) | Publishing extension bundles from a GitHub push: setup, the signature check, and why CI-side publishing is preferred |
| [../README.md](../README.md) | What publoader is, and the five-minute quickstart |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Branch workflow, definition of done, and the review checklist |
