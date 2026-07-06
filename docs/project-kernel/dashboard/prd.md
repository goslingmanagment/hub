# Dashboard PRD — DRAFT (fill during the design pass; owner reviews before build)

> Status: SKELETON. Seeded 2026-07-06 alongside decision #112. The build
> session verifies the ground truth in the launch prompt, answers the open
> questions WITH the owner, and completes every section before any code.

## 1. Audience & jobs

Who operates this console and what do they come to do?
- Owner: <daily jobs, weekly jobs>
- Team leads (if granted): <subset>
<!-- Open question #1: owner-only, or team-lead subset? -->

## 2. Page inventory (keep / cut / new)

| Surface | Today | Verdict | Notes |
|---|---|---|---|
| Overview | exists | ? | re-serve from Stage 28 metrics models |
| Page detail / fans / subscribers / followers | exists | ? | |
| Top supporters / spender auto-lists / deleted fans | exists | ? | |
| Workboard v2 (+ AI closing tabs) | exists | ? | live via workboard.* frames |
| Usage / AI analytics | exists | ? | gateway ledger is the source |
| OFAPI credits | exists | ? | |
| Settings / config surface | exists | ? | staged flips stay |
| Notifications / incidents | exists | ? | no ops event lane in v2 (question #3) |
| dev: logs / queue / db / incidents / sync | exists | ? | |
| Grants + device tokens admin | NEW | required | Stage 22 routes exist |
| Erasure (dry-run-first, owner-only) | NEW | required | Stage 28.4 routes exist |
| Golden signals | NEW | required | ops_metric_samples (Stage 25) |
| Fleet/release visibility | NEW? | ? | question #5 |
<!-- Open question #2: which pages does the owner actually use vs tolerate? -->

## 3. Liveness model

One stream-v2 SSE subscription per session + slow ≥5-min degraded fallbacks.
Frame vocabulary is business events only — decide (question #3) whether ops/
incidents get a kernel event lane or keep a real poll.

## 4. Information architecture & navigation

<!-- sketch after §2 verdicts -->

## 5. Visual direction

<!-- Open question #4: keep utilitarian vs new design language; references -->

## 6. Build stages & parity exit

- Stage 1: <skeleton + auth + shell>
- Stage N: …
- Parity sign-off checklist → old `apps/dashboard` deletion (own commit).

## 7. Non-goals

<!-- explicitly out of scope for v1 -->
