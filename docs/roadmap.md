# Agency Hub — Product Roadmap

> Updated 2026-09-22 against local source at `ecc864da`.
> This is a product direction and idea list. "Implemented" means a capability
> exists in the source; it is not a fresh production or data-completeness audit.
> Phase numbers are retained so useful ideas from the original roadmap stay findable.

## Status Overview

| Phase | Name | Status | What remains useful |
|-------|------|--------|---------------------|
| 1 | Agency Hub Core | Implemented; collection work continues | Reliable, complete platform data and visible gaps |
| 2 | API + Auth | Implemented | Unified accounts, cookie sessions, device tokens and page-scoped access |
| 3 | OnlyFans Connect | Implemented through OFAPI | Historical coverage, vendor recovery and auditable actions |
| 4 | Dashboard | Implemented; ongoing UX work | Fast navigation from agency totals to a page and fan |
| 4a | CRM | Product idea to revisit | Retention, reactivation and a clear list of whom to contact |
| 4b | DM Sync | Implemented; completeness work continues | Both platforms; freshness and recovery without losing history |
| 4c | Fan Intelligence | Implemented foundation | Spending, notes, summaries and useful segmentation |
| 5 | Telegram Notifications | Implemented | Useful alerts without repeated noise |
| 6 | Ops | Implemented foundation | Runtime health, recovery and storage visibility |
| 7 | Chatter applications + AI | Implemented foundation | Shared context, reply quality and visible AI cost |
| 8 | Team Management | Accounts and assignments implemented; scheduling is an idea | Staff profiles, schedules and explainable performance |
| 9 | Chatter Payroll | Product idea | Shift reports, attribution, payout rules and amounts owed |
| 10 | Internal TODO | Parked outside the current Hub scope | Simple team tasks; do not restore the removed Workboard implicitly |
| 11 | Advanced Analytics | Partial foundation; profitability remains an idea | Model PnL, traffic ROI, expenses and content planning |

## Dependencies and next choices

- Reliable capture and access control support every customer-facing feature.
- Team identities and sales attribution are prerequisites for automatic payroll.
- Model PnL needs expenses and payout accounting; traffic ROI needs acquisition
  attribution and traffic spend. Fan analytics can improve independently of payroll.
- CRM should turn existing audience data into an actionable retention/reactivation
  workflow; the old standalone CRM screen is not present in the current router.
- [Project Browser](plans/project-browser/context.md) holds the current browser
  direction. Its platform/session choices are not settled by this roadmap.
- These are candidates, not a newly approved implementation order. Pick one
  concrete workflow and acceptance criterion before starting a phase.

---

## Phase 1: Agency Hub Core — **Implemented; collection work continues**

The agency can add models and Fansly pages, sync all financial and audience data, and verify correctness from the command line.

**Features:**
- Add models and attach Fansly pages to them
- Per-page proxy configuration (SOCKS5) with exit IP verification
- Encrypt platform tokens and proxy credentials at rest (AES-256, key versioning)
- Transaction collection: tips, subscriptions, message purchases, post purchases, stream tips, chargebacks, refunds
- Checkpointed, idempotent sync pipeline: upsert raw events first, then rebuild derived projections safely on reruns
- Classify every transaction into a unified type taxonomy (same categories used across all platforms)
- Revenue stored as net (after platform commission); chargebacks deducted but tracked separately; pending transactions tracked with status
- Sync active subscribers: usernames, expiry dates, auto-renew status (Fansly)
- Collect free followers: ID, username, follow date — full parse on first run, then delta-only with rate-limited requests
- Follower deactivation tracking with generation-based rollup accuracy
- Fan identity: canonical key is `(platform, platform_user_id)` with no cross-platform linking
- Create fan records from transactions, subscriptions, and follows
- Compute per-page fan spending from synced transactions
- Build daily rollups for revenue, subscriber counts, and follower counts
- Store all timestamps in UTC
- Journal platform facts before parsing; preserve them while rebuilding derived projections
- CLI tools: add model/page, trigger sync, view revenue, verify subscribers, inspect fan spending, sync status watch mode

**Depends on:** None

**Milestone to verify:** Run a CLI command and see today's Fansly revenue per page matching the platform.

---

## Phase 2: API + Auth — **Implemented**

The hub exposes a secure API that the dashboard and chatter applications can consume, with role-based access control.

**Features:**
- Fastify REST API with Zod validation and auto-generated OpenAPI schema
- Postgres-backed cookie sessions for browser users
- Password-issued device tokens for chatter applications; scoped access and revocation
- Role-based access: `owner`, `team_lead`, `chatter`
- Page-scoped visibility: chatters see only assigned pages; team leads see their pages; owner sees everything
- Revenue endpoints: by model, by page, by period (today/7d/30d/all-time/custom), by transaction type, with period-over-period comparison
- Subscriber, follower, fan profile endpoints with filtering
- Fan data endpoints respecting visibility rules
- All business periods computed on UTC business dates
- Audit trail for sensitive actions: account access, device-token issuance/revocation and page assignment changes
- Authentication throttling and feature-specific quotas
- Password hashing with Argon2

**Depends on:** Phase 1

**Milestone to verify:** Make an authenticated API call and receive revenue data. Make a call with a chatter's device token and confirm page-scoped access.

---

## Phase 3: OnlyFans Connect — **Implemented through OFAPI**

The agency connects OnlyFans pages and sees unified data across both platforms.
OnlyMonster is retired; its old limits and performance metrics are not current
Hub capabilities.

**Features:**
- Connect OFAPI accounts to pages, with historical account binding and custody
- Collect transactions, chargebacks, audience, messages and supported content
- Capture webhooks durably, project them and recover missing delivery/history
- Account for vendor credits and make collection policy visible
- Expose supported media, marketing, export and command operations in the dashboard
- Verify combined revenue and per-fan spending across a model's pages

Provider support, captured coverage and a usable screen are separate checks.
See the [OFAPI schema baseline](../reference/onlyfansapi/README.md) and the
operation-specific documents in `docs/runbooks/` before extending an operation.

**Depends on:** Phase 2

**Milestone:** See total revenue for a model across Fansly and OnlyFans, with
consistent transaction classification and visible coverage gaps.

---

## Phase 4: Dashboard — **Implemented; ongoing UX work**

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
- ✅ Team accounts, invitations, page assignments and device revocation
- ✅ Settings for connections, collection, models, pages, team and runtime configuration
- ✅ Login screen
- ✅ Desktop-only layout
- ✅ Dev pages: Logs, Queue, DB Stats, Incidents (owner-only)

**Original UX/debug ideas to recheck before taking into work:**

These historical observations have not been reproduced in this source review.
- 🔴 Unknown User aggregation: deleted Fansly accounts group into one bucket instead of separate entries. Fix: use `platform_user_id` as grouping key.
- 🟡 mikeyt10101 alltime mismatch ($264 vs $256): investigate how Fansly calculates "top supporters"
- 🟡 Default period should be "Today" not "30D"
- 🟡 Followers chart useless on "Today" — needs wider default range
- 🟡 Log/Incident detail view: clickable rows → modal with full message, actionable recommendations per incident type, severity color coding

**Original Phase 4 acceptance item to verify in the current UI:**
- Custom date range picker across the relevant views

**Depends on:** Phase 2 + Phase 3

**Milestone:** Open the dashboard, see today's revenue by page — Fansly and OnlyFans combined. Drill into a model, see transactions from both platforms. Open a fan profile, see spending and notes. **Core routes exist; review the current UI before choosing polish work.**

---

## Phase 4a: CRM Module — **Product idea to revisit**

> The original retention/reactivation idea is retained. The current dashboard
> router has no standalone CRM screen; the old "Done" claim is not current.

The agency's team leads can prioritize fan retention and reactivation from the dashboard.

**Features:**
- CRM summary dashboard: retention rate, churn indicators, engagement touchpoints
- Retention tab: cohort analysis with touchpoint windows (21d/14d/7d/5d/3d/1d before expiry)
- Filters: auto-renew on/off, unread messages, handled status
- Reactivation tab: scoring for inactive fans ready for re-engagement
- Filters: silence threshold, min spend, no DM history, hide deleted, subscriber state
- Chat preview panel: see recent DM conversation inline
- Sortable columns, search, pagination
- Start with the platform whose subscriber and DM coverage supports the workflow; verify coverage explicitly

**Depends on:** Phase 4 + Phase 4b (DM Sync)

**Milestone:** Team lead opens CRM, sees subscribers expiring in 3 days sorted by lifetime spend. Opens chat preview, decides who to message.

---

## Phase 4b: DM Sync — **Implemented; completeness work continues**

> Not in the original roadmap. Required for CRM retention/reactivation features.

The system captures Fansly and OnlyFans messages for fan context, clients and analytics. Complete history and fresh mutable chat state need separate verification.

**Features:**
- Sync DM conversations per page (conversation list with metadata)
- Preserve captured messages and rebuild their projections when needed
- Incremental sync with checkpointing
- Rate-limited to respect platform API limits
- Fansly and OnlyFans use their respective capture and recovery paths

**Depends on:** Phase 1 (sync pipeline)

**Milestone:** Clients and fan profiles can read captured messages with visible coverage and freshness; incomplete history is not presented as complete.

---

## Phase 4c: Fan Intelligence — **Implemented foundation**

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

**Milestone to verify:** Owner opens agency-wide spender view, sees top fans ranked by total spend across all pages with trend indicators.

---

## Phase 5: Telegram Notifications — **Implemented**

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

**Milestone to verify:** Invalidate a Fansly token → receive Telegram alert within minutes. Keep invalid → no spam. Restore → resolved notification sent.

---

## Phase 6: Ops — **Implemented foundation**

The source includes runtime monitoring, recovery and deployment tooling. Recurring
off-server database backups and disaster-recovery restore drills remain outside
the owner-approved product scope.

**Implemented:**
- ✅ Health check endpoints (`/health`, `/health/sync`) for uptime monitoring
- ✅ Sync job monitoring: PgBoss queue with job status, failures, retry state, dead letter queues
- ✅ Separate preservation of business facts from governed observability/operational cleanup
- ✅ Orphaned run recovery on worker restart
- ✅ Connection status verification (active/stale/error/expired/never_synced/unverified)
- ✅ DB stats endpoint for table sizes and row counts

**Explicit non-goals:**
- Recurring off-server database backups
- Disaster-recovery restore drills
- Backup-provider monitoring and alerting

**Depends on:** None

**Milestone to verify:** Runtime health, sync recovery, queue visibility and
storage diagnostics work together.

---

## Phase 7: Chatter applications + AI — **Implemented foundation**

The OnlyFans desktop app and Fansly extension use Hub for shared data, access,
AI features and usage accounting. Hub owns prompts, personas and fan context.

**Features and directions:**
- Page-scoped device-token access and recoverable event/snapshot delivery
- Durable message capture and fan context: spending, notes, summary and history
- Shared fan notes: chatters create and read notes visible to colleagues on the same page
- Command custody with explicit outcomes; no automatic retry of an uncertain send
- Streaming AI replies, draft improvement, fan summaries and related features
- Shared personas and prompt definitions; quotas and per-request cost accounting
- Provider prompt caching where supported; this does not mean reusing an old answer
- Keep reply freshness, usefulness and voice quality visible to the operator
- Preserve the original idea of a fan-context panel alongside the conversation
- Future DM analytics: response-time pairing, PPV unlock funnels and AI-to-send
  correlation, after explicit identity and attribution contracts are established

Current boundaries are in the source, [identity rights matrix](identity-rights-matrix.md)
and [fast-reply freshness specification](fastreply-freshness-build-spec.md).
Client UX acceptance must also be checked in the client repositories.

**Depends on:** Phase 2 + captured fan/message data

**Milestone:** A chatter sees current fan context, receives a useful streamed
reply, and the owner can inspect its usage and cost without client-held AI keys.

---

## Phase 8: Team Management — **Accounts implemented; scheduling is an idea**

The agency manages staff, page assignments, and work schedules in one place.

**Features:**
- Staff profiles: chatters, content managers, team leads
- Assign staff to specific pages
- Schedule table: who works when, which days, what hours, days off
- Chatter performance: sales, replies and working time, with an explicit attribution/source contract
- Dashboard access management for team leads

**Note:** Team accounts, invitations, page assignments and device access already exist. This idea adds schedules, richer staff profiles and performance workflows.

**Depends on:** Phase 4 + Phase 3

**Milestone:** Add a chatter, assign them to two pages, set their weekly schedule. See performance metrics whose attribution can be explained.

---

## Phase 9: Chatter Payroll — **Product idea**

The agency tracks chatter earnings, calculates payouts as a percentage of chat sales, and sees who is owed what.

**Features:**
- Establish attributable chatter sales for each platform; use explicit shift reports where automated attribution is not proven
- Chatter shift reports: chatters submit what they sold for Fansly periods
- Owner configures one payout percentage per chatter; changes apply to future periods only
- Chatter compensation calculated as a percentage of attributable chat sales
- Payout calculation: how much is owed to each chatter and for what
- Payout overview table for optimizing payments
- Manual revenue entry with provenance and corrections where automatic attribution is unavailable

**Depends on:** Phase 3 + Phase 8

**Milestone:** A Fansly chatter submits a shift report and an OnlyFans chatter has sales imported automatically. Owner opens the payout table and sees both amounts calculated.

---

## Phase 10: Internal TODO — **Parked outside current Hub scope**

The original idea is a simple task manager for agency operations: business and team tasks. The in-core Workboard was removed in September. Retaining this idea does not authorize rebuilding it inside Hub; choose the existing external tool or a separate product explicitly.

**Features:**
- Create tasks for agency operations
- Assign tasks to staff members
- Statuses and priorities

**Depends on:** Phase 8

**Milestone:** Create a task, assign it to a team lead, and mark it complete.

---

## Phase 11: Advanced Analytics — **Partial foundation; profitability is an idea**

Fansly content/traffic/revenue analytics, coverage views and fan spending already exist. The larger idea is model profitability, traffic ROI and actionable fan insights.

**Features:**
- PnL per model: revenue minus all expenses (traffic, chatter payouts, content management)
- Traffic spend tracking: add channels (Reddit, Twitter, YouTube, etc.), track acquisition and ad spend, calculate ROI
- Build on existing fan spending/LTV data for retention and value trends
- Fan segmentation: whale, regular, tipper, lurker, new fan (automated rules, not just manual flags)
- Expense tracking across all cost categories
- Enhanced trend charts and dashboards
- Content operations for content managers: posting calendar, content status per page

**Depends on:** Phase 9 for payroll-based PnL; expense and traffic attribution for ROI. Other fan/content analytics can progress independently.

**Milestone:** Open a model's analytics view and see net profit after all tracked expenses. See which traffic channel delivered the highest ROI.

---

## Engineering work and product choices

Use [backlog.md](../backlog.md) for engineering candidates, reproducing an item
before treating its historical status as current. Keep this roadmap focused on
user outcomes and future ideas rather than deploy receipts or a second bug list.

Useful next product conversations are CRM prioritization, staff schedules,
chatter payout attribution, model profitability and the content calendar. Their
order and acceptance criteria still need an owner decision.
