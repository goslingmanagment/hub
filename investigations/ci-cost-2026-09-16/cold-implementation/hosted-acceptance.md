# Final hosted acceptance

Commit: 83ac0e28b75698da011b55635ac3a3a905d3ce81.
Run: https://github.com/goslingmanagment/core/actions/runs/35141164169
First attempt; success; all heavy checks actually executed.

- Unit: 357 files, 4297 passed, 9 existing skips.
- DB: 741 + 965 + 834 = 2540 passed, no skips.
- API: 27 PR cases passed; all 104 cases also passed locally.
- Native image build, Chromium smoke, startup smoke, types, lint, contracts and both proof uploads passed.
- Cost estimate: 46 rounded runner-minutes, no cancelled or rerun work.

Earlier full run used 47 minutes, but the two hosted runs are not a controlled A/B: application main, case counts, build cache and runner timing differ. DB2 rose from 538s to 664s while most matched files also slowed. The directly paired local DB3 comparison preserves all case identities and fell from 226.60s to 216.79s; its import phase fell from 48.41s to 40.28s. Synthetic delay was removed from ordinary scale validation but retained and verified in opt-in benchmarking. Do not project a monthly saving from these samples.

The original intermittent typed-export failures also reproduced without infrastructure edits. A deterministic clock-skew regression fails before the separately committed scheduler-clock correction and passes afterward; three new cases supplement, rather than replace, all original assertions.
