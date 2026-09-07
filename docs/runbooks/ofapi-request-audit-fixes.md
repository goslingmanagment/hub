# OFAPI request audit fixes (R1–R6)

This batch repairs the six request-path findings against deployed `7fac98f3`.
It adds no collector, enables no production flag, and sends no live vendor request.
Apply forward migration `0154_ofapi_credit_receipts.sql` before the new runtime.

| Finding | Behavior after this batch | Regression evidence |
|---|---|---|
| R1 | Link discovery and subscriber walks follow explicit continuation, retain the next offset across budget yields, and stop on an explicit terminal full page. Provider URLs are validated against account/resource/origin and only their offset is used. | Short-page resume and terminal full-page integration cases in `ofapi-fan-identities.integration.test.ts`; URL rejection tests in `ofapi-request-audit.test.ts`. |
| R2 | Missing list envelopes, malformed items and missing continuation evidence fail without certifying empty coverage. Empty documented lists remain valid. Spenders alone retain the documented array-only length fallback. | List contract tests; existing client and ledger fixtures now include real terminal evidence. |
| R3 | Unknown/denied and persistence failures refresh on the next access after 30 seconds. All callers share one in-flight verification. Verified/mismatched credentials stay pinned; changing configured key/team requires runtime recreation. | Concurrent same-client provider/persistence recovery tests; existing wrong-team and key-isolation tests. |
| R4 | Financial metadata is captured before ledger/counter settlement. An acknowledged send remains confirmed with `creditAccounting: pending` in its verifier evidence. New paid dispatch waits for DB-only receipt recovery; no original command is reissued. | Both-projection outage, new-client recovery, concurrent settlement, one-attempt outbox and all command/legacy gateway tests. |
| R5 | Numeric media identifiers beyond JavaScript's safe integer range are emitted as exact strings. Both media and preview identifiers use the same codec. | Boundary and 30-digit accepted-identifier wire assertions. |
| R6 | Missing message-search `query`, missing users-list `ids`, and user-list `limit` outside 10–50 are rejected locally. | Required-field and both limit-boundary tests. |

## Accounting recovery and retention

`ofapi_credit_receipts` is the retained financial source evidence for legacy
request attempts, keyed by `(request_id, attempt_number)`. Its observation contains
only operation, HTTP status, credit metadata, receipt time, page/principal attribution
and budget scope. It stores no message body, fan identity, signing secret, token or
request URL. Settlement locks that receipt and commits its disposition together with
ledger/counter changes. Ambiguous commits and concurrent drains are idempotent.
Receipt content never changes. There is no timer, purge or automatic fact deletion.
The existing owner-gated page-data erasure includes its financial receipts using
their nested page attribution, matching the credit ledger. Fan erasure has no
receipt target because these receipts contain no fan identity.

If the ledger path fails, a successfully updated physical counter still preserves
existing availability behavior; the receipt retains the full financial evidence and
marks `accounting_path=physical`. If both projections fail, it remains pending.
Every subsequent paid request drains at most 100 pending receipts before admission,
including after restart. A larger backlog keeps dispatch closed until a later drain.
Free balance, credential and account/webhook inventory diagnostics remain available.
A database-wide outage can prevent even receipt capture: the running client retains
its receipt in memory and refuses subsequent paid dispatch until persistence works.
A process crash during that database-wide outage still requires provider balance
reconciliation; this batch does not claim an external durable store exists.

Owner diagnostic (read-only):

```sql
select request_id, attempt_number, received_at, observation ->> 'operation' as operation,
       observation ->> 'credits' as credits, accounted_at, accounting_path
from ofapi_credit_receipts
where accounted_at is null
order by received_at, request_id, attempt_number;
```

Do not retry a confirmed command to clear a financial incident. Fix database
availability; the next admitted request repairs accounting only. Free `/whoami`
preflight retries also never replay a command. Rollback leaves migration 0154 and
all financial evidence intact; deploying an older runtime removes this admission
guard, so inspect pending receipts before a rollback.

## Vendor evidence and discrepancies

Checked 2026-09-06 against the live documentation and the same-day audit evidence.
No authenticated vendor call was made; fixtures prove local behavior only.

- [Tracking links](https://docs.onlyfansapi.com/api-reference/tracking-links/list-tracking-links)
  and [transactions](https://docs.onlyfansapi.com/api-reference/transactions/list-transactions)
  show `data.list` plus continuation metadata. Their short examples can explicitly
  continue, so list length does not establish completion.
- [Tracking link spenders](https://docs.onlyfansapi.com/api-reference/tracking-links/list-tracking-link-spenders)
  documents a `data` array. The old client comment generalized `data.list` across
  the whole family; that assumption was wrong and is now explicitly narrowed.
- [Send message](https://docs.onlyfansapi.com/api-reference/chat-messages/send-message)
  permits string identifiers in `mediaFiles`/`previews`; the live generated item
  schema is imprecise (`file[]|string`). Preserve supported strings exactly rather
  than treating the schema as permission to round a numeric identifier.
- [User lists](https://docs.onlyfansapi.com/api-reference/user-lists/list-user-lists)
  specifies limit 10–50. The audit's downloaded 2026-09-06 OpenAPI also marks
  `/users/list` `ids` and `/chats/{chat_id}/messages/search` `query` required.
  Hub's previous allowlist admitted their absence. The live page renderer was
  unavailable for the user-list page during this implementation; the audit snapshot
  supplies its pinned evidence, rather than claiming an additional live verification.

Spend: no new paid operations or larger budgets. Complete pagination may consume
more of existing per-run/day caps because the old walk skipped legitimate pages;
explicit terminal full pages avoid the former unnecessary request. One extra small
financial receipt row is retained per acknowledged legacy response; zero-credit
high-frequency typing remains suppressed unless the vendor reports a charge.
