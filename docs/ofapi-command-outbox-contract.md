# OFAPI Desktop Command Outbox Contract

> Living contract. Exact request/response schemas live in
> `packages/contracts/src/routes.ts`; state transitions live in
> `packages/db/src/repositories/ofapi-commands.ts` and
> `apps/runtime/src/services/ofapi-command-*.ts`. Historical rollout evidence
> belongs in Git and the decision archive.

Decision authority: #55, #56, #58, #59, #60, #61, #63, and #125.

## Boundary

Core owns command identity, page authorization, durable state, deduplication,
one-attempt vendor execution, settlement, and audit facts. The client owns
draft text and optimistic UI until Core accepts a command.

There is no generic OFAPI write proxy. Only the versioned command kinds below
may cross this boundary. Uploads, likes, reply-to sends, and arbitrary paths or
methods remain out of scope.

Two boot-applied flags are independent safety gates:

- `OFAPI_DESKTOP_COMMAND_OUTBOX_ENABLED` gates create/read/cancel;
- `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED` gates vendor execution and requires
  the outbox flag.

Disabling execution does not discard accepted rows. The minutely sweep still
expires stale queued rows before returning, so re-enabling cannot release an
hours-old message.

## API

### Create or deduplicate

`POST /api/v1/ofapi/commands`

- Auth: bearer API key or device token, with page scope enforced server-side.
- `accountId` must map to a page currently assigned to the caller.
- A new command returns 202 with `deduplicated: false`.
- Exact replay of the same `(page, chatter, clientCommandId)` returns the
  existing row with 200 and `deduplicated: true`.
- Reusing that id with a different canonical request returns 409.
- Disabled intake returns 503.

Canonical hashing covers kind, account, conversation, payload, and retry
lineage. It is never derived only from message text.

### Read

`GET /api/v1/ofapi/commands/{commandId}`

Only the creating chatter, while still assigned to the page, may read a row.
Unknown and unowned ids share the same 404 boundary.

### Cancel

`POST /api/v1/ofapi/commands/{commandId}/cancel`

Only `queued -> cancelled` is mutable. Repeating cancel on an already-cancelled
row is idempotent; any other state returns 409. Cancellation never calls OFAPI.

Responses expose ids, state, hashes, retry lineage, bounded failure/verifier
metadata, platform message id, attempt timestamps, and dedupe status. They do
not expose the command payload.

## Versioned commands

| Kind | Payload and limits | Retry lineage | Vendor mutation |
| --- | --- | --- | --- |
| `send_text_message_v1` | `{text}`; nonblank, at most 10,000 chars | Optional, same kind/lane and owned terminal source | Create chat message |
| `send_media_message_v1` | `{text, price, mediaFiles, previews}`; existing media ids only; price 0 or integer 3-200; 1-50 unique media; previews are a unique subset | Same as text | Create chat message with media/PPV |
| `typing_active_v1` | `{}` | Forbidden | Start typing |
| `unsend_message_v1` | `{messageId}` with numeric platform id | Forbidden | Delete that message |
| `mark_chat_read_v1` | `{}` | Forbidden | Mark the chat read |

Text/media retry sources may be `failed_retryable`, `failed_terminal`,
`indeterminate`, or `cancelled`. A retry is always a new command with a new
`clientCommandId`; Core never requeues the original row.

Media commands accept identifiers already known to OFAPI. URLs, local file
bytes, filenames, upload instructions, unknown fields, and duplicate media ids
are rejected.

## State and one-attempt law

```text
queued -> cancelled
queued -> in_flight
in_flight -> confirmed | failed_retryable | failed_terminal | indeterminate
indeterminate -> confirmed   (unique matching messages.sent evidence)
```

One partial unique index permits only one `in_flight` row per
`(page_id, conversation_id)`. Each durable row gets at most one vendor request:
the queue job has zero retries, service code does not retry, and a stale
`in_flight` row becomes `indeterminate` instead of returning to `queued`.

Outcome classification:

- a valid command-specific 2xx response confirms;
- 400/401/403/404/409/422 are terminal failures;
- 429 is human-retryable;
- timeout, transport failure, 408, 5xx, or malformed/ambiguous success is
  indeterminate.

The stored failure surface is bounded code/class/status metadata. Raw vendor
bodies, message text, media URLs, and fan names must not enter logs, responses,
or verifier metadata.

## Recovery and webhook evidence

`messages.sent` may repair an `in_flight` or `indeterminate` text/media send only
when account, conversation, normalized text, bounded time window, and uniqueness
match. Media sends additionally require price and media-count equality.
Ambiguous or incomplete evidence makes no state change. Typing, unsend, and
mark-read confirm only from their direct endpoint result.

The direct response and webhook paths race through the same conditional
finalize. Only the winner emits the settlement fact, so response loss followed
by a webhook cannot produce contradictory command outcomes. Confirmed text and
media sends also feed the message-material lane; a later webhook may enrich
that material without creating a duplicate first fact.

Client behavior follows state, not hope:

- never direct-send or auto-resubmit while `queued` or `in_flight`;
- treat `indeterminate` as manual recovery, not safe-to-resend;
- use a fresh command id for every human-approved retry;
- remove an unsent local bubble only after confirmed delete evidence.

## TTL, retention, and privacy

- General queued commands expire to `cancelled` after 10 minutes by default;
  the live `ofapiQueuedCommandTtlMs` setting may change this with a 60-second
  floor (#125).
- A queued typing beacon is unclaimable after 10 seconds.
- Business commands keep a 400-day dedupe horizon.
- Typing keeps a two-minute dedupe horizon; terminal typing rows are then
  deleted and emit no permanent `command_result` observation.
- Business-command payloads are retained permanently under the current
  retention/redaction stand-down (#63). The legacy `payload_redacted_at` column
  and index remain schema compatibility only; no active sweep redacts business
  payloads.

Permanent payload custody does not widen access: status APIs omit payloads,
ordinary logs and exports must omit them, and command-result observations carry
bounded settlement data rather than message text.

## Change rule

Keep this file at the invariant level. Add a command kind only with a narrow
strict schema, explicit vendor mutation, outcome rules, retry policy, retention
policy, and tests. Deployment revisions, live test ids, test counts, and rollout
transcripts stay in Git history, not here.
