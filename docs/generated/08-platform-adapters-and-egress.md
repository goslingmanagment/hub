> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Platform Adapters and Outbound Egress

Platform capability is declared through a small registry, while transport
identity and pacing are resolved through a separate egress seam. The two
boundaries answer different questions: the adapter says which work a platform
supports; egress says which network address and shared rate-limit lane a
request must use.

## 1. Platform-core contract

`packages/platform-core/src/index.ts` owns the platform-neutral vocabulary.
`PLATFORM_STREAMS` mirrors the database's eleven current sync stream names.
`PlatformCapabilities` declares:

- supported pull streams;
- whether webhooks exist;
- accepted command kinds;
- presence source (`webhook`, `poll`, or `none`);
- billing model (`credit_metered`, `flat`, or `session`).

`PlatformAdapter<TPullHandler>` adds the platform key and display name, one
bounded pull handler per declared stream, and a session-custody descriptor.
The generic handler type keeps platform-core independent of runtime executor
types. `createPlatformRegistry` rejects duplicate platform keys and provides
strict and optional lookups. `checkAdapterConformance` reports a missing
handler for a declared stream or a handler for an undeclared stream.

`packages/platform-core/src/egress.ts` separately defines page/vendor scopes,
the egress context, priority classes, and stable scope keys. Callers receive a
dispatcher, an egress identity key, a class-aware pacing function, and an
explicit close operation.

## 2. Runtime registry

`apps/runtime/src/platforms/registry.ts` eagerly constructs the process-wide
registry and makes conformance failure a boot failure.

| Capability | Fansly | OnlyFans through OFAPI |
|---|---|---|
| Pull streams | ten; every stream except `fan_identities` | seven: `light`, `transactions`, `fan_identities`, `top_spenders`, `subscribers`, `dm_conversations`, `dm_messages` |
| Webhooks | no | yes |
| Writes | none | text, media, typing, unsend, mark-read commands |
| Presence | poll | webhook |
| Billing | session | credit-metered |
| Session custody | encrypted pasted browser session | vendor API key; end-user session remains vendor-side |

Each registry slot points directly to the appropriate split handler in
`apps/runtime/src/services/sync/executor-handlers.ts`; platform selection does
not occur inside the dispatched handler. The registry also carries trigger
scope policy. Capability and policy are intentionally distinct: Fansly can run
the two bulk streams, but its manual `all` scope excludes them.

There is no OnlyFans adapter package parallel to `packages/fansly` at this
commit. OnlyFans pull and write behavior is implemented at the runtime OFAPI
boundary and assembled into the app registry. Platform-core is the shared
contract, not a promise of package symmetry.

## 3. Fansly transport adapter

`packages/fansly/src/adapter.ts` is the concrete direct-to-platform HTTP
adapter. Its read operations cover:

- account self and account-id lookup;
- wallet transactions and earnings accounts;
- subscribers and followers;
- messaging groups, group detail, and message pages;
- lifetime/monthly earnings statistics;
- media-order purchase history.

The adapter normalizes pagination and returns both parsed results and the raw
payload needed for capture. Requests run through
`executeObservedRequest`, carry operation/category/shape telemetry, use a
30-second timeout, classify transport and HTTP failures, honor retry delay, and
redact sensitive error text. Request context carries session headers, proxy,
egress key, pacing hook, and optional request observer; therefore sync budgets
count actual attempts.

`FanslyAdapter.getDispatcher` is fail-closed: no proxy raises
`FanslyProxyMissingError`. The class still owns a direct dispatcher for
lifecycle/test reset mechanics, but real request selection does not use it as
a proxyless production fallback. Proxy dispatchers are cached by normalized
proxy identity and are explicitly retired/closed when reset or when the
adapter closes.

The adapter's per-egress request chains preserve minimum spacing within an
address identity. App-level egress pacing remains a separate, database-backed
cross-process layer.

## 4. Credentials, page context, and connection lifecycle

`apps/runtime/src/services/page-context.ts` stores credential bundles and
proxy authentication as versioned encrypted JSON. It normalizes legacy Fansly
session field names, decrypts through the configured key ring, and derives a
stable proxy egress key from stored proxy metadata.

For OnlyFans, page context contains no hub-side browser session: OFAPI holds
that session and the runtime keeps an empty compatibility token plus optional
proxy. For Fansly, page context requires valid stored Fansly credentials and a
proxy. Missing proxy opens a `proxy_missing` notification incident and throws
`ProxyMissingError`.

`allowMissingProxy` is a narrow escape hatch for the proxy-assignment flow in
`apps/runtime/src/services/page-proxies.ts`. It lets the code resolve the page
whose missing state it is repairing; that caller verifies with the newly
supplied proxy and must not egress through the stored null proxy.

`apps/runtime/src/services/connections.ts`, `page-onboarding.ts`, and catalog
routes verify credentials before accepting connection changes and expose a
derived connection status. Runtime sync auth failures and OFAPI auth webhooks
feed durable stream/account health rather than mutating the adapter registry.

## 5. Egress resolver

`apps/runtime/src/services/egress/resolver.ts` is the app-wide resolver for
platform traffic. It has no implicit default scope.

| Scope | Network identity | Egress key | Missing-proxy behavior |
|---|---|---|---|
| page / Fansly | assigned page proxy, direct to Fansly | stored proxy key | refused with `ProxyMissingError` |
| page / OnlyFans | assigned page proxy when present; otherwise hub direct to OFAPI | proxy key or `direct` | direct is allowed because platform traffic remains vendor-side |
| vendor / OFAPI | hub direct to `onlyfansapi.com` | `vendor:ofapi` | not page-proxy-bound |
| vendor / Fansly | none | none | scope is rejected by construction |

The Fansly distinction is security-significant: vendor-wide or proxyless
Fansly traffic would reach the platform from the shared hub address. Both page
context and the resolver enforce refusal, and the sync executor classifies the
result as a manual `proxy_missing` blocker.

OnlyFans page-scoped reads may use the page proxy so large response bodies do
not traverse the hub's direct route. Vendor-global OFAPI operations remain
direct to the gateway and use their own vendor scope.

## 6. Cross-process pacing

`apps/runtime/src/services/egress/pacer.ts` uses
`sync_rate_limits` rows to reserve slots atomically across processes. Modes are
`off`, `shadow`, and `enforce`; priority classes are `interactive`, `commands`,
and `bulk`.

Each vendor has a `vendor_global` row plus one row per class. OFAPI's vendor
spacing defaults to the configured REST delay (500 ms by default). Fansly's
vendor-global spacing is zero because existing behavior has no cross-proxy
global cap. Interactive and command class spacing is zero; bulk self-spaces at
the vendor rate.

Bulk reservation is deliberately two-phase:

1. Claim and wait on `class:bulk`, keeping the backlog out of the global row.
2. Immediately before send, claim and wait on `vendor_global`.

Interactive/command requests reserve the global and their class row together.
This keeps bulk backlog from moving the vendor horizon while still preventing
bulk starvation after it has claimed its own class slot. Shadow `plan()` uses
`shadow:vendor:<vendor>` rows and never advances the rows used by enforced
traffic.

## 7. Static egress ratchets

Two scripts keep bypasses visible:

- `scripts/check-platform-branches.mjs` compares strict platform-branch sites
  to `scripts/platform-branch-budget.json`; the current ceiling is 50. The
  budget records the intentional AI prompt wording branch and the OnlyFans-only
  fast-reply union read gate.
- `scripts/check-raw-fetch.mjs` compares global raw `fetch(` call sites outside
  the egress area to `scripts/raw-fetch-budget.json`; the current ceiling is
  13.

Both are ratchets: increases fail and a lower observed count asks for the
recorded ceiling to be reduced.

## 8. Fansly operational probes and support paths

`apps/runtime/src/services/fansly-replay-probe.ts` exercises representative
read families through the same page context, proxy, pacing, and adapter path as
normal work. `calls` must be a positive integer. Dry-run produces skipped
rows, and a result set with no actual probes explicitly carries no
replayability verdict.

Followers/presence and page-alias repair remain Fansly-specific runtime
services, while proxy assignment, connection verification, durable sync
state, raw capture, and health reporting use shared seams. Platform-specific
behavior is therefore declared at adapter/handler edges without pretending
that both providers expose identical APIs or custody models.
