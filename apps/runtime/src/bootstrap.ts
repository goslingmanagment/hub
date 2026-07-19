import { assertRuntimeSchemaReady, createDb, createPool, getConfigOverrides, type Database } from "@agency_hub_core/db";
import { FanslyAdapter } from "@agency_hub_core/fansly";
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
import { createEgressPacer } from "./services/egress/pacer.ts";
import { createOfapiClient } from "./services/ofapi.ts";
import type { AiGatewayProvider } from "./services/ai-gateway.ts";
import { createOpenrouterAiGatewayProvider } from "./services/ai-gateway-openrouter-provider.ts";
import {
  createAnthropicAiGatewayProvider,
  createPageProxyAnthropicClientResolver,
} from "./services/ai-gateway-anthropic-provider.ts";
import {
  createElevenLabsVoiceProvider,
  type VoiceTtsProvider,
} from "./services/voice-elevenlabs-provider.ts";
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
  rawConfig?: ReturnType<typeof loadConfig> | undefined;
  /** Boot-apply overrides that were rejected at start (invalid value / not a boot key /
   *  merged-invariant violation). The heartbeat publishes these in its snapshot so the
   *  dashboard can surface an ignored override per instance. Empty for a clean boot.
   *  Optional so existing AppContext literals (tests, codegen) need not provide it;
   *  createAppContext always populates it, so production behavior is exact. */
  bootSkipped?: SkippedOverride[] | undefined;
  logger: ReturnType<typeof createLogger>;
  pool: ReturnType<typeof createPool>;
  db: Database;
  adapter: AdapterLike;
  // onlyfansapi.com management client; absent when OFAPI_API_KEY is not set
  // (admin webhook registration then 503s). Optional so existing AppContext
  // literals (tests, codegen) need not provide it.
  ofapi?: OfapiClient | undefined;
  // Provider execution is deliberately absent until the C6c provider slice wires
  // a real implementation. Tests may inject a fake provider to exercise SSE
  // plumbing without external network calls.
  aiGatewayProvider?: AiGatewayProvider | undefined;
  // Stage 29: second provider ("openrouter:*" models route here); absent
  // when OPENROUTER_API_KEY is unset — implemented-but-unkeyed ships fine.
  aiGatewayOpenrouterProvider?: AiGatewayProvider | undefined;
  // Voice notes vendor TTS (ElevenLabs). Constructed whenever ELEVENLABS_API_KEY
  // is configured at boot — INDEPENDENT of the live voiceNotesEnabled flag,
  // which is a DB override bootstrap never sees. Undefined only when the key is
  // absent (admission then 503s voice_provider_unavailable). Non-platform,
  // direct vendor egress; spend is gated live by voiceNotesEnabled at admission.
  voiceTtsProvider?: VoiceTtsProvider | undefined;
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
    // anything reads config (adapters/OFAPI client/sink). With no boot overrides in
    // the DB this is a no-op and config === rawConfig.
    //
    // W5.5 (A31): a read failure used to fall back to env config — i.e. boot
    // with EVERY staged cutover flag silently off. A crash-looping container
    // is visible; a "healthy" api running pre-cutover code paths is not.
    // Retry the read (schema is already proven ready above, so failures here
    // are transient), then rethrow: fail closed, never fail open.
    const overrides = await (async () => {
      const attempts = 3;
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await getConfigOverrides(db);
        } catch (err) {
          if (attempt >= attempts) {
            logger.error({ err, attempts }, "boot override read failed after retries; refusing fail-open boot");
            throw err;
          }
          logger.warn({ err, attempt }, "boot override read failed; retrying");
          await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
        }
      }
    })();
    const applied = applyBootOverrides(rawConfig, overrides);
    const config = applied.config;
    const bootSkipped: SkippedOverride[] = applied.skipped;

    const adapter = new FanslyAdapter({
      baseUrl: config.fanslyBaseUrl,
      globalDelayMs: config.fanslyDefaultDelayMs,
    });
    const ofapi = config.ofapiApiKey
      ? createOfapiClient({
        baseUrl: config.ofapiBaseUrl,
        apiKey: config.ofapiApiKey,
        restDelayMs: config.ofapiRestDelayMs,
        onCreditSpend: createOfapiCreditSpendSink({ db, logger, config }),
        // Stage 26: off = legacy slot only; shadow computes + logs the
        // class-aware decision off-path; enforce cuts pacing over.
        pacer: config.egressPacerMode === "off"
          ? null
          : createEgressPacer({ config, db }, { vendor: "ofapi" }),
        onShadowDiff: (diff) => {
          logger.info({
            component: "egress_pacer_shadow",
            vendor: "ofapi",
            ...diff,
          }, "Egress pacer shadow decision");
        },
      })
      : undefined;
    const aiGatewayProvider = config.chatMuseAiGatewayEnabled && config.anthropicApiKey
      ? createAnthropicAiGatewayProvider({
        resolveClient: createPageProxyAnthropicClientResolver(config.anthropicApiKey),
      })
      : undefined;
    const aiGatewayOpenrouterProvider = config.chatMuseAiGatewayEnabled && config.openrouterApiKey
      ? createOpenrouterAiGatewayProvider({ apiKey: config.openrouterApiKey })
      : undefined;
    // Construct on API-KEY PRESENCE ALONE — deliberately NOT gated on
    // voiceNotesEnabled. That flag is a LIVE DB override with a default of
    // false; bootstrap only ever sees the env/boot config, so gating here would
    // wedge the provider undefined forever — flipping the live flag on (even
    // with a restart) could never build it, and admission would 503 in
    // perpetuity. The live admission gate (voice_disabled 403) is the spend
    // gate; a missing key is the only reason the provider stays inert.
    const voiceTtsProvider = config.elevenLabsApiKey
      ? createElevenLabsVoiceProvider({ apiKey: config.elevenLabsApiKey })
      : undefined;

    return {
      config,
      rawConfig,
      bootSkipped,
      logger,
      pool,
      db,
      adapter,
      ofapi,
      aiGatewayProvider,
      aiGatewayOpenrouterProvider,
      voiceTtsProvider,
      async close() {
        await adapter.close?.();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
