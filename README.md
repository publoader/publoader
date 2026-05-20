# External Publisher MangaDex Uploader

Reads new chapter updates from extension modules (one per publisher) and posts
them to MangaDex. Extensions are pulled from the
[publoader-extensions](https://github.com/publoader/publoader-extensions)
repo (and optionally a private companion) and loaded dynamically.

When a chapter is no longer reachable on the source, the uploader does **not**
delete it on MangaDex — it strips the `externalUrl` and leaves a placeholder
info card (uploaded at first commit) as the visible page, and moves the row
into the `to_unavailable` collection on MongoDB. Duplicate-chapter cleanup
still hard-deletes.

## Running with Docker (recommended)

```bash
cp config.ini.example config.ini   # fill in credentials
cd docker
docker compose up -d
```

This brings up:

- `publoader` — main scheduler, workers, IPC server, and the Discord control
  bot (one container; bot is started in the background by the entrypoint).
- `publoader-extensions` — sidecar that syncs `src/<extension>/` from the
  extensions image into the named `extensions` volume on every start, then
  exits. The main container waits for this to finish via
  `service_completed_successfully`.
- `watchtower` — auto-pulls new images on a cron (defaults to 01:00).
- `cloudflared` — optional Cloudflare tunnel.

State lives in `./resources/` (mounted into `/app/resources`):
- `publoader.db` — SQLite state DB (WAL mode, schedule overrides + run history)
- `publoader.sock` — IPC unix socket
- `.mdauth` — MangaDex session cache

### Single-instance CLI

Once the scheduler is running, re-invoking `python run.py` forwards the command
over the IPC socket instead of starting a second instance:

```bash
python run.py -e mangaplus    # run one or more extensions
python run.py -f              # force-run everything
python run.py -c              # clean run (full reconcile)
python run.py -u              # restart via the updater
```

## Running locally without Docker

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

## Discord bot

Set `discord_bot_token` in `config.ini` (`[Credentials]`) — the entrypoint
starts the bot in the background. Run/error notifications keep going through
the configured `[Paths] webhook_url` (comma- or newline-separated for multiple
channels); the bot itself is **control-only**.

| Setting | `config.ini` key (`[Paths]`) | Env var |
| --- | --- | --- |
| Guild for fast slash sync | `discord_guild_id` | `PUBLOADER_DISCORD_GUILD` |
| Allowed channels / threads | `discord_allowed_channels` | `PUBLOADER_DISCORD_CHANNELS` |
| Admin user IDs | `discord_admin_users` | `PUBLOADER_ADMIN_USERS` |
| Admin role IDs | `discord_admin_roles` | `PUBLOADER_ADMIN_ROLES` |
| Prefix character | `discord_command_prefix` | — |

`discord_allowed_channels` accepts comma- or whitespace-separated channel and
thread IDs. Leave it empty to allow the bot anywhere. When inviting, include
the `applications.commands` scope.

### Commands

Every command exists as both prefix (default `!`) and slash. For prefix variants
without arguments, the bot sends a dropdown picker of on-disk extensions.

| Command | Description |
| --- | --- |
| `!ping` / `/ping` | Bot heartbeat, IPC reachability, scheduler PID + queued jobs |
| `!run [extension ...]` / `/run [extension]` | Run extensions on schedule |
| `!force [extension ...]` / `/force [extension]` | Force-run regardless of schedule |
| `!clean [extension ...]` / `/clean [extension]` | Clean reconcile run |
| `!reload` / `/reload` | Reload extensions in-place (no process restart) |
| `!restart` / `/restart` | Restart the scheduler (pulls new code via the updater) |
| `!status` / `/status` | Scheduler PID + queued jobs |
| `!pull [repo ...]` / `/pull [repo]` | `git pull --ff-only` for `base`, `extensions`, `extensions-private`, or `all` (admin) |
| `!schedule list` / `/schedule list` | Show effective schedule and DB overrides |
| `!schedule set <ext> <hour> <minute> [day]` / `/schedule set …` | Persist a per-extension schedule override (admin) |
| `!schedule remove <ext>` / `/schedule remove …` | Drop a DB override — falls back to `schedule.json` (admin) |

Slash variants accept a single comma/space-separated `extension` arg where the
prefix forms take varargs. Concurrent-run dedup is enforced: the same extension
can't be queued twice while one invocation is in flight.

### `/pull` paths

`/pull` resolves each repo from (in order): the env var, `config.ini` `[Repos]`
section, then a built-in default. Override per-repo when the working trees
aren't where the defaults expect them:

```ini
[Repos]
base = /opt/publoader
extensions = /opt/publoader/publoader/extensions
extensions_private = /opt/publoader-extensions-private
```

If a path isn't a git working tree (the production image doesn't ship `.git`),
`/pull` returns a hint to update via `docker compose pull && docker compose up -d`
or to let watchtower handle it.

## Extensions

Extension trees are mounted into `/app/publoader/extensions/src/<extension>/`.
Each tree must contain `<extension>.py`, `manifest.json`, and any data files
the extension reads at runtime. Extensions are loaded dynamically with a
static-AST safety scan that rejects modules using `eval`, `exec`,
`subprocess`, `ctypes`, etc. The scan is **not** a sandbox — upstream repos
are still trusted.

Extensions should import only from `publoader.api` — it pins a stable
public surface (`__api_version__`) re-exporting `Chapter`, `Manga`,
`PubloaderWebhook`, `setup_extension_logs`, `chapter_number_regex`,
`open_manga_id_map`, `open_title_regex`, `find_key_from_list_value`, and
`create_new_event_loop`. Anything else under `publoader.*` is internal.

For writing a new extension, see the
[extensions contributing guide](https://github.com/publoader/publoader-extensions/blob/master/README.md).

## Tests

```bash
.venv/bin/python -m pytest -q
```

The suite covers the IPC server, state DB, AST scanner, atomic writes,
webhook URL parsing, chapter dataclasses, chapter card generation, and the
`/pull` git wiring.

## Contributing

Format code with [Black](https://pypi.org/project/black/) using default
settings. Open an issue or PR for changes.
