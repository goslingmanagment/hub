# Stage 16 — Fansly earnings & PPV order-history streams

**Repo(s):** core · **Depends on:** 6 (replay verdict YES per family), 8 (canonicalizers) ·
**Passport:** roadmap.md §4, stage 16

**Status header.** No deviation from the master. Two execution notes: (1) **Stage 6's day-1
verdict is IN (2026-07-04): all three families REPLAYABLE** with the single pasted
`fansly-client-check` — zero auth rejections on lilly-1/lilly-2 (`decisions.md` #62). No family is
cut; the whole stage proceeds on the single-check path (the per-route `routeChecks` contingency
stays unbuilt). The Q2 part-2 escalation is moot unless the ≥5-day longevity re-probe later
reveals fast check-rot on a family. (2) Stream naming: the two new streams
are named `fan_earnings` and `purchase_history`, matching the target §4.1 capability vocabulary,
so Stage 18's `PlatformCapabilities.streams` adopts them without a rename. **Scope guard:** the
streams use whatever session material the custody descriptor provides (today: the pasted bundle,
single check — proven by Stage 6); how that material is obtained/refreshed is deliberately not
specified here.

## 1. Context

DP 1-B: Fansly capture is kernel-only, so the two endpoint families only the extension calls today
— per-fan lifetime/monthly earnings stats and PPV order history — must become kernel sync streams,
or the agency's own database never sees per-fan Fansly revenue. This stage adds them as first-class
sync streams landing as observations (producer 2) → domain events → a per-fan earnings projection.

**Entry criteria restated as facts to verify:**
- Stage 6 verdict table (in `docs/decisions.md`) says **replayable** for `earnings` and `media`
  families, with measured check-longevity. If missing → stop, Stage 6 has not executed.
- Stage 8 live: `domain_events` receiving Fansly pull-sync canonicalizations (query: any
  `fan.profile_observed`/`transaction.posted` rows for a Fansly account).
- Session-death monitoring armed (verified in code: auth errors → `blockPageSync` with
  `blockerKind:"auth"` + `notifyAuthFailedIncident` kind `auth_blocked` —
  `apps/runtime/src/services/sync/executor.ts:501-538`,
  `services/notification-incidents.ts:262-275`).
- Owner-approved ramp plan: which page goes first (default: one of the Stage 6 probe pages,
  `lilly-1`/`lilly-2` — their sessions were just proven).

**Deliverable:** both streams running on cadence for every active Fansly page (after ramp),
earnings stats updating daily, PPV order history walked to depth ≥ extension-visible depth,
`fan.earnings_observed` + PPV purchase events flowing, and a rebuildable `fan_earnings_stats`
projection serving per-fan Fansly revenue.

## 2. Changes

**core — `packages/fansly/src/adapter.ts`** (hardening Stage 6's probe methods):
- `getEarningsStatsAccountsPage` / `getEarningsMonthlyStatsAccountsPage` /
  `getMediaOrderHistoryPage` graduate from probe-grade (`passthrough()` Zod) to typed response
  schemas derived from the probe's captured payloads. Pagination params per the probe's findings
  (order history is expected `before`/`limit` back-scroll like `getMessagesPage`
  (`adapter.ts:392`); earnings stats are snapshot-shaped). Model on `getEarningsAccountsPage`
  (`adapter.ts:166`) — same observed-request wrapper, new `endpointTemplate`/`operation`/`category`.

**core — stream registration** (the full checklist, verified against code; a new stream touches
ALL of these):
- `syncStreamEnum` — add `fan_earnings`, `purchase_history` (`packages/db/src/schema.ts:50`; DB
  migration, see §3).
- `SYNC_STREAMS` + `SyncStream` type (`packages/db/src/repositories/page-sync.ts:16,28`).
- `SYNC_STREAM_POLICY` (`page-sync.ts:78`): `fan_earnings` cadence daily (earnings stats are
  slow-moving); `purchase_history` cadence a few hours with back-scroll to exhaustion, then
  incremental.
- `SYNC_DOMAIN_POLICY` (`page-sync.ts:180`), `SYNC_STREAM_DEPENDENCIES` (`page-sync.ts:213`)
  (`purchase_history` depends on `light`/account mapping only), `SYNC_STREAM_PRIORITY_BY_SOURCE`
  (`page-sync.ts:227`) — both streams lowest priority (bulk class; never ahead of
  transactions/DMs), `streamOrderSql` (`page-sync.ts:423-434`), `streamPriorityBySourceSql`
  (`page-sync.ts:440`), `getSyncStreamsForPlatform` — add to the `fansly` list only
  (`page-sync.ts:533-539`).
- Executor dispatch: new cases in `executeStreamChunk`'s switch
  (`apps/runtime/src/services/sync/executor-handlers.ts:4120`) → `executeFanEarningsChunk`,
  `executePurchaseHistoryChunk`, modeled on `executeTransactionsChunk` (`:1509`): checkpointed via
  `getCheckpoint`/`upsertCheckpointProgress` (`packages/db/src/repositories/sync.ts:454,592`),
  chunk-budgeted (`chunk-budget.ts:5-11`, 5 requests / 45 s), paced by the existing waiter
  (`rate-limiter.ts:15`; 2.5 s global — `packages/shared/src/config.ts:336`).
- Handlers persist every fetched response page as a producer-2 observation (Stage 7's generalized
  persistence; `kind` = the endpoint template) — capture is unconditional, no flag.

**core — ramp gating (serving/egress, not capture):** two registry flags
`fanslyFanEarningsSyncEnabled`, `fanslyPurchaseHistorySyncEnabled` (default false, staged-style
one-at-a-time enable) + `fanslyNewStreamPageAllowlist` (editable CSV of page labels; empty = all).
Handlers no-op-complete for non-allowlisted pages. Ramp: allowlist = one page → watch 48 h → clear
allowlist. These gate *platform egress volume*, not capture — once a response is fetched it is
always journaled.

**core — Stage 8 canonicalizers (extend):**
- Earnings-stats observation → `fan.earnings_observed` events (one per fan per stats window;
  `dedup_key` = `fan_earnings:<native_fan_id>:<window>:<content-hash>` so an unchanged snapshot
  re-fetch produces no new event).
- Order-history observation → `message.ppv_unlocked` events (dedup key on the platform-native
  order/purchase id). NB the money side of a PPV purchase already arrives via the `transactions`
  stream (`raw_type` numeric Fansly codes → `canonical_type='message_purchase'`,
  `packages/fansly/src/mappers.ts:21-50`); the order-history event carries the *content* facts
  (item, price, purchased-at). Cross-producer dedup is per event type — the two do NOT collapse
  (different types), and the spec of the projection join is `transaction_ref`.

**core — new projection `fan_earnings_stats`** (per §5.2 discipline: declared inputs
`fan.earnings_observed`; per-account watermark; one-command rebuild): serves "per-fan Fansly
lifetime/monthly revenue" reads. Minimal owner-grade read endpoint on the existing
spenders/finance surface (full SDK-grade endpoints ride Stages 19/20; dashboard view is Stage 33).

## 3. Schema & data migration

```sql
-- 00NN_fansly_new_streams.sql  (NB: ALTER TYPE ... ADD VALUE — check the migration runner
-- wraps migrations in a transaction; if so, split enum additions into their own migration
-- executed per the runner's non-transactional path, or use the documented workaround.)
ALTER TYPE sync_stream ADD VALUE IF NOT EXISTS 'fan_earnings';
ALTER TYPE sync_stream ADD VALUE IF NOT EXISTS 'purchase_history';

-- 00NN+1_fan_earnings_stats.sql
CREATE TABLE fan_earnings_stats (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id        bigint NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,
  fan_id            bigint NOT NULL REFERENCES fans(id) ON DELETE RESTRICT,
  window            text   NOT NULL,          -- 'lifetime' | 'YYYY-MM'
  gross_mills       bigint NOT NULL,
  net_mills         bigint,                   -- as the platform reports it, if it does
  currency          char(3) NOT NULL DEFAULT 'USD',
  observed_at       timestamptz NOT NULL,
  source_event_id   bigint NOT NULL,          -- provenance → domain_events.id
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, fan_id, window)
);
CREATE INDEX fan_earnings_stats_account_window_idx ON fan_earnings_stats (account_id, window);
```
Exact money columns follow the probe's payload shape — if Fansly reports units other than mills,
convert at canonicalization with the shared codec and record the raw amount on the observation
(target §5.3). **No data backfill**: history accumulates from first sync; order-history back-scroll
IS the historical backfill for PPV (to the platform's floor). Idempotency: events deduped by
`dedup_key`; projection upserts on the unique key. No credits involved (Fansly is session-billed,
not credit-metered) — the cost guard is the pacing + allowlist ramp.

## 4. Client compatibility

- **Desktop:** none (OnlyFans-only surface).
- **Extension:** unchanged — it still reads Fansly directly for its UI (DP 1-B keeps it a reader;
  DP 3-A keeps it alive). Nothing it calls changes. In Stage 32 its spenders board starts reading
  the kernel projections this stage begins filling.
- **Dashboard:** no required change; a Fansly per-fan revenue view may land here (owner-grade
  endpoint above) or defer wholesale to Stage 33.
- **Workboard:** n/a (module consumes these events from Stage 23 on).

**Compatibility invariants (target §14):** none touched — no existing contract changes; two new
streams and one new projection only.

## 5. Tests & verification

**New tests:**
- Adapter unit tests: URL/query/schema for the three hardened methods (mock dispatcher; fixture
  payloads captured by the Stage 6 probe).
- Stream registration test: `getSyncStreamsForPlatform('fansly')` includes both;
  `asSyncStream` accepts them; executor dispatch reaches the new handlers (unit).
- Integration (Testcontainers): a `fan_earnings` chunk with a fixture response produces (a) an
  observation row, (b) `fan.earnings_observed` events, (c) `fan_earnings_stats` rows; re-running
  the same fixture produces zero new events (dedup proof). Same pattern for `purchase_history` →
  `message.ppv_unlocked`.
- Projection rebuild test: `kernel projection rebuild fan_earnings_stats` from event fixtures
  reproduces identical rows (CI, per §5.2 discipline).
- Allowlist test: non-allowlisted page chunk no-ops without platform calls.

**Existing suites:** Fansly adapter suite; sync executor suite; planner tests (stream-list changes).

**Production verification (exit criteria):**
- Earnings stats updating on cadence for every active Fansly page:
  `SELECT account_id, max(observed_at) FROM fan_earnings_stats GROUP BY 1` — all pages within
  cadence + slack.
- PPV depth: for one sampled fan, order-history event count ≥ what the extension shows for the
  same fan (owner eyeball against the extension UI).
- Zero `auth_blocked` incidents attributable to the new streams over 2 weeks
  (`notification_incidents` query filtered to the ramp window; compare per-stream
  `sync_run_events` failures).
- **Observation window:** 48 h single-page ramp, then 2 weeks fleet-wide incident watch.

## 6. Rollback

- Flags off → streams stop scheduling (planner skips; in-flight chunks finish). Instant, no data
  effect. Allowlist shrink = partial rollback.
- Enum values and the projection table stay (harmless, additive). Events/observations already
  captured stay — by design (never roll back capture).
- No irreversible step. Platform-facing risk is bounded by pacing + ramp; a session death fails
  safe through the existing auth-block + incident path.

## 7. Assumptions

1. **Stage 6's day-1 verdicts are YES for both families and its longevity measurement holds in
   steady state.** Drift signal: `auth_blocked` incidents clustering on the new streams while old
   streams stay healthy → degrade cadence (config) and re-raise Q2 part 2; do not hammer.
2. **The extension remains the freshness source in-conversation** — these streams buy completeness,
   not freshness (daily earnings cadence is a feature, not a bug).
3. **Stage 7/8 landed**: generalized observation persistence exists in the executor and the
   canonicalizer seam accepts new kinds. If Stage 8 slipped, the streams can still ship
   capture-only (observations, no events) — flag the partial state in `decisions.md`.
4. **Fansly is session-billed** (`billing: 'session'`) — no credit machinery applies; the DP 2
   day-budget condition is OFAPI-only and does not bind here.
5. **`fans`/`page_fans` identity lane**: Fansly fan native id keys `fans (platform,
   platform_user_id)` (`schema.ts:549-565`); the projection references `fans.id`. Stage 18's
   `platform_identities` consolidation re-anchors this later — the projection is rebuildable, so
   that re-anchor is a rebuild, not a migration.
6. **Stream names `fan_earnings`/`purchase_history` are the final capability names** consumed by
   Stage 18. Drift signal: Stage 18 spec renaming them — reconcile there, not here.

## 8. Task breakdown

1. **Harden the three adapter methods** (typed schemas from probe fixtures). Done-check: adapter
   unit tests green. *(≤0.5 session)*
2. **Stream registration sweep** (enum migration + the 9 registration sites + dispatch cases with
   stub handlers). Done-check: registration unit tests; migration applies on staging. *(≤0.5
   session)*
3. **`fan_earnings` handler + canonicalizer + projection** (+ rebuild command wiring). Done-check:
   integration test (fixture → observation → event → projection row; rebuild reproduces). *(1
   session)*
4. **`purchase_history` handler + canonicalizer** (back-scroll to exhaustion + incremental).
   Done-check: integration test incl. dedup re-run. *(1 session)* *(parallel with 3)*
5. **Ramp flags + allowlist + owner-grade read endpoint.** Done-check: allowlist no-op test;
   endpoint role-gated (owner/team_lead). *(≤0.5 session)*
6. **(Last) Deploy; single-page ramp 48 h; fleet enable; record production verification** (the §5
   queries + the 2-week incident watch) in this file. *(ops)*

## Progress

*Working scratchpad — session 2026-07-05, branch `kernel/stage-16-fansly-earnings` off the Stage 10 tip 10d8b6d (linear chain 8→9→10→16; needs 8's canonicalizer seam + 10's `projection_seq_watermarks`). **Ordering deviation family (#73–#75, owner "build 2 stages in a row"):** Stage 6 = day-1 GO + day-2 no-rot (exit needs days 3–5); Stage 8 green-local undeployed. Deploy rides the chain after Stage 7 exits. Ramp flags default OFF, so deploying this stage is inert until the owner flips.*

**Build plan (for session continuity):**
1. Migrations **0060** (sync_stream enum + `fan_earnings`,`purchase_history` — ALTER TYPE ADD VALUE, 0052/0054 precedent OK in per-file tx) + **0061** (`fan_earnings_stats` per spec §3).
2. Registration sweep — 9 sites in `packages/db/src/repositories/page-sync.ts` (SYNC_STREAMS:16, type:28, POLICY:78 — fan_earnings daily / purchase_history hours, DOMAIN_POLICY:180, DEPENDENCIES:213 (purchase_history ← light only), PRIORITY:227 lowest, streamOrderSql:423, streamPriorityBySourceSql:440, getSyncStreamsForPlatform fansly-only:533) + `syncStreamEnum` schema.ts:50 + executor dispatch cases → `executeFanEarningsChunk`/`executePurchaseHistoryChunk`.
3. Adapter hardening: typed schemas for `getEarningsStatsAccountsPage`/`getEarningsMonthlyStatsAccountsPage`/`getMediaOrderHistoryPage` from probe shapes (probe service `fansly-replay-probe.ts` has the calls; order-history = before/limit back-scroll like getMessagesPage; stats snapshot-shaped).
4. Handlers (model executeTransactionsChunk): checkpointed, chunk-budgeted, paced; persistRawPayload with platform:"fansly", endpoints `fan_earnings_stats`/`fan_earnings_monthly`/`purchase_history`; allowlist no-op check FIRST (flags `fanslyFanEarningsSyncEnabled`/`fanslyPurchaseHistorySyncEnabled` default false + `fanslyNewStreamPageAllowlist` CSV — config-registry editable, runtimeApply reload).
5. Canonicalizers (extend sync-pull family, version bump v2): `fan_earnings_stats|fan_earnings_monthly` kinds → `fan.earnings_observed` (dedup `fan_earnings:<fan>:<window>:<payload-hash>`); `purchase_history` → `message.ppv_unlocked` (dedup `ppv:<order id>`). NB version bump makes the sweep re-visit ALL pull kinds — dedup absorbs.
6. Projection `fan_earnings_stats` (reuse Stage 10 watermark table + rebuild pattern; money: Fansly reports raw units per probe — convert at canonicalization, record raw on observation).
7. Owner-grade read endpoint on the finance surface (requireDashboardUser).
8. Tests per §5; full suite; decision entry.

**Build state (2026-07-05, capture side COMPLETE):** migrations 0060/0061; full registration sweep (enum, SYNC_STREAMS, policies — fan_earnings daily prio 20 / purchase_history 4h prio 15, domains, deps purchase_history←light, all 6 priority-by-source maps, contracts enum); handlers `executeFanEarningsChunk` (snapshot: stats+monthly pages journaled verbatim) + `executePurchaseHistoryChunk` (**probe finding: order-history is per-fan and CURSORLESS** — the "back-scroll" is a checkpointed keyset walk over page_fans via new `listPageFanNativeIds`, cursor resets on exhaustion = incremental refresh); ramp gates `fanslyFanEarningsSyncEnabled`/`fanslyPurchaseHistorySyncEnabled`/`fanslyNewStreamPageAllowlist` (EDITABLE + runtimeApply live — staged-by-process, live-editable by mechanism, so ramp flips need no restarts; deviation note). **CENTRAL DEVIATION (capture-first, recorded):** adapter typing + canonicalizers (`fan.earnings_observed`, ppv) + `fan_earnings_stats` projection writer + endpoint are DEFERRED to canonicalizer v2 AFTER the single-page ramp captures a live corpus — payload shapes are probe-grade `unknown`; guessing schemas pre-ramp is what capture-now-parse-later exists to avoid. Observations lose nothing; replay fills events retroactively. Migration 0061 ships the projection TABLE now so the v2 slice is code-only.

**v3 PARSE SIDE LANDED SAME-DAY (owner "can we do canonicalizer somehow now"):** shapes derived from the EXTENSION's production-proven parsers (`chatgoose/src/shared/types.ts` — EarningsRow/MonthlyEarningsRow/FanslyMediaOrderHistoryResponse; it parses these exact responses in production daily), units confirmed MILLS by core's own `totalGross` treatment (executor-handlers `grossAmountMills: BigInt(Math.trunc(item.totalGross))`). The ramp now VERIFIES shapes instead of discovering them. sync-pull v3 declares `fan_earnings_stats`/`fan_earnings_monthly` → `fan.earnings_observed` (per-fan-per-window aggregate with type breakdown; CONTENT-HASHED dedup key so an unchanged snapshot re-fetch appends zero — CI-proven) and `purchase_history` → `message.ppv_unlocked` (**deviation: rows carry NO order id** — composite key `ppv:<fan>:<media|bundle>:<createdAt>`). `fan_earnings_stats` projection writer (Stage 10 watermark pattern, fans upserted on demand, forward-only observed_at guard) runs in the projection sweep + `projection:rebuild fan_earnings_stats`. Integration proof: observation→events→rows, snapshot dedup, rebuild reproduces. Remaining from the original deferral: adapter typed schemas (cosmetic once ramp confirms) + the owner-grade read endpoint (rides Stage 33 or a later slice).


## Progress addendum — 2026-07-06/07 (the ramp catches the contract)

The ramp did its job twice:
1. **fan_earnings capture never returned data**: Fansly's earnings endpoints
   answer PER FAN — a windowed call without `correlationAccountId` returns
   `[]` (probe re-run with a fan id → 21 rows; day-1's "replayable" verdict
   only ever proved session acceptance, not data). Capture reworked
   (535cfb8) as a spender-scoped checkpointed walk (page_fans net > 0,
   92–994 spenders/page, two calls per fan, concatenated chunk journals —
   the canonicalizer keys rows by correlationAccountId, shape-neutral).
   VERIFIED IN PROD: lilly-1 walk completed in ~8 min → 87 spenders on the
   projection; kernel net values byte-identical to page_fans' independent
   totals for the shared top ranks.
2. **purchase_history remains blocked** (by design, loudly): order-history
   400 code-99s the per-fan `accountIds` walk — the endpoint wants
   `accountMediaId` (probe-recorded). The walk shape needs rework; the
   mass-skip circuit breaker is doing exactly what it was built for.
   OPEN ITEM for a follow-up session.

Allowlist opened fleet-wide (all 5 fansly pages) after the lilly-1
verification, 2026-07-06 ~19:05 UTC (owner-approved).
