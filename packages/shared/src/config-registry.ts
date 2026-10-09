// Single descriptor registry for every runtime config value. One row per env var
// (plus a few derived AppConfig fields). This is the keystone for the in-dashboard
// configuration surface: it drives the read-only view (Stage A), and later the
// editable overlay (Stage B) and staged-rollout flips (Stage C). Keeping it as
// pure data means the API can serialize it and the dashboard can render generically
// without hard-coding the flag list.
//
// `config.ts` stays the single source of the env schema; a parity test asserts this
// registry matches ENV_CONFIG_KEYS so the two can never silently drift.

import { OFAPI_MIRROR_BUDGET_DEFAULTS, type AppConfig } from "./config.ts";
import { FANSLY_PAUSE_MAX_MS, FANSLY_PAUSE_MIN_MS } from "./fansly-pause.ts";
import { agentExportPolicyValues } from "./types.ts";

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
  | "Agent";

export type ConfigKind =
  | "boolean" // on/off gate
  | "number"
  | "string"
  | "url"
  | "secret" // never displayed; only set/unset
  | "derived" // computed in loadConfig, no 1:1 env var
  | "complex"; // structured value (proxy object, key ring); set/unset only

/** never = ops-only (secrets/infra/SSRF-class); staged = gated rollout flips in a
 *  prescribed order (Stage C); editable = safe operational knob (Stage B). */
export type ConfigEditability = "never" | "staged" | "editable";

/** A scalar config override as stored in the overlay table. Editable descriptors are
 *  only ever boolean/number/string, so the override value is one of those three. */
export type ConfigOverrideValue = string | number | boolean;

/** The structure inside a string value that the generic checks cannot see. Each
 *  has one parser in chat-extension-settings.ts; validateConfigOverride rejects a
 *  value it does not parse. */
export type ConfigStringFormat =
  | "semver"
  | "chat-extension-features"
  | "chat-extension-host-bindings"
  | "chat-extension-receipt-profiles";

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
  /** Stable id. For a 1:1 env var this is the AppConfig field; for a derived value
   *  it is a unique camelCase id. Used as the key in serialized running values. */
  key: string;
  /** Env var name. For derived entries this is the underlying env hint (e.g.
   *  NODE_ENV) and is intentionally absent from ENV_CONFIG_KEYS. */
  envName: string;
  /** The AppConfig field this value lands in. */
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
  /** Included in cross-instance drift detection. False for secret/derived/complex
   *  values where a raw compare would be meaningless or unsafe. */
  comparable: boolean;
  /** Short note shown in the UI (e.g. clamping behavior or a boot invariant). */
  note?: string;
  min?: number;
  max?: number;
  /** What a number outside `min`/`max` gets. 'clamp' (the default) stores the
   *  nearest bound. 'reject' refuses the write with `belowMinError` /
   *  `aboveMaxError`, for a bound that is a rule rather than a convenience: a
   *  silently raised or lowered value would hide the mistake from the person who
   *  made it. The live overlay ignores a stored out-of-range value either way. */
  outOfRange?: "clamp" | "reject";
  /** Rejection text for a value below `min` (only with outOfRange 'reject'). The
   *  console shows server errors verbatim, so it is written for the owner. */
  belowMinError?: string;
  /** Rejection text for a value above `max` (only with outOfRange 'reject'). */
  aboveMaxError?: string;
  enumValues?: string[];
  /** A string value with inner structure (JSON, a version): a value that does not
   *  parse is REJECTED on write, never trimmed into shape. String kind only. */
  format?: ConfigStringFormat;
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
  // Fansly Sync Engine plan §2.1: the one owner pace setting, live, rejected (never
  // clamped) outside 2000..60000 ms. The env value goes through the same range at boot.
  { key: "fanslyDefaultDelayMs", envName: "FANSLY_DEFAULT_DELAY_MS", configField: "fanslyDefaultDelayMs", kind: "number", subsystem: "Fansly", label: "Fansly pause between requests (ms)", default: "2500", editability: EDITABLE, runtimeApply: "live", comparable: true, min: FANSLY_PAUSE_MIN_MS, max: FANSLY_PAUSE_MAX_MS, outOfRange: "reject", belowMinError: `Пауза между запросами Fansly не может быть меньше ${FANSLY_PAUSE_MIN_MS} мс: правило владельца — не чаще одного запроса страницы раз в 2 с. Ниже — только правкой кода.`, aboveMaxError: `Пауза больше ${FANSLY_PAUSE_MAX_MS} мс похожа на опечатку. Допустимо от ${FANSLY_PAUSE_MIN_MS} до ${FANSLY_PAUSE_MAX_MS} мс.`, costWarning: "Lowering reduces politeness against Fansly's unofficial API; raises ban/throttle risk.", note: `One pause for every Fansly page, ${FANSLY_PAUSE_MIN_MS}-${FANSLY_PAUSE_MAX_MS} ms. A value outside the range is rejected, never clamped.` },
  { key: "fanslyLiveOverlayReadPages", envName: "FANSLY_LIVE_OVERLAY_READ_PAGES", configField: "fanslyLiveOverlayReadPages", kind: "string", subsystem: "Fansly", label: "Fansly live overlay readers", default: "none", editability: EDITABLE, runtimeApply: "live", comparable: true, note: "Pages whose chatter routes (conversation messages and preview) and AI kernel context show socket messages before REST confirms them: comma-separated exact page labels, all, or none. none is the read kill-switch: those readers serve REST copies only, exactly as before. Agent Read and the archive routes stay REST-confirmed on every page." },
  { key: "fanslyRepliesRewalkCycleDays", envName: "FANSLY_REPLIES_REWALK_CYCLE_DAYS", configField: "fanslyRepliesRewalkCycleDays", kind: "number", subsystem: "Fansly", label: "Fansly replies re-walk cycle (days)", default: "14", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 1, max: 365, costWarning: "How old a post's last walk must be before the round-robin re-reads it. LOWERING it does not raise the request rate — the engine's pace sets that — it changes which posts the walk reads: a shorter cycle keeps re-reading recent posts and starves the never-walked tail." },
  // Arena "vanished chat" R5 (owner decisions Р1, Р2): the session-less public account reader in the `sync`
  // process. Off at rest; with no proxy of its own (`sync public-lookup proxy set`) it sends nothing either way.
  { key: "fanslyPublicLookupEnabled", envName: "FANSLY_PUBLIC_LOOKUP_ENABLED", configField: "fanslyPublicLookupEnabled", kind: "boolean", subsystem: "Fansly", label: "Fansly public account reader", default: "false", editability: EDITABLE, runtimeApply: "live", comparable: true, costWarning: "On, Hub asks Fansly WITHOUT any session whether fans' accounts exist, through the reader's own proxy (never a page's): at most 1 request a minute and 50 a day. The first 429, 401/403, network failure or unexpected answer stops it until the owner resumes it.", note: "Checks the partners of chats Fansly stopped serving, fans a page's lookup missed, and the owner's one-off re-check of the deleted marks; writes fans.public_checked_at/public_found (and takes a deleted mark off a found account). Read live on every pass." },
  { key: "fanslyPublicLookupBatchSize", envName: "FANSLY_PUBLIC_LOOKUP_BATCH_SIZE", configField: "fanslyPublicLookupBatchSize", kind: "number", subsystem: "Fansly", label: "Fansly public account reader: ids per request", default: "100", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 1, max: 100, outOfRange: "reject", belowMinError: "Публичная проверка спрашивает хотя бы один аккаунт за запрос (от 1 до 100).", aboveMaxError: "Больше 100 аккаунтов в одном запросе Fansly не принимает от приложения: допустимо от 1 до 100.", note: "Fansly ids asked in one session-less request, 1-100 (100 = the app's own batch). A smaller batch asks fewer fans per request; the request budget (1 a minute, 50 a day) does not change." },

  // ── Sync / OnlyFans ───────────────────────────────────────────────────────
  // The ONLYFANS_PUBLIC_PROFILE_* flags (and their boot-crash OR-invariant)
  // were deleted in W8.2 (A30, decision #133): the resolver module had zero
  // callers, so the flags could only ever crash boot, never enable anything.
  { key: "onlyFansDmPollingEnabled", envName: "ONLYFANS_DM_POLLING_ENABLED", configField: "onlyFansDmPollingEnabled", kind: "boolean", subsystem: "Sync", label: "OnlyFans DM polling (legacy)", default: "false", editability: STAGED, runtimeApply: "none", comparable: true, note: "Legacy polling path; superseded by the OFAPI webhook path." },
  { key: "syncHttpTraceFile", envName: "SYNC_HTTP_TRACE_FILE", configField: "syncHttpTraceFile", kind: "string", subsystem: "Sync", label: "Sync HTTP trace file", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: true, note: "Debug-only file path on the container." },
  { key: "syncHttpAttemptTraceStdout", envName: "SYNC_HTTP_ATTEMPT_TRACE_STDOUT", configField: "syncHttpAttemptTraceStdout", kind: "boolean", subsystem: "Sync", label: "Per-attempt HTTP trace on stdout", default: "false", editability: EDITABLE, runtimeApply: "none", comparable: true, costWarning: "Verbose per-attempt success traces were ~83% of worker log lines (~400 MB/day of container logs); leave off unless debugging.", note: "Off = only retries, failures, and attempts whose DB telemetry row was lost reach stdout. Read from boot config by the sync telemetry — applies after worker restart." },
  { key: "onlyFansDefaultDelayMs", envName: "ONLYFANS_DEFAULT_DELAY_MS", configField: "onlyFansDefaultDelayMs", kind: "number", subsystem: "Sync", label: "OnlyFans default delay (ms)", default: "1000", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, note: "Captured by the OnlyFans adapter at boot — applies after restart." },
  { key: "lakeDir", envName: "LAKE_DIR", configField: "lakeDir", kind: "string", subsystem: "Core", label: "Lake directory (Stage 28)", default: "lake", editability: NEVER, runtimeApply: "none", comparable: true, note: "On-box Parquet lake root for tiered partitions; captured at boot." },
  { key: "egressPacerMode", envName: "EGRESS_PACER_MODE", configField: "egressPacerMode", kind: "string", subsystem: "Sync", label: "Egress pacer mode (Stage 26)", default: "off", editability: EDITABLE, runtimeApply: "none", comparable: true, enumValues: ["off", "shadow", "enforce"], note: "Captured at boot by the OFAPI client — applies after restart. shadow logs the class-aware decision while the old policy enforces." },
  { key: "syncPageExecutorConcurrency", envName: "SYNC_PAGE_EXECUTOR_CONCURRENCY", configField: "syncPageExecutorConcurrency", kind: "number", subsystem: "Sync", label: "Page executor concurrency", default: "4", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Higher concurrency increases simultaneous external API pressure.", note: "How many pages the legacy page executor (OnlyFans) runs at once; OFAPI requests stay paced by the egress pacer. Captured at boot — applies after restart." },
  { key: "syncObservabilityRetentionDays", envName: "SYNC_OBSERVABILITY_RETENTION_DAYS", configField: "syncObservabilityRetentionDays", kind: "number", subsystem: "Sync", label: "Observability retention (days)", default: "30", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, destructive: true, costWarning: "Lowering permanently drops observability rows." },
  { key: "healthSyncLightMaxAgeMinutes", envName: "HEALTH_SYNC_LIGHT_MAX_AGE_MINUTES", configField: "healthSyncLightMaxAgeMinutes", kind: "number", subsystem: "Sync", label: "Health: light sync max age (min)", default: "180", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 1 },
  { key: "healthSyncMonitoringToken", envName: "HEALTH_SYNC_MONITORING_TOKEN", configField: "healthSyncMonitoringToken", kind: "secret", subsystem: "Security", label: "Health monitoring token", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false },
  { key: "onlyFansTopSpendersEnabled", envName: "ONLYFANS_TOP_SPENDERS_ENABLED", configField: "onlyFansTopSpendersEnabled", kind: "boolean", subsystem: "Sync", label: "OnlyFans top spenders", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#50", stagedOrder: 5, requires: ["ofapiPresenceProjectionEnabled"] },

  // ── Telegram ──────────────────────────────────────────────────────────────
  { key: "telegramBotToken", envName: "TELEGRAM_BOT_TOKEN", configField: "telegramBotToken", kind: "secret", subsystem: "Telegram", label: "Telegram bot token", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false, note: "Operational Telegram credentials are managed in Notifications, not here." },
  { key: "telegramChatId", envName: "TELEGRAM_CHAT_ID", configField: "telegramChatId", kind: "secret", subsystem: "Telegram", label: "Telegram chat ID", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false, note: "Managed in Notifications." },
  // Not editable here: this is only the env default. The operational report hour is
  // stored in telegram_settings and edited in Notifications — keeping it read-only
  // avoids two conflicting sources of truth (same rule as the Telegram secrets).
  { key: "telegramReportHourUtc", envName: "TELEGRAM_REPORT_HOUR", configField: "telegramReportHourUtc", kind: "number", subsystem: "Telegram", label: "Telegram report hour (UTC, default)", default: "9", editability: NEVER, runtimeApply: "none", comparable: true, min: 0, max: 23, note: "Default only; the operational value is managed in Notifications." },
  { key: "telegramProxyPageLabel", envName: "TELEGRAM_PROXY_PAGE_LABEL", configField: "telegramProxyPageLabel", kind: "string", subsystem: "Telegram", label: "Telegram proxy page", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: true, note: "Deprecated transition-only fallback, used only while the entire dedicated service-egress tuple is absent." },
  { key: "serviceEgressProxyUrl", envName: "SERVICE_EGRESS_PROXY_URL", configField: "serviceEgressProxyUrl", kind: "complex", subsystem: "Security", label: "Service egress proxy URL", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false, note: "SOCKS5 route shared by ElevenLabs and Telegram; all three service-egress values are boot-only and must be configured together." },
  { key: "serviceEgressProxyUsername", envName: "SERVICE_EGRESS_PROXY_USERNAME", configField: "serviceEgressProxyUsername", kind: "secret", subsystem: "Security", label: "Service egress proxy username", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false },
  { key: "serviceEgressProxyPassword", envName: "SERVICE_EGRESS_PROXY_PASSWORD", configField: "serviceEgressProxyPassword", kind: "secret", subsystem: "Security", label: "Service egress proxy password", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false },
  { key: "telegramEnabled", envName: "TELEGRAM_ENABLED", configField: "telegramEnabled", kind: "derived", subsystem: "Telegram", label: "Telegram enabled", default: "false", editability: NEVER, runtimeApply: "none", comparable: true, note: "Derived: bot token AND chat id both set." },

  // ── OFAPI ─────────────────────────────────────────────────────────────────
  // The host literal is intentionally NOT duplicated here — it stays pinned to the
  // OFAPI client and config.ts (D1 spend-tap guard). The effective value still shows
  // via the running snapshot at runtime.
  { key: "ofapiBaseUrl", envName: "OFAPI_BASE_URL", configField: "ofapiBaseUrl", kind: "url", subsystem: "OFAPI", label: "OFAPI base URL", default: "(OFAPI default base URL)", editability: NEVER, runtimeApply: "none", comparable: true, note: "Spend-tap host; pinned in code." },
  { key: "ofapiWebhookManagementScope", envName: "OFAPI_WEBHOOK_MANAGEMENT_SCOPE", configField: "ofapiWebhookManagementScope", kind: "string", enumValues: ["unknown", "team"], subsystem: "OFAPI", label: "Configured webhook visibility", default: "unknown", editability: NEVER, runtimeApply: "none", comparable: false, note: "Owner-confirmed team-wide management access; required before treating a missing resource as absent." },
  { key: "ofapiExpectedTeamSlug", envName: "OFAPI_EXPECTED_TEAM_SLUG", configField: "ofapiExpectedTeamSlug", kind: "string", subsystem: "OFAPI", label: "Expected OFAPI team slug", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false, note: "Independently confirmed team; stateful actions require credential preflight." },
  { key: "ofapiApiKey", envName: "OFAPI_API_KEY", configField: "ofapiApiKey", kind: "secret", subsystem: "OFAPI", label: "OFAPI API key", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false, note: "Single metered spend tap." },
  { key: "ofapiEventRetentionDays", envName: "OFAPI_EVENT_RETENTION_DAYS", configField: "ofapiEventRetentionDays", kind: "number", subsystem: "OFAPI", label: "OFAPI event retention (days)", default: "36500", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, destructive: true, costWarning: "Lowering deletes webhook journal rows — business facts (money events included). Stage 1 stand-down keeps this effectively-forever.", note: "Retention stand-down (kernel Stage 1): journal rows are kept effectively-forever until the ledger lands." },
  { key: "ofapiEventWorkerReplicas", envName: "OFAPI_EVENT_WORKER_REPLICAS", configField: "ofapiEventWorkerReplicas", kind: "number", subsystem: "OFAPI", label: "OFAPI event worker replicas", default: "1", editability: NEVER, runtimeApply: "none", comparable: true, min: 1, note: "Startup guard for settle-order fanout: values other than 1 are unsupported until the event fanout design is redesigned for HA." },
  { key: "ofapiDmProjectionEnabled", envName: "OFAPI_DM_PROJECTION_ENABLED", configField: "ofapiDmProjectionEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI DM projection", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#49", stagedOrder: 1, requires: [] },
  { key: "ofapiDmSyncEnabled", envName: "OFAPI_DM_SYNC_ENABLED", configField: "ofapiDmSyncEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI DM sync (REST)", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#49", stagedOrder: 2, requires: ["ofapiDmProjectionEnabled"], costWarning: "REST bootstrap/reconcile spends real OFAPI credits." },
  { key: "ofapiDmColdArchiveEnabled", envName: "OFAPI_DM_COLD_ARCHIVE_ENABLED", configField: "ofapiDmColdArchiveEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI DM cold archive", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#52", stagedOrder: 1, requires: ["ofapiDmProjectionEnabled"], note: "Forward-only cold archive for future message-shaped OFAPI webhooks; no historical bulk backfill." },
  { key: "ofapiDmColdArchiveRetentionDays", envName: "OFAPI_DM_COLD_ARCHIVE_RETENTION_DAYS", configField: "ofapiDmColdArchiveRetentionDays", kind: "number", subsystem: "OFAPI", label: "OFAPI DM archive retention (days)", default: "36500", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, destructive: true, costWarning: "Lowering can purge stored DM archive transcripts — business facts. Stage 1 stand-down keeps this effectively-forever.", note: "Retention stand-down (kernel Stage 1): archive rows are kept effectively-forever until the ledger lands." },
  { key: "ofapiRestDelayMs", envName: "OFAPI_REST_DELAY_MS", configField: "ofapiRestDelayMs", kind: "number", subsystem: "OFAPI", label: "OFAPI REST delay (ms)", default: "500", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 0, costWarning: "Lowering risks 429s / vendor throttling.", note: "Captured by the OFAPI client at boot — applies after restart." },
  { key: "ofapiDmBootstrapMaxRequestsPerRun", envName: "OFAPI_DM_BOOTSTRAP_MAX_REQUESTS_PER_RUN", configField: "ofapiDmBootstrapMaxRequestsPerRun", kind: "number", subsystem: "OFAPI", label: "OFAPI DM bootstrap max requests/run", default: "25", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Raising accelerates credit burn within the daily ceiling." },
  { key: "ofapiDmDailyCreditBudget", envName: "OFAPI_DM_DAILY_CREDIT_BUDGET", configField: "ofapiDmDailyCreditBudget", kind: "number", subsystem: "OFAPI", label: "OFAPI DM daily credit budget", default: "500", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Raises the daily real-money spend ceiling for DM sync." },
  { key: "ofapiMirrorGlobalDailyCreditBudget", envName: "OFAPI_MIRROR_GLOBAL_DAILY_CREDIT_BUDGET", configField: "ofapiMirrorGlobalDailyCreditBudget", kind: "number", subsystem: "OFAPI", label: "OF mirror global daily credit budget", default: String(OFAPI_MIRROR_BUDGET_DEFAULTS.globalDailyCreditBudget), editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Raises the global daily real-money stop-loss for governed mirror reads." },
  { key: "ofapiMirrorPrincipalDailyCallCap", envName: "OFAPI_MIRROR_PRINCIPAL_DAILY_CALL_CAP", configField: "ofapiMirrorPrincipalDailyCallCap", kind: "number", subsystem: "OFAPI", label: "OF mirror user daily read cap", default: String(OFAPI_MIRROR_BUDGET_DEFAULTS.principalDailyCallCap), editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Raises the daily number of governed OFAPI reads allowed per user." },
  { key: "ofapiMirrorPrincipalDailyCreditCap", envName: "OFAPI_MIRROR_PRINCIPAL_DAILY_CREDIT_CAP", configField: "ofapiMirrorPrincipalDailyCreditCap", kind: "number", subsystem: "OFAPI", label: "OF mirror user daily credit cap", default: String(OFAPI_MIRROR_BUDGET_DEFAULTS.principalDailyCreditCap), editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Raises the daily real-money OFAPI credit allowance per user." },
  { key: "ofapiCreditFloor", envName: "OFAPI_CREDIT_FLOOR", configField: "ofapiCreditFloor", kind: "number", subsystem: "OFAPI", label: "OFAPI credit floor", default: "500", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 0, costWarning: "Lowering removes the safety floor that parks spend when credits run low." },
  { key: "ofapiDmReconcileIntervalMinutes", envName: "OFAPI_DM_RECONCILE_INTERVAL_MINUTES", configField: "ofapiDmReconcileIntervalMinutes", kind: "number", subsystem: "OFAPI", label: "OFAPI DM reconcile interval (min)", default: "360", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 1, costWarning: "Shortening runs credit-spending reconciles more often." },
  { key: "ofapiAccountHealthEnabled", envName: "OFAPI_ACCOUNT_HEALTH_ENABLED", configField: "ofapiAccountHealthEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI account health", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#49", stagedOrder: 3, requires: ["ofapiDmSyncEnabled"] },
  { key: "ofapiBindingReconcileEnabled", envName: "OFAPI_BINDING_RECONCILE_ENABLED", configField: "ofapiBindingReconcileEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI binding reconcile", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#382", stagedOrder: 1, note: "Every 5 minutes: seeds the page's creator id from the roster, rebinds a page whose account died to the authenticated account of the same creator, and attaches same-creator accounts as historical custody (Decision 382)." },
  { key: "ofapiCreditAlertThreshold", envName: "OFAPI_CREDIT_ALERT_THRESHOLD", configField: "ofapiCreditAlertThreshold", kind: "number", subsystem: "OFAPI", label: "OFAPI low-credit alert threshold", default: "1000", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 0, costWarning: "Lowering silences the early low-credit warning." },
  { key: "ofapiWebhookSilenceThresholdMinutes", envName: "OFAPI_WEBHOOK_SILENCE_THRESHOLD_MINUTES", configField: "ofapiWebhookSilenceThresholdMinutes", kind: "number", subsystem: "OFAPI", label: "OFAPI webhook silence threshold (min)", default: "720", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 1 },
  { key: "ofapiWebhookAutoRedeliveryEnabled", envName: "OFAPI_WEBHOOK_AUTO_REDELIVERY_ENABLED", configField: "ofapiWebhookAutoRedeliveryEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI webhook auto-redelivery", default: "false", editability: EDITABLE, runtimeApply: "live", comparable: true, costWarning: "Each automatic redelivery is a billed OFAPI request (about 0.01 credit); the daily cap bounds the spend.", note: "H2, amends #265. After each delivery-history sweep, requests one provider redelivery per failed business webhook without a local receipt. Only failures after the switch is seen on, and only once the receiver is proven alive again; switching off forgets that moment. Never repeats a rejected or indeterminate request and pauses (15 min, doubling up to 6 h) after any request that is not accepted." },
  { key: "ofapiWebhookAutoRedeliveryDailyCap", envName: "OFAPI_WEBHOOK_AUTO_REDELIVERY_DAILY_CAP", configField: "ofapiWebhookAutoRedeliveryDailyCap", kind: "number", subsystem: "OFAPI", label: "OFAPI webhook auto-redelivery cap (per UTC day)", default: "1000", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 1, max: 1000, costWarning: "Raising it allows more billed automatic redeliveries per UTC day (1000 is about 10 credits).", note: "Counts automatic requests only; the manual limit of 20 per UTC day is separate. Reaching it opens the ofapi_burn_rate incident (auto_redelivery_cap) until the next UTC day." },
  { key: "ofapiMediaDailyCapCredits", envName: "OFAPI_MEDIA_DAILY_CAP_CREDITS", configField: "ofapiMediaDailyCapCredits", kind: "number", subsystem: "OFAPI", label: "OFAPI media download budget (credits per UTC day)", default: "100", editability: NEVER, runtimeApply: "none", comparable: true, min: 0, max: 100000, costWarning: "Raising it lets automatic desktop previews spend more OFAPI credits per UTC day; explicit clicks are counted but never blocked.", note: "Agency-wide budget for paid OFAPI media downloads (docs/runbooks/ofapi-media.md). Automatic previews pass only while used + price <= the cap; a click always passes and is logged over_cap. Env-only by owner decision: a change needs a redeploy." },
  { key: "ofapiCreditLedgerEnabled", envName: "OFAPI_CREDIT_LEDGER_ENABLED", configField: "ofapiCreditLedgerEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI credit ledger", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#50", stagedOrder: 1, requires: ["ofapiAccountHealthEnabled"] },
  { key: "ofapiBurnAlertCreditsPerHour", envName: "OFAPI_BURN_ALERT_CREDITS_PER_HOUR", configField: "ofapiBurnAlertCreditsPerHour", kind: "number", subsystem: "OFAPI", label: "OFAPI burn alert (credits/hr)", default: "300", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 0, costWarning: "Raising silences the runaway-spend alarm." },
  { key: "ofapiCreditMicroUsdPrice", envName: "OFAPI_CREDIT_MICRO_USD_PRICE", configField: "ofapiCreditMicroUsdPrice", kind: "number", subsystem: "OFAPI", label: "OFAPI credit price (micro-USD)", default: "0", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 0, note: "Display-only flat price per OFAPI credit for the credits dashboard's USD estimates. Micro-USD integer: 1,000,000 = $1.00, so 10,000 = $0.01/credit. 0 hides all USD estimates. Does not gate spend." },
  { key: "ofapiBalancePingEnabled", envName: "OFAPI_BALANCE_PING_ENABLED", configField: "ofapiBalancePingEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI balance ping", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#50", stagedOrder: 2, requires: ["ofapiCreditLedgerEnabled"], costWarning: "Free daily usage/balance read (0 OFAPI credits). Requires the credit ledger.", note: "Optional and default off; ledger enablement does not enable this probe." },
  { key: "ofapiAudienceSyncEnabled", envName: "OFAPI_AUDIENCE_SYNC_ENABLED", configField: "ofapiAudienceSyncEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI audience sync", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#50", stagedOrder: 3, requires: ["ofapiCreditLedgerEnabled"], costWarning: "Audience sweeps spend real OFAPI credits." },
  { key: "ofapiAudienceMaxRequestsPerRun", envName: "OFAPI_AUDIENCE_MAX_REQUESTS_PER_RUN", configField: "ofapiAudienceMaxRequestsPerRun", kind: "number", subsystem: "OFAPI", label: "OFAPI audience max requests/run", default: "25", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Raising accelerates credit burn." },
  { key: "ofapiAudienceDailyCreditBudget", envName: "OFAPI_AUDIENCE_DAILY_CREDIT_BUDGET", configField: "ofapiAudienceDailyCreditBudget", kind: "number", subsystem: "OFAPI", label: "OFAPI audience daily credit budget", default: "300", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Raises the daily real-money spend ceiling for audience sync." },
  { key: "ofapiAudienceSweepIntervalMinutes", envName: "OFAPI_AUDIENCE_SWEEP_INTERVAL_MINUTES", configField: "ofapiAudienceSweepIntervalMinutes", kind: "number", subsystem: "OFAPI", label: "OFAPI audience sweep interval (min)", default: "1440", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Shortening multiplies daily credit burn." },
  { key: "ofapiBackfillDailyCreditBudget", envName: "OFAPI_BACKFILL_DAILY_CREDIT_BUDGET", configField: "ofapiBackfillDailyCreditBudget", kind: "number", subsystem: "OFAPI", label: "OFAPI backfill daily credit budget", default: "200", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Raises the daily real-money spend ceiling for historical backfills." },
  { key: "ofapiChargebacksReconcileEnabled", envName: "OFAPI_CHARGEBACKS_RECONCILE_ENABLED", configField: "ofapiChargebacksReconcileEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI chargebacks reconcile", default: "false", editability: EDITABLE, runtimeApply: "boot", comparable: true, costWarning: "Daily reconcile spends OFAPI credits (backfill budget lane)." },
  { key: "ofapiLinkStatsReconcileEnabled", envName: "OFAPI_LINK_STATS_RECONCILE_ENABLED", configField: "ofapiLinkStatsReconcileEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI link stats reconcile", default: "false", editability: EDITABLE, runtimeApply: "boot", comparable: true, requires: ["ofapiCreditLedgerEnabled"], note: "Free stored-list reads: 0 OFAPI credits, hence no cost warning; the link_stats day quota is insurance in case the vendor starts charging. This is the only history of link counters: the vendor keeps running totals, so a snapshot missed while the flag is off cannot be backfilled. Run with the OFAPI credit ledger ON: with the ledger off the rest-guard falls back to the global day counter and the link-stats quota compares against ALL OFAPI spend, near-guaranteeing a block." },
  { key: "ofapiLinkStatsDailyCreditBudget", envName: "OFAPI_LINK_STATS_DAILY_CREDIT_BUDGET", configField: "ofapiLinkStatsDailyCreditBudget", kind: "number", subsystem: "OFAPI", label: "OFAPI link stats daily credit budget", default: "50", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 1, costWarning: "Insurance quota: link-stats reads are free (0 credits), so it binds only if the vendor starts charging for them; raising it raises that ceiling. Own day counter: link-stats and the backfill lane used by chargebacks cannot starve each other." },
  { key: "ofapiFanIdentitiesSyncEnabled", envName: "OFAPI_FAN_IDENTITIES_SYNC_ENABLED", configField: "ofapiFanIdentitiesSyncEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI fan identities (tracking/trial links)", default: "false", editability: EDITABLE, runtimeApply: "boot", comparable: true, costWarning: "Paid: 1 OFAPI credit per list page (up to 100 rows) of every tracking/trial link — each link's subscribers, each tracking link's spenders, and the link lists themselves — four sweeps a day (every 6 h), from the audience day budget." },
  { key: "ofapiPresenceProjectionEnabled", envName: "OFAPI_PRESENCE_PROJECTION_ENABLED", configField: "ofapiPresenceProjectionEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI presence projection", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#50", stagedOrder: 4, requires: ["ofapiAudienceSyncEnabled"] },
  { key: "ofapiSpendProjectionShadowEnabled", envName: "OFAPI_SPEND_PROJECTION_SHADOW_ENABLED", configField: "ofapiSpendProjectionShadowEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI spend shadow projection", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#51", stagedOrder: 1, requires: ["ofapiCreditLedgerEnabled"], note: "Shadow-only C3 comparison table; does not change revenue truth or desktop sweep cadence." },
  { key: "ofapiSpendTransactionIngestEnabled", envName: "OFAPI_SPEND_TRANSACTION_INGEST_ENABLED", configField: "ofapiSpendTransactionIngestEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI spend transaction ingest", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#51", stagedOrder: 2, requires: ["ofapiSpendProjectionShadowEnabled"], note: "C3 apply step: applies transactions.new projections (pending, settled, and reversed) into transactions and rollups; pending rows enter as pending state and transition in place when a terminal settled/reversed projection arrives. Also gates the REST transaction backfill --write path into the same truth table." },
  { key: "ofapiDesktopReadGatewayEnabled", envName: "OFAPI_DESKTOP_READ_GATEWAY_ENABLED", configField: "ofapiDesktopReadGatewayEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI desktop read gateway", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#54", stagedOrder: 1, requires: ["ofapiCreditLedgerEnabled"], costWarning: "Gateway reads spend real OFAPI credits.", note: "Read-only C6 custody slice. Desktop direct mode remains available until write commands and rollback are complete." },
  { key: "ofapiMirrorInteractiveCaptureEnabled", envName: "OFAPI_MIRROR_INTERACTIVE_CAPTURE_ENABLED", configField: "ofapiMirrorInteractiveCaptureEnabled", kind: "boolean", subsystem: "OFAPI", label: "OF mirror capture-first gateway", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#158", stagedOrder: 1, requires: ["ofapiDesktopReadGatewayEnabled"], costWarning: "Gateway reads become fail-closed on durable capture and share the governed credit cap.", note: "Canary gate for Decision #158. Off keeps the existing gateway path; on requires migration 0098." },
  { key: "ofapiMirrorBackgroundCaptureEnabled", envName: "OFAPI_MIRROR_BACKGROUND_CAPTURE_ENABLED", configField: "ofapiMirrorBackgroundCaptureEnabled", kind: "boolean", subsystem: "OFAPI", label: "OF mirror background capture", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#158", stagedOrder: 2, requires: ["ofapiMirrorInteractiveCaptureEnabled"], costWarning: "Drains explicitly-created history jobs and spends the bounded bulk credit budget.", note: "No self-seeding fleet crawl. Off leaves jobs durable and performs zero OFAPI calls." },
  { key: "ofapiExportArtifactDir", envName: "OFAPI_EXPORT_ARTIFACT_DIR", configField: "ofapiExportArtifactDir", kind: "string", subsystem: "OFAPI", label: "OF export artifact directory", default: "/var/lib/agency-hub/ofapi-export-artifacts", editability: NEVER, runtimeApply: "none", comparable: true, note: "Read-only container path for owner-captured OFAPI export artifacts; changing it requires a matching bind mount and restart." },
  { key: "ofapiMessageHistoryShadowEnabled", envName: "OFAPI_MESSAGE_HISTORY_SHADOW_ENABLED", configField: "ofapiMessageHistoryShadowEnabled", kind: "boolean", subsystem: "OFAPI", label: "OF certified history shadow", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#158", stagedOrder: 3, requires: ["ofapiMirrorInteractiveCaptureEnabled"], note: "Compares only explicit deep-history-v1 backward pages while the captured vendor response remains authoritative." },
  { key: "ofapiMessageHistoryDbFallbackEnabled", envName: "OFAPI_MESSAGE_HISTORY_DB_FALLBACK_ENABLED", configField: "ofapiMessageHistoryDbFallbackEnabled", kind: "boolean", subsystem: "OFAPI", label: "OF certified history DB + fallback", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#158", stagedOrder: 4, requires: ["ofapiMessageHistoryShadowEnabled"], note: "Serves certified deep-history-v1 pages from DB and uses one capture-first vendor fallback on a miss. No db-only mode before S5b." },
  { key: "ofapiDesktopCommandOutboxEnabled", envName: "OFAPI_DESKTOP_COMMAND_OUTBOX_ENABLED", configField: "ofapiDesktopCommandOutboxEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI desktop command outbox", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#55", stagedOrder: 1, requires: ["ofapiDesktopReadGatewayEnabled"], note: "C6b intake/read/cancel only. Enabling does not execute commands or call OFAPI." },
  { key: "ofapiDesktopCommandExecutionEnabled", envName: "OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED", configField: "ofapiDesktopCommandExecutionEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI desktop command execution", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#56", stagedOrder: 1, requires: ["ofapiDesktopCommandOutboxEnabled"], costWarning: "Executes real OFAPI sends and spends credits.", note: "C6b2 text-send executor. Enable only for a controlled production test fan after the outbox rollout is healthy." },
  { key: "ofapiQueuedCommandTtlMs", envName: "OFAPI_QUEUED_COMMAND_TTL_MS", configField: "ofapiQueuedCommandTtlMs", kind: "number", subsystem: "OFAPI", label: "OFAPI queued command TTL (ms)", default: "600000", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 60000, costWarning: "Raising re-opens the blind window where the kernel can execute a send the desktop has already stopped watching (desktop auto-stop = 10 min).", note: "W3.2 (decision #125): queued-only rows older than this expire to cancelled at each minutely sweep; read live per sweep, no restart." },
  { key: "ofapiDmCorrectionsReconcileEnabled", envName: "OFAPI_DM_CORRECTIONS_RECONCILE_ENABLED", configField: "ofapiDmCorrectionsReconcileEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI DM corrections reconciler", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#122", stagedOrder: 1, requires: [], note: "Wave 2 corrections: drains material!=emitted on dm_message_archive into the ledger (first events for REST/command-only rows; superseding events for advanced material). HARD PRECONDITION: run corrections:backfill-fingerprints FIRST — enabling before the backfill mass-appends redundant superseding events for the entire history." },
  { key: "ofapiDmReadthroughReconcileEnabled", envName: "OFAPI_DM_READTHROUGH_RECONCILE_ENABLED", configField: "ofapiDmReadthroughReconcileEnabled", kind: "boolean", subsystem: "OFAPI", label: "OFAPI DM readthrough reconcile", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#121", stagedOrder: 1, requires: [], note: "Fast-reply freshness PR4: chat-open readthroughs journal the widened v2 observation and reconcile into dm_message_archive (fill-absent merge; webhook-loss rate becomes measured). Deploy precondition: ofapiDmColdArchiveEnabled effectively ON." },
  { key: "pageDmPruneEnabled", envName: "PAGE_DM_PRUNE_ENABLED", configField: "pageDmPruneEnabled", kind: "boolean", subsystem: "Sync", label: "Page DM message prune", default: "false", editability: NEVER, runtimeApply: "none", comparable: true, destructive: true, note: "Fast-reply freshness Wave 1: default OFF — the hot table's purchased_at/deleted_at feed the AI union read (PPV upgrade + tombstone arms); pruning would silently remove them. Still gated at runtime on archive coverage when enabled." },
  { key: "diskUsageAlertPercent", envName: "DISK_USAGE_ALERT_PERCENT", configField: "diskUsageAlertPercent", kind: "number", subsystem: "Core", label: "Disk usage alert threshold (%)", default: "80", editability: NEVER, runtimeApply: "none", comparable: true, min: 1, max: 100, note: "Stage 1 containment: the worker's hourly check pages the owner when server disk usage crosses this percentage (fact tables now grow forever)." },
  { key: "diskUsageGatePercent", envName: "DISK_USAGE_GATE_PERCENT", configField: "diskUsageGatePercent", kind: "number", subsystem: "Core", label: "Disk usage OFAPI read-gate threshold (%)", default: "(unset: same as the alert percent)", editability: NEVER, runtimeApply: "none", comparable: true, min: 1, max: 100, note: "Decision 372: at this percentage the hourly check marks ofapi_storage_health_state breached and every OFAPI interactive read, capture job and collection read is refused with storage_unhealthy (the OnlyFans desktop goes OFFLINE for chat reads). Unset it equals the alert percent; set it ABOVE the alert to give the owner lead time between the page and the chatters losing reads. A value below the alert is clamped up to it." },
  { key: "revenueRouteRoleEnforcement", envName: "REVENUE_ROUTE_ROLE_ENFORCEMENT", configField: "revenueRouteRoleEnforcement", kind: "string", subsystem: "Security", label: "Revenue route role enforcement", default: "log", editability: NEVER, runtimeApply: "none", comparable: true, note: "Chatter-read-scope fix (kernel Stage 2): raw revenue/transaction routes require a dashboard session role. \"log\" serves bearer-key hits but logs would-deny; flip to \"enforce\" (403) after 48 h of clean logs." },
  { key: "authPolicyEnforcement", envName: "AUTH_POLICY_ENFORCEMENT", configField: "authPolicyEnforcement", kind: "string", subsystem: "Security", label: "Declarative route-auth enforcement", default: "log", editability: NEVER, runtimeApply: "none", comparable: true, note: "Kernel Stage 19: every route carries a declarative auth policy checked by one middleware. \"log\" only logs divergence between the declared verdict and the legacy in-handler guards; flip to \"enforce\" (deny before the handler) after 48 h of clean logs." },
  { key: "accessGrantsReadEnabled", envName: "ACCESS_GRANTS_READ_ENABLED", configField: "accessGrantsReadEnabled", kind: "boolean", subsystem: "Security", label: "Access-grants read path", default: "false", editability: NEVER, runtimeApply: "none", comparable: true, note: "Kernel Stage 22: false reads user_page_assignments (legacy shadow, dual-written); true reads the append-only access_grants projection. Flip only after the prod parity diff (grants:parity CLI) is exactly zero; the assignments table freezes at the flip." },
  { key: "accountLinksEnabled", envName: "ACCOUNT_LINKS_ENABLED", configField: "accountLinksEnabled", kind: "boolean", subsystem: "Security", label: "Account links (invite / password reset)", default: "true", editability: EDITABLE, runtimeApply: "live", comparable: true, note: "Decision 349 kill switch for the PUBLIC link routes: false makes /auth/links/inspect and /auth/links/redeem answer 404 while owners can still create links. Live — read per request, no restart." },
  { key: "chatMuseAiGatewayEnabled", envName: "CHATMUSE_AI_GATEWAY_ENABLED", configField: "chatMuseAiGatewayEnabled", kind: "boolean", subsystem: "ChatMuse", label: "ChatMuse AI gateway", default: "false", editability: STAGED, runtimeApply: "boot", comparable: true, stagedGroup: "#26", stagedOrder: 1, costWarning: "Routes chatter AI generations through core provider keys and spend ledger.", note: "Default-off C6c/R4 gateway route. Local desktop provider keys remain the rollback path until production validation passes." },
  { key: "chatMuseAiGatewayDailyRequestLimit", envName: "CHATMUSE_AI_GATEWAY_DAILY_REQUEST_LIMIT", configField: "chatMuseAiGatewayDailyRequestLimit", kind: "number", subsystem: "ChatMuse", label: "AI gateway daily request cap", default: "500", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 0, costWarning: "Raising allows more provider calls per chatter/page UTC day once gateway execution is enabled.", note: "Global guard used by the C6c gateway preflight; 0 blocks all provider attempts." },
  { key: "chatMuseAiGatewayDailyMicroUsdLimit", envName: "CHATMUSE_AI_GATEWAY_DAILY_MICRO_USD_LIMIT", configField: "chatMuseAiGatewayDailyMicroUsdLimit", kind: "number", subsystem: "ChatMuse", label: "AI gateway daily cost cap (micro-USD)", default: "10000000", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 0, costWarning: "Raising increases the daily Anthropic/OpenRouter spend ceiling per chatter/page once provider execution is enabled.", note: "10,000,000 micro-USD is $10.00. 0 blocks all provider attempts." },
  { key: "chatMuseAiGatewayRequestMicroUsdLimit", envName: "CHATMUSE_AI_GATEWAY_REQUEST_MICRO_USD_LIMIT", configField: "chatMuseAiGatewayRequestMicroUsdLimit", kind: "number", subsystem: "ChatMuse", label: "AI gateway per-request cost cap (micro-USD)", default: "5000000", editability: EDITABLE, runtimeApply: "none", comparable: true, min: 0, costWarning: "Raising allows a single provider call to reserve a larger worst-case Anthropic token budget.", note: "Per-request preflight guard; 5,000,000 micro-USD is $5.00. 0 blocks all provider attempts." },
  { key: "anthropicApiKey", envName: "ANTHROPIC_API_KEY", configField: "anthropicApiKey", kind: "secret", subsystem: "ChatMuse", label: "Anthropic API key", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false, note: "Key-gates the default-off ChatMuse AI gateway Anthropic provider." },
  { key: "openrouterApiKey", envName: "OPENROUTER_API_KEY", configField: "openrouterApiKey", kind: "secret", subsystem: "ChatMuse", label: "OpenRouter API key", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false, note: "Stage 29 second gateway provider; unset ships the provider implemented-but-unkeyed (worker restart picks up a new key)." },
  { key: "chatMuseAiGatewayFeatureDailyMicroUsdLimits", envName: "CHATMUSE_AI_GATEWAY_FEATURE_DAILY_MICRO_USD_LIMITS", configField: "chatMuseAiGatewayFeatureDailyMicroUsdLimits", kind: "string", subsystem: "ChatMuse", label: "AI gateway per-feature daily cost caps (JSON)", default: "{}", editability: EDITABLE, runtimeApply: "none", comparable: true, costWarning: "Raising a feature ceiling allows more daily provider spend for that feature across all principals.", note: "Stage 29: JSON object feature->micro-USD, e.g. {\"fan-summary\": 1000000}. Absent feature = no per-feature ceiling; global caps still apply." },
  { key: "aiTranscriptFreshUnionMode", envName: "AI_TRANSCRIPT_FRESH_UNION_MODE", configField: "aiTranscriptFreshUnionMode", kind: "string", subsystem: "ChatMuse", label: "AI transcript fresh-union mode", default: "off", editability: EDITABLE, runtimeApply: "live", comparable: true, enumValues: ["off", "shadow", "serve"], note: "Fast-reply freshness PR3. off = archive only (PERF rollback — shadow still runs the union query); shadow = union computed + manifested, archive served (correctness rollback); serve = union served, archive fallback on error. PATCH-only transitions: upward stepwise off→shadow→serve, any rollback allowed. Read per generation (live)." },
  { key: "chatMuseAiFanProfileContextFeatures", envName: "CHATMUSE_AI_FAN_PROFILE_CONTEXT_FEATURES", configField: "chatMuseAiFanProfileContextFeatures", kind: "string", subsystem: "ChatMuse", label: "AI fan-dossier context features", default: "none", editability: EDITABLE, runtimeApply: "live", comparable: true, note: "Which AI features inject the stored fan dossier (fan_profiles) into their prompt. Default \"none\" — a deploy never activates this by itself; ramp with a deliberate flip: \"fast-reply\" → \"fast-reply,ping\" → \"all\" (= trust the per-feature usesFanProfile policy). Read per generation (live); the lookup is fail-open — a miss or error never blocks generation." },
  { key: "chatMuseAiPromptDebugEchoEnabled", envName: "CHATMUSE_AI_PROMPT_DEBUG_ECHO_ENABLED", configField: "chatMuseAiPromptDebugEchoEnabled", kind: "boolean", subsystem: "ChatMuse", label: "AI prompt debug echo", default: "false", editability: EDITABLE, runtimeApply: "live", comparable: true, note: "Fleet-wide kill-switch: when ON, any chatter whose client advertises debug-input-v1 (i.e. is in debug mode) receives the EXACT assembled feature prompt — safety preamble, persona, templates, fan dossier — for a generation on a page they are authorized to access. This is a permanent DECLASSIFICATION of agency prompt IP from chatters, plus a large per-generation SSE frame + info log; leave it off unless deliberately debugging. Default off (deploy inert); enable via this audited switch. Read per generation (live)." },

  // ── Voice notes (ElevenLabs TTS) ──────────────────────────────────────────
  // Ships inert behind kill switches. The API key copies the ANTHROPIC_API_KEY
  // secret descriptor; the switches/budgets copy the #136 fan-profile pattern
  // (EDITABLE + live). NOTE: voiceNotesPageAllowlist FAILS CLOSED — empty = NO
  // pages enabled.
  // AI media describer (docs/runbooks/ai-media-describe.md): background image descriptions for chat prompts. Ships inert; all live.
  { key: "anthropicMediaApiKey", envName: "ANTHROPIC_MEDIA_API_KEY", configField: "anthropicMediaApiKey", kind: "secret", subsystem: "ChatMuse", label: "Anthropic media describer key", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false, note: "Optional separate key/workspace for the AI media describer (spend accounting, provider-side limit). Unset = the main Anthropic key; no automatic switch after a block or limit." },
  { key: "aiMediaDescribeEnabled", envName: "AI_MEDIA_DESCRIBE_ENABLED", configField: "aiMediaDescribeEnabled", kind: "boolean", subsystem: "ChatMuse", label: "AI media describer", default: "false", editability: EDITABLE, runtimeApply: "live", comparable: true, costWarning: "Enabling sends chat images (downscaled, in memory) to Anthropic for a short description; each costs about $0.003-0.006.", note: "Master switch. Off stops new describe calls within a minute and hides image notes from prompts; stored descriptions remain. Read live per sweep and per generation." },
  { key: "aiMediaDescribePagePolicies", envName: "AI_MEDIA_DESCRIBE_PAGE_POLICIES", configField: "aiMediaDescribePagePolicies", kind: "string", subsystem: "ChatMuse", label: "AI media describer pages (JSON)", default: "{}", editability: EDITABLE, runtimeApply: "live", comparable: true, note: "JSON keyed by exact page label: {\"since\": ISO, \"until\"?: ISO}. FAILS CLOSED: absent or malformed grants nothing. Only messages newer than since are described (no history); after until nothing new is sent, existing notes still serve." },
  { key: "aiMediaDescribeModel", envName: "AI_MEDIA_DESCRIBE_MODEL", configField: "aiMediaDescribeModel", kind: "string", subsystem: "ChatMuse", label: "AI media describer model", default: "anthropic:claude-sonnet-5", editability: EDITABLE, runtimeApply: "live", comparable: true, enumValues: ["anthropic:claude-sonnet-5", "anthropic:claude-haiku-4-5"], note: "Thinking is always off. A refused image is never retried on another model." },
  { key: "aiMediaDescribeDailyImageLimit", envName: "AI_MEDIA_DESCRIBE_DAILY_IMAGE_LIMIT", configField: "aiMediaDescribeDailyImageLimit", kind: "number", subsystem: "ChatMuse", label: "AI media describer images per day", default: "150", min: 0, max: 5000, editability: EDITABLE, runtimeApply: "live", comparable: true, costWarning: "Raising allows more images per UTC day to be sent to Anthropic.", note: "Agency-wide, per UTC day, reserved atomically before each send. 0 blocks all sends." },
  { key: "aiMediaDescribeDailyMicroUsdLimit", envName: "AI_MEDIA_DESCRIBE_DAILY_MICRO_USD_LIMIT", configField: "aiMediaDescribeDailyMicroUsdLimit", kind: "number", subsystem: "ChatMuse", label: "AI media describer cost per day (micro-USD)", default: "1000000", min: 0, max: 50000000, editability: EDITABLE, runtimeApply: "live", comparable: true, costWarning: "Raising increases the daily Anthropic spend ceiling of the describer.", note: "1,000,000 micro-USD is $1.00. Agency-wide per UTC day; worst-case cost is reserved before each send, a possibly-processed timeout keeps its reservation. 0 blocks all sends." },
  { key: "aiMediaDescribeLiveChatOnly", envName: "AI_MEDIA_DESCRIBE_LIVE_CHAT_ONLY", configField: "aiMediaDescribeLiveChatOnly", kind: "boolean", subsystem: "ChatMuse", label: "AI media describer: live chats only", default: "true", editability: EDITABLE, runtimeApply: "live", comparable: true, note: "On: fan media is described on arrival only in conversations with an AI generation in the last 7 days; elsewhere at the first generation that shows it. Off: every fan media on arrival." },
  { key: "aiMediaDescribeModelMedia", envName: "AI_MEDIA_DESCRIBE_MODEL_MEDIA", configField: "aiMediaDescribeModelMedia", kind: "string", subsystem: "ChatMuse", label: "AI media describer: creator media", default: "teasers", editability: EDITABLE, runtimeApply: "live", comparable: true, enumValues: ["teasers", "teasers+free"], note: "Creator media: PPV teasers (what the fan sees before buying) or teasers plus free non-PPV media. Paid PPV bodies are never described." },
  { key: "aiMediaDescribeLoopEnabled", envName: "AI_MEDIA_DESCRIBE_LOOP_ENABLED", configField: "aiMediaDescribeLoopEnabled", kind: "boolean", subsystem: "ChatMuse", label: "AI media describer: describe within seconds", default: "false", editability: EDITABLE, runtimeApply: "live", comparable: true, note: "The worker looks for due images every second and describes them at once instead of waiting for the minutely sweep. Same caps, lease and single slot; the minutely sweep stays as the fallback. Re-read every 15 seconds." },
  { key: "elevenLabsApiKey", envName: "ELEVENLABS_API_KEY", configField: "elevenLabsApiKey", kind: "secret", subsystem: "ChatMuse", label: "ElevenLabs API key", default: "(unset)", editability: NEVER, runtimeApply: "none", comparable: false, note: "Vendor TTS key for voice notes; unset ships the feature implemented-but-unkeyed (worker restart picks up a new key)." },
  { key: "voiceNotesEnabled", envName: "VOICE_NOTES_ENABLED", configField: "voiceNotesEnabled", kind: "boolean", subsystem: "ChatMuse", label: "Voice notes dispatch", default: "false", editability: EDITABLE, runtimeApply: "live", comparable: true, costWarning: "Enabling spends real ElevenLabs TTS characters per synthesis.", note: "Master dispatch kill-switch for voice-note synthesis; default off (deploy inert). Read live per request." },
  { key: "voiceNotesRetrievalEnabled", envName: "VOICE_NOTES_RETRIEVAL_ENABLED", configField: "voiceNotesRetrievalEnabled", kind: "boolean", subsystem: "ChatMuse", label: "Voice notes retrieval", default: "true", editability: EDITABLE, runtimeApply: "live", comparable: true, note: "Retrieval of already-synthesized voice notes is free; this switch exists to shut it off during an incident. Default on. Read live per request." },
  { key: "voiceNotesPageAllowlist", envName: "VOICE_NOTES_PAGE_ALLOWLIST", configField: "voiceNotesPageAllowlist", kind: "string", subsystem: "ChatMuse", label: "Voice notes page allowlist", default: "", editability: EDITABLE, runtimeApply: "live", comparable: true, note: "CSV of page labels allowed to synthesize voice notes. FAILS CLOSED: empty = NO pages enabled (the OPPOSITE of the Fansly new-stream allowlist, where empty = all). Ramp: add one page, watch, then widen. Read live per request." },
  { key: "voiceNotesDailyCharBudget", envName: "VOICE_NOTES_DAILY_CHAR_BUDGET", configField: "voiceNotesDailyCharBudget", kind: "number", subsystem: "ChatMuse", label: "Voice notes daily char budget (per page)", default: "5000", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 1, costWarning: "Raising the per-page/day character ceiling increases daily ElevenLabs spend." },
  { key: "voiceNotesGlobalDailyCharBudget", envName: "VOICE_NOTES_GLOBAL_DAILY_CHAR_BUDGET", configField: "voiceNotesGlobalDailyCharBudget", kind: "number", subsystem: "ChatMuse", label: "Voice notes global daily char budget", default: "20000", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 1, costWarning: "Raising the fleet-wide per-day character ceiling increases daily ElevenLabs spend." },
  { key: "voiceNotesScriptMaxChars", envName: "VOICE_NOTES_SCRIPT_MAX_CHARS", configField: "voiceNotesScriptMaxChars", kind: "number", subsystem: "ChatMuse", label: "Voice notes script max chars", default: "600", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 1, note: "Per-synthesis script length cap; longer scripts are rejected before any spend." },
  { key: "voiceNotesMaxConcurrentSyntheses", envName: "VOICE_NOTES_MAX_CONCURRENT_SYNTHESES", configField: "voiceNotesMaxConcurrentSyntheses", kind: "number", subsystem: "ChatMuse", label: "Voice notes max concurrent syntheses", default: "2", editability: EDITABLE, runtimeApply: "live", comparable: true, min: 1, note: "In-process synthesis limit for the single API process. Read live at admission; queued rows do not claim a dispatch lease until a slot opens." },

  // ── Agent Read Plane ──────────────────────────────────────────────────────
  // Slice 0a ships the schema, the vocabularies and these switches; no route
  // reads them yet. All live-wired, all inert by default: the deploy changes
  // nothing, and the owner ramps one switch per verification window (#70).
  { key: "agentReadPlaneMode", envName: "AGENT_READ_PLANE_MODE", configField: "agentReadPlaneMode", kind: "string", subsystem: "Agent", label: "Agent read plane mode", default: "off", editability: EDITABLE, runtimeApply: "live", comparable: true, enumValues: ["off", "read_only", "full"], note: "off = every agent route answers 503 agent_plane_disabled; read_only = routes serve but every conclusion carries the read_only_mode blocker (the ramp window); full = normal. Read per request (live)." },
  { key: "agentObservationsEnabled", envName: "AGENT_OBSERVATIONS_ENABLED", configField: "agentObservationsEnabled", kind: "boolean", subsystem: "Agent", label: "Agent observation reads", default: "false", editability: EDITABLE, runtimeApply: "live", comparable: true, note: "Own gate for the observation envelope/payload operations on top of the plane mode: these expose raw captured vendor material. Read per request (live)." },
  { key: "agentSearchBackend", envName: "AGENT_SEARCH_BACKEND", configField: "agentSearchBackend", kind: "string", subsystem: "Agent", label: "Agent search backend", default: "fts", editability: EDITABLE, runtimeApply: "live", comparable: true, enumValues: ["off", "fts", "fts_trgm"], note: "off = message search answers 503; fts = Postgres FTS over the GIN expression that already exists on message_archive; fts_trgm additionally needs the pg_trgm extension, which is a MANUAL owner DBA step outside the migration chain — absent at runtime the plane falls back to fts and says so in a caveat. Read per request (live)." },
  { key: "agentHydrationMode", envName: "AGENT_HYDRATION_MODE", configField: "agentHydrationMode", kind: "string", subsystem: "Agent", label: "Agent hydration mode", default: "off", editability: EDITABLE, runtimeApply: "live", comparable: true, enumValues: ["off", "request_only", "dispatch"], costWarning: "dispatch executes approved hydrations against the platforms and spends real vendor budget.", note: "off = hydration operations answer 503; request_only = requests can be filed and decided but nothing executes; dispatch = the executor drains approvals. Read per request (live)." },
  { key: "agentExportPolicyValue", envName: "AGENT_EXPORT_POLICY_VALUE", configField: "agentExportPolicyValue", kind: "string", subsystem: "Agent", label: "Export policy value", default: "no_raw_transcript_export_endpoint_yet", editability: EDITABLE, runtimeApply: "live", comparable: true, enumValues: [...agentExportPolicyValues], note: "The value served in exportPolicy. Widening the wire literal to this enum is a CODE deploy (clients validate successful responses against a vendored schema); only the VALUE flip is config, and only after every client has re-vendored the SDK. Flipping ahead of the fleet breaks clients in production." },
  { key: "fanslyReplayMode", envName: "FANSLY_REPLAY_MODE", configField: "fanslyReplayMode", kind: "string", subsystem: "Fansly", label: "Fansly observation replay mode", default: "off", editability: EDITABLE, runtimeApply: "live", comparable: true, enumValues: ["off", "shadow", "on"], note: "Local replay of parse_version-0 Fansly observations into facts; costs zero vendor credits. shadow = canonicalize into a count report and write nothing; on = write. The runner refuses outright when a partition in the replay window is detached." },
  { key: "retentionTieringEnabled", envName: "RETENTION_TIERING_ENABLED", configField: "retentionTieringEnabled", kind: "boolean", subsystem: "Core", label: "Scheduled retention tiering", default: "false", editability: EDITABLE, runtimeApply: "live", comparable: true, destructive: true, note: "Gates ONLY the scheduled 04:40 UTC tiering callback (the owner CLI tiering:run stays ungated — it is an explicit act). Default off: a detached month makes the agent read plane mint false capture floors and breaks an observation replay with the documented 23514 failure, so the window between a deploy and the owner's decision never opens. Read per cycle (live)." },
  { key: "captureCasDualWritePages", envName: "CAPTURE_CAS_DUAL_WRITE_PAGES", configField: "captureCasDualWritePages", kind: "string", subsystem: "Core", label: "Capture CAS dual-write pages", default: "", editability: EDITABLE, runtimeApply: "live", comparable: true, costWarning: "Every capture on a listed page also writes a content-addressed catalog row and body until the dedup starts collapsing repeats — expect a temporary DISK INCREASE on a box the whole G5 project exists to save space on. Ramp one page and watch the disk slope.", note: "G5 slice 1 canary bound AND switch in one setting. CSV of platform page IDS (numeric, not labels — the ids are what the capture seam holds without an extra lookup), or \"*\" for every page. EMPTY = FULLY OFF and the capture path is byte-identical to before the slice: no catalog write, no extra query. The inline bodies stay the authority either way; nothing reads the catalog to serve a payload yet. Published to each process by the runtime heartbeat, so a flip takes effect within one heartbeat interval (60s) with no restart and no extra query." },
  { key: "captureCasReadMode", envName: "CAPTURE_CAS_READ_MODE", configField: "captureCasReadMode", kind: "string", subsystem: "Core", label: "Capture CAS read mode", default: "inline", editability: EDITABLE, runtimeApply: "live", comparable: true, enumValues: ["inline", "shadow", "serve"], costWarning: "shadow and serve each add ONE catalog query per envelope that carries a reference — and list readers resolve row by row, so a replay page of 200 referenced rows costs 200 extra queries. The blast radius is bounded by the dual-write canary: an envelope with no reference costs nothing in any mode.", note: "G5 slice 2 read migration. inline = readers take the inline columns, exactly as before the slice, and the catalog is never touched (zero extra queries). shadow = callers still get the INLINE bytes, and the catalog copy is additionally read and compared octet-for-octet per read, counted, and logged on disagreement — a live, continuous version of the hourly parity job, and it can never change what a caller receives. serve = the catalog canonical body becomes the byte source callers get, falling back to inline silently on any failure (object/body missing, codec refusal, connection error). THE INLINE COLUMNS REMAIN THE AUTHORITY OF RECORD IN EVERY MODE — serve only changes where the bytes are fetched from, never what is true. PATCH-only transitions: upward stepwise inline->shadow->serve, any rollback allowed. Published to each process by the runtime heartbeat, so a flip lands within one heartbeat interval (60s) with no restart and no config read on a hot path." },
  { key: "captureCasPointerOnlyPages", envName: "CAPTURE_CAS_POINTER_ONLY_PAGES", configField: "captureCasPointerOnlyPages", kind: "string", subsystem: "Core", label: "Capture CAS pointer-only pages", default: "", editability: EDITABLE, runtimeApply: "live", comparable: true, destructive: true, costWarning: "THE ONLY FLAG IN THIS PROJECT A ROLLBACK DOES NOT UNDO. Turning it off resumes double-writing for NEW captures only; every row already written pointer-only keeps its body ONLY in the content-addressed catalog, forever — the envelope has no copy to go back to. List a page only after capture_cas_read_mode has served that page's traffic from the catalog through a full verification window.", note: "G5 slice 3c-1. CSV of platform page IDS or \"*\"; EMPTY = FULLY OFF and every capture writes both copies exactly as it does today. A listed page drops the INLINE body (observations.payload / sync_raw_payloads.response_payload stay SQL NULL) only when the catalog write for that capture ALREADY SUCCEEDED — so the page must also be in capture_cas_dual_write_pages, and any CAS failure (codec refusal, dead connection, page outside that canary) writes the inline body exactly as before. WORST CASE IS BOTH COPIES, NEVER NONE, and the database enforces it: a CHECK on both tables requires payload IS NOT NULL OR payload_object_id IS NOT NULL. A row whose inline body is NULL resolves from the catalog in EVERY read mode INCLUDING inline — the read mode governs byte-source PREFERENCE, not reachability — so rolling capture_cas_read_mode back cannot blank a pointer-only row. Published to each process by the runtime heartbeat (60s), no restart, no config read on the capture path." },

  // ── Chat extension (chat-extension docs/hub-pr-plan.md H-2b) ──────────────
  // The owner's switches for the hub's third client. Read per request (live) by
  // the bootstrap and by the server-side check of every client route, so a flip
  // needs no restart and every flip is a config_audit_log row. Every one rests
  // OFF. A JSON or version value that does not parse is rejected on write; one
  // that still reaches a process (a bad env value) turns the extension off.
  { key: "chatExtensionEnabled", envName: "CHAT_EXTENSION_ENABLED", configField: "chatExtensionEnabled", kind: "boolean", subsystem: "Core", label: "Chat extension master switch", default: "false", editability: EDITABLE, runtimeApply: "live", comparable: true, note: "Off = every chat-extension feature reads disabled on every page and every client route answers 409 client_feature_disabled; the bootstrap still answers 200. Read per request (live)." },
  { key: "chatExtensionFeatures", envName: "CHAT_EXTENSION_FEATURES", configField: "chatExtensionFeatures", kind: "string", subsystem: "Core", label: "Chat extension features", default: "{}", editability: EDITABLE, runtimeApply: "live", comparable: true, format: "chat-extension-features", note: "JSON {\"*\": {flag: true|false}, \"<page label>\": {…}}: a page's own value wins over \"*\"; a flag set nowhere is off; unknown flag names are ignored. Invalid JSON is rejected on write." },
  { key: "chatExtensionMinVersion", envName: "CHAT_EXTENSION_MIN_VERSION", configField: "chatExtensionMinVersion", kind: "string", subsystem: "Core", label: "Chat extension minimum version", default: "0.0.0", editability: EDITABLE, runtimeApply: "live", comparable: true, format: "semver", note: "MAJOR.MINOR.PATCH. A client route refuses an extension whose x-client-version (chat-extension/<version>) is lower or unreadable (409 client_feature_disabled, reason client_outdated); the bootstrap announces it." },
  { key: "chatExtensionHostBindings", envName: "CHAT_EXTENSION_HOST_BINDINGS", configField: "chatExtensionHostBindings", kind: "string", subsystem: "Core", label: "Chat extension host bindings", default: "{}", editability: EDITABLE, runtimeApply: "live", comparable: true, format: "chat-extension-host-bindings", note: "JSON {\"onlymonster:<account id>\": \"<page label>\"}: an explicit binding that wins over matching the page's platform account id. The bootstrap drops a binding to a page that is missing, inactive or not granted to the caller." },
  { key: "chatExtensionPreviewSendReceiptProfiles", envName: "CHAT_EXTENSION_PREVIEW_SEND_RECEIPT_PROFILES", configField: "chatExtensionPreviewSendReceiptProfiles", kind: "string", subsystem: "Core", label: "Chat extension preview-send receipt profiles", default: "[]", editability: EDITABLE, runtimeApply: "live", comparable: true, format: "chat-extension-receipt-profiles", note: "JSON array (at most 32) of {id, adapterVersion, modules: {role: fingerprint}}: the verified send paths of sending from the preview (X8). [] admits none, so X8 stays off." },
  // chat-extension H-4c: whether the fresh text a client reads off the open
  // OnlyFans chat (`liveTextContext`) joins the AI transcript. Rests OFF; a
  // page also needs its `freshText` flag in chatExtensionFeatures.
  { key: "aiLiveTextContextMode", envName: "AI_LIVE_TEXT_CONTEXT_MODE", configField: "aiLiveTextContextMode", kind: "string", subsystem: "ChatMuse", label: "AI fresh-text context mode", default: "off", editability: EDITABLE, runtimeApply: "live", comparable: true, enumValues: ["off", "shadow", "serve"], note: "chat-extension H-4c. off = the client's fresh text is ignored (the context frame says disabled; nothing is refused). shadow = merged with the hub's transcript and recorded in the generation's context manifest as ids and counts only, while the hub's own transcript serves. serve = the merged transcript serves and the generation is marked contextScope=principal-draft. PATCH-only transitions: upward stepwise off→shadow→serve, any rollback allowed. A page also needs its freshText flag. Read per generation (live)." },
  // chat-extension H-6: how deep the full Recap of an OnlyFans chat reads.
  // Rests at 1500, the AI readers' cap for every other caller.
  { key: "aiTranscriptDeepMaxRows", envName: "AI_TRANSCRIPT_DEEP_MAX_ROWS", configField: "aiTranscriptDeepMaxRows", kind: "string", subsystem: "ChatMuse", label: "AI full Recap transcript depth (messages)", default: "1500", editability: EDITABLE, runtimeApply: "live", comparable: true, enumValues: ["1500", "3000"], costWarning: "At 3000 a full Recap gives the model up to twice as many messages, so its input costs up to twice as much.", note: "chat-extension H-6. 1500 = the full Recap reads what every AI feature reads. 3000 = a full Recap (fan-summary, not the short mode) of an OnlyFans chat reads up to 3000 messages when the client advertises context-v1 and asks for them; the bootstrap announces the value as limits.deepMax. Short Recap, Review, Coach and every reply feature stay at 1500, as do clients without context-v1 and Fansly. Read per generation (live)." },
  // H-11b: the health intake's own switch, read per capture batch that carries
  // a client_health report and per bootstrap. It counts only while the master
  // switch is on.
  { key: "chatExtensionHealthIngestEnabled", envName: "CHAT_EXTENSION_HEALTH_INGEST_ENABLED", configField: "chatExtensionHealthIngestEnabled", kind: "boolean", subsystem: "Core", label: "Chat extension health reports", default: "false", editability: EDITABLE, runtimeApply: "live", comparable: true, note: "On (with the master switch on) = the bootstrap lists client-health-perf-v1 and the hub folds each client_health report into hourly rollups that hold no user; the report itself is never stored. Off = the extension keeps its reports to itself, and one that still arrives is accepted and dropped. Rollups already written stay." },
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
