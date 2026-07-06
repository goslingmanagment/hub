> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 15 — Shared Package (`@agency_hub_core/shared`)

**Scope.** This document covers every source file in `packages/shared/src/`: the public-surface barrels (`index.ts`, `browser.ts`); money math (`money.ts`); credential/secret cryptography (`crypto.ts`); the outbound HTTP layer (`http-client.ts`, `http-request.ts`) and its proxy plumbing (`proxy.ts`, `proxy-string.ts`); ID/date decoding (`snowflake.ts`); business-date/timezone helpers (`time.ts`); message text normalization (`dm-text.ts`); fan-labeling and DM-metadata helpers (`fans.ts`); spender analytics primitives (`spender-buckets.ts`, `spender-retention.ts`); the transaction/enum type catalog (`types.ts`); and the pino logger (`logger.ts`). The three config modules (`config.ts`, `config-registry.ts`, `config-settings.ts`) physically live in this package but are documented in territory 13; this doc only notes their location and how the rest of the package touches them (encryption-key parsing, proxy validation). The package's `package.json` name is `@agency_hub_core/shared`; its runtime dependencies are `dotenv`, `pino`, `socks`, `undici`, `zod` (`packages/shared/package.json`).

---

## 0. Package shape and the two public surfaces

`package.json` declares a single export `"." → "./src/index.ts"` (`packages/shared/package.json:5-7`). There is **no** subpath export for `browser.ts`; the browser build is selected by build-tool aliasing, not by the package's own `exports` map.

Two barrels exist and they export **different subsets**:

| Barrel | Re-exports | Consumed by |
| --- | --- | --- |
| `index.ts` (full, server) | config, config-registry, config-settings, crypto, dm-text, fans, http-client, http-request, logger, money, proxy, proxy-string, snowflake, spender-buckets, spender-retention, time, types | `apps/runtime` (API/worker/CLI), `packages/db`, `packages/fansly`, `packages/onlyfans`, `packages/contracts` |
| `browser.ts` (browser-safe) | fans, dm-text, money, proxy-string, spender-retention, time, types | `apps/dashboard` (React SPA) |

The dashboard resolves the same package specifier `@agency_hub_core/shared` to `browser.ts`, not `index.ts`, via two aliases:
- Vite: `"@agency_hub_core/shared": resolve(__dirname, "../../packages/shared/src/browser.ts")` (`apps/dashboard/vite.config.ts:13`).
- TypeScript: `"@agency_hub_core/shared": ["../../packages/shared/src/browser.ts"]` (`apps/dashboard/tsconfig.json:12`).

**Browser-safe vs server-only (boundary of note).** The modules deliberately excluded from `browser.ts` are exactly the ones that import Node built-ins or Node-only libraries, plus a few server-only constants:
- `crypto.ts` (`node:crypto`), `logger.ts` (`pino`), `http-client.ts` (`undici`, `socks`, `node:util`), `http-request.ts` (`node:timers/promises`), `proxy.ts` (`node:crypto`), `config*.ts` (`dotenv`, `node` env) are all server-only.
- `snowflake.ts` (pure `BigInt`) and `spender-buckets.ts` (pure `bigint` constants) contain no Node imports but are still **not** in `browser.ts`; the dashboard has no path to `SPENDER_AUTO_LIST_BUCKETS` or `fanslyFollowIdToDate`. Verified: the only dashboard imports from the package are `formatUsdFromMills`, `parseBusinessDate` (`apps/dashboard/src/lib/format.ts:1`), `resolveFanLabelForScope`, `formatUsdFromMills` (`apps/dashboard/src/pages/SpenderAutoListPage.tsx:14`), and `formatProxyPreview`/`buildProxyConfig`/`getProxyStringError` (`apps/dashboard/src/components/shared/ProxyInput.tsx:2`) — all within the browser subset.
- `proxy.ts` is server-only (SSRF checks, crypto hashing), but `proxy-string.ts` (pure `URL` parsing) is browser-safe, so the dashboard's `ProxyInput` uses only the latter.

No SSE, DB, queue, Telegram, or AI logic lives in this package. All cross-boundary I/O here is indirect: this package supplies the **primitives** (dispatchers, crypto envelopes, retry math, redaction) that runtime services use to cross those boundaries.

---

## 1. `money.ts` — mills arithmetic

Money is represented in **mills**: `1 mill = $0.001`, so `$1 = 1000 mills`, `$500 = 500_000 mills`. `MoneyLike = bigint | number | string` (`money.ts:1`). `COMMISSION_RATE_SCALE = 10_000n` — commission rates are held as integers scaled to 4 decimals (`money.ts:2`).

| Function | Behavior | Rounding |
| --- | --- | --- |
| `toMills(value)` (`:4`) | Coerces to `bigint`. **A `number` is treated as already-in-mills** and truncated via `BigInt(Math.trunc(value))` — it is NOT dollars. A `string` goes through `BigInt(value)`. | truncate toward 0 |
| `millsToDecimalString(value)` (`:16`) | `"<sign><whole>.<3-digit remainder>"`, e.g. `1234 → "1.234"`, `-5 → "-0.005"`. | exact, 3 decimals |
| `formatUsdFromMills(value)` (`:26`) | `Intl.NumberFormat` USD string. Computes cents as `Number(mills / 10n) / 100` — the sub-cent mill digit is **dropped by BigInt truncation, not rounded** (`1239 mills → $1.23`). | truncate to cents |
| `millsToNumber(value)` (`:38`) | `Number(toMills(value))`; lossy above 2^53 mills. | — |
| `sumMills(iterable)` (`:42`) | BigInt sum. | exact |
| `dollarsToMills(value)` (`:50`) | **The dollar→mills converter.** A `number` is first `toFixed(3)` (rounds to 3 dp), a `string` is trimmed; then regex `^(-)?(\d+)(?:\.(\d+))?$` parses, fraction is `padEnd(3,"0").slice(0,3)` (extra digits **truncated**). Throws `Invalid dollar amount` on non-match. | number path rounds to 3dp; string path truncates |

**Commission math** (used to derive creator-net from gross platform revenue and vice-versa):
- `commissionRateToScaledInt(rate)` (`:67`, private): requires `rate ∈ [0,1]`, `toFixed(4)`, returns `whole*10000 + frac4` as bigint. Throws on out-of-range/NaN.
- `roundDiv(value, divisor)` (`:81`, private): integer division **rounded half away from zero** (`(abs + divisor/2) / divisor`, sign restored).
- `calculateNetMillsFromGross(grossMills, rate)` (`:91`): `feeCents = roundDiv(gross * rateScaled, 100_000)`; `net = gross - feeCents * 10`. The comment states "OnlyFans rounds the platform fee to whole cents before subtracting it," so the fee is quantized to whole cents (×10 back to mills) before subtraction. Rate `0` short-circuits to `gross`.
- `calculateGrossMillsFromNet(netMills, rate)` (`:106`): `roundDiv(net * 10000, 10000 - rateScaled)` — inverse without the cent-quantization step. Throws if creator share `≤ 0`.

There are **174** call sites of money helpers across `apps`/`packages` (excluding this file and tests). The dashboard consumes only `formatUsdFromMills` (via `MoneyCell.tsx`, `SpenderAutoListPage.tsx`, `lib/format.ts`).

---

## 2. `crypto.ts` — secrets-at-rest envelope

Algorithm and shape:
- **AES-256-GCM**, 12-byte random IV (`randomBytes(12)`), GCM auth tag captured via `cipher.getAuthTag()` (`crypto.ts:18-23`).
- Output `EncryptedEnvelope` (`crypto.ts:3-9`): `{ alg: "aes-256-gcm"; keyVersion: number; iv: base64; tag: base64; ciphertext: base64 }`. Plaintext is `JSON.stringify(value)` (`:20`), so any JSON-serializable `T` round-trips.

| Function | Direction | Notes |
| --- | --- | --- |
| `encryptJson<T>(value, key: Buffer, keyVersion)` (`:13`) | plaintext → envelope | Always stamps the caller-supplied write-key version. |
| `decryptJson<T>(payload, key)` (`:55`) | envelope → plaintext | Accepts an envelope object or a JSON string (`parseEncryptedEnvelope`, `:33`). |
| `decryptJsonWithKeyVersion<T>(payload, keysByVersion)` (`:59`) | envelope → plaintext | Looks up the key by `envelope.keyVersion` in a `ReadonlyMap<number, Buffer>`; throws `No encryption key configured for version N` if absent. This is the **key-rotation** read path. |
| `sha256Hex(value)` (`:72`) | string → hex digest | Used for token digests. |
| `randomToken(bytes = 32)` (`:76`) | → base64url token | CSPRNG token generation. |

**Key source (secrets/credentials boundary).** Keys are Buffers derived from environment in `config.ts` (territory 13) and reach crypto via `app.config`:
- `APP_ENCRYPTION_KEY` → `config.encryptionKey` (base64, must decode to exactly 32 bytes — `config.ts:456-462`). This is the current **write** key.
- `APP_ENCRYPTION_KEY_VERSION` → `config.encryptionKeyVersion` (positive int, default 1).
- `APP_ENCRYPTION_KEY_RING` → `config.encryptionKeysByVersion` (`ReadonlyMap<number,Buffer>`), parsed from comma-separated `version:base64` entries; each key must be 32 bytes; the write key/version is always inserted and must not conflict with a same-version ring entry (`config.ts:465-509`). Registry: these three are `editability: NEVER`, `runtimeApply: none` (`config-registry.ts:101-103`).

**What is encrypted with this envelope (data crossing into Postgres, encrypted):**
- **Platform login credentials** — `StoredPlatformCredentialBundle` (Fansly `FanslySessionBundle` or OnlyFans `OnlyMonsterTokenBundle`, see §11) — written by `connections.ts:317` and `page-context.ts:103/126`, read by `connections.ts:68` and `page-context.ts:28` (`decryptJsonWithKeyVersion`). Onboarding writes at `page-onboarding.ts:49`.
- **Telegram bot token** — encrypted at `apps/runtime/src/api/server.ts:3373` and `ofapi-webhooks.ts`, decrypted at `telegram.ts:246` — stored as `telegram_settings.encrypted_bot_token` (JSON string of an envelope).
- **OFAPI webhook signing secret** — a `randomToken(32)` generated at `ofapi-webhooks.ts:270`, then `encryptJson`'d and stored as `encryptedSigningSecret` (`ofapi-webhooks.ts:298-300`); decrypted at `ofapi-webhooks.ts:89`.

**Where `randomToken`/`sha256Hex` are used (auth boundary):** `auth.ts` mints API keys (`randomToken(24)`, digest stored via `sha256Hex`, `:391-394`) and session tokens (`randomToken(32)`, digest at `:630`); lookups hash the presented token and match the stored digest (`findAuthSessionByDigest`/`findApiKeyByDigest`, `:656/676/696`). Only digests are persisted; raw tokens are returned to the client once.

---

## 3. `http-client.ts` — outbound dispatcher factory + retry/error math

This module builds the undici `Dispatcher` objects every outbound platform/API/Telegram/AI call runs through, plus the retry-timing and error-classification helpers. It performs **no** requests itself.

**Dispatcher tuning** (`buildDispatcherOptions`, `:28`): `connections: 1`, `pipelining: 1`, `keepAliveTimeout: 10_000ms`, `keepAliveMaxTimeout: 60_000ms`, `keepAliveTimeoutThreshold: 250ms`. The 10s keep-alive is explicitly chosen so Fansly's ~5s-cadence follower syncs reuse the socket instead of reconnecting (comment `:32-34`). Connect timeout `CONNECT_TIMEOUT_MS = 10_000ms`.

| Factory | Returns | Transport |
| --- | --- | --- |
| `createRequestDispatcher()` (`:40`) | `new Agent(...)` | Direct (no proxy). |
| `createProxyRequestDispatcher(proxy)` (`:124`) | For `http:`/`https:` proxies: `new ProxyAgent({ uri, token, ...opts })` with a `Basic` auth token from `username:password` (`buildProxyAuthToken`, `:44`). For `socks5:`: a custom `Agent` whose `connect` opens a SOCKS5 tunnel via `SocksClient.createConnection` (type 5), applies keep-alive/no-delay, and for `https:` layers TLS through `buildConnector` (`createSocksProxyDispatcher`, `:55`). | HTTP CONNECT proxy or SOCKS5. |

The proxy config is normalized through `normalizeProxyConfigWithMetadata` (from `proxy.ts`) before use, giving hostname/port/hasAuth.

**Consumers of these dispatchers (outbound boundaries):**
- `packages/fansly/src/adapter.ts:66/647/655/662` — direct + per-proxy dispatchers for the **Fansly** private API.
- `packages/onlyfans/src/adapter.ts:50/517/525/532` — dispatchers for the **OnlyFans** adapter.
- `apps/runtime/src/services/ofapi-egress.ts:41`, `ofapi-transactions-backfill.ts:815` — **OFAPI** egress (per-page proxy required, `ofapi-egress.ts:34-41`).
- `apps/runtime/src/services/ai-gateway-anthropic-provider.ts:134` — the **Anthropic** AI provider is called through a proxy dispatcher built here.
- `apps/runtime/src/services/telegram.ts:159` — **Telegram Bot API** calls run through a proxy dispatcher.
- `apps/runtime/src/api/server.ts:2822` — proxy connectivity test endpoint.
- `apps/runtime/src/cli.ts:218-219` — CLI picks proxy vs direct dispatcher.

**Retry / error helpers (pure):**
- `classifyTransportError(error)` (`:137`) → `"timeout" | "transport"`, walking the `.cause` chain (`iterateErrorChain`, `:240`, cycle-guarded) and matching names in `TIMEOUT_ERROR_NAMES` (`AbortError`, `BodyTimeoutError`, `ConnectTimeoutError`, `HeadersTimeoutError`, `TimeoutError`).
- `parseRetryAfterDelayMs(header, now)` (`:153`) — parses numeric seconds or an HTTP-date `Retry-After`; clamps to `MAX_RETRY_DELAY_MS = 60_000`.
- `exponentialRetryDelayMs(attemptNumber)` (`:171`) — `5_000ms * 2^(attempt-1)`, jittered into the `[50%,100%]` band (`0.5 + random*0.5`) to de-synchronize concurrent failures.
- `resolveRetryDelayMs(header, attempt, now)` (`:178`) — prefers `Retry-After`, else exponential.
- `formatObservedError(error)` (`:147`) — flattens the cause chain into a single string with per-cause `code/errno/syscall/address/port` and socket details, then runs the whole thing through `redactSensitiveText` (from `proxy.ts`) so proxy/Telegram/credential URLs never reach logs.

---

## 4. `http-request.ts` — observed retry loop

`executeObservedRequest<TResponse, TResult>(input)` (`:43`) is a generic attempt/observe/retry driver used by the API adapters. It does not know about HTTP directly; callers inject `execute`, `onResponse`, and `onTransportError`.

- Loops `attempt = 0..retries` (default `retries = 3`, so up to 4 attempts, `:63`).
- Optional `waitForRateLimit()` is awaited each attempt; the wait duration is reported as `rateLimitWaitMs`.
- Emits an `HttpRequestEvent` (from `types.ts`, §11) to `observer.onRequestEvent(...)` at **`state: "started"`** before the call and a terminal event (`success`/`retry`/`failed`) after (`emitRequestEvent`, `:199`).
- On thrown transport error → `onTransportError` returns a `retry` (sleeps `retryDelayMs` via `node:timers/promises`, then continues) or `failed` (rethrows `outcome.error`).
- On response → `onResponse` returns `success` (returns `value`), `retry`, or `failed`.
- Falls through to `throw new Error("Observed request <op> exhausted retries")` if the loop ends without a terminal outcome (`:137`).

**Boundary (telemetry, outbound to DB via observer):** the event payload (`HttpRequestEvent`, `types.ts:170-217`) carries `requestId`, `operation`, `endpointTemplate` (a template like `/api/v2/...`, not the live URL), `method`, `attemptNumber`, `timestamp`, `pagination` (`offset/limit/pageIndex/cursorPresent`), `requestMetadata`, `rateLimitWaitMs`, and terminal fields `httpStatus`, `durationMs`, `failureKind` (`timeout|transport|http|provider`), `retryDelayMs`, `errorMessage`, `responseMetadata`. The concrete observer that persists these lives in the sync telemetry code (territory 08). Callers: `ofapi.ts:579`, `packages/fansly/src/adapter.ts:471`, `packages/onlyfans/src/adapter.ts:387`.

---

## 5. `proxy.ts` — proxy normalization, SSRF guard, secret redaction

Server-only. Combines proxy-URL canonicalization, an allow/deny check for proxy hostnames, dispatcher-cache/egress keying, and log redaction.

**Normalization** (`parseNormalizedProxyConfig`, `:65`; public `normalizeProxyConfig` `:302`, `normalizeProxyConfigWithMetadata` `:311`):
- Accepts only `http:`, `https:`, `socks5:` (`SUPPORTED_PROXY_PROTOCOLS`), else throws.
- Reconciles credentials from both the `ProxyConfig.username/password` fields **and** inline URL credentials; conflicting values throw `Proxy <field> conflicts with inline credentials in proxy URL` (`resolveCredentialField`, `:27`). Inline creds are URL-decoded.
- Strips credentials from the stored `url`, lowercases hostname, fills default ports (`http`80 / `https`443 / `socks5`1080). Returns `NormalizedProxyConfig` with `protocol`, `hostname`, `host`, `port`, `hasAuth`.

**SSRF guard** (`isDisallowedProxyHostname`, `:282`; `assertProxyTargetAllowed`, `:293`): rejects a proxy target that is `localhost`/`*.localhost`; any **ambiguous numeric host** (bare integers like `2130706433`, hex `0x7f000001`, short dotted `127.1`, or octal-looking leading-zero octets — `isAmbiguousNumericHost`, `:130`); private/loopback/link-local/CGNAT/benchmarking IPv4 (`isPrivateIpv4`, `:94` — covers `0.*`, `10.*`, `127.*`, `100.64-127.*`, `169.254.*`, `172.16-31.*`, `192.168.*`, `198.18-19.*`, `≥224.*`); and private/loopback/ULA/link-local/site-local/multicast IPv6 including IPv4-mapped/compatible embeddings (`isPrivateIpv6`, `:252`, with a hand-rolled IPv6 group parser `parseIpv6Groups`, `:168`). On violation throws `Proxy host must not be loopback, private, link-local, multicast, or localhost`. **Callers:** `config.ts:452` (validating the env-configured proxy) and `apps/runtime/src/services/proxy-validation.ts:18`.

**Keying helpers:**
- `buildProxyDispatcherCacheKey(proxy)` (`:315`) — `"<protocol>//<host>#<16-hex sha256 of url\0user\0pass>"`; keys the per-proxy dispatcher cache in the Fansly/OnlyFans adapters (`packages/*/src/adapter.ts:682/552`).
- `buildProxyEgressKey(proxy | null)` (`:329`) — `"direct"` when no proxy, else `"<protocol>//<hostname>:<port>"`; a stable egress identity ignoring credentials.
- `buildSyncPageExecuteGroupId(provider, egressKey)` (`:338`) — `"<fansly|onlyfans>:<egressKey>"`, used to serialize sync execution per egress.
- `formatMaskedProxyUrl(proxy)` (`:345`) — `"<protocol>//<host>[ (auth)]"` for display/logs.

**Redaction** (`redactSensitiveText`, `:402`): scans text for URL-shaped substrings and (a) masks Telegram bot tokens on `api.telegram.org` paths `/(file/)?bot<TOKEN>` → `bot[REDACTED]` (`redactTelegramBotTokenUrl`, `:370`); (b) masks credentials in proxy URLs (`http/https/socks5`) and in any other URL with embedded `user:pass` (`formatMaskedCredentialUrl`, `:385`). This is the redactor wired into both `logger.ts` and `http-client.ts`'s error formatter.

---

## 6. `proxy-string.ts` — raw proxy string parsing (browser-safe)

Pure `URL`-based parser, no Node built-ins; the module the dashboard uses.

- `parseProxyString(raw)` (`:19`) → `ProxyConfig | null`. Empty/whitespace → `null`. If the string lacks a `scheme://`, `socks5://` is prepended (`DEFAULT_PROTOCOL`), so bare `user:pass@host:port` and `host:port` default to SOCKS5. Only `http/https/socks5` accepted (else throws `Unsupported proxy protocol ...`). Extracts and URL-decodes inline credentials, then returns a credential-stripped `url` plus `username`/`password` (or `null`).
- `formatProxyPreview(raw)` (`:67`) → `"<protocol>//<host>[ (auth)]"` or `null` on empty/invalid (swallows errors).
- `getProxyStringError(raw)` (`:82`) → `null` when valid/empty; returns the protocol-error message for unsupported protocols, else `"Invalid proxy URL"`.
- `buildProxyConfig(raw)` (`:103`) → `ProxyConfig | undefined`; convenience wrapper that swallows errors, used on form submit.

Dashboard consumer: `apps/dashboard/src/components/shared/ProxyInput.tsx:2`. Note `proxy-string.ts` does **not** run the SSRF allow-list (that is `proxy.ts`, server-only); the browser only previews/parses.

---

## 7. `snowflake.ts` — Fansly follow-ID → Date (name/scope discrepancy)

**Discrepancy — flag.** The territory brief and the filename `snowflake.ts` suggest an "ID generation scheme." The file contains **no ID generation**. It has one function, `fanslyFollowIdToDate(id)` (`:3`), which *decodes* a Fansly follow-relation snowflake ID into a `Date`: `new Date(Number((BigInt(id) >> 22n) + 1561494359900n))` — right-shift 22 bits to drop the sequence/worker bits and add the Fansly follow-relation epoch `FOLLOW_RELATION_EPOCH_MS = 1561494359900` (`:1`). No IDs are minted anywhere in this package.

**Consumers:** `apps/runtime/src/services/sync/executor-handlers.ts:1973` and `:2264` derive a follower's `followedAt` timestamp from `follower.id`. Not in `browser.ts`.

---

## 8. `time.ts` — business-date and timezone helpers

Timezone constants: `MOSCOW_TIME_ZONE = "Europe/Moscow"`, `UTC_TIME_ZONE = "UTC"` (`:3-4`). Period enums: `PERIOD_OPTIONS = ["today","7d","30d","all","custom"]` (`:5`); `SPENDER_PERIOD_OPTIONS = ["today","7d","30d","90d","180d","mtd","custom","lifetime"]` (`:6`); `SPENDER_SERIES_GRANULARITIES = ["day","week","month","auto"]` (`:16`). Business-date strings are `YYYY-MM-DD` (`BUSINESS_DATE_PATTERN`, `:17`).

**Timezone note (discrepancy worth flagging).** Many exported functions default their `timeZone` param to `MOSCOW_TIME_ZONE`, but the platform-scoped resolver `resolveBusinessTimeZone(platform)` (`:228`) returns **`UTC` for both `fansly` and `onlyfans`**. So every `...ForPlatform` variant computes bounds/business dates in UTC; the Moscow default only takes effect on the non-platform variants (`resolvePeriodBounds`, `resolveBusinessDateRange`, `resolveComparisonPeriodBounds`).

Core conversions:
- `getDateParts(date, tz)` (`:104`) — via `Intl.DateTimeFormat("en-CA", …, hour12:false)`.
- `getTimeZoneOffsetMs`, `zonedDateTimeToUtc` (`:142`) — convert a wall-clock date-time in a zone to a UTC `Date` (single-pass offset guess).
- `startOfBusinessDay` (`:161`), `addUtcDays` (`:176`), `toBusinessDate` (`:180`), `isValidBusinessDateString` (`:188`), `parseBusinessDate` (`:201`), `businessDateToUtcStart` (`:236`), `nextBusinessDate`/`previousBusinessDate` (`:573/577`), `diffBusinessDays` (`:549`).

Trailing-window offsets:
- `DEFAULT_TRAILING_PERIOD_OFFSETS`: `7d → 6`, `30d → 29` (spans 7 and 30 calendar days) (`:52`).
- `DEFAULT_SPENDER_TRAILING_PERIOD_OFFSETS`: adds `90d → 89`, `180d → 179` (`:57`).
- `ONLYFANS_REVENUE_TRAILING_PERIOD_OFFSETS`: `7d → 7`, `30d → 30` — deliberately **one calendar day longer** (7d spans 8 days, 30d spans 31), applied only via `resolveRevenuePeriodBoundsForPlatform` when `platform === "onlyfans"` (`:71`, `:342`). The comment attributes this to absorbing vendor data lag (decision #51 / audit B2); noted here descriptively.

Public resolvers (all return `PeriodBounds {from, to}` with an **exclusive** upper bound, or `BusinessDateRange {from, toExclusive}`): `resolvePeriodBounds` (`:316`), `resolveRevenuePeriodBoundsForPlatform` (`:331`), `resolveComparisonPeriodBounds` (`:348`, previous equal-length window), `resolveRevenueComparisonPeriodBoundsForPlatform` (`:368`), `resolveBusinessDateRange[ForPlatform]` (`:388/402`), `resolveRevenueBusinessDateRangeForPlatform` (`:416`). Custom ranges are `[from, to)`; same-day custom ranges advance the upper bound by one day (`resolveCustomPeriodBounds`, `:251`).

Spender-specific resolvers: `resolveSpenderPeriodBoundsForPlatform` (`:473`), `resolveSpenderComparisonPeriodBoundsForPlatform` (`:487`, with month-aware `mtd` previous-period logic), `resolveSpenderBusinessDateRangeForPlatform` (`:530`, returns `{timeZone, fromBusinessDate, toBusinessDateInclusive, bounds}`), and `resolveAutoSpenderSeriesGranularity` (`:557`, `≤90d → day`, `≤365d → week`, else `month`). `mtd` = month-to-date from day 1 of the current month (`:454`).

Dashboard uses `parseBusinessDate` (`apps/dashboard/src/lib/format.ts:1`); the platform revenue/spender resolvers are used server-side by analytics/report services (territory 09).

---

## 9. `dm-text.ts` — message text normalization

`normalizeDmMessageText(input)` (`:23`) turns platform DM HTML into plain text: `<br>` → `\n`; `</p|div|li>` boundaries → `\n`; opening `p|div|li` tags dropped; all remaining tags stripped; HTML entities decoded (named subset `amp/apos/gt/lt/nbsp/quot` in `BASIC_HTML_ENTITIES`, plus decimal `&#NN;` and hex `&#xNN;` via `decodeHtmlEntity`, `:10`); trailing/leading intra-line whitespace trimmed; 3+ blank lines collapsed to 2; final `.trim()`. `null`/`undefined`/empty → `""`. Browser-safe.

---

## 10. `fans.ts` — fan labeling + Fansly DM metadata

**Fan label resolution** (`resolveFanLabel` `:63` → delegates to `resolveFanLabelForScope(input, scope)` `:67`). Input `FanLabelInput` = `{platform?, platformUserId, pageAlias?, username?, displayName?}`. Precedence for the display `label` (each part trimmed, empty→null):
1. `pageAlias` — **only when `scope === "page"`** (agency's private nickname for the fan on that page); `primarySource: "pageAlias"`, `secondaryPlatformHandle: username`.
2. `displayName` → `primarySource: "displayName"`, secondary = username.
3. `username` → `primarySource: "username"`.
4. If `platform === "onlyfans"` and none of the above: `@u<platformUserId>` (`onlyFansUserLabel`, `:59`), `primarySource: "platformUserId"`.
5. Otherwise: `"Deleted user · <last 8 chars of id>"` (`deletedUserLabel`, `:52`), `primarySource: "deleted"`, `isDeletedFallback: true`.

Returns `ResolvedFanLabel` (`:11`) with `label`, `pageAlias`, `username`, `displayName`, `primarySource`, `secondaryPlatformHandle`, `isDeletedFallback`. Browser-safe; used both in the dashboard (e.g. `SpenderAutoListPage.tsx`) and server-side (`spenders.ts`, `conversations.ts`, etc.).

**Constants and DM-exclusion metadata:**
- `FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY = "messageSyncExcludedReason"` and two reason values: `partner_missing_from_aggregation_accounts`, `partner_unresolvable_from_account_lookup` (`:21-25`).
- External-presence source tags: `FANSLY_EXTERNAL_PRESENCE_SOURCE_FOLLOWERS_LAST_SEEN = "fansly_followers_last_seen"` and `OFAPI_EXTERNAL_PRESENCE_SOURCE_LAST_SEEN = "ofapi_last_seen"` (the latter covering OnlyFans lastSeen fed through OFAPI: audience sweep, `users.online/offline` webhooks, and message-payload lastSeen — comment `:28-30`).
- `getFanslyDmMessageSyncExcludedReason(metadata)` (`:136`) / `isFanslyDmMessageSyncExcluded(metadata)` (`:150`) read the reason key off a conversation-metadata bag; `buildFanslyDmConversationMetadata({unresolvedIdentity?, messageSyncExcludedReason?})` (`:156`) writes `{unresolvedIdentity?: true, messageSyncExcludedReason?}`. This metadata is persisted on Fansly DM conversation rows (consumed by `ofapi-dm-*`/`conversations` services).

---

## 11. `types.ts` — enum & type catalog

Shared enums/consts and the transaction classification table. All browser-safe.

| Export | Value(s) |
| --- | --- |
| `platforms` / `Platform` (`:1`) | `["fansly","onlyfans"]` |
| `transactionTypes` / `TransactionType` (`:4`) | `subscription, tip, message_purchase, post_purchase, stream_tip, chargeback, refund, payout_reversal, other` |
| `transactionReportingBuckets` (`:18`) | `revenue, adjustment, unclassified, excluded` |
| `transactionClassificationByType` (`:32`) | Maps each type → `{bucket, affectsSpenderAnalytics}`. `subscription/tip/message_purchase/post_purchase/stream_tip` → `revenue`+analytics; `chargeback/refund` → `adjustment`+analytics; `other` → `unclassified`+analytics; `payout_reversal` → `excluded`, `affectsSpenderAnalytics: false`. |
| derived: `reportableTransactionTypes` (`:83`), `spenderAnalyticsTransactionTypes` (`:87`), `transactionTypesByReportingBucket` (`:91`) | computed from the table |
| `transactionStates` (`:100`) | `pending, posted, unknown` |
| `userRoles` (`:104`) / `creatableUserRoles` (`:106`) | `owner, team_lead, chatter, content_manager` / (first three) |
| `fanFlagTypes` (`:109`) | `whale, vip, risky` |
| `aiUsageFeatures` / `AiUsageFeature` (`:112`) | `fast-reply, improve-draft, help-me, fan-summary, chat-review, scan, ping, hi-greeting` |
| `syncHealthStates` (`:151`) | `healthy, degraded, suspicious, failed` |
| `httpRequestStates` (`:154`) | `started, success, retry, failed` |
| `httpRequestFailureKinds` (`:157`) | `timeout, transport, http, provider` |
| `syncTelemetryEventSeverities` (`:160`) | `info, warn, error` |

Credential shapes (the plaintext that `crypto.ts` encrypts): `FanslySessionBundle { authorization, fanslyClientId?, fanslyClientCheck?, fanslySessionId? }` (`:124`); `OnlyMonsterTokenBundle { token }` (`:131`); the tagged union `StoredPlatformCredentialBundle` = `{platform:"fansly", session}` | `{platform:"onlyfans", auth}` (`:135`). `ProxyConfig { url, username?, password? }` (`:145`).

HTTP telemetry contracts: `HttpRequestPagination` (`:163`), `HttpRequestEventBase` and the four state variants → `HttpRequestEvent` union (`:170-217`), and `HttpRequestObserver { onRequestEvent(event): Promise<void> }` (`:218`) — the interface `http-request.ts` emits to.

---

## 12. `spender-buckets.ts` & `spender-retention.ts` — spender analytics primitives

(Also referenced by territory 09; described here as shared primitives.)

**`spender-buckets.ts`** — `SPENDER_AUTO_LIST_BUCKETS` (`:14`): six lifetime **gross-spend** bands in mills, each `[minAmountMills, maxAmountMillsExclusive)` with the last open-ended, mirroring the page's Fansly "[FB] $X-$Y Spenders" lists:

| key | label | min (mills) | maxExclusive (mills) |
| --- | --- | --- | --- |
| `0-25` | [FB] $0-$25 Spenders | `10` | `25_000` |
| `25-50` | [FB] $25-$50 Spenders | `25_000` | `50_000` |
| `50-150` | [FB] $50-$150 Spenders | `50_000` | `150_000` |
| `150-350` | [FB] $150-$350 Spenders | `150_000` | `350_000` |
| `350-600` | [FB] $350-$600 Spenders | `350_000` | `600_000` |
| `600-plus` | [FB] $600+ Spenders | `600_000` | `null` |

Note the first band starts at `10` mills ($0.01), not `0`. `SpenderAutoListBucket` interface at `:7`. Server-only (not in `browser.ts`); the comment states it is the single source of truth for the spender analytics auto-lists and the Workboard v2 "lists" mode.

**`spender-retention.ts`** — statuses `SPENDER_RETENTION_STATUSES = ["all","active","cooling","inactive","needs_reactivation"]` (`:1`). Thresholds: `ACTIVE_DAYS = 14`, `INACTIVE_DAYS = 45`, `NEEDS_REACTIVATION_LIFETIME_NET_MILLS = 100_000` ($100) (`:11-17`). `classifyRetention({lifetimeLastTransactionAt, lifetimeCreatorNetAmountMills, now})` (`:23`) → `active` if last txn `≤14d`; `cooling` if `≤45d`; else `needs_reactivation` when lifetime creator-net `≥ 100_000 mills`, otherwise `inactive` (null last-transaction ⇒ infinite age ⇒ inactive/needs_reactivation path). `isSpenderRetentionStatus` (`:19`) is the guard. Browser-safe (exported by `browser.ts`).

---

## 13. `logger.ts` — pino logger with redaction

`createLogger(level)` (`:28`) returns a `pino` logger with `base: undefined`, ISO timestamps, and an `err` serializer that runs `pino.stdSerializers.err(error)` through `redactLogValue` (`:5`) — a recursive walk (cycle-guarded via `WeakSet`) that applies `redactSensitiveText` (from `proxy.ts`) to every string, so serialized errors never leak proxy credentials or Telegram bot tokens. Server-only. This is the base logger the runtime processes instantiate; the redaction guarantee is the boundary-relevant fact.

---

## 14. `config.ts` / `config-registry.ts` / `config-settings.ts` — located here, documented in territory 13

These three modules live in `packages/shared/src/` and are re-exported by `index.ts` (server surface only; absent from `browser.ts`). They are covered in full by **territory 13**. Facts relevant to *this* territory:
- `config.ts` is where `crypto.ts`'s keys come from: it parses `APP_ENCRYPTION_KEY` / `APP_ENCRYPTION_KEY_VERSION` / `APP_ENCRYPTION_KEY_RING` into `config.encryptionKey: Buffer`, `config.encryptionKeyVersion: number`, `config.encryptionKeysByVersion: ReadonlyMap<number,Buffer>` (`config.ts:325-356`, `456-509`), the exact values passed into `encryptJson`/`decryptJsonWithKeyVersion` by runtime services.
- `config.ts` validates the env-provided proxy through this package's own `normalizeProxyConfig` + `assertProxyTargetAllowed` (`config.ts:451-453`) and parses raw proxy strings with `parseProxyString` (`config.ts:5`).
- `config-registry.ts` exports the `CONFIG_DESCRIPTORS` catalog and `RUNNING_SCHEMA_VERSION`; `config-settings.ts` exports the override validation/resolution/boot-apply helpers. Their concrete behavior is out of scope here.

---

## Boundary summary (this territory's crossings)

This package holds no long-lived connections; it hands primitives to runtime services. The crossings it *defines or gates*:

- **Postgres (encrypted at rest, in/out):** `crypto.ts` AES-256-GCM envelopes for platform credentials, Telegram bot token, and OFAPI webhook signing secret; keys sourced from `APP_ENCRYPTION_KEY*` env via `config.ts`.
- **Outbound HTTP to Fansly, OnlyFans, OFAPI, Anthropic, Telegram (out):** every such call runs through a `Dispatcher` built by `http-client.ts` (`createRequestDispatcher`/`createProxyRequestDispatcher`), with per-proxy caching keyed by `proxy.ts`. `http-request.ts` drives retries and emits telemetry events.
- **Proxy egress (out, credential-bearing):** `proxy.ts`/`proxy-string.ts` parse and normalize proxy URLs (HTTP/HTTPS/SOCKS5) and enforce the SSRF allow-list before any dispatcher is built.
- **Telemetry to DB (out, via observer):** `HttpRequestEvent` payloads from `http-request.ts` flow to a `HttpRequestObserver` implemented in territory 08.
- **Log sink (out, redacted):** `logger.ts` + `redactSensitiveText` strip proxy credentials and Telegram bot tokens from serialized errors before they leave the process.
- **Browser bundle boundary:** `browser.ts` fixes exactly which primitives (money, fans, dm-text, proxy-string, spender-retention, time, types) are safe to ship to the dashboard SPA; crypto/http/proxy/config/logger/snowflake/spender-buckets stay server-only.
