# Fansly W0 protocol check

Authority: the accepted events plan §7 and cross-check DECISION §7; Decision 288.
One W0 draft PR holds offline preparation and later approved evidence. An offline
fixture pass does not establish the live protocol or authorize a new connection.

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

## Live gates — each needs explicit approval

Before any probe, record the exact test account/page, dedicated Management
Session, credential/route generation, its page proxy, agreed interval, expected
events, observers and stop deadline. Confirm page/account through the authorized
REST path; do not substitute an owner token or migrate all REST streams to the
Management Session. Credential creation/revocation and sending test events are
separate actions. No such action is implemented by this reader.

1. Observe selected Received frames with the native Firefox Network Monitor.
   Do not patch `window.WebSocket`, copy auth to the clipboard or use global
   Work Offline. An absent socket may require a separately approved test-profile
   navigation or waiting for a normal reconnect.
2. Verify a real type-1 response and page/actor binding with REST evidence for the
   same credential generation. Record Management Session capability by scope.
   A pong, HTTP 101 or historical bundle alone does not pass this gate.
3. Use browser plus one receiver and independent evidence for the same agreed
   events. Distinguish same-token fan-out from separate browser/management
   sessions. An independent observer measures presence with browser off and WS
   off/on. No events means this test is inconclusive.
4. On the dedicated test account, retain at least six hours of continuity, a
   short and a greater-than-three-minute receiver-only gap, and REST catch-up
   receipts to the prior confirmed boundary. Separate recovered state from
   transient facts that cannot be recovered. Do not assert provider replay.

Stop the test receiver on auth conflict, lost browser delivery, unexpected 4xxx,
transport failure or REST restrictions and investigate before resuming. Do not
call logout, revoke a working session or park healthy REST solely on WS 401.
Preserve the timeline, failed cases, unknown scope and recovery receipts.

B0 remains blocked until those gates pass. Its capture ownership, proxy transport,
durability, erasure, generation fences and seven-day shadow are separate work.
This offline PR contains no deployable receiver and needs no production flag.
