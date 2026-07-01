// Single descriptor registry for every runtime config value. One row per env var
// (plus a few derived AppConfig fields). This is the keystone for the in-dashboard
// configuration surface: it drives the read-only view (Stage A), and later the
// editable overlay (Stage B) and staged-rollout flips (Stage C). Keeping it as
// pure data means the API can serialize it and the dashboard can render generically
// without hard-coding the flag list.
//
// `config.ts` stays the single source of the env schema; a parity test asserts this
// registry matches ENV_CONFIG_KEYS so the two can never silently drift.

import type { AppConfig } from "./config.ts";

/** Bumped when the shape of a serialized running-values snapshot changes, so an
 *  old heartbeat row written by a not-yet-redeployed process can be detected and
 *  ignored rather than misread. v2 adds `skippedOverrides` to the snapshot. */
export const RUNNING_SCHEMA_VERSION = 2;

export type ConfigSubsystem =
  | "Core"
  | "Security"
  | "Fansly"
  | "Sync"
  | "OFAPI"
  | "Telegram"
  | "ChatMuse"
  | "Workboard";

export type ConfigKind =
  | "boolean" // on/off gate
  | "number"
  | "string"
  | "url"
  | "secret" // never displayed; only set/unset
  | "derived" // computed in loadConfig, no 1:1 env var
  | "alias" // legacy env var that feeds another field
  | "complex"; // structured value (proxy object, key ring); set/unset only

/** never = ops-only (secrets/infra/SSRF-class); staged = gated rollout flips in a
 *  prescribed order (Stage C); editable = safe operational knob (Stage B). */
export type ConfigEditability = "never" | "staged" | "editable";

/** A scalar config override as stored in the overlay table. Editable descriptors are
 *  only ever boolean/number/string, so the override value is one of those three. */
export type ConfigOverrideValue = string | number | boolean;

/** How (and whether) an override for this key actually reaches the runtime. This is
 *  the authoritative wiring class, orthogonal to `editability` (the policy class):
 *  - 'live' = wired to the runtime overlay (loadEffectiveConfig); an override is
 *    re-read each work cycle with no restart.
 *  - 'boot' = applied once at process start via applyBootOverrides (the staged-flag
 *    set), so it only takes effect after the process restarts.
 *  - 'none' = NOT overridable via the DB overlay at all (secrets/urls/derived, or an
 *    editable tunable / staged flag that is not yet wired); env-only / read-only. */
export type ConfigRuntimeApply = "live" | "boot" | "none";

export interface ConfigDescriptor {
  /** Stable id. For a 1:1 env var this is the AppConfig field; for aliases/derived
   *  it is a unique camelCase id. Used as the key in serialized running values. */
  key: string;
  /** Env var name. For derived entries this is the underlying env hint (e.g.
   *  NODE_ENV) and is intentionally absent from ENV_CONFIG_KEYS. */
  envName: string;
  /** The AppConfig field this value lands in (aliases share another field's). */
  configField: keyof AppConfig | null;
  kind: ConfigKind;
  subsystem: ConfigSubsystem;
  label: string;
  /** Human-readable default, for display next to the running value. */
  default: string;
  editability: ConfigEditability;
  /** Wiring class (live overlay / boot-apply / not-overridable). Orthogonal to
   *  `editability`; see {@link ConfigRuntimeApply}. The live + boot sets are an
   *  allowlist guarded by a registry-integrity test. */
  runtimeApply: ConfigRuntimeApply;
  /** Included in cross-instance drift detection. False for secret/derived/complex/
   *  alias values where a raw compare would be meaningless or unsafe. */
  comparable: boolean;
  /** Short note shown in the UI (e.g. clamping behavior or a boot invariant). */
  note?: string;
  min?: number;
  max?: number;
  enumValues?: string[];
  /** Money/quota/data implication shown when editing (Stage B). */
  costWarning?: string;
  /** Lowering/clearing this drops data irreversibly; needs an extra confirm. */
  destructive?: boolean;
  /** Staged-rollout grouping + prescribed enable order (Stage C). */
  stagedGroup?: string;
  stagedOrder?: number;
  /** Other descriptor keys that must be effectively-on before this can enable. */
  requires?: string[];
}

const NEVER = "never" as const;
const STAGED = "staged" as const;
const EDITABLE = "editable" as const;

export const CONFIG_DESCRIPTORS: readonly ConfigDescriptor[] = [
  // ── Core / Security ───────────────────────────────────────────────────────
  { key: "databaseUrl", envName: "DATABASE_URL", configField: "databaseUrl", kind: "secret", subsystem: "Core", label: "Database URL", default: "(required)", editability: NEVER, runtimeApply: "none", comparable: false },
  { key: "encryptionKey", envName: "APP_ENCRYPTION_KEY", configField: "encryptionKey", kind: "secret", subsystem: "Security", label: "Encryption key", default: "(required)", editability: NEVER, runtimeApply: "none", comparable: false, note: "AES key for secrets at rest; rotated via the key ring, never edited here." },
  { key: "encryptionKeyRing", envName: "APP_ENCRYPTION_KEY_RING", configField: "encryptionKeysByVersion", kind: "complex", subsystem: "Security", label: "Encryption key ring", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false },
  { key: "encryptionKeyVersion", envName: "APP_ENCRYPTION_KEY_VERSION", configField: "encryptionKeyVersion", kind: "number", subsystem: "Security", label: "Encryption key version", default: "1", editability: NEVER, runtimeApply: "none", comparable: true },
  { key: "logLevel", envName: "LOG_LEVEL", configField: "logLevel", kind: "string", subsystem: "Core", label: "Log level", default: "info", editability: EDITABLE, runtimeApply: "none", comparable: true, enumValues: ["fatal", "error", "warn", "info", "debug", "trace"] },
  { key: "apiHost", envName: "API_HOST", configField: "apiHost", kind: "string", subsystem: "Core", label: "API host", default: "0.0.0.0", editability: NEVER, runtimeApply: "none", comparable: true },
  { key: "apiPort", envName: "API_PORT", configField: "apiPort", kind: "number", subsystem: "Core", label: "API port", default: "3000", editability: NEVER, runtimeApply: "none", comparable: true },
  { key: "trustProxy", envName: "TRUST_PROXY", configField: "trustProxy", kind: "string", subsystem: "Security", label: "Trust proxy", default: "false", editability: NEVER, runtimeApply: "none", comparable: true, note: "Audit P-9: 'true' enables IP spoofing; ops-only (hop count / CIDR)." },
  { key: "sessionTtlDays", envName: "SESSION_TTL_DAYS", configField: "sessionTtlDays", kind: "number", subsystem: "Security", label: "Session TTL (days)", default: "30", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, max: 365 },
  { key: "isProduction", envName: "NODE_ENV", configField: "isProduction", kind: "derived", subsystem: "Core", label: "Production mode", default: "false", editability: NEVER, runtimeApply: "none", comparable: true, note: "Derived from NODE_ENV." },

  // ── Fansly ────────────────────────────────────────────────────────────────
  { key: "fanslyBaseUrl", envName: "FANSLY_BASE_URL", configField: "fanslyBaseUrl", kind: "url", subsystem: "Fansly", label: "Fansly base URL", default: "https://apiv3.fansly.com/api/v1", editability: NEVER, runtimeApply: "none", comparable: true },
  { key: "fanslyDefaultDelayMs", envName: "FANSLY_DEFAULT_DELAY_MS", configField: "fanslyDefaultDelayMs", kind: "number", subsystem: "Fansly", label: "Fansly default delay (ms)", default: "2500", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Lowering reduces politeness against Fansly's unofficial API; raises ban/throttle risk.", note: "Captured by the Fansly adapter at boot — applies after restart." },
  { key: "fanslyGlobalDelayMs", envName: "FANSLY_GLOBAL_DELAY_MS", configField: "fanslyDefaultDelayMs", kind: "alias", subsystem: "Fansly", label: "Fansly global delay (legacy alias)", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false, note: "Legacy fallback feeding Fansly default delay." },
  { key: "fanslyAccountLookupDelayMs", envName: "FANSLY_ACCOUNT_LOOKUP_DELAY_MS", configField: "fanslyDefaultDelayMs", kind: "alias", subsystem: "Fansly", label: "Fansly account-lookup delay (legacy alias)", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false, note: "Legacy fallback feeding Fansly default delay." },
  { key: "followerPageDelayMs", envName: "FOLLOWER_PAGE_DELAY_MS", configField: "followerPageDelayMs", kind: "number", subsystem: "Fansly", label: "Follower page delay (ms)", default: "5000", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1 },
  { key: "fanslyDmConversationsDelayMs", envName: "FANSLY_DM_CONVERSATIONS_DELAY_MS", configField: "fanslyDmConversationsDelayMs", kind: "number", subsystem: "Fansly", label: "Fansly DM conversations delay (ms)", default: "5000", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 5000, note: "Floored to 5000ms in code; lower values are silently clamped." },
  { key: "fanslyDmMessagesDelayMs", envName: "FANSLY_DM_MESSAGES_DELAY_MS", configField: "fanslyDmMessagesDelayMs", kind: "number", subsystem: "Fansly", label: "Fansly DM messages delay (ms)", default: "5000", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 5000, note: "Floored to 5000ms in code; lower values are silently clamped." },
  { key: "fanslyDmDeepBackfillEnabled", envName: "FANSLY_DM_DEEP_BACKFILL_ENABLED", configField: "fanslyDmDeepBackfillEnabled", kind: "boolean", subsystem: "Fansly", label: "Fansly DM deep backfill", default: "false", editability: EDITABLE, runtimeApply: "none", comparable: true, costWarning: "Hammers Fansly's API harder; consumes request quota faster (ban risk)." },
  { key: "fanslyDmDeepBackfillMaxRequestsPerRun", envName: "FANSLY_DM_DEEP_BACKFILL_MAX_REQUESTS_PER_RUN", configField: "fanslyDmDeepBackfillMaxRequestsPerRun", kind: "number", subsystem: "Fansly", label: "Deep backfill max requests/run", default: "1", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 0, costWarning: "Raising consumes Fansly request quota faster." },
  { key: "fanslyDmDeepBackfillLiveRequestsPerDeep", envName: "FANSLY_DM_DEEP_BACKFILL_LIVE_REQUESTS_PER_DEEP", configField: "fanslyDmDeepBackfillLiveRequestsPerDeep", kind: "number", subsystem: "Fansly", label: "Deep backfill live requests/deep", default: "4", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1 },
  { key: "fanslyDmDeepBackfillContinuationDelayMs", envName: "FANSLY_DM_DEEP_BACKFILL_CONTINUATION_DELAY_MS", configField: "fanslyDmDeepBackfillContinuationDelayMs", kind: "number", subsystem: "Fansly", label: "Deep backfill continuation delay (ms)", default: "0", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 0 },
  { key: "fanslyDmDeepBackfillContinuationJitterMs", envName: "FANSLY_DM_DEEP_BACKFILL_CONTINUATION_JITTER_MS", configField: "fanslyDmDeepBackfillContinuationJitterMs", kind: "number", subsystem: "Fansly", label: "Deep backfill continuation jitter (ms)", default: "0", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 0 },

  // ── Sync / OnlyFans (OnlyMonster) ─────────────────────────────────────────
  { key: "onlyMonsterBaseUrl", envName: "ONLYMONSTER_BASE_URL", configField: "onlyMonsterBaseUrl", kind: "url", subsystem: "Sync", label: "OnlyMonster base URL", default: "https://omapi.onlymonster.ai", editability: NEVER, runtimeApply: "none", comparable: true },
  // No `requires`: the precondition is (proxy set) OR allow-direct — an OR that the
  // simple AND-list can't express. It lives in the shared invariant validator
  // (used by loadConfig and, in Stage B/C, by PATCH), not as a misleading dependency.
  { key: "onlyFansPublicProfileResolutionEnabled", envName: "ONLYFANS_PUBLIC_PROFILE_RESOLUTION_ENABLED", configField: "onlyFansPublicProfileResolutionEnabled", kind: "boolean", subsystem: "Sync", label: "OF public-profile resolution", default: "false", editability: STAGED, runtimeApply: "none", comparable: true, note: "Requires a proxy or allow-direct; enabling without one fails boot." },
  { key: "onlyFansPublicProfileAllowDirect", envName: "ONLYFANS_PUBLIC_PROFILE_ALLOW_DIRECT", configField: "onlyFansPublicProfileAllowDirect", kind: "boolean", subsystem: "Sync", label: "OF public-profile allow direct", default: "false", editability: STAGED, runtimeApply: "none", comparable: true, note: "Allows hitting OnlyFans without a proxy." },
  { key: "onlyFansPublicProfileProxy", envName: "ONLYFANS_PUBLIC_PROFILE_PROXY_URL", configField: "onlyFansPublicProfileProxy", kind: "complex", subsystem: "Sync", label: "OF public-profile proxy", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false, note: "Proxy string with embedded credentials." },
  { key: "onlyFansPublicProfileMaxPerRun", envName: "ONLYFANS_PUBLIC_PROFILE_MAX_PER_RUN", configField: "onlyFansPublicProfileMaxPerRun", kind: "number", subsystem: "Sync", label: "OF public-profile max/run", default: "5", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1 },
  { key: "onlyFansPublicProfileDelayMs", envName: "ONLYFANS_PUBLIC_PROFILE_DELAY_MS", configField: "onlyFansPublicProfileDelayMs", kind: "number", subsystem: "Sync", label: "OF public-profile delay (ms)", default: "30000", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1 },
  { key: "onlyFansDmPollingEnabled", envName: "ONLYFANS_DM_POLLING_ENABLED", configField: "onlyFansDmPollingEnabled", kind: "boolean", subsystem: "Sync", label: "OnlyFans DM polling (legacy)", default: "false", editability: STAGED, runtimeApply: "none", comparable: true, note: "Legacy polling path; superseded by the OFAPI webhook path." },
  { key: "syncHttpTraceFile", envName: "SYNC_HTTP_TRACE_FILE", configField: "syncHttpTraceFile", kind: "string", subsystem: "Sync", label: "Sync HTTP trace file", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: true, note: "Debug-only file path on the container." },
  { key: "onlyFansDefaultDelayMs", envName: "ONLYFANS_DEFAULT_DELAY_MS", configField: "onlyFansDefaultDelayMs", kind: "number", subsystem: "Sync", label: "OnlyFans default delay (ms)", default: "1000", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, note: "Captured by the OnlyFans adapter at boot — applies after restart." },
  { key: "syncSharedRateLimitEnabled", envName: "SYNC_SHARED_RATE_LIMIT_ENABLED", configField: "syncSharedRateLimitEnabled", kind: "boolean", subsystem: "Sync", label: "Shared rate limiter", default: "true", editability: EDITABLE, runtimeApply: "none", comparable: true, note: "Boot invariant: concurrency > 1 requires this ON." },
  { key: "syncPageExecutorConcurrency", envName: "SYNC_PAGE_EXECUTOR_CONCURRENCY", configField: "syncPageExecutorConcurrency", kind: "number", subsystem: "Sync", label: "Page executor concurrency", default: "4", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Higher concurrency increases simultaneous external API pressure.", note: "Boot invariant: > 1 requires the shared rate limiter ON." },
  { key: "transactionLookbackDays", envName: "TRANSACTION_LOOKBACK_DAYS", configField: "transactionLookbackDays", kind: "number", subsystem: "Sync", label: "Transaction lookback (days)", default: "7", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 1, max: 365, note: "Capped at 365 days; a wider window scans more transaction pages per cycle." },
  { key: "transactionRescanCapDays", envName: "TRANSACTION_RESCAN_CAP_DAYS", configField: "transactionRescanCapDays", kind: "number", subsystem: "Sync", label: "Transaction rescan cap (days)", default: "30", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 1, max: 365, costWarning: "Wider window increases backfill request volume against upstreams.", note: "Capped at 365 days." },
  { key: "syncObservabilityRetentionDays", envName: "SYNC_OBSERVABILITY_RETENTION_DAYS", configField: "syncObservabilityRetentionDays", kind: "number", subsystem: "Sync", label: "Observability retention (days)", default: "30", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, destructive: true, costWarning: "Lowering permanently drops observability rows." },
  { key: "healthSyncLightMaxAgeMinutes", envName: "HEALTH_SYNC_LIGHT_MAX_AGE_MINUTES", configField: "healthSyncLightMaxAgeMinutes", kind: "number", subsystem: "Sync", label: "Health: light sync max age (min)", default: "180", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 1 },
  { key: "healthSyncFollowerMaxAgeMinutes", envName: "HEALTH_SYNC_FOLLOWER_MAX_AGE_MINUTES", configField: "healthSyncFollowerMaxAgeMinutes", kind: "number", subsystem: "Sync", label: "Health: follower sync max age (min)", default: "1080", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 1 },
  { key: "healthSyncMonitoringToken", envName: "HEALTH_SYNC_MONITORING_TOKEN", configField: "healthSyncMonitoringToken", kind: "secret", subsystem: "Security", label: "Health monitoring token", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false },
  { key: "onlyFansTopSpendersEnabled", envName: "ONLYFANS_TOP_SPENDERS_ENABLED", configField: "onlyFansTopSpendersEnabled", kind: "boolean", subsystem: "Sync", label: "OnlyFans top spenders", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#50", stagedOrder: 5, requires: ["ofapiPresenceProjectionEnabled"] },

  // ── Telegram ──────────────────────────────────────────────────────────────
  { key: "telegramBotToken", envName: "TELEGRAM_BOT_TOKEN", configField: "telegramBotToken", kind: "secret", subsystem: "Telegram", label: "Telegram bot token", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false, note: "Operational Telegram credentials are managed in Notifications, not here." },
  { key: "telegramChatId", envName: "TELEGRAM_CHAT_ID", configField: "telegramChatId", kind: "secret", subsystem: "Telegram", label: "Telegram chat ID", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false, note: "Managed in Notifications." },
  // Not editable here: this is only the env default. The operational report hour is
  // stored in telegram_settings and edited in Notifications — keeping it read-only
  // avoids two conflicting sources of truth (same rule as the Telegram secrets).
  { key: "telegramReportHourUtc", envName: "TELEGRAM_REPORT_HOUR", configField: "telegramReportHourUtc", kind: "number", subsystem: "Telegram", label: "Telegram report hour (UTC, default)", default: "9", editability: NEVER, runtimeApply: "none", comparable: true, min: 0, max: 23, note: "Default only; the operational value is managed in Notifications." },
  { key: "telegramProxyPageLabel", envName: "TELEGRAM_PROXY_PAGE_LABEL", configField: "telegramProxyPageLabel", kind: "string", subsystem: "Telegram", label: "Telegram proxy page", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: true, note: "Optional page label whose stored proxy is used for Telegram Bot API egress." },
  { key: "telegramEnabled", envName: "TELEGRAM_ENABLED", configField: "telegramEnabled", kind: "derived", subsystem: "Telegram", label: "Telegram enabled", default: "false", editability: NEVER, runtimeApply: "none", comparable: true, note: "Derived: bot token AND chat id both set." },

  // ── OFAPI ─────────────────────────────────────────────────────────────────
  // The host literal is intentionally NOT duplicated here — it stays pinned to the
  // OFAPI client and config.ts (D1 spend-tap guard). The effective value still shows
  // via the running snapshot at runtime.
  { key: "ofapiBaseUrl", envName: "OFAPI_BASE_URL", configField: "ofapiBaseUrl", kind: "url", subsystem: "OFAPI", label: "OFAPI base URL", default: "(OFAPI default base URL)", editability: NEVER, runtimeApply: "none", comparable: true, note: "Spend-tap host; pinned in code." },
  { key: "ofapiApiKey", envName: "OFAPI_API_KEY", configField: "ofapiApiKey", kind: "secret", subsystem: "OFAPI", label: "OFAPI API key", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false, note: "Single metered spend tap." },
  { key: "ofapiWebhookRateLimitMax", envName: "OFAPI_WEBHOOK_RATE_LIMIT_MAX", configField: "ofapiWebhookRateLimitMax", kind: "number", subsystem: "OFAPI", label: "OFAPI webhook rate limit max", default: "1000", editability: NEVER, runtimeApply: "none", comparable: true, min: 1, note: "Per-process ingress guard for signed webhook deliveries." },
  { key: "ofapiWebhookRateLimitWindowSeconds", envName: "OFAPI_WEBHOOK_RATE_LIMIT_WINDOW_SECONDS", configField: "ofapiWebhookRateLimitWindowSeconds", kind: "number", subsystem: "OFAPI", label: "OFAPI webhook rate limit window (s)", default: "60", editability: NEVER, runtimeApply: "none", comparable: true, min: 1, note: "Per-process ingress guard for signed webhook deliveries." },
  { key: "ofapiEventRetentionDays", envName: "OFAPI_EVENT_RETENTION_DAYS", configField: "ofapiEventRetentionDays", kind: "number", subsystem: "OFAPI", label: "OFAPI event retention (days)", default: "7", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, destructive: true, costWarning: "Lowering drops webhook journal rows used for back-projection." },
  { key: "ofapiEventWorkerReplicas", envName: "OFAPI_EVENT_WORKER_REPLICAS", configField: "ofapiEventWorkerReplicas", kind: "number", subsystem: "OFAPI", label: "OFAPI event worker replicas", default: "1", editability: NEVER, runtimeApply: "none", comparable: true, min: 1, note: "Startup guard for settle-order fanout: values other than 1 are unsupported until the event fanout design is redesigned for HA." },
  { key: "ofapiDmProjectionEnabled", envName: "OFAPI_DM_PROJECTION_ENABLED", configField: "ofapiDmProjectionEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI DM projection", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#49", stagedOrder: 1, requires: [] },
  { key: "ofapiDmSyncEnabled", envName: "OFAPI_DM_SYNC_ENABLED", configField: "ofapiDmSyncEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI DM sync (REST)", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#49", stagedOrder: 2, requires: ["ofapiDmProjectionEnabled"], costWarning: "REST bootstrap/reconcile spends real OFAPI credits." },
  { key: "ofapiDmColdArchiveEnabled", envName: "OFAPI_DM_COLD_ARCHIVE_ENABLED", configField: "ofapiDmColdArchiveEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI DM cold archive", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#52", stagedOrder: 1, requires: ["ofapiDmProjectionEnabled"], note: "Forward-only cold archive for future message-shaped OFAPI webhooks; no historical bulk backfill." },
  { key: "ofapiDmColdArchiveRetentionDays", envName: "OFAPI_DM_COLD_ARCHIVE_RETENTION_DAYS", configField: "ofapiDmColdArchiveRetentionDays", kind: "number", subsystem: "OFAPI", label: "OFAPI DM archive retention (days)", default: "3650", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, destructive: true, costWarning: "Lowering can purge stored DM archive transcripts sooner." },
  { key: "ofapiRestDelayMs", envName: "OFAPI_REST_DELAY_MS", configField: "ofapiRestDelayMs", kind: "number", subsystem: "OFAPI", label: "OFAPI REST delay (ms)", default: "500", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 0, costWarning: "Lowering risks 429s / vendor throttling.", note: "Captured by the OFAPI client at boot — applies after restart." },
  { key: "ofapiDmBootstrapMaxRequestsPerRun", envName: "OFAPI_DM_BOOTSTRAP_MAX_REQUESTS_PER_RUN", configField: "ofapiDmBootstrapMaxRequestsPerRun", kind: "number", subsystem: "OFAPI", label: "OFAPI DM bootstrap max requests/run", default: "25", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Raising accelerates credit burn within the daily ceiling." },
  { key: "ofapiDmDailyCreditBudget", envName: "OFAPI_DM_DAILY_CREDIT_BUDGET", configField: "ofapiDmDailyCreditBudget", kind: "number", subsystem: "OFAPI", label: "OFAPI DM daily credit budget", default: "500", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Raises the daily real-money spend ceiling for DM sync." },
  { key: "ofapiCreditFloor", envName: "OFAPI_CREDIT_FLOOR", configField: "ofapiCreditFloor", kind: "number", subsystem: "OFAPI", label: "OFAPI credit floor", default: "500", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 0, costWarning: "Lowering removes the safety floor that parks spend when credits run low." },
  { key: "ofapiDmReconcileIntervalMinutes", envName: "OFAPI_DM_RECONCILE_INTERVAL_MINUTES", configField: "ofapiDmReconcileIntervalMinutes", kind: "number", subsystem: "OFAPI", label: "OFAPI DM reconcile interval (min)", default: "360", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 1, costWarning: "Shortening runs credit-spending reconciles more often." },
  { key: "ofapiAccountHealthEnabled", envName: "OFAPI_ACCOUNT_HEALTH_ENABLED", configField: "ofapiAccountHealthEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI account health", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#49", stagedOrder: 3, requires: ["ofapiDmSyncEnabled"] },
  { key: "ofapiCreditAlertThreshold", envName: "OFAPI_CREDIT_ALERT_THRESHOLD", configField: "ofapiCreditAlertThreshold", kind: "number", subsystem: "OFAPI", label: "OFAPI low-credit alert threshold", default: "1000", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 0, costWarning: "Lowering silences the early low-credit warning." },
  { key: "ofapiWebhookSilenceThresholdMinutes", envName: "OFAPI_WEBHOOK_SILENCE_THRESHOLD_MINUTES", configField: "ofapiWebhookSilenceThresholdMinutes", kind: "number", subsystem: "OFAPI", label: "OFAPI webhook silence threshold (min)", default: "720", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 1 },
  { key: "ofapiCreditLedgerEnabled", envName: "OFAPI_CREDIT_LEDGER_ENABLED", configField: "ofapiCreditLedgerEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI credit ledger", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#50", stagedOrder: 1, requires: ["ofapiAccountHealthEnabled"] },
  { key: "ofapiBurnAlertCreditsPerHour", envName: "OFAPI_BURN_ALERT_CREDITS_PER_HOUR", configField: "ofapiBurnAlertCreditsPerHour", kind: "number", subsystem: "OFAPI", label: "OFAPI burn alert (credits/hr)", default: "300", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 0, costWarning: "Raising silences the runaway-spend alarm." },
  { key: "ofapiCreditMicroUsdPrice", envName: "OFAPI_CREDIT_MICRO_USD_PRICE", configField: "ofapiCreditMicroUsdPrice", kind: "number", subsystem: "OFAPI", label: "OFAPI credit price (micro-USD)", default: "0", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 0, note: "Display-only flat price per OFAPI credit for the credits dashboard's USD estimates. Micro-USD integer: 1,000,000 = $1.00, so 10,000 = $0.01/credit. 0 hides all USD estimates. Does not gate spend." },
  { key: "ofapiBalancePingEnabled", envName: "OFAPI_BALANCE_PING_ENABLED", configField: "ofapiBalancePingEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI balance ping", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#50", stagedOrder: 2, requires: ["ofapiCreditLedgerEnabled"], costWarning: "Spends ~1 OFAPI credit/day (a daily balance probe). Requires the credit ledger.", note: "Pairs with the credit ledger; enable together." },
  { key: "ofapiAudienceSyncEnabled", envName: "OFAPI_AUDIENCE_SYNC_ENABLED", configField: "ofapiAudienceSyncEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI audience sync", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#50", stagedOrder: 3, requires: ["ofapiCreditLedgerEnabled"], costWarning: "Audience sweeps spend real OFAPI credits." },
  { key: "ofapiAudienceMaxRequestsPerRun", envName: "OFAPI_AUDIENCE_MAX_REQUESTS_PER_RUN", configField: "ofapiAudienceMaxRequestsPerRun", kind: "number", subsystem: "OFAPI", label: "OFAPI audience max requests/run", default: "25", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Raising accelerates credit burn." },
  { key: "ofapiAudienceDailyCreditBudget", envName: "OFAPI_AUDIENCE_DAILY_CREDIT_BUDGET", configField: "ofapiAudienceDailyCreditBudget", kind: "number", subsystem: "OFAPI", label: "OFAPI audience daily credit budget", default: "300", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Raises the daily real-money spend ceiling for audience sync." },
  { key: "ofapiAudienceSweepIntervalMinutes", envName: "OFAPI_AUDIENCE_SWEEP_INTERVAL_MINUTES", configField: "ofapiAudienceSweepIntervalMinutes", kind: "number", subsystem: "OFAPI", label: "OFAPI audience sweep interval (min)", default: "1440", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Shortening multiplies daily credit burn." },
  { key: "ofapiPresenceProjectionEnabled", envName: "OFAPI_PRESENCE_PROJECTION_ENABLED", configField: "ofapiPresenceProjectionEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI presence projection", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#50", stagedOrder: 4, requires: ["ofapiAudienceSyncEnabled"] },
  { key: "ofapiSpendProjectionShadowEnabled", envName: "OFAPI_SPEND_PROJECTION_SHADOW_ENABLED", configField: "ofapiSpendProjectionShadowEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI spend shadow projection", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#51", stagedOrder: 1, requires: ["ofapiCreditLedgerEnabled"], note: "Shadow-only C3 comparison table; does not change revenue truth or desktop sweep cadence." },
  { key: "ofapiSpendTransactionIngestEnabled", envName: "OFAPI_SPEND_TRANSACTION_INGEST_ENABLED", configField: "ofapiSpendTransactionIngestEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI spend transaction ingest", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#51", stagedOrder: 2, requires: ["ofapiSpendProjectionShadowEnabled"], note: "C3 apply step: applies transactions.new projections (pending, settled, and reversed) into transactions and rollups; pending rows enter as pending state and transition in place when a terminal settled/reversed projection arrives. Also gates the REST transaction backfill --write path into the same truth table." },
  { key: "ofapiDesktopReadGatewayEnabled", envName: "OFAPI_DESKTOP_READ_GATEWAY_ENABLED", configField: "ofapiDesktopReadGatewayEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI desktop read gateway", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#54", stagedOrder: 1, requires: ["ofapiCreditLedgerEnabled"], costWarning: "Gateway reads spend real OFAPI credits.", note: "Read-only C6 custody slice. Desktop direct mode remains available until write commands and rollback are complete." },
  { key: "ofapiDesktopCommandOutboxEnabled", envName: "OFAPI_DESKTOP_COMMAND_OUTBOX_ENABLED", configField: "ofapiDesktopCommandOutboxEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI desktop command outbox", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#55", stagedOrder: 1, requires: ["ofapiDesktopReadGatewayEnabled"], note: "C6b intake/read/cancel only. Enabling does not execute commands or call OFAPI." },
  { key: "ofapiDesktopCommandExecutionEnabled", envName: "OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED", configField: "ofapiDesktopCommandExecutionEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI desktop command execution", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#56", stagedOrder: 1, requires: ["ofapiDesktopCommandOutboxEnabled"], costWarning: "Executes real OFAPI sends and spends credits.", note: "C6b2 text-send executor. Enable only for a controlled production test fan after the outbox rollout is healthy." },
  { key: "chatMuseAiGatewayEnabled", envName: "CHATMUSE_AI_GATEWAY_ENABLED", configField: "chatMuseAiGatewayEnabled", kind: "boolean", subsystem: "ChatMuse", label: "ChatMuse AI gateway", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#26", stagedOrder: 1, costWarning: "Routes chatter AI generations through core provider keys and spend ledger.", note: "Default-off C6c/R4 gateway route. Local desktop provider keys remain the rollback path until production validation passes." },
  { key: "chatMuseAiGatewayDailyRequestLimit", envName: "CHATMUSE_AI_GATEWAY_DAILY_REQUEST_LIMIT", configField: "chatMuseAiGatewayDailyRequestLimit", kind: "number", subsystem: "ChatMuse", label: "AI gateway daily request cap", default: "200", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 0, costWarning: "Raising allows more provider calls per chatter/page UTC day once gateway execution is enabled.", note: "Global guard used by the C6c gateway preflight; 0 blocks all provider attempts." },
  { key: "chatMuseAiGatewayDailyMicroUsdLimit", envName: "CHATMUSE_AI_GATEWAY_DAILY_MICRO_USD_LIMIT", configField: "chatMuseAiGatewayDailyMicroUsdLimit", kind: "number", subsystem: "ChatMuse", label: "AI gateway daily cost cap (micro-USD)", default: "5000000", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 0, costWarning: "Raising increases the daily Anthropic/OpenRouter spend ceiling per chatter/page once provider execution is enabled.", note: "5,000,000 micro-USD is $5.00. 0 blocks all provider attempts." },
  { key: "chatMuseAiGatewayRequestMicroUsdLimit", envName: "CHATMUSE_AI_GATEWAY_REQUEST_MICRO_USD_LIMIT", configField: "chatMuseAiGatewayRequestMicroUsdLimit", kind: "number", subsystem: "ChatMuse", label: "AI gateway per-request cost cap (micro-USD)", default: "5000000", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 0, costWarning: "Raising allows a single provider call to reserve a larger worst-case Anthropic token budget.", note: "Per-request preflight guard; 5,000,000 micro-USD is $5.00. 0 blocks all provider attempts." },

  // ── Workboard ─────────────────────────────────────────────────────────────
  { key: "anthropicApiKey", envName: "ANTHROPIC_API_KEY", configField: "anthropicApiKey", kind: "secret", subsystem: "Workboard", label: "Anthropic API key", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false, note: "Key-gates Workboard closing LLM and the default-off ChatMuse AI gateway provider." },
  { key: "wbClosingLlmEnabled", envName: "WB_CLOSING_LLM_ENABLED", configField: "wbClosingLlmEnabled", kind: "boolean", subsystem: "Workboard", label: "Workboard closing LLM", default: "false", editability: STAGED, runtimeApply: "none", comparable: true, note: "Effective only when the Anthropic key is also set." },
  { key: "wbClosingLlmModel", envName: "WB_CLOSING_LLM_MODEL", configField: "wbClosingLlmModel", kind: "string", subsystem: "Workboard", label: "Workboard closing LLM model", default: "claude-haiku-4-5", editability: EDITABLE, runtimeApply: "none", comparable: true, costWarning: "A larger model multiplies per-call token cost." },
  { key: "wbClosingLlmDailyCapMin", envName: "WB_CLOSING_LLM_DAILY_CAP_MIN", configField: "wbClosingLlmDailyCapMin", kind: "number", subsystem: "Workboard", label: "Closing LLM daily cap (min)", default: "50", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1 },
  { key: "wbClosingLlmDailyCapMax", envName: "WB_CLOSING_LLM_DAILY_CAP_MAX", configField: "wbClosingLlmDailyCapMax", kind: "number", subsystem: "Workboard", label: "Closing LLM daily cap (max)", default: "400", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Raising the max raises the daily Anthropic spend ceiling." },
] as const;

const DESCRIPTOR_BY_KEY = new Map(CONFIG_DESCRIPTORS.map((d) => [d.key, d]));
const DESCRIPTOR_BY_ENV = new Map(CONFIG_DESCRIPTORS.map((d) => [d.envName, d]));

export function getDescriptor(key: string): ConfigDescriptor | undefined {
  return DESCRIPTOR_BY_KEY.get(key);
}

export function getDescriptorByEnv(envName: string): ConfigDescriptor | undefined {
  return DESCRIPTOR_BY_ENV.get(envName);
}

/** Walk a descriptor's transitive `requires` chain (DAG; the registry chains are linear),
 *  returning every prerequisite key (excluding the key itself), nearest-first. Pure over
 *  CONFIG_DESCRIPTORS so the staged validator (apps/runtime) and the boot fail-safe
 *  (config-settings.ts) share one source of truth for the requires graph. */
export function transitiveRequires(key: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([key]);
  const queue = [...(getDescriptor(key)?.requires ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    queue.push(...(getDescriptor(next)?.requires ?? []));
  }
  return out;
}

/** A single value as a process actually holds it, sanitized for transport/storage.
 *  Secrets/complex values never carry their real value — only set/unset state. */
export interface RunningValue {
  value: string | number | boolean | null;
  masked?: boolean;
  state?: "set" | "unset";
}

/** A boot-apply override that could not be applied (invalid value, not a boot key, or
 *  it would break a merged invariant). Carried in the snapshot so the dashboard can
 *  surface "this override was ignored" per instance instead of silently dropping it. */
export interface SkippedOverride {
  key: string;
  reason: string;
}

export interface RunningSnapshot {
  schemaVersion: number;
  values: Record<string, RunningValue>;
  /** Boot-apply overrides this process rejected at start (see applyBootOverrides).
   *  Empty for a clean boot. v2 snapshot field. */
  skippedOverrides: SkippedOverride[];
}

function isPresent(raw: unknown): boolean {
  if (raw == null) return false;
  if (typeof raw === "string") return raw.length > 0;
  if (raw instanceof Map) return raw.size > 0;
  if (raw instanceof Set) return raw.size > 0;
  if (Buffer.isBuffer(raw)) return raw.length > 0;
  if (Array.isArray(raw)) return raw.length > 0;
  return true;
}

function toDisplayValue(raw: unknown): string | number | boolean | null {
  if (raw == null) return null;
  if (typeof raw === "boolean" || typeof raw === "number") return raw;
  if (typeof raw === "string") return raw;
  return String(raw);
}

/** Serialize the effective config a process is actually using into a sanitized,
 *  versioned snapshot. The SAME function is used by the heartbeat (so the stored
 *  running values are exactly what the process consumes) and is the only place
 *  secrets are reduced to set/unset before leaving the process. `skippedOverrides`
 *  carries any boot-apply overrides the process rejected at start (defaults to none;
 *  the heartbeat passes the boot-skipped list it captured in createAppContext). */
export function buildRunningSnapshot(
  config: AppConfig,
  skippedOverrides: readonly SkippedOverride[] = [],
): RunningSnapshot {
  const values: Record<string, RunningValue> = {};
  const source = config as unknown as Record<string, unknown>;

  for (const descriptor of CONFIG_DESCRIPTORS) {
    if (descriptor.kind === "alias") {
      // Alias env vars are coalesced into another field at load time and have no
      // independent running value; represent them as not-applicable.
      values[descriptor.key] = { value: null };
      continue;
    }

    const raw = descriptor.configField ? source[descriptor.configField as string] : undefined;

    if (descriptor.kind === "secret" || descriptor.kind === "complex") {
      values[descriptor.key] = { value: null, masked: true, state: isPresent(raw) ? "set" : "unset" };
      continue;
    }

    values[descriptor.key] = { value: toDisplayValue(raw) };
  }

  return {
    schemaVersion: RUNNING_SCHEMA_VERSION,
    values,
    skippedOverrides: skippedOverrides.map((entry) => ({ key: entry.key, reason: entry.reason })),
  };
}
