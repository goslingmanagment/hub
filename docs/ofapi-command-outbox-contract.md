# OFAPI Desktop Command Outbox Contract

Status: C6b1 intake/read/cancel, C6b2 executor, terminal payload redaction, desktop recovery
transport, controlled text execution, and the core typing/unsend/mark-read command slices are
implemented and production-validated as of 2026-06-20. The bounded media/PPV send command slice is
implemented pending production validation.
Decision owner: core Decisions #55, #56, #58, #59, #60, and #61.

## Boundary

Core owns command ids, dedupe, authorization, durable state, and eventual vendor execution.
Desktop owns draft text, optimistic UI, and its local outbox until a core command is accepted.
OFAPI remains unreachable through arbitrary methods or paths.

The v1 boundary remains deliberately narrow:

- `OFAPI_DESKTOP_COMMAND_OUTBOX_ENABLED` gates intake/read/cancel.
- `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED` gates vendor execution and requires the outbox flag.
- Executable command kinds are narrow and versioned: `send_text_message_v1`,
  `send_media_message_v1`, `typing_active_v1`, `unsend_message_v1`, and `mark_chat_read_v1`.
  Uploading, liking, reply-to sends, and arbitrary vendor write paths remain outside this command
  version.

## Version 1 Commands

Text send:

```json
{
  "clientCommandId": "uuid",
  "kind": "send_text_message_v1",
  "accountId": "acct_...",
  "conversationId": "numeric OnlyFans fan/chat id",
  "payload": {
    "text": "non-blank, max 10000 characters"
  },
  "retryOfCommandId": "optional core command UUID"
}
```

Media/PPV send with existing media ids:

```json
{
  "clientCommandId": "uuid",
  "kind": "send_media_message_v1",
  "accountId": "acct_...",
  "conversationId": "numeric OnlyFans fan/chat id",
  "payload": {
    "text": "caption may be empty, max 10000 characters",
    "price": 25,
    "mediaFiles": ["3866342509", "ofapi_media_abc123"],
    "previews": ["3866342509"]
  },
  "retryOfCommandId": "optional core command UUID"
}
```

Typing beacon:

```json
{
  "clientCommandId": "uuid",
  "kind": "typing_active_v1",
  "accountId": "acct_...",
  "conversationId": "numeric OnlyFans fan/chat id",
  "payload": {}
}
```

Unsend message:

```json
{
  "clientCommandId": "uuid",
  "kind": "unsend_message_v1",
  "accountId": "acct_...",
  "conversationId": "numeric OnlyFans fan/chat id",
  "payload": {
    "messageId": "numeric OnlyFans message id"
  }
}
```

Mark chat read:

```json
{
  "clientCommandId": "uuid",
  "kind": "mark_chat_read_v1",
  "accountId": "acct_...",
  "conversationId": "numeric OnlyFans fan/chat id",
  "payload": {}
}
```

Version 1 media sends accept only bounded media identifiers already known to OFAPI. They reject
URLs, local file bytes, filenames, reply-to fields, upload instructions, likes, and unknown payload
fields. Typing, unsend, and mark-read commands cannot set `retryOfCommandId`. Text and media sends
may retry only same-kind owned terminal/indeterminate commands in the same lane. Typing is
advisory: desktop does not need recovery UI for a missed beacon. Unsend is destructive: desktop
tombstones the local row only after core confirms the DELETE response or a later
`messages.deleted` event/snapshot tombstone. Mark-read confirms only from the OFAPI response; any
later read workflow action is a fresh command.

## API

### Create

`POST /api/v1/ofapi/commands`

- Auth: chatter API key only.
- ACL: `accountId` must map to one of the caller's currently assigned pages.
- New canonical request: `202`, `deduplicated=false`, state `queued`.
- Exact duplicate: `200`, `deduplicated=true`, returns the existing command.
- Reused client id with any canonical-field mismatch: `409`.
- Intake disabled: `503`.

### Read

`GET /api/v1/ofapi/commands/{commandId}`

Only the creating chatter can read it. Unowned/unknown ids return `404` without existence
disclosure.

### Cancel

`POST /api/v1/ofapi/commands/{commandId}/cancel`

Only `queued -> cancelled` is mutable. Repeating cancel on `cancelled` is idempotent. Any other
state returns `409`.

## Response Shape

Command responses omit command payloads:

```json
{
  "commandId": "uuid",
  "clientCommandId": "uuid",
  "kind": "send_text_message_v1 | send_media_message_v1 | typing_active_v1 | unsend_message_v1 | mark_chat_read_v1",
  "accountId": "acct_...",
  "conversationId": "123",
  "state": "queued",
  "payloadHash": "sha256 hex",
  "retryOfCommandId": null,
  "attemptCount": 0,
  "lastErrorCode": null,
  "lastErrorClass": null,
  "verifierResult": null,
  "platformMessageId": null,
  "createdAt": "UTC ISO timestamp",
  "updatedAt": "UTC ISO timestamp",
  "deduplicated": false
}
```

## State Machine

```text
queued -> cancelled
queued -> in_flight
in_flight -> confirmed
in_flight -> failed_retryable
in_flight -> failed_terminal
in_flight -> indeterminate
indeterminate -> confirmed   (matching webhook or read-only verifier)
```

No transition requeues the same row. Retry creates a new row and references the terminal original.
Only one row may be `in_flight` for a `(page_id, conversation_id)` lane.

## Desktop Status and Recovery UX Contract

Desktop may display command state from the core status endpoint, but must keep draft/message text in
desktop-local state. Core status responses never return the payload text needed to rebuild a draft.

- `draft` / `local_pending`: desktop-local only; no core command exists yet.
- `queued`: accepted by core. If execution is disabled, desktop should show that sending is parked
  by the server and may offer cancel while the command remains queued.
- `in_flight`: one server-owned attempt is in progress. Desktop must not submit an automatic
  duplicate or fall back to direct send for the same client command id.
- `confirmed`: terminal success. The optional `platformMessageId` may be used to reconcile the
  optimistic bubble when present.
- `failed_retryable`: terminal failed attempt that a human may retry. Retry creates a new
  `clientCommandId` with `retryOfCommandId`; core never retries the same row.
- `failed_terminal`: terminal policy/auth/validation failure. Desktop may let the chatter edit and
  submit a new command, but must use a new `clientCommandId`.
- `indeterminate`: the server cannot prove delivery or failure. Desktop must present this as a
  manual recovery state, not as failed-safe-to-resend. A retry is a new command and should be a
  visible human decision after checking the platform/conversation when possible.
- `cancelled`: queued command cancelled before any vendor attempt.

Desktop implements this UX around text sends. Recovery does not add a `GET /messages` body read
solely to decide command outcome; the core response path and `messages.sent` webhook verifier are
the non-read-state-changing evidence sources. `typing_active_v1` is lossy/advisory and does not
participate in desktop recovery. `unsend_message_v1` does not retry or poll message bodies; if the
command is not confirmed, desktop leaves the local message visible until an authoritative delete
event/snapshot tombstone arrives or a human retries after inspecting the conversation.

## Dedupe and Retention

The dedupe key is `(page_id, chatter_user_id, client_command_id)`. Canonical request hashing includes
kind, account, conversation, payload, and retry lineage. Rows have a minimum 400-day dedupe horizon.
Payload text redaction does not shorten that horizon or change the stored `payload_hash`. Retry
lineage must stay within the same command kind; typing commands are not retryable.

## Payload Retention, Purge, and Export Policy

Text commands store `payload.text` while the command may still execute or need recovery. Typing
commands store only `{}`. Unsend commands store only the numeric target `messageId`. The worker
sweep tombstones terminal text command payloads after the recovery window while preserving
non-text audit and dedupe fields; terminal typing payloads remain empty and terminal unsend
payloads retain the target message id for audit.

- Retain full payload only while the row may still need execution, webhook repair, explicit human
  recovery, or retry-context inspection.
- After a command is terminal and outside the recovery/correlation window, purge tombstones
  `payload.text` while preserving non-text audit fields: command ids, page,
  chatter, account, conversation id, state, payload hash, retry lineage, attempt timestamps,
  bounded error code/class, verifier source, platform message id, and dedupe horizon.
- `indeterminate` rows keep payload until a human recovery decision creates a retry, accepts the
  outcome, or the future governance policy expires the recovery window.
- Owner/admin exports, diagnostics, audit logs, and command status APIs may include only the
  non-text audit fields above. They must not include `payload.text`, raw vendor bodies, or webhook
  text copied from verifier comparisons.
- Raw command payload export is not part of C6b. If ever required for legal support, it needs a
  separate owner-approved governance decision with scope, ACL, audit trail, and retention limits.
- The first runtime implementation is purge-only: no owner/admin export includes raw command text.
  Desktop write transport still requires the recovery UI and controlled live send validation.

## Production Validation

The intake slice is validated with execution disabled:

1. Prove both runtime roles report outbox enabled and execution absent/off.
2. Create one harmless command for an assigned account.
3. Repeat it and prove exact dedupe returns the same command.
4. Reuse the client id with changed text and prove `409`.
5. Prove unassigned account and another chatter cannot access it.
6. Cancel it, repeat cancel, and prove no OFAPI credit ledger row or vendor request was created.

No real fan send is authorized by this validation. Execution requires a separately designated
controlled test fan and a new rollout decision.

### 2026-06-19 Production Evidence

- Canonical deploy revision: `ea81511d92de`; API and worker both healthy on the same dependency
  checksum.
- Before enablement, both active runtime heartbeats reported read gateway `true`, command outbox
  `false`, and no skipped overrides. A real chatter-key create returned
  `503 service_unavailable`.
- The audited staged override was then enabled at version 1 and the same revision redeployed.
  Both active runtime roles reported read gateway `true`, command outbox `true`, and
  `skippedOverrides=[]`.
- One harmless, never-executed command produced the expected status matrix:
  create `202`, exact replay `200`, mismatched replay `409`, unassigned account `404`, read `200`,
  cancel `200`, repeated cancel `200`.
- The replay returned the same command id with `deduplicated=true`; no command response contained
  payload text.
- The durable row ended `cancelled` with `attempt_count=0`, a 64-character SHA-256 payload hash,
  an exact 400-day dedupe horizon, and no `in_flight` rows.
- The credit-ledger baseline did not move during the command lifecycle, and production API/worker
  logs contained no payload text. The command service has no vendor execution path.
- Cross-chatter ownership remains covered by the Docker-backed integration case. Production used
  one existing chatter credential and did not create an artificial second user/key solely for
  validation.

The historical intake-only evidence above remains useful, but the separate controlled execution
gate has now passed; see the 2026-06-20 evidence below.

## C6b2 Executor Contract

Status: executor implemented, live-enabled through audited staged config, and production-validated
for text and typing command slices.
Decision owner: core Decision #56.

### Flag and Queue Boundary

- `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED` is a default-off staged boot flag requiring
  `OFAPI_DESKTOP_COMMAND_OUTBOX_ENABLED`.
- Intake remains available while execution is off. Disabling execution parks `queued` commands
  and prevents new claims.
- API create may enqueue an execution wakeup only after durable insert. A minutely sweep is the
  recovery path for a lost wakeup.
- The worker claims `queued -> in_flight` transactionally. The existing partial unique index
  remains the authority for one in-flight command per `(page_id, conversation_id)` lane.
- A command row is attempted at most once. No pg-boss retry or service retry may issue a second
  vendor request for the same row.

### Vendor Requests

`send_text_message_v1` executes exactly:

```text
POST /api/{accountId}/chats/{conversationId}/messages
{"text":"..."}
```

`send_media_message_v1` executes exactly one message POST with bounded media fields:

```text
POST /api/{accountId}/chats/{conversationId}/messages
{"text":"...","price":25,"mediaFiles":[3866342509,"ofapi_media_abc123"],"previews":[3866342509],"lockedText":true}
```

`previews` is omitted when empty. `lockedText` is derived by core only when `price > 0` and the
caption is non-blank.

`typing_active_v1` executes exactly:

```text
POST /api/{accountId}/chats/{conversationId}/typing
```

`unsend_message_v1` executes exactly:

```text
DELETE /api/{accountId}/chats/{conversationId}/messages/{messageId}
```

All requests use the core OFAPI client, global pacing, page-attributed credit accounting, a bounded
timeout, and no automatic retry. Message text and media identifiers are never logged or copied into
error/verifier metadata. Typing has no text/media payload and records zero fallback credits if a
successful OFAPI response omits `_meta`; provider `_meta._credits.used` still wins when present.
Unsend and mark-read have no text/media payload and use normal OFAPI response credit observation.

### Outcome Classification

- Valid text/media-send `2xx` JSON with a message id: `confirmed`, record `platform_message_id`.
- Valid typing `2xx` JSON or empty success: `confirmed`, leave `platform_message_id` null.
- Valid unsend `2xx` JSON with `success=true`, or empty `2xx/204` success: `confirmed`, record the
  target message id as `platform_message_id`.
- Definite validation/auth/not-found rejection (`400`, `401`, `403`, `404`, `409`, `422`):
  `failed_terminal`.
- Definite pre-delivery throttling (`429`): `failed_retryable`; retry remains a new human-visible
  command with a new client id.
- Transport error/timeout, `408`, `5xx`, or malformed/ambiguous success: `indeterminate`.
- A worker crash or shutdown can lose knowledge after claim. Any stale `in_flight` row becomes
  `indeterminate`; it is never automatically requeued.

The stored error surface is a bounded code/class/status only. Raw vendor bodies and payload text
are not persisted in command outcome metadata.

### Webhook Verification

A settled `messages.sent` event may confirm `send_text_message_v1` or `send_media_message_v1`
commands in `in_flight` or `indeterminate` only when all of these hold:

1. OFAPI account and fan conversation match.
2. Normalized webhook text exactly equals normalized command text.
3. For media sends only, webhook price and media count match the command payload.
4. The event falls inside the bounded attempt-correlation window.
5. Exactly one eligible command matches.

Ambiguous, late, missing-id, missing-conversation, missing media-count for media sends,
non-send-kind, or multi-candidate events do not mutate command state. Successful HTTP response
remains the primary confirmation path; webhook matching repairs response-loss and worker-crash
cases without an extra `GET /messages` that could affect read state or spend credits.

### Production Gate

The executor is first deployed and validated with execution off. Enabling it requires:

- both runtime roles reporting outbox and execution enabled with no skipped overrides;
- no pre-existing unintended `queued` rows;
- one explicitly designated controlled test fan/conversation;
- operator-approved harmless text for text sends, an owner-account existing media id for media
  sends, or an owner-account non-message mutation for other command kinds;
- proof of exactly one OFAPI credit-ledger attempt, terminal command state, matching
  `messages.sent`/projection when validating text delivery, and no payload text in logs;
- rollback proof that disabling execution leaves intake available and prevents new claims.

Desktop write transport remains direct until this live gate passes, payload purge/export
implementation exists, and command status/recovery UI is implemented.

### C6b2 Implementation

- Migration `0039_ofapi_command_execution.sql` adds attempt timestamps, queued/verifier indexes,
  and a database constraint limiting each command row to one attempt.
- The API enqueues a durable wakeup only after a new command is committed. The worker owns
  `ofapi.commands.execute` and `ofapi.commands.sweep`; execute jobs have zero retries.
- The core OFAPI client implements the versioned text-send request and advisory typing request.
  Text returns only the platform message id and records operation `ofapi_command_send_text`.
  Typing returns only `{ success: true }` and records operation `ofapi_command_typing_active`.
  Unsend returns only `{ success: true }` and records operation `ofapi_command_unsend_message`.
- Command status responses expose nullable attempt start/finish timestamps, but no payload text.
- The minutely command sweep also redacts old terminal command payload text while preserving
  command state, payload hash, verifier metadata, platform message id, and retry lineage.
- Post-settle `messages.sent` processing runs the conservative verifier before the existing
  best-effort projections. Verifier failure cannot block webhook settle/fanout.
- The default execution flag remains off. No production send is performed by implementation or
  default-off deployment validation.

### 2026-06-19 Default-Off Production Evidence

- Canonical deploy revision: `47a36525e653`; API and worker both healthy on the same dependency
  checksum.
- Migration `0039_ofapi_command_execution.sql` is applied. Production schema contains
  `attempt_started_at`, `attempt_finished_at`, and the at-most-one-attempt constraint.
- Active API and worker heartbeats reported command outbox `true`, command execution `false`, and
  `skippedOverrides=[]`. No staged config row exists for execution, so the default-off value is the
  active runtime truth.
- `ofapi.commands.execute` and `ofapi.commands.sweep` queues exist; execute has `retry_limit=0`.
  During validation there were no execute jobs, only completed sweep jobs.
- A real chatter-key command create/read/cancel returned `202/200/200`. The row ended
  `cancelled` with `attempt_count=0`, no attempt timestamps, no platform message id, and no error.
- The validation created no `ofapi_command_send_text` credit-ledger rows and no ledger rows after
  the pre-validation baseline. Production logs contained neither validation text nor command-send
  operation logs.

This proves the deployed executor is present but inert while execution remains disabled. The live
send gate remains blocked on a designated controlled test fan/conversation and explicit operator
approval for one harmless message.

### 2026-06-20 Controlled Live Execution Evidence

- The owner-designated route was `loravievip` to the owner-controlled `loravie` conversation
  (`platform user id 518588958`) with the approved text `hi`; no third-party fan was involved.
- Core command `f7fa35d4-f3a2-486a-8d62-73246fc21195` reached `confirmed` after exactly one
  vendor attempt. It recorded platform message id `10088948367788`.
- `ofapi_credit_ledger` contains exactly one matching `ofapi_command_send_text` row: page 9,
  one credit, HTTP 200, non-estimated, attempt number 1.
- The sent message produced `messages.sent` and `messages.received` journal rows; the subsequent
  owner-authorized unsend produced the paired `messages.deleted` rows. All four settled and
  projected.
- Command API responses omitted payload text. Focused API/worker log checks contained command ids
  and bounded outcome metadata, but no payload text.
- The acceptance initially rolled execution back to staged `false`. After desktop recovery
  transport and Hub write default were committed, production staged version 3 enabled execution
  again with zero nonterminal commands. Current API and worker heartbeats report outbox/execution
  enabled with `skippedOverrides=[]`.
- Rollback remains: stage `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED=false` and recreate API/worker.
  Intake remains available and queued commands stay parked; Direct desktop write transport is the
  client rollback.

## C6b3 Typing Command Slice

Status: implemented and production-validated on 2026-06-20.
Decision owner: core Decision #58.

### Contract

- `typing_active_v1` uses the same command outbox, page/chatter ACL, dedupe, state machine,
  one-attempt executor, and staged rollback as text commands.
- Payload is exactly `{}`. Request/response/log surfaces must not contain message text, media URLs,
  fan names, or arbitrary vendor body fields.
- `retryOfCommandId` is rejected for typing commands. Re-sending a typing beacon is a fresh
  client command id and has no desktop recovery obligation.
- `messages.sent` webhook verification ignores typing commands; only the direct OFAPI typing
  endpoint response can confirm the row.
- `platform_message_id` remains null on success. Audit evidence is command id, account,
  conversation id, state, payload hash, timestamps, attempt count, bounded error metadata, and
  credit ledger operation.

### Implementation

- Migration `0043_ofapi_command_typing_active.sql` widens `ofapi_commands.kind` to include
  `typing_active_v1`; existing rows are not rewritten.
- Core contracts use a discriminated command schema: text commands require non-blank text, typing
  commands require empty payload.
- The core OFAPI client sends one `POST /api/{accountId}/chats/{conversationId}/typing` request
  with no body, global pacing, and page-attributed credit observation
  `ofapi_command_typing_active`.
- Since the typing endpoint is documented free, a successful response without `_meta` records zero
  estimated fallback credits. Any `_meta._credits.used` value is authoritative if returned.

### Production Validation Plan

Use only the owner-controlled `loravievip` to `loravie` conversation. Validate:

1. Migration `0043` applied and API/worker heartbeats match the deployed source revision.
2. Create one `typing_active_v1` command through a chatter key assigned only to the owner page.
3. Command reaches terminal `confirmed` with `attempt_count=1`, null `platform_message_id`, and
   payload `{}`.
4. `ofapi_credit_ledger` has exactly one matching `ofapi_command_typing_active` row; expected
   credits are zero unless OFAPI reports otherwise in `_meta`.
5. API/worker logs contain command ids and bounded outcome metadata only; no payload text/media
   canary appears.
6. Stage `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED=false`, recreate API/worker, prove a new typing
   command remains `queued`/unclaimed, then restore execution if validation passes.

### 2026-06-20 Production Validation Evidence

- Canonical deploy revision: `405fe9e41bff`; API and worker image labels matched that revision
  and dependency checksum `b9e2460cf2e038b7d75ad5c310424990b748fa30d55b19ad2c6b0d31a89a0227`.
  API health was OK. `/api/v1/health/sync` stayed 503 for the known pre-existing workload/page
  state, not this deploy.
- Migration `0043_ofapi_command_typing_active.sql` is applied in production
  (`2026-06-20 03:12:58.929366+00`). The pre-validation command table contained only previous
  text rows: two `cancelled` and one `confirmed`.
- Active runtime heartbeats reported command outbox `true`, command execution `true`, AI gateway
  `true`, and zero skipped overrides for both API and worker.
- The controlled route was owner-only: page `lora-vip-of` (page id 9,
  account `acct_b92980e0650b49d09a8312fa12f36a58`) to the owner-controlled `loravie`
  conversation `518588958`. A temporary validation chatter was assigned only to `lora-vip-of`.
- API create returned HTTP 202 for client command `0a287250-23e1-4a7b-9ed8-7b7ac2407764`, core
  command `729fb32c-c313-4481-9c7c-c64963ec8df3`, kind `typing_active_v1`, state `queued`,
  `attemptCount=0`, `platformMessageId=null`, and no payload in the response.
- The command row reached `confirmed` with `attempt_count=1`, `platform_message_id=null`,
  `last_error_code=null`, `last_error_class=null`, payload `{}`, and verifier metadata
  `{"source":"ofapi_response","commandKind":"typing_active_v1"}`.
- `ofapi_credit_ledger` row `13` recorded operation `ofapi_command_typing_active`, page 9,
  HTTP 200, `credits_used=0`, `estimated=false`, idempotency key
  `ofapi_command_typing_active:3fb61930-6296-4d8b-9943-650a5ef4fdcb`, and
  `attemptNumber=1`.
- Worker logs for the bounded validation window contained only command id/page/kind/platform-id
  outcome metadata for the command. Focused searches found no validation key, payload, media URL,
  signed CDN field, conversation id, or provider failure text.
- Rollback drill: staged `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED=false` at config version 4,
  recreated API/worker, and fresh heartbeats reported execution `false` with zero skipped
  overrides. A new typing command `e2d9024f-84e7-44df-a8e4-cd768d58ee49` stayed `queued` with
  `attempt_count=0`, no error, no platform id, and no additional
  `ofapi_command_typing_active` ledger row. The parked command was cancelled before restore.
- Restore drill: staged execution back to `true` at config version 5, recreated API/worker, and
  final heartbeats reported outbox `true`, execution `true`, AI gateway `true`, and zero skipped
  overrides. The temporary validation key was revoked and the temporary chatter's page assignment
  was removed; it has zero active keys and no assigned pages.

## C6b4 Unsend Command Slice

Status: implemented and production-validated on 2026-06-20.
Decision owner: core Decision #59.

### Contract

- `unsend_message_v1` uses the same command outbox, page/chatter ACL, durable dedupe, state
  machine, one-attempt executor, and staged rollback as text and typing commands.
- Payload is exactly `{ "messageId": "<numeric OnlyFans message id>" }`. It cannot contain text,
  media URLs, arbitrary vendor path fields, or reply/media/PPV fields.
- `retryOfCommandId` is rejected. A second unsend can have different platform effects after an
  ambiguous first DELETE, so retry is a visible human decision outside automatic recovery.
- `messages.sent` webhook verification ignores unsend commands. `messages.deleted` projection may
  tombstone desktop state later, but it does not mutate command state in this slice.
- On confirmed DELETE, `platform_message_id` records the target message id. Audit evidence is
  command id, account, conversation id, target message id, state, payload hash, timestamps,
  attempt count, bounded error metadata, and credit ledger operation.

### Implementation

- Migration `0044_ofapi_command_unsend_message.sql` widens `ofapi_commands.kind` to include
  `unsend_message_v1`; existing rows are not rewritten.
- Core contracts use a discriminated command schema: unsend commands require a strict numeric
  `messageId` payload and reject retry lineage.
- The core OFAPI client sends one
  `DELETE /api/{accountId}/chats/{conversationId}/messages/{messageId}` request with no body,
  global pacing, bounded timeout, and page-attributed credit observation
  `ofapi_command_unsend_message`.
- Successful JSON `{data:{success:true}}`, bare `{success:true}`, or empty `2xx/204` response
  confirms the command. Non-JSON or missing-success `2xx` is indeterminate.
- Desktop Hub write transport creates this command for the unsend action and tombstones the local
  message only after core confirms; Direct remains the support rollback path.

### Production Validation Plan

Use only the owner-controlled `loravievip` to `loravie` conversation. Validate:

1. Migration `0044` applied and API/worker heartbeats match the deployed source revision.
2. Create one fresh owner-only text command or otherwise use an owner-owned unsendable message id.
3. Create one `unsend_message_v1` command through a chatter key assigned only to the owner page.
4. Command reaches terminal `confirmed` with `attempt_count=1`, `platform_message_id` equal to the
   target message id, and payload containing only the numeric `messageId`.
5. `ofapi_credit_ledger` has exactly one matching `ofapi_command_unsend_message` row.
6. The paired `messages.deleted` webhook settles/projects when OFAPI emits it; if delayed, record
   the command proof separately without polling third-party fan bodies.
7. API/worker logs contain command ids and bounded outcome metadata only; no message text or media
   URLs appear.
8. Stage `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED=false`, recreate API/worker, prove a new unsend
   command remains `queued`/unclaimed, cancel it, then restore execution if validation passes.

### 2026-06-20 Production Validation Evidence

- Canonical deploy revision: `8d75e4f94d93`; API and worker image labels matched that revision
  and dependency checksum `b9e2460cf2e038b7d75ad5c310424990b748fa30d55b19ad2c6b0d31a89a0227`.
  API health was OK. `/api/v1/health/sync` stayed 503 for the known pre-existing workload/page
  state, not this deploy.
- Migration `0044_ofapi_command_unsend_message.sql` is applied in production
  (`2026-06-20 03:46:07.858525+00`). Active runtime heartbeats reported command outbox `true`,
  command execution `true`, AI gateway `true`, and zero skipped overrides for both API and worker.
- The controlled route was owner-only: page `lora-vip-of` (page id 9,
  account `acct_b92980e0650b49d09a8312fa12f36a58`) to the owner-controlled `loravie`
  conversation `518588958`. A temporary validation chatter was assigned only to `lora-vip-of`.
- A fresh owner-only text command `c6f73e57-8b51-4c13-aef7-6ced300390f5` created platform message
  id `10090438628342` after one attempt so the unsend fixture had a current owner-owned target.
- API create returned HTTP 202 for unsend client command
  `9a09ce4b-137e-4692-996e-67dbfc3f1cc5`, core command
  `21cd8d41-8383-40b2-8418-7ca01067ea85`, kind `unsend_message_v1`, and state `queued`.
- The unsend command row reached `confirmed` with `attempt_count=1`,
  `platform_message_id=10090438628342`, payload `{"messageId":"10090438628342"}`, no errors, and
  verifier metadata `{"source":"ofapi_response","commandKind":"unsend_message_v1"}`.
- `ofapi_credit_ledger` row `15` recorded operation `ofapi_command_unsend_message`, page 9,
  HTTP 200, `credits=1`, `estimated=false`, request id
  `ofapi_command_unsend_message:60404fdc-04b2-4f68-9450-36cef36acfe8`, and
  `attemptNumber=1`. The setup text send wrote row `14` under `ofapi_command_send_text`.
- Webhook journal evidence for platform message id `10090438628342`: `messages.sent`,
  `messages.received`, and two `messages.deleted` rows all reached `processed/projected` with
  fanout seq `15563` through `15566`.
- Bounded API/worker log searches for the validation window found zero matches for the text canary,
  `payload`, `mediaUrl`, `mediaFiles`, signed URL fields, or CDN fields. Command logs contained
  only command id, page id, command kind, and platform message id.
- Rollback drill: staged `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED=false` at config version 6,
  recreated API/worker, and fresh heartbeats reported execution `false` with outbox `true`,
  AI gateway `true`, and zero skipped overrides. A new unsend command
  `358ad76c-3670-494a-800f-b99fe35b5474` stayed `queued` with `attempt_count=0` and no new
  unsend ledger row, then was cancelled.
- Restore drill: staged execution back to `true` at config version 7, recreated API/worker, and
  final heartbeats reported execution `true`, outbox `true`, AI gateway `true`, and zero skipped
  overrides. The temporary validation key was revoked and its page assignment removed; it has zero
  active keys and no assigned pages.

## C6b5 Mark-Read Command Slice

Status: implemented and production-validated.
Decision owner: core Decision #60.

### Contract

- `mark_chat_read_v1` uses the same command outbox, page/chatter ACL, durable dedupe, state
  machine, one-attempt executor, and staged rollback as text, typing, and unsend commands.
- Payload is exactly `{}`. It cannot contain text, media URLs, arbitrary vendor path fields, or
  reply/media/PPV fields.
- `retryOfCommandId` is rejected. A later mark-read is a fresh explicit action from desktop's
  open/read workflow rather than automatic retry after an ambiguous first attempt.
- `messages.sent` webhook verification ignores mark-read commands. There is no webhook verifier in
  this slice; the OFAPI response confirms the row.
- On confirmed POST, `platform_message_id` remains null. Audit evidence is command id, account,
  conversation id, state, payload hash, timestamps, attempt count, bounded error metadata, and
  credit ledger operation.

### Implementation

- Migration `0045_ofapi_command_mark_chat_read.sql` widens `ofapi_commands.kind` to include
  `mark_chat_read_v1`; existing rows are not rewritten.
- Core contracts use a discriminated command schema: mark-read commands require empty payload and
  reject retry lineage.
- The core OFAPI client sends one
  `POST /api/{accountId}/chats/{conversationId}/mark-as-read` request with no body, global pacing,
  bounded timeout, and page-attributed credit observation `ofapi_command_mark_chat_read`.
- Successful JSON `{data:{success:true}}`, bare `{success:true}`, or empty `2xx/204` response
  confirms the command. Non-JSON or missing-success `2xx` is indeterminate.

### Production Validation Evidence

Owner-controlled `loravievip` to `loravie` validation completed on 2026-06-20:

1. Canonical dist-only deploy reached revision `8fb9a9bc8393`; API and worker were healthy on
   dependency checksum `b9e2460cf2e038b7d75ad5c310424990b748fa30d55b19ad2c6b0d31a89a0227`.
2. Migration `0045_ofapi_command_mark_chat_read.sql` was applied at
   `2026-06-20 04:13:53.282961+00`.
3. Owner-only command `be5c38b9-2697-4bc1-81de-957ec8db2368` reached `confirmed` with
   `attempt_count=1`, null `platform_message_id`, payload `{}`, and verifier
   `{"source":"ofapi_response","commandKind":"mark_chat_read_v1"}`.
4. `ofapi_credit_ledger` row `18` recorded `ofapi_command_mark_chat_read` for page `9`, HTTP 200,
   one credit, `estimated=false`, and `{"attemptNumber":1}`.
5. Worker log redaction checks over the validation window found no payload, text, media URL, signed
   CDN field, or owner conversation id.
6. Rollback staged `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED=false`, recreated API/worker, and proved
   command `4bbd0943-5e56-4500-9125-38928b89ebd9` stayed unclaimed with `attempt_count=0` and no
   additional mark-read ledger row. The command was cancelled, execution was restored to `true`, and
   final API/worker heartbeats reported outbox `true`, execution `true`, AI gateway `true`, and zero
   skipped overrides.
7. The temporary validation key was revoked and the validation user has zero assigned pages and zero
   active keys.

## C6b6 Media/PPV Send Command Slice

Status: implemented, pending production validation.
Decision owner: core Decision #61.

### Contract

- `send_media_message_v1` uses the same command outbox, page/chatter ACL, durable dedupe, state
  machine, one-attempt executor, and staged rollback as text commands.
- Payload accepts only caption text, integer price, media IDs, and preview IDs. It rejects URLs,
  file bytes, filenames, reply-to fields, upload instructions, arbitrary vendor paths, and unknown
  fields.
- `price` is `0` or an integer from `3` through `200`. `mediaFiles` must be non-empty and bounded;
  `previews` must be a bounded subset of `mediaFiles`.
- `retryOfCommandId` is allowed only for owned same-kind media commands in a retryable terminal or
  indeterminate state. A retry creates a new command row and cannot reattempt the original row.
- `messages.sent` webhook verification can repair media commands only by account, conversation,
  normalized caption text, price, media count, time window, and uniqueness. It never compares or
  logs media IDs.

### Implementation

- Migration `0046_ofapi_command_send_media_message.sql` widens `ofapi_commands.kind` to include
  `send_media_message_v1`; existing rows are not rewritten.
- Core contracts use a discriminated schema with strict media ID regexes and preview-subset
  validation. API status responses still omit the payload.
- The core OFAPI client sends one
  `POST /api/{accountId}/chats/{conversationId}/messages` request with JSON body containing text,
  price, mediaFiles, optional previews, and derived `lockedText` for priced non-blank captions.
- The operation records credit ledger rows under `ofapi_command_send_media`. Vendor success returns
  only the platform message id to the executor.

### Production Validation Plan

Use only the owner-controlled `loravievip` to `loravie` conversation. Validate:

1. Migration `0046` applied and API/worker heartbeats match the deployed source revision.
2. Confirm an existing owner media id is available; if not, abort the live validation rather than
   centralizing upload in this slice.
3. Create one `send_media_message_v1` command through a chatter key assigned only to the owner page.
4. Command reaches terminal `confirmed` with `attempt_count=1` and a platform message id.
5. `ofapi_credit_ledger` has exactly one matching `ofapi_command_send_media` row.
6. Command status APIs and API/worker logs contain no caption, media id, media URL, filename, signed
   CDN field, or arbitrary vendor body.
7. If a message was posted, unsend it through the already validated unsend command path.
8. Stage `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED=false`, recreate API/worker, prove a fresh media
   command remains `queued` with zero attempts and no new media ledger row, cancel it, then restore
   execution if validation passes.

### 2026-06-19 Payload Redaction Production Evidence

- Canonical deploy revision: `bbd42e844f36`; API and worker both healthy on dependency checksum
  `b9e2460cf2e038b7d75ad5c310424990b748fa30d55b19ad2c6b0d31a89a0227`.
- Migration `0041_ofapi_command_payload_redaction.sql` is applied
  (`2026-06-19 22:24:36.221068+00`). Production schema contains
  `ofapi_commands.payload_redacted_at` and `ofapi_commands_payload_redaction_idx`.
- Active runtime heartbeats reported command outbox `true`, command execution `false`, AI gateway
  `false`, Anthropic key `unset`, and `skippedOverrides=[]` on API and worker.
- Production command table at validation time: 2 total rows, 0 redacted rows, 0 old terminal
  unredacted rows beyond the seven-day window, 0 `in_flight`, and 0 `queued`.
- `ofapi_credit_ledger` had 0 `ofapi_command_send_text` rows; no vendor send path was activated.
- A rollback-only production DB smoke inserted a synthetic confirmed command, applied the redaction
  update inside the transaction, proved `payload.text` became empty while `payload_hash` remained
  intact, then rolled back; the synthetic row count after rollback was 0.
- API/worker logs for the validation window contained no command-send operation and no validation
  payload text. Public `/api/v1/health` was OK. `/api/v1/health/sync` stayed 503 due pre-existing
  workload state (Fansly conversation catch-up and unverified OF pages), not this deploy.
