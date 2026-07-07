# Workboard app — design-pass session (Stage 34)

> **DEPRECATED (decision #117, 2026-07-07, owner).** Do not run this session
> — the workboard direction is closed. Kept as a tombstone.

Run this in a FRESH session opened in `~/code/core`. You are designing the
standalone workboard application — the chatter's revenue tool: log in, see
your assigned pages, see who to message now and why. This is the design pass
the owner deferred at DP 4b/4c; those decisions are now MADE (below). Your
deliverable is a PRD the owner reviews — **STOP after the PRD; do not build
until the owner approves it.** After approval this session (or a successor)
scaffolds the new repo skeleton.

## Non-negotiable process

1. Read this file, then `docs/project-kernel/pass3/stages/stage-34-workboard-application.md`
   (the kernel-ready inventory + constraints — re-check named specs, do not
   re-derive), then the current board reality: `docs/generated/14-workboard.md`
   (core map), `docs/workboard-v2-priority-design.md` (the engine's design
   rationale), `apps/runtime/src/modules/workboard/` (the live module).
2. Write the PRD into `docs/project-kernel/workboard/prd.md` (skeleton exists —
   fill it, keep its section shape). Every open question you cannot decide from
   ground truth goes to the owner as a SHORT structured question, not prose.
3. STOP. Owner reviews the PRD. Only then: repo skeleton
   (`~/code/workboard`), meeting the family standard from day one (see
   Constraints).

## Decisions in force (owner, 2026-07-07 — do not reopen)

- **DP 4a = B:** own repository (`~/code/workboard`), standalone web app.
- **v1 is Fansly-only.** The kernel module is platform-neutral; OnlyFans comes
  later for cheap. Decide in the PRD what (if anything) v1 SHOWS about OF pages
  (probably nothing).
- **DP 4b = kernel sessions.** Username/password login against the kernel
  (Stage 22 machinery: argon2id, must_change_password, backoff, session
  cookie). No IdP, no device tokens for the browser app.
- **DP 4c = per-page grants.** "My pages" = the chatter's `assignedPageIds`
  (the existing enforcement shape; every module route is already page-scoped
  by the auth middleware). Claim leases remain the fan-level coordination
  primitive on top — NOT access control.
- **Hosting: same VPS, subdomain** `workboard.gosling-agency.ru`.

## Known technical question you must resolve IN the PRD (with a recommendation)

The kernel session cookie is issued for the kernel's origin. Two clean ways to
make it work on the subdomain — pick one and justify:
(a) **Reverse-proxy pattern (likely winner):** nginx on
`workboard.gosling-agency.ru` serves the SPA and proxies `/api/*` to the
kernel — the cookie stays first-party on the workboard origin, ZERO kernel
changes, login happens through the proxied path.
(b) Parent-domain cookie (`Domain=.gosling-agency.ru`) — requires a small
kernel cookie-options change → written proposal per the app-agnostic rule.

## Product ground truth (verified 2026-07-07)

- **The board engine is LIVE in the kernel** (Stage 23): tabs
  subscribers/spenders/fresh_mass/old_mass/service; per-fan value/urgency/
  quality scores + rank; event-driven recompute in seconds (debounced per-fan
  jobs; nightly reconciler); claim leases (soft, TTL, non-blocking); contact
  log with `acted_by_user_id`; undo = compensating `contact.retracted` event;
  L1/L2 closing classifier (Haiku, flag-gated). The app RENDERS the kernel
  board; it does not re-derive priorities. App needs that require module
  changes go through a written proposal.
- **Live updates:** SSE stream v2 (`/api/v1/events/v2/stream`) carries
  `workboard.state_changed` frames (pageId, fanId, tab transition) + the raw
  `message.*`/`transaction.posted`/`presence.*` vocabulary. Decide in the PRD:
  frames-only (simple) vs frames+raw (richer attention model).
- **Fansly revenue context is server-side** (Stage 16): `fan_earnings_stats`
  per-fan lifetime/monthly — the board's money numbers don't depend on who is
  browsing.
- **THE V3 LESSON (owner, 2026-06-10; the previous workboard app was built
  and deleted over this):** a board shown on top of an undug needs-reply
  backlog is useless — chatters drown. The PRD must design for the backlog
  reality FIRST (what does the chatter see when 300 fans "need reply"? what
  is the dig-out flow?) before any fancy prioritization UI.
- **Access/UX seed:** chatters are deliberately blocked from the dashboard;
  the workboard is their ONLY web surface. Login UX must include the
  must_change_password flow (kernel primitive exists, UX does not).

## Constraints inherited (may not silently reopen)

- Kernel module API stays app-agnostic; SDK-visible contracts only (no
  private surfaces). SDK = `@kernel/sdk` pinned by git-tag + contract-hash
  drift gate — adopt from day one.
- Single-tenant (DP 9-A). No org dimension.
- Family standard from day one (Stage 35 obligation): CLAUDE.md (desktop's
  shape), AGENTS.md pointer, `docs/decisions.md` with the family law, CI
  floor (typecheck+lint+unit+build on PR), pinned SDK + drift gate.
- Expectation: **no kernel schema changes** — the app is a client. Any schema
  need = kernel proposal routed through the owner.

## Owner questions to settle during PRD review (prepare them as structured asks)

1. v1 board UX: table-first (like the dashboard tab today) or card/queue-first
   ("next fan" flow)? What does DONE look like for a shift?
2. Notification/attention model: what changes must a chatter SEE in real time
   (new message on claimed fan? tab transitions? tips)? Sound/badge posture?
3. Mobile: real requirement for v1 or desktop-browser-only?
4. Invite/reset UX: admin sets passwords in the dashboard — is that enough for
   v1, or does the workboard need self-serve reset?
5. Stack: default is the family idiom (React+Vite+TS strict+`@kernel/sdk`,
   same-origin nginx). Confirm or redirect.

## Repo mechanics

- PRD lives in core: `docs/project-kernel/workboard/prd.md` (docs/ is
  gitignored — commit with `git add -f`). The new repo is created only after
  PRD approval.
- Never `git add -A` in core; commit only your own files by explicit path.
- Record design decisions in the PRD itself; once the repo exists, its
  `docs/decisions.md` starts with W1 = the PRD acceptance.
