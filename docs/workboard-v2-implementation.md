# Workboard v2 — Implementation & Operations

Companion to **[workboard-v2-priority-design.md](workboard-v2-priority-design.md)** (the algorithm/UX design). This doc is the build log + runbook: what is actually implemented, where it lives, how to operate it, and the decisions made along the way.

- **Scope:** net-new alongside Workboard v1 — **v1 is untouched** (its tables, routes, page, and queries are unchanged). v2 is additive: new tables, routes, components, behind a new route and feature flags.
- **Platform:** Fansly first (matches v1 scope; the read resolver is Fansly-only).
- **Status:** Stages 0–2 shipped and verified (typecheck, `contracts:generate`, dashboard `tsc -b`, 27 Workboard-v2 tests + the full 486-test unit suite green). The L2 AI classifier is **flag-gated off by default**.

---

## 1. Architecture (recap)

The "Cartesian Board": every fan has two **separately-stored** scores — `value_score` (who matters) and `urgency_score` (why today) — persisted on a `workboard_state` FSM row. The four tabs (`subscribers / spenders / fresh_mass / old_mass`, plus a `service` state) are **physically separate queues**, so the reply-SLA can only re-order rows *within* a tab — it can never flatten the books together. Ranking inside a tab: `rankScore = U·(1+0.15·Q) + βV_tab·value − freeloaderPenalty`. Full math, decay shapes, and coefficients are in the design doc.

Pipeline: a nightly **recompute** job reads raw signals → the pure **engine** (`evaluateFan`) → persists `workboard_state`; the **read API** serves it per tab; the dashboard renders it. A nightly **classify** job (optional, AI) cleans the `needs_reply` tail.

---

## 2. What each stage delivered

**Stage 0 — foundation (no ML).** Schema + the pure scoring engine (value, urgency, FSM tab derivation, L1 closing detector, within-tab rank, secondary status), the recompute service + pg-boss job, the read API + Zod contracts, the `Готово`/touch-log write endpoint, and the React UI shell (tabs + counters, status-grouped sections, rows, color tones).

**Stage 1 — conversation quality + freeloader.** `computeQuality` (message-ratio / initiator / who-wrote-last / latency → `Q ∈ [-1,1]`, damped by coverage and by Fansly `unknown`-role share); cadence **clock-bending** (`T_eff = T_cad·(1−0.45·Q)/freeloaderFM`); the persisted **freeloader** sliding window (counts meaningful conversation-days / 90d, intent-gate that spares actively-converting fans, lifetime cap, conversion reset). UX polish: Focus strip, value×urgency quadrant glyph, expandable row, Old-mass cap meter.

**Stage 2 — L2 Haiku closing classifier.** Anthropic client behind an injectable interface; its own cache + cost-cap tables; the classify orchestration (candidates → L1 pre-filter → adaptive cap → cache + usage); engine integration so a `>24h` tail uses the cached verdict (and is flagged "unverified" until classified); pg-boss classify job; the in-UI transparency ("Детектор ответа") + an AI-coverage indicator in the header.

---

## 3. Data model

New tables (v1 tables untouched). Money is in **mills** (`1 mill = $0.001`).

| Table | Migration | Purpose |
|---|---|---|
| `workboard_state` | `0019` | Persisted FSM row per `(page, fan)`: `tab`, `mass_substate`, `value_score`, `urgency_score`, `rank_score`, `secondary_status`, `value_tier`, `urgency_severity`, `needs_reply`, `is_purchase_followup`, `why_now_code/value`, `reason_chips` (jsonb), `q_score`, `q_confidence`, `freeloader_status`, `freeloader_episodes` (jsonb), `lifetime_free_episodes`, `service_reason`, … Indexed `(page, tab, rank_score desc)` and `(page, tab, secondary_status)`. |
| `workboard_contact_log` | `0019` | Dashboard-written touch log (the authoritative "we contacted this fan" signal — the DM sync is lagged + caps at 25 msgs). Backs cadence floors, cooldowns, cross-page anti-spam. |
| `wb_closing_cache` | `0020` | Permanent per-message L2 verdict cache, `unique(page, platform_message_id)`. `layer = 'l2'`. |
| `wb_llm_usage_daily` | `0020` | Per-`(page, business_date, feature)` calls/tokens counter — the **per-page cost-cap home** (`ai_usage_events` is keyed to a human `userId` and has no `platform_account_id`). |

Migrations are hand-written SQL (the repo doesn't use drizzle-kit's journal). Apply with `pnpm db:migrate`.

---

## 4. Background jobs (pg-boss)

Registered in `apps/runtime/src/worker-services.ts`, defined in `apps/runtime/src/services/sync-queue.ts`:

| Queue | Cron (UTC) | Handler |
|---|---|---|
| `workboard.classify-closing` | `0 1 * * *` | `runClosingClassificationAllPages` — only if `WB_CLOSING_LLM_ENABLED` + key present (no-op otherwise). Runs *before* recompute so fresh verdicts feed it. |
| `workboard.recompute` | `0 3 * * *` | `recomputeAllWorkboardPages` — recompute + persist `workboard_state` for every Fansly page. |

The worker must be restarted to register new queues/schedules and to pick up `.env` changes.

---

## 5. API endpoints

`packages/contracts/src/routes.ts` (Zod) + `apps/runtime/src/api/server.ts`. All `requireDashboardUser`, Fansly-only, per page.

| Method · Path | Purpose |
|---|---|
| `GET /api/v1/pages/{pageLabel}/workboard/v2?tab=&status=&limit=&offset=` | Tab queue + per-tab counts + `oldMassBudget` (old-mass tab) + `aiCoverage` (classifier progress). Items carry value/urgency, secondary status, reason chips, `quality`, and the `closingVerdict` (detector transparency). |
| `POST …/workboard/v2/contact` | Record a `Готово`/touch into `workboard_contact_log`. |
| `POST …/workboard/v2/recompute` | On-demand recompute for one page (synchronous; returns `evaluated`). |

---

## 6. Frontend

Route `pages/:pageLabel/workboard/v2` → `apps/dashboard/src/pages/WorkboardV2Page.tsx`. v1's `/workboard` is unchanged.
- Components: `components/page/workboard/v2/` — `tone.ts` (the color system, mirrors `getSyncUxTone`), `WorkboardV2Row.tsx` (compact + expandable), `QuadrantGlyph.tsx` (`useId()`), `FocusStrip.tsx`, `CapMeter.tsx`.
- Hooks: `useWorkboardV2`, `useWorkboardV2Contact`, `useWorkboardV2Recompute` in `api/workboard.ts`.
- Header shows the **ИИ-детектор ответа** indicator (`проверено N · из них закрывающих M · вызовов сегодня K`); the expanded row shows the **Детектор ответа** verdict per fan (`ИИ Haiku: нужен ответ` / `закрывающее` / `Вы ответили последним` / `Ещё не проверено ИИ`).

---

## 7. Configuration (env)

`packages/shared/src/config.ts`. The five fields are **optional** in `AppConfig` (so existing config literals/tests/codegen need not enumerate them); `loadConfig` always populates them.

| Env | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Anthropic key. Stored only in gitignored `.env`. |
| `WB_CLOSING_LLM_ENABLED` | `false` | Master switch for L2. Effective only when a key is also present. |
| `WB_CLOSING_LLM_MODEL` | `claude-haiku-4-5` | Classifier model. |
| `WB_CLOSING_LLM_DAILY_CAP_MIN/MAX` | `50` / `400` | Adaptive per-page daily call cap = `clamp(0.5·dailyTailCount, MIN, MAX)`. |

---

## 8. Runbook / scripts

```bash
pnpm db:migrate                                              # apply 0019 + 0020
pnpm api:watch        # API with auto-reload (no manual restart on code change)
pnpm worker:watch     # worker with auto-reload (registers the nightly jobs)

# one-off operations (env loaded from .env):
node --import tsx/esm scripts/workboard-v2-recompute.ts <pageLabel|all>     # recompute + persist
node --import tsx/esm scripts/workboard-v2-classify.ts <pageLabel> [capMax] # run L2 classifier (probes the key first)
node --import tsx/esm scripts/workboard-v2-show-verdicts.ts <pageLabel>     # show recent AI verdicts (message → decision)
```
On-demand recompute is also available from the UI ("Пересчитать" button) and the `/recompute` endpoint.

---

## 9. Decisions made during implementation

- **`SPENDER_MIN` = any payment (`>$0`).** Spec: "Spenders — anyone who has ever paid." (Was $100 for v1-compat; lowered per owner decision. On Lora-1 this moved 444 micro-payers from mass → Spenders: 136 → 580.)
- **Synchronous Messages API, not Batches.** The `ClosingClassifier` interface makes the Batches API (−50% cost, 24h SLA) a drop-in upgrade later; sync is simpler and easier to verify now.
- **`closingVerdict` is derived at read-time** from `last_message_sender_role` + tail age + L1 + the cached L2 verdict (no extra persisted column).
- **`AppConfig` L2 fields are optional** to keep every existing config literal compiling.
- **Pool parses int8 as bigint** — raw-SQL id/mills columns come back as `bigint`; ids are `Number()`-ed before hitting `z.number()` contracts / `mode:"number"` inserts.

---

## 10. Tests

- `tests/workboard-v2-engine.test.ts` — 24 pure-engine unit tests (L1 detector, value recency-decay, SLA-cap guarantee, settlement-aware purchase, tab routing, Q, freeloader, L2→needs_reply, the design's hard cases).
- `tests/workboard-v2.integration.test.ts` — 3 Postgres (testcontainers) tests: tab routing + the big signal SQL; the `cq` aggregation (`qScore` from real messages); and the full L2 path end-to-end with a **fake classifier** (no API calls) — proves L1 closings are skipped, the cache works, and verdicts gate `needs_reply`.

---

## 11. Known limitations & next

- **Approximations (Stage 1):** conversation-quality aggregates come from the ≤25-msg window; latency is an avg-gap proxy (not true median fan→model); the freeloader counter tracks recompute-days-with-a-live-meaningful-thread, not full gap-segmented episodes.
- **Highest-value next ("live board"):** `Готово`/snooze should re-evaluate a fan instantly (today the board only changes on the nightly recompute / on-demand button).
- **Then:** the **Batches API** for the classifier (−50%); per-page percentile calibration of the value anchors (`LTV_REF`/`VEL_REF`/`TIER_REF`); a conversions-per-touch telemetry loop to fit/validate coefficients and detect gaming; presence nudges.
- The design doc still references the old `$100` spender threshold in places — superseded by §9 above.
