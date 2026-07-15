> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# AI gateway, features, personas, and prompts

The AI subsystem has two layers. `apps/runtime/src/services/ai-gateway.ts` owns
provider execution, page egress, quota reservation, spend settlement, and
restricted generation capture. `apps/runtime/src/modules/ai/` owns the HTTP
surface, feature policy, context loading, persona resolution, prompt assembly,
output normalization helpers, and owner-only restricted reads.

## HTTP surface

`apps/runtime/src/modules/ai/index.ts` registers:

- `POST /api/v1/ai/gateway/stream`: a bearer-only raw prompt-block lane.
- `POST /api/v1/ai/features/:feature`: a bearer-only feature lane that builds
  the prompt in Core and uses the same gateway/SSE pump.
- `POST /api/v1/ai-usage/batch`: compatibility intake for client-recorded usage.
- `GET /api/v1/ai/personas`: transitional bearer route returning active
  persona prompt text.
- `GET /api/v1/ai/persona-catalog`: bearer metadata catalog containing key,
  display name, revision, opaque `definitionId`, and active/archived status;
  it does not return prompt text.
- `PUT` and `DELETE /api/v1/ai/personas/:key`: transitional bearer lifecycle
  routes. An omitted expected version retains legacy behavior; numeric versions
  provide compare-and-swap conflict detection.
- `/api/v1/admin/ai/personas`: owner-session full-text reads. The registered
  owner mutation handlers currently fail with a conflict because
  `ADMIN_PERSONA_MUTATIONS_ENABLED` is false.
- `GET /api/v1/ai/restricted/generations` and its `:generationRef` detail:
  owner-only access to captured prompts, completions, parameters, and linked
  acceptance events.
- `GET /api/v1/admin/usage/chatters`: owner usage aggregation.

Route schemas and authorization declarations live in
`packages/contracts/src/routes.ts`; handler-level guards additionally require
bearer credentials for client lanes and owner cookie sessions for restricted
content.

## Gateway execution and SSE

`prepareAiGatewayStream` in `apps/runtime/src/services/ai-gateway.ts` resolves
the requested page by label, checks principal page access and platform match,
requires a stored page proxy, and selects a provider by model prefix:
`openrouter:*` selects OpenRouter and every other supported model selects
Anthropic. Supported model names and per-million token prices are explicit in
`apps/runtime/src/services/ai-gateway-pricing.ts`.

Before provider execution the gateway:

1. marks reservations older than 30 minutes failed;
2. checks per-user/per-page UTC-day request and micro-USD limits;
3. checks an optional global per-feature daily micro-USD ceiling;
4. estimates the worst-case request cost against the per-request ceiling; and
5. inserts a unique reservation in `ai_usage_events`.

A rejected quota attempt is itself recorded with
`gateway_outcome=quota_denied`. Successful reservations settle in the
`recordTerminal` path as completed, failed, or cancelled. Usage includes input,
output, cache-write and cache-read tokens, provider identity, approximate-cost
status, duration, and cache hit.

`pipeAiGatewaySse` in `apps/runtime/src/modules/ai/index.ts` emits a meta frame,
an optional feature debug frame, provider deltas, usage, errors, and a terminal
done frame. Client disconnect aborts the provider. A stream that emitted content
without usage is failed as `provider_usage_missing`. Connect failures are
classified through `packages/shared/src/http-client.ts`; unreachable page
proxies surface as `provider_proxy_unreachable`, while other stream failures use
`provider_stream_failed`.

The Anthropic provider in
`apps/runtime/src/services/ai-gateway-anthropic-provider.ts` uses the vendor SDK
through the page proxy and makes connect failures sticky within one generation
so SDK retries do not repeatedly dial a dead proxy. The OpenRouter provider in
`apps/runtime/src/services/ai-gateway-openrouter-provider.ts` uses the
OpenAI-compatible streaming endpoint through the same page proxy. The internal
completion lane in `apps/runtime/src/services/ai-gateway-internal.ts` is direct
egress, uses `user_id=NULL`, and is currently used by the workboard closing
classifier; it still reserves, settles, prices, and captures content.

## Restricted content and acceptance

The terminal path for every prepared stream finalizes its reserved usage row
and writes `ai_generation_content` through
`packages/db/src/repositories/ai-restricted.ts`. Quota denials remain usage-ledger
facts, and failures before reservation do not create generation-content rows.
The restricted row contains the gateway generation reference, prompt blocks,
accumulated completion (including partial content on failure/cancellation),
model/provider, principal/page/conversation references, and execution
parameters. `ai_acceptance_events` links lifecycle
facts (`shown`, `copied`, `inserted`, `edited`, `sent`) to the same generation
reference. `apps/runtime/src/services/projections/ai-acceptance.ts` projects
captured client events into that table.

## Feature lane and context

`apps/runtime/src/modules/ai/prompts/feature-policies.ts` defines seven operation
features: `fast-reply`, `improve-draft`, `help-me`, `fan-summary`,
`chat-review`, `ping`, and `hi-greeting`. It pins result type, prompt mode,
message-window bucket, model delegation, deep-feature message minimums, draft
requirements, reply tone/mode support, ping segmentation, and dossier support.
`compare` is an orchestrating client feature rather than a single Core
operation.

`apps/runtime/src/modules/ai/features/index.ts` resolves the stored persona and
its `definitionId`, applies an optional definition precondition, loads or
accepts context, builds the prompt, and delegates to the gateway. Only Fansly
may use the client-context lane. Kernel context loaders under
`apps/runtime/src/modules/ai/context/` provide transcript, display name, bio,
spend, subscription, and optional fan dossier data.

Transcript selection has a live `off | shadow | serve` mode. The union path in
`packages/db/src/repositories/ai-transcript-union.ts` combines archive material
with fresher page-DM data and records counts/heads in the restricted generation
context manifest. Dossier injection is independently narrowed by the live
`chatMuseAiFanProfileContextFeatures` allowlist and is fail-open on lookup
errors.

When both the request capability `debug-input-v1` and the live
`chatMuseAiPromptDebugEchoEnabled` switch are present, the feature lane emits
the exact assembled prompt in an additive debug SSE frame. The raw gateway lane
does not create that frame. Capability parsing and size bounds are in
`apps/runtime/src/modules/ai/prompt-debug-echo.ts`.

## Personas

Persona persistence is implemented by
`packages/db/src/repositories/ai-personas.ts`. Rows retain archived tombstones
and a monotonic revision. `apps/runtime/src/modules/ai/persona-definition.ts`
derives an opaque content identity from key, display name, and exact system
block. Feature requests may send `expectedPersonaDefinitionId`; mismatch or an
archived/missing expected persona is rejected before quota reservation and
provider execution. An omitted persona key resolves to the stored
`builtin:lora` row rather than source prompt bytes.

Bundled persona seeding is create-only: an existing active row or archived
tombstone is not overwritten. The metadata catalog is the client steady-state
read boundary; full prompt text remains available on the transitional legacy
bearer route and the owner admin read route.

## Prompt unit

The prompt library is under `apps/runtime/src/modules/ai/prompts/`:

- `builder.ts` assembles safety preambles, persona, static templates, dynamic
  context, tone, reply-mode, and task blocks.
- `templates.ts` and `templates/*.md` contain the seven feature templates.
- `feature-policies.ts`, `types.ts`, and `personalities.ts` define policy and
  vocabulary.
- `context/` formats spending and subscription sections.
- `transcript/` normalizes and formats platform message material.
- `output/` splits `[NEXT]`/`[VARIANT]`, strips known meta leaks, sanitizes
  insertable parts, and parses XML-shaped feature output.

`applyPlatformWording` rewrites static prompt sources from OnlyFans to Fansly;
runtime transcript, profile, bio, and other user data are not rewritten. Prompt
blocks carry `1h`, `5m`, or `none` cache hints. Static fan-agnostic material is
the 1-hour prefix, dynamic fan material is 5-minute, and task overrides are
uncached.

`prompt-manifest.json` records the historical desktop source hash and current
Core hash for each migrated file. The manifest drift test recomputes every
current hash. Post-freeze template changes carry explanatory notes while the
historical `sourceSha256` remains unchanged.

## Configuration and enforcement pins

AI config descriptors are in `packages/shared/src/config-registry.ts`. They
cover the boot-applied gateway switch, request/day/feature cost ceilings,
Anthropic and OpenRouter keys, transcript union mode, dossier allowlist, and
prompt debug echo. `tests/ai-sdk-import-ban.test.ts` limits vendor AI SDK imports
to provider code. Prompt assembly, platform wording, output sanitation,
provider framing/pricing, persona lifecycle, restricted capture, transcript
union, and feature parity have dedicated tests under `tests/ai-*.test.ts`.
