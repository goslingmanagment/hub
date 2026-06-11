import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

import { assertProxyTargetAllowed, normalizeProxyConfig } from "./proxy.ts";
import { parseProxyString } from "./proxy-string.ts";
import type { ProxyConfig } from "./types.ts";

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

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ENCRYPTION_KEY: z.string().min(1),
  APP_ENCRYPTION_KEY_RING: optionalTrimmedStringSchema,
  APP_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
  LOG_LEVEL: z.string().default("info"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(3000),
  TRUST_PROXY: booleanSchema.default(false),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  FANSLY_BASE_URL: z.string().url().default("https://apiv3.fansly.com/api/v1"),
  ONLYMONSTER_BASE_URL: z.string().url().default("https://omapi.onlymonster.ai"),
  ONLYFANS_PUBLIC_PROFILE_RESOLUTION_ENABLED: booleanSchema.default(false),
  ONLYFANS_PUBLIC_PROFILE_ALLOW_DIRECT: booleanSchema.default(false),
  ONLYFANS_PUBLIC_PROFILE_PROXY_URL: optionalTrimmedStringSchema,
  ONLYFANS_PUBLIC_PROFILE_MAX_PER_RUN: z.coerce.number().int().positive().default(5),
  ONLYFANS_PUBLIC_PROFILE_DELAY_MS: z.coerce.number().int().positive().default(30_000),
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
  OFAPI_BASE_URL: z.string().url().default("https://app.onlyfansapi.com/api"),
  OFAPI_API_KEY: optionalTrimmedStringSchema,
  OFAPI_EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  OFAPI_DM_PROJECTION_ENABLED: booleanSchema.default(false),
  ANTHROPIC_API_KEY: optionalTrimmedStringSchema,
  WB_CLOSING_LLM_ENABLED: booleanSchema.default(false),
  WB_CLOSING_LLM_MODEL: z.string().trim().min(1).default("claude-haiku-4-5"),
  WB_CLOSING_LLM_DAILY_CAP_MIN: z.coerce.number().int().positive().default(50),
  WB_CLOSING_LLM_DAILY_CAP_MAX: z.coerce.number().int().positive().default(400),
});

export interface AppConfig {
  databaseUrl: string;
  encryptionKey: Buffer;
  encryptionKeyVersion: number;
  encryptionKeysByVersion: ReadonlyMap<number, Buffer>;
  logLevel: string;
  apiHost: string;
  apiPort: number;
  isProduction: boolean;
  trustProxy: boolean;
  sessionTtlDays: number;
  fanslyBaseUrl: string;
  onlyMonsterBaseUrl: string;
  onlyFansPublicProfileResolutionEnabled?: boolean;
  onlyFansPublicProfileAllowDirect?: boolean;
  onlyFansPublicProfileProxy?: ProxyConfig | null;
  onlyFansPublicProfileMaxPerRun?: number;
  onlyFansPublicProfileDelayMs?: number;
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
  ofapiBaseUrl?: string;
  ofapiApiKey?: string | null;
  ofapiEventRetentionDays?: number;
  ofapiDmProjectionEnabled?: boolean;
  anthropicApiKey?: string | null;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  loadDotEnv({
    processEnv: env,
    quiet: process.env.DOTENV_CONFIG_QUIET === "true",
  });

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
  const onlyFansPublicProfileProxy = parseOnlyFansPublicProfileProxy(
    parsed.ONLYFANS_PUBLIC_PROFILE_PROXY_URL,
  );
  if (
    parsed.ONLYFANS_PUBLIC_PROFILE_RESOLUTION_ENABLED &&
    !parsed.ONLYFANS_PUBLIC_PROFILE_ALLOW_DIRECT &&
    !onlyFansPublicProfileProxy
  ) {
    throw new Error(
      "ONLYFANS_PUBLIC_PROFILE_PROXY_URL or ONLYFANS_PUBLIC_PROFILE_ALLOW_DIRECT=true is required when ONLYFANS_PUBLIC_PROFILE_RESOLUTION_ENABLED=true",
    );
  }
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
    onlyMonsterBaseUrl: parsed.ONLYMONSTER_BASE_URL,
    onlyFansPublicProfileResolutionEnabled: parsed.ONLYFANS_PUBLIC_PROFILE_RESOLUTION_ENABLED,
    onlyFansPublicProfileAllowDirect: parsed.ONLYFANS_PUBLIC_PROFILE_ALLOW_DIRECT,
    onlyFansPublicProfileProxy,
    onlyFansPublicProfileMaxPerRun: parsed.ONLYFANS_PUBLIC_PROFILE_MAX_PER_RUN,
    onlyFansPublicProfileDelayMs: parsed.ONLYFANS_PUBLIC_PROFILE_DELAY_MS,
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
    ofapiBaseUrl: parsed.OFAPI_BASE_URL,
    ofapiApiKey: parsed.OFAPI_API_KEY ?? null,
    ofapiEventRetentionDays: parsed.OFAPI_EVENT_RETENTION_DAYS,
    ofapiDmProjectionEnabled: parsed.OFAPI_DM_PROJECTION_ENABLED,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY ?? null,
    // L2 only runs when explicitly enabled AND a key is present (safe by default).
    wbClosingLlmEnabled: parsed.WB_CLOSING_LLM_ENABLED && (parsed.ANTHROPIC_API_KEY ?? null) !== null,
    wbClosingLlmModel: parsed.WB_CLOSING_LLM_MODEL,
    wbClosingLlmDailyCapMin: parsed.WB_CLOSING_LLM_DAILY_CAP_MIN,
    wbClosingLlmDailyCapMax: parsed.WB_CLOSING_LLM_DAILY_CAP_MAX,
  };
}

function parseOnlyFansPublicProfileProxy(rawValue: string | undefined) {
  if (!rawValue) {
    return null;
  }

  const parsed = parseProxyString(rawValue);
  if (!parsed) {
    return null;
  }

  const normalized = normalizeProxyConfig(parsed);
  assertProxyTargetAllowed(normalized);
  return normalized;
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
