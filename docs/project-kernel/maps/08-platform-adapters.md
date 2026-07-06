> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 08 — Platform Adapters (OnlyFans & Fansly outbound)

**Scope.** This document covers the outbound integration layer that pulls data from the two creator platforms and the proxy/credential plumbing that surrounds it. Files covered in full: the `@agency_hub_core/onlyfans` package (`packages/onlyfans/src/adapter.ts`, `types.ts`, `mappers.ts`, `errors.ts`, `index.ts`); the `@agency_hub_core/fansly` package (`packages/fansly/src/adapter.ts`, `types.ts`, `mappers.ts`, `errors.ts`, `index.ts`); and the runtime services `apps/runtime/src/services/onlyfans.ts`, `onlyfans-public-profiles.ts`, `onlyfans-page-metadata-backfill.ts`, `fansly.ts`, `fansly-page.ts`, `fansly-presence.ts`, `fansly-page-alias-backfill.ts`, `connections.ts`, `page-context.ts`, `page-proxies.ts`, `proxy-validation.ts`, `page-onboarding.ts`. Callers in `apps/runtime/src/services/sync/*` (territory 06 — Sync) and the shared HTTP/proxy/crypto helpers in `packages/shared/src/*` (territory 15) are referenced but documented in their own territories.

---

## 0. The three upstreams (critical naming clarification)

There are **three distinct outbound network destinations** in this territory, and the naming is misleading. Do not conflate them:

| Internal name | Actual host | Reached from | What it is |
| --- | --- | --- | --- |
| **OnlyMonster** (a.k.a. the "OnlyFans adapter") | `https://omapi.onlymonster.ai` (`onlyMonsterBaseUrl`, env `ONLYMONSTER_BASE_URL`, `packages/shared/src/config-registry.ts:126`) | `packages/onlyfans` `OnlyFansAdapter` | A **third-party OnlyFans data aggregator/proxy service**. The `@agency_hub_core/onlyfans` package does **not** talk to `onlyfans.com` and does **not** use OFAPI. It authenticates with an OnlyMonster-issued token (`x-om-auth-token`). |
| **OnlyFans.com (public)** | `https://onlyfans.com` (`onlyfans-public-profiles.ts:9`) | `onlyfans-public-profiles.ts` via headless Playwright Chromium | The only path in this territory that hits OnlyFans directly. Anonymous (no session cookies); scrapes a public profile XHR. |
| **Fansly** | `https://apiv3.fansly.com/api/v1` (`fanslyBaseUrl`, env `FANSLY_BASE_URL`, `packages/shared/src/config-registry.ts:112`) | `packages/fansly` `FanslyAdapter` | Fansly's own (unofficial, browser-emulating) private API, called **directly** with the model's browser session token. |

A **fourth** OnlyFans upstream — **OFAPI** — exists but belongs to territory 06 (Sync/OFAPI). It surfaces in this territory only as a fallback in `onlyfans-page-metadata-backfill.ts` via `app.ofapi.listAccounts()` (see §9). So OnlyFans data enters the system through two independent channels: OnlyMonster (used by the sync executor for transactions/messages/link-users) and OFAPI (used by webhooks + metadata backfill).

Both adapter classes are constructed once at boot in `apps/runtime/src/bootstrap.ts:162-169` and exposed on `AppContext` as `app.adapter` (**Fansly**) and `app.onlyFansAdapter` (**OnlyMonster**). Note the field-name inversion: `app.adapter` is Fansly, and the OnlyFans-named field is `onlyFansAdapter`.

---

## 1. The adapter shape (there is no shared interface)

Both packages have an identical file layout but **no shared abstract interface or base class** — they are two independent classes with parallel (hand-mirrored) structure:

| File | OnlyFans (OnlyMonster) | Fansly |
| --- | --- | --- |
| `adapter.ts` | `class OnlyFansAdapter` | `class FanslyAdapter` |
| `types.ts` | `OnlyFansRequestContext` + response DTOs | `FanslyRequestContext` + response DTOs |
| `mappers.ts` | raw transaction type/state → internal enums | raw numeric type/state/sub-status → internal enums |
| `errors.ts` | `OnlyMonsterApiError(message, status?, responseSnippet?)` | `FanslyApiError(message, status?, code?, responseSnippet?)` |
| `index.ts` | re-exports all four | re-exports all four |

Each adapter is instantiated with `{ baseUrl, defaultDelayMs? }` (OnlyFans, `adapter.ts:33-36`) or `{ baseUrl, globalDelayMs? }` (Fansly, `adapter.ts:37-40`). All request methods take a **request context** as the first argument that carries per-call credentials, proxy, egress key, an optional telemetry observer, and an optional rate-limit waiter — the adapters are otherwise stateless with respect to a page. Both hold only transport-level state internally: a direct undici `Dispatcher`, a proxy-dispatcher cache, retiring-dispatcher set, and per-egress rate-limit chains/timestamps.

### 1.1 Request context (credentials cross here)

`OnlyFansRequestContext` (`packages/onlyfans/src/types.ts:3-12`):
```
auth:            OnlyMonsterTokenBundle           // { token: string }
proxy?:          ProxyConfig | null
egressKey?:      string | null
requestObserver?: HttpRequestObserver | null
rateLimitWaiter?: (scopes) => Promise<number> | null
```

`FanslyRequestContext` (`packages/fansly/src/types.ts:3-12`) is identical except it carries `session: FanslySessionBundle` instead of `auth`. `FanslySessionBundle` = `{ authorization, fanslyClientId?, fanslyClientCheck?, fanslySessionId? }` (`packages/shared/src/types.ts:124-129`); `OnlyMonsterTokenBundle` = `{ token }` (`:131-133`). These bundles are the decrypted platform secrets — see §7.

### 1.2 Shared transport behavior (both adapters, `request()` private method)

- **Method:** every method is HTTP **GET**. Neither adapter ever mutates upstream state.
- **Transport:** `undici.fetch` with a per-request `dispatcher` chosen by `getDispatcher(proxy)` — the shared direct `Agent` when no proxy, else a cached `ProxyAgent`/SOCKS agent from `createProxyRequestDispatcher(proxy)` (`packages/shared/src/http-client.ts:124`, territory 15).
- **Timeout:** `AbortSignal.timeout(30_000)` (`REQUEST_TIMEOUT_MS`, both `adapter.ts`).
- **Observer wrapper:** all requests go through `executeObservedRequest(...)` from `@agency_hub_core/shared` (territory 15), which emits `started`/`success`/`retry`/`failed` telemetry events to `context.requestObserver` with `{operation, endpointTemplate, method, pagination, requestMetadata, httpStatus, responseMetadata}`. `requestMetadata`/`responseMetadata` are deliberately non-PII summaries (counts, cursor-present booleans, ISO date bounds) built by each method's `requestShape`/`summarizeResponse` closures.
- **Retry policy:** default `retries = 3`. Retries on HTTP `429, 500, 502, 503, 504` while retries remain, using `resolveRetryDelayMs(retry-after-header, attempt)`. Transport errors classified by `classifyTransportError`; a `"transport"` classification triggers `resetDispatcher(proxy)` (rebuilds and retires the undici agent) and retries with a jittered `5000 * attempt * (0.5..1.0)` ms backoff.
- **Auth failure:** HTTP `401`/`403` is a **hard non-retryable failure** raising `OnlyMonsterApiError`/`FanslyApiError` with `status` and a redacted 400-char body snippet (`redactSensitiveText`).
- **Rate limiting:** before each request, `waitForRateLimit(context, category, minDelayMs)`. If `context.rateLimitWaiter` is set, it delegates to the DB-backed shared limiter (territory 06, `sync/rate-limiter.ts`) with provider/scope tuples; otherwise it enforces an **in-process** minimum-spacing gate keyed on `egressKey` (per-category and global chains). OnlyMonster global default spacing = `onlyFansDefaultDelayMs` (1000 ms). Fansly global default = `globalDelayMs` (2500 ms) **+ 100 ms safety margin** (`GLOBAL_DELAY_SAFETY_MARGIN_MS`, `packages/fansly/src/adapter.ts:58,725-728`).

### 1.3 Rate-limit scopes emitted to the shared waiter

- **OnlyMonster** always emits a single scope `{ provider: "onlyfans", scope: "global" }` (`packages/onlyfans/src/adapter.ts:560-564`).
- **Fansly** emits `{ provider: "fansly", scope: "global" }` plus conditionally `followers_page` (when `category === "followers"` and `minDelayMs > 0`), `dm_conversations`, and `dm_messages` (`packages/fansly/src/adapter.ts:690-701`).

---

## 2. OnlyMonster adapter — endpoint & data catalog

**Host:** `https://omapi.onlymonster.ai`. **Auth header:** `x-om-auth-token: <OnlyMonsterTokenBundle.token>` (`packages/onlyfans/src/adapter.ts:400-404`). **Accept:** `application/json`. Response bodies are parsed as raw JSON (no envelope); a non-JSON body on a 2xx is a `provider` failure (`:489-501`).

| Method | Path (GET) | Query params sent | Returns (`parsed`) |
| --- | --- | --- | --- |
| `listAccountsPage` | `/api/v0/accounts` | `cursor`, `limit` | `{ accounts: OnlyMonsterAccount[], nextCursor? }` |
| `getAccount` | `/api/v0/accounts/:accountId` | — | `{ account: OnlyMonsterAccount }` |
| `getTransactionsPage` | `/api/v0/platforms/onlyfans/accounts/:platformAccountId/transactions` | `start`,`end` (ISO), `cursor`, `limit` | `{ items: OnlyMonsterTransaction[], cursor? }` |
| `getChargebacksPage` | `/api/v0/platforms/onlyfans/accounts/:platformAccountId/chargebacks` | `start`,`end` (ISO), `cursor`, `limit` | `{ items: OnlyMonsterChargeback[], cursor? }` |
| `getTrackingLinkUsersPage` | `/api/v0/platforms/onlyfans/accounts/:platformAccountId/tracking-link-users` | `collected_from`,`collected_to` (ISO), `cursor`, `limit`, `link_id` | `{ items: OnlyMonsterLinkUser[], cursor? }` |
| `getTrialLinkUsersPage` | `.../trial-link-users` | same as tracking | `{ items: OnlyMonsterLinkUser[], cursor? }` |
| `getRecentChatFanIds` | `/api/v0/accounts/:accountId/fans` | `limit` (default shape 10000) | `{ fan_ids: string[] }` |
| `getChatMessagesPage` | `/api/v0/accounts/:accountId/chats/:chatId/messages` | `limit`, `message_id`, `order` (`asc`/`desc`) | `{ items: OnlyMonsterChatMessage[], has_more? }` |

Response DTO fields (`packages/onlyfans/src/types.ts`): `OnlyMonsterAccount` carries `id` (numeric OnlyMonster id), `platform_account_id` (the OnlyFans user id, string), `platform: "onlyfans"`, `name`, `email|null`, `avatar`, `username`, `organisation_id`, `subscribe_price|null` (dollars), `subscription_expiration_date|null`. `OnlyMonsterTransaction`/`OnlyMonsterChargeback` carry `amount` (dollars), `fan.id`, `type`, `status`, and timestamps. `OnlyMonsterChatMessage` carries `text`, `from_user`, `is_sent_by_me`, `price`, media descriptors, etc.

**Mappers** (`packages/onlyfans/src/mappers.ts`, version `onlymonster-phase3-v1`) translate the string `type` to an internal `TransactionType` (`Tip from`→`tip`, `Payment for message`→`message_purchase`, `Subscription`/`Recurring subscription`→`subscription`, `Post purchase`→`post_purchase`, `Live stream`→`stream_tip`, else `other`) and the string `status` to a `TransactionState` (`loading`/`done`/`undo`→`posted`, `pending return`→`pending`, else `unknown`).

Consumed by the sync executor (territory 06): `getTransactionsPage`/`getChargebacksPage` in `sync/onlyfans-transactions.ts`, `getTrackingLinkUsersPage`/`getTrialLinkUsersPage` in `sync/onlyfans-identities.ts`, `getRecentChatFanIds`/`getChatMessagesPage` in `sync/executor-handlers.ts`, `getAccount` in `sync/shared.ts` (light metadata refresh).

---

## 3. Fansly adapter — endpoint & data catalog

**Host:** `https://apiv3.fansly.com/api/v1`. Every request appends `ngsw-bypass=true` to the query string (`packages/fansly/src/adapter.ts:459`). **Response envelope:** Fansly wraps payloads in `{ success, response, error{ code?, message?, details? } }`; the adapter treats `success !== true || response === undefined` on a 2xx as a `provider` failure (`:576-590`).

### 3.1 Auth / headers (`buildHeaders`, `packages/fansly/src/adapter.ts:613-634`)

Emulates a real Fansly browser session:
- `authorization: <session.authorization>` — the browser session token (required).
- `fansly-client-ts: <Date.now()>` — millisecond timestamp, regenerated per request.
- `fansly-client-id`, `fansly-client-check`, `fansly-session-id` — added only when present on the session bundle.
- `accept: application/json, text/plain, */*`, `referrer: https://fansly.com/`.

### 3.2 Endpoints

| Method | Path (GET) | Query params | Returns (post-envelope) |
| --- | --- | --- | --- |
| `getAccountMe` / `verifySession` | `/account/me` | — | `{ account: { id, username, displayName, createdAt, followCount, subscriberCount, earningsWallet?, walls?, subscriptionTiers? } }` |
| `getAccountsByIdsPage` | `/account` | `ids` (comma-joined, max 100 — throws above) | `FanslyAccount[]` |
| `getTransactionsPage` | `/account/wallets/earnings/transactions` | `after`,`before` (**ms-epoch**), `limit`, `offset` | `{ total, items: FanslyEarningsTransaction[], offset, done }` |
| `getEarningsAccountsPage` | `/account/wallets/earnings/accounts` | `after`,`before` (ms-epoch) | `{ items: FanslyEarningsAccount[], after, before, done }` (page size cap 100) |
| `getSubscribersPage` | `/subscribers` | `offset`,`limit`,`after`,`before`, `status` (default `"3,4"` = active) | `{ total(=stats.totalActive), items: FanslySubscriber[], offset, done }` |
| `getFollowersPage` | `/account/:accountId/followersnew` | `offset`,`limit`,`after`,`before`,`lastSeenAfter` | `{ items: FanslyFollower[], accounts: FanslyAccount[], offset, done }` |
| `getMessagingGroupsPage` | `/messaging/groups` | `offset`,`limit`,`sortOrder`,`flags`,`search`,`subscriptionTierId`,`listIds` | `{ total, items: FanslyMessagingGroup[], accounts, groups, offset, done }` |
| `getGroupDetail` | `/group/:groupId` | — | `FanslyGroupDetail` |
| `getMessagesPage` | `/message` | `groupId`,`limit`(default 25),`before` | `{ items: FanslyMessage[], groupId, before, done }` |

Fansly time bounds are **milliseconds since epoch** (`params.after.getTime()`), unlike OnlyMonster's ISO strings. `FanslyEarningsTransaction` carries numeric `type`, `status`, `amount` (Fansly's own integer money unit), `senderId`, `receiverId`, `createdAt` (ms), `correlationAccountId`, etc. (`packages/fansly/src/types.ts:56-74`). `FanslyAccount` carries `id`, `username|null`, `displayName|null`, `statusId?`, `lastSeenAt?` (ms), `streaming.channel.chatRoomId?`, and `notes?` (`:14-27`).

**Mappers** (`packages/fansly/src/mappers.ts`, version `fansly-phase1-v5`) key off numeric transaction-type codes (e.g. `15000/15001/6515`→`subscription`, `7001/7101/20001`→`tip`, `2010/2016/2110/2116`→`message_purchase`, `32001/32101`→`post_purchase`, `45001/45101`→`stream_tip`, `16013`→`payout_reversal`). Numeric status: `1`→`pending`, `2`→`posted`, else `unknown`. Subscription status: `3|4`→`active`, `1|2|10`→`pending`, `5`→`expired`, `6`→`error`.

Consumed by sync (territory 06): `getTransactionsPage` in `sync/transactions.ts`, `getAccountsByIdsPage` in `fansly-page-alias-backfill.ts` and fan hydration, followers/messaging in `sync/executor-handlers.ts`, `verifySession` in onboarding/credential/proxy flows (§7-8).

---

## 4. OnlyFans.com public-profile resolver (`onlyfans-public-profiles.ts`)

The only direct hit against `onlyfans.com` in this territory. `PlaywrightOnlyFansPublicProfileResolver` (`:125`) lazily `import("playwright")` (`loadPlaywrightChromium`, `:115-123`) and launches headless Chromium (`--disable-quic`, extensions/sync disabled, `:253-266`), optionally through a proxy translated by `buildPlaywrightProxy` (`:102-113`).

**Resolution flow (`resolve`, `:137-225`):**
1. Spacing gate — waits `input.delayMs` since the previous resolve start (`waitForSpacing`, `:234-243`).
2. New browser context with a spoofed desktop Chrome UA (`ONLYFANS_PUBLIC_PROFILE_USER_AGENT`, `:11-12`), **empty storage state (no cookies/session)**, `serviceWorkers: "block"`, `en-US`/`UTC`.
3. Route interception aborts `image`/`media`/`font` requests (`:177-185`).
4. `page.goto("https://onlyfans.com/u<platformUserId>", { waitUntil: "domcontentloaded", timeout: 25000 })` and waits for the XHR whose URL contains `/api2/v2/users/u<platformUserId>` (`:188-199`).
5. Parses that JSON response: requires `id === platformUserId`, then returns `{ username (handle, `@` stripped), displayName (=`name`) }` (`parseProfilePayload`, `:69-96`).

**Outputs:** a discriminated result — `resolved` with `{platformUserId, username, displayName}`, or a non-resolved status (`not_found` for HTTP 404, `rate_limited` for 429, `unavailable` for 401/403, `failed` otherwise; `classifyHttpStatus`, `:56-67`). Data crossing the boundary is a **public OnlyFans user id in / public display name+handle out**; no credentials are sent.

**Callers/config (territory 06):** `sync/onlyfans-identities.ts:396` constructs the resolver via `createOnlyFansPublicProfileResolver({ proxy, delayMs })`. Governed by feature flags in `config-registry.ts:130-134`: `onlyFansPublicProfileResolutionEnabled` (default off, STAGED), `onlyFansPublicProfileAllowDirect` (permit no-proxy), `onlyFansPublicProfileProxy` (proxy string w/ embedded creds), `onlyFansPublicProfileMaxPerRun` (default 5), `onlyFansPublicProfileDelayMs` (default 30000). `getOnlyFansPublicProfileEgressKey(proxy)` (`:276-278`) returns `buildProxyEgressKey(proxy)` or `"direct"`.

---

## 5. OnlyMonster service helpers (`onlyfans.ts`)

Pure/derivation helpers around OnlyMonster account records — no network of its own except through the injected adapter:

- **`findOnlyFansAccountByUsername(adapter, context, username)` (`:184-228`)** — paginates `listAccountsPage` (limit 100) matching a normalized handle. Guards against runaway pagination: repeated cursor → throw; hard cap `ONLYFANS_ACCOUNT_LOOKUP_MAX_PAGES = 50` (`:24`). `normalizeOnlyFansUsername` (`:230-254`) accepts raw handles or `onlyfans.com/<user>` URLs and lowercases/strips a leading `@`. Used by onboarding, credential update, and `/admin/credentials/verify` to resolve/verify the numeric account id.
- **`buildOnlyFansMetadata(account, existing?)` (`:139-156`)** — the page-metadata blob written on onboard/refresh: `{ provider: "onlymonster", onlyMonsterAccountId, platform, avatarUrl, email, organisationId, subscribePriceMills, subscriptionExpirationDate }`. Preserves internal keys `accountCreatedAt`/`transactionBackfillLowerBound`. `subscribePriceMills` converts dollars→mills via `millsToNumber(dollarsToMills(...))`.
- **`normalizeOnlyFansAvatarUrl(value)` (`:56-84`)** — accepts only `https://onlyfans.com`/`*.onlyfans.com` URLs and **rejects signed/CDN URLs** carrying `expires`/`key-pair-id`/`policy`/`signature` query keys (avoids persisting expiring CloudFront-style links).
- **`resolveOnlyFansDisplayName(account, existingPage?)` (`:116-137`)** — prefers a non-generic display name (one that differs from the username) over a handle-echo, falling back to existing page data then the username.
- **`getOnlyMonsterAccountId(metadata)` (`:169-182`)** — reads the numeric `onlyMonsterAccountId` from stored metadata (throws if absent); used by `page-proxies.ts` to re-verify a proxy via `getAccount`.

---

## 6. Fansly service helpers (`fansly.ts`, `fansly-presence.ts`, `fansly-page.ts`)

- **`fansly.ts`** — `buildFanslyMetadata(account, existing?)` (`:18-34`) stores `{ accountCreatedAt(ISO), walls, subscriptionTiers }`; `resolveFanslyPlatformAccountId(page)` (`:40-53`) reads `page.platformAccountId` (or `metadata.platformAccountId`), throwing if missing.
- **`fansly-presence.ts`** — converts follower/account `lastSeenAt` (ms) into presence signals. `classifyFanslyPresenceBucket` (`:29-40`): age `< 30 min` → `active_now`, `< 120 min` → `recently_active`, else dropped. `buildFanslyFollowerPresenceSignals` (`:42-80`) dedupes per `followerId` keeping the newest `lastSeenAt`, tagging `source = FANSLY_EXTERNAL_PRESENCE_SOURCE_FOLLOWERS_LAST_SEEN`. Consumed by `sync/executor-handlers.ts:1950,2250` and `workboard-presence.ts:98` (territory 06/other).
- **`fansly-page.ts`** — despite the name, this is an **API access-control helper, not an adapter**. `resolveAccessibleFanslyPage` (`:7-25`) loads a page summary, enforces `canAccessPage` and `platform === "fansly"` (else `BadRequestError`). `resolveAccessibleDmPage` (`:33-51`) permits both `fansly` **and** `onlyfans` for DM-backed features (comment cites decision #49 — OFAPI feeds OnlyFans DMs). No outbound network.

---

## 7. Credential & proxy assembly (`page-context.ts`)

This is where a stored page is turned into a live request context — the **decryption boundary**.

- **`resolvePageContext(app, label)` / `resolvePageContextById(app, id)` (`:185-193`)** load the page + credentials + proxy via `findPageByLabel`/`findPageById` (DB, territory 05) and hand off to `resolveStoredPageContext` (`:195-286`).
- **Credential decryption:** `stored.credentials.encryptedSession` (a JSON string of an AES-GCM envelope) is decrypted with `decryptJsonWithKeyVersion(payload, app.config.encryptionKeysByVersion)` (`crypto.ts`, territory 15). The result is either a tagged `StoredPlatformCredentialBundle` (`{platform:"fansly", session}` / `{platform:"onlyfans", auth}`) or a legacy untagged object normalized by `normalizeSessionBundle`/`normalizeOnlyMonsterTokenBundle`. Cross-platform mismatch (OnlyFans creds on a Fansly page or vice-versa) throws `BadRequestError`.
- **Legacy field aliasing** (`:43-68`): a Fansly session accepts `authorization|token`, `fanslyClientId|fansly-client-id`, etc.; an OnlyMonster token accepts `token|authToken|x-om-auth-token`.
- **Proxy decryption:** `resolveStoredProxyConfig(app, stored.proxy)` (`:152-173`) decrypts the proxy's `encryptedAuth` (username/password) and normalizes into a `ProxyConfig`. `resolveStoredProxyEgressKey` (`:175-183`) returns the stored `rateLimitScopeKey` or a derived `buildProxyEgressKey`.
- **Output:** a discriminated `ResolvedPageContext` — `{ page, platform:"fansly", session, proxy, egressKey }` or `{ page, platform:"onlyfans", auth, proxy, egressKey }` (`:288-291`).

**Encryption side (writes):** `saveEncryptedCredentials` (`:98-113`) and `saveProxy` (`:115-143`) use `encryptJson(payload, app.config.encryptionKey, app.config.encryptionKeyVersion)` and persist via `storePlatformCredentials`/`storeProxyConfig` (DB). Proxy auth is encrypted separately only when a username/password is present; the proxy URL itself is stored in plaintext. `page-context.ts` also exposes file loaders `loadFanslySessionBundleFromFile` / `loadOnlyMonsterTokenBundleFromFile` (`:86-96`) used by the CLI onboarding path.

---

## 8. Connections, onboarding, proxy management (inbound triggers of outbound calls)

### 8.1 `connections.ts`

- **`listConnectionStatuses(app, input?)` (`:147-203`)** — read-only status projection over `listVisiblePages` + `getLatestSyncRunPerPage` (light stream). Classifies each page (`classifyConnectionStatus`, `:100-135`) into `unverified` (no creds) / `never_synced` / `expired` (last light run failed **and** error text matches an auth signal — `401/403/unauthorized/forbidden/invalid token/expired/authentication`, `:84-98`) / `error` / `stale` (>9h since light sync, `STALE_THRESHOLD_HOURS`) / `active`. Emits per-page `proxyUrl`, `proxyHasAuth`, counts, and sync-UX summary. No outbound platform call.
- **`updatePageCredentials(app, pageLabel, body)` (`:205-348`)** — the credential-rotation path. Reconciles proxy input (can reuse stored proxy auth when only the route matches, `:222-241`), builds a rate-limit waiter, then **verifies the submitted (or stored) credentials against the live platform**: Fansly via `app.adapter.verifySession(...)` → asserts `verification.parsed.account.id` matches the page's bound `platformAccountId` (`assertVerifiedAccountIdentity`, `:45-58`, `ConflictError` on mismatch); OnlyFans via `findOnlyFansAccountByUsername(...)` → asserts `account.platform_account_id`. On success, re-encrypts and stores credentials, saves/removes the proxy, and clears any verification incident (`handleSuccessfulPageVerificationRecovery`). **Inbound endpoint:** `PATCH /api/v1/admin/pages/:pageLabel/credentials` (`api/server.ts:2888-2895`, owner-only).

### 8.2 `page-onboarding.ts`

- **`onboardFanslyPage(app, {modelSlug,label,session,proxy?})` (`:91-157`)** — resolves the model, validates the proxy (`assertAllowedProxyTarget`), **verifies the session** via `app.adapter.verifySession(...)`, then in a single DB transaction creates the page (`createFanslyPage`), stores encrypted credentials + proxy, and writes metadata from the verified account (`platformAccountIdValue`, `username`, `displayName`, `followerCount`, `subscriberCount`, `earningsBalanceMills = toMills(earningsWallet.balance)`, `metadata = buildFanslyMetadata`). Identity-collision DB errors are remapped to `ConflictError`.
- **`onboardOnlyFansPage(app, {modelSlug,label,auth,username,proxy?})` (`:159-238`)** — same flow but resolves the account via `findOnlyFansAccountByUsername` then `getAccount` (OnlyMonster), and writes `followerCount/subscriberCount = null`, `earningsBalanceMills = 0n`, `metadata = buildOnlyFansMetadata`.
- **Inbound endpoint:** `POST /api/v1/admin/pages` (`api/server.ts:2684-2720`, owner-only) branches on `body.platform`; also invoked from `cli.ts:661/693`. After onboard the handler calls `queueInitialOnboardingSync` (territory 06). A related read-only verify path `POST /api/v1/admin/credentials/verify` (`server.ts:2752-2805`) runs `verifySession`/`findOnlyFansAccountByUsername` **without** persisting.

### 8.3 `page-proxies.ts`

- **`setPageProxy(app, pageLabel, proxy)` (`:15-58`)** — normalizes + SSRF-validates the proxy, resolves the page context, **re-verifies the page through the new proxy** (Fansly `verifySession` / OnlyMonster `getAccount(getOnlyMonsterAccountId(metadata))`), then `saveProxy`. Preserves the existing `rateLimitScopeKey` when the egress route is unchanged.
- **`removePageProxy(app, pageLabel)` (`:60-70`)** — deletes the stored proxy row.
- Both are **CLI-only** in the current wiring (`cli.ts:760/773`); no dedicated API route sets/removes a proxy independently — the API mutates proxies through `updatePageCredentials`. A separate `POST /api/v1/admin/proxy/test` (`server.ts:2807-2845`) validates a proxy by fetching `https://api.ipify.org?format=json` through it and returning the observed egress IP.

---

## 9. Backfills (`onlyfans-page-metadata-backfill.ts`, `fansly-page-alias-backfill.ts`)

- **`backfillOnlyFansPageMetadata(app, {pageLabels?})` (`onlyfans-page-metadata-backfill.ts:104-194`)** — per page: if the page has stored credentials, resolve the page context and call `refreshPageMetadata(app, pageContext, "light")` (territory 06 → OnlyMonster `getAccount`). **If credentials fail or are absent but an `ofapiAccountId` exists, it falls back to OFAPI:** `app.ofapi.listAccounts()` (territory 06) returns `OfapiAccountRecord[]` (`{id, username, displayName, onlyfansName, onlyfansUserId, avatarUrl}`), matched by `ofapiAccountId`, then `updateOnlyFansPageIdentityFromOfapi(app.db, page.id, {ofapiAccountId, username, displayName, metadata:{...,avatarUrl}})` writes identity. Requires `OFAPI_API_KEY` (else `app.ofapi` is undefined → throws). CLI: `cli.ts:858`.
- **`backfillFanslyPageAliases(app, {pageLabels?, chunkSize?})` (`fansly-page-alias-backfill.ts:22-131`)** — for target Fansly pages (from `listFanslyFanPageIdentityBackfillTargets`), chunks unique fan ids (≤100) and calls `app.adapter.getAccountsByIdsPage(requestContext, chunk)` (Fansly `/account`), then `upsertHydratedFansForPageDetailed` (territory 06/DB) to set/clear fan usernames, display-name aliases, and Fansly notes. Fans missing from the response become `fallbackIds`. Returns per-page and aggregate counters. CLI: `cli.ts:897`.

---

## 10. Proxy validation & egress (`proxy-validation.ts`, shared)

`assertAllowedProxyTarget(proxy)` (`proxy-validation.ts:16-41`) is the **SSRF guard** on every proxy that is saved or used for onboarding/verification. It (1) calls `assertProxyTargetAllowed(proxy)` (shared) which rejects non-`http:`/`https:`/`socks5:` protocols and any hostname that is loopback/private/link-local/multicast/localhost, then (2) DNS-resolves the hostname (`dns.lookup(all, verbatim)`) and rejects if **any** resolved address is disallowed (`isDisallowedProxyHostname`). DNS failures are swallowed (best-effort for hostnames, strict for IP literals). Errors are remapped to `BadRequestError`.

Egress identity is `buildProxyEgressKey(proxy)` = `"direct"` when no proxy, else `${protocol}//${hostname}:${port}` (`packages/shared/src/proxy.ts:329-336`) — this is the rate-limit/dispatcher-cache key that ties all outbound calls sharing an egress together. Dispatcher construction (direct `Agent`, `ProxyAgent`, or SOCKS via `socks`) lives in `packages/shared/src/http-client.ts` (territory 15).

---

## 11. Boundary summary (what crosses, which direction, counterpart)

| # | Direction | Counterpart | Data & shape |
| --- | --- | --- | --- |
| 1 | Outbound HTTP GET | **OnlyMonster** `omapi.onlymonster.ai` | Header `x-om-auth-token` (page's OnlyMonster token). Pulls accounts, transactions, chargebacks, tracking/trial link users, chat fan ids, chat messages (raw JSON). Money in dollars. Via optional per-page proxy. |
| 2 | Outbound HTTP GET | **Fansly** `apiv3.fansly.com/api/v1` | Headers `authorization`, `fansly-client-ts`, `fansly-client-id/-check/-session-id` (page's browser session). Pulls account/me, account lookup, earnings transactions/accounts, subscribers, followers, messaging groups, group detail, messages (`{success,response,error}` envelope). Money in Fansly integer units; time bounds ms-epoch. Via optional per-page proxy. |
| 3 | Outbound (headless browser) | **OnlyFans.com** `onlyfans.com` | Anonymous page load of `/u<id>`; reads XHR `/api2/v2/users/u<id>` JSON → `{id, username, name}`. No credentials sent. Optional proxy. |
| 4 | Outbound HTTP (fallback) | **OFAPI** (territory 06) | `app.ofapi.listAccounts()` → `OfapiAccountRecord[]` used only in metadata backfill. Requires `OFAPI_API_KEY`. |
| 5 | Outbound HTTP GET | `api.ipify.org` | Proxy-test endpoint fetches egress IP through a candidate proxy. |
| 6 | DB read | Postgres (territory 05) | `findPageByLabel/ById`, `listVisiblePages`, `getLatestSyncRunPerPage`, `listFanslyFanPageIdentityBackfillTargets` — page rows, encrypted credential/proxy blobs, sync-run status. |
| 7 | DB write | Postgres (territory 05) | `storePlatformCredentials`, `storeProxyConfig`/`deleteProxyConfig`, `createFanslyPage`/`createOnlyFansPage`, `updatePageMetadata`, `updateOnlyFansPageIdentityFromOfapi`, `upsertHydratedFansForPageDetailed`. Encrypted secrets in, identity/metadata in. |
| 8 | Secret decrypt/encrypt | AES-GCM key material (`app.config.encryptionKey`, `encryptionKeysByVersion`; territory 15/config) | Platform session tokens and proxy auth cross plaintext only in-memory inside request contexts. |
| 9 | Telemetry (out of territory) | `HttpRequestObserver` (territory 06) | Per-request `started/success/retry/failed` events with non-PII operation/pagination/status summaries. |
| 10 | Rate-limit reservation | Postgres shared limiter (territory 06) | When `rateLimitWaiter` is set, provider/scope/egressKey tuples reserve a scheduled slot; otherwise in-process spacing only. |
| 11 | Inbound HTTP (owner-only) | Dashboard/CLI (territories 01/api) | `POST /api/v1/admin/pages` (onboard), `PATCH .../pages/:label/credentials` (rotate), `POST /admin/credentials/verify`, `POST /admin/proxy/test`, `POST .../pages/:label/verify` — each triggers a live platform verification described above. |

---

## 12. Notable name/behavior discrepancies

- **`packages/onlyfans` / `OnlyFansAdapter` / `app.onlyFansAdapter` do NOT contact OnlyFans.** They contact the third-party **OnlyMonster** aggregator (`omapi.onlymonster.ai`) with an `x-om-auth-token`. The only direct OnlyFans.com contact is the Playwright public-profile resolver (§4).
- **`app.adapter` is the Fansly adapter; `app.onlyFansAdapter` is the OnlyMonster/OnlyFans adapter** — the unqualified field is Fansly.
- **`fansly-page.ts` is not a platform adapter** — it is an API authorization/platform-gating helper (§6), and `resolveAccessibleDmPage` intentionally also admits OnlyFans pages.
- **`FanslyAdapter.getEarningsAccountsPage` "top_spenders" category:** the earnings-accounts endpoint is rate-limited under the `top_spenders` category (`packages/fansly/src/adapter.ts:183`) though it emits no dedicated shared-limiter scope (only `global`).
- **Fansly `verifySession` is just `getAccountMe`** (`packages/fansly/src/adapter.ts:435-437`) — there is no separate verification endpoint; identity is confirmed by `account.id` equality at the call sites.
- **Two OnlyFans ingestion channels coexist** (OnlyMonster for sync-pulled transactions/messages; OFAPI for webhooks + metadata-backfill fallback), so an OnlyFans page's identity may be sourced from either upstream depending on whether it has stored OnlyMonster credentials or an `ofapiAccountId`.
