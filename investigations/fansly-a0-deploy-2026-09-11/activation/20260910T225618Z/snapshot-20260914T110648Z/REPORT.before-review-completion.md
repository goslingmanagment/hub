# A0 cumulative observation — 14 September 2026, 11:06 UTC

**1,009 sweeps: 757 complete, 252 incomplete and zero selected running.**
All 937 prior rows are unchanged. The 72 new rows are complete, twelve on each
page. No new state, flags, exclusion-reason or head-rollback counter occurs.
Existing discrepancies and acceptance blockers remain; no changed owner action
is established. A0 stays **NO-GO** and its original clock is unchanged.

One unchanged reviewed reader exported the original window from
`2026-09-10T22:58:33.610Z` through `2026-09-14T11:06:48.704647+00:00`.
The read completed at `2026-09-14T11:06:58.081423+00:00`, with `read_only`,
`transaction_read_only=on`, explicit `BEGIN READ ONLY`, a 20-second statement
limit and a 40-second subprocess deadline. No fallback or failed export occurred.
The manifest count/hash, raw/normalized parity and unique `(page_id, generation)`
keys match. All sweep starts are in the window; no prior row is missing or
changed and no selected timestamp exceeds the cutoff. The existing reader marks
this report **non-atomic**; absence of selected running rows does not prove no
active work. [Invocation](invocation.json), [summary](summary.json) and
[manifest](artifact-manifest.json) retain the exact evidence and local comparison.

| Page | Complete / incomplete | New complete | Latest finish UTC |
|---|---:|---:|---|
| ari-1 | 134 / 35 | 12 | 11:06:30.530797 |
| lilly-1 | 127 / 42 | 12 | 11:02:44.884280 |
| lilly-2 | 122 / 35 | 12 | 10:58:18.171335 |
| lora-1 | 122 / 52 | 12 | 10:48:56.830236 |
| lora-2 | 126 / 44 | 12 | 11:01:39.894377 |
| lora-3 | 126 / 44 | 12 | 10:47:10.735603 |

Lilly-2 generations **6894–6905** each retain one missing-hot-head observation:
**+12 occurrences**, cumulative 165,278. Repeated observations do not identify
unique missing messages, deletion causes or new reader loss. State changes stay
2,405, flags 13 and known exclusion occurrences nine. Lora-1 G4830 remains the
unchanged historical 2,364 runtime rollback/head observations versus 2,363 paired
raw clearings and one pre-apply unknown; the closed investigation is not repeated.

Each added reason field is known on **470 rows** (454 complete, 16 incomplete),
absent on **538**, and explicitly null on **one**. All 72 new rows have known zero
reason counters and zero unknown material checks; historical unknown material
checks remain **403,215**. The 252 incomplete rows retain 231 uncertified/partial
and 21 overlap-guard reasons. Their 23 null boundaries remain unresolved
(16 uncertified, seven overlap); `completeCoverage=true` does not certify them.
The twelve new null virtual-stop rows are Ari-1, not twelve missing diagnostics.
New sweeps retain 93,022 material-lag samples; per-sweep maxima and pending-history
counts remain in the summary. These counters are not event-to-reader latency or
unique debt, and summing per-sweep maxima has no latency meaning.

Physical HTTP attempts total **109,663 (+5,397)**: 4,417 retry ordinals (+1),
4,419 retry outcomes (+1), 1,430 failed outcomes (unchanged) and zero HTTP 429.
The only added retry bucket is Lilly-1 scheduled `fan_earnings`,
`earnings_monthlystats_accounts`, timeout. No new failed outcome is retained.
Media-stat attempt buckets are unchanged; this does not establish recovery of the
previously recorded failure class. The known captured-payload total is
7,235,339,473 bytes (+460,899,383), excluding 146 null-byte buckets; 7,121 attempts
have unknown bytes (+79). These are capture-object bytes, not wire traffic.

HTTP coverage totals **26,242 runs (+1,296)**, with four unknown runs (previously
six), three boundary runs and zero known unrecorded/unfinished counters. The
September 14 scheduled earnings buckets for Lilly-2 and Lora-2 now report zero
unknown runs instead of one each. This is a changed cumulative classification,
not an independently established repair or run-level cause. Four historical
unknown buckets remain. DM coverage totals **11,822 runs (+816)**; failed/lost/
unknown totals stay **34 / 8 / 1**. Zero additional known failures does not fill
unknown coverage or erase old failures.

Cumulative snapshots replace one another; their populations and repeated
observations are never added. Signed counter differences are not an independent
interval census or causal savings. Full polling and the original earliest
seven-day report, **17 September 22:58:33.610 UTC**, remain unchanged; calendar
age alone cannot pass the gate. Runtime/configuration belongs to the coordinator's
separate evidence. No code, tests, Git/PR, provider/socket, flag, recovery,
deployment or automation change occurred. No savings or event latency is claimed.
Independent artifact review is pending. A0-only recommendation: **DONT_NOTIFY**.
