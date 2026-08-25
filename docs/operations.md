# Operations runbooks

Date: 2026-07-29
Audience: whoever is on the other end of "publoader stopped uploading".

Every procedure here assumes:

```bash
export PUBLOADER_API_URL=https://publoader.ardax.dev
export PUBLOADER_ADMIN_TOKEN=<admin token>
alias padmin='node /path/to/publoader/dist/src/cli/admin.js'
```

`padmin` sends your `$USER` as `X-Actor`, so everything you do below appears in
`padmin audit`. If you are running from inside the core compose network instead,
use `PUBLOADER_API_URL=http://core-api:8100`.

**The two commands to run first, always:**

```bash
padmin stats        # queue depths, worker counts, pause state
padmin dead-letter  # what has already given up
```

---

## The dashboard

Everything in this document can also be done from a browser at
`https://publoader.ardax.dev/`. It is the same admin API with a login screen,
so the CLI remains authoritative and the two are interchangeable; every
dashboard action lands in `padmin audit` exactly like a CLI one.

**Sign in** with your email and password, with an emailed sign-in link, or with
Discord if this deployment has OAuth configured. Your account name becomes the
audit actor, so "who paused the platform" is answerable without anyone having
to set a header.

**Invited, or forgot your password?** Enter your address and click **Email me a
sign-in link**. The link works once and signs you straight in; set a password
from **the profile menu → Your account** while you are there, or you will need
another link next time. You can also attach Discord to the same account from
that dialog, after which either method signs you in.

If nobody has an account, a fresh database seeds one `OWNER`
(`DASH_OWNER_EMAIL`) with no credentials, use **"Use the admin token
instead"** on the login page, then **Users → Set password**. That is the
bootstrap path and the break-glass path both. (With email configured, the
seeded owner can also just ask for a link.)

Sessions last `SESSION_TTL_MINUTES` (12h default) and are individually
revocable from **Users → Live sessions**. Full setup, including the Discord
OAuth application, is in `docs/deployment.md` → "Dashboard"; a tour of every
section, the role matrix, and the short list of things that still need a shell
on the host is in `docs/dashboard.md`.

### Someone left the team

```
Users → their row → Delete        # revokes their sessions by cascade
```

If you want to keep the account but cut access now, **Revoke** each of their
live sessions and change their password; a password change on its own does
*not* invalidate sessions already issued.

To take away only their ability to manage other operators, set them to `ADMIN`.
Be clear-eyed about what that does and does not contain: an `ADMIN` still has
full control-plane authority, including publishing bundles, which is code
execution on every worker. It is not a safe role for someone you no longer
trust; deletion is.

### Approving a new operator

With self-signup on (**Users → Self-signup**), a Discord login by someone
unknown creates an unapproved `ADMIN` row and shows them "awaiting approval".
Nothing else happens until you act: they cannot sign in, and no endpoint is
reachable. Approve from **Users**, or leave it and delete the row.

With self-signup off (the default), an unknown Discord login is refused
outright. Invite them instead, **Users → Invite** with their email, and they
get in by linking Discord with that same verified email, or by you setting a
password for them.

### Onboard a community contributor

The `CONTRIBUTOR` role exists so the series map can be maintained by someone you
have not given the keys to. A contributor can add mappings and work the
untracked queue; they cannot trigger runs, touch workers or settings, read the
audit log, or change where an existing mapping points.

```
Users → Invite → their email, role CONTRIBUTOR
Users → their row → Set password        # or let them link Discord
```

Their dashboard has three sections (Overview, Extensions, with the series map
under **Extensions → Open**, and Untracked) and nothing else: the tab strip is
built from the scopes the server says they hold, so there is no tab that 403s.

What to tell them: **add freely, and flag anything that looks already-mapped.**
A row that would repoint or remove an existing mapping comes back as
`rejected_needs_write` with the current target, which is the signal to bring it
to an operator rather than a failure. Their additions are attributed to them in
`padmin audit`, so a contributor who maps a series wrongly is traceable and
reversible.

To promote or remove them later: **Users → Make admin**, or **Delete** (which
revokes their sessions by cascade).

### Curate the series map, and preview a paste first

**Extensions → (extension) → Open → Tracked series.** The paste box accepts
lines of `externalId,mangadexTitleId`: separators can be commas, whitespace,
tabs, semicolons or pipes, `#` comments and a header row are ignored, and the
two columns may be in either order because the MangaDex id is recognised by its
UUID shape. **Export** emits exactly that format, so export → edit → paste back
is the round trip, with no file in git and no shell on the host.

**Always dry-run a paste you did not generate yourself.** The preview reports
what every line would do, added, updated (with the previous target), unchanged,
removed, or rejected, and writes nothing, because the store skips its write
transaction rather than applying and undoing.

```bash
padmin tracked list mangaplus > /tmp/before.txt

curl -sX POST "$PUBLOADER_API_URL/api/v1/admin/extensions/mangaplus/tracked/batch" \
  -H "authorization: Bearer $PUBLOADER_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d "$(jq -Rs '{dryRun: true, text: .}' < /tmp/paste.csv)"
```

Read the `updated` rows before committing: each one silently redirects a
series' uploads to a different MangaDex title, and the row's `detail` says what
it was pointing at. Then re-send with `"dryRun": false`.

A dry run leaves no audit entry, because nothing happened. A real batch records
`tracked_manga.batch` with the counts. If a paste goes in wrong, the audit
detail plus `/tmp/before.txt` is what you reconstruct from; there is no undo.

Three further flows are worth calling out because they are easier to get
wrong in a UI than on a command line.

### Enrol a worker from the dashboard

**Workers → Enroll new worker.** Pick the trust tier (leave `COMMUNITY` unless
you control the machine), a note naming the host, and a TTL.

The token is displayed **once**, inside a ready-made compose snippet with
`CORE_URL` and `ENROLL_TOKEN` already filled in. Copy it before closing the
dialog; there is no way to retrieve it, and the only recovery is minting
another and letting the first expire. Send it over a private channel; it is a
bearer credential until it is spent.

Everything else matches the CLI flow below: the agent exchanges the token for a
permanent one on first contact, and the row appears under **Workers** once it
heartbeats.

### Approve an untracked series

**Untracked → filter `NEW` → Approve.** This creates a real MangaDex title
synchronously and **cannot be undone from the dashboard**, so it asks for
confirmation first.

Check the series name, language, and source URL before approving; the common
mistake is approving something that already exists on MangaDex under a
different name, which produces a duplicate title. When it already exists, use
**Extensions → Open → Tracked series** to point the external id at the
existing MangaDex UUID instead, and **Skip** the untracked row.

On success the toast contains the new `https://mangadex.org/title/<id>` link,
and the row moves to `TRACKED` with the same link in the table.

### Trigger a run; and what `Clean` means

**Extensions** gives each published bundle three buttons:

| Button | Kind | What it does |
|---|---|---|
| Run | `UPDATE` | Normal incremental run. |
| Force | `FORCE` | Ignores the schedule and the already-posted set. |
| Clean | `CLEAN` | Re-reads the extension's entire back catalogue. |

`Clean` is destructive and confirms before firing. A clean run compares the
full catalogue against what is on MangaDex and can queue **deletions** for
chapters the extension no longer reports; a source-side outage that hides
chapters therefore looks identical to chapters being removed. Check the
extension is healthy first; **Runs** tab, or `padmin runs list`.

Note you cannot pre-pause as a safety net: `POST /runs` returns 409 while the
platform is paused. The recovery lever is the other way round; if a clean run
does queue deletions you did not want, hit **Pause** on the Overview tab
immediately. The uploader honours the pause gate, so queued upload tasks stop
before they execute and you can inspect them.

Runs started from the dashboard get a server-generated idempotency key, so
double-clicking creates two runs. Watch the **Runs** tab rather than clicking
again.

---

## Enrol a worker

Workers are outbound-only: they need no inbound ports, no static IP, and no
firewall changes. Enrolment is a one-time token exchange.

**1. Mint a token** (operator side). Default trust is `COMMUNITY`; pass
`--trust` only for machines you control.

```bash
padmin enroll-token create --note "hetzner-fsn-1" --ttl-hours 24
padmin enroll-token create --trust --note "arda-desktop" --ttl-hours 4
```

The token is displayed once. It is single-use and expires; there is no way to
retrieve it again, so if you lose it, mint another and let the first expire.

**2. Start the agent** (worker side).

```bash
cd publoader/docker/worker
cp .env.example .env
# WORKER_NAME=hetzner-fsn-1
# ENROLL_TOKEN=pe_...
docker compose pull
docker compose up -d
docker compose logs -f worker-agent
```

The agent exchanges the token for a permanent worker token, persists it to the
`worker-state` volume, and starts long-polling. Once it has enrolled, remove
`ENROLL_TOKEN` from `.env`: it is spent.

**3. Confirm** (operator side).

```bash
padmin workers list
```

`STATUS` should be `ACTIVE` and `HEARTBEAT` under a minute. If the worker never
appears, the enrolment failed; check `padmin audit` for a
`worker.enroll.rejected` event, which records the source IP and the name that
was attempted.

**Enrolling by hand** (useful when debugging, or provisioning without compose):

```bash
curl -fsS -X POST https://publoader.ardax.dev/api/v1/worker/enroll \
  -H 'content-type: application/json' \
  -d '{"enrollToken":"pe_...","name":"hetzner-fsn-1","agentVersion":"1.0.0"}'
# -> 201 {"workerId":"...","workerToken":"pw_...","trust":"COMMUNITY"}
```

Store the returned `workerToken` as `WORKER_TOKEN` in the worker's `.env`. A
403 here means the enroll token is invalid, expired, or already used.

---

## Drain, revoke, and re-enrol a worker

**Drain**: take a worker out of rotation without interrupting its current job.
Use this for planned maintenance, host reboots, and agent upgrades.

```bash
padmin workers drain <workerId>
```

The worker finishes its in-flight job and its next lease request returns 204
with a `drained` flag, so it idles instead of polling hard. Watch `padmin stats`
until no job is leased to it, then do your maintenance.

```bash
padmin workers activate <workerId>     # back into rotation
```

**Revoke**: permanently invalidate the credential. Use this when a host is
decommissioned, a token may have leaked, or a community worker is misbehaving.

```bash
padmin workers revoke <workerId>
```

Revocation is immediate: the next request from that token gets 401. Any job it
holds a lease on keeps that lease until it expires, then the sweeper requeues
it; so expect a job to be re-run within `LEASE_TTL_SECONDS` (default 300).
There is no way to un-revoke; re-enrol instead.

**Re-enrol** after revocation or after wiping the worker's state volume:

```bash
# operator
padmin enroll-token create --note "hetzner-fsn-1 re-enrol"
# worker
docker compose down
docker volume rm worker_worker-state      # only if the old identity is dead
# set ENROLL_TOKEN in .env
docker compose up -d
# operator: the old worker row is now a zombie; revoke it
padmin workers revoke <oldWorkerId>
```

A revoked worker row is kept deliberately: it is the audit record of what that
worker submitted.

---

## Upgrade the core

> **One-off: the compose files moved.** Everything that lived under `platform/`
> is now at the repository root, so the stack is at `docker/core/`, not
> `platform/docker/core/`. A server still sitting in the old directory fails with
>
> ```
> lstat /docker: no such file or directory
> ```
>
> which names neither the path nor the move. The compose file's `context: ../..`
> resolves to `platform/` there, and `platform/` no longer contains `docker/`.
>
> ```bash
> cd <repo> && git pull
> rm -rf platform          # leftovers; git does not remove an untracked directory
> cd docker/core
> docker compose --env-file .env config | grep image:   # proves you are in the right place
> ```

Core services are stateless; the schema is not. Migration runs first, as a
one-shot container, and every service waits on it.

```bash
cd docker/core

# 1. Quiesce. Not strictly required for additive migrations, but it means an
#    in-flight MangaDex upload cannot be interrupted by a restart.
padmin pause --minutes 30

# 2. New image.
#    Set PUBLOADER_CORE_IMAGE in .env to the new tag, or rebuild from source:
#    (to build from source instead: add -f docker-compose.build.yml)
docker compose pull

# 3. Migrate + restart. `up -d` reruns `migrate deploy` (idempotent; it applies
#    only migrations absent from _prisma_migrations) before starting services.
docker compose up -d

# 4. Verify.
docker compose ps                                  # migrate exited 0
curl -fsS https://publoader.ardax.dev/healthz
docker compose exec core-api node -e "fetch('http://127.0.0.1:8100/readyz').then(r=>r.text()).then(console.log)"
padmin stats

# 5. Resume.
padmin resume
```

**If migrate exits non-zero**, no application service starts and the old
containers keep running until you `up` successfully; the stack fails closed.
Read `docker compose logs migrate`, fix the migration, retry. Do not run
`prisma migrate reset` against production; it drops the database.

**Never deploy a single service with `--no-deps`.** All four core services
declare `depends_on: migrate: service_completed_successfully`, which is what
makes step 3 safe; and `--no-deps` exists precisely to skip that. Deploying just
the API that way starts new code against the old schema, and the failure is not a
crash on boot: the service comes up healthy and reports healthy, because
`/healthz` does not consult the schema. Only the endpoints that touch a
changed table fail, one at a time, with a 500 and a Prisma `P2022` (*column does
not exist*) in the log. If you need to replace one container, either use plain
`up -d <service>` (dependencies included, migrate reruns idempotently) or run
`docker compose run --rm migrate` yourself first.

Either way, confirm the schema afterwards from the dashboard; **System →
Schema**, or:

```bash
curl -fsS -H "authorization: Bearer $ADMIN_TOKEN" \
  https://publoader.ardax.dev/api/v1/admin/schema
```

`current: true` with an empty `pending` is the answer you want. `pending`
non-empty means running code is ahead of the database. `historyAvailable: false`
means the database was built by `prisma db push` or restored from a dump rather
than migrated, so pending migrations cannot be computed; expect that on a dev
stack, never on production.

**If you deployed one service by hand, use `--force-recreate`.** Observed on this
stack: after a container had been created by a `--no-deps` deploy, a subsequent
plain `docker compose up -d core-api` brought it back attached to only `edge`,
not `edge` **and** `data`, even though the compose file declares both. The
symptom is a service that will not start, looping on

```
PrismaClientInitializationError: Can't reach database server at `postgres:5432`
```

while `docker ps` shows postgres up and healthy; because the two containers are
on networks that cannot see each other. `data` is `internal: true`, so there is
no route to fall back on. Check with:

```bash
docker inspect publoader-prod-core-api-1 \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
# want: publoader-prod_data publoader-prod_edge
```

Neither `up -d` nor `up -d --force-recreate` reliably repairs it. Plain `up -d`
does nothing at all, because the service's configuration has not changed and
compose sees no reason to recreate it. `--force-recreate` recreates in place and
has been observed *causing* this; once dropping `data`, once dropping `edge`.
What works is removing the container and creating it again:

```bash
docker compose -p publoader-prod --env-file docker/core/.env.production \
  -f docker/core/docker-compose.yml rm -sf core-api
docker compose -p publoader-prod --env-file docker/core/.env.production \
  -f docker/core/docker-compose.yml up -d core-api
```

Note this is worth checking even when nothing looks wrong: the service reports
healthy either way, because its health check is local. With `edge` missing,
cloudflared cannot reach it and the public site is down while every panel says
the stack is fine. `docker compose config` is the tiebreaker; if it lists both
networks, the file is right and only the running container is stale.

**Rolling back a core upgrade** is only safe if the migration was additive. If
it was not, restore from backup (below): which is why you take one before a
schema-changing upgrade.

---

## Upgrade a worker fleet

Workers are independent and versions may be mixed, because every job pins the
extension bundle it needs by sha256. There is no fleet-wide flag day.

Rolling upgrade, one worker at a time:

```bash
# operator
padmin workers drain <workerId>
# wait until it holds no lease
padmin stats

# worker host
cd docker/worker
docker compose pull
docker compose up -d

# operator
padmin workers activate <workerId>
padmin workers list      # AGENT column shows the new version after a heartbeat
```

If you skip the drain, nothing breaks; the agent's in-flight job loses its
lease, the sweeper requeues it, and another worker picks it up. Draining just
avoids the wasted work.

For community workers you cannot drain-and-upgrade on demand: publish the new
image tag, and let operators update at their own pace. If an old agent version
becomes incompatible, `workers revoke` is the enforcement mechanism.

---

## Rotate secrets

> **Unresolved incident; these four secrets are public.**
>
> `docker/core/.env.production` and `.env.staging` were tracked and
> pushed to this repository, which is public. `platform/.gitignore` (as it then was) matched
> `.env` but not `.env.production`, so neither file was ever ignored. Commit
> `d472f8d` untracks them and ignores `.env*`, which stops it recurring; it does
> **not** unpublish anything. The values remain readable in the history of every
> pushed commit that touched those files, and must be treated as compromised:
>
> | Secret | What it grants until rotated |
> | --- | --- |
> | `ADMIN_TOKEN` | Full admin API access. It is the break-glass credential and outranks every account. |
> | `SESSION_SECRET` | Forged dashboard sessions as any operator, without a password. |
> | `POSTGRES_PASSWORD` | The database, if the port is ever reachable. |
> | `TUNNEL_TOKEN` | Running a Cloudflare tunnel for the hostname; an attacker can serve traffic as publoader.ardax.dev. |
>
> **Status: three of the four are rotated.** `POSTGRES_PASSWORD`, `ADMIN_TOKEN`
> and `SESSION_SECRET` were replaced on 2026-07-31; the leaked admin token now
> answers 401 and the leaked database password is refused by the server. The
> published values for those three are inert.
>
> **`TUNNEL_TOKEN` is NOT rotated and cannot be from here**: it is issued by
> Cloudflare and only the account that owns the tunnel can revoke it. Until it is,
> anyone who read it can run a tunnel for publoader.ardax.dev. Rotate it in the
> Cloudflare dashboard (Zero Trust → Networks → Tunnels → the tunnel → refresh
> its token), put the new value in `.env.production`, and recreate cloudflared.
>
> MangaDex credentials were placeholders throughout the exposure window and were
> never published; they were filled in from `config.ini` afterwards, into a file
> that is now ignored.
>
> Purging them from history (`git filter-repo`, or deleting the branch) is worth
> doing afterwards, but rotation is what actually ends the exposure; assume the
> published values were scraped the moment they were pushed.


### Dashboard credentials

An operator password: **Users → Set password** (owner), or the operator does it
themselves from their own row. Minimum 12 characters, scrypt-hashed at rest.
Then revoke their live sessions; a password change does *not* invalidate
sessions already issued.

To sign *everyone* out there is no single lever: revoke each session under
**Users → Live sessions**, or in an emergency go straight at the table.

```bash
psql "$DATABASE_URL" -c "UPDATE admin_sessions SET revoked = true"
```

Rotating `SESSION_SECRET` does not log anyone out; it signs the OAuth state
cookie only, so rotating it breaks Discord logins that are mid-flight and
nothing else. Rotating `ADMIN_TOKEN` likewise leaves existing sessions alive,
including any created with the old token.

### Worker token

Workers can rotate their own credential without operator involvement; the swap
is atomic and the old token dies with it:

```bash
curl -fsS -X POST https://publoader.ardax.dev/api/v1/worker/token/rotate \
  -H "authorization: Bearer $WORKER_TOKEN"
# -> {"workerToken":"pw_..."}
```

The agent persists the new token to its state volume. Operator-side, the
alternative is `workers revoke` + re-enrol, which also changes the worker id.

### Admin token

The admin token is held by you and the Discord bot. (The dashboard no longer
holds a copy; operators sign in with their own accounts, and the token is only
its break-glass path.) Rotating it breaks the CLI and the bot until they are
updated, so do it in this order:

```bash
NEW=$(openssl rand -base64 48)

# 1. Update .env: ADMIN_TOKEN=$NEW
# 2. Restart only core-api; the other services do not read it.
docker compose up -d core-api
# 3. Update your own shell, then the bot's config, then restart it.
export PUBLOADER_ADMIN_TOKEN=$NEW
padmin stats
```

There is one admin token and no overlap window in v1, so expect a brief period
where the bot returns errors. Rotate at a quiet time.

If `ADMIN_TOKEN` is unset, the admin API answers 503; it fails closed. A typo
in `.env` locks you out of the API but does not stop uploads.

### MangaDex credentials

Only `core-uploader` and `core-processor` hold these. Nothing else in the system,
 and definitely no worker, ever sees them.

```bash
padmin pause --minutes 15          # let in-flight uploads finish
# Change MANGADEX_PASSWORD / MANGADEX_CLIENT_SECRET in .env
docker compose up -d core-uploader core-processor
docker compose logs -f core-uploader     # watch for a successful auth
padmin resume
```

Then revoke the old MangaDex API client in the MangaDex account settings. If
you are rotating because the credential leaked, revoke **first** and accept the
downtime; a live stolen credential is worse than a paused queue.

### Database password

```bash
docker compose exec postgres psql -U publoader -d publoader \
  -c "ALTER USER publoader WITH PASSWORD '<new>';"
# Update POSTGRES_PASSWORD (and DATABASE_URL if you set it explicitly) in .env
docker compose up -d
```

---

## Stuck jobs and the dead-letter queue

A job reaches `DEAD_LETTER` when it exhausts `maxAttempts` on transient errors,
or immediately on a `PERMANENT` or `POLICY` error.

```bash
padmin dead-letter
padmin runs show <runId>        # per-job attempt count, lease holder, lastError
```

Read the `CLASS` column first; it tells you what kind of problem you have:

| Class | Meaning | What to do |
|---|---|---|
| `TRANSIENT` | Retried and kept failing. Site down, rate limited, network. | Fix the cause, then `padmin jobs retry <id>`. |
| `PERMANENT` | The extension raised something that will not succeed on retry. | Read `lastError`. Usually an extension bug or a site layout change; fix the extension, `bundle publish`, then trigger a fresh run rather than retrying the old job (the old job is pinned to the old bundle sha). |
| `POLICY` | The worker refused to run it, or the result violated the manifest. | Almost always a manifest problem: `allowed_hosts` missing a domain the extension fetches, a language not declared, wrong `mangadex_group_id`, or a bundle sha the worker could not obtain. Fix and republish. |

**Retry** a dead-lettered job:

```bash
padmin jobs retry <jobId>
```

This resets it to `PENDING` with the attempt counter cleared. It re-executes on
whichever worker claims it next.

**Cancel** instead, when the job should not run at all:

```bash
padmin jobs cancel <jobId>
```

**A job stuck in `LEASED` or `RUNNING`** is not stuck; it holds a lease that
expires. The sweeper (`SWEEP_INTERVAL_SECONDS`, default 30) requeues it once
`leaseExpiresAt` passes. If you see a job whose `LEASE EXPIRES` is in the past
and it has not moved after two sweep intervals, the scheduler is not running:

```bash
docker compose ps core-scheduler
docker compose logs --tail 100 core-scheduler
# Unix time of the last COMPLETED tick. Compare it against `date +%s`: more
# than two intervals behind means the loop is not turning.
curl -s http://core-scheduler:8101/metrics | grep publoader_scheduler_last_tick
```

---

## Quarantine triage

A quarantined result is a worker that submitted something the core refused to
believe. This is the security-relevant queue, not just an error queue.

```bash
padmin quarantine
```

Each row names the worker and the reason. Group them mentally:

**Reasons that mean "manifest is wrong"**: the common case, and not an attack:

- `host not in allowed_hosts`: the extension fetches a domain the manifest
  does not declare. Add it, republish, re-run.
- `language not in manifest languages`: the extension returned a language the
  manifest does not list.
- `mangadexGroupId mismatch`: the extension returned a group id different from
  the manifest's. Verify which one is correct before "fixing" the manifest;
  uploading under the wrong group is worse than a quarantined result.

**Reasons that mean "look harder"**:

- Schema violations (unknown fields, wrong types) from a worker running a
  bundle sha you published. The core and the worker validate against the same
  contract, so a mismatch here means the worker is not producing what the
  runner shim produces; i.e. it is not running the code you think it is.
- Counts over cap, or chapter ids for manga outside the job's segment. The
  runner filters to the segment's manga ids, so seeing others means the filter
  was bypassed.

**If one worker accounts for most of the quarantine:**

```bash
padmin quarantine | awk '{print $3}' | sort | uniq -c | sort -rn
padmin workers drain <workerId>      # stop giving it work
padmin audit --limit 200             # what else has it done
```

Then decide: a `COMMUNITY` worker producing invalid envelopes gets revoked. A
`TRUSTED` worker doing so is a bug in the agent or the shim, and you should
find it before re-activating.

**Nothing quarantined ever reaches MangaDex.** Quarantine is terminal for that
submission; the job is retried and re-run rather than the envelope being
"fixed". There is no approve-and-commit path, deliberately.

---

## Triage a stuck upload task

Upload tasks are the MangaDex-facing half of the pipeline: one row per chapter
to upload, edit, delete, or mark unavailable. A chapter that scraped fine but
never appeared on MangaDex is stuck here, not in a job.

```bash
padmin queues list                                  # depths + rows
padmin queues list --state DEAD_LETTER               # the ones that gave up
padmin queues list --kind DELETE --state PENDING
```

Read the state first:

| State | Meaning | What to do |
|---|---|---|
| `PENDING` | Waiting for an uploader to claim it. `NOT BEFORE` in the future means it is backing off after a failure. | Nothing, unless `NOT BEFORE` is long past and nothing moves; then `core-uploader` is not running. |
| `LEASED` | An uploader is working on it right now. | Nothing. Look at `core-uploader`'s logs if it never leaves this state. |
| `FAILED` / `DEAD_LETTER` | Retries exhausted, or a permanent MangaDex rejection. `ERROR` says which. | Fix the cause, then `padmin queues retry <id>`. |
| `DONE` | Finished; or cancelled. A cancelled row says so in `ERROR`. | Nothing. |

**Retry** once the cause is fixed. This clears the attempt counter, so the task
gets a full budget rather than dead-lettering on the first hiccup:

```bash
padmin queues retry <taskId>
```

**Cancel** when the task should never run. There is no `CANCELLED` state, so the
row is marked `DONE` with an operator note in `lastError`: a bare `DONE` would
be indistinguishable from a chapter that actually uploaded:

```bash
padmin queues cancel <taskId>
```

Cancel refuses (409) on a `LEASED` row. An uploader owns that task; forcing it
`DONE` would race that process into either a duplicate upload or a lost result.

**Nothing is draining at all.** The usual cause is an uploader that died holding
leases. Leases expire on their own, but you can reclaim them now:

```bash
padmin queues requeue-stale       # only touches leases already past expiry
docker compose ps core-uploader
docker compose logs --tail 100 core-uploader
```

If tasks are `PENDING` with `NOT BEFORE` in the past and `requeue-stale`
reclaims nothing, the queue is fine and the consumer is not: check the pause
gate (`padmin stats`) before anything else.

**Everything that failed, in one list.** Dead-lettered jobs, failed upload
tasks, and quarantined submissions merged and time-ordered; the fastest way to
see whether a bad hour was one cause or three:

```bash
padmin errors --limit 100
```

**Clear what you have dealt with.** The feed is only useful if an empty feed
means something, so a failure that has been read and fixed can be acknowledged
and it drops out of the list:

```bash
padmin errors clear 3f9a1c2b --note "upstream 503s, extension fixed in 1.4.2"
padmin errors clear --all                # after working through the list
padmin errors --cleared only             # what was acknowledged, by whom, why
padmin errors restore 3f9a1c2b           # it was not actually fixed
```

Clearing hides, it never deletes: the job, upload task or submission keeps its
state, `padmin dead-letter` and the Activity feed still show the failure, and the
`errorsOutstanding` count that drives the dashboard badge is what drops. Anything
that fails *again* comes back on its own; the acknowledgement is recorded against
that failure's timestamp, so a cleared-then-retried-then-failed job returns as new
work rather than staying silenced. The same operation is on the dashboard's Errors
view, `/errors clear` in Discord, and `POST /api/v1/admin/errors/clear`.

This is deliberately *not* a log endpoint. **Container logs stay on the host**:
work executes in containers (and on remote worker hosts) that the core cannot
read, so `docker compose logs -f core-uploader` remains the way to read them.
`padmin errors` reports platform state; `docker logs` reports processes. The
same split holds in the dashboard: Errors shows the feed, and nothing in the UI
tails a log file.

---

## Kill a run in progress

When a run is doing something wrong, a bad extension build, a mapping mistake,
an upstream site returning nonsense, stop the whole run rather than its jobs one
at a time:

```bash
curl -sX POST $CORE/api/v1/admin/runs/$RUN_ID/cancel -H "authorization: Bearer $ADMIN_TOKEN"

# everything unfinished, optionally for one extension
curl -sX POST $CORE/api/v1/admin/runs/cancel-all \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"extension":"mangaplus"}'
```

Every job the run still has outstanding goes to `CANCELLED` immediately, and a
worker mid-execution aborts at its next lease renewal. Nothing can land
afterwards: `cancel_requested` blocks a re-claim even after the lease sweeper
requeues an abandoned job, and ingest only accepts an envelope for a job still in
`LEASED`/`RUNNING`, so a worker that finishes anyway has its result superseded
rather than committed.

**Prefer this to cancelling individual jobs on a partitioned run.** Cancelling
one segment leaves the others to finish, and the run is then processed from
incomplete results; which on a CLEAN run means the processor concludes that
every chapter the missing segment covered has vanished upstream, and queues it
for removal. A killed run never reaches the processor at all.

A finished run is refused with 409 rather than "cancelled", because cancelling
completed work would misreport what happened. The run lands in `CANCELLED`, not
`DEAD_LETTER`: this was a decision, and the state an operator reads later should
say so.

---

## Queue management

The section above is triage: look at a stuck task, retry it, cancel it. This one
is the rest of the job; acting on many rows at once, emptying a queue, changing
what runs next, and queueing or correcting a chapter by hand. Everything here
lives under `/api/v1/admin/queues`, needs `runs:write` (`runs:read` to look),
and is audit-logged with the acting principal.

```bash
API=https://publoader.ardax.dev
AUTH="authorization: Bearer $ADMIN_TOKEN"
```

**Two rules hold everywhere in this section, and they are not configurable.**

1. **A `LEASED` row is untouchable.** The lease means `core-uploader` is
   mid-flight against MangaDex right now. Every endpoint below refuses one, and
   the refusal names the lease id so you can find it in the uploader's logs. The
   only safe interactions are to wait for the lease to expire (the sweeper
   requeues it) or to stop the work upstream. If you are tempted to force it:
   forcing a leased row races that process into either a duplicate chapter on
   MangaDex or a result that is silently lost.
2. **A `DONE` row is load-bearing.** See "Deleting a DONE row" below before you
   delete one.

### Look at a queue

```bash
# depth per kind and state, nothing else
curl -fsS "$API/api/v1/admin/queues" -H "$AUTH"

# the queue in the order it will actually drain
curl -fsS "$API/api/v1/admin/queues/tasks?kind=UPLOAD&state=PENDING&limit=50" -H "$AUTH"

# everything that gave up, oldest first, with the failure text
curl -fsS "$API/api/v1/admin/queues/tasks?state=FAILED&state=DEAD_LETTER" -H "$AUTH"

# one series' worth: dedupeKey is a case-insensitive substring
curl -fsS "$API/api/v1/admin/queues/tasks?dedupeKey=1234%7C&attemptMin=3" -H "$AUTH"

# the same queue read as CHAPTERS, numbered in claim order; which series,
# which chapter, and what an EDIT is going to change
curl -fsS "$API/api/v1/admin/queues/chapters?limit=50" -H "$AUTH"

# ...searched by series name rather than by dedupe key
curl -fsS "$API/api/v1/admin/queues/chapters?q=sakamoto" -H "$AUTH"

# what is scheduled to be taken down, and for which publisher
curl -fsS "$API/api/v1/admin/queues/tasks?kind=UNAVAILABLE&extension=mangaplus" -H "$AUTH"

# find a chapter by series, title, number or either MangaDex id
curl -fsS "$API/api/v1/admin/queues/tasks?q=blue%20lock&language=en" -H "$AUTH"

# newest first instead of claim order: what has just been queued
curl -fsS "$API/api/v1/admin/queues/tasks?sort=desc&limit=50" -H "$AUTH"
```

`?sort=` takes `asc` (the default, and the claim order a reorder is checked
against) or `desc` (the same total ordering reversed, newest first). Both
endpoints take it, both echo the applied direction back as `sort`, and paging
works either way: the cursor keys on the same `(not_before, created_at, id)` and
only the comparison flips. The dashboard asks for `desc`, because a queue is
usually being watched rather than audited. `position` on `/queues/chapters` is
NOT reversed: it always counts from the front of the claim order, so on a
descending page it counts down.

`GET /queues/chapters` is the same rows and the same ordering as
`/queues/tasks`, projected through the chapter payload. Reach for it when the
question is *what is about to be published*; a dedupe key of `1015117|142|en`
identifies a chapter only to someone willing to decode it; and for
`/queues/tasks` when the question is *what is stuck and why*. It defaults to
`PENDING`, and its `position` is the place in the whole filtered claim order, so
"14th" survives paging.

`/queues/tasks` is readable as chapters too: every row carries an `identity`
object (series, both MangaDex ids, number, volume, title, language, extension)
built in the same statement, so the incident view names what it contains without
a fetch per row.

### Filtering a queue by the chapter rather than the row

`dedupeKey` only reads a row's identity for `UPLOAD` tasks; for `EDIT`, `DELETE`
and `UNAVAILABLE` the dedupe key *is* the MangaDex chapter id, so searching it
means already knowing the UUID. Three filters read the queued payload instead,
and they are what make those kinds findable:

| Filter | Match | Reads |
|---|---|---|
| `q` | case-insensitive substring | series name, chapter title, chapter number, and both MangaDex ids |
| `extension` | exact | the payload's `extensionName` |
| `language` | exact | the payload's `chapterLanguage` |

All three are part of the shared filter shape, so they narrow the bulk verbs
exactly as they narrow a list: `{"filter": {"kind": "UNAVAILABLE", "extension":
"mangaplus"}}` on `retry`, `remove` or `purge` acts on that set and no other.
They read JSONB rather than an indexed column, so they scan; that is fine for an
operator query on a paged view and is the reason they are not offered as an
uncapped export.

This list is ordered by `notBefore`, the same ordering `core-uploader` claims
in, so it answers *what runs next*. `GET /api/v1/admin/upload-tasks` (the older
endpoint) orders the same rows by `updatedAt` and answers *what changed last*.
Both are useful; do not mistake one for the other when checking a reorder.

Paging is by cursor, not offset: `notBefore` changes constantly as the queue
drains, so an offset page would skip and repeat rows. Pass the `nextCursor` from
the previous response back as `?cursor=`. The `summary` is always global, so a
narrow filter cannot hide a queue that is backing up, and `total` counts the
whole filtered set rather than the page.

`chapter` is omitted from the list (it is large and worker-supplied). Fetch one
row to see it: `GET /api/v1/admin/queues/tasks/<id>`.

### Retry in bulk

Retry moves `FAILED`/`DEAD_LETTER` back to `PENDING`, resets `attempt` to 0, and
makes the task due immediately. The budget reset is deliberate: you are
asserting the cause is fixed, and leaving `attempt` at `maxAttempts` would
dead-letter the task again on the first hiccup.

```bash
# by id
curl -fsS -X POST "$API/api/v1/admin/queues/retry" -H "$AUTH" \
  -H 'content-type: application/json' \
  -d '{"ids":["<id>","<id>"]}'

# everything that gave up on one queue; a filter is intersected with
# FAILED/DEAD_LETTER, so this does not touch pending or completed rows
curl -fsS -X POST "$API/api/v1/admin/queues/retry" -H "$AUTH" \
  -H 'content-type: application/json' \
  -d '{"filter":{"kind":"UPLOAD"}}'
```

Bulk calls always answer `200` with one result per requested id, plus `changed`
and `refused` counts. Read `results`, not the status code: a select-all over 200
rows where three are leased is a success with three skips. The single-row route
(`POST /queues/tasks/<id>/retry`) answers `409` instead, which is what you want
when you named one row.

More than 1000 matching rows are capped; the response says `capped: true` and
you call again.

### Remove rows

Remove deletes the row outright; there is no undo and no archive. It needs
`confirm: true`, and it refuses `LEASED` always and `DONE` unless you also pass
`includeCompleted: true`.

```bash
# one row
curl -fsS -X DELETE "$API/api/v1/admin/queues/tasks/<id>" -H "$AUTH" \
  -H 'content-type: application/json' -d '{"confirm":true}'

# many
curl -fsS -X POST "$API/api/v1/admin/queues/remove" -H "$AUTH" \
  -H 'content-type: application/json' \
  -d '{"ids":["<id>","<id>"],"confirm":true}'
```

The response names every row it deleted (id, kind, dedupe key, prior state), and
so does the audit event; after the statement runs, that log line is the only
record those rows ever existed.

**Remove or cancel?** `POST /api/v1/admin/upload-tasks/<id>/cancel` marks the row
`DONE` with an operator note in `lastError`, which keeps the dedupe slot occupied
and so keeps the chapter from being re-enqueued by the next run. Removal frees
the slot. Prefer **cancel** for "this chapter should never be uploaded" and
**remove** for "this row is junk and I want the queue clean".

### Purge a queue

Purge empties a queue by kind and/or state. `dryRun` defaults to **true**, and
that default is the safety property: a first call, including one from a client
that forgot the field, reports what would go and writes nothing at all, not even
an audit row.

```bash
# 1. see what it would take
curl -fsS -X POST "$API/api/v1/admin/queues/purge" -H "$AUTH" \
  -H 'content-type: application/json' \
  -d '{"kind":"DELETE","state":"DEAD_LETTER"}'
# -> {"dryRun":true,"matched":412,"wouldDelete":412,"protectedRows":0,
#     "breakdown":[...],"sample":[...20 rows...]}

# 2. take it
curl -fsS -X POST "$API/api/v1/admin/queues/purge" -H "$AUTH" \
  -H 'content-type: application/json' \
  -d '{"kind":"DELETE","state":"DEAD_LETTER","dryRun":false,"confirm":true}'
```

`dryRun: false` without `confirm: true` is a 400. `matched` counts everything
your filter selects and `wouldDelete` counts what may actually go, so
`protectedRows` shows how many leased or completed rows are in your filter but
not in the delete set. Purges are capped at 5000 rows per call and the response
says how many are left.

Asking to purge a protected state is a 400 that says why, rather than a cheerful
"0 deleted": `{"state":"LEASED"}` is never purgeable, and `{"state":"DONE"}`
needs `includeCompleted: true`.

### Reorder: what runs next

The queue has no priority column. It is ordered by `notBefore`: the claim query
reads `WHERE state = 'PENDING' AND not_before <= now() ORDER BY not_before ASC`,
so that one timestamp is both the readiness gate and the sort key. Reordering is
therefore just rewriting it, which needs no schema change and leaves exactly one
field deciding order.

```bash
reorder() {
  curl -fsS -X POST "$API/api/v1/admin/queues/reorder" -H "$AUTH" \
    -H 'content-type: application/json' -d "$1"
}

# these three run next, in this order
reorder '{"ids":["<a>","<b>","<c>"],"mode":"front"}'

# get out of the way of everything else
reorder '{"ids":["<id>"],"mode":"back"}'

# keep their place in the queue, fix their order among themselves
reorder '{"ids":["<ch1>","<ch2>","<ch3>"],"mode":"sequence"}'

# not for the next hour (rate-limited by the publisher, say)
reorder '{"ids":["<id>"],"mode":"defer","deferSeconds":3600}'
```

| Mode | Effect |
|---|---|
| `front` | Claimed next, in the order given, and due immediately even if the rest of the queue is backing off into the future. |
| `back` | Behind every other pending row. |
| `sequence` | The group keeps its slot in the queue; only its internal order changes. Use this to make chapter 1 upload before chapter 2. |
| `defer` | Each row pushed `deferSeconds` further out, measured from now for a row that is already due. |

`PENDING` only. A `FAILED` or `DEAD_LETTER` row is not in the queue at all, so
its `notBefore` means nothing until you retry it; reordering one is refused with
`wrong_state`. The response's `ordered` array is the resulting claim order, so
you can verify the change rather than trust it.

### Queue a chapter by hand

`POST /api/v1/admin/queues/tasks` creates a task from a chapter payload you
supply. **This is the sharpest tool in the API**: an `UPLOAD` row queued here
will, within minutes, create a real chapter on MangaDex under the group in the
payload. It requires the `ADMIN` role or above (not just `runs:write`) and the
whole payload goes into the audit log.

```bash
curl -fsS -X POST "$API/api/v1/admin/queues/tasks" -H "$AUTH" \
  -H 'content-type: application/json' -d '{
    "kind": "UPLOAD",
    "chapter": {
      "chapterId": "src-4001", "chapterNumber": "12", "chapterLanguage": "en",
      "chapterTitle": "A Title", "chapterUrl": "https://example.com/12",
      "mdMangaId": "<mangadex manga uuid>", "mdGroupId": "<group uuid>",
      "mangaName": "Test Series", "extensionName": "mangaplus",
      "imageArtifacts": ["<artifact uuid>", "..."]
    }
  }'
```

Required fields, by kind; a payload missing them is a 422 listing every problem
at once, because each one is an error the uploader would otherwise raise *after*
claiming the task and, for `UPLOAD`, after opening a MangaDex upload session:

| Kind | Needs | Dedupe key |
|---|---|---|
| `UPLOAD` | `mdMangaId`, `mdGroupId`, `chapterLanguage` | `chapterId\|chapterNumber\|chapterLanguage` |
| `EDIT` | `mdChapterId`, plus a non-empty `payload` object (the fields to change) | `mdChapterId` |
| `DELETE` | `mdChapterId` | `mdChapterId` |
| `UNAVAILABLE` | `mdChapterId` | `mdChapterId` |

The dedupe key is derived by the same rule the processor uses, and page
artifacts are checked to exist before the row is written. A duplicate is a 409
naming the task that already holds the slot; that unique `(kind, dedupeKey)`
constraint is exactly what makes a double upload impossible, so there is no flag
to override it. If you genuinely need to re-upload a chapter, deal with the
existing row first (retry it, or remove it and understand the note below).

`UPLOAD` without `imageArtifacts` is legal and produces an external-only
chapter; the same thing the pipeline creates for a publisher whose pages we do
not host. That is rarely what you meant when queueing by hand.

### Correct a queued task

```bash
curl -fsS -X PATCH "$API/api/v1/admin/queues/tasks/<id>" -H "$AUTH" \
  -H 'content-type: application/json' \
  -d '{"chapter":{"chapterTitle":"Fixed"},"notBefore":"2026-08-01T00:00:00Z","maxAttempts":9}'
```

`PENDING` only; a leased task is being executed and a `DONE` or dead one is
history. `chapter` is a shallow merge, so you can fix one field without
restating the payload; send `null` to clear a field. If the edit changes an
identity field the dedupe key is recomputed, and a collision with another task's
key is a 409 rather than a silent overwrite. A `FAILED` row must be retried
first, which returns it to `PENDING`.

### Deleting a DONE row

A `DONE` upload task plus its `upload_logs` rows are what make reprocessing
idempotent, and they work in that order:

- The `DONE` row occupies the unique `(kind, dedupeKey)` slot, so the next run's
  enqueue for that chapter is a no-op. **This is the first line of defence.**
- The `COMMITTED` upload log carries the MangaDex chapter id. If a chapter is
  enqueued again anyway, the uploader finds that log, re-checks the chapter still
  exists on MangaDex, and skips. **This is the second, and it only exists on the
  `UPLOAD` path.**

So deleting a `DONE` row removes the first defence. For `UPLOAD` the second one
usually catches it; for `EDIT`, `DELETE` and `UNAVAILABLE` there is nothing, and
the task simply runs again against MangaDex. That is why `includeCompleted: true`
is required on top of `confirm: true`, and why the response says so out loud.

Delete `DONE` rows when you are pruning old completed work you are certain will
never be re-derived, or when you deliberately want a chapter reprocessed and have
checked what that will do. Do not delete them to "clean up the queue"; a `DONE`
row costs one row and buys idempotency.

### What the older endpoints still do

`/api/v1/admin/upload-tasks/*` (documented in the triage section above) is not
superseded and is not going away:

| Need | Endpoint |
|---|---|
| What changed last, one filtered page | `GET /admin/upload-tasks` |
| What runs next, filtered, paged, with a total | `GET /admin/queues/tasks` |
| Retry one | either (`/admin/upload-tasks/<id>/retry`, `/admin/queues/tasks/<id>/retry`) |
| Abandon a chapter, keeping its dedupe slot | `POST /admin/upload-tasks/<id>/cancel` |
| Reclaim expired leases now | `POST /admin/upload-tasks/requeue-stale` |
| Everything else on this page | `/admin/queues/*` |
| What is about to be published, as chapters | `GET /admin/queues/chapters` |
| What a run actually found | `GET /admin/runs/<id>/chapters` |
| What is on MangaDex now, and its history | `GET /admin/chapters` |

---

## Fix a chapter that is already published

The queue endpoints above act on *work that has not run yet*. This section is the
other case: the chapter is on MangaDex, and it is wrong.

Everything here goes through `/api/v1/admin/chapters/*` (Chapters in the
dashboard), and every action **queues an upload task** rather than calling
MangaDex; `core-uploader` remains the only process with write credentials, so
the response is `202` with a task id and the change lands within seconds. Watch
it under Queues, filtered to that chapter id.

Two guards apply to all three actions: the **ADMIN** role on top of
`chapters:write`, and no api tokens at all. Use the dashboard, or the break-glass
`ADMIN_TOKEN`.

### Find the chapter

```bash
# by anything: series name, chapter title, or any of the four ids
curl -s -H "authorization: Bearer $ADMIN_TOKEN" \
  "$API/api/v1/admin/chapters?search=$(printf %s 'Series Name' | jq -sRr @uri)" | jq '.chapters[]'

# everything one extension has up
curl -s -H "authorization: Bearer $ADMIN_TOKEN" \
  "$API/api/v1/admin/chapters?extension=mangaplus&limit=200" | jq '.total'
```

`?archive=unavailable|deleted|edited` reads the three history tables with the
same filters. Paging is by the `nextCursor` the response hands back, never an
offset; the table grows while it is being read.

Then open one chapter, which is the read worth doing before any change: it shows
our row, **what MangaDex says right now**, and anything already queued against it.

```bash
curl -s -H "authorization: Bearer $ADMIN_TOKEN" \
  "$API/api/v1/admin/chapters/$MD_CHAPTER_ID" | jq '{chapter, mangadex, mangadexError, tasks, archives}'
```

### Correct its metadata

The body uses MangaDex's field names; `null` clears a field and an omitted field
is left alone. The uploader lays this over MangaDex's current resource when it
runs, because `PUT /chapter` replaces rather than patches and needs the version
current at that moment.

```bash
curl -s -X PATCH -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"chapter":"12.1","title":"The right title"}' \
  "$API/api/v1/admin/chapters/$MD_CHAPTER_ID"
```

### Replace it with an unavailable card

The chapter keeps its place on MangaDex; its page becomes the card and the
publisher link is repointed away from the dead URL. Preview the exact image
first; the endpoint renders it with the same code the uploader posts:

```bash
curl -s -H "authorization: Bearer $ADMIN_TOKEN" \
  "$API/api/v1/admin/chapters/$MD_CHAPTER_ID/card.png" > /tmp/card.png

curl -s -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"footerNote":"Removed at the publisher'"'"'s request."}' \
  "$API/api/v1/admin/chapters/$MD_CHAPTER_ID/unavailable"
```

**Regenerating a card that is already posted needs `force: true`.** Without it
the uploader sees a chapter with nothing left to take down and correctly does
nothing, which is right for the automated pass and useless when the card on a
public page says the wrong thing. Asking without the flag is a `409` that says
so, rather than a silent no-op.

```bash
curl -s -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"force":true,"footerNote":"Corrected wording."}' \
  "$API/api/v1/admin/chapters/$MD_CHAPTER_ID/unavailable"
```

### Re-post the cards already on MangaDex

A card is rendered at the moment it is posted, so every card in the catalogue is
a fossil of the build that put it there. When the renderer changes — a font that
was missing, wording that was wrong, a layout that clipped long titles — the only
fix for the pages already up is to render them again and post them over the top.

**Dashboard → System → Unavailable cards.** Four targets, because the occasions
differ: one chapter somebody complained about, **one series**, a set ticked out
of the archive, or every card on the site after a renderer fix. Preview first;
the preview resolves the same rows and checks the same refusals as the live run.

The series target is the one most complaints arrive as — a reader reports that a
title's pages are wrong, not that chapter `1c2d…`'s are. Picking it out of the
list shows how many cards that title has up before anything is queued; from the
CLI it is one command that follows its own continuation to the end:

```bash
# which titles have cards up, largest first
padmin chapters series --archive unavailable --search sakamoto

# what re-carding one of them would do, then doing it
padmin chapters recard --series "$MD_MANGA_ID"
padmin chapters recard --series "$MD_MANGA_ID" --apply
```

`/recard` in Discord answers the same question and hands back that command line;
it cannot queue the work itself, because card images are closed to api tokens at
the endpoint.

By hand it is one route, always forced, always the `unavailable` archive:

```bash
# one series, previewed
curl -s -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d "{\"filter\":{\"mdMangaId\":\"$MD_MANGA_ID\"}}" \
  "$API/api/v1/admin/chapters/unavailable/recard"

# every unavailable chapter, previewed
curl -s -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"filter":{}}' "$API/api/v1/admin/chapters/unavailable/recard"

# and live, one page at a time
curl -s -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"filter":{},"dryRun":false,"confirm":true}' \
  "$API/api/v1/admin/chapters/unavailable/recard"
```

The response carries `nextAfterId`; repeat with `{"afterId":"<that>"}` until it
comes back `null`. The dashboard does that loop for you and reports the running
count as it goes.

Two things this route does that `/chapters/bulk/unavailable` does not, and the
reason it is a separate route rather than another flag:

- **The card keeps the date the chapter went unavailable.** The bulk route stamps
  `new Date()`, which is right for a chapter going unavailable now and wrong for
  one pulled in March; through it, re-rendering a year-old page rewrites its
  "available until" line.
- **A whole-archive sweep terminates.** The uploader rewrites `unavailable_at` as
  it archives, so paging on that column re-reads the rows it just processed for
  ever. This pages on the primary key instead.

Chapters that have never been carded refuse as `not_unavailable`: this re-posts,
it never cards a chapter for the first time. Use the section above for that.

### Delete it

The one irreversible action. `confirm: true` is required, the reason goes into
the audit trail, and the whole row is copied into that audit entry; after the
uploader runs, it and `deleted_chapters` are the only records the chapter
existed. Prefer the unavailable card unless the chapter should never have been
published at all (a duplicate, a wrong series).

```bash
curl -s -X DELETE -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"confirm":true,"reason":"duplicate of ch. 12"}' \
  "$API/api/v1/admin/chapters/$MD_CHAPTER_ID"
```

### Do it to a whole set

The same three actions take a set of chapters; either a list of ids, or a
filter (`?archive=`, `extension`, `language`, `mdMangaId`, `chapterNumber`,
`search`, `since`, `until`). The realistic cases are "this series was licensed,
take the lot down" and "that run uploaded fifty chapters under the wrong volume".

**Every bulk call is a dry run unless you say otherwise.** With no flags it
writes nothing, queues nothing, audits nothing, and returns a per-chapter
prediction; including the chapters it would refuse and why. Read that list;
it is the last chance anyone gets.

```bash
# what would happen (this is inert)
curl -s -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"filter":{"mdMangaId":"'"$MD_MANGA_ID"'"}}' \
  "$API/api/v1/admin/chapters/bulk/unavailable" | jq '{matched, wouldQueue, blocked, capped, results}'

# then, and only then
curl -s -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"filter":{"mdMangaId":"'"$MD_MANGA_ID"'"},"dryRun":false,"confirm":true,
       "footerNote":"Licensed; removed at the publisher'"'"'s request."}' \
  "$API/api/v1/admin/chapters/bulk/unavailable" | jq '{queued, refused, results}'
```

A bulk **edit** only takes the fields a set of chapters can legitimately share;
`volume`, `translatedLanguage`, `groups`. A title, a chapter number or a source
URL belongs to one chapter, so those stay on the single-chapter route rather than
being available to apply two hundred times by accident.

```bash
curl -s -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"filter":{"mdMangaId":"'"$MD_MANGA_ID"'"},"changes":{"volume":"3"},"dryRun":false,"confirm":true}' \
  "$API/api/v1/admin/chapters/bulk/edit"
```

**200 chapters per call.** A wider filter answers `capped: true`; run it again
for the rest. The response is a `200` with `queued`, `refused` and a result per
chapter; a batch is routinely a success and a partial failure at once, and the
per-chapter rows are the part to act on. Each queued chapter also gets its own
audit event, correlated by a shared `bulk` id, so the history of one chapter
still explains itself.

In the dashboard this is the tick-boxes on the Chapters list plus the bar above
it; the **whole filter** toggle switches the buttons from the ticked rows to
everything the current filter matches. Each button opens a dialog that previews
first and only then offers to queue.

### When it refuses

| Answer | Meaning |
|---|---|
| `409 already_queued` | A task of that kind for this chapter is queued and has not run. Look at it under Queues; edit or remove it there rather than stacking a second one. |
| `409 leased` | An uploader is executing that action right now. Wait for it and read the result before deciding again. |
| `409 already_unavailable` | The card is already posted; pass `force: true` to replace it. |
| `409` naming a deletion | The chapter is recorded as deleted, so there is nothing left to change. If MangaDex still has it, the archive row is stale; queue the task by hand from `/admin/queues/tasks`. |
| `403` closed to api tokens | Use the dashboard as a signed-in admin, or the break-glass admin token. |
| `superseded: true` in a `202` | Normal. A completed task for this chapter was reset in place, because nothing deletes `DONE` rows and the slot is one per (kind, chapter). |

---

## Reconcile our record of the chapters with MangaDex

Every chapter table here is written by this platform as it acts: `uploaded_chapters`
when a run uploads something, `unavailable_chapters` and `deleted_chapters` by the
upload-task workers at the moment those workers act. That makes them a log of *our
actions* rather than a description of the catalogue, and the two come apart whenever
the log is incomplete: a database restored without them, a migration, work done
before the tables existed, or an upload history younger than the catalogue itself.
MangaDex still carries the evidence; nothing was reading it back.

**What "marked unavailable" looks like on MangaDex.** An external chapter, the
only kind this platform publishes, normally has no pages: the reader follows
`externalUrl` to the publisher. Marking one unavailable replaces that with a
card, and the card is a page. So:

| MangaDex record | Meaning |
|---|---|
| `externalUrl` set, `pages > 0` | carries our card: **marked unavailable** |
| `externalUrl` set, `pages == 0` | live; the reader clicks through |

On the live group that separates without a single ambiguous case: 112 carded
chapters, every one with exactly one page, against 6108 live ones with none. The
`externalUrl` of a carded chapter is no help on its own; the card flow repoints
it at the series or domain root rather than clearing it, which is why the page
count is the signal and the URL is not.

`padmin chapters reconcile` rebuilds all three tables from that. Three passes,
and they are not variations of one thing:

- **discover**: walk our groups' chapters on MangaDex and archive the carded
  ones. This deliberately does not start from `uploaded_chapters`: on a database
  whose upload history is younger than the catalogue, the carded chapters have
  no row there. Measured on the live deployment, the overlap was zero. The
  archive row is seeded from the MangaDex record itself.
- **adopt**: the same walk's *live* chapters, the ones with no row of ours,
  recorded into `uploaded_chapters`. See [Adopting the live
  catalogue](#adopting-the-live-catalogue) below.
- **reconcile**: sweep `uploaded_chapters` for rows MangaDex no longer has, and
  archive those as deleted. Deletions can only be found in this direction: a
  chapter that is gone cannot be enumerated, so our own memory of uploading it
  is the only evidence there was one.

The default is a dry run that writes nothing:

```bash
padmin chapters reconcile
#   EXTENSION   GROUP     ON MD   CARDED   NEW   MD-HIDDEN   LIVE   UNTRACKED   ADOPTED   WITH ID
#   mangaplus   4f1de6a2   6220      112   112          24   6084        5593      5593      5593
#   mangaplus: chapter id read as the last 1 path segment(s) of the chapter URL
#   (100% of 491 existing row(s) agree)
#   scanned 491 uploaded row(s), 491 of them answered by the group walk
#   would record 112 unavailable and 0 deleted (found 112 / 0; the rest were
#   already archived), and would adopt 5593 live chapter(s) (5593 with a
#   recovered chapter id; 5593 untracked in total); re-run with --apply to write
```

### Adopting the live catalogue

`uploaded_chapters` records uploads *this* platform performed, seeded once from
the previous deployment's Mongo `uploaded` collection. That collection never
held the whole catalogue, so most of what our groups have on MangaDex — years of
it, uploaded by the predecessor — has no row here at all. On the live deployment
that is a few hundred rows against 6220 chapters MangaDex holds for the mangaplus
group. Nothing was closing that gap: the discover pass enumerated every one of
those chapters and then threw the live ones away.

**The gap is not cosmetic.** `uploaded_ids` is what `/api/v1/worker/jobs/claim`
hands an extension as `postedChapterIds`, and extensions use it to decide they
have nothing to fetch — mangaplus's `latest-chapter-posted` skip is exactly this.
A chapter with no id recorded is a detail call the extension makes again on every
run, forever, for a chapter uploaded years ago.

So adoption writes both:

- the `uploaded_chapters` row, from the MangaDex record: chapter number, title,
  volume, language, `readableAt`, the publisher `externalUrl`, the MangaDex manga
  and group ids, and the formatted title so the dashboard shows a series name
  rather than another bare UUID;
- an `uploaded_ids` row whenever the publisher's own chapter id can be recovered.

**Recovering the publisher chapter id.** MangaDex holds the publisher's URL but
never the publisher's id, and nothing in a manifest describes how one sits inside
the other. The rows we already have are worked examples of exactly that
relationship, so the rule is *measured* off the extension's own history rather
than assumed: on the live deployment all 491 mangaplus rows say "the id is the
last path segment", and that is what gets applied to the other 5593.

It fails closed, and says so. Fewer than five examples, examples that disagree
about where the id sits, or ids that are not in the URL at all, and there is no
rule: the row is still written, with a NULL `chapter_id`, and the command prints
which extension it could not answer for. A wrong id in `uploaded_ids` would tell
an extension a chapter is posted when it is not, which is an upload silently
never made, so "no answer" has to be cheaper than "an answer that might be
wrong". Rows adopted by an earlier run are excluded from the evidence, so one
early mis-parse cannot become its own justification.

**It never overwrites.** Adoption only inserts rows for chapters no table here
knows about. A chapter this platform actually uploaded carries publisher-side
identifiers MangaDex has never known about — the source chapter and manga ids,
the series URL — and a sweep that upserted would replace those with the
less-informed version. Chapters already archived as unavailable or deleted are
skipped too, so adoption cannot quietly undo the archiving pass that just ran.
An adopted row is marked `extra.adopted = "mangadex-reconcile"`, which is the
only thing distinguishing it from a row written because we performed the upload.

**One knock-on worth knowing.** The deletion sweep costs one MangaDex call per
row it cannot rule out, so a table thousands of rows larger would have made
`reconcile` unusable. It now skips any row the group walk already saw — MangaDex
just enumerated that group, so those rows cannot be deletions — and reports the
count as `answered by the group walk`. Only rows outside every walked group
still cost a call.

Read it before applying it. `deleted` is the row that matters: it claims a
chapter is gone forever, so it is only ever recorded on a 404 from the chapter's
own endpoint and never on a chapter merely missing from a list response.

**MD-HIDDEN is a different thing and is never archived.** Those are chapters
carrying no card of ours that MangaDex itself refuses to serve; MangaDex hiding
a chapter rather than us having marked one. They are arguably chapters that
*want* an `UNAVAILABLE` task, which is an operator's call, so the command lists
them and stops there.

```bash
padmin chapters reconcile --apply
```

Applying mirrors what the workers do: upsert the archive row, keep the MangaDex
snapshot under `extra.mdAttributes`, then drop any `uploaded_chapters` row so a
chapter lives in exactly one table. Where a chapter still has our row, the
publisher-side identifiers come from it rather than from MangaDex, which has
never known about them. It is safe to re-run: an id already archived keeps its
original timestamp, because that instant is when the change was first seen and a
later sweep does not know better. A chapter already recorded as deleted is never
resurrected as merely unavailable.

| Flag | Effect |
|---|---|
| `--apply` | Write. Without it nothing is written. |
| `--extension <name...>` | Only these extensions. |
| `--skip-deleted` | Skip the `uploaded_chapters` sweep: the slow half on a large table, and the only pass that can find deletions. |
| `--skip-adopt` | Report the untracked live chapters in the table above and record none of them. |
| `--skip-unavailable` | Report the carded chapters and archive none of them. |

The three skips make the three passes independently selectable, which is what
lets each dashboard button run exactly the one that writes the table being
looked at. `--skip-deleted --skip-unavailable` is adoption alone; `--skip-adopt`
is the archiving passes alone.

**Who can run it.** The dry run needs `chapters:read`, so any scoped token,
including the bot's, can ask. `/reconcile` in Discord reports the same counts.
Applying takes the same guard as every other mutating chapter route: ADMIN or
above, and closed to api tokens, so it is the dashboard or the break-glass
`ADMIN_TOKEN`.

**In the dashboard** the card is **Chapters → Reconcile with MangaDex**, on
every archive it can rebuild. **Check** reads MangaDex and reports the whole
drift; the button beside it writes only the table you are looking at, and there
is deliberately no button that writes all three:

| Archive | Button | What it runs | Needs Check first |
|---|---|---|---|
| On MangaDex (`uploaded`) | **Track them** | `skipDeleted`, `skipUnavailable` — adoption alone | no |
| Unavailable, Deleted | **Record them** | `skipAdopt` — the archiving passes alone | yes |
| Edited | — | the card is not offered; nothing here rebuilds it | — |

**Track them does not need a Check first**, and that asymmetry is deliberate.
Check is itself a full pass, so requiring it meant walking MangaDex twice to do
one thing. The discipline it enforces is about writes you cannot inspect
afterwards: **Record them** *moves* rows out of `uploaded_chapters` and claims
chapters are gone, so it still asks for a count first. Adoption only ever *adds*
rows, for chapters MangaDex says our own group published, and every row it adds
is marked `extra.adopted` and listed on the page below it. Its dialog still
names any extension whose chapter ids could not be recovered, because those rows
land visible and still outside `postedChapterIds`.

A single "do everything" button was the obvious shape and the wrong one — it
meant clicking **Record them** on the deleted archive and silently adding several
thousand rows to `uploaded`, which is neither what the label says nor what is on
screen.

### A pass runs in the background

**Nothing about reconcile happens inside the request that asks for it.** A group
walk is two full paginations at `MANGADEX_RATELIMIT_MS` (2s by default), which on
the mangaplus group is ~124 requests and about **four minutes**. Held open, that
request dies to the proxy in front of the API long before it answers — the
symptom is a Check button that "keeps failing" while the platform is perfectly
healthy, because a timeout and a fault look identical from the browser.

So `POST /chapters/reconcile` **starts** a pass and answers `202` immediately;
`GET /chapters/reconcile` reports where it is up to. Everything polls that:

- the dashboard card draws the live phase and count, and picks a running pass
  back up if you navigate away and return, rather than offering to start a second;
- `padmin chapters reconcile` prints a progress line and prints the report at the
  end — Ctrl-C stops the *watching*, not the pass;
- `/reconcile` in Discord waits ~30s and then reports whatever is known, because
  an interaction cannot be left open for minutes. Run it again for the numbers.

**One pass at a time.** A second start joins the one in flight and answers
`started: false`; that is not an error, it is the honest answer to a second click
on a four-minute button. Two passes racing would walk the same group twice and
then decide what to adopt from separate snapshots.

A pass whose progress has not moved for five minutes is treated as abandoned —
a restart mid-walk would otherwise leave `running` in the `settings` table
forever, and that row is a permanent lock on every button. It is a heartbeat,
not a deadline: progress is written on every MangaDex page, so a genuinely long
pass over many groups refreshes it far more often than the window and is never
stolen from under itself.

**Why this one writes directly** instead of queueing an upload task like every
other action on a published chapter: it changes nothing on MangaDex. Queueing
would be actively wrong: a chapter it finds is already carded, already gone, or
already live and merely unrecorded, so running the workers over them would
re-upload cards, re-issue deletes and re-upload chapters for work that is
already done.

> One MangaDex API trap is worth knowing, because it decides how the MD-HIDDEN
> column is measured. `isUnavailable` on a chapter looks like the direct answer
> and is not: the attribute is absent entirely from older records, and on the
> live group every hidden chapter came back with no such key. What MangaDex does
> reliably is drop them from collection reads unless `includeUnavailable=1` is
> set, so that state is measured as the difference between two otherwise
> identical calls. Its similarly-named siblings are traps in the other
> direction: `includeExternalUrl`, `includeEmptyPages` and
> `includeFuturePublishAt` are exclusive *filters* on that endpoint, and
> `includeExternalUrl=1` returns only external chapters.

---

## Clear a bad MangaDex session

The MangaDex token pair lives in the `settings` table (`mdauth_access` /
`mdauth_refresh`) so a restarted or replaced container resumes the same session.
The failure mode that creates is a *persistently* bad session: a refresh token
MangaDex no longer honours survives a restart, and every upload keeps failing to
authenticate.

Check first; this never prints the tokens themselves:

```bash
padmin mangadex auth
# accessToken   saved
# refreshToken  saved
# expiresAt     2026-07-29T22:41:03.000Z
# expired       true
# expiresIn     -12m
```

`expired true`, or repeated auth failures in `core-uploader`'s logs, means the
saved pair is the problem:

```bash
padmin mangadex clear-auth
```

The next MangaDex call authenticates from `MANGADEX_USERNAME` /
`MANGADEX_PASSWORD` / `MANGADEX_CLIENT_*` and writes a fresh pair. In-flight
uploads may fail once and retry. The action is audit-logged.

What this does **not** do:

- It does not revoke anything MangaDex-side. If the credential itself leaked,
  that is a rotation; see "MangaDex credentials" above, and revoke the client
  in MangaDex first.
- It does not change the configured credentials. If those are wrong, clearing
  the session just makes the failure louder.

`expiresAt unknown` is not a fault: the expiry is read from the access token's
`exp` claim without verifying it, and a token shape we cannot parse is reported
as unknown rather than assumed dead. Do not clear a session on that alone.

---

## Issue, rotate, and revoke a client token

Machine clients (the Discord bot, CI, a monitoring probe) authenticate with a
scoped `pa_…` token carrying only the scopes that client needs, so a leaked
credential is confined to its area. `ADMIN_TOKEN` is break-glass only and should
not be a client's day-to-day credential.

**Issue.** Start from a preset; the easy path should also be the
least-privilege one:

```bash
padmin tokens scopes                       # taxonomy + recommended sets
padmin tokens create --name discord-bot \
  --scopes runs:write,workers:read,extensions:read,untracked:write,stats:read,audit:read
padmin tokens create --name ci-publisher --scopes bundles:write --ttl-days 90
```

The secret is printed once and is unrecoverable; the database stores only its
sha256. Hand it over through a private channel.

**Rotate.** There is no reveal endpoint, so rotation is mint-then-revoke, which
also gives you an overlap window the `ADMIN_TOKEN` rotation does not have:

```bash
padmin tokens create --name discord-bot-2026-07 --scopes <same scopes>
# update the client's config, restart it, confirm it works
padmin tokens list                         # LAST USED confirms the new one is live
padmin tokens revoke <oldTokenId>
```

**Revoke.** Immediate and irreversible:

```bash
padmin tokens revoke <tokenId>
```

Revoke on any suspicion. `LAST USED` (throttled to one write per token per
minute, so treat it as approximate) is how you tell a dead credential from one
still in use before pulling it.

All of this is also in the dashboard's **Tokens** view, which is OWNER-only:
minting a token can grant any scope, so it is privilege escalation and stays a
human, owner-level action. No `pa_…` token, not even one scoped `*`, can mint
another token or touch accounts.

---

## Change what a role or an account may do

Roles ship with a scope baseline, not a fixed law. Two knobs, and reaching for
the smaller one first is usually right.

**Redefine a role** when the answer should apply to everybody in it:

```bash
padmin permissions show                    # the taxonomy, and where each role stands
padmin permissions set-role CONTRIBUTOR \
  --scopes extensions:read,tracked:read,tracked:append,untracked:write,stats:read
padmin permissions reset-role CONTRIBUTOR  # back to the shipped default
```

Only `ADMIN` and `CONTRIBUTOR` are tunable. `OWNER` is the wildcard by
construction and is the role that edits permissions at all, so narrowing it
could leave nobody able to widen it again; `ADMIN_TOKEN` is the only thing
behind it.

Resetting is a delete, not a re-typing of the default: a role with no override
tracks the shipped default as future releases change it, which is how a new
scope reaches your admins without you noticing. A role you have redefined does
**not** pick up new scopes — that is the trade for tuning it at all.

**Tune one account** when the answer is about one person, and inventing a fourth
role would be worse:

```bash
padmin permissions user <userId>                       # baseline, grants, denials, effective
padmin permissions set-user <userId> --deny bundles:write     # an ADMIN who may not publish
padmin permissions set-user <userId> --grant runs:read        # a contributor who may watch runs
padmin permissions set-user <userId> --clear                  # exactly their role again
```

Denials win over grants and over the role. They close **upward**: denying
`runs:read` also denies `runs:write`, because a write implies the read and would
hand it straight back. Denying a write leaves the read alone, which is how you
express "watch but do not touch".

Owners cannot be tuned — they hold everything regardless — and promoting an
account to `OWNER` clears its tuning rather than parking it, so a later demotion
cannot resurrect a denial nobody remembers.

**All of it takes effect on sessions that are already open**, within a few
seconds. You do not need to force anyone to sign in again; if you want them out
regardless, revoke the session from **Users → Sessions**.

Same operations in the dashboard's **Permissions** view and the **Permissions**
button on each account row, and from Discord with `/permissions` — though the
writing half of that needs the OWNER role, which a bot token never has (see
[bot.md](bot.md#which-scope-unlocks-which-command)). Every change is audited as
`permissions.role`, `permissions.role.reset` or `permissions.user`, recording
the before and after.

---

## Untracked series triage

When an extension reports a series that has no `tracked_manga` mapping, the
processor records an `untracked_manga` row instead of dropping it. What happens
next depends on the extension's manifest:

- `auto_create_titles: true`: the title service (inside `core-uploader`)
  creates and commits the MangaDex title automatically, writes the mapping into
  `tracked_manga`, and announces it to Discord with a
  `https://mangadex.org/title/<id>` link.
- `auto_create_titles: false` (the default): the row sits at `NEW` until an
  operator approves or skips it. Nothing is created on MangaDex without you.

```bash
padmin untracked list                 # everything
padmin untracked list --state NEW     # awaiting your decision
padmin untracked list --state FAILED  # creation was attempted and failed
```

### States

| State | Meaning |
|---|---|
| `NEW` | Reported, nothing done. Awaiting auto-creation or your approval. |
| `CREATING` | A title service instance has claimed it (CAS) and is calling MangaDex. Transient. |
| `CREATED` | The MangaDex title exists but the mapping is not yet written. Transient. |
| `TRACKED` | Done. `mdMangaId` is set and a `tracked_manga` row exists. |
| `FAILED` | Creation was attempted and failed. `lastError` says why. |
| `SKIPPED` | You decided this series should never get a title. Terminal. |

### Triaging `NEW`

For each row, decide whether the series should exist on MangaDex at all.
Check `MANGA`, `LANG`, and the source URL first; the common reasons to skip
are a series that already has a MangaDex title under a different name (the
mapping is missing, not the title), a duplicate the extension emitted under two
ids, or something the group does not actually translate.

```bash
# Already on MangaDex under a different id; map it instead of creating one.
padmin tracked set <extension> <externalMangaId> <mdMangaId>
padmin untracked skip <id>

# Genuinely new; create it now.
padmin untracked approve <id>
# -> prints the new mdMangaId and its mangadex.org URL

# Should never exist.
padmin untracked skip <id>
```

`approve` is synchronous: it creates the title, writes the mapping, announces
it, and returns the `mdMangaId`. It returns 409 if the row is not in `NEW` or
`FAILED`, and 503 if you hit an API instance without the title service
configured.

**Approval is not reversible from here.** There is no un-create; deleting a
MangaDex title is a MangaDex-side operation. Read the row before approving.

### Correct a row before approving it

What the extension scraped is not always right: a mangled name, a title keyed to
the wrong language, a source URL that moved. Approve and skip used to be the
whole vocabulary, so the only way to fix a bad row was to skip it and hope the
next run reported it better.

```bash
# What is on the row, and what MangaDex currently says about it.
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$CORE_URL/api/v1/admin/untracked/$ID" | jq

# Correct any of the three scraped fields. Local only; nothing is sent to
# MangaDex by this call, ever.
curl -s -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"mangaName":"Correct Name","mangaLanguage":"ja","mangaUrl":"https://example.com/series/9"}' \
  "$CORE_URL/api/v1/admin/untracked/$ID" | jq

# Then approve as usual: the title is created from the corrected values.
padmin untracked approve $ID
```

`PATCH` refuses more than it accepts, because all three fields escape this
platform; the name becomes a public MangaDex title and a Discord embed, and
`mangaUrl` becomes `links.raw` on the catalogue entry:

| Refusal | Why |
|---|---|
| 400 unknown language | Checked against the MangaDex allowlist (`src/contracts/languages.ts`), not a shape. `PT-BR` is accepted and stored as `pt-br`. |
| 400 host not allowed | The URL must be in the extension manifest's `allowed_hosts`: the same allowlist the sandbox holds the extension to. |
| 400 bad scheme / blank name / unknown field | A misspelled field name is an error, not an edit that changed nothing. |
| 409 row is `CREATING` | A title service instance has claimed it and is calling MangaDex. Wait for it to land. |
| 409 no published bundle | Without a manifest there is no `allowed_hosts` to check the URL against. Publish or un-yank a bundle first. |
| 409 duplicate | `(extension, mangaId, mangaLanguage)` is unique; correcting the language collided with another row. Skip one of the two. |

A language outside the extension's manifest `languages` is a **warning**, not a
refusal; a series' name in its original language is legitimate. The warning
comes back in `warnings[]`.

### Fix a MangaDex title this pipeline already created

A wrong title created by this platform is a wrong title on a public catalogue,
so the correction has to reach MangaDex. It is a separate, explicit step:

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$CORE_URL/api/v1/admin/untracked/$ID/apply-to-mangadex" | jq
# -> {"ok":true,"applied":true,"titleUrl":"https://mangadex.org/title/…",
#     "changes":[{"field":"title","from":{"en":"Mangled Nmae"},"to":{"ja":"正しい"}}]}
```

**This needs the ADMIN role, not just `untracked:write`.** A CONTRIBUTOR may
correct rows all day and is refused here, with the reason in the response;
editing a public entry under the platform's shared MangaDex account is a
different act from fixing a local row. The dashboard disables the control and
shows the same reason.

What it sends, and what it deliberately does not:

- **Only the fields that changed.** A title's description, authors, tags and
  cover are absent from the request and survive it untouched. This matters most
  for a title the pipeline did not create but was pointed at (see
  `tracked set`), where those fields are somebody's curation.
- **`title` and `links` are merged, not rebuilt.** MangaDex replaces whatever is
  sent, so sending a bare `{"links":{"raw":…}}` would delete an entry's AniList
  and MangaUpdates links. The one deliberate deletion: when the entry carries
  exactly one name and the language was corrected, the name **moves** rather
  than leaving the mangled one behind as an alternative title. An entry with
  several names keeps them all and the response says so in `notes[]`.
- **The version MangaDex currently holds**, read in the same request. A 409
  `version-conflict` means somebody edited the entry in between; re-read the row
  (`GET` shows the live fields) before deciding, because re-sending would clobber
  their change. It is never retried automatically.

Other answers: 409 `no-md-title` (nothing created yet; approve instead), 409
`title-missing` (deleted or merged on MangaDex), 502 `rejected` (MangaDex
refused a well-formed edit; its complaint is in `error` and on the row's
`lastError`), 503 (this API instance holds no MangaDex credentials).

`GET /api/v1/admin/untracked/:id` is the whole picture for one row:
`mangadex` is the live entry, `pendingChanges` is exactly what an apply would
send, and `appliedToMangaDex` is the last apply (who and when, from the audit
log; `untracked.edit` and `untracked.mangadex_apply` are both recorded against
the row id, so `padmin audit search --subject $ID` is the history). A MangaDex
outage degrades this to `mangadex: null` plus `mangadexError` rather than
failing the request: correcting the local row does not need MangaDex.

### Triaging `FAILED`

`lastError` is the MangaDex API's complaint. The usual causes:

- **Validation rejected the draft**: a missing or malformed field in the
  manifest's `title_defaults` (original language, content rating, status). Fix
  the manifest, republish, then approve. Approving a `FAILED` row resets its
  attempt budget.
- **Rate limited or transient 5xx**, just approve again.
- **Duplicate title**, MangaDex already has it. Map it by hand with
  `tracked set` and then `untracked skip`.

```bash
padmin untracked list --state FAILED
padmin untracked approve <id>       # retries with a fresh attempt budget
```

### Rows stuck in `CREATING`

`CREATING` is a CAS claim held by one title-service instance. If a row has sat
there for more than a few minutes, the uploader died mid-creation. Check
whether the title actually got made on MangaDex before doing anything else; if
it did, map it with `tracked set` and skip the row, or you will create a
duplicate.

```bash
docker compose logs --tail 200 core-uploader | grep -i untracked
```

### A flood of untracked rows

Dozens or hundreds of `NEW` rows appearing at once is almost never a real
publisher event. It means the platform thinks nothing is tracked:

```bash
padmin tracked list <extension> | tail -1     # expect thousands, not zero
```

If that count is zero or implausibly low, the bundle's config seed did not land
(see `docs/migration-guide.md` stage 3a). **`padmin pause` immediately** if any
affected extension has `auto_create_titles: true`: otherwise the title service
will start creating hundreds of duplicate MangaDex titles, and cleaning that up
is manual and slow. Fix the tracking data, then skip the bogus rows in bulk
before resuming.

---

## Config lives in the database, not in JSON files

The two data files behave **differently**, and the difference decides whether
editing one in git does anything at all on a live deployment.

**`manga_id_map.json` is reconciled on every publish**: so the contributor
workflow (edit the file, open a PR, merge) does reach the database. Per row:

| Change in git | Effect on the database |
| --- | --- |
| A new `(namespace, mangaId)` pair | inserted |
| A corrected MangaDex id, on a row that came from a previous import | updated |
| A different id on a row an **operator** set, or the title pipeline auto-created | preserved; git does not win |
| A line removed | nothing; a series is never untracked by deletion |

The `source` column draws that line. A row set by an operator is a later and
better-informed decision than the file, and dropping a line from the map must not
silently stop a series being tracked; untracking is an explicit action
(dashboard, `padmin tracked remove`, or the bot).

**`override_options.json` is seed data**, imported only when an extension has no
configuration at all. Once any of it exists, a config row, an alias, a
multi-chapter entry, a language mapping, republishing does nothing, so editing
this file on a live deployment changes nothing. Use `ext-config` below.

```bash
padmin tracked list <extension>
padmin tracked set <extension> <externalMangaId> <mdMangaId>
padmin tracked remove <extension> <externalMangaId>

padmin ext-config get <extension>                 # prints JSON
padmin ext-config set <extension> ./overrides.json
padmin ext-config get ext-a | padmin ext-config set ext-b   # or from stdin
```

`ext-config set` **replaces** the whole document; it is not a merge. Get it,
edit it, set it back:

```bash
padmin ext-config get mangaplus > /tmp/o.json
$EDITOR /tmp/o.json
padmin ext-config set mangaplus /tmp/o.json
```

Both are audited, so `padmin audit` shows who repointed a mapping and when.

### `custom_language` widens what a chapter may be published as

`custom_language` maps an external manga id to a MangaDex language code, and it
is the one override that changes what the ingest gate will *accept*: chapters of
that title are allowed to carry that language even though the extension's
manifest does not declare it. mangaplus reports `SPANISH` for everything, so the
one title that is actually Latin-American Spanish is mapped to `es-la` here.

The map is read from the **database**, never from the worker's envelope; a
worker cannot vote on which languages it may publish. So a chapter rejected as

```
chapter language es-la not declared by manifest (declared: en, es)
```

means the mapping is missing from `ext-config`, not that the manifest is wrong.
Values are validated against MangaDex's language list on write, so a typo like
`pt_br` is refused at that point rather than silently failing to protect
Brazilian-Portuguese chapters from the removal pass.

---

## Webhook verbosity

By default the channel gets **failures only** for individual chapters. Python
sent an embed per chapter either way, which on a normal run is almost entirely
`Success: True`: and the one failure worth acting on scrolls past between them.
The run-level embeds (`Reading data from …`, `Found N chapters for …`, the
untracked-series list) already report that the work happened.

```bash
curl -s $CORE/api/v1/admin/webhook-verbosity -H "authorization: Bearer $ADMIN_TOKEN"
curl -sX POST $CORE/api/v1/admin/webhook-verbosity \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"uploadSuccesses": true}'          # back to the Python firehose
```

Failure embeds are not switchable, and they carry the reason in the description;
 a failure notification that does not say why is one you cannot act on.

---

## Extensions publish themselves from GitHub

Two paths keep the fleet current, and they overlap on purpose:

1. **The push webhook**: fires within seconds of a push, carrying the exact
   commit. This is the fast path.
2. **A poll every 15 minutes**: the scheduler asks each repo in
   `GITHUB_EXTENSIONS_REPOS` for its HEAD and publishes anything that changed.

The poll exists because the webhook fails *silently*: an unregistered hook, a
revoked secret or a dropped delivery all look identical to "nobody pushed", and
the first symptom is a run producing stale results days later. Publishing is
idempotent, an unchanged tree hashes the same and returns `unchanged`, so the
two overlapping costs nothing.

The poll discovers extensions by directory (`src/<name>/manifest.json`), so an
extension **added** to a repo is picked up on its own. The sysops sync button
walks already-published bundles and therefore can only ever update extensions
somebody installed by hand first.

A commit is only remembered when every extension in it published cleanly, so a
transient build failure is retried next pass rather than being skipped until the
next push. Publishes are audited under `github.autosync`.

```bash
# freeze the fleet on what is published now (e.g. while investigating a bad extension)
docker compose exec postgres psql -U publoader -d publoader \
  -c "insert into settings (key, value) values ('github_auto_sync','false')
      on conflict (key) do update set value = 'false';"
```

---

## Series-map sync

The database winning has one cost: the `manga_id_map.json` files in the
extensions repos go stale. Every title the pipeline auto-creates and every
mapping an operator repoints is invisible in git, so a contributor reads the
file, sees a series missing, and opens a pull request adding something that has
been tracked for months. A mapping deliberately *removed* from the database is
worse; the file still has it, so the next publish seeds it straight back.

Once a week core-api writes the table back:

```bash
padmin maps sync --dry-run     # what the next weekly run would commit
padmin maps sync               # do it now
padmin maps sync --extension mangaplus --extension viz
```

The same run is on the dashboard, for the change that should not wait a week:
**Tracked → Publish to GitHub** covers every extension, and the same card at the
bottom of **Extensions → *name* → Series map** covers just that one. Preview
first; it prints the per-extension outcome, the repo and the exact delta, and
the commit asks for confirmation. Both need the `tracked:write` scope, so a
CONTRIBUTOR sees the card disabled rather than absent.

| | |
| --- | --- |
| **Where it runs** | core-api. It is the only core service with a GitHub token and egress; core-scheduler sits on the internal `data` network. |
| **When** | Every `MAP_SYNC_INTERVAL_HOURS` (default 168 = weekly), tracked by the `map_sync_last_run` row in `settings`: so restarts, redeploys and a second replica cannot make it run twice. |
| **Not on deploy** | The first boot after enabling it only *arms* the timer. The first automatic commit is one interval later. |
| **Needs** | `GITHUB_TOKEN` with **Contents: write** on the repos in `GITHUB_EXTENSIONS_REPOS`. Without it the feature reports itself off at boot and does nothing. |
| **Off switch** | `MAP_SYNC_ENABLED=false`. It also skips while the platform is paused (`padmin pause`). |

What it will not do, because it commits unattended:

- **Never creates a file.** An extension with no `manga_id_map.json` is skipped
  with a note; add the file once by hand and the sync keeps it current.
- **Never empties one.** No mappings in the database for an extension that has
  some in git means *refused*, not a deletion.
- **Refuses a big shrink.** A write that would drop more than half of a file's
  mappings is refused and logged; `padmin maps sync --force` is the deliberate
  override once you have looked at the dry run.
- **Never guesses a repo.** An extension directory present in two configured
  repos is skipped rather than written to whichever was listed first.
- **Keeps each file's shape.** mangaplus's `{titleId: [ids]}`, alpha_manga's
  `{id: titleId}` and viz's nested `{namespace: {…}}` all survive; only the
  ordering is normalised (once), so a week with no changes makes no commit.
- **Keeps each file's layout.** The indent is read from the file, arrays stay on
  one line, and alpha_manga's right-aligned ids stay aligned. This is not
  cosmetic: the renderer used to be `JSON.stringify(…, 2)`, which put every id
  on its own line and reindented everything, so the first run turned mangaplus
  into a 2565-line file and a commit whose subject said `+7 -1` and whose diff
  was every line. A diff has to be the change.

Its commits carry `[map-sync]` in the subject, and the push webhook skips a
delivery whose commits are *all* marked; otherwise the platform would answer
its own data-file commit with a bundle republish every week. A push that mixes
one of ours with a human's still publishes.

Each write is audited as `map_sync.write`, with the commit sha and the counts:

```bash
curl -s "$PUBLOADER_API_URL/api/v1/admin/audit/search?action=map_sync" \
  -H "authorization: Bearer $PUBLOADER_ADMIN_TOKEN" | jq '.events[]'
```

Run it manually in any environment that shares the extensions repos with
another deployment, and leave `MAP_SYNC_ENABLED=false` there; two deployments
writing the same files would overwrite each other with whichever database is
staler.

---

## Lease-expiry storms

Symptom: `publoader_lease_expiries_total` climbing fast, jobs cycling
`PENDING → LEASED → PENDING`, `publoader_jobs_requeued_total` rising, and
little or nothing succeeding.

```bash
# Lease/queue metrics are recorded by the scheduler process, so they are on the
# scheduler's port; prom-client registries are per-process (see "Which service
# serves which metric" below).
curl -s http://core-scheduler:8101/metrics | grep -E 'lease_expiries|jobs_requeued|job_queue_depth'
padmin workers list      # heartbeat ages
```

Diagnose in this order:

1. **Is one worker taking leases and dying?** Check `runs show` for jobs whose
   `WORKER` is the same id repeatedly. Drain it.
2. **Are jobs genuinely slower than the lease TTL?** A big extension on a slow
   host can exceed `LEASE_TTL_SECONDS` between renewals. The agent renews
   mid-job; if renewal is failing (network flaky, core overloaded) the lease
   dies while the work is still running; and the work is then done twice.
   Raise `LEASE_TTL_SECONDS` in the core `.env` and restart `core-api` and
   `core-scheduler`.
3. **Is the core overloaded?** If `core-api` is returning 429 or 5xx to renew
   calls, every worker's lease expires at once. Check `docker compose logs
   core-api` and the rate-limiter settings.
4. **Did a network partition just heal?** A batch of leases all expiring
   together after a connectivity blip is self-correcting; the jobs requeue and
   run. Watch rather than intervene.

**Emergency stop** while you work it out:

```bash
padmin pause
```

This stops new leases being granted. Existing leases still expire and requeue,
but nothing new starts, and the churn dies down.

---

## Pause and resume

```bash
padmin pause                 # indefinite
padmin pause --minutes 30    # auto-resume
padmin resume
padmin stats                 # confirm
```

Pause is stored in Postgres, so every replica honours it immediately; there is
no per-process state to get out of sync. It gates: new scheduler runs, new job
leases, and upload-task draining. It does **not** abort in-flight work; a
chapter mid-upload finishes.

Use pause for: upgrades, credential rotation, "something is wrong and I need to
think", and any time you are unsure whether the platform is about to do
something to MangaDex that you cannot undo.

---

## Backup and restore

The only durable state is the `pgdata` volume. Bundles, artifacts, chapter
history, queues, and audit all live there.

**Backup** (run on a schedule; daily is reasonable):

```bash
cd docker/core
docker compose exec -T postgres pg_dump -U publoader -Fc publoader \
  > "$HOME/backups/publoader-$(date +%F-%H%M).dump"
```

`-Fc` (custom format) is compressed and restores selectively. Keep at least
two weeks, and keep at least one copy off the host.

Artifacts (page images) are stored as `bytea` and dominate the dump size. If
backups get unwieldy, exclude them and accept that in-flight uploads would need
re-scraping after a restore:

```bash
docker compose exec -T postgres pg_dump -U publoader -Fc \
  --exclude-table-data=artifacts publoader > .../publoader-noart-$(date +%F).dump
```

**Restore**:

```bash
padmin pause
docker compose stop core-api core-scheduler core-processor core-uploader

docker compose exec -T postgres dropdb -U publoader publoader
docker compose exec -T postgres createdb -U publoader publoader
docker compose exec -T postgres pg_restore -U publoader -d publoader --no-owner \
  < "$HOME/backups/publoader-2026-08-01-0300.dump"

docker compose up -d        # migrate runs, then services start
padmin stats
padmin resume
```

**Test the restore path at least once**, into a scratch database, before you
need it. A dump that has never been restored is a hypothesis.

---

## Incident: an extension is failing repeatedly

Symptoms: the same extension appears repeatedly in `dead-letter`, or its runs
never reach `PROCESSED`.

**1. Establish the blast radius.** Is it one extension or all of them?

```bash
padmin dead-letter
padmin stats
```

If every extension is failing, it is not the extension; go to the lease-storm
or core-health runbooks instead.

**2. Stop the bleeding.** A broken extension retrying on a schedule wastes
worker capacity and fills the dead-letter queue:

```bash
padmin extensions disable <name>
```

This stops it being scheduled. It does not touch already-queued work.

**3. Read one failure properly.**

```bash
padmin runs list --extension <name> --limit 10
padmin runs show <runId>            # lastError on each job
padmin quarantine                   # is it failing validation rather than execution?
```

Distinguish three cases:

- **Execution failures** (dead-letter, `PERMANENT`): the extension code raised.
  Site layout changed, an API moved, a dependency broke. Fix in the extensions
  repo, `bundle publish`, re-enable.
- **Policy failures** (dead-letter, `POLICY`): the manifest disagrees with what
  the extension does. Fix the manifest.
- **Validation failures** (quarantine): the extension ran and produced output
  the core rejected. See quarantine triage above.

**4. Check whether it is the site, not us.** Try the source manually. If the
publisher is down or rate-limiting, the correct action is to leave the
extension disabled and re-enable later; not to raise `maxAttempts` and hammer
them.

**5. Fix forward.**

```bash
cd $EXTENSIONS_REPO
# ... fix ...
padmin bundle publish ./src/<name> --source-commit "$(git rev-parse HEAD)"
padmin extensions enable <name>
padmin runs trigger <name> --kind UPDATE
padmin runs show <runId>
```

Jobs are pinned to the bundle sha they were created with, so retrying an old
dead-lettered job runs the **old** code. After publishing a fix, trigger a new
run instead of retrying old jobs.

**6. Record it.** `padmin audit` has what you did; add a note to the extension's
repo about what broke and why, so the next person does not re-derive it.

---

## Failover test procedure

Run this after setup and after any change to lease handling. It proves the
property the whole distributed design rests on: **a worker dying mid-job loses
no work.**

**Setup:** two enrolled workers, both `ACTIVE`, both healthy.

```bash
padmin workers list        # expect two ACTIVE with fresh heartbeats
padmin stats
```

**1. Start a run** on an extension that takes long enough to interrupt (a
minute or more):

```bash
padmin runs trigger <extension> --kind FORCE
padmin runs show <runId>
```

**2. Identify the lease holder.** In `runs show`, note the `WORKER` column and
the `LEASE EXPIRES` time.

**3. Kill that worker hard.** Not a graceful stop; a graceful stop is a
different (easier) test:

```bash
# on the worker host
docker kill publoader-worker
```

**4. Observe the job stay leased and then requeue.** For up to
`LEASE_TTL_SECONDS` (default 300) nothing happens; this is correct. The core
cannot distinguish "crashed" from "slow", so it waits for the lease to expire
rather than double-running the job.

```bash
watch -n 15 "padmin runs show <runId>"
```

Expected sequence: job stays `LEASED`/`RUNNING` with the dead worker → lease
expires → sweeper requeues it as `PENDING` with `attempt` incremented → the
surviving worker claims it → `SUCCEEDED`.

**5. Confirm the run completes** and the result is committed exactly once:

```bash
padmin runs show <runId>            # state PROCESSED
padmin quarantine                   # still empty
curl -s http://core-api:8104/metrics | grep -E 'envelopes_(committed|superseded)'
curl -s http://core-scheduler:8101/metrics | grep lease_expiries
```

`publoader_lease_expiries_total` should have incremented by one.

**6. Restart the killed worker** and confirm it rejoins:

```bash
docker compose up -d
padmin workers list
```

**7. The late-submission case.** If the killed worker had already finished and
was mid-submit, it may submit after the successor. That envelope must be
recorded as `SUPERSEDED`, not committed twice;
`publoader_envelopes_superseded_total` increments and
`publoader_envelopes_committed_total` does not. To force this case, pause the
worker's network instead of killing it (`docker network disconnect`), let the
lease expire, then reconnect.

**Pass criteria:** the run completes, exactly one result is committed per job,
nothing is quarantined, and no chapter is uploaded twice.

---

## Monitoring quick reference

Every core service serves `/metrics`, `/healthz` and `/readyz` (Prometheus text
format) on an internal-only metrics port, reachable **only** from the compose
network:

| Service | Metrics port | Public port | Env override |
|---|---|---|---|
| `core-api` | 8104 | 8100 (API, dashboard, health) | `METRICS_PORT` / `PORT` |
| `core-scheduler` | 8101 |; | `METRICS_PORT` |
| `core-processor` | 8102 |; | `METRICS_PORT` |
| `core-uploader` | 8103 |; | `METRICS_PORT` |

**`/metrics` is deliberately unreachable from the public hostname.** The
Cloudflare tunnel's Public Hostname maps `publoader.ardax.dev` to a single
origin, `core-api:8100`, and cloudflared forwards *every* path on that
hostname. So `/metrics` is not served on 8100 at all: it lives on 8104, which
nothing routes to. That makes the guarantee structural rather than a WAF rule
someone can forget; `https://publoader.ardax.dev/metrics` returns 404 from the
API's own router even before the edge rules are considered. The direct-ingress
path (`docker/core/ingress/Caddyfile`) 404s it too.

`/healthz` and `/readyz` remain on the public port because the container
healthcheck and compose `depends_on` use them, and they return only
`{"ok":true}` / `{"ok":false,"reason":"database unreachable"}`: a boolean and a
fixed string, no topology.

Nothing is authenticated, and the compose file uses `expose:`, never `ports:`,
so nothing is on the host either. Point Prometheus at the service names over
the compose network:

```yaml
scrape_configs:
  - job_name: publoader
    static_configs:
      - targets:
          - core-api:8104        # NOT 8100; metrics are on the internal port
          - core-scheduler:8101
          - core-processor:8102
          - core-uploader:8103
```

Put the scraper on the stack's `data` network (or on `edge` with the same
`expose` ports) rather than publishing anything.

### Which service serves which metric

This matters, because a `prom-client` registry is per-process: a metric is only
visible on the port of the process that records it. Scraping the wrong one
returns a *missing* series, not a zero.

| Recorded by | Metrics |
|---|---|
| `core-api` | `envelopes_*`, `jobs_succeeded_total`, `jobs_requeued_total`, `job_duration_seconds`: everything driven by an inbound worker request |
| `core-scheduler` | `scheduler_last_tick_timestamp_seconds`, `job_queue_depth`, `dead_letter_jobs`, `oldest_pending_job_age_seconds`, `runs`, `oldest_ingesting_run_age_seconds`, `result_submissions`, `artifact_rows`, `artifact_bytes`, `workers`, `jobs_created_total`, `lease_expiries_total`, `jobs_requeued_total`, `jobs_dead_letter_total`, `upload_tasks` |
| `core-uploader` | `md_uploads_total`, `upload_tasks` (its own live view of the queue it drains) |
| `core-processor` | `upload_tasks` (the queue it fills) |

Two consequences worth knowing before you write a query:

- `upload_tasks` is published by three processes. Aggregate with
  `max by (kind, state) (publoader_upload_tasks)`: summing triple-counts.
- `jobs_requeued_total` is incremented in two processes for two different
  reasons (`reason="lease_expired"` by the scheduler, transient failures by the
  API), so `sum without (instance, job) (...)` is the fleet-wide number.
- `publoader_jobs_leased_total` is declared but **never incremented**: no lease
  route records it. Treat it as absent, and use `publoader_job_queue_depth` and
  `publoader_jobs_succeeded_total` instead.

Metric names are defined in `src/metrics.ts`.

### Counters

| Metric | Labels | Watch for |
|---|---|---|
| `publoader_jobs_created_total` | extension, kind | Flat when it should not be = scheduler is not ticking. |
| `publoader_jobs_leased_total` | extension | **Never incremented**: declared but no call site records it. Use `publoader_oldest_pending_job_age_seconds` to see "no one is claiming". |
| `publoader_jobs_succeeded_total` | extension | The success signal. |
| `publoader_jobs_requeued_total` | extension, reason | Rising = retry churn. |
| `publoader_jobs_dead_letter_total` | extension | Any increase deserves a look. |
| `publoader_lease_expiries_total` | extension | Rising = workers dying or renewals failing. |
| `publoader_envelopes_received_total` | extension | |
| `publoader_envelopes_quarantined_total` | extension, reason | **Security signal.** Any sustained rise is an incident. |
| `publoader_envelopes_superseded_total` | extension | Late/duplicate results. Small numbers are normal after a failover. |
| `publoader_envelopes_committed_total` | extension | Should track `received` minus quarantined/superseded. |
| `publoader_md_uploads_total` | outcome | `outcome="failure"` rising = MangaDex problem or bad credential. |

### Gauges

All of these seed every label value to 0 on each refresh, so a series never
goes missing when a queue empties and never sticks at a stale value.

| Metric | Labels | Watch for |
|---|---|---|
| `publoader_scheduler_last_tick_timestamp_seconds` |; | Unix time of the last **completed** scheduler tick. **The single best liveness signal for the control plane**: alert on `time() - <metric>`, never on a "seconds since" gauge (see below). |
| `publoader_job_queue_depth` | state | `PENDING` growing without bound = not enough worker capacity. |
| `publoader_dead_letter_jobs` |; | Jobs sitting in `DEAD_LETTER` right now. The `_total` counter says it happened once; this says it is still unfixed. |
| `publoader_oldest_pending_job_age_seconds` |; | Age of the oldest *due* job. Better than depth: a small queue that never drains is still broken. |
| `publoader_runs` | state | `INGESTING` piling up = `core-processor` is down, paused, or stuck on MangaDex. |
| `publoader_oldest_ingesting_run_age_seconds` |; | How long the oldest such run has waited. Non-zero and climbing = processing has stopped. |
| `publoader_result_submissions` | state | `QUARANTINED` is the security-relevant depth; `RECEIVED` growing = envelopes arriving but not committing. |
| `publoader_upload_tasks` | kind, state | `DEAD_LETTER` non-zero = uploads failing permanently; `PENDING` flat and non-zero = uploader stalled. |
| `publoader_artifact_rows` / `publoader_artifact_bytes` |; | Artifact table growth (bytes includes TOAST, i.e. the real disk cost). Refreshed every 5 minutes. Unbounded growth = retention is not pruning. |
| `publoader_workers` | status | `ACTIVE` dropping = fleet shrinking. |

**Why there is no `publoader_scheduler_lag_seconds` any more.** It was set to 0
at the top of every tick, so it read 0 when the scheduler was healthy; and
also read 0 forever once the loop wedged, because the only code that could
raise it was the code that had stopped running. A process cannot be trusted to
report its own absence; record a timestamp and let the scraper do the
subtraction.

### Histogram

`publoader_job_duration_seconds{extension}`: lease-to-submit. Buckets 10s to
1h. A p95 approaching `LEASE_TTL_SECONDS` predicts lease-expiry storms before
they happen.

### What to alert on

Every expression below reads a metric that a scraper can actually reach today,
on the port listed in "Which service serves which metric". Thresholds are
starting points, but the shapes are not: each one is chosen so that the
*absence* of a working service still fires.

| Metric | Expression | What it means | First action |
|---|---|---|---|
| `publoader_scheduler_last_tick_timestamp_seconds` | `time() - publoader_scheduler_last_tick_timestamp_seconds > 120` or `absent(...)` for 5m | The clock has stopped: nothing is scheduled, no lease is swept, no retry backs off. Everything else follows from this. | `docker compose logs --tail 200 core-scheduler`; restart it if the loop is wedged rather than erroring. |
| `up` (scrape target) | `up{job="publoader"} == 0` for 5m | A core service is gone or cannot be scraped; including the scheduler, whose stall alert would otherwise go quiet with it. | `docker compose ps`; check the container's healthcheck and last log lines. |
| `publoader_dead_letter_jobs` | `publoader_dead_letter_jobs > 0` for 15m | Work has permanently failed and is sitting there; no retry will pick it up. | `padmin dead-letter` to see what and why, then `padmin retry` after fixing the cause. |
| `publoader_oldest_pending_job_age_seconds` | `publoader_oldest_pending_job_age_seconds > 1800` | A due job has waited 30m: no worker is claiming, or the fleet is too small. | `padmin workers list`; check `publoader_workers{status="ACTIVE"}` and worker logs. |
| `publoader_workers` | `sum(publoader_workers{status="ACTIVE"}) == 0` for 10m | No capacity at all. | Check worker hosts (`docker compose ps` there); heartbeat ages via `padmin workers list`. |
| `publoader_oldest_ingesting_run_age_seconds` | `publoader_oldest_ingesting_run_age_seconds > 1800` | Runs finished executing but nothing is processing them; `core-processor` down, paused, or stuck on MangaDex. | `padmin stats` (is it paused?), then `docker compose logs --tail 200 core-processor`. |
| `publoader_result_submissions` | `publoader_result_submissions{state="QUARANTINED"} > 0` | **Security signal.** A worker submitted data that failed validation and it is still held. | `padmin quarantine`; identify the worker and revoke it if the pattern repeats. |
| `publoader_envelopes_quarantined_total` | `increase(publoader_envelopes_quarantined_total[15m]) > 10` | A worker is submitting garbage at volume, right now. | `padmin quarantine`, then `padmin workers revoke <id>`. |
| `publoader_upload_tasks` | `max by (kind) (publoader_upload_tasks{state="DEAD_LETTER"}) > 0` | Chapters that will never be posted without intervention. | `padmin upload-tasks --state DEAD_LETTER`; fix the cause and requeue. |
| `publoader_upload_tasks` | `min_over_time(max(publoader_upload_tasks{state="PENDING"})[30m:]) > 0` | The upload queue has not drained to empty in 30m: the uploader is stalled or paused. | `padmin stats` (paused?), then `docker compose logs --tail 200 core-uploader`. |
| `publoader_md_uploads_total` | `increase(publoader_md_uploads_total{outcome="failure"}[15m]) > 5` | Credential expired, MangaDex down, or a bad payload. | Uploader logs; `padmin pause` if it is posting bad data. |
| `publoader_lease_expiries_total` | `rate(publoader_lease_expiries_total[15m]) > rate(publoader_jobs_succeeded_total[15m])` | More jobs are timing out than completing; lease churn. | Compare `publoader_job_duration_seconds` p95 against `LEASE_TTL_SECONDS`. |
| `publoader_job_duration_seconds` | `histogram_quantile(0.95, sum by (le) (rate(publoader_job_duration_seconds_bucket[1h]))) > 0.8 * LEASE_TTL_SECONDS` | A lease-expiry storm is forming. | Raise `LEASE_TTL_SECONDS` or split the extension into more segments. |
| `publoader_artifact_bytes` | `publoader_artifact_bytes > 5e9` | The artifact table is eating the disk that Postgres shares with everything else. | Check expiry pruning; artifacts have `expiresAt` for a reason. |

Note the two rate-based rows read counters recorded in *different* processes
(`lease_expiries_total` on the scheduler, `jobs_succeeded_total` on the API), so
drop the `instance`/`job` labels when comparing them.

### Health endpoints

All four core services answer both, on the ports above:

- `GET /healthz`: "alive": the process is running and its event loop turns.
  This is the container healthcheck.
- `GET /readyz`: "safe to work": Postgres answers. Deliberately **not** the
  container healthcheck anywhere: a Postgres restart must not cascade into
  killing the whole control plane.

Both are unauthenticated and both are blocked at the edge.

The worker agent has no listening socket by design, so its liveness probe is a
heartbeat file instead: `services/worker.ts` refreshes
`$WORKER_STATE_PATH/heartbeat` on every piece of work-related traffic with the
core (lease polls while idle, lease renewals while a job runs), and the image's
HEALTHCHECK fails if it is missing or older than
`WORKER_HEARTBEAT_MAX_AGE_SECONDS` (default 600). Raise that only if you also
raised the core's `LEASE_TTL_SECONDS`, since renewals happen every TTL/3.
`docker` only *reports* the worker unhealthy; nothing restarts on it, because
an autoheal sidecar would need `docker.sock` mounted on the worker host.

---

## Incident checklist

Print this. Work top to bottom.

1. `padmin stats`, is it paused? are there workers? how deep are the queues?
2. `padmin dead-letter`, what has already failed?
3. `padmin quarantine`, is a worker submitting bad data? (security-relevant)
4. `padmin untracked list --state NEW`, is a flood of series about to have
   MangaDex titles created for it? If yes, `padmin pause` before anything else.
5. `padmin workers list`: heartbeat ages; is the fleet there?
6. `curl -s http://core-scheduler:8101/metrics | grep scheduler_last_tick` vs
   `date +%s`, is the clock running?
7. `docker compose ps`, is everything up? did `migrate` exit 0?
8. `docker compose logs --tail 200 core-api core-scheduler core-uploader`
9. **If unsure, `padmin pause`.** Stopping is cheap; an incorrect upload to
   MangaDex is not.
10. `padmin audit --limit 100`: did a human change something just before this started?
11. Once resolved: `padmin resume`, then verify with `padmin stats` and a spot
    check on MangaDex.


---

## Triage from the Activity feed instead of `docker logs`

**Activity** is one timeline over five tables, runs, jobs, upload tasks, result
submissions, and the audit log, so the first question in an incident ("what
changed, and what started failing?") is answerable in a browser.

Start wide and narrow down:

```
Activity → Severity: errors only → Window: last hour
```

Then filter by extension, or search the subject and message for a dedupe key, a
manga id, or a fragment of an error string. Every row carries a permalink
(`Copy link`) that opens the same row for anyone who can sign in; that is what
to paste into an incident channel rather than a screenshot.

Two properties make this the right starting point rather than a summary:

- A job that is *still retrying* appears with its `lastError` attached, so a
  transient failure is visible before it dead-letters.
- Audit events are interleaved, so "the uploads started failing four minutes
  after someone changed the removal mode" is one screen rather than two.

The same feed is available to a script:

```bash
curl -s "$PUBLOADER_API_URL/api/v1/admin/activity?severity=error&hours=6&limit=50" \
  -H "authorization: Bearer $PUBLOADER_ADMIN_TOKEN" | jq -r \
  '.activity[] | [.at, .severity, .kind, .subject, .message] | @tsv'
```

**What it does not cover.** Every row in Activity is a database row. Container
stdout is not; a stack trace from a crash loop, a Prisma engine that failed to
load, anything a process emitted before it could reach Postgres. None of that is
written to the database, so no endpoint can serve it:

```bash
docker compose logs -f --tail=200 core-uploader
```

Reach for that only when the Activity row does not already explain itself. Most
of the time `lastError` or `rejectReason` is the whole answer.

---

## Search the audit log

`GET /api/v1/admin/audit` returns the most recent N events, which only answers
"what happened just now". The retrospective questions need
**Audit → Search**, which is a case-insensitive substring across the actor, the
action, the subject, **and the serialised detail**:

```bash
# Who changed the removal mode, ever?
curl -s "$PUBLOADER_API_URL/api/v1/admin/audit/search?action=removal_mode" \
  -H "authorization: Bearer $PUBLOADER_ADMIN_TOKEN" | jq '.events[]'

# Everything touching one series, including inside the detail JSON.
curl -s "$PUBLOADER_API_URL/api/v1/admin/audit/search?q=12345" \
  -H "authorization: Bearer $PUBLOADER_ADMIN_TOKEN" | jq '.total'
```

Searching the detail is the point: the arguments of every audited action live
there and nowhere else, so "which batch repointed this series, and to what?" is
only answerable this way. `since` / `until` take ISO instants, `limit` and
`offset` page, and the response carries a `total` so you can tell "that is all of
them" from "that is the first page".

Clicking an action name in the table filters to it; the fastest way to ask
"what else did this?".

---

## Check the schema before and after an upgrade

**System → Schema & migrations** reports what `_prisma_migrations` contains,
what is on disk in this build, and the difference:

```bash
curl -s "$PUBLOADER_API_URL/api/v1/admin/schema" \
  -H "authorization: Bearer $PUBLOADER_ADMIN_TOKEN" | jq '{current, pending, failed}'
# -> { "current": true, "pending": [], "failed": [] }
```

Read the three fields together:

| Field | Meaning |
|---|---|
| `current: true` | Nothing pending, nothing failed. What you want after `up -d`. |
| `pending: [...]` | The image carries migrations this database has not applied. The services are running against an older schema than the code expects. |
| `failed: [...]` | A migration was recorded but never finished, or was rolled back. **This is the state that makes containers crash-loop on boot**, and it is invisible from every other panel. |
| `current: null` | Either the migration history was not shipped with this build, or the database has no `_prisma_migrations` table at all (its schema was created by `db push` or a hand-restored dump). The `note` field says which. |

Nothing here applies a migration, and that is deliberate: the runtime image
carries no Prisma CLI, because a long-lived internet-facing service must not
hold a tool that can rewrite the database. Migrations are applied by the one-shot
`migrate` compose service; see "Upgrade the core" above. The panel tells you
*whether* you need to, which is the part that used to require a shell.

`current: false` after an upgrade means the `migrate` service did not run or
failed. Check it before restarting anything:

```bash
docker compose logs migrate
```

---

## Take a backup from the dashboard

**System → Database backup → Download backup** streams `pg_dump -Fc`: the same
custom format as the scheduled backup in "Backup and restore" above, so a dump
taken from the browser and one taken on the host restore identically with
`pg_restore`.

Two things to understand before using it.

**It is gated harder than anything else in the platform**: OWNER role *and*
`users:admin`. Not because a backup is dangerous to take, but because of what one
contains; every operator password hash, every client token hash, and the saved
MangaDex session. Taking a dump is a credential-theft primitive, so it sits at
the same bar as account administration. The role requirement is what excludes
API tokens entirely: `adminAuthHook` never grants a `pa_…` token the OWNER role,
so **no client credential can dump the database**, however broadly it is scoped;
 not even one minted with `["*"]`. Treat the downloaded file as a secret:
encrypt it at rest, and keep it off shared storage.

**It needs `pg_dump` in the container, and the shipped image has it.** The core
runtime image installs `postgresql-client-16` from PGDG; specifically 16, because
Debian bookworm ships client 15 and `pg_dump` refuses to dump a *newer* server
("aborting because of server version mismatch"), so Debian's default package
would give you a button that always fails against Postgres 16.9. If you build a
custom image without it the endpoint answers 503 naming the missing binary rather
than failing obscurely, and the host procedure above still works.

Adding a database-dumping binary to a long-lived internet-facing service is worth
being deliberate about, so the reasoning is recorded here rather than assumed: it
adds no listener and no privilege, and anyone who can already execute code in
this container holds `DATABASE_URL` and can read the same rows over SQL. `pg_dump`
therefore gives an attacker who is already inside nothing they did not have. What
it costs is image size and one well-maintained package's CVE surface.

Restoring is host-side regardless of any of this: it requires stopping the
services that would write during it, and nothing that can take the API down
should be reachable through the API.

---

## Self-service: fetch, restart, install, read

Four things used to need a shell on the core host. They are all on the dashboard's
**System** section now, and each has a caveat worth knowing before you press it.

### Fetch the latest extension code from GitHub

**Check GitHub for changes** compares the commit each live bundle was built from
(`bundles.source_commit`) against the default-branch HEAD of every repo in
`GITHUB_EXTENSIONS_REPOS`, and **Fetch and publish** builds and publishes the ones
that are behind; the same download, the same esbuild step and the same
`BundleStore.publish` the push webhook runs, so a bundle published by this button
and one published by a push to the same commit are byte-identical.

```bash
# read-only
curl -sH "Authorization: Bearer $ADMIN_TOKEN" \
  https://publoader.ardax.dev/api/v1/admin/sysops/github/status | jq

# what would happen, without doing it
curl -sX POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"dryRun":true}' \
  https://publoader.ardax.dev/api/v1/admin/sysops/github/sync | jq '.outcomes'
```

Read the `behind` field carefully, because it has three values and only one of
them means "nothing to do":

| `behind` | Meaning |
|---|---|
| `false` | The published commit *is* the repo HEAD. Current. |
| `true` | HEAD has moved. `changedPaths` lists what changed under `src/<extension>/`; an empty list with HEAD moved means the repo advanced but this extension did not, so publishing would republish identical bytes. |
| `null` | **The question could not be answered.** `reason` says why: no `GITHUB_TOKEN` for a private repo, GitHub unreachable or rate-limited, the commit force-pushed away, or a bundle published from a local directory with no `source_commit` at all. |

`available: false` at the top level means the same thing for every extension;
`GITHUB_EXTENSIONS_REPOS` unset, or none of the repos could be reached. It is
never reported as "everything is current", because an operator who is told that
does not look again.

One failure never blocks the others: a sync answers `207` with per-extension
outcomes when some extension fails to build, and the ones that worked are
published. Every publish is audited with the acting operator and
`detail.via = "sysops-github-sync"`.

Anonymous GitHub reads are limited to 60/hour, so `GITHUB_TOKEN` is worth setting
even when every repo is public; without it, a few refreshes exhaust the budget
and the panel starts answering `null` for everything.

### Restart a service

**System → Restart** takes `api`, `scheduler`, `processor`, `uploader` or `all`.

> **This depends entirely on the container restart policy.** A restart here is a
> *graceful self-exit*: the service finishes what it is doing, closes its server,
> disconnects from Postgres and exits 0. Something else has to start it again. Our
> compose files give every core service `restart: unless-stopped`, which does
> exactly that. A service started with `docker run` and no `--restart`, or from a
> compose file without a restart policy, **will stay down**: the button is a stop
> button there. Set `SYSOPS_RESTART_ENABLED=false` in such a deployment and the
> endpoint refuses with a 503 explaining why, instead of taking the platform down.

There is deliberately no Docker socket involved. Mounting `/var/run/docker.sock`
into core-api would be the obvious implementation and it is the reason this one
exists instead: the socket is root-equivalent access to the host, and core-api is
reachable from the internet. It is absent from every compose file and must stay
absent.

The API can only exit *itself*. The other three services have no listening socket,
so a restart aimed at them is recorded as a `restart_request` row in `settings`
and each service acts on it during its next loop pass:

```bash
docker compose exec postgres psql -U publoader -d publoader \
  -c "select key, value from settings where key like 'restart%'"
```

Two properties keep that from misfiring. It is **time-bounded**: a request older
than 120 seconds is ignored, so a row left behind by a crash cannot restart a
service the next morning. And it is **acknowledged per service**
(`restart_ack_<service>`): without that, a service back up in five seconds would
see the still-fresh request and exit again, looping for as long as the TTL.

Restart latency is therefore up to one loop pass: about 30s for the scheduler
(`SCHEDULER_INTERVAL_SECONDS`) and 15s for the processor. The uploader checks
between iterations rather than mid-drain, so it finishes the queues it is
currently draining before exiting; with a deep upload backlog that can be
minutes, and that is the right trade: it means the process never exits holding a
task lease, so no upload is abandoned half-done for the sweeper to reclaim. The
API answers `202` and exits ~500ms later, so the response reaches the browser;
the dashboard then waits for `/healthz` and reloads, and tells you plainly if it
does not come back within 30 seconds.

Every restart is audited with the actor and the target (`action:
sysops.restart`).

### Install an extension that is not in a configured repo

Two paths, both ending in the same builder and the same publish:

```bash
# from any repo/ref; a fork, a contributor's branch, a new source
curl -sX POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"repo":"someone/their-extensions","ref":"main"}' \
  https://publoader.ardax.dev/api/v1/admin/sysops/extensions/install-github | jq

# from a folder on your laptop, not in git yet
cd path/to/my-extension && zip -r /tmp/ext.zip . -x '*/node_modules/*' -x '.git/*'
curl -sX POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/zip' \
  --data-binary @/tmp/ext.zip \
  https://publoader.ardax.dev/api/v1/admin/sysops/extensions/install-upload | jq
```

The zip may contain a built extension (`manifest.json` + `index.mjs`) or the
TypeScript source (`manifest.json` + `index.ts` / `src/`), which is built here with
the same esbuild invocation the webhook uses. Zipping the folder itself rather
than its contents is fine; the wrapper directory is unwrapped. A pre-v2 python
bundle is refused with the porting message, as everywhere else. Everything an
uploaded or fetched archive is checked for before any of that happens is in
§"What bundle intake does and does not protect against" below; read it before
handing anyone `bundles:write`.

For `install-github`, the ref is resolved to a real commit sha before anything is
downloaded, so the new bundle records provenance and the "is it behind?" check
above can answer for it later. If the repo holds several extensions the response
lists them and asks for `path` rather than picking one.

Both answer `isLatest`, which is the question that actually matters:

```json
{ "extension": "mangaplus", "version": "2.1.0", "status": "published", "isLatest": true }
```

`isLatest: false` means the bundle was stored but something published more
recently is still what every new run pins; re-uploading last week's folder does
that. `latest` names what is live instead.

### Read the docs

**System → Read the docs** serves this documentation set out of the running image
(`/app/docs`, copied by `docker/core/Dockerfile`). It is the copy that matches the
code you are running, which is the point: no repo checkout, no network, no
guessing which branch the host has. `DOCS_PATH` overrides where the API looks.

`GET /api/v1/admin/docs` lists what shipped and `GET /api/v1/admin/docs/<name>`
returns one document's markdown, both behind `stats:read`. Names are validated
against the shipped directory listing, and anything with a path separator, a
leading dot or `..` is refused; the endpoint is a file reader exposed to the
internet, and traversal is the risk it is built around.

If the list comes back `available: false`, the docs were not copied into the image
(a custom build that dropped the `COPY docs ./docs` line, or a wrong `DOCS_PATH`).
Everything else keeps working; you just read the docs on GitHub until the next
build.

---

## What bundle intake does and does not protect against

Both install paths, the zip an operator uploads and the archive fetched from
GitHub, go through one intake (`src/core/sysops/bundleIntake.ts`)
before anything is written to disk or built. A repository is not treated as more
trustworthy than an upload: the zipball is written by anyone who can push to that
repo and arrives over the network.

### What it stops

| Class | What is refused |
|---|---|
| Decompression bombs | Per-file cap (10 MB), total cap (50 MB), entry count (2,000 in the extension, 20,000 in the archive), and a 200:1 ratio ceiling. Bytes are counted **as they are decompressed**: `zlib` is given a hard output ceiling, so an entry that declares 12 bytes and expands to 8 GB aborts mid-inflate. The declared sizes in the archive are checked first only because a cheap refusal is better than an expensive one; they are never believed. |
| Nested archives | Refused by extension and by magic bytes (zip, gzip, bzip2, xz, 7z, rar, zstd, tar). A bundle has no reason to contain one, and one inside another defeats the ratio accounting. |
| Zip slip / traversal | Names are normalised (backslashes, percent-encoding, `.` and `..` segments) before any path is built; absolute paths and drive letters are refused rather than stripped; the resolved path is re-checked against the extraction root immediately before the write. |
| Symlinks and special files | Refused from the unix mode in the archive, not from the name; a symlink entry looks exactly like a small text file whose contents are a path, and honouring one is how an "extraction" writes somewhere else. |
| Executables | An extension is source and data: only `.mjs`, `.js`, `.ts`, `.json`, `.proto`, `.md`, `.txt` and the paths the manifest declares in `data_files` are accepted, and every file is additionally sniffed for ELF/Mach-O/PE/wasm/dex magic and for a shebang. `manga_id_map.json` containing an ELF header is refused. |
| Archive permissions | Never preserved. Everything is written `0600` into a `mkdtemp` directory (`0700`), so nothing extracted is executable and nothing else on the host can read it. An entry marked executable is refused outright. |
| Dependency expectations | `node_modules/`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` and dotfiles (`.npmrc`, `.git/`) are refused **with an explanation**, because nothing here installs dependencies and silently ignoring them would publish a bundle whose imports cannot resolve. |
| Lifecycle scripts | No package manager is ever invoked; not npm, not pnpm, not yarn. There is no code path from intake to a lifecycle script, which is the only real guarantee that a `scripts.postinstall` in an uploaded `package.json` stays inert. A test asserts the sentinel file it would create does not appear. |
| Third-party imports | A bare import fails the build with `dependency X cannot be resolved; extensions must be dependency-free or vendored`. Nothing is fetched. |
| Build resource abuse | esbuild runs in a subprocess with a 30s wall clock, a 256 MB heap ceiling, its own process group (so a timeout kills esbuild's Go child too), cwd set to the extraction directory, and **no inherited environment**: this process holds `DATABASE_URL`, `ADMIN_TOKEN`, `GITHUB_TOKEN` and the MangaDex credentials, and none of it belongs near a build of code someone uploaded. |

Every accepted and every refused archive is audited with its sha256, byte size,
entry count and (for a refusal) the reason and the refusal code:

```bash
# what has been refused, and why
curl -sH "Authorization: Bearer $ADMIN_TOKEN" \
  "https://publoader.ardax.dev/api/v1/admin/audit/search?action=bundle.intake.refused" | jq
```

Two limits live on the endpoint rather than in the intake: the request body is
capped at 8 MiB (a real extension is tens of kilobytes), and publishing is
rate-limited **per credential**, six bursts, refilling one every two minutes,
so a leaked `bundles:write` token cannot be used to grind the builder.

### What it does not stop

Be clear about this, because the checks above can read as more than they are.

**Intake stops malformed and hostile ARCHIVES. It does not stop hostile INTENT in
a well-formed extension.** Code that passes every check is still code, and an
extension that is valid TypeScript with no dependencies can still be written to
do something you did not want.

What limits that is not intake, it is where extension code runs and what it is
allowed to do:

- the control plane **never executes** extension code. Publishing stores bytes
  and builds them; running them happens on workers.
- a worker runs the bundle under Node's permission model with no filesystem
  writes, no subprocesses, and network egress limited to the `allowed_hosts` its
  manifest declares. See [security-trust-model.md](security-trust-model.md).
- results are not trusted either: ingest validates every envelope against the
  manifest and the database, and quarantines what fails
  (§"Quarantine triage" above).

So the realistic residual risk from a malicious-but-well-formed extension is that
it scrapes within its declared hosts and fabricates results; which is a
quarantine and review problem, not an intake one.

Two practical consequences:

- **`bundles:write` is a trusted scope.** It means "may change the code every
  worker executes". Hold it to operators; do not put it on a bot token that only
  needed to read stats. The dashboard's install controls sit behind it, and the
  audit trail names whoever used them.
- **An anti-virus scan of the uploaded artifact would be a reasonable addition**
  and is deliberately not implemented: it would mean a scanner dependency and a
  signature database inside the control plane, which is a larger commitment than
  it looks. The hook point is the intake's accepted-archive path in
  `install-upload`, the archive bytes and their sha256 are already in hand there,
 so adding a scan later is a local change and not a redesign.

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
