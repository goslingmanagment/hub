# Project Kernel — Pass 3a: The Roadmap

**Master document for Pass 3** · Written 2026-07-04 · Produced by `prompts/prompt-3a-roadmap-skeleton.md`

**Provenance.** This is the ordered migration plan from the Pass 2 current-architecture review to
the retained [target architecture](target-architecture.md), under the owner's recorded decisions
on DP 1–10. The original review and roadmap-prompt inputs were never committed to this repo.
Ground-truth findings in §2 were re-verified against the three repos on 2026-07-04. Stage
**passports** here are half-page work orders, not specifications — Passes 3b (kernel-side) and 3c
(clients + re-documentation) write the full per-stage specs from the template in §6. The owner
reviews the stage list in §4 before 3b starts.

**Contents.** §1 what this system is and what the migration is for (read this before judging any
sequencing call). §2 ground truth as of 2026-07-04. §3 sequencing principles and the binding
invariants. §4 the ordered stage list with passports. §5 the dependency graph. §6 the stage-spec
template for 3b/3c. §7 design proposals (deviations from / corrections to the Pass 2 design).
§8 open questions for the owner.

---

## 1. What is being migrated, and why it matters

### 1.1 The business, in plain terms

This is the operating system of a fan-platform agency. The agency manages creator accounts —
**models** — on two platforms, OnlyFans and Fansly. Fans pay: subscriptions, tips, pay-per-view
unlocks. Nearly all of that revenue is *conversational* — it is closed in DMs by **chatters**,
agency employees who work fan conversations on the models' behalf, around the clock. The product
family exists to make chatters faster and better informed, and to give the owner a truthful
picture of the money.

Four surfaces serve that today, with a fifth planned:

- **core — the kernel.** One backend that syncs platform data (OnlyFans via the OFAPI vendor,
  plus OnlyMonster for transactions; Fansly via direct REST with a pasted browser session), stores
  transactions, messages, fans, and subscriptions in one Postgres, relays every OnlyFans read and
  write the desktop makes, meters the OFAPI credit budget, and serves the dashboard. It is where
  facts are supposed to live forever. Today it is where most facts go to die (§1.2).
- **ChatGoose Desktop** — the OnlyFans chat workspace. Chatters read conversations, get AI reply
  suggestions, and send messages through the kernel's command outbox. This is where OnlyFans
  revenue is worked, in real time, all day.
- **ChatGoose extension** (Firefox) — the Fansly workspace, living inside fansly.com: inline AI
  panel, fan context, spenders board. This is where Fansly revenue is worked.
- **Dashboard** — the owner/team-lead console inside core: revenue reporting, sync health,
  credentials, config, credits.
- **Workboard** (future, own repo) — the chatter application: log in, see your assigned models,
  see who to message now and why. Its primary users — chatters — cannot even log in to the
  kernel today.

### 1.2 Why the migration exists

Stated as product outcomes, not mechanisms:

- **The business cannot remember.** The kernel deletes its own raw record of OnlyFans events —
  including money events — after 7 days; it prunes DM history to the last 200–1,000 messages per
  conversation on every sync; for Fansly that pruned table is the *only copy in existence*. What
  a fan said, bought, and was promised last quarter is unanswerable — and every day that passes
  destroys more. Retention is the single worst finding of the review (capture grade: F).
- **Half the platform surface is dark.** Fansly per-fan earnings, PPV purchase history, and full
  transcripts are visible only to the extension, which uses them for one prompt render and
  discards them. Third-party AI vendors see more of the agency's Fansly business than the
  agency's own database does.
- **Analytics are impossible, not merely unbuilt.** LTV curves, churn, chatter performance,
  pricing analysis, presence-timed outreach — all require history that is currently being
  discarded at the moment of observation. No amount of dashboard work fixes this; only capture
  does.
- **The money picture is split and approximate.** Two paid OnlyFans vendors feed different
  tables; creator net is *estimated* from a commission rate; `transactions` cannot say which
  vendor wrote a row; a dual-fed page can ping-pong money rows indefinitely.
- **The revenue tool is blocked on identity.** The workboard — the tool meant to raise revenue
  per chatter-hour — cannot be built: chatters are API-key-only principals, boards are up to
  24 h stale, and contact history doesn't record who acted.
- **AI runs outside the kernel.** Vendor keys sit on N machines, spend is self-reported and
  lossy, prompts/completions/acceptance — the product's own quality signal — are recorded
  nowhere.

What the target buys, in the same terms: a kernel that keeps every fact it sees (and can prove
it); Fansly lit up server-side; one OnlyFans vendor with verified money parity; analytics as a
queryable product over years of data; chatters as first-class logged-in users with attributed
actions; AI governed, budgeted, and learning from its own acceptance loop; and a system a coding
agent can safely extend — one seam per concept, generated SDK, accurate agent docs in every repo.

### 1.3 What must never break (the crown jewels)

Chatters' daily work **is** the revenue stream, and both platforms are unofficial APIs where
recklessness means account bans. Every stage is judged against these invariants before any other
merit:

1. **Message flow.** Desktop chat reads (gateway + SSE) and extension in-page context must stay
   fresh; a stale or empty chat list is lost sales within minutes.
2. **Sends.** The command outbox's one-attempt, fail-closed, webhook-reconciled discipline. A
   dropped send is a lost sale; a *duplicated* send is fan-visible damage. No stage may weaken
   this path, ever.
3. **Money capture.** `transactions` + rollups feed reporting and payouts. During vendor
   consolidation the rule is: capture in parallel, verify parity, then and only then switch off
   the old feed (DP 2's owner condition).
4. **Platform account safety.** Pacing, egress consistency, and quota discipline on both
   platforms. Backfills and new sync streams always run inside the existing budget/pacing
   machinery — a ban is unrecoverable in a way no schema migration is.
5. **The OFAPI credit budget.** Credit-metered vendor; a runaway backfill starves live chat
   reads. All backfills run under the day-budget reservation machinery (DP 2 condition, binding).

### 1.4 Where the value concentrates

Front-load what saves or earns, sequence groundwork by what it unblocks:

- **Immediate saves (days, not weeks):** stop-the-bleeding config and small code — every day of
  delay destroys webhook journals, DM history, command payloads, and desktop telemetry that no
  later stage can recover.
- **Early product wins:** completing the staged OFAPI projection enablement (durable DM archive
  + spend visibility on live traffic); OnlyMonster historical export (insurance against vendor
  loss); Fansly earnings/PPV sync (net-new revenue intelligence the owner has never had
  server-side); OnlyMonster retirement (a bill disappears, fee estimates become real numbers).
- **The pivot investment:** the observation ledger + domain events. Zero direct user-visible
  change, but every capture door closes onto it, every projection rebuilds from it, the event
  stream and analytics stand on it. It is deliberately early — everything after it gets simpler.
- **Deferred-value groundwork:** platform seam, API decomposition, SDK, identity — enabling
  work paced so that each lands immediately before the stages that consume it, not speculatively
  early.
- **The compounding tail:** AI plane consolidation and the analytics lake — the stages that turn
  accumulated data into product; they close the loop the mandate opened.

---

## 2. Ground truth as of 2026-07-04

Verified against the three repos on 2026-07-04 (core HEAD `b5fb6ce`, 2026-07-02 — **no commits
exist after 2026-07-02**, so the Pass 2 documents describe current committed code). Production
*database* state was not reachable from this session (SSH to the VPS is permission-gated); the
two production-only checks are recorded below as owner-run queries and carried as open question
Q1. Everything else was verified in code or on public release feeds.

### 2.1 Staged-flag graph (code state) — production values pending Q1

> **Update 2026-07-04:** Q1 answered by direct production check — **every flag below is
> running-on** on both live instances (#49/#50 via env, the rest via DB overrides), and no
> dual-fed pages exist. Full findings in §8 Q1.

The registry is `packages/shared/src/config-registry.ts` (`CONFIG_DESCRIPTORS`, lines 98–205);
all capture/projection flags are `default: false` in code and flip via the staged mechanism
(`staged-config.ts`: one enable per patch, prerequisite must be desired-on **and running-on**,
boot-applied — i.e. one flip + restart at a time). The graph, in prescribed order:

| Staged group | Flags (in order) | Gates |
|---|---|---|
| #49 | `ofapiDmProjectionEnabled` → `ofapiDmSyncEnabled` → `ofapiAccountHealthEnabled` | OnlyFans DM projection, budgeted REST bootstrap/reconcile, health alerts |
| #50 | `ofapiCreditLedgerEnabled` → `ofapiBalancePingEnabled` → `ofapiAudienceSyncEnabled` → `ofapiPresenceProjectionEnabled` → `onlyFansTopSpendersEnabled` | credit ledger, audience, presence, top spenders |
| #51 | `ofapiSpendProjectionShadowEnabled` → `ofapiSpendTransactionIngestEnabled` | spend shadow table; **truth ingest into canonical `transactions` + the REST backfill `--write` path** |
| #52 | `ofapiDmColdArchiveEnabled` | forward-only DM cold archive |
| #54/#55/#56 | `ofapiDesktopReadGatewayEnabled` → `ofapiDesktopCommandOutboxEnabled` → `ofapiDesktopCommandExecutionEnabled` | desktop read gateway (503s unless gateway **and** credit-ledger flags on — `ofapi-read-gateway.ts:365-370`), command outbox, executor |
| #26 | `chatMuseAiGatewayEnabled` | hub AI gateway (+ 3 editable micro-USD/request limits) |

Reading **production** values: owner-only `GET /api/v1/admin/config` (`server.ts:3144`), or SQL
against `runtime_instances` (running values) / `config_settings` (desired overrides) per the
runbook pattern in `docs/chatgoose-custody-go-live.md:87-101`. Ready-to-run (inside the prod
Postgres container):

```sql
-- desired overrides
SELECT key, value, updated_at FROM config_settings ORDER BY key;
-- running values on live instances (per key of interest)
SELECT instance_id, role, running->'values'->'ofapiSpendTransactionIngestEnabled'->>'value'
FROM runtime_instances WHERE last_seen_at > now() - interval '3 minutes';
-- dual-fed check: pages with an OFAPI mapping AND OnlyMonster-sourced transaction rows
SELECT p.label, p.ofapi_account_id,
       SUM((t.raw_type LIKE 'ofapi:%')::int)  AS ofapi_rows,
       SUM((t.raw_type NOT LIKE 'ofapi:%')::int) AS onlymonster_rows
FROM pages p JOIN transactions t ON t.platform_account_id = p.id
WHERE p.platform = 'onlyfans' GROUP BY 1, 2 ORDER BY 1;
```

### 2.2 Retention/destruction mechanics — one correction to Pass 2

- `ofapiEventRetentionDays` (default 7, destructive, purge cron 02:30 UTC —
  `ofapi-events.ts:252`) and `ofapiDmColdArchiveRetentionDays` (default 3650) are
  `editability: editable` but **`runtimeApply: "none"` — not overridable via the DB overlay at
  all; env-only** (`config-registry.ts:166,171` + the wiring-class comment at lines 47-54).
  **Correction to review §4.9:** the DM-archive retention knob is *not* in practice
  dashboard-editable down to 1 day — a dashboard override would be stored but never applied
  (`skippedOverrides`). Consequence for Stage 1: the retention stand-down is an **env change +
  restart** (a deploy), not a config flip.
- Hardcoded (code-only) destruction: `sync_raw_payloads` 180 d / 7 d-DM windows
  (`sync/shared.ts:27-36`); `page_dm_messages` caps 200/1,000 (`page-dm.ts:17-22`);
  `ofapi_commands` payload self-redaction 7 d after terminal state
  (`ofapi-command-executor.ts:27-28`, sweep-applied). All confirmed still present.

### 2.3 OFAPI payload fidelity (vendored spec + live fixtures, desktop repo)

From `chatgoose_desktop_fable/docs/vendor/onlyfansapi/openapi.json` + `llms-full.txt` + the
live-captured fixtures in `tests/fixtures/webhooks/`:

- **Actual platform fees: YES.** `GET /api/{account}/transactions` items carry `amount` (gross),
  `net`, `fee`, `vatAmount`, `taxAmount`, `currency`, `createdAt`, `status`, `user.id`; the
  live-captured `transactions.new` webhook fixture carries `amount`/`fee_amount`/`net_amount`/
  `vat_amount`/`currency` (fee = exactly 20% in both spec example and fixture). The estimated-net
  problem (review §4.8) is fully solvable on OFAPI data.
- **Full history: YES, two routes.** Marker-cursor walk-back on `GET /{account}/transactions`
  (`startDate` accepts absolute dates, no documented depth limit), and `POST /api/data-exports`
  with `type` ∈ {`transactions`, `chargebacks`, `tracking_links`, `trial_links`, `payouts`,
  `fans`, `chat_messages`, …} — advertised as "export your **entire transaction history**".
  The data-export lane is a candidate mechanism for the Stage 14 backfills (cost/shape to be
  verified in 3b).
- **OnlyMonster's exclusive feeds are replaceable.** OFAPI has `GET /{account}/chargebacks`
  (+ statistics/ratio) and a full tracking-links family incl.
  `GET /{account}/tracking-links/{id}/subscribers` and `/spenders` — covering the two feeds
  ground-truthed as OnlyMonster-exclusive (§2.5). DP 2's replacement precondition holds on
  paper; Stage 14 must prove it on live data.
- **Money webhooks exist**: `transactions.new` (live-verified fixture), `tips.received`
  (documented; fixture still `verified:false` — "re-capture when they occur naturally").

### 2.4 Fansly server-side replayability (the DP 1 condition) — OPEN, escalating

- The extension (repo `chatgoose`) builds every Fansly request from: three **static** session
  headers (`authorization`, `fansly-client-id`, `fansly-session-id`), a trivially computable
  `fansly-client-ts` (= `Date.now()`), and **`fansly-client-check` — an opaque token the
  extension never computes**: it is harvested from the browser's own live traffic via a
  `webRequest.onBeforeSendHeaders` listener (`session-capture.ts:85-102`) and stored **per
  route** (`session.routeChecks[routeKey] ?? session.latestCheck`, `fansly-client.ts:341-343`)
  — because a check harvested on one route is not reliably valid on another.
- The two DP 1 endpoint families are: earnings `GET /account/wallets/earnings/stats/accounts`
  and `.../monthlystats/accounts` (route key `earnings`); PPV `GET /media/orderhistory` (route
  key `media`). Both currently reach Fansly only from the extension.
- Core's own Fansly client (`packages/fansly/src/adapter.ts:613-634`) sends the pasted session's
  **single** `fanslyClientCheck` value verbatim on all routes — and this demonstrably works in
  production for the routes core calls today (transactions, subscribers, followers, groups,
  messages). Whether a pasted check validates on the `earnings`/`media` routes — and for how
  long — is **empirically unknown**; core cannot compute fresh checks. Session-death handling
  already exists (auth errors block the page's sync + open an incident —
  `executor.ts:500-537`, `connections.ts:84-135`).
- Consequence: the roadmap carries Stage 6 as an explicit **replay-spike gate** (per-route
  checks added to the session bundle + paste flow, then a live server-side probe of both
  families), with per-endpoint escalation to the owner if any family proves non-replayable —
  per the recorded DP 1 caveat. → Open question Q2.

### 2.5 OnlyMonster dependency surface (code state)

> **Update 2026-07-04:** production check (§8 Q1): none of these OnlyMonster streams run in
> production and zero OnlyMonster-sourced transaction rows exist — the surface below is
> code-only, not a live dependency. Stages 5/15 collapse accordingly.

- Streams that call OnlyMonster (`omapi.onlymonster.ai` via `packages/onlyfans/src/adapter.ts`):
  `light` (page metadata), `transactions` (+ chargebacks — writes canonical `transactions`,
  `fans`, `page_fans`, raw payloads), `fan_identities` (tracking/trial-link users →
  `fans`/`page_fans`/public-profile resolutions), and the **non-OFAPI** DM paths of
  `dm_conversations`/`dm_messages`. `top_spenders` is a pure DB aggregate; `subscribers` routes
  to OFAPI.
- **OnlyMonster-exclusive today:** chargebacks (`canonical_type='chargeback'` produced only by
  the OnlyMonster path — OFAPI ingest's category map never emits it) and tracking/trial-link
  users (no OFAPI branch exists).
- **Transactions are no longer structurally exclusive:** `ofapiSpendTransactionIngestEnabled`
  (staged #51/2) drains OFAPI `transactions.new` projections into canonical `transactions`
  (`ofapi-spend-transaction-ingest.ts:104`, `rawType:"ofapi:<category>"`), and an OFAPI REST
  transactions backfill CLI shipped 2026-07-01 (`ofapi-transactions-backfill.ts`, write mode
  gated by the same flag). OFAPI financial reads-from-truth shipped 2026-07-02 (`6d2870e`).
- **No per-page exclusivity gate exists** — the ingest flag is global, the OnlyMonster
  `transactions` stream is not disabled when it is on, and dedup is per-row on
  `(platform_account_id, transaction_id)` only. The dual-writer hazard (review §5.2) is live
  the moment #51/2 is enabled on a page OnlyMonster also feeds; `transactions` still has **no
  provenance and no currency column** (`schema.ts:1203-1261`; `raw_type` prefix is the only
  provenance proxy). `tips.received` is still projection-blocked
  (`ofapi-spend-projection-contract.ts:298-299`, `tips_received_live_fixture_required`).

### 2.6 Shipped clients and pinned contracts

- **Desktop:** update feed (generic provider, static nginx site
  `https://45-8-230-111.sslip.io/u/…/`) is serving **0.1.28** (released 2026-07-01T01:58Z);
  the repo's committed version field is 0.1.27 — release hygiene note for Stage 35 (and Q5).
  Auto-update applies on **Windows packaged builds only** (`updater.ts:19-21`). Read transport
  default is `hub`; **Direct-OFAPI read mode is still selectable** in settings
  (`HubSettings.tsx:127-131`). The lossy usage-upload policy is confirmed live
  (`packages/shared/src/hub/usage-reporter.ts:17,208-224` — drop after 3 attempts, persisted
  across restarts). Local prunes: 5,000 msgs/chat, 31-day transactions. The hub client is
  hand-verified against core's OpenAPI snapshot of **2026-06-11** (`hub/client.ts:1-6`); no
  snapshot is committed in the desktop repo.
- **Extension:** self-hosted feed `https://ext.gosling-agency.ru/updates.json` serves **1.5.6**
  (matches repo HEAD). Firefox MV3 (gecko, min 142.0). AI is direct-to-vendor only (user-held
  Anthropic/OpenRouter keys, `llm-client.ts:41-74`); hub calls are bearer-key REST
  (`agency-hub-client.ts`) for pages/fan-profiles/ai-usage only.
- **Core-hosted contract artifact:** `reference/agency-hub.openapi.json` (1.7 MB, OpenAPI 3.1,
  regenerated by `pnpm contracts:generate`, last committed 2026-07-02).

### 2.7 Drift since Pass 2 review — none committed; one working tree

No commits after 2026-07-02 (Pass 2 read the same tree). The only drift is the **uncommitted**
dashboard working tree (OFAPI Credits page rework + Pagination props + its test) — frontend-only,
no bearing on this roadmap's facts. Decisions log now runs through **#61** (typing/unsend/
mark-read/media-send command custody, DM aggregates groundwork) — all consistent with the Pass 2
picture.

---

## 3. Sequencing principles and binding invariants

How the stage order in §4 was derived — so that 3b/3c and any future re-planning can re-derive
it instead of guessing:

1. **Perishable first, by perishability.** The §14 perishable-data table is triaged by what is
   being destroyed *fastest* and what is cheapest to stop. Config-only fixes ship before
   code fixes; kernel fixes before client releases (auto-update latency).
2. **Insurance before surgery.** Full OnlyMonster export and desktop local-DB harvest happen
   before the systems that hold those facts are touched, so no later stage can destroy an
   un-copied fact.
3. **The ledger is the anchor, not the gate.** The observation/event ledger lands early because
   capture doors close onto it — but stop-the-bleeding does *not* wait for it (interim retention
   fixes use existing tables), and money consolidation starts its verification in parallel.
4. **Capture in parallel, cut over on parity.** Every replacement of a data feed (OnlyMonster →
   OFAPI, journal → observations, old SSE → stream v2) runs both sides concurrently with a
   verification gate before the old side is retired. No big-bang cutovers anywhere in the plan.
5. **Contracts retire only after their last consumer migrates.** The compatibility invariants in
   target §14 are binding: the SSE `sync` frame protocol, command-outbox intake semantics,
   chatter bearer keys, fan-profile PUT/GET, read-gateway path shape, desktop auto-update feed
   continuity. Each has a named retirement stage that lists its consumers.
6. **One migration in flight per crown jewel.** Stages touching sends, message flow, or money
   never overlap with each other in the sequence; verification windows are explicit exit
   criteria.
7. **Kernel before clients, clients before retirement.** Every client-visible change lands
   kernel-side first (old + new served in parallel), then clients migrate on their own release
   cadence, then the old path is removed in a later, separate stage.
8. **Every stage ends deployed.** No stage's exit criteria are "code merged" — they are "running
   in production, verified by the named check". Long-running background work (backfills) gets
   its own stage so nothing else queues behind it.

---

## 4. The stage sequence

Thirty-five stages in ten phases. The numbered order is the **recommended execution order** —
a serialization of the true dependency graph in §5; stages on independent tracks may run in
parallel where the graph allows, but no stage may start before its listed dependencies exit.
Sizes are rough agent-session estimates (one focused session ≈ half a day of agent work
including verification).

| # | Stage | Phase | Repo(s) | Size |
|---|---|---|---|---|
| 1 | Kernel retention & redaction stand-down | A. Stop the bleeding | core | 1–2 |
| 2 | Kernel destruction-door guards + chatter-read-scope fix | A | core | 1–2 |
| 3 | OFAPI staged-capture enablement completed | A | core (ops) | 1 |
| 4 | Desktop stop-loss release | A | desktop | 1–2 |
| 5 | OnlyMonster full historical export | B. Insurance & gates | core | 1–2 |
| 6 | Fansly server-replay gate (per-route checks + live spike) | B | core (+ext ref) | 1–2 |
| 7 | Observation journal + server-side producers | C. Ledger | core | 3–4 |
| 8 | Domain events, canonicalization, replay | C | core | 3–5 |
| 9 | Read-gateway capture-through + read attribution | C | core | 1–2 |
| 10 | Platform-neutral message archive | C | core | 2–3 |
| 11 | Client-capture lane + desktop hoard upload | C | core + desktop | 2–3 |
| 12 | Desktop local-DB harvest (one-time) | C | desktop (+core) | 1–2 |
| 13 | Transactions provenance, currency, single-writer gate | D. One OnlyFans vendor | core | 2 |
| 14 | OFAPI transactions truth + historical backfills | D | core | 3–4 |
| 15 | OnlyMonster parity gate + retirement | D | core (ops) | 1–2 |
| 16 | Fansly earnings & PPV order-history streams | E. Fansly lit | core | 2–3 |
| 17 | Fansly message backscroll backfill | E | core | 1–2 |
| 18 | Platform adapter seam | F. Structure | core | 4–6 |
| 19 | API decomposition + declarative authorization | F | core | 4–6 |
| 20 | Generated SDK + dashboard adoption + cross-repo gates | F | core (+CI in all) | 3–4 |
| 21 | Event stream v2 | F | core | 2–3 |
| 22 | Identity: all-roles sessions, device tokens, grants, attribution | G. People | core | 3–4 |
| 23 | Workboard kernel module (neutral, event-driven, leases) | G | core | 2–3 |
| 24 | Desktop migration: SDK, stream v2, direct-read removal (DP 8) | G | desktop | 3–4 |
| 25 | Worker scale-out; global-ordering retirement | H. Scale & economics | core | 3–4 |
| 26 | Egress & pacing unification; auth-dead pause | H | core | 2–3 |
| 27 | Money-unit consolidation — **pending Proposal 1** | H | core (+clients) | 2–6 |
| 28 | Retention tiering, lake, metrics, erasure procedure | H | core | 3–5 |
| 29 | AI gateway hardening + restricted capture class (DP 6) | I. AI plane | core | 2–3 |
| 30 | AI feature services + prompt migration | I | core (+refs) | 3–4 |
| 31 | Desktop AI cutover | I | desktop | 2–3 |
| 32 | Extension cutover (SDK, gateway AI, kernel boards, toolchain) | I | extension | 3–4 |
| 33 | Dashboard modernization (stream v2, metrics models) | I | core/dashboard | 2 |
| 34 | Workboard application — **placeholder, pending DP 4 design pass** | J. Closing | new repo | TBD |
| 35 | Re-documentation & family standard | J | all | 3–4 |

---

### Phase A — Stop the bleeding

#### Stage 1 — Kernel retention & redaction stand-down

- **Goal.** No business fact is deleted or redacted on a schedule anywhere in the kernel,
  effective the day this deploys.
- **Product rationale.** Every day of delay permanently destroys OnlyFans money/message
  journals, raw DM payloads, and the text of what chatters actually sent — facts no later stage
  can recover.
- **Scope.** Env + constants + tiny guards, one deploy: `OFAPI_EVENT_RETENTION_DAYS` → 36500 in
  production env **and** code default raised (knob is env-only — §2.2); journal purge job
  additionally guarded to never delete rows whose projections/archive have not consumed them
  (belt and braces); `sync_raw_payloads` windows (180 d / 7 d DM, `sync/shared.ts:27-36`) →
  effectively-forever; DM message sync paths gain `persistRawPayload` (today they persist zero
  raw — review §4.2); `page_dm_messages` prune (200/1,000) becomes a no-op behind a kill-switch
  env; `ofapi_commands` payload self-redaction disabled. Config-registry labels updated so the
  dashboard shows truthful values.
- **Repos:** core · **Depends on:** — · **Size:** 1–2 sessions.
- **Entry criteria.** Disk headroom on the VPS checked (Postgres volume); Q1 answered is *not*
  required.
- **Exit criteria / verification.** Deployed; next 02:30 UTC cleanup run deletes 0 journal rows
  (job log); `page_dm_messages` per-conversation counts strictly nondecreasing over 48 h
  (query); a terminal command older than 7 days still has payload text; DM sync runs produce
  `sync_raw_payloads` rows.
- **Clients during/after.** No visible change to desktop, extension, or dashboard; reads and
  sends untouched.
- **Risks → containment.** Table growth: volumes are tens of MB/day at current scale (target
  §3.4 numbers) — add a disk-usage alert; hot-table reads are LIMIT-bounded (verify preview
  queries stay capped when prune is off).
- **Assumptions.** The daily purge jobs are the *only* deleters of these tables; current
  webhook volume ≈ Pass 2's estimate; `.env.production` is the live env source on the VPS.

#### Stage 2 — Kernel destruction-door guards + chatter-read-scope fix

- **Goal.** One-click and one-key destruction paths are closed: admin resets, page deletes,
  workboard undo, and the chatter-key revenue-read hole.
- **Product rationale.** An owner misclick or a leaked chatter key must not be able to erase a
  page's history or read the whole agency's revenue.
- **Scope.** Admin "reset messages_history" disabled (or double-confirm + archive-first) —
  today it is a guaranteed-loss door (`sync-blocks.ts:552-558`); admin page DELETE blocked when
  the page has transactions/messages (interim tombstone flag until Stage 13's soft-delete
  standard); workboard `undo` writes a retraction marker instead of hard-deleting the contact
  log row; reclassify soft-supersedes classifier verdicts instead of wholesale delete;
  revenue/transactions/reporting routes gated to session roles (owner/team_lead) — closing
  "chatter API keys can read page revenue today" (review §5.3) ahead of Stage 19's systematic
  fix.
- **Repos:** core · **Depends on:** — (parallel with 1) · **Size:** 1–2 sessions.
- **Entry criteria.** Verified (in client code, not assumption) that desktop and extension
  never call the to-be-gated routes with bearer keys — their route inventory is §2.6's list.
- **Exit criteria / verification.** A chatter-key request to a revenue route returns 403
  (integration test); undo produces a retraction row (test); page-delete on a page with facts
  refuses (test); deployed and smoke-checked.
- **Clients during/after.** No change for well-behaved clients; dashboard admin actions show
  new confirmations/refusals.
- **Risks → containment.** An unknown consumer of the gated routes breaks → grep all three
  repos for the exact paths first; ship with a log-only mode for 48 h before enforcing.
- **Assumptions.** The §2.6 client route inventories are complete; workboard v1/v2 are both
  still served (v1 retires in Stage 23).

#### Stage 3 — OFAPI staged-capture enablement completed

- **Goal.** Every already-built OFAPI projection consumes live traffic in production: staged
  groups #49, #50, #51/1 (shadow), #52 (cold archive), #54–#56 (gateway/outbox/executor) all
  running-on. **#51/2 (transactions truth ingest) is explicitly excluded** — it waits for the
  single-writer gate (Stage 13/14).
- **Product rationale.** The projections that make webhook facts durable — above all the DM
  cold archive — were built and verified weeks ago; every hour they stay off, live facts settle
  into a journal (now retained by Stage 1) without becoming serving-grade data.
- **Scope.** Ops-led: read actual production values (Q1), then walk the staged validator's
  prescribed order one flip + restart at a time, watching credit-burn/health alerts between
  flips; record each flip in `decisions.md` per the existing enablement-runbook practice.
- **Repos:** core (ops/config only) · **Depends on:** 1 (journal retained), Q1 answered ·
  **Size:** 1 session.
- **Entry criteria.** Q1 results in hand (which flags are already on — the owner has been
  flipping since 2026-06); credit balance and day-budgets reviewed (audience sweep + DM
  bootstrap spend real credits — registry cost warnings).
- **Exit criteria / verification.** `runtime_instances` shows all target flags running-on on
  all instances; `dm_message_archive` row rate > 0; spend-shadow table populating;
  credit ledger reconciles against the balance ping; read gateway returns 200 for a desktop
  chatter key.
- **Clients during/after.** Desktop gains (or keeps) hub reads/sends; extension and dashboard
  unaffected; dashboard credit/health pages start showing live data if they weren't.
- **Risks → containment.** Credit spend jump → flips one at a time, day-budget knobs
  (`ofapiDmDailyCreditBudget`, `ofapiAudienceDailyCreditBudget`) verified before each; burn
  alert (`ofapiBurnAlertCreditsPerHour`) armed.
- **Assumptions.** The staged validator graph in §2.1 is current; webhook delivery is healthy
  (silence threshold alert quiet); OFAPI-mapped pages are correctly mapped (unique
  `pages.ofapi_account_id`).

#### Stage 4 — Desktop stop-loss release

- **Goal.** The desktop stops destroying telemetry and stops pruning history the kernel does
  not yet hold.
- **Product rationale.** Acceptance telemetry (did the chatter use the AI suggestion) and local
  message/transaction history are being deleted on chatters' machines daily; they are inputs to
  the AI quality loop and the Stage 12 harvest.
- **Scope.** Usage reporter: drop-after-3-attempts (`usage-reporter.ts:17,208-224`) replaced by
  an unbounded durable spool with backoff + a dead-letter state that never deletes;
  HTTP-400 quarantine kept but exportable. Local prunes: message cap 5,000/chat and 31-day
  transaction window raised (interim ~10×) so nothing more is lost before the Stage 12 harvest;
  `cmd:data.purge` gains a "kernel has a copy?" warning (full fix in Stage 11). Ship as 0.1.29
  on the existing generic feed.
- **Repos:** desktop · **Depends on:** — (parallel with 1–3) · **Size:** 1–2 sessions.
- **Entry criteria.** Release process confirmed (Q5 — feed serves 0.1.28 while the repo says
  0.1.27); Windows auto-update path sanity-checked.
- **Exit criteria / verification.** Feed serves the new version; installed clients report it
  (hub telemetry); usage-event drop counter is zero over 7 days; local caps confirmed via the
  app's diagnostics.
- **Clients during/after.** Desktop-only; chatters see nothing except slightly larger local DB;
  extension/dashboard untouched.
- **Risks → containment.** Local DB growth on old machines → caps raised not removed; spool
  growth bounded by the existing batch-upload endpoint draining it.
- **Assumptions.** Auto-update feed continuity invariant (target §14) — same feed URL, same
  unsigned-trust model; macOS installs update manually (auto-update is Windows-only —
  `updater.ts:19-21`).

---

### Phase B — Insurance & gates

#### Stage 5 — OnlyMonster full historical export

- **Goal.** A complete, checksummed, off-box copy of everything OnlyMonster holds for every
  OnlyFans page: transactions, chargebacks, tracking/trial-link users, account metadata, and
  the commission-rate config its net estimates used.
- **Product rationale.** DP 2's owner condition — "full historical export before cancellation,
  lose nothing" — and insurance against vendor-relationship loss at any point during the
  migration.
- **Scope.** A deep-walk export job over the existing adapter under existing pacing: page all
  history for each stream to exhaustion, persist every raw response (Stage 1 made raw payloads
  permanent), and additionally write a self-contained export archive (JSONL + manifest with
  counts and gross/net sums per page/month) stored off the VPS. Read-only against the vendor;
  idempotent (re-runnable, cursor-checkpointed).
- **Repos:** core · **Depends on:** 1 · **Size:** 1–2 sessions (+ unattended runtime).
- **Entry criteria.** OnlyMonster credentials healthy for all pages (light-stream status);
  export destination agreed with owner (off-box storage).
- **Exit criteria / verification.** Manifest counts/sums recorded per page/month; spot-check
  months reconcile against dashboard revenue reports; archive checksummed and stored off-box;
  re-run produces byte-identical manifest (idempotency proof).
- **Clients during/after.** None visible; export paced to not compete with live syncs.
- **Risks → containment.** Vendor rate limits / account flags → existing per-egress-group
  serialization and pacing; run off-peak; abort-resume safe by design.
- **Assumptions.** OnlyMonster retains full history (Pass 2 §14 says yes — verify depth on
  first page before committing to the full walk); vendor account stays active until Stage 15
  signs off.

#### Stage 6 — Fansly server-replay gate (per-route checks + live spike)

- **Goal.** An evidence-backed verdict, per endpoint family, on whether core can replay the
  extension-only Fansly routes (earnings stats, monthly stats, PPV order history — plus
  re-confirm message backscroll) server-side with pasted session material.
- **Product rationale.** DP 1-B (kernel-only Fansly capture) stands or falls on this; the owner
  ordered it verified EARLY with per-endpoint escalation, not planned around.
- **Scope.** Upgrade the session bundle from a single `fanslyClientCheck` to per-route checks
  (`{routeKey: check}` — the extension's own storage shape, §2.4) with backward compatibility;
  extend the paste/verify flow (`PATCH …/credentials`, `POST /admin/credentials/verify`) to
  accept them; run an owner-approved, minimal-volume live probe of each family with freshly
  pasted material; re-probe over several days to measure check longevity. Record the verdict
  table as an addendum to this roadmap.
- **Repos:** core (extension repo as reference only) · **Depends on:** — (any time after 1;
  before 16/17 by definition) · **Size:** 1–2 sessions.
- **Entry criteria.** Owner approves the probe (live model account, real session material) and
  provides per-route header captures (visit the earnings page + an order-history view while
  copying headers, or a one-off export from the extension's session store).
- **Exit criteria / verification.** Per-family verdict recorded: replayable / replayable-but-
  check-rots-in-N-days / non-replayable; Q2 answered to the owner with the narrow per-endpoint
  question if anything is non-replayable.
- **Clients during/after.** None visible; extension behavior unchanged.
- **Risks → containment.** Anti-bot flagging of the model account → minimal call count, real
  browser-shaped headers, existing 2.5 s pacing, owner-chosen account and timing.
- **Assumptions.** The extension's per-route check model (§2.4) is the correct mental model of
  Fansly's checks; core's existing routes continue to validate with the single pasted check
  (demonstrably true in production today — §2.4), so the per-route bundle upgrade is additive
  and cannot regress live Fansly sync.

---

### Phase C — The ledger

#### Stage 7 — Observation journal + server-side producers

- **Goal.** The universal append-only `observations` journal (target §3.1) exists in production
  and every *server-side* producer writes it: webhook receivers, pull-sync handlers, command
  results, operator actions (producers 1, 2, 5, 6 of target §3.3).
- **Product rationale.** Every fact the kernel sees — including ones it cannot parse yet, and
  events for accounts not yet mapped — becomes permanent; "understand later" replaces
  "understand first or lose it".
- **Scope.** New partitioned `observations` table (monthly range on `received_at`; unique
  `(source, idempotency_key)`; `payload_hash`; nullable `account_id` — unmapped accounts are
  captured, not skipped). The OFAPI webhook receiver dual-writes journal-first (existing
  `ofapi_webhook_events` keeps serving its consumers unchanged — no cutover here; it retires
  with stream v1 in Stage 25). The sync executor persists every fetched platform response page
  as an observation, generalizing `persistRawPayload`; command settle emits `command_result`
  observations; admin/operator mutations (credential rotations, manual syncs, resets) land as
  `operator` observations with the acting principal. Journaling is unconditional — no capture
  flags, by construction (target §3.1). Producer 4 (gateway) is Stage 9; producer 3 (clients)
  is Stage 11.
- **Repos:** core · **Depends on:** 1 · **Size:** 3–4 sessions.
- **Entry criteria.** Stage 1 deployed (nothing expires while the journal ramps); VPS disk
  headroom re-checked; partition management approach validated on a staging copy.
- **Exit criteria / verification.** Observation row rate reconciles against webhook receive
  rate + sync fetch counts (`sync_runs` stats); an unmapped-account webhook produces a retained
  observation (integration test); every producer class has ≥1 production row within 48 h; p95
  webhook settle latency unchanged (the journal insert is one bounded INSERT).
- **Clients during/after.** No visible change; SSE, gateway, and outbox untouched.
- **Risks → containment.** Hot-path write amplification → measured before/after on staging;
  missing-partition failures must be loud, never silent drops → partitions pre-created N months
  ahead + alert on the pre-creation job.
- **Assumptions.** Stage 1's retention stand-down still in effect; webhook/sync volumes within
  Pass 2's estimates (target §3.4); Postgres remains the single stateful store (no new infra).

#### Stage 8 — Domain events, canonicalization, replay

- **Goal.** The canonical `domain_events` log (target §3.2): adapters translate observations
  into versioned, platform-neutral events with per-account `account_seq`, multi-producer dedup,
  and a replay job that re-derives events from retained observations.
- **Product rationale.** One vocabulary of what happened — the layer the stream, workboard, and
  analytics will consume — plus the ability to fix a parser and replay history (the
  `tips.received` class of blocker dissolves permanently).
- **Scope.** `domain_events` table (partitioned, append-only, `UNIQUE (account_id,
  account_seq)`, `UNIQUE (account_id, dedup_key)`, `observation_id` provenance FK);
  canonicalizers for the OFAPI webhook kinds and the OnlyFans/Fansly pull-sync observation
  kinds (initial vocabulary from target §3.2); `account_seq` assigned under per-account
  serialization (pg-boss group id per account — the machinery exists for egress groups);
  `parse_version` consumption marking; `kernel events replay` CLI, idempotent via `dedup_key`.
  Existing projections are NOT rewired here — they keep their current feeds; re-anchoring is
  per-projection in later stages (10, 23). `tips.received` canonicalization ships here if its
  live fixture has occurred naturally by then (§2.3); otherwise it becomes the first
  capture-now-parse-later replay when it does.
- **Repos:** core · **Depends on:** 7 · **Size:** 3–5 sessions.
- **Entry criteria.** Stage 7 producers live for several days (a real observation corpus to
  canonicalize against); desktop-repo webhook fixtures current.
- **Exit criteria / verification.** Events derived from live observations for all mapped kinds;
  replay over a copied production slice is idempotent (identical row counts after a double
  run); cross-producer dedup proven in CI (same DM via webhook fixture + REST fixture → one
  event, two observations); `account_seq` gapless per account under concurrent writes (test).
- **Clients during/after.** None visible; nothing consumes `domain_events` yet.
- **Risks → containment.** A wrong `dedup_key` design is the one real one-way risk in this
  phase → the 3b spec must enumerate the key shape per event type and CI-prove cross-producer
  dedup before anything consumes the log; canonicalizer bugs → events are derived data at this
  point — version bump + replay rebuilds them.
- **Assumptions.** Stage 7's observation kinds are stable; the worker is still a single process
  (group serialization orders within it; multi-worker arrives in Stage 25).

#### Stage 9 — Read-gateway capture-through + read attribution

- **Goal.** Every OFAPI response the desktop read gateway proxies lands as an observation
  (producer 4), attributed to the requesting principal — and the credit ledger records who
  spent each read.
- **Product rationale.** The credit spent on a chatter's read currently buys one screen render;
  after this stage it also buys a permanent fact, at zero marginal vendor cost.
- **Scope.** The read gateway (`ofapi-read-gateway.ts`) tees successful response bodies into
  the journal asynchronously, post-respond — never on the chatter's latency path;
  `actor_principal_id` populated from the bearer principal; credit-ledger rows gain the
  principal (closing the review's gateway-attribution gap); canonicalization of chat-list /
  message-page kinds reuses Stage 8's OFAPI parsers (same shapes as REST sync).
- **Repos:** core · **Depends on:** 7 (journal); 8 (parsers — soft, capture works without them)
  · **Size:** 1–2 sessions.
- **Entry criteria.** Gateway flags running-on (Stage 3); Stage 7 deployed.
- **Exit criteria / verification.** Gateway 200s produce observations with principal set
  (24 h count of `producer='read-gateway'` rows ≈ gateway request count); a DM fetched only via
  the gateway appears in `domain_events` once Stage 8 parsers cover it; gateway p95 unchanged.
- **Clients during/after.** Desktop unchanged (same paths, same latency); dashboard can later
  show per-chatter credit spend.
- **Risks → containment.** Body buffering under load → size-capped async tee queue that drops
  to a counter (never blocks serving) + alert on the dropped-capture counter — fail-open is
  acceptable *here only* because proxied reads recur; the counter keeps the gap visible.
- **Assumptions.** The gateway is the desktop's only read path in practice (direct mode exists
  but non-default until Stage 24 removes it); read-gateway path-shape invariant (target §14).

#### Stage 10 — Platform-neutral message archive

- **Goal.** One durable, rebuildable message-archive projection for all platforms — successor
  of the OFAPI-only `dm_message_archive` — serving history reads beyond the hot cache.
- **Product rationale.** "What did this fan say last quarter" gets one answer for OnlyFans and
  Fansly alike; pruning the hot table becomes harmless because history no longer lives there.
- **Scope.** Archive projection keyed by `account_id` + platform-native conversation/message
  refs, fed by `message.*` domain events; declared inputs + per-account watermark + one-command
  rebuild per the §5.2 projection discipline; backfill from existing `dm_message_archive` rows,
  retained raw payloads, and the current contents of `page_dm_messages` (harvest what the hot
  table still holds — it has been un-pruned since Stage 1); minimal internal/dashboard-grade
  read+search endpoints (SDK-grade endpoints ride Stages 19/20). `page_dm_messages` remains the
  interactive cache; its prune stays disabled until Stage 28 re-enables bounded pruning as
  provably safe.
- **Repos:** core · **Depends on:** 8 (and Stage 3's #52 archive flag running) · **Size:** 2–3
  sessions.
- **Entry criteria.** `message.*` events flowing for OFAPI webhooks and for Fansly sync
  (via Stage 7 producers + Stage 8 canonicalizers).
- **Exit criteria / verification.** Archive per-conversation counts ≥ hot-table counts (query);
  Fansly rows present — the platform-neutral proof; rebuild-from-ledger on a staging copy
  reproduces identical counts; a message visible in the desktop is findable in the archive
  within minutes.
- **Clients during/after.** None visible; desktop history UX unchanged until Stage 24.
- **Risks → containment.** Backfill misses hot-table-only rows → the harvest query runs and is
  verified per-conversation *before* any prune policy anywhere changes; storage growth → text
  at tens of MB/day (target §3.4), tiered later by Stage 28.
- **Assumptions.** `dm_message_archive` rows accumulated since the #52 flip are sound; Fansly
  message sync stays healthy under the pasted session.

#### Stage 11 — Client-capture lane + desktop hoard upload

- **Goal.** The authenticated, idempotent client-capture endpoint (producer 3) exists, and the
  desktop uploads its hoard through it: acceptance telemetry, guard-audit events (full text),
  send audit, AI/credit spend ledgers — on a durable spool that never self-deletes.
- **Product rationale.** The AI quality loop's raw signal — did the chatter use the suggestion —
  and the desktop's private audit trail become kernel facts instead of dying on N machines.
- **Scope.** Kernel: bearer-authenticated, batched `POST /ingest/observations` (size caps, rate
  limits, client idempotency keys, per-principal attribution) writing
  `source='client_capture'` observations + canonicalizers for the desktop kinds. Desktop: the
  Stage 4 durable usage spool generalizes into the capture uploader; `cmd:data.purge` gets its
  full target semantics — purge the device, never the kernel's copy (completing Stage 4's
  interim warning). Ship as the next desktop release on the existing feed. Per **DP 1-B** the
  extension does NOT mirror Fansly responses; its existing summary/telemetry pushes migrate to
  this lane in Stage 32.
- **Repos:** core + desktop · **Depends on:** 7 (journal), 4 (spool base) · **Size:** 2–3
  sessions.
- **Entry criteria.** Stage 4's release confirmed across the fleet (hub telemetry); Stage 7
  live.
- **Exit criteria / verification.** Acceptance events from ≥1 production desktop visible
  end-to-end as observations; spool drains after a simulated 24 h offline (test); duplicate
  batch upload is idempotent (test); no unbounded spool growth over a week (fleet telemetry).
- **Clients during/after.** Desktop-only change, invisible to chatters; extension/dashboard
  untouched.
- **Risks → containment.** Telemetry volume spikes → batch caps + polite kernel backpressure
  (Retry-After; the spool absorbs); guard-audit text is sensitive → owner-only read routes now,
  formalized into the restricted access class by Stage 29.
- **Assumptions.** Chatter bearer keys remain the client credential (device tokens arrive in
  Stage 22 — the lane must not assume them); Windows auto-update uptake within days, macOS
  manual (per Stage 4).

#### Stage 12 — Desktop local-DB harvest (one-time)

- **Goal.** Everything the fleet's local SQLite databases hold that the kernel never captured —
  message history beyond the kernel's, local transactions, historical acceptance/guard/send
  audit — harvested once into the ledger.
- **Product rationale.** Chatters' machines are the only place some OnlyFans history exists;
  this is a one-time recovery of facts that predate kernel capture, before any local policy
  loosens.
- **Scope.** A desktop export command that walks the local DBs and uploads via the Stage 11
  lane under a harvest-tagged producer (`desktop-harvest@<version>`); kernel-side dedup happens
  naturally at canonicalization (`dedup_key` vs. already-known events); owner/team-lead-
  triggered per machine, staged across the fleet; per-machine manifest (counts by table and
  date range) reconciled kernel-side. Local prune policies stay frozen (Stage 4 caps) until the
  harvest is verified complete.
- **Repos:** desktop (+core canonicalizer glue) · **Depends on:** 11, 8, 10 · **Size:** 1–2
  sessions (+ fleet runtime).
- **Entry criteria.** Stage 11 lane proven in production; archive (10) live so harvested
  messages have a projection home; fleet inventory with local DB sizes (hub telemetry).
- **Exit criteria / verification.** Per-machine manifests reconciled against kernel ingested
  counts; archive coverage extends to before the webhook epoch for harvested accounts; re-run
  on one machine is a no-op (dedup proof).
- **Clients during/after.** At most a progress note in the desktop; no workflow change.
- **Risks → containment.** Large uploads over home connections → chunked, resumable, off-hours;
  a machine dying mid-harvest → manifest + resume cursor; duplicates → collapsed by Stage 8's
  CI-proven dedup.
- **Assumptions.** Local schema versions across the fleet are within the known range
  (telemetry); what was pruned locally before Stage 4 shipped is already booked as
  unrecoverable — this stage recovers what remains, it does not chase ghosts.

---

### Phase D — One OnlyFans vendor

#### Stage 13 — Transactions provenance, currency, single-writer gate

- **Goal.** `transactions` can say who wrote every row and in what currency, and a per-page
  single-writer gate makes dual-feeding structurally impossible.
- **Product rationale.** Money consolidation (DP 2) is only safe if "which vendor wrote this"
  is a column and two vendors can never fight over one page again (the review §5.2 ping-pong).
- **Scope.** Migration adds `source` (`'onlymonster' | 'ofapi:webhook' | 'ofapi:rest' |
  'harvest' | …`), nullable `source_observation_id` FK (legacy rows stay null), and
  `currency char(3)` (backfilled `'USD'`) to `transactions`; `source` backfilled for existing
  rows from the `raw_type` prefix (§2.5's proxy); a per-page transactions-writer registry
  (e.g. `pages.transactions_writer`) enforced in BOTH write paths — the OnlyMonster stream and
  the OFAPI ingest each refuse rows for a page whose writer is not them, loudly (incident, not
  silent skip). Also here: page soft-delete formalized (`status`/`deleted_at` tombstone
  replacing Stage 2's interim flag) with `ON DELETE RESTRICT` on fact-table FKs — the 38-table
  cascade door closes.
- **Repos:** core · **Depends on:** 7 (FK target — soft: legacy rows carry `source` only), Q1
  · **Size:** 2 sessions.
- **Entry criteria.** Q1 answered — the dual-fed page inventory decides whether any page needs
  per-page reconciliation before its writer is set; #51/2 still OFF (the gate must exist before
  the flag flips).
- **Exit criteria / verification.** 100% of rows carry `source`; wrong-writer insert refused +
  incident (integration test); page delete on a fact-bearing page refused at the FK level
  (test); dashboard revenue totals identical before/after the migration (query diff).
- **Clients during/after.** None visible; API responses gain optional fields only.
- **Risks → containment.** Mixed-provenance history on a dual-fed page (if Q1 finds one) →
  documented per-page reconciliation before the writer is set; migrating the hottest table →
  additive columns + batched backfill, no table rewrite.
- **Assumptions.** The `raw_type` prefix is a faithful provenance proxy for historical rows
  (§2.5); no third writer path exists (the Stage 12 harvest lands via the ledger).

#### Stage 14 — OFAPI transactions truth + historical backfills

- **Goal.** OFAPI becomes the transactions writer of record for OnlyFans pages: truth ingest
  (#51/2) enabled page-by-page under the single-writer gate; full per-page history backfilled
  under credit day-budgets; actual platform fees replace commission-rate estimates; the two
  OnlyMonster-exclusive feeds (chargebacks, tracking-link users) replaced by OFAPI streams.
- **Product rationale.** Creator net becomes a real number from the platform (fee/VAT/tax per
  §2.3) instead of a guess — and the second vendor's replacement becomes provable, page by
  page.
- **Scope.** Per page: set `transactions_writer='ofapi'` (OnlyMonster stream auto-refuses per
  Stage 13), enable `ofapiSpendTransactionIngestEnabled` for it, run the REST backfill
  (`ofapi-transactions-backfill.ts --write`) to full depth strictly under the day-budget
  reservation machinery (**DP 2 condition, binding**). 3b evaluates the `POST /api/data-exports`
  bulk lane (§2.3) as the cheaper alternative per its cost/shape. New OFAPI sync streams for
  chargebacks and tracking/trial-link users (§2.5's exclusives — routes exist per §2.3),
  writing observations → events → `transactions`/`fans`. `tips.received` should be unblocked by
  a naturally-captured live fixture by now; if none has occurred, escalate rather than ship
  unverified parsing.
- **Repos:** core · **Depends on:** 13, 5 (insurance before surgery), 3 (#51/1 shadow
  accumulating), Q1 · **Size:** 3–4 sessions (+ paced backfill runtime).
- **Entry criteria.** Stage 5 export manifest verified off-box; shadow-vs-OnlyMonster parity
  sampled per page; credit balance covers the priced backfill estimate; burn alert armed.
- **Exit criteria / verification.** Per page over the overlap window: OFAPI rows vs OnlyMonster
  rows reconcile on count and monthly gross sums within stated tolerance, with net deltas
  explained as "real fee replaces estimate"; backfill depth reaches account creation or the
  vendor's floor (recorded per page); re-run adds zero rows; day-budget never breached (ledger
  query).
- **Clients during/after.** Dashboard reporting serves throughout (same tables); deltas where
  real fees replace estimates are announced to the owner, never silent.
- **Risks → containment.** Credit exhaustion starving live chat → day-budget reservations +
  burn alert + one-page-first staging; parity confusion between "truer" and "missing" → the
  parity report separates gross reconciliation (must match) from net deltas (explained).
- **Assumptions.** OFAPI history depth suffices (verify on the first page before the fleet —
  §2.3 says no documented limit); `transactions.new` webhook stays live-verified; the Stage 13
  gate is deployed and tested.

#### Stage 15 — OnlyMonster parity gate + retirement

- **Goal.** OnlyMonster switched off everywhere and the subscription cancelled — after the
  owner signs a fleet-wide parity report.
- **Product rationale.** A vendor bill disappears and the money picture has exactly one writer
  per page — the end of the split-truth era.
- **Scope.** Fleet parity report (per page/month: row counts, gross sums, chargeback coverage,
  tracking-link coverage — OFAPI vs OnlyMonster vs the Stage 5 export); OnlyMonster streams
  (`light`, `transactions`, `fan_identities`, non-OFAPI DM paths) disabled per page, then
  globally; adapter code quarantined (kept compilable; deleted behind the seam in Stage 18);
  credentials revoked; the owner cancels the account only after the Stage 5 archive is
  re-verified readable.
- **Repos:** core (ops + small code) · **Depends on:** 14 (all pages migrated), 5 · **Size:**
  1–2 sessions.
- **Entry criteria.** Every OnlyFans page on `transactions_writer='ofapi'` for the agreed
  parity window (recommend 30 days); OFAPI page-metadata coverage confirmed as the `light`
  replacement.
- **Exit criteria / verification.** Parity report signed by the owner and recorded in
  `decisions.md`; zero OnlyMonster egress in logs over 7 days; reports serve normally; the
  bill is cancelled.
- **Clients during/after.** None visible — verified against dashboard reports before/after.
- **Risks → containment.** A gap discovered post-cancellation → the checksummed off-box export
  is the permanent fallback; cancellation is the last step and owner-executed.
- **Assumptions.** No undiscovered OnlyMonster consumer (grep all repos at 3b spec time); the
  vendor account is short-term reactivatable if something surfaces.

---

### Phase E — Fansly lit

#### Stage 16 — Fansly earnings & PPV order-history streams

- **Goal.** Kernel-side Fansly sync covers the two extension-only endpoint families — per-fan
  lifetime/monthly earnings stats and PPV order history — landing as observations → events →
  projections.
- **Product rationale.** The agency's own database finally sees per-fan Fansly revenue and what
  PPV content actually sells — server-side, independent of who is browsing (DP 1-B's point).
- **Scope.** Two new sync streams in the Fansly adapter, using the per-route session material
  established by Stage 6 — the adapter obtains valid route-scoped material via its custody
  descriptor; the capture/refresh mechanics are deliberately not specified here (Scope guard).
  Existing 2.5 s pacing; conservative cadence per family (earnings stats are slow-moving —
  daily/weekly); canonical events (`fan.earnings_observed`, PPV purchase events) + a per-fan
  earnings enrichment projection (feeds spenders/workboard later).
- **Repos:** core · **Depends on:** 6 (replay verdict YES for these families — else this stage
  is re-scoped per the owner's Q2 answer), 8 · **Size:** 2–3 sessions.
- **Entry criteria.** Stage 6 verdict table in hand; session-death monitoring confirmed live
  (§2.4 — it exists); owner-approved ramp plan starting with one page.
- **Exit criteria / verification.** Earnings stats updating on cadence for every active Fansly
  page; PPV order-history depth ≥ extension-visible depth for a sampled fan; zero auth
  incidents attributable to the new streams over 2 weeks.
- **Clients during/after.** Extension unchanged (still reads Fansly directly for its UI);
  dashboard may gain a small Fansly per-fan revenue view here or defer to Stage 33.
- **Risks → containment.** Anti-bot sensitivity on new routes → tiny volumes, conservative
  cadence, one-page ramp, owner-chosen timing; faster check-rot than Stage 6 measured →
  session-death incident pages the owner and the cadence degrades instead of hammering.
- **Assumptions.** Stage 6's longevity measurements hold in steady state; the extension remains
  the *freshness* source in-conversation — these streams buy completeness, not freshness.

#### Stage 17 — Fansly message backscroll backfill

- **Goal.** Full Fansly DM history — beyond the pruned hot window — backfilled into the ledger
  and archive via `before`-cursor pagination, per conversation, resumable.
- **Product rationale.** For Fansly the pruned hot table was the only copy in existence; this
  recovers everything the platform still serves and makes the archive the durable home.
- **Scope.** A paced backfill job walking each conversation to exhaustion (the extension proves
  unbounded depth works — target §14); session-authenticated under existing pacing; writes
  observations (producer 2) → events → archive; per-conversation cursor checkpoints;
  value-ordered fleet staging (top-spender conversations first).
- **Repos:** core · **Depends on:** 6 (message replay re-confirmed), 8, 10 · **Size:** 1–2
  sessions (+ weeks of gentle, paced runtime).
- **Entry criteria.** Archive live; Fansly session healthy; owner OK on the pacing plan (a
  long, gentle crawl by design).
- **Exit criteria / verification.** Per-conversation manifest (count, earliest timestamp) with
  earliest timestamps preceding the hot-window era for old conversations; re-run is a no-op;
  archive search returns years-old Fansly messages.
- **Clients during/after.** None visible; extension unaffected.
- **Risks → containment.** Session rot mid-crawl → checkpointed resume after re-paste; platform
  sensitivity → strict pacing, off-peak windows, abort on any auth anomaly; volume → text-scale
  data, weeks of runtime is acceptable and stated up front.
- **Assumptions.** Fansly retains full history server-side (verify on the first conversation);
  the hot-table prune is still disabled, so there is no race between prune and backfill.

---

### Phase F — Structure

#### Stage 18 — Platform adapter seam

- **Goal.** One `PlatformAdapter` seam (target §4.1): registry-resolved adapters with declared
  capabilities, per-adapter handler modules, the `platform` pgEnum replaced by a reference
  table, and the OnlyFans/Fansly naming inversion dead.
- **Product rationale.** Adding platform #3 becomes a package plus a table row — and every
  later stage stops paying the two-hand-mirrored-adapters tax.
- **Scope.** Extract `PlatformAdapter`/`PlatformCapabilities`; decompose the 4,142-line
  `executor-handlers.ts` into per-adapter stream handlers (move-don't-rewrite); registry
  (`platforms.get(page.platform)`) replaces `AppContext.adapter`/`onlyFansAdapter`;
  `platforms` reference table + text FK, pgEnum retired; quarantined OnlyMonster code deleted;
  the Fansly `SessionCustodyDescriptor` formalizes the pasted-session *interface* (lifecycle,
  verification, death signaling) — capture/refresh mechanics remain deliberately unspecified
  (Scope guard); planner reads `adapter.capabilities.streams` instead of hardcoded per-platform
  lists; lint ratchet: `platform ===` count outside adapter packages may only decrease, target
  ~0.
- **Repos:** core · **Depends on:** 8 (the `canonicalize` seam), 15 (one fewer adapter to
  port); 16/17 recommended-complete (so the Fansly streams move behind the seam once, not
  twice) · **Size:** 4–6 sessions.
- **Entry criteria.** Full Docker integration suite green (this is the plan's biggest pure
  refactor — the suite is the net); sync-critical tests tagged and passing.
- **Exit criteria / verification.** Behavior-identical: sync telemetry (streams run, chunk
  counts, error rates) statistically unchanged over 48 h before/after; branch-site count report
  recorded; enum-to-table migration rehearsed and reversed cleanly on a staging copy.
- **Clients during/after.** None visible — pure internal seam; API contracts unchanged.
- **Risks → containment.** Subtle behavior drift in handler extraction → per-stream telemetry
  diff, staged deploy (one adapter first); the enum migration's blast radius → verified in 3b
  (the text FK lands on `pages.platform` and reference rows; children reference `pages`).
- **Assumptions.** No new platform lands mid-stage; the sync FSM's semantics (planner →
  `page_sync_states` → executor → bounded chunks) are unchanged and keep their tests.

#### Stage 19 — API decomposition + declarative authorization

- **Goal.** The 3,583-line `server.ts` (129 routes) decomposes into the target's ten
  bounded-context modules, and every route carries a declarative `auth` block enforced by one
  middleware — a route without one fails CI.
- **Product rationale.** "Who can do what" becomes one generated, auditable table — and the
  chatter-key-reads-revenue class of hole (interim-patched in Stage 2) becomes impossible to
  reintroduce silently.
- **Scope.** Module extraction along target §6.1 (identity, catalog, ingest, conversations,
  finance, audience, workboard, ai, ops, events) with lint-enforced import boundaries (the
  desktop's `no-restricted-imports` pattern); `routeSchemas` gain `auth: {roles, scope}`; one
  principal-resolution middleware (role check + `page`-scope via the proven `assignedPageIds`
  primitive); Stage 2's interim gates re-expressed declaratively; the policy table generated
  into `docs/generated/`; OpenAPI's `security` becomes derived-and-honest.
- **Repos:** core · **Depends on:** — (hard); recommended after 18 so module lines settle once
  · **Size:** 4–6 sessions.
- **Entry criteria.** Route inventory frozen for the stage's duration; contract tests green.
- **Exit criteria / verification.** All routes declare `auth`; the generated policy table
  diffed against pre-stage behavior route-by-route — any tightening beyond Stage 2's is
  deliberate and listed; role-matrix integration tests per module; well-behaved clients
  unaffected (their route usage per §2.6 re-verified).
- **Clients during/after.** No behavior change for desktop/extension/dashboard principals;
  dashboard admin unaffected.
- **Risks → containment.** An overlooked client call gated off → log-only enforcement first
  (Stage 2's pattern), 48 h of would-deny logs reviewed before enforcing.
- **Assumptions.** §2.6's client route inventory still current; no new principal kinds yet
  (device tokens arrive in Stage 22 — the middleware is designed to accept them additively).

#### Stage 20 — Generated SDK + dashboard adoption + cross-repo gates

- **Goal.** `@kernel/sdk` generated from the Zod contracts (typed operations, runtime
  validation, SSE helpers, auth plumbing, retry/error taxonomy), published per DP 10; the
  dashboard consumes it end-to-end; desktop/extension repos get pinned versions + CI drift
  gates.
- **Product rationale.** Surfaces stop hand-writing hub clients against an eyeballed snapshot;
  contract sync becomes a failing build instead of a convention.
- **Scope.** SDK generator as a core build step, generated from `routeSchemas` directly
  (target §6.3 — sidestepping the `$ref`-less OpenAPI problem); distribution mechanism chosen
  in 3b (private registry vs git-tag installs — DP 10 leaves it open); dashboard migrates fully
  (same repo — the cheapest, most complete first adopter); desktop/extension get pin + contract-
  hash drift CI (adoption itself is Stages 24/32); scheduled bump-PR flow; the unused
  14,753-line `api-types.ts` deleted; OpenAPI artifact continues as published documentation.
- **Repos:** core (+CI wiring in desktop/extension) · **Depends on:** 19 (contracts carry
  `auth`; module structure stable) · **Size:** 3–4 sessions.
- **Entry criteria.** `contracts:generate` clean; special-shape routes (SSE, uploads,
  streaming) enumerated for the generator.
- **Exit criteria / verification.** Dashboard runs on the SDK only (lint bans the old client
  imports); SDK round-trip suite validates every operation against fixtures; a deliberate
  breaking change on a branch fails the client repos' drift CI (gate proven, not assumed).
- **Clients during/after.** Dashboard-internal change only; desktop/extension untouched until
  their stages.
- **Risks → containment.** Generator edge cases → explicit per-route escape hatches,
  documented; registry unavailability → git-tag consumption works as fallback.
- **Assumptions.** Zod contracts remain 129/129 the source of truth; the extension repo is
  still npm/commonjs until Stage 32 — its drift gate uses a standalone check script until then.

#### Stage 21 — Event stream v2

- **Goal.** The SSE stream re-keyed to `domain_events`: per-account ordering
  `(account_id, account_seq)`, opaque resume cursor, per-account 409-snapshot recovery, all
  platforms — served in parallel with stream v1, which desktop pins until Stage 24.
- **Product rationale.** Fansly activity reaches clients for the first time, and the stream
  stops being welded to the OFAPI-only journal and the global-singleton sequence.
- **Scope.** v2 endpoint + frame contract (additive; v1 byte-identical — compatibility
  invariant, target §14); source = `domain_events`; resume cursor encodes per-account
  high-waters; LISTEN/NOTIFY fan-out and 60 s re-auth unchanged; gap-beyond-hot-window → the
  existing `409 sync_snapshot_required` flow, per-account; the Stage 20 SDK SSE helper gains
  v2; a smoke consumer runs in production (dashboard's real migration is Stage 33).
- **Repos:** core · **Depends on:** 8; 20 (SDK helper — soft) · **Size:** 2–3 sessions.
- **Entry criteria.** Domain events complete for the types clients need (`message.*`,
  `transaction.*`, `presence.*` flowing).
- **Exit criteria / verification.** v2 conformance suite mirrors v1's (ordering, resume,
  gap→409, re-auth); dual-stream serving load-measured; a v2 consumer replays a 24 h window
  with zero gaps and zero duplicates (harness).
- **Clients during/after.** None affected — v1 continues unchanged; v2 is opt-in.
- **Risks → containment.** Dual-stream fan-out load → same NOTIFY source, two encoders,
  measured; premature v1 retirement → explicitly out of scope here (Stage 25, after desktop
  migrates).
- **Assumptions.** The SSE frame-union invariant holds on v1 throughout; `account_seq` is
  gapless (Stage 8's CI proof).

---

### Phase G — People

#### Stage 22 — Identity: all-roles sessions, device tokens, grants, attribution

- **Goal.** Chatters become first-class humans: every human role is session-capable; device
  tokens (human-bound, revocable, expiring) succeed bare chatter API keys; grants become the
  append-only `access_grants` log with model- and page-scope; the attribution invariant — no
  kernel write API without a principal — is enforced by lint + review.
- **Product rationale.** The workboard's real blocker dies: a chatter can log in, and
  everything anyone does is attributed to them, not to a shared key.
- **Scope.** `roleCanUseSession` opened to chatter, with the password lifecycle (invite/reset)
  they currently lack; device-token issue/revoke/expiry, carrying the owning human's grants
  (nothing is ever attributed to a bare device); `access_grants`
  (`scope_type org|model|page`; model-scope expands to that model's pages, present and future)
  replacing delete-on-unassign `user_page_assignments`, with a live-permissions projection
  preserving the `assignedPageIds` enforcement shape; migration: current assignments → grant
  rows (parity-checked), chatter keys → device tokens on a deprecation schedule with BOTH
  credential kinds accepted until clients migrate (Stages 24/32 — the bearer-key invariant of
  target §14 holds); attribution gaps closed (contact log actor, snoozes, staged flips, manual
  syncs); the dead `content_manager` enum value removed.
- **Repos:** core · **Depends on:** 19 (the declarative middleware to extend) · **Size:** 3–4
  sessions.
- **Entry criteria.** Stage 19's policy layer live; no other auth work in flight; break-glass
  owner access path tested before any enforcement change.
- **Exit criteria / verification.** A chatter password-login succeeds on a test account; device
  token issue/revoke works while old chatter keys still work (parallel-acceptance test); "who
  had access to page X in June" answered by a grant-history query; live-permissions projection
  exactly equals pre-migration assignments.
- **Clients during/after.** Nothing breaks: bearer keys keep working; desktop/extension adopt
  device tokens in their own stages; dashboard gains minimal user/grant admin.
- **Risks → containment.** Auth regression locking out the fleet → dual credential acceptance +
  staged enforcement + tested break-glass; over-granting via model-scope expansion →
  deny-wins tests and property tests on the expansion.
- **Assumptions.** argon2id/session machinery unchanged (keep-list); DP 4b (workboard app auth)
  stays deferred — kernel sessions here are the substrate the design pass will build on, and
  nothing here forecloses its options.

#### Stage 23 — Workboard kernel module

- **Goal.** The platform-neutral workboard module (target §10.3): the v2 pure engine serving
  all platforms, event-driven recompute in seconds, claim leases, an attributed contact log;
  workboard v1 retired.
- **Product rationale.** The kernel side of "who to message now and why" becomes real-time and
  platform-neutral — everything the future workboard app needs, none of it blocked on DP 4.
- **Scope.** The 822-line pure engine transfers intact with its tests; board serving for both
  platforms (the compute-but-can't-serve OnlyFans split deleted); domain events
  (`message.*`, `transaction.posted`, `subscription.*`, `presence.*`) drive debounced per-fan
  recomputes with the nightly sweep demoted to reconciler; claim-lease table (soft "I'm working
  this fan" locks, event-logged); contact log carries the acting principal; undo becomes a
  compensating `contact.retracted` event (formalizing Stage 2's retraction marker); classifier
  verdicts soft-superseded; v1 routes removed after consumer verification.
- **Repos:** core · **Depends on:** 21 (events to drive recompute), 22 (attribution + grants)
  · **Size:** 2–3 sessions.
- **Entry criteria.** Domain events flowing for both platforms (16 landed Fansly earnings;
  presence per the #50 flags); v1 consumer inventory confirms dashboard-only.
- **Exit criteria / verification.** Board state changes within seconds of a triggering event
  (staging harness); event-driven results equal the nightly reconciler's over a week
  (diff = 0); claim lease prevents double-work (test); v1 routes gone, dashboard tab on the
  module.
- **Clients during/after.** Dashboard workboard views keep working (moved onto module routes);
  desktop/extension unaffected.
- **Risks → containment.** Recompute storms on hot accounts → debounce + per-fan serialization
  (group machinery); engine drift in transfer → byte-for-byte move with its test suite.
- **Assumptions.** DP 4's design pass is still pending — the module API stays app-agnostic;
  the owner's v1-scope note (Fansly-first workboard) affects the app, not this module's
  neutrality.

#### Stage 24 — Desktop migration: SDK, stream v2, direct-read removal

- **Goal.** The desktop becomes a pure kernel client: SDK-based hub client, stream v2, device
  tokens — and Direct-OFAPI read mode removed entirely (DP 8, the write path's
  `z.literal('hub')` precedent).
- **Product rationale.** Every chatter's reads flow through one governed, captured, attributed
  lane — and userspace's last tenancy/capture bypass dies.
- **Scope.** Hand-written hub client → pinned `@kernel/sdk`; SSE v1 → v2 behind the client
  seam (resume-cursor swap); the read-transport enum collapses to `hub` (settings entry
  removed — `HubSettings.tsx:127-131`; break-glass is an ops runbook per DP 8, not a client
  feature); bearer key → device-token login flow; keeps: custody model (SQLCipher, keychain,
  media token indirection), outbox/verifier discipline, local cache UX. Staged fleet rollout on
  the existing auto-update feed, one machine first.
- **Repos:** desktop · **Depends on:** 20 (SDK), 21 (stream v2), 22 (device tokens) · **Size:**
  3–4 sessions.
- **Entry criteria.** SDK stable under the dashboard for ≥2 weeks; v2 conformance suite green;
  Q5 (release hygiene) resolved.
- **Exit criteria / verification.** Fleet on the new version (feed telemetry); zero desktop v1
  SSE connections (server metrics); direct-mode code deleted (repo grep); gateway request
  volume unchanged (no silent fallback path); chat freshness over a full week unchanged —
  crown jewel 1 explicitly verified.
- **Clients during/after.** Chatters see a one-time login (device token) and nothing else;
  extension/dashboard untouched.
- **Risks → containment.** SSE migration bugs = stale chat lists = lost sales → a
  rollout-window-only v1 fallback flag in the client, staged rollout, instant rollback via the
  feed; token-flow lockouts → dual credential acceptance (22) until the fleet confirms.
- **Assumptions.** Auto-update feed continuity invariant (same URL, same trust model);
  auto-update is Windows-only (`updater.ts:19-21`) — macOS installs get a manual step in the
  rollout plan; DP 8's availability trade (kernel down ⇒ reads from local cache only) is
  accepted and the runbook exists.

---

### Phase H — Scale & economics

#### Stage 25 — Worker scale-out; global-ordering retirement

- **Goal.** Workers scale horizontally: per-account serialization fully replaces the global
  `fanout_seq` singleton; stream v1 (the last global-order consumer) and the OFAPI-only
  journal's serving role retire once the desktop is off them.
- **Product rationale.** Capture latency stops being capped by one process — 10× pages must
  not mean 10× lag on the facts chatters act on.
- **Scope.** Canonicalization/projection jobs partitioned by account (Stage 8 laid the seq
  mechanics); the asserted-single-replica worker constraint removed; scheduler leader election
  (advisory lock) formalized with a stateless standby; `fanout_seq` + stream v1 retired after a
  consumer inventory proves zero (desktop migrated in 24; anything else found = blocker);
  M-worker compose topology (target §8.1); the five golden signals (capture lag,
  canonicalization lag, projection lag, command settle time, SSE delivery lag — target §8.5)
  become first-class, exported, and alertable — they are this stage's acceptance instrument.
- **Repos:** core · **Depends on:** 24 (v1 consumers gone), 8 · **Size:** 3–4 sessions.
- **Entry criteria.** Desktop v1 connection count zero for a week; golden-signal baseline
  recorded on the singleton topology.
- **Exit criteria / verification.** ≥2 workers in production; ordering property tests green;
  kill-one-worker chaos check shows no gaps and no duplicates (seq + dedup proofs); lag
  metrics ≤ baseline under synthetic 5× load on staging; v1 code deleted.
- **Clients during/after.** None visible; SSE v2 semantics unchanged.
- **Risks → containment.** Concurrency-ordering bugs (the subtle class) → the property tests
  and chaos check are entry-to-exit requirements, not nice-to-haves; topology drift on the
  VPS → one image, compose-declared roles.
- **Assumptions.** Postgres write-throughput headroom at these volumes (re-verify numbers in
  3b); pg-boss group serialization behaves under multi-worker (verify the pinned version's
  semantics).

#### Stage 26 — Egress & pacing unification; auth-dead pause

- **Goal.** One egress resolver for every platform call (no default path; direct fetch
  lint-banned), per-account pacing with priority classes (interactive > commands > bulk), and
  typed credential-death that pauses a page's streams and opens an incident.
- **Product rationale.** A chatter's open chat never queues behind a backfill; every call for
  an account leaves from the same address (platform-safety crown jewel); a dead session stops
  burning quota on failures.
- **Scope.** `resolveEgress(account)` as the single HTTP-client factory path; the three
  coexisting egress behaviors migrate onto it; budgets keyed `(vendor, account)` with
  vendor-global caps; three priority classes wired into the DB-backed rate-limit waiter — the
  500 ms process-global OFAPI slot replaced by per-account fairness; typed auth-death detection
  (not substring matching) → FSM `paused` + incident, planner skips paused pages (the
  vocabulary exists; this is the wiring).
- **Repos:** core · **Depends on:** 18 (the adapter seam owns the client factory); 19 — soft
  (its ESLint config carries the egress ban) · **Size:** 2–3 sessions.
- **Entry criteria.** Adapter seam stable; a generated egress inventory (every outbound call
  site) reviewed.
- **Exit criteria / verification.** Lint proves no direct undici/fetch outside the resolver;
  staging test: interactive read p95 unchanged while a backfill saturates the bulk class;
  an auth-dead page pauses within one planner cycle and alerts; per-account egress-address
  consistency verified in logs.
- **Clients during/after.** None visible; chat reads can only improve under load.
- **Risks → containment.** Pacing regressions throttling live sync → shadow mode first (log
  decisions, enforce old policy) for 48 h, diff, then cut over; bulk-class starvation → aging
  floor in the waiter; address drift mid-migration → per-account cutover, never global.
- **Assumptions.** Per-page proxy assignment remains the egress-identity mechanism; vendor
  rate-limit shapes per the vendored spec (§2.3).

#### Stage 27 — Money-unit consolidation — **pending Proposal 1**

- **Goal.** One coherent money-unit policy across the family, per the owner's ruling on
  Proposal 1 (§7): either **(a)** mills for platform money + micro-USD for AI cost, with one
  codec and strict named constructors (the §13.8 runner-up — Proposal 1 recommends this), or
  **(b)** the full micro-USD migration of target §5.3.
- **Product rationale.** The 1000× footgun class dies by construction, whichever unit wins.
- **Scope (either ruling).** `packages/shared/money` becomes the single codec; the ambiguous
  `toMills(MoneyLike)` constructor (money.ts:4) and friends are replaced by source-named ones
  (`millsFromDollars`, `microsFromCents`, …) with no bare-number path; lint bans raw arithmetic
  on money columns and ambiguous construction; every money boundary (API contract fields,
  report payloads, client display) carries its unit in its name. **Under (b) additionally:**
  ×1000 migration of the 22 `_mills` schema columns + rollups + report contracts + dashboard
  and desktop display — the blast radius Proposal 1 prices.
- **Repos:** core (+clients under (b)) · **Depends on:** 13 (currency column in place), Q6
  answered · **Size:** 2 sessions under (a); up to 6 under (b).
- **Entry criteria.** Proposal 1 ruled by the owner; report totals snapshotted for a
  before/after diff.
- **Exit criteria / verification.** Lint gates green across repos; report totals byte-identical
  under (a) or exactly unit-converted under (b); zero remaining ambiguous constructor call
  sites (grep = 0).
- **Clients during/after.** (a): nothing visible. (b): coordinated display updates ride each
  client's release train.
- **Risks → containment.** Silent double-conversion under (b) → migrate into new columns, keep
  old until the diff is clean, then drop; mixed-unit joins → the unit-suffix naming rule is
  mandatory under both rulings.
- **Assumptions.** The AI plane continues in micro-USD (its config limits already are — §2.1);
  decision #15 (mills) is superseded only by the owner's explicit ruling.

#### Stage 28 — Retention tiering, lake, metrics, erasure procedure

- **Goal.** The full DP 7 retention model: hot windows in Postgres, aged ledger partitions
  tiered to Parquet on object storage, a DuckDB-queryable lake, versioned SQL metrics models,
  and the audited break-glass erasure procedure reaching all three planes.
- **Product rationale.** Facts become forever at flat cost (the owner's "never in the minus"
  condition), analytics become a queryable product over years of data, and "delete" becomes a
  governed procedure instead of a footgun.
- **Scope.** Partition tiering job — export → checksum-verify → detach, in that absolute
  order — for observations/domain_events/archive; object storage per Q3, with a mandatory
  restore drill; lake layout `plane/table/year/month`; DuckDB query head +
  `core/analytics/models/` (initial set: LTV, cohort retention, net revenue by page/model/day,
  response SLAs, AI acceptance rate); erasure: owner-initiated, scoped (page/model/fan),
  tombstones + physical purge including Parquet rewrite, fully audited, dry-run mode; with
  history now provably held (archive + ledger + tiering), the Stage 1 kill-switches retire and
  bounded hot-table pruning returns as a safe cache policy; ops telemetry gets bounded
  retention — the only scheduled deletion left in the system.
- **Repos:** core · **Depends on:** 8, 10; 12 and 17 recommended-complete (their facts should
  be in the ledger before partitions tier); 29 — soft (the acceptance-rate model needs its
  class; that model lands with 29 otherwise) · **Size:** 3–5 sessions.
- **Entry criteria.** Q3 answered (storage destination); partition sizes measured; the
  cost/perf guardrail numbers written against DP 7's condition.
- **Exit criteria / verification.** A tiered partition queried via DuckDB returns identical
  counts to its pre-detach Postgres rows; restore drill passes; an erasure drill on a synthetic
  fan removes it from hot DB + lake + projections with a complete audit trail; hot DB size
  plateaus (the actual point of the stage); metrics models reproduce current report numbers
  within stated tolerance.
- **Clients during/after.** None visible; dashboard serving swaps to the models in Stage 33.
- **Risks → containment.** Tiering is the one place "append-only" could silently lose data →
  export-verify-then-detach is absolute, checksums mandatory, restore drill gates the first
  real detach; erasure over-reach → dry-run listing + owner confirmation.
- **Assumptions.** Single VPS + S3-compatible store remains the topology (target §8.4); the
  monthly partition scheme from Stages 7/8 is the tiering unit.

---

### Phase I — AI plane

#### Stage 29 — AI gateway hardening + restricted capture class

- **Goal.** The gateway becomes the production-grade single AI lane: OpenRouter actually
  implemented, per-feature routing and budgets, and the DP 6 restricted capture class
  (prompts, completions, acceptance lifecycle) with owner-grant-only reads.
- **Product rationale.** Before any client is forced through the gateway, the gateway must be
  worth being forced through — governed spend, and the product's own quality signal captured
  under proper access control.
- **Scope.** Gateway (#26) hardened: OpenRouter provider implemented (today a dead enum
  value); kernel-side model/pricing table (micro-USD); per-feature budgets and quotas; the
  restricted class: separate partition/tables for content + acceptance, owner-grant-only read
  path, excluded by default from lake exports, covered by the DP 7 erasure procedure; capture-
  volume monitoring per the owner's DP 6 note (trimming later is the two-way door); the usage
  ledger becomes gateway-authoritative (client-reported lane marked deprecated); the workboard
  closing classifier reroutes through the gateway (today it bypasses it with core's own key).
- **Repos:** core · **Depends on:** 7 (capture discipline), 19 (module + policy layer for the
  restricted read path; 22's grant machinery — soft; 28 — soft: its exporter exclusion list
  and erasure procedure are what keep the content tables out of the lake and erasable) ·
  **Size:** 2–3 sessions.
- **Entry criteria.** #26 flag state known (Q1); provider keys confirmed kernel-held.
- **Exit criteria / verification.** The classifier runs via the gateway (its direct SDK import
  gone); a completion round-trips with content captured in the restricted class and unreadable
  by a team-lead principal (test); a budget breach blocks with a typed error (test); the
  pricing table reconciles against vendor invoices for a sample week.
- **Clients during/after.** None affected — desktop/extension stay on their current lanes
  until Stages 31/32.
- **Risks → containment.** Capture volume (DP 6 note) → per-day volume metric + alert;
  gateway latency → intra-VPS single-digit ms, measured and published.
- **Assumptions.** The gateway codebase is as reviewed (well-built); DP 5-A and DP 6-A stand.

#### Stage 30 — AI feature services + prompt migration

- **Goal.** Prompt assembly relocates into the kernel: `POST /ai/features/<feature>` services
  with kernel-side context loading; the desktop's and extension's prompt libraries migrated
  **byte-for-byte** with the escape/sanitize pipeline and its regression tests moving as one
  unit.
- **Product rationale.** The most-tuned production asset — the prompts — gets one home, one
  version, one measured acceptance loop, instead of drifting per machine.
- **Scope.** Feature-service framework (streaming, per-feature model/effort/temperature as
  kernel config, editable per org — not per machine); context loaders over kernel projections
  (transcript from archive/hot table, spend, subscription, fan summary — all present after
  10/14/16); prompts from both clients byte-for-byte (hard rule; the anti-slop tuning is the
  value) with `escapeForPrompt` + safety preamble + output sanitizer and their tests; personas
  become kernel config; a parity harness proves same-context → equivalent assembled prompts
  against the client-local implementations *before* any client cuts over.
- **Repos:** core (desktop/extension repos as reference sources) · **Depends on:** 29, 10
  (transcript context), 16 (Fansly context) · **Size:** 3–4 sessions.
- **Entry criteria.** Prompt inventories in both client repos frozen for the migration window
  (owner-communicated — no tuning mid-move).
- **Exit criteria / verification.** Byte-diff proves prompt equality; the parity harness
  compares assembled prompts (not just outputs) per feature and is signed off; sanitize
  regression tests green kernel-side; features exercised by a production smoke client.
- **Clients during/after.** No client cuts over yet — this stage ends with the kernel *able*
  to serve them all.
- **Risks → containment.** Context drift (kernel-assembled ≠ client-local context) → the
  parity harness is the gate; tuning regressions post-cutover → per-feature acceptance metrics
  watched in Stages 31/32.
- **Assumptions.** The kernel holds all needed context by now (the §3 promise, delivered by
  10/14/16); the Pass 2 feature inventory is still the feature set.

#### Stage 31 — Desktop AI cutover

- **Goal.** Desktop AI goes gateway-only: the local prompt/cost/model machinery retires, the
  dock UX stays, acceptance telemetry correlates to generations in the gateway's capture class.
- **Product rationale.** Chatters' AI spend becomes governed and attributed, and suggestions
  start teaching the product — the acceptance loop closes with zero workflow change.
- **Scope.** The already-wired hub-AI mode becomes the only lane (feature calls via SDK); local
  prompt library, cost tables, and model registry deleted; user-held vendor keys
  decommissioned (owner comms to the team); acceptance lifecycle (shown/inserted/edited/sent)
  reported against generation ids — the Stage 11 lane's events now correlate; staged fleet
  rollout on the feed.
- **Repos:** desktop · **Depends on:** 30, 24 (SDK + device tokens in the desktop), 11 (the
  capture lane the acceptance lifecycle reports on) · **Size:** 2–3 sessions.
- **Entry criteria.** Parity harness signed off; hub-AI mode smoke-tested on one machine doing
  real work for a day.
- **Exit criteria / verification.** Zero direct vendor calls from the fleet (vendor dashboard +
  egress evidence); suggestion latency within the agreed delta of direct mode; acceptance
  events correlated to generation ids in the ledger; owner check-in confirms no workflow
  complaints.
- **Clients during/after.** Desktop-only; extension/dashboard untouched.
- **Risks → containment.** Latency/availability regressions mid-selling-day → staged rollout,
  instant feed rollback; kernel outage = AI outage is the accepted DP 5 trade — the break-glass
  runbook (owner-issued temporary keys) exists as ops, not as a client feature.
- **Assumptions.** DP 5-A stands; prompts frozen since Stage 30 — all tuning is kernel-side
  from here on.

#### Stage 32 — Extension cutover

- **Goal.** The extension becomes a first-class kernel client (DP 3-A): SDK + device tokens,
  AI via kernel features (user-held keys retire), spenders board and fan context served from
  kernel projections, summary/telemetry pushes on the client-capture lane, toolchain migrated
  to the family standard (pnpm/ESM).
- **Product rationale.** The Fansly workspace stops rebuilding spender boards from ~150
  platform calls per creator per 10 minutes and stops needing chatters to hold vendor keys —
  thinner and safer, same UX.
- **Scope.** Hand-written `agency-hub-client` → SDK; bearer key → device token; AI panel →
  feature services (personas from kernel config); spenders board → kernel finance/audience
  queries (real data via Stage 16's earnings projections; Fansly quota spent once, kernel-side,
  incrementally); fan summaries stay kernel-backed, moving onto SDK + capture lane; DOM layer
  and toolbar/panel/overlay UX untouched; npm/commonjs → pnpm/ESM at this natural rework moment
  (target §12.4); release on the self-hosted feed. Per **DP 1-B** the extension remains a
  *reader* of Fansly — no response mirroring.
- **Repos:** extension · **Depends on:** 20 (SDK), 22 (device tokens), 30 (features), 16
  (kernel board data), 11 (capture lane for acceptance telemetry) · **Size:** 3–4 sessions.
- **Entry criteria.** Kernel board queries return parity data vs the extension-computed boards
  (sampled comparison); an early SDK-under-MV3 spike passes (gecko, service-worker
  constraints).
- **Exit criteria / verification.** New version on `ext.gosling-agency.ru` feed; zero direct
  vendor AI calls from extension users; the board renders from kernel data (network panel:
  kernel calls, not ~150 Fansly calls); measured drop in Fansly quota consumption; a chatter
  walkthrough confirms UX parity.
- **Clients during/after.** Extension-only; chatters keep panel, hotkeys, and overlay exactly.
- **Risks → containment.** MV3/gecko SDK incompatibility → the early spike decides; escape
  hatch is a thin generated fetch layer; kernel board cadence lagging in-page freshness → the
  extension may still read Fansly for display freshness (reader role is in-scope; only
  mirroring is out under DP 1-B).
- **Assumptions.** DP 3-A stands (indefinitely maintained surface); the Firefox self-hosted
  update path is unchanged; the extension's Fansly read behavior stays within today's envelope
  (no new call patterns — platform safety).

#### Stage 33 — Dashboard modernization

- **Goal.** The dashboard sheds polling (stream v2) and ad-hoc aggregation SQL (metrics
  models), and gains the new admin surfaces: grants, erasure, capture-plane health.
- **Product rationale.** The owner sees live truth computed from the same metric definitions
  every other consumer uses — not 18 polling endpoints and a 180-line inline `/overview`
  query.
- **Scope.** SSE v2 subscription replaces the polling loops; reporting reads the Stage 28
  metrics models (the inline aggregation dies); admin UI for grants (22), the erasure procedure
  (28, owner-only, dry-run-first), and the golden signals (25); workboard tabs finish moving to
  the module views (23).
- **Repos:** core/dashboard · **Depends on:** 20 (SDK — the adoption this stage builds on),
  21, 22, 28 · **Size:** 2 sessions.
- **Entry criteria.** Metrics models verified against current reports (28's exit); v2 stable
  under desktop fleet load (24 shipped).
- **Exit criteria / verification.** Polling request volume collapses (server metrics); report
  numbers identical pre/post (same models on both sides by then); owner walkthrough of the new
  admin surfaces.
- **Clients during/after.** Dashboard itself; no chatter-facing change.
- **Risks → containment.** Report regressions → the numbers were reconciled in Stage 28; this
  stage only swaps the serving path, and the diff is checked again anyway.
- **Assumptions.** Dashboard stays in core's repo, served same-origin (target §10.4); the
  currently-uncommitted Credits-page working tree (§2.7) has merged or rebased long before
  this.

---

### Phase J — Closing

#### Stage 34 — Workboard application — **placeholder, pending DP 4 design pass**

- **Goal (placeholder).** The standalone workboard product: own repository (owner's DP 4a = B),
  chatters log in, see their assigned models, and see who to message now and why. v1 scope is
  Fansly-only per the owner's decision note. **Deliberately not specified here**: the owner
  deferred 4b (auth mechanism) and 4c (access grain) to a dedicated product-design pass; this
  stage exists in the sequence so nothing else claims its scope and so its prerequisites are
  visibly complete.
- **Product rationale.** The revenue-per-chatter-hour tool — the reason the kernel
  prerequisites exist at all.
- **Scope.** To be written by the design pass. The kernel owes it nothing further by this
  point: sessions + grants (22), platform-neutral module + leases + attribution (23), stream
  v2 (21), SDK (20) are all in production.
- **Repos:** new repo · **Depends on:** 20, 21, 22, 23 + the DP 4 design pass (Q4) · **Size:**
  TBD by the design pass.
- **Entry criteria.** Design-pass output approved by the owner.
- **Exit criteria / verification.** Per the design pass.
- **Clients during/after.** It *is* the new client; existing surfaces unaffected.
- **Risks → containment.** Building it before the design pass — the containment is this
  placeholder's existence and the explicit Q4.
- **Assumptions.** Kernel prerequisites delivered as specced (each has its own exit criteria);
  the family repo standard (Stage 35) applies to the new repo from day one.

#### Stage 35 — Re-documentation & family standard

- **Goal.** Every repo meets the target §12 standard — accurate CLAUDE.md (+ AGENTS.md
  pointer), decisions.md discipline, machine-generated maps regenerated from committed prompts,
  the CI floor everywhere, cross-repo SDK gates humming — so the documentation describes the
  end state, not the starting one.
- **Product rationale.** The owner's operating model is agents-do-the-engineering (DP 10
  emphasis: mandatory, not optional); this is what makes every future agent session start
  oriented instead of doing archaeology.
- **Scope.** Core CLAUDE.md written (the 632-file money repo has none — the family's
  inversion, fixed last-but-not-least); desktop/extension CLAUDE.md updated to post-migration
  truth; Pass 1 maps regenerated from committed prompts into `docs/generated/` with banner
  discipline; decisions.md quick-ref tables current in every repo; the anti-deletion rule
  (tombstone entries for removed docs) recorded as family law; release hygiene fixed — the
  committed-version-vs-feed drift (Q5) becomes a checked release step; CI floors verified:
  typecheck + lint + unit + build per PR in all repos (the desktop's zero-PR-CI ends here at
  the latest), integration nightly in core, projection-rebuild proof in CI.
- **Repos:** all · **Depends on:** everything prior (last by definition) · **Size:** 3–4
  sessions.
- **Entry criteria.** No stage in flight; a stage-list retrospective recorded (where what
  shipped differs from this roadmap, the diff is written down, not papered over).
- **Exit criteria / verification.** The target's own test, run literally: a fresh agent session
  in each repo, given only CLAUDE.md, correctly answers the orientation questions ("where does
  X get written", "who can do what", "what happens when Y arrives"); maps regenerated after the
  last code change; all CI gates green across the family.
- **Clients during/after.** None — documentation and CI only.
- **Risks → containment.** Docs drifting during the migration's long tail → hand-curated docs
  are updated in-change per family law from Stage 20 onward; this stage is the final sweep and
  regeneration, not the first attempt.
- **Assumptions.** Repo topology per DP 10-A (three repos + the workboard's, if Stage 34 has
  shipped); the Pass 1 map-generation prompts are still in each repo.

---

## 5. Dependency graph

Hard dependencies only (a stage may not start before these have exited); "soft" notes
recommended-but-not-blocking ordering. Q-numbers are §8 owner inputs.

| Stage | Hard depends on | Soft / recommended after |
|---|---|---|
| 1 | — | — |
| 2 | — | parallel with 1 |
| 3 | 1, Q1 | — |
| 4 | — | Q5; parallel with 1–3 |
| 5 | 1 | Q3 (destination) |
| 6 | — | after 1; must precede 16/17 |
| 7 | 1 | after 3 |
| 8 | 7 | — |
| 9 | 7 | 8 (parsers) |
| 10 | 8 | 3 (#52 running) |
| 11 | 7, 4 | — |
| 12 | 11, 8, 10 | — |
| 13 | Q1 | 7 (provenance FK form) |
| 14 | 13, 5, 3, Q1 | — |
| 15 | 14, 5 | — |
| 16 | 6, 8 | Q2 (if any family non-replayable) |
| 17 | 6, 8, 10 | — |
| 18 | 8, 15 | 16, 17 (move Fansly streams once) |
| 19 | — | 18 (module lines settle) |
| 20 | 19 | — |
| 21 | 8 | 20 (SDK helper) |
| 22 | 19 | — |
| 23 | 21, 22 | 16 (Fansly board data) |
| 24 | 20, 21, 22 | Q5 |
| 25 | 24, 8 | — |
| 26 | 18 | 19 (ESLint config the egress ban hooks into) |
| 27 | 13, Q6 | — |
| 28 | 8, 10, Q3 | 12, 17 (facts in ledger before tiering); 29 (acceptance-rate model — lands with 29 otherwise) |
| 29 | 7, 19 | 22 (grant machinery); 28 (lake exclusion + erasure reach the content tables) |
| 30 | 29, 10, 16 | — |
| 31 | 30, 24, 11 | — |
| 32 | 20, 22, 30, 16, 11 | — |
| 33 | 20, 21, 22, 28 | 24 (v2 proven under fleet load) |
| 34 | 20, 21, 22, 23, Q4 | — |
| 35 | all | — |

**Tracks** (independent chains that may run in parallel wherever the table allows):

```
Stop-the-bleeding   1 ─→ 3        2, 4 parallel
Insurance/gates     1 ─→ 5        6 independent
Ledger spine        1 ─→ 7 ─→ 8 ─→ {9, 10, 21}
Client capture      4 ──────→ 11 ─→ 12          (11 also needs 7)
Money               Q1 ─→ 13 ─→ 14 ─→ 15        (14 also needs 5, 3)
Fansly              6 ─→ {16, 17}               (both also need 8; 17 needs 10)
Structure           {8,15} ─→ 18 ─→ 26          19 ─→ {20, 22}    8 ─→ 21
People/clients      22 ─→ {23, 24}              {20,21,22} ─→ 24 ─→ {25, 31}
Economics           13 ─→ 27      {8,10} ─→ 28
AI plane            {7,19} ─→ 29 ─→ 30 ─→ {31, 32}   (31/32 also need 11)
Closing             33 ← {20,21,22,28}    34 ← {20..23, Q4}    35 last
```

**Critical path** (longest hard chain): 1 → 7 → 8 → 15-track merge at 18 → 19 → 20/22 → 24 →
25 — i.e. the ledger spine, then the OnlyMonster consolidation feeding the adapter seam, then
the serve-plane rebuild, then the desktop. Fansly (6→16/17), the money track (13→14→15), and
the AI plane (29→30) run substantially in parallel with it. The stop-the-bleeding phase gates
nothing except through Stage 1 — which is why it is first and small.

---

## 6. The stage-spec template for Passes 3b/3c

Every stage specification written by 3b/3c is one file, `pass3/stages/stage-NN-<slug>.md`,
1–3 dense pages, using **exactly** these sections in this order. A spec is done when a fresh
agent session could execute the stage from the spec + the code alone, without re-deriving this
roadmap's reasoning.

```markdown
# Stage NN — <title>

**Repo(s):** … · **Depends on:** stages … · **Passport:** roadmap.md §4, stage NN
**Status header:** any deviation from the master roadmap is recorded HERE as a numbered
proposal for owner sign-off, never silently.

## 1. Context
Why this stage exists (2–5 sentences, product-first), what state the system is in when it
starts (entry criteria restated as facts to VERIFY, with the commands/queries to verify them),
and the exact deliverable. If an entry criterion fails at execution time → stop, report drift.

## 2. Changes
The complete change list, grouped by repo and module: files/modules touched (paths verified
against code at spec-writing time), new files, deleted files. For each change: what and why in
1–2 lines. Naming follows target-architecture conventions.

## 3. Schema & data migration
Numbered SQL migrations sketched at DDL level (CREATE/ALTER statements, indexes, constraints);
data backfills with: idempotency mechanism, batch/rate bounds, credit/cost guards (DP 2
day-budget machinery where OFAPI is touched), progress checkpointing, and the verification
query that proves completeness. "No schema change" is an explicit statement, not an omission.

## 4. Client compatibility
For EACH of desktop / extension / dashboard (and workboard once it exists): what that client
experiences during the stage, after the stage, and what it must NOT notice. Which compatibility
invariants (target §14 list) are in play and how they are preserved. If a contract gains a
successor, the deprecation is declared here with its retirement stage number.

## 5. Tests & verification
New tests (unit/integration, with target file paths); existing suites that must stay green;
production verification: the exact checks (SQL queries, endpoints, log lines, metrics) that
prove the exit criteria, and the observation window (e.g. "48 h of parity metrics") where the
stage requires one.

## 6. Rollback
How to abort at each phase of the stage: feature-flag/config reversal, migration down-path or
roll-forward statement, client version rollback implications (auto-update feed), data cleanup
for partially-run backfills. If any step is irreversible, it is named and gated on an explicit
owner go.

## 7. Assumptions
The facts about the surrounding system this spec relies on (flag states, table shapes, client
versions, contract behaviors), each stated verifiably — so a later session executing the stage
can detect drift from earlier stages instead of silently building on sand.

## 8. Task breakdown
Hand-off-ready, ordered tasks sized for single agent sessions (≤1 session each), each with:
scope, files, done-check. Parallelizable tasks marked. The last task is always: run the
stage's production verification and record the result in the stage file.
```

Rules for 3b/3c use of the template: sections may not be reordered, merged, or omitted (write
"none" rather than dropping a section); the passport's assumptions must be restated and
re-verified in §1/§7, not assumed still true; every path cited must be re-checked against code
at spec-writing time (the maps and this roadmap orient; the code wins).

---

## 7. Design proposals

One proposal. (The §2.2 retention-knob finding was a *review* correction, recorded there; it
changes Stage 1's mechanics, not the design of record.)

### Proposal 1 — Money unit: adopt the §13.8 runner-up (mills + micro-USD with strict named constructors), not the full micro-USD migration

- **What.** Target §5.3 prescribes one unit — `amount_micros` — across the whole system.
  Proposed instead: platform money stays in **mills**; AI cost stays in **micro-USD**; the rest
  of §5.3's discipline ships in full — one codec in `packages/shared/money`, source-named
  constructors with no bare-number path, lint bans on raw money arithmetic and ambiguous
  construction, unit suffixes mandatory on every column/field/variable.
- **Evidence.** The live schema carries **22 `_mills` columns** (transactions gross/net/
  balance, rollups — `schema.ts`); `toMills(MoneyLike)` (`packages/shared/src/money.ts:4`) is
  exactly the ambiguous constructor Pass 2 wants dead — and it dies under either option; 13
  dashboard source files, the desktop's display/cost code, report contracts, and Telegram
  digests all speak mills (entrenched by decision #15); the AI plane already speaks micro-USD
  (the #26 gateway's per-request limits — §2.1). So the system today *is* the runner-up,
  minus the constructor/lint discipline.
- **Why better.** The full migration is a ×1000 rewrite of every money column on the hottest
  tables, all historical rows, every report contract, and both clients' display code — while
  its entire safety benefit (killing the 1000× footgun class) is delivered by the constructor-
  naming + lint rule, which ships under either option. Pass 2 itself pre-authorized this fork:
  §13.8 names the runner-up "acceptable if Pass 3 finds the migration blast radius
  unjustifiable — flagged there, not silently decided." This is that flag, raised. The one
  real cost — two units coexisting — is today's reality already, bounded by the suffix rule.
- **Affected stages.** Stage 27 only (size 2 sessions under this proposal vs. up to 6 under
  the full migration). Stage 13's `currency` column and provenance work are unit-agnostic.
- **Decision needed.** Owner ruling — carried as **Q6**.

---

## 8. Open questions for the owner

Numbered as referenced throughout §2–§4. Q1, Q2 and Q5 gate early stages; the rest can be
answered while Phase A runs. **All six were answered by the owner on 2026-07-04** (recorded
inline below, with consequences); the Q1 production findings materially shrink Stages 3, 5,
13, 14 and 15 — 3b must re-verify them at spec time rather than trusting the passports'
pre-answer wording.

- **Q1 — Production flag state + dual-fed pages** *(gates Stages 3, 13, 14).* Run the §2.1
  queries inside the prod Postgres container (or read owner-only `GET /api/v1/admin/config`):
  which staged flags are running-on today, and does any OnlyFans page have both
  OnlyMonster-sourced and OFAPI-sourced transaction rows? The dual-fed answer decides whether
  Stage 13 needs per-page reconciliation before the writer gate is set.
  **ANSWERED 2026-07-04** (verified over SSH on the VPS, api + worker instances both healthy,
  `skippedOverrides = 0`):
  - **Every staged flag is running-on** on both instances: all of #49, #50, #51 (including
    **#51/2 truth ingest**, on since 2026-06-19), #52, #54–#56, #26. Mechanism: #49/#50 via
    `.env.production` env vars; #51/#52/#54–56/#26 via `config_settings` DB overrides.
    → **Stage 3 collapses to a verification checklist** (its exit criteria, no flips).
  - **No dual-fed pages — zero OnlyMonster rows exist.** Both OnlyFans pages (`lora-of`,
    `lora-vip-of`) are 100 % OFAPI-fed (685 + 2,160 rows, history back to 2025-09 via the
    REST backfill); production runs **no OnlyMonster sync streams at all** (48 h
    `sync_runs`: Fansly full set + OFAPI subscribers/DM only). The early #51/2 enablement is
    therefore safe — there is no second writer. → Stage 13's per-page reconciliation is moot
    (the structural gate is still built); **Stage 14's backfill is already substantially
    done**; **Stages 5 and 15 collapse** — there is no OnlyMonster data to export and no feed
    to retire, only dead code (deleted in Stage 18) and, if a subscription is still being
    paid, a bill the owner can cancel at will.
  - `ofapiEventRetentionDays` runs at the default 7 — the journal purge is live (oldest row
    = exactly 7 days back, 76 k rows retained). **Stage 1 urgency confirmed.** Disk: 32 GB
    free of 79 GB.
  - Live ops issue found in passing: `onlyfans/dm_messages` sync is stuck on two
    conversations (one per account) failing with OFAPI upstream timeouts — 93 retries each
    per 48 h, zero successes. Needs an ops look independent of this roadmap.
- **Q2 — Fansly server-side replayability (the DP 1 condition — §2.4)** *(gates Stage 6's
  execution and, downstream, Stages 16/17's scope).* Two parts. Now: approve the Stage 6
  minimal-volume live probe (which model account, when) and provide freshly captured per-route
  header material for the earnings and order-history families. After Stage 6's verdict: for
  any family that proves **non**-replayable with pasted material, the recorded DP 1 escalation
  applies — choose per endpoint between (a) capture-through for those endpoints only, (b) an
  owner-approved session-provisioning add-on (mechanism deliberately unspecified in these
  documents), or (c) accepting the capture gap explicitly. The roadmap does not plan around
  the gap silently.
  **ANSWERED (part 1) 2026-07-04.** Probe approved — run it on the Lilly pages (`lilly-1`/
  `lilly-2`); the owner expects these routes to be replayable without per-route tokens ("токен
  не нужен, это безопасно") and is comfortable proceeding directly. Stage 6 runs first thing
  in 3b and records the verdict; part 2 (per-endpoint escalation) only activates if the
  owner's expectation turns out wrong.
- **Q3 — Off-box storage destination** *(gates Stage 5's archive and Stage 28's lake/tiering).*
  Which S3-compatible provider/bucket/account, and the monthly cost ceiling per DP 7's
  "never in the minus" condition (§3.4 numbers suggest ~$2/month/year-of-data at 10× scale).
  **ANSWERED 2026-07-04: declined for now** ("я бы не делал этого"). Consequences: Stage 5 is
  moot anyway (Q1 — nothing to export); Stage 28's tiering target is re-scoped at spec time
  (on-box lake, or re-raise the question then). **Standing risk, explicitly owner-accepted:**
  there is still no off-server backup of any kind — the go-live doc already names this an
  infrastructure blocker (`docs/chatgoose-custody-go-live.md:81-83`); if the VPS dies, all
  history dies with it. Re-raise no later than Stage 28.
- **Q4 — Workboard design pass** *(gates Stage 34 only).* When does the dedicated DP 4
  product-design pass run (it must answer 4b auth and 4c access grain), and what is the new
  repository's name/home? All kernel prerequisites proceed regardless.
  **ANSWERED 2026-07-04.** The design pass will produce implementation documentation for a
  separate AI session plus a skeleton, then pause; the PRD still needs work and will be
  developed in a dedicated conversation. Stage 34 stays a placeholder; no date set; kernel
  prerequisites (20–23) proceed as planned.
- **Q5 — Desktop release provenance** *(gates Stage 4's release).* The update feed serves
  0.1.28 (built 2026-07-01) while the repo's committed version field is 0.1.27 — what was
  0.1.28 built from? If it contains unmerged changes, they must be recovered before Stage 4
  ships the next version from the repo; shipping a silent downgrade to the fleet is the risk.
  **ANSWERED 2026-07-04.** Owner: most likely an uncommitted version bump, nothing serious —
  risk accepted. Stage 4 keeps one cheap self-serve mitigation (no owner action needed):
  before shipping the next release, diff the served 0.1.28 artifact against a clean repo
  build to confirm nothing unmerged is being reverted.
- **Q6 — Proposal 1 ruling (money unit)** *(gates Stage 27).* Adopt the runner-up — mills for
  platform money + micro-USD for AI cost, strict named constructors and lint bans (§7,
  recommended) — or execute the full micro-USD migration of target §5.3? Sizes Stage 27 at
  2 vs. up to 6 sessions.
  **ANSWERED 2026-07-04: Proposal 1 accepted** ("делай как правильнее" → the recommended
  runner-up). Stage 27 is sized at 2 sessions: mills stay for platform money, micro-USD for
  AI cost, one codec + source-named constructors + lint bans; no data migration.
