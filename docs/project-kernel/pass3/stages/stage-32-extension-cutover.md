# Stage 32 — Extension cutover (SDK, gateway AI, kernel boards, toolchain)

**Repo(s):** extension (`chatgoose`) · **Depends on:** 20 (SDK), 22 (device tokens), 30
(feature services), 16 (kernel board data), 11 (capture lane for acceptance telemetry) ·
**Passport:** roadmap.md §4, stage 32

**Status header — one proposal, two verified calibrations:**
- **Proposal 32.1 — RULED (a) by the owner 2026-07-04, with a corrected shape:** the
  extension's **compare/"Multi"** feature runs **one model** (the fast-reply feature model,
  `compare-operations.ts:124`) across several **prompt variants**: the mapped persona's
  "current" card + bundled draft prompts (`src/shared/compare-cards.ts:80-104`; cards from
  `prompts/drafts/*.md`, a folder currently absent from the repo — shipped builds therefore
  carry only the persona card, so the feature is effectively dormant). Usage events
  `clientEventId = '<operationId>:<cardId>'` (`compare-operations.ts:1251`). Ruling: a
  kernel-side `compare` feature — fast-reply fanned out across N kernel-held prompt variants
  (persona + drafts, one model, one budget, one capture) in a single call; a natural
  Stage 30 registry addendum since personas and prompt assets move kernel-side there anyway.
  No client model registry survives; OpenRouter-routed models are covered kernel-side by
  Stage 29's provider implementation.
- Calibration 1: the DOM boundary is `src/content/conversation-dom.ts` at **116 lines**
  (Pass 2's "~165-line" figure bundles the mount/write side, `conversation-mount-controller.ts`
  + `textarea.ts`) — untouched either way.
- Calibration 2: the extension's hub responses are **cast, not validated**
  (`agency-hub-client.ts:177,231` — `await response.json() as …`); SDK adoption upgrades
  this to runtime validation for free.

**Scope guard.** DP 1-B: the extension remains a **reader** of Fansly — no response
mirroring, no capture-through. Session-credential handling (`session-capture.ts`,
`session-store.ts`) is out of scope and untouched; this spec references only its exported
interface (`initializeSessionCapture`, `normalizeRouteKey`) and specifies nothing about
capture, refresh, transport, or storage of session material.

## 1. Context

The extension is the Fansly workspace: toolbar/panel/overlay UX over fansly.com, seven AI
features + compare + a spenders board, with direct-to-vendor AI (user-held
`claudeApiKey`/`openRouterApiKey` in `storage.local`, `src/shared/types.ts:17-18`;
`llm-client.ts:47-66`), a hand-written bearer-key hub client covering exactly four routes
(`agency-hub-client.ts`: `GET api/v1/pages` `:165`, `GET …/conversations/{id}/profile`
`:211-213`, `PUT …/fans/{id}/profile` `:244-253`, `POST api/v1/ai-usage/batch` `:270-277`),
and a board that rebuilds spend rankings from up to ~151 Fansly calls per creator per 10
minutes (`spenders-service.ts:56,66,79`; `SPENDERS_MAX_FANS=150` + TTL `constants.ts:99,103`).
After Stages 16/20/22/30 the kernel serves earnings projections, a typed SDK, device tokens,
and byte-identical AI features — the extension gets **thinner**: DOM layer and UX stay,
vendor keys and the board rebuild die.

**Entry criteria restated as facts to verify:**
- Stage 16 running fleet-wide: `fan_earnings_stats` fresh within cadence for the Fansly
  pages; a **sampled parity comparison** of kernel board data vs the extension-computed
  board for ≥2 creators recorded (rank order + lifetime totals within tolerance — the
  entry gate).
- Stage 30 parity sign-off covers the extension's features and personas (its prompt library
  `prompts/*.md` ×7 + `src/shared/prompts.ts` assembly + builtin Lora persona
  `personalities.ts:7-174` were reference sources; verify the manifest hashes).
- Stage 22: device tokens issuable; Stage 20: SDK published; the **SDK-under-MV3 spike**
  passed (gecko service-worker/background constraints; bundling via esbuild) — if the spike
  fails, the escape hatch is stage-20's thin generated-fetch layer.
- Proposal 32.1 ruled.

**Deliverable:** extension ≥1.6.0 on the self-hosted feed: SDK + device token; AI via kernel
features (vendor keys retired); board from kernel queries; acceptance/telemetry on the
capture lane; pnpm/ESM toolchain; UX byte-identical to the chatter.

## 2. Changes

**extension — hub client → SDK** (`src/background/agency-hub-client.ts` shrinks to a thin
adapter or dies):
- The four routes become SDK operations (same wire shapes — fan-profile PUT/GET invariant);
  runtime validation replaces the casts; the 50 KB profile cap (`agency-hub.ts:7`) stays as
  a client-side pre-flight. `resolvePageLabel` (`:180-200`) keeps its exact-match rule over
  the SDK's `listPages`.
- Auth: `agencyHubApiKey` (bearer) → **device token**: options page gains a login form
  (username/password → SDK session login → `POST /api/v1/auth/device-tokens`, label =
  browser/profile name) storing the token where the API key lives today
  (`storage.local` settings — same custody class, no new storage); the legacy key keeps
  working as fallback until fleet confirmation (Stage 22 dual-acceptance).
- The stage-20 standalone `check-kernel-contract.mjs` drift gate is replaced by the normal
  SDK pin + contract-hash CI job (the passport's note honored: the standalone script existed
  only because the repo was npm/commonjs — fixed below).

**extension — AI → kernel feature services:**
- `llm-client.ts`, `anthropic-client.ts`, `openrouter-client.ts`, `llm-stream-utils.ts`,
  `llm-cost.ts`, `src/shared/model-registry.ts`, `src/shared/prompts.ts` + `prompts/*.md`,
  `prompt-injection.ts` — **deleted**; panel actions call SDK feature operations
  (`fast-reply`, `improve-draft`, `help-me`, `fan-summary`, `chat-review`, `ping`,
  `hi-greeting` — the wire enum already matches core's) with
  `{conversationRef, tone?, draft?, personaId?, clientRequestId}`; streaming into the
  existing overlay/inline-panel controllers unchanged. Compare rides Proposal 32.1's
  kernel `compare` feature.
- Personas: `PersistedState.personalities` (`types.ts:98-105`) retires as source of truth —
  the picker lists kernel `ai_personas` (seeded in Stage 30 from these defaults, including
  builtin Lora); local persona edits become kernel persona edits (owner/team-lead-gated
  kernel-side; the options-page persona editor is removed or downgraded to read-only per the
  Stage 30 config surface).
- Vendor keys: `claudeApiKey`/`openRouterApiKey` fields removed from settings + options UI;
  values deleted from `storage.local` on upgrade; `manifest.json` host permissions for
  `*://api.anthropic.com/*` and `https://openrouter.ai/*` (`manifest.json:12-17`) **removed**
  — the permission surface shrinks, which is itself the no-direct-AI proof.
- AI usage self-reporting (`agency-hub-usage-reporter.ts`, lossy 3-attempt policy) dies with
  direct mode — the gateway ledger is authoritative (Stage 29).

**extension — spenders board → kernel:**
- `spenders-service.ts`'s Fansly fan-out (list groups → per-fan earnings → names) is
  replaced by one kernel query over Stage 16's projections (top spenders for the resolved
  page, lifetime + monthly, served by the finance/audience surface; SDK operation). The
  board UI (`spenders-board-controller.ts`, `board-launcher.ts`) renders the same shape
  (`SpendersListResult` mapped from the kernel response; `builtAt` = kernel
  `max(observed_at)` so staleness is honest in the UI).
- The old rebuild path stays behind a hidden setting for **one release** (default kernel;
  flip = diagnostic fallback), then is deleted — the Fansly-quota win is the point
  (roadmap exit: network panel shows kernel calls, not ~150 Fansly calls). Freshness note
  recorded in the UI copy: kernel earnings are cadence-fresh (daily), not click-fresh; the
  extension remains free to *read* Fansly in-page for conversation context (reader role,
  DP 1-B) — it just never rebuilds rankings from quota-expensive sweeps.

**extension — capture lane (summaries/telemetry):**
- Fan-summary PUT/GET keeps its contract (invariant) via SDK. NEW: acceptance telemetry —
  the panel emits `ai_acceptance` events (shown/copied/inserted, correlated by
  `clientRequestId` + the gateway meta frame's `requestId`) on the Stage 11 capture lane
  (`POST /api/v1/ingest/observations`), with the extension's own `x-client-version` header
  (stage-11 §2 anticipates this). Spooled in `storage.local` with resend-until-2xx +
  `Retry-After` (the lane contract; bounded queue — the extension is not a durable-disk
  client, cap + drop-oldest with a counter is acceptable here and recorded as different
  from the desktop's never-drop spool).
- Per DP 1-B, explicitly NOT here: any Fansly response mirroring.

**extension — toolchain (family standard, target §12.4, at its natural rework point):**
- npm/commonjs → **pnpm/ESM**: `"type": "module"` (`package.json:20`), `packageManager`
  pinned, `package-lock.json` → `pnpm-lock.yaml`; esbuild config stays (IIFE bundles are a
  build *output* concern, unaffected by package ESM-ness); vitest config carried over.
- ESLint added (desktop's flat config as the base: `no-explicit-any`,
  `consistent-type-imports`, boundary `no-restricted-imports` — here: content scripts may
  not import background-only modules; nothing imports the deleted vendor clients).
- CI (`.github/workflows/ci.yml`) updates to pnpm and gains the lint step + the SDK
  contract-hash gate.
- Release path unchanged: `scripts/deploy.sh` (web-ext AMO unlisted signing → `updates.json`
  with sha256 → scp to `ext.gosling-agency.ru`) — verify it under pnpm (`npm run build` →
  `pnpm build`).

**extension — untouched (the keeps):** all of `src/content/` (DOM boundary
`conversation-dom.ts`, mount/textarea write boundary, toolbar `button-bar.ts`, overlay,
inline panel, hotkeys `src/shared/hotkeys.ts`, cheatsheet, toasts, spenders board *UI*),
session capture/store interface, summary cache (`summary-cache.ts` — still the local cache
for hub-backed summaries), manifest gecko id + `strict_min_version` + `update_url`.

## 3. Schema & data migration

**No kernel schema change** (board queries serve Stage 16 projections; the `compare` feature
of Proposal 32.1 is config/code, not schema). **Extension-side migration:** one
`storage.local` settings migration (existing versioned-migrations pattern,
`src/shared/storage.ts` family): drop vendor-key fields, add device-token field + capture
spool; personas map read-only. Idempotent by the storage layer's version counter. "No data
backfill" explicit — local summaries stay as cache; nothing uploads retroactively (the
extension never held unpushed business facts beyond summaries, which are already hub-synced).

## 4. Client compatibility

- **Extension (chatters):** identical panel/toolbar/overlay/hotkeys; one-time login in
  options (device token); persona editing moves kernel-side; the spenders board shows the
  same ranking with an honest as-of timestamp and opens instantly (no 2-minute build,
  `SPENDERS_BUILD_TIMEOUT_MS=120_000` dies). Old versions keep working during rollout
  (bearer key + old routes still served; direct AI still works for not-yet-updated users
  until their keys are removed on upgrade).
- **Desktop / dashboard / workboard:** untouched.
- **Kernel:** gains extension device-token principals, feature-service traffic, capture-lane
  `ai_acceptance` events with an extension producer, and loses the extension's ai-usage
  batch traffic.
- **Fansly (platform safety):** total quota consumption drops by the board sweep
  (~150 calls/creator/10 min → 0 steady-state); no NEW Fansly call patterns are introduced
  (the read behavior envelope only shrinks — the passport's platform-safety assumption).

**Compatibility invariants (target §14):** fan-profile PUT/GET — preserved (same routes via
SDK). Chatter bearer keys — dual-accepted; after this stage + 24, the kernel declares the
retirement schedule (recorded in Stage 22's spec). Extension self-hosted release channel —
same `update_url`, same signing flow, continuity preserved. SSE/outbox invariants — not in
play (the extension consumes neither).

## 5. Tests & verification

**New tests:** SDK adapter tests replacing `tests/agency-hub-client.test.ts` fixtures
(same shapes, validation now enforced); feature-call panel tests (per feature: refs, stream
handling, insert path) replacing `tests/llm-client.test.ts`/vendor client tests; board
kernel-query tests replacing the fan-out orchestration tests (`tests/spenders-service.test.ts`
reshaped; ranking/format logic tests survive); capture-spool tests (resend, Retry-After,
cap + drop-oldest counter); storage migration test (keys dropped, token added, idempotent);
manifest test: vendor host permissions absent.

**Existing suites:** the content/UI suites (58-file vitest set) green throughout — the
untouched-UX proof; `npm run check` equivalent (`pnpm check` after toolchain task) is the
gate.

**Production verification (exit criteria):**
- New version served by `https://ext.gosling-agency.ru/updates.json`; fleet updated
  (version header on kernel requests).
- Zero direct vendor AI calls from extension users (vendor dashboards + the removed host
  permissions make new calls structurally impossible on the new version).
- Board renders from kernel data: network panel on a live creator shows kernel calls only;
  **measured Fansly quota drop** recorded (before/after call counts over a day).
- A chatter walkthrough confirms UX parity (panel, hotkeys, overlay, board) — recorded.
- Acceptance events from the extension visible as observations (`producer='extension@…'`).

## 6. Rollback

- Feed rollback: re-publish the previous `updates.json` + signed `.xpi` (self-hosted channel
  — minutes). Old version's direct-AI works only for users who haven't upgraded (upgrade
  deletes local vendor keys); a post-upgrade rollback leaves AI on the kernel lane — the
  hidden board fallback and the dual-accepted bearer key cover the other surfaces.
- The toolchain migration is git-revertable; it ships first (task 1) so any later rollback
  within the stage stays on pnpm/ESM rather than straddling.
- No kernel-side steps to unwind. Irreversible: none (vendor keys are user-held; users can
  re-enter them on an old version if the owner ever sanctioned that — he won't, DP 5).

## 7. Assumptions

1. **DP 3-A stands** — the extension is an indefinitely maintained first-class surface; this
   stage invests accordingly (toolchain, CI, SDK) rather than minimally.
2. **The SDK-under-MV3 spike verdict holds** for the release build (gecko ≥142, background
   service worker, esbuild IIFE bundling); escape hatch: stage-20's generated thin-fetch
   layer, same contracts.
3. **Stage 16's cadence (daily earnings / few-hourly purchases) is acceptable board
   freshness** — the entry parity sample + the UI's as-of timestamp make this honest;
   chatter complaints about staleness re-open the cadence config (kernel), not the client
   fan-out.
4. **Kernel origin host permission** is already grantable (optional host permissions
   `http(s)://*/*`, `manifest.json:18-21`) — device-token login and capture lane need no new
   manifest permission classes; `data_collection_permissions` unchanged.
5. **The capture lane tolerates a bounded, drop-oldest spool** for the extension's
   acceptance events (unlike the desktop's never-drop spool) — acceptance is recoverable
   signal here, not custody-grade audit; the drop counter keeps the gap visible. If the
   owner wants desktop-grade durability, `storage.local` quota + `unlimitedStorage`
   (`manifest.json:8`) makes it possible — decide at execution.
6. **Proposal 32.1's ruling arrives before the AI task** — tasks 1–2 and 4–5 are
   independent of it.

## 8. Task breakdown

1. **Toolchain migration** (pnpm/ESM, ESLint, CI update incl. SDK hash gate). Done-check:
   `pnpm check` green; CI green on a PR. *(0.5–1 session)*
2. **SDK adoption + device-token login + storage migration.** Files:
   `agency-hub-client.ts` → adapter, `src/options/index.ts`, `src/shared/types.ts`,
   storage migrations. Done-check: adapter tests; migration test; fallback-key path test.
   *(1 session)*
3. **AI panel → feature services + persona swap + vendor deletion + manifest permission
   shrink** (needs Proposal 32.1 ruled for compare). Done-check: feature tests; manifest
   test; grep gate (no vendor URLs). *(1 session)*
4. **Spenders board → kernel query + hidden fallback + quota instrumentation.** Done-check:
   board tests; fallback flip works. *(0.5–1 session — parallel with 3)*
5. **Capture lane (acceptance events + spool) + `x-client-version`.** Done-check: spool
   tests; observation appears in a staging kernel. *(0.5 session)*
6. **(Last) Release on the self-hosted feed; run production verification (§5) incl. the
   quota-drop measurement and chatter walkthrough; record results here. Next release deletes
   the board fallback + legacy key path.** *(ops)*

## Progress

**2026-07-06 — Tasks 1–2 BUILT; core enablers landed; entry criteria verified.**
Branch `kernel/stage-32-extension-cutover` (pushed).

- **Entry checks:** all 7 extension templates differ from the kernel's stored
  wording by exactly the one word Fansly↔OnlyFans (plus the two safety
  preambles and the Lora persona body — three static sites total).
  **SDK-under-MV3 spike PASSED for real:** vendored SDK + zod bundle to an
  805 KB IIFE via esbuild with zero node builtins and execute in a bare JS
  context (fetch/getReader/TextDecoder are Firefox-background-page natives).
  `fan_earnings_stats` has NO read endpoint in core — the board query is
  core-side work inside Task 4. Stage 16 fleet-freshness/parity gate deferred
  to Task 4 (prod check).
- [x] **Task 1 (21aebd4): toolchain.** npm/commonjs → pnpm/ESM
  (packageManager pnpm@10.33.1, esbuild build-script allowlisted,
  pnpm-lock); ESLint flat config (desktop base minus React; type
  annotations allowed for the suites' `typeof import()` mock idiom;
  content→background boundary rule) — 74 initial errors to zero; CI on
  pnpm + lint via `pnpm check`; deploy.sh/README follow. 824 tests green.
- [x] **Task 2 (1a08f8a): SDK + device token + storage v8.** @kernel/sdk
  vendored (core 69329da, contract ea3d4182…; `link:` dep so bundler
  resolution applies; dist committed — gitignore anchored to `/dist/`;
  drift-gate test pins manifest hash == exported hash). The four legacy
  hub routes ride SDK ops with runtime validation replacing the casts
  (wire facts: profile source enum is 'chatmuse'; fan carries pageAlias);
  network/abort semantics preserved through the KernelApiError wrap.
  Device-token sign-in in options: login → authIssueDeviceToken → logout,
  every call `credentials: 'include'` (Set-Cookie is unreadable in
  extensions — the desktop's header capture is impossible here); token in
  settings storage, never crossing the runtime-message boundary;
  `resolveHubBearer` = token || legacy key (dual-acceptance). Storage
  schema v7→8 adds the field, idempotent-tested. 831 tests green.
- **Core enabler (core db6f65b): named platform substitution.**
  `buildPrompt` gains `platform` (default 'onlyfans' — Stage 30 fixtures
  untouched); fansly swaps the word in STATIC sources only (template,
  preambles, persona content) — runtime data survives verbatim (a fan
  message mentioning OnlyFans is never rewritten). Strong pin:
  fansly-worded kernel templates byte-identical to the extension's
  prompts/*.md, all 7, cross-repo skip-if-absent.
- **DEVIATION (Proposal 32.1 execution shape):** a single-call kernel
  `compare` feature is DEFERRED — its value is kernel-held draft
  variants, and none exist (prompts/drafts/ absent from the repo; shipped
  builds render only the mapped persona card, so every real compare run
  degenerates to one fast-reply). The Multi UI cuts over by riding the
  fast-reply feature lane once per card (v1: one card = one call); one
  model, per-feature budget, full capture per generation hold. Revisit as
  a Stage 30 registry addendum when the owner wants kernel-held variants.
- **DEVIATION (Task 3 context model) + core enabler (core cedb00a):**
  refs-only feature calls assume a fresh kernel archive — TRUE for OnlyFans
  (webhooks), FALSE for Fansly by design: `dm_conversations` cadence =
  30 min, `dm_messages` = 24 h history stream (page-sync stream config).
  A kernel-assembled transcript would miss up to half an hour of live
  conversation → functionally broken for chatting. The extension already
  reads the conversation LIVE from the Fansly API at generation time, so
  the feature body gains optional `clientContext` (transcript string,
  messageCount, fanDisplayName, spending/subscription blocks, fanBio,
  pingSegment) — context VALUES from the client, prompt ASSEMBLY
  kernel-side (templates/personas/wording/budgets/capture/ledger
  unchanged; values are captured under the Stage 29 restricted class
  exactly like archive context). Product gates run on the client counts;
  ping requires the client-computed segment (CG-FLOW-05 holds).
  Integration-tested (client transcript verbatim in the captured prompt;
  min-30 satisfied by client count against a 3-row archive; hi-greeting
  lock; ping segment required/active-blocked/proceeds).
- [x] **Task 3 COMPLETE (seam 432544e + sweep a036a48, −9,004 lines).**
  operations.ts + compare-operations.ts run through
  kernelGateway.streamFeature (refs + clientContext out, gateway-priced
  spend back via the slim src/shared/spend.ts; 'kernel' = summary-cache
  sentinel, pre-cutover entries invalidate once; service_unavailable
  retries once, the rate-limit auto-retry died with Retry-After). Compare
  runs only 'current' persona cards; draft cards error explicitly.
  DELETED: both vendor clients, llm stream utils/costs, model
  registry/capabilities, shared prompts.ts + prompts/*.md,
  prompt-injection, feature-readiness, the usage self-reporter
  (parseRetryAfterMs inlined into fansly-client). Settings v9 drops
  vendor keys + model/reasoning selections; options API-keys/Models
  sections gone; readiness = hub-configured. Manifest loses the two
  vendor host permissions (structural no-direct-AI proof). Gates:
  scripts/check-ai-cutover.mjs in `pnpm check` + the manifest pin test.
  Suite triaged to green: 643 tests (test rewrites of note: prompt-content
  assertions became kernel-REQUEST assertions; duck-typed error keys kept
  the retry path testable across dual module instances; the deep
  idle-keepalive test now rides reasoning deltas — the kernel lane's
  inter-chunk provider activity).
  *(the original seam entry follows)*
  `kernel-feature-gateway.ts`: SDK aiFeatureStream with refs+clientContext,
  frame fan-out (onText/onMeta/onUsage/onReasoningDelta/onStopReason),
  kernel gate wordings → extension error keys (not_enough_history /
  hi_too_many_messages / ping_blocked), quota→rate_limited,
  5xx→service_unavailable, auth→hub_invalid_api_key, aborts→AbortError,
  fail-closed on a truncated stream; gateway-priced usage (costMicroUsd).
  `AgencyHubClient.resolvePageLabelForUsername` exposed for page
  resolution. SDK re-vendored @ core cedb00a. 834 tests green.
  REMAINS (fresh context): operations.ts tail rewrite onto the gateway
  (replace llmClient.streamMessage + local model/key/cost machinery;
  retry policy moves to kernel-error-driven), compare/Multi → fast-reply
  per card, persona picker → kernel CRUD + one-time custom sync, the
  DELETIONS sweep (llm-client/anthropic/openrouter/llm-stream-utils/
  llm-cost/model-registry/prompts.ts+prompts/*.md/prompt-injection/
  usage-reporter), vendor keys out of settings+options+storage v9,
  manifest host-permission shrink, grep gate, test triage.
- **Core enabler (core be5facb): the board read endpoint.**
  `GET /api/v1/pages/:pageLabel/top-spenders` (auth any + page scope;
  page-scoped per-fan spend for an ASSIGNED page — not the Stage 2-gated
  dashboard revenue aggregates). Snapshot-honest: builtAt =
  max(observed_at), fanCount = gross>0 spenders, entries spend-descending
  (qualified ORDER BY — the Stage 8 trap). window ∈ lifetime|YYYY-MM,
  limit ≤ 500 default 150. Ratchet fallout resolved: platform-branch
  budget 49 (+1 named substitution), builder.ts coreSha256 refreshed in
  the prompt manifest, retention-deleter scan filters `server.delete(`
  registrations (a LATENT Stage 31 trip) and its allowlist tightened by
  four noise-only modules. Core suite 205/1689 green.
- [x] **Task 4 (7b5d25a): board → kernel query.** ONE pageTopSpenders call
  replaces the ~150-call per-fan earnings sweep; one bounded conversations
  enumeration remains (the fan→groupId map for opening chats — DP 1-B
  reader). Kernel spenders without a visible conversation are filtered.
  builtAt = the projection's freshest observed_at (honest staleness).
  Legacy rebuild behind hidden `spendersLegacyRebuild` (storage v10, no
  UI) for one release. NOTE: the Stage 16 prod freshness/parity gate is
  OWNER-RUN pre-release (needs prod SSH): fan_earnings_stats fresh within
  cadence for the Fansly pages + a sampled rank/total comparison vs the
  legacy board for ≥2 creators, recorded here.
- [x] **Task 5 (b257cbd + 84f0625): producer identity + acceptance.**
  x-client-version (chatgoose-extension/<version>) on all three SDK
  client sites. Acceptance lifecycle shown/copied/inserted on the capture
  lane (ai_acceptance; correlation pair operationId + meta-frame
  requestId kept in a bounded per-operation map; copied/inserted travel
  over a new operation:acceptance port message from both surfaces).
  SPOOL: storage.local drop-oldest (300) with a persisted dropped counter
  (spec §7.5 — recoverable signal, unlike the desktop's never-drop
  spool); enqueue-assigned clientEventId (kernel dedup); 400 drops
  loudly; transients retry capped; writes serialized (the first test run
  caught a real lost-update race between rapid enqueues).
- [ ] **Task 6 (ops, owner-gated): ≥1.6.0 release + §5 verification.**
  ORDER: (1) deploy core main (substitution + top-spenders + clientContext
  — prod is behind); (2) run the Stage 16 gate above; (3) bump version,
  sign, publish updates.json; (4) §5: fleet on the version header, zero
  vendor calls (structural — permissions gone), network panel shows
  kernel calls, measured quota drop, chatter walkthrough, acceptance
  events visible as observations (producer='chatgoose-extension@…').
  Next release: delete the board fallback + legacy key path.
