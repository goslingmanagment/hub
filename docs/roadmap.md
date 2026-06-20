# Agency Hub — Product Roadmap

> Last updated: 2026-06-11

## Status Overview

| Phase | Name | Status | Notes |
|-------|------|--------|-------|
| 1 | Agency Hub Core | **Done** | Fansly + OF adapters, sync pipeline, CLI |
| 2 | API + Auth | **Done** | REST API, RBAC, API keys, session auth |
| 3 | OnlyFans Connect | **Done** | OnlyMonster adapter, transactions, chatter metrics |
| 4 | Dashboard | **On Track** | ~90% features built. Polish and bug fixes remaining |
| 4a | CRM Module | **Done** | Retention, reactivation, touchpoints — shipped ahead of plan |
| 4b | DM Sync | **Done** | Conversation + message sync from Fansly |
| 4c | Fan Intelligence | **Done** | AI summaries, version history, cross-page spender analytics |
| 5 | Telegram Notifications | **Done** | Daily reports, incident alerts, test messages |
| 6 | Backups + Ops | **At Risk** | Job queue + monitoring done. Automated off-server backups missing |
| 7 | ChatMuse Backend | **On Track** | Real-time track shipped (OFAPI webhooks → SSE, decision #48); AI proxy, fan context injection, cost tracking not started |
| 8 | Team Management | **Not Started** | Staff profiles, schedules, chatter performance display |
| 9 | Chatter Payroll | **Not Started** | Payout calculation, shift reports |
| 10 | Internal TODO | **Not Started** | Task manager for agency ops |
| 11 | Advanced Analytics | **Not Started** | PnL, traffic ROI, fan LTV, segmentation |

**Summary:** 7 of 11 phases done or near-done. Phase 4 polish + Phase 6 backups are the remaining blockers before production readiness. Phases 7–11 are untouched.

---

## Dependency Graph

```
Phase 1: Agency Hub Core
  └─► Phase 2: API + Auth
       ├─► Phase 3: OnlyFans Connect
       │    ├─► Phase 4: Dashboard (+ 4a CRM, 4b DM Sync, 4c Fan Intel) ─┐
       │    │    └─► Phase 8: Team Management ──────────────────────────►│─► Phase 9: Chatter Payroll ─► Phase 11: Advanced Analytics
       │    │                                                            │
       │    └─────────────────────────────────────────────────────────────┘
       └─► Phase 5: Telegram Notifications

Phase 6: Backups + Ops  (must complete before production deploy)
Phase 7: ChatMuse Backend  (depends on Phases 2 + 4; scheduled after Phases 3-6 by owner decision)
Phase 8: Team Management ─► Phase 10: Internal TODO
```

---

## Phase 1: Agency Hub Core — **Done**

The agency can add models and Fansly pages, sync all financial and audience data, and verify correctness from the command line.

**Features:**
- Add models and attach Fansly pages to them
- Per-page proxy configuration (SOCKS5) with exit IP verification
- Encrypt platform tokens and proxy credentials at rest (AES-256, key versioning)
- Hourly transaction sync: tips, subscriptions, message purchases, post purchases, stream tips, chargebacks, refunds
- Checkpointed, idempotent sync pipeline: upsert raw events first, then rebuild derived projections safely on reruns
- Classify every transaction into a unified type taxonomy (same categories used across all platforms)
- Revenue stored as net (after platform commission); chargebacks deducted but tracked separately; pending transactions tracked with status
- Sync active subscribers: usernames, expiry dates, auto-renew status (Fansly)
- Sync free followers every 12 hours: ID, username, follow date — full parse on first run, then delta-only with rate-limited requests
- Follower deactivation tracking with generation-based rollup accuracy
- Fan identity: canonical key is `(platform, platform_user_id)` with no cross-platform linking
- Create fan records from transactions, subscriptions, and follows
- Compute per-page fan spending from synced transactions
- Build daily rollups for revenue, subscriber counts, and follower counts
- Store all timestamps in UTC
- Retain raw platform responses with configurable retention + automated cleanup
- CLI tools: add model/page, trigger sync, view revenue, verify subscribers, inspect fan spending, sync status watch mode

**Depends on:** None

**Milestone:** ✅ Run a CLI command and see today's Fansly revenue per page matching the platform.

---

## Phase 2: API + Auth — **Done**

The hub exposes a secure API that the dashboard and ChatMuse extension can consume, with role-based access control.

**Features:**
- Fastify REST API with Zod validation and auto-generated OpenAPI schema
- Session-based login (JWT cookies) for dashboard users
- API key authentication for ChatMuse chatters (scoped, revocable, prefix-tracked)
- Role-based access: `owner`, `team_lead`, `chatter`, `content_manager`
- Page-scoped visibility: chatters see only assigned pages; team leads see their pages; owner sees everything
- Revenue endpoints: by model, by page, by period (today/7d/30d/all-time/custom), by transaction type, with period-over-period comparison
- Subscriber, follower, fan profile endpoints with filtering
- Fan data endpoints respecting visibility rules
- All business periods computed on UTC business dates
- Audit trail for sensitive actions: logins, key issuance/revocation, page assignment changes
- Rate limiting per endpoint (Fastify rate-limit plugin)
- Password hashing with Argon2

**Depends on:** Phase 1

**Milestone:** ✅ Make an authenticated API call and receive revenue data. Make a call with a chatter's API key and confirm page-scoped access.

---

## Phase 3: OnlyFans Connect — **Done**

The agency connects OnlyFans pages via OnlyMonster and sees unified data across both platforms.

**Features:**
- OnlyMonster platform adapter for OnlyFans pages (token-based auth)
- CLI onboarding for OnlyFans pages: attach OF page to existing model, configure adapter credentials, trigger sync
- Hourly transaction sync: tips, subscriptions, message payments, post purchases, live stream revenue
- Hourly chargeback sync
- Map OnlyMonster transaction types into the unified taxonomy
- Sync chatter performance metrics from OnlyMonster every 6 hours: messages sent, chat sales, reply time averages, work time, break time
- Sync OnlyMonster tracking-link data daily
- Window-based backfill with synthetic bounds for OnlyFans historical transactions
- No subscriber/follower sync in v1: OnlyMonster does not expose these endpoints
- Create fan records from OnlyFans transactions; compute fan spending
- CLI verification: combined revenue across Fansly + OnlyFans for a single model

**Known issue:** OnlyMonster API timeouts on deep backfill (pages 5+). Not our bug — OM API performance. Workaround: longer timeouts, smaller page sizes, checkpoint-based resume.

**Depends on:** Phase 2

**Milestone:** ✅ See total revenue for a model across both Fansly and OnlyFans, with transactions under the same types.

---

## Phase 4: Dashboard — **On Track** (~90% complete)

The agency opens a browser and sees live revenue, subscribers, fans, and trends across all pages and models.

**Implemented features:**
- ✅ Agency-wide overview: total revenue, page-by-page breakdown, model-by-model summary (both platforms)
- ✅ Revenue display: today, 7d, 30d, all-time with period selector
- ✅ Revenue breakdown by transaction type (subscriptions, tips, messages, posts, streams, chargebacks, refunds)
- ✅ Period comparison: growth or decline vs. the previous equivalent period
- ✅ Drill-down flow: agency overview → model → page → transactions
- ✅ Transaction list with type filters; pending and chargeback status indicators
- ✅ Active subscriber count & list with usernames, expiry dates, renew status (Fansly-only)
- ✅ New subscribers in last 24h highlighted (Fansly-only)
- ✅ Expiring subscriptions list: retention priority view (Fansly-only)
- ✅ Free follower count per page (Fansly-only)
- ✅ Daily inflow chart: new followers/subscribers by day (Fansly-only)
- ✅ Follower/subscriber growth chart over time (Fansly-only)
- ✅ Full fan profiles: spending, subscription/follower status, notes, AI summaries with version history, flags
- ✅ Fan search, whale list, top spenders across the agency
- ✅ Cross-page fan view for team leads; cross-model view for owner
- ✅ Fan notes from the dashboard
- ✅ Last sync time and sync status per page
- ✅ Dashboard alert/incident view: sync failures, dead tokens, proxy issues
- ✅ API key management for ChatMuse (create, view, revoke)
- ✅ Settings page with 5 tabs: Credentials, Sync, Models, Pages, Users
- ✅ Login screen
- ✅ Desktop-only layout
- ✅ Dev pages: Logs, Queue, DB Stats, Incidents (owner-only)

**Remaining work (from TODO.md):**
- 🔴 Unknown User aggregation: deleted Fansly accounts group into one bucket instead of separate entries. Fix: use `platform_user_id` as grouping key.
- 🟡 mikeyt10101 alltime mismatch ($264 vs $256): investigate how Fansly calculates "top supporters"
- 🟡 Default period should be "Today" not "30D"
- 🟡 Followers chart useless on "Today" — needs wider default range
- 🟡 Log/Incident detail view: clickable rows → modal with full message, actionable recommendations per incident type, severity color coding

**Missing from original Phase 4 spec:**
- Custom date range picker (only preset periods exist)

**Depends on:** Phase 2 + Phase 3

**Milestone:** Open the dashboard, see today's revenue by page — Fansly and OnlyFans combined. Drill into a model, see transactions from both platforms. Open a fan profile, see spending and notes. **Partially met — core flows work, polish remaining.**

---

## Phase 4a: CRM Module — **Done** (shipped ahead of plan)

> Not in the original roadmap. Built during Phase 4 development as a natural extension of fan data.

The agency's team leads can prioritize fan retention and reactivation from the dashboard.

**Features:**
- CRM summary dashboard: retention rate, churn indicators, engagement touchpoints
- Retention tab: cohort analysis with touchpoint windows (21d/14d/7d/5d/3d/1d before expiry)
- Filters: auto-renew on/off, unread messages, handled status
- Reactivation tab: scoring for inactive fans ready for re-engagement
- Filters: silence threshold, min spend, no DM history, hide deleted, subscriber state
- Chat preview panel: see recent DM conversation inline
- Sortable columns, search, pagination
- Fansly-only (requires subscriber/DM data not available from OnlyMonster)

**Depends on:** Phase 4 + Phase 4b (DM Sync)

**Milestone:** ✅ Team lead opens CRM, sees subscribers expiring in 3 days sorted by lifetime spend. Opens chat preview, decides who to message.

---

## Phase 4b: DM Sync — **Done** (shipped ahead of plan)

> Not in the original roadmap. Required for CRM retention/reactivation features.

The system syncs direct message conversations from Fansly to power CRM and fan intelligence.

**Features:**
- Sync DM conversations per page (conversation list with metadata)
- Sync message content with configurable retention limits
- Incremental sync with checkpointing
- Rate-limited to respect platform API limits
- Fansly-only (OnlyMonster does not expose DM endpoints)

**Depends on:** Phase 1 (sync pipeline)

**Milestone:** ✅ DM conversations appear in CRM chat preview panel. Fan profiles show last contact date.

---

## Phase 4c: Fan Intelligence — **Done** (shipped ahead of plan)

> Partially described in original Phase 4 but significantly expanded during implementation.

Advanced fan analytics and AI-powered insights across the agency.

**Features:**
- Cross-page spender rankings (v2 API): agency-wide top spenders with period-over-period comparison
- Batch spender lookup for bulk operations
- Per-fan time-series metrics (spend trajectory)
- AI-generated fan summaries with version history (new summaries append, never overwrite)
- Fan flags: whale, VIP, risky (manual in v1)
- Global fan search across all pages
- Type breakdown per fan: subscriptions, tips, messages, posts, streams

**Depends on:** Phase 4

**Milestone:** ✅ Owner opens agency-wide spender view, sees top fans ranked by total spend across all pages with trend indicators.

---

## Phase 5: Telegram Notifications — **Done**

The owner receives daily revenue summaries and immediate alerts for sync and connection problems.

**Features:**
- ✅ Daily revenue report by page, sent to configurable Telegram chat
- ✅ Revenue anomaly alerts: significant drops vs recent trends
- ✅ Sync failure alerts: expired tokens, proxy failures, partial sync errors
- ✅ Token and proxy health checks: periodic verification of all page connections
- ✅ Incident pattern: recurring failures produce one open alert (not spam); resolved when issue clears
- ✅ Test message functionality
- ✅ Report preview and manual send from dashboard
- ✅ Report delivery history
- ✅ Configuration via dashboard UI (Notifications page) — not just CLI
- ✅ Owner-only; configurable chat ID and bot token

**Depends on:** Phase 2

**Milestone:** ✅ Invalidate a Fansly token → receive Telegram alert within minutes. Keep invalid → no spam. Restore → resolved notification sent.

---

## Phase 6: Backups + Ops — **At Risk** (partially complete)

The system is production-ready with automated backups, restore verification, and operational monitoring.

**Implemented:**
- ✅ Health check endpoints (`/health`, `/health/sync`) for uptime monitoring
- ✅ Sync job monitoring: PgBoss queue with job status, failures, retry state, dead letter queues
- ✅ Automated data retention: raw payload cleanup (daily 2 AM UTC), observability log trimming (30-day default)
- ✅ Orphaned run recovery on worker restart
- ✅ Connection status verification (active/stale/error/expired/never_synced/unverified)
- ✅ DB stats endpoint for table sizes and row counts

**Missing — blocks production deploy:**
- ❌ Nightly full database backup stored off-server
- ❌ Periodic restore drills to verify backup integrity
- ❌ Backup monitoring/alerting (backup failed → Telegram notification)

**Depends on:** None technically, but must be completed before production deploy

**Milestone:** Restore a backup to a clean environment and verify all revenue and fan data is intact. **Not met — backups not automated.**

---

## Phase 7: ChatMuse Backend — **On Track**

Chatters using the ChatMuse extension get live fan context, AI-assisted replies with streaming output, and all usage is tracked and rate-limited through the hub. The real-time track (2026-06-11, decision #48) serves the ChatGoose desktop app, which succeeds the extension as the chatter surface.

**Features:**
- ✅ OFAPI webhook receiver: raw-body HMAC verify, `x-ofapi-idempotency-key` dedupe, event journal, async pg-boss processing, owner admin flow to register the webhook + map accounts to pages
- ✅ SSE event fanout `GET /api/v1/events/stream`: chatter-key auth, page-filtered `SyncEvent` frames, `Last-Event-ID` replay, ~7-day journal retention; stale cursors receive `409 sync_snapshot_required`
- ✅ Webhook queue throughput hardening: `ofapi.events.process.v2` uses exclusive event-id
  dedupe and sequential batches of 100, replacing the duplicate-prone one-job polling queue
  without changing settle-order `fanout_seq` semantics.
- ✅ Chatter-scoped `GET /api/v1/events/snapshot`: paginated durable chat/message/tombstone/account-auth state with a snapshot cursor for replay-gap recovery
- ✅ C6 custody slice: default-off, chatter-key `GET /api/v1/ofapi/read/*` proxies only the desktop's allowlisted account-scoped GETs through the core OFAPI client, with assigned-page ACL and page-attributed credit ledger; desktop switching and all write commands remain pending
- ✅ C6 command intake: Decision #55 + migration 0038 add the core command outbox and chatter-key create/read/cancel API for strict `send_text_message_v1` intake. Exact client-id dedupe, mismatch conflicts, retry lineage, page/chatter ACLs, explicit terminal/indeterminate states, and one-in-flight-per-lane are defined. Revision `ea81511d92de` was production-validated default-off, then enabled through audited staged config; the validation command ended cancelled with zero attempts and zero credit-ledger movement.
- 🟡 C6 command execution: the separately flagged, default-off text executor is implemented with one-attempt claims, zero queue retries, stale-attempt recovery to `indeterminate`, page-attributed credit accounting, response confirmation, conservative `messages.sent` repair, and terminal payload redaction from the command sweep. Revision `bbd42e844f36` is production-validated with execution disabled, payload redaction migration applied, zero command-send ledger rows, and no vendor send path active. Controlled test-fan enablement and desktop command transport/recovery UI remain pending.
- 🟡 D6 desktop spend-sweep reduction: core C3 shadow+apply is production-clean for `transactions.new` over 30 days as of 2026-06-19 22:55 UTC (11/11 matched, mismatch buckets zero), and desktop has the rollback flag to restore the legacy 10-minute sweep. Reduction remains blocked until PPV/tips policy is explicitly accepted; PPV unlocks are still estimated-only and `tips.received` still needs a live verified fixture.
- ✅ ChatMuse pre-P4 prerequisites: profile PUT auto-creates OnlyFans fans; AI-usage batch skips invalid events per-event (`invalidCount`)
- 🟡 Admin UI for the OFAPI webhook flow (API-only today; register via `POST /api/v1/admin/ofapi/webhook`)
- 🟡 AI proxy with streaming responses — R4a contract schemas/docs define the default-off
  prompt-streaming gateway; R4b adds the default-off route/config gate; R4c adds gateway ledger
  storage/repository fields; R4d adds ledger-backed daily quota preflight; R4e adds Anthropic
  pricing for terminal usage rows; R4f adds Anthropic request-building and usage normalization
  without provider network; R4g adds the SSE provider seam; R4h adds terminal ledger finalization
  for provider-seam streams; R4i reserves
  request ids before provider execution to prevent duplicate paid attempts; R4j adds the real
  Anthropic streaming adapter default-off; R4k recovers stale null-outcome reservations before new
  authorized provider attempts; R4l adds owner usage reporting for gateway cost/outcomes. Revision
  `736d37c66549` is deployed default-off with api/worker healthy,
  `chatMuseAiGatewayEnabled=false`, `anthropicApiKey=unset`, no gateway ledger rows, and
  production reporting code returning the new cost/gateway fields. Live provider validation and
  desktop switch remain pending
- Fan context injection: spending (page + total), notes, AI summary, subscription status, flags in one panel
- Fan notes via the app: chatters create and read notes visible to others on the same page
- AI-generated fan summaries from chat history; version history preserved
- Rate limiting: per-chatter configurable request quota
- Cost tracking: every AI request logged with chatter, page, token count, dollar cost
- Prompt caching: identical prompts return cached responses
- Model personality management: update voice/persona in one place, applied to all chatters on that page

**Depends on:** Phase 2 + Phase 4

**Milestone:** A chatter opens a Fansly DM in the extension, sees fan spending and notes. Uses AI-assisted reply with streamed output. Owner sees request count and cost in the dashboard. ✅ Real-time milestone: a captured OFAPI webhook delivery reaches a connected desktop as a page-filtered SSE frame, with dedupe and Last-Event-ID resume (integration-tested end-to-end).

---

## Phase 8: Team Management — **Not Started**

The agency manages staff, page assignments, and work schedules in one place.

**Features:**
- Staff profiles: chatters, content managers, team leads
- Assign staff to specific pages
- Schedule table: who works when, which days, what hours, days off
- Chatter performance metrics display (OnlyMonster data already collected in Phase 3)
- Dashboard access management for team leads

**Note:** Basic user management (create users, assign pages, manage API keys) already exists in Phase 4 Settings → Users tab. Phase 8 adds scheduling, profiles, and performance display on top.

**Depends on:** Phase 4 + Phase 3

**Milestone:** Add a chatter, assign them to two pages, set their weekly schedule. See their OnlyMonster performance metrics on the dashboard.

---

## Phase 9: Chatter Payroll — **Not Started**

The agency tracks chatter earnings, calculates payouts as a percentage of chat sales, and sees who is owed what.

**Features:**
- OnlyFans payroll uses OnlyMonster chat sales data; Fansly payroll uses manual shift reports
- Chatter shift reports: chatters submit what they sold for Fansly periods
- Owner configures one payout percentage per chatter; changes apply to future periods only
- Revenue calculated as percentage of chat sales
- Payout calculation: how much is owed to each chatter and for what
- Payout overview table for optimizing payments
- Manual revenue entry for Fansly chatters (no automated chatter-level sales data on Fansly)

**Depends on:** Phase 3 + Phase 8

**Milestone:** A Fansly chatter submits a shift report and an OnlyFans chatter has sales imported automatically. Owner opens the payout table and sees both amounts calculated.

---

## Phase 10: Internal TODO — **Not Started**

A simple task manager for agency operations — not code tasks, but business and team tasks.

**Features:**
- Create tasks for agency operations
- Assign tasks to staff members
- Statuses and priorities

**Depends on:** Phase 8

**Milestone:** Create a task, assign it to a team lead, and mark it complete.

---

## Phase 11: Advanced Analytics — **Not Started**

The agency sees profitability, traffic ROI, and deeper fan insights to optimize business decisions.

**Features:**
- PnL per model: revenue minus all expenses (traffic, chatter payouts, content management)
- Traffic spend tracking: add channels (Reddit, Twitter, YouTube, etc.), track acquisition and ad spend, calculate ROI
- Fan LTV calculation
- Fan segmentation: whale, regular, tipper, lurker, new fan (automated rules, not just manual flags)
- Expense tracking across all cost categories
- Enhanced trend charts and dashboards
- Content operations for content managers: posting calendar, content status per page

**Depends on:** Phase 9

**Milestone:** Open a model's analytics view and see net profit after all tracked expenses. See which traffic channel delivered the highest ROI.

---

## Known Issues & Tech Debt

Items from TODO.md that affect shipped phases:

| Priority | Issue | Phase | Status |
|----------|-------|-------|--------|
| 🔴 | Unknown User aggregation: deleted accounts merged into one bucket | 1/4 | Open |
| 🟡 | mikeyt10101 alltime total mismatch ($264 vs $256) | 1 | Investigating |
| 🟡 | CLI missing `page remove` command — requires manual SQL cleanup | 1 | Open |
| 🟡 | Dashboard default period should be "Today" not "30D" | 4 | Open |
| 🟡 | Followers chart useless on "Today" period — needs wider default range | 4 | Open |
| 🟡 | Log/Incident detail: no clickable rows, no actionable recommendations | 4 | Open |
| 🟡 | CLI missing interactive prompts when required args not provided | 1/2 | Open |
| 🟡 | OnlyMonster API timeouts on deep backfill (pages 5+) | 3 | External dependency |

---

## Changes This Update (2026-06-11)

**Statuses updated:**
- Phase 7: → **On Track** — the real-time track shipped (decision #48): OFAPI webhook receiver (raw-body HMAC, idempotency-key dedupe, `ofapi_webhook_events` journal, pg-boss async processing, admin registration flow) and SSE fanout `GET /api/v1/events/stream` (chatter-key auth, page-filtered `SyncEvent` frames, `Last-Event-ID` replay, 7-day retention), integration-tested end-to-end against the live-captured OFAPI fixtures. AI gateway scope remains untouched.

**Items added:**
- Phase 7 pre-P4 prerequisites for the ChatGoose desktop: OnlyFans fan auto-create on profile PUT, per-event skip in AI-usage batch ingestion
- Follow-up flagged: dashboard admin UI for the OFAPI webhook flow (API-only today)

---

## Changes Past Updates (2026-03-26)

**Statuses updated:**
- Phase 1: → **Done**
- Phase 2: → **Done**
- Phase 3: → **Done** (was untracked)
- Phase 4: → **On Track** (~90%)
- Phase 5: → **Done** (was not started per previous roadmap)
- Phase 6: → **At Risk** (partial)

**Items added:**
- Phase 4a: CRM Module (retention/reactivation) — built but was not in roadmap
- Phase 4b: DM Sync — built but was not in roadmap
- Phase 4c: Fan Intelligence — expanded beyond original Phase 4 scope
- Known Issues & Tech Debt section — consolidates TODO.md items
- Status overview table at top
- Per-feature completion checkmarks in done phases

**Structural changes:**
- Added note to Phase 8 that basic user management already exists in Phase 4 Settings
- Added known issue to Phase 3 (OnlyMonster timeouts)
- Phase 6 split into implemented vs missing items
