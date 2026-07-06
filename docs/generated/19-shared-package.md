> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# 19 — The Shared Package (`@agency_hub_core/shared`)

This map inventories `packages/shared/src` — the cross-cutting library that every runtime module and service imports as `@agency_hub_core/shared`. The barrel `index.ts:1-17` re-exports every module below. Contents span the money codec, domain type vocabularies, the business-day/period engine, spender bucketing and retention codecs, the Fansly snowflake decoder, fan-label helpers, the config/registry/settings machinery, the at-rest crypto envelope, proxy normalization and SSRF guards, the observed HTTP client, DM-text normalization, the logger, and the browser/node split. The money codec has its own map (`13-financial-and-money.md`); it is summarized here for completeness.

## Module inventory

| Module | Anchors | What it provides |
|---|---|---|
| `money.ts` | see below | The single money codec — full detail in `13-financial-and-money.md`. |
| `types.ts` | see below | Domain type vocabularies. |
| `time.ts` | see below | Business-day / period engine. |
| `spender-buckets.ts` | `:14` | Spender auto-list bands. |
| `spender-retention.ts` | `:12-23` | Retention-status codec. |
| `snowflake.ts` | `:3` | Fansly id → date decode. |
| `fans.ts` | `:21-156` | Fan-label + DM sync-exclusion helpers. |
| `config.ts` | `:205,366` | `AppConfig`, `loadConfig`, env invariants. |
| `config-registry.ts` | `:98,298` | Descriptor registry + running snapshot. |
| `config-settings.ts` | `:24-237` | Override validation + boot/staged/live machinery. |
| `crypto.ts` | `:13-59` | AES-256-GCM envelope for secrets at rest. |
| `proxy.ts` / `proxy-string.ts` | `:293,402` / `:19` | Proxy normalize/mask + SSRF allow-check. |
| `http-client.ts` / `http-request.ts` | `:40,124,178` / `:43` | undici dispatcher factory + observed requests. |
| `dm-text.ts` | `:23` | `normalizeDmMessageText`. |
| `logger.ts` | `:28` | `createLogger`. |
| `browser.ts` | — | Browser/node split (no exports; side-effecting/empty). |

Downstream, the money codec is used heavily by `modules/finance/index.ts`, `services/reporting.ts`, `services/spenders.ts`, `services/telegram-report.ts`, and `modules/workboard/engine.ts`.

## `money.ts` — the money codec (summary)

Platform money is **MILLS** (`bigint`, 1/1000 USD) via branded type `Mills` (`money.ts:10`); AI-plane money is **MICRO-USD** (`number`, integer) via `MicroUsd` (`money.ts:12`); `MillsLike` is `bigint | number | string` (`money.ts:15`). Source-named constructors (`millsFromInteger` `:29`, `millsFromDollars` `:43`, `millsFromCents` `:61`, `microUsdFromDollars` `:67`, `microUsdFromDbInt` `:75`), the two converters (`millsToMicroUsd` `:82` exact; `microUsdToMills` `:87` lossy), display/aggregation helpers, and commission math (`calculateNetMillsFromGross` `:170`, `calculateGrossMillsFromNet` `:185`, scale `COMMISSION_RATE_SCALE = 10_000n` `:17`) are all detailed in `13-financial-and-money.md`.

## `types.ts` — domain vocabularies

The kernel's enumerated vocabularies and their type aliases:

- **Platforms** — `platforms` / `Platform` (`types.ts:1`).
- **Transaction types** — `transactionTypes` / `TransactionType` (`types.ts:4`).
- **Reporting classification** — `transactionClassificationByType` mapping each type to a bucket of `revenue` / `adjustment` / `unclassified` / `excluded` (`types.ts:32-69`), read through `getTransactionClassification` (`types.ts:77`); the filtered sets `reportableTransactionTypes` and `spenderAnalyticsTransactionTypes` (`types.ts:83-89`).
- **Transaction states** — `transactionStates` (`types.ts:100`).
- **User roles** — `userRoles` and `creatableUserRoles` (`types.ts:104-107`).
- **Fan flags** — `fanFlagTypes` = whale / vip / risky (`types.ts:109`).
- **AI usage features** — `aiUsageFeatures`, including `workboard-closing` (`types.ts:112-124`).
- **Credential + HTTP-request events** — credential bundles and the `HttpRequest*` event types (`types.ts:126-222`).

## `time.ts` — business-day / period engine

The period/business-day engine over Moscow and UTC zones (`time.ts:3-4`). Period option sets `PERIOD_OPTIONS` and `SPENDER_PERIOD_OPTIONS` (`time.ts:5-15`); bounds resolvers `resolvePeriodBounds` / `resolvePeriodBoundsForPlatform` (`time.ts:316,331`) and `resolveSpenderPeriodBounds…` (`time.ts:473`), plus comparison-bounds helpers. Business-date primitives: `toBusinessDate`, `businessDateToUtcStart`, `diffBusinessDays`, and `resolveAutoSpenderSeriesGranularity`. OnlyFans revenue windows run one day longer than the Fansly equivalents — encoded in `ONLYFANS_REVENUE_TRAILING_PERIOD_OFFSETS` (`time.ts:71-74`).

## `spender-buckets.ts` — auto-list bands

`SPENDER_AUTO_LIST_BUCKETS` (`spender-buckets.ts:14`) — mills bands mirroring the Fansly `[FB] $X-$Y Spenders` labels. It is the single source shared by both the spender auto-lists and the Workboard v2 "lists" mode.

## `spender-retention.ts` — retention codec

`classifyRetention` (`spender-retention.ts:23`) maps recency to statuses `active` / `cooling` / `inactive` / `needs_reactivation`. Thresholds (`spender-retention.ts:12-17`): active ≤ 14 days, inactive ≤ 45 days, and a reactivation spend threshold of `100_000` mills.

## `snowflake.ts` — Fansly id decode

`fanslyFollowIdToDate` (`snowflake.ts:3`) decodes a Fansly BIGINT snowflake id into a timestamp (epoch `1561494359900`, `>> 22n`).

## `fans.ts` — fan labels + DM sync exclusion

`resolveFanLabel` / `resolveFanLabelForScope` (`fans.ts:63,67`) produce display labels; the Fansly DM sync-exclusion reason keys/enums live at `fans.ts:21-39`; `buildFanslyDmConversationMetadata` (`fans.ts:156`) assembles conversation metadata.

## `config.ts` / `config-registry.ts` / `config-settings.ts` — configuration machinery

- **`config.ts`** — the `AppConfig` shape (`config.ts:205`) and `loadConfig` (`config.ts:366`), which reads the environment and runs env-invariant checks.
- **`config-registry.ts`** — the descriptor registry: `CONFIG_DESCRIPTORS` (`config-registry.ts:98`) with `RUNNING_SCHEMA_VERSION = 2` and per-descriptor editability of `never` / `staged` / `editable`; `buildRunningSnapshot` (`config-registry.ts:298`) assembles the running view.
- **`config-settings.ts`** — the override machinery: `validateConfigOverride` (`config-settings.ts:24`), `collectCostWarnings` (`:90`), `resolveEffectiveConfig` (`:130`), `validateStagedOverride` (`:170`), and `applyBootOverrides` (`:237`).

## `crypto.ts` — at-rest secret envelope

`encryptJson` / `decryptJson` / `decryptJsonWithKeyVersion` (`crypto.ts:13,55,59`) implement an AES-256-GCM envelope for secrets at rest, alongside `sha256Hex` and `randomToken`. Used, among other places, for Telegram bot-token encryption.

## `proxy.ts` / `proxy-string.ts` — proxy config + SSRF guard

Normalize, mask, and validate proxy configurations. `assertProxyTargetAllowed` (`proxy.ts:293`) is the SSRF allow-check; `redactSensitiveText` (`proxy.ts:402`) masks secrets in text; `parseProxyString` (`proxy-string.ts:19`) parses proxy connection strings.

## `http-client.ts` / `http-request.ts` — observed HTTP client

`createRequestDispatcher` / `createProxyRequestDispatcher` (`http-client.ts:40,124`) build undici dispatchers (direct or proxied); retry timing is `resolveRetryDelayMs` (`http-client.ts:178`). `executeObservedRequest` (`http-request.ts:43`) runs a request under observation (capturing the request/response as an event).

## `dm-text.ts` / `logger.ts` / `browser.ts`

- `dm-text.ts` — `normalizeDmMessageText` (`dm-text.ts:23`), the canonical DM-text normalizer used by conversation and message projections.
- `logger.ts` — `createLogger` (`logger.ts:28`).
- `browser.ts` — the browser/node split; no exports (side-effecting/empty).
