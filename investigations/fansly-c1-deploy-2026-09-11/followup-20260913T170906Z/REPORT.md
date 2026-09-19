# C1 cumulative observation — 13 September 2026, 17:09 UTC

The exhausted timeline contains **2,493 ordered unique runs** through `743492`. All **2,289** rows from the previous 11:09 snapshot are unchanged. The **204 new rows** comprise 36 valid incremental decisions, 157 partial reconcile chunks and 11 successful exact-generation terminals. The same natural grace/retirement pattern continues; no new failure, missing receipt, OR branch or acceptance result appears.

Window: `2026-09-11T01:05:57.089215Z` to `2026-09-13T17:09:06.021727+00:00`. Collection finished at `2026-09-13T17:09:32.228047+00:00`. Five sequential pages used the same window and first-page upper run ID. Every page is one REPEATABLE READ, READ ONLY transaction as `read_only`, with the reviewed 20-second statement limit. The complete five-page export is **not atomic**. The exporter SHA-256 remains `75bf0c1b841d26cdea469d3f39dd238f7817fdd1d8ed721f57c99f6d86abdf3f`.

| Page | Records | asOf UTC | after → next |
|---|---:|---|---|
| 1 | 500 | 2026-09-13T17:09:08.648995+00:00 | 0 → 727169 |
| 2 | 500 | 2026-09-13T17:09:15.318523+00:00 | 727169 → 731728 |
| 3 | 500 | 2026-09-13T17:09:22.12985+00:00 | 731728 → 736301 |
| 4 | 500 | 2026-09-13T17:09:26.648045+00:00 | 736301 → 740790 |
| 5 | 493 | 2026-09-13T17:09:30.474412+00:00 | 740790 → exhausted |

All report/manifest SHA values, raw read-receipt parity, counts and cursor transitions were verified. Every selected run starts within the frozen window and finishes at or before its cutoff; there are no running or unfinished-in-window rows. [Collection](collection.json), [page manifests](timeline-pages.json) and [summary](summary.json) retain per-page bounds, hashes and receipts. Exhaustion is of the retained diagnostic timeline, not proof of uncaptured facts.

## Decisions and membership

Of **445 incremental runs**, **385** have valid decisions: **286 no-request, 93 count-mismatch only, six count-mismatch plus exhausted-without-known**. All **99** requests came from a valid clean queue and each has exactly one later exact-generation terminal for that page and requested revision. The other **eight** successful terminals are scheduled reconciles. The 36 new valid decisions split into **26 no-request and ten mismatch-only requests**. No new OR combination or pending-at-request case appeared.

The missing incremental receipt cohort is unchanged: **59 partial chunks and one historical failed run**. Partial does not mean failure or no-request. There are no invalid/duplicate decision receipts or unknown request-queue receipts. Exported count/OR arithmetic and queue revision increments agree. Native follower/head IDs and `sawKnownCheckpoint` are not exposed, so hidden checkpoint equality cannot be independently reconstructed.

All **11 new terminal membership receipts** are valid, with exact-generation proof: ten anomaly reconciles and one scheduled reconcile. The cumulative **107** successful terminals have **60** valid terminal membership receipts and the same **47** missing receipts (44 before instrumentation and the three known writer-boundary runs `733622`, `733859`, `734003`). No receipt newly disappears or becomes invalid. There are **61** valid membership receipts across all runs because one historical nonterminal receipt is also retained.

The new terminals record **nine actual-deactivation occurrences** and **seven grace-only protection occurrences**. These are sums across generations, not distinct relations. In particular, a protected row and a later retirement are not linked by identity in these aggregates.

## New natural comparisons

- **Lora-2:** after generation 1595's two grace protections, the next incremental (`741883`) requests revision 1634 on counts 8,135 / 8,133. Generation **1596** (`741939`, **11:51:07.082 UTC**) records two candidates and two deactivations, no protections. The **scheduled** generation **1597** (`742042`, **12:13:02.245**) then records matching 8,133 counts, no candidates and no deactivations. Five later incrementals at 12:44–16:44 match and request nothing (three at 8,133 / 8,133, then 8,134 / 8,134 and 8,137 / 8,137). Keep the scheduled walk in this chronology: later matches cannot be attributed solely to generation 1596.
- **Lora-3:** generation **782** (`742019`) records one deactivation and one grace protection; generation **783** (`742319`, **13:06:40.322 UTC**) records one deactivation with protection buckets zero. Four later incrementals at 14:00–17:00 match and request nothing (three at 7,570 / 7,570, then 7,571 / 7,571). This is a later natural cohort; the previously closed generation 775/776 case is unchanged.
- **Lora-1:** generation **1222** records two deactivations after generation 1221's two grace protections. Later provider/active counts change, and generations 1223–1225 retain additional grace/retirement receipts. The 15:28 comparison matches and requests nothing, but the 16:28 comparison mismatches and requests generation **1226**, which protects one row with zero deactivations. Its subsequent comparison is not in this cutoff.
- **Ari:** generation **63** protects one row with zero deactivations; generation **64** records one deactivation and one grace protection. The next incremental after generation 64 is not in this cutoff.

These are pre-UPDATE aggregates and later independent observations, not an atomic active-after result. Changes in active/provider counts do not identify a particular provider deletion, protected/retired relation or cause. Neither an all-matching scheduled walk nor later matching counts prove redundancy, presence equivalence or that every other walk is necessary. No trigger suppression is justified.

## Retained follower HTTP attempts

| Cumulative source / stream | Physical attempts | Retry ordinals | Attempts with unknown payload bytes |
|---|---:|---:|---:|
| anomaly/followers_reconcile | 9,152 | 23 | 229 |
| scheduled/followers | 1,080 | 2 | 387 |
| scheduled/followers_reconcile | 763 | 1 | 17 |

Only the **first-page** aggregate is used: **10,995 follower attempts**, **26** retry ordinals, zero failed/429 attempt rows and **633** attempts with unknown payload bytes. Follower HTTP coverage has 2,493 runs and zero unknown/boundary/unrecorded/unfinished counters. The previous retained total was 10,102; the cumulative difference is **893 attempts** (736 anomaly reconcile, 85 scheduled reconcile and 72 scheduled incremental), with 58 additional unknown-byte attempts. This is a difference between snapshots, not a separately queried interval, per-revision log reconciliation or savings measurement. Repeated page aggregates, overlapping snapshots and logs are not added together.

The collector performed five bounded read-only exports and local analysis only. No export failed; no role fallback, session termination, code/test/git/PR, provider/socket probe, forced sync, recovery, flag, deployment or automation action occurred. Runtime/configuration/log evidence belongs to the coordinator's separate readback; this report does not establish continuous propagation or attribute a change to a release.

Classification: additional evidence of the existing natural repair/protection path, with unchanged stage diagnosis and no new operational action. Presence equivalence, safe suppression, causal savings and event-to-reader latency remain unproven. Independent [review](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T170716Z/REVIEW.md) passed with no open actionable findings. The previous 11:09 packet's [review](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T110856Z/REVIEW.md) passed; its historical pending label in the central report has been corrected.
