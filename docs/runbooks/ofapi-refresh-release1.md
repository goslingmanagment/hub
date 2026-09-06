# OFAPI refresh: first technical release

Baseline: planning PR [#131](https://github.com/goslingmanagment/core/pull/131)
merged on 2026-09-05 as `f1834cd9`. Implementation branch:
`impl/ofapi-refresh-release1`. This is code acceptance and a proposed rollout;
this implementation session performs no production migration, deployment,
binding replacement, webhook mutation, flag activation or vendor send.

## Scope and evidence

| Slice | Implemented behavior | Live acceptance still required |
|---|---|---|
| S0 | Top-level numeric creator identity, explicit nested fallback/conflict handling; owner preview/apply; custody history; historical replay; current-generation dispatch/health; narrow recovery; remote webhook inspection | Current page identity evidence, desktop canary, fresh receipts, actual webhook scope/absence |
| S1 | Existing read parameters and response schemas; separate search-ID response; plural gallery aliases; spender-only identity mapping; validated audience continuation; real skips preserve freshness | Bounded existing desktop reads and provider response fixtures |
| S4a | Free account-independent `/usage/credits` balance read, no paid fallback, zero/unknown/access failure distinction | A redacted current response and comparison with vendor balance |
| Minimum S5 | Independent expected team, per-credential boot preflight, distinct unknown/mismatch/denied, write gate, partial-roster semantics | Owner-established team slug and permitted operation/account scope |

The new admin operations use owner-session auth under
`/api/v1/admin/ofapi/webhook`, declared in contracts and generated into SDK and
OpenAPI. No desktop SDK re-vendor is needed: existing client requests remain
compatible. Gallery aliases `photo/video/audio` normalize to vendor plurals;
vault enums remain singular. Pinned/search/partial results do not certify full
history. Existing adaptive history cursor behavior is retained.

No new collection is enabled. S-POL, S-UI, S1b and S4b remain separate. No new
webhook subscriptions, uploads, publishing, visitors or traffic/pixel work is
included. Fansly contracts and collectors are unchanged.

## Migration, custody and retention

Apply forward-only `0150_ofapi_binding_history.sql` through the existing approved
deployment procedure before starting the new runtime. It adds page/outbox
generations, generation-owned sync blockers, an explicit OF user-pause marker,
binding custody, preflight results and retired webhook-registration provenance.
It records currently mapped accounts at generation 1 without asserting creator
identity or historical dates. It does not repeat the historical account migration.

`ofapi_account_bindings` maps each provider account to its original page and
verified creator. It is a durable custody index; exact replacement actions are
also immutable `ofapi.binding.replaced` observations. Nullable time boundaries
mean unknown. Existing retirement boundaries survive later evidence imports.
Replay resolves a retired account regardless of when a redelivery arrives.

The custody index is retained with the `pages` catalog and operator audit during
page erasure; it contains no fan identities. Page/model erasure includes its old
native references when locating captured facts. Credential preflight and remote
registration history are agency control records with no fan data or raw keys.
New operational observations are registered as intentionally raw-only; they do
not imply a business projection or an additional collector. No scheduled deletion
or new data-retention policy is introduced. The custody index cannot be rebuilt
from today's roster alone: retain it with normal database backups and audit facts.

Generation-less legacy auth blockers remain unchanged because their ownership
and pause history cannot be proven retrospectively. Inspect them individually;
do not use Reset as routine recovery. Versioned recovery only clears matching
auth blockers and never changes cursor rows, user pauses, source facts, budgets
or collection flags.

## Required boot configuration

| Setting | Meaning |
|---|---|
| `OFAPI_EXPECTED_TEAM_SLUG` | Exact slug established independently through the owner's existing OFAPI team/console evidence. Never populate it by copying a new key's whoami response as the sole proof. |
| `OFAPI_WEBHOOK_MANAGEMENT_SCOPE=unknown\|team` | Default `unknown`. Set `team` only after verifying full management/inventory visibility in the provider console; whoami and account counts do not prove this. |
| `OFAPI_BALANCE_PING_ENABLED` | Existing flag remains default off; enabling the credit ledger or deploying this release does not enable the optional daily probe. The probe now costs zero credits. |

The API key remains server-side in the existing secret configuration. Never put
keys, authorization headers or webhook signing requests in rollout notes.
Preflight stores only the key fingerprint and expected/observed team result.
Admin response bytes are retained through the owner-controlled journal, except
the account roster: rule `ofapi_admin_accounts_v2` retains an identity projection
without `onlyfans_email`, `_meta` or nested fields other than creator `id`.
Non-200 roster bodies are withheld; status, body shape and machine code remain.

Boot/adoption preflight is cached for the client lifetime, including failed or
unknown results. Missing expected team produces `unknown` without guessing it.
JSON 401/403 produces `denied`; an edge HTML rejection is `unknown`; a different
team is `mismatch`. All fail closed for stateful actions. DB-only service and
permitted reads can continue. Fixing a transient/preflight configuration failure
requires a reviewed restart/rollout; no new dynamic key-rotation feature exists.

## Owner preview and apply

1. Read `GET /api/v1/admin/ofapi/webhook/preflight` and existing webhook status.
   Require `verified` and inspect each page's current account and
   `bindingGeneration`. `rosterScope=unknown` is deliberate: visible accounts are
   not proof of a full roster.
2. POST the following body to `/api/v1/admin/ofapi/webhook/bindings` with an owner
   session, substituting values from current evidence. This example is synthetic.

```json
{
  "pageId": 9,
  "expectedAccountId": "acct_previous",
  "expectedGeneration": 1,
  "accountId": "acct_replacement",
  "identityEvidence": null,
  "historicalEvidence": [],
  "dryRun": true
}
```

Current persisted stable identity or the current mapped account's verified
roster identity must agree with the target creator. A replacement account or
username alone is insufficient. If the previous account has disappeared from
the visible roster and stable fields are empty, `identityEvidence` must reference
a retained `ofapi_admin_accounts` observation using `{id, receivedAt}`; its projected
successful response must establish that previous account's creator. Missing
evidence blocks replacement rather than inventing a seed. Original captured
observations already attributed to the page (including canonical event lineage)
may be referenced in `historicalEvidence` to import former account associations.

3. Review exact old/new account, creator, generation, historical references and
   recovery stream versions. Preview and apply require `is_authenticated=true` on
   the target roster record; the apply-time roster receipt is the recovery boundary. Obtain the applicable owner approval for this
   concrete production mutation.
4. Repeat the same body with `dryRun:false` and the returned `previewToken`.
   Credential, identity, binding or recovery drift rejects the apply and requires
   a new preview. The binding/history/recovery/audit write is atomic.
5. Verify current mapping, retained cursor state, original pauses, historical
   attribution and the live checks below. Existing uncertain sends stay parked.

## Remote webhook check and live rollout

Existing registration now GETs the stored remote ID before reporting a stable
noop and compares endpoint, enabled state, events and account scope. A remote
404 is insufficient alone: team-wide management visibility must be configured,
and a successful inventory must show neither that ID nor an overlapping endpoint.
Only then may the existing durable create/reconcile procedure replace it, keeping
old-ID provenance. 401/403/5xx, malformed scope and transport failures never
trigger creation. An uncertain previous create still requires reconciliation.

The current official webhook response schema does not document `account_scope`.
Tests therefore use an explicit synthetic scope field to exercise the comparison;
they do not prove live response compatibility. Capture and review the actual
response before registration acceptance. Missing remote scope stays unknown and
blocks mutation/noop; do not relax that check from a successful mock.

For an approved staged rollout:

1. Record current production bindings, blocker/checkpoint versions, webhook
   registration and effective flags through the permitted read plane. Confirm
   expected team independently and prepare configuration before deployment;
   otherwise stateful OFAPI actions will intentionally be unavailable.
2. Approve and deploy the immutable implementation commit and migration. Check
   migration success and each process's preflight; do not bundle collection flips.
3. Obtain one redacted free usage response (including `_meta._credits` or top-level
   `_credits`); verify fresh zero/nonzero balance without a paid chat request.
   Synthetic parser tests are not a current production fixture.
4. Preview any necessary identity/history repair. Do not replace healthy current
   account IDs merely to exercise the workflow. Apply only the approved mutation.
5. Verify one chatter's account selection, chat list and existing history reads;
   inspect fresh receipts and page attribution. Do not send a test DM unless its
   account/recipient/material are separately approved.
6. Review actual remote webhook scope and current ID. Retire only the former
   webhook targeting this Hub endpoint after proving replacement delivery and
   obtaining approval for that exact external mutation. Record its old ID/history.
7. Observe the agreed verification window; page silence needs activity context,
   not an unconditional alarm on every quiet page.

## Recovery and unresolved work

Migrations are not rolled back. Before any binding change, an old binary can only
be considered after verifying unchanged bindings and keeping vendor execution
paused. After replacement, rolling back to a binary without historical/generation
guards is unsafe. Prefer a forward fix; a deliberate return to an earlier account
must itself use new verified preview/apply evidence. Restoring a database snapshot
would discard newly captured facts and is not routine rollback.

**Posts capture remains open.** This release changes neither its transport nor
acceptance criteria. Collect attempt reason/phase/bytes/timeout and response
boundary through permitted diagnostics before claiming a root cause or fix.
Cancellation/recreation is not acceptance. Code readiness for the independent
slices above does not imply that posts, desktop canary, provider scope, receipt
silence or production recovery are verified.


## Local validation record

On the implementation branch: `pnpm check` passed (247 unit files, 2,700 passed,
9 existing skips; lint, repository strictness ratchet and dashboard build).
Strictness debt fell from 1,913 to 1,909 and its snapshot was tightened; the
repository still has that pre-existing type debt. Vite reports its existing
large-chunk warning. `pnpm contracts:generate` and `git diff --check` completed.
The dated full-repository code maps retain their earlier generation commit;
current release behavior is described here and in the generated API/auth artifacts.

The following single, serial integration invocation passed all 289 tests across
19 files with Docker/Testcontainers and no skips:

```sh
pnpm exec vitest run --no-file-parallelism \
  tests/ofapi-refresh.integration.test.ts tests/ofapi-webhook.integration.test.ts \
  tests/ofapi-account-health.integration.test.ts tests/ofapi-command-outbox.integration.test.ts \
  tests/ofapi-audience-sync.integration.test.ts tests/ofapi-fan-identities.integration.test.ts \
  tests/ofapi-read-gateway.integration.test.ts tests/ofapi-credit-ledger.integration.test.ts \
  tests/ofapi-dm-projection.integration.test.ts tests/ofapi-presence.integration.test.ts \
  tests/ofapi-dm-archive.integration.test.ts tests/ofapi-dm-sync.integration.test.ts \
  tests/ofapi-capture-repository.integration.test.ts tests/ofapi-flag-flip-hardening.integration.test.ts \
  tests/ofapi-sync-snapshot.integration.test.ts tests/canonicalize-sweep.integration.test.ts \
  tests/db-write.integration.test.ts tests/erasure-page-owned-tables.integration.test.ts \
  tests/erasure.integration.test.ts
```


### Auth recovery evidence boundary

The client stamps JS `Date` immediately after reading the complete roster body,
before capture or credit-ledger waits. That timestamp is persisted as the roster
observation receipt and used by apply as `ofapi_auth_changed_at`; custody and
binding audit retain its observation ID and receipt. Earlier lifecycle events of
the replacement cannot undo that proof; events at or after it remain eligible.
This is a transport receipt, not a vendor snapshot timestamp. Webhook receipt
uses the database clock on the same host; revisit clock assumptions if split.
A new-account event already processed before binding commit may find no page
and remain skipped. This window includes capture, credit, identity and lock waits;
the boundary does not replay such events.


### Owner pause during auth recovery

Apply and same-generation connected/reconnected clear the confirmed auth marker
on owner-paused rows while retaining their pause and checkpoints. Only Resume
releases the pause. Apply takes ordered sync-row locks before recovery reread:
a preceding Resume changes the snapshot and requires re-preview; a concurrent
Resume waits for commit and then sees the cleared marker. Legacy blockers whose
generation cannot be proved remain unchanged; there is no blanket backfill.
