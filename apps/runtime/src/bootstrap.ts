import { ofapiCollectionPolicyHooks } from "./services/ofapi-collection-policy.ts";
import { assertRuntimeSchemaReady, createDb, createPool, type Database } from "@agency_hub_core/db";
import {
  createLogger,
  loadConfig,
  listIgnoredFanslyEndpointPauseEnv,
  resolveFanslyDefaultDelayEnvSource,
  type SkippedOverride,
} from "@agency_hub_core/shared";

import { loadBootConfig } from "./services/boot-config.ts";
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
import {
  createFanslySendGuards,
  type FanslySendGuardRegistry,
  type FanslySendHolderRole,
} from "./services/fansly-send-guard/index.ts";

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
   *  a prerequisite left off). The heartbeat publishes these in its snapshot so the
   *  dashboard can surface an ignored override per instance. Empty for a clean boot.
   *  Optional so existing AppContext literals (tests, codegen) need not provide it;
   *  createAppContext always populates it, so production behavior is exact. */
  bootSkipped?: SkippedOverride[] | undefined;
  logger: ReturnType<typeof createLogger>;
  pool: ReturnType<typeof createPool>;
  db: Database;
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
  /** The process's Fansly send-guard registry (plan §2.5). No runtime sender
   *  captures a page through it any more (step 4): it is this process's holder
   *  identity — for the journal of the identity check without a page, the
   *  termination sweeper and the CLI. createAppContext always sets it and
   *  closes it; optional so AppContext literals (tests) need not provide it —
   *  `getFanslySendGuards` then builds one on first use. */
  fanslySendGuards?: FanslySendGuardRegistry | undefined;
  close(): Promise<void>;
}

export interface CreateAppContextOptions {
  /** The role in this process's Fansly holder identity (journal and status).
   *  The long-lived runtimes pass theirs; everything else is the CLI. */
  processRole?: FanslySendHolderRole;
}

export async function createAppContext(options: CreateAppContextOptions = {}): Promise<AppContext> {
  // Env config. loadConfig validates the env values here. The
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

  const pool = createPool(rawConfig.databaseUrl);
  try {
    await assertRuntimeSchemaReady(pool);

    const db = createDb(pool);

    // Apply the staged ('boot') DB overrides onto the env config exactly once, before
    // anything reads config (the OFAPI client, the credit sink). Fails closed (A31).
    const { config, bootSkipped } = await loadBootConfig(db, rawConfig, logger);

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
      ofapi,
      aiGatewayProvider,
      aiGatewayOpenrouterProvider,
      voiceTtsProvider,
      fanslySendGuards,
      async close() {
        // Before the pool ends: a lease still held (none at run time since
        // step 4) writes its completion first.
        await fanslySendGuards.close();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
