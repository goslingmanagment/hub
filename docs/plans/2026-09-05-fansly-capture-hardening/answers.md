# Owner answers (phase 2) — full set, sent identically to every planner

Answered 2026-09-06 by the owner (translated from Russian by the orchestrator). Statements
are the owner's own recollection unless marked "orchestrator-verified". Numbering follows
the consolidated question list; several planners asked overlapping questions, so read all
of it.

## 1. How the session bundle reaches the kernel; what it carries on prod

Manual. The owner opened Fansly in his own browser, took the values from the Network tab
and pasted them into the dashboard form. Owner's words: "we pasted only ONE token; the
rest were not even entered." Read that literally: the production bundles most likely carry
only the `authorization` token — no `fansly-client-id`, no `fansly-session-id`, no
`fansly-client-check` (scalar or per-route). No `--session-file` import was done, and
nothing was re-pasted after 2026-08-23 as far as the owner recalls. Treat "what the kernel
actually sends today" as: Firefox-like static headers from the HAR + `authorization` +
a fresh `fansly-client-ts`, nothing else — and plan a verification step if your plan
depends on it (request headers are not journaled; the dashboard form and
`page_credentials` are the only places that would show it, and neither is readable by
the read-only role).

## 2. Whose browser, and is it alive

The owner's own browser on the owner's machine. It is still open and logged in; the same
session is still used interactively by the owner. So the token (and whatever device
identity that browser has) is alive in two places: the owner's browser and the kernel's
replay through the page proxy. The owner does not know what caused the two 401s in the
last 14 days ("no idea what problems there are right now, honestly"); no incident record
exists beyond what the journal shows (`*:failed` observations carry the response snippet).

## 3. Proxies

Every Fansly page has its own dedicated proxy: residential, United States. Provider,
city, rotation policy, protocol and exclusivity are not documented; the owner did not
elaborate. Nothing in the kernel records the proxy type (backlog FANSLY-007).

## 4. Chatter workstations

Chatters do NOT log in with the model's credentials. They join through Fansly's manager
link (the account-manager / agency access feature), i.e. each chatter has their own Fansly
account with manager access to the model's account — their own sessions, their own
device identity. Owner: "there is no danger there, they have their own sessions." The
owner gives the chatters the same IP as the page: chatters work from home in Firefox (with
the extension) routed through the page's proxy. Concurrency: several chatters per page is
normal; the owner did not give a peak number (assume 1–3 per page). Whether the model
herself logs in (mobile app) was not answered.

Implication for the diagnosis: the kernel's replay is the ONLY thing reusing the OWNER's
own session; chatter sessions are separate identities that happen to share the page's
exit IP. Verify against the extension's session capture (`src/background/session-capture.ts`)
what the extension captures from a manager session versus the model's own session.

## 5. Signals from Fansly so far

None. No bans, restrictions, suspicious-login emails, forced logouts, captchas or shadow
limits observed on any page, before or after kernel capture began. The concern is
preventive: "they fight bots and sooner or later may punish." 2FA status on the model
accounts was not answered; the owner controls the e-mail and the authenticator for every
account (see 7).

## 6. Freshness of the kernel's copy — DECIDED

Owner's decision: relaxing the kernel's Fansly DM sweep (`dm_conversations`) from 30 min
to **2–4 hours is acceptable**, and a workboard "needs reply" lag of the same size is
acceptable. Overnight pause: not decided — the owner did not say whether there is a night
shift; treat an overnight slowdown/pause as an OPTION to propose with its trade-off, not a
requirement. The kernel must keep collecting and backfilling on its own (chatter browsers
closed or not); archival lanes may be slowed during a migration.

Orchestrator-verified findings (code research, 2026-09-06) you may rely on:

- Nothing chatter-facing depends on the kernel's DM copy. Every AI feature for Fansly
  (fast reply, improve draft, help, ping, fan summary, coach, voice script) takes the
  transcript, spend, subscription, bio and ping segment from `clientContext` supplied by the
  extension, which reads the live Fansly tab (`apps/runtime/src/modules/ai/features/index.ts:345-386`,
  `packages/contracts/src/routes.ts:2164-2170`, fansly-ext `src/background/kernel-feature-gateway.ts:445-461`).
- The extension calls the kernel only for: AI generations (SSE), voice notes, recap status,
  the top-spenders board (fan_earnings projection, daily), fan dossier get-by-conversation /
  push, the AI persona catalog, AI usage batches, and service calls (page resolution,
  health, identity, device tokens) — see fansly-ext `src/background/agency-hub-client.ts`.
  The dossier lookup keys on `page_dm_conversations` rows created by the sweep and the push
  404s for a fan the sync has never seen (`apps/runtime/src/services/fan-profiles.ts:107-146`);
  with hour-scale cadence that only means "a brand-new conversation has no dossier for a
  few hours".
- Telegram sends only the daily money report and incident latches; no "fan wrote / needs
  reply" alerts (`apps/runtime/src/services/notification-incidents.ts:80-118`). The Agent
  Read Plane promises no freshness; hydration is an on-demand targeted backfill.
- Workboard v2 in the dashboard reads `page_dm_threads` / `page_dm_messages`; its own design
  treats the DM sync as lagging and uses the dashboard contact log as the authoritative
  touch signal (`docs/workboard-v2-priority-design.md:376-386`). Lag = degradation, not
  breakage.
- Notifications forward-poll pages from the head until overlap (up to 20 × 50 ≈ 33 days),
  so pausing for hours loses nothing (`apps/runtime/src/services/sync/fansly-notifications.ts:740-803`).
- Bodies of new messages are fetched by the same sweep when a conversation head moves
  (`executor-handlers.ts:3583-3590`); the 24 h `dm_messages` lane is backfill only.
- `/group/:id` fires only when the list lacks or contradicts the partner id
  (`executor-handlers.ts:3113-3118`); the partner id feeds `fan_id`, which the workboard
  and the dossier lookup join on — it cannot be dropped wholesale.
- Cadences are constants in `packages/db/src/repositories/page-sync.ts:176-455`
  (`SYNC_STREAM_POLICY`: dm_conversations 1800 s, freshness SLA 3600 s; domain
  `messages_live` SLA 3600 s at `:469-473`); no config key changes them; no quiet-hours
  mechanism exists (`services/sync/planner.ts`); only a manual `pauseSyncBlock`
  (`services/sync-blocks.ts:453`).
- HARD COUPLING: `/api/v1/health/sync` and the deploy gate compare `succeeded_at` age
  against `freshnessSlaSeconds` (`apps/runtime/src/services/sync-status.ts:1029-1039`,
  `services/health.ts:257, 297-299, 355-376`, `scripts/deploy-production.sh:1000, 1586`;
  tests pin 1800 in `tests/api.integration.test.ts:663, 1267, 9645-9655`). Any cadence
  change must move the SLA constants, the health semantics and the tests together, or
  pages go `degraded` → 503 → deploy fails.
- `docs/decisions.md` records no freshness SLA for the Fansly copy; DP 1-B says the
  cadence IS the budget; the fast-reply-freshness wave is OnlyFans-only.

## 7. Appetite for a browser-based transport on hub infrastructure

(a) Cost: yes, a larger VPS or a second host is affordable ("we can carry that").
(b) Entering the model's password on hub infrastructure: yes, if it is technically safe.
(c) Remote screen (noVNC-style) for login/2FA/challenges: "I don't know what's right —
probably yes."
(d) Anti-detect / cloud browsers (GoLogin, Multilogin class): "probably yes, but I don't
know how one would do it through them" — not excluded on principle (unlike OFAPI for
Fansly, which is excluded as a dependency). If you recommend one, explain the operating
model concretely.
(e) Storing an encrypted password for re-authentication: "in principle, probably yes."
(f) E-mail and authenticator for the accounts are with the owner; he will restore a session
when needed, on his own schedule (not tied to chatter shifts).

## 8. Chatter-side scope

(A): chatters keep working in their own Fansly tabs with the extension. Do not plan
toward (B) "chatters through a hub-owned client" — plan for (A) indefinitely. Requirement:
several simultaneous chatter sessions per page (their own manager accounts) plus the
owner's own session must keep working.

## 9. Scale, horizon, cost

Pages: 5–8 Fansly pages, "no more" (six today: lora-1/2/3, lilly-1/2, ari-1; OF pages are
out of scope). No deadline was given — read that as: safety over speed, but stages that
ship value early are preferred. Cost per page was not quantified; see 7(a).

## 10. Canary and experiments

No page is off-limits ("for now, probably none are dangerous"). A low-value page (ari-1,
~450 calls/day) may be the canary for pausing replay, switching transports and a small
number of owner-run read-only probe calls. Every such probe must be owner-gated and
proposed as a step in the plan, not executed by planners.

## 11. HAR access

Read the HARs directly (read-only, local). Paths:
- `/Users/dmitriy/code/goose/hub/artifacts/fansly-network-capture-2026-08-19/fansly-session-2026-08-19.har` (31 MB, the session capture the header set was copied from)
- `/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/fansly-app-bundle-2026-08-20.har` (5.7 MB, the web app bundle — useful for `fansly-client-check` derivation and WebSocket usage)
- `/Users/dmitriy/code/goose/hub/artifacts/fansly-payouts-capture-2026-08-20/fansly-payouts-2026-08-20.har` (6.4 MB)
- `/Users/dmitriy/code/goose/hub/artifacts/fansly-ui-walk-2026-08-21/fansly-ui-walk-2026-08-21.har` (58 MB), `-pre-rewalk.har` (44 MB), `-control.har` (20 KB)
- Older, from a different tool: `/Users/dmitriy/tools/fansly_api_sdk/fansly_api_doc/fansly_full.har`, `profile_data.har`, `single_media.har`
These files contain LIVE credentials (authorization tokens, cookies, device ids). Read them
with `jq`/grep to extract header names, order, timing, endpoint patterns and WebSocket
frames; NEVER copy a token, cookie, session id, device id or check value into your output
file — describe shapes and lengths only.

## 12. Production configuration snapshot (orchestrator-verified, read-only)

See `reference/prod-facts-2026-09-05.md`: pages, per-stream observation volumes for the
last 7 days, hourly volume for 48 h, and `page_sync_states` (status / succeeded_at /
blockers). Hub image tag `agency_hub_core/runtime:production` (api, worker, scheduler;
Postgres 16); the running commit is not readable without owner-gated access — assume
current `main`. Extension on the update feed: 1.9.11 (equals the local manifest).
`config_settings` and env-level flags (`SYNC_SHARED_RATE_LIMIT_ENABLED`, Fansly delay
overrides, `EGRESS_PACER_MODE`) are NOT readable by the read-only role and the owner does
not know them; assume the defaults in `packages/shared/src/config.ts` unless the code
maps or decisions record a production flip, and include "confirm the effective pacing
config" as a verification step in your plan.
