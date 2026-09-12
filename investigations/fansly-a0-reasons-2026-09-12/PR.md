# fix(sync): retain bounded A0 discrepancy reasons

A0 could record a state change below its virtual stop while retaining no
specific count for six possible causes. This patch preserves those pre-apply
reason categories in six bounded scalar counters. It leaves the full sweep,
existing discrepancy predicates and provider requests unchanged.

Only measurement from the start of a runtime sweep initializes the new counts
to zero. Legacy cursors and diagnostics started mid-sweep keep unknown counts
as null. Completed observation does not mean complete reason coverage. The
offline analyzer also leaves its three unavailable runtime-only categories
null; tier/time/sender there remain raw-to-raw metadata comparisons. Old reports
are not rewritten, and historical generic observations remain unexplained.

Decision 313 and the A0 runbook describe interpretation and downgrade behavior.
Existing JSON persistence/read functions carry the new fields; no migration,
runtime flag, API route or credential change is needed. The original A0 branch
is synchronized with main `c76c6db0` without changing that base tree.

Validation on tree `0763c732ea49d22c3f4e4c78776b4f431be61388`:

- `pnpm check`: **3,261 passed, nine existing skips, 296 unit files**.
  Strictness stays at 1,901 known errors in 121 files; lint and build pass.
- Serial Docker-Postgres: **34 passed, zero skips, four files, 10.56 s**.
  Command: `pnpm exec vitest run --no-file-parallelism` with suites
  `fansly-dm-shadow`, `fansly-dm-conversations-sweep`,
  `fansly-events-measurement` and `erasure-page-owned-tables`
  (all `.integration.test.ts`).
- Real handler/write/read fixtures prove that six pre-apply reasons remain
  visible after the stored row is updated. Legacy and late-start cases preserve
  null without changing business completion or the provider call count.
  Unit/corpus checks preserve unread deduplication and unavailable categories.
- Independent correctness and quality reviewers closed both P2 findings and
  found no remaining actionable issues. Three changed implementation/tool
  modules have 114, 130 and 165 lines. Applied migrations are unchanged.

No production deployment or new A0 measurement was performed for this patch.
It does not clear historical gaps, prove a safe A1 stop, measure physical savings
or establish fresh-event latency. A release must preserve current production
ancestry; this main-based branch is not a standalone replacement for it.

Publication gate: PR164 already merged. An additional A0 PR requires an explicit
exception to the owner's one-stage/one-PR instruction. This draft is prepared
locally until that exception is granted.
