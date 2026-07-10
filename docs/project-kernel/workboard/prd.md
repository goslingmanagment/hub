# Workboard — PRD (v1, Fansly-only)

> **MOVED (2026-07-08, same day as #119).** The live skeleton is
> `~/code/workboard/docs/prd.md` — the design session fills THAT copy. This
> one is frozen history (kept per the anti-deletion rule).

> STATUS: SKELETON — the design session fills this; the owner reviews before
> any code. Decided inputs (do not reopen): kernel-session login, per-page
> grants, workboard.gosling-agency.ru on the agency VPS, own repo
> ~/code/workboard, v1 Fansly-only, kernel board is the single source of
> priorities.

## 1. Audience & jobs
<!-- Who: chatters (per-page grants), team leads?, owner? One job per row:
     "start shift → know who to message now → message → mark/undo → next".
     THE V3 LESSON lives here: design the 300-fans-need-reply dig-out flow
     FIRST. -->

## 2. v1 scope
<!-- In / out table. Fansly-only boundary: what OF pages show as (nothing?).
     Claim leases, contact+undo, closing hints (L2) — in? Spender detail? -->

## 3. Board UX
<!-- Table-first vs queue-first (owner Q1). Tabs from the kernel engine
     (subscribers/spenders/fresh_mass/old_mass/service) — rendered how?
     What DONE looks like for a shift. -->

## 4. Liveness & attention model
<!-- stream v2: workboard.state_changed frames only vs +raw events (owner
     Q2). Reconnect/cursor/409-snapshot handling via @kernel/sdk helpers.
     Notifications: what interrupts a chatter, sound/badge posture. -->

## 5. Auth & session UX
<!-- Kernel sessions: login page, must_change_password flow, logout,
     session expiry UX. Cookie mechanics: reverse-proxy /api on the
     workboard origin (recommended) vs parent-domain cookie (kernel
     proposal). Invite/reset (owner Q4). -->

## 6. IA & surfaces
<!-- Pages: login, board (per assigned page or merged?), fan drawer/detail,
     shift summary? settings-lite? Chatters have NO dashboard access —
     everything they need lives here. -->

## 7. Tech shape
<!-- Stack (owner Q5, default React+Vite+TS+@kernel/sdk), nginx serving +
     /api proxy, deploy script (same VPS), CI floor, SDK pin + drift gate,
     family docs standard from day one. NO kernel schema changes expected. -->

## 8. Build stages & exit criteria
<!-- Staged: skeleton+auth → read-only board → claim/contact/undo → live
     frames → polish. Each stage's DONE = a chatter-visible capability.
     Pilot = one real chatter shift; the v3 lesson is the acceptance bar. -->

## 9. Non-goals (v1)
<!-- OnlyFans board, per-model grants UI, analytics/reports (dashboard's
     job), AI features in the workboard, mobile app (browser posture per
     owner Q3), multi-tenant anything. -->

## Open questions for the owner
<!-- Keep the running list here as short structured asks. Seeded: Q1 board
     UX shape, Q2 attention model, Q3 mobile, Q4 invite/reset, Q5 stack. -->
