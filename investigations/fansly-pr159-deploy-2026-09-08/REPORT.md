# PR159 production attempt — automatic rollback

The owner-approved deployment of b213c32e70f84cc17a03526b4920e2de5988f7a5 did not pass its sync-health gate. Production returned to b47f552abb97f44a7c10ffad005a871c99d4ff18; no recovery flag was activated. This is a failed deployment and incomplete pre-A0 acceptance, not an events migration stage exit.

## Deployment evidence

- Standard command in a clean pinned worktree: `scripts/deploy-production.sh --mode dist-only --no-image-gc root@45.8.230.111`.
- Started 2026-09-08 16:34:44 UTC. Artifact/image and ordinary role health passed; API/scheduler started 16:39:47, worker 16:40:07.
- Six protected `/api/v1/health/sync` requests timed out at 150 seconds each. No gate or timeout was changed. Automatic rollback started around 16:57:30; script exit 1.
- At 16:59:12 UTC the previous revision's API/worker/scheduler were healthy with zero restarts, `/health` OK, DB probe 0 ms, 31 GiB free. Configuration UI after rollback: catch-up shared running/editor `none`, Save disabled, all roles active.
- Evidence: `evidence/deploy.log`, `rollback-verified.txt`, `flag-after-rollback.txt`, API/worker logs.

Postgres showed high CPU (353.94% in one sample), and projection ticks reached 342.958 seconds with archive work 242.049 seconds. A bounded read-only lock check found no waiting locks at its sample time. Other-role SQL text/activity is hidden from `read_only`; detailed attempt tables are not granted. These facts do not identify the exact health-query bottleneck. Local reproduction is required before choosing a change.

## Candidate measurements

Preflight 16:32:19 UTC: 2394 parse-zero sync-pull observations (860 DM, 68 earnings, 733 monthly, 733 stats), 290064 v5 observations. Oldest zero DM was 12:08:40.856 UTC. In the frozen initial cohort, by 16:49:06, 400/2394 advanced to v6: 249 DM, 13 earnings, 69 monthly, 69 stats. DM v5 history fell from 44754 at 16:42 to 44660 at 16:52, so both lanes progressed during the window.

The recovered ari exact message `953354621215076352` / group `953353803074117634`, captured at 12:36:33.695, was stamped v6 by 16:57. Serving at 16:45 and 16:49 still selected the hot message plane; archive acceptance is unproven. No completed canonicalizer sweep was observed in the exported candidate logs, so these samples do not prove fairness across completed sweeps, wall-clock budgets, or a latency percentile. Rollback does not undo v6 stamps, repaired links or cursor records.

## Retained reply cohort

Latest reply-bearing observation within received-time window 2026-09-07 01:45 UTC through 2026-09-08 01:45 UTC per page/message: 994 unique messages, 326 conversations, 474 conversation-day groups, 27 attached messages. Source bodies were available for all 994. Exact metadata was read using the Hub CLI only, one request at a time. The scan resumed after rollback from 249 completed groups and finished at 17:05:59 UTC. Read timestamps and coverage blockers are preserved per group; successful groups were not reread.

| Page | Exact IDs in archive serving | Parent matches | Root matches |
|---|---:|---:|---:|
| ari-1 | 9/9 | 0/9 | 0/9 |
| lilly-1 | 316/316 | 256/316 | 249/316 |
| lilly-2 | 409/409 | 363/409 | 321/409 |
| lora-1 | 143/143 | 4/143 | 4/143 |
| lora-2 | 63/63 | 6/63 | 6/63 |
| lora-3 | 54/54 | 2/54 | 2/54 |
| Total | 994/994 | 631/994 | 582/994 |

At 17:23:17 UTC, an additional read-only check matched all 370 distinct page/received-time source keys to exactly one observation each: all still parse_version=5, accounting for all 994 targets. The retained cohort's own source observations have not reached v6 replay. The existing matching links therefore do not establish repair by this replay. Evidence: `evidence/reply-source-versions-after.sql` and `.txt`.

All target IDs were found; no groups remained failed/unread. Positive exact-ID comparisons do not require exhausting unrelated transcript messages, so the retained `delivery_not_exhausted` blockers do not invalidate those matches. They still preclude general conversation completeness. This is a mutable bounded comparison, partly on the candidate and partly after rollback, with v6 on both. Mismatches are pending acceptance, not proof that PR159 caused them or that all are permanent parser defects. Explicit clears, later parent changes, absent provider messages and normalized full-text/media parity are outside this cohort. No private message text is retained by the comparison script.

## Gates and next action

PR159: https://github.com/goslingmanagment/core/pull/159. Independent review and local tests passed: pnpm check 3110 tests (9 existing skips), 50 Docker-Postgres tests without skips, production build; all five CI checks passed. The PR contains these results and the failed deployment update.

Prepare a narrow, locally reproduced health-query fix in its own worktree/branch/PR, with decision numbered from current main and independent review. A repeated deployment needs a new explicit owner yes. The lilly-2 recovery is still off; A0/T0/A1 and later stages are not started, B2 awaits a separate decision. No HTTP savings or event latency measurement exists; the >=50% goal is not met or claimed.


## Follow-up prepared

PR https://github.com/goslingmanagment/core/pull/160 contains a narrow current-run activity-query improvement and Decision 280. Worktree: /Users/dmitriy/.codex/worktrees/hub-sync-health-query; reviewed head 536f93c4f5704c361fbf69fc4e290f5d45a405b2. In a six-page synthetic Docker-Postgres fixture, all 102 rows match and EXPLAIN ANALYZE improves from 4323.725 to 1112.748 ms. This does not establish the production timeout's exact cause. Full pnpm check passed (3110 unit tests, 9 existing skips), 15 PostgreSQL integration tests passed without skips, production build passed, independent review found no blockers. All five CI checks passed; merged at 17:30:59 UTC as 18649bd95f3bedb812847343d27fdeedf8b5d32f, with its tree identical to the independently reviewed final head. The pinned clean deployment worktree is ready; repeated deploy requires a new owner yes.

## Later approved deployment

The owner separately approved PR160 merge 18649bd95f3b. The standard deployment succeeded and now includes PR159, with catch-up none. The recovered ari target is proven in archive serving; replay acceptance is still incomplete. One follow-up sync-health request timed out, so the latency issue remains open. Current measurements and gates: [PR160 deployment report](../fansly-pr160-deploy-2026-09-08/REPORT.md).
