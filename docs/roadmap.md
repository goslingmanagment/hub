# Agency Hub — Product Roadmap

## Dependency Graph

```
Phase 1: Fansly Connect
  ├─► Phase 2: API + Auth
  │    ├─► Phase 3: Dashboard ───────────────┐
  │    ├─► Phase 5: Telegram Notifications   │
  │    │                                     ▼
  │    └──────────────────► Phase 7: ChatMuse Backend
  │
  └─► Phase 4: OnlyFans Connect  (does not block anything)

Phase 6: Backups + Ops  (must complete before production deploy)

Phases 3 + 5 run in parallel.
Phase 4 runs in parallel with Phases 2–3.
Phases 8–11 are flexible in order; all depend on Phase 2+.
  Phase 8:  Team Management
  Phase 9:  Chatter Payroll   (after Phase 8)
  Phase 10: Internal TODO     (after Phase 8)
  Phase 11: Advanced Analytics (after Phase 9)
```

---

## Phase 1: Fansly Connect

The agency can add models and Fansly pages, sync all financial and audience data, and verify correctness from the command line.

**Features:**
- Add models and attach Fansly pages to them
- Per-page proxy configuration to avoid single-IP detection
- Hourly transaction sync: tips, subscriptions, message purchases, post purchases, stream tips, chargebacks, refunds
- Classify every transaction into a unified type taxonomy (same categories used across all platforms later)
- Revenue stored as net (after platform commission); chargebacks deducted but tracked separately; pending transactions tracked with status
- Sync active subscribers: usernames, expiry dates, auto-renew status (where the platform provides it)
- Sync free followers every 12 hours: ID, username, follow date — full parse on first run, then delta-only updates every 12 hours with rate-limited requests (~5 sec pauses, handling 5–15k per page)
- Create fan records from transactions, subscriptions, and follows
- Compute per-page fan spending from synced transactions
- Fans are platform-scoped — Fansly fans and OnlyFans fans are never linked to each other, only within the same platform
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
- ChatMuse authentication: scoped API keys (one per chatter), issued via CLI, revocable
- Page-scoped access control: chatters see only their assigned page; team leads see their assigned pages; owner sees everything
- Fan data endpoints respecting visibility rules — chatters get their page's fan data plus total platform spending; team leads get cross-page view; owner gets full agency view
- Revenue endpoints: by model, by page, by period (today / 7d / 30d / custom / all-time), by transaction type, with period-over-period comparison
- Subscriber and follower endpoints with filtering
- Fan profile endpoints: spending, subscription status, notes, summaries, flags
- All business periods computed in Moscow time
- Audit trail for sensitive actions: logins, key issuance/revocation, page assignment changes

**Depends on:** Phase 1

**Milestone:** Make an authenticated API call and receive revenue data matching the CLI. Make a call with a chatter's API key and confirm it returns data only for the assigned page.

---

## Phase 3: Dashboard

The agency opens a browser and sees live revenue, subscribers, fans, and trends across all pages and models.

**Features:**
- Agency-wide overview on the main screen: total revenue, page-by-page breakdown, model-by-model summary
- Revenue display: today, 7 days, 30 days, all-time, custom date range
- Revenue breakdown by transaction type (subscriptions, tips, messages, posts, streams, chargebacks, refunds)
- Period comparison: growth or decline vs. the previous equivalent period
- Drill-down flow: agency overview → model → page → individual transactions
- Transaction list with type filters; pending and chargeback status indicators
- Active subscriber count, list with usernames, expiry dates, and renew on/off status
- New subscribers in the last 24 hours highlighted
- Expiring subscriptions list: subs expiring in 1, 3, or 7 days — retention priority view for team leads
- Free follower count per page
- Daily inflow: new followers and subscribers by day; growth and decline trends
- Follower and subscriber growth chart over time
- Full fan profiles: per-page spending, total platform spending, subscription status, follower status, notes, AI summaries with version history, flags (whale, VIP, risky)
- Fan search, whale list, top spenders across the agency
- Cross-page fan view for team leads; cross-model view for owner
- View and create fan notes from the dashboard
- Last sync time and sync status per page
- API key management for ChatMuse (create, view, revoke keys for chatters)
- Login screen
- Desktop-only layout

**Depends on:** Phase 2

**Milestone:** Open the dashboard, see today's revenue by page matching the platform. Drill into a model, see transactions. Open a fan profile, see spending and notes.

---

## Phase 4: OnlyFans Connect

The agency connects OnlyFans pages via OnlyMonster and sees unified data across both platforms.

**Features:**
- OnlyMonster platform adapter for OnlyFans pages
- Sync transactions: tips, subscriptions, message payments, post purchases, live stream revenue
- Sync chargebacks separately
- Map OnlyMonster transaction types into the same unified taxonomy defined in Phase 1
- Sync chatter performance metrics from OnlyMonster: messages sent, chat sales, reply time averages, work time, break time
- Create fan records from OnlyFans transactions; compute fan spending from synced data
- CLI verification: see combined revenue across Fansly + OnlyFans for a single model

**Depends on:** Phase 1 (does not block any other phase)

**Milestone:** Run a CLI command and see total revenue for a model across both Fansly and OnlyFans pages, with transactions classified under the same types.

---

## Phase 5: Telegram Notifications

The owner receives a daily revenue summary and immediate alerts for sync and connection problems.

**Features:**
- Daily revenue report by page, sent to a configurable Telegram chat
- Revenue anomaly alerts: significant drops compared to recent trends
- Sync failure alerts: expired platform tokens, proxy failures, partial sync errors
- Token and proxy health checks: periodic verification that all page connections are alive; failures become alerts
- Incident pattern: recurring failures produce one open alert (not repeated spam), resolved when the issue clears
- Alerts also visible in the dashboard
- Owner-only; configurable chat ID

**Depends on:** Phase 2

**Milestone:** Invalidate a Fansly token. Within minutes, receive a Telegram alert about the dead connection and see the same alert in the dashboard.

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

**Features:**
- AI proxy with streaming responses — the extension sends requests through the hub, not directly to the AI provider
- Fan context injection: when a chatter opens a DM, the extension receives spending (page + total), notes, AI summary, subscription status, and flags in one panel
- Fan notes via the extension: chatters create and read notes; notes from one chatter are visible to others on the same page
- AI-generated fan summaries from chat history; version history preserved (new summaries append, never overwrite)
- Rate limiting: each chatter has a configurable request quota
- Cost tracking: every AI request logged with chatter, page, token count, and dollar cost
- Prompt caching: identical prompts return cached responses to reduce cost
- Model personality management: update a model's voice/persona in one place, applied to all chatters on that page

**Depends on:** Phase 2 + Phase 3

**Milestone:** A chatter opens a Fansly DM in the extension, sees the fan's spending and notes. Uses AI-assisted reply with streamed output. The owner sees the chatter's request count and cost in the dashboard.

---

## Phase 8: Team Management

The agency manages staff, page assignments, and work schedules in one place.

**Features:**
- Staff profiles: chatters, content managers, team leads
- Assign staff to specific pages
- Schedule table: who works when, which days, what hours, days off
- Chatter performance metrics display (OnlyMonster data collected in Phase 4)
- Dashboard access management for team leads

**Depends on:** Phase 2

**Milestone:** Add a chatter, assign them to two pages, set their weekly schedule. See their OnlyMonster performance metrics on the dashboard.

---

## Phase 9: Chatter Payroll

The agency tracks chatter earnings, calculates payouts as a percentage of chat sales, and sees who is owed what.

**Features:**
- Chatter shift reports: chatters submit what they sold
- Revenue calculated as percentage of chat sales
- Payout calculation: how much is owed to each chatter and for what
- Payout overview table for optimizing payments
- Manual revenue entry for Fansly chatters (no automated chatter-level sales data on Fansly)

**Depends on:** Phase 8

**Milestone:** A chatter submits a shift report. The owner opens the payout table and sees the calculated amount owed based on the configured percentage.

---

## Phase 10: Internal TODO

A simple task manager for agency operations — not code tasks, but business and team tasks.

**Features:**
- Create tasks for agency operations
- Assign tasks to staff members
- Statuses and priorities

**Depends on:** Phase 8

**Milestone:** Create a task, assign it to a team lead, mark it complete. See the task history.

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
