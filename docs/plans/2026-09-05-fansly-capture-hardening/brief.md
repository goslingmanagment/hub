# Brief — Fansly capture hardening (ban-risk review and connection architecture)

Date: 2026-09-05. Owner: Dmitriy (Gosling agency). This is a PLANNING task, read-only.
You are one of two independent planners. Work alone; do not assume what the other
planner will say; do not read anything under `docs/plans/` except this run directory's
`brief.md`, `answers.md`, and files explicitly addressed to you.

## Rules for you

- Repository access is READ-ONLY. The only file you may create or modify is your own
  output file named in the message that launched you. No worktrees, no branches, no
  `git` writes, no edits anywhere else.
- Never call Fansly, OnlyFans, or any production host of ours (no requests to
  fansly.com, no SSH, no psql, no Telegram). Reading public documentation and public
  articles on the web IS allowed and expected (OnlyFansAPI docs, competitor public
  docs/help centers, Fansly ToS/help pages, browser-fingerprinting literature).
- Ground every claim about the current system in a concrete repo path. Mark anything
  you could not verify as an assumption.
- Write in English. Be precise and dense; no marketing prose.

## The system today (verify yourself — pointers, not conclusions)

Agency Hub "core" (this repo, `~/code/goose/hub`, worktree at the path you are
running in) is the kernel of an OnlyFans/Fansly agency: source of truth for platform
data, money ledgers, AI gateway, owner console. Read `CLAUDE.md`, then
`docs/decisions.md` (Quick Reference table up top; relevant entries include 20, 21,
42, 62, 76, 100, 118, 124), and the generated code maps `docs/generated/00-overview.md`,
`06-capture-and-canonicalization.md`, `07-sync-engine.md`,
`08-platform-adapters-and-egress.md`, `15-auth-config-and-access.md`.

Fansly is captured by TWO cooperating components:

1. **The kernel's server-side replay (this repo).** `packages/fansly/src/*`
   (`adapter.ts`, `request-headers.ts`, `types.ts`), the egress resolver and pacer
   (Stage 26: per-page proxy is mandatory for Fansly, vendor-scope Fansly refused,
   `EGRESS_PACER_MODE` off/shadow/enforce), the sync engine
   (`apps/runtime/src/services/sync/**`, incl. `fansly-stream-gate.ts`, ten Fansly
   streams, pull cadence roughly 30 min for conversations / 24 h for messages),
   page onboarding (`apps/runtime/src/services/page-onboarding.ts`,
   `page-context.ts`), the replay probe (`apps/runtime/src/services/fansly-replay-probe.ts`,
   Stage 6 gate — `docs/migration-history/stages/stage-06-*.md`), credentials schema in
   `packages/contracts/src/routes.ts` (search `fanslyCredentialsSchema`,
   `FANSLY_CLIENT_CHECK_ROUTES`). The kernel authenticates with a pasted
   `FanslySessionBundle` (authorization token, `fansly-client-id`, `fansly-session-id`,
   per-route-family `fansly-client-check` values), replays requests with a fixed
   Firefox header set copied from a 2026-08-21 HAR, through the page's proxy.

2. **The ChatGoose Firefox extension** (`~/code/goose/fansly-ext`, read its `CLAUDE.md`,
   `docs/decisions.md`, `src/background/session-capture.ts`, `session-store.ts`,
   `fansly-client.ts`). It runs inside the chatter's own logged-in browser session, is
   the LIVE reader (DP 1-B), captures the session bundle / route checks from real
   traffic, and pushes credentials to the kernel. Hard rule there: never add
   out-of-band requests to Fansly beyond what the page itself does.

For comparison, OnlyFans is NOT captured directly: it goes through the commercial
vendor OnlyFansAPI (OFAPI) — see `docs/generated/09-ofapi-boundary.md` and
`~/code/goose/of-desktop`. OFAPI also sells a Fansly connector; its public docs are a
useful reference for how a commercial provider connects an account (username/password
login with 2FA challenge handling, managed dedicated mobile proxy per account or a
custom proxy; for OnlyFans they also offer "Cookies & Headers" cURL paste and an
"Auth+" mobile app). Snapshots are in `reference/` next to this brief; the live docs are
at https://docs.onlyfansapi.com/api-reference/fansly and
https://docs.onlyfansapi.com/api-reference/fansly/connect-fansly-account/start-authentication.

## The pain

The owner believes the current Fansly capture is "probably not optimal" and fears it
will eventually get model accounts banned or restricted by Fansly. Commercial agency
tools (OnlyMonster, Infloww, Supercreator, Fanvue-style CRMs, OFAPI's Fansly connector,
and others) run thousands of accounts on server-side capture and are not known for
mass bans — so a "correct" way evidently exists. We want to know what it is and how to
get there ourselves.

## What we want from you

A plan that delivers, in this order:

1. **Diagnosis of the current implementation.** What exactly in today's capture is a
   ban/fingerprint/behavioral risk and what is fine. Cover at least: identity
   consistency (session bundle vs. the chatter's real browser: UA, header set/order,
   TLS/HTTP2 fingerprint of Node's `undici` vs Firefox, `fansly-client-id` /
   `fansly-session-id` reuse from a different IP, the `fansly-client-check` semantics,
   header freshness, `fansly-client-ts`), network identity (per-page proxy type and
   rotation, proxy geography vs the chatter's location, one session used from two IPs
   concurrently), request patterns (pacing, burst shape, endpoints and page sizes no
   real client would hit, cadence), session lifecycle (expiry, re-capture, what happens
   when the chatter logs out), error handling that could look like abuse (retries on
   401/429), and anything else you find. Cite code.
2. **Three to five alternative architectures for a self-built Fansly connection**
   (NOT adopting OFAPI as a dependency — OFAPI is a reference, not an option). Examples
   to consider, not an exhaustive list: (a) harden the current replay path (browser-grade
   TLS/HTTP fingerprint, exact header parity, single-IP-per-session discipline,
   real-client pacing); (b) a kernel-driven real browser per page (headless/headful
   Firefox or Chromium with a persistent profile behind the page's proxy, the kernel
   drives it and the same profile serves the chatter); (c) the extension as the sole
   collector — the chatter's browser does all capture and streams observations to the
   kernel, the kernel never talks to Fansly; (d) a dedicated always-on "chatter
   workstation" browser per page (remote browser/VM/anti-detect browser profile such as
   Multilogin/GoLogin-class tooling) that both chatters and the kernel use; (e) an
   own credential-based login flow (username/password + 2FA + device fingerprint) the
   way OFAPI does it; (f) a hybrid. For each: how it works, what it needs, pros, cons,
   ban-risk assessment with reasoning, data completeness/freshness, operational burden
   (re-auth, 2FA, session death), cost, implementation effort and sequence in THIS
   codebase, and which hard rules it touches.
3. **One recommended option** with rationale, the migration path from today's state
   (stages, what can ship behind a flag, what is verifiable and how), risks, and the
   decisions left to the owner.

Where you can, back the ban-risk reasoning with public evidence: how Fansly actually
detects (what is known about `fansly-client-check`, device/session semantics, rate
limits, Cloudflare/WAF behavior), how the commercial tools connect accounts, what
agency operators report. Distinguish evidence from inference.

## Scope

- IN: the kernel's Fansly capture path in this repo; the extension's role; a new
  component if the recommended architecture needs one; proxy/egress policy.
- OUT: OnlyFans (stays on OFAPI), the AI gateway and prompts, money/ledger logic,
  dashboard UX beyond what the connection flow needs.

## Constraints (hard rules from CLAUDE.md that apply)

- Fansly traffic MUST go through the page's own proxy; egress only via the resolver.
- Capture-first, never scheduled deletion (DP 7); observations are journaled verbatim.
- No auto-retry of an indeterminate send. Read paths must not become write paths.
- The extension is the live reader; freshness for chatters is the product.
- Platform branches are budgeted; vendor SDKs only in the gateway; single-tenant.
- Migrations forward-only; flags flip one at a time with a verification window.

## Success criteria

- The owner can read the plan and understand, in plain terms, why today's capture is or
  is not dangerous and which single architecture to build next.
- Every option has explicit pros/cons and a ban-risk rating with reasons.
- The recommended path is sequenced into stages that each ship independently and can be
  verified against production telemetry without touching Fansly beyond normal capture.

## Output format

Phase 2 (now): questions. Write clarifying questions only if the answers would change
your plan; otherwise write exactly `No questions.` Number them.

Phase 3 (after answers): the plan, with sections: Summary; Diagnosis of the current
implementation; Options (one subsection each, common structure); Recommendation and
rationale; Migration path and stages with dependencies; Verification and acceptance
criteria; Risks, trade-offs, assumptions; Decisions left to the owner; Evidence index
(repo paths and URLs).
