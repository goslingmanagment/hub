# OFAPI Desktop Command Outbox Contract

Status: C6b1 intake/read/cancel implemented and production-validated on 2026-06-19.
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

## Dedupe and Retention

The dedupe key is `(page_id, chatter_user_id, client_command_id)`. Canonical request hashing includes
kind, account, conversation, payload, and retry lineage. Rows have a minimum 400-day dedupe horizon.
No automatic command purge ships in the first intake slice; payload purge/export policy is a
required follow-up before broad rollout.

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

The separately flagged executor, controlled test-fan send, payload purge/export policy, and desktop
command transport remain pending.

## C6b2 Executor Contract

Status: default-off executor implemented on 2026-06-19; production deploy/enablement pending.
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

Desktop write transport remains direct until this live gate passes and command status/recovery UX
is implemented.

### C6b2 Implementation

- Migration `0039_ofapi_command_execution.sql` adds attempt timestamps, queued/verifier indexes,
  and a database constraint limiting each command row to one attempt.
- The API enqueues a durable wakeup only after a new command is committed. The worker owns
  `ofapi.commands.execute` and `ofapi.commands.sweep`; execute jobs have zero retries.
- The core OFAPI client implements only the versioned text-send request and returns only the
  platform message id. Credit observations use operation `ofapi_command_send_text` with page
  attribution.
- Command status responses expose nullable attempt start/finish timestamps, but no payload text.
- Post-settle `messages.sent` processing runs the conservative verifier before the existing
  best-effort projections. Verifier failure cannot block webhook settle/fanout.
- The default execution flag remains off. No production send is performed by implementation or
  default-off deployment validation.
