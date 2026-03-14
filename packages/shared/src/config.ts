import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ENCRYPTION_KEY: z.string().min(1),
  APP_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
  LOG_LEVEL: z.string().default("info"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(3000),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  FANSLY_BASE_URL: z.string().url().default("https://apiv3.fansly.com/api/v1"),
  ONLYMONSTER_BASE_URL: z.string().url().default("https://omapi.onlymonster.ai"),
  SYNC_HTTP_TRACE_FILE: z.string().min(1).optional(),
  FANSLY_GLOBAL_DELAY_MS: z.coerce.number().int().positive().optional(),
  FANSLY_ACCOUNT_LOOKUP_DELAY_MS: z.coerce.number().int().positive().optional(),
  FOLLOWER_PAGE_DELAY_MS: z.coerce.number().int().positive().default(5000),
  SYNC_SHARED_RATE_LIMIT_ENABLED: z.preprocess((value) => {
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
  }, z.boolean().default(false)),
  TRANSACTION_LOOKBACK_DAYS: z.coerce.number().int().positive().default(7),
  TRANSACTION_RESCAN_CAP_DAYS: z.coerce.number().int().positive().default(30),
  SYNC_OBSERVABILITY_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  loadDotEnv();

  const parsed = envSchema.parse(env);
  const encryptionKey = Buffer.from(parsed.APP_ENCRYPTION_KEY, "base64");

  if (encryptionKey.length !== 32) {
    throw new Error("APP_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }

  const fanslyGlobalDelayMs =
    parsed.FANSLY_GLOBAL_DELAY_MS ??
    parsed.FANSLY_ACCOUNT_LOOKUP_DELAY_MS ??
    2500;

  return {
    databaseUrl: parsed.DATABASE_URL,
    encryptionKey,
    encryptionKeyVersion: parsed.APP_ENCRYPTION_KEY_VERSION,
    logLevel: parsed.LOG_LEVEL,
    apiHost: parsed.API_HOST,
    apiPort: parsed.API_PORT,
    sessionTtlDays: parsed.SESSION_TTL_DAYS,
    fanslyBaseUrl: parsed.FANSLY_BASE_URL,
    onlyMonsterBaseUrl: parsed.ONLYMONSTER_BASE_URL,
    syncHttpTraceFile: parsed.SYNC_HTTP_TRACE_FILE ?? null,
    fanslyGlobalDelayMs,
    followerPageDelayMs: parsed.FOLLOWER_PAGE_DELAY_MS,
    syncSharedRateLimitEnabled: parsed.SYNC_SHARED_RATE_LIMIT_ENABLED,
    transactionLookbackDays: parsed.TRANSACTION_LOOKBACK_DAYS,
    transactionRescanCapDays: parsed.TRANSACTION_RESCAN_CAP_DAYS,
    syncObservabilityRetentionDays: parsed.SYNC_OBSERVABILITY_RETENTION_DAYS,
  };
}
