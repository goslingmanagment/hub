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
   cadence and performs no hints, canonicalization or business writes.
4. Kill-switch: set enabled to false (or remove the page from the allowlist).
   Config polling is ten seconds; failed/stuck checks stop sockets. Verify a
   closed connection receipt within 60 seconds and continued REST health.
   The socket and its dedicated dispatcher are destroyed without waiting for a
   peer close handshake. Do not delete raw, receipts or gaps on rollback.

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
attempt and leave coverage unknown. Retry backs off to 60 seconds; ten consecutive
unstable attempts pause about 30 minutes with jitter. A durable business capture
or 60 verified seconds resets that sequence. An explicit 401 blocks the same
generation across restarts; disabling/re-enabling cannot erase that evidence.
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

The worker replays up to 20 pending inline observations at startup and on each
guard. For an offline, provider-free repair using the existing operator CLI:

```sh
pnpm cli fansly:decode-ws --page lilly-1 --max-batches 50
```

This is a DB mutation and follows the usual operator approval boundary. Each batch
contains at most 20 rows; output contains only page ID and settled count. Pending
rows whose raw was tiered or is unavailable are not certified recovered by this
inline repair and remain pending. Unknown/debt receipts require a later explicit
decoder change; B0 does not reinterpret them automatically.

Every connection starts with `gap_state=unknown`, carrying the previous attempt's
last known boundary. Neither reconnect nor REST replay proves transient fact
recovery. Closed-at NULL with stale guard is a failed/unconfirmed attempt, not a
healthy connection. Never sum resumed phases into an uninterrupted duration.

Read diagnostics via the `read_only` role in a READ ONLY transaction, without raw:

```sql
BEGIN READ ONLY;
SELECT id, page_id, started_at, verified_at, last_guard_at, last_capture_at,
       last_ordinal, closed_at, stop_reason, gap_since, gap_state
FROM fansly_ws_connections ORDER BY started_at DESC LIMIT 20;
SELECT page_id, state, count(*), min(received_at) AS oldest
FROM fansly_ws_decode_receipts GROUP BY page_id, state ORDER BY page_id, state;
COMMIT;
```

## Erasure and retained limitations

The tagged raw codec searches nested JSON strings, escaped Unicode, fan refs and
resolved conversation-group refs consistently in inline/CAS and tiered lake data.
Capture fences pre-erasure queued material. Page/model erasure removes the raw and
both B0 operational tables through the existing sanctioned erasure path.

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
