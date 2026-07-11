import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

const MIN_FANSLY_DM_DELAY_MS = 5000;

const optionalTrimmedStringSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return value;
}, z.string().min(1).optional());

const optionalPositiveIntSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return value;
}, z.coerce.number().int().positive().optional());

const optionalTelegramHourSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return value;
}, z.coerce.number().int().min(0).max(23).optional());

const booleanSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return value;
}, z.boolean());

// `true` trusts the whole x-forwarded-for chain, which lets a client spoof
// `request.ip` whenever any hop forwards client-supplied XFF (audit P-9).
// A hop count (e.g. "1" for the single TLS proxy) or an IP/CIDR allowlist
// narrows trust to the proxies actually in front of the API.
const trustProxySchema = z
  .string()
  .trim()
  .default("false")
  .transform((value) => {
    const normalized = value.toLowerCase();
    if (normalized === "" || normalized === "false") {
      return false;
    }
    if (normalized === "true") {
      return true;
    }
    if (/^\d+$/.test(normalized)) {
      return Number.parseInt(normalized, 10);
    }
    return value;
  });

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ENCRYPTION_KEY: z.string().min(1),
  APP_ENCRYPTION_KEY_RING: optionalTrimmedStringSchema,
  APP_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
  LOG_LEVEL: z.string().default("info"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(3000),
  TRUST_PROXY: trustProxySchema,
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  FANSLY_BASE_URL: z.string().url().default("https://apiv3.fansly.com/api/v1"),
  ONLYFANS_DM_POLLING_ENABLED: booleanSchema.default(false),
  SYNC_HTTP_TRACE_FILE: optionalTrimmedStringSchema,
  FANSLY_DEFAULT_DELAY_MS: optionalPositiveIntSchema,
  FANSLY_GLOBAL_DELAY_MS: optionalPositiveIntSchema,
  FANSLY_ACCOUNT_LOOKUP_DELAY_MS: optionalPositiveIntSchema,
  FOLLOWER_PAGE_DELAY_MS: z.coerce.number().int().positive().default(5000),
  FANSLY_DM_CONVERSATIONS_DELAY_MS: z.coerce.number().int().positive().default(5000),
  FANSLY_DM_MESSAGES_DELAY_MS: z.coerce.number().int().positive().default(5000),
  FANSLY_DM_DEEP_BACKFILL_ENABLED: booleanSchema.default(false),
  FANSLY_DM_DEEP_BACKFILL_MAX_REQUESTS_PER_RUN: z.coerce.number().int().min(0).default(1),
  FANSLY_DM_DEEP_BACKFILL_LIVE_REQUESTS_PER_DEEP: z.coerce.number().int().min(1).default(4),
  FANSLY_DM_DEEP_BACKFILL_CONTINUATION_DELAY_MS: z.coerce.number().int().min(0).default(0),
  FANSLY_DM_DEEP_BACKFILL_CONTINUATION_JITTER_MS: z.coerce.number().int().min(0).default(0),
  ONLYFANS_DEFAULT_DELAY_MS: z.coerce.number().int().positive().default(1000),
  SYNC_SHARED_RATE_LIMIT_ENABLED: booleanSchema.default(true),
  // Stage 28: on-box lake root for tiered Parquet exports (Q3 declined).
  LAKE_DIR: z.string().min(1).default("lake"),
  // Stage 26: class-aware egress pacer rollout mode. off = old policy only;
  // shadow = old policy enforces while the new pacer computes + logs the
  // diff; enforce = the new pacer paces (per-vendor cutover after the 48 h
  // shadow window).
  EGRESS_PACER_MODE: z.enum(["off", "shadow", "enforce"]).default("off"),
  SYNC_PAGE_EXECUTOR_CONCURRENCY: z.coerce.number().int().positive().default(4),
  TRANSACTION_LOOKBACK_DAYS: z.coerce.number().int().positive().default(7),
  TRANSACTION_RESCAN_CAP_DAYS: z.coerce.number().int().positive().default(30),
  SYNC_OBSERVABILITY_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  HEALTH_SYNC_LIGHT_MAX_AGE_MINUTES: z.coerce.number().int().positive().default(180),
  HEALTH_SYNC_FOLLOWER_MAX_AGE_MINUTES: z.coerce.number().int().positive().default(1080),
  HEALTH_SYNC_MONITORING_TOKEN: optionalTrimmedStringSchema,
  TELEGRAM_BOT_TOKEN: optionalTrimmedStringSchema,
  TELEGRAM_CHAT_ID: optionalTrimmedStringSchema,
  TELEGRAM_REPORT_HOUR: optionalTelegramHourSchema,
  TELEGRAM_PROXY_PAGE_LABEL: optionalTrimmedStringSchema,
  OFAPI_BASE_URL: z.string().url().default("https://app.onlyfansapi.com/api"),
  OFAPI_API_KEY: optionalTrimmedStringSchema,
  // Stage 1 retention stand-down: the webhook journal holds business facts; the
  // default matches the env so a missing env can never re-enable a short purge.
  OFAPI_EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(36500),
  OFAPI_EVENT_WORKER_REPLICAS: z.coerce.number().int().positive().default(1),
  OFAPI_DM_PROJECTION_ENABLED: booleanSchema.default(false),
  OFAPI_DM_SYNC_ENABLED: booleanSchema.default(false),
  OFAPI_DM_COLD_ARCHIVE_ENABLED: booleanSchema.default(false),
  FANSLY_FAN_EARNINGS_SYNC_ENABLED: booleanSchema.default(false),
  FANSLY_PURCHASE_HISTORY_SYNC_ENABLED: booleanSchema.default(false),
  FANSLY_NEW_STREAM_PAGE_ALLOWLIST: z.string().default(""),
  FANSLY_DEEP_BACKFILL_IGNORE_RETENTION_LIMIT: booleanSchema.default(false),
  OFAPI_DM_COLD_ARCHIVE_RETENTION_DAYS: z.coerce.number().int().positive().default(36500),
  OFAPI_REST_DELAY_MS: z.coerce.number().int().min(0).default(500),
  OFAPI_DM_BOOTSTRAP_MAX_REQUESTS_PER_RUN: z.coerce.number().int().min(1).default(25),
  OFAPI_DM_DAILY_CREDIT_BUDGET: z.coerce.number().int().min(1).default(500),
  OFAPI_CREDIT_FLOOR: z.coerce.number().int().min(0).default(500),
  OFAPI_DM_RECONCILE_INTERVAL_MINUTES: z.coerce.number().int().positive().default(360),
  OFAPI_ACCOUNT_HEALTH_ENABLED: booleanSchema.default(false),
  OFAPI_CREDIT_ALERT_THRESHOLD: z.coerce.number().int().min(0).default(1000),
  OFAPI_WEBHOOK_SILENCE_THRESHOLD_MINUTES: z.coerce.number().int().positive().default(720),
  OFAPI_CREDIT_LEDGER_ENABLED: booleanSchema.default(false),
  OFAPI_BURN_ALERT_CREDITS_PER_HOUR: z.coerce.number().int().min(0).default(300),
  OFAPI_CREDIT_MICRO_USD_PRICE: z.coerce.number().int().min(0).default(0),
  OFAPI_BALANCE_PING_ENABLED: booleanSchema.default(false),
  OFAPI_AUDIENCE_SYNC_ENABLED: booleanSchema.default(false),
  OFAPI_AUDIENCE_MAX_REQUESTS_PER_RUN: z.coerce.number().int().min(1).default(25),
  OFAPI_AUDIENCE_DAILY_CREDIT_BUDGET: z.coerce.number().int().min(1).default(300),
  OFAPI_BACKFILL_DAILY_CREDIT_BUDGET: z.coerce.number().int().min(1).default(200),
  OFAPI_CHARGEBACKS_RECONCILE_ENABLED: booleanSchema.default(false),
  OFAPI_FAN_IDENTITIES_SYNC_ENABLED: booleanSchema.default(false),
  OFAPI_AUDIENCE_SWEEP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(1440),
  OFAPI_PRESENCE_PROJECTION_ENABLED: booleanSchema.default(false),
  OFAPI_SPEND_PROJECTION_SHADOW_ENABLED: booleanSchema.default(false),
  OFAPI_SPEND_TRANSACTION_INGEST_ENABLED: booleanSchema.default(false),
  OFAPI_DESKTOP_READ_GATEWAY_ENABLED: booleanSchema.default(false),
  OFAPI_DESKTOP_COMMAND_OUTBOX_ENABLED: booleanSchema.default(false),
  OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED: booleanSchema.default(false),
  // W3.2 (decision #125): queued-only outbox rows older than this expire to
  // cancelled. Floor 60s so a typo can't cancel the whole queue instantly.
  OFAPI_QUEUED_COMMAND_TTL_MS: z.coerce.number().int().min(60_000).default(600_000),
  // Fast-reply freshness PR4: REST readthrough reconcile into the cold
  // archive (boot-applied staged flag; own verification window).
  OFAPI_DM_READTHROUGH_RECONCILE_ENABLED: booleanSchema.default(false),
  // Wave 2 corrections: the material!=emitted reconciler. OFF until the
  // fingerprint backfill has run on prod (preamble 1).
  OFAPI_DM_CORRECTIONS_RECONCILE_ENABLED: booleanSchema.default(false),
  // Stage 1 retention stand-down kill-switches (default OFF = no destruction).
  // Fast-reply freshness Wave 1: prune default OFF again — the hot table's
  // purchased_at/deleted_at feed the AI union read; the runtime coverage gate
  // stays for a deliberate re-enable.
  PAGE_DM_PRUNE_ENABLED: booleanSchema.default(false),
  // Stage 1 containment for forever-growing fact tables: the worker pages the
  // owner when server disk usage crosses this percentage.
  DISK_USAGE_ALERT_PERCENT: z.coerce.number().int().min(1).max(100).default(80),
  // Stage 2 chatter-read-scope fix: raw revenue/transaction routes require a
  // dashboard session role. "log" serves bearer-key hits but logs would-deny
  // (the 48 h observation mode); "enforce" refuses them with 403.
  REVENUE_ROUTE_ROLE_ENFORCEMENT: z.enum(["log", "enforce"]).default("log"),
  // Stage 19 declarative route authorization: "log" computes the middleware
  // verdict per request and logs divergence from the legacy in-handler guards
  // (the 48 h observation mode); "enforce" makes the declared policy deny
  // before any handler runs. Legacy guards stay in place either way until the
  // post-flip cleanup.
  AUTH_POLICY_ENFORCEMENT: z.enum(["log", "enforce"]).default("log"),
  // Stage 22 grants read-path flip: false = assignments table (legacy shadow,
  // dual-written); true = the access_grants projection. Flip only after the
  // prod parity diff is exactly zero.
  ACCESS_GRANTS_READ_ENABLED: booleanSchema.default(false),
  CHATMUSE_AI_GATEWAY_ENABLED: booleanSchema.default(false),
  CHATMUSE_AI_GATEWAY_DAILY_REQUEST_LIMIT: z.coerce.number().int().min(0).default(500),
  CHATMUSE_AI_GATEWAY_DAILY_MICRO_USD_LIMIT: z.coerce.number().int().min(0).default(10_000_000),
  CHATMUSE_AI_GATEWAY_REQUEST_MICRO_USD_LIMIT: z.coerce.number().int().min(0).default(5_000_000),
  CHATMUSE_AI_GATEWAY_FEATURE_DAILY_MICRO_USD_LIMITS: z.string().default("{}"),
  // Fast-reply freshness (Wave 1 PR3): AI transcript union-read mode. off =
  // archive only; shadow = union computed + manifested, archive served;
  // serve = union served (archive fallback on union error). LIVE-wired:
  // read per generation via loadEffectiveConfig — flips need no restart.
  // Keep the env at the default; the PATCH lane owns transitions (stepwise
  // up, any rollback), and clearing the override must resolve to off.
  AI_TRANSCRIPT_FRESH_UNION_MODE: z.enum(["off", "shadow", "serve"]).default("off"),
  // Fan-dossier context: which AI features read the stored fan profile into
  // their prompt. "none" = off (the SAFE default — enabling is a deliberate
  // post-deploy flip); "all" = trust the per-feature policy flag; otherwise a
  // CSV of feature keys narrows the policy set (staged rollout: fast-reply →
  // fast-reply,ping → all). LIVE-wired: read per generation.
  CHATMUSE_AI_FAN_PROFILE_CONTEXT_FEATURES: z.string().default("none"),
  CHATMUSE_AI_FAN_PROFILE_VOLATILE_MAX_AGE_DAYS: z.coerce.number().int().min(0).default(21),
  // DP 6-A time-bounded prompt declassification. Both values are required at
  // runtime; "none" is the fail-closed sentinel because empty live strings
  // are rejected by the generic override validator.
  CHATMUSE_AI_PROMPT_DEBUG_ECHO_USERS: z.string().trim().toLowerCase()
    .refine((value) => value === "none", {
      message: "prompt debug echo may be enabled only through the audited live-config API",
    })
    .default("none"),
  CHATMUSE_AI_PROMPT_DEBUG_ECHO_UNTIL: z.string().trim().toLowerCase()
    .refine((value) => value === "none", {
      message: "prompt debug echo may be enabled only through the audited live-config API",
    })
    .default("none"),
  OPENROUTER_API_KEY: z.string().optional(),
  ONLYFANS_TOP_SPENDERS_ENABLED: booleanSchema.default(false),
  ANTHROPIC_API_KEY: optionalTrimmedStringSchema,
  WB_CLOSING_LLM_ENABLED: booleanSchema.default(false),
  WB_CLOSING_LLM_MODEL: z.string().trim().min(1).default("claude-haiku-4-5"),
  WB_CLOSING_LLM_DAILY_CAP_MIN: z.coerce.number().int().positive().default(50),
  WB_CLOSING_LLM_DAILY_CAP_MAX: z.coerce.number().int().positive().default(400),
});

// Machine-readable list of every env var the schema understands. Exported so the
// config registry (config-registry.ts) can be parity-tested against the schema
// without reaching into Zod internals (see config-registry parity test).
export const ENV_CONFIG_KEYS = Object.keys(envSchema.shape) as Array<
  keyof typeof envSchema.shape
>;

export interface AppConfig {
  databaseUrl: string;
  encryptionKey: Buffer;
  encryptionKeyVersion: number;
  encryptionKeysByVersion: ReadonlyMap<number, Buffer>;
  logLevel: string;
  apiHost: string;
  apiPort: number;
  isProduction: boolean;
  trustProxy: boolean | number | string;
  sessionTtlDays: number;
  fanslyBaseUrl: string;
  onlyFansDmPollingEnabled?: boolean;
  syncHttpTraceFile: string | null;
  fanslyDefaultDelayMs: number;
  followerPageDelayMs: number;
  fanslyDmConversationsDelayMs: number;
  fanslyDmMessagesDelayMs: number;
  fanslyDmDeepBackfillEnabled?: boolean;
  fanslyDmDeepBackfillMaxRequestsPerRun?: number;
  fanslyDmDeepBackfillLiveRequestsPerDeep?: number;
  fanslyDmDeepBackfillContinuationDelayMs?: number;
  fanslyDmDeepBackfillContinuationJitterMs?: number;
  onlyFansDefaultDelayMs: number;
  syncSharedRateLimitEnabled: boolean;
  egressPacerMode: "off" | "shadow" | "enforce";
  lakeDir: string;
  syncPageExecutorConcurrency: number;
  transactionLookbackDays: number;
  transactionRescanCapDays: number;
  syncObservabilityRetentionDays: number;
  healthSyncLightMaxAgeMinutes: number;
  healthSyncFollowerMaxAgeMinutes: number;
  healthSyncMonitoringToken: string | null;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  telegramEnabled: boolean;
  telegramReportHourUtc: number;
  // Optional so existing AppConfig literals (tests, codegen) need not enumerate them;
  // loadConfig always populates them, so production behavior is exact.
  telegramProxyPageLabel?: string | null;
  ofapiBaseUrl?: string;
  ofapiApiKey?: string | null;
  ofapiEventRetentionDays?: number;
  ofapiEventWorkerReplicas?: number;
  ofapiDmProjectionEnabled?: boolean;
  ofapiDmSyncEnabled?: boolean;
  ofapiDmColdArchiveEnabled?: boolean;
  fanslyFanEarningsSyncEnabled?: boolean;
  fanslyPurchaseHistorySyncEnabled?: boolean;
  fanslyNewStreamPageAllowlist?: string;
  fanslyDeepBackfillIgnoreRetentionLimit?: boolean;
  ofapiDmColdArchiveRetentionDays?: number;
  ofapiRestDelayMs?: number;
  ofapiQueuedCommandTtlMs?: number;
  ofapiDmBootstrapMaxRequestsPerRun?: number;
  ofapiDmDailyCreditBudget?: number;
  ofapiCreditFloor?: number;
  ofapiDmReconcileIntervalMinutes?: number;
  ofapiAccountHealthEnabled?: boolean;
  ofapiCreditAlertThreshold?: number;
  ofapiWebhookSilenceThresholdMinutes?: number;
  ofapiCreditLedgerEnabled?: boolean;
  ofapiBurnAlertCreditsPerHour?: number;
  ofapiCreditMicroUsdPrice?: number;
  ofapiBalancePingEnabled?: boolean;
  ofapiAudienceSyncEnabled?: boolean;
  ofapiAudienceMaxRequestsPerRun?: number;
  ofapiAudienceDailyCreditBudget?: number;
  ofapiBackfillDailyCreditBudget?: number;
  ofapiChargebacksReconcileEnabled?: boolean;
  ofapiFanIdentitiesSyncEnabled?: boolean;
  ofapiAudienceSweepIntervalMinutes?: number;
  ofapiPresenceProjectionEnabled?: boolean;
  ofapiSpendProjectionShadowEnabled?: boolean;
  ofapiSpendTransactionIngestEnabled?: boolean;
  ofapiDesktopReadGatewayEnabled?: boolean;
  ofapiDesktopCommandOutboxEnabled?: boolean;
  ofapiDesktopCommandExecutionEnabled?: boolean;
  /** Fast-reply freshness PR4: readthrough reconcile (boot flag). */
  ofapiDmReadthroughReconcileEnabled?: boolean;
  /** Wave 2 corrections: the material!=emitted reconciler (boot flag). */
  ofapiDmCorrectionsReconcileEnabled?: boolean;
  pageDmPruneEnabled?: boolean;
  diskUsageAlertPercent?: number;
  revenueRouteRoleEnforcement?: "log" | "enforce";
  authPolicyEnforcement?: "log" | "enforce";
  accessGrantsReadEnabled?: boolean;
  chatMuseAiGatewayEnabled?: boolean;
  chatMuseAiGatewayDailyRequestLimit?: number;
  chatMuseAiGatewayDailyMicroUsdLimit?: number;
  chatMuseAiGatewayRequestMicroUsdLimit?: number;
  /** Stage 29: JSON object mapping feature -> daily micro-USD ceiling (global,
   * all principals). Absent feature = no per-feature ceiling. */
  chatMuseAiGatewayFeatureDailyMicroUsdLimits?: string;
  /** Fast-reply freshness PR3: AI transcript union-read mode (live-wired). */
  aiTranscriptFreshUnionMode?: "off" | "shadow" | "serve";
  /** Fan-dossier context allowlist: "all" (policy decides) | "none" | CSV of features (live-wired). */
  chatMuseAiFanProfileContextFeatures?: string;
  /** Dossier volatile-section age cutoff in days (live-wired). */
  chatMuseAiFanProfileVolatileMaxAgeDays?: number;
  /** CSV chatter usernames allowed to receive feature-lane prompt echoes. */
  chatMuseAiPromptDebugEchoUsers?: string;
  /** Mandatory ISO expiry for prompt echo; "none" disables. */
  chatMuseAiPromptDebugEchoUntil?: string;
  onlyFansTopSpendersEnabled?: boolean;
  anthropicApiKey?: string | null;
  openrouterApiKey?: string | null;
  wbClosingLlmEnabled?: boolean;
  wbClosingLlmModel?: string;
  wbClosingLlmDailyCapMin?: number;
  wbClosingLlmDailyCapMax?: number;
}

function hasConfiguredValue(value: string | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

function enforceFanslyDmDelayFloor(delayMs: number) {
  return Math.max(delayMs, MIN_FANSLY_DM_DELAY_MS);
}

export function resolveFanslyDefaultDelayEnvSource(env: NodeJS.ProcessEnv = process.env) {
  if (hasConfiguredValue(env.FANSLY_DEFAULT_DELAY_MS)) {
    return "FANSLY_DEFAULT_DELAY_MS" as const;
  }

  if (hasConfiguredValue(env.FANSLY_GLOBAL_DELAY_MS)) {
    return "FANSLY_GLOBAL_DELAY_MS" as const;
  }

  if (hasConfiguredValue(env.FANSLY_ACCOUNT_LOOKUP_DELAY_MS)) {
    return "FANSLY_ACCOUNT_LOOKUP_DELAY_MS" as const;
  }

  return null;
}

/** Concurrency > 1 is only safe when the shared rate limiter is on (the limiter is
 *  what keeps simultaneous workers from hammering an upstream past its budget). The
 *  boot check in bootstrap.ts throws on this; exposed here as a pure validator so the
 *  Stage B/C PATCH can reject the same combination before applying an override.
 *  Returns the boot error message when violated, else null. */
export function checkSyncConcurrencyInvariant(input: {
  pageExecutorConcurrency: number;
  sharedRateLimitEnabled: boolean;
}): string | null {
  if (input.pageExecutorConcurrency > 1 && !input.sharedRateLimitEnabled) {
    return "SYNC_PAGE_EXECUTOR_CONCURRENCY > 1 requires SYNC_SHARED_RATE_LIMIT_ENABLED=true";
  }
  return null;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { loadDotEnv?: boolean } = {},
): AppConfig {
  // Callers that pass an explicit env (tests, the registry parity check) can opt
  // out of merging the ambient .env file so the result is hermetic.
  if (options.loadDotEnv !== false) {
    loadDotEnv({
      processEnv: env,
      quiet: process.env.DOTENV_CONFIG_QUIET === "true",
    });
  }

  const parsed = envSchema.parse(env);
  const encryptionKey = parseEncryptionKey(parsed.APP_ENCRYPTION_KEY, "APP_ENCRYPTION_KEY");
  const encryptionKeysByVersion = parseEncryptionKeyRing(
    parsed.APP_ENCRYPTION_KEY_RING,
    parsed.APP_ENCRYPTION_KEY_VERSION,
    encryptionKey,
  );

  const fanslyDefaultDelayMs =
    parsed.FANSLY_DEFAULT_DELAY_MS ??
    parsed.FANSLY_GLOBAL_DELAY_MS ??
    parsed.FANSLY_ACCOUNT_LOOKUP_DELAY_MS ??
    2500;
  const telegramBotToken = parsed.TELEGRAM_BOT_TOKEN ?? null;
  const telegramChatId = parsed.TELEGRAM_CHAT_ID ?? null;
  const telegramEnabled = telegramBotToken !== null && telegramChatId !== null;

  return {
    databaseUrl: parsed.DATABASE_URL,
    encryptionKey,
    encryptionKeyVersion: parsed.APP_ENCRYPTION_KEY_VERSION,
    encryptionKeysByVersion,
    logLevel: parsed.LOG_LEVEL,
    apiHost: parsed.API_HOST,
    apiPort: parsed.API_PORT,
    isProduction: env.NODE_ENV === "production",
    trustProxy: parsed.TRUST_PROXY,
    sessionTtlDays: parsed.SESSION_TTL_DAYS,
    fanslyBaseUrl: parsed.FANSLY_BASE_URL,
    onlyFansDmPollingEnabled: parsed.ONLYFANS_DM_POLLING_ENABLED,
    syncHttpTraceFile: parsed.SYNC_HTTP_TRACE_FILE ?? null,
    fanslyDefaultDelayMs,
    followerPageDelayMs: parsed.FOLLOWER_PAGE_DELAY_MS,
    fanslyDmConversationsDelayMs: enforceFanslyDmDelayFloor(parsed.FANSLY_DM_CONVERSATIONS_DELAY_MS),
    fanslyDmMessagesDelayMs: enforceFanslyDmDelayFloor(parsed.FANSLY_DM_MESSAGES_DELAY_MS),
    fanslyDmDeepBackfillEnabled: parsed.FANSLY_DM_DEEP_BACKFILL_ENABLED,
    fanslyDmDeepBackfillMaxRequestsPerRun: parsed.FANSLY_DM_DEEP_BACKFILL_MAX_REQUESTS_PER_RUN,
    fanslyDmDeepBackfillLiveRequestsPerDeep: parsed.FANSLY_DM_DEEP_BACKFILL_LIVE_REQUESTS_PER_DEEP,
    fanslyDmDeepBackfillContinuationDelayMs: parsed.FANSLY_DM_DEEP_BACKFILL_CONTINUATION_DELAY_MS,
    fanslyDmDeepBackfillContinuationJitterMs: parsed.FANSLY_DM_DEEP_BACKFILL_CONTINUATION_JITTER_MS,
    onlyFansDefaultDelayMs: parsed.ONLYFANS_DEFAULT_DELAY_MS,
    syncSharedRateLimitEnabled: parsed.SYNC_SHARED_RATE_LIMIT_ENABLED,
    egressPacerMode: parsed.EGRESS_PACER_MODE,
    lakeDir: parsed.LAKE_DIR,
    syncPageExecutorConcurrency: parsed.SYNC_PAGE_EXECUTOR_CONCURRENCY,
    transactionLookbackDays: parsed.TRANSACTION_LOOKBACK_DAYS,
    transactionRescanCapDays: parsed.TRANSACTION_RESCAN_CAP_DAYS,
    syncObservabilityRetentionDays: parsed.SYNC_OBSERVABILITY_RETENTION_DAYS,
    healthSyncLightMaxAgeMinutes: parsed.HEALTH_SYNC_LIGHT_MAX_AGE_MINUTES,
    healthSyncFollowerMaxAgeMinutes: parsed.HEALTH_SYNC_FOLLOWER_MAX_AGE_MINUTES,
    healthSyncMonitoringToken: parsed.HEALTH_SYNC_MONITORING_TOKEN ?? null,
    telegramBotToken,
    telegramChatId,
    telegramEnabled,
    telegramReportHourUtc: parsed.TELEGRAM_REPORT_HOUR ?? 9,
    telegramProxyPageLabel: parsed.TELEGRAM_PROXY_PAGE_LABEL ?? null,
    ofapiBaseUrl: parsed.OFAPI_BASE_URL,
    ofapiApiKey: parsed.OFAPI_API_KEY ?? null,
    ofapiEventRetentionDays: parsed.OFAPI_EVENT_RETENTION_DAYS,
    ofapiEventWorkerReplicas: parsed.OFAPI_EVENT_WORKER_REPLICAS,
    ofapiDmProjectionEnabled: parsed.OFAPI_DM_PROJECTION_ENABLED,
    ofapiDmSyncEnabled: parsed.OFAPI_DM_SYNC_ENABLED,
    ofapiDmColdArchiveEnabled: parsed.OFAPI_DM_COLD_ARCHIVE_ENABLED,
    fanslyFanEarningsSyncEnabled: parsed.FANSLY_FAN_EARNINGS_SYNC_ENABLED,
    fanslyPurchaseHistorySyncEnabled: parsed.FANSLY_PURCHASE_HISTORY_SYNC_ENABLED,
    fanslyNewStreamPageAllowlist: parsed.FANSLY_NEW_STREAM_PAGE_ALLOWLIST,
    fanslyDeepBackfillIgnoreRetentionLimit: parsed.FANSLY_DEEP_BACKFILL_IGNORE_RETENTION_LIMIT,
    ofapiDmColdArchiveRetentionDays: parsed.OFAPI_DM_COLD_ARCHIVE_RETENTION_DAYS,
    ofapiRestDelayMs: parsed.OFAPI_REST_DELAY_MS,
    ofapiQueuedCommandTtlMs: parsed.OFAPI_QUEUED_COMMAND_TTL_MS,
    ofapiDmBootstrapMaxRequestsPerRun: parsed.OFAPI_DM_BOOTSTRAP_MAX_REQUESTS_PER_RUN,
    ofapiDmDailyCreditBudget: parsed.OFAPI_DM_DAILY_CREDIT_BUDGET,
    ofapiCreditFloor: parsed.OFAPI_CREDIT_FLOOR,
    ofapiDmReconcileIntervalMinutes: parsed.OFAPI_DM_RECONCILE_INTERVAL_MINUTES,
    ofapiAccountHealthEnabled: parsed.OFAPI_ACCOUNT_HEALTH_ENABLED,
    ofapiCreditAlertThreshold: parsed.OFAPI_CREDIT_ALERT_THRESHOLD,
    ofapiWebhookSilenceThresholdMinutes: parsed.OFAPI_WEBHOOK_SILENCE_THRESHOLD_MINUTES,
    ofapiCreditLedgerEnabled: parsed.OFAPI_CREDIT_LEDGER_ENABLED,
    ofapiBurnAlertCreditsPerHour: parsed.OFAPI_BURN_ALERT_CREDITS_PER_HOUR,
    ofapiCreditMicroUsdPrice: parsed.OFAPI_CREDIT_MICRO_USD_PRICE,
    ofapiBalancePingEnabled: parsed.OFAPI_BALANCE_PING_ENABLED,
    ofapiAudienceSyncEnabled: parsed.OFAPI_AUDIENCE_SYNC_ENABLED,
    ofapiAudienceMaxRequestsPerRun: parsed.OFAPI_AUDIENCE_MAX_REQUESTS_PER_RUN,
    ofapiAudienceDailyCreditBudget: parsed.OFAPI_AUDIENCE_DAILY_CREDIT_BUDGET,
    ofapiBackfillDailyCreditBudget: parsed.OFAPI_BACKFILL_DAILY_CREDIT_BUDGET,
    ofapiChargebacksReconcileEnabled: parsed.OFAPI_CHARGEBACKS_RECONCILE_ENABLED,
    ofapiFanIdentitiesSyncEnabled: parsed.OFAPI_FAN_IDENTITIES_SYNC_ENABLED,
    ofapiAudienceSweepIntervalMinutes: parsed.OFAPI_AUDIENCE_SWEEP_INTERVAL_MINUTES,
    ofapiPresenceProjectionEnabled: parsed.OFAPI_PRESENCE_PROJECTION_ENABLED,
    ofapiSpendProjectionShadowEnabled: parsed.OFAPI_SPEND_PROJECTION_SHADOW_ENABLED,
    ofapiSpendTransactionIngestEnabled: parsed.OFAPI_SPEND_TRANSACTION_INGEST_ENABLED,
    ofapiDesktopReadGatewayEnabled: parsed.OFAPI_DESKTOP_READ_GATEWAY_ENABLED,
    ofapiDesktopCommandOutboxEnabled: parsed.OFAPI_DESKTOP_COMMAND_OUTBOX_ENABLED,
    ofapiDesktopCommandExecutionEnabled: parsed.OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED,
    ofapiDmReadthroughReconcileEnabled: parsed.OFAPI_DM_READTHROUGH_RECONCILE_ENABLED,
    ofapiDmCorrectionsReconcileEnabled: parsed.OFAPI_DM_CORRECTIONS_RECONCILE_ENABLED,
    pageDmPruneEnabled: parsed.PAGE_DM_PRUNE_ENABLED,
    diskUsageAlertPercent: parsed.DISK_USAGE_ALERT_PERCENT,
    revenueRouteRoleEnforcement: parsed.REVENUE_ROUTE_ROLE_ENFORCEMENT,
    authPolicyEnforcement: parsed.AUTH_POLICY_ENFORCEMENT,
    accessGrantsReadEnabled: parsed.ACCESS_GRANTS_READ_ENABLED,
    chatMuseAiGatewayEnabled: parsed.CHATMUSE_AI_GATEWAY_ENABLED,
    chatMuseAiGatewayDailyRequestLimit: parsed.CHATMUSE_AI_GATEWAY_DAILY_REQUEST_LIMIT,
    chatMuseAiGatewayDailyMicroUsdLimit: parsed.CHATMUSE_AI_GATEWAY_DAILY_MICRO_USD_LIMIT,
    chatMuseAiGatewayRequestMicroUsdLimit: parsed.CHATMUSE_AI_GATEWAY_REQUEST_MICRO_USD_LIMIT,
    chatMuseAiGatewayFeatureDailyMicroUsdLimits: parsed.CHATMUSE_AI_GATEWAY_FEATURE_DAILY_MICRO_USD_LIMITS,
    aiTranscriptFreshUnionMode: parsed.AI_TRANSCRIPT_FRESH_UNION_MODE,
    chatMuseAiFanProfileContextFeatures: parsed.CHATMUSE_AI_FAN_PROFILE_CONTEXT_FEATURES,
    chatMuseAiFanProfileVolatileMaxAgeDays: parsed.CHATMUSE_AI_FAN_PROFILE_VOLATILE_MAX_AGE_DAYS,
    chatMuseAiPromptDebugEchoUsers: parsed.CHATMUSE_AI_PROMPT_DEBUG_ECHO_USERS,
    chatMuseAiPromptDebugEchoUntil: parsed.CHATMUSE_AI_PROMPT_DEBUG_ECHO_UNTIL,
    openrouterApiKey: parsed.OPENROUTER_API_KEY ?? null,
    onlyFansTopSpendersEnabled: parsed.ONLYFANS_TOP_SPENDERS_ENABLED,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY ?? null,
    // L2 only runs when explicitly enabled AND a key is present (safe by default).
    wbClosingLlmEnabled: parsed.WB_CLOSING_LLM_ENABLED && (parsed.ANTHROPIC_API_KEY ?? null) !== null,
    wbClosingLlmModel: parsed.WB_CLOSING_LLM_MODEL,
    wbClosingLlmDailyCapMin: parsed.WB_CLOSING_LLM_DAILY_CAP_MIN,
    wbClosingLlmDailyCapMax: parsed.WB_CLOSING_LLM_DAILY_CAP_MAX,
  };
}

function parseEncryptionKey(value: string, envVar: string): Buffer {
  const encryptionKey = Buffer.from(value, "base64");
  if (encryptionKey.length !== 32) {
    throw new Error(`${envVar} must decode to exactly 32 bytes`);
  }

  return encryptionKey;
}

function parseEncryptionKeyRing(
  rawValue: string | undefined,
  writeKeyVersion: number,
  writeKey: Buffer,
): ReadonlyMap<number, Buffer> {
  const keysByVersion = new Map<number, Buffer>();

  if (rawValue) {
    for (const entry of rawValue.split(",")) {
      const trimmedEntry = entry.trim();
      if (trimmedEntry.length === 0) {
        continue;
      }

      const separatorIndex = trimmedEntry.indexOf(":");
      if (separatorIndex <= 0 || separatorIndex === trimmedEntry.length - 1) {
        throw new Error(
          "APP_ENCRYPTION_KEY_RING entries must use the format version:base64",
        );
      }

      const versionText = trimmedEntry.slice(0, separatorIndex).trim();
      const keyText = trimmedEntry.slice(separatorIndex + 1).trim();
      const keyVersion = z.coerce.number().int().positive().parse(versionText);

      if (keysByVersion.has(keyVersion)) {
        throw new Error(`APP_ENCRYPTION_KEY_RING repeats key version ${keyVersion}`);
      }

      keysByVersion.set(
        keyVersion,
        parseEncryptionKey(keyText, `APP_ENCRYPTION_KEY_RING version ${keyVersion}`),
      );
    }
  }

  const existingWriteKey = keysByVersion.get(writeKeyVersion);
  if (existingWriteKey && !existingWriteKey.equals(writeKey)) {
    throw new Error(
      `APP_ENCRYPTION_KEY_RING version ${writeKeyVersion} conflicts with APP_ENCRYPTION_KEY_VERSION`,
    );
  }

  keysByVersion.set(writeKeyVersion, writeKey);
  return keysByVersion;
}
