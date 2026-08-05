# Contributing

This document is about *how* to land a change. For how the system works, read
[docs/architecture-guide.md](docs/architecture-guide.md); for how to run it
locally, [docs/development.md](docs/development.md).

---

## The repositories

Three, and which one you want depends on what you are changing.

| Repository | Contains | Change it when |
| --- | --- | --- |
| **publoader** (this one) | The platform: control plane, worker agent, extension runtime, dashboard, CLI, Discord bot, schema, docs | You are changing the system |
| **publoader-extensions** | Public extensions (`src/mangaplus/`, …), one directory per publisher | You are adding or fixing a scraper for a public source |
| **publoader-extensions-private** | Extensions that cannot be public | Same, for a non-public source |

The extension repositories depend on this one only through the
[v2 contract](docs/extension-guide.md#the-v2-contract) and the published bundle
format. They are not submodules and are not built by this repo's CI; bundles are
published into a running platform with `publoader-admin bundle publish`.

The legacy Python monolith that used to sit alongside this code has been
removed; it survives in git history and is described in the migration guide, kept for
reference during the migration. Do not add to it.

---

## Branching and worktrees

Never commit to `master`.

```bash
git switch -c descriptive-branch-name
```

For work that runs alongside other work — which is most work here, since several
changes are usually in flight — use a **git worktree** so each branch has its own
checkout and its own `node_modules`:

```bash
git worktree add .claude/worktrees/my-change -b my-change
cd .claude/worktrees/my-change/platform
pnpm install && pnpm exec prisma generate
```

Two things to know about worktrees in this repo. The **git stash stack is shared**
across all of them, so `git stash` / `git stash pop` can pop somebody else's work —
use a temporary WIP commit instead, or `git stash push -u -m "<unique-tag>"` and
`git stash apply <sha>`. And the dev Docker stack uses a fixed project name
(`publoader-dev`) and fixed loopback ports, so only one worktree can run it at a
time.

Merge to `master` through a pull request, never directly.

---

## Commits

Imperative subject line, and a body that explains **why**. The existing history is
the standard — read `git log` before your first commit. A representative subject:

```
Harden ingest validation, dead-letter replay, and deployment surfaces
```

and a representative body opening:

> Security review found ingest validated three envelope fields while the
> processor consumed a dozen. A worker holding one legitimate lease could name
> any MangaDex title in mdMangaId, send allChapters: [], and have the processor
> conclude the group's chapters had vanished upstream and queue them for
> deletion. Ingest now validates every field the pipeline trusts: …

What that example does, and what yours should do:

- **Names the problem before the fix.** A reader six months from now needs to know
  what was wrong, not just what changed.
- **Says what an attacker or a failure could actually do.** Concretely, with the
  mechanism.
- **Explains reversals.** If you changed a previous decision, say what the old
  reasoning was and why it was wrong. That is how the next person avoids
  reinstating it.
- **States the verification.** "334 tests green", "e2e pipeline + failover verified
  on the rebuilt images".

Wrap the body at 72–76 columns. If a change touches several areas, a short
`Also:` paragraph is fine — one commit per logical change is the goal, not one
commit per file.

Assistant-authored commits carry the trailer already used throughout the history:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## The definition of done

A change is not done until all of these are true.

**1. `tsc` is clean.**

```bash
pnpm run typecheck
```

Zero errors. Note that `prisma generate` must have run — `src/` imports the
generated types.

**2. `eslint` is clean.**

```bash
pnpm run lint
```

**3. Unit and integration tests are green.**

```bash
pnpm test && pnpm run test:integration
```

Integration tests **skip themselves** when no database is reachable
(`test/globalSetup.ts:44-49`). A green run with everything skipped is not a green
run — check the output.

**4. New behaviour has a test.**

Not "the change is covered somewhere". A test that fails before your change and
passes after. Which layer:

| The change is | Test it in |
| --- | --- |
| a decision, a transformation, a pure function | `test/unit/` — no database, no network |
| a state transition, a constraint, a race, a scope boundary | `test/integration/` — real Postgres, because `SKIP LOCKED` and partial unique indexes *are* the thing being tested |
| a cross-process behaviour (leasing, failover, the full pipeline) | `test/e2e/run-e2e.sh` |

If you are adding an endpoint, the test a reviewer will look for is the one
asserting it is **confined to the scope it declares** — see
`test/integration/ops.test.ts:347`.

**5. Docs are updated.**

Which doc, by what you changed:

| Changed | Update |
| --- | --- |
| an endpoint, a scope, a status code, a metric | [docs/api-reference.md](docs/api-reference.md) |
| the schema, an index, an invariant | [docs/data-model.md](docs/data-model.md) |
| a lifecycle, a guarantee, a state transition | [docs/architecture-guide.md](docs/architecture-guide.md) |
| the extension contract or manifest schema | [docs/extension-guide.md](docs/extension-guide.md) |
| a workflow, a command, a convention | [docs/development.md](docs/development.md) |
| a term worth defining | [docs/glossary.md](docs/glossary.md) |
| an operational procedure | [docs/operations.md](docs/operations.md) |
| deployment, compose, images, ingress | [docs/deployment.md](docs/deployment.md) |

The docs carry `file:line` references. Those go stale as code moves, and a doc
that lies is worse than no doc — if you move code a doc cites, fix the citation.

**6. Migrations are hand-verified against a populated database.**

Covered below, because it is the item most likely to cause an unrecoverable
mistake.

---

## Migrations

**`prisma migrate dev` must not write the SQL you ship for any change that touches
an existing column.** It generates drop-and-add. In this repo it has twice
generated SQL that would have discarded every chapter snapshot the platform holds
— 8.5k uploaded, 25k deleted, 429 unavailable rows at the time. Both were caught
in review, and both are now hand-written
(`prisma/migrations/20260729214943_optimise_names/`,
`20260729225058_normalise_chapter_storage/`).

The required workflow:

```bash
pnpm exec prisma migrate dev --create-only --name describe_the_change
```

Then read what it generated. **If it contains `DROP COLUMN`, `DROP TABLE`, a type
change, or a rename it turned into drop-and-add, replace it** with SQL that carries
the data across:

- renames → `ALTER TABLE … RENAME COLUMN`
- type changes → add a new column, `UPDATE` from the old, drop, rename. Postgres
  rejects a subquery inside an `ALTER … USING` transform, which is why the array
  conversions are shaped this way
- promotions (document → columns) → add the columns, copy the data, park whatever
  has no column in an `extra` document, and only *then* drop the source

Then:

```bash
pnpm exec prisma migrate deploy
pnpm exec prisma generate
```

**Verify against data, not against an empty database.** Seed rows first, apply the
migration, and assert the rows survived and are still correct. Ideally against a
restored production backup. An empty database proves only that the SQL parses.

Write the migration to be **replayable** — it may run before or after the Mongo
import (see [docs/migration-guide.md](docs/migration-guide.md)) and against tables
that are empty. And comment it: the two hand-written migrations explain what
`migrate dev` had generated and why it was rejected, which is the note that stops
somebody regenerating it.

---

## Pull requests

Open it as a **draft** first:

```bash
gh pr create --draft
```

The description should carry the same content as the commit body — the problem, the
mechanism, the fix, and the verification. If the commit message is good, the PR
description is mostly a copy of it.

Include:

- **What breaks if this is wrong.** Reviewers prioritise by blast radius.
- **The verification you ran**, verbatim. Not "tested" — the commands and their
  results.
- **Anything you could not verify**, explicitly. An honest gap is reviewable; a
  silent one is a trap.
- **Migrations**, called out separately, with how you verified them against data.

Never push to `master`, never force-push a shared branch, never merge your own PR
without review.

---

## Review checklist

The four questions a reviewer asks first, because these are the failures that are
expensive and quiet.

### Does it preserve exactly-once?

The guarantee rests on six layers
([architecture-guide.md](docs/architecture-guide.md#why-exactly-once-holds)), four
of which are database constraints. So:

- Is any new state transition **one guarded statement whose `WHERE` names the
  expected prior state**, checking the affected count? A `read → decide → write`
  sequence is a bug however obvious it looks.
- Does any transition a **worker** can drive also name the **lease id**? Without
  it, a worker whose lease expired can still write.
- Does anything new that enqueues work have a **dedupe key with a unique
  constraint**? The processor is designed to be re-runnable; that is only safe if
  re-enqueueing is a no-op.
- Does anything that mutates MangaDex have a **write-ahead marker** so a crash
  mid-operation is distinguishable from "never started"? See `upload_logs`.
- Did a migration **drop an index the guarantee depends on** — in particular
  `result_committed_one_per_job`?

### Does every new route declare a scope?

- `requireScope("<area>:<verb>")` in the `preHandler`, on **every** admin route.
  A route without one inherits nothing and is reachable by any authenticated admin
  principal.
- Is the scope the *narrowest* one that fits? A new area needs a new scope
  ([development.md](docs/development.md#add-a-scope)); do not reach for
  `settings:write` because it happens to be handy.
- Is there an integration test asserting the confinement?
- Does the route **audit** its mutation, with `actor(req)`?
- If it can be reached by a cookie, do writes require the CSRF header? (The shared
  `adminAuthHook` handles this — do not bypass it.)

### Does any new migration lose data?

- Any `DROP COLUMN`, `DROP TABLE`, or `ALTER COLUMN … TYPE` in the diff is a stop
  sign. Was the data copied first?
- Was it verified against a populated database, and does the PR say so?
- Is it replayable, and safe to run twice?
- Does a renamed or retyped column still have every reader and writer updated? A
  spread into a Prisma `create`/`update` **defeats excess-property checking**, so
  `tsc` will not always catch a stale field name — grep for the old name.

### Does any new secret leak into logs or a client?

- Is a token, password, or session secret **hashed at rest** and compared in
  constant time?
- Is any plaintext credential returned by more than the one endpoint that mints
  it? There must be no path that reveals an existing secret.
- Does any log line, error message, or audit `detail` include a credential? Note
  the specific hazards already handled: a MangaDex token-grant failure body can
  echo the operator's password, so the error is reshaped before it is logged and
  the raw one never is (`src/core/api/mangadexLogin.ts`); the MangaDex auth endpoint reports
  only *whether* tokens exist and when they expire, never their values
  (`routes/ops.ts:219-247`).
- Does an error response leak internals? The handler collapses every 5xx to
  `"internal error"` — do not route around it.
- Does anything new give a **worker** something it should not have? A worker holds
  a token and a bundle. Not a database URL, not a MangaDex credential, not a
  webhook. The runner is spawned with a minimal environment for this reason.
- Does the dashboard use `innerHTML` anywhere? It must not — the CSP has no
  `unsafe-inline` and there is no `innerHTML` in `app.js` today.

### Also worth a look

- **Error class.** Is a new failure classified deliberately? "Would running this
  again against the same pinned bundle produce the same result?" If yes, it is not
  `TRANSIENT`. And remember `POLICY` comes from a *worker*, so treating it as
  permanent lets one bad worker dead-letter everything it leases.
- **Fail closed.** A new gate with nothing configured should deny, not allow. The
  bot's authz is the reference: an unconfigured admin allowlist denies every
  mutating command and names the variable to set.
- **The guarded fetch exists twice.** `src/extsdk/guardedFetch.ts` and an
  inline copy in `runner-node/runner.mjs`, because the runner executes
  under a read allowlist that cannot see `dist/`. Change one, change the other.
- **Comments explain why.** A comment restating the next line will be asked about.
- **Metrics that measure liveness** must not be written by the process being
  measured — see the note at `src/metrics.ts:19-33`.

---

## The verification sweep

Before marking a PR ready:

```bash

pnpm exec prisma generate       # if the schema changed
pnpm run typecheck              # zero errors
pnpm run lint                   # zero warnings
pnpm test                       # unit
./test/browser/run.sh           # dashboard, in real Chrome (needs Chrome + a Postgres)
pnpm run test:integration       # needs a real Postgres — check for skips
```

And for anything touching leasing, ingestion, the processor, or the uploader, the
full pipeline:

```bash
./scripts/publoader dev up -d --build
./test/e2e/run-e2e.sh
./scripts/publoader dev down -v
```

That last one includes the failover case — kill the worker holding the lease
mid-job and assert the other one finishes the run. It is the only test that proves
lease expiry and reassignment work end to end, and it takes about two minutes.

---

## Where to ask

- **How does X work?** [docs/architecture-guide.md](docs/architecture-guide.md),
  then the code. The comments in `src/core/store/jobs.ts`,
  `core/api/scopes.ts`, and `core/ingest/ingest.ts` carry the reasoning behind the
  parts that look surprising.
- **Why is X like this?** [docs/architecture-guide.md](docs/architecture-guide.md)
  for the design decisions,
- **Is this a security-relevant change?**
  [docs/security-trust-model.md](docs/security-trust-model.md) has the control
  matrix and the worker-fabrication analysis. If your change touches the worker
  boundary, ingest validation, or credentials, read it first.
- **Something is broken in a deployment.**
  [docs/operations.md](docs/operations.md) — runbooks, triage, and the incident
  checklist.
- **Anything else** — open an issue, or ask in the operators' Discord channel. A
  question that turns out to be a documentation gap is worth a PR to the docs.

---

## Documentation map

| Document | Read it when |
| --- | --- |
| [docs/architecture-guide.md](docs/architecture-guide.md) | You need to understand how the system works |
| [docs/development.md](docs/development.md) | You are setting up, running, testing, or debugging locally |
| [docs/api-reference.md](docs/api-reference.md) | You are calling or adding an endpoint |
| [docs/data-model.md](docs/data-model.md) | You are touching the schema or a query |
| [docs/extension-guide.md](docs/extension-guide.md) | You are writing or porting an extension |
| [docs/glossary.md](docs/glossary.md) | A term is unfamiliar |
| [docs/security-trust-model.md](docs/security-trust-model.md) | Your change touches trust, credentials, or the worker boundary |
| [docs/deployment.md](docs/deployment.md) | You are standing up staging or production |
| [docs/operations.md](docs/operations.md) | Something is wrong in a running deployment |
| [docs/migration-guide.md](docs/migration-guide.md) | You are moving data off the legacy stack |
| [docs/ipc-to-api-mapping.md](docs/ipc-to-api-mapping.md) | You are looking for the endpoint that replaced a legacy IPC command |
| [docs/bot.md](docs/bot.md) | You are setting up or extending the Discord bot |
| [docs/webhooks.md](docs/webhooks.md) | Publishing extension bundles from a GitHub push |
