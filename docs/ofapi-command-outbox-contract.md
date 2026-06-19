# OFAPI Desktop Command Outbox Contract

Status: C6b1 intake/read/cancel, C6b2 default-off executor, and terminal payload redaction
implemented on 2026-06-19. Live execution remains blocked on the controlled-send gate.
Decision owner: core Decision #55.

## Boundary

Core owns command ids, dedupe, authorization, durable state, and eventual vendor execution.
Desktop owns draft text, optimistic UI, and its local outbox until a core command is accepted.
OFAPI remains unreachable through arbitrary methods or paths.

The first implementation is deliberately non-executing:

- `OFAPI_DESKTOP_COMMAND_OUTBOX_ENABLED` gates intake/read/cancel.
- `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED` will gate vendor execution and requires the outbox flag.
- Intake can be production-validated without sending, typing, marking read, uploading, liking, or
  mutating OnlyFans in any way.

## Version 1 Command

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

Version 1 rejects media, PPV, reply-to, uploads, typing, mark-read, likes, unsend, and unknown
payload fields. Later command kinds get separate discriminated schemas and execution policies.

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

Command responses omit payload text:

```json
{
  "commandId": "uuid",
  "clientCommandId": "uuid",
  "kind": "send_text_message_v1",
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

Desktop command transport remains blocked until this UX is implemented around the existing status
endpoint. Recovery must not add a `GET /messages` body read solely to decide command outcome; the
core response path and `messages.sent` webhook verifier are the non-read-state-changing evidence
sources.

## Dedupe and Retention

The dedupe key is `(page_id, chatter_user_id, client_command_id)`. Canonical request hashing includes
kind, account, conversation, payload, and retry lineage. Rows have a minimum 400-day dedupe horizon.
Payload text redaction does not shorten that horizon or change the stored `payload_hash`.

## Payload Retention, Purge, and Export Policy

The command payload stores `payload.text` while the command may still execute or need recovery.
The worker sweep now tombstones terminal command text after the recovery window while preserving
non-text audit and dedupe fields.

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

The separately flagged executor is now implemented default-off. Controlled test-fan send and
desktop command transport/recovery UI remain pending.

## C6b2 Executor Contract

Status: default-off executor implemented and production-validated with execution disabled on
2026-06-19; live enablement pending.
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

### Vendor Request

Version 1 executes exactly:

```text
POST /api/{accountId}/chats/{conversationId}/messages
{"text":"..."}
```

The request uses the core OFAPI client, global pacing, page-attributed credit accounting, a bounded
timeout, and no automatic retry. Message text is never logged or copied into error/verifier
metadata.

### Outcome Classification

- Valid `2xx` JSON with a message id: `confirmed`, record `platform_message_id`.
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

A settled `messages.sent` event may confirm `in_flight` or `indeterminate` only when all of these
hold:

1. OFAPI account and fan conversation match.
2. Normalized webhook text exactly equals normalized command text.
3. The event falls inside the bounded attempt-correlation window.
4. Exactly one eligible command matches.

Ambiguous, late, missing-text, or multi-candidate events do not mutate command state. Successful
HTTP response remains the primary confirmation path; webhook matching repairs response-loss and
worker-crash cases without an extra `GET /messages` that could affect read state or spend credits.

### Production Gate

The executor is first deployed and validated with execution off. Enabling it requires:

- both runtime roles reporting outbox and execution enabled with no skipped overrides;
- no pre-existing unintended `queued` rows;
- one explicitly designated controlled test fan/conversation;
- operator-approved harmless text;
- proof of exactly one OFAPI credit-ledger attempt, terminal command state, matching
  `messages.sent`/projection when delivered, and no payload text in logs;
- rollback proof that disabling execution leaves intake available and prevents new claims.

Desktop write transport remains direct until this live gate passes, payload purge/export
implementation exists, and command status/recovery UI is implemented.

### C6b2 Implementation

- Migration `0039_ofapi_command_execution.sql` adds attempt timestamps, queued/verifier indexes,
  and a database constraint limiting each command row to one attempt.
- The API enqueues a durable wakeup only after a new command is committed. The worker owns
  `ofapi.commands.execute` and `ofapi.commands.sweep`; execute jobs have zero retries.
- The core OFAPI client implements only the versioned text-send request and returns only the
  platform message id. Credit observations use operation `ofapi_command_send_text` with page
  attribution.
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
