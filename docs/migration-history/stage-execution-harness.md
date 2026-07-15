# Project Kernel — Pass 4: Stage Execution (the implementation harness)

**One reusable prompt for all stages.** Planning is finished (Passes 1–3
produced `pass3/roadmap.md` + `pass3/stages/stage-NN-*.md`). This prompt
turns one already-written stage spec into shipped, verified code. Open a
**fresh session** in the repo the stage names (core, or a client repo),
state the stage number, and run.

    STAGE = NN            ← set this at the top of the session
    REPO  = <the repo the spec's header names>

Run **one stage per session** unless two are trivially chained and share a
repo (e.g. a checklist stage). Stages run on **Fable** (Opus is off the
table for this initiative — see Model & safeguard). Follow the roadmap's
recommended order (§4); a stage may start only when every dependency in §5
has *exited* (prod-verified, logged in `execution-log.md`), never merely
"merged".

---

## Read, in order

1. `docs/migration-history/stages/stage-NN-<slug>.md` — **your spec.**
   Its eight sections are the whole job. It is binding. If it contradicts
   the code as it stands today, **stop and ask in chat** — do not silently
   re-plan (the specs were written 2026-07-04; code drifts).
2. `docs/migration-history/roadmap.md` — read **§3 (binding
   invariants)**, **§5 (dependency graph — confirm your deps exited)**, and
   your stage's passport in §4. §3.5/§3.7 (contracts retire only after the
   last consumer migrates; kernel before clients) and §3.8 (every stage
   ends *deployed*) are law.
3. `docs/decisions.md` — the **append-only family log**. Read its tail:
   later entries supersede earlier ones and record what execution already
   changed (e.g. #62 = Stage 6 probe verdict). Your deviations and results
   append here.
4. `docs/migration-history/target-architecture.md` **§14** — only
   if your spec's §4 touches a compatibility invariant. Those invariants
   are binding; do not break a live client.

Do **not** re-read the whole Pass 2/3 corpus — the spec already distilled
it. Over-reading is what stalled earlier sessions.

---

## Pre-flight (before writing any code)

- **Dependencies exited?** Check `execution-log.md` + `decisions.md`: every
  §5 predecessor of this stage must be prod-verified. If not, stop.
- **Re-verify the spec's assumptions (§7) against the code and, where the
  spec says so, against production.** Paths, flag names, table shapes, row
  counts drift. Use targeted background agents (Explore) for path/shape
  checks; keep the writing in this session. A failed assumption is a
  **drift signal → stop and ask**, not a thing to code around.
- **Prod access is owner-gated** (see below). If a §5/§7 check needs SSH or
  prod-Postgres, ask for the specific target first.

## Execution rules

- **Build exactly §2. No scope broadening** — do not add endpoints,
  columns, or surface the spec doesn't call for (API surface stays minimal;
  a genuinely-needed addition is a chat proposal, not a silent commit).
- **Migrations** live in `packages/db/migrations/`, next number **0052**,
  forward-only, append-only. Run locally with `pnpm db:migrate`; the DB
  layer needs **Docker Desktop up** (Testcontainers).
- **Tests (§5) are part of the stage, not optional.** Write them, then:
  `pnpm typecheck` → `pnpm test` (full suite needs Docker; `pnpm test:unit`
  for the fast loop; `pnpm test:sync-critical` for the sync/DB/API gate).
  Test gotchas (hard-won): **no `drizzle-orm` imports in test files**;
  worker-startup mocks use closed factories; SSE tests need a real
  listen+fetch. There is **no linter** in core until Stage 19 — until then,
  ratchets are counter-scripts, not ESLint.
- **New dashboard page/endpoint?** Run `pnpm contracts:generate`, add
  breadcrumbs, add an integration test (the new-surface checklist).
- **Money** stays mills (bigint, $0.001) + micro-USD (AI cost) with the
  named constructors (Proposal 1). Do not invent a new unit; do not migrate
  data for it (that is Stage 27's bounded job).
- **§4 compatibility:** every named live client (desktop, extension,
  dashboard) keeps working *during and after* the stage. Kernel change
  lands first, old + new served in parallel, client migrates on its own
  cadence, old path removed in its named later stage — never a big-bang.
- **§7 assumptions** become drift-detectors: state in the code/PR where each
  load-bearing assumption is relied on, so a later session sees a break.

## Definition of done

The session is done when the spec's eight sections are satisfied:

| § | Done means |
|---|---|
| 1 Context | entry facts re-verified true (not assumed) |
| 2 Changes | built exactly, nothing extra |
| 3 Schema | migration written, numbered, **run locally green** |
| 4 Client compat | every live client still works; invariants held |
| 5 Tests | written **and** `pnpm test` green locally (Docker up) |
| 6 Rollback | the documented revert path actually exists |
| 7 Assumptions | re-verified; any drift escalated, not coded around |
| 8 Task breakdown | every checklist item done or explicitly deferred |

**"Green locally" is the session's gate. "Prod-verified" is the stage's
exit criterion (§3.8) — and it needs an owner-run deploy + the spec's named
production check.** So a session ends by *preparing* the deploy, not doing
it: list the migration to run on prod, the deploy command, and the exact
§5 production check the owner (or a follow-up ops session) runs to close
the stage. Only then flip the stage to `exited` in `execution-log.md`.

## Commits (pre-authorized, checkpoint per task)

All of a stage's work lands on **one stage branch** — that branch is the
revert unit the §6 rollback stories ("revert by git") depend on. But
**commit at the granularity of a §8 task, not the whole stage**: the specs
already cut §8 into `≤1 session` tasks, and checkpointing each one means a
session that dies mid-stage (a crash, a safeguard stop, a context cutoff)
loses at most the *current* task, never a day of work. The session commits
**its own work** without re-asking, under strict rules:

- **Start from a clean tree.** If it's dirty with unrelated work, stop and
  surface it — do not build on top. (`execution-log.md` "Dirty working
  tree" note names any known uncommitted groups to resolve first.)
- **Stage only the files this task touched. Never `git add -A`** — that
  sweeps unrelated changes into the wrong commit. Add by explicit path.
- **One branch per stage**, off `main`:
  `git switch -c kernel/stage-NN-<slug>` if you're on `main`.
- **One checkpoint commit per completed §8 task** on that branch, message
  `Stage NN.<task>: <what shipped>`, with the session's Co-Authored-By
  trailer. A tight logical pair of tasks may share a commit; a big task may
  not be left uncommitted "until the rest is done".
- **Commit a task only when it is green** — `pnpm typecheck` + the task's
  own tests pass locally (Docker up). Checkpoints are how you avoid losing
  work; an un-green checkpoint defeats the point, so a red task stays
  uncommitted and is the thing you fix or hand off.
- The **stage** flips to `green-local` only when *every* §8 task is
  committed **and** the full `pnpm test` suite is green — not at the first
  checkpoint. (Squashing the checkpoints into one `Stage NN:` commit before
  hand-off is allowed but optional — the branch reverts either way.)
- **Never push, never merge to `main`, never deploy** — all owner-gated
  (below).

## Checkpointing & handoff (so a killed session costs a task, not a day)

Multi-session stages exist (18, 19 are 4–6 sessions) and any session can
end early. The expensive part of a restart is **re-orientation**, not
re-typing — so leave the next session a map:

- **Keep a `## Progress` block at the bottom of the stage spec file**
  (`stage-NN-*.md`), updated at the end of every task and **always** before
  stopping for any reason (including a safeguard stop). It holds: §8
  checklist with done/open marks, the last checkpoint commit hash, key
  findings or drift noticed, the exact next step, and files touched. This
  is a working scratchpad — it is exempt from the append-only rule that
  governs the spec's eight sections; do not touch those sections.
- A resuming session reads **the spec + its `## Progress` block** and
  starts from the next step — it does **not** re-derive the roadmap or
  re-read the Pass 2/3 corpus.
- For a stage still mid-flight, set its `execution-log.md` row to
  `in-progress` with a note pointing at the `## Progress` block, so the
  board shows where it actually stands.

## Owner-gated actions — stop and ask before any of these

Never do these unprompted; each needs explicit per-target owner go:

- **`git push` / merge to `main`** — never unprompted; the owner pushes and
  merges. Per-stage *local* commits are pre-authorized (see Commits above).
- **SSH to the prod host** (`root@45.8.230.111`) and **direct psql to the
  prod DB** — auto-mode blocks each as a **separate** capability; name the
  target and wait for go.
- **Deploy** — `scripts/deploy-production.sh --mode dist-only
  root@45.8.230.111` (prod is Docker: `agency-hub-{api,worker,postgres}-1`,
  image `agency_hub_core/runtime:production`, env `/opt/agency-hub/.env.production`).
- **Commercial/irreversible acts** — e.g. cancelling the OnlyMonster
  subscription (Stage 15) is the owner's action, not the session's.

## Model & safeguard (Fable)

Most stages are pure kernel plumbing (journal, events, SDK, workboard
module, dashboard) and run clean. A few brush the platform adapters
(Stages 6/16/17/18 touch `packages/fansly` / `packages/onlyfans`). There,
the **kernel storage contract is unchanged and referenced as-is**
(AES-256-GCM envelope, versioned key ring, never logged) — do **not**
re-implement or deep-read session-credential / anti-bot-token internals;
touch only the public adapter surface the spec names. If the Fable
safeguard flags an adapter read, the legitimate move is to **narrow scope**
(work interface-and-intent, keep custody mechanics as they are), never to
bypass or reverse the classifier. If a stage genuinely cannot be built
without the forbidden detail, stop and ask the owner.

- **Isolate the sensitive part so a safeguard stop is cheap.** On the
  adapter-touching stages, sequence the §8 tasks so the custody-adjacent
  work is its own small task (≤ half a session), and do the clean plumbing
  (schema, projections, canonicalizers, tests — none of which open adapter
  internals) *first* and checkpoint it. Then a safeguard stop lands inside
  a small, already-isolated task with everything else committed — you
  narrow scope and continue, or hand off via the `## Progress` block, having
  lost nothing. A safeguard flag interrupts one read; it only becomes
  expensive when it catches a pile of uncommitted mixed work.

## Recording

- **`docs/decisions.md`** — append a numbered entry per stage: what
  shipped, any deviation from the spec (with why), verification results,
  new risks carried forward. Append-only; never edit prior entries or the
  spec's **eight sections** (the `## Progress` scratchpad at the bottom of
  the stage file is the one allowed exception — see Checkpointing).
- **`docs/migration-history/execution-log.md`** — update this stage's
  row: `not-started → in-progress → green-local → exited (prod-verified
  <date>, <commit>)`. This is the live progress board; keep it current so
  the next session reads dependency state at a glance.

## Finish (chat summary)

End with: what shipped this session; any spec deviation (also in
decisions.md); the exact owner-run steps to reach the stage's prod exit
criterion (migration + deploy + the named §5 check); and whether the next
stage's dependencies are now satisfied.

---

### First invocation

**Stage 1 (kernel retention & redaction stand-down)** is first and
**burning** — the webhook journal prunes at retention 7 and the oldest slice
is exactly −7d, so a capture slice is lost every day it waits. Before it,
resolve the dirty working tree (the Stage 6 probe code + the OFAPI-credits
dashboard changes are two unrelated uncommitted groups) so Stage 1 starts
from a clean tree.
