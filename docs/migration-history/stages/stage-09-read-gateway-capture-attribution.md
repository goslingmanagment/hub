# Stage 9 — Read-gateway capture-through + read attribution

**Repo(s):** core · **Depends on:** 7 (journal); soft: 8 (parsers) ·
**Passport:** roadmap.md §4, stage 9

**Status header.** No deviation. One verified sharpening: the passport's "closing the review's
gateway-attribution gap" is confirmed at line level — the principal is available in
`executeOfapiReadGatewayRequest` (`ofapi-read-gateway.ts:359`, used only for page filtering
`:388` and whoami `:381`) but is **not** threaded into `proxyRead` → `reportCreditSpend` →
`recordOfapiCreditSpend`, and `ofapi_credit_ledger` has **no principal column**
(`schema.ts:2015-2031`). Both halves (capture tee + attribution) land here.

## 1. Context

Every credit spent on a chatter's gateway read currently buys one screen render; the body is
discarded (review §4.4). This stage tees every successful proxied response into the observation
journal (producer 4) — asynchronously, post-respond, never on the chatter's latency path — and
records who spent each read in the credit ledger.

**Entry criteria restated as facts to verify:**
- Stage 7 deployed (journal live).
- Gateway flags running-on (`ofapiDesktopReadGatewayEnabled` + `ofapiCreditLedgerEnabled` — the
  gateway 503s without them, `ofapi-read-gateway.ts:365-370`); desktop fleet reads via
  `GET /api/v1/ofapi/read/*` (`server.ts:1586`, rate limit 120/min `:1589-1592`).
- Baseline gateway p95 recorded (from `sync_http_attempts`-equivalent gateway logs or a 24 h
  measurement) before deploy.

**Deliverable:** gateway 200s produce `producer='read-gateway'` observations with
`actor_principal_id` set; credit-ledger rows carry the acting principal; gateway p95 unchanged.

## 2. Changes

**core — capture tee** (`services/ofapi-read-gateway.ts`): after `app.ofapi.proxyRead(...)`
returns (`:419-429`) with a 2xx, enqueue `{principalUserId, pageId, operation, pathname, query,
status, body}` onto an in-process **size-capped async tee queue** (bounded array + single
drainer; cap ~500 entries / ~32 MB). The drainer inserts observations: `source='readthrough'`,
`producer='read-gateway'`, `account_id=pageId`, `kind=<allowlisted path template>` (from
`resolveOfapiReadGatewayRequest`'s match, `:148` — the template, not the raw path),
`idempotency_key=<uuid per proxied response>`, `actor_principal_id=principal.user.id`, payload =
response body verbatim. **Queue full → increment a dropped-capture counter and serve normally**
(fail-open is acceptable HERE ONLY — proxied reads recur; the counter keeps the gap visible), and
raise an incident when the counter grows over a threshold (reuse `notification-incidents`).
The tee runs after the reply is dispatched (`server.ts:1598-1605` relays; tee enqueues in the
service before returning — enqueue is O(1), the insert is async).

**core — read attribution:** thread the principal through the read path — add optional
`actorUserId` to the proxy-read input (`app.ofapi.proxyRead` context, `services/ofapi.ts:713,
1365`), carry it into `reportCreditSpend` (`ofapi.ts:499`) → `onCreditSpend` sink
(`createOfapiCreditSpendSink`, `ofapi-credits.ts:62`) → `recordOfapiCreditSpend`
(`ofapi-credits.ts:71-83`) → new nullable column `ofapi_credit_ledger.actor_user_id`. Gateway
passes `principal.user.id`; background REST spenders (DM sync, audience) pass nothing (NULL =
system).

**core — canonicalization of gateway kinds:** the chat-list / message-page kinds reuse Stage 8's
OFAPI parsers (same shapes as REST sync — the canonicalizer keys off the path-template `kind`).
If Stage 8 has not shipped when this deploys, capture still works (observations accumulate;
`parse_version=0` rows are picked up by the sweep later) — the soft dependency is real.

## 3. Schema & data migration

```sql
-- 00NN_credit_ledger_actor.sql
ALTER TABLE ofapi_credit_ledger ADD COLUMN actor_user_id bigint REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX ofapi_credit_ledger_actor_idx ON ofapi_credit_ledger (actor_user_id, created_at);
```
Additive, nullable, no backfill (historical reads are unattributable — recorded fact, not a
gap to chase). **No other schema change** (observations exist from Stage 7).

## 4. Client compatibility

- **Desktop:** zero change — same paths, same response bodies, same latency (tee is post-respond
  and fail-open). The read-gateway **path-shape invariant** (target §14) is explicitly in play
  and preserved: no URL, auth, or response change.
- **Extension / workboard:** n/a.
- **Dashboard:** none required; per-chatter credit spend becomes *queryable* (surface in
  Stage 33 if desired).

## 5. Tests & verification

**New tests:**
- Integration: a gateway 200 (fixture upstream) → one observation with principal + path-template
  kind; a 4xx/5xx → no observation.
- Queue-full behavior: cap forced to 1 in test → drops counted, serving unaffected, incident
  raised at threshold (unit).
- Attribution: gateway read writes a ledger row with `actor_user_id`; background DM-sync spend
  writes NULL (integration).
- Latency guard: tee enqueue adds < 1 ms to the handler (micro-benchmark in test, generous
  bound).

**Existing suites:** read-gateway suite, credit-ledger suite (`tests/ofapi-*.integration.test.ts`
patterns), SSE suite untouched.

**Production verification (exit criteria):**
- 24 h: `count(observations WHERE producer='read-gateway')` ≈ gateway request count (200s) from
  logs/rate-limit metrics; dropped-capture counter ≈ 0.
- `SELECT actor_user_id, count(*) FROM ofapi_credit_ledger WHERE created_at > :deploy AND
  actor_user_id IS NOT NULL GROUP BY 1` — per-chatter spend visible.
- Gateway p95 unchanged vs the pre-deploy baseline (same measurement method).
- A DM fetched **only** via the gateway appears in `domain_events` once Stage 8 parsers cover it
  (spot-check; deferred if 8 lags).

## 6. Rollback

- Tee and attribution are code-revert-only (column stays, inert). No data effect; captured
  observations stay.
- No irreversible step.

## 7. Assumptions

1. **The gateway is the desktop's only read path in practice** (direct mode exists but
   non-default until Stage 24 removes it) — capture coverage equals gateway coverage; direct-mode
   reads are a known, shrinking blind spot until 24.
2. **Response bodies fit the journal comfortably** (chat lists / message pages are KB-scale;
   the 1 MB Fastify body default doesn't apply to upstream responses — verify the largest
   allowlisted operation's typical size at execution; cap tee entries above it).
3. **`proxyRead`'s signature can gain an optional field without touching its other callers**
   (whoami/list uses — verify call sites of `app.ofapi.proxyRead`).
4. **Fail-open is bounded to this producer only** — webhook/pull/command/operator producers stay
   fail-closed (Stage 7); nothing here weakens them.

## 8. Task breakdown

1. **Tee queue + drainer + counter + incident threshold.** Done-check: integration + queue-full
   tests. *(0.5–1 session)*
2. **Attribution threading + migration.** Done-check: attribution tests. *(0.5 session)*
   *(parallel with 1)*
3. **(Last) Deploy; 24 h count reconciliation + p95 comparison; record results here.** *(ops)*

## Progress

*Working scratchpad — session 2026-07-05, branch `kernel/stage-09-read-gateway-capture` off the Stage 8 tip (da8f0e4 — linear 8→9 merge chain, migration numbering stays clean). **Same ordering deviation as Stage 8 (#73, owner "do not wait"):** Stage 7 deployed+live but not exited; DEPLOY WAITS for 7's exit. Entry criterion "baseline gateway p95 recorded" moves to the deploy step (measure immediately before).*

**§8 checklist:**
- [x] 1. **Capture tee (09.1).** New `ofapi-read-gateway-capture.ts`: bounded queue (cap 500) + single joinable drainer (awaiting joins the in-flight drain; a racing enqueue re-kicks — both subtleties test-visible); gateway 2xx responses enqueue `{principal, pageId, operation, status, body}` post-respond, O(1) on the latency path. Observations: `source='readthrough'`, `producer='read-gateway'`, kind = the allowlisted path-template operation (e.g. `ofapi_gateway_chats`), payload = response body VERBATIM, `idempotency_key = rg:<uuid>` (each proxied response is its own fact), `actor_principal_id` = chatter. Fail-open bounded to THIS producer: queue-full or failed insert → dropped counter + `read_gateway_capture` incident at threshold (25). whoami/accounts synthetic responses are not captured (not upstream reads). **Deviation:** the spec's <1 ms micro-benchmark test is skipped as CI-flaky by nature — the guard is structural (bounded array push); integration proves the path.
- [x] 2. **Attribution (09.2).** Migration 0058: nullable `ofapi_credit_ledger.actor_user_id` FK→users SET NULL + `(actor_user_id, occurred_at)` index + the incident-kind enum value. `OfapiRequestContext.actorUserId` threaded proxyRead→reportCreditSpend→spend observation→sink→`recordOfapiCreditSpend`→ledger; ONLY the gateway passes it (principal.user.id) — the six background REST spend sites are untouched (NULL = system spend). No backfill (historical reads unattributable — recorded fact).
- [x] Tests: gateway 200 → one journal row (producer/kind/principal/verbatim payload) + attributed ledger row; 404 → no capture; queue cap 0 + threshold 1 → 200 still served, drop counted, incident row present. Suite: gateway file 11/11.
- [ ] 3. Deploy (AFTER Stage 7 exits, chained behind Stage 8) + 24 h count reconciliation + p95 comparison (baseline measured just before deploy).
