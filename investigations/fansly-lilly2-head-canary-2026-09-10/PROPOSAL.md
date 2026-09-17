# Lilly-2 known-head canary — prepared, not activated

Proposed owner action: set `fanslyDmHeadCatchupPageAllowlist` from `none` to
`lilly-2` for 60 minutes, then restore `none` using the normal Configuration
save. Request approval for activation and that timed/early-abort rollback
as one bounded operation. This is the separate Lilly-2 recovery gate from the
original instruction and `docs/runbooks/fansly-dm-head-catchup.md`; PR162's
approved deployment does not authorize this flag.

## Evidence before the decision

- PR157 is merged, independently reviewed and deployed as part of PR162's
  `8b25d57e5d1343271177426ee9caf644cb1ee5c0` production image. It passed
  `pnpm check` (3099 tests, 9 existing skips) and seven Docker-Postgres files
  (66 tests, zero skips). Tests cover stale reads, overlap, persisted resumes,
  the five-page cap, large bursts, external receipts and rollback continuity.
- The current Configuration DOM shows both running/editor `none`. The numeric
  override version is not exposed there; the normal dashboard submits its
  current expectedVersion and refuses a stale save. Refresh before any edit;
  preserve the old value and conflict outcome rather than inventing a version.
- The original diagnostic Lilly-2 cohort is 5615/5615 captured in retained raw.
  That is distinct from the current debt queue and is not a full archive census.
- At 9 September 21:03:36 UTC the queue has 112 pending IDs: 93 hidden,
  11 other excluded and eight visible/resolved/unexcluded eligible targets.
  No target is exhausted. Eight targets were frozen at 20:56:25, all with zero
  completed recovery attempts. All eight exact Hub reads returned no matching
  ID at 21:00–21:01; the permitted source query found no DM observations for
  Lilly-2 since 19:00. This proves no matching receipt in that scope, not deletion.
- Neither DM stream has a current failure/blocker. The last successful
  dm_conversations completion is 18:13:47 and dm_messages 15:41:42; current
  captures, completed full sweeps and archive materialization are separate clocks.
- Shared archive/canonicalization latency is already elevated during reply
  replay. The original Lilly-1 reply gate passed at 21:16:10 UTC, completing
  all 994 original target checks across six pages. Keep the earlier
  baseline as evidence; take a fresh runtime/queue/receipt/log snapshot after
  repair before using an approval. Continued elevated latency must stay explicit,
  and an extra canary must not be credited with fresh-event percentile acceptance.

An exact retained list receipt (observation 2328008, received 20:20:04.799 UTC)
confirms all eight IDs in both `data.lastMessageId` and the embedded lastMessage.
The one-body read passed using read_only/READ ONLY with the unchanged 5-second
limit. See `evidence/marker-baseline-summary.json`. The proposal and acceptance
helpers received independent local review with no actionable findings (`REVIEW.md`).

A fresh post-repair read at **21:20:18 UTC** confirms the same 112 pending
Lilly-2 debts and the same eight eligible targets, all unconfirmed with zero
attempts; there are still no matching DM receipts in the fixed source window.
The list is running and DM is pending, with no failure/blocker. All roles were
healthy on the approved image at 21:16. Golden-signal projection/canonicalizer
alerts remain as of 21:17, so broad freshness is still unaccepted. Evidence:
`evidence/baseline-after-reply.txt` and the release's final runtime/log snapshots.

## Execution after an explicit yes and the preceding reply gate

1. Recheck the exact deployed revision, all-role health/free disk, current value,
   eligible/excluded debt and fresh/archive progress. Preserve a competing config
   edit. If the eight targets have already arrived, close their serving checks
   and report that fact rather than manufacturing a recovery success.
2. Save only `lilly-2`. Record the actual save time, prior value, UI CAS outcome
   and the rollback deadline at save + 60 minutes. Verify running value on all
   three roles within the existing live-configuration propagation window.
3. The existing executor handles the next ordinary list sweep and message
   selection. Do not reset a checkpoint, force sync, raise concurrency/budgets,
   call Fansly directly, repeat v6 replay or start a socket. New eligible Lilly-2
   debts may also be selected by this page-level flag; the eight original targets
   keep a separate denominator. Other pages remain off.
4. Read the debt/receipt report and completed worker HTTP summaries every five
   minutes; deduplicate summaries by page, stream and run ID. Check transport
   retries and 429s separately from terminal failures. Compare all eight exact
   IDs through Hub and verify repaired material after durable receipts arrive.
   Report raw/hot/archive latency separately and keep unread/unconfirmed IDs.
5. Restore `none` at the deadline, or earlier on lost/corrupted material,
   broken proxy/session boundary, failed kill switch, rising failures/429s,
   demonstrably worsening fresh/history progress or uncontrolled extra work.
   Verify all-role propagation. An in-flight request may finish; preserve all
   raw/events/debt, attempt receipts and ordinary history cursors. A conflicting
   operator edit must not be overwritten.
6. Save the final target, debt, latency, attempts, runtime and rollback evidence.
   A one-hour window can end before the fifth scheduled retry: unresolved IDs
   remain explicit. The canary does not automatically start A0 or permit A1.

The current `baseline.sql` has a fixed source window of 9 September 19:00–23:00
UTC and was already executed successfully as read_only in READ ONLY. Before a
later activation, rebase and validate that bounded query window to cover the
actual canary. Never silently reuse an expired window as a negative result.
`check-known-head-samples.py` already ran once and refuses a duplicate dispatch;
after-checks must use a fresh evidence directory while preserving all eight IDs.

Sources: `evidence/pr157.json`, `evidence/config-before-proposal.json`,
`evidence/known-head-samples.txt`, `evidence/known-head-serving-result.json`,
`evidence/baseline.txt`; current release report is
`../fansly-pr162-release-2026-09-09/REPORT.md`.
