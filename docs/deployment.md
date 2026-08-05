# Deployment

Operator guide for the distributed platform: the core control plane you run,
and the worker hosts other people run.

Everything here assumes you are at the repository root and that the public URL
is `https://publoader.ardax.dev`. Substitute your own hostname throughout.

- [What you are deploying](#what-you-are-deploying)
- [Prerequisites](#prerequisites)
- [Core bring-up](#core-bring-up)
- [First run](#first-run)
- [Cloudflare tunnel and WAF](#cloudflare-tunnel-and-waf)
- [Dashboard](#dashboard)
- [Enrolling a worker host](#enrolling-a-worker-host)
- [Scaling to multiple workers](#scaling-to-multiple-workers)
- [Upgrading](#upgrading)
- [Draining and revoking workers](#draining-and-revoking-workers)
- [Failover test](#failover-test)
- [Backup and restore](#backup-and-restore)
- [Local end-to-end stack](#local-end-to-end-stack)
- [Troubleshooting](#troubleshooting)

## What you are deploying

Two independently deployed things that only ever meet over HTTPS.

**Core** (`docker/core/`) runs on your host and holds everything
sensitive: PostgreSQL, the MangaDex account, the Discord webhooks, the admin
token. Five containers — `postgres`, `core-api`, `core-scheduler`,
`core-processor`, `core-uploader` — plus a one-shot `migrate` and the
`cloudflared` tunnel. Nothing is published on the host; the tunnel is the only
way in.

**Workers** (`docker/worker/`) run anywhere, including on machines you
do not control. One container that long-polls the core API for a job, runs an
extension under Node's permission model, and posts back a result envelope. A worker holds
a single revocable token and nothing else. It cannot upload to MangaDex — only
`core-uploader` can, and only after the result has passed validation, dedup and
audit. See [security-trust-model.md](security-trust-model.md) for the full trust model.

**There are no configuration files to deploy.** No `config.ini`, no
`config.json`, and no compose service bind-mounts one. Deployment configuration
is environment variables (or Docker secrets — `config.ts` reads any `VAR` from
`VAR_FILE`), and runtime configuration — tracked manga, per-extension override
options, schedules, pause state — lives in Postgres and is changed through the
admin API. This is the main operational difference from the legacy stack: there
is no file on the core host to edit, and nothing to keep in sync across hosts.

## Prerequisites

- Docker Engine 24+ with Compose v2 (`docker compose version`).
- A Cloudflare account with the zone for your hostname, and Zero Trust enabled.
- A MangaDex account with API client credentials.
- Roughly 4 GB RAM and 20 GB disk for the core host. Artifacts (uploaded page
  images awaiting processing) live in Postgres, so disk grows with backlog.

Three things must be committed for the images to build. All three are in the
repository today; each fails the build loudly if one ever goes missing:

| What | Why | If missing |
| --- | --- | --- |
| `pnpm-lock.yaml` | Images install with `--frozen-lockfile` so the dependency tree is the reviewed one | `pnpm install`, commit the lockfile — do not drop the flag |
| `prisma/migrations/` | The `migrate` service runs `prisma migrate deploy`, which applies committed migrations and never infers a schema | `pnpm prisma migrate dev --name init` against a scratch database, commit the result |
| `runner-node/` | The worker image ships `runner.mjs`, which executes extension API v2 bundles | Part of the worker runtime |

The base image is pinned by digest in all three Dockerfiles — the multi-arch
index digest of `node:24-bookworm-slim` as of 2026-07-29, so builds are
reproducible on amd64 and arm64 alike. Refresh it deliberately (on a schedule,
and whenever a base CVE lands) rather than letting a tag drift:

```bash
docker pull node:24-bookworm-slim
docker buildx imagetools inspect node:24-bookworm-slim   # take "Digest:"
# update NODE_IMAGE in all three, together:
#   docker/core/Dockerfile
#   docker/worker/Dockerfile
#   docker/dev/mock-md/Dockerfile
```

A digest that no longer exists fails the build immediately, so a stale pin is a
loud problem rather than a silent one. To build unpinned (development only):
`docker build --build-arg NODE_IMAGE=node:24-bookworm-slim ...`.

One detail to preserve if you ever regenerate migrations: the partial unique
index enforcing one committed result per job cannot be expressed in the Prisma
schema and is applied by hand-written SQL (currently in the
`result_commit_marker` migration). Without it, that invariant is enforced only
by application logic:

```sql
CREATE UNIQUE INDEX result_committed_one_per_job
  ON result_submissions (job_id) WHERE state = 'COMMITTED';
```

## Core bring-up

```bash
cd docker/core
cp .env.example .env
chmod 600 .env
```

Fill in `.env`. Five values are mandatory and the stack refuses to start
without them:

```bash
openssl rand -base64 36   # POSTGRES_PASSWORD
openssl rand -base64 48   # ADMIN_TOKEN
```

plus `MANGADEX_USERNAME` / `MANGADEX_PASSWORD` / `MANGADEX_CLIENT_ID` /
`MANGADEX_CLIENT_SECRET`, and `TUNNEL_TOKEN` (see the next section — bring the
tunnel up first if you would rather not restart later).

`ADMIN_TOKEN` is a root-equivalent credential: it can trigger runs, publish
bundles, mint worker tokens and revoke workers. If it is unset the entire admin
API answers 503, which is the intended fail-closed behaviour. For more than a
single-operator host, use Docker secrets instead — every variable is also
accepted as `<VAR>_FILE`, and the commented `secrets:` block at the bottom of
`docker-compose.yml` shows the wiring.

Then bring it up from the repository root:

```bash
docker compose -f docker/core/docker-compose.yml pull
docker compose -f docker/core/docker-compose.yml up -d
docker compose -f docker/core/docker-compose.yml ps
```

Expected: `postgres` healthy, `migrate` exited 0, four core services up,
`cloudflared` up. Startup order is enforced — `migrate` waits for Postgres to
accept connections, and the four services wait for `migrate` to exit
successfully, so the stack cannot come up half-migrated.

Verify from inside the network (nothing is published on the host, by design):

```bash
docker compose -f docker/core/docker-compose.yml exec core-api \
  node -e "fetch('http://127.0.0.1:8100/readyz').then(r=>r.text()).then(console.log)"
```

`/healthz` means the process is alive; `/readyz` additionally means Postgres is
reachable. Only `/healthz` is the container healthcheck — a database blip must
not cause an orchestrator to kill an otherwise healthy API.

## First run

Export the admin token once so the commands below are readable:

```bash
export ADMIN=https://publoader.ardax.dev
export ADMIN_TOKEN='…the value from .env…'
auth=(-H "authorization: Bearer $ADMIN_TOKEN" -H 'x-actor: your-name')
```

`x-actor` is optional but recorded in the audit log — set it to something that
identifies you, because "who paused the platform" is a question you will ask.

Publish an extension bundle. The API expects the zip itself as the body, reads
`manifest.json` out of it, validates it and stores it content-addressed:

```bash
curl -sX POST "$ADMIN/api/v1/admin/bundles" "${auth[@]}" \
  -H 'content-type: application/zip' \
  -H "x-source-commit: $(git -C ../publoader-extensions rev-parse HEAD)" \
  --data-binary @mangaplus.zip
```

Publishing also seeds that extension's runtime data into Postgres, which is why
there are no config files to deploy alongside it:

- `manga_id_map.json` in the bundle becomes `TrackedManga` rows (inserted with
  `skipDuplicates`, so re-publishing adds new titles and disturbs nothing).
- `override_options.json` becomes the extension's `ExtensionConfig` row
  **create-only** — once it exists, the database wins and a re-publish will not
  overwrite operator edits. Change options through the admin API, not by
  editing a bundle.

Workers receive this configuration in the job payload at lease time, so a
change takes effect on the next run without rebuilding or redeploying anything.

Then confirm what the platform knows:

```bash
curl -s "$ADMIN/api/v1/admin/extensions" "${auth[@]}"   # published bundles
curl -s "$ADMIN/api/v1/admin/stats"      "${auth[@]}"   # queue depths, fleet
curl -s "$ADMIN/api/v1/admin/audit"      "${auth[@]}"   # everything so far
```

Nothing will run until at least one worker is enrolled — the scheduler will
happily create jobs, and they will sit `PENDING` until a worker leases them.
Enrol a worker before triggering a run:

```bash
curl -sX POST "$ADMIN/api/v1/admin/runs" "${auth[@]}" \
  -H 'content-type: application/json' \
  -d '{"extension":"mangaplus","kind":"FORCE"}'
```

## Cloudflare tunnel and WAF

The tunnel is token-managed: it is created and configured in the Cloudflare
dashboard, and the container only needs the token. This matches the legacy
stack.

1. **Zero Trust → Networks → Tunnels → Create a tunnel** (type: Cloudflared).
   Copy the token into `TUNNEL_TOKEN` in `.env`.
2. **Public Hostname** on that tunnel:
   - Subdomain/domain: `publoader.ardax.dev`
   - Service: `HTTP` → `core-api:8100`

   `core-api` resolves over the compose network; no host port is involved.
3. Restart the tunnel if you added the token after bring-up:
   `docker compose -f docker/core/docker-compose.yml up -d cloudflared`

### WAF rules

These are load-bearing, not hardening theatre. The core API is exposed to the
internet so that workers on other hosts can reach it, which also means the
internet can reach it.

**Block the observability endpoints** (Security → WAF → Custom rules). None of
them requires authentication — that is intentional, because they are meant for
the internal network only (see `src/core/api/server.ts`), and `/metrics` leaks
queue depths, fleet size and per-extension failure rates.

```
(http.host eq "publoader.ardax.dev" and
 http.request.uri.path in {"/metrics" "/healthz" "/readyz"})
→ Block
```

**Allow only the known surfaces**, block the rest. Anything else is probing.

```
(http.host eq "publoader.ardax.dev" and
 not starts_with(http.request.uri.path, "/api/v1/worker/") and
 not starts_with(http.request.uri.path, "/api/v1/admin/") and
 not starts_with(http.request.uri.path, "/dash") and
 not http.request.uri.path eq "/")
→ Block
```

The dashboard now answers `/` as well as `/dash`, so the root must be allowed —
see "Dashboard" below. Those are the only browser-facing paths in the system.

**Rate limit enrollment** (Security → WAF → Rate limiting rules).
`/api/v1/worker/enroll` is the only unauthenticated write endpoint in the
system. The API has its own per-IP limiter, but that is a backstop that runs
after the request has already arrived.

```
Match:      http.request.uri.path eq "/api/v1/worker/enroll"
Rate:       5 requests per 1 hour, per IP
Action:     Block for 1 hour
```

**Rate limit the admin API** as a brute-force ceiling on the bearer token:

```
Match:      starts_with(http.request.uri.path, "/api/v1/admin/")
Rate:       60 requests per 1 minute, per IP
Action:     Managed challenge
```

Two settings worth checking while you are in the dashboard:

- **Do not enable Zero Trust Access on `/api/v1/worker/*`.** Workers
  authenticate with bearer tokens and cannot complete an interactive login. You
  *can* put Access with a service token in front of `/api/v1/admin/*`, and it is
  a good idea — it makes the admin token the second factor rather than the only
  one.
- The lease endpoint long-polls for up to `LEASE_POLL_WAIT_SECONDS` (25s by
  default). Keep it comfortably below Cloudflare's ~100s idle timeout; if you
  raise one, check the other.

## Dashboard

`core-api` serves the operator dashboard at the domain root — `https://publoader.ardax.dev/`
lands on the sign-in page, and `/dash` is kept as an alias. Same origin as the
API, so there is no second deployment, no CORS, and no build step. The assets
are static HTML/CSS/JS read once at boot from
`src/core/api/dashboard/` (copied into `dist/` by `pnpm build`).

**This replaces the legacy `publoader-dash` container.** The tunnel's Public
Hostname for `publoader.ardax.dev` points at `core-api:8100` and nothing else;
retire the old dashboard route and container (`docs/migration-guide.md`,
decommission checklist). Everything the dashboard can do, it does through
`/api/v1/admin/*` — there is no privileged back channel.

### Accounts

Operator accounts live in Postgres (`admin_users`), each with a role:

| Role | Can do |
|---|---|
| `OWNER` | Everything, including managing accounts, roles, the signup gate, and force-logout. |
| `ADMIN` | Every control-plane operation, but cannot see or change who else has access. |

`ADMIN_TOKEN` remains the break-glass credential and the bot/CLI credential. It
is owner-equivalent and bypasses the accounts table entirely, which is what
makes it the way back in when the accounts table *is* the problem.

At startup core-api idempotently ensures an `OWNER` account exists for
`DASH_OWNER_EMAIL` (default `iam@ardax.dev`) and logs whether it has
credentials yet. It is seeded **without** a password, so first sign-in is:

1. Open `/`, choose "Use the admin token instead", sign in with `ADMIN_TOKEN`.
2. Go to **Users**, click **Set password** on the owner row (minimum 12
   characters, scrypt-hashed at rest).
3. Sign out and back in with email + password.

From there, **Users → Invite** creates further accounts. An invited account is
approved but has no credentials: they get in either by an owner setting a
password for them, or — when the invite names their MangaDex username — by
signing in with that MangaDex account.

### Sessions

Sessions are rows in `admin_sessions`, not self-contained tokens. The cookie is
`${sessionId}.${secret}` and only a sha256 of the secret is stored, so the
table is not a credential store and a session id appearing in a log or an admin
list view is not a credential.

Because the row is the authority, **an individual session can be revoked**:
**Users → Live sessions → Revoke**, or `DELETE /api/v1/admin/sessions/:id`.
Revocation takes effect on that session's next request. Deleting an account
revokes its sessions by cascade.

```bash
# .env
SESSION_TTL_MINUTES=720      # optional; 12h default
SESSION_COOKIE_SECURE=true   # optional; see below
SESSION_SECRET=$(openssl rand -base64 48)
```

`SESSION_SECRET` keys the encryption of stored MangaDex client secrets. It is
optional — without it the key is derived from `ADMIN_TOKEN` via HKDF and
core-api warns at boot — but set it, or rotating `ADMIN_TOKEN` will make those
stored secrets unreadable and every operator will be asked for theirs again.

The `Secure` cookie attribute is set when the request arrives with
`x-forwarded-proto: https`, which cloudflared sends. Set
`SESSION_COOKIE_SECURE=true` if you front core-api with something that does not.

### MangaDex login

Nothing to register on your side — there is no OAuth application to create,
because MangaDex has not shipped public OAuth clients. See
[dashboard.md](dashboard.md#why-mangadex-login-is-a-form-and-not-a-button) for
what that costs you; the short version is that each operator brings their own
personal API client and their password is posted to core-api.

The one setting is who gets in:

```bash
# .env — scanlation groups whose members may sign in, comma-separated.
MANGADEX_ALLOWED_GROUP_IDS=b1c2d3e4-0000-0000-0000-000000000000
```

Leave it **empty** for the strictest setting: self-signup is refused outright
and the only way in is an OWNER inviting a MangaDex username from **Users →
Accounts**. Set it and members of those groups may self-signup — still
unapproved, and still needing an owner's approval — when the signup toggle in
**Users → Self-signup** is on. That toggle is off by default.

How a MangaDex login is matched, in order:

1. **Already bound** — the MangaDex account UUID is on an account: sign in. A
   username change on MangaDex's side follows the account instead of losing it.
2. **An unclaimed invite for that username** — bind the UUID to it and sign in.
   A row already bound to a *different* UUID is refused, so releasing a
   username on MangaDex cannot hand over the account that held it.
3. **Neither** — self-signup, subject to the group gate above.

The group check applies on every login, not just the first: someone who leaves
the group loses access.

Nothing from MangaDex is persisted beyond the account UUID and username. The
password is forwarded once and discarded, the access token is used for a single
`/user/me` call and dropped, and neither is ever logged.

### Gate it with Cloudflare Access

Still worth doing, even with accounts. Put Zero Trust Access in front of `/`,
`/dash` and `/api/v1/admin/session` so a stolen password is not sufficient:

```
Application:  Self-hosted
Domain:       publoader.ardax.dev
Path:         (leave blank for the whole host, or "dash")
Policy:       Allow → Emails / IdP group of your operators
```

Do **not** put Access in front of `/api/v1/worker/*` — worker agents cannot
complete an interactive login. Putting it in front of all of `/api/v1/admin/*`
also breaks the CLI and the bot unless you issue them service tokens.

### Content security

The assets are served with `default-src 'self'` and no `'unsafe-inline'`, so
there are no inline scripts, no inline event handlers, and no external origins
— a tampered asset cannot phone home, and `connect-src 'self'` means it cannot
exfiltrate what it reads. `frame-ancestors 'none'` plus `X-Frame-Options: DENY`
blocks clickjacking of the destructive buttons.

Cookie-authenticated **writes** additionally require
`x-requested-with: publoader-dash`. `SameSite=Strict` is the first line of CSRF
defence; the header is the second, and it is one no cross-origin form or image
tag can set. Bearer clients are exempt and should not send it.

### Operational controls need no configuration

Everything an operator does day to day is a database row reachable through the
admin API, not an environment variable — so none of it needs a redeploy, and
none of it needs a shell on a container:

| Control | Where it lives | Dashboard | CLI |
|---|---|---|---|
| Pause / resume | `settings.pause_until` | Overview | `padmin pause` / `resume` |
| Schedules, removal mode, per-extension overrides | `schedule_overrides`, `settings`, `extension_configs` | Extensions | `padmin schedules`, `removal-mode`, `ext-config` |
| Tracked manga mapping | `tracked_manga` | Extensions → Configure | `padmin tracked` |
| Upload queue triage | `upload_tasks` | Queues | `padmin queues` |
| Failure feed | `jobs`, `upload_tasks`, `result_submissions` | Errors | `padmin errors` |
| Saved MangaDex session | `settings.mdauth_*` | Overview → MangaDex session | `padmin mangadex auth` / `clear-auth` |
| Client credentials | `api_tokens` | Tokens (OWNER only) | `padmin tokens` |
| Worker fleet | `workers` | Workers | `padmin workers` |

The environment supplies only identity and connectivity — `DATABASE_URL`,
`ADMIN_TOKEN`, `SESSION_SECRET`, the MangaDex credentials, the tunnel token.
Two consequences worth planning around:

- **A `.env` change is never how you fix a stuck queue.** If a runbook says to
  restart a service, it is to restart a *consumer*, not to reload config.
- **`padmin mangadex clear-auth` replaces "redeploy core-uploader to force a
  re-login".** The token pair is persisted in `settings` so a replaced container
  resumes the same MangaDex session; clearing it is what makes the next upload
  authenticate afresh. See `docs/operations.md` → "Clear a bad MangaDex session".

Container **logs** are the deliberate exception: they stay with the host log
driver (`docker compose logs -f core-uploader`). Work runs in containers and on
remote worker hosts the core cannot read, so there is no log API to expose — the
Errors view reports platform state instead.


## Enrolling a worker host

Enrollment is deliberately manual and operator-initiated: you mint a
single-use, expiring token and hand it to a host you have decided to trust.

**On the core host**, mint the token:

```bash
curl -sX POST "$ADMIN/api/v1/admin/enroll-tokens" "${auth[@]}" \
  -H 'content-type: application/json' \
  -d '{"trust":"COMMUNITY","note":"arda-desktop","ttlHours":24}'
# → {"token":"pe_…","expiresAt":"…"}
```

`trust` is `COMMUNITY` or `TRUSTED`. Extensions whose manifest sets
`min_trust: TRUSTED` are never leased to a `COMMUNITY` worker, so use
`COMMUNITY` for anything you do not personally administer.

**On the worker host**:

```bash
git clone https://github.com/publoader/publoader && cd publoader
cd docker/worker
cp .env.example .env && chmod 600 .env
# set WORKER_NAME and paste the pe_… token into ENROLL_TOKEN
cd -
docker compose -f docker/worker/docker-compose.yml pull
docker compose -f docker/worker/docker-compose.yml up -d
docker compose -f docker/worker/docker-compose.yml logs -f
```

The agent exchanges the enroll token for a permanent worker token on first
boot and persists it to the `worker-state` volume. The enroll token is spent at
that point and can be removed from `.env`.

**Verify from the core host** — the worker should appear with a recent
heartbeat:

```bash
curl -s "$ADMIN/api/v1/admin/workers" "${auth[@]}"
```

If `lastHeartbeatAt` is null or stale, see [Troubleshooting](#troubleshooting).

The worker publishes no ports and accepts no inbound connections, so it works
behind NAT, on a laptop, or on a home connection with no firewall changes.

## Scaling to multiple workers

Throughput is workers, not core services. `core-scheduler` and `core-uploader`
must each stay at exactly one replica — the scheduler would race itself on slot
creation, and MangaDex upload sessions are per-account state that two uploaders
would clobber.

To add capacity, repeat the enrollment walkthrough on another host. Each worker
needs its own enroll token and its own state volume; sharing either means
sharing an identity, which breaks revocation.

Several workers on one machine work too — copy the compose file, and give each
a distinct project name, `WORKER_NAME` and volume:

```bash
docker compose -p publoader-worker-2 \
  -f docker/worker/docker-compose.yml up -d
```

Size the fleet by watching `PENDING` job depth in
`GET /api/v1/admin/stats`: if it is persistently non-zero while workers are
busy, add a worker. Each worker runs one job at a time.

## Upgrading

Migrations run automatically on every `up`: the `migrate` service applies any
migrations not yet recorded in `_prisma_migrations` and exits, and the app
services wait for that exit code. `migrate deploy` never generates, resets or
drops anything, so re-running it is safe.

**Building from source** (the default):

```bash
git pull
docker compose -f docker/core/docker-compose.yml pull
docker compose -f docker/core/docker-compose.yml up -d
```

**From a registry** — set `PUBLOADER_CORE_IMAGE` and `PUBLOADER_MIGRATE_IMAGE`
in `.env` to a digest-pinned tag, then:

```bash
docker compose -f docker/core/docker-compose.yml pull
docker compose -f docker/core/docker-compose.yml up -d
```

Workers upgrade independently and can lag the core by a version; the API is
versioned (`/api/v1/`) for exactly that reason. Rolling the fleet is: drain,
wait for the current job to finish, `pull && up -d`, un-drain (next section).

Watch the first minutes after an upgrade:

```bash
docker compose -f docker/core/docker-compose.yml logs -f --tail=100
curl -s "$ADMIN/api/v1/admin/stats" "${auth[@]}"
```

### Rollback

Code-only rollback (no new migration in the bad release) is just the previous
tag:

```bash
PUBLOADER_CORE_IMAGE=ardax/publoader-core:2.1.3 \
  docker compose -f docker/core/docker-compose.yml up -d
```

If the bad release **did** apply a migration, the old code is running against a
newer schema. Additive migrations (new nullable column, new table) are usually
tolerated; destructive ones are not. In order of preference:

1. **Roll forward.** Write a new migration that undoes the change and deploy
   it. This keeps the migration history linear and honest, and it is almost
   always the right answer.
2. **Restore from backup** (next section) if the migration destroyed data.
3. Only if a migration failed *partway* and left the history table marked
   failed, unblock it explicitly:

   ```bash
   # Mark a failed migration as rolled back, after manually reverting its SQL:
   docker compose -f docker/core/docker-compose.yml run --rm \
     migrate migrate resolve --rolled-back 20260101120000_bad_migration

   # Or mark one as applied, if you applied its SQL by hand:
   docker compose -f docker/core/docker-compose.yml run --rm \
     migrate migrate resolve --applied 20260101120000_partly_applied
   ```

   `migrate resolve` only edits Prisma's bookkeeping — it runs no SQL and fixes
   no data. Reverting the actual schema change is your job, first.

Never edit a migration that has already been deployed. Prisma checksums them
and the next `deploy` will refuse to run.

**Postgres major upgrades** (16 → 17) are not in-place: dump, recreate the
volume with the new image, restore.

## Draining and revoking workers

Three states, and the difference matters:

```bash
# Drain: finish the current job, take no new ones. The polite one — use it
# before rebooting a worker host or rolling the fleet.
curl -sX POST "$ADMIN/api/v1/admin/workers/$WORKER_ID/drain" "${auth[@]}"

# Activate: back into rotation.
curl -sX POST "$ADMIN/api/v1/admin/workers/$WORKER_ID/activate" "${auth[@]}"

# Revoke: the token stops working immediately. Use it when a host is
# compromised, gone, or no longer trusted. Not reversible — the host must
# re-enroll with a fresh token.
curl -sX POST "$ADMIN/api/v1/admin/workers/$WORKER_ID/revoke" "${auth[@]}"
```

A drained worker gets `204` with `x-publoader-drained` on its next lease poll
and idles quietly rather than hammering the API. A revoked worker's in-flight
job is not cancelled by the revocation itself — its result submission will be
rejected, and the lease will expire and be reassigned. To stop the work sooner,
cancel the job:

```bash
curl -sX POST "$ADMIN/api/v1/admin/jobs/$JOB_ID/cancel" "${auth[@]}"
```

After revoking, on the worker host: `docker compose down -v` to remove the
state volume containing the dead token.

## Failover test

Worth running once after setup and after any change to lease handling. It
proves the property the whole distributed design rests on: a worker dying
mid-job loses nothing but time.

Do it on the [local stack](#local-end-to-end-stack), where `LEASE_TTL_SECONDS`
is 30 instead of 300:

```bash
cd docker/dev
docker compose up -d --build
export DEV=http://127.0.0.1:8100
dev_auth=(-H 'authorization: Bearer dev-admin-not-a-secret')

# 1. Both workers enrolled and heartbeating?
curl -s "$DEV/api/v1/admin/workers" "${dev_auth[@]}"

# 2. Trigger a run.
curl -sX POST "$DEV/api/v1/admin/runs" "${dev_auth[@]}" \
  -H 'content-type: application/json' \
  -d '{"extension":"mangaplus","kind":"FORCE"}'

# 3. Find who leased it.
docker compose logs worker-a worker-b | grep -i lease

# 4. Kill the holder mid-job — SIGKILL, no graceful shutdown, exactly like a
#    host losing power.
docker compose kill worker-a

# 5. Watch the sweeper reclaim it and the other worker pick it up.
docker compose logs -f core-scheduler worker-b
```

Expected: within `LEASE_TTL_SECONDS + SWEEP_INTERVAL_SECONDS` (~35s here), the
scheduler logs the expired lease, the job returns to `PENDING`, and `worker-b`
leases it on its next poll. The job's `attempt` counter increments; it
dead-letters only after `maxAttempts`.

Then confirm nothing was double-uploaded — the mock records every write, and a
correct run commits each chapter exactly once:

```bash
curl -s http://127.0.0.1:8200/_test/uploads | jq '.commits | length'
```

Bring `worker-a` back with `docker compose up -d worker-a`; its identity
survives in its state volume.

## Backup and restore

Postgres is the only durable state. The named volume `pgdata` is the whole
system: queues, leases, results, artifacts, bundles, chapter history, audit.
Everything else is rebuildable from the repository.

**Backup** — a custom-format dump, which restores selectively and compresses:

```bash
docker compose -f docker/core/docker-compose.yml exec -T postgres \
  pg_dump -U publoader -Fc publoader > publoader-$(date +%F).dump
```

Automate it daily and keep the dumps off this host. Artifacts (page images) are
stored as bytea, so dumps grow with backlog; if size becomes a problem, dump
`--exclude-table-data=artifacts` — they are transient and re-fetchable, unlike
everything else.

**Restore** into an empty database:

```bash
# Stop everything that writes; leave postgres running.
docker compose -f docker/core/docker-compose.yml stop \
  core-api core-scheduler core-processor core-uploader

docker compose -f docker/core/docker-compose.yml exec -T postgres \
  dropdb -U publoader --if-exists publoader
docker compose -f docker/core/docker-compose.yml exec -T postgres \
  createdb -U publoader publoader
docker compose -f docker/core/docker-compose.yml exec -T postgres \
  pg_restore -U publoader -d publoader --no-owner < publoader-2026-07-29.dump

docker compose -f docker/core/docker-compose.yml up -d
```

Verify the restore before trusting it — the migration history in particular,
because that is what decides whether the next deploy tries to re-apply
everything:

```bash
docker compose -f docker/core/docker-compose.yml exec -T postgres \
  psql -U publoader -d publoader -c \
  'select migration_name, finished_at from _prisma_migrations order by finished_at desc limit 5;'
```

Test a restore into a scratch stack occasionally. An untested backup is a
hypothesis.

Jobs that were `LEASED` at dump time come back leased with an expiry in the
past; the sweeper reclaims them on its next tick, which is the correct
behaviour and needs no intervention.

## Local end-to-end stack

`docker/dev/docker-compose.yml` runs the entire system on one machine
with MangaDex replaced by a mock. It is the only place the failover, dedup and
concurrency behaviours can be exercised for real.

```bash
docker compose -f docker/dev/docker-compose.yml up -d --build
```

You get: Postgres (tmpfs — `down` really resets), `migrate`, all four core
services, `mock-md`, and two workers that enrol themselves automatically. The
API is on `127.0.0.1:8100` with the admin token `dev-admin-not-a-secret`; the mock is on
`127.0.0.1:8200`.

The mock's test surface:

```bash
curl -s http://127.0.0.1:8200/_test/uploads   # every write it received
curl -s http://127.0.0.1:8200/_test/state     # fixtures + counters
curl -sX POST http://127.0.0.1:8200/_test/seed -H 'content-type: application/json' \
  -d '{"chapters":[…],"manga":[…],"aggregate":{}}'
curl -sX POST http://127.0.0.1:8200/_test/reset
```

`_test/uploads` also lists `unrouted` requests — endpoints the client called
that the mock does not implement. Check it first when an e2e test fails
mysteriously.

This stack is **not secure and not meant to be**: fixed weak credentials,
automated enrollment, published ports. Do not run it on a host that accepts
traffic from anywhere else.

## Troubleshooting

**`migrate` exits non-zero, everything else stays down.** Read its logs first —
this is the designed failure mode, not a bug. `No migration found in
prisma/migrations` means the prerequisite above was skipped. A checksum
mismatch means a deployed migration was edited.

**`core-api` is up but `/readyz` returns 503.** Postgres is unreachable. Check
`docker compose ps postgres` and its logs; usually a wrong `POSTGRES_PASSWORD`
after a `.env` edit, and note that changing it does *not* change the password
inside an existing `pgdata` volume — `ALTER USER` for that.

**Every admin call returns 503.** `ADMIN_TOKEN` is unset or shorter than 16
characters. The admin API fails closed.

**A worker enrolls, then never heartbeats.** Almost always the tunnel or the
WAF. From the worker host:
`curl -sv https://publoader.ardax.dev/api/v1/worker/heartbeat` should give 401
(reached the API, no token), not 403/404/timeout. A 403 usually means a WAF rule
is matching more than intended.

**Enrollment returns 403.** The token was single-use and already spent, or it
expired, or it was revoked. Mint a fresh one — they are cheap.

**Jobs sit `PENDING` with idle workers.** Either the platform is paused (check
`paused` in `/api/v1/admin/stats`, resume with
`POST /api/v1/admin/resume`), the extension is disabled, or the job's
`min_trust` is `TRUSTED` and every worker is `COMMUNITY`.

**MangaDex calls fail with "Connection refused" from `core-processor` or
`core-uploader`.** A filtering DNS resolver on the LAN is sinkholing
`mangadex.org`. Both services already override DNS to `1.1.1.1`/`8.8.8.8` for
this reason (see the `x-public-dns` anchor); remove it if your network does not
filter, and check it first if you changed it.

**A service restarts in a loop with `EROFS` or a permissions error.** Something
is writing outside `/tmp`. That is the `read_only: true` root filesystem working
as intended — fix the write path rather than removing the flag.

**The scheduler seems stuck.** It has no healthcheck (no port, no heartbeat
file) and autoheal is deliberately absent, because autoheal requires mounting
`docker.sock` into the stack — a much larger risk than the failure mode it
fixes. Detect a wedged scheduler with the scheduler-lag metric on
`/metrics`, and restart it by hand.

## Discord bot

Optional, and independent of everything above: the stack runs fine without it.
Full setup, the command reference and the gating model are in `docs/bot.md` —
this section is the deployment half.

The `publoader-bot` service runs the same core image with a different
entrypoint (`dist/src/services/bot.js`), like the other four. What makes it
different is its attack surface, which is deliberately the smallest in the
stack:

- **No `DATABASE_URL`, and not attached to the `data` network.** It is an HTTPS
  client of the admin API and has no route to Postgres at all.
- **No `docker.sock`.** The legacy bot mounted it so `!restart` could restart
  the scheduler container, which made a bot compromise equivalent to root on
  the host. Those commands are gone; the bot tells you what to run instead.
- **No MangaDex credential.** It cannot upload, delete, or authenticate to MD.
- **One scoped `pa_…` token**, not `ADMIN_TOKEN`.

So the bot is on the `edge` network only, and everything it can do to the
platform is the scope list on its token.

### Bring it up

1. Create the Discord app and invite it (`docs/bot.md` §1). Copy the bot token.

2. Mint the bot's own control-plane token from the core host:

   ```
   docker compose -f docker/core/docker-compose.yml exec core-api \
     node dist/src/cli/admin.js tokens create --name discord-bot \
     --scopes runs:write,workers:read,extensions:read,untracked:write,stats:read,audit:read,settings:write
   ```

   That is the `discord-bot` preset plus `settings:write`, which is what makes
   `/pause` and `/resume` work — the single most useful thing a chat bot does
   during an incident. Add `extensions:write`, `workers:write` or
   `enroll:write` if you want the commands they unlock (`docs/bot.md` §2).

   **Never put `ADMIN_TOKEN` in `BOT_API_TOKEN`.** `ADMIN_TOKEN` resolves to
   `*`, which includes `bundles:write` — publishing arbitrary code to the whole
   worker fleet — and `users:admin`. The token is printed once and cannot be
   recovered.

3. Add to `docker/core/.env` (annotated in `.env.example`):

   ```
   DISCORD_BOT_TOKEN=...        # from the Developer Portal
   BOT_API_TOKEN=pa_...         # from step 2
   DISCORD_GUILD_ID=...         # your guild id
   DISCORD_ADMIN_USERS=...      # who may run write commands
   DISCORD_ALLOWED_CHANNELS=... # where the bot accepts them
   ```

   The last two are not optional in practice: with no admins configured the bot
   refuses every state-changing command, and with no channel allowlist it
   refuses writes anywhere. It fails closed, unlike the legacy bot which
   allowed everyone when unconfigured.

4. Start it and watch the first ten seconds of log:

   ```
   docker compose -f docker/core/docker-compose.yml up -d publoader-bot
   docker compose -f docker/core/docker-compose.yml logs -f publoader-bot
   ```

   A good start logs, in order: `admin API reachable; bot authorization model
   loaded` (with a one-line summary of the gating), `discord bot connected`, and
   `registered guild slash commands`.

5. Verify from Discord: `/whoami` then `/status`. `/whoami` shows which API the
   bot points at, a masked token fingerprint, and the actor string your commands
   will be attributed to in the audit log. `/status` proves the token works.

### Rotating the bot's token

Create the replacement, update `BOT_API_TOKEN`, redeploy, then revoke the old
one — in that order, so the bot is never without a working credential:

```
... tokens create --name discord-bot-2 --scopes <same list>
# edit .env, then:
docker compose -f docker/core/docker-compose.yml up -d publoader-bot
... tokens revoke <old-id>
```

### Troubleshooting the bot

**Restart loop, with one `fatal` line about the token.** The API rejected
`BOT_API_TOKEN` (or it is unset). The process exits 78 — `EX_CONFIG`, meaning
restarting will not help — but `restart: unless-stopped` restarts it anyway, so
read the *first* fatal line rather than the last. Check the token was not
revoked and that `CORE_URL` points at the right deployment.

**`Improper token` / login failure from Discord.** `DISCORD_BOT_TOKEN` is not a
bot token, or was regenerated (which permanently revokes the old one). The
client secret, public key and OAuth token are all different values and none of
them work. Surrounding quotes are stripped automatically.

**Commands do not appear in Discord.** With `DISCORD_GUILD_ID` set they register
instantly, so this means registration failed — check the log for `failed to
register slash commands`, and that the invite included the
`applications.commands` scope. Without `DISCORD_GUILD_ID` the commands are
global and can take up to an hour to propagate; the bot warns about this at
startup.

**Every command answers with a 403 naming a scope.** Working as intended: the
token lacks that grant. The reply also lists the scopes it does hold. Mint a
replacement with the extra scope (see above) rather than widening to `*`.

**A command answers `:lock:` with a reason.** Discord-side gating, not the API.
The reason names the variable to set — usually `DISCORD_ADMIN_USERS` or
`DISCORD_ALLOWED_CHANNELS`. See `docs/bot.md` §4.

**The bot cannot reach Discord.** It carries the same public-resolver override
as the MangaDex-facing services (the `x-public-dns` anchor) because this host's
LAN resolver filters. Remove it if your network does not.

## Publishing extension code

Extensions ship as content-addressed bundles, separately from the core image.
Publishing one is what makes the running system use new extension code: the
scheduler pins each job to the latest published bundle for that extension, so the
next run picks it up with no restart and no deploy.

**By hand**, from a checkout:

```bash
publoader-admin bundle publish src/mangaplus --source-commit "$(git rev-parse HEAD)"
publoader-admin extensions list
```

**From CI** — the recommended arrangement. A GitHub Actions workflow runs that
same command with a token minted for nothing else:

```bash
publoader-admin tokens create --name ci-extensions --scopes bundles:write
```

The build happens on the runner, which already has a checkout and a package
manager, and core-api needs no GitHub credential and no compiler. Workflow in
`docs/webhooks.md` §6.

**From a GitHub push webhook** — the zero-CI option. `POST /webhook` verifies an
HMAC, downloads the repo at the pushed commit, and publishes a bundle per changed
extension. It puts a GitHub token and esbuild inside core-api, cannot install
third-party dependencies, and inherits GitHub's ~10-second delivery timeout (so a
slow-but-successful delivery can be logged red). Set it up only if you have no
CI, and read `docs/webhooks.md` first — including §6, which argues against it.

Note what none of these do: **core itself is never deployed this way.** A push to
the core repo is acknowledged and does nothing. Core is an image, rolled out with
`./scripts/publoader prod upgrade <tag>` (see §Upgrading above).


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
