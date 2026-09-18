# A0 observation — 14 September 2026, 17:42 UTC

**1,089 sweeps: 833 complete, 255 incomplete, one running.** All 1,009 rows
from the 11:06 export are unchanged; 80 added rows comprise 76 complete, three
incomplete and one running. New reader evidence is available, including two
missing-head occurrences. **A0 remains NO-GO; this report does not authorize A1.**

The original cumulative window starts `2026-09-10T22:58:33.610Z`; this cutoff is
`2026-09-14T17:42:41.583795Z` (3.780648 days). Export ran from
`17:42:41.641751Z` to `17:43:00.658062Z`. Both current/prior report hashes,
unique page/generation keys, manifest counts and raw/normalized JSON parity pass.
The receipt reports `read_only` and `transaction_read_only=on`. The retained
exporter uses `BEGIN READ ONLY`, a 20-second statement timeout and a 40-second
subprocess deadline; it labels the export **non-atomic**, not REPEATABLE READ.
This analysis made no database or network calls.

One timestamp exceeds the nominal cutoff: Lora-1 G4927, started
`17:42:24.520Z`, is running with `updated_at=17:42:45.404046Z`, 3.820251 seconds
after the cutoff but within export execution. Its partial counts are retained
separately; no cutoff-atomic or completed-cohort claim includes that row. All
starts are inside the window and all row timestamps precede export completion.

| Page | Complete / incomplete / running | New C / I / R | Latest finish UTC |
|---|---:|---:|---|
| ari-1 | 147 / 35 / 0 | 13 / 0 / 0 | 17:36:35.438333 |
| lilly-1 | 140 / 42 / 0 | 13 / 0 / 0 | 17:32:50.285294 |
| lilly-2 | 134 / 36 / 0 | 12 / 1 / 0 | 17:28:31.896110 |
| lora-1 | 134 / 54 / 1 | 12 / 2 / 1 | 17:19:00.886573 |
| lora-2 | 139 / 44 / 0 | 13 / 0 / 0 | 17:31:44.713534 |
| lora-3 | 139 / 44 / 0 | 13 / 0 / 0 | 17:17:07.452969 |

## New reader cohort

All seven reader fields are known on **16 rows: 15 complete and one running**;
1,072 older rows lack them, and Lilly-2 G6916 has explicit nulls. No partially
present field set was found. The null sweep began `16:20:06.907Z` and finished
incomplete at `16:32:28.332934Z`; its historical prefix remains unknown. Two
additional new incomplete rows are Lora-1 G4922 (overlap guard, finished
`15:48:32.026396Z`) and G4923 (uncertified/partial, finished `15:56:52.148563Z`).
The cumulative incomplete reasons are 233 uncertified/partial and 22 overlap.

The **15 complete reader observations** contain 47,482 advertised-ID checks,
zero unknown checks, and below the virtual stop: **38,179 materialized, two
missing, zero deleted/pending/archive-only**. The one running row adds 500 checks
and no below-stop observations; do not add those 500 to the completed cohort.
Three completed Ari sweeps have no virtual stop, so their zero below-stop counts
are not evidence of a tested tail. These are repeated observations, not unique
message counts, complete transcript coverage or body/media/link parity.

Lilly-2 G6917 (`16:46:24.430Z`–`16:58:10.122665Z`) and G6918
(`17:16:25.467Z`–`17:28:31.896110Z`) each have one `readerMissingHeadsBelowStop`.
**Two occurrences do not establish two distinct messages, lost messages, a
provider deletion or pruning.** The report carries no target identities. G6918
also has one flags/state discrepancy; that aggregate does not establish it is
the same object as the missing-head observation.

Across all 80 added rows, state discrepancies increase by nine: eight exclusion
reason occurrences and one flags occurrence. Within the reader cohort, Lora-1
G4925 has two exclusion occurrences and Lora-2 G5572 has one; G6918 has the flags
occurrence. The other five exclusion occurrences precede this reader cohort.
Cumulative state/flags/exclusion counts are **2,414 / 14 / 17**. Head rollbacks
remain 2,364 and unread changes 21. Lilly-2 G6906–6918 each adds one old hot-head
occurrence: **+13**, cumulative 165,291. This does not give old rows reader
coverage. Unknown hot-material checks remain 403,215; new material-lag samples
are 101,124, unrelated to event-to-reader latency. Each added reason field is
known on 550 rows, absent on 538 and null on one.

## HTTP and coverage

Physical attempts total **117,432 (+7,769)**: success 111,569 (+7,755), retry
outcomes 4,431 (+12), failed outcomes 1,432 (+2); retry ordinals are 4,429 (+12).
There are no retained started attempts or HTTP 429 outcomes. The two new failed
buckets are scheduled transport failures: Ari-1 `light/account_me` and Lilly-2
`transactions/earnings_transactions`, one each. Twelve new retry outcomes are
also transport-class across seven buckets, listed in `summary.json`. Daily
aggregate buckets do not supply exact attempt times or prove an ongoing outage.
Media-offer-stat buckets are unchanged, which does not establish recovery.

Known captured-object bytes total **7,782,748,158 (+547,408,685)**, excluding
154 null-byte buckets; 7,252 attempts have unknown bytes (+131). These are not
wire-byte measurements. HTTP coverage totals **28,078 runs (+1,836)**, four
unknown runs (unchanged), four boundary runs (+1: Lora-1 scheduled DM), and zero
known unrecorded/unfinished counters. DM coverage totals **12,722 runs (+900)**:
failed 35 (+1, Lora-1), lost reports eight and unknown one (both unchanged).
A failed run is distinct from a failed physical HTTP attempt; the aggregate does
not prove the new Lora-1 run failure belongs to a specific sweep or transport
attempt. Known-zero counters do not remove historical unknown/lost coverage.

Cumulative exports replace one another; signed differences are not an independent
interval census and must not be added across snapshots. Preserve full polling,
the original clock and earliest seven-day boundary **17 September
22:58:33.610 UTC**. The new reader cohort does not retroactively cover prior days;
calendar age, flags/state observations or deployment alone cannot pass A0/A1.
The missing/exclusion/flags occurrences still require scoped explanation. No
realized savings, event latency, current runtime/flag continuity or automatic
repair decision is established here. Runtime and deployment evidence belong to
the coordinator's separate packet.

[Summary](summary.json), [reproducible local analysis](analyze.py) and
[artifact hashes](artifact-manifest.json) retain the evidence. Independent review
is pending. No STATE, code, tests, CI, flags, provider/socket, recovery or
production action was changed by this analysis.
