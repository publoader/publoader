# Security and trust model

Date: 2026-07-29
Scope: the platform as implemented on this branch (v1).

The design problem: **run community-supplied code, on machines the operator
does not control, without giving those machines the ability to write to
MangaDex, read the database, or see any credential.**

The answer is a split of authority, not a sandbox:

- Workers **execute** extensions and **propose** results.
- The core **validates** every proposal against a manifest it holds itself, and
  is the only thing that can **act** — the only process that writes to Postgres
  and the only process that writes to MangaDex.

A worker's maximum achievable outcome is therefore "submit a plausible lie that
survives validation and MangaDex-side deduplication". Everything below is
either enforcing that ceiling or lowering it.

---

## 1. Control matrix

One section per component. "Trust level" is what the system assumes about it,
not how much you personally trust the person running it.

### 1.1 Public edge — `publoader.ardax.dev` / cloudflared

| | |
|---|---|
| **Assets** | The DNS name and TLS termination; the tunnel token, which *is* the identity that serves that hostname. |
| **Trust level** | Untrusted network position, trusted software. It is internet-facing by definition and gets exactly one hop. |
| **Authn/authz** | None of its own. It authenticates nothing and authorises nothing; it forwards to `core-api`, which does both. The tunnel token authenticates the tunnel *to Cloudflare*. |
| **Network exposure** | The only ingress path into the whole system. Nothing else is published on the host — no `ports:` on any core service. |
| **Hardening** | `read_only`, `cap_drop: ALL`, `no-new-privileges`, 256 MB cap, attached only to the `edge` network so it has **no route to Postgres**. Cloudflare-side WAF rules are load-bearing, not optional: block `/metrics`, `/healthz`, `/readyz` from the internet; hard rate limit `/api/v1/worker/enroll`; allow only `/api/v1/worker/*` and `/api/v1/admin/*`. |
| **Residual risks** | Cloudflare is a trusted third party with plaintext visibility — the worker and admin bearer tokens transit it. A stolen `TUNNEL_TOKEN` lets an attacker serve the hostname (phish workers into enrolling against a fake core, harvest worker tokens). Image tracks `latest`, so it changes without review. |

### 1.2 core-api

| | |
|---|---|
| **Assets** | `ADMIN_TOKEN` (in memory); the database connection; every worker token hash; every result envelope before validation. |
| **Trust level** | Fully trusted. It is the policy decision point. |
| **Authn/authz** | Two strictly separated bearer audiences (`src/core/api/auth.ts`): `pw_…` worker tokens authorise **only** `/api/v1/worker/*`; the admin token authorises **only** `/api/v1/admin/*`. There is no shared session and no token that does both. Comparison is `timingSafeEqual`, with a burned comparison on length mismatch so length is the only observable difference. Worker tokens are sha256-hashed at rest and looked up by hash; the admin token is compared directly. |
| **Network exposure** | `expose: 8100` only — reachable from the compose network (i.e. from cloudflared) and nowhere else. |
| **Hardening** | `read_only` + noexec/nosuid tmpfs, `cap_drop: ALL`, `no-new-privileges`, non-root uid 10001, 768 MB cap. Per-IP rate limiter on enrol, per-worker limiter on the worker scope, per-IP limiter on admin. Body size caps on envelopes, artifacts, and bundles (64 MB). Fastify JSON Schema on transport, strict zod on payloads. Fails **closed**: no `ADMIN_TOKEN` → the admin API answers 503, not 200. |
| **Residual risks** | Single admin token, unscoped — it grants bundle publishing as well as pause/resume, and the bot holds it while every dashboard operator types it. A bug in envelope handling is reachable pre-validation by any enrolled worker. `/metrics` is unauthenticated and relies on the edge to block it; if the WAF rule is missing, fleet and queue topology leak. |

### 1.3 Admin surface — `/api/v1/admin/*`

| | |
|---|---|
| **Assets** | Every control operation: trigger runs, publish bundles, pause, drain/revoke workers, mint enroll tokens, change removal mode, edit the tracked-manga mapping and extension override options (the config authority), and approve untracked series into new MangaDex titles. |
| **Trust level** | Operator-only. Effectively equivalent to shell access to the control plane. |
| **Authn/authz** | Single bearer token. `X-Actor` header is **attribution, not authentication** — it is attacker-controlled and only meaningful because possession of the token is already proven. |
| **Network exposure** | Through the tunnel, same as everything else. |
| **Hardening** | Every mutating route writes an `AuditEvent` with actor, action, subject and detail. Extension names are regex-validated (`^[a-z0-9_]+$`) at the route before reaching any store. Removal mode is enum-validated. Rate limited. |
| **Residual risks** | No scopes and no per-client tokens: the Discord bot holds the same credential you do, so a compromised bot can publish a bundle, repoint a tracked-manga mapping, or approve a title into existence. No overlap window on rotation — changing the token breaks every client at once. `bundle publish` accepts any zip that passes manifest validation, so admin-token compromise is code execution on every worker. Repointing a `tracked_manga` mapping is the quietest destructive action available: it makes future chapters upload to the *wrong MangaDex title*, with nothing in the upload path to notice. |

### 1.3a Operator dashboard — `/`, `/dash`, and the session/account endpoints

| | |
|---|---|
| **Assets** | Operator accounts (`admin_users`) with scrypt password hashes, bound MangaDex identities, and sealed per-operator MangaDex client secrets; live sessions (`admin_sessions`); the admin token in transit during break-glass login; every read the admin API exposes, rendered in a browser. |
| **Trust level** | Operator-only. An `ADMIN` account is §1.3 authority; an `OWNER` additionally controls who else has it. |
| **Authn/authz** | Three ways in, all issuing the same kind of session: (a) `ADMIN_TOKEN`, constant-time compared, bound to the seeded owner account — break-glass, and owner-equivalent by definition; (b) email + password, scrypt N=16384 r=8 p=1, `timingSafeEqual`, with one error message for "no such account" and "wrong password" alike; (c) MangaDex, a server-side `password` grant against auth.mangadex.org followed by `/user/me`, admitted only for a bound account, an invited username, or a member of an allowlisted scanlation group. Unapproved accounts are refused at login regardless of credential. Roles are attached by `adminAuthHook` and `requireOwner` gates account management, the signup toggle, and force-logout. |
| **Sessions** | Postgres rows, not self-contained tokens. Cookie is `${sessionId}.${secret}`; only sha256(secret) is stored, so the table is not a credential store and a session id in a log or an admin list view is not a credential. HttpOnly, `SameSite=Strict`, `Secure` when the proxy reports https. **Individually revocable** — logout, `DELETE /sessions/:id`, or deleting the account (cascade). Expiry is checked on every request, so shortening `SESSION_TTL_MINUTES` does not require a restart to matter. |
| **CSRF** | Two independent controls: `SameSite=Strict` (the cookie is not sent on any cross-site navigation), and a required `x-requested-with: publoader-dash` header on every cookie-authenticated non-safe method — a value no HTML form, image, or link can produce. Bearer-authenticated writes are exempt: a header the attacker must add is not attached automatically. |
| **Discord OAuth** | `identify email` only; no bot, no gateway, no library — two fetches. CSRF on the callback is a signed, 10-minute, `SameSite=Lax` state cookie (Lax because a Strict cookie would not survive Discord's cross-site redirect back). Matching order is linked `discordId` → **verified** email → gated signup; an *unverified* Discord email can never claim an existing account, which is what stops account takeover by setting an email on a throwaway account. Self-signup is off by default and always produces an unapproved, non-privileged row. Nothing is persisted beyond id, username, email; the code and access token are never logged. |
| **Assets/CSP** | Three static files read once at boot, served at exactly `/`, `/dash`, `/dash/*` — no root-level wildcard, so an unknown top-level path 404s and the dashboard cannot shadow `/metrics`, `/healthz`, `/readyz` or the API namespaces. Sub-paths index a fixed in-memory map by basename; the handler never touches the filesystem, so path traversal has nothing to traverse. `default-src 'self'`, no `'unsafe-inline'`, `connect-src 'self'`, `frame-ancestors 'none'` + `X-Frame-Options: DENY`, `base-uri`/`object-src`/`form-action` `'none'`. The client renders every server value with `textContent` and attaches handlers with `addEventListener`; there is no `innerHTML` and no inline handler, both enforced by an integration test. |
| **Network exposure** | The domain root, through the tunnel. Allow `/` and `/dash` in the WAF allowlist or the page is blocked; gate with Cloudflare Access so a stolen password alone is not enough (`docs/deployment.md` → "Dashboard"). |
| **Hardening** | Login is rate limited per IP (5/min) *before* any comparison, so neither the token nor the password path is a cheap oracle. Every rejection is audited (`session.login.rejected`, `session.login.unapproved`, `session.signup.rejected`), as is every account change. Password hashes never appear in an API response. The last `OWNER` cannot be demoted or deleted. Login fails **closed** when `ADMIN_TOKEN` is unset (503) and the seeded owner has no credentials until an operator sets them. |
| **Residual risks** | The seeded owner starts with **no password**, so until someone sets one the only way in is `ADMIN_TOKEN` — and an attacker who has that token can set the owner's password and gain a durable, less-noticeable credential. Rotating `ADMIN_TOKEN` does not revoke sessions it created; revoke those explicitly. Sessions are bound to nothing — not IP, not user agent — so a stolen cookie replays from anywhere until revoked or expired (12h default). `ADMIN` is not a meaningful containment boundary: it still reaches `bundle publish`, i.e. code execution on every worker. MangaDex account recovery is now an authentication path into the control plane: whoever can take over a linked MangaDex account gets in. The login also handles operators' MangaDex passwords in transit — unavoidable while MangaDex ships no `authorization_code` flow — so a compromised core-api can harvest them, and it stores each operator's personal client secret recoverably (sealed, but with a key derived from `SESSION_SECRET`/`ADMIN_TOKEN` held by the same process). Password reset is deliberately not implemented — an owner sets passwords — so losing every owner credential means falling back to `ADMIN_TOKEN`, and losing that too means editing the database by hand. Without Cloudflare Access the dashboard makes the admin token and operator passwords phishable in a way a CLI-only surface was not. |

### 1.4 core-scheduler

| | |
|---|---|
| **Assets** | Database write access to runs, jobs, and leases. |
| **Trust level** | Fully trusted. No external input at all — it reads the database and the clock. |
| **Authn/authz** | None needed; it has no listener. |
| **Network exposure** | `data` network only. No egress, no ingress. |
| **Hardening** | Same baseline as core-api. Exactly one replica — duplicate schedulers would race on slot creation (though idempotency keys make that safe, it is wasted work). Healthcheck disabled deliberately: a hung loop is detected out-of-band via `publoader_scheduler_lag_seconds`, rather than by mounting `docker.sock` for an autoheal container. That trade is explicit — the socket mount is a larger risk than the failure mode it fixes. |
| **Residual risks** | Single point of liveness: if it wedges, nothing is scheduled and no expired lease is swept. Detection is metric-based, so it depends on someone actually alerting on the lag gauge. |

### 1.5 core-processor

| | |
|---|---|
| **Assets** | MangaDex **read** credentials; database write access to `upload_tasks`. |
| **Trust level** | Fully trusted, but deliberately limited: it reads MangaDex and never writes to it. |
| **Authn/authz** | MangaDex OAuth for reads. |
| **Network exposure** | `data` + `edge`, with public DNS (the LAN resolver sinkholes `mangadex.org`). |
| **Hardening** | Same baseline; 1 GB cap. Consumes only **already-committed** envelopes, so everything it sees has passed schema and policy validation. |
| **Residual risks** | It holds MangaDex credentials that are technically write-capable at the account level — the restriction to reads is code discipline, not an API-enforced scope. A bug here cannot upload, but it can enqueue a wrong `DELETE`/`UNAVAILABLE` task, which the uploader will then act on. That is the most damaging realistic bug in the system, because deletion is not reversible. |

### 1.6 core-uploader — the MangaDex credential holder

| | |
|---|---|
| **Assets** | The MangaDex account: username, password, client id, client secret, and the live session. This is the crown jewel. Also hosts the **title service**, which creates MangaDex titles for untracked series. |
| **Trust level** | Fully trusted and maximally isolated. |
| **Authn/authz** | MangaDex OAuth. It is the **only** process in the entire system permitted to write to MangaDex — chapter uploads and **title creation** alike. |
| **Network exposure** | `data` + `edge`. No listener. |
| **Hardening** | Same baseline; 1.5 GB cap and a larger 1 GB tmpfs for image work; `stop_grace_period: 120s` so an in-flight chapter commit finishes rather than leaving a half-uploaded session. Exactly one replica — the MD upload session is per-account state and two uploaders would clobber each other. Every commit attempt is recorded in `upload_log` before and after, closing the legacy crash window between "MD commit succeeded" and "queue row removed". |
| **Residual risks** | Compromise here is total with respect to MangaDex — it can post, edit, delete, and now *create titles* with anything the account can do. Credentials are long-lived; rotation is manual. There is no second-person approval on destructive operations, so a `DELETE` task that reached the queue *will* be executed. With `auto_create_titles: true`, title creation is likewise unattended — see §2a. |

### 1.7 postgres

| | |
|---|---|
| **Assets** | Everything durable: chapter history, queues, leases, result envelopes, artifacts, bundle zips, worker token hashes, audit trail. |
| **Trust level** | Fully trusted; the single source of truth. Losing it loses the system. |
| **Authn/authz** | Password auth, one application role. |
| **Network exposure** | `data` network with `internal: true` — **no default gateway**, so it has no route to the internet and no route from the tunnel. No published host port. `docker compose exec` is the access path, deliberately not a port. |
| **Hardening** | `no-new-privileges`, 2 GB cap, pinned to a minor tag (`16.9-bookworm`) so a rebuild cannot jump a minor unnoticed, `--locale=C` so a glibc upgrade cannot silently reorder text indexes. Health-gated: `migrate` and every service wait on `pg_isready`. |
| **Residual risks** | One role for all four services — `core-api` has the same grants as `core-uploader`; per-service roles with narrower grants are not implemented. No encryption at rest beyond whatever the host provides. The `pgdata` volume is the entire blast radius of `docker compose down -v`. |

### 1.8 Bundles pipeline

| | |
|---|---|
| **Assets** | The extension code that every worker executes. This is the supply chain. |
| **Trust level** | Trusted at publish time, verified at execution time. |
| **Authn/authz** | Admin token to publish. Content-addressed by sha256 thereafter — no name-based resolution at execution. |
| **Network exposure** | Published via the admin API; served to workers over the worker API, keyed by sha256. |
| **Hardening** | `manifest.json` is required and validated with strict zod at publish (name regex, uuid group id, non-empty `allowed_hosts` and `languages`, entrypoint path shape). `runtime: "python"` bundles are **rejected**; republishing one needs an explicit `x-allow-legacy-runtime: true` header, which is audit-logged on its own before the publish is even attempted. Node bundles must carry an entrypoint that exists in the zip, is non-empty, and has a default export. Extensions are built to a single self-contained ESM file by esbuild **at publish time on the operator's machine**, with dependencies inlined — so the sha256 pins the complete program. Jobs pin `bundleSha256`; a worker that cannot obtain exactly that bundle fails the job with a `POLICY` error rather than running something else. `sourceCommit` is recorded, and publishing is audited. Bundles are immutable and `yanked` rather than mutated. |
| **Residual risks** | **No signing.** sha256 pinning proves the worker ran what the core stored; it does not prove the core stored what the maintainer wrote. Anyone with the admin token can publish arbitrary code to the whole fleet. Sigstore signing is an explicit v2 item. Inlining dependencies at publish removes the old "compromised PyPI package reaches every worker via the image" path, but moves it: whatever npm resolved on the publishing machine is now baked into the artefact, unverified. The gain is that it is *pinned and auditable* — the same sha256 everywhere, reviewable after the fact — rather than re-resolved per image build. |

### 1.9 Worker agent

| | |
|---|---|
| **Assets** | One worker token, scoped to `/api/v1/worker/*` on one deployment. Bundle cache. Job inputs. |
| **Trust level** | **Untrusted.** Assume the host operator is hostile and the extension code is buggy. |
| **Authn/authz** | Bearer `pw_…` token obtained by exchanging a single-use, expiring enroll token. Only the sha256 hash is stored server-side. Individually revocable. Self-rotatable (`POST /api/v1/worker/token/rotate`, atomic swap). Lease operations additionally require the matching `leaseId` — an expired lease cannot renew, complete, or overwrite its successor. |
| **Network exposure** | **Outbound only.** No `ports:`, no `expose:`. Works behind NAT, on a laptop, on a home connection, with no firewall exception and no inbound attack surface. |
| **Hardening** | `read_only` root fs; `/tmp` as `rw,noexec,nosuid,nodev,size=2g` (noexec blocks executing a downloaded payload); `cap_drop: ALL` — a scraper needs no kernel capability; `no-new-privileges`; `mem_limit` = `memswap_limit` so an over-memory extension is OOM-killed promptly instead of thrashing the host disk; `cpus`; `pids_limit: 512` as a fork-bomb ceiling; `nofile` ulimits. `stop_grace_period: 60s`, after which the core's lease sweeper reclaims the job — an abrupt kill loses time, not work. |
| **Residual risks** | The container boundary is the whole isolation story: a container escape is a host compromise on the worker's own host (not the operator's). A hostile worker can fabricate results — see §2. It can also selectively **withhold** results, which is harder to detect than fabricating them. |

### 1.10 Node runner / extension code

| | |
|---|---|
| **Assets** | Nothing of the operator's. It receives the job spec, the pinned bundle, and the extension's data files — that is all. |
| **Trust level** | **Untrusted code, running on an untrusted host.** The worst position in the system, which is why it holds nothing. |
| **Authn/authz** | None. It has no credential and no API access; it communicates by printing one JSON envelope as the last line of stdout. `process.stdout` and `console.*` are redirected to stderr before any bundle code runs, so an extension cannot forge or corrupt that channel by printing. |
| **Network exposure** | Outbound to the manifest's `allowed_hosts` only, via `ctx.fetch`. |
| **Hardening** | Subprocess with a wall-clock timeout (`timeout_seconds`, 60s–6h, default 1h), spawned into its own process group so a timeout kills grandchildren too. **Node permission model** (verified on Node 24): `--permission` with `--allow-fs-read` scoped to the bundle dir, the runner dir and the job workdir, and `--allow-fs-write` scoped to the output dir and workdir — the extension cannot read the worker token, the bundle cache, or anything else on the host, and cannot write outside its own scratch. The same flag denies **`child_process` and `worker_threads`**, closing the "shell out to curl" and "spawn a thread with unguarded fetch" escapes that the Python allowlist could not. `--disallow-code-generation-from-strings` makes `eval`/`new Function` throw, so a bundle cannot fetch code and run it. **Guarded fetch** (`ctx.fetch`) enforces `allowed_hosts` before connecting and re-checks **every redirect hop** (`redirect: "manual"`), so an allowlisted origin cannot launder a request off-allowlist; it also applies a per-host politeness delay, a per-request timeout, bounded retries, and honours `Retry-After`. For partitioned runs the runner filters returned chapters to the segment's manga ids **regardless of what the extension returns**, so overlapping segment output is impossible by construction rather than by extension cooperation. Chapters whose external manga id has no tracked mapping are dropped. Inherits every container control in §1.9. |
| **Residual risks** | **`--permission` has no network component**: it restricts the filesystem and process spawning, not sockets. An extension that opens a raw `net.Socket` or builds its own HTTP request bypasses `ctx.fetch` and its allowlist entirely. Egress control is therefore still a guardrail against accident and casual misbehaviour, not a containment boundary — but the escapes that *were* trivial in the Python design (subprocess, thread, `eval`ed payload, arbitrary file read) are now blocked, and what remains is mitigated by the fact that the extension has nothing worth stealing, holds no ambient credential, and cannot act on its own output: every result passes core-side schema and policy validation, tracked-id filtering, and MD-side dedup before anything is uploaded. Per-extension micro-VM or gVisor isolation remains the documented v2 item. |

### 1.11 Discord bot (API client)

The dashboard is no longer a separate client holding its own copy of the admin
token — it is served by core-api and authenticates per-operator (§1.3a). This
row is now about the bot alone.

| | |
|---|---|
| **Assets** | The admin token. Discord bot token. |
| **Trust level** | Semi-trusted. It holds operator-equivalent credentials but is exposed to user input from Discord. |
| **Authn/authz** | Admin bearer token against `/api/v1/admin/*`; Discord's own auth for its users. It should forward the invoking user in `X-Actor`. |
| **Network exposure** | Outbound HTTPS to the API. |
| **Hardening** | Command allowlisting on the client side is the only control that limits what a Discord user can reach, because the token itself is unscoped. Rate limiting on the admin scope backstops a runaway client. |
| **Residual risks** | **This is the weakest link in v1.** A compromised bot has full control-plane authority including `bundle publish`, i.e. code execution on every worker. The legacy bot additionally mounted `docker.sock`; removing that mount is a decommission-checklist item (`docs/migration-guide.md` stage 7) and should be treated as required, not optional. Per-client scoped tokens are the fix and are not implemented. |

---

## 2. Worker fabrication: threat analysis

**The threat.** An enrolled worker is handed a job, runs whatever it likes (or
nothing), and submits a result envelope of its choosing. It can:

1. Fabricate chapters that do not exist on the publisher's site.
2. Alter real chapters — wrong title, wrong number, wrong language, wrong manga.
3. Point `chapterUrl` at content it controls.
4. Omit chapters that do exist (withholding).
5. On a `CLEAN` run, report an empty chapter list, implying everything was
   removed — the most damaging variant, because removal is not reversible.
6. Replay or delay a stale envelope to overwrite a newer result.

**What actually happens to a fabricated envelope**, in order:

**a. Lease binding.** The submission must carry the `leaseId` currently
associated with the job. A worker whose lease expired and was reassigned cannot
complete or overwrite the successor; its late submission is recorded as
`SUPERSEDED`. It cannot submit for a job it was never leased.

**b. Schema validation.** Strict zod, unknown fields rejected, size-capped.
`ChapterRecord` is closed — there is no passthrough field to smuggle data
through. Malformed input never reaches business logic.

**c. Policy validation against the core's own manifest copy.** This is the
important one: the core validates against **its** stored manifest, not against
anything the worker sends. Enforced:

- Every chapter and manga URL host must match `allowed_hosts` (exact or
  subdomain). This defeats threat 3 outright — a worker cannot point a chapter
  at a domain the maintainer did not declare.
- Languages must be a subset of the manifest's `languages`.
- `mangadexGroupId` must equal the manifest's. A worker cannot upload under a
  different scanlation group.
- Counts must be within caps.

A violation is `QUARANTINED` + audited + metered, and **never touches canonical
state**. There is no approve-and-commit path for a quarantined envelope,
deliberately.

**d. Segment filtering.** For partitioned runs the runner filters to the
segment's manga ids, and the core knows which ids a segment covers. A worker
returning chapters for manga outside its segment is visible.

**e. Commit marker.** A partial unique index — one `COMMITTED` row per job —
makes duplicate and out-of-order deliveries structurally unable to double-ingest.
Losers become `SUPERSEDED`. This closes threat 6.

**f. MangaDex-side deduplication before upload.** The processor fetches the
manga's existing chapters from MangaDex and applies the ported duplicate / edit
/ skip decisions. A fabricated chapter that collides with a real one is a no-op.

**g. Central upload authority.** Even after all of the above, the worker has
only caused a row to appear in `upload_tasks`. The upload itself is performed by
`core-uploader` with the operator's credentials, and is recorded in `upload_log`.

**h. Trust tiers.** Manifests may set `min_trust: TRUSTED`. Jobs for those
extensions are never leased to `COMMUNITY` workers. Private-repo extensions
default to trusted-only.

**i. Audit and attribution.** Every submission carries `workerId`. If something
wrong reaches MangaDex, the worker that proposed it is identifiable, and
`workers revoke` is immediate.

**What remains, honestly:**

- **Plausible fabrication survives.** A chapter with a well-formed number, a
  declared language, a URL on an allowed host, and no MangaDex collision *will*
  be uploaded. Nothing in v1 checks that it corresponds to reality.
- **Withholding is not detected at all.** A worker that returns an empty
  `updatedChapters` looks identical to "the publisher posted nothing".
- **`CLEAN`-run removal is the highest-severity path.** The mitigation shipped
  is structural: a `CLEAN` run is **never processed from partial segments**
  (`requireAllSegments`), because absence of data must never be read as
  deletion. Combined with the default `removal_mode: unavailable` — which marks
  a chapter unavailable rather than deleting it, preserving the card on
  MangaDex — the realistic worst case from a hostile worker is chapters marked
  unavailable, which is recoverable. **Operators running `removal_mode: delete`
  with `COMMUNITY` workers are accepting an unrecoverable-loss risk.** Set
  `min_trust: TRUSTED` on extensions where you run delete mode.

**Documented for v2**: probabilistic verification
re-runs of the same job on a second worker with result comparison; reputation
scoring per worker; canary manga with known-correct expected output.

### 2a. Title creation from worker-reported candidates

The untracked-series pipeline is the one place where worker-reported data can
cause a **new object to be created on MangaDex**, so it deserves its own
analysis.

**The flow.** An extension reports manga in the envelope's `untrackedManga`
array → the processor persists `untracked_manga` rows → the title service
(inside `core-uploader`) creates the MangaDex title → the mapping lands in
`tracked_manga` → a Discord embed announces it.

**Where the authority sits.** Workers **propose candidates; they never create
titles.** `untrackedManga` entries are `MangaRecord`s — id, name, language, url
— and go through the same pipeline as everything else: strict schema
validation, host allowlist on `mangaUrl`, language ⊆ manifest languages, counts
within caps. A violation quarantines the **whole envelope**, so a worker cannot
smuggle a bogus title candidate past validation by attaching it to an otherwise
valid result. Persistence is idempotent on `(extension, mangaId, mangaLanguage)`,
so replaying a result cannot enqueue the same candidate twice, and creation is
a CAS claim (`NEW → CREATING`) so two uploader instances cannot double-create.

**What a hostile worker can achieve.** With `auto_create_titles: false` — the
default — **nothing without a human**. The row sits at `NEW` until an operator
runs `untracked approve`. This is the recommended posture for any extension
that community workers execute.

With `auto_create_titles: true`, a worker that survives policy validation can
cause the operator's account to create MangaDex titles with attacker-chosen
name, language, and source URL. The mitigations are: the manifest opt-in itself
(off by default, per-extension, set by the maintainer not the worker), the host
allowlist on `mangaUrl`, `title_defaults` in the manifest fixing the content
rating / status / original language so those are not worker-controlled, and the
audit + Discord announcement making every creation immediately visible.

**The honest residual risk:** `auto_create_titles: true` plus `COMMUNITY`
workers means unattended title creation driven by untrusted input. Titles are
not silently destructive the way chapter deletion is — they are visible,
attributable, and removable — but cleaning up a few hundred junk titles is slow
manual work. **Pair `auto_create_titles: true` with `min_trust: TRUSTED`**, and
leave it off for anything a community worker executes.

There is also a non-adversarial failure with the same blast radius, and it is
the more likely one: if `tracked_manga` is empty or wrong (a config seed that
did not land — see `docs/migration-guide.md` stage 3a), every series looks
untracked and the pipeline will duplicate the entire catalogue. The operational
guard is watching `untracked list` volume, documented as a runbook in
`docs/operations.md`.

**Rate limiting title creation is not implemented.** A per-run or per-hour cap
on automatic creations, refusing to proceed when the untracked count exceeds a
threshold, would turn the flood case from an incident into a stopped queue.
Recommended before enabling `auto_create_titles` on anything busy.

---

## 3. Secrets inventory

| Secret | Held by | Where it lives | Rotation |
|---|---|---|---|
| `POSTGRES_PASSWORD` | postgres; all four core services via `DATABASE_URL` | `.env` or Docker secret; never leaves the `data` network | `ALTER USER` + `docker compose up -d`. See `docs/operations.md` → "Database password". |
| `ADMIN_TOKEN` | core-api; operator CLI; Discord bot; dashboard operators at login | `.env` / `ADMIN_TOKEN_FILE`; in memory in core-api | `openssl rand -base64 48`, update `.env`, `up -d core-api`, then update every client. **No overlap window** — clients break until updated. When `SESSION_SECRET` is unset this is also the sealing key material, so rotating it makes stored MangaDex client secrets unreadable — operators re-enter them at the next login. Dashboard sessions are DB rows and survive. |
| `SESSION_SECRET` | core-api only | `.env` / `SESSION_SECRET_FILE`; in memory in core-api | `openssl rand -base64 48`, update `.env`, `up -d core-api`. Keys the AES-256-GCM sealing of stored MangaDex client secrets (via HKDF, distinct info string); rotating it makes those unreadable, so operators are asked for the secret again at the next login. Session cookies are DB rows and are unaffected. Optional: HKDF-derived from `ADMIN_TOKEN` when unset, with a boot warning. |
| Operator passwords | The operator; core-api verifies | scrypt `salt:hash` in `admin_users.password_hash`; never returned by any endpoint | An OWNER sets a new one from the Users view (`POST /users/:id/password`, min 12 chars). There is no self-service reset by design. Revoke the operator's live sessions afterwards — a password change does not invalidate them. |
| Dashboard session cookies | One browser each | sha256 of the secret in `admin_sessions.token_hash`; plaintext only in the operator's cookie jar | Individually revocable (`DELETE /sessions/:id`, logout, or deleting the account). Expire after `SESSION_TTL_MINUTES`. |
| Operator MangaDex client secrets | One per dashboard operator; core-api replays them to MangaDex at login | AES-256-GCM sealed in `admin_users.md_client_secret`; never returned by any endpoint | The operator deletes the client at mangadex.org/settings, registers a new one, and enters it at the next login. Each secret is that operator's alone — MangaDex personal clients only work for the account that created them. |
| Operator MangaDex passwords | The operator; core-api forwards them once | Never stored, never logged; held only for the duration of the login request | Changed on mangadex.org. Forwarded to MangaDex's token endpoint because the `password` grant is the only one MangaDex offers third parties today. |
| `MANGADEX_PASSWORD`, `MANGADEX_CLIENT_SECRET` | core-uploader, core-processor only | `.env` / `_FILE`; never in core-api, core-scheduler, or any worker | Pause, update `.env`, restart the two services, revoke the old client MangaDex-side. Revoke **first** if the credential leaked. |
| MangaDex session/refresh token | core-uploader (in memory) | Not persisted to a shared file — unlike the legacy `mdauth.json` | Automatic refresh; forced by restarting core-uploader. |
| `TUNNEL_TOKEN` | cloudflared | `.env` / Docker secret | Regenerate in the Cloudflare Zero Trust dashboard, update `.env`, restart cloudflared. Rotate on any suspicion — it is the hostname's identity. |
| `DISCORD_WEBHOOK_URLS` | core-processor, core-uploader | `.env` | Regenerate the webhook in Discord; update `.env`. |
| Enroll token (`pe_…`) | Operator, then one worker, once | sha256 hash in `enroll_tokens`; plaintext shown once at mint | Single-use and TTL-bounded by construction. Lost token → mint another, let the first expire. |
| Worker token (`pw_…`) | One worker | sha256 hash in `workers.token_hash`; plaintext only on the worker's state volume | Worker-initiated: `POST /api/v1/worker/token/rotate` (atomic). Operator-initiated: `workers revoke` + re-enrol. |
| Discord bot token | Discord bot | Bot's own config | Discord developer portal. |
| GitHub PAT (legacy `pull`) | **Retired** | Was in `config.ini` | **Revoke outright at decommission.** The bundle pipeline does not need it, and it had write-capable scope on the source tree of a running deployment. |

**Convention.** `src/config.ts` honours `<VAR>_FILE` for **every**
variable, so any secret can come from a Docker secret file instead of the
environment — it then never appears in `docker inspect`, in shell history, or
in a compose file committed by accident. Prefer this for anything above.

---

## 3a. Credential inventory and blast radius

§3 covers where each secret lives. This covers what an attacker gets by holding
one — the question that decides which credential a given client should carry.

| Credential | Who should hold it | Authority | Blast radius if leaked | Containment |
|---|---|---|---|---|
| `ADMIN_TOKEN` (root, bearer) | **Nobody, routinely.** Vault-only break-glass. Its only standing use is the dashboard's token-login form when the accounts table is the problem. | `["*"]`, and owner-equivalent by construction — the one credential that reaches account administration and token minting. | Total control plane: mint credentials, delete operator accounts, revoke every worker, publish bundles, trigger destructive `CLEAN` runs. Not MangaDex write access (no MD credential) and not the database. | Not a scope problem — a storage problem. Keep it out of client configs, rotate per `docs/operations.md` → "Admin token", and give clients `pa_…` tokens instead. Rotation has **no overlap window**. |
| Dashboard session, `OWNER` | Named humans | `["*"]` | Everything `ADMIN_TOKEN` reaches, from one browser. | Individually revocable (`DELETE /sessions/:id`), TTL-bounded, HttpOnly + `SameSite=Strict`, and cookie-authed writes need `x-requested-with: publoader-dash`. |
| Dashboard session, `ADMIN` | Named humans | Every scope **except** `users:admin` | Full operational authority: runs, workers, bundles, pause, settings, upload queues. Cannot see or change who else has access, and cannot mint a token. | Same revocation story, plus the role boundary: an ADMIN cannot promote themselves, invite anyone, or read the accounts list. |
| `pa_…` client token | One machine client each | Exactly its stored scopes; never owner-equivalent whatever it holds | Confined to its areas. A `bundles:write` token publishes bundles and does nothing else; a `stats:read` token reads counters and 403s everywhere else. | Per-client naming (the audit log names the token), optional TTL, immediate revocation, `LAST USED` to spot dead credentials. Mint from `SCOPE_PRESETS`. |
| `pw_…` worker token | One worker host each | `/api/v1/worker/*` only — lease, submit, upload artifacts, heartbeat, self-rotate | Its own job stream. Cannot reach `/api/v1/admin/*` **at all** — rejected by audience, before any permission check — and cannot write to MangaDex or the database. See §4. | Hashed at rest; worker-initiated atomic rotation; `workers drain` / `revoke`. Trust tier gates which bundles it can ever see. |
| `pe_…` enroll token | The operator, then one host, once | Exchange for exactly one `pw_…` | One unauthorized worker joins the fleet at the tier the token was minted for. §2 is the analysis of what that worker can then do — lie within a schema, not act. | Single-use and TTL-bounded by construction. Mint `COMMUNITY` unless the host is yours. |
| Operator password | The operator | Authenticates to a session; the session's role is the authority | Whatever that account's role grants. | scrypt at rest, never returned by any endpoint, login rate-limited per IP (5/min), unapproved accounts refused even with the right password. |

**Recommended scope sets** (`SCOPE_PRESETS` in
`src/core/api/scopes.ts`, surfaced by `padmin tokens scopes` and the
dashboard's mint form, so the easy path is the least-privilege one):

| Preset | Scopes | For |
|---|---|---|
| `discord-bot` | `runs:write`, `workers:read`, `extensions:read`, `untracked:write`, `stats:read`, `audit:read` | The bot: trigger runs, approve untracked series, report status. Deliberately no `bundles:write`, no `workers:write`, no `settings:write`. |
| `ci-publisher` | `bundles:write` | A pipeline that publishes extension bundles and must not be able to do anything else. |
| `monitoring` | `stats:read`, `audit:read` | A read-only probe. |
| `worker-enroller` | `enroll:write`, `workers:read` | Automation that provisions worker hosts. |

`<area>:write` implies `<area>:read` — a client that can trigger runs can
obviously look at them, and making callers list both halves invites
over-granting by copy-paste. Nothing else implies anything.

**No token can mint tokens, manage accounts, or take a database dump.** This is
the one invariant to state without hedging, because it is what makes the table
above hold:

- `POST /api/v1/admin/tokens` requires the `users:admin` scope **and** the
  `OWNER` role. API-token principals are assigned `ADMIN` in `adminAuthHook`
  regardless of their scopes, so a `pa_…` token minted with `["*"]` still gets
  403 there. Minting can grant any scope, so it is privilege escalation and
  stays a human, owner-level action.
- The same double gate covers `/api/v1/admin/users*`, `/sessions*`, and the
  signup toggle: no token can create an operator, promote one, set someone's
  password, or read the accounts list.
- It also covers `GET /api/v1/admin/backup`, the `pg_dump` stream. A dump is not
  a read: it contains every operator password hash, every token hash, and the
  saved MangaDex access and refresh tokens in plaintext, so whoever holds one can
  attack the account table offline and authenticate to MangaDex as the operator.
  It therefore sits at the account-administration bar and not at `settings:write`
  — which the Discord bot holds so it can pause the platform.
- **The scope alone is never the gate; `requireOwner` is.** An OWNER may mint a
  `pa_…` token with `["*"]`, and wildcard satisfies every scope check — so a
  route guarded only by `requireScope("users:admin")` is reachable by a client
  credential. The role is what excludes tokens, because `adminAuthHook` never
  assigns one the OWNER role. Any future route at this bar needs both.
- Consequence: a leaked client credential cannot widen itself, cannot issue a
  second credential to outlive its own revocation, cannot grant a human
  persistent access, and cannot exfiltrate the material that would let it do any
  of those offline. Revoking the row ends it.
- `test/integration/tokens.test.ts` asserts both halves of this (a `["*"]`
  token 403s on mint and on `/users`), and `test/integration/ops.test.ts` does
  the same for the operational routes and for `/backup` (a `["*"]`, a
  `users:admin` and a `settings:write` token all 403). The claim is tested, not
  just documented.

`pg_dump` is deliberately **absent** from the core runtime image, so `/backup`
answers 503 with that fact and a pointer to the host procedure unless an operator
adds `postgresql-client` to it. That is a defensible place to leave it: the
scheduled backup in `docs/operations.md` runs `pg_dump` inside the postgres
container, where the tool belongs, and adding it to a long-lived internet-facing
service is a real increase in that service's reach.

---

## 4. What a worker can and cannot do

Stated explicitly, because this is the question every prospective worker
operator asks and the one the design exists to answer.

**A worker CAN see:**

- Its own job specs: extension name, kind, segment index, and the list of
  external manga ids in its segment.
- The pinned extension bundle and its data files — i.e. the extension's source
  code and its `manga_id_map`. For a private-repo extension this is the
  strongest disclosure in the system, which is why those default to
  `min_trust: TRUSTED`.
- MangaDex manga ids and previously-posted chapter ids for its tracked manga.
  These are public information on MangaDex.
- Its own worker token.
- Whatever the extension fetches from the publisher's site.

**A worker CANNOT see:**

- MangaDex credentials, session tokens, or any ability to authenticate as the
  operator's account.
- The database — no connection string, no route (Postgres is on an `internal`
  network with no gateway), no query endpoint.
- Any other worker's token, jobs, or results.
- The admin token, Discord webhooks, or the tunnel token.
- Bundles for extensions it has not been given a job for.
- The audit log, the quarantine queue, or fleet composition.

**A worker CAN do:**

- Lease jobs for extensions its trust tier permits, execute them, and submit
  result envelopes.
- **Propose** untracked series as title-creation candidates (§2a). Proposing is
  not creating: with the default `auto_create_titles: false` an operator must
  approve each one.
- Upload artifacts (page images) tied to its own leased job, sha256- and
  size-verified.
- Fetch bundles by sha256 for jobs it holds.
- Rotate its own token; heartbeat.
- Fail, stall, or return nothing — losing time, not data.

**A worker CANNOT do:**

- Write to MangaDex. Ever. Not once, not indirectly — chapters or titles.
  `core-uploader` is the only process with that authority.
- Write to Postgres directly.
- Change any configuration. `tracked_manga` and `extension_configs` are the
  config authority and are writable only through the admin API; a worker sees
  the tracked ids for its own job as *input* and cannot alter the mapping.
- Complete, renew, or overwrite a job whose lease it does not hold.
- Cause a second ingestion of a job that already committed (partial unique
  index).
- Escape the manifest: upload under a different group, use an undeclared
  language, or reference a host outside `allowed_hosts`.
- Return chapters for manga outside its segment (shim-side filtering).
- Trigger runs, pause the platform, publish bundles, enrol other workers, or
  reach any `/api/v1/admin/*` route — a `pw_…` token is rejected there by
  audience, not by permission check.
- Reach the operator's host. It has no inbound ports and no route in.

**The one thing to be clear about:** a worker can *lie* within the schema. It
cannot *act*. Everything in §2 is about narrowing what a survivable lie can
achieve, and everything in §1 is about making sure a lie is the only thing on
the table.


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
| [migration-guide.md](migration-guide.md) | Staged Mongo/SQLite to Postgres cutover, with a rollback at every stage |
| [ipc-to-api-mapping.md](ipc-to-api-mapping.md) | Which endpoint replaced each legacy IPC command |
| [bot.md](bot.md) | Discord bot setup, the admin-gating model, and the command reference |
| [webhooks.md](webhooks.md) | Publishing extension bundles from a GitHub push: setup, the signature check, and why CI-side publishing is preferred |
| [../README.md](../README.md) | What publoader is, and the five-minute quickstart |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Branch workflow, definition of done, and the review checklist |
