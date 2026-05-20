# Running with Docker

The published image lives on Docker Hub as
[`ardax/publoader`](https://hub.docker.com/r/ardax/publoader). The extension
sidecar is [`ardax/publoader-extensions`](https://hub.docker.com/r/ardax/publoader-extensions).
Either pull the images directly or use the `docker-compose.yml` in this
directory for a fully wired stack.

## Quick start

Put `docker-compose.yml`, `entrypoint.sh`, and the host-side files referenced
by the compose file in the same directory, then:

```bash
cp ../config.ini.example config.ini   # fill in your credentials
mkdir -p logs resources
touch .mdauth
docker compose up -d
```

## What's in the stack

| Service | Purpose |
| --- | --- |
| `publoader` | Scheduler, watchers, IPC server. Entrypoint also starts the Discord control bot in the background when `discord_bot_token` is set. |
| `publoader-extensions` | Sidecar. Runs `sync_extensions.py` on each start to atomically populate the `extensions` named volume from the image, then exits. `publoader` waits for it via `service_completed_successfully`. |
| `watchtower` | Pulls fresh `ardax/publoader*` images on a daily cron (default 01:00). |
| `cloudflared` | Optional Cloudflare tunnel — needs `CLOUDFLARE_PUBLOADER_TUNNEL_TOKEN` in the environment. |

## Volumes and bind mounts

- `./config.ini` → `/app/config.ini` (read-only credentials + paths)
- `./logs` → `/app/logs`
- `./resources` → `/app/resources` (holds `publoader.db`, `publoader.sock`, `.mdauth`, cached chapter data)
- `./entrypoint.sh` → `/app/entrypoint.sh`
- `./.mdauth` → `/app/.mdauth`
- Named volume `extensions` → `/app/publoader/extensions` (populated by the sidecar)

The IPC unix socket lives at `/app/resources/publoader.sock`. Subsequent
invocations of `python run.py` inside the container forward over that socket
instead of starting a second instance.

## Updating

The recommended path is the watchtower cron — it pulls and recreates the
containers automatically. For a manual refresh from the host:

```bash
docker compose pull
docker compose up -d
```

If you are running with the source tree bind-mounted as a `.git` working tree
(useful for development), you can use the bot's `/pull` command to fast-forward
the base or extension repos in place without recreating the container.
