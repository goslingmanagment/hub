# Stage 2 — Kernel destruction-door guards + chatter-read-scope fix

**Repo(s):** core · **Depends on:** — (parallel with Stage 1) · **Passport:** roadmap.md §4, stage 2

**Status header.** No deviation from the master. Verified fan-out correction carried from
decision-points §0: page DELETE cascades through **38** `ON DELETE CASCADE` FKs on `pages.id`
(`schema.ts` lines enumerated below), not 63.

## 1. Context

Two classes of one-action data loss exist today, both closable now without waiting for the ledger:
(1) **destruction doors** — an owner misclick or a single request erases a page's history: admin
"reset messages_history" hard-deletes every `page_dm_messages` row for a page with no archive-first;
admin page DELETE fans out through 38 cascade FKs (transactions included); workboard undo
hard-deletes the newest contact-log row; reclassify wholesale-deletes a page's cached verdicts.
(2) **the chatter-read-scope hole** — a leaked chatter bearer key can read a page's raw revenue and
transaction ledger, because those routes are gated only by `canAccessPage`, not by session role
(review §5.3). This stage closes both as interim guards ahead of the systematic fixes (Stage 13's
soft-delete standard, Stage 19's declarative authorization).

**Entry criteria restated as facts to verify:**
- **Verify in client code (not assumption)** that desktop and extension never call the
  to-be-gated revenue/transaction routes with bearer keys. The core-side bearer-key route inventory
  (verified): `requireApiKeyUser`-gated routes are `ai-usage/batch`, `ai/gateway/stream`,
  `events/stream`, `events/snapshot`, `ofapi/credits/summary`, `ofapi/read/*`, `ofapi/commands`(+cancel).
  The chatter-reachable revenue routes below are `canAccessPage`-only, **not** in that list. The
  spenders board (`/api/v2/spenders*`, `/api/v2/fans/search`) IS chatter-facing (extension) and must
  stay reachable — do **not** gate it here. Grep the desktop and extension repos for the exact paths
  in §2 before enforcing (Pass 3c owns those repos; this spec names the exact strings to grep).
- Workboard v1 and v2 are both served (v1 retires in Stage 23) — the undo/reclassify guards must not
  break v1 dashboard reads.

**Deliverable:** deployed guards after which a chatter-key request to a raw revenue route returns
403; page-delete on a fact-bearing page refuses; reset-messages archives-or-refuses; undo/reclassify
write retraction/supersede markers instead of hard-deleting — each shipped behind a **48 h log-only
mode** before enforcing.

## 2. Changes

**core — chatter-read-scope gate** (`apps/runtime/src/api/server.ts`, using `auth.ts` primitives):
Gate these four routes to session roles (owner/team_lead) via `requireDashboardUser`
(`auth.ts:720-727`), keeping the existing `canAccessPage` page-scope on top:
- `GET /api/v1/pages/:pageLabel/revenue` (`server.ts:859-872`)
- `GET /api/v1/pages/:pageLabel/transactions` (`server.ts:874-890`)
- `GET /api/v1/pages/:pageLabel/revenue/daily` (`server.ts:2159-2168`)
- `GET /api/v1/pages/:pageLabel/fans/:platformUserId/transactions` (`server.ts:2232-2268`)

Enforcement ships in **log-only mode first**: a `REVENUE_ROUTE_ROLE_ENFORCEMENT` env
(`log` | `enforce`, default `log`) — in `log` mode a chatter-key hit logs `would-deny` with the
path + principal and serves normally; after 48 h of clean logs, flip to `enforce` (403). The
spenders board (`/api/v2/spenders*` `:1220-1242`, `/api/v2/fans/search` `:1249`) stays
`requirePrincipal` + `assignedPageIds`-scoped — unchanged (it is chatter workflow).

**core — reset "messages_history" door** (`services/sync-blocks.ts:522-590`,
`repositories/page-dm.ts:843-865`): change `resetSyncBlock`'s `messages_history` path so that
`resetPageDmSyncState` (which today hard-deletes all `page_dm_messages` for the page at `:849`)
either (a) requires a double-confirm token on the route (`POST /api/v1/admin/sync/blocks/reset`,
`server.ts:2606-2615`) **and** archives affected conversations first, or (b) is disabled for
`messages_history` entirely until Stage 10's archive exists. **Preferred interim:** disable the
message-history reset (keep checkpoint/top-spender resets) and return a 409 explaining the archive
prerequisite — the cheapest guaranteed-no-loss option. The dashboard `ConfirmModal`
(`apps/dashboard/.../SyncBlockActions.tsx:149-158`) gets truthful copy (this is a Pass 3c dashboard
touch — named here as the interface it relies on).

**core — page DELETE guard** (`server.ts:2739-2750`, `repositories/catalog.ts:520-534`): block
`deletePageByLabel` when the page has transactions or DM messages. Interim mechanism: a pre-delete
count check in the handler that refuses with 409 if `EXISTS(transactions WHERE platform_account_id
= page.id) OR EXISTS(page_dm_messages …)`; plus set an interim **tombstone flag** (a nullable
`pages.deleted_at`/`pages.status` — Stage 13 formalizes this and flips the 38 FKs to RESTRICT). Do
not add the FK-level RESTRICT here (that is Stage 13's migration); the handler-level refusal is the
interim.

**core — workboard undo → retraction marker** (`services/workboard-v2/report.ts:316-326`,
`repositories/workboard-v2.ts:626-640`): replace `deleteLastWorkboardContact` (hard delete) with a
retraction: mark the last contact row retracted (a nullable `retracted_at` on
`workboard_contact_log`, `schema.ts:1837-1872`) instead of deleting it. Board/list reads exclude
retracted rows. This is the interim form of Stage 23's `contact.retracted` compensating event.

**core — reclassify → soft-supersede** (`repositories/workboard-v2.ts:938-943`,
`services/workboard-v2/ai-analytics.ts:172`, `scripts/workboard-v2-reclassify-page.ts:54`): replace
`clearClosingCacheForPage` (delete-all) with a supersede: keep prior `wb_closing_cache` verdicts,
mark them superseded (a `superseded_at`/`run_id` column), and let the new run write fresh rows;
reads take the latest non-superseded verdict per fan. Verdicts become an append log, not a
destructive overwrite.

## 3. Schema & data migration

Small additive columns (one migration, all nullable, no rewrite):
```sql
-- 00NN_destruction_door_guards.sql
ALTER TABLE pages                 ADD COLUMN deleted_at timestamptz;      -- interim tombstone (Stage 13 formalizes status)
ALTER TABLE workboard_contact_log ADD COLUMN retracted_at timestamptz;   -- undo marker
ALTER TABLE wb_closing_cache      ADD COLUMN superseded_at timestamptz;  -- reclassify supersede
-- (optional) index for reads that filter retracted/superseded rows:
CREATE INDEX workboard_contact_log_active_idx ON workboard_contact_log (platform_account_id, fan_id) WHERE retracted_at IS NULL;
```
No backfill (existing rows: `deleted_at`/`retracted_at`/`superseded_at` = NULL = active). Idempotent
by construction (additive columns). **No FK changes here** — the 38 cascade FKs stay until Stage 13.

## 4. Client compatibility

- **Desktop:** no change for well-behaved use. It does not call the gated revenue routes with a
  bearer key (verify at execution — it reads via `ofapi/read/*` + events + `ofapi/credits/summary`,
  all still bearer-gated). Log-only mode guarantees a 48 h safety net if that is wrong.
- **Extension:** no change. Its spenders board reads `/api/v2/spenders*` / `/api/v2/fans/search`,
  which stay chatter-accessible. Fan-profile PUT/GET untouched (target §14 invariant preserved).
- **Dashboard:** admin actions gain refusals/confirmations (reset-messages 409, page-delete 409);
  workboard undo/reclassify behave identically to the user (retracted/superseded rows are hidden) —
  the only difference is data is preserved. Copy updates on the reset modal are Pass 3c's.
- **Workboard (kernel v1/v2):** both keep working; undo and reclassify change storage, not UX.

**Compatibility invariants (target §14):** chatter bearer keys keep working (only their *scope*
narrows on the four raw-revenue routes); fan-profile PUT/GET pair untouched; read-gateway path shape
untouched; command outbox untouched.

## 5. Tests & verification

**New tests (integration, Testcontainers):**
- A chatter-key request to each of the four gated routes returns 403 in `enforce` mode and logs
  `would-deny` in `log` mode (assert both).
- A chatter-key request to `/api/v2/spenders` still returns 200 (regression guard — do not
  over-gate).
- `POST /admin/sync/blocks/reset` for `messages_history` refuses (409) / archives-first; checkpoint
  and top-spender resets still succeed.
- Page DELETE on a page with a transaction row → 409; on an empty page → 200.
- Undo produces a `retracted_at` row (not a missing row); the fan's last contact is excluded from
  list reads.
- Reclassify produces superseded rows retained + new rows; reads return the new verdict.

**Existing suites:** workboard v1/v2 integration suites, sync-blocks suite.

**Production verification (exit criteria):**
- 48 h of `would-deny` logs reviewed → zero legitimate client hits → flip to `enforce`; then a
  chatter-key probe to a revenue route returns 403.
- A page-delete attempt on a fact-bearing page is refused (smoke).
- Undo/reclassify produce marker rows (query `retracted_at IS NOT NULL` / `superseded_at IS NOT NULL`
  after a test action).

## 6. Rollback

- Role enforcement: set `REVENUE_ROUTE_ROLE_ENFORCEMENT=log` (or unset) to revert to serving —
  instant, no data effect.
- Reset/delete guards: env/flag-guarded refusals; revert the handler change to restore prior
  behavior (not recommended — prior behavior is the data-loss door).
- Migration: the three additive nullable columns are safe to keep even on rollback; a down-path
  `DROP COLUMN` is available but unnecessary. No data is destroyed by this stage, so there is no
  irreversible step.

## 7. Assumptions

1. **The §2.6 client route inventories are complete** — desktop/extension do not call the four
   gated routes with bearer keys. The 48 h log-only mode is the containment if this is wrong; the
   authoritative check is a grep of both client repos at execution (Pass 3c).
2. **The spenders board is intended chatter workflow** and must remain reachable — gating it would
   break the extension. Drift signal: a future decision to make spend data owner-only (then move it
   into Stage 19's policy, not here).
3. **Workboard v1 and v2 are both still served** (v1 retires in Stage 23); the undo/reclassify
   guards touch v2 paths (`report.ts`, `ai-analytics.ts`) — verify v1 has no separate hard-delete
   undo (it has snooze/unsnooze only, `services/workboard.ts:172-209`).
4. **`pages.deleted_at` added here is interim** and is superseded by Stage 13's formal
   `status`/`deleted_at` soft-delete + FK RESTRICT flip. Drift signal: Stage 13 must reconcile with
   this column rather than add a second one.
5. **Config staged flips are already attributed** (`config_settings.updated_by_user_id`,
   `config_audit_log.user_id`) — not a gap this stage needs to close; the remaining attribution gaps
   (contact-log actor, snoozes, manual sync) are Stage 22's, not here.

## 8. Task breakdown

1. **Migration** (3 additive nullable columns + partial index). Done-check: `schema-guard` passes;
   migration applies+reverts cleanly on staging. *(≤0.3 session)*
2. **Chatter-read-scope gate** with `log`/`enforce` env on the four routes. Done-check: the 403 +
   spenders-200 integration tests. *(≤0.5 session)* *(parallel with 1)*
3. **Reset-messages + page-delete guards.** Done-check: reset-409 + delete-409 tests. *(≤0.5 session)*
4. **Undo retraction + reclassify supersede.** Done-check: marker-row tests. *(≤0.5 session)*
   *(parallel with 3)*
5. **(Last) Deploy log-only, review 48 h, flip to enforce, record verification** in the stage file.
   *(ops)*

---

## Progress

*Working scratchpad — exempt from the append-only rule. Session 2026-07-05, branch `kernel/stage-02-destruction-doors` (based on `kernel/pass3-spec-fixup` tip so decisions.md stays linear; owner merges the chain stage-01 → spec-fixup → stage-02).*

**Pre-flight (done):** §5 deps: none (parallel with Stage 1). Entry criteria verified in client code: desktop (`chatgoose_desktop_fable`) calls core only for `/api/v1/pages`, fan profiles, OFAPI read lanes; extension (`chatgoose`, branch bar-tone-menu) calls `/api/v1/pages`, profiles, `ai-usage/batch` — **neither touches the four gated routes, and the extension never calls `/api/v2/spenders` (its spenders board scans Fansly directly)**. All §2/§7 code refs verified; one structural finding: `wb_closing_cache` had UNIQUE(page,message) + upsert writer, so §2's supersede design ("new run writes fresh rows") required converting it to a **partial unique on active rows** — §3's ADD-COLUMN-only sketch was incomplete; recorded as deviation.

**§8 checklist:**
- [x] 1. Migration **0053** + schema (3f789c3) — pages.deleted_at (substrate, unwritten), workboard_contact_log.retracted_at + active partial index, wb_closing_cache.superseded_at + partial active unique replacing the full unique; schema-guard green
- [x] 2. Chatter-read-scope gate (6e19f7d) — `REVENUE_ROUTE_ROLE_ENFORCEMENT` (log|enforce, default log, env-only) + `enforceRevenueRouteRoleScope` in auth.ts layered after canAccessPage on the four routes; integration test covers log-200+would-deny-log, enforce-403, owner-session-200, spenders-200
- [x] 3. Reset + delete guards (7448bb9) — messages_history reset 409s before touching state (audience/financials resets still 200); admin page DELETE 409s on fact-bearing pages via getPageBusinessFactPresence, empty pages still delete
- [x] 4. Undo retraction + reclassify supersede (335bdf2) — retractLastWorkboardContact / supersedeClosingCacheForPage; 2 contact-log readers + 5 cache joins + 3 cache scans filter markers; upsert targets the partial unique (targetWhere); integration tests for both flows
- [ ] 5. Deploy log-only, 48 h would-deny review, flip to enforce, record verification (ops, owner-run)

**Green-local reached 2026-07-05:** full `pnpm test` 166 files / **1402 passed / 0 failed**; typecheck clean; decisions.md #65 appended (commit 734cef8). One pre-existing test met the new guard and was updated (admin CRUD deleted fact-bearing lana expecting 200 → now asserts the 409 first, clears fixture transactions, then keeps the cascade assertions — commit 2231112). Stage branch: 3f789c3 → 6e19f7d → 7448bb9 → 335bdf2 → 2231112 → 734cef8.

**Owner-run deploy steps (stage exit):**
1. Merge the branch chain into `main` (stage-01 → pass3-spec-fixup → stage-02).
2. Deploy (`scripts/deploy-production.sh --mode dist-only root@45.8.230.111`) — ships migration 0053; no env change needed at first (REVENUE_ROUTE_ROLE_ENFORCEMENT defaults to `log`).
3. Watch 48 h for `would-deny` in api logs (`docker logs agency-hub-api-1 | grep would-deny`). Zero legitimate hits expected (client grep already clean).
4. Flip: set `REVENUE_ROUTE_ROLE_ENFORCEMENT=enforce` in `/opt/agency-hub/.env.production`, restart api. Probe a revenue route with a chatter key → 403.
5. Smoke: page-delete attempt on a fact-bearing page → 409; a workboard undo then `SELECT count(*) FROM workboard_contact_log WHERE retracted_at IS NOT NULL` > 0; after a reclassify, `SELECT count(*) FROM wb_closing_cache WHERE superseded_at IS NOT NULL` > 0.
6. Flip execution-log.md row 2 to `exited (prod-verified <date>, <commit>)`.

**DEPLOYED 2026-07-05 00:00 UTC** with Stage 1 (image 89fa290, migration 0053 applied 23:57:27 UTC, marker columns confirmed in prod). Gate live in `log` mode (env absent = default). Remaining to exit: 48 h `would-deny` review (`docker logs agency-hub-api-1 | grep would-deny` — expected zero) → set `REVENUE_ROUTE_ROLE_ENFORCEMENT=enforce` + recreate api container (compose --env-file, NOT docker restart) → chatter-key 403 probe + smoke (fact-bearing delete 409, retraction/supersede markers after a workboard undo/reclassify).
