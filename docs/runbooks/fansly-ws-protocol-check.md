# Fansly W0 protocol check

Authority: the accepted events plan §7 and cross-check DECISION §7; historical
Decision 288, the owner session-choice amendment in Decision 325 and the
generation-bound REST identity preflight in Decision 336.
One W0 draft PR holds offline preparation and later approved evidence. An offline
fixture pass does not establish the live protocol or authorize a new connection.

On 13 September the owner chose reuse of the existing encrypted Fansly REST
session stored by Hub. This replaces the Management-only restriction, including
the previous owner-token prohibition for this selected existing session. It is
the provider credential used by Hub, not an administrative Hub API access token.
The first limited probe on `lilly-1` completed on 13 September; its sanitized
receipt and still-unverified gates are recorded in the stage STATUS.
See [the exact owner choice](../../investigations/fansly-w0-protocol-2026-09-10/OWNER-CHOICE-20260913.md).

## Offline diagnostic export

`scripts/fansly-ws/report.ts` is a local file reader. It does not install a browser
hook, connect a socket, provision credentials or send requests. The old
`ws-tap-snippet.js` remains historical defective evidence; do not run it.

For synthetic fixtures, or separately approved test-account evidence, create one
private JSONL record per received frame with exactly this source convention:

```json
{
  "direction": "received",
  "url": "wss://wsv3.fansly.com/?v=3",
  "receivedAt": "2026-09-10T18:00:00.000Z",
  "frame": "{\"t\":2,\"d\":\"{}\"}"
}
```

The actual JSONL file has one JSON object per line. Timestamps are local receipt
times in UTC, not provider emission times. Restrict the source file to mode 0600
and keep it in approved private evidence storage. Do not export auth, full browser
logs or correspondence into a shared artifact to feed this tool. Outbound lines
are excluded defensively; this is not permission to collect them.

Create a private random correlation key once per experiment, without printing it:

```sh
node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {writeFileSync} from "node:fs"; writeFileSync("correlation.key", randomBytes(32), {flag:"wx",mode:0o600});'
node --import tsx/esm scripts/fansly-ws/report.ts received.jsonl correlation.key report.json
```

Use the same private key for paired independent observations of that experiment;
otherwise pseudonyms will not match. HMACs support selected message/group/receipt
comparisons; they do not identify every event or prove absent events. The key and
raw inputs stay outside the report. The output is mode 0600 and never overwrites
an existing file. No input path or filesystem/parser error is printed on failure.

The report contains fixed field names and no payload values except bounded numeric
type codes. Unknown names contribute only a count. Unknown wrappers, malformed
children and partial batches remain explicit; `truncated` is an incomplete
diagnostic, not successful coverage. Limits: 1 MiB per frame, 256 nodes, depth 8,
10,000 input lines (including blanks), 32 MiB input/output. Keep original approved evidence separately;
this report cannot replay frames or replace B0's raw-before-route journal.

`session_verified_frame` only means the envelope had type 1. Pong never means
authenticated. Neither label verifies actor/page/scopes or even the source's
claimed direction. `candidate_inner_service` is an alternate shape for research,
not a confirmed account-socket wire form. No receipt here certifies business
materialization, presence, fan-out, completeness or event-to-reader latency.

## Bounded existing-session probe

The separate probe now reuses the encrypted REST session. It opens one fixed
`wsv3` connection for 5–120 seconds, with no reconnect, REST request, pacing
write, business writer or credential change. It records received metadata only.
A type-1 frame remains distinct from account binding. The optional receipt
workflow below adds REST identity and generation evidence. Overall
`accountBinding`, completeness, reader latency and stage readiness remain
unverified. The correlation key is ephemeral by default. For an approved paired corpus,
supply the same private experiment key to the offline exporter and probe as
described below. The first live receipt predates that option and cannot be paired.

Build a new private bundle with `node scripts/fansly-ws/build-probe.mjs <new.mjs>`.
The bundle resolves runtime dependencies from `/app/apps/runtime`; source files
or tsx need not exist in the production image. This is an operator artifact,
not an API/worker/scheduler deployment or a new runtime flag.

`scripts/fansly-ws/run-probe.py` requires `--bundle`, `--environment`, `--image`,
`--network`, `--page` and a new `--output` directory; `--seconds` defaults to 120.
Before invoking it, verify the immutable image ID and the existing Docker network.
Copy `launcher_inputs.py` and `launcher_container.py` alongside `run-probe.py`;
the short and long launchers use these same reviewed admission/cleanup helpers.
The private environment file supplies the existing runtime encryption keys and
the existing runtime DATABASE_URL, retained within the trusted production host.
The pool defaults to read-only transactions; every short REPEATABLE READ,
READ ONLY snapshot verifies its mode before reading credentials. No privilege
grant, role fallback or provider-token export is part of execution. Ordinary
psql diagnostics still use read_only.

The launcher uses a disposable container with 256 MiB memory, no swap, 0.25 CPU,
64 PIDs, a read-only filesystem and dropped capabilities. A host-side 150-second
deadline stops attach and removes only this run's verified container ID.
SIGTERM and failed attach shutdown also pass through container cleanup. Short,
long and binding-preflight launchers share host/page admission and the Docker name
`hub-fansly-w0-<page>`; a run UUID label protects ownership. An orphaned or
foreign container is refused, never taken over. Inspect
`execution.json` for confirmed cleanup; a failed removal is unresolved. Do not
run the entrypoint inside a production role's container: V8 heap limits alone
cannot bound undici's fragmented-message buffers, and destroying its dispatcher
does not forcibly close an upgraded socket.

Docker `--rm` may remove the container before cleanup inspects it, or between
the ownership check and removal by immutable ID. Cleanup accepts Docker's complete
`no such object/container` diagnostic for that exact name/ID regardless of message
casing; daemon errors, extra diagnostics and other identifiers remain unresolved.
If an older launcher reports failed cleanup after a successful provider request,
retain the original receipts and verify absence separately with read-only Docker
inspection; do not repeat the provider request to repair the cleanup receipt.

Reports stop at 1,000 frames or 8 MiB of metadata; incoming-message size is checked
after transport delivery. Output and errors stay in the private report directory.
Exit zero requires reaching the deadline, a valid top-level type-1 frame, and
matching before/after credential-route generations. This means a completed short
observation only. With a validated binding receipt, review the separate REST
identity and generation comparison described below. Neither result proves
continuous unchanged generation, socket actor scope, fan-out, presence,
six-hour continuity, savings or reader latency.

## Transport failure receipts

Short reports and continuity terminal observations retain `openedAt` and three
bounded diagnostic fields. `failurePhase` is `connect` for a synchronous socket
construction exception, `pre_open` for an error before the open event, `socket`
for an error after open, or `auth_send`/`ping` for that send's exception. Other
stop reasons have null phase. `pre_open` does not identify DNS, TLS, proxy or
provider failure; `openedAt` plus `sessionFrameSeen` separates open from type-1.

`transportErrorCode` comes from a fixed allowlist at the explicit page dispatcher,
before Undici can discard the request cause. `httpStatus` is the first exposed
101 or 200–599 outer HTTP status; interim 1xx is ignored. HTTP 101 alone does not
prove open, authentication or actor binding. Internal CONNECT rejection status
may be unavailable: leave it null. `UND_ERR_ABORTED` alone does not prove proxy
refusal or an intentional operator abort. Unknown or already-discarded codes
remain null; no error message, response headers/body or secret is exported.

The first error and terminal snapshot survive cleanup unchanged. `closeCode`
stays null when only a later close follows the terminal error. These fields do
not recover missing information in older reports. Preserve the original failed
attempt and inspect the new receipt only during a separately scoped live action;
the diagnostics add no retry or automatic recovery.

## REST identity preflight

For the accepted binding workflow, obtain a new preflight receipt within the
agreed experiment window before the initial receiver connection. Review its
timestamps; there is no automatic expiry policy. The ordinary page verify
endpoint is not a substitute: it writes metadata/recovery state and does not
record the W0 credential/route generation. This preflight makes its own single
GET and stores its evidence separately from the receiver output.

Build the separate operator bundle on the reviewed checkout:

```sh
node scripts/fansly-ws/build-probe.mjs <new-private-preflight.mjs> --binding-preflight
```

After approval of the precise live action, run
`scripts/fansly-ws/run-binding-preflight.py` on the trusted host with `--bundle`,
`--environment`, `--image sha256:<verified-id>`, `--network`, `--page lilly-1` and
a new `--output` directory. Place the reviewed `launcher_inputs.py` and
`launcher_container.py` alongside it. Use the same existing private runtime
environment, immutable image and verified network as the receiver. The launcher
shares host/page admission, resource limits, private output and owned-container
cleanup with the short and continuity launchers. Confirm cleanup in
`execution.json` before starting the receiver.

One verified READ ONLY snapshot supplies the existing session, expected stored
account ID and page dispatcher. The transport issues only
`GET https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true`, with the existing
Fansly header builder and that snapshot's proxy route. It has a 15-second request
deadline and a 1 MiB streamed-body limit. It follows no redirects, retries no
failure and has no direct fallback. Missing expected account ID refuses the GET;
HTTP errors, invalid envelopes and a different account ID fail the preflight.
It performs no WS, database write, pacing reservation or ordinary sync dispatch.

Its private `report.json` records page identity, expected/observed numeric account
IDs, `credentialRouteGeneration`, request timing/status and the match or fixed
failure code. It exports no provider body, response headers, username or auth
material. An admitted GET has `restRequests: 1` in this report; a refusal before
dispatch has `restRequests: 0`. Inspect both this report and cleanup before
proceeding; a failed preflight is not a binding receipt for a new connection.

Pass the successful private file to the short launcher as
`--binding-receipt-file <preflight-output/report.json>`. The launcher validates
and mounts its own private copy. Before connect, the receiver checks receipt
schema, success, page/account and generation against its new credential snapshot,
then rereads the current generation without another token decrypt. Rejected
evidence or a generation mismatch means zero socket attempts. Receiver output
retains a bounded `w0_binding_refusal` receipt for invalid input, a snapshot
mismatch, a changed generation or an unavailable generation read. These reasons
remain distinct; unrelated exceptions use the generic private failure path.
Successful receiver output
records the receipt's SHA-256 and generation comparison under `bindingPreflight`;
`restRequests: 0` remains true for the receiver, while the separate preflight
report accounts for the GET.

Retain both original reports together. The SHA-256 identifies which receipt was
consumed; it does not authenticate externally supplied evidence. This workflow
proves REST identity at the recorded generation and checks receiver generation
at connection boundaries. Overall `accountBinding` remains unverified: the
receipt does not prove continuous configuration history, WS actor scope,
fan-out, presence, completeness or a full W0 pass. Existing short invocations
without this argument remain available without the added REST identity evidence.

## Paired reference comparison

Create a fresh random 32-byte experiment key using the private-key command above.
It is a diagnostic correlation key, not a Fansly credential. Use it for the native
browser Received-frame export and pass its private file to the isolated launcher
with `--correlation-key-file <private-key-path>`. Existing 120-second and page
limits remain. Without this option, the probe still creates an ephemeral key.

Both reports contain `correlationKeyFingerprint`, derived from the actual key.
The launcher validates the supplied file, makes a private mode-0600 copy in its
new output directory, and mounts only that copy read-only into the container.
It removes its copy after execution, including cancellation and failed startup.
Retrieve report/execution artifacts after cleanup; do not archive a running
output directory containing the temporary key. Preserve the original experiment
key privately for the paired browser export, outside shared evidence.

Record the actual observation intervals in a private windows JSON file. These
are operator-supplied intervals, not proof of uninterrupted capture. For example,
this **synthetic** file describes two overlapping two-minute observations:

```json
{
  "left": { "from": "2026-09-14T10:00:00.000Z", "to": "2026-09-14T10:02:00.000Z" },
  "right": { "from": "2026-09-14T10:00:10.000Z", "to": "2026-09-14T10:02:10.000Z" }
}
```

Run the local comparison on the two sanitized reports:

```sh
node --import tsx/esm scripts/fansly-ws/compare-cli.ts \
  browser-report.json receiver-report.json windows.json new-comparison.json
```

Each report is limited to 32 MiB, 10,000 records and 20,000 reference occurrences;
frames retain the existing 256-node limit. Inputs must be private regular files,
and the output is new and mode 0600. Missing/different key fingerprints,
non-overlapping intervals and inconsistent probe counts refuse comparison.
A declared live interval cannot extend beyond that probe's actual observation.
The first live report has no key fingerprint, so it cannot be retroactively used.

The report compares references inside the half-open overlap. It includes the
service, event type and whitelisted entity reference in each comparison key;
group IDs alone never match events. Repeated references remain ambiguous.
Matching entity IDs do not prove identical payloads, event versions, independent
receivers or a shared provider session. Unknown/excluded/truncated frames,
missing probe receipts and abnormal termination remain explicit. Records outside
the overlap are counted separately and are not declared missing deliveries.

An empty or unmatchable corpus is inconclusive. Candidate correspondences are
only inputs to the manual W0 review: `fanOut`, binding, capture completeness and
reader latency remain unverified. Verify page/session provenance and agreed
business objects independently before accepting the live gate. The comparator
has no provider, database, browser-control or business-write path.

## Live gates — each needs explicit approval

Before each newly approved limited probe, record its exact page/account binding,
existing credential and route generations, page proxy, agreed interval,
expected events, observers and stop deadline. Use the separate preflight and pass
its successful private receipt to the receiver for the accepted binding workflow.
Use the existing encrypted
credential path inside the trusted process; never expose raw auth in CLI
arguments, environment exports, stdout, logs, exceptions, clipboard, chat or
diagnostic files. Do not invent a token-reading command or copy a browser token.

The bounded executable uses the existing trusted runtime credential path.
The retained permission read shows why the separate diagnostic read_only role
cannot perform that lookup; no grants to it are proposed.
The public server contract remains unproven. Owner approval of reuse does not
prove compatibility or expand this first probe to other pages. New credentials,
test messages and disruptive experiments require their own agreed scope.
REST polling and its working credential remain unchanged.

1. Observe selected Received frames with the native Firefox Network Monitor.
   Do not patch `window.WebSocket`, copy auth to the clipboard or use global
   Work Offline. An absent socket may require a separately approved test-profile
   navigation or waiting for a normal reconnect.
2. Verify a real type-1 response and review the separate REST identity receipt and
   receiver generation comparison. Establish the socket actor binding and the
   selected session's capability by scope independently.
   A pong, HTTP 101 or historical bundle alone does not pass this gate.
3. Use browser plus one receiver and independent evidence for the same agreed
   events. Distinguish same-token fan-out from separate browser/receiver
   sessions. An independent observer measures presence with browser off and WS
   off/on. No events means this test is inconclusive.
4. On the agreed test account, retain at least six hours of continuity, a
   short and a greater-than-three-minute receiver-only gap, and REST catch-up
   receipts to the prior confirmed boundary. Separate recovered state from
   transient facts that cannot be recovered. Do not assert provider replay.

The first limited probe does not pass the fan-out, presence or continuity gates.
Wider or sustained use remains gated by their evidence and agreed scope.

Stop the test receiver on auth conflict, lost browser delivery, unexpected 4xxx,
transport failure or REST restrictions and investigate before resuming. Do not
call logout, revoke a working session or park healthy REST solely on WS 401.
Keep WS auth failure separate from REST auth failure; do not rotate the stored
credential automatically or retry a failed WS generation indefinitely.
Preserve the timeline, failed cases, unknown scope and recovery receipts.

B0 remains blocked until those gates pass. Its capture ownership, proxy transport,
durability, erasure, generation fences and seven-day shadow are separate work.
This W0 PR contains no durable receiver and needs no production flag.

## Explicit continuity experiment

The separate [continuity runbook](fansly-ws-continuity.md) describes the prepared
Lilly-1 six-hour observation and scheduled 30-second/240-second receiver-only
gaps. Build that explicit entrypoint with `build-probe.mjs <new.mjs> --continuity`.
The short probe's 5–120-second invocation and evidence meaning are unchanged.
All three launchers must come from the same reviewed revision so their shared page
admission applies. No repeated short probes count as a six-hour observation.
