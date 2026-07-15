# Stage 3 — OFAPI staged-capture enablement completed

**Repo(s):** core (ops/config only) · **Depends on:** Stage 1 (journal retained), Q1 answered ·
**Passport:** roadmap.md §4, stage 3

**Status header — SPEC COLLAPSED + one reconciliation (flag for sign-off).**
Q1 (verified over SSH, 2026-07-04) found **every staged flag already running-on** on both live
instances. So this stage is **not a sequence of flips** — it collapses to a **verification
checklist** that confirms the running state and the health of each already-enabled projection, per
the 3b instruction.

**Reconciliation the owner should note:** the pre-answer passport says "#51/2 (transactions truth
ingest) is explicitly excluded — it waits for the single-writer gate (Stage 13/14)." Q1 found
`ofapiSpendTransactionIngestEnabled` (#51/2) has been **running-on since 2026-06-19** and is **safe**
because production has **no dual-fed pages** (zero OnlyMonster rows, no OnlyMonster streams). Per the
3b ordering rule (§8 answers supersede pre-answer passport text), this stage **verifies #51/2 is on
and safe** rather than turning it off. The structural single-writer gate is still built in Stage 13
(retroactively protecting the already-on flag); nothing here regresses it. This is recorded as a
**deviation from the passport wording** for owner sign-off.

## 1. Context

Every already-built OFAPI projection is meant to consume live traffic so webhook facts become
serving-grade data. Q1 confirms they do. This stage's job is therefore to **prove** it (turn the
passport's exit criteria into a run checklist) and to arm the guards that keep credit burn bounded —
not to enable anything.

**Entry criteria restated as facts to verify at execution time** (all via `GET
/api/v1/admin/config` `server.ts:3144`, or the §2.1 `config_settings`/`runtime_instances` queries):
- Stage 1 deployed (journal retained — nothing expires while projections run).
- Credit balance + day-budgets reviewed: `ofapiDmDailyCreditBudget` (default 500, `runtimeApply:
  none` — `config-registry.ts:174`), `ofapiAudienceDailyCreditBudget` (default 300, `:186`),
  `ofapiCreditFloor` (500, `:175`), `ofapiBurnAlertCreditsPerHour` (300, `runtimeApply: live` `:181`).

**Deliverable:** a recorded verification checklist in `decisions.md` proving all target flags
running-on and each projection healthy, with the burn/budget guards confirmed armed. **No code, no
flips** (unless a flag is found unexpectedly off — then walk the staged validator's order one flip +
restart at a time, per the passport's original procedure).

## 2. Changes

**core — none (code/config), expected path.** No flags flipped, no code changed. This is an
ops/verification stage.

**Contingency only** (if a target flag is found *off* at execution time, contradicting Q1): walk the
staged validator's prescribed order using `PATCH /admin/config/staged` (`server.ts:3280`, requires
`ack:true`, advisory-locked commit `commitStagedConfigChange` `staged-config.ts:189-232`) **one
enable + restart at a time** — the validator (`validateStagedTransition`
`staged-config.ts:69-144`) enforces that each prerequisite is desired-on **and** running-on before
the next enable, so a chain cannot be enabled in one patch. Record each flip in `decisions.md`.

The flag graph to verify (all `default:false`, `editability:staged`, `runtimeApply:boot` —
`config-registry.ts`):

| Group | Flags (in order) | registry lines |
|---|---|---|
| #49 | `ofapiDmProjectionEnabled` → `ofapiDmSyncEnabled` → `ofapiAccountHealthEnabled` | 168, 169, 177 |
| #50 | `ofapiCreditLedgerEnabled` → `ofapiBalancePingEnabled` → `ofapiAudienceSyncEnabled` → `ofapiPresenceProjectionEnabled` → `onlyFansTopSpendersEnabled` | 180, 183, 184, 188, 146 |
| #51 | `ofapiSpendProjectionShadowEnabled` → `ofapiSpendTransactionIngestEnabled` | 189, 190 |
| #52 | `ofapiDmColdArchiveEnabled` | 170 |
| #54/55/56 | `ofapiDesktopReadGatewayEnabled` → `ofapiDesktopCommandOutboxEnabled` → `ofapiDesktopCommandExecutionEnabled` | 191, 192, 193 |
| #26 | `chatMuseAiGatewayEnabled` | 194 |

## 3. Schema & data migration

**No schema change. No data migration.** Read-only verification queries only (§5).

## 4. Client compatibility

- **Desktop:** unaffected (it already has hub reads/sends — the gateway flags are on). No version
  change.
- **Extension / dashboard:** unaffected; dashboard credit/health pages show live data (they already
  do).

**Compatibility invariants (target §14):** none touched — nothing is enabled or retired.

## 5. Tests & verification

**No new automated tests** (nothing built). The verification IS the stage:

```sql
-- (V1) All target flags running-on on all live instances.
SELECT instance_id, role,
       running->'values'->'ofapiSpendTransactionIngestEnabled'->>'value' AS ingest,
       running->'values'->'ofapiDmColdArchiveEnabled'->>'value'          AS cold_archive,
       running->'values'->'ofapiDesktopReadGatewayEnabled'->>'value'     AS read_gw,
       running->'values'->'chatMuseAiGatewayEnabled'->>'value'           AS ai_gw
FROM runtime_instances WHERE last_seen_at > now() - interval '3 minutes';
-- Repeat per flag of interest; PASS iff every target flag = 'true' on every instance.
```
- **(V2)** `dm_message_archive` row rate > 0 over 24 h (`SELECT count(*) FROM dm_message_archive
  WHERE created_at > now() - interval '24 hours'`).
- **(V3)** Spend-shadow table populating: `SELECT count(*) FROM ofapi_spend_projection_events WHERE
  received_at > now() - interval '24 hours'` > 0.
- **(V4)** Credit ledger reconciles against the balance ping (`runOfapiCreditBurnMonitor` /
  reconciliation, `ofapi-credits.ts`); no unexplained drift.
- **(V5)** Read gateway returns 200 for a desktop chatter key on an assigned page (smoke via
  `GET /api/v1/ofapi/read/*`).
- **(V6 — budget guards armed)** `ofapiBurnAlertCreditsPerHour` > 0 (alert live); day-budget
  reservation (`reserveOfapiDayCredits` `repositories/ofapi.ts:1052`) confirmed enforcing on the DM
  + audience scopes.

**Known anomaly to surface (from Q1, not fixed here):** `onlyfans/dm_messages` sync is stuck on two
conversations (one per account) failing with OFAPI upstream timeouts — 93 retries each per 48 h,
zero successes. This is an **independent ops item**, not a roadmap stage; record it in the checklist
and hand it to ops. Do not let it block Stage 3 sign-off (it is a per-conversation upstream issue,
not a flag-state problem).

**Observation window:** 24 h for the row-rate checks (V2/V3); point-in-time for the flag census.

## 6. Rollback

- Nothing to roll back in the expected (verify-only) path.
- **Contingency:** if a flip is performed and misbehaves, the staged mechanism is reversible — a
  DISABLE patch (`validateStagedTransition` Rule 4, `staged-config.ts:130-140`) + restart returns
  the flag to off; the boot-apply fail-safe re-reads state. `#51/2` is the only flag whose disable
  needs care (it stops truth ingest) — but since it is already safely on, no disable is planned.

## 7. Assumptions

1. **Q1's "all running-on" holds at execution time** — V1 verifies it. Drift signal: any target
   flag reads `false` on any instance → contingency flip procedure (§2) applies.
2. **The staged validator graph in `config-registry.ts` is current** (prerequisite chains as listed).
   Drift signal: registry `requires` arrays changed since this spec.
3. **Webhook delivery is healthy** (silence-threshold alert quiet) and OFAPI-mapped pages have
   unique `pages.ofapi_account_id`. Drift signal: webhook-silence incident open.
4. **#51/2 is safe because there are no dual-fed pages** (Q1). Drift signal: Stage 13's census (or
   Stage 5's V1) finds any OnlyMonster-sourced row — then #51/2's safety must be re-evaluated
   against the single-writer gate before this checklist can be signed.

## 8. Task breakdown

1. **Run the flag census (V1)** on both instances; record per-flag running values. Done-check:
   checklist row per flag. *(ops, ≤0.2 session)*
2. **Run the health checks (V2–V6)**; record row rates, ledger reconciliation, gateway smoke, guard
   state. Done-check: all pass or exceptions noted. *(ops, ≤0.3 session)*
3. **Surface the dm_messages stuck-conversation anomaly** to ops as an independent ticket.
   Done-check: ticket filed, referenced in checklist. *(ops)*
4. **[CONTINGENCY] If any flag is off:** walk the staged order one flip + restart at a time with
   budget/burn watched between flips; record each. *(ops)*
5. **(Last) Record the completed checklist** in `decisions.md` and this stage file. *(ops)*

---

## Progress

*Working scratchpad — session 2026-07-05 (owner-authorized compressed execution: "i don't want to wait that much"). Formal start after Stage 1's exit tonight; read-only census pre-run.*

**Checklist (V1–V6):**
- [x] **V1 flag census — ALL 15 target flags `true` on BOTH live instances** (api 30f27d78…, worker 739418e1…, both seen <1 min; 00:30 UTC). #51/2 spend-ingest confirmed on+safe per the spec's reconciliation note. No contingency flips needed.
- [x] **V2** — 876 `dm_message_archive` rows in the last 24 h (cold archive consuming live traffic).
- [x] **V3** — 28 `ofapi_spend_projection_events` in 24 h, 28/28 `projected` (zero blocked/skipped).
- [x] **V4** — ledger↔balance healthy: balance 47,338 credits observed 00:31 UTC; 24 h ledger = 954 `rest` (897 credits) + 84 `external` (541 credits); **zero open** burn/low-credit/webhook-silence incidents.
- [x] **V6** — guards armed: day budgets enforcing (2026-07-05: DM 95/500, audience 95/300 spent), burn alert at default 300/hr; the incident→Telegram pipeline itself proven live by the Stage 1 V5 disk drill (incident #25, delivered 00:15:43).
- [ ] **V5** — read-gateway 200 smoke: pending. Bearer surface proven post-deploy (probe key: 200 on /api/v1/pages, 403s only on the four Stage-2-gated routes); Nikita's chatter key last used 23:05 UTC (fleet active). Plan: check api logs for natural `/api/v1/ofapi/read/*` 200s at the 02:36 close-out; fallback = owner mints a key for `kernel-stage2-probe-20260705` on `lora-of` and probe `GET /api/v1/ofapi/read/acct_fbaf2216a7c84147a599f349e0a6fb87/chats?limit=1` (1 credit).
- [x] **Anomaly surfaced (independent ops item, does not block sign-off):** `onlyfans/dm_messages` still failing — 193 failed runs in 48 h (the two stuck conversations with OFAPI upstream timeouts, known since Q1).
