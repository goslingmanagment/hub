# Independent missing-head findings review

**No outstanding findings.** Reviewed final REPORT.md, retained command and
output receipts, the prepared SQL, candidate transcript and current reader/debt
source locally. No production call, test, source change, Git operation or STATE
change was performed. Only this review file was written.

Final reviewed REPORT.md SHA256:
`e14c2a6385e596f316659c7d843925d98d6b14ec57d3e51edd31668d78e1b0d9`.

## Resolved report finding

**P2 — Do not describe ordinary Agent reads as zero production writes.**
The original opening said no production data changed. The transcript handler
always writes an Agent audit row, and the runtime updates request/row usage.
The final report limits the claim to business data and explicitly acknowledges
ordinary audit/usage bookkeeping. The SQL reads themselves remain READ ONLY.
Verified this against handlers-threads.ts:909, runtime.ts:488 and
agent-read-audit.ts:172 onward in the supplied ac921 source worktree.

## Retained evidence verified

Independently verified all 13 recorded hashes: the stdout/stderr files for six
commands, plus the historical-marker SQL hash. SQL commands exited zero;
the transcript command intentionally exited 3. No missing or altered hashed
output was found. The historical-marker read used the reviewed SQL, with
remote timeout 8s plus 1s kill grace, and completed in about 3.11 local seconds.
Local receipt times and database timestamps are not subtracted into latency.

The access receipts establish page 5/Fansly and SELECT permission on observations,
capture_json_hot_bodies and the debt-report view. Direct message/thread stores
are denied. The separate 18:24 raw-access read successfully evaluates catalog
privileges and returns false for sync_raw_payloads and sync_runs; it contains
no attempted SELECT of their business rows and is not a failed data export.

The current debt query contains 106 rows with scope_count=106. All 106 exact
group/message pairs are unique and match the literal historical-query targets.
No visibility, identity-resolution or exclusion filter reduced the candidates.

For each historical window, independently counted 142 unique source IDs,
ordered by receipt time and ID. The SQL returns 14,104 list entries per window,
zero unavailable bodies, zero malformed data arrays and no 201-row cap hit.
Each window has exactly one target match, the same pair:

- Conversation: `834268142812291072`
- Advertised message: `949097710298869762`
- Observations: `2500080` and `2500617`
- Source ordinal/item: `69 / 44` in both windows
- Producer run IDs: `750834` and `750944`
- Capture pointer: September 2026 / object `1077298`

Both rows have flags 2 and exactly one matching aggregation group whose
lastMessage key is present with JSON null. Embedded ID and timestamp are null.
The reviewed query retains duplicate-group counts and all sanitized markers;
it does not silently choose one group.

The producer idempotency-key construction in sync/shared.ts places syncRunId
in the third colon-delimited component, matching these two run IDs. Generation
labels come from the query's supplied sweep time windows, not a generation
field in those observations. Ordinal 69 is checked retained-source order and
is not verified request offset or independently proved runtime page membership.

The exact debt row has captured_at null, attempts 0, no last attempt, visible
and resolved identity, complete recorded history, and the stated lookup
exclusion. Its message/debt timestamps match the report. Migration 0172 seeds
existing heads, so first_observed_at is not first-provider-sighting proof.
Complete history and resolved identity do not override the exact-head debt or
establish current reader material.

## Transcript and conclusion boundaries

The retained transcript has ok=true, exitCode=3, zero items and an exact zero
post-dedup count for its requested conversation/window. It has no cursor,
snapshotExhausted=false and delivery_not_exhausted. Four transcript planes are
marked read; sourceErrors and gaps are empty. Its message_archive floor and
three unknown floors match REPORT.md. This is a successful API call with an
intentionally partial evidence verdict, not a frozen absence proof.

Independently checked includeDeleted default true, NULL-inclusive event windows,
pending-row inclusion, and final filtering after source precedence in
agent-transcript.ts. An empty selected window is not an all-date exact-ID
classification or a reconstruction of either historical pre-apply snapshot.
The source-contract review agrees. The separately linked count-cap note is
explicitly static, unreproduced and unrelated to this zero-row outcome; this
review performs no additional reproduction or source modification for it.

The report's strongest conclusion is appropriately limited to one repeated
current-debt candidate advertised in both historical windows with a null
embedded head. Current debt coverage is not complete for historical misses;
the two scalar counters do not themselves carry target identities. No exact
historical attribution, distinct-message loss, provider deletion, permanent
account status or explanation of the separate flags counter is claimed.

Repeating the same transcript or top-100 EXPLAIN would not close those limits.
No additional production read is required to deliver this bounded result.
Further reading needs a separate concrete question and an appropriate existing
surface; today's state cannot supply omitted historical per-ID pre-apply facts.
The original A0 clock, NO-GO, full polling, unknown coverage, savings and latency
gates remain unchanged.
