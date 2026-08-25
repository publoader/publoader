# Discord control bot

Date: 2026-07-29

The bot is how operators drive the platform from chat. It replaces the legacy
`publoader/bot/server.py`, and the difference that matters is what it is allowed
to touch:

| | Legacy bot | This bot |
|---|---|---|
| Transport | Unix socket to the scheduler, same container | HTTPS to the admin API, any host |
| Credential | filesystem permissions on the socket | one scoped `pa_…` bearer token |
| Database | imported the whole `publoader` package | **none**: no `DATABASE_URL`, not on the database network |
| Docker | mounted `docker.sock` to start/stop/restart | **none**: cannot touch the host |
| MangaDex | shared the process' MD session | **none**: cannot upload, delete or log in |
| Attribution | none | `X-Actor: discord:<username>` on every call, recorded in the audit log |
| Commands | prefix (`!run`) + slash | slash only |

Compromising the bot host gets an attacker exactly the scopes on
`BOT_API_TOKEN`. Nothing else. That property is the point of the rewrite, and
the rest of this document is mostly about not giving it away.

## 1. Create the Discord application

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** → **Reset Token** → copy it. This is `DISCORD_BOT_TOKEN`. It is shown
   once; regenerating permanently revokes the old one.
3. Leave every **Privileged Gateway Intent** off. The bot is slash-command only
   and never reads message content; if you find yourself enabling Message
   Content Intent, something has gone wrong.
4. **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: **Send Messages**, **Embed Links**, and **Use Slash
     Commands**. Nothing else. The bot does not need Administrator, does not
     need Manage Server, and does not moderate anything.
5. Open the generated URL and invite it to your guild.

Turn on **Developer Mode** in Discord (User Settings → Advanced) so you can
right-click to copy the guild, channel, user and role ids the next step needs.

## 2. Mint a scoped API token

The bot needs its own control-plane credential:

```
publoader-admin tokens create --name discord-bot \
  --scopes runs:write,workers:read,extensions:read,untracked:write,stats:read,audit:read
```

That is the `discord-bot` preset (`publoader-admin tokens scopes` lists all of
them). The output includes the `pa_…` token; it is shown once and cannot be
recovered. Put it in `BOT_API_TOKEN`.

### Do not give the bot `ADMIN_TOKEN`, and do not give it `*`

`ADMIN_TOKEN` is the break-glass credential and resolves to `*`: every scope,
including `bundles:write` (publish arbitrary code to the fleet) and
`users:admin` (mint more tokens, delete operator accounts). A token scoped `*`
is the same thing by another name.

The bot is the component most exposed to other people's input: it sits in a chat
server, parses arguments typed by humans, and runs on whatever host was
convenient. Scoping it is not paperwork; it is the difference between "someone
got the bot's token and could trigger runs" and "someone got the bot's token and
owns the platform". `/whoami` warns when the token does not look scoped.

Rotation: create the replacement, update `BOT_API_TOKEN`, redeploy the bot, then
`publoader-admin tokens revoke <old-id>`.

### Which scope unlocks which command

The preset above covers every read plus the two write areas you want day to day
(`/run` and `/untracked approve`). Write implies read in the same area, so
`runs:write` also grants `runs:read`. Everything else is opt-in:

| Add this scope | To get |
|---|---|
| `settings:write` | `/pause`, `/resume`, `/removal-mode get`/`set`, `/mdauth status`/`clear` |
| `extensions:write` | `/extensions enable`/`disable`, every mutating `/schedule` subcommand, `/tracked set`/`remove` |
| `workers:write` | `/workers drain`/`activate`/`revoke` |
| `enroll:write` | `/enroll` |
| `bundles:write` | nothing — **the bot has no publish command; never grant it** |
| `users:admin` | `/permissions roles` only, and only the *reading* of it. **Still not worth granting** |

`/permissions` is the one command whose write half the bot cannot reach however
it is scoped. Changing a role or an account's scopes needs the `OWNER` role, and
a `pa_…` token is never `OWNER` — so `/permissions set-role`, `reset-role` and
`set-user` answer 403 unless the bot was given the platform's root
`ADMIN_TOKEN`, which is exactly the arrangement `/whoami` warns about. The
subcommands exist rather than being hidden, because a refusal that says "you
cannot do this from here" beats a feature that appears not to exist; do the
change from the dashboard or `publoader-admin permissions`.

Note that reading the removal mode needs `settings:write`, not a read scope:
`GET /removal-mode` is guarded by `settings:write` server-side. Most deployments
will want the preset plus `settings:write`, because `/pause` during an incident
is the single most useful thing a chat bot can do.

A command that needs a scope the token lacks answers with a 403 that names the
missing scope *and* lists the ones the token holds, so you never have to guess.

## 3. Configure and start

Set these in `docker/core/.env` (see `.env.example` for the annotated
versions):

| Variable | Required | Meaning |
|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | Bot token from the Developer Portal. Also accepted as `DISCORD_BOT_TOKEN_FILE`. |
| `BOT_API_TOKEN` | yes | The scoped `pa_…` token from step 2. Also accepted as `BOT_API_TOKEN_FILE`. |
| `CORE_URL` | no | Admin API base URL. Default `https://publoader.ardax.dev`. |
| `DISCORD_GUILD_ID` | strongly recommended | The one guild the bot serves. |
| `DISCORD_ADMIN_USERS` | yes, in practice | Comma/space-separated user ids allowed to run write commands. |
| `DISCORD_ADMIN_ROLES` | alternative to the above | Role ids whose holders are admins. |
| `DISCORD_ALLOWED_CHANNELS` | yes, in practice | Channel ids the bot accepts commands in. |

Then:

```
docker compose -f docker/core/docker-compose.yml up -d publoader-bot
docker compose -f docker/core/docker-compose.yml logs -f publoader-bot
```

A healthy start logs `admin API reachable; bot authorization model loaded` with
a summary of the gating in force, then `discord bot connected`, then
`registered guild slash commands`.

If the API rejects the token the process logs one `fatal` line naming the
problem and exits 78 (`EX_CONFIG`, "restarting will not help"). Compose's
`restart: unless-stopped` will restart it anyway, so the symptom of a bad token
is a restart loop; read the first `fatal` line, not the last.

If the core is merely unreachable at startup the bot starts anyway: an outage is
exactly when you want the bot online to tell you about it.

## 4. The admin-gating model

Two independent layers:

- **The token** decides what the bot *can* do to the platform (section 2).
- **This model** decides who is allowed to ask it to.

Both must permit an action. A guild member who is not an admin cannot trigger a
run even though the bot's token could.

Every command is classified by how much damage it can do:

| Class | Gate | Examples |
|---|---|---|
| **read** | channel allowlist only, if one is configured | `/status`, `/runs`, `/audit`, `/whoami` |
| **mutate** | admin **and** allowed channel | `/run`, `/pause`, `/extensions disable`, `/schedule add`/`set` |
| **destructive** | admin, allowed channel, **and** an explicit `confirm: true` | `/run mode:CLEAN`, `/workers revoke`, `/untracked approve`, `/enroll` |

Evaluated in order, guild, then channel, then privilege, so the message you
get back names the outermost problem rather than a symptom of it.

### It fails closed. The legacy bot failed open.

The Python bot's `_is_admin()` returned `True` when neither
`DISCORD_ADMIN_USERS` nor `DISCORD_ADMIN_ROLES` was set, and
`_channel_allowed()` returned `True` on an empty channel list. A deployment with
a half-finished `.env` therefore let every member of the guild pause the
platform and trigger runs.

This bot refuses instead, and says which variable to set:

- No admins configured → **every** mutating command is denied.
- No channel allowlist → reads work anywhere, **writes are denied**.
- `DISCORD_GUILD_ID` set → commands from other guilds and from DMs are denied.

Reads stay permissive on purpose: their worst case is a noisy channel, and
leaving `/status` working while the allowlists are being filled in makes the bot
useful during setup. This is deliberate and tested
(`test/unit/botAuthz.test.ts`).

### Where replies go

Anything operational or secret is **ephemeral**: visible only to the person who
ran it. `/status`, `/ping`, `/run`, `/pause` and `/resume` reply publicly,
because those are announcements the channel should see.

The one true secret, the worker enrollment token from `/enroll`, is sent by
**DM** and never posted to a channel at all; not even ephemerally, since an
ephemeral message still renders in a channel that may be screen-shared. If your
DMs are closed the bot falls back to the ephemeral reply and says so.

## 5. Command reference

`<>` is required, `[]` optional. "Scope" is what the bot's token must hold.

### Health

| Command | Class | Scope | What it does |
|---|---|---|---|
| `/status` | read | `stats:read` (+ `workers:read` for the fleet section) | Pause state, job counts by state, upload-task depths, worker fleet with heartbeat age. |
| `/ping` | read | `stats:read` | Whether the admin API answers, and how fast. |
| `/stats` | read | `stats:read` | Alias for `/status`, kept from the legacy bot. |
| `/whoami` | read | none | Which API the bot points at, a masked token fingerprint, the actor string your commands are attributed to, and the token's scopes when they are known. |

### Runs and jobs

| Command | Class | Scope | What it does |
|---|---|---|---|
| `/run <extension> [mode] [confirm]` | mutate (destructive for `CLEAN`) | `runs:write` | Trigger a run. `mode` is `UPDATE` (default), `FORCE` or `CLEAN`. `CLEAN` re-scrapes from scratch and requires `confirm: true`. |
| `/runs recent [extension] [limit]` | read | `runs:read` | Recent runs, newest first, with what triggered each. |
| `/runs show <id>` | read | `runs:read` | One run with every job, attempt count, segment and last error. |
| `/jobs cancel <id>` | mutate | `runs:write` | Cancel one job. |
| `/jobs retry <id>` | mutate | `runs:write` | Replay a dead-lettered job. |
| `/dead-letter` | read | `runs:read` | Jobs that exhausted retries or hit a permanent error. |
| `/quarantine` | read | `runs:read` | Result envelopes rejected by schema or policy validation; the signal a worker is misbehaving. |
| `/errors list [limit] [show]` | read | `runs:read` | One merged feed of everything that recently failed: dead-lettered jobs, failed upload tasks, quarantined submissions. The closest thing to the legacy `/logs`. Entries somebody has cleared are hidden by default and counted; `show` switches to including them or to only them. Each row prints the first eight characters of its id, which is what `clear` takes. |
| `/errors clear [id] [all] [note]` | mutate | `runs:write` | Mark failures as read and dealt with so they leave the list. `id` is a full id or a leading prefix; `all: true` clears everything outstanding. Nothing is deleted; the jobs, tasks and submissions keep their state, and anything that fails again comes back on its own. `note` records why, for whoever reviews cleared entries later. |
| `/errors restore [id] [all]` | mutate | `runs:write` | Put cleared entries back in the list: the undo, and the way to re-open something that turned out not to be fixed. |

Each `/run` uses the Discord interaction id as its idempotency key, so a
double-submit or a Discord-side retry cannot produce two runs. The reply says
`already existed` when that happens.

### Platform state

| Command | Class | Scope | What it does |
|---|---|---|---|
| `/pause [minutes]` | mutate | `settings:write` | Pause scheduling and dispatch. Omit `minutes` for indefinite. |
| `/resume` | mutate | `settings:write` | Release a pause. |
| `/removal-mode get` | read | `settings:write` | Current chapter-removal mode. |
| `/removal-mode set <mode>` | mutate | `settings:write` | `unavailable` keeps the chapter card, `delete` removes it. Manifests that force a mode still win. |

### Upload queue

The uploader's task queue; the legacy `queue peek` / `queue clear` pair, with
the bulk flush deliberately left out.

| Command | Class | Scope | What it does |
|---|---|---|---|
| `/queue list [kind] [state] [limit]` | read | `runs:read` | Upload tasks newest first, plus depth totals by kind and state. |
| `/queue retry <id>` | mutate | `runs:write` | Requeue a `FAILED` or `DEAD_LETTER` task with a fresh attempt budget. |
| `/queue cancel <id> confirm:true` | destructive | `runs:write` | Abandon a task. **The chapter is never sent to MangaDex.** A `LEASED` task cannot be cancelled; wait for the lease or requeue stale ones first. |
| `/queue requeue-stale` | mutate | `runs:write` | Sweep leases held by a dead uploader back onto the queue, without waiting for its timer. |

There is no bulk flush. The legacy `queue clear` could empty a queue of
thousands of pending uploads from one chat message; cancellation is per task on
purpose.

### MangaDex session

| Command | Class | Scope | What it does |
|---|---|---|---|
| `/mdauth status` | read | `settings:write` | Whether an access and refresh token are stored, and when the access token goes stale. Never shows the tokens. |
| `/mdauth clear confirm:true` | destructive | `settings:write` | Forget the stored session so the next MangaDex call re-authenticates from the configured credentials. |

An **expired access token is normal**: it is refreshed on demand, and
`/mdauth status` says so rather than implying an outage. Only clear the session
when refreshing itself keeps failing. Clearing does **not** revoke anything on
MangaDex's side; that is a credential rotation (`docs/operations.md`).

There is no "log in now" command. Clearing the session achieves the same thing
as the legacy `force_login` without a chat command that handles a password.

### Extensions

| Command | Class | Scope | What it does |
|---|---|---|---|
| `/extensions list` | read | `extensions:read` | Published bundles with version, hash and disabled state. |
| `/extensions enable <extension>` | mutate | `extensions:write` | Schedule it again. |
| `/extensions disable <extension>` | mutate | `extensions:write` | Stop scheduling it. In-flight jobs are unaffected. |
| `/schedule list` | read | `extensions:read` | Every extension's slots, and whether they come from the manifest or an operator. |
| `/schedule show <extension>` | read | `extensions:read` | One extension's slots, **numbered**; those numbers are what the mutating subcommands take. |
| `/schedule add <extension> <hour> <minute> [days] [kind] [label]` | mutate | `extensions:write` | Add a slot, keeping the others. Copies the manifest's slots in first if the extension has none, and says so. |
| `/schedule set <extension> <hour> <minute> [days] [kind] [label]` | mutate | `extensions:write` | **Replaces** the whole schedule with this one slot. Use `add` to keep the others. |
| `/schedule disable <extension> <slot>` | mutate | `extensions:write` | Stop one slot firing, keeping the row. |
| `/schedule enable <extension> <slot>` | mutate | `extensions:write` | Switch it back on. |
| `/schedule remove <extension> <slot>` | mutate | `extensions:write` | Delete one slot. |
| `/schedule reset <extension>` | mutate | `extensions:write` | Drop every operator slot, falling back to the manifest. |
| `/tracked list <extension>` | read | `extensions:read` | The external-id → MangaDex-id mapping. |
| `/tracked set <extension> <manga-id> <md-manga-id>` | mutate | `extensions:write` | Add or repoint a mapping. |
| `/tracked remove <extension> <manga-id>` | mutate | `extensions:write` | Stop tracking. Does not touch MangaDex. |
| `/reconcile [extension]` | read | `chapters:read` | How many chapters are already marked unavailable on MangaDex, or deleted, that the archives do not know about. **Reports only**; applying is closed to api tokens, so recording them is `padmin chapters reconcile --apply` or the dashboard. |
| `/recheck series [extension] [confirm]` | mutate | `runs:write` | Asks the publisher whether one series' chapters are still there, and queues whatever it no longer lists as UNAVAILABLE (or DELETE). Reports without starting anything until `confirm: true`. Unlike `/recard` the bot **can** do this one: it creates a run, and run creation is not closed to api tokens. |
| `/recard [series] [extension]` | read | `chapters:read` | Which titles have unavailable card images up and how many each has, autocompleted from the archive. Naming one title answers with the line that re-posts its cards. **Reports only**, for the same reason: posting card images is closed to api tokens, so the work happens on the dashboard or through `padmin chapters recard --series … --apply`. |

`/extensions list` shows **published bundles**, not files on disk. An extension
in the repo that was never published does not appear; that is intended.

`/schedule` addresses slots by their **position in `/schedule show`**, not by
their database id: Discord gives nobody a way to paste a uuid except reading it
off another message and hoping. The bot re-reads the list on every mutating
call and names the slot back in its answer ("Removed 01:00 UTC wed `clean`"), so
a number typed from a stale message produces a visibly wrong confirmation rather
than a silent deletion of the wrong row.

`days` accepts `mon,wed`, `weekdays`, `weekends`, or the raw contract numbers
`0-6` with **0 = Monday**. Names are the documented form because `0` reads as
Sunday to anyone who knows JavaScript, and that mistake is invisible until the
run happens on the wrong day.

### Untracked series

| Command | Class | Scope | What it does |
|---|---|---|---|
| `/untracked list [state] [limit]` | read | `untracked:read` | Series reported with no MangaDex title yet. |
| `/untracked approve <id> confirm:true` | destructive | `untracked:write` | Create the MangaDex title now and start tracking it. **Creates a real title and cannot be undone from the API.** |
| `/untracked skip <id>` | mutate | `untracked:write` | Never create a title for this series. |

### Worker fleet

| Command | Class | Scope | What it does |
|---|---|---|---|
| `/workers list` | read | `workers:read` | Every enrolled worker with status, trust tier, agent version and heartbeat age. |
| `/workers drain <id>` | mutate | `workers:write` | Stop giving it new jobs; in-flight work finishes. |
| `/workers activate <id>` | mutate | `workers:write` | Return a drained worker to service. |
| `/workers revoke <id> confirm:true` | destructive | `workers:write` | Kill its credential permanently. The host must re-enroll. |
| `/enroll [trust] [note] [ttl-hours]` | destructive | `enroll:write` | Mint a single-use worker enrollment token, **DM'd to you**. |

### Permissions

| Command | Class | Scope | What it does |
|---|---|---|---|
| `/permissions roles` | read | `users:admin` | The scope baseline behind each role on this deployment, and whether it is the shipped default or a local choice. |
| `/permissions user <id>` | read | `users:admin` + **OWNER** | One account's role baseline, grants, denials and effective scopes. |
| `/permissions set-role <role> <scopes> confirm:true` | destructive | `users:admin` + **OWNER** | Redefine what `ADMIN` or `CONTRIBUTOR` may do. Replaces the whole list. |
| `/permissions reset-role <role> confirm:true` | destructive | `users:admin` + **OWNER** | Back to the shipped default. |
| `/permissions set-user <id> [grant] [deny] confirm:true` | destructive | `users:admin` + **OWNER** | Grant and deny scopes for one account. An omitted list is left as it is; pass both empty to clear all tuning. |

Everything marked **OWNER** needs the owner *role*, which a scoped `pa_…` token
never has — see [§2](#which-scope-unlocks-which-command). Changes take effect on
sessions that are already open, within a few seconds.

### Audit

| Command | Class | Scope | What it does |
|---|---|---|---|
| `/audit [limit]` | read | `audit:read` | Who did what to the platform, newest first. |

Your Discord username is forwarded as `X-Actor: discord:<username>`, so audit
rows read `admin:discord:ardax` rather than naming the bot. `/whoami` shows the
exact string you will appear as.

### Retired commands

These still register, so typing the muscle-memory name gets a pointer rather
than "unknown command": `/logs`, `/kill`, `/restart-workers`, `/config`,
`/login`, `/logout`, `/pull`, `/reload`, `/restart`, `/refresh`, `/shutdown`,
plus the renamed `/load`, `/unload`, `/force`, `/clean`, `/history` and
`/removal`. Each reply says what to do instead.

`/queue` and `/mdauth` used to be on that list and are now real commands (see
above): `src/core/api/routes/ops.ts` closed those gaps. `/logs` points
at `/errors list` for failures and at `docker compose logs` for process output,
since container logs describe processes rather than platform state.

Full rationale per command: `docs/ipc-to-api-mapping.md`.

## 6. Operating notes

- **One command per user at a time.** A second command while one is running is
  refused with a note, so a slow `/run` cannot be accidentally double-triggered.
- **Autocomplete** on every `extension` option is served from the published-bundle
  list, cached for 60 seconds. The legacy bot listed directories on the
  scheduler's disk and could offer a name that had never been published.
- **Rate limits.** The admin API rate-limits per IP and answers 429; the bot
  reports the wait rather than hammering. Do not script a loop against it.
- **Logs** are structured JSON on stdout (pino), like every other service.
  Denied commands log at `warn` with the user, channel and reason; that log is
  the only place a pattern of attempts is visible.
- **Adding a command.** Add a `BotCommand` to `src/bot/commands.ts`
  with its `sensitivity`, add the API call to `apiClient.ts` with the scope the
  route enforces, and add a row to the table above. A subcommand present in the
  builder but missing from the `sensitivity` map is treated as `destructive`, so
  forgetting one fails closed rather than open.

## 7. Files

| Path | What |
|---|---|
| `src/services/bot.ts` | Process entrypoint: credentials, signals, fatal-exit policy. |
| `src/bot/bot.ts` | discord.js client, command registration, interaction routing. |
| `src/bot/commands.ts` | Command definitions and handlers (no discord.js in the handlers). |
| `src/bot/apiClient.ts` | Typed admin-API client, scope tagging, error messaging. |
| `src/bot/authz.ts` | The gating model. Pure functions. |
| `test/unit/botAuthz.test.ts` | Gating, including every fail-closed path. |
| `test/unit/botCommands.test.ts` | Every handler against a fake API client. |
| `test/unit/botApiClient.test.ts` | Request construction and error mapping. |


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
