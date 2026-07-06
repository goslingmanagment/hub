# Stage 31 — Desktop AI cutover

**Repo(s):** desktop · **Depends on:** 30 (feature services + parity sign-off), 24 (SDK +
device tokens in the desktop), 11 (capture lane — `ai_acceptance` in its allowlist, per §1
entry criteria) · **Passport:** roadmap.md §4, stage 31

**Status header.** No deviation from the master. One verified sharpening that changes the
shape of the work: the desktop's "already-wired hub-AI mode" is a **proxy** lane — prompt and
context are still assembled on the desktop and only the provider call streams through core
(`apps/desktop/src/main/hub/ai-gateway.ts:1-2` — "keeps prompt/context construction in
desktop"). The cutover is therefore NOT a transport flip: the dock moves from
assemble-locally→proxy to **calling Stage 30 feature services with refs**
(`POST /api/v1/ai/features/<feature>` `{conversationRef, tone?, draft?, personaId?}`), and
the local assembly machinery is what gets deleted. One verified calibration on acceptance:
today's lifecycle signal is `copied|inserted` only (`aiFeedbackSchema`,
`apps/desktop/src/main/ipc/handlers.ts:195-211`) — `shown`/`edited`/`sent` do not exist as
events; this stage adds them (the passport's lifecycle list is the target, not the current
state).

## 1. Context

Desktop AI today: default `aiGatewayTransport: 'direct'` (`settings/store.ts:180,238`) —
user-held Anthropic/OpenRouter keys in the OS keychain read at call time
(`ai/gateway.ts:71-78`; secrets `anthropicKey`/`openRouterKey`, `secrets/keychain.ts:10-17`),
local prompt library (`packages/shared/src/prompts/templates.ts` + `templates/*.md`,
byte-equality-tested), local cost tables (`packages/shared/src/llm/cost.ts`) and model
registry (`llm/model-registry.ts`), per-request lane selection
(`createSelectableAiGateway`, `ai/gateway.ts:128-135`; `op.aiGatewayTransport` set from
settings, `ai/coordinator.ts:729`). After Stage 30 the kernel serves every feature with
byte-identical prompts and kernel-loaded context, proven by the parity harness. This stage
makes that the only lane, closes the acceptance loop against gateway generation ids, and
decommissions the last user-held vendor keys.

**Entry criteria restated as facts to verify:**
- Stage 30 exited: parity harness signed off in `decisions.md`; per-feature smoke latencies
  recorded (the baseline for this stage's latency budget).
- Stage 24 shipped fleet-wide: SDK in the desktop, device tokens live, stream v2 stable.
- Stage 11 lane live with `ai_acceptance` in its kind allowlist (stage-11 §2).
- Hub-AI smoke: one machine doing real work for a day on the feature-service lane (this
  stage's own first rollout step doubles as the check).
- Generation correlation anchor verified in code: the gateway stream's `meta` frame carries
  `requestId` + `clientRequestId` (core `apps/runtime/src/services/ai-gateway.ts:205-215`),
  and the ledger reserves on `clientEventId = clientRequestId` — Stage 30's feature route
  preserves this (its streaming path IS the gateway's).

**Deliverable:** a desktop release where every generation is a kernel feature call; local
prompt/cost/model machinery deleted; vendor keys decommissioned with owner comms; acceptance
lifecycle (`shown/copied/inserted/edited/sent`) reported on the capture lane with generation
refs; dock UX unchanged to the chatter.

## 2. Changes

**desktop — dock onto feature services:**
- The AI coordinator (`ai/coordinator.ts`) replaces prompt assembly + gateway selection with
  SDK feature calls: request = `{feature, conversationRef (page label + platform-native
  conversation id), tone, draft, personaId, clientRequestId: operationId}`; response = the
  gateway SSE stream (SDK AI helper from stage-20/30). Streaming/insert/cancel UX in the dock
  (`renderer/.../ai/aiStore.ts`, `dockLogic.ts`) unchanged — same frames, same insertion flow.
  The "AI never sends without explicit human action" gate stays client-side (target §9.2).
- **Deleted:** `packages/shared/src/prompts/` (templates, builder, personalities, escape),
  `packages/shared/src/llm/` (cost, model-registry, provider clients),
  `apps/desktop/src/main/ai/providers/` (anthropic, openrouter),
  `createSelectableAiGateway` + `createDirectGateway` (`ai/gateway.ts`),
  `hub/ai-gateway.ts` (the proxy adapter — superseded by feature calls). Their regression
  tests (escape/reply-output/prompt-builder/templates-sync) were **moved kernel-side in
  Stage 30** — deletion here is the second half of move-don't-fork; the stage-30
  `prompt-manifest.json` already pins the byte-identity against this repo's frozen state.
- **Kept client-side:** output insertion, hotkeys, tone cycling UI, `FEATURE_POLICIES`'
  UI-facing parts (`packages/shared/src/features.ts:53-159` — which buttons exist, insertable
  vs analysis surfaces); the output *sanitizer* runs kernel-side now (Stage 30) — the dock
  trusts sanitized frames.
- Settings: `aiGatewayTransport` collapses to `z.literal('hub')` then the field and the
  HubSettings toggle (`HubSettings.tsx:148-159`) are removed (the `store.ts:178` write-path
  precedent, third and last application); model selector UI removed (per-feature
  model/effort/temperature are kernel config per Stage 30); persona picker re-lists from the
  kernel's `ai_personas` (SDK operation) instead of local `prompts/personalities.ts`.

**desktop — acceptance lifecycle (closing the loop):**
- Events on the Stage 11 capture lane, kind `ai_acceptance`, each carrying
  `{operationId (=clientRequestId), requestId (from the meta frame), feature, action,
  conversationId, at}`; actions: `shown` (first token rendered), `copied`/`inserted`
  (existing `cmd:ai.feedback` actions, `handlers.ts:844-865`, now also enqueued to the
  capture spool), `sent` with `edited: boolean` — emitted by the send path when an outbox
  send follows a tracked insertion in the same conversation (`edited` = sent text ≠ inserted
  suggestion, computed by the existing composer/outbox text, no new custody surface).
- The local `usage_events` generation bookkeeping stops for new runs (the gateway ledger is
  authoritative — Stage 29; suppression already exists for hub-lane runs,
  `coordinator.ts:607,639`, now the only lane). The old `/api/v1/ai-usage/batch` reporter
  remains for one release to drain the fleet's pending spool, then dies (kernel lane already
  marked deprecated in Stage 29). `ai_spend_log` daily counters keep serving the local
  activity UI, fed from gateway-reported `costMicroUsd` in the terminal frame instead of
  local price tables.

**desktop — vendor-key decommission (owner comms included):**
- `anthropicKey`/`openRouterKey` leave `SECRET_NAMES` (`secrets/keychain.ts:10-17`); on first
  run the app deletes the stored secrets. Owner communicates to the team: personal vendor
  keys are retired; the owner revokes/rotates them at the vendors after fleet confirmation
  (ops step — keys existed on N machines).
- Break-glass: a kernel outage means no AI (DP 5-A accepted trade); the ops runbook
  (owner-issued temporary direct keys) is documented kernel-side — explicitly NOT a client
  feature or settings toggle.

**desktop — release:** staged fleet rollout on the existing feed; one machine does a full
real workday on the new lane before fleet (the passport's smoke), then a mid-selling-day-safe
staged rollout with instant feed rollback.

## 3. Schema & data migration

**No local schema change** (`SCHEMA_VERSION` 16; `ai_spend_log`/`usage_events` tables stay —
one keeps serving display, one drains). **No kernel schema change** (Stage 29/30 built the
capture class and personas). "No data migration" explicit: historical local AI ledgers were
harvested in Stage 12; nothing else moves.

## 4. Client compatibility

- **Desktop (chatters):** zero workflow change — same dock, same hotkeys, same insertion;
  the model picker disappears (kernel-tuned per feature), persona list now comes from the
  kernel. Latency changes by the Stage 30-measured delta (intra-VPS assembly + context
  queries); the agreed budget is below.
- **Extension:** untouched (its cutover is Stage 32; its direct-vendor lane still works).
- **Dashboard:** untouched (AI analytics pages read kernel data that only gets more
  complete).
- **Kernel:** feature-service traffic replaces `ai/gateway/stream` proxy traffic
  machine-by-machine; the client-reported usage lane drains to zero.

**Compatibility invariants (target §14):** none of the listed invariants touch the AI lane;
the deprecated ai-usage batch route keeps accepting until the drain completes (its retirement
is declared in Stage 29's ledger-authority decision, executed after this stage's fleet
confirmation).

## 5. Tests & verification

**New tests (desktop):** coordinator-to-SDK feature-call contract tests (per feature: right
refs, right stream handling, cancel path); acceptance lifecycle unit tests (shown/copied/
inserted/sent+edited emission, correlation ids present, spool-backed); settings collapse
coercion test; grep gates as compile-time proofs: no `api.anthropic.com`/`openrouter.ai`
literals outside deleted paths, `SECRET_NAMES` without vendor keys, no imports of the deleted
prompt/llm modules.

**Existing suites:** full `pnpm check`; dock renderer tests green with the feature-call
store; **send-engine suites untouched and green** (the acceptance `sent` hook is
observe-only — a test asserts it cannot affect outbox state).

**Production verification (exit criteria):**
- Zero direct vendor calls from the fleet: vendor dashboards show no traffic on the retired
  keys over 7 days; egress logs on sampled machines clean.
- Suggestion latency within the agreed delta of the Stage 30 baseline (p95 per feature,
  measured on the pilot machine over its workday and re-checked fleet-wide; the number and
  verdict recorded here).
- Acceptance events correlated: for a sample day,
  `ai_acceptance` observations join to gateway ledger rows on
  `clientEventId = operationId` ≥ 95 % (unmatched = investigate, not shrug).
- Owner check-in with the team: no workflow complaints after one week fleet-wide.
- Client-reported usage lane at zero events/day (drain complete).

## 6. Rollback

- Staged rollout + instant feed rollback is the primary containment (mid-selling-day latency
  or availability regressions revert the machine in minutes; old version still has the
  direct lane and its keys until that machine's first run of the new version deleted them —
  rollback after key deletion falls back to hub-proxy mode, which remains served).
- Kernel outage ≠ rollback trigger: that is the accepted DP 5 trade with the ops runbook.
- Vendor-key revocation at the vendors is the irreversible step — it happens **only after**
  fleet confirmation (last task), owner-executed.

## 7. Assumptions

1. **DP 5-A stands** (gateway-only; break-glass is ops). Prompts are frozen kernel-side
   since Stage 30's sign-off — all tuning is kernel config from here on; a desktop-side
   prompt edit request is a process error, route it to the kernel prompt library.
2. **Stage 30's feature contract carries the meta frame** (`requestId`,
   `clientRequestId`) — verified against core at spec time for the v1 gateway
   (`services/ai-gateway.ts:205-215`); if Stage 30 renamed fields, the correlation mapping
   updates here, the design doesn't.
3. **The Stage 11 capture lane absorbs acceptance volume** (a few events per generation —
   well inside the 120/min/principal envelope).
4. **`FEATURE_POLICIES` UI semantics survive without local models** — feature availability
   is client UX; model choice is kernel config; nothing in the dock needs a model id
   anymore.
5. **The extension's direct lane is unaffected** by the vendor-key revocation (its users
   hold their own keys until Stage 32 — the owner's revocation list covers desktop-issued
   keys only).
6. **Latency budget**: the Stage 30 smoke p95 + the agreed delta (owner-accepted number,
   recorded at stage-30 sign-off) is the gate; a miss pauses rollout rather than shipping
   degraded suggestion latency into selling hours.

## 8. Task breakdown

1. **Coordinator → SDK feature calls + dock store rewiring + contract tests.** Files:
   `ai/coordinator.ts`, `renderer/.../ai/aiStore.ts`, `dockLogic.ts`. Done-check: per-feature
   contract tests; dock renderer tests. *(1 session)*
2. **Acceptance lifecycle events + capture-lane wiring + correlation tests.** Files:
   `ipc/handlers.ts`, send-path hook, capture uploader. Done-check: lifecycle unit tests;
   outbox-untouched proof test. *(0.5–1 session)*
3. **Deletions + settings collapse + persona/model UI swap + grep gates.** Files: the §2
   deleted list, `settings/store.ts`, `HubSettings.tsx`, persona picker. Done-check:
   `pnpm check` green after deletion; grep gates. *(0.5–1 session)*
4. **Vendor-key decommission + usage-lane drain mode + ops runbook cross-check.**
   Done-check: `SECRET_NAMES` test; drain counter visible in diagnostics. *(≤0.5 session)*
5. **(Last) Pilot machine full-workday smoke → staged fleet rollout → production
   verification (§5) → owner comms + vendor key revocation; record latency numbers,
   correlation rate, and the drain-to-zero date here.** *(ops)*

## Progress

**Session 1 (2026-07-06, branch `kernel/stage-31-ai-cutover` in the desktop
repo; core support in main @ 109096f):**

§8 status — **Task 1 DONE; Tasks 2-5 remain.**

- [x] **Core support (109096f):** `streamAiFeature` SDK helper (feature-route
  twin of the gateway stream, exported through the generated surface) and
  the kernel ping-active gate (CG-FLOW-05 parity — the kernel now 400s
  pings on active conversations, so the cutover cannot regress the gate).
- [x] **SDK re-vendored** @ core d03f5bc→109096f (aa4d38f): aiFeatureStream +
  restricted-class ops in the vendored @kernel/sdk. Boundary fix: the wire
  feature enum now carries kernel-internal features (workboard-closing) —
  the usage mapper narrows to the desktop's reportable set.
- [x] **Task 1 (ed10024): the feature lane end-to-end.** Transport
  'feature': coordinator sends REFS (no local context loads, no prompt
  assembly, no vendor-key checks — checkProviderKey short-circuits), same
  dock lifecycle via the extracted shared stream callbacks; usage
  suppression now `transport === 'direct'` only (gateway ledger
  authoritative for both kernel lanes). New hub-client `streamAiFeature`,
  `hub/ai-feature-gateway` adapter with kernel-gate→CG-code mapping
  (MAPPED BEFORE the CgError pass-through — HubError subclasses CgError,
  the pass-through would eat every gate), HubModule delegator + composition
  wiring. fan-summary cache still short-circuits before any kernel call.
  RECORDED LIMITATION: local custom personas are not kernel-known until
  Task 3's persona swap — the lane sends only 'builtin:lora'; 'feature' is
  NOT the default transport yet, so nothing ships changed.
  Desktop fully green: 772 + 1230 tests (7 new contract tests: refs-only
  shape, draft gate, cancel, unwired lane, gate-message mapping,
  page-label resolution).
- [ ] Task 2: acceptance lifecycle (shown/copied/inserted/sent+edited on
  the capture lane with generation refs).
- [ ] Task 3: deletions + settings collapse ('feature' becomes the only
  lane) + persona picker from kernel ai_personas (needs kernel persona
  list/CRUD routes + custom-persona sync).
- [ ] Task 4: vendor-key decommission + usage-lane drain mode.
- [ ] Task 5 (ops): pilot workday → staged fleet rollout → §5 verification.
