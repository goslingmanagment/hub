import { assertRuntimeSchemaReady, createDb, createPool, getConfigOverrides, type Database } from "@agency_hub_core/db";
import { FanslyAdapter } from "@agency_hub_core/fansly";
import { OnlyFansAdapter } from "@agency_hub_core/onlyfans";
import type {
  FanslyAccount,
  FanslyAccountMeResponse,
  FanslyEarningsAccountsPageResponse,
  FanslyEarningsTransaction,
  FanslyFollower,
  FanslyGroupDetail,
  FanslyMessagesPageResponse,
  FanslyMessagingGroupsPageResponse,
  FanslyRequestContext,
  FanslySubscriber,
} from "@agency_hub_core/fansly";
import {
  applyBootOverrides,
  checkSyncConcurrencyInvariant,
  createLogger,
  loadConfig,
  resolveFanslyDefaultDelayEnvSource,
  type SkippedOverride,
} from "@agency_hub_core/shared";

import { createOfapiCreditSpendSink } from "./services/ofapi-credits.ts";
import type { OfapiClient } from "./services/ofapi.ts";
import { createOfapiClient } from "./services/ofapi.ts";
import type { AiGatewayProvider } from "./services/ai-gateway.ts";
import {
  createAnthropicAiGatewayProvider,
  createPageProxyAnthropicClientResolver,
} from "./services/ai-gateway-anthropic-provider.ts";
import type { ProviderAdapter } from "./services/provider.ts";

export type AdapterLike = ProviderAdapter<
  FanslyRequestContext,
  FanslyAccountMeResponse,
  FanslyAccount,
  FanslyEarningsTransaction,
  FanslySubscriber,
  FanslyFollower
> & {
  getMessagingGroupsPage(
    context: FanslyRequestContext,
    params: {
      offset?: number;
      limit?: number;
      sortOrder?: number;
      flags?: number;
      search?: string;
      subscriptionTierId?: string | null;
      listIds?: string | null;
    },
  ): Promise<FanslyMessagingGroupsPageResponse>;
  getGroupDetail(context: FanslyRequestContext, groupId: string): Promise<{
    parsed: FanslyGroupDetail;
    raw: FanslyGroupDetail;
  }>;
  getMessagesPage(
    context: FanslyRequestContext,
    params: {
      groupId: string;
      limit?: number;
      before?: string | null;
    },
  ): Promise<FanslyMessagesPageResponse>;
  getEarningsAccountsPage(
    context: FanslyRequestContext,
    params: {
      after?: Date | null;
      before?: Date | null;
    },
  ): Promise<FanslyEarningsAccountsPageResponse>;
  // Stage 6 replay-probe methods (read-only, loosely typed — Stage 16 hardens).
  getEarningsStatsAccountsPage(
    context: FanslyRequestContext,
    params: { correlationAccountId?: string | null; after?: Date | null; before?: Date | null },
  ): Promise<{ items: unknown; raw: unknown }>;
  getEarningsMonthlyStatsAccountsPage(
    context: FanslyRequestContext,
    params: { correlationAccountId?: string | null; after?: Date | null; before?: Date | null },
  ): Promise<{ items: unknown; raw: unknown }>;
  getMediaOrderHistoryPage(
    context: FanslyRequestContext,
    params: {
      accountIds?: string | null;
      accountMediaId?: string | null;
      accountMediaBundleId?: string | null;
      limit?: number;
    },
  ): Promise<{ items: unknown; raw: unknown }>;
  close?(): Promise<void>;
};

export interface AppContext {
  /** The env config with the staged ('boot') DB overrides applied (see
   *  applyBootOverrides). Equal to the raw env config when there are no boot overrides. */
  config: ReturnType<typeof loadConfig>;
  /** The PRE-boot-apply env config (raw `loadConfig()`), before any DB override merge.
   *  The staged validator uses this as the env baseline so the desired-graph it checks is
   *  built from the current DB overrides over the raw env — never the stale boot-applied
   *  `config`. Optional so existing AppContext literals (tests, codegen) need not provide
   *  it; createAppContext always populates it. */
  rawConfig?: ReturnType<typeof loadConfig>;
  /** Boot-apply overrides that were rejected at start (invalid value / not a boot key /
   *  merged-invariant violation). The heartbeat publishes these in its snapshot so the
   *  dashboard can surface an ignored override per instance. Empty for a clean boot.
   *  Optional so existing AppContext literals (tests, codegen) need not provide it;
   *  createAppContext always populates it, so production behavior is exact. */
  bootSkipped?: SkippedOverride[];
  logger: ReturnType<typeof createLogger>;
  pool: ReturnType<typeof createPool>;
  db: Database;
  adapter: AdapterLike;
  onlyFansAdapter: OnlyFansAdapter;
  // onlyfansapi.com management client; absent when OFAPI_API_KEY is not set
  // (admin webhook registration then 503s). Optional so existing AppContext
  // literals (tests, codegen) need not provide it.
  ofapi?: OfapiClient;
  // Provider execution is deliberately absent until the C6c provider slice wires
  // a real implementation. Tests may inject a fake provider to exercise SSE
  // plumbing without external network calls.
  aiGatewayProvider?: AiGatewayProvider;
  close(): Promise<void>;
}

export async function createAppContext(): Promise<AppContext> {
  // Env config. loadConfig runs its own boot invariants on the env values here. The
  // logger is built from the env logLevel (runtimeApply: 'none', never boot-applied).
  const rawConfig = loadConfig();
  const logger = createLogger(rawConfig.logLevel);

  const deprecatedFanslyDelayAlias = resolveFanslyDefaultDelayEnvSource(process.env);
  if (
    deprecatedFanslyDelayAlias &&
    deprecatedFanslyDelayAlias !== "FANSLY_DEFAULT_DELAY_MS"
  ) {
    logger.warn(
      { envVar: deprecatedFanslyDelayAlias },
      "Deprecated Fansly delay env var in use; prefer FANSLY_DEFAULT_DELAY_MS",
    );
  }

  const syncConcurrencyInvariantError = checkSyncConcurrencyInvariant({
    pageExecutorConcurrency: rawConfig.syncPageExecutorConcurrency,
    sharedRateLimitEnabled: rawConfig.syncSharedRateLimitEnabled,
  });
  if (syncConcurrencyInvariantError) {
    throw new Error(syncConcurrencyInvariantError);
  }

  const pool = createPool(rawConfig.databaseUrl);
  try {
    await assertRuntimeSchemaReady(pool);

    const db = createDb(pool);

    // Apply the staged ('boot') DB overrides onto the env config exactly once, before
    // anything reads config (adapters/OFAPI client/sink). A read or apply failure is
    // non-fatal: log and fall back to the env config so a DB hiccup can't wedge boot.
    // With no boot overrides in the DB this is a no-op and config === rawConfig.
    let bootSkipped: SkippedOverride[] = [];
    let config = rawConfig;
    try {
      const overrides = await getConfigOverrides(db);
      const applied = applyBootOverrides(rawConfig, overrides);
      config = applied.config;
      bootSkipped = applied.skipped;
    } catch (err) {
      // A DB read failure must not wedge boot — but it also must not skip the staged
      // requires-graph normalization. applyBootOverrides with NO overrides is pure (no I/O)
      // and still forces any invalid env-only dependent=on/prereq=off graph OFF, so boot can
      // never start an invalid graph even when the override read fails (e.g. a transient blip).
      logger.warn({ err }, "boot override read failed; normalizing env config without overrides");
      const applied = applyBootOverrides(rawConfig, new Map());
      config = applied.config;
      bootSkipped = applied.skipped;
    }

    const adapter = new FanslyAdapter({
      baseUrl: config.fanslyBaseUrl,
      globalDelayMs: config.fanslyDefaultDelayMs,
    });
    const onlyFansAdapter = new OnlyFansAdapter({
      baseUrl: config.onlyMonsterBaseUrl,
      defaultDelayMs: config.onlyFansDefaultDelayMs,
    });

    const ofapi = config.ofapiApiKey
      ? createOfapiClient({
        baseUrl: config.ofapiBaseUrl,
        apiKey: config.ofapiApiKey,
        restDelayMs: config.ofapiRestDelayMs,
        onCreditSpend: createOfapiCreditSpendSink({ db, logger, config }),
      })
      : undefined;
    const aiGatewayProvider = config.chatMuseAiGatewayEnabled && config.anthropicApiKey
      ? createAnthropicAiGatewayProvider({
        resolveClient: createPageProxyAnthropicClientResolver(config.anthropicApiKey),
      })
      : undefined;

    return {
      config,
      rawConfig,
      bootSkipped,
      logger,
      pool,
      db,
      adapter,
      onlyFansAdapter,
      ofapi,
      aiGatewayProvider,
      async close() {
        await adapter.close?.();
        await onlyFansAdapter.close();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
