# Fansly C2a/C2b preflight — 12 September 2026

The retained C2a parse backlog is zero in the measured scope. Projection
correctness remains unverified. C2b shadow is disabled on all three live roles.
The first C1 membership receipt records one actual retirement; it does not
justify suppressing the next full walk.

## C2a: retained parsing

The final repeatable READ ONLY census selects received_at before 12:37:00 UTC,
as visible in its transaction at 12:39:35.718179 UTC. It is not a historical
snapshot of parser state at 12:37. It includes every
attached observation with source `pull` and either `fan_earnings_stats` or
`fan_earnings_monthly`; it does not exclude inactive or unexpected accounts.

- 281,525 observations: 140,764 lifetime and 140,761 monthly, all at parser v7.
- Zero observations below v7; no unexpected platform, null account or unknown page.
- Six Fansly pages, 34 month/page/kind/version groups. Retained receipts range
  from 6 July 10:44:17.974 to 12 September 10:53:28.476 UTC.
- Thirteen attached observation partitions, including `observations_future`,
  the range partition starting at 2031-01-01;
  no detached month-named observation table was found in the catalog inventory.

The first census used a cutoff 14 seconds after its transaction began. It is
preserved as interim snapshot evidence; the final census fixes that boundary.
The snapshots are not additive. Counts prove parser stamps, not per-fan
refresh, monetary correctness or projector catch-up. Valid empty arrays have
no fan/window identity. No explicit replay or repair was run.

The read_only role cannot select `fan_earnings_stats` or
`projection_seq_watermarks`. The selectable `projection_watermarks` table is a
legacy plane and cannot certify this projector. The CLI earnings dataset is
planned. Existing C2b aggregates and top-spender readers omit the necessary
scope or source receipts. The owner payload API also withholds top-level arrays,
which include valid earnings captures.

Next: prepare a narrow earnings audit that compares the latest valid retained
snapshot per fan/window with the projection, including source observation/event
IDs and the actual projector watermark. Account for empty, invalid and
unavailable payloads. A new read surface needs its normal code, test and review
gates; privileged replay/rebuild remains separately gated.

## C2b: effective configuration and baseline

The authenticated Configuration UI's normal refresh returned HTTP 200 with
`generatedAt=2026-09-12T12:35:41.441Z`. The selected fields are retained as a clearly labeled
transcription, not a raw response-body export. API, worker and scheduler have
fresh active instances; the older stale API instance is retained separately.

| Setting | All three live values | Source / override version |
|---|---|---|
| `fanslyFanEarningsShadowPageAllowlist` | `none` | env / null |
| `fanslyFanEarningsSyncEnabled` | true | override / 1 |
| `fanslyNewStreamPageAllowlist` | empty string, meaning all pages | env / null |

All three items have `pendingApply=false` and `drift=false`. The two string
items' aggregate `runningState=unknown` is preserved; the exact per-role CSV
values establish their meaning. No setting was edited.

At 12:42:04 UTC, the bounded read_only Lilly-1 report has no tracked endpoint or
outcome rows, `tracked_scope_complete=false` and zero unknown attribution. Its
last completed daily spender sweep is 10:53:28.495 UTC. This empty report is not
evidence of full coverage or any accepted shadow window. Before an activation,
finish C2a verification and prepare the one-page flag, baseline and rollback
packet; preserve the current daily rotation.

## C1: first natural receipt

The separate 12:11:06.271182–12:30:50.069257 UTC window has nine follower runs:
two incremental decisions and seven chunks of Lilly-1 request 736 / generation
687. Its terminal run 733015 records one valid exact-generation receipt:
3,357 active before UPDATE, 3,356 in generation, one outside, one candidate and
one actual retirement. All protection buckets are zero. The generation uses
36 successful physical attempts, no retries or terminal failures.

Previous generation 686 exposed zero candidates but had no actual UPDATE
receipt. Neither snapshot identifies the retired row or measures active-after.
The next useful evidence is Lilly-1's following natural incremental comparison.
Physical savings and fresh-event latency remain unmeasured. A0's original
calendar and evidence gates remain unchanged.

## Runtime and evidence

At 12:38:39 UTC, API, worker and scheduler still ran release `7aaa3185757e`,
image `24ae357d7a5a…`, healthy with zero restarts. This preflight changed no
production code, flags, credentials, cursors or rows, and made no provider call.

Primary files: `c2a-census-cutoff-123700.json` and its SQL/manifest,
`c2a-access.json`, `c2b-config-receipt.json`, `c2b-lilly1-baseline.json`,
`c1-20260912T123050Z/report.json` and `runtime-after.json`.
Independent reviews and remaining limitations are recorded in `REVIEW.md`.
