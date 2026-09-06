# OFAPI owner actions: scope expansion

The owner explicitly approved implementing publishing/campaigns, user and vault
list changes, moderation, banking/account settings, and the provider's native
Saved-for-later automation after the original coverage stack. Subscribing to
users is excluded, including changes to the provider's `following` list.

The common owner action plane is available at **Управление OnlyFans**
(`/ofapi-actions`). It uses typed fields and generated SDK operations. Prepare
is local; Execute sends the frozen request once. Refresh and repair only read
or process retained evidence. A prepared action can be cancelled locally;
cancelling a published post or running campaign is its own provider action.

## Batch 1: shared execution and collections

Twenty operations cover user lists, vault folders and media removal, block and
restrict, and separate native OnlyFans fan notes. See `collections.md` for the
operation inventory and verified vendor contracts.

The caller's principal, account binding generation and credential fingerprint
are frozen. The binding lock covers dispatch through response capture. An
owner action uses nonblocking locks so concurrent requests cannot exhaust the
connection pool while waiting for a binding. A busy request keeps its prepared
intent and can be submitted again after checking the current status.

The shared daily credit counter reserves the documented estimate before HTTP
(five credits for `skip_invalid`, one for other collection actions). Actual
provider receipts settle that reservation once. The accounting mode is frozen
at dispatch, so changing the ledger flag cannot charge the same result twice.

Raw responses and commands are encrypted. Administrative result projection and
accounting can be repaired without repeating the physical request. Native notes
never overwrite Hub notes. Page/fan erasure follows explicit subject references
and fences in-flight response handling and later replay. An anonymous admitted
UUID remains after erasure, without page, principal, time or payload, so an old
request cannot be recreated and physically dispatched again.

## Owner rollout

1. Merge and deploy the preceding coverage stack and this batch in order; apply
   the forward migration with the normal deployment procedure.
2. Sign in as the owner and open **Управление OnlyFans**. Select a bound account.
3. Select an action, fill its fields and press **Проверить действие**. Review the
   exact account, parameters and credit estimate, then press **Выполнить**.
4. For a partial list addition, use the retained `added` and `failed` IDs. Never
   resubmit the entire batch after an indeterminate result.

No collector, native automation or production setting is enabled by deploying
this code. These controls perform explicit owner requests only. Testing uses
synthetic provider responses; no authenticated OFAPI request is part of the
development checks. Vendor credits spent during implementation: **0**.

Validation: `pnpm check` (typecheck ratchet, ESLint, 2880 unit tests and
production dashboard build); 26 owner-action integration cases, 6 erasure
cases, 14 media custody cases, plus existing composer/outbox, erasure and schema
regressions. Local Playwright exercised owner login, prepare/execute, retained
result and partial addition. Desktop and 390px screenshots were inspected;
mobile navigation and no horizontal overflow were checked. Vendor responses
were synthetic against a disposable local PostgreSQL server. Local/CI
acceptance does not claim live provider or production acceptance.
