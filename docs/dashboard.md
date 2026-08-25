# The operator dashboard

Date: 2026-07-30
Audience: anyone who has to drive publoader without a shell on the host.

The dashboard is served by `core-api` itself, at `https://publoader.ardax.dev/`
(and `/dash`). It is the same admin API the CLI and the Discord bot use, with a
login screen in front of it; there is no second backend, no separate
deployment, and no CORS surface. Every button maps to one documented endpoint;
anything the dashboard can do, `padmin` can do, and vice versa.

The design goal is **self-sufficiency**: an operator should be able to answer
"what is broken and why" and then fix it, without `docker exec`. Where that is
not true, it is listed explicitly at the bottom of this page.

---

## Signing in

Four methods, in the order you should prefer them:

| Method | For | Notes |
|---|---|---|
| Email + password | Day-to-day | Minimum 12 characters. Anyone signed in sets or changes their own from **the profile menu → Your account**; an OWNER can also set one from **Users → Accounts**. There is no self-service reset for a password you cannot sign in with; use an emailed link instead. |
| Emailed sign-in link | First sign-in, and forgotten passwords | Shown when `RESEND_API_KEY` is configured. Enter your address, click **Email me a sign-in link**. The link works once, expires (15 minutes when you asked for it, 72 hours for an invite), and is retired by any newer link or by setting a password. |
| Discord | Teams already on Discord | Only shown when `DISCORD_CLIENT_ID` is configured. Can be *added* to an existing account from **Your account → Link my Discord account**, so one account signs in either way. New Discord accounts land unapproved and an OWNER must approve them; and only if self-signup is enabled. |
| Admin token | Break-glass | The `ADMIN_TOKEN`, exchanged for a session cookie. Use it when the accounts table is the problem. It is never stored in the browser. |

The session is an HttpOnly, `SameSite=Strict` cookie backed by a revocable row,
so signing someone out actually ends their access rather than asking their
browser to forget. Sessions expire after `SESSION_TTL_MINUTES`; an OWNER can
revoke any live one from the Users view.

Login is rate limited to 5 attempts per minute per IP, and every rejected
attempt is audited (`session.login.rejected`). Emailed links get their own,
tighter budget: 5 requests per IP in a burst then one every two minutes, and 3
per *address* then one every five minutes, because each one sends real mail.

### How the emailed link travels

The link is `https://<dash>/#token=<secret>`: the secret is in the URL
**fragment**, which browsers never send to a server. That keeps it out of
core-api's request log, out of any proxy's access log, and out of `Referer`
headers, and it means a mail-scanner that fetches the URL cannot burn a
single-use token before its owner clicks it. The dashboard reads the fragment,
posts it back, and strips it from the address bar.

The trade-off: a mail gateway that rewrites links and drops fragments makes the
link useless. If that is your environment, have an OWNER set passwords directly
from **Users → Accounts** instead.

### Linking Discord to an existing account

Signing in with Discord already claims an existing account when Discord's
**verified** email equals the account's. If yours differ, sign in by any method
and use **Your account → Link my Discord account**: the session is the
authorisation there, so the two addresses need not match. One Discord identity
can belong to only one operator account; unlink it from the first account
(**Your account → Unlink Discord**, or **Users → Accounts** for an OWNER)
before attaching it elsewhere.

Unlinking is refused when Discord is the only way into that account; no
password set, and no mailer configured. Removing the last credential is
deletion with extra steps, and deletion has its own button.

### Invites

**Users → Invite** creates an approved account and emails it a sign-in link in
one action. The invitee sets their own password once they are in; until they
do, another emailed link is their only way back. If the mail fails, the account
is still created and the dashboard says so; use **Email sign-in link** on that
row to try again.

---

## Roles

Three roles. They differ in *authority*, and the dashboard renders accordingly.

| | OWNER | ADMIN | CONTRIBUTOR |
|---|---|---|---|
| Runs, jobs, queues, workers | yes | yes |; |
| Extensions, schedules, bundles | yes | yes | read-only catalogue |
| Pause / resume, settings | yes | yes |; |
| Series map: add a new mapping | yes | yes | yes |
| Series map: repoint or remove an existing mapping | yes | yes |; |
| Untracked queue: approve / skip | yes | yes | yes |
| Audit log | yes | yes |; |
| Accounts, sessions, client tokens | yes |; |; |
| Database backup | yes |; |; |

**CONTRIBUTOR is the role to hand a community volunteer.** It exists so the
tedious, valuable job, mapping external series ids to MangaDex titles and
working the untracked queue, can be delegated without also delegating the
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
convenience so nobody clicks into a wall of 403s; never the control itself.

### Tuning what a role means

The table above is the **shipped default**, not a fixed law. **Admin →
Permissions** redefines what `ADMIN` and `CONTRIBUTOR` may do here: tick the
scopes, save, and every account in that role holds exactly those. **Reset to
shipped default** puts a role back on the default and back to tracking it as
future releases change it.

`OWNER` is not editable. It holds the wildcard — including scopes that do not
exist yet — and it is the role that edits permissions at all, so leaving it
narrowable would let one mistake lock the deployment out of its own control
plane. The break-glass `ADMIN_TOKEN` is the only thing behind it.

### Tuning one account

**Users → Permissions** on an account row grants scopes on top of its role and
denies scopes despite it. This is for the case a role cannot express: "an ADMIN,
except they must not publish bundles" should not require inventing a fourth
role for one person.

Denials are applied last and win. They also close upward — denying `runs:read`
denies `runs:write` too, since a write would imply the read straight back —
while denying a write leaves the read alone, which is how you get "watch but do
not touch". The dialog previews the effective set as you tick.

An account that is not simply its role is marked **tuned** in the accounts
table, so the person whose access nobody remembers granting is visible at a
glance. Owners cannot be tuned: they hold everything regardless, and promoting
an account to `OWNER` clears its tuning rather than parking it.

Both kinds of change reach sessions that are **already open**, within a few
seconds. Nobody has to sign out and back in.

---

## Navigation

Three levels, and each one is in the URL.

**A persistent left sidebar** is the main menu. Destinations are grouped by what
you are doing rather than by which endpoint serves them:

| Group | Destinations |
|---|---|
|; | Overview |
| **Work** | Runs, Queues, Activity, Errors |
| **Catalogue** | Extensions, Chapters, Tracked, Untracked |
| **Fleet** | Workers |
| **Admin** | Users, Tokens, Permissions, Audit, System, Maintenance, Docs |

Each entry declares the scope its view needs and is simply absent without it;
a contributor's sidebar is Overview, Extensions, Tracked, Untracked and Docs. The
current entry carries `aria-current="page"` and is marked three ways (fill,
brighter text, a left rule), because "which page am I on" should not require
reading. The sidebar collapses to icons with the button at its foot, and
remembers that in `localStorage`. Below 860px it becomes a drawer: a hamburger in
the header opens it, a tap outside or Escape closes it, and while closed it is
`inert` so Tab cannot walk into it.

**Tabs inside a page** are that page's own sections; Overview's Platform and
MangaDex, System's Schema / MangaDex / Unavailable cards / Backup, one extension's
Overview / Series
map / Schedule / Config / Versions. They are a tablist: arrow keys, Home and End
move between them.

**A header** carries the platform's live state on the left; paused or running,
active/total workers, jobs in flight, uploads queued, and the last run with how
long ago it was; polled from `GET /admin/stats` every ten seconds and **only
while the browser tab is visible**, so a dashboard left open overnight is not the
busiest client the API has. On the right is the signed-in actor with a role
badge; its menu holds "Your account" (which credential this is, what it may do,
and setting your own password) and Sign out.

### The URL is the view

Routing is hash-based, `#/<destination>[/<thing>][/<tab>]`:

```
#/overview/platform                      the default landing view
#/runs/dead-letter                       a tab within a destination
#/runs/<runId>                           one run, its segments, and what it found
#/queues/chapters                        what is about to be uploaded, in order
#/chapters                               every chapter we have put on MangaDex
#/chapters/<mdChapterId>                 one chapter, its history, its edit form
#/extensions/mangaplus/series-map        one extension, one of its tabs
#/untracked/<id>                         one untracked series, editable
#/audit/<id>                             one audit event
#/system/cards                            re-post the card image on unavailable chapters
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
| **Overview** | `stats:read` | *Platform*: paused or running, with pause-for-N-minutes / pause indefinitely / resume; jobs and upload tasks as work **outstanding** (the states that still owe something, worst first, with settled and completed totals folded behind a disclosure), plus workers by status and the quarantine count. *MangaDex*: the upload side's saved session and its expiry, with "clear saved session". The first screen in an incident. |
| **Runs** | `runs:read` | *Recent*: the last 50 runs with how many chapters each found, linking to its own page; every segment with attempts, lease holder, lease expiry and last error, plus per-job cancel and retry, and **the chapters that run actually reported**: coverage per segment, a breakdown per series, and the chapter list itself, searchable. *Dead letter*: jobs that exhausted their attempt budget, with replay. |
| **Queues** | `runs:read` | *Chapters* (the default): what is about to be sent to MangaDex, **numbered in the order the uploader will claim it**, series, number, volume, title, language, and for an EDIT the fields it will change. Correct one or move it to the front from here. *Tasks*: the same rows keyed on queue mechanics, dedupe key, attempts, last error, with retry, remove, purge, reorder and hand-enqueue; each row still names its chapter and links the series and chapter on MangaDex, so the incident view is readable too. Both tabs filter by the queued chapter (series/title/number/either MangaDex id, extension, language), which is the only way to find an `EDIT` or `UNAVAILABLE` row, its dedupe key is a bare MangaDex UUID. *Depth*: what the queues still owe, counted by kind and state and ordered worst first; each tile opens the rows behind it in *Tasks*, and the completed totals sit behind a disclosure rather than burying the handful that need an operator. |
| **Activity** | `runs:read` | One time-ordered feed merged across runs, jobs, upload tasks, quarantine and the audit log, filtered by severity, time window, extension and free text. Every row links to the thing it is about and offers a permalink. |
| **Errors** | `runs:read` (clearing needs `runs:write`) | *Failures*: everything that failed, newest first, across all three sources, with a **Clear** on each row for when it has been read and dealt with, so the list stays a to-do list instead of a wall. Clearing hides the entry and nothing else: the row keeps its state, Activity still shows the failure, *Show → cleared* reviews what was acknowledged and by whom (with the optional note), **Restore** undoes it, and anything that fails *again* comes back by itself. *Quarantine*: result envelopes the core refused to believe; the security-relevant queue, not just an error queue. The count of failures nobody has cleared shows as a red badge on Errors in the sidebar. |
| **Extensions** | `extensions:read` | The published-bundle list, the chapter removal mode, and the publish drop zone. Opening one gives *Overview* (its bundle, its curation counts, and its runs, jobs, upload tasks and quarantine on one screen; the join is the point: green runs beside red upload tasks is the diagnosis), *Series map*, *Schedule* (the extension's slots, several times a day and each with its own weekdays and run kind, plus **Add slot**, per-slot switch-off and remove, and **Reset to manifest**), *Config*, and *Versions* (every version ever published, with yank). |
| **Chapters** | `chapters:read` | Every chapter this platform has published, in four archives, *On MangaDex*, *Unavailable*, *Deleted*, *Edited*, filtered by extension, language, chapter number and a search that matches the series name, the chapter title and any of the four ids. Opening one shows our row beside what MangaDex says right now, anything already queued against it, and its edit history, with the three actions: edit the metadata, replace it with an unavailable card (previewed first), or delete it. The same three run in bulk over ticked rows or over the whole filter. See below. |
| **Tracked** | `tracked:read` | The series map across every extension: how many mappings each has and the most recent one, linking into the map that can be edited. There is no cross-extension endpoint, so this is an index rather than a merged table. |
| **Untracked** | `untracked:read` | Series an extension reported that have no mapping yet, filtered by state. Opening one gives its details **editable**: see below. Approve creates the MangaDex title; skip never does. |
| **Workers** | `workers:read` | *Fleet*: status, trust tier, heartbeat, agent version, which extensions each worker takes, with drain / activate / revoke. *Enrolment*: mint a one-time token and copy the compose snippet that uses it. |
| **Users** | OWNER | *Accounts*: invite, approve, change role, set a password, delete. *Sessions*: who is signed in, with revoke. *Signups*: the self-signup gate. |
| **Tokens** | OWNER | *Issued*: every `pa_…` client credential with its scopes, creator, last use and expiry, with revoke. *Mint*: scopes grouped by area, with the shipped presets. |
| **Audit** | `audit:read` | Who did what, searchable by actor, action, subject, free text and date range; and one event at a time by id. |
| **System** | `settings:read` (acting needs `chapters:write` + ADMIN) | *Schema*: is this database the schema this build expects. *MangaDex*: the saved session. *Unavailable cards*: two halves of one job. *Re-check a series at the publisher* asks an extension for its current listing of one title and queues whatever MangaDex still holds that it no longer lists — the only way to ask, since runs only visit series that reported an update. *Re-post unavailable card images* re-renders the card on chapters already marked unavailable — every one of them, one series, a set ticked out of the archive, or a single chapter id, previewed first. *Backup*: a `pg_dump` download (OWNER only). |
| **Maintenance** | `bundles:read` | Compare each live bundle against its GitHub branch, install a bundle, restart a service. Lives in `dashboard/sysops.js`. |
| **Docs** | `stats:read` | The operator handbook that ships with this build, rendered in the page. Lives in `dashboard/docs.js`. |

Runbooks for the triage-shaped ones, stuck upload tasks, a bad MangaDex
session, issuing and rotating client tokens, are in
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
   and reported individually; pasting 200 lines and being told which three
   were wrong is the point. At most 2000 rows per batch.
3. **Remove**, one row or in bulk. Requires `tracked:write`.
4. **Export.** Downloads every mapping in exactly the format the paste box
   accepts. That closes the loop: export, edit in whatever you like, paste back,
   preview, apply; no file in git and no shell on the host at any point.

Per-row outcomes:

| Outcome | Meaning |
|---|---|
| `added` | New mapping created. |
| `updated` | Existing mapping repointed; the response says what it was before. |
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

The preview covers **additions, repoints and removals**: every row is judged
exactly as the real batch would judge it, and the write transaction is skipped
entirely. Both dashboard modes go through it, so there is no second
implementation of the rules to drift out of step.

Worth knowing what this replaced, because the old shape is a trap worth
recognising if you see it elsewhere: the dry run used to apply the batch for real
and then delete the rows it had inserted. That undid the additions and left every
*repoint* in place; so previewing a paste could silently redirect a series'
uploads to a different MangaDex title, and the uncommitted mappings were briefly
visible to the scheduler. A preview that writes is not a preview.

A preview leaves no audit entry, because nothing happened. A real batch leaves
one (`tracked_manga.batch`) with the counts.

---

## Publishing a bundle

**Extensions → Publish an extension bundle.** Drop a `.zip`, choose one, or
choose the extension *directory*; the browser zips it for you, stripping the
directory's own name so `manifest.json` lands at the archive root. That last
part matters because zipping the folder instead of its contents is the single
most common publish mistake, and it used to surface as "bundle missing
manifest.json".

Nothing is published on drop. The archive goes to
`POST /api/v1/admin/bundles/inspect` first, which parses the manifest and
answers with either the reasons it cannot be published, one line per bad
field, or the facts you need before authorising it:

- name, version, runtime, entrypoint, languages, allowed hosts, group id;
- what is currently published, and whether this replaces the same version.

Only then does a **Publish** button appear. This is deliberate friction: a
publish is a code-execution change on every worker that runs the extension, so
the operator should be reading the parsed manifest before they confirm rather
than a 422 afterwards.

The preflight is advisory. `POST /api/v1/admin/bundles` re-validates everything
and remains the decision of record, so a preflight that drifts can only ever be
less helpful; never permissive.

---

## The Activity feed, and what it is not

**Activity** merges five tables into one timeline: runs, jobs (including the
last error of a job that is still retrying), upload tasks, result submissions,
and audit events. Filter by severity, time window, extension, or free text over
the subject and message.

Be precise about what this replaces. **It covers application-level events; every
row in it is a durable database row.** That is why it can be filtered, linked
to, and read back months later, and it is why triage now starts in a browser
instead of in a terminal.

**Container stdout is not here and cannot be.** A stack trace from a crash loop,
a Prisma engine that failed to load, anything a process emitted before it could
reach the database; none of that is written to Postgres, so no endpoint can
serve it. That still lives in `docker logs` on the host:

```bash
docker compose logs -f --tail=200 core-uploader
```

The intended workflow is to start in Activity, find the run, job or task id, and
then reach for `docker logs` only if the row does not already explain itself.
Most of the time it does; the point of the feed is that `lastError` and
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
browser, and `GET /admin/audit` accepted only `limit`: so an event that had
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
filter is served by an index that already exists, `id` is the primary key,
`createdAt` and `action` each carry one, and the substring filters could not use
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
  so. Validation happens in the browser first, a title is required, the language
  must look like `en`, `pt-br` or `zh-hk`, the URL must be complete and http(s),
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
  title yet; approve the series first.

The order this is designed around is: **fix the details, then approve.** A row
whose title already exists shows a banner saying local edits do not reach
MangaDex until they are applied.

---

## Fixing a chapter that is already on MangaDex

`#/chapters` is the mirror of what the platform has published. It answers the
question that used to mean `psql` on the core container, *which MangaDex chapter
is this, is it still up, and what did we think it was?*, and then lets you change
it.

Opening one chapter (`#/chapters/<md chapter id>`) puts three things side by side:

- **our row**, written when the chapter was published;
- **what MangaDex says right now**, read live when the API instance holds
  credentials. This is the one that decides anything: our row is a mirror that
  may be days old while you are about to change a public entry. When MangaDex
  cannot be read the panel says why, and every action still works; the uploader
  reads MangaDex itself when it runs them;
- **what is already queued** against the chapter, so you do not queue a second
  change on top of somebody else's.

The three actions all **queue an upload task** and say so. `core-uploader` is the
only process holding MangaDex credentials; nothing is applied by the click, and
the result appears under Queues within seconds.

- **Edit metadata** takes MangaDex's own field names, volume, chapter, title,
  language, groups, external URL, prefilled from the live values and sending
  only what you actually changed. Blanking a field clears it; blanking the
  language leaves it alone, because a chapter always has one.
- **Mark unavailable** replaces the chapter's page with the info card explaining
  the publisher removed it, and repoints the publisher link away from the dead
  URL. **The card is previewed in the dialog first**, rendered by the same code
  the uploader posts, so what you approve is what readers get. A footer note
  replaces the standard wording for a takedown whose reason is not "the
  publisher removed it".
- **Regenerate the unavailable card** is the same button on a chapter that
  already carries one, and it is why the underlying task has a `force` flag:
  without it the uploader treats an archived chapter as done and would change
  nothing, leaving a card that says the wrong thing on a public page forever.
- **Delete from MangaDex** is the one irreversible action. It asks for a reason
  (recorded in the audit trail), states that marking the chapter unavailable is
  the reversible alternative, and needs an explicit confirmation.

### The same three, in bulk

Tick rows on the list and a bar appears above it with the same three actions.
The **whole filter** toggle switches them from the ticked rows to every chapter
the current filter matches; which is how "this series was licensed, take the lot
down" and "that run got the volume wrong on fifty chapters" are one click each.

Each button opens a dialog that **previews before it offers to apply**. The
preview is the server's own dry run: it names every chapter in the set, says what
would happen to each, and lists the ones it would refuse (already carded and no
`force`, already queued, claimed by an uploader, already deleted). The apply
button stays disabled until that preview has been fetched, and says how many
chapters it will queue. One call, one preview, and 200 chapters at a time; a
wider filter says so and is run again for the rest.

A bulk edit offers only **volume**, **language** and **groups**: the fields a set
of chapters can share. A title or a chapter number belongs to one chapter, so
those stay on the single-chapter form rather than being applicable two hundred
times by accident.

Afterwards the toast reports how many queued and how many were refused, and the
refusals are listed with their reasons; a batch is routinely a success and a
partial failure at once.

All of these need the **ADMIN** role on top of `chapters:write`, and all are
closed to `pa_…` api tokens however broadly they are scoped: changing a public
catalogue entry under the shared MangaDex account is attributable to a signed-in
operator or nothing. The buttons are disabled with the server's own reason rather
than hidden, so a contributor can see that the operation exists and who to ask.

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
  refuses; which it does, for instance, when a contributor tries to remove a
  mapping that needs `tracked:write`.
- **Space is reserved before data arrives**, so the page does not jump under
  your pointer.
- **A failed load names the reason and offers "Try again"** in place of that one
  panel; it never empties the page.
- **Every list has an empty state that says what would put something in it**,
  rather than showing a blank table.

### Visual language

The console is styled after industrial HMI practice, ISA-101 is the written-down
version of it, rather than after web dashboards. Four rules carry it, and
`style.css` is commented with the reasoning behind each:

- **Colour means abnormal.** The console is greyscale. Cyan, green, amber and red
  are spent only on state: in-motion, normal, caution, fault. A button is not
  coloured because it is important, only because it commits something; which is
  why `primary` and `danger` are the only two that take one. If everything is
  normal the screen is grey, and that is what makes a single amber chip findable.
- **Numbers are instrument readings.** Every count, id, timestamp, hash and state
  token is monospace with tabular figures, so a column lines up digit over digit
  and a value changing under a ten-second poll does not reflow its neighbours.
  Prose keeps the UI sans.
- **Panels are faceplates.** Square corners, one hairline, a captioned header
  strip, registration ticks at the corners. Nothing casts a shadow.
- **Motion means something is happening.** The only things that move are the lamp
  on a `busy` chip, the alarm pulse on the quarantine count, and the spinner on a
  control with a request in flight. Placeholders are hatched and still; the
  absence of a reading is not an event.

One caption object, 10px, uppercase, tracked, dim, is used for every legend:
panel headers, group headings, table headers, readout captions, badges. Anything
wearing it is a label for something else and never content in its own right.

The class contract at the foot of `style.css` lists every class the four scripts
emit. Renaming one without the other is how a view silently loses its skin, so
keep the two in step. There is a published mirror of the system, every preview
inlines the real stylesheet, in the "Publoader Control Plane" design project.

### Responsiveness

Usable down to a phone. The sidebar becomes a drawer; below 620px tables restack
as cards, with each cell labelled from its column header. A wide table always
scrolls inside its own container; the page body never scrolls sideways at any
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
- **No `innerHTML`, anywhere.** Every operator-supplied string, extension
  names, worker names, error text, is written with `textContent`, which is what
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
| **Restoring a backup, and scheduled backups** | Taking a backup *is* in the UI; **System → Database backup**, see [operations.md](operations.md). Restoring is not: it means stopping the services that would write during it, and nothing that can take the API down should be reachable through the API. Recurring backups belong in cron on the host, not in a browser tab someone has to remember to open. | The restore procedure and the scheduled `pg_dump` in [operations.md](operations.md) → "Backup and restore". |
| **Upgrading the core or a worker** | Replacing an image is the host's job; a container must not rewrite and re-exec itself (that was a legacy failure mode). | `docker compose pull && up -d` per [deployment.md](deployment.md) → "Upgrading". |
| **Rotating a secret in `.env`** | `ADMIN_TOKEN`, `SESSION_SECRET`, the MangaDex credentials and the tunnel token are environment, not database. | [operations.md](operations.md) → "Rotate secrets". Note that clearing the *saved MangaDex session* IS in the UI; that is database state, and it is the fix for a stale token pair. |
| **Applying a migration** | The runtime image has no Prisma CLI on purpose: a long-lived service must not carry a tool that can rewrite the database. | The one-shot `migrate` compose service. The System view tells you *whether* you need to; it reports pending and failed migrations. |
| **Restarting, stopping or recreating a container** | This needs the Docker socket, and `/var/run/docker.sock` is deliberately **not** mounted into any container. A process that can talk to that socket can start a privileged container and mount the host filesystem; it is root on the host, so exposing it to an internet-facing service would trade every other control on this page for a convenience. It will not be added. | `docker compose restart core-uploader` on the host. In practice you rarely need it: there is no `restart_workers` equivalent because every unit of work is a durable row, so the fix for stuck work is **Queues → Requeue stale leases** or a job replay, not a restart. |
| **Anything at all when `core-api` is down** | The dashboard *is* `core-api`. A control plane cannot repair the process serving it. | The host. Check `docker compose ps` and `docker compose logs core-api`; `/healthz` (liveness) and `/readyz` (database reachable) are the two probes worth curling first. |

Everything else; pausing, scheduling, curating the series map, triaging
queues, publishing a bundle, enrolling a worker, minting and revoking
credentials, managing accounts; is in the dashboard.

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
