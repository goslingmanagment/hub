# Stage 34 — Workboard application — PLACEHOLDER

> **DEPRECATED (decision #117, 2026-07-07, owner).** The workboard direction
> is closed — do not run the design pass, do not build this stage. The
> "Progress (2026-07-07)" note below (DPs resolved, hosting, repo) is
> historical. The dashboard's Workboard v2 page keeps serving as-is but is
> not a product direction. This file stays as the scope tombstone.

**Repo(s):** new repo (name/home TBD by the owner — DP 4a = B, own repository) ·
**Depends on:** 20 (SDK), 21 (stream v2), 22 (sessions/grants), 23 (workboard module), Q4
(design pass) · **Passport:** roadmap.md §4, stage 34

**Status header.** No deviation. **This file is deliberately a placeholder, not a
specification** — the owner deferred DP 4b (auth mechanism) and DP 4c (access grain) to a
dedicated product-design pass (Q4, answered 2026-07-04: the design pass will produce
implementation documentation for a separate AI session plus a skeleton, then pause; the PRD
will be developed in a dedicated conversation; no date set). Per the recorded decision, Pass 3
must NOT design the app. This placeholder exists so (a) no other stage claims the scope,
(b) the design pass starts from an accurate inventory of what the kernel already provides, and
(c) the boundary between "kernel owes" and "app decides" is written down once.

## 1. Context

The workboard is the revenue-per-chatter-hour tool — the chatter application: log in, see your
assigned models, see who to message now and why. It is the reason the kernel prerequisite
stages (20–23) exist. Owner decisions in force: **DP 4a = B** (own repository, standalone web
application — not an SPA in core, not a desktop view); **v1 scope is Fansly-only** (the kernel
module stays platform-neutral so OnlyFans comes cheap later); **DP 4b and 4c are deferred**.
Single-tenant per DP 9-A.

Entry criterion (the only one): **design-pass output approved by the owner.** There is nothing
to verify in code until then; the kernel prerequisites carry their own exit criteria in their
own specs.

**Deliverable of THIS stage file:** the two lists below — decided-elsewhere inputs the design
pass will find ready, and the questions it must answer. Nothing else.

### What the design pass will find ready (kernel side, delivered by 3b stages)

Each item is verified by its own stage's exit criteria; the design pass should re-check the
named spec rather than re-deriving:

- **Chatter login substrate** (stage-22): every human role is session-capable
  (`roleCanUseSession` opened; password lifecycle with admin-set password +
  `must_change_password`); device tokens (`agency_hub_device_` prefix, human-bound, expiring,
  revocable) beside bearer keys; argon2id + timing-equalized verification + backoff. Kernel
  sessions are the substrate whichever way DP 4b is answered — an IdP choice would map onto
  the same principal model (decision-points.md DP 4b-B note).
- **Access grants** (stage-22): append-only `access_grants` with BOTH `model`- and
  `page`-scope (model-scope expands to present-and-future pages at read time); grant history
  queryable ("who had access to page X in June"); the `assignedPageIds` enforcement shape
  preserved in one middleware (stage-19), so every workboard read/write the app makes is
  grant-scoped without app-side logic.
- **The workboard module** (stage-23): platform-neutral board serving (the Fansly-only read
  gate deleted); event-driven recompute in seconds (debounced per-fan jobs; nightly sweep
  demoted to reconciler); claim leases (soft, TTL'd, non-blocking "I'm working this fan"
  coordination — deliberately NOT access control, which keeps DP 4c open); contact log with
  `acted_by_user_id` attribution; undo as a compensating `contact.retracted` event.
- **Live feed** (stage-21 + 23): SSE stream v2 (`GET /api/v1/events/v2/stream`) with
  per-account ordering, opaque cursor resume, per-account 409-snapshot recovery — carrying
  `workboard.state_changed` frames (pageId, fanId, tab transition) emitted on every
  board-state change, plus the underlying `message.*`/`transaction.posted`/`presence.*`
  vocabulary if the app wants raw events.
- **Typed client** (stage-20): `@kernel/sdk` — typed operations, runtime validation, SSE
  helpers, cookie AND bearer auth modes, retry/error taxonomy; distributed by git-tag installs
  with a contract-hash drift CI gate the new repo adopts on day one.
- **Fansly board data** (stage-16): per-fan lifetime/monthly earnings (`fan_earnings_stats`)
  and PPV purchase events server-side — the v1 (Fansly-first) board's revenue context no
  longer depends on who is browsing.

### What the design pass must decide (the deferred questions)

1. **DP 4b — authentication mechanism.** First-party kernel sessions (username/password,
   the machinery stage-22 ships) vs an external IdP/OIDC. Includes: session storage for a
   browser app on its own origin (cookie domain/CORS vs bearer device tokens), MFA posture,
   credential lifecycle UX (invites, resets — kernel primitives exist, the UX does not).
2. **DP 4c — access grain.** What "assigned" means in the product: model-level grants
   (recommended in Pass 2), page-level, or fan-level ownership — noting the kernel already
   supports model- and page-scope grants and provides claim leases as the fan-level
   *coordination* primitive on top of either.
3. **UX and product scope of v1.** Board interaction design, claim/contact/undo flows,
   Fansly-only v1 boundary (what OnlyFans teaser, if any), notification/attention model
   (what does a chatter see change in real time), mobile posture.
4. **Repository name/home, serving origin, deploy cadence** — DP 4a = B fixes "own repo";
   the design pass names it and its hosting (same VPS? separate origin? TLS/domain).
5. **Whether the app consumes `workboard.state_changed` frames only, or also raw domain
   events** — an API-consumption choice with freshness/complexity trade-offs, not a kernel
   change; the kernel serves both.

### Constraints the design pass inherits (may not silently reopen)

- The kernel module API stays app-agnostic (stage-23 assumption 1) — app needs that require
  module changes go through a written proposal, not silent kernel drift.
- Single-tenant (DP 9-A) is a written invariant; no org dimension.
- The new repo meets the family standard (target §12) **from day one**: CLAUDE.md + AGENTS.md
  pointer, `docs/decisions.md`, CI floor (typecheck + lint + unit + build per PR), pinned
  `@kernel/sdk` + contract-hash drift gate. Stage 35 verifies this if the app exists by then;
  otherwise the standard applies at creation (stage-35 §2 records the obligation).
- Chatters remain blocked from the dashboard (stage-22 §4) — the workboard app is the chatter
  surface; nothing in the app's design changes dashboard route policy.

## 2. Changes

To be written by the design pass. **None specified here** — deliberately (see Status header).

## 3. Schema & data migration

To be decided by the design pass; the expectation from the kernel side is **no schema change**
— the app is a client of module routes, grants, and stream v2. Any schema need it discovers is
a kernel proposal routed through the owner, not an app-side migration.

## 4. Client compatibility

- **Desktop / extension / dashboard:** unaffected — the app is a new, additive client; it
  consumes only contracts that already have production consumers or were built for it
  (module routes, stream v2, SDK).
- **Workboard app:** it *is* the client. Its compatibility obligations start at its own v1.

**Compatibility invariants (target §14):** none touched by the placeholder. The app must not
be given any private/unversioned kernel surface — SDK-visible contracts only, so the
invariants list never grows a special case for it.

## 5. Tests & verification

Per the design pass. The placeholder's own "verification" is organizational: the design-pass
output must exist and be owner-approved before any Stage 34 code session starts (entry
criterion), and the prerequisite stages' exit criteria must be recorded as met in their spec
files (20, 21, 22, 23).

## 6. Rollback

Not applicable to a placeholder. For the eventual app: it is additive (a new client);
retiring it cannot affect kernel data or other clients by construction.

## 7. Assumptions

1. **Q4's answer stands**: design pass → implementation docs + skeleton → pause; PRD developed
   in a dedicated conversation. If the owner instead green-lights direct app development, that
   session still starts from this file's two lists.
2. **Kernel prerequisites delivered as specced** — each has its own exit criteria; the design
   pass re-verifies the four named specs rather than this summary if anything looks off.
3. **DP 4a = B and v1-Fansly-only remain the decisions of record**; a change (e.g. back to an
   SPA in core) reopens DP 4a with the owner, and this placeholder is superseded by a new spec.
4. **DP 3-A stands** (extension maintained indefinitely) — the app does not absorb Fansly chat
   in v1; the DP 3-B long-run question stays open and is the design pass's to raise, not
   assume.

## 8. Task breakdown

1. **(Owner-gated) Run the DP 4 product-design pass** — answers the five questions in §1,
   produces implementation documentation + skeleton per Q4. Done-check: owner approval
   recorded in `docs/decisions.md`.
2. **Replace this placeholder** with the real stage spec(s) derived from the design-pass
   output (supersession note in this file's Status header position, per the anti-deletion
   rule — tombstone/banner, not deletion). Done-check: new spec(s) indexed in
   `stages/README.md`; this file carries the supersession banner.

## Progress (2026-07-07)

The deferred decisions are RESOLVED (owner): **DP 4b = kernel sessions**
(no IdP, no browser device tokens), **DP 4c = per-page grants** (the existing
`assignedPageIds` enforcement shape), hosting = same VPS at
`workboard.gosling-agency.ru`, repo `~/code/workboard`. Design-pass workspace
created: launch prompt `../../prompts/prompt-workboard-design.md` + PRD
skeleton `../../workboard/prd.md`. Entry criterion unchanged: owner-approved
PRD before any Stage 34 code.
