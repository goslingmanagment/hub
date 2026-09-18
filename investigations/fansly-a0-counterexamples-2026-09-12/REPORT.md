# A0 retained counterexample — 12 September

The current stop candidate misses a real provider flags change on an old
Lilly-1 conversation. The retained response places it on page 12; every planned
K/overlap combination stops earlier. The existing full sweep reached this
response. This is a hypothetical early-stop miss, not a lost production
message. Preserving the agreed freshness still prevents accepting this candidate.

## Scope and source

The existing A0 report through 11:21 UTC contains 425 sweeps: 188 complete,
236 incomplete and one running. Twelve sweep observations contain a state
change below the candidate stop; eight are complete and four incomplete.
Three observations identify flags, without excluding other simultaneous reasons.
The other nine do not retain their exact subtype. These are observations, not
twelve unique conversations. The report and hash are preserved in `baseline.json`.

This follow-up exports only retained head metadata for 08:30–11:03 UTC on
12 September through the existing `fansly_dm_shadow_corpus_batch` reader.
The 47 batch transactions plus one upper-bound read use `read_only`, REPEATABLE
READ READ ONLY and 20-second statement limits. The batches cover raw IDs
`(2794341, 2841266]`, scanning 46,925 rows
and returning 1,673 matching list pages. The lower bound is the preceding
export's pinned ceiling from 10 September. This is a complete selected ID range,
not a global census or one historical snapshot of all mutable run receipts.

The export ran at 15:09:47–15:11:36 UTC. Its SHA-256 is
`5a16ab73157d13fe151fd9c3fd52227f16416f1d72ea83ef8ff7fc64cfbe1c09`.
The unchanged existing analyzer evaluated all nine policies. Its source matches
the verified release `64149b95`. Both analysis commands exited 0.

## Lilly-1 generation 7379, 09:30 sweep

The preceding complete 09:00 sweep and the 09:30 sweep retain the same group at
offset 1100. Raw response 2832738 at 09:01:03.915 UTC reports flags `1048586`;
response 2833241 at 09:31:00.835 UTC reports `8`. The compared head ID, timestamp,
sender, unread fields and subscription tier are unchanged. The changed bitmask
is not assigned a product meaning without separate protocol evidence.

The offline and runtime candidate both stop at page 4 for K=3/overlap=60s.
The runtime sweep records one state change and one flags change below that stop;
the retained comparison independently locates a flags transition on page 12.
The retained transition is still present in later responses through 11:01 UTC.

| K | Stops with overlap 0 / 60 / 300 seconds | Flags change found below stop |
|---|---|---|
| 1 | 2 / 2 / 2 | Yes, all three policies |
| 3 | 4 / 4 / 4 | Yes, all three policies |
| 5 | 6 / 6 / 6 | Yes, all three policies |

Increasing K or overlap within the plan's sensitivity matrix does not remove
this counterexample. Head timestamps alone do not discover this flags change.
These virtual pages are not measured physical HTTP savings.

## Lilly-1 generation 7382, 11:00 sweep

The runtime report contains one state change below its page-3 stop, with zero
head-ID, flags, unread or rollback counters. The raw-to-raw comparison with the
preceding complete 10:30 sweep finds zero metadata changes below the same stop.
The raw comparison therefore does not explain this runtime discrepancy.

The runtime compares against pre-apply database state, which also includes
other writers and effective repaired fields. Its generic state counter does not
preserve the exact reason or affected conversation. Remaining reason categories
include visibility, identity/exclusion, tier, effective timestamp and sender.
None is attributed here. Retained provider responses cannot reconstruct every
concurrent database value; zero raw changes does not erase the runtime result.

## Coverage and next action

The corpus has 25 comparable complete sweeps and six priming sweeps across six
pages. All 1,673 records pass the existing schema. The analyzer's 18 invalid
records are leading Lora-2 pages before the first offset-zero response, rather
than malformed payloads; that incomplete window boundary remains excluded.

Keep the flags transition as negative acceptance evidence. Resolve the other
runtime discrepancies against the full pre-apply scope; additional receipt
detail may be needed where the aggregate omitted it. Keep polling freshness
unchanged. The seven-day date is not sufficient for an A1 go decision.
No deployment, flag, cursor, provider call, replay or recovery changed here.

Private evidence is under `evidence/corpus-20260912T151000Z/`: raw read receipts,
corpus and manifest, sensitivity, schema check, bounded target comparison and
execution logs. No message bodies, usernames or credentials were exported.
Group identifiers remain in the private corpus; the target summary uses digests.
