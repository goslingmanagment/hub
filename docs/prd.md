# Agency Hub — Vision

---

## What is this

The agency's core. A hub where different modules and applications plug in. A single place to see everything: revenue, models, team, fans. Other tools will be built on top of this core (ChatMuse, analytics, etc.).

---

## 1. Models and Pages

- See all models in the system
- Each model can have multiple pages on different platforms (Fansly, OnlyFans)
- Add a model → attach pages to it
- All pages connect into the hub
- Fansly — via custom SDK (API is fully reverse-engineered, request examples available)
- OnlyFans — via OnlyMonster API
- Want to see all platforms in one place
- May need a proxy — making requests to all pages from one IP is suspicious
- Fansly tokens expire — need an alert to admin in the panel + duplicate to Telegram when a token dies
- Any sync error (OF auth lost, proxy down, API 500, partial sync) → alert in panel + Telegram

---

## 2. Revenue and Transactions

- Go into a model → see how much it earned: today, 7 days, 30 days, custom date, all-time
- See revenue **per page separately** and **total per model** (e.g. Lora: 3 Fansly + 2 OnlyFans — see each page and the grand total)
- Drill deeper when needed — what today's earnings consist of
- **Breakdown by transaction type**: unified classification across platforms (tip, subscription, message, post purchase, stream, chargeback, refund, etc. — exact mapping decided by engineers)
- See all transactions on each account, filter by type
- Period comparison — see growth or decline vs previous period
- **Revenue = net** (after platform commission). Revenue, adjustments (chargebacks/refunds), and unclassified shown as separate metrics. Net earnings = revenue + adjustments + unclassified (reconciliation total). See Decision #46 for classification details
- **Timezone**: UTC in database; business reporting aligns to UTC business dates
- Data updates automatically:
  - Light requests (recent transactions) — every hour
  - Heavy requests (followers, full parse) — every 12 hours

---

## 3. Subscribers and Followers

- Count of **active subscribers** (active = subscription not expired), their list, expiry date, usernames
- See **renew on/off** for each subscriber
- **New subscriber** = appeared in the last 24 hours
- Count of **free followers** on the account
- **Daily inflow**: how many new followers and subscribers were added — where it grew, where it dropped
- Follower and subscriber growth by day (dynamics)
- Collect followers themselves into the database — will be needed later for applications built on top of the API
- Parse followers carefully: ~5 sec pauses between requests, can be 5-15k per page. Full parse once, then only add new ones
- **Expiring subs**: list of subscribers with expiring subscriptions (1-3-7 days) — retention priority, team leads pass to chatters (future: via ChatMuse)

---

## 4. Fans

**Product note (2026-03-10):** Keep `fan` as a backend/API/CRM entity, but do not treat a standalone dashboard `Fans` section as mandatory in v1. Default dashboard navigation should prioritize revenue, transactions, subscribers, followers, and expiring subscriptions. A top-level `Fans` screen should appear only if it delivers distinct CRM value such as top spenders, notes/flags workflow, or cross-page fan context.

### Identification
- **Fan = one entity per platform** (by platform user ID — Fansly user ID / OF user ID)
- Fan ID = platform user ID (not internal UUID) — so ChatMuse can match a fan from DM directly
- Fansly and OnlyFans fans are not linked to each other — only within a platform

### Per-page data (fan + page)
- Fan's spending on this specific page
- Subscription status, renew on/off, expiry date
- Follower status
- **Notes** — multiple, from different chatters (observations, promises, remarks, etc.)
- **Summary** — a special type of note, AI-generated from chat history. Version history is kept (new summary doesn't overwrite the old one, it's appended). Latest is shown, but previous versions are accessible
- One chatter creates a note/summary → another chatter on the same page sees it

### Platform-level data (aggregate)
- Total fan spending across all pages on the platform
- Which pages they're subscribed to / following
- Flags: whale, VIP, risky, etc.

### Who sees what
- **Chatter** (via ChatMuse): fan data only for their page + total platform spending. Cannot see notes from other models
- **Team Lead** (dashboard): cross-page view for their assigned pages, fan search, expiring subs, whale list
- **Owner** (dashboard): everything + cross-model view, top spenders across the entire agency

### ChatMuse badge (future)
- Chatter opens a DM → extension calls Hub API with fan platform ID → receives: spending (page + total), notes, summary, subscription, flags — all in one panel

### Future
- Fan segmentation (whale, regular, tipper, lurker, new fan, etc.)

---

## 5. Dashboard (UI)

- React, custom dashboard — clean, well-designed, convenient
- **Primary scenario**: open daily → immediately see which page earned how much
- Revenue: today, 7d, 30d, all-time, custom
- By pages and by models
- Breakdown by transaction type
- Active subscribers: count, list, expiry date
- Follower growth by day
- Last sync time, status
- Agency-wide overview on the main screen
- Drill-down: overview → model → page → specific transactions
- Do not add a standalone `Fans` nav item by default. Keep fan-facing UI behind concrete CRM workflows only: top spenders, recent buyers, notes/flags, cross-page fan context

---

## 6. ChatMuse

Firefox extension. AI assistant for chatters on Fansly. Working MVP already exists (`/code/chatmuse/`).

**What exists:** Fast Reply, Help Me (coaching), Fan Summary, Chat Review (chatter performance rating), Ping (fan reactivation).

**What it needs from Hub:**
- Extension communicates through Hub API (Hub → Claude) — not directly to Claude. This gives native limit control and tracking
- Store fan summaries and notes in the backend — so all chatters can see each other's work
- Store fan data and profiles in our database per model
- Track how many requests each chatter made, how much it cost in money, how many tokens were spent
- Assign chatters a limit (N requests in the extension)
- Cache identical prompts to AI
- Future: update model personalities in one place for all chatters at once (from ChatMuse TODO)

**Priority:** after OnlyFans Connect, Telegram, and Backups are in place. Must be planned ahead because the ChatMuse backend and main hub share the same server.

---

## 7. Team and Staff

- Add staff members: chatter, content manager, team lead
- **Staff assigned to pages**: chatters, team leads, and CMs are attached to specific pages
- Chatter schedule — simple table: who works when, which days, what hours, days off
- Chatter revenue tracking: they submit reports after shifts — who sold how much
- Revenue calculated as % of chat sales
- **Payout calculation** — not just tracking, but seeing how much is owed to whom and for what
- Convenient table to see everything and optimize payouts
- Dashboard access: owner and team leads (simple password, issued manually)
- Dashboard: desktop only
- OnlyMonster API already provides chatter metrics (messages, sales, reply time, work time) — can be automated for OF pages
- For Fansly — chatters enter manually, that's fine

---

## 8. Analytics (future)

- Enhanced dashboards: trends, charts
- **PnL per model** — revenue minus all expenses (traffic, chatter payouts, CM, etc.)
- **Traffic spend tracking**: add traffic channels (Reddit, FYP, OnlyGuider, Twitter, YouTube), track how many came through, how much was spent on ads/traffic, what ROI
- Fan metrics and analytics
- **Fan LTV** — formula to be determined later
- Expense tracking across all areas
- Future: content operations for CMs (posting calendar, content status per page)

---

## 9. Telegram Notifications

- Daily report: revenue by page
- Alerts: revenue drops, anomalies
- Sync issues: dead tokens, proxy failures, partial sync errors

---

## 10. Internal TODO

- Custom task manager inside the hub
- Agency operations tasks (not code)
- Assign to staff, statuses, priorities

---

## Roadmap

Phases are sequential where noted; parallel execution where no dependency exists.

1. **Fansly Connect** — schema, platform adapter, transaction sync (hourly), follower sync (12h delta), CLI for manual ops
2. **API + Auth** — Fastify server, dashboard auth (cookie sessions), ChatMuse auth (API keys), data endpoints *(depends on 1)*
3. **OnlyFans Connect** — OnlyMonster adapter, chatter metrics sync, unified transaction taxonomy *(depends on 2)*
4. **Dashboard** — React SPA: revenue overview, per-model/per-page drill-down, subscribers/followers, expiring subs. Fan profiles are optional and should ship only together with a clear CRM workflow, not as a default top-level section *(depends on 2 + 3; ships with both platforms from day one)*
5. **Telegram Notifications** — daily revenue report, alerts (dead tokens, sync failures), incident pattern *(depends on 2)*
6. **Backups + Ops** — nightly pg_dump off-VPS, health checks, sync monitoring *(before production deploy)*
7. **ChatMuse Backend** — AI proxy with SSE streaming, fan context injection, rate limiting, cost ledger, prompt management *(depends on 2+3)*
8. **Team Management** — staff profiles, page assignments, schedule table
9. **Chatter Payroll** — % of chat sales, payout calculation, reporting
10. **Internal TODO** — task manager for agency ops, assign to staff, statuses
11. **Advanced Analytics** — PnL per model, traffic ROI, fan LTV, content ops for CMs
