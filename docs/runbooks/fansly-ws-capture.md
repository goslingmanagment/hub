# Fansly B0 capture-only receiver

Decision 343 delivers the receiver in the existing worker. Deployment alone opens
no socket: `FANSLY_WS_CAPTURE_ENABLED=false` and
`FANSLY_WS_CAPTURE_PAGE_ALLOWLIST=""` are defaults. The live registry keys are
`fanslyWsCaptureEnabled` and `fanslyWsCapturePageAllowlist`. Empty, whitespace and
`none` select no pages; otherwise use exact comma-separated page labels.

## Activation and rollback

1. Deploy clean merged main including Decision 341's C2b isolation fix. Verify
   source/image and API, worker and scheduler health. Check effective B0 settings
   in the existing configuration UI; the diagnostic feature card exposes both.
2. Before enabling, accept W0: the original REST identity receipt must match the
   current credential/route generation; paired socket/browser delivery, independent
   presence evidence, six-hour continuity and short/long-gap recovery receipts
   remain required. A pong, HTTP 101 or REST 200 does not meet those gates.
   See [W0 continuity](fansly-ws-continuity.md). There is no invented receipt TTL.
   Decision 364 permits the separately bounded early experiment described in
   [the B1 runbook](fansly-ws-hints.md#bounded-early-canary-decision-364): quiet
   gaps stay unknown without forcing another live run; transport failures do
   not qualify. Full polling remains the recovery authority.
3. Set one reviewed page allowlist, verify it, then separately flip the enabled
   flag. Follow the existing one-flag-at-a-time audit ritual. B0 changes no REST
   cadence, and the receiver itself performs no hints, canonicalization or
   business writes. After each capture commit the worker applies the frame to
   the [live overlay](#live-overlay) (no HTTP, no work). Downstream, a captured
   DM deletion frame becomes an exact
   receipt that marks that page's stored copy of the message deleted, text
   kept ([Platform deletions](fansly-ws-reliability.md#platform-deletions)).
   No separate flag gates these marks: adding a page here starts them.
4. Kill-switch: set enabled to false (or remove the page from the allowlist).
   Config polling is ten seconds; failed/stuck checks stop sockets. Verify a
   closed connection receipt within 60 seconds and continued REST health.
   The socket and its dedicated dispatcher are destroyed without waiting for a
   peer close handshake. Frames already received are still captured and
   applied (see the drain below). Do not delete raw, receipts, overlay rows or
   gaps on rollback.

Default-off development/deployment does not wait for W0. B1 additionally requires
at least seven accepted durable B0 shadow days and event diversity for its
explicitly permitted types for general rollout. Decision 364 replaces that
calendar minimum only for the bounded Lilly-1/message-created canary; durable
capture, identity, budgets and the unchanged polling fallback still apply.
These are activation gates, not build gates.

## Ownership, generation and bounded failure

One dedicated PostgreSQL session holds advisory lock `(58213, page_id)` for the
connection lifetime. A lost DB session closes the socket; a second worker cannot
own the page concurrently. Capture transactions lock page/credential/egress rows
and compare the W0 generation digest before commit. A five-second guard checks
generation and records progress; its independent watchdog stops a stuck guard
within 20 seconds. Live config has a separate watchdog.
Failed or stalled live-config reads close connections as `guard_unavailable`;
`disabled` records an explicit flag/allowlist removal or worker shutdown.
Older receivers also recorded config failures as `disabled`, so that historical
reason alone does not prove an operator changed the flag. Keep those receipts.

Only the page resolver's dedicated HTTP CONNECT/SOCKS5 dispatcher may connect to
the fixed Fansly WS authority; there is no direct fallback. Compression is not
negotiated. A pre-assembly wire scanner limits each message to 1 MiB and 4,096
fragments, before Undici can retain an unbounded fragment sequence. The application
queue holds at most 128 frames / 4 MiB, including its in-flight frame.

Auth has a ten-second deadline; pings run every 20 seconds and missing pong stops
within the 30-second deadline plus the five-second check interval. Overflow,
capture failure, transport failure, invalid controls or generation loss stop the
attempt and leave coverage unknown.

A stop first closes intake: the socket is no longer read. Frames it already
delivered (up to the full 128-frame queue) are then captured through the same
fenced writer within 20 seconds, and applied to the overlay within 15 more,
before the attempt row closes; worker shutdown and a live-config `disabled` stop
fit the worker's 60-second stop grace this way. The queue is dropped, never
drained, only when the right or the ability to write is gone: `ownership_lost`,
`generation_changed`, `guard_unavailable` or `capture_unavailable`; a drain in
progress ends at once on any of them. The attempt row's `closed_at` is the
moment intake stopped, not the end of the drain, so the next attempt's
`gap_since` never skips time the socket was not read. Retry backs off to 60 seconds; ten consecutive
unstable attempts pause about 30 minutes with jitter. A durable business capture
or 60 verified seconds resets that sequence. An explicit 401 blocks the same
generation across restarts; disabling/re-enabling cannot erase that evidence.
The block is the `auth_refused` close of the attempt row. If that close is not
confirmed, the worker logs `Fansly B0 auth refusal not confirmed` at error level.
Check the row's `stop_reason`: a `timeout` close may still have committed. If it
did not, only the running page loop keeps the generation blocked. Any restart of
that page's runner (worker restart, disable/re-enable, or a live-config outage
that stops pages) gets one more WS auth attempt with the refused token, so in
this state disabling/re-enabling does not preserve the block.
No automatic credential revocation or proxy mutation occurs.

## Journal and debt

Each attempt has a connection UUID and each accepted frame a local ordinal.
`observations.source=fansly_ws`, kind `fansly.ws.frame.v1`, stores `{codec,frame}`.
Business text stays byte-exact unless a batch contains known transport controls;
those children become `{t,excluded:true}`, preserving original business child
values. Auth, session and heartbeat bodies are never business payloads or logs.
An undecidable/over-limit control scan stops instead of storing possible auth.

Raw, the pending decode receipt and the last committed ordinal are one transaction.
Only after commit does metadata decoding inspect service/event types. Unknown,
invalid and traversal-limited children remain in raw and produce debt; `retained`
means structurally decoded, never approved for routing or applied. Decoder limits
are 256 nodes / eight levels. A settlement failure keeps the pending receipt.

Receipts captured since the live overlay (`live_state` other than `legacy`) get
their metadata settled by the overlay apply, in its transaction. The worker
replays up to 20 pending inline observations captured before it
(`live_state='legacy'`) at startup and on each guard. For an offline,
provider-free repair using the existing operator CLI (it also applies pending
live receipts of the page):

```sh
pnpm cli fansly:decode-ws --page lilly-1 --max-batches 50
```

This is a DB mutation and follows the usual operator approval boundary. Each batch
contains at most 20 rows; output contains only page ID, the settled count and the
live apply outcomes by status. Pending
rows whose raw was tiered or is unavailable are not certified recovered by this
inline repair and remain pending. Unknown/debt receipts require a later explicit
decoder change; B0 does not reinterpret them automatically.

Every connection starts with `gap_state=unknown`, carrying the previous attempt's
last known boundary. Neither reconnect nor REST replay proves transient fact
recovery. Only the owning session closes its row. When that close is lost (the
session died, or the close was not confirmed and was logged as `Fansly B0
connection close not confirmed` with a fixed `closeError` class), the next owner
of the page closes the row with `stop_reason=abandoned` as it starts. A `timeout`
close may still have committed; the row then keeps its real `stop_reason` and is
never abandoned. An abandoned `closed_at` is the row's last guard or capture, not
an observed close. Closed-at NULL with a stale guard means the owner died and no
later owner has started on that page yet; it is not a healthy connection. Never
sum resumed phases into an uninterrupted duration.

Read diagnostics via the `read_only` role in a READ ONLY transaction, without raw:

```sql
BEGIN READ ONLY;
SELECT id, page_id, started_at, verified_at, last_guard_at, last_capture_at,
       last_ordinal, closed_at, stop_reason, gap_since, gap_state
FROM fansly_ws_connections ORDER BY started_at DESC LIMIT 20;
SELECT page_id, state, live_state, count(*), min(received_at) AS oldest
FROM fansly_ws_decode_receipts GROUP BY page_id, state, live_state ORDER BY 1, 2, 3;
COMMIT;
```

## Live overlay

Fansly Sync Engine step 1 (plan §7, §15): a socket message becomes visible in
Hub seconds after it arrives, before REST confirms it. The worker applies each
captured frame in ONE transaction that writes the overlay rows
(`dm_live_messages`), one deliverable `message.live_observed` domain event per
newly visible message (SSE v2 delivers it after the commit's NOTIFY) and the
receipt's ack (`live_state`). The ack never commits without the overlay and
the event, so a crash between the capture commit and the apply commit loses
nothing: the receipt stays `pending` and is applied once by a later path.

* Paths, all on the pool, never on the page's lock-owning session: right after
  each capture (in capture order, one transaction at a time per connection),
  at worker start, and every 5 seconds on a worker-level timer over every
  Fansly page (`skip locked`, 100 receipts per pass, receipts younger than 3 s
  left to the connection; each pass continues after the previous one and
  wraps to the oldest, so receipts that keep failing never starve the rest).
  A page whose socket is down, blocked or disabled is still applied.
* `live_state`: `legacy` (captured before the overlay, never replayed),
  `pending`, `applied`, `debt` (a message without `id`, `groupId`, `senderId`
  or a parseable `createdAt`, the decoder bound, unreachable raw, or a frame
  the database refuses with a data error — SQLSTATE class 22 or a check
  violation — which every retry would hit; the worker logs its SQLSTATE and
  the frame's writes roll back, the ack commits), `skipped` (no message in the
  frame, or every one erasure-fenced). Any other failure, and an erasure in
  flight, leaves the receipt `pending`; an executed erasure fences the erased
  fan's material by material time, like every DM archive writer.
* Socket-only fields (plan §7.3): text, sender, chat, normalized time,
  reply-to, attachment fact and type (ids only). Tips, PPV prices, purchases
  and media access stay REST-only: the overlay has no money column and the
  event carries none. Socket text is vendor text: an unpaired UTF-16
  surrogate (a fan's broken emoji) or a NUL is stored as U+FFFD, since the
  text column and the event's jsonb would refuse it on every retry.
* A deletion is a sticky mark. A deletion before its create leaves a stub
  that the create fills without clearing the mark; a late create, a replay or
  a REST read never clears it. A message deleted before it became visible
  produces no event.
* Step 1 apply creates no work and makes no HTTP request. The event is not a
  `message_archive` projection input, so the archive stays REST-confirmed.
  Which readers show overlay rows is the per-page reader switch below.
* Passive parity (no HTTP): 30 s after a message became visible, and then
  every 30 s / 2 min / 10 min, the worker timer looks for its REST copy in
  `page_dm_messages`, else `message_archive`, and records `confirm_outcome`
  `match` or `mismatch` (`mismatch_fields`: text, sender, time beyond 1 s,
  group, reply; only fields the socket carried). Without a copy after 24 h it
  is `not_found`, or `excluded` when its chat is excluded from message sync.
* Golden signals (`GET /api/v1/ops/metrics`): `dm_visible_lag` (created →
  first visible, p50/p95; step-1 acceptance p95 ≤ 5 s; latch at 10 min),
  `ws_live_pending_age` (oldest pending live receipt, 0 when none; latch at
  10 min: no apply path is acking), `dm_live_parity_bp` (match share of the
  last hour's verdicts in basis points; acceptance ≥ 9 900) and
  `ws_decode_debt` (receipts acked `debt` in 24 h). The last two only inform.

```sql
BEGIN READ ONLY;
SELECT page_id, confirm_outcome, count(*) FROM dm_live_messages
WHERE confirmed_at > now() - interval '1 day' GROUP BY 1, 2 ORDER BY 1, 2;
SELECT page_id, percentile_cont(0.95) WITHIN GROUP (ORDER BY first_visible_at - created_at) AS p95_visible
FROM dm_live_messages WHERE first_visible_at > now() - interval '1 day' GROUP BY 1;
SELECT page_id, mismatch_fields, count(*) FROM dm_live_messages
WHERE confirm_outcome = 'mismatch' GROUP BY 1, 2 ORDER BY 3 DESC;
COMMIT;
```

### Readers, page by page

`FANSLY_LIVE_OVERLAY_READ_PAGES` / live key `fanslyLiveOverlayReadPages`
(console: «Живые сообщения в чатах»): exact page labels, `all`, or `none`
(the default; a `none` anywhere in the list wins). It is read on every
request, so a change applies from the next one without a restart.

* A listed page's chatter routes
  (`GET /api/v1/pages/:page/conversations/:id/messages` and `…/preview`) and
  its AI kernel context (requests without `clientContext`) read
  `page_dm_messages` (resp. `message_archive`) ∪ the overlay rows that store
  does not hold yet, through one function (`readDmLiveUnion`). An overlay row
  is hidden once the reader's own store has a row with its message id (in any
  state, so a REST tombstone is never undone by the socket), when it is
  deleted, and when parity found no REST copy for 24 h (`not_found`: REST
  wins). A socket deletion also hides the store's copy at once. Chats without
  a thread row stay invisible. Money is REST-only: an overlay row has tip 0.
* Each row of a listed page's chatter response carries `source` (`rest` or
  `live`); a `live` row also carries `apiUnavailable`, true in a chat excluded
  from REST message sync (no REST copy will ever replace it: «API
  недоступен»). Pages not listed return exactly the confirmed-only response,
  without these fields. The AI generation's `contextManifest` records
  `liveOverlay`, `liveCount` and `liveError` (a failed union read serves the
  archive).
* Agent Read, the archive routes, search and timelines read REST-confirmed
  stores only, on every page.
* Rollout (plan §15 step 1): `ari-1` first, then the other pages after one
  hour of observation each; rollback: `none`.

## Erasure and retained limitations

The tagged raw codec searches nested JSON strings, escaped Unicode, fan refs and
resolved conversation-group refs consistently in inline/CAS and tiered lake data.
Capture fences pre-erasure queued material. Page/model erasure removes the raw,
both B0 operational tables and the live overlay through the existing sanctioned
erasure path. Fan erasure removes the fan's overlay rows: their messages, every
row of their chats (including a chat only the socket has named, which also
joins the erasure's resolved group fence) and every row an erased frame made.

B0 cannot certify exclusive fan attribution for a whole unknown/batched envelope.
Fan erasure therefore counts matching WS observations as shared/unknown-exclusive
residuals and keeps them, rather than deleting bystander facts. This is an explicit
incomplete fan-erasure result under the existing residual law, not a claim that
every envelope is proven multi-fan. It remains a limitation until an approved
exclusive attribution contract exists. Lake rewrites exclude those residual IDs
even when a generic textual predicate also matches.

Fixtures prove bounds and storage behavior, not live event coverage, provider
session fan-out/presence, HTTP savings or event-to-reader latency. Default-off B0
does not claim any of those measurements or close the migration's savings goal.
