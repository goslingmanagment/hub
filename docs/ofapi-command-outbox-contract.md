# OFAPI Desktop Command Outbox Contract

Status: accepted for C6b implementation on 2026-06-19. Decision owner: core Decision #55.

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
