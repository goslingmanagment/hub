# ChatMuse AI Gateway Contract

Status: R4b default-off runtime gate is implemented. Provider execution, quota ledger, and
streaming are still pending.
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
  is off, return `503` before quota reservation, page lookup, or provider network. While the runtime
  provider implementation is still pending, enabling the flag authorizes only the page-scope check
  and still returns `503` before any provider call or ledger write.

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

Before provider network, core reserves quota for the `(chatter, page, feature)` request. A quota
denial emits/returns a bounded `quota_exceeded` error and must not call the provider.

Every terminal provider attempt writes one durable ledger record keyed by `(userId,
clientRequestId)` for idempotency. The ledger must preserve:

- chatter user id and page id;
- feature, model, provider, provider response id when available;
- input, output, cache-write, and cache-read token counts;
- integer micro-USD cost and whether pricing was approximate;
- cache-hit/cache-read markers;
- quota decision and regeneration marker;
- completed timestamp, duration, and terminal outcome.

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
- define cancellation semantics so desktop `ai:cancel` aborts the provider request;
- document the production validation command/API/log/DB evidence.

Production validation must use a small approved prompt and must not send any platform message.
