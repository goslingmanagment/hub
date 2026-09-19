# Independent A0 numerical report review

Reviewed 2026-09-14T17:51:24.585623+00:00 from local retained evidence.
**No outstanding findings.** No production/database/network calls, test runs,
STATE writes or Git changes were made by this reviewer.

Independently verified all seven artifact hashes, exporter hash, prior report
hash and exact raw/normalized report equality. Both reports retain the same
original window start. Current page/generation keys are unique: 1,089 rows,
833 complete, 255 incomplete and one running. All 1,009 prior rows are unchanged;
80 new rows are 76 complete,three incomplete and one running. Recomputed every
page/status count and latest finished timestamp in REPORT and summary.

The exporter evidence is `read_only`/READ ONLY, 20s statement and 40s process
limit, explicitly non-atomic. Lora-1 G4927 is the sole row timestamp beyond the
nominal cutoff: 3.820251s later, but inside export execution. Its 500 checks stay
in the running cohort. This is not a reconstructed cutoff-atomic result.

All seven reader fields have the same coverage: 1,072 absent, one explicit null
and 16 fully known rows. The completed 15-row cohort has 47,482 checks,
38,179 materialized below-stop observations and two missing occurrences;
unknown checks and deleted/pending/archive-only below-stop values are zero only
within that known cohort. Three Ari completed rows have no virtual stop, so
their zero tail counters do not prove a tested tail. Lilly-2 G6916 retains nulls
across its resumed legacy prefix; no historical row is retroactively certified.

Lilly-2 G6917/G6918 each contributes one missing occurrence. No target IDs are
retained, so neither unique message count nor linkage to the older hot-head
anomaly, loss, deletion or pruning is established. G6918 also has one flag/state
occurrence, but the data does not identify it as the missing object. Lora-1 G4925
has two exclusion-reason occurrences and Lora-2 G5572 one. Across all new rows,
the state delta 9 consists of 8 exclusion and 1 flag occurrences; the other five
exclusions precede the known reader cohort. The 13 new hot-head occurrences are
exactly Lilly-2 G6906–G6918; they are not additional reader coverage.

Independently recalculated HTTP/coverage totals and all nine changed non-success
buckets. Physical attempts 117,432 (+7,769), retries +12 and failures +2 match raw
aggregates. The failed buckets are scheduled Ari light/account_me and Lilly-2
transactions/earnings_transactions, transport-class; no exact timing or ongoing
outage follows from a daily bucket. Known captured-object bytes, 154 null-byte
buckets and unknown-byte attempts remain distinct from wire traffic. DM coverage
35 failed/8 lost/1 unknown is separate from failed physical HTTP attempts; its
new Lora-1 failure has no proved sweep/attempt association. Four HTTP unknown
runs and known-zero unrecorded counters are not conflated.

The report accurately preserves the original clock and 17 September 22:58:33.610
UTC earliest seven-day boundary, full polling and A0/A1 NO-GO. Calendar age,
completion status and the new diagnostic cohort do not establish unexplained-
discrepancy clearance, complete transcript/material parity, realized savings or
event-to-reader latency. Signed cumulative differences are not an independent
interval census.

## Corrected review finding

P2: the first summary emitted seven zero sums for the empty known-reader
incomplete cohort (rows 0), while its underlying incomplete fields were absent
or null. The author changed only the empty-cohort summary behavior to null,
matching the reviewed first-reader summary contract. Verified the final
incomplete cohort remains rows 0 with all sums null; the completed/running
figures and report text are unchanged. The final analyzer and manifest hashes
below identify the correction. No new production export was needed.

## Reviewed fingerprints

- `REPORT.md`: `e9d3e3d8f776a8a49b69af192657c293466d6000322ed31a3458e069a08ff1b3`
- `summary.json`: `a8b0cd1d28e1ae3e7ff25e1d483e4d0a88f84b7888725244c1c41c2166ab8e76`
- `artifact-manifest.json`: `cff2f1152079ed6096314286a390e639847bcc9635987d71eba124333fe2419d`
- `analyze.py`: `a85ed568e89fff61d9ca52de7079be0a3531a3115ef421688114588f1ad48c76`
- `report.json`: `74c2e9375d6e6df82932989e114c8ab5f67c349d7b80685108e87f914a328a1e`
- `report.json.manifest.json`: `9540247b2387b5c6db5e7d62d4c8e1e6378b2b4fceeec0b8c06757d40aa3600d`
- `read-receipt.json`: `1c9dba7505b33e4e1ea6796de0160beaa29065d25f2be09e026c359dd3e54f51`

The current normalized report hash is 74c2e937…; prior report hash is
`bd1d703647c28e385f2ce16fd02dee97160d282623736faa3509d6f4e96d29a2`.
The retained exporter hash is
`57dbfd1781b2a996a2c35c30a235143b683c4586d4e2f90e032f2f33327cf2b1`.
Independent review is complete for this snapshot; subsequent STATE pointers and
root release narrative remain separate coordinator-owned updates.
