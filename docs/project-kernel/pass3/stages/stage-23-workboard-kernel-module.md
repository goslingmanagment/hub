# Stage 23 — Workboard kernel module

**Repo(s):** core · **Depends on:** 21 (events drive recompute), 22 (attribution + grants) ·
soft: 16 (Fansly earnings board data) · **Passport:** roadmap.md §4, stage 23

**Status header.** No deviation. One verified sharpening of the "compute-but-can't-serve split":
recompute already scores OnlyFans pages (`listWorkboardRecomputePageIds` selects
`fansly OR (onlyfans AND ofapi_account_id IS NOT NULL)`, `repositories/workboard-v2.ts:647-656`)
while every v2 read/write gate throws for non-Fansly (`resolveAccessibleFanslyPage` →
`fansly-page.ts:20-21`) — the fix is deleting one accessor's platform guard, not a compute
rework. The owner's v1-scope note (Fansly-first workboard **app**) affects Stage 34, not this
module's neutrality.

## 1. Context

The kernel side of "who to message now and why": the 822-line pure engine
(`services/workboard-v2/engine.ts`, exports `computeValue…evaluateFan`, `:172-707`) is proven but
runs on a nightly cron (recompute 03:00 UTC, classify 01:00 — `sync-queue.ts:151-152`), serves
Fansly only, hard-deletes contact history on undo (`deleteLastWorkboardContact`,
`workboard-v2.ts:625-640` — still a hard delete unless Stage 2 landed first), and attributes
nothing. This stage makes the module platform-neutral, event-driven (seconds, not 03:00),
lease-coordinated, and attributed — everything the future workboard app needs, none of it
blocked on DP 4.

**Entry criteria restated as facts to verify:**
- Domain events flowing for both platforms: `message.*`, `transaction.posted`,
  `subscription.*`, `presence.*` (Stage 21 entry re-check) — presence via the #50 projection
  (`ofapi-presence-projection.ts:127-149`) canonicalized by Stage 8.
- Stage 22 columns live (`acted_by_user_id`, grants) — attribution lands on them.
- v1 consumer inventory: confirm dashboard-only (grep the dashboard for the four v1 routes
  `server.ts:1088-1112`; grep desktop/extension repos — expect zero).

**Deliverable:** boards served for both platforms from module routes; event-driven recompute in
seconds with the nightly sweep demoted to reconciler (diff = 0 over a week); claim leases;
attributed contact log with compensating-event undo; v1 routes removed.

## 2. Changes

**core — module + platform neutrality:** the engine transfers **intact with its tests** into the
Stage 19 `workboard` module (byte-for-byte move; if 19 hasn't shipped, the move is a folder
rename with the same discipline). `resolveAccessibleFanslyPage`'s platform throw
(`fansly-page.ts:20-21`) is replaced by a neutral `resolveAccessibleWorkboardPage` (grant check
via Stage 22 expansion; platform-agnostic); the v2 read routes (`server.ts:1120-1200`) serve
OnlyFans pages — the compute side already covers them.

**core — event-driven recompute:** a module subscriber consumes `message.*`,
`transaction.posted`, `subscription.*`, `presence.*` (in-process consumer on the Stage 21 hub,
or direct pg-boss jobs enqueued from the canonicalization driver — decide at execution;
default: enqueue from the driver to avoid SSE coupling) → **debounced per-fan recompute** jobs:
pg-boss `singletonKey='<pageId>:<fanId>'` + a short debounce delay (e.g. 5 s) so bursts collapse
(the group-serialization machinery precedent, `sync-queue.ts:177`). The nightly 03:00 sweep
(`recomputeAllWorkboardPages`, `worker-services.ts:165-168`) is kept and **demoted to
reconciler**: it computes but also diffs against the event-driven state and emits a
`workboard_reconcile_drift` counter (target: 0).

**core — claim leases:** new table (§3) + routes (`POST /workboard/v2/claim`,
`DELETE .../claim/:fanId`): soft "I'm working this fan" locks — TTL'd (default 30 min), owner
visible on board reads, non-blocking (a second chatter sees the claim, is not prevented —
coordination, not access control per DP 4c note). Claim/release are event-logged (operator-class
observation or a `workboard.claimed` domain event — observation is enough; no client consumes a
claim stream yet).

**core — attribution + compensating undo:** contact log writes `acted_by_user_id`
(Stage 22 column) from the acting principal (`server.ts:1136-1142` route); undo
(`DELETE /v2/contact/:fanId` `:1168` → `report.ts:316-326`) becomes: mark the row
(`retracted_at` — reuse Stage 2's column if present, add it here if not) + emit a
`contact.retracted` compensating event (module-emitted domain event on the page's account
stream) — **the hard delete dies** (`deleteLastWorkboardContact` replaced). Classifier verdicts:
reclassify soft-supersedes (`superseded_at` per Stage 2; if Stage 2 didn't land, add here —
`clearClosingCacheForPage` `workboard-v2.ts:937-941` replaced by supersede-write).

**core — v1 retirement:** after the consumer inventory confirms dashboard-only, the four v1
routes (`server.ts:1088,1096,1104,1112`) are removed and the dashboard workboard tab moves to
the v2/module routes (same-repo dashboard change rides this stage); `services/workboard.ts` +
`repositories/workboard.ts` deleted. Snooze v1/v2 duplication collapses to the module's.

**core — board events for the future app:** on recompute completing with a state change, emit
`workboard.state_changed` (account-scoped domain event, small payload: pageId, fanId, tab
transition) — rides stream v2 for Stage 34's app; dashboard may consume in 33.

## 3. Schema & data migration

```sql
-- 00NN_workboard_module.sql
CREATE TABLE workboard_claim_leases (
  id bigserial PRIMARY KEY,
  platform_account_id bigint NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  fan_id bigint NOT NULL REFERENCES fans(id) ON DELETE CASCADE,
  claimed_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  UNIQUE (platform_account_id, fan_id)      -- one live claim per fan (upsert refreshes)
);
-- If Stage 2 did not land: ALTER TABLE workboard_contact_log ADD COLUMN retracted_at timestamptz;
--                          ALTER TABLE wb_closing_cache      ADD COLUMN superseded_at timestamptz;
```
No data migration (contact history stays; verdict cache stays). Idempotency: recompute jobs are
singleton-keyed; reconciler diff is read-only.

## 4. Client compatibility

- **Dashboard:** workboard views keep working, moved onto module routes in the same deploy
  (same repo — atomically consistent); v1 tab dies with its routes. Board data for OnlyFans
  pages appears (new, additive).
- **Desktop / extension:** unaffected (neither consumes workboard routes — re-verified in the
  entry inventory).
- **Workboard app (34):** gains its complete kernel API — module routes + `workboard.state_changed`
  on stream v2 + leases + attribution; the module API stays app-agnostic (DP 4 deferred).

**Compatibility invariants (target §14):** none in play (workboard routes are dashboard-only;
the retirement is the last-consumer-migrates rule executed within one repo/deploy).

## 5. Tests & verification

**New tests:** engine tests transfer green (byte-move proof); event→recompute integration (a
`message.received` fixture updates board state within the debounce window); debounce collapse
(N events → 1 recompute); claim lease lifecycle (claim, refresh, expire, release; second-user
visibility; no access denial); undo produces `retracted_at` + `contact.retracted` event, board
excludes the contact; reclassify supersedes (old verdicts retained); OnlyFans board read returns
data (neutrality proof); v1 routes 404 after removal + dashboard tab works on module routes.

**Existing suites:** workboard v2 suite (updated route module paths), classifier suite,
dashboard workboard page tests.

**Production verification (exit criteria):**
- Staging harness: board state changes within seconds of a triggering event (measure; record
  p95 event→board latency).
- One week: nightly reconciler drift counter = 0 (event-driven results equal the sweep's).
- Claim lease prevents double-work in a two-user drill (staging).
- v1 routes gone (prod 404 probe); dashboard tab on module routes; OnlyFans board visible to the
  owner.

## 6. Rollback

- Event-driven recompute is additive — disable the subscriber/jobs and the nightly sweep is the
  (current) behavior again.
- v1 route removal is the one consumer-visible step; it ships last within the stage and reverts
  by git if the dashboard move regresses (same repo, same deploy — low risk).
- Leases/attribution/undo changes are additive; no data loss anywhere (that's the point).

## 7. Assumptions

1. **DP 4's design pass is still pending** — module API stays app-agnostic; nothing here
   presumes the app's auth or shape.
2. **Presence events exist for OnlyFans** (#50 projection → Stage 8 canonicalizer); Fansly
   presence stays fetch-on-read (`workboard-presence.ts:119,155-171`) until/unless a Fansly
   presence stream exists — board freshness for Fansly presence is unchanged (recorded, not a
   regression).
3. **Stage 2's columns** may or may not exist — this spec carries the conditional DDL both ways
   (reconcile, don't duplicate — Stage 2 assumption 4 mirrored).
4. **Recompute cost per fan** is the engine's current cost (pure function over projections) —
   debounce + per-fan serialization contains hot-account storms (passport containment); the
   reconciler is the safety net for missed events.
5. **v1 has no non-dashboard consumer** — the inventory is the gate; anything found = blocker,
   not workaround.

## 8. Task breakdown

1. **Module move (engine + tests byte-for-byte) + neutral accessor + OnlyFans serving.** *(0.5–1
   session)*
2. **Event-driven recompute (driver enqueue + debounce + singleton keys) + reconciler demotion +
   drift counter.** *(1 session)*
3. **Claim leases (table + routes + board surfacing) + `workboard.state_changed` emission.**
   *(0.5–1 session)* *(parallel with 2)*
4. **Attribution + compensating undo + supersede (conditional DDL).** *(0.5 session)*
5. **v1 retirement + dashboard tab move.** *(0.5 session — last code task)*
6. **(Last) Deploy; staging latency harness + two-user lease drill; one-week reconciler-drift
   watch; record results here.** *(ops)*

## Progress

**Session 1 (2026-07-06, branch `kernel/stage-21-event-stream-v2` continued as the chain —
Stage 23 commits 377b528 / 4a4054a / 69baf3f / 6318372 / 2c9a124 after Stage 22 on the same
tip; ordering deviation per the standing owner "continue": deps 21+22 are green-local, deploy
follows the chain):**

§8 checklist — **Tasks 1–5 BUILT** (decision #94). Suite after the last commit:
**188 files / 1527 tests green**. Migration **0066**.

- [x] **Task 1** (377b528) — ten engine files git-mv'd byte-for-byte into
  `apps/runtime/src/modules/workboard/`; `resolveAccessibleWorkboardPage` (grant check via
  canAccessPage, NO platform throw) replaces resolveAccessibleFanslyPage at all ten call
  sites — OnlyFans boards serve. Module door = index.ts re-exports.
- [x] **Task 2** (4a4054a) — WORKBOARD_FAN_RECOMPUTE_QUEUE + hub subscriber
  (`services/workboard-event-recompute.ts`): fan-relevant events → boss.send with
  singletonKey `<account>:<fanIdentityRef>` + startAfter 5 s (bursts collapse); job resolves
  the native ref via findPlatformFan (unknown fan = recorded skip, reconciler covers).
  recomputeAllWorkboardPages returns `changed` = **workboard_reconcile_drift** counter
  (nightly handler logs warn>0/info=0).
- [x] **Task 3** (4a4054a) — migration 0066 `workboard_claim_leases` (UNIQUE(page,fan);
  claim = upsert refresh/STEAL, non-blocking; release = stamp; TTL default 30 min capped
  240; expiry read-filtered). Routes workboardV2Claim/workboardV2Unclaim
  (kind:"any-session" + scope:"page" — chatters claim their own work); `claims[]` rides the
  board response; recordAudit fan_claimed/fan_released. `workboard.state_changed` emitted on
  REAL tab transitions only (before/after snapshot incl. removals; observationId 0 sentinel,
  time-based dedupKey).
- [x] **Task 4** (4a4054a) — undo emits `workboard.contact_retracted` (NAMING DEVIATION:
  spec wrote contact.retracted; namespaced to match state_changed) with
  retractedByUserId, ONLY when retractLastWorkboardContact actually stamped a row (now
  returns boolean). retracted_at + attribution columns landed Stages 2/22.
- [x] **Task 5** (6318372 + fallout 2c9a124) — v1 retirement: inventory gate passed
  (dashboard-only; desktop grep clean). 4 routes + contracts + schemas + types removed;
  absence pinned by contract test AND api.integration 404 probe. services/workboard.ts +
  workboard-presence.ts + repositories/workboard.ts deleted; unsnoozeWorkboardFan moved
  verbatim to the v2 repo. Dashboard: /workboard renders WorkboardV2Page; /workboard/v2 →
  legacy redirect (crm precedent); single neutral sidebar entry (OnlyFans visible); v1
  page/view-model/theme/4 components deleted. Presence-panel consequence recorded in #94:
  the on-demand follower refresh died with it; presence rides follower sync + OFAPI
  webhooks → v2 `online` flag (ofapi-presence suite proves projection→board end to end).
- [x] **Tests** (69baf3f) — `tests/workboard-stage23.integration.test.ts`: lease lifecycle
  (claim/steal/release/expiry, one row per fan), claim services + audit + board surfacing,
  state_changed real-transitions-only, contact_retracted once-only, OnlyFans board read,
  hub→job mapping (relevance filter, ordered-delivery proof, singletonKey/startAfter), job
  fan resolution (page_missing/fan_unknown/evaluated).
- [ ] **Task 6 (ops)** — deploy 0066 with the chain → staging latency harness (p95
  event→board inside the 5 s debounce) → two-user lease drill → ONE WEEK reconciler drift
  = 0 → prod 404 probe on the four v1 paths + dashboard tab check + OnlyFans board visible
  to the owner.

Gotchas for the next session: worker-startup's closed sync-queue mock needed the new queue
const + an async stop() on the event-recompute handle mock; the auth-policy module matrix and
identity-grants attribution now ride v2 URLs; contract edits to routes.ts must match whole
balanced blocks (a single-line enum removal that pattern-matched to the next `});` swallowed
unrelated schemas mid-session — caught by typecheck, redone bounded).
