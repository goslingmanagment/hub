# Independent A0 evidence review — 13 September 2026, 23:08 export

Reviewer: `/root/w0_role_tests`. Verdict: no actionable findings in the A0
numbers, evidence limits or shared report's A0 disposition.

This review used retained local files only. It performed no production query,
provider request, application test, code change, flag flip or deployment. C1
collection was a separate assigned operation; this review does not independently
certify C1 or the shared runtime/configuration collection.

The reviewer independently recalculated SHA-256, compared the raw report with
its normalized form, and verified the `read_only` / `readOnly=on` receipt. The
export keeps its original start, `2026-09-10T22:58:33.610+00:00`, through
`2026-09-13T23:08:56.244621+00:00`. Its manifest correctly says that it is not an
atomic snapshot. No sweep key is duplicated; all 787 previous rows remain
unchanged in the 865-row report.

Independent counts agree: **613 complete, 252 incomplete and none running**.
The **78 new rows** comprise **71 complete** and **seven incomplete Lilly-2
generations**: six overlap guards, followed by one uncertified successor.
`completeCoverage=true` does not promote these incomplete rows or certify their
null boundaries. All diagnostic sums and differences in `summary.json` agree
with direct sums from the retained rows.

The last five complete Lilly-2 observations are:

| Generation | Completed UTC | Missing-hot-head occurrences |
|---|---|---:|
| 6870 | 20:27:55.765416 | 2 |
| 6878 | 21:34:50.014303 | 57 |
| 6879 | 21:58:25.312841 | 146 |
| 6880 | 22:28:26.720821 | 146 |
| 6881 | 22:58:17.627656 | 3 |

These are occurrences in separate sweeps, not distinct missing messages or
reader-loss proof. The decrease to three and resumed complete sweeps do not
prove the underlying cause resolved. The shared report appropriately retains
the cluster for natural follow-up without asserting resolution or introducing
an unsupported production action.

The cumulative unknown-material count remains **403,215**, and direct summation
of DM coverage confirms the unchanged **eight lost-report runs**. Four added
flags occurrences and one exclusion-reason occurrence do not identify a
provider deletion or cause. Counters with absent/null historical reason fields
retain that incomplete coverage. Request totals, byte totals and material-lag
samples are not presented as causal savings, wire traffic or fresh-event latency.

The A0 paragraph and disposition in the shared `REPORT.md` agree with these
receipts. A0 remains **NO-GO**; the original seven-day boundary remains
**17 September 22:58:33.610 UTC**. Full polling remains in place. No new owner
decision or production intervention is established by this packet; continued
quiet observation is reasonable. This is not an A0/A1 acceptance or a guarantee
against an unobserved incident.

Reviewed source hashes:

| Artifact | SHA-256 |
|---|---|
| A0 report.json | `c3cc29403d60aa5da94ff1c660a0783c560c226a9f0390cd33ae0ff72ef16676` |
| A0 report.json.manifest.json | `129896b9b62604d41c8d955648b86781082f34aa93011d3a2036fbd118dee80c` |
| A0 summary.json | `cadeb3fb73843fb2d928b9b1cb6a582c8c2528cd02ec646b6361d301bbc7059e` |
| A0 analyze.py | `9f4704b57fa40aefec32c243107e388260097114f758908768a9fe4a2d9c06ff` |
| Previous A0 report.json | `dcb8306951cedb003ba9dea71630a21c3a232daf396c67b473b803359ac2c0fa` |
| Shared REPORT.md at review | `b7abc6530d1dc59afc7c1477e04000bf4f4c1d0d9405c1674dbc885fcb08d585` |

Current A0 files are under
`activation/20260910T225618Z/snapshot-20260913T230856Z/`; the previous report is
under `snapshot-20260913T170727Z/`. The shared report hash pins this review's
readback, not later documentation-only review/completion link additions.
