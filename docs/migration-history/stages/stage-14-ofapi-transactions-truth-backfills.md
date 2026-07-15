# Stage 14 — OFAPI transactions truth + historical backfills

**Repo(s):** core · **Depends on:** 13, 3 (verified running), Q1 · (5 is moot per Q1) ·
**Passport:** roadmap.md §4, stage 14

**Status header — Q1 shrink + two elaborations (flag for sign-off):**

1. **Q1 shrink honored.** Truth ingest (#51/2) is already running-on globally (since 2026-06-19)
   and the REST backfill has already run: both OnlyFans pages are 100 % OFAPI-fed with history to
   2025-09 (re-verified live 2026-07-04: 685 + 2,162 rows, earliest 2025-09-09/2025-09-11). This
   stage therefore does NOT "enable ingest page-by-page" — it *formalizes* the running state under
   Stage 13's writer gate, **verifies backfill depth** (don't re-run blindly), and delivers the
   still-missing pieces: the two OnlyMonster-exclusive feeds via OFAPI, explicit fee capture, the
   day-budget guard on the backfill CLI, and the `tips.received` unblock.
2. **Elaboration — the backfill CLI is not yet day-budget-guarded.** Verified: the CLI has a page
   cap (`OFAPI_TRANSACTION_BACKFILL_MAX_PAGES=1000`, `ofapi-transactions-backfill.ts:47`) and
   eligibility gates (`loadWriteEligibility` `:371`), but does **not** call
   `reserveOfapiDayCredits` (`packages/db/src/repositories/ofapi.ts:1052-1092`). DP 2's condition
   ("backfills run only under the day-budget reservation machinery") is binding — this stage wires
   it. Not in the passport's wording; it is the passport's *intent*.
3. **Elaboration — explicit fee columns.** OFAPI net is already real (parsed from payload
   `net_amount`, `ofapi-spend-projection-contract.ts:218`), so "real fee replaces estimate" is
   already true for OFAPI rows; but fee/VAT/tax are not stored anywhere queryable (shadow table
   has gross+net only — verified `schema.ts:2057-2110`). Add nullable
   `platform_fee_mills`/`vat_amount_mills`/`tax_amount_mills` to `transactions`, populated by the
   OFAPI writers going forward (target §3.5 door 4.8).

## 1. Context

OFAPI becomes the formal transactions writer of record for OnlyFans pages. After Q1 that is
mostly a matter of *proving and closing gaps* rather than migrating: the writer gate (13) must be
set, the backfill depth must be shown to reach the vendor's floor, chargebacks and
tracking/trial-link users — the two feeds only OnlyMonster could supply — must flow from OFAPI
routes (they exist: `GET /{account}/chargebacks` + the tracking-links family, roadmap §2.3), and
`tips.received` must stop being projection-blocked.

**Entry criteria restated as facts to verify:**
- Stage 13 deployed: `pages.transactions_writer='ofapi'` on both OnlyFans pages; wrong-writer
  guard tested.
- Credit posture: balance + `ofapiDmDailyCreditBudget`/`ofapiAudienceDailyCreditBudget` values
  read (`config-registry.ts:174,186`); burn alert armed (`ofapiBurnAlertCreditsPerHour`,
  `config-registry.ts:181`, evaluated in `runOfapiCreditBurnMonitor`, `ofapi-credits.ts:341-377`).
- `transactions.new` webhook still live-verified; shadow projection populating
  (`ofapi_spend_projection_events` row rate > 0).
- tips fixture check: has a `tips.received` webhook occurred naturally? (query
  `ofapi_webhook_events WHERE event_type='tips.received'` — retained since Stage 1). If yes →
  unblock task 5 proceeds; if no → escalate to owner, ship everything else.

**Deliverable:** depth-verified OFAPI history per page (recorded floor), chargebacks +
tracking-link users flowing from OFAPI under audience-class budgets, fee/VAT/tax stored for new
rows, the backfill CLI credit-guarded, `tips.received` canonicalized (or escalated), and the
Stage 15 retirement checklist unblocked.

## 2. Changes

**core — depth verification (no blind re-run):** dry-run the existing CLI with an early window
(`ofapi-transactions-backfill --page <label> --from 2020-01-01 --to 2025-09-01` — dry-run is the
default, `cli.ts:948-974`) per page; if the vendor returns rows older than the current earliest,
run `--write` for the missing window **under the new budget guard**; record per page: floor date,
row delta, credits spent. If the vendor floor equals the current earliest → record "depth
complete" and stop.

**core — day-budget guard on the backfill** (`services/ofapi-transactions-backfill.ts`): before
each fetch batch, reserve against a new scope via `reserveOfapiDayCredits`
(`repositories/ofapi.ts:1052`) with knob `ofapiBackfillDailyCreditBudget` (registry: editable,
default conservative, min 1 — pattern of `config-registry.ts:174`); on reservation refusal the
CLI checkpoints and exits with "budget exhausted, resume tomorrow" (it is already resumable via
its pagination + terminal-state guards `:639-676`). Settle actuals via
`settleOfapiDayCreditReservation` (`ofapi.ts:1102`).

**core — chargebacks via OFAPI:** new client method on `app.ofapi` (`services/ofapi.ts`) for
`GET /{account}/chargebacks` (+ statistics if cheap), and a scheduled reconcile job
(`services/ofapi-chargebacks-sync.ts`, daily, budget-guarded same as above) writing
`upsertTransaction` rows with `canonicalType:'chargeback'`, `source:'ofapi:rest'`, gross negated —
mirroring the OnlyMonster chargeback shape (`onlyfans-transactions.ts:696-708`) so rollups behave
identically. (Today `canonical_type='chargeback'` is produced ONLY by the dead OnlyMonster path —
verified; the OFAPI *webhook* path maps reversals to `refund`, `ofapi-spend-transaction-mapping.ts:15`
— that stays; chargeback rows come from this REST reconcile.)

**core — tracking/trial-link users via OFAPI:** re-point the existing `fan_identities` stream for
OnlyFans pages from the OnlyMonster adapter to OFAPI: `executeFanIdentitiesChunk`
(`executor-handlers.ts:1476`) gains an OFAPI branch (page has `ofapi_account_id`) calling new
`app.ofapi` methods for the tracking-links family (`GET /{account}/tracking-links`,
`.../{id}/subscribers`, `/spenders`) and trial links, feeding the existing
`upsertFans`/`upsertFanPages` writes (`onlyfans-identities.ts:239,241`). Runs under the audience
day budget (`ofapiAudienceDailyCreditBudget`). Keeps the stream name — no enum change. Verify at
execution which route set is actually needed vs. the vendored spec (desktop repo
`docs/vendor/onlyfansapi/openapi.json` is the reference).

**core — fee capture:** extend the spend projection contract parse
(`ofapi-spend-projection-contract.ts`) to carry `fee_amount`/`vat_amount`/`tax_amount` (mills)
through the shadow row into the ingest (`ofapi-spend-transaction-ingest.ts`) and the REST
backfill (`ofapi-transactions-backfill.ts:691`) → new nullable `transactions` columns. Optional
one-shot backfill of fee columns for existing `ofapi:%` rows from retained journal payloads
(`ofapi_webhook_events.payload`) — batched UPDATE joining on transaction id; rows whose journal
predates retention keep NULL (fee derivable as gross−net where needed).

**core — `tips.received` unblock (conditional on a live fixture existing):** remove the hard
block (`OFAPI_TIPS_RECEIVED_BLOCKED_REASON`, `ofapi-spend-projection-contract.ts:10,298-299`),
map tips to category `tip` per the captured payload shape, add the fixture to the suite, and
re-project blocked rows (they sit at `projection_status='blocked'` — re-run the sweep after
deploy). **If no natural fixture exists → escalate; do not ship unverified parsing** (passport
rule).

**core — data-exports lane evaluation (task, not code):** price `POST /api/data-exports`
(`type=transactions`) against the marker-walk REST cost using the vendored spec + one live probe;
record verdict in `decisions.md`. Adopt only if a further deep backfill is actually needed after
depth verification.

## 3. Schema & data migration

```sql
-- 00NN_transactions_fee_columns.sql
ALTER TABLE transactions
  ADD COLUMN platform_fee_mills bigint,
  ADD COLUMN vat_amount_mills   bigint,
  ADD COLUMN tax_amount_mills   bigint;
```
No rewrite (nullable, no defaults). Fee backfill (optional) is batched, idempotent
(`WHERE platform_fee_mills IS NULL AND source LIKE 'ofapi:%'`), joins journal payloads; its
completeness query: count of `ofapi:%` rows with NULL fee vs. rows whose journal payload is
retained. All backfill/reconcile jobs: cursor-checkpointed, re-runnable (upserts on the
`(platform_account_id, transaction_id)` unique add zero rows on re-run), credit-guarded per §2.

## 4. Client compatibility

- **Desktop / extension:** none — no consumed contract changes.
- **Dashboard:** reporting serves throughout (same tables/rollups). Where explicit fees make
  displayed net *more precise* for future rows, deltas are announced to the owner, never silent
  (passport rule). No dashboard code change required this stage.
- **Workboard:** n/a.

**Compatibility invariants (target §14):** untouched. All work is ingest-side.

## 5. Tests & verification

**New tests:** budget-guard unit (reservation refusal → checkpoint + exit, no fetch); chargeback
reconcile integration (fixture → `canonical_type='chargeback'`, `source='ofapi:rest'`, negative
gross, rollups match OnlyMonster-shape expectations); fan_identities OFAPI-branch integration
(fixture → fans/page_fans rows); fee parse unit (contract carries fee/vat/tax); tips fixture test
(if unblocked); CLI re-run idempotency (second run adds 0 rows).

**Existing suites:** spend projection/ingest suites, backfill CLI tests, rollup rebuild tests.

**Production verification (exit criteria):**
- Per page: recorded depth floor (`SELECT min(occurred_at)` vs the probe result) — reaches
  account creation or the vendor's floor, written into this file.
- Re-run of the backfill window adds zero rows (`count(*)` before/after).
- Day budget never breached: `ofapi_credit_ledger` daily sums for the backfill scope ≤ knob.
- Chargebacks: any vendor-reported chargeback appears within one reconcile cadence; tracking-link
  users populate `fans`/`page_fans` for a known link.
- `tips.received`: a live tip lands as a `transactions` row with `canonical_type='tip'`,
  `source='ofapi:webhook'` (if unblocked).
- **Observation window:** one week of budget/burn telemetry after enabling the new reconciles.

## 6. Rollback

- New reconcile jobs and the fan_identities OFAPI branch are flag-guarded (one registry flag per
  job, boot-apply) — flip off to stop; rows already written stay (correct facts).
- Fee columns: additive; inert on rollback.
- tips unblock: revert = restore the blocked-reason constant (rows already projected stay).
- No irreversible step; no data deletion anywhere.

## 7. Assumptions

1. **OFAPI history depth suffices** (roadmap §2.3: no documented limit) — the depth probe is the
   proof; if the vendor floor is later than account creation, record the gap explicitly (it is
   then genuinely unrecoverable — OnlyMonster holds no data either, per Q1).
2. **The vendored OFAPI spec in the desktop repo is current** for chargebacks/tracking-links
   route shapes; verify response shapes on the first live call (dry-run mode first).
3. **Stage 13's writer gate is live**; `loadWriteEligibility`'s legacy heuristics (`:404-412`)
   are subsumed by `transactions_writer` and simplified in this stage.
4. **Credit prices per operation** are whatever the ledger reports (`estimated` vs actual) — the
   budget knob is set from observed per-call costs during the dry-run, not guessed.
5. **Zero OnlyMonster rows** still true at execution (re-check; else Stage 13 reconciliation
   revives).

## 8. Task breakdown

1. **Budget guard on backfill CLI + knob.** Done-check: unit test; dry-run on staging logs
   reservations. *(≤0.5 session)*
2. **Depth probe per page (dry-run) → verdict; conditional `--write` top-up under budget.**
   Done-check: floor recorded here; re-run adds 0. *(0.5 session + paced runtime)*
3. **Chargebacks reconcile job + client method + flag.** Done-check: integration test; staging
   run. *(1 session)*
4. **fan_identities OFAPI branch + trial/tracking methods + flag.** Done-check: integration test.
   *(1 session)* *(parallel with 3)*
5. **Fee columns migration + contract/ingest/backfill plumbing (+ optional journal fee
   backfill).** Done-check: fee populated on new staging rows. *(0.5–1 session)*
6. **tips.received: fixture check → unblock or escalate.** Done-check: fixture test green or
   owner escalation recorded. *(≤0.5 session)*
7. **data-exports evaluation** → `decisions.md` verdict. *(≤0.5 session)* *(parallel)*
8. **(Last) Deploy; run §5 checks over a week; record results here.** *(ops)*

## Progress

- **2026-07-05 (session: Stage 13 exit → Stage 14 same-day build).** Entry criteria
  verified live in an owner-authorized read-only prod session: writer gate set on both
  OF pages; shadow projection alive (19 rows/24 h); **3 natural tips.received webhooks
  exist** (task 6 → unblock, not escalate); depth baseline recorded (lora-of earliest
  2025-09-11, 685 rows; lora-vip-of 2025-09-09, 2,170 rows); 0 OnlyMonster rows
  (assumption 5 holds).
- **BUILD COMPLETE, suite 179/1458 green** — branch `kernel/stage-14-ofapi-transactions`
  @ da3b595, five slices (f05d375, 564a8b4, 8a9f343, 2e098f0, e373b2f), decision #80.
  Tasks 1/3/4/5/6/7 done; task 2 (depth probe, live credits) + task 8 (deploy + §5
  week) are ops. Migrations 0062+0063 additive, flags default off → deploy inert.
- Deviations recorded: chargeback rows keyed `{payment.id}:chargeback` (payment.id is
  the original transaction's id — collision); fan_identities OFAPI branch has no
  cross-run cursor (links few, upserts idempotent, converges across cadence);
  tips.received maps as shadow signal only (money arrives via transactions.new —
  double-count guard). Follow-up unlocked for Stage 8: declare tips.received in the
  webhook canonicalizer family (version bump).
- Exit checklist (after chain deploy): flip `ofapiChargebacksReconcileEnabled` +
  `ofapiFanIdentitiesSyncEnabled`, run depth probe dry-run per page → record floor here,
  conditional --write top-up under the budget, re-run adds 0, budget ledger ≤ knob,
  tips_signal rows appear + 5 legacy blocked rows self-heal on first sweep, one week
  of burn telemetry.
