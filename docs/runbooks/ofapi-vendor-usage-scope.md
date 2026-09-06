# OFAPI vendor usage and declared credential scope

S4b/S5 implementation, based on release #132 at `7fac98f3`. New reports use the free vendor usage endpoint; no collector is enabled by installation or top-up.

## Operator workflow

Open OFAPI Credits, then "Сверка с провайдером и права ключа". Choose a closed UTC range (at most 366 days), then request the free report. Provider totals, locally recorded credits, locally estimated credits and external balance residuals remain separate. No vendor aggregate creates a ledger expense. Today can be explicitly requested through the SDK with `includeToday: true` and remains provisional.

The original HTTP response is captured before parsing. Valid bounded aggregates are materialized in `ofapi_vendor_usage_snapshots` referencing that observation; parsing can be repeated from the captured body. This is team accounting evidence containing aggregate counts and provider account IDs, not fan records. Snapshots and key declaration audit have no scheduled deletion. The snapshot is not a canonical revenue fact, and never feeds revenue or spend admission.

Read key scope, configure the actual credential in the provider console, and record only confirmed operation/account restrictions. Unknown is supported. Local scope changes are CAS/versioned and tied to the SHA-256 fingerprint of the configured server credential. Neither the key nor its tokens are exposed. The operation classes are reads, commands, webhooks, exports, uploads and links. Hub principal/page ACL and credential/team preflight remain independent. Free identity and credit diagnostics remain available to diagnose denied access. A different credential does not inherit this declaration.

`whoami` does not document permission introspection or public scope CRUD. An owner declaration is labelled as such, and does not prove that the provider granted a permission. Actual 401/403 and OF session failures continue through their existing separate classifications. A restricted roster does not prove an account is disconnected.

## Accounting boundaries

Fresh `x-ofapi-credits-used` and `x-ofapi-credits-balance` headers take precedence over potentially cached `_meta`; both original sources stay captured. Headers are used for bodyless, binary and error responses. `x-ofapi-is-cached` and `Idempotent-Replayed` are retained; neither alone proves a zero charge or successful send. Local reservations without price evidence remain estimates. Export-start reservations keep the approved variable-cost ceiling until lifecycle settlement.

Historical ledger rows do not prove credential-generation continuity. The comparison therefore does not claim equivalent scopes, including when today's declaration says team-wide. Null account/endpoint buckets remain unattributed. A difference is a diagnostic result, not a newly created expense or evidence of missing money.

## Validation and rollout

Deterministic unit/integration tests cover malformed scopes, real calendar dates, zero-balance free reads, durable observations, independent aggregates, concurrent CAS, account/capability refusal and header/body precedence. Production rollout remains owner-gated. After merge deploy the additive migration; verify existing chatter compatibility first, then use one free closed-day report. Changing provider credentials/permissions or activating optional collectors requires the owner's explicit action; this screen does neither automatically.

## Sources and discrepancies

- https://docs.onlyfansapi.com/api-reference/usage/get-credit-usage (checked 2026-09-06): free, at most 366 days, nightly aggregates, restricted keys retain team unattributed spend.
- https://docs.onlyfansapi.com/api-reference/api-keys/whoami (checked 2026-09-06): identity, no documented public scope management API.
- The usage example sends `include_today=true` while returning `includes_today=false`; implementation refuses a scope mismatch rather than treating that example as a valid reconciliation fixture.
