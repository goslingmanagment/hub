# Lora-1 generation 4830: retained pointer-clearing evidence

The raw responses explain 2,363 distinct list-head pointer clearings behind
the candidate stop. All affected groups already lacked an embedded head in
the preceding response. The cleared pointers remain empty in the following
full sweep. This establishes a provider-response metadata transition; it
does not establish when or why message content became unavailable, a deletion,
archive loss, or the impact on readers.

The runtime recorded 2,364 head-ID changes and rollback occurrences below
stop. Raw-to-raw comparison explains 2,363 of them; the difference of one
remains unresolved because the original pre-apply database state is not
retained by this report. The current early-stop candidate is NO-GO without
waiting for seven days. A0 observation itself is not declared accepted.

## Observed production scope

The existing `fansly_dm_shadow_corpus_batch` function exported metadata for
12 September 19:30–21:00 UTC. Reads ran on 13 September
00:35:37–00:36:32 UTC as `read_only`, in REPEATABLE READ READ ONLY transactions,
with a 20-second statement limit. Seventeen batches scanned raw IDs
`(2841649, 2857710]` and returned 964 selected records. The lower ID is the
previous export's actual last selected record, captured at 15:29:57 UTC;
it is not that export's later global ceiling.

The corpus SHA-256 is
`b52af4b2e296938f90c62c3eafee1a914af4be57dad1ae50e006852cdc4f54bc`.
This is a bounded cohort across separate snapshots. It is not a globally
atomic census or a historical snapshot of database state. No provider
requests, application writes, flags, recovery or deployments were performed.

| Associated runtime generation | First raw ID | Pages | Distinct groups | Null/absent list ID | Null embedded ID |
|---|---:|---:|---:|---:|---:|
| 4829 | 2848010 | 77 | 7,693 | 393 | 2,756 |
| 4830 | 2849360 | 77 | 7,693 | 2,757 | 3,079 |
| 4831 | 2850289 | 77 | 7,693 | 2,757 | 3,079 |

Each raw sequence has contiguous offsets 0–7600 and a terminal membership
certification. Association to runtime generations uses first-response times
and matching page counts, rather than a raw-to-generation foreign key.
Generation 4830 spans 37 runs, consistent with its 36 resumes; each of its
7,693 group IDs occurs once in this reconstructed sweep.

## What changed

Exactly 2,363 groups common to the first two sweeps changed from a populated
list message ID to exported null. That set exactly equals the preceding
sweep's groups that had a populated list ID but no embedded head. For all
2,363, embedded ID, timestamp and sender are absent/null both before and
after, with exactly one aggregation group match.

Of these transitions, 2,342 change only the list ID; 20 also change the last
unread-message ID; one also changes unread count and last unread-message ID.
All 2,363 pointers remain null in the third sweep. Six groups enter and six
leave between the first two sweeps, so the difference between aggregate null
counts is not itself the number of common-group pointer transitions.

The exported JSON collapses an omitted property and explicit JSON null.
A privilege check at 00:42 UTC confirmed that `read_only` cannot select the
raw IDs/pointers or original response column needed for a direct field-presence
comparison. No elevated-role fallback or permission change was attempted.
The report therefore uses "null/absent" and does not infer provider intent.

## Early-stop result

All 2,363 transitions occur on pages 50–77. Every configured sensitivity
candidate stops earlier:

| Depth K | Overlap values tested | Candidate stop | Pointer clearings below stop |
|---|---|---:|---:|
| 1 | 0, 60, 300 seconds | 8 | 2,363 |
| 3 | 0, 60, 300 seconds | 10 | 2,363 |
| 5 | 0, 60, 300 seconds | 12 | 2,363 |

These are hypothetical stop positions. Actual full sweeps continued. The
case adds to the previously verified flags counterexamples; it does not
justify silently excluding changed metadata from the migration's scope.
No physical HTTP savings or event-to-reader latency was measured here.

## Reproduction and review

The existing nine-policy analyzer passed on all 964 retained records.
`analyze.py` independently checks the corpus hash, ordered rows, read-only
receipts, contiguous offsets, certification, distinct groups, paired pointer
transitions, persistence and the nine policy results. It exits zero and writes
`evidence/comparison.json`. Samples contain only group digests and capture
coordinates, with no message bodies or credentials.

An independent reviewer reconstructed the same raw transitions and checked
the runtime counter/checkpoint code. Ordinary continuation does not multiply
committed counts: offset and shadow checkpoint advance together, report
upsert replaces diagnostics, and generation duplicate guards remain enforced.
The reviewer identified the null-versus-omitted limitation retained above.
No application source changed, so `pnpm check` and Docker integration suites
were not rerun for this read-only investigation.

Provider-side deletion head repair remains outside A0, as the owner decided.
The observation clock is unchanged. See [gate assessment](GATE-ASSESSMENT.md)
for work that can proceed independently of the calendar.
