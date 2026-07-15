> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Shared Package

`packages/shared` is the framework-independent utility and vocabulary package
published inside the workspace as `@agency_hub_core/shared`. Its server barrel
is `packages/shared/src/index.ts`; the dashboard build aliases the package to
the smaller `packages/shared/src/browser.ts` entry instead.

## Export surfaces

The server barrel exports 18 modules:

| Area | Modules |
|---|---|
| Configuration | `config.ts`, `config-registry.ts`, `config-settings.ts` |
| Security and transport | `crypto.ts`, `proxy.ts`, `proxy-string.ts`, `http-client.ts`, `http-request.ts` |
| Domain codecs | `money.ts`, `types.ts`, `time.ts`, `fans.ts`, `spender-buckets.ts`, `spender-retention.ts`, `snowflake.ts` |
| Text and logging | `dm-text.ts`, `unicode.ts`, `logger.ts` |

The browser entry exports only `fans.ts`, `dm-text.ts`, `money.ts`,
`proxy-string.ts`, `spender-retention.ts`, `time.ts`, and `types.ts`. Node-only
configuration, crypto, proxy dispatchers, request observation, logging, and
Unicode JSON sanitation are therefore absent from the dashboard bundle.

## Configuration

`packages/shared/src/config.ts` defines `AppConfig` and loads environment
values. `packages/shared/src/config-registry.ts` is the descriptor catalog used
to present and govern configuration keys; descriptors carry value type,
default, subsystem, editability, runtime-application mode, and optional bounds,
dependencies, cost warnings, or destructive-change markers.

`packages/shared/src/config-settings.ts` contains pure overlay logic shared by
the API, worker, and tests:

- `validateConfigOverride` rejects unknown and non-editable keys, validates
  scalar types, trims strings, and clamps integer overrides to descriptor
  bounds;
- `resolveEffectiveConfig` overlays valid editable database values on the
  environment config and records whether each value came from `env` or
  `override`;
- staged boot flags use a separate validator and boot-time application path;
- the AI transcript fresh-union mode permits stepwise upward transitions and
  direct rollback transitions.

## Domain vocabularies and codecs

`packages/shared/src/types.ts` defines the common literal vocabularies for
platforms, transaction types and reporting buckets, transaction states, user
roles, fan flags, AI usage features, stored platform credentials, sync health,
and observed HTTP request events. Transaction classification distinguishes
revenue, adjustment, unclassified, and excluded types and separately records
whether a type affects spender analytics.

`packages/shared/src/money.ts` is the integer money boundary: platform amounts
use branded bigint mills and AI cost uses integer micro-USD. It provides
source-named constructors, explicit converters, formatting, aggregation, and
commission calculations. The financial paths are mapped in
`docs/generated/13-financial-and-money.md`.

`packages/shared/src/time.ts` resolves Moscow- and UTC-based business periods,
comparison windows, spender periods, and automatic series granularity.
`packages/shared/src/spender-buckets.ts` defines the shared spend bands;
`packages/shared/src/spender-retention.ts` classifies spend-recency status.
`packages/shared/src/snowflake.ts` decodes Fansly follow IDs into timestamps.

`packages/shared/src/fans.ts` centralizes fan display-label fallback order,
Fansly DM exclusion metadata, and external-presence source names.
`packages/shared/src/dm-text.ts` normalizes DM message text.

## Secrets, proxying, and observed HTTP

`packages/shared/src/crypto.ts` provides AES-256-GCM JSON envelopes, versioned
decryption, token generation, and SHA-256 helpers used by runtime persistence
paths.

`packages/shared/src/proxy.ts` parses and normalizes HTTP, HTTPS, and SOCKS5
proxy configuration, removes inline credentials from normalized URLs, masks
sensitive text, and rejects disallowed proxy targets. Its target checks cover
private and ambiguous numeric IP forms. `packages/shared/src/proxy-string.ts`
handles the compact proxy string format used by browser-visible code.

`packages/shared/src/http-client.ts` creates direct and proxy-aware undici
dispatchers, including SOCKS5 connections. It also classifies transport and AI
provider stream failures, parses retry timing, formats redacted error chains,
and exposes a generation-scoped sticky-connect-failure fetch wrapper.

`packages/shared/src/http-request.ts` implements the retry loop for an observed
request. Callers provide transport and response classification callbacks; the
wrapper emits started, retry, success, and failed events through the observer
interface declared in `packages/shared/src/types.ts`.

## Unicode and logging

`packages/shared/src/unicode.ts` prevents malformed UTF-16 from reaching
Postgres JSON/JSONB. It offers surrogate-safe truncation and a deep copier that
replaces unpaired surrogates in object keys and values with U+FFFD.

`packages/shared/src/logger.ts` constructs the pino logger used by server-side
packages. It is not part of the browser entry.
