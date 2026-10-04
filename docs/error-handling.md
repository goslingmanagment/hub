# Error-handling canon

This is the single canonical error-handling reference for the Agency Hub family:
the core kernel, the ChatGoose Firefox extension (`fansly-chat`), the ChatGoose
Desktop Electron application (`onlyfans-chat`), and the ChatSpace extension
(`chat-extension`). It records the currently implemented contract and the
family law from core Decisions #154/#182/#183/#184, extension Decisions
E38/E57/E58, and desktop Decision D25; the `chat-extension` columns follow its
frozen CG registry (`chat-extension` `docs/error-registry.md`, `architecture.md`
Appendix A) and its hub→CG map (`packages/contracts/src/hub/error-map.ts`).
Change this document in the same family change as any behavior recorded here;
do not maintain client-side copies.

## 1. The law

### Authority and addressees

- **Core is the sole classifier.** Provider SDK types, HTTP status, structured
  provider error fields, response headers, transport causes, and stream
  integrity are interpreted in core. Clients select presentation from the
  kernel's machine code; they must not parse provider bodies or frame prose to
  derive a different class.
- **Codes are precise; messages are static.** Every SSE error frame contains an
  open-string `code`, one code-owned bounded literal `message`, and nullable
  `retryAfterMs`. A raw provider error, body, response snippet, prompt,
  completion, credential, or proxy secret never becomes error-frame text.
- **Every failed generation has three addressees.**

  | Addressee | Required result |
  |---|---|
  | Chatter | One terminal error card selected structurally from the kernel code. An SSE error frame is terminal and is never followed by `done`. |
  | Operator | The incident producer evaluates the documented policy after terminal persistence. A policy may deliberately produce no incident for an unscoped failure, but it may not be invented by a client. Paging is a separate, durable, policy-gated transition. |
  | Engineer | The terminal `ai_usage_events` row carries the stable failure classification. When a throwable exists, its diagnostic cause is available only through redacted structured server logging; synthetic stream-integrity failures still have the durable ledger classification. |

  A failure class may not stop at the chatter card. The write order is chatter
  frame, terminal usage/restricted-content settlement, then incident evaluation
  behind a log-and-continue guard.
- **A code is not a frame type.** Adding a `code` inside the existing
  `type: "error"` frame is additive and contract-free because the schema keeps
  `code` open. Every client must fail closed and show a safe generic card for an
  unknown code. Adding a frame `type`, changing a frame field's type or
  requiredness, or removing/renaming an existing type is contract work and is
  lockstep-gated across core contract generation, vendored SDKs, and clients.
- **`retryAfterMs` is advice, not retry authority.** It is a non-negative
  relative delay parsed by core. Clients may turn it into a stable display
  deadline. It does not authorize an automatic generation retry.

### Frozen retry laws

| Lane | Automatic behavior | Recovery authority |
|---|---|---|
| Core AI SSE generation | An error frame terminates the stream; core does not restart the generation. | A chatter may explicitly start a new generation only when the card's recovery permits it. |
| Firefox extension AI generation | No SSE error code is auto-retried. A generic pre-stream `service_unavailable` failure gets exactly one transparent retry after 5 seconds, and only before the first output chunk. | Manual retry after the mapped card; a provider-rate countdown is display only. |
| Desktop AI generation | No automatic generation retry. EOF without `done` fails closed. | Manual action after the mapped card; a provider-rate deadline is display only. |
| chat-extension AI generation | No SSE error code is auto-retried. A structured HTTP 503 `service_unavailable` on the AI stream before the first output frame gets exactly one transparent retry after 5 seconds ("Сервис недоступен, повтор через 5 с…"); never after an output frame and never for a send. EOF without `done` fails closed as `CG-STREAM-TRUNCATED`. | Manual retry after the mapped card; a provider-rate `retryAfterMs` is kept as an absolute display deadline only. |
| chat-extension hub calls (non-AI) | No transport failure (network, timeout, contract, truncation) is repeated automatically. A rejected cursor (`cursor_invalid`, `cursor_window_mismatch`) is read again once from the first page, without a toast. H-5 `generation_not_ready` repeats only the idempotent link write, never the generation: 5 s, 15 s, 60 s, then every 3 min up to 30 min while the tab is open, then `CG-RECAP-SAVE`. A claim `dispatch` that fails in transport ends its attempt held: no ticket, so no command was enqueued. | The chatter's next click; only a new click makes a new send attempt. |
| Anthropic adapter | The SDK's HTTP-level retry behavior remains intact. For a page-proxy connect failure, `createStickyConnectFailureFetch` permits one physical proxy dial per resolved generation client; later SDK attempts receive the cached connect failure immediately. | The provider SDK owns eligible response-level attempts; no client owns them. |
| OpenRouter adapter | One local fetch; there is no adapter retry loop. | A later generation is a new explicit action. |
| Voice synthesis | One paid provider dispatch. A timeout, transport failure, or ambiguous status remains dispatched and is swept to the existing indeterminate outcome; it is never redispatched automatically. Idempotent replay reads the same request result. A queued waiter heartbeats durable ownership until a process-local synthesis slot opens. | A deliberate new take is a new paid attempt. |
| OFAPI state-changing commands | One execution attempt per command row; an indeterminate mutation is never automatically sent again. Typing, unsend, and mark-read reject retry lineage. | Only an explicitly requested, policy-permitted same-kind retry creates a new command row and lineage; it is never a second attempt on the old row. |
| Sync/capture reads | Existing lane-specific pacing, durable retry state, and reconciliation remain authoritative; queue redelivery is not a substitute for that state machine. Safe-read retry deadlines are anchored to the failure transition, after transport/capture has finished, using the same clock sample as persistence. | The owning sync/capture lane, never an AI code or chatter card. |
| Sync/capture reads — lease loss | A false or failed page-sync heartbeat stops admission to new observed reads, retry delays and subsequent physical attempts within that chunk. A request admitted before cancellation but not dispatched ends as local policy telemetry. Already-dispatched response reception and capture may finish; existing database lease fencing still rejects business completion. | Lease loss is a control outcome: no new durable retry, sync failure or incident from the fenced chunk. The current owner remains authoritative. The heartbeat detection interval is unchanged. |
| Fansly reads — `Retry-After` | No in-process retry loop is left: the legacy adapter, with its retry loop and its `Retry-After` clamp, is deleted (step 4, S4-20). Every Fansly request is one physical request of the wire layer (`packages/fansly/src/wire/send.ts`): no retry, no redirect followed. A Fansly page's `429`/`503` + `Retry-After` is the Sync Engine's route hold, never shortened (`apps/runtime/src/sync/README.md`, "Errors"). The identity check of a session without a page (onboarding, `POST /api/v1/admin/credentials/verify`) is one journaled request: its `FanslyApiError` carries `retryAfterAt` — the provider's own deadline, absolute and unclamped, parsed from either wire form (delta-seconds or HTTP-date) — and is answered to the caller; a retry is the owner's next attempt. | The Sync Engine for every page read; the caller of the identity check for a session without a page. |
| OFAPI sync reads — collection policy (review #136) | A collection-policy refusal before the fetch is journaled under attempt failure kind `policy` and classified under its own retry class `ofapi_collection_policy`: a time-bound cap sleeps until the repository's reset instant (next UTC day, interval window reopening), the background pause re-checks every 15 min so Resume heals the stream by itself, and a durable policy decision or misconfiguration parks the stream `manual_action_required` with code `ofapi_collection_<reason>`. No sync incident opens — the console already shows the owner's own decision. | The owner's collection policy; a parked stream is unblocked after the policy changes. |
| OFAPI sync reads — status matrix (Decision #245) | `402` retries under `ofapi_insufficient_credits` (OFAPI does not charge the rejected request; ordinary ≤30 min per-stream backoff), opens the credit-ledger monitor's own global low-credit latch (no per-stream threshold alert on top), and that latch is resolved only by a later chunk that actually received an OFAPI response; `401`/`403` park the stream `manual_action_required` without pausing the page; other `4xx` park as `provider_bad_data`; `429` and `5xx` retry under `rate_limit` / `provider_5xx`; a status-less transport failure stays `transient_network`. | The owner tops up credits — the incident resolves itself on the first chunk that succeeds afterwards — or fixes the key/mapping and unblocks the parked stream. |
| OFAPI bounded collection reads — captured transient HTTP | Only a durably captured GET response with `429` or `500`–`599` ends the current background run as `failed`, preserving its response, cursor, caps and consumption. There is no immediate retry or second dispatch on that run; a new bounded run is eligible only at the next configured schedule interval. One-offs remain paused. Auth, other HTTP statuses, indeterminate transport and parse failures keep their existing recovery behavior. | The owner's scheduled policy authorizes the next window. Resume on a legacy paused transient response only replays its captured response locally and ends that run as failed; a fresh one-off probe requires separate bounded approval. |
| OFAPI bounded collection reads — owner finishes incomplete | An owner may close an idle paused background GET run as `failed` after reviewing its retained state, including an uncertain charge. The revision/state/page-fenced action preserves all response, attempt, ledger, cursor and allowance evidence; it performs no egress or charge reconciliation. One-offs, uploads, exports and active work are ineligible. | The explicit owner finish unblocks only the next configured periodic window under current policy. It neither resumes the old cursor nor overrides global/category pause. |
| Fansly `subscribers` walk — empty active page | An empty first page of the active (`status=3,4`) walk retires membership only when the provider states the zero: accepted contract, terminal page, explicit `totalActive=0`, nothing positive earlier in the walk. Even then the finalization transaction locks the current rows untouched since the walk began and retires that exact set only if it holds at most five subscriptions, each past `ends_at` before the walk began with auto-renew off (`subscribers_empty_snapshot_certified` run note). Failing that, it retires the whole locked set, whatever its size, ends or auto-renew, when Fansly's own `/account/me` `subscriberCount` (written hourly to `pages.subscriber_count` by the light and followers streams) also reads 0 and its `pages.last_verified_at` is no more than 2 h before the walk began (`subscribers_empty_snapshot_confirmed_by_counter` run note with `retiredCount`, `subscriberCount`, `lastVerifiedAt`). Either is a normal success: checkpoint, failure streak and `stream_failed_threshold` recover. Any other empty first page over current membership, including a stated zero whose counter is non-zero, stale or null, keeps `subscribers_empty_first_page_guard` (warn, with its `reason` and, for a stated zero, the counter it saw) and fails the chunk into the ordinary retry ladder, membership untouched. Every finalization spares rows touched since the cursor's `walkStartedAt`; a cursor without one is fenced before its next read (rewalked if it was past offset 0). Until a walk has written a page, its start is taken afresh right before each read, so a first read retried after a failure or a budget yield is judged by its own time, not the failed attempt's. | The walk converges by itself once the zero is explainable. The account counter trails a lapse by about a day, so a larger or unexplained drop keeps failing (incident open) for roughly that long, then converges on the counter's zero; a drop the counter never confirms keeps failing until a walk observes membership again or an operator retires the rows. |
| Critical-notification delivery | The durable outbox automatically retries delivery failures to a bounded attempt cap. This retries the notification only, never the failed business action. | Outbox lease/attempt policy; suppression and exhaustion are terminal. |

Decision 322 preserves a future `rate_limit` / `provider_5xx` deadline when
new requests arrive before or after retry settlement. The shared queue keeps
the newest revision, payload and dispatch source; transport/yield supersession
remains unchanged; manual queueing does not bypass the deadline. The Fansly
half of that decision (a provider `Retry-After` as the deadline, the immediate
incident for one more than 30 minutes away, the R04 page hold) went with the
legacy executor's Fansly branches at step 4 (S4-19); the queue guard stays for
the same retry classes on OFAPI streams.
See [the legacy queue's cooldown](runbooks/sync.md#onlyfans-the-legacy-page-sync-queue).

## 2. SSE wire-code registry

`failure_phase` is exactly `connect | provider_response | stream`. In the
incident column, `global` means the singleton latch
`ai_provider_billing:global`; `page/provider` means
`ai_provider_failed:<pageId>:provider`; and `page/proxy` means
`ai_provider_failed:<pageId>:proxy`. A page incident requires a non-null
`pageId`.

| Wire code | Static wire message | Meaning and failure phase | `retryAfterMs` | Default recovery disposition | Incident policy | Firefox extension mapping | Desktop mapping | chat-extension mapping |
|---|---|---|---|---|---|---|---|---|
| `provider_billing` | `AI provider billing requires attention` | Anthropic HTTP 400 `invalid_request_error` whose provider message exactly matches the production low-credit signature; `provider_response`. Near matches remain generic. | Always `null`. | Do not retry until an operator restores provider credit. | `ai_provider_billing`; `global`; immediate on first failure. | `hub_provider_billing` / `CG-HUB-12` | `CG-HUB-04` | `CG-PROVIDER-BILLING` |
| `provider_auth` | `AI provider authentication failed` | Structured provider authentication/permission evidence or HTTP 401/403; `provider_response`. | Always `null`. | Do not retry until an operator repairs the server-side provider credential or permission. | `ai_provider_billing`; `global`; immediate on first failure. | `hub_provider_auth` / `CG-HUB-13` | `CG-HUB-05` | `CG-PROVIDER-AUTH` |
| `provider_rate_limited` | `AI provider rate limit reached` | Structured provider rate-limit evidence or HTTP 429; `provider_response`. | Parsed from `Retry-After` seconds or HTTP date when valid, otherwise `null`; this is the only code that can carry a value. | No automatic retry; wait until the displayed deadline, then retry manually if needed. | `ai_provider_failed`; `page/provider`; threshold 3. | `hub_provider_rate_limited` / `CG-HUB-14` | `CG-HUB-06` | `CG-PROVIDER-RATE-LIMIT`; `retryAfterMs` kept as an absolute display deadline |
| `provider_unavailable` | `AI provider is temporarily unavailable` | Structured provider unavailable/overload evidence, HTTP 529, or any provider 5xx; `provider_response`. | Always `null`. | No automatic retry; retry manually later and escalate a continuing outage. | `ai_provider_failed`; `page/provider`; threshold 3. | `hub_provider_unavailable` / `CG-HUB-15` | `CG-HUB-07` | `CG-PROVIDER-UNAVAILABLE` |
| `provider_proxy_unreachable` | `AI gateway could not reach the page's egress proxy` | Named/code-based connect failure in the cause chain, or an explicit connect-phase failure; `connect`. | Always `null`. | Do not retry until the page's egress route is restored. | `ai_provider_failed`; `page/proxy`; threshold 3. | `hub_provider_failed` / `CG-HUB-10` | `CG-HUB-08` | `CG-PROVIDER-PROXY` |
| `provider_stream_failed` | `AI gateway provider stream failed` | Generic provider/transport failure. A supplied `provider_response` phase or status-bearing unclassified response is `provider_response`; a failure after output starts, a stream-phase hint, or an otherwise statusless fallback is `stream`. | Always `null`. | Do not blind-retry; inspect the provider path and retry manually only after judgment. | `ai_provider_failed`; `page/provider`; threshold 3. | `hub_provider_failed` / `CG-HUB-10` | Provider fallback: `CG-HUB-10` | `CG-PROVIDER-STREAM` |
| `provider_output_empty` | `AI gateway provider completed without usable output` | Provider termination produced no non-whitespace output after stronger terminal-integrity checks; `stream`. | Always `null`. | Discard the unusable result; a later regeneration is manual. | `ai_provider_failed`; `page/provider`; threshold 3. | `ai_output_unusable` / `CG-API-06` | Provider fallback: `CG-HUB-10` | `CG-PROVIDER-EMPTY` |
| `provider_usage_missing` | `AI gateway provider ended without usage metadata` | Output exists but the terminal provider stream supplied no usage metadata; `stream`. | Always `null`. | Discard as an incomplete terminal; investigate before repeated manual generation. | `ai_provider_failed`; `page/provider`; threshold 3. | Provider fallback: `hub_provider_failed` / `CG-HUB-10` | Provider fallback: `CG-HUB-10` | `CG-PROVIDER-USAGE-MISSING` |
| `provider_stream_incomplete` | `AI gateway provider stream ended without a terminal stop reason` | Output and usage exist, but no `done`/terminal stop reason exists; `stream`. | Always `null`. | Discard the partial result; investigate before repeated manual generation. | `ai_provider_failed`; `page/provider`; threshold 3. | Provider fallback: `hub_provider_failed` / `CG-HUB-10` | Provider fallback: `CG-HUB-10` | `CG-PROVIDER-INCOMPLETE` |
| `coach_output_too_long` | `AI gateway output exceeded the coach transport ceiling` | Coach output crossed the 64,000-character transport ceiling; `stream`. The crossing delta is emitted, then this error, with no `done`. | Always `null`. | Change or narrow the request before a new manual generation; retrying the same request is not recovery. | `ai_provider_failed`; `page/provider`; threshold 3. | Non-provider fallback: `hub_request_failed` / `CG-HUB-07` | Non-provider fallback: `CG-HUB-02` | `CG-OUTPUT-COACH-LIMIT` |

Classifier precedence is structural: stream-phase hint; typed
authentication/permission, rate-limit, then unavailable/overload evidence;
the exact Anthropic billing signature; numeric 401/403, 429, then 529/5xx;
connect evidence or hint; generic fallback. Typed evidence therefore wins over
a contradictory status. Provider HTTP status is diagnostic metadata, not a
client classification input.

Unknown-code behavior is mandatory rollback safety:

- Firefox: unknown `provider*` → `hub_provider_failed` / `CG-HUB-10`;
  other unknown codes → `hub_request_failed` / `CG-HUB-07`.
- Desktop: unknown `provider*` → `CG-HUB-10`; other unknown codes →
  `CG-HUB-02`.
- chat-extension: unknown `provider*` → `CG-PROVIDER-UNKNOWN`; other unknown
  codes → `CG-HUB-UNKNOWN` (kept apart in diagnostics).
- A transport EOF without an explicit error frame and without `done` is a
  client-observed truncation, not a kernel wire code: Firefox uses
  `hub_stream_truncated` / `CG-HUB-16`; Desktop uses `CG-HUB-09`;
  chat-extension uses `CG-STREAM-TRUNCATED`.
- Every client preserves a non-null `retryAfterMs` as an absolute display
  deadline. None schedules an SSE generation retry from it.

### chat-extension: HTTP errors and transport failures

§3 below is the core's `AppError` registry and carries no client columns. The
chat-extension reads every non-SSE hub failure by the ordered rules below
(`HUB_HTTP_ERROR_RULES`): the first matching row wins, so route- and
fact-dependent rows come before the general row of the same code, and status
fallbacks and the catch-all come last. A rule matches on the machine `error`
code, the optional machine `reason`, the HTTP status, the route class and one
fact of the call; it never parses message text.

Route classes: **sign-in** (password sign-in that issues the device token),
**sign-out**, **account** (health, me, client bootstrap, persona catalog),
**ai-stream** (the AI feature stream), **page** (page-scoped reads, the
client's own page routes included), **claim** (fan claim and claim status,
H-7b), **recap-profile** (dossier from a generation, H-5), **ingest**
(observations). Facts: *stale sign-in* (the call carried an older token or
sign-in epoch than the current one), *page not granted* (the page is not in the
current bootstrap), *fan lookup* (a lookup of one fan: dossier, fan card),
*before first frame* (AI stream, no output frame yet), *dispatch* (claim action
`dispatch`).

Codes and reasons marked † are not emitted by core yet. They arrive with the
chat-extension hub changes planned in `chat-extension` `docs/hub-pr-plan.md`, and
each lands its §3 row in the change that introduces it; the client mapping is
frozen ahead of them.

| # | `error` | `reason` | Route class / fact | chat-extension code | Client action |
|---:|---|---|---|---|---|
| 1 | any | any | stale sign-in | — | Ignore: nothing changes, nothing is shown (the client's AU-014). |
| 2 | `unauthorized` | `token_revoked` | any | `CG-AUTH-REVOKED` | Wipe the sign-in. |
| 3 | `unauthorized` | `token_expired` | any | `CG-AUTH-EXPIRED` | Wipe the sign-in. |
| 4 | `unauthorized` | any other | sign-in | `CG-LOGIN-CREDENTIALS` | Show. |
| 5 | `unauthorized` | none or any other | any | `CG-AUTH-REJECTED` | Show; a 401 without a known reason never wipes the sign-in. |
| 6 | `forbidden` | any | any | `CG-HUB-FORBIDDEN` | Show; a 403 never wipes the sign-in. |
| 7 | `rate_limit_exceeded` | any | sign-in | `CG-LOGIN-RATE-LIMIT` | Show with an absolute deadline from `retryAfterMs` / `Retry-After`. |
| 8 | any (status 5xx) | any | sign-in | `CG-LOGIN-UNAVAILABLE` | Show. |
| 9 | `rate_limit_exceeded` | any | any | `CG-HUB-RATE-LIMIT` | Show with an absolute deadline from `retryAfterMs` / `Retry-After`. |
| 10 | `preview_send_rate_limited` † | any | claim | `CG-HUB-RATE-LIMIT` | Show with an absolute deadline from `retryAfterMs` / `Retry-After`. |
| 11 | `quota_denied` | any | any | `CG-QUOTA-DAILY` | Show with the deadline at the next 00:00 UTC. |
| 12 | `service_unavailable` | any | ai-stream, before first frame | `CG-HUB-UNAVAILABLE` | One transparent retry after 5 s (§1). |
| 13 | `service_unavailable` | any | any | `CG-HUB-UNAVAILABLE` | Show. |
| 14 | `internal_error` | any | any | `CG-HUB-UNAVAILABLE` | Show. |
| 15 | `unknown_ai_feature` | any | any | `CG-HUB-CAPABILITY` | Show. |
| 16 | `persona_definition_changed` | any | any | `CG-PERSONA-CHANGED` | Drop the result, refresh the persona catalog, show. |
| 17 | `gate_draft_required` | any | any | `CG-GATE-DRAFT` | Show. |
| 18 | `gate_min_messages` | any | any | `CG-GATE-HISTORY` | Show. |
| 19 | `gate_hi_greeting_limit` | any | any | `CG-GATE-HI` | Show. |
| 20 | `gate_ping_active` | any | any | `CG-GATE-PING` | Show. |
| 21 | `context_conflict` † | any | any | `CG-CONTEXT-CONFLICT` | Show. |
| 22 | `client_feature_disabled` † | `binding_missing` † | any | `CG-BINDING-MISSING` | Refresh bootstrap, show. |
| 23 | `client_feature_disabled` † | `client_outdated` † | any | `CG-HUB-OUTDATED` | Refresh bootstrap, show. |
| 24 | `client_feature_disabled` † | any other | claim, dispatch | `CG-SEND-OFF` | Refresh bootstrap, show. |
| 25 | `client_feature_disabled` † | any other | any | `CG-FEATURE-DISABLED` | Refresh bootstrap, show. |
| 26 | `bad_request` | `cursor_invalid` † | any | `CG-HUB-REQUEST` | Read again once from the first page, no toast. |
| 27 | `bad_request` | `cursor_window_mismatch` † | any | `CG-HUB-REQUEST` | Read again once from the first page, no toast. |
| 28 | `bad_request` | `live_text_not_allowed` † | any | `CG-HUB-REQUEST` | Show. |
| 29 | `bad_request` | `capability_required` † | any | `CG-HUB-REQUEST` | Show. |
| 30 | `generation_not_ready` † | any | recap-profile | `CG-RECAP-SAVE` | Repeat the idempotent link write on the §1 schedule; the code only when it runs out. |
| 31 | `generation_not_eligible` † | any | any | `CG-HUB-REQUEST` | Show. |
| 32 | `claim_busy` † | any | any | `CG-CLAIM-BUSY` | Show. |
| 33 | `greeting_done` † | any | any | `CG-CLAIM-BUSY` | Show (the fan is already greeted: a sub-case of busy). |
| 34 | `claim_expired` † | any | any | `CG-CLAIM-EXPIRED` | Show. |
| 35 | `custody_held` † | any | any | `CG-SEND-UNCERTAIN` | Show (an unresolved send to this fan, the desktop's included). |
| 36 | `part_already_sent` † | any | claim | `CG-SEND-PART` | Read the claim status, no toast. |
| 37 | `generation_mismatch` † | any | any | `CG-CONTEXT-CHANGED` | Show. |
| 38 | `attempt_conflict` † | any | any | `CG-HUB-REQUEST` | Show. |
| 39 | `custody_not_owned` † | any | any | `CG-HUB-REQUEST` | Show. |
| 40 | `conflict` | any | claim | `CG-CLAIM-BUSY` | Show. |
| 41 | `conflict` | any | any | `CG-HUB-REQUEST` | Show. |
| 42 | `not_found` | any | recap-profile | `CG-HUB-REQUEST` | Show: not this user's, page's or fan's generation, rejected for good. |
| 43 | `not_found` | any | page or claim, page not granted | `CG-BINDING-NOT-GRANTED` | Show. |
| 44 | `not_found` | any | page, fan lookup | — | Empty: the lookup answers null, nothing is shown. |
| 45 | `not_found` | any | any | `CG-HUB-REQUEST` | Show. |
| 46 | `bad_request` | any | any | `CG-HUB-REQUEST` | Show. |
| 47 | not matched above (status 400) | any | any | `CG-HUB-REQUEST` | Show. |
| 48 | not matched above (status 401) | any | sign-in | `CG-LOGIN-CREDENTIALS` | Show. |
| 49 | not matched above (status 401) | any | any | `CG-AUTH-REJECTED` | Show; never wipes the sign-in. |
| 50 | not matched above (status 403) | any | any | `CG-HUB-FORBIDDEN` | Show. |
| 51 | not matched above (status 429) | any | sign-in | `CG-LOGIN-RATE-LIMIT` | Show with an absolute deadline from `retryAfterMs` / `Retry-After`. |
| 52 | not matched above (status 429) | any | any | `CG-HUB-RATE-LIMIT` | Show with an absolute deadline from `retryAfterMs` / `Retry-After`. |
| 53 | not matched above (status 5xx) | any | any | `CG-HUB-UNAVAILABLE` | Show. |
| 54 | anything else | any | any | `CG-HUB-UNKNOWN` | Show; kept apart in diagnostics. |

Rows 47–53 read a code no earlier row matched by its status alone: 400, 401,
403, 429 and 5xx. That includes a known code outside its route-restricted row
(`preview_send_rate_limited` off a claim route, 429 → row 52). Any other status falls to row 54, so a §3 code without a row
here reads by its status (`voice_script_invalid`, 400 → `CG-HUB-REQUEST`) or
as `CG-HUB-UNKNOWN` (`proxy_missing`, 409). A known code that comes with an
unexpected status is still read by its code. Every deadline is fixed once as an
absolute time.

Failures that carry no hub error code:

| Failure | chat-extension code |
|---|---|
| Network: no connection | `CG-NETWORK`; on sign-in `CG-LOGIN-UNAVAILABLE` |
| Timeout: the client's own deadline (sign-in 20 s) | `CG-HUB-TIMEOUT`; on sign-in `CG-LOGIN-TIMEOUT` |
| Contract: a response or frame failed its schema, an undeclared status, an unknown frame type | `CG-HUB-REQUEST` |
| Truncated: SSE EOF without `done` and without an error frame | `CG-STREAM-TRUNCATED` |
| Aborted: the client cancelled | none; the operation ends cancelled |

None of them is repeated automatically (§1).

## 3. HTTP AppError registry

These are all `AppError` codes emitted by current core constructors and current
`ProductGateError` call sites. The response boundary preserves their declared
status, code, and intentional message.

| Family | Code | Status | Semantics |
|---|---|---:|---|
| General | `bad_request` | 400 | Route/service-specific invalid request represented intentionally by `BadRequestError`. Decision 349: account-link redemption additionally carries the machine `reason` for the password rule it refused — `too_short`, `too_long` or `common` — so the /join page can point at the broken rule instead of matching on prose. chat-extension H-4c: a request that sends `liveTextContext` where the AI feature lane can never use it carries `live_text_not_allowed` (a feature other than `fast-reply`/`improve-draft`/`hi-greeting`/`ping`, a page that is not OnlyFans, or together with `clientContext`) or `capability_required` (no `context-v1` in `x-kernel-ai-capabilities`). Every other bad request stays reason-less. |
| General | `unauthorized` | 401 | Missing, invalid, or rejected principal. Decision 349: when the rejected credential is a device token that MATCHED a row, the body also carries the machine `reason` — `token_revoked` or `token_expired` — so a client can stop re-presenting a dead token. A bearer whose digest is unknown, a refused session and every other 401 carry no `reason`: naming one there would be an enumeration oracle. |
| General | `forbidden` | 403 | Authenticated principal is not permitted to perform the operation. |
| Identity | ~~`password_change_required`~~ | — | **Retired by Decision 370** with the `must_change_password` flag itself (tombstone of #116(b)). No route emits it; `mustChangePassword` is a deprecated wire constant `false`. Nothing maps to it any more — a client that still has a branch for it will simply never take it. |
| General | `not_found` | 404 | Requested resource does not exist or is not visible to the principal. |
| AI | `unknown_ai_feature` | 404 | This core does not implement the requested AI feature key. |
| General | `conflict` | 409 | Route/service-specific state conflict. Decision 349: account-link redemption carries the machine `reason` — `used`, `expired` or `revoked` — so the /join page shows the right dead end. Other conflicts stay reason-less. |
| AI | `persona_definition_changed` | 409 | Selected persona changed after the client read the catalog; refresh before retrying. |
| Sync | `sync_snapshot_restart_required` | 409 | Resume cursor is below the replay continuity floor; response also carries `replayFloor` and `snapshotPath`. |
| General | `rate_limit_exceeded` | 429 | Generic API rate limit, distinct from the AI gateway's daily quota and provider SSE rate code. |
| General | `service_unavailable` | 503 | Intentional temporary service unavailability. Also the OFAPI coverage-revoke idempotency proof when the prior proof's captured body is unreadable (Decision #223) — never the 409 that means the action belongs to a different proof. |
| Capture | `capture_payload_unavailable` | 503 | The agent plane's owner-only observation payload read (#9b): the envelope has no inline body and its content-addressed copy could not be read right now. Deliberately NOT one of the handler's withholding reasons — `restricted_class` is a decision the kernel made, this is a fetch that failed, and Decision #223 exists because the two were the same answer. Transient and retriable. |
| Egress | `proxy_missing` | 409 | A Fansly page has no stored proxy, so fail-closed egress refuses the request. |
| OFAPI | `follower_outreach_conflict` | 409 | Another first-greeting command already holds page/fan custody. Do not enqueue again automatically; show the held/uncertain state. The error discloses no other chatter's command identity. |
| OFAPI | `ofapi_collection_refused` | 429 / 409 | A local collection-policy refusal before any vendor fetch (review #136); the body also carries the machine `reason` and `retryAfterMs`. 429 when only time clears it (`daily_limit`, `interval_limit` — `retryAfterMs` is the reset advice and `Retry-After` mirrors it); 409 when only an owner policy change clears it (`background_paused`, `collection_off`, `on_demand_only`, `detail_disabled`, job and configuration reasons). Never retried automatically; never 500/503. |
| Client | `client_feature_disabled` | 409 | A chat-extension feature is not available to this call (hub-pr-plan H-2b): the owner's switches (`chatExtension*` config), the page, or the extension's version refuse it. Raised by `requireClientFeature`, which every chat-extension client route runs after resolving its page, and by the narrow token's AI switch. Documented structured extension: the machine `reason` — `disabled` (master switch off, or a `chatExtension*` value the hub cannot read: a bad environment value or a stored override that no longer validates, which is logged), `flag_off` (the feature's flag is off for the page), `platform_unsupported`, `binding_missing` (no platform account id and no owner host binding), `hub_not_ready` (this hub does not serve the feature yet), `not_granted` (not an active page granted to the caller; a missing page answers the same), `client_outdated` (`x-client-version` below `chatExtensionMinVersion` or not `chat-extension/<MAJOR.MINOR.PATCH>`); the vocabulary is open (`CLIENT_FEATURE_UNAVAILABLE_REASONS`) and an unknown reason reads as off. 409 because only the owner (or an extension update, for `client_outdated`) lifts it: never retried automatically. The bootstrap is never refused this way: it answers 200 with every feature's availability and the minimum version. |
| Client | `generation_not_ready` | 409 | chat-extension H-5: the dossier save (`POST /api/v1/client/pages/:pageLabel/fans/:fanRef/profile/from-generation`) named a generation of the caller whose record has not appeared. The gateway writes the record right after the stream's `done` frame, so a save sent in that gap is answered this way, and only when the request names the `clientRequestId` of an AI request the gateway admitted for the caller on that page; without it, or for a request the hub does not know, the answer is 404. Retriable: the same request succeeds once the record exists. It can stay for good when the record's write failed (the gateway only logs that), so a client bounds its repeats. No `reason`. |
| Client | `generation_not_eligible` | 409 | chat-extension H-5: the caller's generation exists and will never become the fan's dossier. Documented structured extension: the machine `reason` — `not_full_summary` (not a `fan-summary`, or not its full mode), `not_completed` (failed or cancelled), `stop_reason_missing` (no stop reason recorded), `output_exhausted` (stop reason `max_tokens` or `length`), `empty` (no text), `context_scope` (its context held something only its caller saw), `too_long` (longer than a dossier body may be, 50,000 characters), `superseded` (the fan's dossier already holds a text that is not older than this generation); the vocabulary is open (`CLIENT_GENERATION_NOT_ELIGIBLE_REASONS`). The first six restate the one definition of a usable full recap (`usableFanSummaryPredicate`). Never retried: the same generation is refused every time. `superseded` alone says nothing against the generation (the dossier already holds a newer text), so a client may show it as information rather than as a failed save. A generation of another user, page or fan is not this error but 404. |
| AI | `quota_denied` | 429 | Core AI daily budget/quota rejected the generation before provider dispatch. |
| AI | `context_conflict` | 400 | chat-extension H-4c: the fresh text a client sent with an AI request (`liveTextContext`) contradicts what the hub holds for the conversation the request names: a message the hub knows as sent by the other side, or a message id of another chat (another conversation of the page, or a chat of another page the caller may read). The snapshot is not of this conversation, so nothing is generated and nothing is recorded. Raised only while `aiLiveTextContextMode = serve` (in `shadow` the conflict is recorded in the context manifest). The message names message ids only, at most ten, never a fan's text. Not retried as is: the client re-reads the open chat and asks again. |
| AI gate | `gate_draft_required` | 400 | Feature policy requires nonblank `draftText`. |
| AI gate | `gate_voice_unsupported_platform` | 400 | `voice-script` was requested for a non-Fansly page. |
| AI gate | `gate_voice_identity_required` | 400 | `voice-script` requires nonblank, matching conversation and fan identities. |
| AI gate | `gate_voice_disabled` | 400 | Voice feature flag is off or the page is outside the effective voice allowlist; both intentionally collapse to this gate. |
| AI gate | `gate_voice_provider_unavailable` | 400 | Voice-script product gate found no configured voice synthesis provider. |
| AI gate | `gate_voice_no_profile` | 400 | Voice-script product gate found no voice profile for the page. |
| AI gate | `gate_min_messages` | 400 | Conversation message count is below the selected feature's minimum. |
| AI gate | `gate_hi_greeting_limit` | 400 | Conversation exceeds the hi-greeting maximum (personal messages when the client reports `personalMessageCount`, every message otherwise). |
| AI gate | `gate_ping_active` | 400 | Fansly Ping generation is blocked while the conversation segment is active. OnlyFans manual Ping accepts active conversations (Decision #295). |
| Voice | `voice_disabled` | 403 | Voice-note lane is disabled. |
| Voice | `voice_provider_unavailable` | 503 | Live voice flag is on but provider boot dependencies are unavailable, or an active erasure temporarily owns the page writer fence; no provider spend is admitted. |
| Voice | `voice_not_allowlisted` | 403 | Page is not allowlisted for voice notes. |
| Voice | `voice_no_profile` | 409 | Page has no configured voice profile. |
| Voice | `voice_script_invalid` | 400 | Submitted script fails voice validation. |
| Voice | `voice_source_invalid` | 400 | Source voice-script generation is missing, ineligible, or not owned by the page. |
| Voice | `voice_quota_denied` | 429 | Page's daily voice-character budget is exhausted. |
| Voice | `idempotency_mismatch` | 409 | Voice `clientRequestId` was reused with a different request. Fansly Sync Engine history requests use the same code for a reused `idempotencyKey` with other fans, depth or reason. |
| Sync | `history_requests_unavailable_on_page` | 409 | A history request on a page not switched to the Fansly Sync Engine, or before its `requests_enabled_at` (every page in step 2). The page is in the caller's scope; the remedy is the hydration route, and `hub history-request` prints that fallback beside the refusal. Never retried automatically. |
| Sync | `invalid_history_request` | 400 | A history request the service refuses after the contract accepted it (a fan reference that cannot be stored, a malformed depth from a direct caller). |
| Sync | `history_request_not_found` | 404 | Owner routes and the owner CLI: no request with that ref. The agent plane answers its one static `not_found` instead, for a missing ref and for a request on a page outside the key's grant alike. |
| Sync | `sync_page_not_found` | 404 | Owner routes of the Fansly Sync Engine (`/api/v1/sync/pages/:pageLabel/…`): no engine page with that label. The agent plane answers its one static `not_found` instead. |
| Sync | `sync_work_not_found` | 404 | Owner route `GET /api/v1/sync/pages/:pageLabel/work/:workId`: no work row with that id on that page. |
| Sync | `sync_page_off` | 409 | "Sync now" (`POST /api/v1/sync/pages/:pageLabel/refresh`) on a page no actor runs — its engine mode is `off`, or it was left in `shadow` (a mode nothing runs since step 4 S4-23): there is nothing to make due. |
| Sync | `fansly_page_switching` | 409 | A request that would make a page read, asked of a page in `sync_pages.mode = 'handover'`: the legacy owner levers (`/admin/sync/trigger`, the block trigger and reset, the follower-reconcile reset), the owner page verify and credentials routes, `page verify`, `page set-proxy`, an agent hydration request, and the engine's own enqueue-and-wait. Neither engine reads such a page. Nothing puts a page in `handover` since step 4 of the Fansly Sync Engine (the step-3 switch and its rollback are deleted), so the code is not expected; a row that says so is still refused. |
| Sync | `legacy_sync_retired` | 409 | A legacy sync lever on a page whose platform the legacy page-sync executor no longer serves: since step 4 (S4-10) every Fansly page is read by the Fansly Sync Engine. The owner routes `/admin/sync/trigger`, the block trigger, pause, resume and reset, the follower-reconcile reset, its blast-radius preview and apply (step 4 S4-17) and the CLI `sync --page`, on a Fansly page the engine does not own (a page it owns takes the engine's levers). Also the `/account/me` levers — the owner page verify and credentials routes, `page verify` and `page set-proxy` — on a Fansly page the engine does not run (`off`, `shadow` or no engine row; step 4 S4-19 deleted their legacy check, a `live` page goes through the engine). Nothing was written, queued, sent or stored; the message names the page and the engine command to read it with. |
| Sync | `fansly_sync_work_queued` | 409 | The owner page verify, or a credentials or proxy change on a `live` page: the Fansly Sync Engine took the check (`account.verify` / `account.identity`) but has not answered within 30 s (its page is held, or its queue is busy). Documented structured extension: `statusUrl`, the engine work's status link (`/api/v1/sync/pages/:pageLabel/work/:workId`). Nothing was stored. A second credentials check while one is queued answers the same code without a link. |
| Sync | `engine_managed` | 409 | An owner decision on a hydration request the Fansly Sync Engine serves (a live page's wrapper: a history request needs no decision). |
| Voice | `artifact_expired` | 410 | Stored voice audio passed its retrieval lifetime. |
| Voice | `voice_retrieval_disabled` | 403 | Voice artifact retrieval is disabled. |
| Voice | `voice_artifact_corrupt` | 500 | Stored audio bytes fail their SHA-256 integrity check. |

Boundary-generated failures are not `AppError` registry entries. Invalid Zod
requests are rebuilt from structured issues as HTTP 400 `Bad Request`; response
serialization failure is a generic HTTP 500; every other arbitrary throwable,
including a duck-typed `{statusCode, error, message}` object, becomes static
HTTP 500 `internal_error`. Voice attempt outcome strings such as
`voice_failed_definite`, `voice_failed_after_dispatch`, and
`voice_indeterminate` are persisted state, not HTTP `AppError` codes.

That rule binds PLUGINS too, and the reverse direction is the one that bit:
`@fastify/rate-limit` does not build a reply, it THROWS whatever its
`errorResponseBuilder` returns. Returning a duck-typed literal there meant the
429 survived only because of the passthrough this section removed, so between
2026-07-24 and 2026-07-27 every rate-limited login answered HTTP 500
`internal_error` — the limiter still blocked the request, but clients were told
"internal error" instead of "rate limited" and retried on the wrong semantics.
Any plugin that signals by throwing must throw an `AppError`
(`TooManyRequestsError` here). Both rate-limit tests now carry the
`[sync-critical]` tag so the PR gate, not only the nightly, catches a
regression of this shape.

## 4. Ledger, incidents, and notification delivery

### `ai_usage_events` failure fields

| Field | Meaning and invariant |
|---|---|
| `error_code` | Open text containing the exact kernel failure code. It is populated only for a classified `gateway_outcome = 'failed'`. It is not a provider message. |
| `failure_phase` | One of `connect`, `provider_response`, or `stream`; populated with `error_code` for classified failure. |
| `provider_http_status` | Upstream provider HTTP status when structurally known; it is not the core HTTP response status. Connect and stream-only failures normally have `null`. |

Completed and cancelled terminals force all three fields to `null`.
Reservations and pre-provider `quota_denied` rows also keep them `null`.
Stale open provider reservations recover as
`provider_stream_failed`/`stream`/status `null`. The HTTP SSE lane, internal
gateway lane, operator feature-smoke path, and stale-reservation recovery all
use the same terminal vocabulary.

`ai_usage_events` contains usage, price, outcome, and bounded classification;
it does not contain raw provider errors/bodies, prompts, completions, or
credentials. `ai_generation_content` is the separate restricted,
owner-readable verbatim prompt/completion capture required by the AI gateway;
restricted content must never be copied into failure fields, incidents,
metrics, or error frames.

### Incident rules

| Incident kind | Trigger and threshold | Latch identity | Resolve rule |
|---|---|---|---|
| `ai_provider_billing` | `provider_billing` or `provider_auth`; immediate on the first failure. | One global latch: `ai_provider_billing:global`; `subKey = null`. The incident retains the exact `error_code`. | Any later successful generation resolves the global latch. |
| `ai_provider_failed` | Any other classified failure in the SSE registry; three consecutive qualifying failed provider generations for the page. | Proxy class: `ai_provider_failed:<pageId>:proxy`. Every other class: `ai_provider_failed:<pageId>:provider`. The provider latch is not split by vendor or wire code. | The page's next successful generation resolves both its provider and proxy latches. |
| `db_disk_usage` (percent) | Hourly `statfs("/")`: used ≥ `DISK_USAGE_ALERT_PERCENT` (default 80). | `db_disk_usage:global`; `subKey = null`. | Usage measured back under the threshold resolves. |
| `db_disk_usage` (runway, #213) | Hourly least-squares fit of the `disk_free_bytes` gauges over a 24h window; fires when fitted days-to-full < 30 (`runway_warning`) or < 7 (`runway_critical`). Requires ≥ 6h of gauge span — unknown history is NOT a state: it neither opens nor resolves these latches. | `db_disk_usage:global:runway_warning` and `:runway_critical` — independent latches; a warning→critical escalation therefore pages exactly once more (deliberate: one latch cannot re-page on severity without losing its anti-flap property). | A MEASURED recovery resolves per latch: runway back above that latch's threshold, or a flat/positive slope (disk no longer shrinking). Resolve texts are subKey-specific — a runway resolve must not read as a disk-wide all-clear while the percent latch stands open. |
| `sync_silent` (Fansly send guard, plan §2.5/§10) | The api's minutely send-guard monitor (`services/fansly-send-guard/monitor.ts`). **Closed page:** a guard row whose holder overran its lease and is neither completed nor confirmed gone — nothing is sent for the page; not opened inside the api's 5-minute boot grace (a deploy's own confirmation releases the holders of the containers it removed). **Pace violation:** any two consecutive sends of one page (`fansly_send_log.sent_at`, every source and process) closer than the pause setting in force for the later one; the check walks every new journal row once behind a durable cursor (`fansly_send_pace_cursor`, 0227), so it must never fire. | Page-scoped: `sync_silent:<pageId>:send_guard_closed` and `sync_silent:<pageId>:pace_violation` — own subKeys under the Fansly-only kind (a new kind is a contract change), own titles; the summary of a closed page names the holder and the exact `fansly-send-guard confirm-terminated --holder-token …` to run. Both page immediately. | Closed page: resolves on the first pass that finds the page open again (completion, a sweeper's or the deploy's confirmation, or the CLI). Pace violation: resolves after an hour without a new violation on that page; `fansly-send-guard report --since …` shows every pair. |
| `fansly_sync_engine` (Fansly Sync Engine, plan §10, design §9.6) | Alerts 1–4 come from the `sync` process: the actor's capture transaction opens alert 1 at once (a 429, a refused credential, another identity behind the credentials, a pace violation), and `engine/alerts.ts` re-derives every condition from the database every 30 s. **1 `page_stopped`:** a page hold (429, auth, identity), the conversation list's 429 hold at the top of its ladder, a network hold older than 10 min, no beating owner for 2 min (suppressed in `handover`; a `handover` older than 10 min is `handover_stuck`), and a page-stopping answer within the last 10 min. **2 `live_degraded`:** the page's socket down > 5 min, decode debt > 1 % of the receipts of 10 min, any quarantined work. **3 `freshness`:** a fan message the socket showed unconfirmed > 15 min after it became visible, whenever the parity pass looks next (excluded and hidden chats left out), a socket money frame (status 1, not a payout) not in the ledger > 5 min, urgent work due > 2 min ago (not while the page is held or paused). **4 `stuck`:** a history request with runnable work and no read for 30 min, a poll not served for its SLO (default 3 periods), the newest rescan proving the ledger short (`transactions_ledger_incomplete`). **5 `process`:** the api's ops watchdog — a page is `handover` or `live` and no `sync` heartbeat within 2 min (outside the api's 5-minute boot grace). Only `handover`/`live` pages page the owner; an `off` page, or one left in `shadow`, runs no actor and has no condition. | Page alerts: `fansly_sync_engine:<pageId>:<subKey>`; the pace violation has its own latch `fansly_sync_engine:<pageId>:page_stopped:pace_violation` (a refresh for a 429 must not overwrite it). Alert 5: `fansly_sync_engine:global:process`. One title per alert. All page at once (`immediate`). | The evaluator alone resolves alerts 1–4. Alerts 1–3 resolve once their condition has stayed false for 10 minutes since the latch's `last_seen_at` (every pass that sees the condition refreshes it, so the clean time survives a restart and a condition that comes and goes keeps one standing page); alert 1's "10 min clean" also counts from its last page-stopping answer. Alert 4 resolves on the first pass that sees progress again. Every latch of a page that is `off` or `shadow` resolves at once. The pace latch resolves only by the owner's `pnpm cli sync alerts ack --page <label>` (audited `admin.sync_alerts_ack`); a violation sent before the acknowledgement never reopens it. Alert 5 resolves on the first watchdog pass that sees a fresh `sync` heartbeat. `pnpm cli sync alerts status` shows what holds per page. |
| `capture_payload_parity` (copy divergence, #215) | Hourly bounded sample (≤50) of capture envelopes that carry a content-addressed payload reference; fires when any sampled catalog body fails to reproduce its inline body — full canonical octets compared, never digests — or when the reference points at a missing object or a missing body. Since #220 an envelope written POINTER-ONLY (no inline body) is not compared at all — it is counted as `skippedNullInline` and is neither `checked` nor `matched`, because a comparison with one operand is not evidence of agreement. | `capture_payload_parity:global`; `subKey = null`. | Only a pass that actually COMPARED something and found no mismatch resolves it. With the dual-write canary off nothing is measured, so the job touches neither side of the latch — switching the canary off must never clear an alarm a real mismatch opened. The same asymmetry covers a fully pointer-only page: its `checked` falls to zero by construction and the latch stays exactly where it was. **This job is the SOLE owner of the latch (#217).** The slice-2 read seam in `shadow` mode compares the same two copies on every read and will see a divergence first, but it deliberately neither opens nor resolves this incident: a traffic-driven path cannot promise a clean pass during a quiet hour, cannot bound its own paging rate, and would race this job for the latch. Its counters ride this job's telemetry line instead. Its resolve text names the condition that cleared, so it cannot be read as an all-clear over the collision latch below. |
| `capture_payload_parity` (sha256 collision, #219) | Same hourly job, second condition: `count(*) from capture_payload_objects where collision_ordinal > 0`. A non-zero ordinal is the durable record that `settlePayloadObject` found a stored body under an identical digest, length and scope, proved the FULL contents differ, and gave the new content its own ordinal rather than coalescing it. Every capture is stored and readable — the DIGEST is what stopped being unique. | `capture_payload_parity:global:sha256_collision` — same kind, own subKey, own lifecycle (the #213 `db_disk_usage` runway shape). | **Measured on EVERY pass, canary or not.** A collision is a durable row, not a sample: switching the dual-write canary off does not un-collide anything, so this check runs before the canary early-return. Resolves ONLY when the collision count is back at zero; a clean parity sample must never resolve it, and its resolve text says which condition cleared. The DETECTOR (`settlePayloadObject`, packages/db) owns no latch (#217): it is the hottest write path in the system, and what it owes the alarm is the durable evidence it already writes. |
| `capture_payload_parity` (dangling reference, #222) | Same hourly job, third condition: a bounded census over the head of BOTH envelope tables (`observations`, `sync_raw_payloads`) counting references whose catalog row is absent. Fires on any non-zero count. Since #220 a row may carry NO inline body, so for such a row the reference IS the fact and a reference into a hole is a captured fact nobody can read; on a dual-written row it is "only" a lie the verifier reports as `object_missing`. | `capture_payload_parity:global:dangling_reference` — same kind, own subKey, own lifecycle (the #213 `db_disk_usage` runway shape). | **Measured on EVERY pass, canary or not**, for the collision census's reason and a stronger one: rolling the canary back or putting `capture_cas_read_mode` on `inline` does not re-attach a body to a reference that points at nothing, and that is exactly the configuration an operator reaches for when worried. The window is BOUNDED (a total anti-join over `observations` is not an hourly cost) and travels in the incident text and the log line, so a zero is read as "zero in the newest N rows per table", never as "zero in history" — the total sweep per scope is `capture:verify-backfill`'s. Resolves ONLY on a zero count; a clean parity sample or a cleared collision must never resolve it. The WRITERS own no latch (#217): they drop the stale reference, write the inline body, and count `refVanished` at the capture seam. |

The page streak considers quota-accepted terminal generations. Quota denials
are excluded. Completed, cancelled, old/unclassified, billing, and auth rows
cannot manufacture the streak and stop the relevant consecutive run. A failure
without `pageId` cannot open a page incident. Cancellation produces no
incident transition.

Incident summaries are static derivations of provider name, wire code,
failure phase, and optional provider status, then sanitized and clamped. They
never incorporate the provider body or caught exception message.

Incident state is ordered by EVENT time (the terminal's `completed_at`, the
recovery's `recoveredAt`), never by the clock at which the producer happened to
reach the repository — concurrent generations settle out of order routinely. A
transition whose event time is at or before the stored `resolved_at` /
`last_seen_at` is a no-op: it neither moves the timestamps backwards nor
rewrites `error_code`, `error_summary`, or metadata, so an older failure can no
longer drag `last_seen_at` below a newer one and let the `maxLastSeenAt` guard
resolve a still-broken incident. A repeat failure at the stored `last_seen_at`
is first-writer-wins: same latch, no new state, so the cause fields are not
churned. A failure at the stored `resolved_at` reopens — but only on the
no-tombstone resolve primitive. Every production producer opens through the
recovery guard, which suppresses at `recoveredAt >= occurredAt`, and the
recovery path resolves at `last_seen_at <= recoveredAt`, so a genuine
failure/recovery tie goes to the RECOVERY. That is inherited behavior, kept
deliberately: both directions self-heal on the next terminal, and tightening
the guard would reopen the delayed-retry race it exists for. The recovery tombstone, the
conditional resolve, and the resolved-outbox row commit in ONE transaction
under the incident-key advisory lock: a committed tombstone without its resolve
would pin the incident open while silently suppressing every older failure.

### Durable critical-notification outbox

Incident transitions and their notification rows are committed atomically.
The current channel is `telegram`, paging policy is `ai_critical`, and the
stable idempotency key is
`notification:<incidentId>:<transition>:<transitionedAt-ISO>:telegram`.

| State | Meaning and allowed next state |
|---|---|
| `pending` | Due for delivery. A worker atomically leases it, or policy suppression makes it `suppressed`. |
| `leased` | Owned for 300 seconds — longer than the slowest physical Telegram send (`TELEGRAM_SEND_RETRY_WINDOW_MS`, ~150s), so a second runner cannot reclaim a row that is still in flight. Success makes it `delivered`; a disabled policy makes it `suppressed`; a failed/skipped attempt returns it to `pending` or reaches `exhausted`. An expired lease is reclaimable without consuming an attempt. |
| `delivered` | Telegram delivery was accepted and the row settled; terminal. |
| `suppressed` | Master notifications or `aiCriticalAlertsEnabled` was off at enqueue or worker recheck; terminal. Later flag changes do not resurrect the row. |
| `exhausted` | The maximum delivery attempts were consumed; terminal and explicitly timestamped. |

The default attempt cap is 5. Failed/skipped delivery attempts are journaled.
The default-cap retry delays are 1, 2, 4, and 8 minutes; a higher configured cap
uses the same exponential sequence capped at 15 minutes. The minutely worker
leases up to 25 due rows by default and stops on a 300,000 ms wall-clock budget,
whichever comes first; every lease and every settlement takes a fresh timestamp,
so a slow row cannot hand its successors an already-expired lease or a backoff
that has already elapsed. The sweep queue is `exclusive` with a 600-second
expiry, a 30-second heartbeat and `retryLimit: 0` — delivery retries belong to
the outbox row, and the expiry (not the heartbeat) is the hard ceiling that the
sweep budget plus one send window must fit under. Telegram offers no
provider-side idempotency key, so a process death after Telegram accepts a
message but before local settlement can still duplicate a notification.

Delivery is FIFO per `(incident, channel)`: a row is only leasable when no
earlier-`transition_at` row of the same incident and channel is still `pending`
or `leased`. Without that fence the due-filter hides a backed-off `opened` row
while a freshly enqueued `resolved` row is delivered first. Terminal states
never block a successor, so an `opened` row that ends `exhausted` or
`suppressed` releases its `resolved` successor, which then pages on its own —
including the case where paging was off when the incident opened. Suppressing
such an orphan resolution is a deliberate open question, not current behavior.

`aiCriticalAlertsEnabled` is a separate audited config flag, default `false`;
the master Telegram notification flag must also be enabled. Paging-off does
not prevent incident creation. It persists a visible `suppressed` outbox row,
so enabling the flag later affects new transitions only. Every other kind
reaches the same outbox under the `sync_failure` policy, enqueued by the
paging sweep below rather than by the producer.

### Paging policy (Decision 381)

Producers only transition latches; none of them sends. The minutely
`notifications.paging.sweep` (worker) evaluates every latch outside the AI
critical pair against a per-kind policy in
`apps/runtime/src/services/notification-paging-policy.ts` and enqueues the
resulting page or recovery notice into the durable outbox under
`sync_failure`. The policy is exhaustive over the kind union.

The sweep and the outbox delivery are pg-boss crons that the scheduler fires
and the worker consumes, so while either process is down the pages about it
could not be sent. While a watchdog deadman is tripped (`scheduler_silent`,
`ops_sampler_silent`, outside the api's 5-minute boot grace) the
api's ops watchdog runs the sweep and a short delivery pass itself. Sweeps from
any process are serialized by a session advisory lock
(`NOTIFICATION_PAGING_SWEEP_LOCK_NS`); a pass that finds it held is skipped.
Delivery concurrency stays with the outbox lease.

| Rule | Meaning |
|---|---|
| Open hold | The condition must have stayed open this long before its page is enqueued. `0` pages on the first sweep that sees it open (the kinds that need a hand today, the Fansly send guard's `sync_silent` page latches `send_guard_closed` / `pace_violation`, and every `fansly_sync_engine` alert). Sustained kinds: `proxy_failed` 15 min, `stream_failed_threshold` 10 min, `scheduler_silent` / `ops_sampler_silent` / `sync_silent` 10 min, `golden_signal_lag` / `ofapi_burn_rate` 30 min, `ofapi_webhook_silence` 10 min, `db_disk_usage:runway_warning` 6 h. |
| Flap rule | A sustained kind whose latch opened ≥ 5 times inside 6 h pages once as "flapping" even if no episode outlasted the open hold. The page covers every episode in the window. `scheduler_silent` and `ops_sampler_silent` open on deploys, so theirs is ≥ 12 in 6 h. `sync_silent` has none: one Fansly page alone runs 15–17 min between chunks, so with the rest of the fleet blocked it flickers while chunks still start. |
| Quiet hold | The recovery notice is enqueued only once the latch has stayed resolved for the hold (immediate kinds 5–60 min, proxy kinds 30 min, watchdog 10 min, runway warning 24 h). A reopen inside the hold is the same standing page: no message either way. A page whose outbox row ended `suppressed` or `exhausted` never reached the owner, so its recovery is settled silently rather than as an orphan "Resolved". |
| Episodes | Every latch episode (a distinct `opened_at`) is recorded in `notification_incident_cycles` on the first sweep that sees it, including episodes that began and ended between two sweeps; `paged` marks the ones a page covered. |
| Manual resolve | The dashboard's own "Manually resolved" line is the recovery notice; the sweep sees the `incident_manually_resolved` attempt and settles the standing page silently. |
| Digest | Daily, at the report hour after the revenue report: open incidents by age and the quiet episodes of the last 24 h grouped per subject. Skipped when empty; idempotent per due date via an `alert_digest_scheduled` attempt row; gated by the master flag and `syncFailureAlertsEnabled`. |

Idempotency: a held page's outbox key uses the episode's `opened_at`, a
flapping page's the decision instant, a recovery notice's the latch's
`resolved_at`; the paging row and the outbox row commit in one transaction.

`notification_outbox_age` is the age in milliseconds of the oldest
`created_at` among `pending` or `leased` rows, or `0` when none exist. The
minutely golden-signal sample reports the gauge as both p50 and p95 and uses a
300,000 ms threshold under the existing metric-scoped
`golden_signal_lag` incident.

## 5. Adding a failure class

An additive class in the existing error frame requires one family change:

1. Add a structural branch to `normalizeProviderStreamFailure`, or a terminal
   integrity branch to `AiGatewayTerminalStreamConsumer`. Define its exact
   `failure_phase`, status behavior, and whether `retryAfterMs` can be non-null.
   Do not classify from free-form prose unless the signature is an explicitly
   pinned, exact production fixture.
2. Add one static, bounded message literal owned by the new code. The raw cause
   remains a redacted log diagnostic and must not be interpolated.
3. Add a realistic provider/transport/terminal fixture, including adversarial
   near matches and contradictory evidence where precedence matters.
4. Add characterization tests for classification, static SSE output, terminal
   ordering/no-`done`, Retry-After behavior, and absence of provider text.
5. Record the exact code/phase/status in the terminal usage ledger and test
   completed/cancelled/quota-denied nulling. `error_code` is already open text,
   so a code alone needs no database migration.
6. Choose and test an explicit incident policy: kind, latch scope/cause bucket,
   threshold, streak effect, and resolve rule—or deliberately `none`. Incident
   failure must remain log-and-continue after terminal persistence.
7. Add explicit presentation mappings and registry entries in every client
   (fansly-chat, onlyfans-chat, chat-extension), while retaining tests for the
   namespace-based unknown-code fallback and terminal EOF behavior. A new HTTP
   `AppError` code that a chat-extension route can return also gets its row in
   the §2 chat-extension HTTP table; without one it falls to the status rows.
8. Add or update the row in this registry and update any affected retry,
   ledger, incident, outbox, or boundary section in the same change.

A new `code` does **not** require OpenAPI generation or SDK re-vendoring.
Changing the discriminated frame union does. A new frame `type`, a
required/renamed/retyped field, or a closed-enum change requires:

1. core contract/schema and generated OpenAPI/SDK changes;
2. vendored SDK updates in every client (fansly-chat, onlyfans-chat,
   chat-extension);
3. client readers capable of the new shape before core can emit it; and
4. an explicit rollout/rollback gate across core and every client repository.

Removing or repurposing a code and changing an established retry disposition
are also coordinated family changes even when the TypeScript schema hash would
not detect them.

## 6. Boundary and redaction rules

OFAPI roster capture uses `ofapi_admin_accounts_v2`: identity fields are allowlisted
by key and type before journaling; session material is excluded, non-200 bodies
are withheld, and identity conflicts survive the JSON projection. This control-plane
evidence is restricted in tiering and refused by Agent Read.

Fansly pull capture strips one-off CloudFront signing tokens before journaling
(owner decision 2026-09-29, `sync/fansly/lib/cdn-tokens.ts`): for the
named kinds only, `Policy`, `Signature`, `Key-Pair-Id` and `Expires` leave
`locations[].metadata` and a `locations[].location` string that is entirely one
signed https URL on a Fansly CDN host (`cdn<N>.fansly.com`), in the catalog
object and both inline bodies alike. Nothing else is rewritten: user-authored
text such as a comment's `content` keeps every byte even when it holds or opens
with a signed URL. `sync_raw_payloads.mapper_version` gains
`+cdn-tokens-stripped-v1`. Like the [A20] account-field allowlist, this is a
deliberate exception to the verbatim journal: the tokens change on nearly every
read and would defeat content-address dedup. The allowlist fails closed, and
`dm_messages` and `purchase_history` are never stripped because the AI media
describer downloads from their signed URLs. Earlier captures stay verbatim.

Pull capture never fails on an unpaired UTF-16 surrogate in a provider body
(production 2026-09-30, `sync/fansly/lib/journal-lone-surrogates.ts`). json and
jsonb refuse one (22P02, "Unicode low surrogate must follow a high
surrogate"), so a body that holds one is journaled as a copy with each
replaced by U+FFFD, in the catalog object and both inline bodies alike, for
every kind and platform. Whole emoji are never touched, and a body without an
unpaired surrogate is written as the served object itself. The raw row's
`mapper_version` gains `+lone-surrogates-replaced-v1` (after
`+cdn-tokens-stripped-v1` when both apply), and a capture inside a sync run
adds an info note `journal_lone_surrogates_replaced` with both counts. The lane
keeps parsing its unmodified response; text columns receive U+FFFD from the
driver's UTF-8 encoding, and `pages.metadata` takes sanitized Fansly walls and
tiers, as `page_fan_external_notes` takes sanitized fan notes. The capture
returns the body it journaled, and the DM shadow witness hashes that body.

OFAPI governed transport diagnostics (#259) expose only known machine
class/name/code values, header/body stage, elapsed/timeout values, status and
byte counts. They reach structured logs and existing credit-ledger details;
the bounded transport class also reaches the capture job reason. Arbitrary
cause names/codes are untrusted too and are omitted unless allowlisted. Raw
cause messages, proxy/URL fields and provider bodies are never copied. A
`connect` class does not reclassify `post_dispatch` as undispatched, refund an
uncertain attempt or grant retry authority to a stateful command.

`sanitizeError` is the shared diagnostic sanitizer, not a license to expose
diagnostic text:

- it walks nested causes cycle-safely and renders the first useful name,
  message, code, errno, syscall, address, port, and socket metadata;
- it detects query-shaped errors and can substitute a caller-supplied
  query-safe summary;
- it redacts known URL-credential, provider-key, bearer, Telegram-token,
  labelled token/secret/password/authorization, proxy, and bot-token shapes;
  and
- it applies the caller's fallback and clamp policy. Current clamps are 1,024
  characters with ellipsis for sync persistence, a literal 512-character clip
  for voice logs, and 240 characters with ellipsis for notification incident
  summaries. Provider/transport logging retains its established cause-chain
  shape.

The failed-payload journal is the one sink that keeps provider body text:
since decision #248 a normalized sync failure's `error` object carries a
`responseSnippet` — the provider's response redacted through
`redactSensitiveText` and bounded to 400 characters — and it reaches only the
failed raw payload, the `<endpoint>:failed` observation and run telemetry,
never an SSE frame, an incident summary or a client wire.

`FanslyApiError.retryAfterAt` is diagnostic state on the throwable only. It is
read by the failure classifier to set a durable wake-up and by nothing else:
`PersistedSyncError` allowlists the journalled fields, and the sanitizer renders
only name/message/code and socket metadata, so the deadline reaches no
observation, incident summary, ledger row or client wire.

Query detection does not erase SQL automatically when the caller supplies no
replacement. Shape-based redaction is defense in depth, not proof that
arbitrary provider, user, or database text is safe. Ordinary non-secret text
is intentionally unchanged. Pino separately censors structured authorization
headers, proxy URLs, service egress proxy URLs, and Telegram bot-token paths,
and recursively redacts strings in serialized errors.

The allowed failure surface is therefore an allowlist:

| Sink | Allowed | Never allowed |
|---|---|---|
| SSE error frame | Open machine code, its static literal message, nullable non-negative `retryAfterMs`. | Provider/cause/body text, response snippets, prompt/completion, user content, credentials, proxy URL/auth, SQL/params, stack. |
| HTTP intentional error | `AppError` status/code/intentional application message and documented structured extensions. | Arbitrary throwable text or duck-typed error envelopes; secrets or provider bodies. |
| Incident | Kind, latch identity, stable resource/provider identifiers, code, phase, optional status, static sanitized summary. | Provider/cause/body text, prompt/completion, request/user content, credentials, proxy URL/auth, SQL/params, stack. |
| Metrics | Bounded metric names/dimensions, counts, durations, states, and ages. | Any free-form error/provider/user text, prompt/completion, credentials, URLs, SQL/params, stack. |
| `ai_usage_events` | Stable identifiers, quota/outcome, token/cost data, open error code, phase, optional provider status. | Provider/cause/body text, prompt/completion, credentials, proxy URL/auth, user content, SQL/params, stack. |
| Server log | Structured context plus the necessary `sanitizeError`/redacted cause diagnostic. | Unredacted credentials, authorization headers, proxy authentication, raw provider body dumps, unrestricted prompt/completion capture, or raw SQL parameters. |

When in doubt, add a bounded structured field or a restricted capture—not a
free-form string on a broader wire.

`AppError` messages are trusted application output and cross the boundary
unchanged; the boundary does not sanitize or clamp them. Their constructors and
call sites therefore own the same no-secret/no-provider-diagnostic rule.


## OFAPI binding and credential failures (Decision #252)

An HTTP 404 with the vendor machine code `account_not_found` is a missing
provider binding; a message/resource 404 is not. Capture the response first,
mark only the matching current generation unavailable, park runnable streams
with lease revocation and re-stamp only auth blockers of that generation. Foreign
blockers, legacy auth and owner/gate pauses remain untouched. Repeated missing
responses rewrite no state; they retry only the idempotent incident notification
using the original marker time. Responses for replaced bindings do nothing. Later reads and commands
fail locally until verified recovery. DB-only queries and computations remain
available. A late response or lifecycle event from a retired binding cannot
change the replacement's auth state. Verified preview/apply always requires an
authenticated target. The receipt of that apply-time roster is retained as the
forward-only boundary: earlier lifecycle events of the new account are stale.

`whoami` denial is credential access failure, not a model-session failure.
JSON 401/403 is `denied`; missing evidence, transport/edge failures and an
unconfigured expected team are `unknown`; a different observed team is
`mismatch`. All three block stateful vendor actions and webhook management.
Restricted account lists are partial/unknown scope, never proof that hidden
accounts were deleted. Preflight is bound to the key fingerprint and runs at
boot/adoption; correcting its boot configuration requires an approved rollout.

Commands refused before dispatch record `source=local_precondition` and a
typed binding/auth/credential reason in both outbox evidence and the result
observation, without a vendor `httpStatus`. A denied `whoami` is not a denied
send. The claim still consumes the single attempt and settles terminally;
neither a credential correction nor a key rotation automatically replays it.
Actual command HTTP failures keep their provider status and classification.

Owner binding recovery is a preview/apply operation with generation and
blocker-version checks under the ordered page sync-row locks. Verified apply or
same-generation connected/reconnected clears its auth marker even on owner-paused
rows; the pause itself is released only by Resume. A changed recovery snapshot
is refused and requires a new preview. It does not use Reset, delete checkpoints, clear user
pauses, activate collectors or resend indeterminate commands. Unversioned
legacy blockers are retained for explicit review. The free balance read has no
paid fallback and never fabricates a zero result after access/transport failure.


`ofapi_binding_conflict` is a global latch opened by a write-mode canonicalization
sweep when custody and current mapping claim different owners. Only the conflicting
ref is quarantined; a clean write-mode sweep resolves the latch. Dry-run computes
conflicts without opening, delivering or resolving incidents. Initial mapping
returns a conflict on another page’s historical account; lifecycle status cannot
hide that owner.


### OFAPI audience quality hold

A completed paginated audience sweep that saw zero fans while current subscriptions
exist returns `qualityHold=subscribers_empty_sweep_guard` (decision #258). Existing
membership and the successful checkpoint are preserved. The executor records a
skipped run without changing freshness/failure evidence or resolving incidents;
`sweep_not_due` carries the hold forward. This is distinct from a pre-egress ramp
gate. A durable checkpoint marker keeps both status readers Unverified until a
certified sweep clears it, even after a lost-lease completion without hold stats.
The single empty first-page guard and malformed-identity failures retain their
existing failure classification.


### Typed OFAPI owner actions (Decision #272)

Owner action intents preserve prepared, dispatching, confirmed, partial, rejected,
indeterminate and cancelled states. A busy nonblocking dispatch lock returns 409
without HTTP and keeps the prepared intent. Definitive local admission refusal
returns 503 without HTTP; timeout, 5xx or an unproven successful response retain an
indeterminate outcome. Confirmed HTTP acceptance never asserts campaign delivery
or money transfer. Retained response repair cannot redispatch the request.
Encrypted commands/responses never enter audit metadata or error messages.

Delivery-history GET diagnostics distinguish admission, authorization, response headers/body, durable capture and response contract failures. Local scan failures use `history_<stage>_failed` for missing capture, parsing, window validation or persistence; vendor HTTP refusals retain `vendor_http_<status>`. Only fixed machine fields cross into scan state/logs, with no raw error, SQL, URL, headers or payload. The free `ofapi_webhook_deliveries` GET uses a 60-second HTTP deadline; other admin requests keep 15 seconds. This does not change polling cadence or retry any write.


### OFAPI receipt canonicalization and history windows (Decision #276)

A settled accepted receipt attempts its exact observation through the shared
canonicalizer after operational projections. Row-level failure remains parse
debt in the retained observation and is recoverable by the bounded sweep or exact
local replay. It does not roll back receipt/SSE state or trigger provider
redelivery. An exception escaping the driver logs only the local event ID and a
fixed deferral message. Background cursor CAS loss ends that family's pass without
overwriting the winning cursor; already committed facts deduplicate on repetition.

History validation includes the full boundary seconds. A fractional lower bound
must not reject a provider timestamp within that same second. Outside those
seconds `history_window_failed` still retains the raw page and old offset. A
retry of a legacy scan uses its original query bounds and offset; normalization
must never change the provider query halfway through pagination.


### Desktop media resolve (media images)

`POST /api/v1/ofapi/media/resolve` answers HTTP 200 with a closed `outcome`
(`free_url`, `ofapi_cache`, `paid`, `cap_blocked`, `source_expired`,
`unavailable`, `refused`, `pending`, `error`) and a bounded machine `reason`;
these are decisions, not `AppError` codes. HTTP errors stay in the registry:
404 `not_found` for an account not granted to the chatter (the read gateway's
rule), 503 `service_unavailable` while the desktop read gateway is disabled,
400 for an invalid request (a client URL is never accepted; a transfer
report above 30,000,000 bytes), 409 `conflict`
(reason `request_id_reused`) for a `requestId` already used for another file,
429 for the per-device rate limit (keyed by the authenticated device token,
`retry-after` in seconds). Retry law: a paid transfer is never retried
automatically; a lost response may be retried once with the SAME `requestId`
(a concurrent twin joins the resolve in flight, a later one gets the recorded
answer); `pending` (`in_flight`, `busy`) is final for its `requestId` and
advises `retryAfterMs` for a new one; `cap_blocked` by the daily budget carries
the next UTC midnight in `retryAt` and, like `size_unknown` and `click_only`
(an automatic request for `full`), yields only to an explicit click;
`refused` and `unavailable` are not bypassed by a click, except `refused`
`not_ready`, which a click may refresh once through its `reread` hint. A
paid transfer report of more bytes than its hand-out allowed is rejected and
changes nothing; a report can only lower an unknown-size click's debit. Only
fixed reasons, identifiers and error classes/SQL states reach logs and the
decision log — never a URL, signature, provider body, driver error message or
file content. See [the media runbook](runbooks/ofapi-media.md).

### Fansly socket capture (Decision #343)

A live page's socket runs in the `sync` process (`sync/fansly/ws/source.ts`); the
legacy B0 receiver of the worker is gone since step 4 (S4-12).
Ownership/generation loss, unavailable capture, overflow and transport failure
close the connection and retain an unknown coverage gap. Pending decode settlement
never retries a provider request: raw survives and bounded inline repair settles
metadata later. Unknown children remain debt. An auth 401 blocks its generation
across restarts; other failures use bounded backoff, reset by a durable capture
or 60 verified seconds. Socket teardown destroys the upgraded transport even if
the peer ignores close. Only fixed reasons/page labels enter logs; provider
errors, SQL errors, tokens and raw frames do not. See
[the socket and its repair](runbooks/sync.md#the-socket-and-its-repair) for
the limits and the erasure residual.

### Fansly B1 addressed reads (Decisions 384–385; retired)

The B1 hint lane is deleted with the legacy engine (step 4: the projector in S4-11,
the hint step of the DM handler in S4-14). No hint request is admitted, retried or
settled any more. What a socket event asks for is the Fansly Sync Engine's work
(`dm-messages.head`, `transactions.head`, …), and a read that fails follows the
engine's one error table (`apps/runtime/src/sync/README.md`, "Errors"): a breaker of
the subject, a hold of the route for a 429, a page hold for a refused credential.

`fansly_ws_hint_receipts`, its attempts and the `fansly_ws_hint_status` view stay as
records. A `source_deleted` row there settled an exact operational target after a
contiguous REST check, not archive materialization; its `hot_applied_at` is null.
See [what the legacy runbooks became](runbooks/sync.md#what-the-legacy-runbooks-became).
