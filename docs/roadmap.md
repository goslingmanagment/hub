# Agency Hub — Product Roadmap

## Dependency Graph

```
Phase 1: Fansly Connect
  └─► Phase 2: API + Auth
       ├─► Phase 3: OnlyFans Connect
       │    └─► Phase 4: Dashboard ──────────────┐
       │         └─► Phase 8: Team Management ───►│─► Phase 9: Chatter Payroll ─► Phase 11: Advanced Analytics
       │                                          │
       └─► Phase 5: Telegram Notifications        │
                                                   │
Phase 8: Team Management ─────────────────────────► Phase 10: Internal TODO

Phase 6: Backups + Ops  (must complete before production deploy)
Phase 7: ChatMuse Backend  (depends on Phases 2 + 4; intentionally scheduled after Phases 3-6 by owner decision)

Phase 3 (OF Connect) precedes Phase 4 (Dashboard) so the dashboard ships with both platforms from day one.
Phase 5 runs after Phase 2 and can ship independently of Phases 3, 6, and 7.
```

---

## Phase 1: Fansly Connect

The agency can add models and Fansly pages, sync all financial and audience data, and verify correctness from the command line.

**Features:**
- Add models and attach Fansly pages to them
- Per-page proxy configuration to avoid single-IP detection
- Encrypt platform tokens and proxy credentials at rest
- Hourly transaction sync: tips, subscriptions, message purchases, post purchases, stream tips, chargebacks, refunds
- Checkpointed, idempotent sync pipeline: upsert raw events first, then rebuild derived projections safely on reruns
- Classify every transaction into a unified type taxonomy (same categories used across all platforms later)
- Revenue stored as net (after platform commission); chargebacks deducted but tracked separately; pending transactions tracked with status
- Sync active subscribers: usernames, expiry dates, auto-renew status (where the platform provides it)
- Sync free followers every 12 hours: ID, username, follow date — full parse on first run, then delta-only updates every 12 hours with rate-limited requests (~5 sec pauses, handling 5–15k per page)
- Fan identity is a core schema rule: canonical fan key is `(platform, platform_user_id)` with no cross-platform linking
- Create fan records from transactions, subscriptions, and follows using the canonical platform fan identity
- Compute per-page fan spending from synced transactions
- Build daily rollups for revenue, subscriber counts, and follower counts
- Store all timestamps in UTC
- Retain raw platform responses for debugging and future re-mapping
- CLI tools: add model/page, trigger sync, view today's revenue, verify subscriber counts, inspect fan spending

**Depends on:** None

**Milestone:** Run a CLI command and see today's Fansly revenue per page matching the platform. Run another command and see the active subscriber list with expiry dates.

---

## Phase 2: API + Auth

The hub exposes a secure API that the dashboard and ChatMuse extension can consume, with role-based access control.

**Features:**
- Authenticated API serving all collected data: revenue, transactions, subscribers, followers, fans
- Dashboard login with password-based accounts for owner and team leads
- Minimal staff/account skeleton via CLI: users, roles, and page assignments for `owner`, `team_lead`, `chatter`, and `content_manager`
- ChatMuse authentication: scoped API keys (one per chatter), issued via CLI, revocable
- Page-scoped access control: chatters see only their assigned page; team leads see their assigned pages; owner sees everything
- Fan data endpoints respecting visibility rules — chatters get their page's fan data plus total platform spending; team leads get cross-page view; owner gets full agency view
- Revenue endpoints: by model, by page, by period (today / 7d / 30d / custom / all-time), by transaction type, with period-over-period comparison
- Subscriber and follower endpoints with filtering
- Fan profile endpoints: spending, subscription status, notes, summaries, flags, and the list of pages that fan follows/subscribes to on that platform
- All business periods computed in Moscow time
- Generate OpenAPI from Zod route schemas and publish typed API clients for dashboard and extension consumers
- Audit trail for sensitive actions: logins, key issuance/revocation, page assignment changes

**Depends on:** Phase 1

**Milestone:** Make an authenticated API call and receive revenue data matching the CLI. Make a call with a chatter's API key and confirm it returns data only for the assigned page.

---

## Phase 3: OnlyFans Connect

The agency connects OnlyFans pages via OnlyMonster and sees unified data across both platforms.

**Features:**
- OnlyMonster platform adapter for OnlyFans pages
- CLI onboarding for OnlyFans pages mirrors Phase 1: attach an OF page to an existing model, configure adapter credentials, and trigger sync manually when needed
- Hourly transaction sync: tips, subscriptions, message payments, post purchases, live stream revenue
- Hourly chargeback sync
- Map OnlyMonster transaction types into the same unified taxonomy defined in Phase 1
- Sync chatter performance metrics from OnlyMonster every 6 hours: messages sent, chat sales, reply time averages, work time, break time
- Sync OnlyMonster tracking-link data daily
- No subscriber/follower sync in v1: OnlyMonster does not expose subscriber/follower endpoints, so subscriber/follower features remain Fansly-only until that changes
- Create fan records from OnlyFans transactions; compute fan spending from synced data
- CLI verification: see combined revenue across Fansly + OnlyFans for a single model

**Depends on:** Phase 2

**Milestone:** Run a CLI command and see total revenue for a model across both Fansly and OnlyFans pages, with transactions classified under the same types.

---

## Phase 4: Dashboard

The agency opens a browser and sees live revenue, subscribers, fans, and trends across all pages and models — Fansly and OnlyFans combined from launch.

**Features:**
- Agency-wide overview on the main screen: total revenue, page-by-page breakdown, model-by-model summary (both platforms)
- Revenue display: today, 7 days, 30 days, all-time, custom date range
- Revenue breakdown by transaction type (subscriptions, tips, messages, posts, streams, chargebacks, refunds)
- Period comparison: growth or decline vs. the previous equivalent period
- Drill-down flow: agency overview → model → page → individual transactions
- Transaction list with type filters; pending and chargeback status indicators
- Active subscriber count, list with usernames, expiry dates, and renew on/off status — Fansly-only; not available for OnlyFans until OnlyMonster adds subscriber/follower endpoints
- New subscribers in the last 24 hours highlighted — Fansly-only
- Expiring subscriptions list: subs expiring in 1, 3, or 7 days — retention priority view for team leads, Fansly-only
- Free follower count per page — Fansly-only
- Daily inflow: new followers and subscribers by day; growth and decline trends — Fansly-only
- Follower and subscriber growth chart over time — Fansly-only
- Full fan profiles: per-page spending, total platform spending, subscription status, follower status, notes, AI summaries with version history, flags (whale, VIP, risky), and platform page memberships
- Fan search, whale list, top spenders across the agency
- Cross-page fan view for team leads; cross-model view for owner
- View and create fan notes from the dashboard
- Manual fan flags in v1: owner and team leads can set whale, VIP, and risky flags; automatic rules are deferred to Phase 11
- Last sync time and sync status per page
- Dashboard alert view for DB-backed incidents: sync failures, dead tokens, and proxy issues
- API key management for ChatMuse (create, view, revoke keys for chatters)
- Login screen
- Desktop-only layout

**Depends on:** Phase 2 + Phase 3

**Milestone:** Open the dashboard, see today's revenue by page matching the platform — Fansly and OnlyFans combined. Drill into a model, see transactions from both platforms. Open a fan profile, see spending and notes.

---

## Phase 5: Telegram Notifications

The owner receives a daily revenue summary and immediate alerts for sync and connection problems.

**Features:**
- Daily revenue report by page, sent to a configurable Telegram chat
- Revenue anomaly alerts: significant drops compared to recent trends
- Sync failure alerts: expired platform tokens, proxy failures, partial sync errors
- Token and proxy health checks: periodic verification that all page connections are alive; failures become alerts
- Incident pattern: recurring failures produce one open alert (not repeated spam), resolved when the issue clears
- Telegram is the delivery layer for DB-backed incidents; dashboard alert viewing already exists in Phase 4
- Owner-only; configurable chat ID

**Depends on:** Phase 2

**Milestone:** Invalidate a Fansly token. Within minutes, receive a Telegram alert about the dead connection. Keep the token invalid and confirm repeated checks do not spam; restore it and confirm one resolved notification is sent.

---

## Phase 6: Backups + Ops

The system is production-ready with automated backups, restore verification, and operational monitoring.

**Features:**
- Nightly full database backup stored off-server
- Periodic restore drills to verify backup integrity
- Health check endpoint for uptime monitoring
- Sync job monitoring: visibility into job status, failures, and retry state

**Depends on:** None technically, but must be completed before production deploy

**Milestone:** Restore a backup to a clean environment and verify that all revenue and fan data is intact and queryable.

---

## Phase 7: ChatMuse Backend

Chatters using the ChatMuse extension get live fan context, AI-assisted replies with streaming output, and all usage is tracked and rate-limited through the hub.
This phase is intentionally scheduled after Phases 3-6 by owner decision, even though its hard dependencies are only the API and dashboard.

**Features:**
- AI proxy with streaming responses — the extension sends requests through the hub, not directly to the AI provider
- Fan context injection: when a chatter opens a DM, the extension receives spending (page + total), notes, AI summary, subscription status, and flags in one panel
- Fan notes via the extension: chatters create and read notes; notes from one chatter are visible to others on the same page
- AI-generated fan summaries from chat history; version history preserved (new summaries append, never overwrite)
- Rate limiting: each chatter has a configurable request quota
- Cost tracking: every AI request logged with chatter, page, token count, and dollar cost
- Prompt caching: identical prompts return cached responses to reduce cost
- Model personality management: update a model's voice/persona in one place, applied to all chatters on that page

**Depends on:** Phase 2 + Phase 4

**Milestone:** A chatter opens a Fansly DM in the extension, sees the fan's spending and notes. Uses AI-assisted reply with streamed output. The owner sees the chatter's request count and cost in the dashboard.

---

## Phase 8: Team Management

The agency manages staff, page assignments, and work schedules in one place.

**Features:**
- Staff profiles: chatters, content managers, team leads
- Assign staff to specific pages
- Schedule table: who works when, which days, what hours, days off
- Chatter performance metrics display (OnlyMonster data collected in Phase 3)
- Dashboard access management for team leads

**Depends on:** Phase 4 + Phase 3

**Milestone:** Add a chatter, assign them to two pages, set their weekly schedule. See their OnlyMonster performance metrics on the dashboard.

---

## Phase 9: Chatter Payroll

The agency tracks chatter earnings, calculates payouts as a percentage of chat sales, and sees who is owed what.

**Features:**
- OnlyFans payroll uses OnlyMonster chat sales data; Fansly payroll uses manual shift reports
- Chatter shift reports: chatters submit what they sold for Fansly periods
- Owner configures one payout percentage per chatter; percentage changes apply to future periods only and do not recalculate closed periods
- Revenue calculated as percentage of chat sales
- Payout calculation: how much is owed to each chatter and for what
- Payout overview table for optimizing payments
- Manual revenue entry for Fansly chatters (no automated chatter-level sales data on Fansly)

**Depends on:** Phase 3 + Phase 8

**Milestone:** A Fansly chatter submits a shift report and an OnlyFans chatter has sales imported automatically. The owner opens the payout table and sees both payout amounts calculated from the configured per-chatter percentages.

---

## Phase 10: Internal TODO

A simple task manager for agency operations — not code tasks, but business and team tasks.

**Features:**
- Create tasks for agency operations
- Assign tasks to staff members
- Statuses and priorities

**Depends on:** Phase 8

**Milestone:** Create a task, assign it to a team lead, and mark it complete.

---

## Phase 11: Advanced Analytics

The agency sees profitability, traffic ROI, and deeper fan insights to optimize business decisions.

**Features:**
- PnL per model: revenue minus all expenses (traffic, chatter payouts, content management)
- Traffic spend tracking: add channels (Reddit, Twitter, YouTube, etc.), track acquisition and ad spend, calculate ROI
- Fan LTV calculation
- Fan segmentation: whale, regular, tipper, lurker, new fan
- Expense tracking across all cost categories
- Enhanced trend charts and dashboards
- Content operations for content managers: posting calendar, content status per page

**Depends on:** Phase 9

**Milestone:** Open a model's analytics view and see net profit after all tracked expenses. See which traffic channel delivered the highest ROI.
