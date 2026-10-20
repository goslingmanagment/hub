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

- Auth: owner cookie session only. A raw prompt on the agency's provider keys is owner content, so
  no device token of any role or client profile is admitted. Every client streams through
  `POST /api/v1/ai/features/:feature`, where the hub assembles the prompt itself; the sections
  below describe the shared gateway internals both routes use.
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
- `coach-chat`
- `voice-script`
- `fan-notes-fill`

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
`packages/contracts/src/sdk-runtime.ts` (`debug-input-v1`, `context-v1`, `split-all-v1`,
`coverage-check-v1`, `hi-start-proof-v1`). A token is
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
- `split-all-v1` lets `replyMode: "preferSplit"` reach `ping`, `hi-greeting` and `coach-chat` on a
  page whose owner switched the `splitAll` flag on (see "Split for Ping, Hi and Coach drafts"
  below). It adds no frame.
- `coverage-check-v1` adds the `coverageCheck` answers to the `context_v1` frame, so it means
  something only beside `context-v1` (see "Feature-lane window coverage check" below). The
  bootstrap lists the same name among the capabilities this hub serves: a client sends the body's
  `coverageCheck` only to a hub that lists it, since an older hub's strict body refuses the field.
- `hi-start-proof-v1` moves Hi on a Fansly page, for a request without `clientContext`, to the
  start-proof gate, and is required to send `startProof`, `personalMessageCount` and the top-level
  `fanAvatarUrl` (see "Hi on Fansly by the start proof" below). It adds no frame. The bootstrap lists
  the same name: a client sends those fields only to a hub that lists it.
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
  `AI_CONTEXT_LIVE_STATUSES`, `AI_FAN_LANGUAGE_EVIDENCE`, `AI_CONTEXT_PAIR_STATES`,
  `AI_COVERAGE_CHECK_WINDOW_STATES`, `AI_COVERAGE_CHECK_DELETED_STATES`); a client reads an unknown
  one as "unknown".

| Field | Meaning |
|---|---|
| `generationRef` | Equals `meta.requestId`. |
| `source` | The reader whose rows became the transcript: `archive`, `union` (`aiTranscriptFreshUnionMode = serve`) or `live_union` (the Fansly socket overlay). In `shadow` mode the union is computed but the archive serves, and the frame says `archive`. |
| `servedHead` | Newest message of the served window: `{ messageRef, occurredAt, isFromFan }`. `null` for an empty window. |
| `archiveHead` | Diagnostics only: the plain archive reader's newest row. With `source: "union"` the model may have read past it. |
| `window` | `requested`: the window the request resolved to. `served`: the messages the prompt holds whole. That is the transcript the hub loaded (after normalization and the window cap), minus what the prompt itself cut: only `coach-chat` cuts, when its whole-prompt budget drops the oldest transcript lines. A line the cut runs through is not counted. |
| `coverage` | How much of the chat's history the hub can vouch for, from the per-chat history proof of the page's platform (`services/client-coverage.ts`); a failed lookup reads `unknown`. OnlyFans, from `ofapi_message_coverage`: `complete`: a standing continuous-history proof under the current proof policy, and the archive has projected everything it covers; `partial`: a standing proof that does not vouch for the whole history; `unknown`: no proof, a revoked one, or one under a proof policy the hub no longer accepts. Fansly, from the Sync Engine's chain (the thread's effective `page_dm_threads.history_state`, chat-extension R20 HF-8д): `complete` when the chain is proven down to the chat's first message, `unknown` otherwise (a `partial` chain proves only a newest stretch; `unverified`, `none` and a chat without a thread prove nothing). Fansly never reads `partial`. |
| `knownFanMessages` | One `{ id, state }` per id of the body's `knownFanMessageIds`, in the same order. Absent when the body named none. |
| `coverageCheck` | `{ window, deleted }`: one `{ id, state }` per id of the body's `coverageCheck.window` and `coverageCheck.deletedIds`, each list in the body's order (below). Only for a caller that advertised `coverage-check-v1` and sent the field; absent otherwise. |
| `source` with fresh text | Unchanged: `source` names the hub's own reader. Text a client supplied is described by `live` alone. |
| `live` | What the hub did with the request's fresh text (`liveTextContext`, below): `{ status, accepted, rejected, matched? }`. `matched` (chat-extension R20 HF-8б): the client's items the hub's own transcript already held, from the same sender; present only when the hub merged the text (`shadow`, `served`, `rejected`), absent for `not_sent` and `disabled`. |
| `fanLanguageEvidence` | `latin`, `cyrillic`, `mixed` or `unknown`: a rough count of the letters in the fan's latest 20 text messages of the served window. It is not language detection. |
| `pair` | Fansly only, when the request names a `fanRef`: what the hub vouches for about the pair `conversationRef` (the group) ↔ `fanRef` (below). `verified`: the page's thread of the group has this fan. `unverified`: the page holds no thread of the group, or one whose fan the hub does not know yet. Absent on OnlyFans and without `fanRef`. |

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

Message ids are exact on the whole path. A message id is the platform's id as its store keeps it,
from the store to the prompt and the frame: the transcript keys, deduplicates and orders messages
by that string (a decimal id compares by its value, never through a JavaScript number), and an id
of `knownFanMessageIds` matches a window ref only as the same string. Fansly ids (18-19 digits)
pass 2^53, where two different ids can be one double; each stays its own message and gets its own
answer. OnlyFans ids are far below 2^53, so their transcripts are what they were.

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

### Feature-lane window coverage check (chat-extension R20 HF-8в)

`coverageCheck` (body, optional) names what the client's open tab holds of the chat: `window`, up to
60 messages of both sides as `{ id, dir }` (`dir`: `fan` or `model`; media-only messages count; empty
for a chat with no messages), and `deletedIds`, up to 60 messages the tab saw deleted there. Ids are
canonical numeric ids, each named once across both lists; anything else is a 400 from the schema.
Ids only: no text travels, nothing is added to the prompt and nothing is stored. The field is
accepted on every feature and answered, in the `context_v1` frame, only to a caller that advertised
both `context-v1` and `coverage-check-v1`; otherwise it is ignored, so every other stream stays
byte for byte what it was. Like the frame, it is answered only for a transcript the hub loaded
itself (no `clientContext`).

Each id gets exactly one answer, in its own list, in the body's order, judged against the
transcript that served the generation (after the Coach prompt budget's cut, as `window.served`) and
the same conversation-scoped store lookup as `knownFanMessageIds`:

| `coverageCheck.window[].state` | Meaning |
|---|---|
| `included` | The served window holds the id, sent by the side the client says. |
| `direction_mismatch` | The served window holds the id, sent by the other side. |
| `outside_window` | Not in the served window, but the hub holds it for this conversation: older than the window, or cut by the Coach prompt budget. |
| `deleted` | Not in the served window, and tombstoned for this conversation. |
| `absent` | Not in the served window, and the hub does not hold it for this conversation (never seen, another chat's, or only in a store the serving reader did not read). |
| `unknown` | Not in the served window, and the stores could not be read. |

| `coverageCheck.deleted[].state` | Meaning |
|---|---|
| `still_served` | The served window holds the id: the model read a message the client saw deleted. |
| `deleted` | Not in the served window, and tombstoned for this conversation. |
| `absent` | Not in the served window, and no tombstone for this conversation: the model did not read it, whatever else the stores hold. |
| `unknown` | Not in the served window, and the stores could not be read. |

The ids of `knownFanMessageIds` and of both lists that the served window does not hold are looked up
together, once per generation (at most 130 ids, the lookup's cap). An id of another chat on the same
page reads `absent`, as above; a failed lookup answers `unknown` and never fails the generation.

How the client reads these answers (a window miss, a stale context, an unchecked id, and their order)
is one table shared with the hub: `tests/fixtures/ai-coverage-check-matrix.json`. The hub proves its
answers against it (`tests/ai-coverage-check.test.ts`); the client copies the file verbatim for its
verdict (chat-extension P8b2) and reads the same verdicts from it. A change to the answers is a
change to that file.

### Feature-lane conversation pair on Fansly (chat-extension R20 HF-9)

On Fansly a chat is a group with an id of its own. A request whose transcript the hub loads itself
(no `clientContext`) names the group as `conversationRef` and the fan as `fanRef`: the hub reads
the transcript by the one and the fan's spend, subscription, name and dossier by the other. Before
any context loads, after the page was admitted, the hub reads the page's thread of the group
(`page_dm_threads` by `platform_account_id` and `platform_conversation_id`, hidden threads
included) and compares its fan (`partner_platform_user_id`) with `fanRef` as exact strings:

| The page's thread of the group | Answer |
|---|---|
| has this fan | served; `pair: verified` |
| has another fan | 409 `conversation_fan_mismatch`: nothing is generated, nothing is recorded |
| none (a chat the hub has not captured yet), or its fan is not known | served; `pair: unverified` |

The answer is recorded as `params.contextManifest.conversationPair` (`verified` or `unverified`) and
rides the `context_v1` frame as `pair` for a caller that advertised `context-v1`. A failed read is
not swallowed: the request fails as any failed context load does. Not checked, and answered exactly
as before: a request with `clientContext` (the released Fansly extension sends its own transcript,
with `conversationRef` the group or the fan's id), an OnlyFans request, and a request without
`fanRef`.

### Hi on Fansly by the start proof (chat-extension R20 HF-5)

Hi is for a conversation with at most 10 personal messages (the fan's, and the model's that are not
a welcome or a mass send), counted over a history read to its first message. The hub cannot count
them on Fansly: its history there is pull-cadenced and almost never reaches a new chat's first
message. The released Fansly extension counts them itself and sends the count in `clientContext`.
A client that sends no `clientContext` proves the start from what its page already loaded, and the
hub checks what it can check.

**The lane.** `hi-greeting`, a Fansly page, no `clientContext`, a caller that advertised
`hi-start-proof-v1`. On it the proof decides Hi and nothing else does. Off it nothing changes: Hi
keeps the gate it had (the count of messages in the hub's transcript, or the released clients'
`clientContext.personalMessageCount`), and the three body fields below are refused.

**The body fields** (all optional):

- `startProof`: `{ v: 1, source, groupId, startWitnessId, coveredCount, personalCount, automatedIds }`.
  `source` is who proved the start: `tab-short-page` (the open tab, by a fresh end of the history
  shorter than a page and the continuous observation since) or `pass-empty-page` (a walk of the
  history to its empty page). `groupId` is the chat. `startWitnessId` is the first message of the
  conversation as the source saw it, null only for an empty history. `coveredCount` is how many
  messages from the start the source saw. `personalCount` is the personal messages among them: a
  tab counts over the whole history it proved, a pass among the last 30 messages of the history it
  walked, as the released extension does. `automatedIds` are the newest automatic messages, oldest
  first, at most 120. Ids only, never a text. The schema is the client's own, field by field:
  the witness is null exactly when `coveredCount` is 0, no automatic id is older than it, the
  automatic ids ascend without repeats, the counts stay within `coveredCount` (a tab's personal and
  automatic messages together too), and a pass counts at most 30.
- `personalMessageCount`: the same count at the top level, as the released clients carry it in
  `clientContext`. It proves nothing by itself; beside a proof it must equal
  `startProof.personalCount`.
- `fanAvatarUrl`: the fan's avatar as the page already loaded it, under the rule of
  `clientContext.fanAvatarUrl` (an HTTPS address on a Fansly host, at most 4,096 characters). It
  rides to the provider as an image, exactly as that field does; the hub never fetches it.

**Where they are refused** (400 `bad_request` with a machine `reason`, before any context loads;
a request that sends none of them is never refused here):

| The request | `reason` |
|---|---|
| a feature other than `hi-greeting`, a request with `clientContext`, or a page that is not Fansly | `start_proof_not_allowed` |
| no `hi-start-proof-v1` in `x-kernel-ai-capabilities` | `capability_required` |
| `startProof.groupId` is not the request's `conversationRef`, or `personalMessageCount` is not `startProof.personalCount` | `start_proof_mismatch` |

**The gate.** A refusal is 400 `gate_hi_greeting_limit` with a machine `reason`
(`AI_HI_GREETING_REFUSAL_REASONS`); nothing is generated and nothing is recorded. A request
without a proof is refused before any context loads; a proof is judged after the transcript
loaded. The first that holds:

| The request | Answer |
|---|---|
| no `startProof` (with or without a count) | `history_unproven` |
| the request's own `coverageCheck.window` names a message older than `startWitnessId`, or any message beside a proof of an empty history | `history_unproven` |
| the hub holds, as not deleted, a message of the conversation older than `startWitnessId`, or any message beside a proof of an empty history | `history_unproven` |
| `personalCount` is above 10 | `too_many_personal` |
| otherwise | served |

What the hub holds for the conversation is the transcript it just served (with the socket overlay's
messages, where the live union served it) and the oldest message of its archive, one more read
(`findAiConversationOldestMessageRef`: this page, this conversation, not deleted; on a page that
reads the overlay, not deleted on the socket either). A message the hub knows as deleted never
contradicts a proof. Neither does a message of another chat or of another page, nor a witness the
hub does not hold or holds as deleted: the hub's history seldom reaches a chat's start, and the
proof is the client's. Ids compare as snowflakes (the shorter is the older, then the string order),
never as numbers. The number of messages in the hub's transcript is not read on this lane: a chat
with forty automatic messages and no personal one is admitted. A failed read fails the request, as
any failed context load does.

An admitted proof adds nothing to the prompt, the stream or the `context_v1` frame; the record
keeps its counts as `params.contextManifest.hiStartProof` (`source`, `coveredCount`,
`personalCount`, `automatedCount`), never an id. The window's ids are still answered one by one
in the frame (the window coverage check, above).

The schema's bodies, the refusals and the gate's answers are one fixture matrix shared with the
client: `tests/fixtures/ai-hi-start-proof-matrix.json`. The hub proves itself against it
(`tests/ai-hi-start-proof.test.ts`); the client's fake hub copies the file verbatim (chat-extension
P6c2). A change to these rules is a change to that file.

### Voice identity on Fansly (chat-extension R20 HF-4а)

A voice take is a `voice-script` generation, then a paid render of it
(`POST /api/v1/pages/:pageLabel/voice-notes`). Both name the chat and the fan:

| Request | Released Fansly extension (2.10.1) | New client |
|---|---|---|
| `voice-script` | `conversationRef` = `fanRef` = the fan's id, with `clientContext` | `conversationRef` = the group, `fanRef` = the fan, no `clientContext` |
| render | `conversationRef` = the fan's id, no `fanRef` | `conversationRef` = the group, `fanRef` = the fan |

- `voice-script` always needs a nonblank `fanRef` (`gate_voice_identity_required`). A
  `conversationRef` other than `fanRef` is accepted only without `clientContext`, where the pair
  check above ran: a contradicted pair is 409 `conversation_fan_mismatch` before any spend, an
  unverified pair is served. With `clientContext` both refs still must match.
- The render's source generation must be this principal's completed, untruncated `voice-script` on
  this page, with the render's `conversationRef` and its fan: `fanRef`, or `conversationRef` when
  the body has no `fanRef` (`voice_source_invalid`). A body with `fanRef` is then held to the pair
  the page's capture knows now, by the same check: a group captured as another fan's chat since
  the script is 409 `conversation_fan_mismatch`, before any row, budget reservation or provider
  call. A body without `fanRef` is not checked and is admitted exactly as before.
- `fanRef` is not part of the request hash (`pageId`, `conversationRef`, `sourceGenerationRef`,
  canonical script; the client computes the same digest): the hashed source generation carries
  its fan. A replay re-runs no admission gate, as before.
- Erasure: the render's admission and its dispatch are fenced by a fan erasure of `fanRef` as well
  as of `conversationRef`; a fan erasure deletes a render whose source generation it deletes (the
  generation carries the fan), so a render of a group the hub never linked to the fan goes with
  the fan.

### Spend and subscription on Fansly (chat-extension R20 HF-7г)

A feature that reads earnings (every one but `hi-greeting` and `voice-script`) carries two blocks
about the fan. The released Fansly extension reads both from Fansly on every generation and sends
them in `clientContext`. A request whose context the hub loads itself (no `clientContext`) gets
them from what the hub already holds, in the extension's own shape, and makes no request to Fansly
(`apps/runtime/src/modules/ai/context/fansly-money.ts`; the texts are
`prompts/context/fansly-spending.ts` and `fansly-subscription.ts`; the reference, generated by the
extension's own formatters, is `tests/helpers/fansly-money-reference.ts`):

| Block | Read from | Lines |
|---|---|---|
| `FAN SPENDING DATA` | the page's ledger: the fan's active `transactions` rows, summed in the database by UTC month and type | the fan's id; all-time gross and net; the types, largest first; every month, newest first. A deep feature (`fan-summary`, `chat-review`, `fan-notes-fill`) adds the twelve newest months by type |
| `FAN SUBSCRIPTION DATA` | `page_subscriptions`: the row the page's active list serves, else the fan's last one | tier and renewal price; an active subscription: since when, the period's end, auto-renew; an ended one: when it ended and how long it lasted |

- A fan with no ledger row reads zero totals. An account the hub has no fan row for (a fan it has
  not seen yet; a request without `fanRef`, whose `conversationRef` is the group) gets neither
  block: the hub cannot say that an id it does not know spent nothing.
- A fan the page never had a subscription from gets no subscription block. A fan who left reads
  `Expired (ended …)` from his last row, whether the expired list served it or the active list
  stopped serving it (`page_fans` cannot answer: its subscriber fields are cleared with the last
  current row).
- The data are as fresh as the page's walks, not read at generation time: the ledger follows the
  socket's money events (`transactions.head`) and a 15-minute poll; the active subscribers list is
  walked hourly and on the socket's subscription event.

What differs from the extension's blocks:

- The type names are the ledger's: `Subscriptions`, `Tips`, `Paid messages`, `Paid posts`,
  `Streams`, as in the OnlyFans block, else `Unknown (type <code>)`. The extension named Fansly's
  codes wrongly (a media purchase, 2110, was "Subscription"; a subscription payment, 15001, was
  "Message tip / paid message").
- The all-time lines are whole: the extension summed an answer Fansly cuts at 100 rows.
- `Source` is always `/api/v1/subscribers`, the one list the hub captures subscriptions from.
- The gift and promotion lines are absent: the hub does not store a subscription's gift code or
  promotion.

Not changed: a request with `clientContext` (its two blocks are the client's, byte for byte), and
OnlyFans (`loadSpendingContext`, `loadSubscriptionContext`).

### Feature-lane media on Fansly (chat-extension R20 HF-7a)

On a Fansly page the transcript the hub loads itself (no `clientContext`) shows a message's
attachments as the released Fansly extension (2.10.1) shows them in the transcript it sends: one
label per attachment, in the message's order, before the text. `[Photo]`, `[Video]`, `[Audio]`;
`[Media]` for a media of no known kind or one the page never served; `[Media Bundle: 2 Photos,
1 Video]` for a bundle, counting the photos and videos among its members the page served
(`[Media Bundle]` when there are none). An attachment that is not media (a tip's, a story reply's)
has no label; a tip reads `[Tip: $X.XX]` as before. Each paid attachment carries its own purchase
mark (R20 HF-7в, below); a message whose attachments the media plane has not recorded yet keeps one
suffix (` - PPV $X.XX, unknown`) on its first label, because the archive keeps one price per message.

The labels come from the hub's stores: the archive row's `media_metadata` (what each attachment is:
its MIME type, a bundle, or `other`) and the media plane of the same observations
(`message_media_offers`: the attachments' order and content type; `creator_media_bundles` and
`creator_media`: a bundle's members). On a page in `fanslyLiveOverlayReadPages` a socket message
the archive does not hold yet is labelled from its attachments' ids by the same tables, with no
price (money is REST-only): a file the hub has not seen reads `[Media]` until the message's REST
copy arrives. A failed read of those tables does not fail the generation: the messages serve
without media labels and `params.contextManifest.fanslyMediaError` is `true`.

Unchanged: a request with `clientContext` (its transcript is the client's), and OnlyFans (the
archive reader shapes its rows without their media list, as before; the union reads OFAPI's).

The conversation feed (`clientConversationFeed`) captions a Fansly row's media with the same words
(`[Photo]`, `[Media Bundle: 2 Photos]`, nothing for a tip's attachment), without price or purchase
state: those are the item's `priceMills` and `tipMills`. An OnlyFans row's captions are read from its
own media list, as before.

### Feature-lane PPV purchase state on Fansly (chat-extension R20 HF-7в)

On the same lane each paid attachment of a Fansly message is marked on its own label, as the
released extension marks it: `[Video - PPV $20.00, purchased] [Photo] [Media Bundle: 1 Photo, 1 Video
- PPV $30.00, unknown]`. An attachment is paid when a permission row the page served for its media or
bundle has the PPV bit (`flags & 1`); its price is that row's `price`, else the price inside its
`metadata`, else none (` - PPV, state`). The state is the chat's fan's (the fan the page's capture
names for the group, `page_dm_threads`; unknown fan: every state `unknown`):

- `purchased`: an order of the fan for that media or bundle in `media_orders` (a single media's own
  order of type 1 or of no type; a bundle's order);
- `not purchased`: no such order, and the hub has read the target's whole order history: its latest
  Sync Engine walk (`purchases.targets`, one per media or bundle) closed on an empty page or on an
  order its previous whole walk saw, every page its walks read is canonicalized, and no order of the
  fan waits above the media plane's watermark;
- `unknown`: everything else — a target never walked (the engine walks a target when an order of it
  is seen, so a PPV nobody bought stays `unknown`), a walk open or closed on a refusal, an order not
  projected yet, a failed read.

The released extension asks Fansly on every generation instead (`/media/orderhistory` per paid
attachment, filtered by the fan); where the hub has no complete walk it says `unknown` where the
extension could say `not purchased`. `params.contextManifest.fanslyPpv` counts the paid attachments
and their states (`{ paid, purchased, notPurchased, unknown }`, only when one is paid); a failed
purchase read leaves every mark `unknown` and sets `fanslyPpvError: true`. A socket message (live
overlay) carries no price and no mark.

### Feature-lane transcript depth (`messageCount`, full Recap, notes fill)

`messageCount` is the window a request asks for (5 to 5000). The hub's two transcript readers (the
archive reader and the union reader) cap every window at 1500 messages, whatever was asked: a
request for 3000 is served the newest 1500, and the `context_v1` frame says so in `window`
(`requested`, and `served`: the number of messages the transcript actually holds).

Two requests read past that cap, up to 5000 messages, on OnlyFans and Fansly alike
(`apps/runtime/src/services/ai-transcript-depth.ts`). Both need:

- a caller that advertised `context-v1`;
- a transcript the hub loads itself: a request with `clientContext` brings its own transcript and is
  not read by the hub's readers at all (the released Fansly extension sends up to 3000 messages
  this way, unchanged).

and then:

- **the full Recap** (`fan-summary`, not `summaryMode: "short"`; the short Recap keeps its window of
  300) reads up to the owner's live setting `aiTranscriptDeepMaxRows`. It takes exactly `1500`,
  `3000` or `5000` and rests at `1500`; one value for both platforms.
- **the notes fill** (`fan-notes-fill`) reads up to the same value, but never fewer than 3000: the
  Fansly extension 2.10.1 fills its notes from the 3000 messages it reads itself, and its successor,
  which lets the hub read, must not see less.

On a Fansly page the hub's transcript is the archive, or, on a page in `fanslyLiveOverlayReadPages`,
the archive joined with the socket messages it does not hold yet (`source: "live_union"`); both take
the deeper cap. Everything else stays at 1500: `chat-review` and `coach-chat`, the reply features,
and every client that does not send `context-v1`. The released desktop lets a chatter set its deep
window as high as 3000; such a Recap is served 1500, before and after the owner raises the setting.

A request that names no `messageCount` keeps its feature's default window (1500 for the full Recap
and the notes fill). A client that wants the deeper read asks for it: the full Recap up to the
bootstrap's `limits.deepMax`, which is the value of `aiTranscriptDeepMaxRows`
(`GET /api/v1/client/bootstrap`); the notes fill up to `max(3000, limits.deepMax)`. A larger
`messageCount` is served at the cap.

The recorded generation tells what was read: `params.requestedCount` is the window the request
resolved to (not clipped by the cap), `params.keptCount` is the number of messages the prompt held,
and `params.contextManifest.archiveCount` / `unionCount` are the rows each reader returned.

Cost: the deeper the read, the longer the prompt. Measured on production (2026-10-13), the heaviest
5000-message window of a chat holds 374k characters of text (75 a message); a full Recap of it is a
prompt of about 455k characters, about 200k input tokens on the Recap's model (Opus 5.5; production
Recaps tokenize at 2.0 to 2.7 characters a token). By that model's list price a full Recap of that
chat costs about $0.41 at 1500, $0.66 at 3000 and $0.99 at 5000, the answer included. The
per-request ceiling (`chatMuseAiGatewayRequestMicroUsdLimit`) and the daily ceilings below apply
unchanged, to the longer prompt; the cost preflight of that Recap is $0.93 against the $5 default.
The read itself is the same statement and plan at every cap: both readers fetch the whole
conversation by its index and cut the tail afterwards (tombstones, stubs and duplicates are resolved
before the cap).

Size: those ceilings bound what a request may cost, not how large its prompt is. The gateway does
not measure a prompt against the model's context window; the cost preflight's token estimate (4
characters per token) is used for the price alone, and it counts only half to two thirds of the
tokens a real chat transcript takes. Nothing shortens a full Recap's transcript to fit (only Coach has a prompt budget), so a prompt
larger than the window of the model the request runs on is refused by the provider and the
generation fails. The Recap's model (Opus 5.5) has a 1M-token window: the heaviest 5000-message
Recap above takes about a quarter of it with the answer's 24k-token budget, and fits even if every
byte of its text were a token. A request that names another `model` carries that model's window.

### Feature-lane fan profile on Fansly (chat-extension R20 HF-7б)

On a Fansly page a request without `clientContext` reads who the fan is from the hub's stores, by
the rules of the released Fansly extension (2.10.1), which reads the fan's account from Fansly at
every generation and sends what it read in `clientContext`
(`apps/runtime/src/modules/ai/context/fansly-fan-identity.ts`):

- **the name**: the username, else the display name, else `fan`. Hi turns the pair round (display
  name first) and names the username on a line of its own.
- **the saved name**: the page's own name for the fan (Fansly's "Custom Username" note),
  `page_fans.page_alias` of the page the request names. It reads where `clientContext.fanCustomName`
  does: in Ping and Hi. One difference from the released client: of several such notes on one fan
  (2% of the named fans on production) the hub keeps the newest, the client reads the first Fansly
  serves, which is the oldest.
- **the bio**: the fan's profile text, for the features whose policy includes it (Hi, Ping, Help,
  Coach, the notes fill).
- The avatar is not the hub's: the client takes it from the page.

A value is cut to the bound the contract puts on the same `clientContext` field (200 characters for
a name, 5000 for the bio).

The values are as fresh as the Sync Engine's reading of Fansly, not as the generation:

- The names and the saved name come with the accounts Fansly serves beside the page's inbox list
  (the newest 100 chats every 30 minutes, the whole list once a day), and with the account lookup.
  Measured on production (2026-10-13, the 12 days before): a name saved for the first time reached
  `page_alias` in 9 minutes at the median, 20 at the 90th percentile and 54 at most (134 names); a
  changed name within 35 minutes for 150 of 176 fans, and with the daily read of the whole list (up
  to 26 hours) for the rest, whose chats were below the newest 100.
- The bio comes only with the account lookup (`GET /account?ids=`, at most once a day for a fan of
  a page), which stores it in `fans.metadata.about`; the accounts beside a list carry no `about`.
  A lookup's answer without `about` clears the stored text. A fan no lookup of the page has
  returned has no bio in the prompt.

The recorded generation says what was read, never the values: `params.contextManifest.fanIdentity`
holds `known` (the hub has an account for the fan), `name` (`username`, `display_name` or
`fallback`), `savedName`, `bio`, `savedNameReadAt` (when the page's notes on the fan were last
read; null when Fansly never served one) and `accountReadAt` (the page's last lookup of the fan).

Unchanged: a request with `clientContext` (the fan fields are the client's own), and OnlyFans (one
name: the page's alias, else the display name, else the username; no saved-name line and no
username line; no `fanIdentity` in the record).

### Feature-lane automation marks on Fansly (chat-extension R20 HF-7д)

Hi on a Fansly page without `clientContext` marks the model's welcome and mass messages in the
transcript `[Automatic / mass message]`, before their other labels, as the released Fansly extension
(2.10.1) marks the transcript of its Hi; the Hi template tells the model what the mark means. Its
rule, in order (`apps/runtime/src/modules/ai/context/fansly-automation.ts`):

- `type` 2;
- a `correlationId` other than `'0'` on a message that answers none (`inReplyTo` empty or `'0'`);
- a text equal to one of the page's welcome texts, whitespace collapsed.

A fan's message is never marked. A marker the hub never observed is not automation, as a missing key
is not for the released client. The markers are the store's that served the message: the archive's
(`message_type`, `correlation_id`, `marker_field_mask`, R20 HF-7д0) or, on a page in
`fanslyLiveOverlayReadPages`, the socket overlay's for a message the archive does not hold yet. An
archive row written before HF-7д0 has none; it takes the markers the overlay holds for the same
message, when the socket saw it. The welcome texts are the page's automations as the catalog
captured them from `/message/automated` (`page_automated_messages`, a removed one too); the hub makes
no request of its own for them. The released client reads `/message/automated` itself (its answer
cached for 24 hours) and keeps the texts of edited automations; on production no automation text has
changed since the catalog began (2026-08-22).

`params.contextManifest.fanslyAutomation` counts what was marked in the served window: `marked`,
by reason (`typeTwo`, `nonReplyCorrelation`, `welcomeText`), `modelMarkersUnknown` (the model's
messages with neither marker observed in any store: only a welcome text can mark them),
`overlayMarkers` (archive rows that took the overlay's markers) and `welcomeTexts` (how many were
compared; null when their read failed, and then the markers alone decide; `overlayMarkersError`
when the overlay's could not be read). A failed read never fails the generation.

Only Hi is marked, as in the released client; the other features read the same transcript as
before. Hi's gate on this lane is the client's start proof (R20 HF-5), which counts the personal
messages itself; the marks change the prompt, not the gate. Ping's segment and the fan's silence
read only the fan's text messages, so automation never moves them: on the same chat they are the
released client's.

Unchanged: a request with `clientContext` (its transcript is the client's, marked by the client),
and OnlyFans (no Fansly markers; nothing is read for them).

### The transcript's clock (`clientContext.transcriptClock`)

The `Now:` line of the fan-facing prompts says whose clock the transcript's `[HH:MM]` are in. The
hub's own transcript is UTC with `--- YYYY-MM-DD ---` day lines. A client's transcript is UTC when
`clientContext.transcriptClock` is `"utc"` (fansly-chat E168 writes the hub's format); without the
field it is the clock of the chatter's device, as in the clients released before it. Any other
value is a 400.

### Feature-lane transcript coverage on Fansly (chat-extension R20 HF-7д)

`transcriptCoverage` says how much of the conversation the transcript shows: the Recap stores it
with the recap (`params.transcriptCoverage`, read by the recap readers), and the short Recap, Coach
and the notes fill say it in the prompt. The released Fansly extension sends it in `clientContext`
for Coach, the short Recap and the notes fill, `full-history` only when its read reached the chat's
first message and nothing was cut after. On a Fansly page without `clientContext`, for Coach, both
Recaps and the notes fill, the hub says what its own stores prove
(`apps/runtime/src/modules/ai/context/fansly-coverage.ts`):

- `full-history`: the thread's Sync Engine chain is `complete` (R20 HF-8д: proven down to the chat's
  first message) and the served window reaches the oldest message of the chat the archive holds;
- `window`: the archive holds a message older than the served window, or Coach's prompt budget cut
  the oldest lines of the transcript: the model reads less than the hub holds;
- no value: the window holds everything the hub has, but nothing proves the chat began there. The
  prompt has no note and the Recap stores null, as before this change.

`params.contextManifest.transcriptCoverage` records `value`, `chain` and `reachesOldest`
(`promptBudgetCut` when Coach's budget decided; `error` when a read failed, which leaves no value and
never fails the generation).

Unchanged: a request with `clientContext` (the client's value, as before), and OnlyFans (no
coverage on the hub's lane).

### Feature-lane fresh text (`liveTextContext`)

The hub's archive trails the chat a chatter is looking at by seconds to minutes. A client that
reads the open chat sends its last confirmed messages with the request, and the hub merges them
into the transcript it loaded itself, for that one generation
(`apps/runtime/src/modules/ai/context/live-text.ts`). OnlyFans since H-4c; Fansly since
chat-extension R20 HF-8б, on the hub's own transcript only (the released Fansly extension sends
its whole transcript as `clientContext`, and fresh text beside it is refused).

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
| a feature other than `fast-reply`, `improve-draft`, `hi-greeting`, `ping`, `chat-review`, `coach-chat`, `fan-summary`, `voice-script`, `fan-notes-fill` | 400 `bad_request`, reason `live_text_not_allowed` |
| together with `clientContext` | 400 `bad_request`, reason `live_text_not_allowed` |
| no `context-v1` in the capability header | 400 `bad_request`, reason `capability_required` |

Help never takes it. Review and Coach take it since chat-extension X52 (bootstrap capability
`live-text-review-coach-v1`): each answers only the person who asked, and its record, scoped like
any other (below), is read back by no one else. Recap, full and short, takes it since the same
decision (`live-text-recap-v1`, owner ruling 2026-10-17): a recap built with the open chat's latest
messages is the fan's recap like any other — never scoped, shared with every chatter of the page
and a dossier's proof — as the released Fansly extension's recap on its own transcript always was
(`AI_LIVE_TEXT_SHARED_FEATURES`). A client sends it to these features only where the bootstrap
lists their capability; an older hub refuses it there.

С 2026-10-20 `live-text-fansly-tools-v1` добавляет тот же свежий текст для
`voice-script` и `fan-notes-fill`: последние сообщения дополняют архив перед
сборкой промпта. Действуют те же лимиты, выключатель страницы и проверка
принадлежности сообщений чату; результат с добавленным текстом доступен своему
автору. Запись анкеты и синтез войса остаются отдельными действиями человека.
PPV-поле для этих двух функций не добавляется.

Whether it is USED is the owner's switch, and a switch that is off IGNORES the field, it never
refuses: a client's bootstrap can be up to its TTL old, and a kill switch must not fail
generations. Two conditions, both read per generation:

- `aiLiveTextContextMode` (`off` | `shadow` | `serve`, rests `off`; stepped up one mode at a time,
  rolled back freely, like `aiTranscriptFreshUnionMode`);
- the page's `freshText` flag in `chatExtensionFeatures`, by the evaluation the bootstrap announces
  (master switch, flag, platform, binding, the `live-text-v1` capability). The flag exists on
  OnlyFans and on Fansly (R20 HF-8б; before it a Fansly page was refused with
  `live_text_not_allowed`); one mode serves both, and a page reads its flag like every other
  flag: its own row, else the `"*"` row on OnlyFans; a Fansly page reads its own row alone (R20
  HF-2).

| `live.status` | Meaning |
|---|---|
| `not_sent` | The request carried no fresh text. |
| `disabled` | It did, and the switch is off: nothing was read from it, nothing recorded. The generation is the one without the field, byte for byte. |
| `shadow` | Merged and recorded in the context manifest; the hub's own transcript served. `accepted` is what `serve` would have added. A conflict is recorded and counted in `rejected`, never thrown: shadow changes no generation. |
| `served` | The merged transcript served. `accepted` can be 0: the hub already held every message. |
| `rejected` | `serve`, and nothing of the client's joined although something was refused (tombstoned, unusable, unverifiable, or the merge failed). The hub's transcript served. |

### Feature-lane PPV state of the open chat (`livePpvContext`)

chat-extension X54. The transcript marks the model's paid message `[… - PPV $X.XX, purchased]`,
`not purchased` or `unknown` from the hub's stores; the archive read keeps no purchase state
(`unknown`), and a store's `isOpened: false` may be from before the fan bought it. The extension
reads the chat the person has open from OnlyMonster's API, whose messages carry OnlyFans' own
`isOpened`, and sends the model's paid messages with it, for that one generation
(`apps/runtime/src/modules/ai/context/live-ppv.ts`). The bootstrap lists `live-ppv-v1`.

```json
{ "capturedAt": "2026-10-17T06:00:00.000Z",
  "items": [{ "platformMessageId": "4301234567890", "priceUsd": 25, "purchased": true }] }
```

- `items`: 1 to 100 (`AI_LIVE_PPV_MAX_ITEMS`), each id once; `priceUsd` above 0 and at most
  10 000 (`AI_LIVE_PPV_PRICE_MAX_USD`); no text.
- Taken where `liveTextContext` is (`fast-reply`, `improve-draft`, `hi-greeting`, `ping`, and since
  chat-extension X52 `chat-review`, `coach-chat` and `fan-summary`; never beside `clientContext`) and on an OnlyFans page only; anything else is 400 `bad_request`, reason
  `live_text_not_allowed`. It needs no capability header: nothing of it rides the frame.
- Used under the fresh text's switch (`aiLiveTextContextMode` and the page's `freshText` flag);
  off, it is ignored. `shadow` records what would change in the context manifest (`livePpv`: ids
  and counts); `serve` changes the transcript after the fresh text joined.
- What changes: a model's message in the served transcript whose id is listed. Its PPV mark takes
  the client's state on the hub's own price, and a `purchased` from either side stands (a purchase
  does not come undone). A message without any label (a fresh one the archive has not caught, a
  paid text) gets `[PPV $X.XX, …]` with the client's price. A message the hub holds with media and
  no price stays as it is: it is the hub's free media, and the image notes read its label as
  written. An id outside the window or a fan's message is ignored. A generation it changed is scoped `principal-draft`; nothing is stored.

The merge, in `serve` and `shadow` alike:

- Only by platform message id, never by text. The hub's rows come first and win: for an id the
  transcript already holds, the hub's text stands (the page's HTML against the archive's plain text
  is not a disagreement).
- An id the hub holds as sent by the OTHER side, or under ANOTHER chat, is a conflict: the snapshot
  is not of the conversation the request names. `serve` answers 400 `context_conflict`; the message
  names message ids only. "Another chat" is another conversation of the same page, or a chat of
  another page the caller may read (the wrong page for this chat). Two pages of this hub writing to
  each other archive the same message under both; that is the same chat from its other side, not a
  conflict: on OnlyFans each page archives it with the other page's account as the conversation,
  on Fansly both archive it under the one group id (a group names the chat itself, so the same
  group on another page is this chat and any other group is another chat). A page the caller
  cannot read is not consulted. Another page is read in both of its message stores
  (`message_archive` and `dm_message_archive`), so a snapshot of the wrong page is refused even
  when it is made only of messages seconds old.
- A tombstone is never restored: an id deleted in any store of the page is rejected.
- Fansly (R20 HF-8б): where the socket overlay served the transcript (`source: "live_union"`), the
  page's overlay (`dm_live_messages`) is one more store of the page. Its deletion mark rejects an
  item whatever group the mark names, a deletion that only the socket knows included; a row under
  another group of the page is another chat (a conflict); a row under this group places the
  message in it with its sender and time, after both archives. Where the overlay did not serve
  (the page is not in `fanslyLiveOverlayReadPages`, or that switch could not be read), it is not
  consulted, exactly as for the frame's answers.
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
- `accepted` counts the client's items the served window holds; `matched` (the frame, R20 HF-8б)
  counts the items the hub's transcript already held. Items cut by the window are neither accepted
  nor rejected nor matched: `sent = accepted + rejected + matched + outsideWindow`, the last one in
  the manifest only.

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
one statement of point lookups on the stores' unique keys (the Fansly overlay by its primary key),
for the ids the transcript does not hold. It fails closed: if it cannot be read, nothing the hub cannot vouch for joins the transcript
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
(`requireClientFeature`), on both platforms (the three flags exist on Fansly since R20 HF-2). On
Fansly (R20 HF-12; the request's `platform`, which the route holds to
the page's own before any context load) `fast-reply`, `improve-draft`, `hi-greeting` and `ping` run
the same check of the page's `drafts` flag, `voice-script` of `voice` and `fan-notes-fill` of
`notesFill`: three flags that exist on Fansly alone (`voice` also opens the voice-note routes the
script feeds to the narrow token, R20 HF-4б). On OnlyFans those six, and `help-me`,
need `chatExtensionEnabled` and an `x-client-version` of `chat-extension/<MAJOR.MINOR.PATCH>` at or
above `chatExtensionMinVersion`. The master switch is checked before platform support (R20 HF-15):
when off, every bootstrap feature of every page reads `disabled` and all top-level `flags` are
`false`; the narrow token's AI switch also refuses with reason `disabled`. With the master on,
the existing order stays: platform, flag, binding, served capabilities, then version (the page
grant remains first for flagged calls). `help-me` on Fansly is then refused `platform_unsupported` (R20 HF-2: the
extension has no Help on its Fansly site), so on Fansly every generation of the narrow token waits
for a flag of the page. A page's flag is the page's own row of `chatExtensionFeatures`, else the
`"*"` row on OnlyFans; a Fansly page reads its own row alone (R20 HF-2), so no Fansly generation
of the narrow token runs until the owner names the page. A full device token (the released Fansly
extension, the desktop) is asked none of this. A refusal is `409 client_feature_disabled` with its `reason`. The
check runs once, when the generation is asked for: an owner's change while it streams holds from the
next request, and the generation already admitted finishes. The raw gateway stream is not on the
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
`anthropic:claude-opus-5-5` (the default for all text features),
`anthropic:claude-sonnet-5-5`, `anthropic:claude-sonnet-5`, `anthropic:claude-sonnet-4-5`, `anthropic:claude-opus-4-8`, `anthropic:claude-opus-4-6`,
`anthropic:claude-opus-4-5`, and `anthropic:claude-haiku-4-5`) and computes integer micro-USD
costs from input, output, cache-write, and cache-read tokens. Aggregate cache-write usage without
5m/1h provider breakdown is recorded as approximate. Unsupported models fail closed instead of
being silently underpriced.

Text features use Opus 5.5 with high effort, full Recap and fan-notes-fill included.
Short Recap uses low effort and a 4096-token total cap for thinking plus text;
models that can disable thinking retain the 2048-token cap. Opus 5.5 always uses
adaptive thinking, so an `off` preference is mapped to low effort. Explicit
per-request model choices remain supported. The background image describer's
separate model setting is unchanged. Opus 5.5 pricing includes both cache TTLs
and follows the [provider's published rates](https://platform.claude.com/docs/en/models/opus-5-5/overview).

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

### The caller's own spend for the chat extension (chat-extension H-15)

`GET /api/v1/client/pages/:pageLabel/ai-usage?date=YYYY-MM-DD[&days=1..7][&timeZone=…]`
(`clientAiUsageDaily`, capability `ai-usage-v1`) reads the same ledger for the extension's debug
panel: the caller's own rows on that page, by day and by feature, in micro-USD. It reads only the
ledger and the config; it never stores or returns prompt text, generated text or provider bodies.

Two day boundaries meet in one answer, and it states both:

- **Report days** are calendar days in `timeZone` (default `Europe/Moscow`, the cabinet's business
  day). Each day carries the instants it was cut at (`from`, `toExclusive`), and the ledger is
  bucketed by exactly those instants on `completed_at`. A day is cut where the zone's date turns,
  so a day the zone's clocks change in is 23 or 25 hours long.
- **The quota's day is the UTC day** (the preflight above). `quota.dayBoundary` is `"UTC"` and
  `remainingRequestsToday` / `remainingMicroUsdToday` are the gateway's own answer for
  `(caller, page)`. At 01:30 Moscow time the report's "today" is 90 minutes old while the quota's
  day has 1.5 hours left, so "spent today" and "left today" do not add up to the limit. `quota` is
  `null` while the gateway is off.

A day is `partial` while its numbers may still move or are not exact: `day_open` (not over yet),
`open_reservations` (a reservation without an outcome: it carries no cost yet, and on a normal
finish its `completed_at` becomes the finish time, so the row moves to the day it finished in), and
`approximate_cost` (a cost in it is an estimate). Otherwise it is `complete`. `date` may be today in
`timeZone` or up to 8 days before it; a later or older date and an unknown zone answer `400
bad_request` with a `reason` (`docs/error-handling.md` §3). The route is behind the chat-extension
master switch and the minimum extension version (`409 client_feature_disabled`).

## Privacy and Retention

Core may stream prompt text to the selected provider, but must not persist raw prompt text,
transcript text, generated reply text, or raw provider error bodies in the AI ledger, audit events,
runtime logs, or diagnostics exports. Logs may include request ids, page id, chatter id, feature,
model, provider, provider response id, bounded error code/class, token counts, and cost.

Provider response ids are audit metadata; they are not a substitute for storing prompt or response
content.

### Reads by conversation (chat-extension R20 HF-10)

The shared recaps read, the dossier save from a generation and the archive feed below are about
one conversation of one fan; the fan is in the path (`:fanRef`). On OnlyFans the chat id is the fan
id, so the fan names the conversation. On Fansly a chat is a group with an id of its own: the
request names it as `conversationRef` (the recaps and the feed in the query, the dossier save in
the body; one client id shape, `CLIENT_NUMERIC_ID_PATTERN`). A client sends the field only to a hub
that lists the bootstrap capability `conversation-recaps-v1`: the query strings and bodies are
strict, and an older hub answers an unknown key `400`.

Before anything is read, the hub resolves the conversation (`services/client-conversation.ts`):

| Page | `conversationRef` | Answer |
|---|---|---|
| chats are their fans (OnlyFans) | absent, or the fan | the fan's chat: exactly the read as before |
| chats are their fans (OnlyFans) | any other | `409 conversation_fan_mismatch` |
| chats have ids of their own (Fansly) | absent | `400 bad_request` (no `reason`): the fan's id names no chat |
| chats have ids of their own (Fansly) | a group | the pair is checked by the feature lane's rule (HF-9 above, `checkAiConversationPair`): the page's thread of the group with another fan is `409 conversation_fan_mismatch`; with this fan, none yet, or with a fan the hub does not know, the read is served |

Which platform keys its chats by ids of their own is one table (`clientConversationsHaveOwnIds`,
`services/client-features.ts`). A read by a group never returns what is stored about another fan:

- recaps: the rows of the group and of the fan's own form (`conversation_ref` = the fan, how the
  released Fansly extension's older requests keyed a chat), each only when stored about this fan —
  `fan_ref` is the fan, or no fan is named and `conversation_ref` is the fan
  (`generationOfFanPredicate`, the dossier's generation proof's own rule). A record of the group
  that names no fan, or names another fan, is not selected. The Coach recap attach on a request
  whose pair was checked (a Fansly request without `clientContext`) selects the same rows; every
  other Coach request attaches as before;
- the dossier save: a generation keyed by the fan as before, or one of the group that names this
  fan (`generationIsOfConversation`); the fan's dossier is written, as always;
- the feed: the group's messages; `target.conversationRef` repeats the request's, and a cursor is
  bound to the group and the fan (a cursor of the fan's own chat keeps the scope it always had).

`recap` and `preview` exist on Fansly since chat-extension R20 HF-2
(`CLIENT_FEATURE_REQUIREMENTS`), where they also need `conversation-recaps-v1`. A Fansly page
reaches these routes only with its own row of the owner's switches: without it they answer `409
client_feature_disabled` `flag_off` before the conversation is resolved, whatever the `"*"` row
says.

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
  status slot, never attached to Coach, never returned here and never proves a dossier. A recap is
  never scoped, fresh text or not (`AI_LIVE_TEXT_SHARED_FEATURES`, chat-extension X52), so nothing
  writes the key on a `fan-summary` row and the condition is a guard.
- `fanRef` is the OnlyFans fan id, which is the chat id; on Fansly the fan's account id, with the
  group as `conversationRef` (reads by conversation, above). `personaDefinitionId` (optional, as
  on the recap status) narrows both slots to one persona.
- Answer: `{ full, short, fullSavedToProfile }`. A slot is `null` or `{ generationRef,
  generatedAt, personaDefinitionId, coverage: { transcriptCoverage, requestedCount, keptCount },
  text }`; `generationRef` is the generation's `meta.requestId`. `fullSavedToProfile` is true when
  the fan's latest dossier on the page has exactly the full recap's text. Never a prompt block,
  the author or the context manifest.
- It reads the database only: no generation, no AI spend, no platform request.
- Behind the owner's `recap` switch on the page (`requireClientFeature`): a refusal is `409
  client_feature_disabled` with its `reason`. The `recap` feature needs both `shared-recaps-v1`
  and `recap-profile-v1` (the dossier save below); this hub serves both.

### Dossier from a stored generation (chat-extension)

`POST /api/v1/client/pages/:pageLabel/fans/:fanRef/profile/from-generation`
(`clientFanProfileFromGeneration`, bootstrap capability `recap-profile-v1`) saves a finished full
recap as the fan's dossier on the page. The body is `{ generationRef, clientRequestId? }`: the
client names the generation (`generationRef` is the `meta.requestId` of its `fan-summary`
request) and the hub copies the text from the restricted record it stored. With
`conversation-recaps-v1` the body may name the conversation as well, `conversationRef` (reads by
conversation, above). No text travels
through the client, in either direction: the dossier is exactly the model's output, and the
answer carries none of it.

- Found: only a generation of the same user, the same page and the same fan. On OnlyFans the
  chat id is the fan id, so the fan in the path names the conversation: the record's
  `conversation_ref` must equal it, and its `fan_ref` must be absent or equal to it. Anything
  else answers `404`, another person's generation included, for every role. A record whose two
  refs differ is found for neither fan: the AI route reads the transcript by `conversationRef`
  and the fan's own data by `fanRef` and does not make a Recap's two refs agree, so such a
  record mixes two fans. On Fansly (R20 HF-10) the request names the group, the pair was checked
  before the record is read, and a record of that group that names this fan is found as well: the
  form a Fansly Recap is stored in (`conversation_ref` = the group, `fan_ref` = the fan). A record
  of the group that names no fan is not. This is never wider than the dossier's generation proof
  (`fan_ref`, or `conversation_ref` when no fan is named), which the older write keeps.
- Eligible: only a usable full recap, by the rule above (`usableFanSummaryPredicate("full")`),
  and no longer than a dossier body may be (50,000 characters, the cap of the older write). Any
  other generation answers `409 generation_not_eligible` with a `reason`
  (`docs/error-handling.md` §3). A dossier saved here is therefore always one the prompts use:
  the dossier's generation proof selects by the same rule.
- Written: a new dossier version with `source_generated_at` = the record's `created_at` (the
  hub's time of the generation, never a client's clock), `created_by_user_id` = the caller and
  `source` = `chatmuse`. The fan is resolved as every dossier write resolves it (created on first
  sight on OnlyFans; a fan flagged deleted stays `404`).
- Idempotent: when a version of the fan's dossier on the page already has exactly this text, the
  answer is `existing` with that version and nothing is written, however many versions came
  since. Otherwise the dossier write's own rules apply: a generation that is not newer than the
  dossier's latest text is never written (`409 generation_not_eligible`, `superseded`). That
  one reason says nothing against the generation: the dossier already holds a newer text (a
  colleague's later recap saved first, or an older client's write). The answer stays a refusal
  because this text was not saved, and `existing` promises a version that holds it; a client
  may show `superseded` as information rather than as a failed save.
- Answer: `{ outcome: "created" | "existing", profile: { version, createdAt, sourceGeneratedAt } }`.
- Not ready: the generation record is written after the stream's `done` frame. Until it exists, a
  request that names the `clientRequestId` of an AI request the gateway admitted for the caller on
  that page answers `409 generation_not_ready` and may be repeated; without it the answer is
  `404`. Not-ready can stay for good when the record's write failed, so a client bounds its
  repeats.
- It reads and writes the database only: no generation, no AI spend, no platform request.
- Behind the same `recap` switch as the shared recaps. The older write (`PUT
  /api/v1/pages/:pageLabel/fans/:platformUserId/profile`, the text sent by the client) stays for
  the clients that use it; the chat-extension token does not reach it.

### Archive feed (chat-extension)

`GET /api/v1/client/pages/:pageLabel/conversations/:fanRef/feed[?cursor=…][&limit=1..100][&summaryWindow=5..1500][&conversationRef=…]`
(`clientConversationFeed`, bootstrap capability `archive-feed-v1`) is not an AI route: it generates
nothing and spends nothing. It is described here because it shows a chatter the conversation **as a
generation would read it**, and three of its answers are a generation's own.

- Reader: the generation's switch decides, `aiTranscriptFreshUnionMode`. `serve` reads the archive
  ∪ webhook-store union; `off`, `shadow` and a value that cannot be read serve the archive.
  `source` is `archive` or `union`, the same words as the `context_v1` frame's `source`.
- Rows: newest first by (event time, message id), `limit` a page (50 by default, 100 at most; the
  bootstrap announces the cap as `limits.feedMax`). A row is `{ messageId, at, sender, text,
  automatic, deleted, tipMills, priceMills, attachmentLabels }`. A message deleted on the platform
  is a row with `deleted: true` and an empty `text`, whatever the stores still hold of it (a
  generation drops the message altogether); its time, sender, money and captions stay. A
  content-pending stub is never a row.
  `automatic` is always `null`: the stores hold no automation signal. `attachmentLabels` are the
  transcript's own media captions (`[Photo]`, `[Media Bundle: 2 Photos, 1 Video]`), never a media
  id; the price and the tip are fields, in mills, not part of a caption.
- `head`: the newest message of the transcript the summary read, `{ messageRef, at, sender }`. It
  is the `servedHead` a `context_v1` frame reports for a generation served by the same reader from
  the same stored state: live, never a deleted message, `null` when the reader holds no live
  message. Its `sender` is the frame's `isFromFan` in the feed's words: `model` for the page's own
  message, `fan` for every other one (a system line too; the row in `items` keeps its stored
  role). A generation that was sent fresh text (`liveTextContext`) may read past it; the feed
  never holds fresh text.
- `summary` (first page only): `{ pingSegment, fanSilenceDays, window: { requested, served },
  coverage, asOf }`, counted by `computePingSummary` over `loadTranscriptContext`, the one function
  and loader a Ping generation uses, over the newest `summaryWindow` messages (100 by default, the
  Ping window; 1500 at most, the readers' cap; the 3000 depth is the full Recap's alone). A client
  never recounts the segment from the rows of a page.
- `coverage`: the same answer as the frame's `coverage` (`services/client-coverage.ts`).
  `newestKnownAt`: the head's time, or the chat list's last message time
  (`page_dm_threads.last_message_at`) when that is later than every row the reader holds, a
  deleted row included; later than `head.at` means the stores have not caught up with the chat.
  An unsent newest message does not read as a lag: the chat list keeps its time, the reader holds
  its row, and `newestKnownAt` is the head's time.
- A walk is frozen at its first page: `snapshotRevision`, `asOf`, `coverage`, `head` and
  `newestKnownAt` are read once and repeated on every later page, and a message that arrives
  meanwhile is not in the walk (`packages/db/src/repositories/conversation-feed.ts` says what a
  walk guarantees). `nextOlderCursor` is opaque and signed (`services/signed-cursor.ts`, domain
  `agency-hub:client-feed-cursor:v1`), bound to the page, the fan (and on Fansly the group:
  reads by conversation, above), the person, the reader and the archive generation. Its state is sealed (AES-256-GCM under a subkey of the encryption ring):
  the walk's bounds are ids of hub-wide sequences, and a holder reads from the token neither them
  nor where the walk stands; `snapshotRevision` is a keyed digest for the same reason. A walk ends
  a day after its **first** page: every page issues a new cursor, and taking a page does not renew
  the walk. Anything else is `400 bad_request` with the reason `cursor_invalid`
  (`docs/error-handling.md` §3): the client reads the first page again.
- It reads the database only, in one read-only snapshot per request: no platform request, no
  refresh, no queued work, no change to a chat's unread state.
- Behind the owner's `preview` switch on the page (`requireClientFeature`): a refusal is `409
  client_feature_disabled` with its `reason`.

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
- `startProof`, `personalMessageCount` and `fanAvatarUrl` at the top level: Hi
  on Fansly without `clientContext`, for a caller that advertised
  `hi-start-proof-v1` ("Hi on Fansly by the start proof", above). There the
  proof decides the gate; anywhere else the three fields are refused.

`greetingMode: "new-follower"` is a DEPRECATED ALIAS kept for released clients
(extension <= 2.4.3, of-desktop), with its earlier semantics unchanged: it
requires explicit `fanRef === conversationRef` (OnlyFans refs must be numeric
native ids, Fansly requires clientContext), implies one message when
`variantCount` is absent, and skips the freshness gate. OnlyFans keeps
server-loaded transcript/profile context and rejects clientContext. Page access,
platform matching, persona revision, quotas and restricted capture are
unchanged. A greeting is a reviewed draft; the kernel neither sends a message
nor certifies live first-contact eligibility.

### Notes fill (`fan-notes-fill`)

The Fansly notes panel's «fill with AI»: the chatter starts a questionnaire note
from a template (`Имя: `, `Локация: `, …) and the hub fills it from the whole
chat. The client sends the labels; the hub assembles the prompt
(`templates/fan-notes-fill.md`) and streams the answer.

- `noteFields`: 1-30 labels, in output order. Each is trimmed, then 1-60 UTF-16
  code units, with no line break (`\r`, `\n`, U+2028, U+2029), no `:` and no
  `<`, `>` or `&` (the prompt escaping would change those, and the answer must
  copy the label byte for byte). No two labels may be equal case-insensitively.
  A label outside these rules is a schema 400. The field is required for
  `fan-notes-fill` (`fan-notes-fill requires noteFields`) and refused on every
  other feature (`<feature> does not accept noteFields`), both 400
  `bad_request`.
- `noteValues` (optional, `fan-notes-fill` only): the questionnaire's current
  value per label, index-aligned with `noteFields`: `""` for an empty field and
  for a template field the note does not have yet. Each value is trimmed, then
  0-2000 UTF-16 code units (`AI_NOTE_VALUE_MAX_CHARS`), with no line break
  (`\r`, `\n`, U+2028, U+2029): a value is one line of the note. Any other
  character is allowed, `<`, `>` and `&` included; the prompt escapes them like
  all untrusted text (the transcript too), so the model reads `&lt;`, `&gt;`
  and `&amp;` and may write that form back in a rewritten value and in a quote
  it copies: the client decodes the three before it compares a value, writes
  it or locates a quote. A value outside these rules, or a list of 0 or more than 30, is a
  schema 400. A list whose length differs from `noteFields`
  is a 400 `bad_request` (`noteValues must hold exactly one value per
  noteFields label`); every other feature refuses the field (`<feature> does
  not accept noteValues`).
- Two modes, chosen by `noteValues`. Absent (legacy mode, the released
  extension 2.10.1 and older): the prompt is the one those clients were built
  against, byte for byte (pinned by digest in `tests/ai-fan-notes-fill.test.ts`).
  Present, even with every value empty (merge mode, the 2026-10-13 notes-fill
  spec): the task lists `Label: value` per field and the prompt adds the merge
  rules. A current value is the chatter's record and stays true unless the fan
  later contradicts it; new facts still come only from the fan; a field the
  chat adds nothing to comes back as `Label: =` (keep the value; nothing is
  echoed, so the answer does not grow with the note); any other field is
  rewritten in Russian keeping every fact, a fact that belongs elsewhere
  moving to the right listed field or to «Другое»; markers it does not
  understand («Sexting 1») stay as written. Facts that go
  stale carry the month they were said, `(MM.YYYY)`, read from the
  transcript's day lines `--- YYYY-MM-DD ---` (the client adds them in merge
  mode, in UTC on every feature since fansly-chat E168; they are the only
  source of dates). The prompt also defines «Локация»,
  «График», «Планы и даты» and «Другое».
- One fact in one field, merge mode only (2026-10-13, after the owner's review
  of real output, where the same fact landed in «Фетиши», «Медиа» and
  «Характеристика»). The two modes define two fields differently, so those
  template lines are slots (`{noteFillCharacterField}`,
  `{noteFillMediaField}`). Legacy mode keeps its definitions: «Характеристика»
  is what the fan likes and pays for, «Медиа» what he bought and likes. Merge
  mode: «Характеристика» is what kind of fan he is and how to talk to him, in
  his own stated terms (the agency chatters' own use of the field), never his
  purchases, prices, content tastes, fetishes or subscription; «Медиа» is what
  content he bought (by the transcript's `purchased` tags and the spending
  data) and what content he says he likes, and the one place for purchases and
  prices. The fan's subscription (its tier, price, dates and renewal) is
  recorded in no field (2026-10-14: the owner saw it written into «Медиа» and
  called it useless); the subscription data still reaches the prompt. One
  «Current Values» rule goes with the definitions: a fact is stated in one
  field, the one whose definition fits it best, and a fact a current value
  already holds, in any field, is not added again. How much the mode writes is
  unchanged (the owner's ruling: the output is not to get shorter), and so are
  the request and the answer format.
- Context as for a full Recap: on Fansly the client sends `clientContext` with
  the whole conversation it read (`transcriptCoverage` usually
  `full-history`), the spending and subscription blocks and the bio, plus
  `fanRef`, which is required on Fansly (`fanRef is required on fansly for
  fan-notes-fill`). The prompt reads the transcript, spending, subscription and
  bio; it never reads the stored dossier, image notes, the display name or the
  chatter's saved name. OnlyFans reads the hub archive with the deep window.
  The only product gate is an empty chat (`gate_min_messages`, at least 1).
- Answer, legacy mode: exactly one `Label: value` line per requested label, in
  order, the label as sent (after trimming), nothing else. A value is short and
  in Russian; a label the chat says nothing about comes back as `Label: ` (the
  model may drop the trailing space). The client merges: an empty field takes
  the value, a filled one is never overwritten.
- Answer, merge mode: one line per requested label, in order: `Label: =` for a
  field that keeps its current value, `Label:` for an empty field that stays
  empty, otherwise `Label: value` with the new or rewritten value in Russian,
  followed by zero to three quote lines `> «…»`. Then at most two proposed
  fields `+ Label: value` (a Russian label of one to three words, at most 60
  characters, no `:`, `<`, `>` or `&`, not equal to a listed label in any
  case; the value is never `=`), each followed by its quote lines; nothing
  else. A quote follows only a new or rewritten value, never a `=` line: a
  verbatim fragment, at most 200 characters, of one of the fan's own messages
  (a `Fan:` line, as escaped in the transcript), never translated; none for a
  fact taken from the bio or the spending data. The prompt asks; the
  hub does not check the answer: the client parses it, locates each quote in
  the transcript it sent and shows rewrites of filled fields as suggestions.
- Model: `anthropic:claude-opus-5-5` at `high` reasoning by default
  (`DEFAULT_FEATURE_MODELS` / `DEFAULT_FEATURE_REASONING`); a request's `model`
  and `reasoningEffort` override it. Prompt blocks are sent uncached.

### Split for Ping, Hi and Coach drafts (`split-all-v1`, chat-extension H-10)

`replyMode: "preferSplit"` splits Reply and Fix (`fast-reply`, `improve-draft`) for every client, as
before. `ping`, `hi-greeting` and `coach-chat` take it only when all of these hold:

- the request advertises `split-all-v1` in `x-kernel-ai-capabilities`;
- the owner's `splitAll` flag is on for the page, by the same evaluation as every chat-extension
  flag (`evaluateClientFeature`: `chatExtensionEnabled`, the flag in `chatExtensionFeatures`, a
  binding, `split-all-v1` among the served capabilities). The flag exists on OnlyFans and on
  Fansly (R20 HF-2); a Fansly page reads its own row alone, never the `"*"` row;
- the feature is `supportsSplitAll` in both policy tables (`FEATURE_POLICIES` and the builder's
  `PROMPT_POLICIES`).

`replyMode` alone never turns it on: the Fansly extension sends `preferSplit` on every feature, and
a client that does not advertise the capability keeps its prompts byte for byte
(`tests/ai-prompts-split-all.test.ts`, `tests/client-sdk-compat.integration.test.ts`). A request
that does not pass the gate is not refused: it generates the prompt without Split it always did.

With the gate open only the uncached task block changes. Ping gets the instructions for 2-3
`[NEXT]` parts; Hi asks for `[NEXT]` parts inside each `[VARIANT]`, or inside its one draft. The
cached prefix, the body schema and the frames are unchanged: the markers travel inside
`content_delta` text and the client parses them after `done`.

Coach splits its drafts, never its advice. The draft grammar is unchanged: a block opens with a
` ```draft ` line and closes with a ` ``` ` line, at most two blocks per answer (exactly two on a
preset turn), each under 1500 characters. With the gate open the `[NEXT]` parts sit inside each
block, 2-3 per block, and the 1500 characters cover the block with all its parts. A client splits
a block's body on `[NEXT]` after it has lifted the block out of the answer; `[NEXT]` is asked for
nowhere else in a Coach answer. An earlier split answer replayed in `coachHistory` reaches a later
prompt as the client sent it, markers included, whatever that later turn's gate says.

A generation the gate opened also stores `params.outputStructure` in its restricted record: the
structure of the finished text, counts only. It is written for completed streams only and is a
record, never a filter: the stream has already been sent.

- Ping and Hi: `{ variantsRequested, partsPerVariant, ok }`, where `ok` means the requested number
  of variants with two or three parts each.
- Coach: `{ draftsRequested, partsPerDraft, brokenDrafts, strayMarkers, ok }`. The check reads the
  answer the way a client does: it lifts the draft blocks out and the rest stays in the advice.
  `draftsRequested` is `2` on a preset turn and `null` on a question turn, where the coach decides
  how many messages to propose. `partsPerDraft` counts the parts of every well-formed block:
  closed, not empty, at most 1500 characters. `brokenDrafts` counts the draft fences the model
  opened that are not such a block: an opener that is not the ` ```draft ` line (indented,
  ` ```Draft `, four backticks), a block that never closes (the answer ran out of tokens, the
  closer is glued to the text), a block over 1500 characters. `strayMarkers` counts the `[NEXT]`
  markers outside the counted blocks, in the advice or in a broken draft: a client shows those to
  the chatter as text. `ok` means the requested number of blocks (at most two when the coach
  decides, none included), each with two or three parts, no broken draft and no stray marker. So
  an empty `partsPerDraft` with `ok: true` on a question turn is an answer with no draft fence
  and no marker anywhere in it: as far as the markup can tell, one that proposes no message.
