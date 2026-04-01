# Implement Workboard

Read `prompts/workboard-spec.md` first — it has the full product spec with all decisions, UI wireframes, data model, and API design.

## What

Replace the CRM page (Retention + Reactivation tabs that nobody uses) with a Workboard — a work queue that shows which fans need to be contacted, split into three tabs:

1. **Subscribers** — active subscribers with unhandled touchpoints. Touchpoint system already exists in `retentionBaseQuery` in `packages/db/src/repositories/crm.ts` — reuse it.
2. **Active spenders** — LTV >= $100, no active sub, last spend within 30 days, no contact in 7+ days.
3. **All spenders** — every spender from `$0.10+` creator net on the page, including fans with an active subscription; rows may be active/inactive by spend recency and may or may not currently be overdue.

Fan cards with key info (name, LTV, last fan/model message timestamps, last spend, sub status, overdue days). Click card → expand inline chat preview (last 25 messages). Snooze buttons (7/14/30 days) on each card. Cards tinted yellow/red by overdue severity.

New `workboard_snoozes` table for snooze/unsnooze. Collapsible snoozed section at bottom.

## Codebase

Study these files for patterns — follow the same conventions:

- `packages/db/src/repositories/crm.ts` — SQL queries, CTE patterns, data normalization
- `apps/runtime/src/services/crm.ts` — service layer
- `apps/runtime/src/api/server.ts` — route registration
- `packages/contracts/src/routes.ts` — Zod schemas and response types
- `apps/dashboard/src/api/queries.ts` — React Query hooks
- `apps/dashboard/src/pages/CrmPage.tsx` — page you're replacing
- `apps/dashboard/src/components/page/crm/ChatPreviewPanel.tsx` — reuse for card expansion
- `apps/dashboard/src/components/page/crm/TouchpointBadge.tsx` — reuse for subscriber cards

## Rules

- Fansly pages only (same `isFanslyPage` gate as current CRM)
- No pagination, no filters, no search — it's a work queue, not a dashboard
- "Contact" = `MAX(last_fan_message_at, last_model_message_at)`
- Active subscribers excluded from spender tabs
- LTV < $100 without active subscription = not shown
- Don't delete old CRM code — add workboard alongside it
- Three separate queries are fine, don't force a UNION
