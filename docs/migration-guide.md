# Migration guide: legacy publoader → distributed platform

Date: 2026-07-29
Audience: the operator running the existing stack.

This is a **staged cutover with a working rollback at every step**. The legacy
stack keeps running and keeps uploading until stage 5. Nothing here deletes
legacy data; the decommission step is separate and comes last.

The two systems can safely coexist because the platform scheduler starts
**paused**. The only thing that must never happen is both systems uploading the
same chapters at once — which is why stage 5 pauses legacy *before* unpausing
the platform, with a delta migration in between.

Path conventions below: `$REPO` is your publoader checkout,
`$LEGACY` is the directory holding the legacy `docker-compose.yml`,
`resources/` and `config.ini` (usually `$REPO/docker`).

---

## Stage 0 — Prerequisites and backups

Do not skip this. Stage 5 is the only irreversible-ish step and its rollback
depends on these artifacts existing.

**Take a full Mongo dump.**

```bash
# Credentials are in $LEGACY/config.ini under [Credentials] mongodb_uri.
mongodump --uri="$MONGODB_URI" --db="$MONGODB_DB_NAME" \
  --gzip --archive="$HOME/publoader-backup-$(date +%F).archive.gz"
```

Verify it is restorable before proceeding — an untested backup is not a backup:

```bash
mongorestore --uri="$MONGODB_URI" --gzip \
  --archive="$HOME/publoader-backup-$(date +%F).archive.gz" \
  --nsFrom='<db>.*' --nsTo='publoader_restoretest.*' --dryRun
```

**Copy the SQLite state store.** `sqlite3 .backup` takes a consistent snapshot
while the bot is running; `cp` of a WAL database does not.

```bash
sqlite3 "$LEGACY/resources/publoader.db" \
  ".backup '$HOME/publoader-state-$(date +%F).db'"
```

**Record the current state** so you can compare after cutover:

```bash
# Collection counts — you will check these against the migration report.
mongosh "$MONGODB_URI" --quiet --eval '
  ["uploaded","uploaded_ids","edited","unavailable",
   "to_upload","to_edit","to_delete","to_unavailable"]
   .forEach(c => print(c, db.getCollection(c).countDocuments()))'
```

**Checklist before continuing:**

- [ ] Mongo dump taken and restore-tested
- [ ] `publoader.db` snapshot taken
- [ ] Source counts recorded
- [ ] MangaDex credentials to hand (username, password, client id, client secret)
- [ ] A Cloudflare tunnel token for `publoader.ardax.dev`
- [ ] A checkout of the extensions repos (public and private) at the commit you
      intend to publish
- [ ] Somewhere to run at least one worker host — ideally two, so you can test
      failover (see `docs/operations.md`)

---

## Stage 1 — Stand up Postgres and the core

Full detail is in `docs/deployment.md`; the short version:

```bash
cd $REPO/docker/core
cp .env.example .env
# Fill in: POSTGRES_PASSWORD, ADMIN_TOKEN (openssl rand -base64 48),
# MANGADEX_*, DISCORD_WEBHOOK_URLS, TUNNEL_TOKEN.
docker compose pull
docker compose up -d
```

The `migrate` service runs `prisma migrate deploy` and exits 0 before any
application service starts, so a successful `up` means the schema is applied.

**Pause the platform immediately.** The scheduler must not create runs while
legacy is still the live system:

```bash
export PUBLOADER_API_URL=https://publoader.ardax.dev
export PUBLOADER_ADMIN_TOKEN=<the ADMIN_TOKEN you just set>

node $REPO/dist/src/cli/admin.js pause     # indefinite
node $REPO/dist/src/cli/admin.js stats     # expect paused: true
```

(If you have not built locally, run the CLI from the image instead —
`docker compose run --rm core-api node dist/src/cli/admin.js pause` — and set
`PUBLOADER_API_URL=http://core-api:8100` inside the compose network.)

**Verify before moving on:**

```bash
docker compose ps                 # postgres healthy, migrate exited 0, 4 services up
curl -fsS https://publoader.ardax.dev/healthz     # {"ok":true} through the tunnel
docker compose exec postgres psql -U publoader -d publoader -c '\dt'
```

---

## Stage 2 — Migrate the data

Two scripts, both re-runnable. Run them from a core container so they inherit
`DATABASE_URL` and the compose network. Use `core-processor` as the run target:
it is attached to both the `data` network (Postgres) and the `edge` network
(so it can reach an external MongoDB), and it uses public DNS.

### 2a. MongoDB → Postgres

Do a dry run first. It reads everything and writes nothing, so it costs only
time and tells you whether every document is accounted for:

```bash
cd $REPO/docker/core

docker compose run --rm --no-deps \
  -e MONGODB_URI="$MONGODB_URI" \
  -e MONGODB_DB_NAME="$MONGODB_DB_NAME" \
  core-processor node dist/src/cli/migrate-from-mongo.js --dry-run
```

Then the real pass:

```bash
docker compose run --rm --no-deps \
  -e MONGODB_URI="$MONGODB_URI" \
  -e MONGODB_DB_NAME="$MONGODB_DB_NAME" \
  core-processor node dist/src/cli/migrate-from-mongo.js
```

What it does:

| Mongo | Postgres | Natural key |
|---|---|---|
| `uploaded` | `uploaded_chapters` | `md_chapter_id` |
| `uploaded_ids` | `uploaded_ids` | `extension` + `chapter_id` |
| `edited` | `edited_chapters` (with the `edits[]` history preserved) | `md_chapter_id` |
| `unavailable` | `unavailable_chapters` | `md_chapter_id` |
| `deleted` | `deleted_chapters` | `md_chapter_id` |
| `to_upload` | `upload_tasks` kind `UPLOAD` | `chapterId\|chapterNumber\|chapterLanguage` |
| `to_edit` | `upload_tasks` kind `EDIT` | `md_chapter_id` |
| `to_delete` | `upload_tasks` kind `DELETE` | `md_chapter_id` |
| `to_unavailable` | `upload_tasks` kind `UNAVAILABLE` | `md_chapter_id` |
| GridFS bucket `images` | `artifacts` rows, referenced from the task's `chapter.imageArtifacts` | new UUID per image |

Field names are converted snake_case → camelCase throughout. The four chapter
history tables store the chapter in **typed columns**, so datetimes land as real
timestamps there; the transient `upload_tasks.chapter` payload keeps them as
ISO-8601 strings inside JSONB. Any key a legacy document carries that has no
column (`_id`, the GridFS `images` list, `archivedAt`) is parked in that table's
nullable `extra` JSONB rather than dropped, so a migrated row stays traceable
back to Mongo. Queue documents keep their
non-chapter sidecars (`payload`, `oldInfo`, `unavailableAt`) in the JSONB
payload, since the upload workers read them alongside the chapter.
Images larger than 20 MiB are skipped with a warning (they are not real pages).

> **Not migrated here:** `manga_id_map.json` and `override_options.json` never
> lived in Mongo, so this script does not touch them. They are seeded into
> `tracked_manga` and `extension_configs` by **bundle publish** in stage 3.

Every insert is `ON CONFLICT DO NOTHING` against the natural key, so re-running
adds only what is new. The script ends with a verification report:

```
migration report
collection        source  inserted   skipped    target  status
uploaded           48213     48213         0     48213  ok
uploaded_ids       48190     48190         0     48190  ok
...
images: 1204 fetched (612.3 MiB), 0 missing, 0 over the 20971520-byte cap
```

It exits non-zero if `inserted + skipped ≠ source` for any collection — that
means rows were read but neither written nor deliberately skipped, and you
should stop and investigate rather than cut over.

It also lists the non-chapter fields it carried through into the task payload.
Nothing is dropped — an `EDIT` task cannot execute without its `payload` (the
literal MangaDex PUT body) and an `UNAVAILABLE` task reads `unavailableAt`, so
anything that is not a chapter field rides along verbatim. Read the list once as
a sanity check that the queues look like you expect.

> **Run one instance at a time.** Two concurrent passes can write image
> artifacts whose owning upload task then loses the `ON CONFLICT` race, leaving
> orphaned rows in `artifacts`.

### 2b. SQLite → Postgres

```bash
docker compose run --rm --no-deps \
  -v "$LEGACY/resources:/legacy:ro" \
  core-processor node dist/src/cli/import-sqlite.js /legacy/publoader.db
```

This imports `schedule_overrides`, `disabled_extensions`, and the two settings
the platform honours (`chapter_removal_mode`, `pause_until`). `run_history` is
deliberately **not** imported — the platform's `runs` table carries state,
bundle pins and segments that the legacy rows cannot supply. Keep the SQLite
file as your historical record.

> `pause_until` is imported. If legacy was paused when you snapshotted, the
> platform will come up paused too — which is what you want at this stage, but
> remember it at stage 5.

**Verify:**

```bash
docker compose exec postgres psql -U publoader -d publoader -c "
  SELECT 'uploaded_chapters' t, count(*) FROM uploaded_chapters
  UNION ALL SELECT 'uploaded_ids', count(*) FROM uploaded_ids
  UNION ALL SELECT 'edited_chapters', count(*) FROM edited_chapters
  UNION ALL SELECT 'unavailable_chapters', count(*) FROM unavailable_chapters
  UNION ALL SELECT 'upload_tasks', count(*) FROM upload_tasks
  UNION ALL SELECT 'artifacts', count(*) FROM artifacts
  UNION ALL SELECT 'schedule_overrides', count(*) FROM schedule_overrides;"
```

Compare against the counts you recorded in stage 0.

---

## Stage 3 — Publish extension bundles (and seed the config tables)

The platform does not read extensions from a shared volume. Each extension is
published once as a content-addressed zip; jobs then pin a specific sha256.

**This stage also migrates the JSON config files.** `manga_id_map.json` and
`override_options.json` are no longer read at runtime — the database is the
config authority. Publishing a bundle **seeds** those files into
`tracked_manga` and `extension_configs`. The Mongo migrator does **not** touch
them; this is the only path that imports them.

For each extension directory (one containing `manifest.json`):

```bash
cd $EXTENSIONS_REPO
git rev-parse HEAD                      # record this

node $REPO/dist/src/cli/admin.js bundle publish ./src/mangaplus \
  --source-commit "$(git rev-parse HEAD)"
```

The CLI validates that `manifest.json` exists and declares `name` and `version`
before uploading, and the server re-validates the manifest against the zod
schema and runs the publish-time static scan. A rejected bundle is a real
problem with the manifest, not a transport error — read the 422 message.

Publish from **both** extension repos (public and private). Then:

```bash
node $REPO/dist/src/cli/admin.js extensions list
```

Every extension you expect to run must appear here, at the version you expect.
An extension that exists in the repo but is not listed will simply never be
scheduled.

Extensions that were disabled in SQLite carry over from stage 2b; confirm the
`DISABLED` column matches your intent.

### 3a. Verify the config seed

**Seeding runs on every publish, but it is create-only — it never overwrites.**
A mapping an operator fixed by hand survives a republish carrying stale JSON;
new external ids in the file *are* added. `extension_configs` is created once
and never touched again. The practical consequences, both worth internalising:

- **If the seed is wrong, republishing will not fix it.** Correct it through
  the API.
- **A wrong JSON file can still inject *new* mappings on a later publish**, so
  a repo with drifted data files is not harmless just because the database is
  authoritative for the ids it already has.

Check the counts against the JSON files, per extension:

```bash
# What the file says. manga_id_map.json is {mdMangaId: [externalId, ...]},
# so the row count is the total number of external ids, not the key count.
jq '[.[] | length] | add' ./src/mangaplus/manga_id_map.json

# What the database got.
node $REPO/dist/src/cli/admin.js tracked list mangaplus | tail -1
```

These must match. If the database count is lower, the usual causes are a
`data_files` entry in `manifest.json` pointing at a different filename, or
duplicate external ids in the JSON (which collapse onto the
`(extension, mangaId)` unique constraint — legitimate, but worth knowing about).

Then the override options:

```bash
node $REPO/dist/src/cli/admin.js ext-config get mangaplus \
  | diff - <(jq -S . ./src/mangaplus/override_options.json) && echo "match"
```

Fix any discrepancy through the API rather than by editing the JSON:

```bash
# One mapping.
node .../admin.js tracked set mangaplus <externalId> <mdMangaId>
node .../admin.js tracked remove mangaplus <externalId>

# Whole override document, from the file or a pipe.
node .../admin.js ext-config set mangaplus ./src/mangaplus/override_options.json
```

Once this stage is complete, treat the JSON files in the extensions repos as
**historical**. They are seed data, not configuration. Editing them changes
nothing on a deployment that has already published once.

---

## Stage 4 — Shadow phase

**Legacy keeps running and keeps uploading. The platform stays paused.** The
goal is to prove the platform produces the same decisions as legacy, without
letting it act on them.

### 4a. Enrol one trusted worker

```bash
node $REPO/dist/src/cli/admin.js enroll-token create --trust \
  --note "shadow-phase worker"
```

On the worker host:

```bash
cd $REPO/docker/worker
cp .env.example .env
# Set WORKER_NAME and paste the token as ENROLL_TOKEN.
docker compose pull
docker compose up -d
```

Back on the operator machine:

```bash
node $REPO/dist/src/cli/admin.js workers list
# STATUS ACTIVE, TRUST TRUSTED, HEARTBEAT within a minute
```

### 4b. Trigger one FORCE run

A `FORCE` run scrapes without the "already uploaded" short-circuit, which is
exactly what you want for comparison. It creates `upload_tasks` rows but does
not upload them — the platform is paused, so `core-uploader` is not draining
the queue.

```bash
node $REPO/dist/src/cli/admin.js runs trigger mangaplus --kind FORCE
```

> If the platform is paused, `runs trigger` returns 409. For the shadow test,
> resume briefly, trigger, and pause again — or leave it paused and instead
> insert the run while paused is lifted only long enough for the scheduler to
> claim it. The simpler sequence is: `resume`, `runs trigger`, `pause`. The
> uploader will not have drained a meaningful number of tasks in those seconds,
> but check `stats` afterwards and cancel anything it picked up.

Watch it:

```bash
node $REPO/dist/src/cli/admin.js runs show <runId>
```

### 4c. Compare against legacy

This is the actual gate. Check all four:

1. **Quarantine is empty.** `admin.js quarantine`. Any entry means the worker
   submitted something that failed schema or policy validation — a manifest
   `allowed_hosts` mismatch, a language not declared in the manifest, or a
   wrong group id. Fix the manifest, republish, re-run. Do not proceed with
   entries here.

2. **Dead-letter is empty.** `admin.js dead-letter`. Entries mean the job
   itself failed. Read `lastError`; `POLICY` and `PERMANENT` classes are
   configuration problems, `TRANSIENT` exhaustion usually means the extension
   is hitting a rate limit or the site is down.

3. **Upload tasks look like legacy's queues.** Compare the chapters the
   platform queued against what legacy has already uploaded for the same
   window:

   ```bash
   docker compose exec postgres psql -U publoader -d publoader -c "
     SELECT kind, chapter->>'chapterId' AS chapter_id,
            chapter->>'chapterNumber' AS num,
            chapter->>'chapterLanguage' AS lang
     FROM upload_tasks WHERE state = 'PENDING' ORDER BY created_at DESC LIMIT 50;"
   ```

   A `FORCE` run on an extension legacy has been keeping current should queue
   **few or no** `UPLOAD` tasks — the migrated `uploaded_chapters` history
   makes the processor's dedup skip them. A flood of UPLOAD tasks for chapters
   already on MangaDex means the history migration did not land correctly:
   stop, and check `uploaded_chapters` counts against Mongo.

4. **No `DELETE`/`UNAVAILABLE` surprises.** A `CLEAN`-style removal decision
   made from bad data removes real chapters. If the run queued removals you did
   not expect, cancel those tasks and investigate before stage 5.

5. **Untracked series look sane.** This is new behaviour with no legacy
   equivalent, so give it a careful first look:

   ```bash
   node $REPO/dist/src/cli/admin.js untracked list
   ```

   Every series the extension reported that has no `tracked_manga` mapping
   lands here as `NEW`. A handful is expected — genuinely new series the
   publisher added. **A flood is a symptom**, not a feature: it almost always
   means the stage-3 seed did not land, so the platform thinks nothing is
   tracked. Stop and re-check `tracked list` counts before going further.

   If the manifest sets `auto_create_titles`, rows move to `CREATED`/`TRACKED`
   on their own once the platform is unpaused, and titles get created on
   MangaDex. **During the shadow phase the platform is paused, so nothing is
   created** — which is the point. Review the list, `untracked skip` anything
   that should not exist, and only unpause when the remainder looks right.

Run the shadow phase for at least a full scheduling cycle of your busiest
extension — a day is reasonable. Repeat 4b/4c for two or three different
extensions, including one partitionable one, so segmenting gets exercised.

**Rollback at this stage is free:** stop the platform stack. Legacy never
stopped.

---

## Stage 5 — Cutover

Sequence matters. Legacy must be quiet before the platform starts uploading.

**5.1 — Pause legacy.** Over Discord: `/pause` (indefinite). Then confirm it
actually stopped:

```bash
docker compose -f $LEGACY/docker-compose.yml logs --tail 50 publoader
```

Wait for any in-flight extension run to finish and for the four worker queues
to stop draining. Legacy has no lease concept — a half-finished upload is
finished by the process that started it, so give it time rather than killing it.

**5.2 — Stop legacy uploads entirely.** Once quiet:

```bash
docker compose -f $LEGACY/docker-compose.yml stop publoader
```

Leave `publoader-bot` and `publoader-dash` running if you want them; they only
read. Stop them too if their `/run` commands could be used by someone who has
not read this document.

**5.3 — Delta migration.** Legacy has been uploading since stage 2. Re-run both
scripts to pick up everything new. Use `--refresh` this time so history rows
that legacy *updated in place* (edits, changed metadata) are rewritten rather
than skipped:

```bash
cd $REPO/docker/core

docker compose run --rm --no-deps \
  -e MONGODB_URI="$MONGODB_URI" -e MONGODB_DB_NAME="$MONGODB_DB_NAME" \
  core-processor node dist/src/cli/migrate-from-mongo.js --refresh

docker compose run --rm --no-deps -v "$LEGACY/resources:/legacy:ro" \
  core-processor node dist/src/cli/import-sqlite.js /legacy/publoader.db
```

Check the report exits 0. The `skipped` column will now be large — that is the
already-migrated bulk, and it is correct.

**5.4 — Clear the imported pause.** Stage 5.3 re-imported `pause_until` from
SQLite, and you paused legacy in 5.1, so the platform is now paused by that
setting as well as by yours:

```bash
node $REPO/dist/src/cli/admin.js resume
node $REPO/dist/src/cli/admin.js stats     # paused: false
```

**5.5 — Watch the first hour.** The migrated `upload_tasks` queue drains
immediately once resumed. This is the highest-risk window in the whole
migration, because it is the first time the platform writes to MangaDex.

```bash
watch -n 30 "node $REPO/dist/src/cli/admin.js stats"
```

Check on MangaDex directly that the first few chapters uploaded correctly
(right manga, right number, right language, right group). If anything is wrong:
`pause` immediately — that stops the uploader within one poll interval — then
work out what happened before resuming.

**5.6 — Keep legacy stopped but present.** Do not `docker compose down -v` and
do not delete `$LEGACY`. Leave the containers stopped, the volumes intact, and
Mongo untouched for **at least two weeks** of normal operation. That is your
rollback.

---

## Stage 6 — Rollback

Rollback is straightforward for anything that goes wrong **before** the
platform has uploaded much, and gets progressively more manual after that.

**Immediate rollback (platform has uploaded little or nothing):**

```bash
node $REPO/dist/src/cli/admin.js pause
docker compose -f $REPO/docker/core/docker-compose.yml stop \
  core-scheduler core-processor core-uploader
docker compose -f $LEGACY/docker-compose.yml start publoader
# then unpause legacy over Discord: /resume
```

Leave `core-api` running if workers are enrolled — draining them cleanly is
nicer than letting their requests fail — but nothing will be scheduled.

**The reverse-sync caveat.** There is no automated Postgres → Mongo migration,
and there will not be one. Anything the platform uploaded after cutover exists
only in Postgres:

- `uploaded_chapters` / `uploaded_ids` rows for chapters posted to MangaDex
- `edited_chapters`, `unavailable_chapters` rows
- `upload_tasks` in any state

Legacy does not know about these. If you restart legacy without reconciling,
it will see those chapters as **not yet uploaded** and will re-upload them —
MangaDex-side deduplication catches most of it, but not all, and you will get
duplicate chapters.

**Manual reconciliation before restarting legacy.** Export what the platform
did and load it into Mongo's `uploaded`/`uploaded_ids` collections:

```bash
# 1. Everything the platform recorded as uploaded since cutover. The chapter
#    lives in typed columns now, so rebuild the legacy document shape from them.
docker compose exec -T postgres psql -U publoader -d publoader -At -c "
  SELECT json_agg(jsonb_build_object(
    'mdChapterId', md_chapter_id, 'extensionName', extension,
    'chapterId', chapter_id, 'chapterUrl', chapter_url,
    'chapterNumber', chapter_number, 'chapterTitle', chapter_title,
    'chapterVolume', chapter_volume, 'chapterLanguage', chapter_language,
    'chapterTimestamp', chapter_timestamp, 'chapterExpire', chapter_expire,
    'chapterLookup', chapter_lookup, 'mangaId', manga_id,
    'mangaName', manga_name, 'mangaUrl', manga_url,
    'mdMangaId', md_manga_id, 'mdGroupId', md_group_id))
  FROM uploaded_chapters
  WHERE created_at > TIMESTAMPTZ '2026-08-01 00:00:00+00';" > /tmp/post-cutover.json

# 2. Load into Mongo. The rebuilt document is camelCase; legacy expects
#    snake_case, so convert on the way in. Sanity-check a few by hand first.
mongoimport --uri="$MONGODB_URI" --collection=uploaded --jsonArray \
  --file=/tmp/post-cutover-snake.json --mode=upsert --upsertFields=md_chapter_id
```

Then repeat for `uploaded_ids` (`chapter_id` + `extension_name`). Do **not**
reverse-sync `upload_tasks`: pending work should be re-derived by letting
legacy scrape, not by injecting queue rows whose shape has diverged.

Because this is manual and error-prone, the practical guidance is: **decide
within the first 48 hours.** If the platform has been running for two weeks,
rolling back means accepting some duplicate uploads and cleaning them up on
MangaDex afterwards. That is a worse position than fixing forward.

---

## Stage 7 — Decommission checklist

Only after the platform has run cleanly for at least two weeks and you have a
current Postgres backup.

- [ ] **Final Mongo dump**, archived somewhere off the host. This is the last
      copy of pre-migration history.
- [ ] **Final `publoader.db` snapshot**, archived alongside it.
- [ ] **Migrate the Discord bot** to the admin API. Until this is done the bot
      is talking to a stopped scheduler. See `docs/ipc-to-api-mapping.md` — note
      the gaps section, some commands need new endpoints first.
- [ ] **Retire `publoader-dash`.** There is nothing to migrate: the platform
      ships its own dashboard, served by `core-api` at the domain root, and it
      already covers every admin endpoint. Point the tunnel's Public Hostname
      for `publoader.ardax.dev` at `core-api:8100`, delete the old dashboard's
      Public Hostname route, then stop and remove the container and its image.
      Operators sign in with their own accounts now (`docs/deployment.md` →
      "Dashboard"), so also revoke the copy of `ADMIN_TOKEN` the old dashboard
      held, and delete the Discord OAuth app it used if it had one of its own —
      the new dashboard signs operators in with MangaDex, not Discord.
- [ ] **Remove the `docker.sock` mount** from `publoader-bot`. The bot mounted
      the Docker socket so `/start`, `/shutdown` and `/restart` could control
      the scheduler container. That mount is root-equivalent access to the host
      and is the single largest piece of attack surface in the legacy stack.
      Its replacement is `publoader-admin pause` / `resume` / `workers drain`,
      none of which need the Docker daemon.
- [ ] **Retire the Unix-socket IPC.** Delete `$LEGACY/resources/` from the bot
      and dashboard bind mounts. The socket was a shared-filesystem coupling
      that only worked because everything ran on one host.
- [ ] **Retire the SQLite state store.** Postgres is now authoritative for
      schedules, disabled extensions, removal mode, and pause.
- [ ] **Stop maintaining the JSON config files.** `manga_id_map.json` and
      `override_options.json` are seed data only; after the first publish the
      database wins and edits to the files do nothing. Either delete them from
      the extensions repos or add a header comment saying so — a file that
      looks live but is not will eventually cost someone an afternoon. Export
      the current truth first if you want a copy in the repo:
      `admin.js tracked list <ext>` and `admin.js ext-config get <ext>`.
- [ ] **Retire the shared `extensions` volume.** Extension code is delivered as
      hash-pinned bundles; a writable shared volume of Python that several
      containers execute is exactly the supply-chain path the bundle pipeline
      removes.
- [ ] **Retire `config.ini`.** All configuration is environment/Docker-secret
      driven. Rotate every credential it contained — it has been on disk in a
      bind mount, and the `pull` command's GitHub PAT in particular should be
      revoked outright since the bundle pipeline does not need it.
- [ ] **Revoke the MangaDex session** the legacy stack held (`mdauth.json`) and
      confirm only `core-uploader` holds MD credentials now.
- [ ] **Remove the legacy Cloudflare tunnel hostnames** for the webhook (8080)
      and old dashboard (8090). The dashboard route is no longer optional to
      clean up: `publoader.ardax.dev/` now serves the platform's own dashboard,
      so a stale route pointing at 8090 is two UIs claiming one hostname.
- [ ] **`docker compose down -v`** on the legacy stack, and remove the images.
- [ ] Set up backups for the new world: `pgdata` volume, on a schedule. See
      `docs/operations.md` → "Backup and restore".


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
