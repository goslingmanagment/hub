# Lilly-2 recovery: approved, not activated

Measured on 10 September 2026, 13:00–13:11 UTC. The owner's latest `да`
approves `fanslyDmHeadCatchupPageAllowlist= lilly-2` for 60 minutes and return
to `none`, including the proposal's early-abort conditions. Approval persists.
There has been **no production mutation**, flag save, activation timestamp,
rollback deadline or new monitoring automation in this turn. A0 remains unstarted.

## Fresh acceptance before activation

All eight original targets from `evidence/known-head-samples.txt` were captured
by ordinary collection on **9 September 21:43–21:44 UTC**, with zero completed
recovery attempts. They are not a canary result. Their exact retained DM
receipts are eight available observations, all parser v6. Each original ID has
exactly one match in the explicit six-minute source window.

Fresh Hub reads finished at 13:06:25 UTC: **8/8** exact IDs in `message_archive`.
The retained source/material comparison at 13:09:43 UTC passed **8/8** for
normalized text, observed parent/root, media count, stable media metadata and
raw attachment references; one message has attachments. The immutable original
page/conversation/message identities are preserved.

The Hub envelopes retain `delivery_not_exhausted` and `field_state_insufficient`.
Positive exact-ID and source-material comparisons do not assert full history,
provider deletion, subsequent edits/clears, media-file preservation or general
freshness. Reads are timestamped separately, not one atomic snapshot. CLI wall
times were 1.58–8.37 seconds; these are not event delivery percentiles.

Current debt is **2,959 captured, 104 pending, zero visible/resolved/unexcluded
pending targets**. The 104 pending targets comprise 93 hidden and 11 other
excluded visible targets. Identity/exclusion counts overlap and are not added.
No exhausted target is present. The original diagnostic 5,615-ID raw cohort and
these eight later targets remain separate denominators.

Evidence: `evidence/pre-activation-20260910/status.txt`, `eight-raw.txt`,
`serving/evidence/known-head-serving-result.json`, `eight-material-check.json`.
The source comparisons used only `read_only`, READ ONLY, a 20-second statement
limit and a bounded source window. Raw message bodies stayed in process memory.

## Production state and limitations

- API, worker and scheduler are healthy on the previously approved PR162 image
  `sha256:893cc4cc7fd2fadfd0afa204dd10c188b62449201adf4e668c7c1e2fd597a513`.
  The image's actual `agency-hub.source-revision` label is `8b25d57e5d13`.
- API and worker have zero restarts; scheduler has one restart, started
  9 September 21:27:16 UTC. Docker reports OOMKilled=false; the available
  bounded startup logs show leadership acquired and scheduler online at 21:28.
  These observations do not establish the earlier exit's cause.
- Free disk 28 GiB. Loopback health is OK, DB check 29 ms. Hub capabilities
  returned the matching deployed contract hash. No deployment was repeated.
- Completed Fansly HTTP summaries collected at 13:08:39 UTC for the requested
  12:50–13:10 window: **125 unique page/stream/run IDs, 510 attempts,
  zero retries and zero terminal failures**. The actual read precedes the
  requested upper bound; no claim is made about the later portion. Lilly-2
  list summaries account for 124 attempts; no completed Lilly-2 DM summary is
  present. Run summaries can span their completion window and do not replace
  T0's complete physical-attempt accounting. No savings comparison exists.
- Message-archive sweeps continue. Six completed canonicalization sweeps report
  83.5–281.8 seconds, and golden-signal warnings plus a projection-duration
  warning remain. This does not establish acceptable end-to-end freshness.
- Lilly-2 list succeeded at 12:54:22 UTC and is running; messages last succeeded
  at 07:39:14 UTC and are idle. Neither stream reports a current failure or
  blocker. These timestamps do not prove latest-message capture.

See `evidence/pre-activation-20260910/runtime.txt`, `image-labels.json`,
`worker-logs.json`, `scheduler-logs.json`, `http-baseline-summary.json`.

## Why activation is pending

The Chrome browser tool fails even for a read-only tab listing:
`Unable to load browser request-header policy. Retry the browser command.`
The documented diagnostics find Chrome running, its extension enabled and the
native-host manifest correct. The supported fresh-window recovery also failed.
No configuration page was read or edited in this turn. The earlier observed
`none` value is historical, not freshly reverified. No alternative privileged
DB/configuration write, session extraction or browser security bypass was used.

Restore the Codex Browser plugin connection, then continue with the existing
owner approval. Refresh the actual configuration and preserve a competing edit.
Prepare the five-minute monitoring/deadline follow-up, save only `lilly-2`, and
record actual save time plus 60 minutes. Verify all-role live propagation and
return to `none` at the deadline or an approved early-abort condition. A quiet
window with no eligible work cannot establish recovery efficacy.

`canary-status.sql` now requires explicit `receipt_from` and `receipt_to`
parameters. It passed a bounded READ ONLY validation for 12:50–13:10 UTC with
COMMIT; that validation is not a canary. Rebase to the actual activation before
using it for monitoring. `STATE.json` is the resumption pointer.

## Stage position

| Stage | State | Measured savings / latency |
| --- | --- | --- |
| Known-head prerequisite code, PR157 | Previously reviewed, tested and deployed | No savings measurement |
| Reply prerequisite / PR162 serving fix | Previously accepted: 994 original IDs, 27 attached messages across six pages | Historical replay acceptance bounds retained in release report; no fresh-event SLO acceptance |
| Lilly-2 recovery canary | Owner approved; tool-blocked before activation. Eight later targets recovered ordinarily and accepted | No recovery-flag effect measured |
| A0 / T0 | Not started; no shadow clock | No baseline or ≥50% claim |
| Later migration stages | Gates unchanged | Unmeasured |

Existing PRs: https://github.com/goslingmanagment/core/pull/157 and
https://github.com/goslingmanagment/core/pull/162. This turn changes local operator
evidence/helpers only, not product code, so it opens no new stage PR. Relevant
prior `pnpm check` and Docker-Postgres results are preserved in the approved
proposal and PR162 release report. Independent local acceptance review found
no actionable findings (`PRE-ACTIVATION-REVIEW.md`).
