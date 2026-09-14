# W0 continuity runner — implementation ready

Base: `e73513737e19b01bd74a4bfbfc6eeed1ffe56d69` (main with PR 193 / D332).
Branch: `feat/fansly-w0-continuity`. Decision 333.

The separate operator runner can collect one six-hour Lilly-1 connection and two
scheduled receiver-only gaps (30 and 240 seconds). It preserves the short probe's
5–120-second invocation/report shape, shares host/page admission and removes only
its verified container ID. There is no provider HTTP, new flag, business writer,
automatic recovery dispatch or production deployment in this change.

The shared observer streams sanitized received metadata. The first top-level t=1
marker starts a monotonic six-hour clock; it is not verified account binding.
Periodic read-only generation checks allocate no dispatchers and stop on changed
or missing evidence. Host/Node deadlines, output/resource bounds, cancellation,
confirmed cleanup and incomplete-receipt handling make the scenario finite.

Binding, browser fan-out, independent presence, REST recovery, completeness,
savings and event-to-reader latency remain unverified. A successful command means
collection completed only. Lilly-1 is the selected page; no verified Lilly-1
browser/proxy surface was provided to this implementation task. The independent
fan-side observer concerns presence only. All live actions and recovery receipts
remain separate from these offline implementation results.

## Validation on the final candidate

- `NODE_OPTIONS=--max-old-space-size=4096 pnpm check`: PASS, 3,770 unit tests,
  9 existing skips, typecheck/lint/dashboard build. The existing test:unit script
  supplies its own 8 GiB heap; typecheck/lint/build use the stated 4 GiB environment.
- Python launcher suites: 10 short-probe and 8 continuity tests PASS. They cover
  actual host file locks, planned gaps, cancellation, owned-ID cleanup and
  inconsistent/partial receipts; Docker subprocesses are mocked.
- Serial Docker-Postgres/transport batch: 44 tests across 3 files PASS:
  fansly-probe-context.integration.test.ts, fansly-probe-transport.test.ts,
  fansly-dm-material-probe.integration.test.ts. This proves read-only context and
  generation behavior, real loopback HTTP CONNECT/SOCKS transport, and composition
  with main's A0 measurement migration. It makes no provider connection.
- Both short and continuity bundles build (target node22) and pass local
  `node --check`; neither bundle was executed against a provider. Their paths,
  sizes and hashes are retained in validation/build.json.
- Source manifest hashes remained unchanged throughout final validation. A later
  documentation-only sentence names the short launcher's extracted Python helpers.

Final commands/times/exit codes/log hashes: validation/final.json and build.json.
Final test window: 14 September 2026, 15:26:35–15:27:44 UTC.

## Findings fixed and retained failures

Independent review found P1: fsyncSync(1) would run on Docker's stdout pipe and
throw EINVAL before the first connection. Fixed by writing to the pipe and syncing
only the host's regular output files after attach cleanup. Continuation requires
outputSyncConfirmed. A real child-process/pipe regression uses the fixed writer;
the original fsync-on-pipe negative control reproduced EINVAL exactly. No test
substitutes a mocked sink for this descriptor behavior. Partial W0 metadata is not
claimed to be B0's per-fact durable capture.

The first short-launcher Python pass failed one stale extracted-helper import;
fixed in the test. The initial failure, the pre-review green checks (which did
not detect P1), the P1 negative control and final corrected results are retained.
REVIEW.md records the finding and resolution; independent final artifact review
is requested. No original failure log was overwritten.

## Publication and live boundary

This report records the pre-publication validation and review candidate. The
coordinator authorized commit/push/one PR after independent receipt verification;
GitHub records provide the subsequent publication state. No deployment, config
flip, browser operation, provider request or live socket was performed by this
subtask. The root task separately owns deployment and live evidence gathering.
