# HTTP API reference

Every endpoint the platform serves, derived from the route files. The server is
built in [`src/core/api/server.ts`](../src/core/api/server.ts);
routes live in `src/core/api/routes/`, `session.ts`, `oauth.ts`, and
`dashboard.ts`.

Only `core-api` serves this API. The other three core services expose a small
[metrics/health listener](#metrics-and-health) and nothing else.

---

## Audiences and authentication

There are two strictly separated token audiences, and crossing them is a 401
regardless of how privileged the token is (`auth.ts:17-25`, tested at
`test/integration/api.test.ts:97`).

| Audience | Credential | Reaches |
| --- | --- | --- |
| Worker | `pw_…` bearer, sha256-hashed at rest | `/api/v1/worker/*` only |
| Admin | `ADMIN_TOKEN` bearer, or a `pa_…` scoped token, or a dashboard session cookie | `/api/v1/admin/*` only |

Admin principals resolve to scope sets (`auth.ts:101-166`):

| Principal | Kind | Scopes | Role |
| --- | --- | --- | --- |
| `ADMIN_TOKEN` | `root` | `["*"]` | `OWNER` |
| `pa_…` token | `api-token` | exactly its stored scopes | `ADMIN`: **never** `OWNER`, whatever it holds |
| Session cookie | `session` | derived from the account's role (below) | the account's role |

Dashboard accounts have three roles (`scopes.ts:103-121`):

| Role | Scopes |
| --- | --- |
| `OWNER` | `["*"]` |
| `ADMIN` | every scope except `users:admin`: an admin cannot promote anybody |
| `CONTRIBUTOR` | `extensions:read`, `tracked:read`, `tracked:append`, `untracked:read`, `untracked:write`, `stats:read`: enough to curate the series map and work the untracked queue, and nothing else. No runs, workers, credentials, settings, or bundles. This is the role to hand a community contributor |

That an API token is never `OWNER` is what makes "no token can mint or widen
another token" hold: token management requires both `users:admin` **and** the
owner role (`routes/tokens.ts:24-29`, tested at
`test/integration/tokens.test.ts:129`).

If `ADMIN_TOKEN` is unset the entire admin API answers **503**, not 200
(`auth.ts:103-106`).

### Cookie writes need a CSRF header

A cookie is attached by the browser automatically, so any non-`GET`/`HEAD`/
`OPTIONS` request authenticated by a session cookie must also send a header no
cross-origin form can set (`auth.ts:150-153`):

```
x-requested-with: publoader-dash
```

Missing it is a **403**. Bearer-authenticated writes are unaffected. Tested at
`test/integration/dashboard.test.ts:306` and
`test/integration/ops.test.ts:423`.

### Actor attribution

Machine credentials may name the human they act for with `x-actor` (max 64
chars). A `pa_…` token's audit actor becomes `token:<name> for <claimed>`;
sessions are always named by their own account and **may not** claim someone else
(`routes/admin.ts:33-50`). The Discord bot always sends
`x-actor: discord:<username>` (`src/bot/apiClient.ts:362-364`).

### Rate limits

In-process token buckets, keyed per principal (`api/ratelimit.ts`,
`api/context.ts:62-68`). Exceeding one is a **429**.

| Limiter | Key | Capacity | Refill | Applies to |
| --- | --- | --- | --- | --- |
| Enroll | remote IP | 5 | 1/min | `POST /worker/enroll` |
| Worker | worker id | 60 | 10/s | all authenticated worker routes |
| Admin | remote IP | 120 | 20/s | all admin routes except `/tokens` |
| Session | remote IP | 5 | 5/min | `POST /admin/session`, OAuth start and link |
| Magic link | remote IP | 5 | 1/2min | requesting and redeeming an emailed sign-in link |
| Magic link | email address | 3 | 1/5min | requesting one; the per-IP bucket alone lets a distributed caller mailbomb one inbox |

### Shared response conventions

Every response carries `x-request-id`, `x-content-type-options: nosniff`,
`referrer-policy: no-referrer`, and `cache-control: no-store`
(`server.ts:65-70`). Errors are `{"error": "<message>"}`; a 5xx is always the
literal string `"internal error"`: stack traces and internals are never
returned (`server.ts:100-105`). An empty body with
`content-type: application/json` is parsed as `{}`, so the many no-body admin
actions do not 400 (`server.ts:44-58`). Default body limit is 1 MiB; three routes
raise it explicitly.

---

## Worker API

Base: `/api/v1/worker`. Auth: `pw_…` bearer, except enrollment.
Client: [`src/worker/coreApi.ts`](../src/worker/coreApi.ts).

### `POST /enroll`

Exchange an operator-minted enroll token for a worker identity. The one
unauthenticated write endpoint in the system; rate-limit it at the edge as well
(`docker/core/docker-compose.yml`, the WAF notes on `cloudflared`).

Request:

```json
{ "enrollToken": "pe_…", "name": "worker-01",
  "extensions": ["mangaplus"], "agentVersion": "1.0.0" }
```

`extensions` and `agentVersion` are optional; `name` is truncated to 128 chars.

| Status | Meaning |
| --- | --- |
| `201` | `{ "workerId": "<uuid>", "workerToken": "pw_…", "trust": "COMMUNITY" }`: the token is shown **once** |
| `400` | body failed validation |
| `403` | invalid, expired, revoked, or already-used enroll token (audited as `worker.enroll.rejected`) |
| `429` | rate limited |

`routes/worker.ts:33-52`.

### `POST /heartbeat`

Request `{ "agentVersion"?: "…" }` → `200 { "ok": true, "status": "ACTIVE" }`.
Updates `last_heartbeat_at`. `routes/worker.ts:63-69`.

### `POST /token/rotate`

No body. → `200 { "workerToken": "pw_…" }`. The old token stops working
atomically; the agent persists the new one before adopting it
(`worker/credentials.ts:165-177`). `routes/worker.ts:72-81`.

### `POST /lease`

Long-poll for work. Request:

```json
{ "extensions": ["mangaplus"], "waitSeconds": 25 }
```

Both optional. `waitSeconds` is clamped to `LEASE_POLL_WAIT_SECONDS` (default
25). `extensions` may only **narrow** the worker's registered capability set,
never widen it (`routes/worker.ts:99-107`).

| Status | Meaning |
| --- | --- |
| `200` | a lease grant (below) |
| `204` | nothing to do. `x-publoader-drained: true` when the worker is `DRAINED`/`REVOKED`, so the agent idles instead of hammering |
| `400` | body failed validation |
| `429` | rate limited |

The grant:

```json
{
  "job": {
    "jobId": "<uuid>", "runId": "<uuid>",
    "extension": "mangaplus", "extensionVersion": "1.1.0",
    "bundleSha256": "<64 hex>", "kind": "UPDATE", "attempt": 1,
    "segmentIndex": 0, "segmentTotal": 4,
    "segmentKey": "a1b2c3d4e5f60718", "segmentMangaIds": ["100001", "…"],
    "timeoutSeconds": 3600,
    "manifest": { "…": "the core's copy for the pinned bundle" },
    "postedChapterIds": ["…"],
    "mangaIdMap": { "<mdMangaId>": ["<externalId>", "…"] },
    "overrideOptions": { "…": "from extension_configs" }
  },
  "leaseId": "<uuid>", "leaseExpiresAt": "<iso>", "leaseTtlSeconds": 300
}
```

`mangaIdMap` and `overrideOptions` come from the **database**, not from files in
the bundle, which is how a title auto-created since publish reaches the extension
without a republish. `postedChapterIds` is empty for a `CLEAN` run.
`routes/worker.ts:87-176`.

### `POST /jobs/:jobId/start`

Request `{ "leaseId": "<uuid>" }` → `200 { "ok": true }`.

**`409 { "error": "lease not current" }`**: the lease expired or was reassigned.
The agent drops the job and lets the sweeper requeue it
(`worker/agent.ts:184-195`). `routes/worker.ts:178-185`.

### `POST /jobs/:jobId/renew`

Request `{ "leaseId": "<uuid>" }` →

```json
{ "ok": true, "cancelRequested": false, "leaseExpiresAt": "<iso>" }
```

`cancelRequested: true` is how a running worker learns to abort. **`409`** means
the lease is gone and the worker must stop working on the job. Renewals use a
tighter retry budget than other calls (3 attempts, 400 ms base) so they do not
burn the TTL they are trying to extend (`worker/coreApi.ts:311-323`).
`routes/worker.ts:187-198`.

### `POST /jobs/:jobId/results`

Submit the [result envelope](../src/contracts/envelope.ts). Body limit
raised to **32 MiB**.

| Status | Meaning |
| --- | --- |
| `200` | the envelope was judged. Body is one of the four outcomes below |
| `400` | the envelope's `jobId` does not match the route |
| `422` | not a well-formed envelope (`{ "outcome": "invalid", "reason": "…" }`) |

The four judged outcomes; all **200**, because the worker's delivery duty is
done whichever way the verdict went (`routes/worker.ts:211-215`):

```json
{ "outcome": "committed",   "submissionId": "<uuid>" }
{ "outcome": "superseded",  "submissionId": "<uuid>", "reason": "stale lease" }
{ "outcome": "quarantined", "submissionId": "<uuid>", "reason": "<policy error>" }
{ "outcome": "job_failed",  "submissionId": "<uuid>", "disposition": "requeued" }
```

Resubmitting the same envelope returns the prior verdict rather than re-judging
it (`ingest.ts:49-53`). `routes/worker.ts:200-217`.

### `POST /artifacts`

Upload one page image. Binary body; body limit 20 MiB + 1 KiB.

Headers: `content-type` (must be `image/png|jpeg|gif|webp`),
`x-artifact-sha256` (required, verified against the bytes),
`x-artifact-job-id` (optional provenance).

| Status | Meaning |
| --- | --- |
| `201` | `{ "artifactId": "<uuid>", "sha256": "<64 hex>" }` |
| `400` | body was not binary |
| `422` | size outside limits, disallowed content type, or **sha256 mismatch** |

`routes/worker.ts:219-239`.

### `GET /bundles/:sha256`

Download a pinned bundle. Response is `application/zip` with
`x-bundle-sha256`, `x-bundle-extension`, `x-bundle-version`.
**400** for a malformed sha, **404** for an unknown one. The client re-hashes the
body and refuses a mismatch (`worker/coreApi.ts:367-378`).
`routes/worker.ts:241-252`.

---

## Admin API

Base: `/api/v1/admin`. Every route declares a required scope. Every mutating
route writes an audit event naming the acting principal.

### Scopes

The twenty-one valid scopes (`api/scopes.ts:20-52`):

| Area | Scopes |
| --- | --- |
| runs | `runs:read` `runs:write` |
| published chapters | `chapters:read` `chapters:write` |
| workers | `workers:read` `workers:write` `enroll:write` |
| extensions | `extensions:read` `extensions:write` |
| series map | `tracked:read` `tracked:append` `tracked:write` |
| bundles | `bundles:read` `bundles:write` |
| untracked | `untracked:read` `untracked:write` |
| settings | `settings:read` `settings:write` |
| accounts | `users:admin` |
| observability | `audit:read` `stats:read` |

**Implication** (`scopes.ts:91-101`): `write` implies `append` implies `read`,
within one area only. Nothing else implies anything, so `users:admin` grants only
itself and a token scoped for account management cannot quietly publish bundles.

`chapters:*` is separate from `runs:*` on purpose. `runs:*` is about scraping and
the queue that drains from it; `chapters:write` queues an edit, a takedown or a
delete against a live public catalogue entry. A credential that may trigger a run
does not thereby get to unpublish chapters; and `chapters:write` is not enough
on its own either: every mutating chapter route also requires the ADMIN role and
refuses api tokens outright (see *Published chapters* below).

`tracked:*` is deliberately split three ways, and the middle one is the point.
`tracked:append` can create mappings that do not exist yet, the worst case is a
wrong *new* mapping, which is visible and reversible, while `tracked:write` is
needed to repoint or delete an existing one, because un-tracking a series silently
stops its uploads. That is what makes the series map safe to delegate.

A missing scope is **403** and names what was needed, because the caller already
proved it holds a valid credential and "which scope do I need?" is the only
useful next question (`auth.ts:169-191`):

```json
{ "error": "missing scope: bundles:write", "held": ["runs:write", "stats:read"] }
```

Shipped presets (`scopes.ts:123-146`): note `discord-bot` **includes**
`settings:write`, deliberately, because pausing the platform from chat during an
incident is the most valuable thing the bot does:

| Preset | Scopes |
| --- | --- |
| `discord-bot` | `runs:write`, `workers:read`, `extensions:read`, `untracked:write`, `settings:write`, `stats:read`, `audit:read` |
| `ci-publisher` | `bundles:write` |
| `monitoring` | `stats:read`, `audit:read` |
| `worker-enroller` | `enroll:write`, `workers:read` |
| `curator` | `extensions:read`, `tracked:append`, `untracked:read`, `untracked:write` |

`bundles:read` is defined but no route currently requires it; bundle bytes are
served to workers, not to admin clients.

### Worker fleet

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| `POST` | `/enroll-tokens` | `enroll:write` | `{trust?, note?, ttlHours?}` (default `COMMUNITY`, 24 h, max 720) → `{token, expiresAt}`. Shown once |
| `GET` | `/workers` | `workers:read` | `{workers: [{id, name, status, trust, extensions, lastHeartbeatAt, agentVersion, createdAt}]}`: never the token hash |
| `POST` | `/workers/:id/drain` | `workers:write` | → `{ok, status: "DRAINED"}`; `404` unknown worker |
| `POST` | `/workers/:id/activate` | `workers:write` | → `ACTIVE` |
| `POST` | `/workers/:id/revoke` | `workers:write` | → `REVOKED`; the token stops authenticating immediately |

`routes/admin.ts:53-97`.

### Runs and jobs

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| `POST` | `/runs` | `runs:write` | `{extension, kind?, idempotencyKey?}`. `kind` defaults to `FORCE`. `201` created / `200` already existed → `{runId, created, segments}`. **`409` platform is paused**; `404` no bundle published for that extension |
| `GET` | `/runs` | `runs:read` | `?limit=1..200` (25), `?extension=`. Each row carries `chaptersFound` (new or changed) and `chaptersSeen` (catalogue snapshot), aggregated over the page in one statement. **Both are `null` when no segment has committed an envelope yet**: which is not the same as a run that found nothing |
| `GET` | `/runs/:id` | `runs:read` | Run plus all its jobs; `404` unknown |
| `GET` | `/runs/:id/chapters` | `runs:read` | What the run's extension reported, read back out of the stored envelopes. `?set=updated\|all` (updated), `?q=`, `?mdMangaId=`, `?language=`, `?segmentIndex=`, `?limit=1..500` (100), `?offset=`. Ordered `segmentIndex, position`: the extension's own order. Offset paging is safe here because a committed envelope never changes |
| `GET` | `/runs/:id/chapters/summary` | `runs:read` | Per-segment coverage and a per-series breakdown. A segment with no committed envelope reports `updated: null`, **not `0`**, and `complete` says whether the chapter list can be read as the whole run |
| `POST` | `/jobs/:id/cancel` | `runs:write` | → `{ok, result: "cancelled"\|"flagged"}`. `PENDING` cancels immediately; a live lease is flagged and the worker aborts on its next renew. **`409`** if the job is in neither state |
| `POST` | `/jobs/:id/retry` | `runs:write` | Replay a dead letter with a fresh attempt budget. **`409` job is not dead-lettered** |
| `GET` | `/dead-letter` | `runs:read` | Up to 100 `DEAD_LETTER` jobs, newest first |
| `GET` | `/quarantine` | `runs:read` | Up to 100 quarantined submissions; id, jobId, workerId, rejectReason, createdAt. **The envelope body is not returned** |

`routes/admin.ts:100-187`; the two chapter endpoints are `routes/chapters.ts`,
backed by `store/runChapters.ts`. There is no run-level cancel; cancel the jobs.

The chapters a run found are **not** copied into a table on ingest: they are
unnested from `result_submissions.envelope` on demand
(`jsonb_array_elements … WITH ORDINALITY`), so the envelope stays the single
source of truth and paging happens in Postgres rather than in the API process.

### Pause gate

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| `POST` | `/pause` | `settings:write` | `{minutes?: 1..1440}`. Omitting `minutes` pauses indefinitely → `{ok, paused: true, indefinite}` |
| `POST` | `/resume` | `settings:write` | → `{ok, paused: false}` |

Pausing stops new leases (`routes/worker.ts:110`), scheduled run creation
(`scheduler/service.ts:46-50`), and processor ticks
(`services/processor.ts:52-54`). In-flight work finishes.
`routes/admin.ts:190-205`.

### Extensions, schedules, and config

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| `GET` | `/extensions` | `extensions:read` | Latest non-yanked bundle per extension + `disabled` flag |
| `POST` | `/extensions/:name/enable` | `extensions:write` | `400` on a name failing `^[a-z0-9_]+$` |
| `POST` | `/extensions/:name/disable` | `extensions:write` | Stops scheduling; does not touch in-flight runs |
| `GET` | `/schedules` | `extensions:read` | `{defaults, overrides, effective}`: manifest slots, DB rows, and what will actually run. Each is `Record<extension, slot[]>` |
| `GET` | `/schedules/:name` | `extensions:read` | `{extension, manifest, entries, effective, source}`. `entries` carries the `id` every mutating call below needs |
| `PUT` | `/schedules/:name` | `extensions:write` | **Replaces** the whole schedule. `{entries: slot[]}`, or a bare slot meaning a one-element list. `{entries: []}` means *run nothing*, which is not the same as `DELETE` |
| `POST` | `/schedules/:name` | `extensions:write` | **Appends** one slot → `{ok, id, created, seeded}`. Seeds the manifest's slots first when the extension has none, so adding never silently drops them. `created: false` when an identical slot already exists |
| `PATCH` | `/schedules/:name/:id` | `extensions:write` | `{enabled: boolean}`: stop a slot firing without losing it. **404** on an id not belonging to `:name` |
| `DELETE` | `/schedules/:name/:id` | `extensions:write` | Drop one slot. **404** on an id not belonging to `:name` |
| `DELETE` | `/schedules/:name` | `extensions:write` | Drop every slot → `{ok, removed}`; the extension falls back to its manifest |
| `GET` | `/extensions/:name/tracked` | `tracked:read` | Every publisher-id → MangaDex-title mapping |
| `PUT` | `/extensions/:name/tracked` | `tracked:append` | `{mangaId, mdMangaId}`; upsert, records the actor as `source`. **403** when the mapping already exists and points somewhere else and the caller lacks `tracked:write`: repointing a series is an edit, and a silent one |
| `POST` | `/extensions/:name/tracked/batch` | `tracked:append` | Bulk curation; see below |
| `POST` | `/maps/sync` | `tracked:write` | Write the tracked map back to `manga_id_map.json` in GitHub; see below |
| `DELETE` | `/extensions/:name/tracked/:mangaId` | `tracked:write` | → `{ok, removed}`. Does **not** touch MangaDex |
| `GET` | `/extensions/:name/config` | `extensions:read` | `{extension, overrideOptions}` |
| `PUT` | `/extensions/:name/config` | `extensions:write` | `{overrideOptions: {…}}`: replaces wholesale |
| `GET` | `/removal-mode` | `settings:read` | `{mode, validModes}` |
| `POST` | `/removal-mode` | `settings:write` | `{mode: "unavailable"\|"delete"}` |

`routes/admin.ts:208-280`, `387-470`.

#### Schedule slots

One extension has a *list* of slots, not one time. A slot is:

```json
{
  "hour": 1,
  "minute": 0,
  "days": [2],
  "kind": "CLEAN",
  "label": "weekly deep clean"
}
```

- `days` is a **set** of weekdays, **Monday = 0 … Sunday = 6** (Python's
  `weekday()`, the numbering the extension contract has always used, *not*
  JavaScript's Sunday = 0). An empty or absent array means **every day**. A
  single `day: 0..6` is accepted as shorthand and folded into `days`.
- `kind` is `UPDATE` (default, the ordinary incremental run), `CLEAN` (full
  catalogue so removals can be computed), or `FORCE`.
- `label` is never interpreted; it exists so `01:00 Wed clean` has a name in a
  listing.

The four-slot example the feature was built for, 15:00 update, 01:00 update,
Wednesday 01:00 clean, midnight update:

```json
{"entries": [
  {"hour": 15, "minute": 0},
  {"hour": 1,  "minute": 0},
  {"hour": 1,  "minute": 0, "days": [2], "kind": "CLEAN", "label": "weekly deep clean"},
  {"hour": 0,  "minute": 0}
]}
```

**Precedence is replacement, not merge.** If an extension has any rows, they are
its whole schedule and the manifest's slots are ignored, including when every
row is switched off, which means *run nothing* rather than *fall back*. A merge
could not express "not that one": there would be no way to drop a slot the
manifest declared. `POST` compensates for the sharp edge by copying the
manifest's slots in before appending (`seeded` in the response says how many),
so adding a weekly clean cannot silently cancel the daily update.

**Run identity.** The scheduler keys each run
`sched:<extension>:<slot-minute>:<kind>`. Two slots at the same minute with
different kinds therefore produce two runs; two that agree on both collapse to
one, which is what makes a duplicated slot harmless
(`core/scheduler/service.ts`).

#### Bulk series-map curation

`POST /extensions/:name/tracked/batch`, scope `tracked:append`
(`routes/admin.ts:434-470`). Request:

```json
{
  "set": [{ "mangaId": "100001", "mdMangaId": "<uuid>" }],
  "remove": ["100002"],
  "text": "100003,<uuid>\n100004,<uuid>",
  "dryRun": false
}
```

`text` accepts the pasted `externalId,mdMangaId` form (order-insensitive) so
nobody has to build JSON by hand. `dryRun: true` reports what would happen without
writing. At most 2000 rows per batch (`store/trackedManga.ts:17`); more is a
**413**.

Rows are judged and reported **individually**: a contributor pasting 200 lines
needs to know which three were wrong, not that "the batch failed". The response
carries `parseErrors` plus a per-row outcome. `remove` still requires
`tracked:write`, per the same append-versus-edit rule as the single-row route.

#### Series-map write-back

`POST /maps/sync`, scope `tracked:write`. Runs the same job the weekly timer
runs, which is what makes `dryRun` an honest preview:

```json
{ "dryRun": false, "force": false, "extensions": ["mangaplus"] }
```

`extensions` empty means every extension with tracked mappings. `force` bypasses
the guard that refuses a write deleting more than half of a file's mappings;
operator-only, and never set by the timer. The response is the run report:

```json
{
  "ok": true, "ranAt": "…", "dryRun": false, "written": 1, "failed": 0,
  "outcomes": [{
    "extension": "mangaplus", "status": "write", "repo": "publoader-extensions",
    "path": "src/mangaplus/manga_id_map.json", "commit": "<sha>",
    "added": 3, "removed": 1, "mappings": 412
  }]
}
```

`status` is `write`, `unchanged`, `skipped` (no file, no repo, or two repos
claim the extension), `refused` (a guard fired; `detail` says which) or
`failed`. `skippedReason` on the report means the whole run did nothing, most
often "`GITHUB_TOKEN` is unset; writing to a repo needs Contents: write".
Behaviour, guards and the weekly schedule: docs/operations.md §"Series-map sync".

### Bundles

| Method | Path | Scope |
| --- | --- | --- |
| `POST` | `/bundles` | `bundles:write` |

Body is the raw zip with `content-type: application/zip`; limit **64 MiB**.
Optional headers `x-source-commit` (provenance) and `x-allow-legacy-runtime: true`
(the audited escape hatch for republishing a pre-v2 Python bundle; requesting it
is logged even if the publish then fails for another reason).

| Status | Meaning |
| --- | --- |
| `201` | newly published → `{extension, version, sha256, created: true}` |
| `200` | identical content already published (`created: false`) |
| `400` | body was not a zip |
| `422` | missing or invalid `manifest.json`, invalid zip, or the bundle was rejected; a Python runtime without the override, a missing/empty entrypoint, a non-`.mjs`/`.js` entrypoint, or an entrypoint with no default export |

`routes/admin.ts:283-337`; rejection rules in `store/bundles.ts:37-46`,
`172-209`, tested at `test/unit/bundlePublish.test.ts`.

### Untracked series

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| `GET` | `/untracked` | `untracked:read` | `?state=NEW\|CREATING\|CREATED\|TRACKED\|FAILED\|SKIPPED`, `?limit=1..500` (100) |
| `POST` | `/untracked/:id/approve` | `untracked:write` | Creates and commits the MangaDex title now, then tracks it. **`503`** when this instance holds no MangaDex credentials; **`409`** when the row is not approvable in its current state |
| `POST` | `/untracked/:id/skip` | `untracked:write` | `NEW`/`FAILED` → `SKIPPED`. **`409` not skippable** |

`routes/admin.ts:395-429`; `md/titleService.ts:66-84`.

### Upload-task queues

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| `GET` | `/upload-tasks` | `runs:read` | `?kind=`, `?state=`, `?limit=1..500` (100) → `{tasks, counts}`. **`chapter` is deliberately not returned**: large, worker-supplied, and the dedupe key identifies the chapter well enough for triage. `400` on a bad filter value |
| `POST` | `/upload-tasks/:id/retry` | `runs:write` | `FAILED`/`DEAD_LETTER` → `PENDING` with `attempt` reset to 0. `404` unknown; **`409`** naming the actual state otherwise |
| `POST` | `/upload-tasks/:id/cancel` | `runs:write` | `PENDING`/`FAILED`/`DEAD_LETTER` → `DONE` with the reason in `lastError`. **`409` for a `LEASED` task**: an uploader owns it mid-flight and forcing it would race into a duplicate upload or a lost result |
| `POST` | `/upload-tasks/requeue-stale` | `runs:write` | Manual lease sweep → `{ok, requeued}` |

| `GET` | `/queues/chapters` | `runs:read` | The queue read as chapters rather than as rows: series, number, volume, title, language, and an EDIT task's `editPayload`. `?kind=`, `?state=` (**defaults to `PENDING`**), `?q=` (searches the payload's series name, title, number and both MangaDex ids; not the dedupe key), `?extension=` and `?language=` (exact, the same two facets `/queues/tasks` takes), `?dedupeKey=`, `?limit=1..500` (100), `?cursor=`, `?sort=asc\|desc` (`asc`, the claim order; `desc` newest first, echoed back as `sort`). `position` is the place in the claim order across **everything matching the filter**, not within the page, and is never reversed by `sort` |

`routes/ops.ts:103-217`, tested at `test/integration/ops.test.ts`;
`/queues/chapters` is `routes/chapters.ts`, tested at
`test/integration/runQueueChapters.test.ts`.

### Published chapters

What the platform has put on MangaDex, and the three things an operator can do to
a chapter afterwards. **Nothing here writes to MangaDex.** Every action queues an
`UploadTask` and answers **`202`** with the task; `core-uploader` is the only
process holding write credentials, and a `200` here would be claiming a change
that has not happened yet.

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| `GET` | `/chapters` | `chapters:read` | `?archive=uploaded\|unavailable\|deleted\|edited` (default `uploaded`), `?extension=`, `?language=`, `?mdMangaId=`, `?mdChapterId=`, `?chapterId=`, `?chapterNumber=`, `?search=`, `?since=`, `?until=`, `?limit=1..200` (50), `?cursor=` → `{archive, chapters, total, nextCursor, order, totals, archives}`. Newest first, **keyset** paged: the table grows while it is read, so an offset page would repeat rows. `search` covers the series name, the chapter title and all four ids. `totals` is global, so a narrow filter cannot hide an archive that is filling up |
| `GET` | `/chapters/extensions` | `chapters:read` | `?archive=` → `{extensions: [{extension, count}]}`: what the filter picker offers |
| `GET` | `/chapters/:mdChapterId` | `chapters:read` | The row from whichever archives hold it, `archives` (when each recorded it), `edits`, `tasks` (queue rows keyed on this chapter), `links`, and **`mangadex`**: what MangaDex says right now, when this instance has credentials. A MangaDex outage degrades to `mangadex: null` + `mangadexError` and never makes the row unreadable. `actionsBlockedReason` is why a mutating call would be refused, so a UI can disable a control *with the reason* |
| `GET` | `/chapters/:mdChapterId/card.png` | `chapters:read` | `?footerNote=`, `?unavailableAt=` → **`image/png`**. The unavailable card as it would be posted, rendered by the same function the uploader calls (`md/unavailableCard.ts`). Writes and queues nothing |
| `PATCH` | `/chapters/:mdChapterId` | `chapters:write` + ADMIN | `{volume?, chapter?, title?, translatedLanguage?, groups?, externalUrl?}`: MangaDex's own field names, `null` clears, omitted leaves alone. Queues an `EDIT` carrying `payload` and `oldInfo`. The merge onto MangaDex's current resource happens at execution time, because `PUT /chapter` replaces rather than patches and needs the `version` current when the write lands. `400` unknown field / bad language / bad URL |
| `POST` | `/chapters/:mdChapterId/unavailable` | `chapters:write` + ADMIN | `{force?, footerNote?}`. Queues an `UNAVAILABLE`: render the card, attach it as the chapter's only page, repoint `externalUrl`, archive the row. **`409` when the chapter is already marked unavailable unless `force: true`**: without the flag the uploader treats it as done and changes nothing, which would make a wrong card unfixable |
| `DELETE` | `/chapters/:mdChapterId` | `chapters:write` + ADMIN | `{confirm: true, reason?}`. Queues a `DELETE`. **`400` without `confirm`**, and the refusal names the unavailable route as the reversible alternative. The whole row goes into the audit detail, because afterwards `deleted_chapters` and that entry are the only records the chapter existed |

And the one chapter route that writes directly instead of queueing, because it
changes nothing on MangaDex; it corrects our record of what MangaDex already
did:

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| `POST` | `/chapters/reconcile` | `chapters:read`, **plus ADMIN and no api tokens when `dryRun: false`** | `{dryRun?, extensions?, skipDeleted?, skipAdopt?, skipUnavailable?}`, `dryRun` defaulting to **true**. Archives the chapters already carrying an unavailable card (`externalUrl` set **and** `pages > 0`; an external chapter with no pages is live) and the ones MangaDex 404s. Seeds archive rows for chapters with no `uploaded_chapters` row at all: the usual case, and the reason a sweep of our own table finds nothing. Also **adopts** the live chapters MangaDex holds for our groups that no table here has a row for, into `uploaded_chapters` and (where the publisher chapter id can be recovered from the URL) `uploaded_ids`; `skipAdopt` reports them without recording any, and `skipUnavailable` does the same for the carded chapters; the three skips make the three passes independently selectable, which is how the dashboard offers one button per archive. Adoption only inserts — a chapter this platform uploaded keeps the row it has. `untrackedFound`/`adoptedRecorded`/`idsRecorded` count that pass, and each group carries `live`, `untracked`, `adopted`, `adoptedWithId` and the measured `idRule` (`null` when no id could be recovered, in which case adopted rows carry no `chapter_id`). `hiddenOnMangadex` lists uncarded chapters MangaDex will not serve; those are reported and never written. Idempotent: an already-archived id keeps its original timestamp. See docs/operations.md §"Reconcile our record of the chapters with MangaDex" |

The same three actions over a set of chapters:

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| `POST` | `/chapters/bulk/edit` | `chapters:write` + ADMIN | `{ids?, filter?, changes: {volume?, translatedLanguage?, groups?}, dryRun?, confirm?}`. **The fields are a subset of the single-chapter edit on purpose**: a title, a chapter number and an external URL are one chapter's identity, so they are not expressible here. `oldInfo` is taken from our own rows rather than 200 live MangaDex reads; the uploader still merges against the live resource when it runs |
| `POST` | `/chapters/bulk/unavailable` | `chapters:write` + ADMIN | `{ids?, filter?, force?, footerNote?, dryRun?, confirm?}`. Cards are rendered per chapter from that chapter's own details |
| `POST` | `/chapters/bulk/delete` | `chapters:write` + ADMIN | `{ids?, filter?, reason?, dryRun?, confirm?}`. The whole row goes into each chapter's audit entry |

Three rules hold across all three:

- **Exactly one of `ids` or `filter`.** `filter` takes the list's own fields plus
  `archive` (default `uploaded`); `ids` is capped at 200 by the schema.
- **`dryRun` defaults to `true`.** The first call anyone makes, including a
  client that forgot the field, writes nothing, queues nothing, audits nothing,
  and returns a per-chapter prediction: `would_queue`, or the same refusal the
  live call would give (`not_found`, `deleted`, `needs_force`, `already_queued`,
  `leased`). A live run needs `dryRun: false` **and** `confirm: true`. It is a
  preview of the operation, not an estimate of it.
- **200 chapters per call**, lower than the 1000 of `/queues/*` because this cap
  bounds a change to public pages rather than to queue rows. A truncated set
  answers `capped: true` and the operator calls again.

A live bulk call answers **`200`** (not `202`) with `{queued, refused, results}`:
a batch where eight chapters queued and two were refused is a success and a
partial failure at once, and only the per-chapter results say which is which.
Each queued chapter gets **its own audit event** (subject = the chapter id,
detail carrying a shared `bulk` id) plus one `<action>.bulk` summary row, so
"why was this chapter deleted?" stays answerable by subject.

Two refusals are worth knowing about:

- **`409` `already_queued` / `leased`.** One queue slot per (kind, chapter): a
  `PENDING` task is not silently rewritten, and a `LEASED` one belongs to a live
  uploader. A task that has *finished* is superseded in place and the response
  says `superseded: true`: without that a chapter could be edited exactly once,
  ever, since nothing deletes `DONE` rows.
- **`403` for api tokens.** Changing a public catalogue entry under the shared
  MangaDex account is attributable to a signed-in operator or nothing, so these
  routes are closed to `pa_…` credentials however broadly they are scoped;
 every api token carries `adminRole = "ADMIN"`, which means "not
  owner-equivalent", not "vetted human". The break-glass `ADMIN_TOKEN` is a
  `root` principal and still works.

Re-posting the card image on chapters that already carry one is its own route,
not a fourth flag on the bulk ones:

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| `POST` | `/chapters/unavailable/recard` | `chapters:write` + ADMIN | `{ids?, filter?, footerNote?, dryRun?, confirm?, afterId?, batch?}`. Always the `unavailable` archive and always forced. A chapter with no card refuses as `not_unavailable` rather than being carded for the first time |
| `GET` | `/chapters/series` | `chapters:read` | `?archive=&extension=&language=&search=&limit=`. The titles present in one archive, most-affected first: `{mdMangaId, mangaName, extensions[], count, at}` plus `capped`. Aims the `mdMangaId` filter above; read-only, so unlike the re-card itself it is reachable on a `pa_…` token |

It exists because the bulk route gets two things wrong for a re-render:

- **The date.** `/chapters/bulk/unavailable` stamps every card with `new Date()`,
  which is right for a chapter going unavailable now and wrong for one that went
  unavailable in March; through it, re-rendering a year-old page rewrites its
  "available until" line. Here `unavailableAt` comes from the archive row.
- **Termination.** The bulk cap is 200 with no continuation, ordered on
  `unavailable_at DESC` — the column the uploader rewrites as it archives. "Re-card
  everything" through it re-cards the newest 200 for ever. This pages on the
  primary key and answers `nextAfterId`; the caller repeats with it until it is
  null, which is exactly what the dashboard panel does.

`filter: {mdMangaId}` is the single-series trigger: every card one title has up,
swept to the end by the same continuation as a whole-archive pass. `GET
/chapters/series` is how a title is found — `count` is the size of the job, and
extension and language narrow both it and the sweep identically, so the list an
operator picks from and the rows the sweep touches are the same set.

`filter: {}` means every unavailable chapter; the filter is required-but-emptiable
so that "re-card everything" has to be typed rather than fallen into. Everything
else matches the bulk contract: `ids` XOR `filter`, `dryRun` defaulting to true, a
live run needing `dryRun: false` **and** `confirm: true`, one audit row per chapter
(`chapter.unavailable.recard`) plus a `chapter.unavailable.recard.sweep` summary.

`routes/chapters.ts`, `store/chapters.ts`, tested at
`test/integration/chapters.test.ts`.

### MangaDex session

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| `GET` | `/mangadex/auth` | `settings:read` | `{hasAccess, hasRefresh, expiresAt, expired, expiresInSeconds}`. **The tokens themselves are never returned**; `exp` is read from the JWT without verifying the signature, and an unparseable token reports unknown expiry rather than `expired: true` |
| `POST` | `/mangadex/auth/clear` | `settings:write` | Forgets the saved session so the next call re-authenticates from configured credentials. Does **not** revoke anything MangaDex-side |

`routes/ops.ts:229-260`.

### Observability

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| `GET` | `/stats` | `stats:read` | `{jobs: {state: n}, uploadTasks: [{kind, state, count}], workers: {status: n}, quarantined, errorsOutstanding: {total, jobs, uploadTasks, submissions}, paused}`. `quarantined` is a state count; `errorsOutstanding` excludes failures an operator has cleared and is what the dashboard badge uses |
| `GET` | `/errors` | `runs:read` | `?limit=1..200` (50), `?cleared=without\|with\|only` (`without`). One time-ordered feed merging dead-lettered jobs, failed/dead-lettered upload tasks, and quarantined submissions → `{errors: [{at, kind, source, subject, message, id, cleared?}], clearedHidden}`. Each source is queried at the full limit before merging, so a burst in one cannot be hidden behind old rows from another. Cleared entries are omitted by default and counted in `clearedHidden`, so an empty feed never reads as "nothing ever failed" |
| `POST` | `/errors/clear` | `runs:write` | `{refs?: [{source, id}], ids?: [id], all?: true, note?}`: acknowledge failures that have been read and dealt with, so they leave the feed. `ids` accept a full id or a leading prefix (≥4 chars) and are resolved across all three sources; ambiguous prefixes are refused, not guessed. Entries that are not currently failing come back in `skipped` with a reason (404 if nothing matched at all), because acknowledging a healthy row would hide its NEXT failure. Hides only; no row changes state, and anything that fails again reappears. One audit event per entry |
| `POST` | `/errors/restore` | `runs:write` | `{refs?, ids?, all?: true}`: un-clear, putting entries back in the feed → `{restored}`. The undo for a mis-clicked "clear all" |
| `GET` | `/audit` | `audit:read` | `?limit=1..500` (100) → `{events}` |

`routes/admin.ts:432-453`, `routes/ops.ts:274-338`.

### Client tokens

All four routes require **`users:admin` *and* the `OWNER` role**, so no API
token can mint or widen another (`routes/tokens.ts:24-29`).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/tokens/scopes` | `{scopes, presets}`: so the dashboard never hardcodes the taxonomy |
| `GET` | `/tokens` | Metadata only; the hash is stripped, and there is no path that returns a secret |
| `POST` | `/tokens` | `{name, scopes: [1..32], ttlDays?: 1..3650}`. `201` → `{id, name, scopes, expiresAt, token}`: **the token is shown once**. **`422`** on an unknown scope, with `validScopes` in the body |
| `POST` | `/tokens/:id/revoke` | **`409`** unknown or already revoked |

> `GET /api/v1/admin/tokens/self` does **not** exist. The Discord bot's
> `/whoami` probes for it and treats 403/404/405 as "unknown"
> (`src/bot/apiClient.ts:444`), so the command degrades rather than
> failing; but do not build against that path.

### Accounts and sessions

`OWNER` + `users:admin` for everything here except setting your own password.
Role keeps API tokens out entirely; the scope keeps a future non-owner principal
from inheriting it by accident (`routes/users.ts:34-37`).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/users` | Accounts with `hasPassword` instead of the hash |
| `POST` | `/users` | `{email, role?}`: invite an approved account and mail it a sign-in link, in one action. Returns `{user, emailed, linkExpiresAt?, emailError?}`: a failed send does **not** roll the account back, because the account is the durable half and the link can be re-sent. **`409`** email exists |
| `POST` | `/users/:id/approve` | Approves and mails a "your account is ready" link, same `{emailed, …}` fields. **`409`** unknown or already approved |
| `POST` | `/users/:id/magic-link` | Re-send a sign-in link; the recovery path for an invite that went to spam or expired. **`404`** unknown, **`409`** not approved yet, **`503`** no mailer, **`502`** the send failed |
| `DELETE` | `/users/:id/discord` | Unlink Discord. Self-service, or an OWNER for anyone (`403` otherwise). **`409`** nothing linked, or Discord is the only way into that account (no password and no mailer) |
| `POST` | `/users/:id/role` | `{role}`. **`409` cannot demote the last owner**; `404` unknown |
| `DELETE` | `/users/:id` | **`409` cannot delete the last owner**. Sessions cascade, so deletion is also a logout |
| `POST` | `/users/:id/password` | `{password}`, min **12** chars. Self-service, what an account that got in by emailed link does first, or an owner setting one for someone else, which is how the seeded owner gets its first password after logging in with the break-glass token. Retires every outstanding sign-in link for that account and mails a "your password was changed" notice. **`403`** if you are neither the owner nor that user; `400` on a short password; `404` unknown |
| `GET` | `/sessions` | Live sessions only; id, actor, email, role, createdAt, expiresAt |
| `DELETE` | `/sessions/:id` | Force logout. `404` unknown or already revoked |
| `GET` | `/settings/signups` | `{enabled}` |
| `POST` | `/settings/signups` | `{enabled}`: the Discord self-signup gate, off unless turned on |

`routes/users.ts:41-143`, tested at
`test/integration/dashboard.test.ts:184`.

### Permissions

What a role means on this deployment, and what one account may do beyond — or
short of — its role.

Every **change** needs `OWNER` + `users:admin`, the same double gate as account
administration: widening a role is granting authority, and an API token is never
`OWNER`, so no token can widen the role its own holder sits in. Reading the
taxonomy and the role baselines needs only `users:admin`, because it names no
account and grants nothing — that is what keeps the Discord bot, which can never
be `OWNER`, able to answer "what does CONTRIBUTOR mean here?".

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/permissions` | `{scopes: [{name, description}], presets, tunableRoles, roles}`. Each role reports `scopes`, the shipped `defaults`, `custom`, `tunable`, and who last changed it. `users:admin` only |
| `PUT` | `/permissions/roles/:role` | `{scopes}` — replaces the baseline wholesale. **`400`** for `OWNER` or an unknown role, **`400`** `{error, invalid}` on an unknown scope |
| `DELETE` | `/permissions/roles/:role` | Drop the override and track the shipped default again. **`409`** already on the default |
| `GET` | `/users/:id/permissions` | `{role, baseline, extraScopes, deniedScopes, effective, tunable}` — the parts the answer was built from, so "why can they do that?" needs no mental arithmetic. **`404`** unknown |
| `PUT` | `/users/:id/permissions` | `{extraScopes, deniedScopes}`, both replaced wholesale. **`409`** for an `OWNER` (they hold everything regardless), **`400`** on an unknown scope or on a scope that is both granted and denied |

**The algebra** (`scopes.ts`, `effectiveScopes`): effective = role baseline ∪
grants, minus denials. With nothing denied the wildcard survives intact, so an
`OWNER` keeps holding scopes that future releases add. The moment anything is
denied the set is materialised into a fixed list, which is the only honest
reading of "everything except X".

Grants close **downward** — `runs:write` carries `runs:read` — and denials close
**upward**: denying `runs:read` also denies `runs:write`, because a write would
imply the read straight back. Denying `runs:write` leaves `runs:read` alone,
which is what makes "watch but do not touch" expressible.

Two things are deliberately impossible. `OWNER`'s baseline cannot be edited, and
an `OWNER` account cannot be individually tuned — it is the role that reaches
these routes at all, so a narrowing mistake there would leave a deployment
unable to undo it. Promoting an account to `OWNER` clears its tuning outright,
so a later demotion cannot resurrect a forgotten denial.

Changes reach sessions that are **already open**, within a few seconds: scopes
are recomputed per request from the session's account row rather than frozen at
login. Nobody has to sign in again, and a revoked permission is never left
outstanding.

`routes/permissions.ts`, `store/permissions.ts`, tested at
`test/integration/permissions.test.ts` and `test/unit/permissionTuning.test.ts`.

---

## Session and OAuth

These are the authentication step, so they sit outside the admin scope and carry
their own per-IP limiter (`session.ts:137-141`).

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/v1/admin/session/methods` | none | `{discord, signups, password, magicLink}`: which login methods to render. Safe to leave open: everything it reports is visible from the login page anyway |
| `POST` | `/api/v1/admin/session` | none; **this is** the authentication | Two shapes. `{token, actor?}` is the break-glass path and attaches a session to the seeded owner. `{email, password}` is the normal path. Sets an `HttpOnly; SameSite=Strict` cookie and returns `{ok, actor, role, email, expiresAt}` |
| `GET` | `/api/v1/admin/session` | cookie | Who am I → `{actor, role, userId, email, hasPassword, discordLinked, discordUsername, magicLink, discordAvailable}`. The cookie is HttpOnly, so a reloaded page has to ask. **`401`** with no active session |
| `DELETE` | `/api/v1/admin/session` | cookie | Revokes the session row and clears the cookie. Always `200` |
| `POST` | `/api/v1/admin/session/magic-link/request` | none | `{email}` → mails a single-use sign-in link. Always **`202`** with one message, whatever the address turns out to be; anything else is an account-enumeration oracle. **`503`** when no mailer is configured; **`429`** per-IP (5 burst, 1/2min) or per-address (3 burst, 1/5min) |
| `POST` | `/api/v1/admin/session/magic-link` | none; **this is** the authentication | `{token}` → issues a session, same cookie as above, and returns `{ok, actor, role, email, userId, hasPassword, expiresAt}`. A `POST` rather than the `GET` the email links to, because the secret rides in the URL fragment (see below). **`401`** unknown / used / expired / superseded, **`403`** account awaiting approval, **`429`** rate limited |
| `GET` | `/api/v1/admin/oauth/discord/start` | none | Redirects to Discord with a signed, `SameSite=Lax`, 10-minute state nonce carrying a `login` intent. **`503`** when no OAuth app is configured; **`429`** rate limited. Answers HTML, not JSON |
| `GET` | `/api/v1/admin/oauth/discord/link` | cookie | Same round-trip with a `link` intent bound to the signed-in account, so a Discord identity can be attached to an account whose email differs. **`401`** with no session; **`503`**/**`429`** as above |
| `GET` | `/api/v1/admin/oauth/discord/callback` | none, or cookie for a link | Completes the exchange. For `login`, issues a session and `302`s to `/`. For `link`, attaches the identity and answers a `200` notice. HTML on every failure: `400` missing code or replayed/expired state, `401` the session ended mid-link, `403` no verified email / signups closed, `409` that Discord account is on another operator account, `502` exchange failed, `200` "awaiting approval" |

The link's secret travels in the URL **fragment**
(`https://<dash>/#token=<secret>`), which is never sent to a server: it stays
out of request logs, proxy logs and `Referer` headers, and a mail-scanner that
fetches the URL cannot burn a single-use token before its owner clicks it. The
dashboard reads the fragment and posts it to the endpoint above. The intent in
the OAuth state cookie is covered by the same HMAC as the nonce, so a login
round-trip cannot be finished as a link, or the reverse.

Failure statuses on the password path: **`401`** with one message for both "no
such account" and "wrong password"; **`403` account is awaiting approval**;
**`429` too many login attempts**; **`503`** when `ADMIN_TOKEN` is unset and a
token login was attempted. Every rejection is audited with the source IP.

The session cookie is `publoader_session` = `${sessionId}.${secret}`; the
`admin_sessions` row is the authority, which is what makes one session revocable
without signing everyone else out (`store/adminUsers.ts:190-210`). `Secure` is
inferred per request from `x-forwarded-proto`, or forced with
`SESSION_COOKIE_SECURE=true`.

Discord identity resolution is deliberately ordered; a linked `discord_id` is
the account; otherwise a **verified** email may claim an existing account;
otherwise it is a gated signup that always lands unapproved
(`api/oauth.ts:49-105`, unit-tested at
`test/unit/discordOauth.test.ts`).

---

## GitHub push webhook

`src/core/api/routes/webhooks.ts`. Builds and publishes extension bundles
from a push. Full setup, and the argument for publishing from CI instead, in
[webhooks.md](webhooks.md).

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/webhook` | `X-Hub-Signature-256` HMAC |
| `POST` | `/api/v1/webhooks/github` | same; the alias to configure for anything new |

**Deliberately unauthenticated in the platform's own terms**: there is no bearer
token and no session, because GitHub cannot present one. The HMAC *is* the
credential, and it is verified over the **raw request bytes** before anything else
looks at the payload; which is why this scope replaces the server's JSON parser
with a buffer parser, inside an encapsulated plugin so no other route is affected
(`webhooks.ts:59-67`).

Per-IP budget: 10 bursts refilling one every 10 s. GitHub sends one request per
push and does not retry automatically, so that is generous for the legitimate
caller and useless for hammering.

| Status | Meaning |
| --- | --- |
| `200` | published, or a `ping` (`{ok: true, pong: true}`), or nothing to do |
| `202` | delivery accepted and deliberately ignored, with the reason; a non-push event, an unrecognised repo, a branch that is not the default |
| **`207`** | **partial success**: some extensions published, some failed or were skipped. The operator sees at a glance from GitHub's delivery list that something needs attention, without a total failure hiding what did publish |
| `400` | empty body, or invalid JSON |
| `401` | invalid signature |
| `429` | rate limited |
| `503` | `GITHUB_WEBHOOK_SECRET` is unset; **fails closed**, because an endpoint that triggers a publish must never run without its credential |

A push to the *core* repo is acknowledged with `action: "none"` and an explanation:
core deploys are image-based, so CI builds the image and
`./scripts/publoader prod upgrade <tag>` rolls it out.

Configuration (`src/config.ts`): `GITHUB_WEBHOOK_SECRET` (≥16 chars),
`GITHUB_REPO_OWNER` (default `publoader`), `GITHUB_EXTENSIONS_REPOS`,
`GITHUB_CORE_REPO`, `GITHUB_TOKEN`, `GITHUB_API_URL`, plus `MAP_SYNC_ENABLED`
(default true) and `MAP_SYNC_INTERVAL_HOURS` (default 168) for the series-map
write-back below.

---

## Dashboard

Static assets served from the API process itself, so there is one origin, one
deployment, and no CORS surface (`api/dashboard.ts`).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/` | The dashboard shell; the domain root *is* the sign-in page |
| `GET` | `/dash` | Alias |
| `GET` | `/dash/*` | `app.js`, `style.css`; any other sub-path falls back to the shell so a stale bookmark lands on it |

Only these exact routes are claimed; there is **no root-level wildcard**, so the
dashboard can never shadow `/healthz`, `/readyz`, `/metrics`, or the API
namespaces, and an unknown top-level path still 404s
(`dashboard.ts:48-57`, tested at
`test/integration/dashboard.test.ts:492`).

Assets are served under a strict CSP with no `unsafe-inline`, plus
`x-frame-options: DENY` (`dashboard.ts:27-37`):

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
connect-src 'self'; form-action 'none'; frame-ancestors 'none';
base-uri 'none'; object-src 'none'
```

The page authenticates with the session cookie and holds the admin token in JS
only for the duration of the login submit. It uses `textContent` everywhere, never
`innerHTML`, so operator-supplied strings cannot become script.

Its twelve views, overview, activity, workers, extensions, runs, queues,
untracked, quarantine, audit, system, users, tokens, are **scope-gated**, each tab
declaring the scope it needs (`TABS` and `tabAllowed` in `dashboard/app.js`).
`users` and `tokens` are gated on the **role** rather than a scope, because a
wildcard API token holds `users:admin` but is never `OWNER`. A principal whose
scopes match no tab is told what it holds rather than being shown an empty page,
and the gate reads what the *server* answered about the session rather than what
the login payload claimed; so the page never offers a control that 403s.

---

## Metrics and health

Unauthenticated by design and **internal-network only**: `/metrics` leaks fleet
and queue topology. Keep them on `expose:`, never `ports:`, and block them at the
edge (`server.ts:22-27`, and the WAF notes in
`docker/core/docker-compose.yml`).

`core-api` serves them on its main port (default 8100):

| Path | Meaning |
| --- | --- |
| `GET /healthz` | `{ok: true}`: liveness. The container healthcheck. Says nothing about Postgres |
| `GET /readyz` | `{ok: true}`, or **`503` `{ok: false, reason: "database unreachable"}`**. Deliberately *not* the container healthcheck: a Postgres blip must not cascade into killing the API |
| `GET /metrics` | Prometheus text, `text/plain; version=0.0.4` |

The other three core services have no HTTP API but do have their own
prom-client registry, so each runs the same three routes on its own port
(`core/observability/metricsServer.ts`). Override with `METRICS_PORT`; a port
that cannot be bound is a **boot failure**, because a service that silently
failed to expose its metrics is indistinguishable from a healthy one.

| Service | Default port |
| --- | --- |
| `core-api` | 8100 (its main port) |
| `core-scheduler` | 8101 |
| `core-processor` | 8102 |
| `core-uploader` | 8103 |

Workers expose nothing at all. They are outbound-only; liveness is the mtime of a
heartbeat file the entry point refreshes on work-related traffic with the core
(`core/observability/heartbeat.ts`, `docker/worker/Dockerfile`).

### Exported metrics

`src/metrics.ts`.

| Metric | Type | Labels |
| --- | --- | --- |
| `publoader_jobs_created_total` | counter | extension, kind |
| `publoader_jobs_leased_total` | counter | extension |
| `publoader_jobs_succeeded_total` | counter | extension |
| `publoader_jobs_requeued_total` | counter | extension, reason |
| `publoader_jobs_dead_letter_total` | counter | extension |
| `publoader_lease_expiries_total` | counter | extension |
| `publoader_envelopes_received_total` | counter | extension |
| `publoader_envelopes_committed_total` | counter | extension |
| `publoader_envelopes_superseded_total` | counter | extension |
| `publoader_envelopes_quarantined_total` | counter | extension, reason |
| `publoader_md_uploads_total` | counter | outcome |
| `publoader_job_duration_seconds` | histogram | extension |
| `publoader_job_queue_depth` | gauge | state |
| `publoader_upload_tasks` | gauge | kind, state |
| `publoader_workers` | gauge | status |
| `publoader_runs` | gauge | state |
| `publoader_result_submissions` | gauge | state |
| `publoader_dead_letter_jobs` | gauge |; |
| `publoader_oldest_pending_job_age_seconds` | gauge |; |
| `publoader_oldest_ingesting_run_age_seconds` | gauge |; |
| `publoader_artifact_rows` | gauge |; |
| `publoader_artifact_bytes` | gauge |; |
| `publoader_scheduler_last_tick_timestamp_seconds` | gauge |; |

Two things worth knowing before you alert on these.

**The scheduler gauge is a timestamp, not a lag.** A "seconds since last tick"
gauge set by the ticking process cannot report the failure it exists to report;
it reads 0 while healthy and *also* 0 forever once the loop wedges, because the
only code that could raise it is the code that stopped running. Recording the
timestamp moves the subtraction to the scraper, which is still running when the
scheduler is not (`metrics.ts:19-33`):

```promql
time() - publoader_scheduler_last_tick_timestamp_seconds > 120
```

`publoader_scheduler_lag_seconds` is gone from the registry.

**Depth gauges are seeded to zero for every label value** before the counts are
applied, so an alert on `> 0` is on a series that actually exists and a queue
that drained does not keep reading its last value
(`core/observability/inventory.ts:8-21`).

---

## See also

| Document | For |
| --- | --- |
| [glossary.md](glossary.md) | what the nouns in these payloads mean |
| [data-model.md](data-model.md) | the tables behind each endpoint |
| [architecture-guide.md](architecture-guide.md) | the lifecycle these endpoints implement |
| [ipc-to-api-mapping.md](ipc-to-api-mapping.md) | how each legacy IPC command maps here |
| [bot.md](bot.md#5-command-reference) | the Discord bot's command-to-endpoint mapping |
| [operations.md](operations.md#monitoring-quick-reference) | which metric to alert on |
