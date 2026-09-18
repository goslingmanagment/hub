# Operational export review

Independent reviewer: `review_pr162`, 11 September 2026 (Europe/Moscow).
Reviewed `export-t0.py`, the pinned A0 `read.ts`, corpus reader and analyzer.
The worktree was clean at `a3caa0e9`. No actionable findings.

The reviewer verified the read_only identity and READ ONLY transaction check,
20-second statement timeout, 500-ID keyset batches, pinned upper ID, and
completion manifest / SHA-256 / record-count checks. Empty matching batches
do not terminate a scan while candidate envelope IDs remain.

Interpretation requirements retained for the actual export:

- September 1–6 is six historical UTC days, before runtime shadow and its new
  loss counters. Unknown old runs and missing shadow rows do not mean zero loss.
- Nine policies share one corpus. Each has its own complete, priming,
  incomplete and invalid denominators; they are not independent samples.
- An empty eligible cohort does not close the historical gate.
- Hypothetical list pages avoided do not prove physical HTTP savings,
  freshness, event-to-reader latency, or seven days of live shadow.

The reviewer did not access production, run tests or verify export results.
The original implementation review and green tests remain recorded in PR164.

## Actual T0 baseline

The reviewer independently verified the completed baseline SHA-256, grouping
uniqueness and all summary aggregations: 183,416 physical-attempt rows, 5,241
retry-attempt rows, 1,709 terminal-failed rows, 42,839 overlapping runs with
unknown loss counters, three boundary runs and 9,100 unknown-byte rows.
Known captured payload bytes sum to 12,888,887,748.

The 94,125 `dm_conversations` stream attempts include 93,110 `messaging_groups`,
681 `account_lookup` and 334 `messages` attempts. Retry ordinals >1 differ from
rows in the `retry` state; their equal totals in this window are coincidental.

The new optional `--output` argument initially left relative paths unresolved
while child processes changed working directory. The P3 finding was fixed by
expanding and resolving the path once. The running export used an absolute
path and was unaffected. The failed first socket connection remains separate
as a zero-byte `.partial`; the successful connection uses the verified
canonical `/run/postgresql` path without changing database privileges.

## Bounded psql transport

The original corpus transport spent five wide-area query round trips per
500-envelope batch. It was stopped deliberately; its partial remains separate
from the already-completed T0 baseline. The replacement reads the same SQL
operation through the existing read_only psql route, with no production files.

The reviewer verified disjoint `(after, min(after+500, upper)]` ID ranges,
including sequence gaps, a pinned upper ID, per-batch role/range/count receipts,
strict record ordering, successful psql completion and full interval coverage
before writing a completed manifest. Each interval contains at most 500 IDs,
so the SQL function's 500-row limit cannot truncate that interval.

One finding was fixed before execution: the preparatory `generate_series`
query also needs READ ONLY. The psql process starts with session-only
`PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=20000`;
explicit READ ONLY transactions remain around every upper/batch read. This
changes no persistent database or runtime setting. No other findings remained.

## Cancellation and reader cleanup

Stopping local SSH left one owned psql export alive on the server. A later
read hit the role's connection limit. The abandoned client was identified by
its PID, start time, command and window before terminating only that client;
the compressed export continued. The cleanup receipt is retained separately.

Review found missing SIGTERM handling and a cancellation gap before receiving
the remote PID. Both are fixed: the remote shell waits for a one-time
handshake before opening psql, and Python always enters cleanup on SIGTERM.
Cleanup checks the exact PID and unique export marker before signalling it.

A real Docker-Postgres regression reproduced why terminating a busy client
was insufficient: its backend retained the only reader slot. Sending SIGINT
through psql cancels the server query. SIGINT, SIGTERM and cancellation before
the PID now all leave zero reader sessions, preserve only a partial export,
and allow a new READ ONLY connection. A fourth case completes an empty
fixture export through the unchanged nine-policy analyzer. This uses a local
SSH shim and proves database/client behaviour, not WAN-disconnect recovery.

The review also caught ignored signals leaking into analysis. Handlers are
restored after cleanup; the process then executes the analyzer directly.
Final independent review closed all findings and read the four-case receipt;
the coordinator ran the tests. These helper fixes do not alter deployed code
and were not loaded by the already-running compressed export.

Evidence: [four passing cases](evidence/cleanup-local-test.json),
[original TERM counterexample](evidence/cleanup-local-test-term-failure.json),
[owned-client cleanup](evidence/orphan-export-cleanup.json).

## Completed historical results

The reviewer independently streamed the full 2.23 GB corpus: 93,130 records,
matching SHA-256, strictly increasing bounded IDs, every capture inside the
half-open September 1–7 UTC window and all six page labels. All aggregations
in `summary.json` match the nine-policy analyzer. The 5,589 disjoint intervals
match the pinned upper bound; nonmatching `scannedRows` are a reader receipt,
not independently recoverable from the filtered corpus.

All policies have 1,478 complete comparisons, 214 priming and 98 incomplete
sweeps, plus 1,046 invalid/unattached records. Default K=3/60s has 28 state
changes below stop in 26 sweeps, including 25 flag observations, one new-to-
baseline group and two other changes. The reviewer required inspection of
both residual cases as well; they are list/embedded head conflicts in Lilly-2
and Lora-3. Embedded ID/sender/time change while the list ID remains stale;
this is not an in-place sender mutation of the same message. The reviewer
independently reconstructed all six predecessor/current sweep segments,
checking offsets, unique groups, completion receipts and the before/after
metadata. No policy has zero discrepancies.

The reviewer accepts the completed offline investigation as a prerequisite
to separately approved measurement-only runtime shadow. It does not satisfy
A0 exit, seven live days, safe-stop/A1, HTTP savings or latency acceptance.
The reviewer did not access production or rerun the full analyzer.

## Periodic report reader

After owner approval for six-page shadow activation, the independent reviewer
checked `read-report.py`: normalized bounded timestamps, shell/psql quoting,
read_only in READ ONLY, 20-second statement timeout, identity verification and
exclusive output files. Process/receipt failures cannot produce a completed
manifest. No actionable findings. The coordinator's first production read
completed and its hash/count were verified separately.

Reports remain cumulative from activation because earlier rows can settle
later. Do not sum snapshots; preserve unknown and boundary counters. The
eight-day query cap remains, including for a delayed seven-day gate read.
The reviewer did not run tests or access production for this helper review.
