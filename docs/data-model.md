# Data model

PostgreSQL is the single source of truth for scheduling, leases, results,
canonical chapter history, configuration, and audit. There are no JSON config
files at runtime and no in-memory queues: if it is not in Postgres, it did not
happen.

Schema: [`prisma/schema.prisma`](../prisma/schema.prisma).
Migrations: [`prisma/migrations/`](../prisma/migrations/).
Table and column names are snake_case-mapped so the hot-path raw SQL
(`FOR UPDATE SKIP LOCKED`) stays unquoted (`schema.prisma:1-4`).

---

## Reading this document

Tables fall into three categories, and the category tells you what a restore or a
truncation costs you.

| Category | Meaning | Tables |
| --- | --- | --- |
| **Canonical** | Irreplaceable. Losing a row loses information no other system holds. | `bundles`, `uploaded_chapters`, `uploaded_ids`, `edited_chapters`, `unavailable_chapters`, `deleted_chapters`, `tracked_manga`, `extension_configs`, `schedule_overrides`, `settings`, `admin_users`, `api_tokens`, `audit_events`, `workers`, `disabled_extensions` |
| **Derived** | Reconstructable by re-running work. Losing it costs time, not truth. | `runs`, `jobs`, `result_submissions`, `untracked_manga` |
| **Transient** | Queue and cache rows with a natural end of life. | `upload_tasks`, `artifacts`, `enroll_tokens`, `admin_sessions`, `upload_logs` |

`upload_logs` is transient in lifetime but load-bearing while a chapter is
in flight — see [its entry](#upload_logs-transient-load-bearing).

---

## Enums and their state machines

### `JobState` (`schema.prisma:42-49`)

The job lifecycle. Every transition is one guarded SQL statement; see
[architecture-guide.md](architecture-guide.md#the-job-state-machine) for the
transition table and what guards each edge.

```
PENDING ──claim──> LEASED ──start──> RUNNING ──commit/complete──> SUCCEEDED
   ^                  │                  │
   │                  └──────┬───────────┘
   └── requeue (TRANSIENT or POLICY, attempt < maxAttempts, backoff) ──┘
                             │
                             └── DEAD_LETTER  (attempts exhausted, or PERMANENT)
PENDING ──operator cancel──> CANCELLED
DEAD_LETTER ──operator retry──> PENDING  (attempt := 0; the parent run is revived
                                          in the same transaction)
```

There is deliberately **no `FAILED`** state. A job that exhausts its attempts
goes straight to `DEAD_LETTER`, which is why the merged error feed filters jobs
and upload tasks on different state sets
(`src/core/api/routes/ops.ts:269-272`).

### `RunState` (`schema.prisma:32-40`)

```
PENDING ──first job claimed──> EXECUTING ──all jobs SUCCEEDED──> INGESTING
                                            ──> PROCESSED   (processor done)
     any job DEAD_LETTER/CANCELLED and none still running ──> DEAD_LETTER
```

`PENDING → EXECUTING` is set opportunistically by the first successful claim
(`src/core/store/jobs.ts:191-195`). `→ INGESTING` and `→ DEAD_LETTER`
are computed by `advanceRuns()` (`jobs.ts:405-431`) — a set-based query, so it is
correct however many jobs a run has. `FAILED` exists in the enum but nothing
currently writes it; `advanceRuns` uses `DEAD_LETTER` for the terminal-failure
case.

### `ResultState` (`schema.prisma:57-62`)

```
RECEIVED ──validated, won the commit race──> COMMITTED
         ──stale lease / worker-reported error / lost the race──> SUPERSEDED
         ──manifest policy violation──> QUARANTINED
```

`COMMITTED` is the terminal success and is capped at one row per job by the
[commit marker](#result_submissions-derived). `SUPERSEDED` means "a submission that did
not take effect"; `QUARANTINED` means "a submission we refused on policy grounds
and an operator should look at".

### `UploadTaskState` (`schema.prisma:77-83`)

```
PENDING ──claim──> LEASED ──> DONE
                      │
                      ├── fail, attempt < maxAttempts ──> PENDING (backoff)
                      └── fail, attempts exhausted ─────> DEAD_LETTER
```

`FAILED` exists in the enum and is accepted by the operator retry filter
(`ops.ts:151`) but the uploader itself only ever writes `PENDING`,
`DEAD_LETTER`, or `DONE` (`src/core/store/uploadTasks.ts:62-91`). There
is no `CANCELLED`: operator cancellation marks the row `DONE` and records why in
`lastError`, because the row has to leave the queue and a silent `DONE` would be
indistinguishable from a real upload (`ops.ts:174-206`).

### `UntrackedState` (`schema.prisma:394-401`)

```
NEW ──CAS claim──> CREATING ──title created + tracked──> TRACKED
 │                     │
 │                     └── error, attempts < 3 ──> NEW
 │                     └── error, attempts >= 3 ──> FAILED ──operator approve──> NEW
 └── operator skip ──> SKIPPED
```

`CREATED` exists in the enum and is accepted as a filter value by the admin API
(`src/core/api/routes/admin.ts:398`) but no code path writes it — the
service goes `CREATING → TRACKED` in one step, because tracking is what actually
unblocks uploads (`src/core/md/titleService.ts:125-138`).

### Remaining enums

| Enum | Values | Meaning |
| --- | --- | --- |
| `WorkerStatus` | `ACTIVE`, `DRAINED`, `REVOKED` | `DRAINED` still authenticates but gets 204 + `x-publoader-drained` on lease (`routes/worker.ts:89-92`); `REVOKED` fails authentication outright (`store/workers.ts:87`). |
| `TrustTier` | `TRUSTED`, `COMMUNITY` | Worker capability floor; see [trust tier](glossary.md). |
| `RunKind` | `UPDATE`, `CLEAN`, `FORCE` | `UPDATE` is the scheduled kind. `CLEAN` asks the extension for its full catalogue so removals can be computed, and is never partitioned. `FORCE` is the default for a manual trigger (`routes/admin.ts:104`). |
| `ErrorClass` | `TRANSIENT`, `PERMANENT`, `POLICY` | Decides retry vs immediate dead-letter. `PERMANENT` dead-letters at once; `TRANSIENT` and `POLICY` requeue with backoff until `maxAttempts` (`store/jobs.ts:246-268`). `POLICY` is written only by ingest, for a manifest or tracked-map violation. |
| `UploadTaskKind` | `UPLOAD`, `EDIT`, `DELETE`, `UNAVAILABLE` | Drained in the order `DELETE, EDIT, UPLOAD, UNAVAILABLE` (`services/uploader.ts:28`) so a chapter removed upstream never races the re-upload of its replacement. |
| `UploadOutcome` | `COMMITTING`, `COMMITTED`, `FAILED` | The `upload_logs` bracket around an upload. |
| `AdminRole` | `OWNER`, `ADMIN`, `CONTRIBUTOR` | An `ADMIN` has full control-plane authority but cannot grant it to anyone else — the one privilege boundary the platform has (`routes/users.ts:8-15`). A `CONTRIBUTOR` curates the series map and triages untracked series: it can **add** mappings but not change or remove existing ones, and cannot reach runs, workers, credentials, or settings (`schema.prisma:477-484`, scope set at `api/scopes.ts:103-121`). |

---

## Control plane

### `workers` (canonical)

Worker identity and credential state.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | uuid pk | Worker identity; appears in audit actors as `worker:<id>`. |
| `name` | text | Operator-supplied label, truncated to 128 chars at enrollment (`store/workers.ts:61`). Not unique — two hosts may share a name; the id and token are what identify them. |
| `token_hash` | text **unique** | sha256 of the `pw_…` bearer token. The plaintext is returned once at enrollment and is unrecoverable. The unique constraint is what makes the token a lookup key. |
| `status` | `WorkerStatus` | See enum table above. |
| `trust` | `TrustTier` | Copied from the enroll token at enrollment (`store/workers.ts:63`); not self-declared. |
| `extensions` | text[] | Declared capability set. A worker may **narrow** this per lease request but never widen it (`routes/worker.ts:99-107`). Empty means "anything". |
| `last_heartbeat_at` | timestamptz? | Updated by `POST /worker/heartbeat`. Staleness is how an operator spots a dead host; nothing automatic acts on it. |
| `agent_version` | text? | Reported by the agent; informational. |

Index: `token_hash` unique — serves the authentication lookup, the only
hot-path query on this table.

### `enroll_tokens` (transient)

Single-use, expiring invitations to join the fleet.

| Column | Meaning |
| --- | --- |
| `token_hash` **unique** | sha256 of the `pe_…` token. |
| `trust` | The tier the resulting worker gets. This is why trust is not self-declared. |
| `expires_at` | Default 24 h (`store/workers.ts:30`), operator-settable 1–720 h. |
| `single_use` | When true, `used_by_worker_id` may be set exactly once. |
| `used_by_worker_id` | Set by a guarded update; the loser of a concurrent enrollment has its worker row rolled back (`store/workers.ts:70-78`). |
| `revoked` | Manual kill switch. |

**Invariant:** one enroll token yields at most one worker. Enforced by
`updateMany({ where: { id, usedByWorkerId: null, revoked: false } })` and
checking the affected count — not by a read-then-write. Tested at
`test/integration/api.test.ts:116`.

### `runs` (derived)

| Column | Meaning |
| --- | --- |
| `idempotency_key` **unique** | The double-creation guard. `sched:<ext>:<slot>` for scheduled runs (`scheduler/service.ts:95`), `manual:<ext>:<kind>:<iso>` for an unnamed manual trigger (`routes/admin.ts:114-116`). |
| `extension`, `extension_version`, `bundle_sha256` | The version pin, copied onto every job. A run's jobs cannot drift onto a different bundle. |
| `kind`, `state` | See enums. |
| `segments_total` | How many jobs this run has. |
| `require_all_segments` | Stored (default true) but **not currently read** by the processor, which instead refuses to process a `CLEAN` run with missing segments and skips only the removal passes for other kinds (`processor/processor.ts:144-146`, `258-269`). |
| `triggered_by` | Audit provenance: `"scheduler"`, or the acting principal for a manual run. |
| `scheduled_for` | The slot this run was created for; null for manual runs. |
| `started_at`, `completed_at`, `error` | Lifecycle timestamps. |

Indexes: `(state)` serves the processor's `INGESTING` claim
(`core/processor/processor.ts:117-130`); `(extension, created_at)` serves the filtered
run list on `GET /admin/runs`.

### `jobs` (derived)

The leasable unit. This is the table the whole exactly-once story rests on.

| Column | Meaning |
| --- | --- |
| `idempotency_key` **unique** | `job:<runKey>:<index>/<total>` (`store/jobs.ts:101`). Makes job creation replay-safe alongside the run key. |
| `run_id` | FK to `runs`. |
| `extension`, `extension_version`, `bundle_sha256`, `kind` | Denormalized from the run so the claim query needs no join. `bundle_sha256` is the version pin the worker must match, re-checked at ingest (`ingest.ts:136-138`). |
| `segment_index`, `segment_total`, `segment_key`, `segment_manga_ids` | Partitioning. `segment_key` is a deterministic hash; `segment_manga_ids` is the disjoint id slice this job owns. `"whole"` and `[]` for an unpartitioned job (`store/jobs.ts:81`). |
| `min_trust` | From the manifest. Filtered in the claim, so enforcement is in the query, not in application logic. |
| `state`, `attempt`, `max_attempts` | Retry budget. `attempt` increments on **claim** (`jobs.ts:170`), so it counts attempts started, not failures recorded. |
| `not_before` | Backoff gate. The claim requires `not_before <= now()`. |
| `timeout_seconds` | From the manifest; the worker enforces it as a hard wall-clock kill of the runner's process group (`worker/executor.ts:441-445`). |
| `lease_id`, `lease_worker_id`, `lease_expires_at` | The lease. `lease_id` is a fresh UUID per claim and is named in the `WHERE` clause of every worker-driven transition. |
| `cancel_requested` | Cooperative cancellation: a live worker learns of it on its next renew and aborts (`worker/agent.ts:256-259`). |
| `error_class`, `last_error` | Last failure, truncated to 8000 chars (`jobs.ts:255`). |

Indexes:

| Index | Query it serves |
| --- | --- |
| `(state, not_before)` | The claim: `WHERE state = 'PENDING' AND not_before <= now() … ORDER BY not_before ASC` (`jobs.ts:153-164`). This is the single hottest query in the system. |
| `(run_id)` | `advanceRuns()`, run detail, and the processor's envelope load. |
| `(lease_expires_at)` | The sweeper: `WHERE state IN ('LEASED','RUNNING') AND lease_expires_at < now()` (`jobs.ts:305-343`). |

**Invariants.**

- *A job is claimed by at most one worker.* Enforced by
  `FOR UPDATE SKIP LOCKED … LIMIT 1` inside the claiming `UPDATE`
  (`jobs.ts:153-186`). Two concurrent claimers cannot select the same row.
  Tested at `test/integration/lease.test.ts:41`.
- *Only the current lease holder may advance a job.* Every transition names
  `lease_id` (`jobs.ts:201-207`, `214-232`, `235-241`, `247-286`) and reports
  `count === 1` as success. A zero-row update means the caller lost and must
  treat the transition as rejected. There is no read-then-write anywhere in the
  file (`jobs.ts:4-9`). Tested at `lease.test.ts:55`.

### `result_submissions` (derived)

Every envelope a worker ever submitted, judged or not.

| Column | Meaning |
| --- | --- |
| `idempotency_key` **unique** | `res:<jobId>:<attempt>` (`contracts/envelope.ts:50-52`). A retried *delivery* of the same attempt collides here and is answered with the prior verdict (`store/results.ts:39-47`, `ingest.ts:49-53`), which is what turns at-least-once delivery into exactly-once effect. |
| `job_id` | Not an FK — deliberately, so an envelope for an unknown job is a validation answer rather than a constraint error (`ingest.ts:47-48`). |
| `attempt` | The job's attempt at ingest time. |
| `lease_id`, `worker_id` | Who submitted it, under which lease. Both are compared against the live job before anything is believed (`ingest.ts:57-60`). |
| `envelope` | JSONB. **Stays JSONB on purpose:** it is an immutable audit record of exactly what a worker sent, including fields a future schema version may add. Promoting it to columns would mean the stored evidence no longer matches what was received. It is re-validated on read (`core/processor/processor.ts:308-315`). |
| `state`, `reject_reason` | The verdict and why. |

Indexes: `(job_id)` serves `committedForJob()`; `idempotency_key` unique serves
the duplicate check.

**The commit marker.** A partial unique index that Prisma cannot express
declaratively, so it lives in migration SQL
(`prisma/migrations/20260729181006_result_commit_marker/migration.sql`):

```sql
CREATE UNIQUE INDEX "result_committed_one_per_job"
  ON "result_submissions" ("job_id")
  WHERE state = 'COMMITTED';
```

**What it prevents:** two submissions for the same job both taking effect. This
is not a nicety — without it, a lease that expires while a worker is still
running (network partition, long GC pause, a clock problem) lets both the
original holder and its replacement commit results for the same job, and the
chapter is uploaded twice. With it, the second `UPDATE … SET state='COMMITTED'`
raises `P2002`, the transaction rolls back, and the submission is recorded
`SUPERSEDED` (`store/results.ts:70-97`). Verified against a real Postgres at
`test/integration/lease.test.ts:142` and end-to-end at
`lease.test.ts:108`.

The commit is also a transaction that flips the submission **and** marks the job
`SUCCEEDED` gated on the lease: either both happen or neither
(`results.ts:72-88`). A stale lease therefore cannot commit even if it somehow
won the index race.

### `artifacts` (transient)

| Column | Meaning |
| --- | --- |
| `sha256` | Computed from the received bytes, not trusted from the client; a declared/actual mismatch is a 422 (`store/artifacts.ts:34-37`). Not unique — identical pages from two jobs get two rows. |
| `size`, `content_type` | Validated: 1 byte–20 MiB, png/jpeg/gif/webp only. |
| `content` | `Bytes`. In Postgres for v1; the store is the seam for moving to object storage (`artifacts.ts:15-17`). |
| `job_id`, `worker_id` | Provenance. |
| `expires_at` | 48 h from insert, **cleared** when a committed result references the artifact (`artifacts.ts:58-65`). |

Indexes: `(job_id)`; `(expires_at)` serves the GC sweep.

**Invariant:** an artifact referenced by a committed envelope is not garbage
collected. Enforced by pinning at commit time (`ingest.ts:104-109`) before the
`gcExpired()` sweep can see it.

### `bundles` (canonical)

| Column | Meaning |
| --- | --- |
| `sha256` **unique** | The content address of the zip. This *is* the version pin. |
| `extension` + `version` **unique together** | One row per extension version. Republishing the same version with different content **replaces** the row and the sha changes; jobs already pinned to the old sha keep their pin but can no longer fetch the bytes — publish under a new version to keep both (`store/bundles.ts:64-73`). |
| `manifest` | JSONB. **Stays JSONB:** it is a validated external document whose schema is versioned independently of ours, and the core parses it with zod on every read (`ingest.ts:141-143`). Columns would freeze a format extensions are allowed to extend (`manifest.ts:78` is `.passthrough()`). |
| `archive` | The zip bytes, served to workers by `GET /worker/bundles/:sha256`. |
| `source_commit` | Provenance from `x-source-commit`; recorded in the audit event too. |
| `yanked` | Excluded from `latest()` and from the scheduler's manifest sweep. Does not break existing pins. |

Indexes: `sha256` unique (worker download, ingest policy load);
`(extension, version)` unique (the publish upsert);
`(extension, published_at)` serves `latest()`.

### `upload_tasks` (transient)

The MangaDex work queue.

| Column | Meaning |
| --- | --- |
| `kind` + `dedupe_key` **unique together** | The idempotency guard. Insertion is `ON CONFLICT DO NOTHING` (`store/uploadTasks.ts:32`), so re-processing a run is a no-op for already-queued chapters. Dedupe keys differ by kind: `UPLOAD` uses `chapterId|chapterNumber|chapterLanguage` (`uploadTasks.ts:15-21`), `EDIT`/`DELETE`/`UNAVAILABLE` use the MangaDex chapter id (`core/processor/processor.ts:219`, `490`). |
| `chapter` | JSONB. **Stays JSONB, and the asymmetry with the four chapter tables is deliberate** (documented at `schema.prisma:228-235`): this is a transient payload consumed once by one worker and never queried by field, and it is *not* the canonical chapter shape — `EDIT` rows carry `payload`/`oldInfo` and `UNAVAILABLE` rows carry `unavailableAt` alongside the chapter, which typed columns would have to model as a union. |
| `state`, `attempt`, `max_attempts` (5), `not_before` | Retry budget, backoff. |
| `lease_id`, `lease_expires_at` | Same SKIP LOCKED lease pattern as jobs, so multiple uploader processes would be safe (`uploadTasks.ts:38-60`). |
| `last_error` | Failure reason, or the operator's cancellation note. |

Index: `(state, not_before)` serves the claim.

### `upload_logs` (transient, load-bearing)

The crash-safety bracket around an upload. Before opening a MangaDex upload
session the uploader writes a `COMMITTING` row; after the commit it writes a
`COMMITTED` row carrying the resulting MangaDex chapter id
(`md/taskWorkers.ts:115`, `159-161`).

On retry, a prior `COMMITTED` row with an id makes the uploader **verify the
chapter still exists on MangaDex** before skipping. A recorded id MangaDex never
indexed must re-upload, not silently vanish (`taskWorkers.ts:95-113`).

| Column | Meaning |
| --- | --- |
| `dedupe_key` | Joins to the upload task that produced it. Indexed — this is the only query on the table. |
| `md_chapter_id` | The committed chapter id; null on `COMMITTING` and `FAILED` rows. |
| `outcome` | `UploadOutcome`. Rows whose legacy free-text value did not map were conservatively converted to `FAILED` (`migrations/20260729214943_optimise_names/migration.sql`). |
| `detail` | Failure message, truncated to 4000 chars. |

---

## Canonical chapter history

Four structurally identical tables record what the platform has done on
MangaDex: `uploaded_chapters` (live), `edited_chapters` (edit history),
`unavailable_chapters` (replaced with a card), `deleted_chapters` (hard-deleted).

These used to hold the whole chapter as an opaque JSONB document. The shape is
fixed and known, so the document bought nothing and cost type enforcement,
indexability, and `chapter->>'x'` in every query. They now use **typed columns
plus a narrow `extra` escape hatch**, and the single mapping both directions
lives in one module — which is what stops the four tables from drifting apart
(`src/core/md/chapterRows.ts:4-19`).

Shared columns (all nullable unless noted):

| Column | Meaning |
| --- | --- |
| `md_chapter_id` **unique** | The MangaDex chapter. The natural key of all four tables. |
| `extension` | Which extension produced it. **NOT NULL on `uploaded_chapters` only**, because every lookup of that table filters on it and an unattributed row would be invisible to those queries; `""` is the stand-in (`chapterRows.ts:118-130`). |
| `chapter_id`, `chapter_url` | The publisher-side identity. |
| `chapter_number`, `chapter_title`, `chapter_volume`, `chapter_language` | Chapter metadata as published. |
| `chapter_timestamp`, `chapter_expire`, `chapter_lookup` | `timestamp(3)`, UTC. An unparseable input becomes NULL rather than failing an archive write (`chapterRows.ts:231-240`). |
| `manga_id`, `manga_name`, `manga_url` | Publisher-side series. |
| `md_manga_id`, `md_group_id` | MangaDex series and scanlation group. |
| `extra` | JSONB, NULL when empty. Deliberately narrow: page-artifact ids, the MangaDex attribute snapshot the unavailable flow keeps, and any key a legacy Mongo document carried that has no column (`_id`, `images`, …). Unknown keys are parked here rather than dropped. |

Per-table differences:

| Table | Extra columns | Indexes | Notes |
| --- | --- | --- | --- |
| `uploaded_chapters` | — | `(extension)`, `(extension, chapter_id)` | The live mirror of what is on MangaDex. Rows are **deleted** when a chapter is removed or archived (`core/processor/processor.ts:495`, `taskWorkers.ts:350`, `505`). |
| `edited_chapters` | `edits` JSONB (default `[]`), `last_edited_at` | none beyond the unique key | `edits` **stays JSONB**: an append-only `{editedAt, old, new}` history of genuinely variable length and shape that nothing queries into (`schema.prisma:317-319`). |
| `unavailable_chapters` | `unavailable_at` | none beyond the unique key | `extra` also holds `mdAttributes`, the chapter as MangaDex had it at takedown — an external API resource, not our shape. |
| `deleted_chapters` | `deleted_at` | `(extension)` | Deletion is the one irreversible action the platform takes, so the record of what was removed outlives it (`schema.prisma:353-356`). Written *before* the live row is dropped (`taskWorkers.ts:341-350`). |

### `uploaded_ids` (canonical)

The narrow "have we already seen this publisher chapter id?" table, kept
separate from `uploaded_chapters` because it is what the lease endpoint reads to
build `postedChapterIds` for every non-clean job (`routes/worker.ts:137-145`) —
a hot path that wants one small index, not the whole history table.

| Column | Meaning |
| --- | --- |
| `extension` + `chapter_id` **unique together** | The lookup key. |
| `md_chapter_id` | The MangaDex chapter it first mapped to. |

**Invariant:** insert-only semantics for the mapping. The processor upserts with
an empty `update: {}` so the *first* MangaDex chapter an extension chapter id
mapped to is the one that stays recorded (`core/processor/processor.ts:463-470`). The uploader's
own write does update it (`taskWorkers.ts:530-534`) — that is the path that
learns the real id after a successful commit.

---

## Series tracking

### `tracked_manga` (canonical)

The authority for publisher-id → MangaDex-title-id.

| Column | Meaning |
| --- | --- |
| `extension` + `namespace` + `manga_id` **unique together** | One MangaDex title per publisher series per catalogue. |
| `namespace` | Which of the extension's catalogues `manga_id` belongs to; `""` for the common single-catalogue case. |
| `md_manga_id` | The MangaDex title. |
| `source` | Provenance: `"auto"`, `"bundle-import"` (seeded from a bundle's `manga_id_map.json` at first publish), or `operator:<actor>`. |

Index: `(extension)` serves the lease-time map build.

`namespace` exists because some publishers expose more than one catalogue behind
one API, and the catalogues number their series independently — viz keys its map
by path, so `709` means one series under one path and a different series under
another. Without the namespace those two rows collide on
`(extension, manga_id)`, and whichever was written second wins: chapters get
attached to the wrong MangaDex title. Note the direction that is *not* a problem
and needs no namespace — many publisher ids mapping to one `md_manga_id`, which
is how per-language editions of one series are tracked, and which the unique
constraint already permits.

This table — not any file in the bundle — is what the worker receives as
`mangaIdMap`, which is why a title auto-created after a bundle was published
reaches the extension without republishing it (`routes/worker.ts:119-137`). Bundle
data files only *seed* missing rows and never overwrite existing ones
(`store/bundles.ts:79-84`, `120`).

**Known limitation: a namespaced extension runs unpartitioned.** `jobs.segment_manga_ids`
is a flat list of ids on the wire, so it cannot say which catalogue an id came
from. For an extension with two, `709` is ambiguous — partitioning on it would
either treat two distinct series as one or hand the same id to two workers. The
scheduler therefore detects a non-empty namespace and creates a single
unpartitioned job, logging a warning (`scheduler/service.ts:137-143`). That is
slower for a large namespaced catalogue and it is correct; guessing is neither.
Lifting it means teaching the wire format, the worker and `invertMangaIdMap` to
carry a namespace — `invertMangaIdMap` currently *refuses* a namespaced map
rather than silently inverting it to an empty one, so this is a deliberate
staged gap and not a latent bug (see `extsdk/context.ts` and
`test/unit/mangaIdMap.test.ts`).

### `untracked_manga` (derived)

The queue of series an extension reported that have no mapping yet.

| Column | Meaning |
| --- | --- |
| `extension` + `manga_id` + `manga_language` **unique together** | Dedupe key. `createMany({ skipDuplicates: true })` means a series already queued keeps its existing row, including any state the title service moved it to (`core/processor/processor.ts:405-409`). |
| `manga_name`, `manga_language`, `manga_url` | What the extension reported; used to create the MangaDex title. |
| `state` | See `UntrackedState`. |
| `md_manga_id` | Set when the title is created. |
| `attempts`, `last_error` | Bounded at 3 attempts (`md/titleService.ts:11`); an operator approval resets the budget. |

Index: `(state)` serves the service's `NEW` sweep and the admin filter.

**Invariant:** one MangaDex title per untracked row, even with replicated
uploaders. Enforced by a compare-and-set claim `NEW → CREATING` that checks the
affected count (`titleService.ts:92-96`).

---

## Configuration (the database is the authority)

There are no runtime JSON config files. Bundle data files seed these tables once
at first publish, for migration convenience; afterwards the database owns them
and the admin API edits them (`schema.prisma:435-437`).

| Table | Key | Contents |
| --- | --- | --- |
| `extension_configs` | `extension` (pk) | `override_options` JSONB: `same`, `multi_chapters`, `custom_language`. **Stays JSONB** — it is operator-authored, open-ended, and read whole. The processor takes it from **here, never from worker output**, because override options decide what counts as a duplicate and which languages may stay on MangaDex, so trusting a worker's copy would let a compromised worker steer deletions (`core/processor/processor.ts:338-347`). |
| `schedule_overrides` | `extension` (pk) | `hour`, `minute`, `day?` — UTC. Overrides the manifest's `schedule` (`scheduler/slots.ts:17-37`). |
| `disabled_extensions` | `extension` (pk) | Presence means "do not schedule". |
| `settings` | `key` (pk) | Free-form string settings: `pause_until` (`"inf"` or an epoch), `chapter_removal_mode`, `dash_signups_enabled`, `scheduler_last_tick`, and the MangaDex session tokens `mdauth_access` / `mdauth_refresh` (`md/client.ts:24-25`, replacing the legacy `mdauth.json`). |

---

## Operator access

### `admin_users` (canonical)

| Column | Meaning |
| --- | --- |
| `email` **unique** | Normalized to trimmed lowercase on every read and write (`store/adminUsers.ts:80`, `103`). |
| `display_name` | Optional; used as the audit actor when present. |
| `role` | `OWNER` or `ADMIN`. |
| `approved` | Self-signups land unapproved (`adminUsers.ts:176-186`); an owner approves. An unapproved account cannot log in even with a correct password (`session.ts:218-221`) and its sessions do not resolve (`adminUsers.ts:227`). |
| `password_hash` | scrypt `salt:hash`, both hex, N=16384/r=8/p=1, 64-byte key (`adminUsers.ts:22-32`). Null when the account is MangaDex-only. Compared in constant time. |
| `mangadex_id` **unique** | The bound MangaDex account UUID, and *the* identity: a username change on MangaDex's side must not repoint the login (`api/mangadexLogin.ts`). |
| `mangadex_username` **unique** | The username an OWNER invited, used only to find the row before its UUID is known. A row already bound to a different `mangadex_id` refuses to rebind, so a username changing hands on MangaDex cannot carry the account. |
| `md_client_id`, `md_client_secret` | That operator's own MangaDex personal API client. MangaDex ships no `authorization_code` flow and a personal client only works for its creator, so each operator brings one. The secret is AES-256-GCM sealed (`api/secretBox.ts`), never stored in the clear, and never returned by any endpoint. |
| `last_login_at` | Set on session creation. |

**Invariant:** at least one `OWNER` always survives. Both demotion and deletion
check the remaining owner count and refuse (`adminUsers.ts:137-158`), because
otherwise the only way back in is the break-glass token.

### `admin_sessions` (transient)

| Column | Meaning |
| --- | --- |
| `user_id` | FK, `onDelete: Cascade` — deleting an account is also a logout. |
| `token_hash` **unique** | sha256 of the cookie's secret half. The cookie is `${sessionId}.${secret}`: the id is a lookup key and the secret is what is verified, so a session id appearing in a log or an admin list view is not a credential (`adminUsers.ts:190-210`). |
| `actor` | The display name recorded at login; what audit events name. |
| `expires_at`, `revoked` | The row — not the cookie's contents — is the authority, which is what makes one session revocable without signing everyone else out. |

Indexes: `(user_id)`, `(expires_at)`.

### `api_tokens` (canonical)

Scoped per-client credentials (`pa_…`).

| Column | Meaning |
| --- | --- |
| `token_hash` **unique** | sha256. The plaintext is shown once at mint and there is no endpoint that can reveal it again, which is why rotation is "mint new, revoke old" (`store/apiTokens.ts:9-13`). |
| `scopes` | text[]. Validated against the enum at mint time; an unknown string is a 422 (`apiTokens.ts:40-42`). |
| `created_by` | The minting principal. |
| `expires_at`, `revoked` | Both checked on every authentication; the caller cannot distinguish unknown from revoked from expired (`apiTokens.ts:60-71`). |
| `last_used_at` | Operator telemetry ("is this still in use before I revoke it?"), written fire-and-forget and throttled to one write per token per minute. Never an authorization input (`apiTokens.ts:73-89`). |

### `audit_events` (canonical)

| Column | Meaning |
| --- | --- |
| `actor` | Kind-prefixed so an actor string always says what sort of thing acted: `root`, `token:<name>`, `token:<name> for discord:<user>`, `user:<actor>`, `worker:<id>`, `ip:<addr>`, `scheduler`, `title-service`. |
| `action` | Dotted verb, e.g. `run.trigger`, `bundle.publish`, `api_token.mint`, `envelope.quarantine`. |
| `subject` | The affected id. |
| `detail` | JSONB. **Stays JSONB:** the payload shape differs per action by definition. |

Indexes: `(created_at)` serves the reverse-chronological feed; `(action)` serves
filtering by verb.

---

## Why JSONB where it is used

Five columns are JSONB and each has a specific reason, all of them recorded in
the schema next to the column. The pattern: **JSONB is for documents whose shape
is genuinely not ours to fix.**

| Column | Reason |
| --- | --- |
| `result_submissions.envelope` | Immutable evidence of what a worker sent, across schema versions. |
| `bundles.manifest` | An external document with a `.passthrough()` schema extensions may extend. |
| `upload_tasks.chapter` | A transient union-shaped queue payload consumed once, never queried by field. |
| `edited_chapters.edits` | An append-only history of variable length and shape. |
| `extension_configs.override_options` / `audit_events.detail` / `*.extra` | Operator-authored or open-ended residue, read whole. |

Everything else that *was* JSONB has been promoted. `workers.capabilities`
became a typed `extensions` array, `api_tokens.scopes` and
`jobs.segment_manga_ids` became `text[]`, and the four chapter tables became
typed columns — all by data-preserving migrations, not drop-and-add
(`migrations/20260729214943_optimise_names/migration.sql`,
`migrations/20260729225058_normalise_chapter_storage/migration.sql`).

---

## Migrations

Seven migrations, applied by `prisma migrate deploy` in the one-shot `migrate`
container (`docker/core/docker-compose.yml`). Two of them are hand-written
because Prisma's generated version would have destroyed data:

| Migration | What it does |
| --- | --- |
| `20260729180953_init` | The initial schema. |
| `20260729181006_result_commit_marker` | The partial unique index Prisma cannot express. |
| `20260729192013_admin_users` | Dashboard accounts and sessions. |
| `20260729203545_api_tokens` | Scoped client tokens. |
| `20260729214943_optimise_names` | **Hand-written.** Renames blob columns, converts jsonb arrays to `text[]` via add/UPDATE/swap (Postgres rejects subqueries in an `ALTER … USING` transform), lifts `workers.capabilities` to a column, renames `upload_log` → `upload_logs` and converts its free-text outcome to an enum. `migrate dev` had generated drop-and-add for all of it. |
| `20260729222814_deleted_chapters` | The hard-delete archive. |
| `20260729225058_normalise_chapter_storage` | **Hand-written.** Promotes the chapter document to typed columns on all four tables: add columns, copy the document into them, park the residue in `extra`, and only then `DROP COLUMN "chapter"`. `migrate dev` had generated `DROP COLUMN` + `ADD COLUMN`, which would have discarded every chapter snapshot the platform holds. Includes an exception-safe ISO-8601 → `timestamp(3)` converter so an unparseable legacy date survives verbatim in `extra` rather than becoming NULL. |

The lesson, which [CONTRIBUTING.md](../CONTRIBUTING.md#migrations) makes a rule:
generate the migration with `--create-only` and then write the SQL yourself.

---

## See also

| Document | For |
| --- | --- |
| [architecture-guide.md](architecture-guide.md) | how the invariants above combine into exactly-once |
| [api-reference.md](api-reference.md) | the endpoints that read and write these tables |
| [glossary.md](glossary.md) | one-paragraph definitions of the nouns |
| [migration-guide.md](migration-guide.md) | the Mongo/SQLite → Postgres cutover |
| [operations.md](operations.md#backup-and-restore) | backup and restore |
