# W0 transport failure: offline source evidence

The cause of the 14 September live transport failure is unresolved. This
supplement proves diagnostic information loss and narrows what the existing
receipt can establish. It contains no new provider request, production command,
proxy change, credential, raw provider frame or product-source edit.

Analysis and reproduction use checkout
`/Users/dmitriy/.codex/worktrees/hub-fansly-w0-cleanup` at
`1efe1cb42ba730d9cdcb4b7d74d139d87d3abb60`. The invocation records merged PR #198
as `b5900cfcf41a5a29d45a7c8c7c8ee0b2a76dce3e`; its executed operator bundle was
built from `1efe1cb4`. The retained `operator/short.mjs` hash matches
`operator-builds.json`: `57c0cff7d563ca19b03d13b109eec8e8a1b5cec5650f7767638334b9f96dc0a2`.
[Source hashes and comparison](source-provenance.json) and
[numbered source excerpts](source-excerpts.txt) preserve the inspected inputs.

1. **The live receipt proves one failed observation, not a failed HTTP upgrade.**
   `../server-output/report.json` records 20:42:08.221–20:42:08.379 UTC (158 ms),
   `transport_error`, zero frames, no type-1, one connection attempt and zero REST
   requests. `../server-output/execution.json` records process exit 2, no timeout and confirmed
   attach stop, cleanup and output sync. Its stderr and the launcher stderr are
   empty. A constructor exception would yield `connect_error`
   (`connection-observer.ts:106–107`). The transport reason instead comes from
   an asynchronous error event (`:168`) or an auth/ping send exception
   (`:114–126`). The first ping is scheduled after 20 seconds, so that branch
   does not explain the 158 ms receipt.

2. **Open and close evidence is discarded.** The connection observer records
   `openedAt` on the open event (`connection-observer.ts:109–112`) and returns it
   (`:94–99`). The short wrapper selects a smaller field set and drops it
   (`probe-observer.ts:24–28`). The first finish fixes the result (`:84–86`);
   a subsequent close therefore cannot replace `closeCode: null`. The offline
   EventTarget cases reproduce identical short receipts for error before open,
   error after open and auth-send exception, including a later synthetic 1006
   close. This is proof of discarded evidence, **not proof that the live socket
   reached or failed to reach open**.

3. **Local Undici 7.27.2 also loses the original error.** Its WebSocket
   `processResponse` passes a network error/non-101 reason and cause to
   `failWebsocketConnection` (`lib/web/websocket/connection.js:96–110`). That
   function does not retain those arguments (`:306–322`). When no close control
   frame was received, `websocket.js:589–603` emits `TypeError(reason)`; the
   pre-open reason is empty. With the real current `openFanslyProbeSocket` and
   an in-memory rejecting dispatcher, synthetic `ECONNREFUSED`,
   `CERT_HAS_EXPIRED` and `SYNTHETIC_PROXY_REFUSAL` each produced
   `TypeError("")`, null code/cause and the same zero-frame transport receipt.
   Merely retaining `ErrorEvent.error` would not distinguish these cases.
   These synthetic inputs are **not candidates proven to have occurred live**.

4. **The transport constructor and stored generation did not change.** The
   constructor still uses `undici.WebSocket`, the fixed
   `wss://wsv3.fansly.com/?v=3` URL, explicit page dispatcher and Fansly Origin
   (`fansly-probe-socket.ts:13–16`). Constructor, page-context and resolver
   SHA-256 match the first successful live probe's validation manifest; the
   shared HTTP/proxy dispatcher is also byte-identical to that probe's source
   revision `ea0d6405`. The observer was subsequently shared with continuity,
   and the binding preflight was added; these are real source changes, but the
   reviewed diff identifies no deterministic cause of this live failure.
   The first successful probe, current identity preflight and failed probe all
   record the same `c7a7ea0c…` stored credential/route generation. It fingerprints
   stored inputs, not provider state or the browser's session/proxy.

5. **Actual production dependency versions remain uninspected.** The successful
   run used image `c443947a…` (recorded source `380326368fe3`); the failed run used
   `ca60d637…` (recorded source `ac92197ba976`). Their source lockfile and runtime
   and shared manifests are byte-identical and pin Undici 7.27.2. The Dockerfile
   diff moves release metadata labels only. The current release deploy log
   (`investigations/fansly-a0-reader-head-state-2026-09-14/release/deploy.log:415–457`)
   shows a dist-only image based on clean full image digest `32e07032…`.
   Different image IDs alone therefore do not prove a dependency regression.
   Neither image exists in the local Docker Desktop image store; no image was
   pulled or executed. The observed local runtime is Node v26.7.0 / Undici
   7.27.2. Production Node/OpenSSL/installed Undici cannot be inferred from it.
   The old launcher copied a limited DB/encryption environment; the current
   invocation uses the existing production env file. Effective runtime/TLS
   environment equivalence is not covered by the stored generation hash.

Reproduce locally from the reviewed checkout:

```sh
node --import tsx/esm /Users/dmitriy/code/goose/hub/investigations/fansly-w0-continuity-2026-09-14/paired-preparation-20260914T202652Z/offline-diagnosis/offline-repro.mjs "$PWD"
```

[The script](offline-repro.mjs), [result](offline-result.json) and
[execution receipt](execution.json) retain four observer cases and three real
Undici cases. Exit code is zero and global fallback calls are zero. Both the
explicit and global dispatchers reject in memory; no real connector is used.
The saved stderr contains only the local Node/tsx deprecation warning.

Existing evidence can still support read-only comparison of actual runtime
packages/effective TLS settings or already-retained proxy/upstream logs for the
failure interval, if available. None was inspected here. The empty process logs
cannot recover a cause that was never recorded. The healthy native browser
socket independently proves browser delivery; it does not prove the receiver's
upgrade, route, session scope or fan-out. No retry or full W0 acceptance follows.

The smallest useful follow-up is one W0-only diagnostic receipt change: retain
the already-collected `openedAt`, add a fixed `failurePhase`, and capture a
strictly allowlisted transport code plus numeric handshake status at the
**explicit dispatcher's request-handler boundary**, before Undici converts the
error. `Dispatcher.compose` is present in the installed 7.27.2 implementation
(`lib/dispatcher/dispatcher.js:20–48`); it adapts legacy Fetch handlers to modern
callbacks through `WrapHandler`. A local interceptor can record
`onResponseError` before forwarding it, and status from `onResponseStart` /
`onRequestUpgrade`, while forwarding every callback with the original receiver,
arguments and return value. `fetch/index.js:2326–2335` is the original request
error boundary; it still receives the synthetic code before WebSocket loses it.

Phase must describe an observed boundary, not an inferred cause: `connect`
before request-start, `handshake` from request-start until open, `auth_send` for
that send's catch, `socket` for an error after open, and `ping` for that send's
catch. Unknown codes stay null; bounded cause traversal uses an exact code
allowlist. Do not retain messages, arbitrary error names, URLs, headers, bodies,
proxy credentials or socket data. Snapshot the first failure so cleanup aborts
cannot overwrite it. The interceptor must use only the already-owned page
dispatcher, with no global diagnostics subscription, second request, alternate
route, retry, dependency change or runtime deployment. Original dispatcher
ownership and cleanup stay with the caller. This proposal is not implemented;
compatibility and forwarding behavior still require focused tests before use.
