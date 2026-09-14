# Independent W0 continuity review

Reviewer: `/root/review_w0_runner`. Base:
`4e18d130ea6ca4b834141789265cce8442f8fcae`.
Initial source freeze: 21 paths in `source-manifest.json`, SHA-256
`d9dd6aaac129b7a405e56ca20cba858b56f7693c69bd337db6c2bab473e8f398`.
This review performs no tests, production operations or code edits.

## Finding and resolution

**R1 / P1 — fsync on container stdout prevents collection.** The frozen
`continuity-cli.ts` writes a line and then calls `fsyncSync(1)`. Inside the
container, descriptor 1 is Docker's output pipe, even when Python directs the
Docker CLI's stdout into a regular host file. Fsync on that pipe fails with
EINVAL. The first started receipt therefore throws before a socket is opened.

Remove the fsync from container stdout and apply any durability operation to
the host-owned regular output file. Add a process regression with piped stdout
that would fail on the previous code. Keep the runbook's durability wording
aligned with when host fsync actually happens. The author confirmed the finding;
the correction is independently reviewed below.

## Remaining source review

The three phases satisfy the plan's bounded collection shape: one six-hour
connection measured monotonically from the first valid top-level type-1 frame,
then two two-minute observations separated by receiver-only gaps of 30 and
240 seconds. Repeated type-1 frames do not extend duration. Unexpected errors,
close, missing authentication/pong, output limits or generation uncertainty
stop collection without a reconnect. This is collection evidence, not a claim
that the account, fan-out, presence or recovery gates passed.

Shared launcher modules keep the short-probe duration contract and enforce one
host/page flock throughout the experiment, including gaps. The common Docker
name rejects an orphan; cleanup verifies the per-run label and uses the immutable
container ID. A foreign container is never removed. Failure to confirm removal
prevents starting a gap or the next connection. This is cooperative single-host
admission; the runbook does not claim a distributed receiver lease.

The isolated container retains independent memory/CPU/PID/heap limits, disables
Docker logging and bounds regular host output files. The metadata writer limits
records and bytes without buffering a six-hour corpus, reserves final status
space, and stops instead of dropping frames to produce a successful duration.
Cancellation during observation or a gap retains incomplete evidence and uses
bounded owned cleanup. Caller-controlled diagnostics cannot introduce provider
requests, credentials in arguments, global browser offline or production flags.

The context extraction preserves the existing generation calculation and initial
credential/proxy validation. Periodic snapshots compute that generation without
decrypting another token or allocating a dispatcher. They remain short READ ONLY,
REPEATABLE READ transactions; an unavailable or changed sample aborts collection.
The initial/final and sampled checks do not prove uninterrupted configuration
history, account binding or continuous permission validity. The runbook preserves
these limits and requires independent browser/presence and REST recovery evidence.

Tests cover the long monotonic clock, more than 1,000 pongs, sampled generation
failures, stop conditions, fixed phase arguments, receipt limits, inter-phase
identity, shared admission, gap cancellation and immutable owned cleanup. The
initial suite omitted the actual container-stdout boundary identified in R1.
The implementation uses focused modules and ordinary control flow; no unrelated
runtime, worker/journal, provider recovery or polling behavior is introduced.

## Corrected source follow-up

**R1 is resolved; no outstanding source findings.** The final review freeze is
`source-manifest.json`, SHA-256
`d0622d9d3bdd81d8e61e266b26cc959354372040feaa3588ad537bcbd11b9bb6`.
All 22 listed file hashes were independently verified against the working bytes.
Base is now `e73513737e19b01bd74a4bfbfc6eeed1ffe56d69`; its only incoming topic
is the separately reviewed A0 material-cost function, with no W0 runtime overlap.

The actual CLI delegates to `writeContinuityLine`, which writes complete lines
to its pipe without fsync. The regression starts a real child with piped stdout,
calls that same writer, and checks its exit and parsed started/finished records.
It exercises the missing descriptor boundary without provider or Docker access.
Host sync now opens the regular output files after attach shutdown and records
`outputSyncConfirmed`; failure prevents further phases or short-probe success.
The runbook correctly limits durability to the host sync, preserving incomplete
streams without claiming per-record crash durability.

The narrow follow-up also restores the exported short `ProbeObservation` type.
The observer's deadline re-arms against the same monotonic target when timer
rounding fires early; it neither extends that target for repeated type-1 frames
nor accepts an observation shorter than six hours. It retains cancellation and
the separate host/Node limits.

Decision 333 is an append-only entry after existing Decision 332. It accurately
describes three connection attempts, owned cleanup, unchanged REST, sampled
generation evidence and separate binding/fan-out/presence/recovery gates. It does
not claim a successful collection is B0 readiness or a production measurement.

Final validation is being rerun by the author on this corrected source; this
review did not run or independently reproduce those tests. The earlier passing
candidate's tests did not exercise the descriptor defect and are not treated as
validation of the corrected tree.

## Final validation artifact follow-up

Final source manifest SHA-256:
`5dbb0a4ab7cbf517e230f3e4bc8549638c768c6c258f990f2bb912e0588a4677`.
All 22 source/document/test hashes verify. The only later source-manifest change
is a protocol-runbook sentence requiring the extracted short-launcher Python
helpers; it is consistent with the reviewed imports. No executable or test
changed after the corrected validation.

Independently verified the five retained log hashes and outcomes referenced by
`validation/final.json`: the old pipe-fsync control fails with EINVAL as expected;
`pnpm check` passes 3,770 tests in 327 files with 9 existing skips and a successful
build; Python passes 10 short-launcher and 8 continuity tests; the serial
PostgreSQL/transport run passes 44 tests in 3 files. These are author executions
whose raw outputs were reviewed, not additional tests by this reviewer.

All four build/syntax-check log hashes in `validation/build.json` verify. Both
retained bundle sizes and SHA-256 hashes match their files. The build targets
node22; a local syntax check is not provider execution or a six-hour live result.
STATUS and the draft PR correctly preserve that limit, the prior missed defect
and the separate acceptance requirements.

**Final disposition: source, fixes and validation receipts are ready for the
coordinator-authorized local commit, push and one PR.** No source findings remain.
Merge, deployment and live experiment execution were not performed or authorized
by this independent review.

## Publication packaging follow-up

Manifest SHA-256 is now
`5f3837f20a5b01c6232a0194851042992e28d64fb452000960a055327575d17a`;
all 22 source hashes verify. The sole subsequent executable-file byte delta is
removal of two trailing newline bytes in `launcher_inputs.py`: appending those
two bytes recreates the reviewed `b8b6b539...` hash exactly. No statement changed.
The final hash is
`6e20886cd5559cc911ec8f86fa795a6da3a8eeb5dc08e5eff182aec39118b0e4`.

All nine final-test/build log archives decompress to the original hashes already
reviewed above. Receipts distinguish archive filenames from original log hashes;
the raw logs are retained locally and are not edited to silence whitespace checks.
This packaging correction needs no new test run. The clean publication disposition
remains unchanged.

## Decision-number and traffic wording follow-up

Compared with published head `f208d2fac357457b6bdab37a9d26d81824d31acd`,
the W0 decision row and heading change only from 333 to coordinator-assigned
334. Existing main decisions remain intact; no contents of concurrent PR194
are imported or assumed merged. Current PR/STATUS references use D334, while
the earlier review/validation fingerprints remain historical evidence.

The continuity runbook now explicitly separates HTTP Upgrade and WebSocket
authentication/ping traffic from zero additional REST requests and T0 attempt
accounting. This corrects an overbroad traffic description without changing the
three-connection experiment or claiming zero provider cost. Current PR/STATUS
wording matches that scope.

Verified all 22 hashes in final manifest
`9c946e926f5b531dfebd5b6e524838445d37f32307d501af5675cae66b580c27`.
Only decisions.md and the continuity runbook differ from the published manifest;
the other 20 entries, including all code and tests, are unchanged. No new test
run is needed for this documentation-only correction. No findings remain;
the coordinator-authorized correction may be committed and pushed for fresh CI.

## Main 4d9cac4a composition follow-up

Independently compared previous base `e73513737e19b01bd74a4bfbfc6eeed1ffe56d69`
and topic `a459032b51eb17800cc825d5ca498d7e59caced3` with new base
`4d9cac4acffbbf1cbb17b74cac0b4d76f01ce65d` and rebased head
`961eef6fa0d71b2b5070ea0573ff1adb1af98549`. The executable/test patch is
byte-identical (SHA-256 `252a6e8112810316e7819782c5b2324e799a09d50ff01dde9c7932054b7d15a4`).
Every prior topic file is byte-identical after rebase except decisions.md.

The manual decision resolution retains all incoming main bytes, including D333,
and inserts the unchanged W0 D334 reference row and complete section. Removing
those additions recovers main plus the single blank separator before the new
section. Incoming follower outreach, AI, contracts and erasure paths are disjoint
from the W0 source paths; no runtime conflict or extra topic change was introduced.

All 22 current source hashes verify; manifest SHA-256 is
`70033ea58702cfad2fb6508833b682a20d7707bde5bea09d42186a56f5cedb4f`.
No findings. Prior validation remains valid for the unchanged topic source; the
author is separately running the requested composition checks and fresh PR CI.
This review performed no tests, production calls or branch mutations.

## Main 4d9cac4a validation receipt follow-up

Verified both lossless archives named by `validation/composition-main-4d9.json`
against their recorded original log hashes. The exact reviewed composition passed
`pnpm check` with 3,776 tests and nine existing skips in 328 files, and 49 serial
PostgreSQL/real-transport tests across four suites, including incoming follower
outreach. Both commands exited zero between 15:49:33 and 15:50:30 UTC. All 22
source manifest hashes remain unchanged. No findings remain; the reviewed
composition and evidence are ready for the coordinator-authorized publication
and fresh CI. This review did not execute tests or production actions.
