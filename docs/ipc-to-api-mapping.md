# Legacy IPC → Admin API mapping

Date: 2026-07-29

This is the migration contract for the two existing API clients — the Discord
bot and the dashboard. Both currently speak JSON-RPC over a Unix socket to
`run.py`'s in-process IPC server (`_setup_ipc_server`, 27 registered commands).
Both must move to HTTPS against the core admin API.

**The dashboard half is already done.** It is no longer a separate app holding
its own copy of the credential: core-api serves it as static assets at the
domain root (`src/core/api/dashboard/`) and it calls the same
`/api/v1/admin/*` endpoints as everything else. Operators sign in with their
own accounts — email + password or MangaDex — and get a revocable session
cookie; the admin token is the break-glass path only. The "Dashboard" column
below is the migration map for the old UI, and it covers every admin endpoint.
What remains to port is the bot.

## How the transport changes

| | Legacy | Platform |
|---|---|---|
| Transport | Unix domain socket, newline-delimited JSON | HTTPS, JSON bodies |
| Location | same host, same container as the scheduler | `https://publoader.ardax.dev` (any host) |
| Auth | filesystem permissions on the socket | `Authorization: Bearer $PUBLOADER_ADMIN_TOKEN`, or a `publoader_session` cookie (per-operator account, revocable) for the dashboard |
| Roles | none | bearer = `OWNER`; accounts are `OWNER` or `ADMIN`, and only `OWNER` manages accounts |
| Attribution | none | `X-Actor: <name>` header, recorded in `audit_events` |
| Errors | `{"ok": false, "error": "..."}` | HTTP status + `{"error": "..."}` |
| Rate limit | none | per-IP limiter on the admin scope (429); 5/min on login |

Every mutating endpoint writes an `AuditEvent` naming the actor, so the bot
should forward the invoking Discord user in `X-Actor`
(e.g. `X-Actor: discord:ardax#0001`). Dashboard sessions carry the operator
name inside the cookie and need no header; `X-Actor` still wins if sent.

Cookie-authenticated **writes** must also send `x-requested-with:
publoader-dash` (CSRF). Bearer clients are unaffected and should not send it.

## Command mapping

Base path for every endpoint below is `/api/v1/admin`. "CLI" is the
`publoader-admin` equivalent (`src/cli/admin.ts`).

### Direct equivalents

| Legacy IPC | Endpoint | CLI | Dashboard | Notes |
|---|---|---|---|---|
| `run` | `POST /runs` | `runs trigger <ext> [--kind]` | Extensions → Run / Force / Clean | `force: true` → `kind: "FORCE"`; `clean: true` → `kind: "CLEAN"`; neither → `UPDATE`. One extension per call — the legacy `extensions: [...]` list becomes N calls. Returns `{runId, created}`; `created: false` means the idempotency key already existed. Returns 409 while paused, matching the legacy paused rejection. |
| `list_schedule` | `GET /schedules` | `schedules list` | Extensions → Configure → Schedule | Returns `{defaults, overrides}`. `defaults` now comes from each bundle's `manifest.json` rather than `schedule*.json` files on disk. |
| `set_schedule` | `PUT /schedules/:name` | `schedules set <ext> <hour> <minute> [--day]` | Extensions → Configure → Schedule → Save override | Body `{hour, minute, day?}`. No explicit reschedule step: the scheduler recomputes due slots every tick, so the change takes effect within one `SCHEDULER_INTERVAL_SECONDS`. |
| `remove_schedule` | `DELETE /schedules/:name` | `schedules remove <ext>` | Extensions → Configure → Schedule → Remove override | Returns `{removed: boolean}`, same "no override existed" semantics. |
| `get_removal_mode` | `GET /removal-mode` | `removal-mode get` | Extensions → Settings | Returns `{mode, validModes}`. The legacy `explicit` / `default` fields are dropped — read `settings` if you need to distinguish. |
| `set_removal_mode` | `POST /removal-mode` | `removal-mode set <mode>` | Extensions → Settings → Save | Body `{mode}`, validated against `unavailable \| delete`. |
| `list_extensions` | `GET /extensions` | `extensions list` | Extensions | Source of truth changes: the legacy version scanned `publoader/extensions/src/` on the local disk; this lists **published bundles** with version, sha256, and disabled flag. An extension that exists in the repo but was never published does not appear — that is the intended behaviour. |
| `disable_extension` | `POST /extensions/:name/disable` | `extensions disable <name>` | Extensions → Disable | |
| `enable_extension` | `POST /extensions/:name/enable` | `extensions enable <name>` | Extensions → Enable | |
| `run_history` | `GET /runs?limit=&extension=` | `runs list` | Runs | Richer than the SQLite `run_history` rows: state machine state, segment count, bundle pin. Use `GET /runs/:id` (`runs show`) for per-job detail including `lastError`. |
| `stats` | `GET /stats` | `stats` | Overview | Returns job counts by state, upload-task depths by (kind, state), worker counts by status, quarantine count, pause flag. Replaces both `stats` and the queue-length half of `status`. |
| `pause` | `POST /pause` | `pause [--minutes]` | Overview → Pause | Body `{minutes?}`; omit for indefinite. Unlike the legacy version the pause is authoritative in Postgres, so it is honoured by every replica immediately rather than by one process's global. |
| `resume` | `POST /resume` | `resume` | Overview → Resume | |
| `status` | `GET /stats` + `GET /workers` | `stats`, `workers list` | Overview + Workers | Split in two. `pid` and the in-process `schedule` job list have no equivalent — see below. |
| `queue_peek` | `GET /stats` (depths only) | `stats` | Overview → Upload tasks (depths only) | **Partial.** Depths are covered; per-row sampling is not — see gaps. |

### New capabilities with no legacy counterpart

These have no IPC command to migrate from, but the bot and dashboard should
surface them because they are where operational problems now appear.

| Endpoint | CLI | Dashboard | What it is |
|---|---|---|---|
| `POST /enroll-tokens` | `enroll-token create` | Workers → Enroll new worker (shows the token once, with a compose snippet) | Mint a single-use worker enrollment token. |
| `GET /workers` | `workers list` | Workers | Fleet inventory with heartbeat age and trust tier. |
| `POST /workers/:id/{drain,activate,revoke}` | `workers drain\|activate\|revoke` | Workers → Drain / Activate / Revoke | Worker lifecycle. |
| `GET /runs/:id` | `runs show <id>` | Runs → click a run (drawer with every job) | Run detail with every job, attempt count, lease holder, and error. |
| `POST /jobs/:id/cancel` | `jobs cancel <id>` | Runs → run drawer → Cancel | Cancel one job. |
| `POST /jobs/:id/retry` | `jobs retry <id>` | Runs → run drawer → Retry, or Dead letter → Replay | Replay a dead-lettered job. |
| `GET /dead-letter` | `dead-letter` | Runs → Dead letter | Jobs that exhausted retries or hit a permanent/policy error. |
| `GET /quarantine` | `quarantine` | Quarantine | Result envelopes rejected by schema or policy validation — the signal that a worker is misbehaving. |
| `POST /bundles` | `bundle publish <dir>` | Extensions → Settings → Publish bundle (.zip) | Publish a content-addressed extension bundle. Also performs the one-time seed of `manga_id_map.json` / `override_options.json` into the database. |
| `GET /audit` | `audit` | Audit | Who did what, when. |
| `GET /extensions/:name/tracked` | `tracked list <ext>` | Extensions → Configure → Tracked manga | The external-id → MangaDex-id mapping. **Replaces `manga_id_map.json`** — the database is the config authority. |
| `PUT /extensions/:name/tracked` | `tracked set <ext> <mangaId> <mdMangaId>` | Extensions → Configure → Tracked manga → Add / repoint | Add or repoint a mapping. |
| `DELETE /extensions/:name/tracked/:mangaId` | `tracked remove <ext> <mangaId>` | Extensions → Configure → Tracked manga → Remove | Stop tracking a manga. Does not touch MangaDex. |
| `GET /extensions/:name/config` | `ext-config get <ext>` | Extensions → Configure → Override options | Override options as JSON. **Replaces `override_options.json`.** |
| `PUT /extensions/:name/config` | `ext-config set <ext> [file]` | Extensions → Configure → Override options → Save (JSON validated) | Replace the override options (whole-document, not a merge). CLI reads a file or stdin. |
| `GET /untracked?state=` | `untracked list [--state]` | Untracked (state filter) | Series an extension reported with no MangaDex title yet. |
| `POST /untracked/:id/approve` | `untracked approve <id>` | Untracked → Approve (confirms; links the new title) | Create the MangaDex title now and start tracking it. Synchronous; returns the new `mdMangaId`. |
| `POST /untracked/:id/skip` | `untracked skip <id>` | Untracked → Skip | Never create a title for this series. |

### Retired — and what replaces the capability

| Legacy IPC | Why it is gone | What to do instead |
|---|---|---|
| `reload` | Called `importlib.reload(publoader)` on a long-lived in-process module tree. There is no such tree: extension code is fetched per job as a sha256-pinned bundle and executed in a fresh subprocess on a worker host. | Publish a new bundle (`bundle publish`). The next job picks it up; no reload step exists. |
| `restart` | `worker.kill()` → GitHub tarball self-update → `pip install` → `os.execv`. A container must not rewrite and re-exec itself. | Redeploy the image: `docker compose pull && docker compose up -d`, then `prisma migrate deploy`. See `docs/operations.md` → "Upgrade the core". |
| `pull` | Downloaded a GitHub tarball with a PAT and `shutil.move`d it over the live source tree. Mutating a running deployment's source is exactly the supply-chain property the bundle pipeline removes. | Build bundles in CI from the extensions repos and `bundle publish --source-commit <sha>`. Bundles are immutable, versioned, hash-addressed, and recorded in the audit log. |
| `restart_workers` | Killed and respawned four `multiprocessing.Process` children inside one container. The upload workers are now separate container replicas and the scrape workers are remote hosts. | Upload-task workers: `docker compose restart core-uploader`. Scrape workers: `workers drain <id>` then restart the remote agent, then `workers activate <id>`. In-flight work is leased and requeues automatically either way. |
| `kill_tasks` | Drained an in-memory `queue.Queue` and restarted local children. There is no in-memory queue — every unit of work is a durable row. | `jobs cancel <id>` per job. **Bulk cancel is a gap** (see below). |
| `logs` | Tailed `*.log` files from the scheduler's own filesystem. Work now executes on machines the core cannot read. | Container logs via the host log driver (`docker compose logs -f core-api`). For a failure, the diagnostic path is `runs show <id>` → per-job `lastError` → `dead-letter` → `quarantine` → `audit`. **Centralised log aggregation is a gap** (see below). |
| `config_show` | Read a local `config.ini` through `configparser`. | Configuration is environment/Docker-secret driven (`src/config.ts`). Inspect with `docker compose config` on the core host; secrets are deliberately not exposed over the API. |
| `config_set` | Rewrote `config.ini` in place and only affected that one process. | Edit the compose env / secret file and redeploy. Nothing that changes MangaDex credentials or database URLs should be settable from a Discord message. |
| `mdauth_status` | Read the local `mdauth.json`. | **Gap** — see below. Only `core-uploader` holds MD credentials now. |
| `force_login` | Forced a MangaDex password-grant login and rewrote `mdauth.json`; other processes kept stale copies. | **Gap** — see below. |
| `logout` | Deleted `mdauth.json` and poked private attributes on an in-process singleton. | **Gap** — see below. Credential revocation now means rotating the secret and redeploying `core-uploader`. |

## Gaps to close before the bot and dashboard can fully cut over

These are the commands with no v1 equivalent. Each is a small, well-scoped
addition to `src/core/api/routes/admin.ts`; none blocks the data
migration, but the bot loses a feature until they land.

1. **MangaDex auth visibility** (`mdauth_status`, `force_login`, `logout`).
   Suggested: `GET /api/v1/admin/md/auth` returning `{authenticated, expiresAt,
   expiresInSeconds}` and `POST /api/v1/admin/md/reauth`. These must be served
   by whichever process owns the MD token (`core-uploader`), either by moving
   the token into a `settings`-style row that `core-api` can read, or by
   `core-uploader` publishing its auth state to a row on each refresh. The
   second is preferable: the credential stays in one process.
   *Deliberately not provided: an endpoint that logs out.* Revoking MD access
   is a credential rotation, documented in `docs/operations.md`.

2. **Upload-task inspection and cancellation** (`queue_peek`, `queue_clear`).
   Suggested: `GET /api/v1/admin/upload-tasks?kind=&state=&limit=` for the
   sample, and `POST /api/v1/admin/upload-tasks/:id/cancel`. A bulk purge
   equivalent to `queue_clear` should stay behind an explicit
   `?confirm=<count>` guard — the legacy version could empty a queue of
   thousands of pending uploads with one Discord message.

3. **Bulk cancel** (`kill_tasks`). Suggested: `POST /api/v1/admin/runs/:id/cancel`
   to cancel every job in a run, which covers the realistic case ("that FORCE
   run was a mistake"). Cancelling the entire queue is not a useful operation
   on a durable store.

4. **Log access** (`logs`). v1 has no centralised log API by design — logs are
   structured JSON on stdout with `runId`/`jobId`/`workerId` correlation, meant
   to be scraped by the host's logging stack. If the bot needs `/logs` back,
   the right shape is a query against a log aggregator, not a file-tailing
   endpoint on core-api.

5. **Effective schedule preview.** `list_schedule` returned the live
   `schedule` library job strings, i.e. the *next fire time*. `GET /schedules`
   returns configuration, not next-fire times. If the dashboard shows a
   countdown, add `nextRunAt` to the response computed from
   `core/scheduler/slots.ts`.

## Client migration notes

- **Idempotency.** `POST /runs` accepts an `idempotencyKey`. A bot that retries
  on network timeout should generate one key per user command
  (e.g. `discord:<interaction_id>`) so a retry cannot create two runs. Without
  a key the server generates a timestamped one and every retry creates a run.
- **Polling.** The legacy `run` command returned once the job was queued and the
  bot inferred completion from the queue length. Now poll `GET /runs/:id` until
  `state` is `PROCESSED`, `FAILED`, `DEAD_LETTER`, or `CANCELLED`.
- **Rate limiting.** The admin scope returns 429 under load. Clients must back
  off rather than retry immediately; a dashboard that polls `/stats` on a
  one-second timer will trip it.
- **Config is in the database now.** Anything in the bot or dashboard that
  reads `manga_id_map.json` or `override_options.json` off disk must move to
  `GET /extensions/:name/tracked` and `GET /extensions/:name/config`. The files
  are seed data imported at first publish; after that they are stale by
  definition.
- **`untracked approve` is destructive-ish and synchronous.** It creates a real
  MangaDex title and cannot be undone from the API. If the bot exposes it as a
  slash command, gate it — this is not a read-only convenience.
- **Token scope.** There is one admin token in v1 and it grants everything,
  including `bundle publish`. The bot and dashboard both hold it. Per-client
  tokens with scopes are a follow-up; until then, treat the bot's token as
  equivalent to shell access to the platform's control plane and keep the bot's
  command surface allowlisted on the bot side.

## Discord bot: the port, as built

Date: 2026-07-29. The bot half of this document is now done. It lives at
`src/bot/` with its entrypoint at `src/services/bot.ts`;
setup and the command reference are in `docs/bot.md`.

Two things above are now out of date and worth stating plainly:

1. **"Token scope … per-client tokens with scopes are a follow-up"** — they have
   landed. The bot holds a scoped `pa_…` token (`src/core/api/scopes.ts`,
   `routes/tokens.ts`), *not* `ADMIN_TOKEN`, and every admin route enforces a
   scope. The bot's token is no longer equivalent to shell access to the control
   plane; it is equivalent to its scope list.
2. **The bot no longer holds a Docker socket.** The legacy `start` / `shutdown` /
   `restart` commands drove `docker.sock` from inside the bot container. That
   mount is gone, and with it the property that compromising the bot meant root
   on the core host.

### Every legacy command, and where it went

`publoader/bot/server.py` registered 32 command paths (most as both a `!prefix`
and a slash command). The new bot is slash-only.

| Legacy | New command | Notes |
|---|---|---|
| `run [ext…]` | `/run <extension>` | One extension per invocation — the legacy list becomes N calls, matching `POST /runs`. Uses the Discord interaction id as the idempotency key. |
| `force [ext…]` | `/run <extension> mode:FORCE` | |
| `clean [ext…]` | `/run <extension> mode:CLEAN confirm:true` | Confirmation required; a CLEAN run can republish a lot of content. |
| `status`, `ping` | `/status`, `/ping` | Split: `/status` is the state (from `GET /stats` + `GET /workers`), `/ping` is API reachability and latency. |
| `stats` | `/stats` | Alias of `/status`, kept for muscle memory. |
| `pause [minutes]` | `/pause [minutes]` | |
| `resume` | `/resume` | |
| `extensions` | `/extensions list` | Now lists **published bundles**, not directories on disk. |
| `load <ext>` | `/extensions enable <extension>` | Renamed. |
| `unload <ext>` | `/extensions disable <extension>` | Renamed. |
| `schedule list` | `/schedule list` | Shows manifest defaults and overrides with the effective time. |
| `schedule set` | `/schedule set` | |
| `schedule remove` | `/schedule remove` | |
| `removal show` | `/removal-mode get` | Renamed. Needs `settings:write` — the GET is guarded by the write scope server-side. |
| `removal set` | `/removal-mode set` | Renamed. |
| `history [ext]` | `/runs recent [extension] [limit]` | Renamed. Richer: run state, kind and trigger source. |
| `queue peek <worker>` | `/queue list [kind] [state]` | Restored in full by `routes/ops.ts` (`GET /upload-tasks`), which returns rows *and* depth totals. Filters are by task kind and state rather than by worker name — upload tasks are no longer per-worker queues. |
| `queue clear <worker>` | `/queue cancel <id> confirm:true` | **Per task, not bulk, on purpose.** The legacy command could empty a queue of thousands of pending uploads from one chat message. `/queue requeue-stale` covers the other reason people reached for it (an uploader died holding leases). |
| `mdauth_status` | `/mdauth status` | Restored by `routes/ops.ts` (`GET /mangadex/auth`). Reports whether tokens are stored and when the access token goes stale; never returns the tokens. |
| `logout` | `/mdauth clear confirm:true` | Restored as "forget the stored session", which is what the legacy command actually did. It does not revoke anything MangaDex-side. |
| `force_login` | `/mdauth clear confirm:true` | No direct equivalent, and none is wanted: clearing the session makes the next MangaDex call authenticate from the configured credentials, which is the same outcome without a chat command that handles a password. |
| `logs` | `/errors [limit]` (partial) | `GET /admin/errors` merges dead-lettered jobs, failed upload tasks and quarantined submissions into one time-ordered feed — the triage half of what `logs` was used for. Process output stays in `docker compose logs`. |
| `kill`, `workers restart`, `config show`, `config set`, `pull`, `reload`, `restart`, `refresh`, `start`, `shutdown` | *(retired)* | See the table below. |

### New commands with no legacy counterpart

`/runs show <id>`, `/jobs cancel <id>`, `/jobs retry <id>`, `/dead-letter`,
`/quarantine`, `/errors`, `/workers list|drain|activate|revoke`, `/enroll`,
`/untracked list|approve|skip`, `/tracked list|set|remove`,
`/queue retry|cancel|requeue-stale`, `/audit`, `/whoami` — the endpoints listed
under "New capabilities" above plus those in `routes/ops.ts`, now reachable from
chat.

`/enroll` DMs the minted enrollment token to the invoker and never posts it to a
channel, not even as an ephemeral reply: an ephemeral message still renders in a
channel that may be screen-shared.

### Retired commands still register, and say what replaced them

Rather than answering "unknown command", the bot registers each retired name and
replies with the replacement. That makes the migration self-documenting for
anyone with the old commands in muscle memory.

| Legacy command | The bot's reply points at |
|---|---|
| `/logs` | `/errors` for failures; `docker compose logs -f core-api` for process output. |
| `/kill` | `/jobs cancel <id>` for scrape jobs, `/queue cancel <id>` for uploads, or `/pause` to stop new work. |
| `/restart-workers` | `docker compose restart core-uploader` for upload workers; `/workers drain` → restart the agent → `/workers activate` for remote ones. |
| `/config` | `docker compose config` on the host. Secrets are deliberately not exposed over the API. |
| `/login`, `/logout` | `/mdauth clear confirm:true`. |
| `/pull` | Build bundles in CI and `bundle publish --source-commit <sha>`. |
| `/reload` | Publish a new bundle; there is no in-process module tree. |
| `/restart` | `docker compose pull && docker compose up -d` on the host. |
| `/refresh` | Was `pull` + `reload`; both are gone. |
| `/shutdown` | The bot has no Docker socket. `/pause`, or `docker compose` on the host. |

`/queue` and `/mdauth` were on this list until `routes/ops.ts` landed; both are
now real commands.

`/start` is the one legacy name not registered, because a globally-registered
`/start` collides with Discord's own conventions; `/shutdown` carries the
explanation for both.

### Client migration notes, resolved

Against the checklist above:

- **Idempotency** — done. Every `/run` sends `idempotencyKey:
  discord:<interactionId>`, so a Discord retry or a double-submit collapses into
  one run. The reply distinguishes "started" from "already existed".
- **Polling** — not implemented. `/run` returns the run id and points at
  `/runs show <id>`. A bot that polled would either spam the channel or trip the
  admin rate limiter; the run-complete notification path is still the existing
  `DISCORD_WEBHOOK_URLS` webhook, which is unchanged.
- **Rate limiting** — the client surfaces 429 with the `Retry-After` value
  instead of retrying. There is no polling loop to trip it.
- **Config is in the database now** — the bot reads nothing from disk. Tracked
  manga come from `GET /extensions/:name/tracked` via `/tracked list`.
- **`untracked approve` is destructive-ish** — gated: admin-only *and*
  `confirm: true`.
- **Command surface allowlisted on the bot side** — done, and it now fails
  closed rather than open; see `docs/bot.md` §4.

### Remaining gaps, from the bot's point of view

Gaps 1 (MangaDex auth) and 2 (upload-task inspection) from the list above are
closed by `routes/ops.ts`. What an operator will still notice missing from chat:

1. **Bulk cancel.** `/jobs cancel` is one job at a time. `POST /runs/:id/cancel`
   would give the bot a `/runs cancel <id>` covering the realistic case ("that
   FORCE run was a mistake").
2. **Next-fire times.** `/schedule list` shows configuration, not when an
   extension runs next — gap 5 above. Adding `nextRunAt` to `GET /schedules`
   would let the bot show a countdown.
3. **Token introspection.** `/whoami` cannot list the bot's scopes up front —
   `/api/v1/admin/tokens/*` is gated on `users:admin` + OWNER, which a bot token
   can never hold. It reports them after any 403 (whose body includes the held
   scope list), and probes a `GET /api/v1/admin/tokens/self` that does not exist
   yet, so adding one would make `/whoami` complete with no bot change.


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
