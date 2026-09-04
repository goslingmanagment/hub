# AI Gateway Contract

> Living contract. Exact wire schemas live in
> `packages/contracts/src/routes.ts`; route behavior lives under
> `apps/runtime/src/modules/ai/` and `apps/runtime/src/services/ai-gateway.ts`.
> Historical rollout evidence belongs in Git and the decision archive.

Decision authority: #105, #108, #111, #115, #120, #136, #140, #167,
#174, #179, #182-#184, #201, and #204.

## Boundary

Core owns:

- provider keys and provider selection;
- page authorization and page-scoped proxy egress;
- personas, context loading, prompt assembly, and prompt-policy gates;
- request and feature budgets;
- provider streaming, terminal classification, usage/cost ledger writes, and
  restricted generation capture.

Clients own request ids, feature inputs, local UI state, and rendering. They do
not contain vendor SDKs, vendor keys, prompt assembly, or a local generation
fallback. Disabling the kernel gateway disables generation; it does not restore
Direct AI (#111).

## Client generation route

`POST /api/v1/ai/features/{feature}` is the steady-state client surface.

- Auth: bearer API key or device token, with page scope enforced server-side.
- Response: `text/event-stream`.
- Params/body/frames: `aiFeatureStreamParamsSchema`,
  `aiFeatureStreamBodySchema`, and `aiFeatureStreamFrameSchema`.
- Current features are derived from `OPERATION_FEATURES` in
  `prompts/feature-policies.ts`: `fast-reply`, `improve-draft`, `help-me`,
  `fan-summary`, `chat-review`, `ping`, `hi-greeting`, `coach-chat`, and
  `voice-script`. The code registry is authoritative.

Every request supplies a stable UUID `clientRequestId`, page/platform identity,
and conversation identity. Optional fields are feature-gated; the strict schema
and feature service reject fields that do not belong to the selected feature.
Important examples:

- `improve-draft` and `voice-script` require `draftText`;
- `coach-chat` requires either `chatterQuestion` or `preset: "situation"`, and
  may replay at most 20 completed exchanges;
- `summaryMode: "short"` is fan-summary-only;
- `voice-script` is Fansly-only and also requires the voice-notes page gate,
  provider configuration, and a page voice profile.

The route resolves `pageLabel` through the caller's current assignments and
requires the stored platform to match. Missing, unassigned, and mismatched
pages share the same not-found boundary.

### Context and prompt assembly

Core selects the persona, loads permitted context, applies the feature policy,
escapes untrusted values, and assembles the prompt.

- OnlyFans context is loaded from kernel stores. A client cannot override it.
- `clientContext` is accepted only for Fansly, whose source conversation is
  read live by the client while the kernel archive remains pull-cadenced.
  Templates, persona text, policies, and platform wording still remain in Core.
- `expectedPersonaDefinitionId` is an optimistic precondition. A changed or
  archived definition returns a structured refresh failure.
- Migrated prompt assets and their approved post-freeze additions are pinned by
  `apps/runtime/src/modules/ai/prompts/prompt-manifest.json` and tests.

An assembled-prompt debug frame is available only when the server switch is on
and the caller advertises the matching capability. It is memory-only and must
not be logged or persisted (#140).

## Low-level compatibility route

`POST /api/v1/ai/gateway/stream` remains a low-level compatibility/internal
route. It accepts already assembled prompt blocks using
`aiGatewayStreamBodySchema` and shares authorization, egress, budgets, provider
execution, streaming, and accounting with the feature route.

New client features must use `/ai/features/{feature}`. The raw route is not
permission to reintroduce prompt assembly or provider logic into a client.

## Personas and recap metadata

- `GET /api/v1/ai/persona-catalog` is the client steady-state metadata route; it
  returns no system prompt text.
- `GET /api/v1/ai/recap-status` returns recap provenance only and performs no
  generation or spend.
- `GET /api/v1/ai/personas` and the API-key persona write routes are transitional
  legacy surfaces for shipped clients.
- `GET /api/v1/admin/ai/personas` is owner-only and may read full definitions.
  Admin create/update/archive routes are registered but intentionally fail
  closed until legacy bearer writes are removed.

## Egress, budgets, and idempotency

The gateway is boot-gated by `CHATMUSE_AI_GATEWAY_ENABLED`. After page
authorization it requires that page's stored proxy. Missing proxy or provider
configuration fails before provider network; there is no direct production-host
egress fallback.

Default guards are:

- 500 requests and $10 per chatter/page/UTC day (#120);
- $5 estimated maximum per request;
- optional global per-feature daily cost ceilings.

Zero blocks the corresponding lane. A quota rejection is a durable
`quota_denied` ledger fact and returns HTTP 429. An accepted request reserves
`(user_id, clientRequestId)` before provider execution; reuse returns 409, so a
retry cannot create a second paid call. Reservations older than 30 minutes are
recovered as failed.

## Stream and terminal rules

SSE uses event name `ai`; each `data:` payload is one frame:

- `meta` — request, feature, page, model/provider, quota, and optional persona,
  recap, or preset provenance;
- optional `debug_input_v1` — capability-gated assembled prompt echo;
- `content_delta` / `reasoning_delta`;
- `usage`;
- `error` — bounded code/message/retry delay, never a raw provider body;
- `done` — successful terminal stop reason.

A provider stream without usage is failed, not silently accepted. Coach output
over 64,000 characters is aborted and fails without `done`, so it cannot be
committed and replayed as a valid history answer.

Every accepted provider attempt finalizes the usage row and stores prompt,
completion, params, provenance, and terminal outcome in the restricted
generation class. This data is excluded from the generic lake, is
erasure-reachable, and must not enter ordinary logs. Client disconnects abort
the provider signal and settle as cancelled; provider failures use bounded,
provider-text-free classifications.

## Change rule

Keep this file at the invariant level. Schema fields, status codes, and feature
gates change in code and tests first; update this contract in the same change.
Deployment revisions, test counts, and rollout transcripts stay in Git history,
not here.
