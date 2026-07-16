# OFAPI chat-history export quote

This runbook is the S5a decision gate from Decision #158. It obtains a real
vendor quote without providing any path that can start, download, or import an
export.

## Safety boundary

- The create endpoint defaults to `dryRun: true`.
- A real request first creates one durable page-scoped `account_export` job.
- The worker sends `POST /data-exports` with `auto_start: false`, captures the
  exact response, and then performs only bounded status GETs.
- A quote ends in `blocked / owner_approval_required`. Core has no export-start
  endpoint in this slice.
- Status polling is bounded to one request every 15 minutes for at most one
  day. An uncertain status GET is conservatively counted as billed before a
  retry is admitted.
- Only a captured quote (`owner_approval_required`) or an explicit vendor
  calculation failure (`export_quote_failed`) can be cancelled to release the
  page slot. HTTP ambiguity, contract drift, and an already-started export keep
  the slot blocked until vendor reconciliation.
- A completed quote is accepted only when its type, dates, file type, exact
  account, row count, and cost match the frozen request contract.

The vendor contract was rechecked on 2026-07-16 against the official
[Create Data Export](https://docs.onlyfansapi.com/api-reference/data-exports/create-data-export),
[Get Data Export Status](https://docs.onlyfansapi.com/api-reference/data-exports/get-data-export-status),
and [Start Data Export](https://docs.onlyfansapi.com/api-reference/data-exports/start-data-export)
documentation. `chat_messages` accepts `maxMessages`, optional `chatIds`, and
charges the calculated credits only when the separate start operation runs.

## Sequence

1. Confirm the credit ledger, capture-first background worker, page proxy, and
   disk gates are healthy. Do not enable a retired legacy DM crawler.
2. POST `/api/v1/admin/ofapi/export-quotes` as owner with a pilot profile and
   two or three explicit numeric chat IDs. Omit `dryRun` first; inspect the
   `would_create` response. Repeat with `dryRun: false` only in the owner window.
3. Inspect `/api/v1/admin/ofapi/export-quotes/:jobId`. Record `totalRows`,
   `creditCost`, `quotedAt`, `expiresAt`, attempts, and actual spent credits.
4. When the quote is safely terminal and recorded, cancel the blocked quote job
   through `/api/v1/admin/ofapi/export-quotes/:jobId/cancel` with
   `{ "expectedState": "blocked", "reason": "..." }` to release the one
   page export slot.
5. Repeat for `profile: "fleet_tail"` without `chatIds`. This is the number used
   for the backend/coverage owner decision; do not extrapolate from the pilot.

Example dry-run body:

```json
{
  "pageId": 123,
  "profile": "pilot_chats",
  "chatIds": ["10001", "10002"],
  "startDate": "2016-01-01T00:00:00.000Z",
  "endDate": "2026-07-16T00:00:00.000Z",
  "maxMessages": 10000000,
  "quoteTtlMinutes": 1440
}
```

Stop and reconcile manually for every blocked reason other than
`owner_approval_required` or `export_quote_failed`. Repeating the create POST is
not a recovery action.
