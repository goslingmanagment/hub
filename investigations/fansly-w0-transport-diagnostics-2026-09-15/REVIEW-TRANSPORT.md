# Independent W0 transport-diagnostics review

Reviewed 2026-09-14T21:08:58.486011+00:00 by
`/root/w0_role_tests`, independently of implementation. Base/HEAD: `b5900cfcf41a5a29d45a7c8c7c8ee0b2a76dce3e`;
branch `fix/fansly-w0-transport-diagnostics`. Source, tests, installed Undici
7.27.2 and final documentation were read locally. No source changes, Vitest,
provider requests, production reads/writes or browser operations were performed
by this reviewer. Root owns the separate serial validation.

**Verdict: no unresolved correctness, secrecy or lifecycle finding in the frozen
candidate.** One P2 found during review is fixed below. This is code review;
passing execution and publication gates require the root's validation receipts.

## Correctness and transport API

The installed `undici/lib/dispatcher/dispatcher.js:20` compose implementation
adapts incoming handlers with `WrapHandler.wrap`. Its modern callbacks are exposed
in `types/dispatcher.d.ts:223` and implemented in
`lib/handler/wrap-handler.js:53`; the new interceptor uses that actual API.
Each callback invokes the original handler as receiver, preserves controller,
arguments and return value, and forwards the original error without replacement.
This avoids private-field failures from spreading or rebinding the wrapper.
`onResponseStart` records an exposed rejection, while `onRequestUpgrade` records
101 before WebSocket's subsequent handshake validation. Neither marks an open.

Both runtime entrypoints create one diagnostic object for one attempt and use
the existing dedicated page dispatcher. No global instrumentation, new transport,
retry, auth, timeout, route or cleanup policy is introduced. Binding admission
and the existing page-egress refusal execute in their original order. The
continuity runner still uses a separate process for each connection phase.

The shared observer preserves its real open timestamp; the short wrapper now
exports it. Failure phase is the observed code boundary only: synchronous
constructor, pre-open error, post-open socket error or the specific auth/ping
send. Other stop reasons keep null. Type-1 and pong remain distinct. The observer
freezes the transport snapshot before closing the socket; a cleanup abort or
late close cannot change the retained first error/status or invent a close code.
Existing host/process limits remain necessary for upgraded sockets.

## Fixed P2 and secrecy

The first draft read `value.code` three times. A changing getter could return an
allowlisted value during validation and arbitrary secret text during return.
The final implementation reads it once into `const code`. The new regression
supplies exactly that counterexample and requires one getter read and the allowed
snapshot. This reviewer established the defect statically; no negative-control
execution was performed here.

The final helper copies only an exact allowlisted string and a numeric HTTP
status. It reads neither message/name/stack nor response headers/body into the
receipt. Cause lookup is bounded to four objects with cycle detection and
throwing-getter handling. Unknown first errors remain null and are not replaced
by a later, more convenient error. Returned snapshots contain primitive copies.
The helper is small and specific to W0; it does not introduce a generic logging
or transport abstraction.

## Exact limitations retained

Installed `undici/lib/dispatcher/proxy-agent.js:195` receives an internal CONNECT
status, but a non-200 response becomes `RequestAbortedError` whose numeric status
exists only in its message at line 198. The outer interceptor therefore cannot
truthfully recover CONNECT 407 as a numeric status. The implementation leaves
that status null and may retain only `UND_ERR_ABORTED`; documentation correctly
says this code does not identify proxy refusal or who aborted. No error-message
parsing or privileged diagnostic fallback was added.

Installed `lib/web/websocket/connection.js:100` rejects non-101 responses and
later validates upgrade headers before connection establishment. A captured 101
is consequently not an open, authenticated session or binding proof. Errors
already lost at that layer, including some upgraded-socket failures, may still
have null structured code. Historical failed receipts are not reclassified.
D338 and the runbook retain these boundaries and grant no new live attempt.

## Test adequacy reviewed, not executed here

The new focused suite exercises exact callback receiver/arguments/return value,
first unknown error preservation, cyclic/deep/throwing causes, the changing
getter, interim/invalid HTTP status and a late cleanup error after a recorded 101.
Observer tests cover pre/post-open and pre/post-type-1 distinctions, constructor,
auth-send and ping failures, redaction and timer cleanup. Continuity checks the
same fields in its terminal receipt.

The existing real child-process CONNECT and SOCKS fixtures now use compose for
successful TLS/WebSocket delivery, proxy refusal and untrusted TLS. Both add a
real outer HTTP 403 response with a private header, asserting no fabricated open,
no global fallback, no REST pacing and no leaked fixture secrets. Thus the new
handler adapter is exercised through the actual fetch/WebSocket route, not only
mock callbacks. The reviewed tests remain subject to root execution results.

## Frozen files

SHA-256 values below identify exactly the reviewed bytes. STATUS may later gain
validation/publication receipts; that does not silently extend this source review.

| File | SHA-256 |
|---|---|
| `apps/runtime/src/services/egress/fansly-probe-diagnostics.ts` | `601f600ea5c41c0d6fc7ecaff63f407ae9f0844fdb42e4b1a7aadd3773d4cce6` |
| `apps/runtime/src/services/egress/fansly-probe-socket.ts` | `e47ce256999c550faf5a3890643ab5cf772ed94b06621b6deec3d1014b728caf` |
| `scripts/fansly-ws/connection-observer.ts` | `959795973372cb89cdb2eb91d32a338920a12636e3ac98ba14d39d39ec4ca683` |
| `scripts/fansly-ws/probe-observer.ts` | `ae3f2157bc91ced970d24bc21d74dddd2db38f16e24df7e9e08541069f3df582` |
| `scripts/fansly-ws/probe.ts` | `8ec69e820facb09f917eb51573936900992544031c99f78b737cecfd72f0fef2` |
| `scripts/fansly-ws/continuity.ts` | `31ef286abeb453e8852fdb865d47627ad21ae589ce9aa30cd551be29339b0c12` |
| `scripts/fansly-ws/continuity-runtime.ts` | `3cf893c621233346e11d30187cdbd51cfe0afe05d766ce4d9de192ca234c4e24` |
| `tests/fansly-probe-diagnostics.test.ts` | `e17caddcd9b325f7b7aa8e6bf6d2523f3b090db089629e74509c39fa63ae28b4` |
| `tests/fansly-probe-observer.test.ts` | `6fcbbc41fa2d02e499a424022cf138eb200ba6e71add638d417c116bf5d84ae5` |
| `tests/fansly-continuity.test.ts` | `84db09da7aea41698861a37950f5b15a222db857c507de853bbdd073fe0cec9c` |
| `tests/fansly-probe-transport.test.ts` | `3a87ca2633b578f3a6cbf9ad5d43f7b2b38f7ab3f038de7f108dc3280ad84f2b` |
| `tests/helpers/fansly-probe-network.ts` | `4ca70727951b96fd693e8092b186ccbe151b14bb044c70f68ec6d019fa5bcce2` |
| `docs/decisions.md` | `7966132dfa5a6340d48e5ffd9883ed5c2366b283761bc302a4cd408499010ada` |
| `docs/runbooks/fansly-ws-protocol-check.md` | `f2d8229aaea77e2deb22585792e210e2525d669034af2e3898de8b7eb3962a03` |
| `investigations/fansly-w0-transport-diagnostics-2026-09-15/STATUS.md` | `098fd4c4b21a9aaf20c500439bbbfe9a4e9ccd368b5abc8164b90ca0a3cb5cef` |
