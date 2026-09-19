# Independent observer review — 13 September 2026, 17:06 wake

No open actionable findings in the reviewed A0/C1/C2b/runtime packet.
Recommendation for the scheduled observer: **DONT_NOTIFY**. The known stage
limitations remain; this packet establishes no new required operational action.
An explicit owner status request can be answered separately from that decision.

Two wording findings were corrected and re-read: the shared report now describes
SSE checkpoint age rather than a delivery percentile; the C2b activation report
distinguishes the later 11:10/11:12 receipts from the current 17:10/17:08 receipts.

## Independently checked evidence

- [A0 snapshot](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/activation/20260910T225618Z/snapshot-20260913T170727Z/REPORT.md):
  raw report, manifest, read-only receipt, execution, summary and previous
  11:08 snapshot. Report SHA-256:
  `dcb8306951cedb003ba9dea71630a21c3a232daf396c67b473b803359ac2c0fa`.
- [C1 collection](/Users/dmitriy/code/goose/hub/investigations/fansly-c1-deploy-2026-09-11/followup-20260913T170906Z/collection.json):
  all five raw reports, manifests, receipt parity, ordered cursor chain,
  fixed bounds, helper hash, report/summary and previous 11:09 page union.
- [C2b observation](/Users/dmitriy/.codex/worktrees/hub-fansly-c2b-shadow/investigations/fansly-c2b-earnings-shadow-2026-09-10/activation/20260912T233234Z/observation-20260913T171033Z/REPORT.md):
  SQL, execution, raw identity and comparison with the 11:10 report.
  Raw SHA-256:
  `8541d502715e89462af21dc1605a523f16a094ee213f92047bf9c7f74ac5323b`.
- Runtime: all 12 hashes in `manifest.json`, Docker receipt parity with the
  previous snapshot, health/disk/configuration receipts and bounded worker log.
  Runtime JSON SHA-256:
  `6320a829e16d265043d1249cb1629fae52b470eeeb97e33dc5b9a256adf6a668`.
  Configuration receipt SHA-256:
  `334fecfd32ab1c6900a589257056429d9e6e2993e67d0bf88896ff312066c05a`.

C1 report SHA-256 values, pages 1–5 respectively:

```text
14fd8d51cf996dd4fe5ad81c98cf46c18148723de7f2877980f8f99a8872b737
df915e435b7793a30fd592996d5541a4656c8389b79e7c40ad0383246e96636b
1f3c4e5292478ea9e3742201b7d88c2d4a06fb904f25d3b771f4ab39353a5d66
b735cae1d978b5bf8cf09ae68e065f0b94b1168e0b24be063821783b93428549
7465b089b4187eebeb18e2f0bded581103968ad0133ebc666fbb75665a478e80
```

## Results and limits

A0 has 787 unique sweeps: 542 complete, 245 incomplete, none running. All 713
previous rows are exactly unchanged. New rows are 70 complete and four Lora-1
incomplete: guards 4864/4872, boundary-null successors 4865/4873, followed by
complete 4866/4874. Zero unknown material does not certify incomplete rows.
Four new completed exclusion-reason receipts belong to an already known class;
they do not identify distinct threads or changed values. Unknown material
403,215, lost DM reports eight and unknown DM runs one remain. DM failed runs
rise 26→28, while HTTP failed/retry totals stay 1,037/3,217. Physical attempts
are 86,625, a cumulative increase of 6,956; closed UTC-day groups are unchanged.
The non-atomic snapshot is not a fresh interval census or a savings estimate.

C1 has 2,493 ordered unique runs, with all 2,289 previous rows unchanged.
The 204 new rows are 36 valid decisions, 157 partial reconcile chunks and 11
exact-generation terminals. Of 385 valid decisions, 286 request nothing and
99 request from clean queues; each request has one later matching terminal.
The 47 historical missing terminal receipts and 60 missing incremental
decisions remain. All 11 new terminal receipts are valid, summing nine actual
deactivations and seven grace-only protection occurrences. These sums do not
identify unique relations or atomic active-after state. Later Lora-2 matches
follow both anomaly and scheduled walks; causal attribution is preserved as
unknown. The first-page aggregate alone gives 10,995 attempts, including 26
retry ordinals, zero failed/429 rows and 633 unknown-byte attempts. The complete
page union remains non-atomic and does not justify suppression or presence
equivalence.

C2b shadow data is exactly unchanged excluding `as_of`. The server report is
17:10:36.308747 UTC, with `read_only` / `on` / `repeatable read` identity. Each
endpoint retains 99 baseline checks/visits/receipts, not 198 distinct fans or
additional checks. Scoped pending/change/unknown counters are zero while
`tracked_scope_complete=false`. The 10:53:03.993 completion remains the excluded
transition, with no full-sweep start proof and zero qualifying comparisons.
Two subsequent independent completions with continuity evidence remain needed.

Runtime remains the same source/image, with three healthy roles and zero
restarts. Disk availability is 18,389,212 KiB (17.54 GiB); the ordinary health
receipt contains a 12 ms database probe, not API request or event latency.
The 17:08:36.598–17:08:43.839 UI receipt shows the same three values and active
roles. Effective per-role flag application, versions, uninterrupted history
and the current protected deployment gate remain unverified.

The bounded log has 3,000 parsed lines from 12:02:37.446 to 17:07:13.321 UTC.
Its 305 threshold warnings include the known OFAPI backlog; eight also contain
SSE checkpoint warnings in two episodes. The following 53 warning records omit
SSE; all 30 smoke summaries retain historical gapCount 2,781 and duplicates zero.
[SSE-TRIAGE.md](SSE-TRIAGE.md) records the exact deployed source semantics,
timestamps, dirty-only persistence and uncertainty. No confirmed current
delivery failure, new loss or latency percentile follows from this proxy.

## Current state and completion boundary

A0/C1 central STATE and current report sections, A0 SHADOW-OBSERVATION, both C2b
STATE aliases and its activation report point to these current receipts.
The C2b STATE copies differ only in their preserved historical update record.
All four temporary current pointers and the five shared summary evidence paths
resolve. Current configuration copies match the retained receipt; historical
deployment results remain separate from the unverified current gate.

A0 stays NO-GO. The original A0 clock and earliest seven-day report point,
17 September 22:58:33.610 UTC, remain unchanged; duration alone passes no gate.
C2b retains its 12 September 23:38:22.888 UTC activation clock. Neither bounded
stage report is delivered. No stage acceptance, suppression, attributable HTTP
savings or event-to-reader latency is claimed. Keep the existing observer active.

Review-status aliases and completion hashes were intentionally pending this
verdict and are finalized by the coordinator afterwards. This review used only
local files and exact deployed Git source; it ran no tests or production/UI/API
queries and changed only this review and the authorized SSE triage document.
