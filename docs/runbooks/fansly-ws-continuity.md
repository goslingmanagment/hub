# W0 continuity experiment on Lilly-1

This is the operator-only continuity collection step in the accepted Fansly
migration plan §7. It keeps the existing encrypted REST session and page proxy.
It does not enable B0, route events, change polling or claim W0 acceptance.
The selected page is `lilly-1`; another creator page is outside this runner.

## Before a live run

Retain the explicit experiment approval, immutable runtime image, source/bundle
hashes, Docker network, page/credential-route fingerprint, stop deadline and
selected test objects. A deployment approval does not itself identify a browser
session or prove paired delivery. The earlier 120-second Lilly-1 probe remains
separate historical evidence.

Use the trusted host's existing private runtime environment file; no provider
token is copied into arguments, logs, artifacts or new environment variables.
The process reads credentials in short REPEATABLE READ, READ ONLY transactions.
Ordinary SQL diagnostics still use `read_only`; no grants or role fallback.

Prepare one private random correlation key using the W0 protocol runbook. A
matching Lilly-1 browser observation uses the same experiment key, never the
Fansly credential. Native Received-frame evidence is external to this runner.
A separate fan-side observer is needed only for the independent presence
baseline/off/on/decay experiment. Missing presence evidence remains pending.
No browser launch/navigation, global Work Offline, test message, logout, token
rotation or revocation is performed by the scripts.

## Build and launch the explicit experiment

Build on the reviewed checkout:

```sh
node scripts/fansly-ws/build-probe.mjs <new-private-bundle.mjs> --continuity
```

After the precise live action is approved, run `scripts/fansly-ws/run-continuity.py`
on the trusted host with `--bundle`, `--environment`, `--image sha256:<verified-id>`,
`--network`, `--page lilly-1`, `--correlation-key-file` and a new `--output` directory.
Deploy all four launcher modules alongside it: `launcher_inputs.py`,
`launcher_container.py`, `continuity_receipt.py` and `run-probe.py`. The Python
scripts require Python 3.11+ on a Unix host. Do not use the old short launcher
concurrently: host admission is shared by the reviewed short and long launchers.

The scenario has exactly three connection attempts, with no automatic retries:

1. One socket remains observed for six hours starting at its first valid top-level
   type-1 envelope. That envelope is a frame marker, not a verified account or
   permission assertion. Wall-clock changes and repeated type-1 frames do not
   extend the monotonic duration.
2. Confirm removal of that owned receiver container, wait 30 seconds with no
   receiver, then observe one new connection for two minutes.
3. Confirm removal again, wait 240 seconds, then observe one new connection for
   two minutes. Both resumed connections must retain the first generation and key.

The nominal duration is six hours eight minutes thirty seconds, plus setup and
cleanup. Host deadline: six hours fifteen minutes, followed by bounded cleanup.
Each connection also has a Node deadline (observation +30 seconds) and host attach
deadline (+45 seconds; short probe remains 150 seconds). There is no resume after
an unexpected failure and no scheduled automation created by the launcher.

## Limits and stop behavior

Each disposable container has 256 MiB memory, no swap, 0.25 CPU, 64 PIDs, a
read-only filesystem, no Linux capabilities and a 128 MiB V8 heap. It owns a
fresh page dispatcher independent of the ordinary REST adapter. Docker daemon
logging is disabled. A host file-size limit caps each stdout/stderr file at
64 MiB. The metadata writer further limits the experiment to 20,000 records and
64 MiB total (18,000/56 MiB first phase; 1,000/4 MiB each resumed phase).
The 1 MiB received-frame limit applies after undici delivers a message; container
memory is the independent bound for fragmented transport buffers.

Sanitized received metadata is streamed through Docker attach into private JSONL
files. After attach shutdown the host fsyncs the regular output files and reports
`outputSyncConfirmed`. Container stdout is a pipe and is never fsynced. A partial
stream remains useful evidence, but writes before the host sync are not claimed
durable across host failure. There is no B0 raw business journal here.
Output failure, exhausted limits, malformed input, auth error, missing pong or
unexpected close stops the receiver. Unknown valid envelope types stay visible.
No frames are silently skipped to make the duration pass.

Every 30 seconds a generation-only snapshot checks the same credential/page/proxy
fingerprint without decrypting another token or creating a dispatcher. Each read
has a five-second wait bound. Missing/deleted/changed state, a failed read or lost
DB connection aborts the observer. Record the sampled intervals: these checks do
not prove continuous configuration history between samples. Final generation
proof is required for a completed collection, but never establishes binding.

Both launchers hold the same host/page file lock. Docker's page-specific name
also refuses an orphan left by a killed launcher. Cleanup checks the run UUID
label and removes the matching immutable container ID only. A foreign container
or failed cleanup prevents the next gap/connection; inspect the receipt instead
of force-removing an unrelated container. This is single-host experiment
admission, not B0 worker ownership or a security sandbox.

SIGINT/SIGTERM cancels the entire experiment, including a planned gap. Allow the
bounded cleanup to finish. The launcher's own PID/terminal is the stop control;
there is no production config flag. Confirm `cleanupConfirmed` before treating
the receiver as stopped. Stopping the experiment leaves healthy REST running.
WS failure never invokes logout, revokes the credential or parks ordinary REST.

## Evidence and acceptance

`report.json` is an atomic progress/final summary. Each phase keeps
`receipts.jsonl`, `execution.json` and bounded `stderr.log`. The host validates
record ordinals, counts, duration, final generation and the final completion
receipt; hashes identify the retained streams. Missing final output, interrupted
gaps, unknown cleanup or receipt disagreement stays incomplete. A successful
exit means collection completed only.

The host records the confirmed receiver-absent wait, not an invented exact
provider disconnect/replay interval. Use each connection's actual open/finish
and host cleanup timestamps to review the short and greater-than-three-minute
gaps. The first six-hour phase is measured separately; short resumed phases are
never added to it to meet the duration.

Binding, fan-out, presence, reader latency and REST recovery are not auto-passed.
Attach independently verified page/account binding through the existing authorized
REST path for the same credential generation and the paired native browser
observation. Matching HMAC entity references do not prove payload/version equality.
The current comparator accepts bounded short reports; this long JSONL stream is
a new evidence format and must not be relabeled as a short probe.

Before each planned gap, retain a confirmed boundary for the agreed thread and
business objects. Leave ordinary REST discovery/message reads running. Attach
existing capture/run receipts identifying page, group, request cursor, retained
payload and capture time, the actual walk to the prior boundary and required
reader results. Distinguish recovery during the gap from recovery after reopen,
and recovered persistent state from transient facts that remain unrecoverable.
No events is inconclusive; a generic successful run or complete thread label
alone does not prove this recovery. Missing permitted receipt access stays unknown.

Do not call `sync.thread.backfill` as a generic new-head catch-up: it normally
starts at the oldest stored message and walks backward. Its start-before field
is an input boundary, not proof of recovery through a previous head. This
experiment adds no provider reads or automatic recovery dispatch. B0 readiness
remains an independent review of all required evidence, not the process exit code.
