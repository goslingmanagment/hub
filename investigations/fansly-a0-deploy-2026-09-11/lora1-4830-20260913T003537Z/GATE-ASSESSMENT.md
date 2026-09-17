# Seven-day gate assessment — 13 September 2026

The current early-stop candidate can be rejected now. Waiting seven days is
not required to act on a negative result. All nine configured candidates
miss the Lora-1 pointer clearings, and earlier Lilly-1 flags counterexamples
remain valid. This is not a positive A0/A1 acceptance or a shortened gate.

The accepted plan explicitly permits C1, C2 and W0 to proceed independently
after A0 starts (`fansly-events-migration-plan-2026-09-07.md:121`). When A1
fails, full sweeps remain and the other branches continue. The calendar
therefore does not require pausing the entire migration.

| Work | Current prerequisite |
|---|---|
| A0 investigation | Can continue now using retained raw and existing diagnostics. |
| A1 activation | Safe stop and original freshness remain unproven, independently of elapsed time. |
| C1 | Suppression needs a proven redundant-work case and equivalent presence freshness. |
| C2b | First comparison needs two qualifying independent post-enable daily sweeps, not seven days. |
| C2c | Quiet-correction coverage, per-fan max-age and cost must pass before rotation changes. |
| W0 live | Requires the separate test-account label and Management Session; offline preparation is ready. |
| B0 then B1 | Follow W0 and retain their separate transport, coverage and recovery requirements. |

The plan's positive A0 acceptance requires at least seven full days across
six pages plus scenario coverage and explanation of discrepancies. The
original clock remains 10 September 22:58:33.610 UTC; the earliest seven-day
point is 17 September 22:58:33.610 UTC, or 18 September 01:58:33 Moscow.
W0 separately requires at least six hours of continuity testing; B0-to-B1
requires at least seven days of durable shadow. A1 expansion has its own
three-day/seven-day verification windows.

These durations are engineering starting gates, not a statistical proof of
optimal sample size or completeness (cross-check `DECISION.md:160`). A shorter
positive gate would need a concrete, separately accepted scope and scenario
coverage argument. There is no evidence that an arbitrary 48/72-hour window
is equivalent, and the current counterexamples would fail either duration.
No plan, acceptance threshold, flag or automation schedule is changed here.

The historical corpus helps with offline sensitivity but does not replace
runtime-shadow days: it lacks historical pre-apply database state, material
completeness and event-to-reader latency. Neither it nor the current bounded
export proves the >=50% physical HTTP savings goal.

Independent gate review: `/root/quality_c1` checked the plan, reviews, Decision
284, cross-check decision and current evidence. Recommendation: continue the
independent branches now and retain the original A0 observation clock in the
background. The lack of a dedicated W0 test-account label is separate from
the calendar and existing deployment authorization.
