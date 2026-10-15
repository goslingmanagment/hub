# Pending admission withdrawal (protocol 1.2)

An operator may send this message only before accepting a grant:

```json
{"type":"cancelAdmit","kind":"site","requestId":"<siteRequestId>","reason":"ended"}
```

`kind` is `site` for HTTP or `ws` for a CONNECT. `requestId` names the
original request (`siteRequestId` or `connectionId`). Reasons are `ended`,
`wait_expired`, `document_replaced`, and `operator_stopped`. These are
observations that the pending request ended, never commands to retry it.

The authenticated connection supplies the owner generation and RPC epoch.
The engine removes pending work immediately and remembers the id against
duplicate asks. A selection made before a reconnect cannot grant or refuse
a re-asked request of the new connection. A withdrawal crossing a grant
settles that attempt as aborted before sending. The operator still records
a durable not-sent outcome if the late grant reaches it after cancellation.
An already accepted grant uses the existing `siteDone` / `wsDone` path;
withdrawal cannot erase an actual or uncertain send.

An aborted request spends neither a pacing interval nor the site's turn.
Attempts which may have sent still count conservatively. The HTTP producer
withdraws on timeout, document replacement, stop, or any other terminal
event before admission. The WS producer withdraws on CONNECT expiry/end,
document replacement and operator stop, only on the RPC epoch of the ask.

Upgrade the operator image before the engine. The new engine requires
operator minor 2. The new operator suppresses `cancelAdmit` for engines
advertising an older minor so that an image-first upgrade preserves their
existing timeout behaviour without introducing unknown message types.

## Socket document boundaries (F2)

A socket waits at most 2,500 ms from CONNECT, including time behind an older
socket. The engine's HTTP wait setting can shorten this bound, not extend
it. Engine pacing is unchanged; F3 supplies urgent scheduling within this
bound. Timeout is a refusal, never an automatic retry by the operator.

The proxy captures a document-boundary epoch at TCP accept, before parsing
CONNECT. An old TCP connection cannot obtain a fresh epoch by delivering
its CONNECT after navigation. The socket gate withdraws pending admissions
before operator navigation and on CDP document commits, and admits nothing
during the operator's reload gap. It rechecks epoch, deadline and permission
after the admission's buffer commit, before releasing the CONNECT.

Navigation intent is not proof that an existing socket ended. A new main
document commit provides that proof for CDP sockets of
the replaced session. Their records remain as tombstones, so a delayed old
handshake cannot bind to a new tunnel. A same-process child-frame commit
withdraws waits but cannot identify which socket belonged to that child.
A worker survives its page's navigation. A CDP target detach loses
observation, not necessarily the target itself: an unaccounted socket
fails closed instead of being considered safely ended.

CONNECT has no CDP request/frame id. Its document can be known before its
handshake only when the work tab is the sole possible web target. When
other tabs or workers exist, only the bound handshake establishes its
owner. Document replacement cannot account for an unbound tunnel with an
unknown owner: the existing round-6 timeout still fails closed. Neither
the oldest CDP creation nor its URL is used as a binding proof.
