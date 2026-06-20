# ChatMuse AI Gateway Contract

Status: R4b through R4l are implemented. Controlled production validation was attempted on
2026-06-20 and rolled back because Anthropic rejects the production server egress with
`403 Request not allowed`. Desktop Direct AI remains the active path.
Decision owner: core Decision #26.

## Boundary

Core owns provider key custody, chatter/page authorization, request quota decisions, provider
network calls, streaming fanout, and the durable AI cost ledger. Desktop owns the local composer,
prompt/context building, optimistic UI, output parsing, and rollback to direct provider mode until
the gateway is deployed and validated.

Version 1 is a prompt-streaming gateway. Desktop sends the prompt blocks it already builds today;
core does not yet rebuild transcript/fan context itself. Moving context construction into core is a
later gateway version and must preserve the same feature and output contracts.

## Planned Route

`POST /api/v1/ai/gateway/stream`

- Auth: chatter API key only.
- Response: `text/event-stream`.
- Request schema: `aiGatewayStreamBodySchema` in `packages/contracts/src/routes.ts`.
- Frame schema: each SSE `data:` payload is one `aiGatewayStreamFrameSchema` JSON object.
- Runtime flag: `CHATMUSE_AI_GATEWAY_ENABLED`, default `false`, staged boot-applied. When the flag
  is off, return `503` before quota preflight, page lookup, or provider network. With the flag on,
  the route authorizes page scope, recovers stale gateway reservations, applies the ledger-backed
  daily quota preflight, and then requires an injected provider implementation. The production app
  instantiates the Anthropic provider only when both the gateway flag and `ANTHROPIC_API_KEY` are
  configured.

## Request

```json
{
  "clientRequestId": "uuid",
  "feature": "fast-reply",
  "pageLabel": "lora-of",
  "platform": "onlyfans",
  "platformUserId": "123456789",
  "conversationId": "123456789",
  "model": "anthropic:claude-sonnet-4-6",
  "reasoningEffort": "low",
  "temperature": 0.7,
  "maxTokens": 1024,
  "isRegeneration": false,
  "prompt": {
    "systemBlocks": [{ "text": "system text", "cache": "1h" }],
    "userBlocks": [{ "text": "user text", "cache": "5m" }]
  }
}
```

Allowed `feature` values are exactly the AI usage ledger enum:

- `fast-reply`
- `improve-draft`
- `help-me`
- `fan-summary`
- `chat-review`
- `scan`
- `ping`
- `hi-greeting`

Desktop-only `compare` remains a local orchestration mode and must be reported/submitted as the
underlying feature operations, currently `fast-reply`.

Prompt block `cache` values are `1h`, `5m`, or `none`, matching the desktop prompt builder. Core
may forward these hints to a provider cache-control mechanism, but raw prompt text must not be
stored in the durable ledger or logs.

## Stream Frames

Core emits SSE frames with event name `ai` and JSON data matching the exported frame schema:

- `meta`: accepted request id, client request id, feature, page, model, provider, optional provider
  response id, and quota snapshot.
- `content_delta`: user-visible text chunk.
- `reasoning_delta`: optional debug/reasoning chunk. Desktop may ignore it outside debug surfaces.
- `usage`: final or updated token/cost metrics, provider response id, and cache-hit marker.
- `error`: bounded code/message/retry-after; no raw provider body.
- `done`: terminal stop reason.

The stream is the only successful response body. Core must not buffer a full provider response and
return it as JSON on success.

## Authorization

Core must resolve `pageLabel` through the authenticated chatter's current page assignments before
any provider call. Unknown pages, unassigned pages, and platform mismatches fail as `404` or `403`
without revealing page existence to other chatters.

`platformUserId` and `conversationId` are audit and context-correlation fields. Version 1 may accept
a fan that is not yet in the core fan table only after page authorization succeeds; it must not use
an unresolved fan to widen page scope.

## Quota and Ledger

Before provider network, core checks quota for the `(chatter, page, feature)` request. R4d adds a
UTC-day preflight over existing gateway ledger rows with these env-only defaults:

- `CHATMUSE_AI_GATEWAY_DAILY_REQUEST_LIMIT=200`
- `CHATMUSE_AI_GATEWAY_DAILY_MICRO_USD_LIMIT=5000000` ($5.00)

The guard is per chatter/page and returns `429 rate_limit_exceeded` before provider execution when
either remaining request count or remaining micro-USD budget is `0`. Setting either value to `0`
blocks provider attempts. The later provider slice must still make reservation/finalization atomic
around the actual provider attempt and final cost.

R4e adds the first Anthropic pricing utility for terminal gateway usage rows. It supports the
desktop Anthropic model ids currently accepted by ChatMuse (`anthropic:claude-sonnet-4-6`,
`anthropic:claude-sonnet-4-5`, `anthropic:claude-opus-4-8`, `anthropic:claude-opus-4-6`,
`anthropic:claude-opus-4-5`, and `anthropic:claude-haiku-4-5`) and computes integer micro-USD
costs from input, output, cache-write, and cache-read tokens. Aggregate cache-write usage without
5m/1h provider breakdown is recorded as approximate. Unsupported models fail closed instead of
being silently underpriced.

R4f adds the first Anthropic provider adapter groundwork without wiring the route to provider
network. Core now builds the Anthropic Messages streaming request from the gateway body, preserving
desktop-compatible prompt-cache markers (`5m` as provider-default ephemeral, `1h` explicit),
feature temperatures, adaptive thinking caps, the no-temperature-with-thinking invariant, and the
`claude-opus-4-8` no-sampling-params rule. `scan` is treated as the deep analysis/fan-summary
tuning profile until desktop exposes a separate gateway operation contract. The same slice
normalizes Anthropic usage into the terminal ledger cost shape, including 5m/1h cache-write
breakdown when the provider supplies it.

R4g wires the runtime route to the SSE framing contract behind an `AppContext.aiGatewayProvider`
execution seam. The route emits an initial `meta` frame, streams provider frames as `event: ai`,
aborts the provider signal on client disconnect, and converts provider failures to bounded `error`
frames without echoing prompt text or raw provider bodies. The production app context does not yet
instantiate a provider, so runtime behavior remains fail-closed before external network. Terminal
ledger writes are intentionally still pending until the real provider path and atomic quota
reservation/finalization land together.

R4h adds terminal ledger finalization around the provider seam. A completed provider stream records
one `ai_usage_events` row with page, provider, provider response id, quota decision, usage, cost,
cache-hit marker, regeneration marker, duration, and `gateway_outcome='completed'`. Provider
failures and client cancellations record bounded terminal rows with zero usage when no provider
usage was observed. Existing `(user_id, client_event_id)` idempotency prevents duplicate rows, but
it does not yet prevent a duplicate provider attempt before the row exists; that requires the
future atomic reservation slice.

R4i makes reservation/finalization atomic enough for the first live provider path: after auth,
page authorization, quota preflight, and provider availability checks, core inserts a zero-usage
reservation row keyed by `(user_id, client_event_id)` before calling the provider seam. Duplicate
client request ids return `409 conflict` before provider execution, so a retry cannot start a
second paid provider call. Terminal handling updates the same row to `completed`, `failed`, or
`cancelled`.

R4j adds the real Anthropic provider adapter. When `CHATMUSE_AI_GATEWAY_ENABLED=true` and
`ANTHROPIC_API_KEY` is configured, the runtime app context can instantiate an Anthropic Messages
streaming provider. The adapter uses the R4f request builder, passes the route abort signal into
the SDK request, maps text/thinking deltas to gateway frames, converts provider usage to integer
micro-USD cost, and emits the terminal `done` frame. Tests use an injected fake Anthropic client;
production validation must still use a small approved prompt and must not send any platform
message.

R4k adds bounded stale-reservation recovery before new provider attempts. After page authorization
and before quota preflight, core marks gateway reservation rows older than 30 minutes with null
`gateway_outcome` as terminal `failed`, records a nonnegative duration, and leaves token/cost counts
at zero. `completed_at` remains the original reservation timestamp so quota and audit attribution
stay on the day the request was accepted. Recovery logs include only counts and the stale threshold,
not prompt text, generated text, or provider bodies.

Default-off production rollout (2026-06-19): revision `bf249a4c33c0` was deployed with
`scripts/deploy-production.sh --mode dist-only` and verified by the deploy script against
`https://gosling-agency.ru`. API and worker image labels reported
`agency-hub.source-revision=bf249a4c33c0` and dependency checksum
`b9e2460cf2e038b7d75ad5c310424990b748fa30d55b19ad2c6b0d31a89a0227`; both containers were
healthy. Production DB validation showed the AI gateway ledger columns present and `0` gateway
rows / `0` stale open reservations. Latest api/worker runtime heartbeats had
`chatMuseAiGatewayEnabled=false`, `anthropicApiKey=unset`, request cap `200`, micro-USD cap
`5000000`, `ofapiDesktopCommandExecutionEnabled=false`, and `skippedOverrides=0`. This rollout did
not perform a provider call or platform message send.

R4l extends owner-visible usage reporting before live enablement. `GET /api/v1/admin/usage/chatters`
now includes per-chatter micro-USD cost, approximate-cost marker, gateway request/outcome counts,
open reservation count, provider cost breakdown, and per-feature cost fields. The Usage dashboard
shows a compact Cost column plus gateway details in the expanded chatter row. These surfaces read
only ledger metadata; they do not store or display prompt text, generated text, or raw provider
bodies.

R4l production rollout (2026-06-19): revision `736d37c66549` was deployed with
`scripts/deploy-production.sh --mode dist-only` and verified against `https://gosling-agency.ru`.
API and worker labels reported `agency-hub.source-revision=736d37c66549`; the production reporting
repository ran against real data with `rowCount=5`, `activeRows=2`, `hasCostField=true`, and
`hasGatewayField=true`. Gateway totals stayed `0` (`totalGatewayRequests=0`,
`openReservations=0`) because live gateway execution remains disabled.

Every terminal provider attempt writes one durable ledger record keyed by `(userId,
clientRequestId)` for idempotency. The existing `ai_usage_events` table now has gateway metadata
columns for this record:

- chatter user id (`user_id`) and page id (`page_id`);
- feature, model, provider, provider response id when available;
- input, output, cache-write, and cache-read token counts;
- integer micro-USD cost (`cost_micro_usd`) and whether pricing was approximate;
- cache-hit/cache-read markers;
- quota decision (`quota_accepted`) and regeneration marker;
- completed timestamp, duration, and terminal outcome (`gateway_outcome`).

The existing `/api/v1/ai-usage/batch` endpoint remains during migration for direct desktop mode.
When gateway mode is active for a request, desktop must not also submit a duplicate usage event for
that same generation.

## Privacy and Retention

Core may stream prompt text to the selected provider, but must not persist raw prompt text,
transcript text, generated reply text, or raw provider error bodies in the AI ledger, audit events,
runtime logs, or diagnostics exports. Logs may include request ids, page id, chatter id, feature,
model, provider, provider response id, bounded error code/class, token counts, and cost.

Provider response ids are audit metadata; they are not a substitute for storing prompt or response
content.

## Rollback

Desktop local provider keys stay supported until all of these are true:

1. Gateway route is deployed default-off.
2. Gateway is enabled for a controlled production validation.
3. Streaming output, cancellation, quota denial, ledger rows, and admin usage reporting are proven.
4. Disabling the gateway flag returns desktop to direct provider mode when local keys are present.

Removing local desktop LLM keys or forcing gateway mode is a later decision.

## Implementation Gates

Before runtime implementation:

- keep the exported contract schemas and tests green;
- add a default-off gateway flag and staged/runtime config copy; **done in R4b gate slice**;
- choose the first provider path explicitly (Anthropic first; OpenRouter compatibility can follow);
- add/extend ledger storage for provider response id, page id, provider, cost, quota, and outcome;
  **done in R4c storage slice**;
- add a ledger-backed daily quota preflight before provider execution; **done in R4d quota slice**;
- add Anthropic gateway pricing for terminal ledger rows; **done in R4e pricing slice**;
- add Anthropic request-building/usage-normalization parity with desktop direct mode; **done in R4f
  provider adapter groundwork**;
- define cancellation semantics so desktop `ai:cancel` aborts the provider request; **route-level
  provider abort signal is in place in R4g and cancelled terminal rows are recorded in R4h; desktop
  cancel transport and provider SDK wiring remain pending**;
- make reservation/finalization atomic so duplicate client request ids cannot start duplicate
  provider attempts; **done in R4i for the first provider seam**.
- add the real Anthropic SDK provider path; **done in R4j, default-off through the gateway flag and
  absent unless `ANTHROPIC_API_KEY` is configured**;
- recover stale gateway reservations after process death without exposing payload text; **done in
  R4k before quota preflight on the next authorized gateway request**;
- expose gateway cost/outcome metadata in owner usage reporting before live enablement; **done in
  R4l**;
- document the production validation command/API/log/DB evidence; **default-off deploy evidence is
  recorded above; live provider validation remains pending**.

Production validation must use a small approved prompt and must not send any platform message.

## 2026-06-20 Controlled Production Validation

- The operator workstation used the configured key to call Anthropic `/v1/models` successfully;
  `claude-sonnet-4-6` was available. The same minimal Messages request returned HTTP 200 and the
  expected short output, proving key/model/request compatibility.
- Production was changed reversibly: `.env.production` was backed up, the same key was installed
  without printing it, `chatMuseAiGatewayEnabled=true` was written through the audited staged
  config, and API/worker were recreated. Both heartbeats reported gateway `true`, key `set`, and
  zero skipped overrides.
- One gateway request reserved client id `d98c86d8-8215-47e7-9450-4e25054970c8`. The SSE stream
  emitted `meta,error`; the ledger finalized it as `failed` with zero tokens, zero cost, and a
  bounded duration. No platform message was sent.
- A non-generating `/v1/models` probe from inside the production API container returned
  `403 forbidden: Request not allowed`, while the workstation probe returned 200. This isolates
  the blocker to production egress/IP acceptance rather than the gateway contract, key, model,
  quota, or request builder.
- Core logs contained request ids and `errorName` only; they did not contain prompt or output text.
- Rollback restored the prior `.env.production`, staged gateway `false` at version 2, and recreated
  API/worker. Current heartbeats report gateway `false`, key `unset`, and zero skipped overrides.

The gateway must not become the desktop default until the production egress/IP is accepted by
Anthropic or a separately contracted provider adapter is implemented and validated.
