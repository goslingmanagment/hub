# Independent C2b review — September 14, 11:09 UTC

Reviewer `/root/w0_role_tests`, 2026-09-14T11:17:22.833580+00:00.
Local retained-artifact review only; no production, browser, tests, source or state edits.
Packet: `/Users/dmitriy/.codex/worktrees/hub-fansly-c2b-shadow/investigations/fansly-c2b-earnings-shadow-2026-09-10/activation/20260912T233234Z/observation-20260914T110906Z`.

**Passed; no actionable findings. One of two subsequent daily sweeps qualifies
under the retained transition-exclusion rule. Final observation delivery and
C2c acceptance remain pending.**

All **10 current** and **11 previous** manifest entries verify. Previous packet:
`observation-20260914T051301Z`. Raw/stdout and empty-stderr hashes match the
successful execution receipt. SQL is unchanged and explicitly uses
`read_only`, REPEATABLE READ READ ONLY, 15-second statement and 1-second lock
limits, then ROLLBACK. Identity reports `read_only`, `readOnly=on`,
`isolation=repeatable read`. Process bounds remain 25 seconds, 1-second kill
grace and a 40-second outer deadline. No fallback or provider call is recorded.

The only non-timestamp changes are:

- Each endpoint's receipts, valid checks and visits increase **99 → 198**.
- Last completed daily sweep advances from **September 13, 10:53:03.993** to
  **September 14, 10:53:41.787 UTC**.

Tracked fans and checked-within-24-hours remain **99 per endpoint**. Changes,
changes without a signal, pending/retry, active/expired claims, missing receipts,
never-checked, older checks and unknown attribution remain zero in this scope.
Outcomes stay `observed`; **tracked_scope_complete=false** is preserved. Scoped
zeros do not establish roster completeness, quiet corrections or maximum age.

The endpoint deltas and checkpoint are corroborated by the independently parsed
worker log: **49 partial chunks then one success**, 10:44:27.247–10:53:41.800 UTC,
lifetime **99 attempts**, monthly **100 including one retry**, zero terminal
failures. The last success is 13 ms after the new checkpoint completion. This is
additional physical-walk evidence; counters are not added or labelled savings.

Qualification follows the previously retained fallback: keep the first
post-activation completion excluded, then count subsequent distinct complete
daily sweeps with ordering evidence and no known instrumentation interruption.
The new walk follows that excluded transition. Runtime source/image/start times
and C2b desired version 1/current reported role values match the earlier samples;
no interruption is observed. Logs **do not export** generation, lease sequence,
request source or full-walk start. The report and qualification explicitly keep
full-start and uninterrupted-history proof false. This one-sweep qualification
does not certify those unavailable properties or satisfy the two-sweep gate.

Both stage and activation states exactly include the reviewed qualification:
**two post-activation completions observed, first excluded, one qualifying**,
original clock **September 12, 23:38:22.888 UTC**, observation delivery false.
Current flag aliases match the 11:07:52.603 configuration response, preserving
null exact applied versions and false historical continuity. No state aliases
contradict the report. One more distinct qualifying sweep remains; then the
bounded report must still retain its uncovered cases. No savings, reader latency,
C2c acceptance, flag change or observer deletion is justified now.

## Reviewed hashes

| C2b artifact | SHA256 |
|---|---|
| `manifest.json` | `56b261dcb7ee2c2a68eff4d011c5462ce30207beb33d7e984b9382722a4656e8` |
| `REPORT.md` | `86cf232d8bff429a1bc07799d8f922bcd6ece115f0c6398b96e83a0ef9845282` |
| `read.raw.json` | `2e6eacbb320c55a8c756b50de934e2ed1cafaaa359aa4cf2493679527a2f4508` |
| `read.sql` | `675110ba23d471b2737d046d367b837324a7b1c2f341477b234fa8b0f9172e5f` |
| `execution.json` | `7281639708b4cdb94705b641c984f17989b6a0e02f2851cb3dfefe2a95931158` |
| `comparison.json` | `8cfa20562e25a5bc00638841e4357bff11bb1c81810138b6ccafe82a9d841e96` |
| `daily-sweep-qualification.json` | `ab1420e5281c76342faca67340feecfa1b3ec3b96a65af0e54f12cdbc2112919` |

Previous manifest: `4918c84b13238a46e4ea5db496de94d8ab4d42098b30688f94eb0d4c675fc366`.
Worker log: `56ffa3d85771bf9734c871a4a060b06d4e5f03c0dd9b9bc786caf246cfc283b1`.
Configuration: `3cb1db6d686ef3ac80f10749eb9f19376001fd209976030dfe9a47c7fc694f92`.
State snapshots before root completion aliases: activation
`f21c4217dc3c9c87e74a8018dfcb221103da323c9940a4ae2b703fa62c7d7b59`,
stage `dd96d0618c689115cce59330473243ab878c6175b15a5e69f912f47e5f1d8726`.
Later shared-report/state edits are outside these immutable-artifact hashes.

## Final shared-report consistency check

**Passed; no material mismatch.** Shared `REPORT.md` SHA256
`eaeeb59220acfadef2d07d824bb6c809e648f60ad75577876aeb85963f5fda8d` agrees with the runtime/C2b evidence reviewed here and
the separate independent A0/C1 numerical reviews. A0's 1,009 sweeps / 757 complete /
252 incomplete, +5,397 attempts and unchanged gates; C1's 2,937 runs / 493 decisions /
117 matched requests and preserved historical gaps; C2b's scoped 1-of-2 count all
match. The shared report retains the new capture timeout without claiming repair,
keeps absence of media requests separate from recovery, and claims neither savings
nor latency nor final observation delivery. The quiet disposition is consistent
with no new required owner action and the existing bounded comparison still open.
This is a synthesis check; A0/C1 raw numerical recomputation belongs to their
separate reviewers, not a duplicate review claimed here.

The refreshed A0 and C1 `observed_current_runtime` aliases were independently
matched to the retained Docker, loopback-health and configuration receipts:
keyed role objects/start times preserved, health timestamp current, database field
0 ms, available disk 18,352,444 KiB, and all evidence paths current. Configuration
values, versions, role samples and explicit history/applied-version limits match.
Reviewed A0 state SHA256 `03862641c4bc7634e4bf214c6d6c15461d8b0c2fa0429853542915a5c4572a9d`;
C1 state `53eac5f04fd62060344a13cd010cd9af74a4c9a2c48084b863a0c6bd5cd0fb7a`.
These are pre-completion-alias snapshots. No further writes by this reviewer remain.
