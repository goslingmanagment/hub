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
event before admission. The same receiver handles WS withdrawals; their
document-lifetime producer is the subsequent F2 change.

Upgrade the operator image before the engine. The new engine requires
operator minor 2. The new operator suppresses `cancelAdmit` for engines
advertising an older minor so that an image-first upgrade preserves their
existing timeout behaviour without introducing unknown message types.
