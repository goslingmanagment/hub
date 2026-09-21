# Fansly reliability fixes after the WS + REST audit

Status: reviewed by Fable; review decisions incorporated before implementation. See reviews/.
Base: ecc864da / origin/main. Branch: codex/fansly-reliability-root-causes.

## Problem and scope

The September 21 audit found four independent defects: an absent/deleted exact message prevents a B1 group revision settling; an additive B1 transport error aborts the shared dm_messages executor; policy generation mismatch silently disables hints after a route/session rotation; A0 loses its previous certified-full boundary when a full scan follows A1. REST recovered most WS-known messages, but that is not proof of full coverage. Six Ari messages retain text in the raw journal and are missing from the ordinary archive.

Fix the four defects in small independent commits, with DB-backed regressions and a shared final check. Keep REST membership and history authoritative, preserve the raw journal, all existing page/lease/generation/erasure fences, default-off settings and the rolling physical-request budget. Do not silently increase the cap, enable flags, introduce a second scheduler, change the 180-minute full cadence or claim that terminal receipt settlement means archival materialization.

Plans: 01 deletion settlement; 02 failure isolation; 03 verified generation recovery and visible status; 04 certified boundary; 05 retained-message recovery contract.

## Architecture decisions

- A receipt has two distinct facts: operational settlement and REST materialization. A delete can settle an addressed target without manufacturing a live business message or stamping hot_applied_at.
- A B1-specific request failure is durable subject work, not success and not a failure of an unrelated ordinary message walk. Real account-auth, provider cooldown, lost ownership, erasure/capture/DB failures keep their existing blocking behavior.
- The generation pin is an intentional safety boundary (Decision 366). Repair its operation with checked preview/apply and a visible mismatch; do not replace it with an unconditional auto-follow.
- A certified-full proof is shared by scheduling and the shadow comparison. Resumed shadow diagnostics keep their original boundary; an interrupted unknown comparison cannot acquire a fabricated complete result.
- Historical raw recovery is a separate projection concern. Do not enable B2 or backfill production as a side effect of fixing hints. Plan 05 specifies a bounded, provenance-preserving recovery route and its acceptance; no unsafe direct SQL insert is an acceptable shortcut.

## Workflow and acceptance

1. Fable reviews all plans against current code and identifies blockers, excess complexity and missing races/tests.
2. Record review decisions, revise the plans, and resolve architectural blockers before implementation.
3. Implement plans 01-04, adding meaningful regression tests. Prepare the concrete recovery procedure in 05 without claiming the six production rows recovered.
4. Run targeted unit and integration suites sequentially, then pnpm check and the repository-required ratchets. Review the final diff and use Fable for a final implementation review if available.
5. Commit only this branch's changes; create a draft PR with evidence and the rollout/rollback procedure. Production rollout and recovery remain a separate owner action: code authorization is not a deployment instruction.

Validation must include late R+1 events, concurrent claims, rotation between preview and apply, transport vs auth/429/capture errors, A1→full→resume transitions, and receipt replay/idempotence. Green tests are not a production completeness certificate.
