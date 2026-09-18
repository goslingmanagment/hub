Fansly follower reconciliation could not explain which anomaly predicate fired,
whether work was already queued, or what a completed walk changed. This C1
draft records the unchanged trigger decisions, atomic queue context and a
bounded run timeline. Membership receipts distinguish protection, retirement
candidates and the actual guarded UPDATE result; missing or malformed evidence
stays unknown. Decision 294 and the runbook document the restricted readers,
including forward migration 0185. No predicate, cadence, presence policy,
provider call or runtime flag changes.

Validation after integration with main `c76c6db0`:

- `pnpm check`: **3,258 passed, nine existing skips, 296 unit files**;
  strictness remains 1,901 known errors in 121 files within budget. Lint and
  dashboard build passed. The initial attempt found 14 lint violations in two
  untracked local health probes; those diagnostics were temporarily moved out
  for the candidate check and restored with every file hash unchanged.
- Serial real Docker-Postgres: **86 passed, zero skips, seven suites, 29.13 s**.
  Command: `pnpm exec vitest run --no-file-parallelism` with integration suites
  `followers-membership`, `followers-timeline`, `followers-diagnostics`,
  `generation-high-water`, `page-sync-lease-fencing`, `sync` and `fan-churn`.
  These exercise guarded UPDATE receipts, protection/grace, restricted readers,
  queue/lease fencing and sync persistence. A DB trigger proves that two
  candidates can result in one actual update.
- Tested tree `af6102b5`; subsequent changes are documentation, diagnostic SQL
  and retained evidence. All 181 production and 180 main migration files are
  unchanged. The handler, fan repository and 0185 match deployed `31b73a96`.
- Independent correctness and code-quality reviews closed implementation
  findings; the exact merge tree has a separate correctness review. The latest
  presence and natural-completion follow-up has independent evidence review.
- CI [34711707746](https://github.com/goslingmanagment/core/actions/runs/34711707746)
  passed all five checks on `46adf234`. The current follow-up changes only
  documentation and evidence; no local application suite was rerun.

Production evidence retains its measurement cutoffs:

The cumulative window, **11 September 01:05:57.089215 through 12 September
18:37:41.859814 UTC**, contains 1,396 unique ordered runs across three READ ONLY
snapshots with a pinned upper ID. It is not one frozen snapshot. Of 250 valid
incremental decisions, 201 request no work, 46 are count-mismatch only and three
also exhaust without a known checkpoint. All 49 requested decisions have a
clean prior queue and one exact-generation terminal; the unchanged-head branch
is unobserved. Partial, failed and missing-writer evidence remains explicit.

Lilly-2 request 2541 restarts after captured pagination overlap in generation
791, then completes generation 792 with **two actual retirements**. Its next
two incremental comparisons match at 18,322/18,322 and request no work. Lora-3
protects one absent row under generation grace and retires none; its next
comparison is outside this report. These are not immediate active-after reads
or proof that every requested walk was necessary or redundant.

Follower cost is **5,969 physical attempts**: 613 incremental, 5,000 anomaly
reconciliation and 356 scheduled reconciliation. There are 25 retry ordinals,
zero terminal-failed attempts and zero HTTP 429s; 389 attempts lack payload size.
These totals are not a savings measurement.

At **20:00 UTC on 12 September**, all three runtime roles were healthy on
`31b73a96` with zero restarts. A short `read_only` READ ONLY catalog check
confirmed no direct SELECT on presence/membership tables. The served Agent
catalog and fifteen matching source files establish a measurement limit:
timeline activity time omits local observation age required by Workboard,
and membership `lastSeenAt` is a different field. The human-authenticated
Followers API exposes both timestamps but does not admit agent keys. No
presence rows, provider requests or production mutations were made by this
read-surface investigation. Decision 224/A20 also prevents reconstructing
historical presence inputs from follower captures.

This remains the single C1 diagnostic draft. **Safe suppression, equivalent
presence coverage, measured savings and fresh-event latency remain unproven.**

Evidence:
- [Current status](https://github.com/goslingmanagment/core/blob/6d65517ff55e1c63bdad271b7dd2de573f95539f/investigations/fansly-c1-followers-2026-09-10/STATUS.md)
- [Merge validation](https://github.com/goslingmanagment/core/blob/6d65517ff55e1c63bdad271b7dd2de573f95539f/investigations/fansly-c1-followers-2026-09-10/MAIN-SYNC-20260912.md)
- [Natural completion](https://github.com/goslingmanagment/core/blob/6d65517ff55e1c63bdad271b7dd2de573f95539f/investigations/fansly-c1-followers-2026-09-10/OBSERVATION-20260912T183741Z.md)
- [Presence measurement limit](https://github.com/goslingmanagment/core/blob/6d65517ff55e1c63bdad271b7dd2de573f95539f/investigations/fansly-c1-followers-2026-09-10/PRESENCE-MEASUREMENT-20260912.md)
