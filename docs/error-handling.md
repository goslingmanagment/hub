# Error-handling canon

This is the single canonical error-handling reference for the Agency Hub family:
the core kernel, the ChatGoose Firefox extension, and the ChatGoose Desktop
Electron application. It records the currently implemented contract and the
family law from core Decisions #154/#182/#183/#184, extension Decisions
E38/E57/E58, and desktop Decision D25. Change this document in the same family
change as any behavior recorded here; do not maintain client-side copies.

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
| Anthropic adapter | The SDK's HTTP-level retry behavior remains intact. For a page-proxy connect failure, `createStickyConnectFailureFetch` permits one physical proxy dial per resolved generation client; later SDK attempts receive the cached connect failure immediately. | The provider SDK owns eligible response-level attempts; neither client owns them. |
| OpenRouter adapter | One local fetch; there is no adapter retry loop. | A later generation is a new explicit action. |
| Voice synthesis | One paid provider dispatch. A timeout, transport failure, or ambiguous status remains dispatched and is swept to the existing indeterminate outcome; it is never redispatched automatically. Idempotent replay reads the same request result. A queued waiter heartbeats durable ownership until a process-local synthesis slot opens. | A deliberate new take is a new paid attempt. |
| OFAPI state-changing commands | One execution attempt per command row; an indeterminate mutation is never automatically sent again. Typing, unsend, and mark-read reject retry lineage. | Only an explicitly requested, policy-permitted same-kind retry creates a new command row and lineage; it is never a second attempt on the old row. |
| Sync/capture reads | Existing lane-specific pacing, durable retry state, and reconciliation remain authoritative; queue redelivery is not a substitute for that state machine. Safe-read retry deadlines are anchored to the failure transition, after transport/capture has finished, using the same clock sample as persistence. | The owning sync/capture lane, never an AI code or chatter card. |
| OFAPI sync reads — collection policy (review #136) | A collection-policy refusal before the fetch is journaled under attempt failure kind `policy` and classified under its own retry class `ofapi_collection_policy`: a time-bound cap sleeps until the repository's reset instant (next UTC day, interval window reopening), the background pause re-checks every 15 min so Resume heals the stream by itself, and a durable policy decision or misconfiguration parks the stream `manual_action_required` with code `ofapi_collection_<reason>`. No sync incident opens — the console already shows the owner's own decision. | The owner's collection policy; a parked stream is unblocked after the policy changes. |
| OFAPI sync reads — status matrix (Decision #245) | `402` retries under `ofapi_insufficient_credits` (OFAPI does not charge the rejected request; ordinary ≤30 min per-stream backoff), opens the credit-ledger monitor's own global low-credit latch (no per-stream threshold alert on top), and that latch is resolved only by a later chunk that actually received an OFAPI response; `401`/`403` park the stream `manual_action_required` without pausing the page; other `4xx` park as `provider_bad_data`; `429` and `5xx` retry under `rate_limit` / `provider_5xx`; a status-less transport failure stays `transient_network`. | The owner tops up credits — the incident resolves itself on the first chunk that succeeds afterwards — or fixes the key/mapping and unblocks the parked stream. |
| OFAPI bounded collection reads — captured transient HTTP | Only a durably captured GET response with `429` or `500`–`599` ends the current background run as `failed`, preserving its response, cursor, caps and consumption. There is no immediate retry or second dispatch on that run; a new bounded run is eligible only at the next configured schedule interval. One-offs remain paused. Auth, other HTTP statuses, indeterminate transport and parse failures keep their existing recovery behavior. | The owner's scheduled policy authorizes the next window. Resume on a legacy paused transient response only replays its captured response locally and ends that run as failed; a fresh one-off probe requires separate bounded approval. |
| OFAPI bounded collection reads — owner finishes incomplete | An owner may close an idle paused background GET run as `failed` after reviewing its retained state, including an uncertain charge. The revision/state/page-fenced action preserves all response, attempt, ledger, cursor and allowance evidence; it performs no egress or charge reconciliation. One-offs, uploads, exports and active work are ineligible. | The explicit owner finish unblocks only the next configured periodic window under current policy. It neither resumes the old cursor nor overrides global/category pause. |
| Fansly `dm_conversations` sweep — erasure fence (Decision #214) | A page whose write transaction cannot take the shared erasure fence writes nothing and yields the chunk with a **+60s** `continuationRetryAt`; the same offset is re-fetched on the next dispatch. Never an exception, never a partial apply. | The sweep's own cursor. The erasure releases the fence by committing; nothing operator-side is required. |
| Fansly `dm_conversations` sweep — uncertified membership (Decision #214) | A completed walk whose row-side generation set does not reproduce its `observedCount` withholds the destructive visibility pass and the success stamp, and yields with a **+15min** `continuationRetryAt`. The retry is a FRESH sweep from offset 0 under a higher generation, never a resumption of the uncertified one. | The next sweep converges on its own; an operator only intervenes if `dm_conversations_generation_membership_guard` keeps firing. |
| Critical-notification delivery | The durable outbox automatically retries delivery failures to a bounded attempt cap. This retries the notification only, never the failed business action. | Outbox lease/attempt policy; suppression and exhaustion are terminal. |

## 2. SSE wire-code registry

`failure_phase` is exactly `connect | provider_response | stream`. In the
incident column, `global` means the singleton latch
`ai_provider_billing:global`; `page/provider` means
`ai_provider_failed:<pageId>:provider`; and `page/proxy` means
`ai_provider_failed:<pageId>:proxy`. A page incident requires a non-null
`pageId`.

| Wire code | Static wire message | Meaning and failure phase | `retryAfterMs` | Default recovery disposition | Incident policy | Firefox extension mapping | Desktop mapping |
|---|---|---|---|---|---|---|---|
| `provider_billing` | `AI provider billing requires attention` | Anthropic HTTP 400 `invalid_request_error` whose provider message exactly matches the production low-credit signature; `provider_response`. Near matches remain generic. | Always `null`. | Do not retry until an operator restores provider credit. | `ai_provider_billing`; `global`; immediate on first failure. | `hub_provider_billing` / `CG-HUB-12` | `CG-HUB-04` |
| `provider_auth` | `AI provider authentication failed` | Structured provider authentication/permission evidence or HTTP 401/403; `provider_response`. | Always `null`. | Do not retry until an operator repairs the server-side provider credential or permission. | `ai_provider_billing`; `global`; immediate on first failure. | `hub_provider_auth` / `CG-HUB-13` | `CG-HUB-05` |
| `provider_rate_limited` | `AI provider rate limit reached` | Structured provider rate-limit evidence or HTTP 429; `provider_response`. | Parsed from `Retry-After` seconds or HTTP date when valid, otherwise `null`; this is the only code that can carry a value. | No automatic retry; wait until the displayed deadline, then retry manually if needed. | `ai_provider_failed`; `page/provider`; threshold 3. | `hub_provider_rate_limited` / `CG-HUB-14` | `CG-HUB-06` |
| `provider_unavailable` | `AI provider is temporarily unavailable` | Structured provider unavailable/overload evidence, HTTP 529, or any provider 5xx; `provider_response`. | Always `null`. | No automatic retry; retry manually later and escalate a continuing outage. | `ai_provider_failed`; `page/provider`; threshold 3. | `hub_provider_unavailable` / `CG-HUB-15` | `CG-HUB-07` |
| `provider_proxy_unreachable` | `AI gateway could not reach the page's egress proxy` | Named/code-based connect failure in the cause chain, or an explicit connect-phase failure; `connect`. | Always `null`. | Do not retry until the page's egress route is restored. | `ai_provider_failed`; `page/proxy`; threshold 3. | `hub_provider_failed` / `CG-HUB-10` | `CG-HUB-08` |
| `provider_stream_failed` | `AI gateway provider stream failed` | Generic provider/transport failure. A supplied `provider_response` phase or status-bearing unclassified response is `provider_response`; a failure after output starts, a stream-phase hint, or an otherwise statusless fallback is `stream`. | Always `null`. | Do not blind-retry; inspect the provider path and retry manually only after judgment. | `ai_provider_failed`; `page/provider`; threshold 3. | `hub_provider_failed` / `CG-HUB-10` | Provider fallback: `CG-HUB-10` |
| `provider_output_empty` | `AI gateway provider completed without usable output` | Provider termination produced no non-whitespace output after stronger terminal-integrity checks; `stream`. | Always `null`. | Discard the unusable result; a later regeneration is manual. | `ai_provider_failed`; `page/provider`; threshold 3. | `ai_output_unusable` / `CG-API-06` | Provider fallback: `CG-HUB-10` |
| `provider_usage_missing` | `AI gateway provider ended without usage metadata` | Output exists but the terminal provider stream supplied no usage metadata; `stream`. | Always `null`. | Discard as an incomplete terminal; investigate before repeated manual generation. | `ai_provider_failed`; `page/provider`; threshold 3. | Provider fallback: `hub_provider_failed` / `CG-HUB-10` | Provider fallback: `CG-HUB-10` |
| `provider_stream_incomplete` | `AI gateway provider stream ended without a terminal stop reason` | Output and usage exist, but no `done`/terminal stop reason exists; `stream`. | Always `null`. | Discard the partial result; investigate before repeated manual generation. | `ai_provider_failed`; `page/provider`; threshold 3. | Provider fallback: `hub_provider_failed` / `CG-HUB-10` | Provider fallback: `CG-HUB-10` |
| `coach_output_too_long` | `AI gateway output exceeded the coach transport ceiling` | Coach output crossed the 64,000-character transport ceiling; `stream`. The crossing delta is emitted, then this error, with no `done`. | Always `null`. | Change or narrow the request before a new manual generation; retrying the same request is not recovery. | `ai_provider_failed`; `page/provider`; threshold 3. | Non-provider fallback: `hub_request_failed` / `CG-HUB-07` | Non-provider fallback: `CG-HUB-02` |

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
- A transport EOF without an explicit error frame and without `done` is a
  client-observed truncation, not a kernel wire code: Firefox uses
  `hub_stream_truncated` / `CG-HUB-16`; Desktop uses `CG-HUB-09`.
- Both clients preserve a non-null `retryAfterMs` as an absolute display
  deadline. Neither schedules an SSE generation retry from it.

## 3. HTTP AppError registry

These are all `AppError` codes emitted by current core constructors and current
`ProductGateError` call sites. The response boundary preserves their declared
status, code, and intentional message.

| Family | Code | Status | Semantics |
|---|---|---:|---|
| General | `bad_request` | 400 | Route/service-specific invalid request represented intentionally by `BadRequestError`. |
| General | `unauthorized` | 401 | Missing, invalid, or rejected principal. |
| General | `forbidden` | 403 | Authenticated principal is not permitted to perform the operation. |
| General | `not_found` | 404 | Requested resource does not exist or is not visible to the principal. |
| AI | `unknown_ai_feature` | 404 | This core does not implement the requested AI feature key. |
| General | `conflict` | 409 | Route/service-specific state conflict. |
| AI | `persona_definition_changed` | 409 | Selected persona changed after the client read the catalog; refresh before retrying. |
| Sync | `sync_snapshot_restart_required` | 409 | Resume cursor is below the replay continuity floor; response also carries `replayFloor` and `snapshotPath`. |
| General | `rate_limit_exceeded` | 429 | Generic API rate limit, distinct from the AI gateway's daily quota and provider SSE rate code. |
| General | `service_unavailable` | 503 | Intentional temporary service unavailability. Also the OFAPI coverage-revoke idempotency proof when the prior proof's captured body is unreadable (Decision #223) — never the 409 that means the action belongs to a different proof. |
| Capture | `capture_payload_unavailable` | 503 | The agent plane's owner-only observation payload read (#9b): the envelope has no inline body and its content-addressed copy could not be read right now. Deliberately NOT one of the handler's withholding reasons — `restricted_class` is a decision the kernel made, this is a fetch that failed, and Decision #223 exists because the two were the same answer. Transient and retriable. |
| Egress | `proxy_missing` | 409 | A Fansly page has no stored proxy, so fail-closed egress refuses the request. |
| OFAPI | `ofapi_collection_refused` | 429 / 409 | A local collection-policy refusal before any vendor fetch (review #136); the body also carries the machine `reason` and `retryAfterMs`. 429 when only time clears it (`daily_limit`, `interval_limit` — `retryAfterMs` is the reset advice and `Retry-After` mirrors it); 409 when only an owner policy change clears it (`background_paused`, `collection_off`, `on_demand_only`, `detail_disabled`, job and configuration reasons). Never retried automatically; never 500/503. |
| AI | `quota_denied` | 429 | Core AI daily budget/quota rejected the generation before provider dispatch. |
| AI gate | `gate_draft_required` | 400 | Feature policy requires nonblank `draftText`. |
| AI gate | `gate_voice_unsupported_platform` | 400 | `voice-script` was requested for a non-Fansly page. |
| AI gate | `gate_voice_identity_required` | 400 | `voice-script` requires nonblank, matching conversation and fan identities. |
| AI gate | `gate_voice_disabled` | 400 | Voice feature flag is off or the page is outside the effective voice allowlist; both intentionally collapse to this gate. |
| AI gate | `gate_voice_provider_unavailable` | 400 | Voice-script product gate found no configured voice synthesis provider. |
| AI gate | `gate_voice_no_profile` | 400 | Voice-script product gate found no voice profile for the page. |
| AI gate | `gate_min_messages` | 400 | Conversation message count is below the selected feature's minimum. |
| AI gate | `gate_hi_greeting_limit` | 400 | Conversation exceeds the hi-greeting maximum. |
| AI gate | `gate_ping_active` | 400 | Ping generation is blocked while the conversation segment is active. |
| Voice | `voice_disabled` | 403 | Voice-note lane is disabled. |
| Voice | `voice_provider_unavailable` | 503 | Live voice flag is on but provider boot dependencies are unavailable, or an active erasure temporarily owns the page writer fence; no provider spend is admitted. |
| Voice | `voice_not_allowlisted` | 403 | Page is not allowlisted for voice notes. |
| Voice | `voice_no_profile` | 409 | Page has no configured voice profile. |
| Voice | `voice_script_invalid` | 400 | Submitted script fails voice validation. |
| Voice | `voice_source_invalid` | 400 | Source voice-script generation is missing, ineligible, or not owned by the page. |
| Voice | `voice_quota_denied` | 429 | Page's daily voice-character budget is exhausted. |
| Voice | `idempotency_mismatch` | 409 | Voice `clientRequestId` was reused with a different request. |
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
so enabling the flag later affects new transitions only. Existing sync
incident delivery remains outside this AI critical-outbox policy.

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
7. Add explicit presentation mappings and registry entries in both clients,
   while retaining tests for the namespace-based unknown-code fallback and
   terminal EOF behavior.
8. Add or update the row in this registry and update any affected retry,
   ledger, incident, outbox, or boundary section in the same change.

A new `code` does **not** require OpenAPI generation or SDK re-vendoring.
Changing the discriminated frame union does. A new frame `type`, a
required/renamed/retyped field, or a closed-enum change requires:

1. core contract/schema and generated OpenAPI/SDK changes;
2. vendored SDK updates in both clients;
3. client readers capable of the new shape before core can emit it; and
4. an explicit rollout/rollback gate across all three repositories.

Removing or repurposing a code and changing an established retry disposition
are also coordinated family changes even when the TypeScript schema hash would
not detect them.

## 6. Boundary and redaction rules

OFAPI roster capture uses `ofapi_admin_accounts_v2`: identity fields are allowlisted
by key and type before journaling; session material is excluded, non-200 bodies
are withheld, and identity conflicts survive the JSON projection. This control-plane
evidence is restricted in tiering and refused by Agent Read.

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
