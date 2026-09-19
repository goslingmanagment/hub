# C1 cumulative observation — 14 September 2026, 17:50 UTC

The exhausted timeline contains **3,244 ordered unique runs** through **751072**.
All **2,937 prior rows are unchanged**. The **307 new rows** contain 40 valid
incremental decisions, 249 partial reconcile chunks and 18 successful reconcile
terminals. No new failed run or invalid decision appears. One requested reconcile
is still pending at the cutoff; this observation does not accept a suppression
or presence policy.

The original window is **2026-09-11T01:05:57.089215Z** through
**2026-09-14T17:50:48.205159+00:00**. Collection completed at
**2026-09-14T17:51:39.160970+00:00**. Seven serial exports used the unchanged reviewed
`read-report.py`, SHA-256
`75bf0c1b841d26cdea469d3f39dd238f7817fdd1d8ed721f57c99f6d86abdf3f`.
Each explicitly uses REPEATABLE READ, READ ONLY, a 20-second statement timeout
and a 40-second subprocess deadline. All receipts confirm `read_only` and
read-only mode; isolation is established by the SQL, not echoed separately.

| Page | Records | asOf UTC | after → next |
|---|---:|---|---|
| 1 | 500 | 17:50:50.801671 | 0 → 727169 |
| 2 | 500 | 17:51:02.182896 | 727169 → 731728 |
| 3 | 500 | 17:51:09.034776 | 731728 → 736301 |
| 4 | 500 | 17:51:15.086679 | 736301 → 740790 |
| 5 | 500 | 17:51:22.080042 | 740790 → 743572 |
| 6 | 500 | 17:51:26.970968 | 743572 → 750176 |
| 7 | 244 | 17:51:37.075047 | 750176 → exhausted |

The first `throughRunId`, original start and cutoff stay fixed. Raw/report
agreement, hashes, role, counts, cursor progression, unique order and exhaustion
were verified. Every selected run starts in the window. Each page is atomic;
the combined seven-page timeline is not. Exhaustion proves retained-row delivery,
not provider completeness. Reproduce locally with [analyze.py](analyze.py);
[collection.json](collection.json) retains exact commands, and
[summary.json](summary.json) and [new-rows.json](new-rows.json) retain the calculations.

Of **611 incremental runs**, **533** have valid final decisions: **398 no-request,
128 count-mismatch only, and seven mismatch plus exhausted-without-known**.
The other five OR combinations remain unobserved. New decisions are **22 no-request
and 18 mismatch-only requests**. First-page aggregates agree with the timeline;
exported count, OR and queue increment arithmetic agree. Hidden checkpoint and
encounter identities were not reconstructed. The same **78** runs lack a final
decision: **77 partial chunks and one historical failure**. Invalid/duplicate
decisions and unknown request-queue receipts remain zero.

Of **135 requests**, **134 have exactly one later successful terminal** for the
same page and requested revision, with exact-generation proof. Ten additional
terminals are scheduled. Pending at request is **0/135**, which is neither current
queue state nor coalescing savings. Lora-2 run **751019** requested **seq 1640** at
**17:44:27.766 UTC**; 16 partial chunks are retained, with no terminal in this
window. Its last chunk **751072** started **17:50:38.260**, finished
**17:51:03.241**, and is explicitly `unfinished_in_window`: its finish is after the
cutoff, observed on page seven. It is not a failed or completed reconcile.

Across **144 successful reconcile terminals**, **97** have valid membership
receipts. The same **47 historical gaps** remain: 44 pre-instrumentation and the
known writer-boundary runs 733622, 733859 and 734003. Including two nonterminal
receipts gives **99 valid membership receipts**. All 18 new terminal receipts are
valid and retain destructive-finalization evidence. They sum to **10 actual
deactivation occurrences and 14 grace-only occurrences**, with zero touch-only,
grace-and-touch or future-generation occurrences. These are not unique relations
or atomic active-after/presence-equivalence measurements.

One new nonterminal receipt is Lilly-2 **G803 / seq 2552**, run **750533** at
**15:47:31.791 UTC**: source count changed from 18,323 to 18,324, finalization was
withheld, and `deactivatedCount` is **null**, not zero. The same queued revision
later completed **G804**, run **750706**, at **16:20:06.828 UTC**, with valid
exact-generation evidence and two deactivation occurrences. No identities were
paired across generations. The closed Lora-3 G775/776 case was not re-read.

| Cumulative source / stream | Physical attempts | Retry ordinals | Unknown-byte attempts |
|---|---:|---:|---:|
| anomaly/followers_reconcile | 11,957 | 23 | 302 |
| scheduled/followers_reconcile | 846 | 1 | 21 |
| scheduled/followers | 1,476 | 8 | 541 |

Only the **first-page aggregate** contributes: **14,279 attempts**, comprising
14,247 successes and 32 retry outcomes; zero failed/429 outcomes; 864 attempts
with unknown bytes. Known captured bytes total 537,393,523 and exclude unknown
sizes. The signed cumulative difference is **+1,410 attempts**: 1,325 anomaly
reconcile, five scheduled reconcile, and 80 incremental; no additional retry,
failed or 429 outcome, and 79 additional unknown-byte attempts. This is not a
separately queried interval, revision attribution or savings measurement.

HTTP coverage contains **3,244 runs and one unknown run** in the Lora-2 anomaly
reconcile bucket; boundary, known unfinished-attempt and unrecorded-attempt
counters are zero. These grouped counters do not identify a particular run;
the separate timeline explicitly retains the cutoff-crossing partial above.
Repeated aggregate pages were not summed.

All seven reads succeeded, without retries or fallback; the DB lane was released.
No STATE, code, test, provider/socket, recovery, flag or deployment action was
performed by this observation. The coordinator owns the fresh deployment and
configuration receipts. Historical counters are not deployment acceptance.
Presence equivalence, safe suppression, causal savings and event-to-reader latency
remain unproven. Independent review is pending.
