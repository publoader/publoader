# External Publisher MangaDex Uploader

Reads new chapter updates from extension modules (one per publisher) and posts
them to MangaDex. Extensions are pulled from the
[publoader-extensions](https://github.com/publoader/publoader-extensions)
repo (and optionally a private companion repo) and loaded dynamically.

## Running with Docker (recommended)

```bash
cp config.ini.example config.ini   # fill in credentials
cd docker
docker compose up -d
```

This brings up:
- `publoader` — main scheduler + watchers, owns the IPC socket. The
  entrypoint also starts the Discord control bot in the background when
  `DISCORD_BOT_TOKEN` is configured (one container, IPC over a unix socket
  inside `/app/resources/`). Run/error notifications still go through
  `WEBHOOK_URL`.
- `publoader-extensions` — sidecar that holds the extensions volume
- `watchtower` — auto-pulls new images

### CLI commands (single-instance aware)

Once the scheduler is running, running `python run.py` again forwards the
command to the live instance instead of starting a second one:

```bash
python run.py -e mangaplus           # run a specific extension
python run.py -f                      # force-run everything
python run.py -c                      # clean run
python run.py -u                      # update + restart
```

## Running locally without Docker

For development you can still use a virtualenv:

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python run.py
```

## Discord bot commands

Once the bot is configured (`DISCORD_BOT_TOKEN`) and running, every command
exists both as a prefix command (default `!`) and as a discord slash command.
The bot is **control-only** — run updates and error notifications still go
through `WEBHOOK_URL`, not the bot. Set `DISCORD_GUILD_ID` to make slash-command
sync near-instant for a single server; leave it blank to sync globally (can
take up to an hour to propagate). When inviting the bot, include the
`applications.commands` scope.

- `!ping` / `/ping` — bot heartbeat, IPC reachability + latency, scheduler PID
  and pending jobs
- `!run [extension ...]` / `/run [extension]` — run extensions now (or all)
- `!force [extension ...]` / `/force [extension]` — force run regardless of schedule
- `!clean [extension ...]` / `/clean [extension]` — clean run
- `!reload` / `/reload` — reload extensions in-place
- `!restart` / `/restart` — full restart (pulls new code via the updater)
- `!status` / `/status` — list scheduled jobs / pid
- `!add <manga_id> [title]` / `/add manga_id title` — add a series to `manga_data.json`

Slash variants accept a single comma- or space-separated `extension` argument
where the prefix forms take varargs.

## Extensions

Extensions are downloaded from the configured GitHub repos as tarballs and
extracted into `publoader/extensions/`. They are loaded dynamically with a
static-AST safety scan that rejects extensions calling `eval`, `exec`,
`subprocess`, `ctypes`, etc. The scan is not a sandbox — the upstream repos
are still trusted.

If a publisher is missing, you can build your own extension. See
[the extensions guide](publoader/extensions/CONTRIBUTING.md).

## Contributing

Format code with [Black](https://pypi.org/project/black/) using the default
settings. Open an issue or PR for changes.
