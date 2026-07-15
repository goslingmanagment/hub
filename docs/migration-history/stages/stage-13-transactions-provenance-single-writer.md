# Stage 13 — Transactions provenance, currency, single-writer gate

**Repo(s):** core · **Depends on:** Q1 (answered); soft: 7 (FK target for `source_observation_id`)
· **Passport:** roadmap.md §4, stage 13

**Status header — one elaboration to the passport (flag for sign-off), plus the Q1 shrink:**

1. **The `source` enum gains `fansly:rest`.** The passport's value list
   (`'onlymonster' | 'ofapi:webhook' | 'ofapi:rest' | 'harvest' | …`) predates the production
   re-check: the five Fansly pages also write `transactions` (raw_type = bare numeric Fansly type
   codes: `2110`, `15001`, `16013`, … — re-verified live 2026-07-04), so the provenance backfill
   must be **platform-aware**, not "non-ofapi ⇒ onlymonster". Values:
   `'onlymonster' | 'ofapi:webhook' | 'ofapi:rest' | 'fansly:rest' | 'harvest'` (open set —
   text + CHECK, not a pgEnum, so later producers add values without enum surgery).
2. **Q1 shrink honored:** re-verified against production 2026-07-04 (this session, SSH +
   prod-Postgres): zero OnlyMonster rows exist; both OnlyFans pages are 100 % `ofapi:%`-fed
   (685 + 2,162 rows); no dual-fed page. **Per-page reconciliation is moot; the structural gate is
   still built** (the passport's own instruction). `ofapiSpendTransactionIngestEnabled` is already
   running-on — the gate arrives *after* the flag, so the gate's default assignments must match
   the running reality (OFAPI pages get `transactions_writer='ofapi'` in the same migration, or
   the live ingest would start refusing).

## 1. Context

Money consolidation is only safe if "which system wrote this row" is a column and two writers can
never fight over one page. Today `transactions` has **no provenance and no currency column**
(verified: full column list at `packages/db/src/schema.ts:1203-1261`; dedup is only the
`(platform_account_id, transaction_id)` unique at `:1241-1244`), and nothing stops two paths
feeding one page. This stage adds provenance + currency, backfills them, installs a per-page
single-writer registry enforced in every write path, and formalizes page soft-delete with
RESTRICT on fact-table FKs (closing the 38-FK cascade door).

**Entry criteria restated as facts to verify:**
- Q1/dual-fed re-check (run the §2.1 roadmap queries in prod): still zero non-`ofapi:%` rows on
  OnlyFans pages. If a dual-fed page has appeared → stop; per-page reconciliation revives.
- `#51/2` state: `ofapiSpendTransactionIngestEnabled` running-on (it is, since 2026-06-19) — see
  Status note 2; the migration must seed writers accordingly.
- Stage 2 executed or not? If its interim `pages.deleted_at` column exists, this stage reuses it;
  if Stage 2 has not run, this stage adds the full tombstone itself (verified 2026-07-04: **not
  yet in code** — `deletePageByLabel` is still a hard DELETE, `catalog.ts:520-534`).
- Stage 7 deployed? If yes, `source_observation_id` gets its FK now; if not, plain bigint now, FK
  added in a follow-up migration when `observations` exists (soft dep per the master).

**Deliverable:** one migration + write-path guards after which every `transactions` row carries
`source` and `currency`, a wrong-writer insert is refused loudly (incident), page hard-delete is
structurally impossible on fact-bearing pages, and dashboard revenue totals are byte-identical.

## 2. Changes

**core — schema (`packages/db/src/schema.ts`)**: `transactions` gains `source` (text NOT NULL
after backfill, CHECK-constrained), `sourceObservationId` (nullable bigint), `currency` (char(3)
NOT NULL DEFAULT 'USD'); `pages` gains `transactionsWriter` (text, nullable, CHECK
`('onlymonster','ofapi','fansly')`) and — if Stage 2 hasn't already — `deletedAt timestamptz` +
`status` (text default 'active', CHECK `('active','deleted')`).

**core — write-path guards** (all four verified writers; each stamps `source` and refuses on
writer mismatch):
- `upsertTransaction` (`packages/db/src/repositories/transactions.ts:52-99`) gains a required
  `source` field — the compiler forces every caller to declare provenance.
- OnlyMonster path `syncOnlyFansTransactions` (`services/sync/onlyfans-transactions.ts:1996`; four
  upsert sites `:656/:702/:1611/:1818`): stamps `source:'onlymonster'`; entry guard — if
  `page.transactions_writer !== 'onlymonster'` → abort the chunk, open incident (reuse
  `notifySyncChunkFailureIncident`, `services/notification-incidents.ts:279`; add a
  `wrong_transactions_writer` code), **never silent-skip**.
- OFAPI ingest `applyOfapiSpendProjectionTransactions`
  (`services/ofapi-spend-transaction-ingest.ts:104`; rawType stamp `:78`): stamps
  `source:'ofapi:webhook'`, `source_observation_id` from the journal row once Stage 7 maps it;
  guard on `transactions_writer === 'ofapi'` (same incident pattern) — evaluated inside the
  existing per-page advisory lock (`withOfapiSpendTransactionPageLock`, `:49`).
- REST backfill (`services/ofapi-transactions-backfill.ts:691`): stamps `source:'ofapi:rest'`;
  `loadWriteEligibility` (`:371`) gains the writer check (it already refuses pages with active
  non-`ofapi:%` rows, `:404-412` — the writer column subsumes and formalizes that heuristic).
- Fansly path `syncTransactions` (`services/sync/transactions.ts:407`): stamps
  `source:'fansly:rest'`; guard on `transactions_writer === 'fansly'`.

**core — page soft-delete + cascade close:**
- `deletePageByLabel` (`packages/db/src/repositories/catalog.ts:520-534`) becomes a tombstone
  UPDATE (`status='deleted', deleted_at=now()`); the route (`server.ts:2739-2750`) keeps its
  shape; list/lookup queries exclude deleted pages (audit each `pages` read site).
- FK policy per target §5.3 — classify the 38 `ON DELETE CASCADE` FKs on `pages.id` (count
  verified): **fact tables → RESTRICT** (`transactions`, `page_dm_messages`,
  `page_dm_conversations`, `dm_message_archive`(already RESTRICT-shaped? verify), `page_fans`,
  `sync_raw_payloads`, `ofapi_commands`, credit/spend-shadow rows, contact log);
  **projections/config/cache → CASCADE stays** (`page_sync_states`, `page_sync_cursors`,
  `sync_rate_limits`-adjacent, rollups `revenue_daily`/`fan_spend_*` — rebuildable). The
  execution session enumerates all 38 with the schema in hand and records the classification in
  the migration comment; the rule above is binding, the enumeration is mechanical.

## 3. Schema & data migration

```sql
-- 00NN_transactions_provenance.sql
ALTER TABLE transactions
  ADD COLUMN source text,
  ADD COLUMN source_observation_id bigint,     -- FK added when observations exists (Stage 7)
  ADD COLUMN currency char(3) NOT NULL DEFAULT 'USD';

ALTER TABLE pages
  ADD COLUMN transactions_writer text
    CHECK (transactions_writer IN ('onlymonster','ofapi','fansly')),
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
  ADD COLUMN deleted_at timestamptz;           -- skip the two page columns if Stage 2 added them

-- Writer seed (matches running reality — see Status note 2):
UPDATE pages SET transactions_writer = CASE
  WHEN platform = 'fansly' THEN 'fansly'
  WHEN platform = 'onlyfans' AND ofapi_account_id IS NOT NULL THEN 'ofapi'
  ELSE NULL END;                               -- NULL = no writer yet (Stage 14 sets it per page)

-- Provenance backfill (batched, e.g. 10k rows/iteration on id ranges; idempotent via source IS NULL):
UPDATE transactions t SET source = CASE
  WHEN t.raw_type LIKE 'ofapi:%' THEN
    CASE WHEN EXISTS (SELECT 1 FROM ofapi_spend_projection_events s
                      WHERE s.page_id = t.platform_account_id
                        AND s.transaction_id = t.transaction_id
                        AND s.projection_status = 'projected')
         THEN 'ofapi:webhook' ELSE 'ofapi:rest' END
  WHEN p.platform = 'fansly' THEN 'fansly:rest'
  ELSE 'onlymonster' END
FROM pages p WHERE p.id = t.platform_account_id AND t.source IS NULL;

ALTER TABLE transactions ALTER COLUMN source SET NOT NULL,
  ADD CONSTRAINT transactions_source_check CHECK (source IN
    ('onlymonster','ofapi:webhook','ofapi:rest','fansly:rest','harvest'));
CREATE INDEX transactions_source_idx ON transactions (source);

-- 00NN+1_pages_fk_restrict.sql — per the §2 classification, per fact table:
--   ALTER TABLE <fact> DROP CONSTRAINT <fk>, ADD CONSTRAINT <fk>
--     FOREIGN KEY (platform_account_id) REFERENCES pages(id) ON DELETE RESTRICT;
```
Notes: `currency` with DEFAULT is metadata-only in PG ≥11 (no rewrite); the shadow table already
check-constrains currency to USD (`schema.ts:2076`) and both ingest paths skip non-USD
(`ofapi-transactions-backfill.ts:246-248`), so `'USD'` is faithful for all existing rows. The
webhook-vs-rest split via the shadow join is best-effort for history (overlap rows classify as
webhook — acceptable; both are OFAPI truth); writers stamp exact values from now on.
**Verification query (completeness):** `SELECT count(*) FROM transactions WHERE source IS NULL`
→ 0; per-page/month gross sums before vs after → identical (snapshot table or CSV diff).

## 4. Client compatibility

- **Desktop / extension:** none. No consumed contract changes; the spenders/fan endpoints keep
  their shapes (new columns are not exposed until a contract deliberately adds them).
- **Dashboard:** none required; revenue reports read the same rollups. Optional later: show
  provenance in admin views (Stage 33).
- **Workboard:** n/a.

**Compatibility invariants (target §14):** all preserved — this is storage-plane only. API
responses gain nothing yet ("optional fields only" per the passport is deferred until a contract
consumer needs them).

## 5. Tests & verification

**New tests:**
- Unit: `upsertTransaction` requires `source` (type-level; plus runtime CHECK test).
- Integration: wrong-writer refusal — a page with `transactions_writer='ofapi'` + a simulated
  OnlyMonster chunk → chunk aborts, `notification_incidents` row with the new code, zero rows
  written; same for the inverse and for the Fansly path.
- Integration: page DELETE route on a fact-bearing page → tombstone (row remains,
  `status='deleted'`), FK-level RESTRICT proven by attempting a raw DELETE in the test (throws).
- Migration test (staging copy): backfill completeness query = 0 NULLs; revenue totals diff = 0;
  re-running the backfill UPDATE matches 0 rows (idempotency).

**Existing suites:** transactions/rollup suites, spend-ingest suite, backfill CLI tests, catalog
admin tests.

**Production verification (exit criteria):**
- `SELECT source, count(*) FROM transactions GROUP BY 1` — 100 % coverage, plausible split
  (expect only `ofapi:webhook`/`ofapi:rest`/`fansly:rest` at current state).
- Dashboard revenue totals identical pre/post (per-page/month sum diff = 0).
- A staged wrong-writer probe on staging refuses + incidents.
- Ingest keeps flowing post-deploy: `max(created_at)` on `transactions` for OFAPI pages advances
  within the webhook cadence (the gate must not have broken the live writer).

## 6. Rollback

- Guards are code: revert the deploy to restore prior write behavior (columns are inert without
  the code). The migration is additive — safe to leave in place on rollback.
- FK RESTRICT flips have a mechanical down-path (re-ADD CASCADE) — but rolling *back* to cascade
  re-opens the destruction door; only do it under owner instruction.
- The backfilled `source` values are derived data over immutable inputs (raw_type, platform,
  shadow rows) — re-runnable, no destructive step anywhere. **No irreversible action in this
  stage.**

## 7. Assumptions

1. **`raw_type` prefix is a faithful provenance proxy for history**: `ofapi:` prefix is written
   only by the two OFAPI paths (`ofapi-spend-transaction-ingest.ts:78`,
   `ofapi-transactions-backfill.ts:697`); OnlyMonster wrote bare vendor strings
   (`packages/onlyfans/src/mappers.ts:5-12`); Fansly writes bare numeric codes. Verified in code
   and against production data 2026-07-04.
2. **No third writer path exists** — all four writers route through `upsertTransaction`
   (verified); the Stage 12 harvest (future) arrives via the ledger with `source='harvest'`.
3. **Zero OnlyMonster rows in production** (re-verified this session). If any appear before
   execution, the `ELSE 'onlymonster'` backfill arm and a reconciliation step activate — re-check
   at execution.
4. **`ofapiSpendTransactionIngestEnabled` stays on** through the deploy; the writer seed makes the
   gate a no-op for the live path on day one.
5. **The 38-FK count and the fact/projection classification** hold as of `schema.ts` today; the
   execution session re-enumerates before writing the FK migration.
6. **Unit stays mills** (Q6/Proposal 1 accepted): no unit change here; `currency` is a label, not
   a conversion.

## 8. Task breakdown

1. **Migration 1** (columns + writer seed + provenance backfill + NOT NULL + CHECK). Done-check:
   staging apply; completeness + totals-diff queries pass. *(≤0.5 session)*
2. **`upsertTransaction` source-required + four writer stamps/guards + incident code.**
   Done-check: wrong-writer integration tests; ingest still green. *(1 session)*
3. **Soft-delete formalization + FK classification + Migration 2** (RESTRICT flips). Done-check:
   tombstone + RESTRICT tests; classification recorded in migration comment. *(0.5–1 session)*
4. **(Last) Deploy; run the §5 production checks; record results here.** *(ops)*

## Progress

*Working scratchpad — session 2026-07-05, branch `kernel/stage-13-transactions-provenance` off main@d8525ca (Stage 7 build-complete slice deployed ~02:47 UTC; observations live in prod → the soft dep is satisfied at build time).*

**Pre-flight verified:** next migrations = **0055/0056**; Stage 2 interim `pages.deleted_at` EXISTS (0053) and nothing writes it — reused, only `status` added; Stage 7 deployed → observation links land NOW (not a follow-up); prod Q1 re-check deferred to deploy time (the migration's `ELSE 'onlymonster'` arm handles any surprise rows; zero expected per #67).

**§8 checklist:**
- [x] 1. **Migration 0055** — provenance columns + writer seed + backfill + NOT NULL + CHECK + index, plus `wrong_transactions_writer` incident-kind enum value. **Deviation (recorded):** `source_observation_id` is a PLAIN bigint, NOT an FK — `observations` PK is `(id, received_at)` (partitioning), PG cannot FK it on `id` alone; same limitation 0054 hit for unique keys. Single-statement backfill (not batched): ~3k rows in prod. `currency char(3) DEFAULT 'USD'` — metadata-only in PG≥11.
- [x] 2. **`upsertTransaction` requires `source`** (`TransactionSource` union; 77 call sites updated across 8 test files prove the compiler gate) + **all four writer paths stamp & guard** via new `transactions-writer-gate.ts` (`assertPageTransactionsWriter` → incident `wrong_transactions_writer` opens IMMEDIATELY, then throws — never silent): OnlyMonster chunk entry, Fansly chunk entry, OFAPI ingest (inside the page lock; refused page's rows stay pending and re-list, other pages still apply), REST backfill (`loadWriteEligibility` gains `wrong_transactions_writer` reason; the old active-non-ofapi heuristic stays for pre-registry data). OFAPI ingest also links `source_observation_id` via `findObservationByKey(webhook, sourceIdempotencyKey)` — the ingest-row SELECT gained `source_idempotency_key`.
- [x] 3. **Soft-delete + FK flips** — `deletePageByLabel` = tombstone UPDATE (`status='deleted', deleted_at=now()`, active-only WHERE → repeat delete 404s); DELETE route drops the Stage 2 handler 409 (per §5: fact-bearing pages tombstone fine) + records `admin.page_soft_delete` operator observation; **13 operational read sites** now filter `status='active'` (find/list in catalog, reporting, spenders, ofapi mapping/snapshot, workboard recompute) while fact readers deliberately keep seeing all pages (rollup rebuilds, fact-presence, model page counts — deleting a model under a tombstoned page still refuses). **Migration 0056**: 42 pages.id FKs enumerated (spec said 38 — count grew), 22 fact/history → RESTRICT, 16 projection/config/cache keep CASCADE, 4 already non-cascade untouched; classification recorded in the migration comment; DO-block resolves real constraint names from pg_catalog (names drifted across old migrations) and fails loudly on a missing FK.
- [x] **Elaboration (beyond spec, recorded):** the 0055 writer-seed invariant continues at the write paths — `createPlatformPage` births Fansly pages with `transactions_writer='fansly'`; `setPageOfapiAccountId` assigns `'ofapi'` when unassigned (never overrides an explicit writer). Without this every page created AFTER the migration would refuse its own writer until Stage 14 — including live onboarding.
- [x] 4. **Tests** — new `tests/transactions-writer-gate.integration.test.ts` (4 e2e: unassigned refuses everyone + incident; born/mapped writers pass; ingest refuse→pending→reassign→apply with observation link + provenance + currency; CHECK rejects unknown source). Stage 2's delete test rewritten for tombstone semantics (fact page tombstones, facts remain, raw DELETE throws FK violation, repeat delete 404s, admin list omits). Unit factories gained `getPageTransactionsWriterInfo` (fansly/onlyfans transaction suites); ingest test's `seedPage` now OFAPI-maps (reality: projection events only exist for mapped pages).
- [x] 5. **DEPLOYED 2026-07-05 ~03:45 UTC** (owner-confirmed; main@d410573; 0055+0056 applied; health+sync green). **§5 checks ALL PASS** (decision #72): source 100% — 15,413 rows split fansly:rest 12,560 / ofapi:rest 2,701 / ofapi:webhook 152, 0 NULLs, 0 onlymonster; revenue per-page/month diff EMPTY (106 rows, before/after CSV in session scratchpad); writer seed 5×fansly + 2×ofapi = running reality; pg_constraint: exactly 22 RESTRICT / 16 CASCADE on pages; 0 wrong-writer incidents; ingest backlog 0 (all 152 projected events applied). Wrong-writer probe = integration suite (no staging env). **Exit pending only:** next live webhook spend writes through the gate (max(created_at) advances past deploy time under daytime traffic) → flip to exited.
