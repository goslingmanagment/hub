> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Platform Adapters and Outbound Egress

This document maps the platform seam and the outbound egress path of the
agency-hub kernel: the `platform-core` adapter contract, the two app-layer
adapters (`fansly`, `onlyfans`), the Fansly HTTP adapter, the OnlyFans package's
current stub state, the Stage 26 egress resolver and class-aware pacer, the two
discipline ratchets that hold the seam in place, and the page-identity /
connection lifecycle that feeds them. It is strictly descriptive; where a name
or comment diverges from runtime behavior, the actual behavior is described.
File anchors are repo-relative (e.g. `packages/fansly/src/adapter.ts:61`).

## 1. The platform seam (`packages/platform-core/src/index.ts`)

Introduced in kernel Stage 18. The package defines the adapter contract that
replaced the roughly 57 strict `platform ===` branch sites the codebase carried
before (`index.ts:1-4`).

**Contract types.**

- `PlatformAdapter<TPullHandler>` (`index.ts:67-77`): `key: Platform`,
  `displayName`, `capabilities`, `pull: Partial<Record<CanonicalStream,
  TPullHandler>>`, and `session: SessionCustodyDescriptor`. The pull-handler
  type is a generic parameter, which keeps `platform-core` app-agnostic; the
  concrete adapters are assembled in the app layer (`index.ts:59-65`).
- `PlatformCapabilities` (`index.ts:36-45`): `streams: CanonicalStream[]`,
  `webhooks: boolean`, `writes: PlatformCommandKind[]` (an empty array means
  read-only), `presenceSource: "webhook" | "poll" | "none"`, and
  `billing: "credit_metered" | "flat" | "session"`.
- `SessionCustodyDescriptor` (`index.ts:53-57`): `kind: "api_key" |
  "browser_session" | "oauth"` plus a human-readable `lifecycle` string. It
  declares WHAT credential a platform uses, not HOW it is captured (an area
  flagged for owner custody).
- `CanonicalStream` (`index.ts:31`) — the 11 `PLATFORM_STREAMS`
  (`index.ts:17-29`): `light`, `fan_identities`, `transactions`,
  `top_spenders`, `subscribers`, `followers`, `followers_reconcile`,
  `dm_conversations`, `dm_messages`, `fan_earnings`, `purchase_history`. The
  comment at `index.ts:6-11` notes these are today's sync-stream names, pinned
  equal to the db `SYNC_STREAMS`; canonical renames are deferred to a later
  migration.

**Registry.** `createPlatformRegistry` (`index.ts:86-108`) builds a `Map` keyed
by `adapter.key`, throws on a duplicate key, and its `get()` throws on an
unknown key. `checkAdapterConformance` (`index.ts:115-129`) asserts that every
declared stream has a pull handler and every pull handler has a declared
stream; the conformance test asserts the returned violation list is `[]`.

## 2. App-layer wiring (`apps/runtime/src/platforms/registry.ts`)

The two adapters are assembled in the app layer because their pull handlers
need `AppContext` / executor types (`registry.ts:34-43`). The app extends the
base contract: `AppPlatformAdapter = PlatformAdapter<ExecutorPullHandler> & {
syncScopes }` (`registry.ts:65-67`). Pull maps route straight to the split
handler halves from `executor-handlers.ts` (`registry.ts:97-118`).
`createAppPlatformRegistry()` runs conformance and throws on failure
(`registry.ts:194-203`); `appPlatformRegistry` is built eagerly so a
conformance failure surfaces as a boot failure rather than a runtime 500
(`registry.ts:205-207`). Exactly two platforms are enumerated — `fansly` and
`onlyfans` (`registry.ts:195`).

### Capability comparison

| Capability | Fansly (`registry.ts:120-153`) | OnlyFans (`registry.ts:155-192`) |
|---|---|---|
| streams | 10 streams — every stream except `fan_identities` (`registry.ts:71-82`) | 7 streams (OFAPI-era: `light`, `transactions`, `fan_identities`, `top_spenders`, `subscribers`, `dm_conversations`, `dm_messages`) (`registry.ts:85-93`) |
| webhooks | `false` | `true` |
| writes | `[]` (read-only) | 5 command kinds: `send_text_message_v1`, `send_media_message_v1`, `typing_active_v1`, `unsend_message_v1`, `mark_chat_read_v1` |
| presenceSource | `poll` | `webhook` |
| billing | `session` | `credit_metered` |
| session.kind | `browser_session` — a pasted session, verified on paste; death signal 401/403 raises an `auth_blocked` incident (`registry.ts:147-152`) | `api_key` — vendor-held sessions behind the OFAPI gateway (onlyfansapi.com); death arrives as an `accounts.authentication_failed` webhook (`registry.ts:186-191`) |

**`syncScopes` policy layer.** `syncScopes` is a policy layer distinct from
capabilities (`registry.ts:57-63`) and is a subset of the declared streams.
Fansly's `all` scope deliberately excludes the bulk `fan_earnings` and
`purchase_history` crawls (Stage 16: a manual sync-all must not fire the heavy
crawls) (`registry.ts:135-144`).

## 3. Fansly adapter (`packages/fansly/src/adapter.ts`)

Class `FanslyAdapter` (`adapter.ts:61`), constructed with
`{ baseUrl, globalDelayMs? }` (`adapter.ts:37-40, 68`).

**Transport / base URL.** The base URL is `https://apiv3.fansly.com/api/v1`,
the `FANSLY_BASE_URL` default (`packages/shared/src/config.ts:83`,
`config-registry.ts:112`). It is injected at boot:
`new FanslyAdapter({ baseUrl: config.fanslyBaseUrl, globalDelayMs:
config.fanslyDefaultDelayMs })` (`apps/runtime/src/bootstrap.ts:183-186`).
Every request appends `?ngsw-bypass=true` (`adapter.ts:566`), uses `undici`
`fetch` with `AbortSignal.timeout(30_000)` (`REQUEST_TIMEOUT_MS`,
`adapter.ts:57, 592`), and is GET-only.

**Auth (headers).** `buildHeaders` (`adapter.ts:720-741`) sets
`authorization: session.authorization`, `fansly-client-ts: Date.now()`,
`accept`, and `referrer: https://fansly.com/`, plus optional `fansly-client-id`,
`fansly-client-check` (the single pasted session-check, `adapter.ts:442`), and
`fansly-session-id`.

**Rate limiting / global delay / followers delay.** `waitForRateLimit`
(`adapter.ts:791-855`) is a two-level promise-chain gate (per-category, then
global) keyed on `egressKey` (`{egressKey}:{category}` and `{egressKey}`). The
global delay defaults to 2500 ms (`this.options.globalDelayMs ?? 2500`,
`adapter.ts:831`) plus `GLOBAL_DELAY_SAFETY_MARGIN_MS = 100`
(`adapter.ts:58, 832-834`). `FANSLY_DEFAULT_DELAY_MS` defaults to 2500
(`config.ts:91`, `config-registry.ts:113`; the legacy aliases
`FANSLY_GLOBAL_DELAY_MS` and `FANSLY_ACCOUNT_LOOKUP_DELAY_MS` feed the same
field, `config-registry.ts:114-115`). A separate per-category `followers_page`
scope engages only when `category === "followers" && minDelayMs > 0`
(`adapter.ts:798-800`); `minDelayMs` is fed by `config.followerPageDelayMs`,
default 5000 (`FOLLOWER_PAGE_DELAY_MS`, `config.ts:94`,
`config-registry.ts:116`), passed in from the executor
(`executor-handlers.ts:1861, 2131`). There are also per-category scopes for
`dm_conversations` / `dm_messages` (`adapter.ts:801-806`). When
`context.rateLimitWaiter` is present, the adapter delegates to that DB-backed
waiter instead (`adapter.ts:809-811`).

**Retry policy.** Retries default to 3 (`adapter.ts:574`). Transport errors use
`retryDelayMs(attempt) = 5000 * attempt` with 0.5–1.0× jitter (a
thundering-herd guard). HTTP statuses `[429, 500, 502, 503, 504]` are retried,
honoring `retry-after` via `resolveRetryDelayMs` (`adapter.ts:653-665`).
`401`/`403` fail hard immediately with a `FanslyApiError` (authorization
failed) (`adapter.ts:637-651`). The `{success, response}` envelope is
unwrapped; a falsey `success` becomes a `provider` failure
(`adapter.ts:683-697`). All requests route through `executeObservedRequest`
from `shared` (`adapter.ts:578`, retry logic at `adapter.ts:602-665, 885-890`).

**Replay-probe methods (Stage 6).** Three read-only, loosely typed methods —
`getEarningsStatsAccountsPage`, `getEarningsMonthlyStatsAccountsPage`,
`getMediaOrderHistoryPage` (`adapter.ts:439-544`). They test whether core can
server-side replay the endpoint families that only the extension calls today,
reusing the single pasted `fansly-client-check`.

**Observer pattern.** `context.requestObserver` (`FanslyRequestContext`,
`types.ts:3-12`) drives `executeObservedRequest` (`adapter.ts:578-581`); errors
are sanitized via `redactSensitiveText` / `formatObservedError`, and the
response snippet is capped at 400 chars (`adapter.ts:625-635`).

**Proxy enforcement / dispatcher management.** A per-proxy `undici`
`Dispatcher` cache is keyed by `buildProxyDispatcherCacheKey`
(`adapter.ts:747-757`); `getDispatcher(proxy)` returns the proxy dispatcher or
the direct dispatcher (`adapter.ts:743-745`). On a transport error,
`resetDispatcher` rotates the agent and gracefully retires the old one
(`adapter.ts:604-606, 759-785`). A null proxy falls back to
`this.directDispatcher`, i.e. the hub IP hitting `apiv3.fansly.com` directly —
the **direct-IP ban risk**; the egress-resolver contract (§4) is what prevents
accidental direct egress. `close()` closes both active and retiring dispatchers
(`adapter.ts:70-81`). The class field set is at `adapter.ts:62-81`.

**Endpoint catalog.** `/account/me` (account_me → `verifySession`,
`adapter.ts:83-95`); `/account?ids=` (account_lookup, ≤100 ids,
`adapter.ts:97-114`); `/account/wallets/earnings/transactions` (transactions,
`adapter.ts:116-164`); `/account/wallets/earnings/accounts` (top_spenders, page
limit 100, `adapter.ts:166-202`); `/subscribers?status=3,4`
(`adapter.ts:204-254`); `/account/:accountId/followersnew` (followers, carries
`minDelayMs`, `adapter.ts:256-311`); `/messaging/groups` (dm_conversations,
`adapter.ts:313-370`); `/group/:groupId` (`adapter.ts:372-390`);
`/message?groupId=` (dm_messages, default limit 25, `adapter.ts:392-433`).
Types live in `packages/fansly/src/types.ts`;
`FanslyApiError(message, status, code, responseSnippet)` in `errors.ts:1-11`;
the package re-exports adapter / errors / mappers / types (`index.ts:1-4`).

## 4. OnlyFans package state (`packages/onlyfans/`)

`packages/onlyfans/` is an empty stub — no `src`, no `package.json`, only a
`node_modules/` directory (symlinks to `@agency_hub_core/shared` and `undici`).
No `@agency_hub_core/onlyfans` import exists anywhere. OnlyFans is
OFAPI-mediated: sessions are vendor-held behind the OFAPI gateway
`onlyfansapi.com`, and the kernel holds only the vendor API key
(`registry.ts:186-191`). OnlyFans pages carry no hub-side session or proxy —
identity and egress live at the vendor (`page-context.ts:189-200`;
`connections.ts:219-226`; `page-proxies.ts:34-40`). The only surviving OnlyFans
code is platform-shaped hygiene in `apps/runtime/src/services/onlyfans.ts`:
`normalizeOnlyFansAvatarUrl` (strips signed-URL query keys, `onlyfans.ts:5-45`)
and `resolveOnlyFansDisplayName` (`onlyfans.ts:68-92`), both used by OFAPI
identity paths. OnlyMonster is explicitly retired (`onlyfans.ts:1`,
`page-context.ts:190`).

## 5. Egress resolver — Stage 26 (`apps/runtime/src/services/egress/`)

Two files: `resolver.ts` and `pacer.ts`. The seam shape is defined in
`packages/platform-core/src/egress.ts`.

**Seam shape (`egress.ts`).** `EgressScope = {kind:"page", pageId}` |
`{kind:"vendor", vendor}` (`egress.ts:24-26`). `EgressContext<TDispatcher>` =
`{ egressKey, dispatcher: TDispatcher | null, pace(class), close() }`
(`egress.ts:28-38`). Priority classes, highest-first, are
`["interactive", "commands", "bulk"]` (`egress.ts:12`). `egressScopeKey` maps
to `page:{id}` / `vendor:{name}` (`egress.ts:44-46`). There is no default path:
a caller without a scope cannot build a client (`egress.ts:5-6`).

**`resolveEgress(app, scope)` (`resolver.ts:43-86`).** The only legal way to
get outbound platform transport (`resolver.ts:17-19`). The per-vendor address
policy is recorded at `resolver.ts:21-33`:

- `vendor:"fansly"` is **refused** — Fansly egress must always be page-scoped;
  a vendor-wide Fansly transport would be an address-consistency violation by
  construction (`resolver.ts:31-33, 48-52`).
- `vendor:"ofapi"` resolves vendor-direct with `dispatcher: null` (the hub
  address) and `egressKey: "vendor:ofapi"` (`resolver.ts:53-64`).
- `kind:"page"` loads `findPageById`; an unresolved page throws `NotFoundError`
  (`resolver.ts:66-69`). It resolves the page's stored proxy into an
  `egressKey` via `resolveStoredProxyEgressKey`, builds a proxy or direct
  `undici` dispatcher, and picks the pacer vendor via
  `PLATFORM_VENDORS = { onlyfans:"ofapi", fansly:"fansly" }`
  (`resolver.ts:38-41, 71-85`). A page with no proxy egresses direct under key
  `"direct"` (`resolver.ts:23-27`, `page-context.ts:160-168`).

**Proxy storage / resolution (`page-context.ts`).** `saveProxy` (the
`page-proxies` path) encrypts username/password (AES via `encryptJson`) and
stores `url`, `encryptedAuth`, `keyVersion`, `rateLimitScopeKey`
(`page-context.ts:100-128`). `resolveStoredProxyConfig` decrypts auth and
normalizes (`page-context.ts:137-158`). `resolveStoredProxyEgressKey` returns
the stored `rateLimitScopeKey`, or derives one via `buildProxyEgressKey`, or
`"direct"` when there is no proxy (`page-context.ts:160-168`).

**Proxy set / validation (`page-proxies.ts`, `proxy-validation.ts`).**
`setPageProxy` normalizes, calls `assertAllowedProxyTarget`, resolves the page
context, computes an egress key preserving the stored route when unchanged, and
then verifies the session through the new proxy (`app.adapter.verifySession`)
before persisting (`page-proxies.ts:14-52`). OnlyFans pages reject proxy
assignment — egress is vendor-side (`page-proxies.ts:34-40`).
`assertAllowedProxyTarget` (`proxy-validation.ts:16-41`) runs
`assertProxyTargetAllowed` plus a DNS `lookup` (all addresses, verbatim),
rejecting loopback / private / link-local / multicast / localhost via
`isDisallowedProxyHostname` — the SSRF / DNS-rebinding guard (best-effort for
hostnames, strict for literals).

**Pacer (`pacer.ts`).** Class-aware pacing over DB `sync_rate_limits` rows, with
claim-at-reservation. Per vendor, under `egress_key="vendor:<vendor>"`, there
is a `vendor_global` row (a shared cap paid immediately) plus
`class:interactive|commands|bulk` rows (`pacer.ts:92-109`). Vendor-cap spacing:
`ofapi` = `max(0, ofapiRestDelayMs ?? 500)`; `fansly` = 0 — there is no
cross-proxy Fansly cap today, and the row exists as a 0-knob
(`pacer.ts:64-77, 14-21`). Bulk is two-phase (`pacer.ts:24-34, 153-171`): a
bulk request waits for its own `class:bulk` slot and only THEN claims
`vendor_global` (the imminent send), which keeps interactive traffic from ever
queuing behind a bulk backlog; an aging floor prevents starvation. Modes are
`off | shadow | enforce` from `egressPacerMode`, default `off`
(`pacer.ts:36, 86`; `config-registry.ts:139`). The pacer is wired into the
OFAPI client at boot (`bootstrap.ts:195-204`).

## 6. Discipline ratchets

Both ratchets currently sit exactly at budget.

**Platform-branch ratchet — `scripts/check-platform-branches.mjs` (Stage 18).**
`countPlatformBranches` (`:14-32`) runs
`grep -rn "platform ===" --include=*.ts apps packages tests`, then excludes
lines matching `^packages/(onlyfans|fansly)/` (the adapter packages) and lines
containing `platform-registry.test.ts` (the ratchet's own test
infrastructure). It fails when `count > budget`; the count may only decrease,
and a drop prints a nudge to ratchet the JSON down (`:37-45`).
`scripts/platform-branch-budget.json` sets `budget: 49`, with the note
(`:4`): "2026-07-06: +1 for the Stage 32 named platform substitution
(applyPlatformWording in ai/prompts/builder.ts) — a deliberate wording branch,
not platform logic drift." Current actual count: 49 (exactly at budget).

**Raw-fetch ratchet — `scripts/check-raw-fetch.mjs` (Stage 26).**
`countRawFetchSites` (`:17-38`) runs
`grep -rnE "(^|[^.\w$])fetch\(" --include=*.ts apps/runtime/src packages`, then
excludes lines starting `apps/runtime/src/services/egress/` (the resolver's own
modules — the one legal home) and lines containing `check-raw-fetch`. The match
is deliberately blunt: type positions and comments still count (`:32-37`); the
target trajectory is 0, and non-platform egress (Telegram, Anthropic) rides on
recorded exceptions. `scripts/raw-fetch-budget.json` sets `budget: 13`, with the
comment (`:2`): "Day-one 13 = ofapi.ts 7 + fansly adapter 1 + telegram 4 +
anthropic provider 1." Current actual count: 13 (exactly at budget).

## 7. Page identity and connection lifecycle

**Page = platform account.** DB helpers `findPageById` / `findPageByLabel`
return `{ page, credentials, proxy }`; `page.platform` is one of `fansly` /
`onlyfans`, and `page.platformAccountId` binds the upstream account
(`connections.ts:44-57`, the identity assertion). The Fansly platform account
id is resolved from `page.platformAccountId` or metadata
(`services/fansly.ts:40-53`).

**`page-context.ts` — resolves a page to an egress-ready context.**
`resolvePageContext` / `resolvePageContextById` reach `resolveStoredPageContext`
(`page-context.ts:170-256`):

- Not found → `NotFoundError`.
- OnlyFans → returns `{page, platform:"onlyfans", auth:{token:""}, proxy,
  egressKey}` — an empty token, no hub-side session (`:189-200`).
- Fansly → requires stored credentials (else `BadRequestError`), decrypts
  (`decryptJsonWithKeyVersion`), validates that the bundle's platform matches,
  and returns `{page, platform:"fansly", session, proxy, egressKey}`
  (`:202-253`). A cross-platform credential mismatch throws (for example
  OnlyFans creds on a Fansly page, `:229-233`).
- Result types: `ResolvedPageContext`, `ResolvedFanslyPageContext`,
  `ResolvedOnlyFansPageContext` (`:258-260`).

**`provider.ts` — the platform-agnostic provider contract.**
`ProviderAdapter<...>` (`:43-67`): `getAccountMe`, `verifySession`,
`getAccountsByIdsPage`, `getTransactionsPage`, `getSubscribersPage`,
`getFollowersPage`; response envelopes `ProviderResponse` /
`ProviderPageResponse` / `ProviderFollowersPageResponse` (`:1-41`). This is the
generic seam that the concrete `FanslyAdapter` satisfies structurally.

**`connections.ts` — connection lifecycle / status.**
`ConnectionStatus = active | stale | error | expired | never_synced |
unverified` (`:27-33`). `classifyConnectionStatus` (`:99-134`): no credentials →
`unverified`; no light-sync yet → `never_synced`; a latest light run that
`failed` with an auth signal → `expired`; a `failed` run otherwise → `error`;
otherwise `stale` when hours-since-light-sync exceeds
`STALE_THRESHOLD_HOURS = 9` (`:35`); otherwise `active`. Auth signals are
matched narrowly: `401`, `unauthorized`, `403`, `forbidden`, `invalid token`,
`expired`, `authentication` (`:83-97`). `updatePageCredentials` (`:204-320`)
rejects a platform mismatch; OnlyFans has no stored creds to update
(`:219-226`); for Fansly it verifies via `app.adapter.verifySession` and asserts
the verified upstream account id matches the page binding
(`assertVerifiedAccountIdentity`, `:44-57, 277-281`), re-encrypts, optionally
saves or removes a proxy, and clears incidents via
`handleSuccessfulPageVerificationRecovery` (`:311-317`).
`listConnectionStatuses` joins the latest light run and the sync-UX snapshot per
page (`:146-202`).

## 8. Fansly presence, page-alias backfill, replay probe

**Presence (`fansly-presence.ts`).** Fansly's `presenceSource:"poll"` is
realized here — presence is derived from followers' `lastSeenAt`, as there is no
webhook. `buildFanslyFollowerPresenceSignals` (`:42-80`) joins followers to
their `aggregationData.accounts`, takes each fan's `lastSeenAt`, and buckets by
age via `classifyFanslyPresenceBucket` (`:29-40`): `active_now` < 30 min
(`FANSLY_ACTIVE_NOW_WINDOW_MS`, `:7`), `recently_active` < 120 min (`:8`), else
dropped. The source tag is
`FANSLY_EXTERNAL_PRESENCE_SOURCE_FOLLOWERS_LAST_SEEN` (`:3, 74`). It dedupes to
the newest signal per `followerId`.

**Page-alias backfill (`fansly-page-alias-backfill.ts`).**
`backfillFanslyPageAliases` (`:22-131`): for Fansly pages (a non-Fansly page
throws, `:34-38, 65-67`), it pulls DB backfill targets
(`listFanslyFanPageIdentityBackfillTargets`), batches unique fan ids into chunks
of ≤100 (`:61, 92-93`), calls `app.adapter.getAccountsByIdsPage` (the
`/account?ids=` endpoint) per chunk, computes `fallbackIds` for ids the API did
not return, and feeds `upsertHydratedFansForPageDetailed` to reconcile accounts,
fan notes, and aliases (`:94-112`). It returns per-page and aggregate counters
(accountsReturned, fallbackMisses, reconciledAccounts, notes seen / upserted /
deactivated, aliasesSet / Cleared). Its purpose is to retroactively hydrate and
alias fan identities on Fansly pages from the account-lookup endpoint. This
backfill's request context omits `rateLimitWaiter` (`:71-75`), unlike the replay
probe.

**Replay probe (`fansly-replay-probe.ts`, Stage 6).** `runFanslyReplayProbe`
(`:85-178`) fires one read-only call per endpoint family
(`earnings/stats/accounts`, `earnings/monthlystats/accounts`,
`media/orderhistory`, `:51-55`) through a page's production egress and pacing,
classifying whether core's single pasted `fansly-client-check` validates
server-side: `auth-rejected` (401/403 = not replayable) versus
`route-rejected` / 200 (= replayable) versus `transport-error` (`classify`,
`:63-83`). `summarizeReplayProbe` prints a verdict table (`:181-214`). A
non-Fansly page throws (`:95-97`).

**Adapter test suite (`tests/adapter-fansly-*.test.ts`).** `transport` (rotates
the direct dispatcher after a transport error), `retry` (retries 429 honoring
retry-after), `global-delay` (probes the private `waitForRateLimit`
structurally), `followers-delay` (keeps follower pacing above the host-global
delay), `proxy` (reuses proxy dispatchers, 30s timeout, closes cached agents),
`observer` (emits sanitized observer events for offset pagination), `query`
(preserves zero offset / limit across paginated endpoints), and `replay-probe`
(correct URLs / queries / headers, omits unset optional params).
