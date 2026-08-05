# HTTP API reference

Every endpoint the platform serves, derived from the route files. The server is
built in [`src/core/api/server.ts`](../src/core/api/server.ts);
routes live in `src/core/api/routes/`, `session.ts`, `mangadexLogin.ts`, and
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
| `pa_…` token | `api-token` | exactly its stored scopes | `ADMIN` — **never** `OWNER`, whatever it holds |
| Session cookie | `session` | derived from the account's role (below) | the account's role |

Dashboard accounts have three roles (`scopes.ts:103-121`):

| Role | Scopes |
| --- | --- |
| `OWNER` | `["*"]` |
| `ADMIN` | every scope except `users:admin` — an admin cannot promote anybody |
| `CONTRIBUTOR` | `extensions:read`, `tracked:read`, `tracked:append`, `untracked:read`, `untracked:write`, `stats:read` — enough to curate the series map and work the untracked queue, and nothing else. No runs, workers, credentials, settings, or bundles. This is the role to hand a community contributor |

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
| Session | remote IP | 5 | 5/min | `POST /admin/session`, `POST /admin/session/mangadex` |

### Shared response conventions

Every response carries `x-request-id`, `x-content-type-options: nosniff`,
`referrer-policy: no-referrer`, and `cache-control: no-store`
(`server.ts:65-70`). Errors are `{"error": "<message>"}`; a 5xx is always the
literal string `"internal error"` — stack traces and internals are never
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
unauthenticated write endpoint in the system — rate-limit it at the edge as well
(`docker/core/docker-compose.yml`, the WAF notes on `cloudflared`).

Request:

```json
{ "enrollToken": "pe_…", "name": "worker-01",
  "extensions": ["mangaplus"], "agentVersion": "1.0.0" }
```

`extensions` and `agentVersion` are optional; `name` is truncated to 128 chars.

| Status | Meaning |
| --- | --- |
| `201` | `{ "workerId": "<uuid>", "workerToken": "pw_…", "trust": "COMMUNITY" }` — the token is shown **once** |
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

**`409 { "error": "lease not current" }`** — the lease expired or was reassigned.
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

The four judged outcomes — all **200**, because the worker's delivery duty is
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

The nineteen valid scopes (`api/scopes.ts:20-45`):

| Area | Scopes |
| --- | --- |
| runs | `runs:read` `runs:write` |
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

`tracked:*` is deliberately split three ways, and the middle one is the point.
`tracked:append` can create mappings that do not exist yet — the worst case is a
wrong *new* mapping, which is visible and reversible — while `tracked:write` is
needed to repoint or delete an existing one, because un-tracking a series silently
stops its uploads. That is what makes the series map safe to delegate.

A missing scope is **403** and names what was needed, because the caller already
proved it holds a valid credential and "which scope do I need?" is the only
useful next question (`auth.ts:169-191`):

```json
{ "error": "missing scope: bundles:write", "held": ["runs:write", "stats:read"] }
```

Shipped presets (`scopes.ts:123-146`) — note `discord-bot` **includes**
`settings:write`, deliberately, because pausing the platform from chat during an
incident is the most valuable thing the bot does:

| Preset | Scopes |
| --- | --- |
| `discord-bot` | `runs:write`, `workers:read`, `extensions:read`, `untracked:write`, `settings:write`, `stats:read`, `audit:read` |
| `ci-publisher` | `bundles:write` |
| `monitoring` | `stats:read`, `audit:read` |
| `worker-enroller` | `enroll:write`, `workers:read` |
| `curator` | `extensions:read`, `tracked:append`, `untracked:read`, `untracked:write` |

`bundles:read` is defined but no route currently requires it — bundle bytes are
served to workers, not to admin clients.

### Worker fleet

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| `POST` | `/enroll-tokens` | `enroll:write` | `{trust?, note?, ttlHours?}` (default `COMMUNITY`, 24 h, max 720) → `{token, expiresAt}`. Shown once |
| `GET` | `/workers` | `workers:read` | `{workers: [{id, name, status, trust, extensions, lastHeartbeatAt, agentVersion, createdAt}]}` — never the token hash |
| `POST` | `/workers/:id/drain` | `workers:write` | → `{ok, status: "DRAINED"}`; `404` unknown worker |
| `POST` | `/workers/:id/activate` | `workers:write` | → `ACTIVE` |
| `POST` | `/workers/:id/revoke` | `workers:write` | → `REVOKED`; the token stops authenticating immediately |

`routes/admin.ts:53-97`.

### Runs and jobs

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| `POST` | `/runs` | `runs:write` | `{extension, kind?, idempotencyKey?}`. `kind` defaults to `FORCE`. `201` created / `200` already existed → `{runId, created, segments}`. **`409` platform is paused**; `404` no bundle published for that extension |
| `GET` | `/runs` | `runs:read` | `?limit=1..200` (25), `?extension=` |
| `GET` | `/runs/:id` | `runs:read` | Run plus all its jobs; `404` unknown |
| `POST` | `/jobs/:id/cancel` | `runs:write` | → `{ok, result: "cancelled"\|"flagged"}`. `PENDING` cancels immediately; a live lease is flagged and the worker aborts on its next renew. **`409`** if the job is in neither state |
| `POST` | `/jobs/:id/retry` | `runs:write` | Replay a dead letter with a fresh attempt budget. **`409` job is not dead-lettered** |
| `GET` | `/dead-letter` | `runs:read` | Up to 100 `DEAD_LETTER` jobs, newest first |
| `GET` | `/quarantine` | `runs:read` | Up to 100 quarantined submissions — id, jobId, workerId, rejectReason, createdAt. **The envelope body is not returned** |

`routes/admin.ts:100-187`. There is no run-level cancel; cancel the jobs.

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
| `GET` | `/schedules` | `extensions:read` | `{defaults, overrides}` — manifest defaults and DB overrides, separately |
| `PUT` | `/schedules/:name` | `extensions:write` | `{hour: 0..23, minute: 0..59, day?: 0..6}`, UTC, `day` 0 = Monday |
| `DELETE` | `/schedules/:name` | `extensions:write` | → `{ok, removed}` |
| `GET` | `/extensions/:name/tracked` | `tracked:read` | Every publisher-id → MangaDex-title mapping |
| `PUT` | `/extensions/:name/tracked` | `tracked:append` | `{mangaId, mdMangaId}`; upsert, records the actor as `source`. **403** when the mapping already exists and points somewhere else and the caller lacks `tracked:write` — repointing a series is an edit, and a silent one |
| `POST` | `/extensions/:name/tracked/batch` | `tracked:append` | Bulk curation — see below |
| `DELETE` | `/extensions/:name/tracked/:mangaId` | `tracked:write` | → `{ok, removed}`. Does **not** touch MangaDex |
| `GET` | `/extensions/:name/config` | `extensions:read` | `{extension, overrideOptions}` |
| `PUT` | `/extensions/:name/config` | `extensions:write` | `{overrideOptions: {…}}` — replaces wholesale |
| `GET` | `/removal-mode` | `settings:read` | `{mode, validModes}` |
| `POST` | `/removal-mode` | `settings:write` | `{mode: "unavailable"\|"delete"}` |

`routes/admin.ts:208-280`, `387-470`.

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

Rows are judged and reported **individually** — a contributor pasting 200 lines
needs to know which three were wrong, not that "the batch failed". The response
carries `parseErrors` plus a per-row outcome. `remove` still requires
`tracked:write`, per the same append-versus-edit rule as the single-row route.

### Bundles

| Method | Path | Scope |
| --- | --- | --- |
| `POST` | `/bundles` | `bundles:write` |

Body is the raw zip with `content-type: application/zip`; limit **64 MiB**.
Optional headers `x-source-commit` (provenance) and `x-allow-legacy-runtime: true`
(the audited escape hatch for republishing a pre-v2 Python bundle — requesting it
is logged even if the publish then fails for another reason).

| Status | Meaning |
| --- | --- |
| `201` | newly published → `{extension, version, sha256, created: true}` |
| `200` | identical content already published (`created: false`) |
| `400` | body was not a zip |
| `422` | missing or invalid `manifest.json`, invalid zip, or the bundle was rejected — a Python runtime without the override, a missing/empty entrypoint, a non-`.mjs`/`.js` entrypoint, or an entrypoint with no default export |

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
| `GET` | `/upload-tasks` | `runs:read` | `?kind=`, `?state=`, `?limit=1..500` (100) → `{tasks, counts}`. **`chapter` is deliberately not returned** — large, worker-supplied, and the dedupe key identifies the chapter well enough for triage. `400` on a bad filter value |
| `POST` | `/upload-tasks/:id/retry` | `runs:write` | `FAILED`/`DEAD_LETTER` → `PENDING` with `attempt` reset to 0. `404` unknown; **`409`** naming the actual state otherwise |
| `POST` | `/upload-tasks/:id/cancel` | `runs:write` | `PENDING`/`FAILED`/`DEAD_LETTER` → `DONE` with the reason in `lastError`. **`409` for a `LEASED` task** — an uploader owns it mid-flight and forcing it would race into a duplicate upload or a lost result |
| `POST` | `/upload-tasks/requeue-stale` | `runs:write` | Manual lease sweep → `{ok, requeued}` |

`routes/ops.ts:103-217`, tested at `test/integration/ops.test.ts`.

### MangaDex session

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| `GET` | `/mangadex/auth` | `settings:read` | `{hasAccess, hasRefresh, expiresAt, expired, expiresInSeconds}`. **The tokens themselves are never returned**; `exp` is read from the JWT without verifying the signature, and an unparseable token reports unknown expiry rather than `expired: true` |
| `POST` | `/mangadex/auth/clear` | `settings:write` | Forgets the saved session so the next call re-authenticates from configured credentials. Does **not** revoke anything MangaDex-side |

`routes/ops.ts:229-260`.

### Observability

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| `GET` | `/stats` | `stats:read` | `{jobs: {state: n}, uploadTasks: [{kind, state, count}], workers: {status: n}, quarantined, paused}` |
| `GET` | `/errors` | `runs:read` | `?limit=1..200` (50). One time-ordered feed merging dead-lettered jobs, failed/dead-lettered upload tasks, and quarantined submissions → `{errors: [{at, kind, subject, message, id}]}`. Each source is queried at the full limit before merging, so a burst in one cannot be hidden behind old rows from another |
| `GET` | `/audit` | `audit:read` | `?limit=1..500` (100) → `{events}` |

`routes/admin.ts:432-453`, `routes/ops.ts:274-338`.

### Client tokens

All four routes require **`users:admin` *and* the `OWNER` role**, so no API
token can mint or widen another (`routes/tokens.ts:24-29`).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/tokens/scopes` | `{scopes, presets}` — so the dashboard never hardcodes the taxonomy |
| `GET` | `/tokens` | Metadata only; the hash is stripped, and there is no path that returns a secret |
| `POST` | `/tokens` | `{name, scopes: [1..32], ttlDays?: 1..3650}`. `201` → `{id, name, scopes, expiresAt, token}` — **the token is shown once**. **`422`** on an unknown scope, with `validScopes` in the body |
| `POST` | `/tokens/:id/revoke` | **`409`** unknown or already revoked |

> `GET /api/v1/admin/tokens/self` does **not** exist. The Discord bot's
> `/whoami` probes for it and treats 403/404/405 as "unknown"
> (`src/bot/apiClient.ts:444`), so the command degrades rather than
> failing — but do not build against that path.

### Accounts and sessions

`OWNER` + `users:admin` for everything here except setting your own password.
Role keeps API tokens out entirely; the scope keeps a future non-owner principal
from inheriting it by accident (`routes/users.ts:34-37`).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/users` | Accounts with `hasPassword` instead of the hash |
| `POST` | `/users` | `{email, role?}` — invite an approved account with no credentials. **`409`** email exists |
| `POST` | `/users/:id/approve` | **`409`** unknown or already approved |
| `POST` | `/users/:id/role` | `{role}`. **`409` cannot demote the last owner**; `404` unknown |
| `DELETE` | `/users/:id` | **`409` cannot delete the last owner**. Sessions cascade, so deletion is also a logout |
| `POST` | `/users/:id/password` | `{password}`, min **12** chars. Self-service, or an owner setting one for someone else — which is how the seeded owner gets its first password after logging in with the break-glass token. **`403`** if you are neither the owner nor that user; `400` on a short password; `404` unknown |
| `GET` | `/sessions` | Live sessions only — id, actor, email, role, createdAt, expiresAt |
| `DELETE` | `/sessions/:id` | Force logout. `404` unknown or already revoked |
| `GET` | `/settings/signups` | `{enabled}` |
| `POST` | `/settings/signups` | `{enabled}` — the MangaDex self-signup gate, off unless turned on, and inert unless `MANGADEX_ALLOWED_GROUP_IDS` names a group |

`routes/users.ts:41-143`, tested at
`test/integration/dashboard.test.ts:184`.

---

## Session and OAuth

These are the authentication step, so they sit outside the admin scope and carry
their own per-IP limiter (`session.ts:137-141`).

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/v1/admin/session/methods` | none | `{mangadex, signups, password}` — which login methods to render. `signups` is true only when `MANGADEX_ALLOWED_GROUP_IDS` is set *and* the toggle is on. Safe to leave open: everything it reports is visible from the login page anyway |
| `POST` | `/api/v1/admin/session` | none — **this is** the authentication | Two shapes. `{token, actor?}` is the break-glass path and attaches a session to the seeded owner. `{email, password}` is the normal path. Sets an `HttpOnly; SameSite=Strict` cookie and returns `{ok, actor, role, email, expiresAt}` |
| `GET` | `/api/v1/admin/session` | cookie | Who am I → `{actor, role, userId, email, hasPassword}`. The cookie is HttpOnly, so a reloaded page has to ask. **`401`** with no active session |
| `DELETE` | `/api/v1/admin/session` | cookie | Revokes the session row and clears the cookie. Always `200` |
| `POST` | `/api/v1/admin/session/mangadex` | none — **this is** the authentication | `{username, password, clientId?, clientSecret?}`. Makes a `password` grant against MangaDex on the caller's behalf (MangaDex has no `authorization_code` flow), resolves `/user/me`, and issues the same cookie and body as `POST /session`. `clientId`/`clientSecret` are needed only until an account has a client stored; they are then kept encrypted |

Failure statuses on the password path: **`401`** with one message for both "no
such account" and "wrong password"; **`403` account is awaiting approval**;
**`429` too many login attempts**; **`503`** when `ADMIN_TOKEN` is unset and a
token login was attempted. Every rejection is audited with the source IP.

Failure statuses on the MangaDex path: **`400`** with `{needsClient: true}` when
the account has no personal API client stored and none was supplied — that flag
is what makes the dashboard reveal the client fields; **`401`** with one message
for bad credentials, a client that is not yours, *and* an unknown account, so
the endpoint never confirms which MangaDex usernames are operators; **`403`**
not in an allowed scanlation group / signups closed / awaiting approval;
**`429`** rate limited.

The session cookie is `publoader_session` = `${sessionId}.${secret}`; the
`admin_sessions` row is the authority, which is what makes one session revocable
without signing everyone else out (`store/adminUsers.ts:190-210`). `Secure` is
inferred per request from `x-forwarded-proto`, or forced with
`SESSION_COOKIE_SECURE=true`.

MangaDex identity resolution is deliberately ordered — a bound `mangadex_id` is
the account; otherwise an **unclaimed** invite for that username may be claimed,
which is what stops a username changing hands on MangaDex from carrying the
account with it; otherwise it is a group-gated signup that always lands
unapproved (`api/mangadexLogin.ts`, unit-tested at
`test/unit/mangadexLogin.test.ts`).

---

## GitHub push webhook

`src/core/api/routes/webhooks.ts`. Builds and publishes extension bundles
from a push. Full setup, and the argument for publishing from CI instead, in
[webhooks.md](webhooks.md).

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/webhook` | `X-Hub-Signature-256` HMAC |
| `POST` | `/api/v1/webhooks/github` | same — the alias to configure for anything new |

**Deliberately unauthenticated in the platform's own terms**: there is no bearer
token and no session, because GitHub cannot present one. The HMAC *is* the
credential, and it is verified over the **raw request bytes** before anything else
looks at the payload — which is why this scope replaces the server's JSON parser
with a buffer parser, inside an encapsulated plugin so no other route is affected
(`webhooks.ts:59-67`).

Per-IP budget: 10 bursts refilling one every 10 s. GitHub sends one request per
push and does not retry automatically, so that is generous for the legitimate
caller and useless for hammering.

| Status | Meaning |
| --- | --- |
| `200` | published, or a `ping` (`{ok: true, pong: true}`), or nothing to do |
| `202` | delivery accepted and deliberately ignored, with the reason — a non-push event, an unrecognised repo, a branch that is not the default |
| **`207`** | **partial success** — some extensions published, some failed or were skipped. The operator sees at a glance from GitHub's delivery list that something needs attention, without a total failure hiding what did publish |
| `400` | empty body, or invalid JSON |
| `401` | invalid signature |
| `429` | rate limited |
| `503` | `GITHUB_WEBHOOK_SECRET` is unset — **fails closed**, because an endpoint that triggers a publish must never run without its credential |

A push to the *core* repo is acknowledged with `action: "none"` and an explanation:
core deploys are image-based, so CI builds the image and
`./scripts/publoader prod upgrade <tag>` rolls it out.

Configuration (`src/config.ts:82-91`): `GITHUB_WEBHOOK_SECRET` (≥16 chars),
`GITHUB_REPO_OWNER` (default `publoader`), `GITHUB_EXTENSIONS_REPOS`,
`GITHUB_CORE_REPO`, `GITHUB_TOKEN`, `GITHUB_API_URL`.

---

## Dashboard

Static assets served from the API process itself, so there is one origin, one
deployment, and no CORS surface (`api/dashboard.ts`).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/` | The dashboard shell — the domain root *is* the sign-in page |
| `GET` | `/dash` | Alias |
| `GET` | `/dash/*` | `app.js`, `style.css`; any other sub-path falls back to the shell so a stale bookmark lands on it |

Only these exact routes are claimed — there is **no root-level wildcard**, so the
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

Its twelve views — overview, activity, workers, extensions, runs, queues,
untracked, quarantine, audit, system, users, tokens — are **scope-gated**, each tab
declaring the scope it needs (`TABS` and `tabAllowed` in `dashboard/app.js`).
`users` and `tokens` are gated on the **role** rather than a scope, because a
wildcard API token holds `users:admin` but is never `OWNER`. A principal whose
scopes match no tab is told what it holds rather than being shown an empty page,
and the gate reads what the *server* answered about the session rather than what
the login payload claimed — so the page never offers a control that 403s.

---

## Metrics and health

Unauthenticated by design and **internal-network only**: `/metrics` leaks fleet
and queue topology. Keep them on `expose:`, never `ports:`, and block them at the
edge (`server.ts:22-27`, and the WAF notes in
`docker/core/docker-compose.yml`).

`core-api` serves them on its main port (default 8100):

| Path | Meaning |
| --- | --- |
| `GET /healthz` | `{ok: true}` — liveness. The container healthcheck. Says nothing about Postgres |
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
| `publoader_dead_letter_jobs` | gauge | — |
| `publoader_oldest_pending_job_age_seconds` | gauge | — |
| `publoader_oldest_ingesting_run_age_seconds` | gauge | — |
| `publoader_artifact_rows` | gauge | — |
| `publoader_artifact_bytes` | gauge | — |
| `publoader_scheduler_last_tick_timestamp_seconds` | gauge | — |

Two things worth knowing before you alert on these.

**The scheduler gauge is a timestamp, not a lag.** A "seconds since last tick"
gauge set by the ticking process cannot report the failure it exists to report —
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
