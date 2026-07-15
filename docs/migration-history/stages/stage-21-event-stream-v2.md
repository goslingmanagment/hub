# Stage 21 — Event stream v2

**Repo(s):** core · **Depends on:** 8; soft: 20 (SDK helper) · **Passport:** roadmap.md §4,
stage 21

**Status header.** No deviation. Contract-shape note fixed here for Stages 24/33 (their specs
rely on it): v2 lives at **`GET /api/v1/events/v2/stream`** + `GET /api/v1/events/v2/snapshot`
(additive routes — `/api/v1` additive-evolution policy, target §6.4; the `/api/v2` pocket is the
spenders API and is NOT reused for this).

## 1. Context

Stream v1 is welded to the OFAPI-only webhook journal and a global settle-ordered sequence:
frames are `ofapi_webhook_events.sync_event` rows keyed by `fanout_seq`
(`nextval('ofapi_webhook_events_fanout_seq')` at settle, `repositories/ofapi.ts:96-97`), fanned
out via LISTEN/NOTIFY (`ofapi_sync_events`, `ofapi-events.ts:66,341`; hub
`services/events-stream.ts`), served at `GET /api/v1/events/stream` (`server.ts:1346`) with
Last-Event-ID resume + 409 snapshot (`:1366-1397`) and 60 s re-auth (`:1326,1460-1483`). Fansly
never streams; the global sequence is the scale singleton. v2 re-keys the same proven protocol to
`domain_events`: per-account ordering, opaque cursor, all platforms — served **in parallel**;
v1 stays byte-identical until Stage 25 retires it after the desktop migrates (24).

**Entry criteria restated as facts to verify:**
- `domain_events` complete for client-needed types: `message.*`, `transaction.posted`,
  `presence.*` flowing (`SELECT type, count(*) … GROUP BY 1`).
- Stage 8's per-account gapless-seq CI proof green (v2's ordering rests on it).
- v1 conformance tests inventoried (`tests/ofapi-sse.integration.test.ts`) — v2's suite mirrors
  them.

**Deliverable:** v2 endpoint + snapshot in production, dual-stream serving load-measured, a
production smoke consumer replaying a 24 h window with zero gaps/duplicates, SDK helper support,
v1 untouched.

## 2. Changes

**core — v2 frame contract** (`packages/contracts`): frame =
`{ accountId, accountSeq, type, occurredAt, data }` with `type` = the canonical vocabulary
(target §3.2) — clients tolerate unknown `type`s (the v1 union's forward-compat rule, now
explicit). Wire: `id: <opaque cursor>\nevent: domain\ndata: <json>`; heartbeat/retry/lifetime
constants shared with v1 (`server.ts:1324-1332`).

**core — resume cursor:** opaque base64url JSON `{v:2, w:{<accountId>: <highSeq>, …}}` — the
per-account high-water map. On connect: parse cursor (absent → "now", or explicit
`?from=snapshot` after snapshot flow); for each granted account, replay
`domain_events WHERE account_id=$a AND account_seq > $w` in seq order (batched, the v1 replay
pattern `server.ts:1511` analog), then live-tail. Per-account monotonic guard (v1's
`createMonotonicSeqGuard`, `events-stream.ts:43`, generalized to a per-account map).
**Gap rule:** if any granted account's `w` is below the account's retained floor (post-Stage-28
tiering makes floors real; until then floor = 0) → `409 {error:'sync_snapshot_required',
version:2, accounts:[…]}` — per-account, replayed via `GET /api/v1/events/v2/snapshot?accounts=…`
(snapshot = current projection state per account + fresh cursor, mirroring the v1 snapshot's
role).

**core — fan-out:** NOTIFY on domain-event append — channel `domain_events_appended`, payload
`<accountId>:<accountSeq>` (emitted in the Stage 8 append protocol's commit path); the existing
hub pattern gets a second LISTEN consumer (`createDomainEventHub`, modeled on
`createSyncEventHub` — same reconnect/watermark discipline, reading forward from the delivery
watermark per account). Per-connection page-grant filtering + 60 s re-auth carried over verbatim.

**core — auth:** v2 routes declare Stage 19 vocabulary `kind:'apiKey'` (desktop) — same as v1;
dashboard access (Stage 33) rides session `kind:'any'` — decide at execution with the policy
table, default `any` since the dashboard consumes v2 in 33.

**core — SDK (soft dep):** `subscribeDomainEvents({ cursor, onFrame, onSnapshotRequired })` added
to `@kernel/sdk` when 20 has shipped; otherwise the smoke consumer uses a local helper and the
SDK gains it in 20's next release.

**core — smoke consumer:** a tiny worker-side subscriber (ops module) that tails v2 for all
accounts, checkpoints, and exports gap/duplicate counters — runs permanently in production as
the conformance instrument (and later the Stage 25 SSE-delivery-lag signal).

**core — NOT here:** v1 code untouched (byte-identical — compatibility invariant); no client
migration (24/33); no `fanout_seq` retirement (25).

## 3. Schema & data migration

**No schema change** (reads `domain_events` + `domain_event_seq` high-waters; the smoke
consumer's checkpoint is one small ops table `v2_smoke_checkpoint(cursor text, updated_at)` —
include it in the stage migration if kept DB-side). **No data migration.**

## 4. Client compatibility

- **Desktop:** unaffected — stays pinned to v1; v2 is opt-in. Its migration is Stage 24, with a
  rollout-window-only v1 fallback per that passport.
- **Extension:** unaffected (doesn't consume SSE today; optional v2 consumer post-32).
- **Dashboard:** unaffected until Stage 33.
- **Workboard:** v2 is its designed feed (`workboard.state_changed` rides it from Stage 23 on).

**Compatibility invariants (target §14):** the SSE `sync` frame union + Last-Event-ID/409
protocol on **v1** is explicitly in play and preserved untouched — the v1 conformance suite runs
unchanged in CI as the proof. Deprecation declared: v1 successor = v2, retirement stage = **25**.

## 5. Tests & verification

**New tests:** v2 conformance suite mirroring v1's (ordering per account, resume from cursor,
gap→409 per account, re-auth close on key revocation, unknown-type tolerance); cursor
encode/decode property tests (round-trip, unknown-version rejection); dual-hub integration (one
event → v1 frame AND v2 frame, each on its own protocol); replay-window batching test.

**Existing suites:** the v1 SSE suite **unchanged and green** — the invariant proof.

**Production verification (exit criteria):**
- Smoke consumer replays a 24 h window: zero gaps, zero duplicates (counters).
- Dual-stream serving load measured: API replica CPU/memory + NOTIFY volume before/after with
  both hubs live (record numbers; the passport's containment).
- Fansly activity visibly streams (a Fansly `message.received` frame observed on v2 — first time
  ever).
- v1 desktop connections unaffected (connection counts + chat freshness spot-check).

## 6. Rollback

- v2 endpoints are additive; disable by removing route registration (or a boot flag) — v1
  consumers never notice. The smoke consumer stops with it.
- No schema/data effects. No irreversible step.

## 7. Assumptions

1. **`account_seq` is gapless per account** (Stage 8's CI proof) — the monotonic guard treats a
   gap as a bug signal (counter + incident), not a normal condition.
2. **LISTEN/NOTIFY scales to a second channel** at current volumes (same Postgres, same hub
   pattern); the measured load check is the gate.
3. **The snapshot flow's projection sources** (threads/fans/spend as v1's snapshot uses) remain
   serving-grade during dual-stream operation.
4. **Retained floor = 0 until Stage 28** — the 409 path is fully wired but rarely triggered
   before tiering exists; the conformance test forces it synthetically.
5. **v2 route auth vocabulary** exists (Stage 19) — if 19 slips, v2 ships with imperative
   `requireApiKeyUser` and re-declares in 19 (note which way at execution).

## 8. Task breakdown

1. **Frame contract + cursor codec + property tests.** *(0.5 session)*
2. **Append-path NOTIFY + domain-event hub.** *(0.5–1 session)*
3. **v2 stream + snapshot endpoints + conformance suite.** *(1–1.5 sessions)*
4. **Smoke consumer + counters + checkpoint.** *(0.5 session)*
5. **SDK helper (if 20 shipped).** *(≤0.5 session)* *(parallel)*
6. **(Last) Deploy; 24 h smoke replay + load measurement + Fansly-frame proof; record results
   here.** *(ops)*

---

## Progress

**Session 1 (2026-07-06 night, branch `kernel/stage-21-event-stream-v2` off the Stage 20 tip
eb82a9f — chain 19→20→21; ordering deviation as #73-#75: built on green-local Stage 8, owner's
standing "continue and next stages"):**

§8 checklist — **Tasks 1–5 ALL BUILT** (four commits, each verified: typecheck + targeted suites
+ v1 invariant battery + policy/SDK gates):
- [x] **Task 1+5** (a29a420) — frame contract `{accountId, accountSeq, type(open), occurredAt,
  data}`; cursor codec in `packages/contracts/src/domain-event-cursor.ts` (base64url
  `{v:2, w:{account: highSeq}}`, strict decode incl. non-canonical-base64 rejection,
  deterministic sorted encode); routes `eventsV2Stream`/`eventsV2Snapshot` declared
  `kind:"any"` (execution decision per spec — dashboard rides v2 in St.33); SDK
  `subscribeDomainEvents` (opaque-cursor resume, 409→onSnapshotRequired); eventsV2Stream on the
  SDK exclusion list, snapshot a plain typed method. Manifest/hash/OpenAPI regenerated (additive).
- [x] **Task 2** (56e0f82) — `pg_notify('domain_events_appended', '<account>:<maxSeq>')` per
  (account, batch) INSIDE the append tx (fires on commit); `createDomainEventHub`
  (services/domain-events-stream.ts) = v1 hub discipline with PER-ACCOUNT watermarks +
  dirty-account set; reconnect rebaselines against all counter rows; `createAccountSeqGuards`
  reports jumps as the bug signal. New db reads: `listDomainEventHighWaters`,
  `listDomainEventAccountBounds` (floor = min retained seq → Stage 28 tiering needs NO code
  change here).
- [x] **Task 3** (a39288b) — endpoints in modules/events beside untouched v1: grant universe
  (owner = all accounts), Last-Event-ID/?cursor resume, per-account batched replay + buffered
  live tail, shared heartbeat/lifetime consts, re-auth for BOTH credential kinds (session +
  bearer — v2 is kind:any), per-account 409 (ahead + below-floor). **Recorded deviation:**
  v2 snapshot = grant-checked fresh-cursor handshake (accounts+currentSeq+cursor); the spec's
  "current projection state per account" payloads ride the consumer stages (24/33) additively —
  the only Stage-21 consumer (smoke) needs exactly the cursor reset.
- [x] **Task 4** (0d28077) — smoke consumer: worker-side, all accounts, same hub+replay code
  path as the endpoint, durable checkpoint (migration **0064**, single row with cursor +
  frames/gap/duplicate counters), 30 s persist / 10 min summary; runs UNCONDITIONALLY (like the
  Stage 7/8 sweeps — read-only besides its row; recorded, no flag). **In-process hub tail, not
  an HTTP self-connection** (recorded deviation: auth/URL wiring to self over Docker adds ops
  surface; the HTTP framing is covered by the CI conformance suite).
- [ ] **Task 6 (ops)** — deploy (migration 0064 + dist), then: 24 h smoke replay (gap/dup
  counters must be 0 — `select * from domain_events_smoke_checkpoint`), dual-stream load
  measurement (API CPU/mem + NOTIFY volume before/after), the first-ever Fansly frame observed
  on v2 (`message.received` from a fansly account), v1 desktop connections unaffected.

Conformance suite: tests/domain-events-v2.integration.test.ts (9: ordering, cursor resume,
grant scoping incl. foreign-cursor 403, unknown-type tolerance, ahead-409, malformed-cursor 400,
dual-protocol serving, >500-row replay batching, synthetic-prune floor-409 + floor-edge resume);
tests/domain-event-cursor.test.ts (3 property tests); tests/domain-events-smoke.integration
(live tail + restart resume + synthetic gap). v1 suite byte-untouched and green (the invariant).

Gotchas for future sessions: repo-level `settleOfapiWebhookEvent` does NOT emit the v1 fanout
NOTIFY (the worker does) — in-process v1 live-path tests must use replay; drizzle-orm stays
banned in test files (use testDb.pool.query for raw SQL).
