import { ofapiCollectionPolicyHooks } from "./services/ofapi-collection-policy.ts";
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
  FanslyPostsPageResponse,
  FanslyPostTipsResponse,
  FanslyTrackingLinksResponse,
  FanslyRequestContext,
  FanslySubscriber,
} from "@agency_hub_core/fansly";
import {
  applyBootOverrides,
  checkSyncConcurrencyInvariant,
  createLogger,
  loadConfig,
  listIgnoredFanslyEndpointPauseEnv,
  resolveFanslyDefaultDelayEnvSource,
  type SkippedOverride,
} from "@agency_hub_core/shared";

import { createOfapiCreditSpendSink } from "./services/ofapi-credits.ts";
import type { OfapiClient } from "./services/ofapi.ts";
import { createEgressPacer } from "./services/egress/pacer.ts";
import { hasServiceEgressProxy } from "./services/egress/service-proxy.ts";
import { ofapiCredentialPolicy } from "./services/ofapi-credential-policy.ts";
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
import {
  createFanslySendGuards,
  type FanslySendGuardRegistry,
  type FanslySendHolderRole,
} from "./services/fansly-send-guard/index.ts";

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
  getPostsPage(
    context: FanslyRequestContext,
    accountId: string,
    params?: {
      before?: string | null;
      wallId?: string | null;
      pageIndex?: number;
    },
  ): Promise<FanslyPostsPageResponse>;
  /** WP-F6 — `GET /post?ids=<csv>`, the engagement refresh phase's only egress.
   *  Same envelope as the timeline, so it journals under the existing `posts`
   *  kind and the v6 family parses it with no new branch. */
  getPostsByIds(
    context: FanslyRequestContext,
    ids: string[],
  ): Promise<FanslyPostsPageResponse>;
  getTipsByTargetIds(
    context: FanslyRequestContext,
    targetIds: string[],
  ): Promise<FanslyPostTipsResponse>;
  getEarningsAccountsPage(
    context: FanslyRequestContext,
    params: {
      after?: Date | null;
      before?: Date | null;
    },
  ): Promise<FanslyEarningsAccountsPageResponse>;
  /** `/trackinglinks` — cumulative promo-link counters (WP-F1 step 5). */
  getTrackingLinks(context: FanslyRequestContext): Promise<FanslyTrackingLinksResponse>;

  // WP-F1: the `stats_snapshot` lane. Loosely typed in and out on purpose —
  // the handler journals before it asserts, so a typed parse here would refuse
  // bytes DP 7 requires us to keep.
  // `year`/`month` are the named-month form (1–12); 0/0 — the default — means
  // "read the bounds". The bounds are honoured only inside the route's own
  // trailing window, so every window OLDER than that is asked for by month.
  getAccountStats(
    context: FanslyRequestContext,
    params: {
      beforeDate: Date;
      afterDate: Date;
      periodMs: number;
      year?: number;
      month?: number;
    },
  ): Promise<{ items: unknown; raw: unknown }>;
  getMediaOfferStats(
    context: FanslyRequestContext,
    params: { mediaOfferId: string; beforeDate: Date; afterDate: Date; periodMs: number },
  ): Promise<{ items: unknown; raw: unknown }>;
  getEarningsStatsWindow(
    context: FanslyRequestContext,
    params: { before: Date; after: Date; limit?: number | null; offset?: number | null },
  ): Promise<{ items: unknown; raw: unknown }>;
  getEarningsMonthlyStats(
    context: FanslyRequestContext,
    params?: { before?: Date | null; after?: Date | null },
  ): Promise<{ items: unknown; raw: unknown }>;
  getDiscoveryMediaSuggestions(
    context: FanslyRequestContext,
    params: { limit?: number | null; before?: number | null; offset?: number | null },
  ): Promise<{ items: unknown; raw: unknown }>;

  // WP-F2: the `notifications` lane. `before` is a NOTIFICATION ID, not a
  // timestamp; `types` omitted is the unfiltered form A1 asks for.
  getNotificationsPage(
    context: FanslyRequestContext,
    params: { before?: string | null; after?: string | null; types?: readonly number[] | null },
  ): Promise<{ items: unknown; raw: unknown }>;

  // WP-F3: the `catalog` lane. Loosely typed in and out — every one of these
  // responses is journaled BEFORE anything asserts a shape about it.
  getVaultAlbums(context: FanslyRequestContext): Promise<{ items: unknown; raw: unknown }>;
  getUserVaultAlbums(
    context: FanslyRequestContext,
    params: { accountId: string },
  ): Promise<{ items: unknown; raw: unknown }>;
  getSubscriptionTiers(context: FanslyRequestContext): Promise<{ items: unknown; raw: unknown }>;
  getGiftCodes(context: FanslyRequestContext): Promise<{ items: unknown; raw: unknown }>;
  getAutomatedMessages(context: FanslyRequestContext): Promise<{ items: unknown; raw: unknown }>;
  // `before`/`after` are the LITERAL string "0" on the first page (§ the app
  // bundle); `mediaType` is present and empty when unfiltered.
  getVaultMediaPage(
    context: FanslyRequestContext,
    params: {
      albumId?: string | null;
      type?: number | null;
      mediaType?: string | null;
      before?: string | null;
      after?: string | null;
      search?: string | null;
    },
  ): Promise<{ items: unknown; raw: unknown }>;
  getAccountMediaByIds(
    context: FanslyRequestContext,
    params: { ids: string },
  ): Promise<{ items: unknown; raw: unknown }>;
  getAccountMediaBundlesByIds(
    context: FanslyRequestContext,
    params: { ids: string },
  ): Promise<{ items: unknown; raw: unknown }>;
  getAccountWalls(
    context: FanslyRequestContext,
    params: { correlationPostIds?: string | null },
  ): Promise<{ items: unknown; raw: unknown }>;

  // WP-F7 — the payouts lane. Two routes, both GET, both loosely typed: the
  // body is journaled before anything asserts on its shape, and `metadata`
  // (a JSON-ENCODED STRING that can carry a plaintext email) is decoded in the
  // canonicalizer, never here and never in SQL.
  getPayoutMethods(
    context: FanslyRequestContext,
  ): Promise<{ items: unknown; raw: unknown }>;
  getPayoutRequestsPage(
    context: FanslyRequestContext,
    params: {
      /** Present and EMPTY when unbounded — exactly as the app sends it. */
      before?: string | null;
      after?: string | null;
      limit: number;
      /** Zero-based ROW offset, not a page index. */
      offset: number;
    },
  ): Promise<{ items: unknown; raw: unknown }>;

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
      before?: string | null;
      limit?: number;
    },
  ): Promise<{ items: unknown; raw: unknown }>;

  // Liveness probes — WP-F9 (`dm_commerce`) + [E1]. Bundle-derived routes, never
  // yet served to us; deliberately `unknown` in and out until a real response has
  // been inspected. See services/fansly-endpoint-probe.ts. All read-only GETs.
  // WP-F5's own lane calls this one now (the probe declared it first). BARE
  // GET, always — `POST /postreply/verify` is never issued. `before` is offered
  // because every other paginated Fansly route uses it, and is sent only after
  // a page looks suspiciously full.
  getPostRepliesPage(
    context: FanslyRequestContext,
    params: { postId: string; before?: string | null },
  ): Promise<{ items: unknown; raw: unknown }>;
  getGroupMediaOffersPage(
    context: FanslyRequestContext,
    params: {
      groupId: string;
      accountId?: string | null;
      before?: string | null;
      after?: string | null;
      limit?: number | null;
      offset?: number | null;
    },
  ): Promise<{ items: unknown; raw: unknown }>;
  getBroadcastStatsPage(
    context: FanslyRequestContext,
    params: { before?: string | null; limit?: number | null; deleted?: boolean },
  ): Promise<{ items: unknown; raw: unknown }>;
  getBroadcastScheduled(
    context: FanslyRequestContext,
  ): Promise<{ items: unknown; raw: unknown }>;
  getAccountMediaOrdersPage(
    context: FanslyRequestContext,
    params: { limit?: number | null; offset?: number | null },
  ): Promise<{ items: unknown; raw: unknown }>;
  getTipsByAccountIds(
    context: FanslyRequestContext,
    params: { accountIds?: string | null },
  ): Promise<{ items: unknown; raw: unknown }>;
  getMediaStoryViewsPage(
    context: FanslyRequestContext,
    params: { storyId: string; limit?: number | null; offset?: number | null },
  ): Promise<{ items: unknown; raw: unknown }>;
  getPolls(context: FanslyRequestContext): Promise<{ items: unknown; raw: unknown }>;
  getRecapStats(context: FanslyRequestContext): Promise<{ items: unknown; raw: unknown }>;
  // (The WP-F9 probe's declarations of the four catalog routes moved up to the
  // WP-F3 block above when the lane that CALLS them landed — one declaration
  // per method, and `getVaultMediaPage`'s `mediaType` is a STRING there because
  // the app sends it present-and-empty when unfiltered.)

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
  // and the complete service proxy are configured at boot — INDEPENDENT of the
  // live voiceNotesEnabled flag, which is a DB override bootstrap never sees.
  // Undefined when either boot dependency is absent (admission then 503s
  // voice_provider_unavailable).
  voiceTtsProvider?: VoiceTtsProvider | undefined;
  /** The process's Fansly send guards (plan §2.5). createAppContext always
   *  sets it and drains it on close; optional so AppContext literals (tests)
   *  need not provide it — `getFanslySendGuards` then builds one on first use. */
  fanslySendGuards?: FanslySendGuardRegistry | undefined;
  close(): Promise<void>;
}

export interface CreateAppContextOptions {
  /** The role this process holds Fansly send guards as (journal and status).
   *  The long-lived runtimes pass theirs; everything else is the CLI. */
  processRole?: FanslySendHolderRole;
}

export async function createAppContext(options: CreateAppContextOptions = {}): Promise<AppContext> {
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

  // Plan §2.3: the endpoint pauses are gone; their env vars are parsed but
  // ignored until the keys are removed (step 4). Said once per long-lived
  // process: a CLI run's stdout stays its own output.
  const ignoredEndpointPauseEnv = listIgnoredFanslyEndpointPauseEnv(process.env);
  if (options.processRole !== undefined && options.processRole !== "cli" && ignoredEndpointPauseEnv.length > 0) {
    logger.warn(
      { envVars: ignoredEndpointPauseEnv },
      "Fansly endpoint pause env vars are ignored: every Fansly request is paced only by its page's send guard (FANSLY_DEFAULT_DELAY_MS × (1 + 0–20 %)); remove them from the env",
    );
  }

  if (!hasServiceEgressProxy(rawConfig) && rawConfig.telegramProxyPageLabel) {
    logger.warn({
      component: "service_egress",
      event: "legacy_route_active",
      vendor: "telegram",
      egressKey: "legacy-page",
    }, "Telegram is using the deprecated transition legacy-page egress route");
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

    const adapter = new FanslyAdapter({ baseUrl: config.fanslyBaseUrl });
    const fanslySendGuards = createFanslySendGuards({
      db,
      config,
      logger,
      role: options.processRole ?? "cli",
    });
    const ofapi = config.ofapiApiKey
      ? createOfapiClient({
        baseUrl: config.ofapiBaseUrl,
        apiKey: config.ofapiApiKey,
        ...ofapiCredentialPolicy(db, config, logger),
        ...ofapiCollectionPolicyHooks(db, error => logger.warn({ error }, "Collection usage settlement pending")),
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
    // Preflight failure leaves database-only work available; stateful dispatch stays closed.
    await ofapi?.getCredentialPreflight?.();
    const aiGatewayProvider = config.chatMuseAiGatewayEnabled && config.anthropicApiKey
      ? createAnthropicAiGatewayProvider({
        resolveClient: createPageProxyAnthropicClientResolver(config.anthropicApiKey),
      })
      : undefined;
    const aiGatewayOpenrouterProvider = config.chatMuseAiGatewayEnabled && config.openrouterApiKey
      ? createOpenrouterAiGatewayProvider({ apiKey: config.openrouterApiKey })
      : undefined;
    // Construct on KEY + ROUTE readiness — deliberately NOT gated on
    // voiceNotesEnabled. That flag remains the live admission-time spend gate.
    const voiceTtsProvider = config.elevenLabsApiKey && hasServiceEgressProxy(config)
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
      fanslySendGuards,
      async close() {
        // In-flight Fansly requests finish (each is bounded by its timeout)
        // and their completions are written before the pool ends.
        await fanslySendGuards.close();
        await adapter.close?.();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
