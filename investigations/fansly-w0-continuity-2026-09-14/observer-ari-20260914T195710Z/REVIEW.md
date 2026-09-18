# Independent evidence review — 14 September 2026

Reviewer: `/root/w0_next_scope`. Reviewed retained native evidence excerpts,
catalog SQL/output/execution and companion binding receipts. No fresh browser
or production observation was performed.

**The scope conclusions are supported; one timestamp wording correction remains.**
REPORT.md describes the creator tab as opened at 20:06:43.161 and closed at
20:12:32.959 UTC. The underlying fields are `navigationRequestedAt` and
`closeRequestedAt`, not completion timestamps. Say navigation/closure was
requested at those times, with successful identity observation / owned-tab
removal subsequently recorded. The evidence does not establish exact browser
connection or disconnection boundaries from those timestamps.

The catalog uses the `read_only` role and a verified READ ONLY transaction. Its
result maps `ari-1` to `itsaribae` and `lilly-1` to `WetLillys`. Native excerpts
support Ari viewing WetLillys with `Last seen today`, and the separate Lily-1
creator context displaying its WetLillys profile link and wsv3 HTTP 101. These
are retained UI excerpts, not an independently replayed authentication test or
provider-frame corpus.

The report correctly identifies a single presence sample, unknown other creator
sessions and the interruption when Ari moved to notifications. The closure
receipt records removal of the temporary creator tab, not closure of every
creator session. No continuous presence interval, browser/receiver coexistence,
paired business frames, authenticated socket scope or presence effect is proven.

The companion invocation is only the one-GET binding preflight. No Hub receiver
was started. The report appropriately keeps that result separate from native
browser activity and leaves full presence and paired-delivery evidence pending.

## Resolved re-review

The coordinator corrected REPORT.md to label 20:06:43.161 as navigation request
time and 20:12:32.959 as closure request time, with subsequent UI confirmation.
Re-read against the same native receipts: the timestamp finding is resolved.
The original finding above is preserved; no report/evidence mismatches remain.
Both evidence reports are ready to seal with their stated limitations.
