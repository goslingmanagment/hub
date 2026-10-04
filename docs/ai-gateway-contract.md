# ChatMuse AI Gateway Contract

Status: R4b through R4m are implemented and proxy-routed production validation passed on
2026-06-20. Controlled direct-host validation was attempted first and rolled back because
Anthropic rejected the production server egress with `403 Request not allowed`; the validated path
now uses the authenticated page's stored proxy route instead of the production host IP. Desktop
Direct AI remains the explicit fallback path until the desktop gateway rollout is accepted.
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
  the route authorizes page scope, requires that the page has a configured stored proxy, recovers
  stale gateway reservations, applies the ledger-backed daily quota preflight, and then requires an
  injected provider implementation. The production app instantiates the Anthropic provider only
  when both the gateway flag and `ANTHROPIC_API_KEY` are configured; runtime Anthropic calls are
  routed through the request page's proxy dispatcher, not direct production-host egress.

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

### Feature-lane capability header

`POST /api/v1/ai/features/:feature` (SDK helper `streamAiFeature`) reads an optional
`x-kernel-ai-capabilities` header: comma-separated tokens from `AI_STREAM_CAPABILITIES` in
`packages/contracts/src/sdk-runtime.ts` (`debug-input-v1`, `context-v1`, `split-all-v1`). A token is
compatibility negotiation ("this client understands the matching frame or field"), never
authorization.

- Server: parsed once per request by `parseAiStreamCapabilities` — one string of at most 256
  characters, split on commas, trimmed, case-sensitive, unknown tokens dropped. A longer value, or an
  array value, counts as empty. A header repeated on the wire is not an array: Node joins its lines
  into one `, `-separated string, which is parsed as usual (the union of the lines) within the same
  256-character cap. The header is not declared in the route schema, so a malformed value is ignored
  instead of failing with 400.
- `debug-input-v1` adds the `debug_input_v1` frame, still behind the
  `chatMuseAiPromptDebugEchoEnabled` kill-switch. `context-v1` adds the `context_v1` frame (below)
  and is required to send `liveTextContext`, whose answer rides that frame. It is also what lets a
  full Recap read past 1500 messages (transcript depth, below).
  `split-all-v1` is reserved for the fields that will read it; until then it changes nothing.
- SDK: the header is the union of the `capabilities` option and the legacy `debugPromptEcho` flag,
  deduplicated, in the constant's order, joined by `, `. With nothing to advertise no header is sent,
  so existing callers put exactly the same bytes on the wire as before.

### Feature-lane `context_v1` frame

A caller that advertised `context-v1` gets one more frame, `aiFeatureContextFrameSchema`: which
transcript snapshot actually served this generation. Without the token the stream is byte for byte
what it was, so a client built before the frame never meets it.

- Position: after `meta` (and after `debug_input_v1` when both are advertised), before the first
  `content_delta`.
- Lane: only a generation whose transcript the hub loaded itself (the kernel-context lane, every
  feature). A request with `clientContext` carries no frame in this version.
- Shape: the one frame that is not strict. A later key is dropped by an installed SDK instead of
  failing its stream, and the vocabularies are open strings. The known values are exported from the
  SDK (`AI_CONTEXT_SOURCES`, `CLIENT_COVERAGE_LEVELS`, `AI_KNOWN_FAN_MESSAGE_STATES`,
  `AI_CONTEXT_LIVE_STATUSES`, `AI_FAN_LANGUAGE_EVIDENCE`); a client reads an unknown one as
  "unknown".

| Field | Meaning |
|---|---|
| `generationRef` | Equals `meta.requestId`. |
| `source` | The reader whose rows became the transcript: `archive`, `union` (`aiTranscriptFreshUnionMode = serve`) or `live_union` (the Fansly socket overlay). In `shadow` mode the union is computed but the archive serves, and the frame says `archive`. |
| `servedHead` | Newest message of the served window: `{ messageRef, occurredAt, isFromFan }`. `null` for an empty window. |
| `archiveHead` | Diagnostics only: the plain archive reader's newest row. With `source: "union"` the model may have read past it. |
| `window` | `requested`: the window the request resolved to. `served`: the messages the prompt holds whole. That is the transcript the hub loaded (after normalization and the window cap), minus what the prompt itself cut: only `coach-chat` cuts, when its whole-prompt budget drops the oldest transcript lines. A line the cut runs through is not counted. |
| `coverage` | How much of the chat's history the hub can vouch for, from `ofapi_message_coverage` (`services/client-coverage.ts`). `complete`: a standing continuous-history proof under the current proof policy, and the archive has projected everything it covers. `partial`: a standing proof that does not vouch for the whole history. `unknown`: no proof, a revoked one, one under a proof policy the hub no longer accepts, or a failed lookup. A page without the capture lane (Fansly) always reads `unknown`. |
| `knownFanMessages` | One `{ id, state }` per id of the body's `knownFanMessageIds`, in the same order. Absent when the body named none. |
| `source` with fresh text | Unchanged: `source` names the hub's own reader. Text a client supplied is described by `live` alone. |
| `live` | What the hub did with the request's fresh text (`liveTextContext`, below): `{ status, accepted, rejected }`. |
| `fanLanguageEvidence` | `latin`, `cyrillic`, `mixed` or `unknown`: a rough count of the letters in the fan's latest 20 text messages of the served window. It is not language detection. |

`knownFanMessageIds` (body, optional, 1 to 10 distinct numeric ids) names fan messages the client
saw in the open chat before it asked. Ids only: no text travels, nothing is added to the prompt and
nothing is stored. It is accepted on every feature. Without `context-v1` there is no frame to answer
in and the ids are ignored. Each id is judged against the transcript that served the generation:

| State | Meaning |
|---|---|
| `included` | The served window holds the id as a fan message. |
| `deleted` | Not in the window, and tombstoned for this conversation in one of the hub's stores. The Fansly socket overlay counts only when it served (`source: live_union`). |
| `absent` | Not in the window: the hub does not hold it for this conversation, or holds it outside what the model read (older than the window, cut by the Coach prompt budget, or only in a store the serving reader did not read). |
| `unknown` | The hub cannot tell: the stores could not be read, or the window holds the id as the model's own message. |

`included` is the only answer that says the model read the message. The same window serves every
retry of a request, so an id the hub holds but that lies before the window stays `absent` however
often the client asks again: `messageCount` can be as low as 5, and ten fan messages with the
model's replies between them can span more than the 25 of Improve and Hi.

The store lookup (`packages/db/src/repositories/ai-live-context.ts`) runs only after the page was
admitted and is scoped to the page and the conversation of the request. An id that belongs to
another fan's chat on the same page reads `absent`, exactly like an id the hub has never seen: the
answer never says that a message exists, or was deleted, in a chat the caller did not name. A delete
webhook carries no chat, so its tombstone counts only for an id the hub already holds for this
conversation; a socket deletion that named no group is the same case.

The frame is built from database reads only (the transcript loader, the coverage row, the known-id
lookup): no platform request, no queued platform work and no change to a chat's unread state.
Coverage and the known-id lookup fail open: a failed read reports `unknown` and never fails the
generation. The frame is not persisted, and the recorded `params.contextManifest` is unchanged.

### Feature-lane transcript depth (`messageCount`, full Recap)

`messageCount` is the window a request asks for (5 to 3000). The hub's two transcript readers (the
archive reader and the union reader) cap every window at 1500 messages, whatever was asked: a
request for 3000 is served the newest 1500, and the `context_v1` frame says so in `window`.

One request reads past that cap, up to 3000 messages: the full Recap. All of these must hold:

- the feature is `fan-summary` and the request is not `summaryMode: "short"` (the short Recap keeps
  its window of 300);
- the page is an OnlyFans page and the hub loads the transcript itself (a request with
  `clientContext` brings its own transcript and is not read by the hub's readers at all);
- the caller advertised `context-v1`;
- the owner's live setting `aiTranscriptDeepMaxRows` is `3000`. It takes exactly `1500` or `3000`
  and rests at `1500`.

Everything else stays at 1500: `chat-review` and `coach-chat`, the reply features, a Fansly page's
hub-loaded transcript (the socket overlay union included), and every client that does not send
`context-v1`. The released desktop lets a chatter set its deep window as high as 3000; such a Recap
is served 1500, before and after the owner raises the setting.

A request that names no `messageCount` keeps the full Recap's default window of 1500. A client that
wants the deeper read asks for it, up to the bootstrap's `limits.deepMax`, which is the value of
`aiTranscriptDeepMaxRows` (`GET /api/v1/client/bootstrap`).

The recorded generation tells what was read: `params.requestedCount` is the window the request
resolved to (not clipped by the cap), `params.keptCount` is the number of messages the prompt held,
and `params.contextManifest.archiveCount` / `unionCount` are the rows each reader returned.

Cost: at 3000 the transcript of a full Recap is up to twice as long. The per-request ceiling
(`chatMuseAiGatewayRequestMicroUsdLimit`) and the daily ceilings below apply unchanged, to the
longer prompt. The read itself is the same statement and plan at either cap: both readers fetch the
whole conversation by its index and cut the tail afterwards (tombstones, stubs and duplicates are
resolved before the cap).

### Feature-lane fresh text (`liveTextContext`)

The hub's archive trails the chat a chatter is looking at by seconds to minutes. A client that
reads the open OnlyFans chat sends its last confirmed messages with the request, and the hub merges
them into the transcript it loaded itself, for that one generation
(`apps/runtime/src/modules/ai/context/live-text.ts`).

Body field (optional, strict):

```json
{ "capturedAt": "2026-10-04T10:20:00.000Z",
  "items": [{ "platformMessageId": "4301234567890", "direction": "fan",
              "occurredAt": "2026-10-04T10:19:30.000Z", "text": "are you there?" }] }
```

- `items`: 1 to 60 (`AI_LIVE_TEXT_MAX_ITEMS`), each text 1 to 5000 UTF-16 units
  (`AI_LIVE_TEXT_MAX_CHARS`); the bootstrap announces the same numbers as `freshTextMaxItems` and
  `freshTextMaxChars`. `platformMessageId` is the platform's own numeric id (no leading zero, at
  most 30 digits); `direction` is `fan` or `model`; both instants are ISO 8601 with seconds and an
  explicit offset.
- An instant is checked for its form and nothing more: the pattern is the client's own frozen one,
  so the hub accepts exactly what the client's contract does. A string of that form that names no
  instant (a leap second, a thirteenth month) is not a schema error, which would fail the whole
  request: its item is rejected by the merge (`unusable`).
- The client sends only messages the platform confirmed: never a queued (welcome, mass) or an
  unsent one, and no message that is media alone. No money, no media, no links as markup: text only.
- `capturedAt` is when the client read the page. Its form is checked and it is otherwise unused:
  nothing is decided by it, and it is not recorded.

Refused before any context loads, after the page was admitted (a client bug, never retried):

| Case | Answer |
|---|---|
| a feature other than `fast-reply`, `improve-draft`, `hi-greeting`, `ping` | 400 `bad_request`, reason `live_text_not_allowed` |
| a page that is not OnlyFans | 400 `bad_request`, reason `live_text_not_allowed` |
| together with `clientContext` | 400 `bad_request`, reason `live_text_not_allowed` |
| no `context-v1` in the capability header | 400 `bad_request`, reason `capability_required` |

Recap (full and short), Review, Coach and Help never take it: a recap built on one person's page
would be shared with everyone.

Whether it is USED is the owner's switch, and a switch that is off IGNORES the field, it never
refuses: a client's bootstrap can be up to its TTL old, and a kill switch must not fail
generations. Two conditions, both read per generation:

- `aiLiveTextContextMode` (`off` | `shadow` | `serve`, rests `off`; stepped up one mode at a time,
  rolled back freely, like `aiTranscriptFreshUnionMode`);
- the page's `freshText` flag in `chatExtensionFeatures`, by the evaluation the bootstrap announces
  (master switch, flag, platform, binding, the `live-text-v1` capability).

| `live.status` | Meaning |
|---|---|
| `not_sent` | The request carried no fresh text. |
| `disabled` | It did, and the switch is off: nothing was read from it, nothing recorded. The generation is the one without the field, byte for byte. |
| `shadow` | Merged and recorded in the context manifest; the hub's own transcript served. `accepted` is what `serve` would have added. A conflict is recorded and counted in `rejected`, never thrown: shadow changes no generation. |
| `served` | The merged transcript served. `accepted` can be 0: the hub already held every message. |
| `rejected` | `serve`, and nothing of the client's joined although something was refused (tombstoned, unusable, unverifiable, or the merge failed). The hub's transcript served. |

The merge, in `serve` and `shadow` alike:

- Only by platform message id, never by text. The hub's rows come first and win: for an id the
  transcript already holds, the hub's text stands (the page's HTML against the archive's plain text
  is not a disagreement).
- An id the hub holds as sent by the OTHER side, or under ANOTHER chat, is a conflict: the snapshot
  is not of the conversation the request names. `serve` answers 400 `context_conflict`; the message
  names message ids only. "Another chat" is another conversation of the same page, or a chat of
  another page the caller may read (the wrong page for this chat). Two pages of this hub writing to
  each other archive the same message under both; that is the same chat from its other side, not a
  conflict. A page the caller cannot read is not consulted. Another page is read in both of its
  message stores (`message_archive` and `dm_message_archive`), so a snapshot of the wrong page is
  refused even when it is made only of messages seconds old.
- A tombstone is never restored: an id deleted in any store of the page is rejected.
- A client item's text goes through `normalizeDmMessageText` and the transcript normalizer, exactly
  as an archive row does (tags and entities out). An item whose text is empty after that, whose id
  or time the transcript cannot key, whose text a normalizer fails on, or that repeats an id of the
  same snapshot is rejected.
- The result is sorted by time then id and capped to the request's window, like every transcript.
  Merging never shrinks it, so a gate that counts messages (Hi) can only tighten; the Ping segment
  and fan silence are computed over the merged window.
- The time is the client's only for a message the hub cannot place itself. An id a store of the
  page holds for this conversation outside the served transcript (older than the window, or only in
  a store the serving reader did not read) keeps the hub's time, `message_archive.occurred_at` first.
  A client's clock therefore never moves a message the hub can place: an old archived message sent
  as if it were new stays before the window and is cut (`outsideWindow`), and a message only the
  webhook store holds joins at the place the hub's own reader would give it. Such an item still
  carries the client's text, and a generation that served it is scoped like any other.
- `accepted` counts the client's items the served window holds. Items cut by the window are neither
  accepted nor rejected.

Where the client's text lives: in the restricted record of that one generation
(`ai_generation_content.prompt_blocks`), and nowhere else. It is written to no message archive, no
observation, no dossier. A generation that served at least one accepted item is recorded with
`params.contextScope = "principal-draft"`, which every shared reader skips (Shared recaps, below).
Without served fresh text the recorded `params` are exactly what they were for every feature.

`params.contextManifest.liveText` (`shadow` and `serve`) holds message ids, counts and the mode,
never a message's text or time: `source: "client-supplied"`, `mode`, `status`, `sent`, `accepted`,
`rejected`, `conflicts`, `matched` (ids the hub already held), `outsideWindow`, `headRef` and
`archiveSawHead` (the client's newest message, and whether the hub's transcript held it),
`acceptedRefs`, `rejectedRefs`, `rejectedReasons`, `conflictRefs`, `conflictReasons`. In `shadow`
this is the evidence to read before `serve`: `matched` close to `sent` proves that the ids the
client reads are the ids the hub archives; `matched: 0` beside a non-empty archive means they are
not, and `serve` must wait.

The store lookup (`lookupAiLiveTextMessages`, `packages/db/src/repositories/ai-live-context.ts`) is
one statement of point lookups on the stores' unique keys, for the ids the transcript does not
hold. It fails closed: if it cannot be read, nothing the hub cannot vouch for joins the transcript
(`unverified`), and the generation runs on the hub's own. Like the frame, fresh text costs database
reads only: no platform request, no queued platform work, no change to a chat's unread state.

The conflict in `serve` is the only way fresh text fails a request. Nothing else about it fails a
generation:

- a switch that cannot be read is a switch that is off (`disabled`);
- a lookup that fails rejects every item the hub could not vouch for (`unverified`);
- a text a normalizer throws on rejects that one item (`unusable`), and the rest of the snapshot
  is still judged;
- a merge that fails altogether rejects every item (`failed`) and the hub's own transcript serves.
  It is logged with the error's name, never its message: the failing code was reading a client's
  text.

In `shadow` nothing at all changes the generation.

## Authorization

Core must resolve `pageLabel` through the authenticated chatter's current page assignments before
any provider call. Unknown pages, unassigned pages, and platform mismatches fail as `404` or `403`
without revealing page existence to other chatters.

Provider egress is page-scoped. After authorization succeeds, core resolves the same stored
`egress_endpoints` proxy used by page/account networking. A missing page proxy fails closed with
`503` before quota reservation, ledger insertion, or provider network. This intentionally prevents
falling back to the production host IP, because Anthropic has already rejected that egress.

`platformUserId` and `conversationId` are audit and context-correlation fields. Version 1 may accept
a fan that is not yet in the core fan table only after page authorization succeeds; it must not use
an unresolved fan to widen page scope.

The chat extension's narrow device token (chat-extension H-3, `client: "chat-extension"` at sign-in)
reaches `/api/v1/ai/features/:feature` only through the owner's switches, checked before any context
load, quota reservation or provider call (`services/client-ai-switch.ts`). `coach-chat`,
`fan-summary` and `chat-review` run the full check of the page's `coach` / `recap` / `review` flag
(`requireClientFeature`); every other feature needs `chatExtensionEnabled` and an
`x-client-version` of `chat-extension/<MAJOR.MINOR.PATCH>` at or above `chatExtensionMinVersion`. A
refusal is `409 client_feature_disabled` with its `reason`. The raw gateway stream is not on the
narrow token's route list at all. The restricted generation record of a narrow token carries
`params.clientProfile = "chat-extension"`; a full token's params are unchanged.

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
`anthropic:claude-sonnet-5` (the reply and Help/Review/Coach default at low effort since Decision #273), `anthropic:claude-sonnet-4-5`, `anthropic:claude-opus-4-8`, `anthropic:claude-opus-4-6`,
`anthropic:claude-opus-4-5`, and `anthropic:claude-haiku-4-5`) and computes integer micro-USD
costs from input, output, cache-write, and cache-read tokens. Aggregate cache-write usage without
5m/1h provider breakdown is recorded as approximate. Unsupported models fail closed instead of
being silently underpriced.

R4f adds the first Anthropic provider adapter groundwork without wiring the route to provider
network. Core now builds the Anthropic Messages streaming request from the gateway body, preserving
desktop-compatible prompt-cache markers (`5m` as provider-default ephemeral, `1h` explicit),
feature temperatures, adaptive thinking caps, the no-temperature-with-thinking invariant, and the
no-sampling-params rule for every model after the 4.6 family (Opus 4.7+, Opus 5, Sonnet 5; only
`claude-haiku-4-5` / `claude-sonnet-4-5` / `claude-opus-4-5` are non-adaptive, and Opus 5 / Sonnet 5
get an explicit `thinking: disabled` when reasoning is off). `scan` is treated as the deep analysis/fan-summary
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

R4m routes Anthropic provider calls through the authorized page proxy. The runtime provider creates
an Anthropic SDK client with a proxy-backed `fetch` per gateway request, using the page's stored
proxy config and closing the dispatcher after the stream. The direct `new Anthropic({ apiKey })`
path remains available only for injected/unit-test clients; production bootstrap wires the
proxy-resolving client instead. Missing page proxy is a pre-reservation `503`, so a bad page config
does not create a quota row or accidentally call Anthropic from the production host IP.

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

### Shared recaps (chat-extension)

The restricted generation records (`ai_generation_content`: prompt blocks and completions) are
read by the owner only, with one exception: a recap is shared. `GET
/api/v1/client/pages/:pageLabel/conversations/:fanRef/recaps` (`clientConversationRecaps`,
bootstrap capability `shared-recaps-v1`) answers the text of the freshest usable full and short
`fan-summary` recap of one fan to every chatter granted the page, whoever generated them (owner
ruling: no private recap per chatter; `docs/identity-rights-matrix.md`).

- Selection: one rule for every reader of a recap, `usableFanSummaryPredicate`
  (`packages/db/src/repositories/ai-restricted.ts`): a `fan-summary` row of the slot's
  `summaryMode` with a completed outcome, a present and non-exhausted `stopReason`, a non-empty
  completion and no `params.contextScope`. `GET /api/v1/ai/recap-status`, the Coach recap attach,
  this route and the dossier's generation proof all select through it, so they always agree on
  which recap exists.
- `params.contextScope` marks a generation whose context held something only its caller saw (the
  fresh text of an open chat, `principal-draft`). Such a row is that person's draft: it is never a
  status slot, never attached to Coach, never returned here and never proves a dossier. Fresh text
  is refused on `fan-summary`, so nothing writes the key on a `fan-summary` row and the condition
  is a guard.
- `fanRef` is the OnlyFans fan id, which is the chat id. `personaDefinitionId` (optional, as on
  the recap status) narrows both slots to one persona.
- Answer: `{ full, short, fullSavedToProfile }`. A slot is `null` or `{ generationRef,
  generatedAt, personaDefinitionId, coverage: { transcriptCoverage, requestedCount, keptCount },
  text }`; `generationRef` is the generation's `meta.requestId`. `fullSavedToProfile` is true when
  the fan's latest dossier on the page has exactly the full recap's text. Never a prompt block,
  the author or the context manifest.
- It reads the database only: no generation, no AI spend, no platform request.
- Behind the owner's `recap` switch on the page (`requireClientFeature`): a refusal is `409
  client_feature_disabled` with its `reason`. The `recap` feature also needs `recap-profile-v1`,
  so the route answers `hub_not_ready` until the hub serves the dossier save as well.

### AI media describer (system lane)

The hub's background image describer (`docs/runbooks/ai-media-describe.md`) is
a second, system-only use of the Anthropic key. It is not a gateway route: no
client can call it. Its ledger rows use the ledger-only feature
`media-describe` with `user_id` NULL (never accepted on the wire), its spend is
bounded by its own agency-wide daily caps, and its restricted records omit the
image. **Custody exception (owner ruling 2026-09-27):** for this path only,
chat image bytes transit hub worker memory (downscaled, metadata stripped) on
the way to the provider; they are never written to disk, a table or a log. The
previews rule — bytes only on chatters' machines — is unchanged. Prompts carry
only the stored text description.

Feature requests: the Fansly `clientContext.media` (optional, strict) lists
the window's numbered media by id — never a URL or bytes. The hub fills ready
descriptions into those labels or, with the describer off for the page or the
feature (`fan-summary`), restores the legacy labels byte-for-byte. The client
never learns whether a description exists; the prompt debug echo shows it.

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
- route Anthropic provider calls through the authorized page/account proxy instead of direct
  production-host egress; **done in R4m, with missing proxy fail-closed before reservation**;
- document the production validation command/API/log/DB evidence; **proxy-routed live provider
  validation is recorded below**.

Production validation must use a small approved prompt and must not send any platform message.

## 2026-06-20 Direct-Host Blocker

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

## 2026-06-20 Proxy-Routed Production Validation

- Revision `1ff3ebc42d55` was deployed with
  `scripts/deploy-production.sh --mode dist-only root@45.8.230.111 --verify-url https://gosling-agency.ru`.
  API and worker labels reported `agency-hub.source-revision=1ff3ebc42d55` and dependency checksum
  `b9e2460cf2e038b7d75ad5c310424990b748fa30d55b19ad2c6b0d31a89a0227`; both containers were healthy.
- The controlled test page `lora-vip-of` was bound to an existing stored proxy route already used by
  `lora-1`, preserving the same `rate_limit_scope_key`. Runtime `page proxy-ip --page lora-vip-of`
  reported proxy exit IP `171.22.220.242`, direct exit IP `45.8.230.111`, and `Differs from direct:
  yes`.
- `ANTHROPIC_API_KEY` was installed server-side only in `.env.production` with backup
  `.env.production.pre-ai-gateway-proxy-20260620T023316Z`. The staged flag
  `chatMuseAiGatewayEnabled=true` was applied at config version 3, then API/worker were recreated.
  Fresh runtime heartbeats showed gateway `true` and zero skipped overrides.
- One owner-scoped, non-mutating gateway request used temporary chatter
  `codex-ai-validation-20260620`, page `lora-vip-of`, conversation id `518588958`, and client
  request id `8f6d988c-86bd-48dd-b8c8-7370dd7970a8`. It returned HTTP 200 with
  `Content-Type: text/event-stream` and SSE frame counts `meta=1`, `content_delta=2`, `usage=1`,
  `done=1`, `error=0`.
- The terminal ledger row for that client request id recorded provider `anthropic`, model
  `anthropic:claude-sonnet-4-6`, outcome `completed`, provider response id present, `39` input
  tokens, `19` output tokens, `402` micro-USD, quota accepted, duration `1739` ms, and page
  `lora-vip-of`. A schema check for prompt/text/message/media/url/body/content/transcript/response
  fields in `ai_usage_events` returned only `provider_response_id`.
- API/worker logs since the request contained zero matches for the validation canary and zero
  matches for the prompt phrase. They contained gateway/provider metadata lines only.
- Rollback by staged flag was tested: gateway was staged `false` at config version 4 and API/worker
  were recreated. A valid gateway request returned `503` with message
  `ChatMuse AI gateway is disabled` and wrote zero ledger rows. The flag was then restored to
  `true` at config version 5 and API/worker were recreated healthy.
- Final production snapshot after cleanup: API and worker heartbeats show read gateway `true`,
  command execution `true`, AI gateway `true`, and zero skipped overrides. Gateway ledger totals
  show one completed gateway row and zero open reservations. The temporary validation key was
  revoked and its page assignment removed.

The gateway must not fall back to direct production-host Anthropic egress. Desktop Direct AI remains
the rollback path until desktop gateway rollout is accepted and any later desktop default flip has
its own staged rollback.


### Greeting parameters (Decision 379, supersedes the mode of Decisions 333/339)

`hi-greeting` is one feature with one template. Its request parameters are
orthogonal, optional and refused with `bad_request` on every other feature:

- `variantCount: 1 | 3`: how many greetings the task block asks for. 3 is the
  chat Hi overlay (variants split by `[VARIANT]`), 1 is the New Followers queue
  draft. Resolved as `variantCount ?? (greetingMode === "new-follower" ? 1 : 3)`.
- `clientContext.personalMessageCount` (`0..messageCount`): messages in the
  window that are not automatic or mass sends. When present, the
  `gate_hi_greeting_limit` gate (limit 10) counts it instead of `messageCount`.
  The OnlyFans kernel-context lane has no automation evidence and keeps counting
  every message.
- `clientContext.fanUsername` and `clientContext.fanAvatarUrl` (HTTPS Fansly
  host only; passed to the provider as an image, never fetched by the kernel).

`greetingMode: "new-follower"` is a DEPRECATED ALIAS kept for released clients
(extension <= 2.4.3, of-desktop), with its earlier semantics unchanged: it
requires explicit `fanRef === conversationRef` (OnlyFans refs must be numeric
native ids, Fansly requires clientContext), implies one message when
`variantCount` is absent, and skips the freshness gate. OnlyFans keeps
server-loaded transcript/profile context and rejects clientContext. Page access,
platform matching, persona revision, quotas and restricted capture are
unchanged. A greeting is a reviewed draft; the kernel neither sends a message
nor certifies live first-contact eligibility.
