# OFAPI chat-history export quote and bounded pilot

This runbook is the S5a decision gate from Decisions #158 and #163. Fleet
exports remain quote-only. One explicitly approved 1-3-chat pilot may start
with at most 1,000 rows and a hard 50-credit ceiling so the delivered schema
can be checked before an importer or larger cohort exists.

## Safety boundary

- The create endpoint defaults to `dryRun: true`.
- A real request first creates one durable page-scoped `account_export` job.
- The worker sends `POST /data-exports` with `auto_start: false`, captures the
  exact response, and then performs only bounded status GETs.
- A fleet quote ends in `blocked / owner_approval_required` and cannot start.
- A pilot in `owner_approval_required` or `export_quote_requires_start` may be
  CAS-approved through `approve-pilot`. The route defaults to dry-run, requires
  the current row version and explicit max credits, and rejects targets above
  1,000 messages or 3 chats.
- Approval permits exactly one stateful start POST. An uncertain start is
  blocked and never repeated automatically. The full approved ceiling remains
  reserved until a captured terminal status reports exact cost.
- Safe status GETs run every 5 minutes after start. Completion is accepted only
  when rows delivered equal rows found, failed downloads are zero, cost is
  within approval, and an HTTPS download URL exists. The job then stops at
  `blocked / artifact_capture_required`; importing from the temporary vendor
  URL is forbidden.
- Status polling is bounded to one request every 15 minutes for at most one
  day. An uncertain status GET is conservatively counted as billed before a
  retry is admitted.
- Only a captured quote (`owner_approval_required`) or an explicit vendor
  calculation failure (`export_quote_failed`) can be cancelled to release the
  page slot. HTTP ambiguity, contract drift, and an already-started export keep
  the slot blocked until vendor reconciliation.
- A completed quote is accepted only when its type, dates, file type, exact
  account, row count, and cost match the frozen request contract.
- The live 2026-07-17 `chat_messages` contract normalizes `end_date` to the end
  of the requested UTC day. For scraping-backed exports it can also return
  `calculating_credits_completed` with `requires_scraping: true`,
  `auto_started: false`, and no row count or cost. Core records that as
  `export_quote_requires_start`; only the bounded pilot approval can advance
  it. All other profiles remain stopped.
- An indeterminate create remains blocked until an owner independently checks
  the vendor. Reconciliation can either adopt the verified vendor export ID or
  confirm that no export was created; it never repeats the create POST.

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
3. Inspect `/api/v1/admin/ofapi/export-quotes/:jobId`. Record `rowVersion`,
   `totalRows`, `creditCost`, `quotedAt`, `expiresAt`, attempts, and spent
   credits.
4. If create is `blocked / indeterminate`, inspect the owner capture-operator
   status and independently check the vendor. Preview, then execute exactly one
   `/api/v1/admin/ofapi/export-quotes/:jobId/reconcile-create` action with the
   original attempt ID and expected job row version:
   - `adopt_created` with the verified vendor export ID continues with status
     GETs only;
   - `confirm_not_created` releases the uncertain attempt and leaves the job
     blocked as `export_quote_failed` so it can be cancelled safely.
5. For a bounded pilot only, preview and then execute
   `/api/v1/admin/ofapi/export-quotes/:jobId/approve-pilot` with the exact
   `expectedRowVersion`, `approvedMaxCredits` (at least
   `ceil(maxMessages / 20)`, never above 50), and an audit reason. Monitor until
   `artifact_capture_required`; do not approve a second pilot until its
   artifact and charged credits are reconciled.
6. When a quote will not be piloted, cancel the blocked quote job
   through `/api/v1/admin/ofapi/export-quotes/:jobId/cancel` with
   `{ "expectedState": "blocked", "reason": "..." }` to release the one
   page export slot.
7. Repeat quote-only for `profile: "fleet_tail"` without `chatIds`. This is the number used
   for the backend/coverage owner decision; do not extrapolate from the pilot.

Example dry-run body:

```json
{
  "pageId": 123,
  "profile": "pilot_chats",
  "chatIds": ["10001", "10002"],
  "startDate": "2016-11-01T00:00:00.000Z",
  "endDate": "2026-07-16T00:00:00.000Z",
  "maxMessages": 1000,
  "quoteTtlMinutes": 1440
}
```

Stop and reconcile manually for every blocked reason other than
`owner_approval_required` or `export_quote_failed`. Repeating the create POST is
not a recovery action.
