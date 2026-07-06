> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# AI Gateway (Stage 29) and Prompt Unit (Stage 30)

This territory covers the kernel's AI subsystem: the Stage 29 gateway through which every client's generation flows (routing, budgets/quotas, the spend ledger, and the DP 6-A verbatim-capture restricted class), and the Stage 30 prompt unit (the byte-migrated prompt library, its drift/freeze pins, the seven kernel features, and the assembled-prompt parity harness). All privileged generation happens here; clients ("userspace") hold no vendor keys and assemble no prompts. Anchors are `file:line` relative to the repo root, primarily under `apps/runtime/src/modules/ai/` (prompt unit + feature service) and `apps/runtime/src/services/` (gateway core, providers, pricing).

## 1. Gateway architecture

### Entry routes

Registered in `apps/runtime/src/modules/ai/index.ts`:

- `POST /api/v1/ai/gateway/stream` (index.ts:40-47) — the raw gateway. Requires a chatter API key (`requireApiKeyUser`); calls `prepareAiGatewayStream` then `pipeAiGatewaySse`.
- `POST /api/v1/ai/features/:feature` (index.ts:99-111) — Stage 30 kernel-side prompt assembly. `prepareAiFeatureStream` builds the prompt, then rides the same gateway internals and SSE pump.
- `POST /api/v1/ai-usage/batch` (index.ts:33-38) — the legacy direct-desktop usage-ledger intake path.
- Restricted/admin routes registered separately via `registerAiAdminRoutes` (index.ts:226-270).

### Request shapes

The two entry routes take deliberately different bodies:

- **Raw gateway** — `AiGatewayStreamBody` (contracts): `clientRequestId`, `feature`, `pageLabel`, `platform` (`onlyfans`|`fansly`), `platformUserId`, `conversationId`, `model`, `reasoningEffort`, optional `temperature`/`maxTokens`, `isRegeneration`, and `prompt.{systemBlocks,userBlocks}` where each block is `{text, cache:'1h'|'5m'|'none'}`. The caller supplies the fully-assembled prompt blocks.
- **Feature route** — `AiFeatureRequestBody` (features/index.ts:47-74): **no prompt blocks**. Instead it carries `conversationRef`, `fanRef`, `personaKey`, `replyTone`, `replyMode`, `messageCount`, `draftText`, and an optional Stage-32 `clientContext` (client-loaded transcript/counts, used for Fansly). The kernel assembles the prompt from these.

Page scope is `pageLabel`, resolved via `findPageByLabel` + `canAccessPage` (ai-gateway.ts:177-184).

### Provider abstraction

The `AiGatewayProvider` interface is `{provider:"anthropic"|"openrouter"; stream(input): AsyncIterable<AiGatewayStreamFrame>}` (ai-gateway.ts:55-58). Provider selection is by **model string prefix**, with no fallback or retry between providers:

- `aiGatewayProviderForModel` returns `"openrouter"` iff the model starts with `"openrouter:"`, otherwise `"anthropic"` (ai-gateway-pricing.ts:108-110).
- `selectAiGatewayProvider` maps that to `app.aiGatewayOpenrouterProvider` vs `app.aiGatewayProvider` (ai-gateway.ts:81-88). Exactly one provider is chosen per request; an unconfigured provider yields HTTP 503 (ai-gateway.ts:254-256).

The two providers differ in vendor coupling:

- **Anthropic provider** (`services/ai-gateway-anthropic-provider.ts`) uses `@anthropic-ai/sdk` (line 1). A page-proxy client resolver (lines 136-153) builds a proxy-backed `fetch` via an undici dispatcher; a direct resolver (lines 130-134) serves the internal lane. It maps `text_delta`→`content_delta` and `thinking_delta`→`reasoning_delta` (lines 196-206).
- **OpenRouter provider** (`services/ai-gateway-openrouter-provider.ts`) uses **no vendor SDK** — a plain `fetch` POST to `https://openrouter.ai/api/v1/chat/completions` (line 25) through the shared proxy dispatcher (reusing `createAnthropicGatewayProxyFetch`, line 166), with OpenAI-compatible SSE parsing (`sseDataLines`, line 113). `cache_control` blocks flatten to plain text (`joinBlocks`, line 36).

### SSE streaming and the pump

The gateway streams SSE throughout. `serializeAiGatewaySseFrame` emits `event: ai\ndata: <json>` (ai-gateway.ts:375-377). The pump `pipeAiGatewaySse` (index.ts:116-224) hijacks the reply, writes `text/event-stream` headers, aborts the provider on client `close`, accumulates `completionText`, and always calls `recordTerminal` in a `finally` block. Frame types: `meta`, `content_delta`, `reasoning_delta`, `usage`, `error`, `done`.

## 2. Budgets and quotas

### Limits and defaults

Defined at ai-gateway.ts:29-32:

- `DEFAULT_AI_GATEWAY_DAILY_REQUEST_LIMIT = 200`
- `DEFAULT_AI_GATEWAY_DAILY_MICRO_USD_LIMIT = 5_000_000` ($5)
- `DEFAULT_AI_GATEWAY_REQUEST_MICRO_USD_LIMIT = 5_000_000` ($5)
- `AI_GATEWAY_STALE_RESERVATION_MS = 30min`

### The budget dimensions

| Budget | Scope | Where | Behavior |
|---|---|---|---|
| Daily request count + daily micro-USD | per (user, page), per UTC-day | `evaluateAiGatewayQuota` (ai-gateway.ts:135-166); totals via `getAiGatewayDailyUsageTotals` (ai-usage repo:352-376) | Accepted iff both remaining > 0 |
| Per-feature GLOBAL daily micro-USD ceiling | all principals combined | parsed from `chatMuseAiGatewayFeatureDailyMicroUsdLimits` JSON via `parseAiGatewayFeatureLimits` (ai-gateway.ts:90-109); checked via `getAiGatewayFeatureDailyTotals` (ai-usage repo:379-402) | The internal (system) lane's only guard (ai-gateway-internal.ts:87-102) |
| Per-request cost ceiling | single request | `estimateAnthropicGatewayRequestCost` / `estimateOpenrouterGatewayRequestCost` (ai-gateway.ts:257-271) | Denied if estimate > `requestMicroUsdLimit`, or if limit ≤ 0 |

### Quota-denied rows as first-class facts

A denial is written to the ledger, not merely returned as an error. `recordAiGatewayQuotaDenied` inserts a row with `gatewayOutcome="quota_denied"`, `quotaAccepted=false`, and zero usage (ai-usage repo:262-293); the route then throws `QuotaDeniedError` → HTTP 429 `{error:"quota_denied"}`. When both apply, 429 outranks 503 (ai-gateway.ts:204-206).

### Reservation flow

`reserveAiGatewayUsageEvent` inserts a zero-usage row keyed on `(userId, clientEventId)` with `quotaAccepted=true` and `gatewayOutcome=null` (ai-usage repo:222-258); a duplicate raises `ConflictError` → HTTP 409. Stale reservations (older than 30min, with a provider set and outcome still null) are marked `failed` on the next request by `markStaleAiGatewayReservationsFailed` (ai-usage repo:327-350).

### Pricing table

`ai-gateway-pricing.ts` holds a static per-model price table in **USD-per-million-tokens**, converted to integer **micro-USD** via `microUsdFromDbInt(Math.round(rawCost))` (line 177).

| Model group | Table | in | out | cacheRead | cacheWrite 5m | cacheWrite 1h |
|---|---|---|---|---|---|---|
| sonnet-4-6 / 4-5 | `ANTHROPIC_PRICING` (line 27) | 3 | 15 | 0.3 | 3.75 | 6 |
| opus-4-8 / 4-6 / 4-5 | `ANTHROPIC_PRICING` | 5 | 25 | 0.5 | 6.25 | 10 |
| haiku-4-5 | `ANTHROPIC_PRICING` | 1 | 5 | 0.1 | — | — |
| gpt-4o-mini, gpt-4.1-mini, llama-3.3-70b-instruct | `OPENROUTER_PRICING` (line 81) | (per-model) | (per-model) | (per-model) | 0 (not billed) | 0 (not billed) |

`estimateAiGatewayUsageCost` (lines 136-180) handles the 5m/1h cache-write breakdown; it sets `costApproximate=true` when a cache-write lacks an explicit breakdown or the token accounting mismatches. An unsupported model throws (fail-closed).

### Ledger schema

`ai_usage_events` (schema.ts:1657-1731): `userId` (**NULL = system lane**, FK users cascade), `pageId`, `clientEventId`, `feature` (enum), `model`, `provider` (`"anthropic"`|`"openrouter"`), `providerResponseId`, token counts, `costMicroUsd` (int, default 0), `costApproximate`, `quotaAccepted`, `gatewayOutcome`, `conversationId`, `durationMs`, `isCacheHit`, `isRegeneration`, `completedAt`, `ingestedAt`. Unique `(userId, clientEventId)`; a CHECK constrains the provider and gatewayOutcome enums.

`finalizeAiGatewayUsageEvent` UPDATEs the reserved row (using `is not distinct from` for the nullable `userId`) and returns the row id that feeds the restricted-content FK (ai-usage repo:295-325). `ingestAiUsageBatch` (ai-usage.ts:74-128) is the legacy chatter batch path — tolerant, null-skipping bad `completedAt`, returning received/inserted/invalid/deduped counts. Reporting: `listChatterUsageSummary` (ai-usage repo:404-643) surfaces per-chatter cost, gateway-outcome counts, open reservations, and provider/feature breakdowns via the owner-only route `GET /api/v1/admin/usage/chatters` (index.ts:230-236, `requireOwner`).

## 3. Verbatim prompt capture (DP 6-A restricted class)

### Table

`ai_generation_content` (schema.ts:2642-2672): `usageEventId` FK → `ai_usage_events` **onDelete restrict**, `generationRef` (unique text = gateway `requestId`), `feature`, `model`, `provider`, `userId` (FK set null), `pageId`, `conversationRef`, **`promptBlocks` jsonb NOT NULL**, **`completion` text NOT NULL**, **`params` jsonb NOT NULL**, `createdAt`.

### What's captured

`recordTerminal` (ai-gateway.ts:342-369) captures the generation verbatim:

- `promptBlocks` = `[{role:"system",blocks:systemBlocks},{role:"user",blocks:userBlocks}]`
- `completion` = the accumulated completion text
- `params` = `{maxTokens, temperature, reasoningEffort, isRegeneration, outcome, stopReason}`

**All outcomes are captured**, including cancelled generations — a partial completion is still a fact (comment ai-gateway.ts:342-346). Insert is via `insertAiGenerationContent` with `onConflictDoNothing` on `generationRef` (ai-restricted repo:24-32). The internal lane inserts through the same path (ai-gateway-internal.ts:196-218).

### Owner-only access routes

Both `requireOwner` (index.ts:238-269):

- `GET /api/v1/ai/restricted/generations` — list (`listAiGenerationContent`, filters feature/pageId/limit ≤ 50 default; ai-restricted repo:52-67).
- `GET /api/v1/ai/restricted/generations/:generationRef` — detail plus joined acceptance events (`getAiGenerationContentByRef`, ai-restricted repo:69-80).

Integration test pins: an owner reads completion `"Hello"`; a **team_lead gets 403** and a **chatter gets 401/403** (ai-restricted-class.integration.test.ts:199-223).

### Relation to the ledger's metadata-only rule

The contract doc's Privacy section (docs/ai-gateway-contract.md:224-232) states that raw prompt/reply text must NOT be persisted in the ledger/logs. The DP 6-A restricted class intentionally supersedes this for a **separate owner-only table**: the *ledger* (`ai_usage_events`) still stores only metadata, while verbatim content lives in `ai_generation_content`, gated owner-only. A volume guard exists (`getAiGenerationContentVolume`, ai-restricted repo:83-94, "monitor, trim later").

## 4. The seven features (Stage 30 Task 4)

`OPERATION_FEATURES` (feature-policies.ts:90-98) is exactly seven; the registry is derived from `FEATURE_POLICIES` (feature-policies.ts:100-206). Each feature's prompt source is a template constant in `templates.ts` (byte-synced to `templates/*.md`), and its persona/personality is a system block.

| Feature | surface / resultKind / promptMode | model (default) | earnings | gate | template |
|---|---|---|---|---|---|
| **fast-reply** | ai-dock / reply / reply | sonnet-4-6 | yes | none; `replyMode`+`replyTone` | fast-reply.md |
| **improve-draft** | ai-dock / single-reply / reply | → fast-reply | yes | **requiresDraft** | improve-draft.md |
| **help-me** | panel-tab / xml / analysis | help-me → sonnet-4-6 | yes | none | help-me.md |
| **fan-summary** | panel-tab / single-reply / analysis | **opus-4-6** | yes | **minMessages 30**; deep; refresh | fan-summary.md |
| **chat-review** | panel-tab / xml / analysis | sonnet-4-6 | yes | **minMessages 30**; deep; refresh | chat-review.md |
| **ping** | ai-dock / reply / reply | sonnet-4-6 | yes | **usesPingSegment** (blocked if segment "active") | ping.md |
| **hi-greeting** | ai-dock / reply / reply | → fast-reply | **no** | **max 10 msgs**; uses fanBio | hi-greeting.md |

Defaults: `DEFAULT_MODEL_ID='anthropic:claude-sonnet-4-6'`, `DEFAULT_FAN_SUMMARY_MODEL_ID='anthropic:claude-opus-4-6'` (feature-policies.ts:61-70); reasoning default `medium` for all (lines 72-78). Message-count buckets: quick=100, improve=25, deep=1500, ping=100, hi=25 (lines 80-86).

The feature service `prepareAiFeatureStream` (features/index.ts:95-222) validates that the feature is in the policies, enforces the draft / minMessages / hi-greeting-cap / ping-active gates, loads context (kernel-side or from `clientContext`), calls `buildPrompt`, then hands off to `prepareAiGatewayStream`.

### Features that are NOT Stage-30 kernel features

- **`scan`** exists in the ledger enum (shared/types.ts:118), the gateway per-feature max-tokens/temperature tables (ai-gateway-anthropic.ts:63,76), and the docs (docs:66) — but it is **not** in `OPERATION_FEATURES`/`FEATURE_POLICIES` and has no template.
- **`workboard-closing`** (shared/types.ts:122) is the internal-lane feature (see §8), also not an `OPERATION_FEATURE`.

## 5. The prompt unit (Stage 30)

### Library layout

Under `apps/runtime/src/modules/ai/prompts/`: `builder.ts` (assembly), `feature-policies.ts` (registry), `templates.ts` + `templates/*.md` (7 files), `personalities.ts`, `types.ts`, `escape.ts`, `prompt-manifest.json`; subdirs `context/{spending,subscription}.ts`, `output/{reply-output,split,xml}.ts`, `transcript/{format,html,index,normalize,ofapi-message,ping-segment}.ts`. The `prompts/index.ts` barrel re-exports all; the module barrel `modules/ai/index.ts` re-exports prompts+context+features (boundary rule).

### prompt-manifest.json mechanics

The manifest records the source repo `chatgoose_desktop_fable` @ commit `1db76a4ae13d…`, snapshotDate 2026-07-06, with per-file `{sourceSha256, coreSha256, byteIdenticalToSource}`. Two enforcement layers:

- **Drift pin** (tests/ai-feature-service.integration.test.ts:435-458): every migrated file's on-disk sha256 must equal the recorded `coreSha256`; all `templates/*.md` must have `byteIdenticalToSource:true`; and no template may exist outside the manifest.
- **Freeze guard** (tests/helpers/ai-parity.ts:40-71, `checkManifestAgainstSources`): hashes the **desktop source** files and asserts they still equal `sourceSha256` — a mismatch signals post-freeze tuning in the desktop repo. Runs in `ai-feature-parity.test.ts` and the signoff CLI.

The `.md` files are byte-identical; the `.ts` files carry `byteIdenticalToSource:false` (adapted imports/provenance headers). The manifest notes (line 19) that Stage 32 added `applyPlatformWording` to `builder.ts`, but the frozen `sourceSha256` stays the historical record.

### applyPlatformWording (STATIC sources only)

`applyPlatformWording` (builder.ts:50-52) is `platform==="fansly" ? text.replaceAll("OnlyFans","Fansly") : text`. It is applied **only to static sources**: template text (buildPrompt lines 346-349) and safety preambles + personality content (buildSystemBlocks lines 302-303). **Runtime data — transcript, bio, draft, spending — is never rewritten** (builder.ts:42-47 doc comment): a fan message mentioning "OnlyFans" survives verbatim. Stored wording is always OnlyFans (the Stage 30 freeze bytes); default platform is `"onlyfans"` (builder.ts:57,345). The `templates-sync` test asserts every `.md` contains "OnlyFans" and no "fansly" (ai-prompts-templates-sync.test.ts:41-46).

### Cache anchoring

`splitTemplate` (builder.ts:174-324) cuts at fixed anchors (`DRAFT_ANCHOR`/`TRANSCRIPT_ANCHOR` + `TASK_ANCHOR`) **before** substitution, so untrusted values cannot move a cache boundary. This yields 3 user blocks (static 1h / dynamic 5m / task none), falling back to a single uncached block if anchors are missing. System blocks are preamble+anchor (none) plus personality (1h). Untrusted inputs are escaped via `escapeForPrompt`; personality is interpolated raw as trusted owner content (builder.ts:263-290).

### Personalities / personas and the 0073 migration

The bundled `Lora` personality: `BUNDLED_LORA_PERSONALITY_ID='builtin:lora'`, version 2 (personalities.ts:11-13); `createBundledPersonalities` returns `[Lora]` (line 188). `reconcileBundledPersonalities` replaces stale builtin copies by version (lines 227-263).

Migration `0073_ai_personas.sql` creates `ai_personas` (key unique, `display_name`, `system_block`, `feature_overrides` jsonb, `archived_at` soft-delete; DP 9-A: single-tenant global config). `resolvePersona` (features/index.ts:76-93): if `personaKey` is given it calls `findAiPersonaByKey` (throwing BadRequest if missing) and maps stored → Personality; otherwise it defaults to the bundled Lora. Persona CRUD routes (index.ts:51-95) — list/upsert/archive — are all `requireApiKeyUser` (Stage 31 desktop picker; account→persona mappings stay client-local).

## 6. The vendor-SDK ban

`tests/ai-sdk-import-ban.test.ts` (Stage 29) greps `apps/runtime/src` + `packages` for `from "@anthropic-ai/sdk"` or `require("@anthropic-ai/sdk")` and asserts the **only** importer is `apps/runtime/src/services/ai-gateway-anthropic-provider.ts` (`SANCTIONED_SDK_IMPORTERS`, lines 9-11, 33). Enforcement is dual: an ESLint wall at edit-time plus this test. Its stated purpose (comment lines 6-8): spend/budgets/restricted-capture cannot be bypassed. The SDK `import Anthropic from "@anthropic-ai/sdk"` appears only at ai-gateway-anthropic-provider.ts:1; the OpenRouter provider deliberately uses no SDK (raw fetch).

## 7. Acceptance and parity

### Assembled-prompt parity (Stage 30 Task 5)

`tests/ai-feature-parity.test.ts` does two things: (a) the freeze guard — desktop sources match the frozen snapshot; (b) kernel and desktop assemble **byte-identical `PromptPayload`s** for ≥ 9 fixtures (the passport rule: compare assembled prompts, not outputs; differences are BLOCKERS). It skips gracefully if the sibling repo is absent. The harness `tests/helpers/ai-parity.ts` sets `DESKTOP_ROOT=/Users/dmitriy/code/chatgoose_desktop_fable`, `FROZEN_DESKTOP_COMMIT=1db76a4ae13d…`, and 9 fixtures (fast-reply×2, improve-draft, help-me, fan-summary, chat-review, ping segment-a + active, hi-greeting) at `buildParityFixtures` (lines 107-126); it imports the live desktop `buildPrompt` and compares `JSON.stringify` (lines 160-172).

### Sign-off CLI

`scripts/ai-parity-signoff.ts` is the runnable sign-off (`node --import tsx/esm scripts/ai-parity-signoff.ts`). It prints desktop HEAD vs the frozen commit, runs the freeze guard + assembled-prompt parity, and exits nonzero on any violation/difference (the authoritative run). It notes that Stage 31 Task 3 may delete the desktop library post-cutover, after which the manifest remains the historical record.

### Acceptance projection

`runAiAcceptanceProjection` (services/projections/ai-acceptance.ts) projects `desktop.ai_acceptance` observations (the Stage 11 lane) carrying a `generationRef` into `ai_acceptance_events`. The watermark sits on `projection_seq_watermarks` with account_id=0 sentinel and page 500, idempotent by the `(generationRef, lifecycle, occurredAt)` unique + watermark. Field mapping is tolerant (lines 60-68). Lifecycles: shown / copied / inserted / edited / sent. A `sent` with `edited:true` books a companion `edited` row (lines 83-96); rows without a ref or lifecycle are skipped (not fatal). The integration test pins: scanned 6, projected 5, skippedNoRef 2; a rerun is idempotent (0/0); the result order is `["copied","edited","inserted","sent","sent"]` (ai-restricted-class.integration.test.ts:259-296).

Migration `0074_ai_acceptance_copied.sql` (Stage 31) widens the `ai_acceptance_events_lifecycle_check` CHECK to add `'copied'` (Stage 29's original CHECK predated the client `cmd:ai.feedback` wiring); the allowed set becomes `('shown','copied','inserted','edited','sent')`. The `ai_acceptance_events` table is at schema.ts:2674-2694 (lifecycle text `$type` union, unique on ref+lifecycle+occurredAt, `source_observation_id`).

## 8. The internal (system) lane

The L2 workboard-closing classifier runs THROUGH the gateway as a system-lane feature. `createGatewayClosingClassifier` (workboard/closing-classifier.ts:148-175) invokes `runGatewayCompletion` (ai-gateway-internal.ts:67-222) with feature `workboard-closing`, model `anthropic:claude-haiku-4-5`, maxTokens 1536, temperature 0, **direct egress (no page proxy)**, and `userId=null` (system lane). Its spend lands in the ledger under that feature, and its content joins the restricted class. The internal lane's only budget guard is the per-feature GLOBAL daily ceiling (§2). Test pins: a usage row `{feature:"workboard-closing", user_id:null, gateway_outcome:"completed"}` plus one `generation_content` row with a verbatim JSON completion (ai-restricted-class.integration.test.ts:298-331).

## 9. Docs cross-check

`docs/ai-gateway-contract.md` is **stale relative to Stages 29–32** — it describes the R4x Anthropic-only V1 gateway:

- It says "core does not yet rebuild transcript/fan context itself" (lines 18-19) — **superseded**: the Stage 30 kernel context loaders (`modules/ai/context/index.ts`) plus the `/api/v1/ai/features/:feature` route now assemble prompts kernel-side.
- It describes only the Anthropic provider ("OpenRouter compatibility can follow", line 252) — **now implemented** as the second provider with `openrouter:` prefix routing.
- Its Privacy section forbids persisting prompt/generated text (lines 224-232) — **the ledger still complies**, but Stage 29 DP 6-A `ai_generation_content` intentionally persists verbatim content in a separate owner-only table (the doc predates it).
- Its feature list (lines 59-68) includes `scan` and omits `workboard-closing`; the current enum (shared/types.ts:112-123) has both, and neither is a Stage-30 `OPERATION_FEATURE`.
- Its pricing model list (lines 122-123) matches `ANTHROPIC_PRICING` except that the doc omits `claude-sonnet-4-6` in the R4e list wording (though it appears in the request example); the current table has all six Anthropic models.
- Quota / reservation / stale-recovery / SSE-frame descriptions (R4d–R4m) remain accurate to the current code.
