import { OFAPI_MIRROR_BUDGET_DEFAULTS } from "@agency_hub_core/shared";

import type { AppContext } from "../../apps/runtime/src/bootstrap.ts";
import { createFanslySendGuards } from "../../apps/runtime/src/services/fansly-send-guard/index.ts";
import type { StartedTestDatabase } from "./db.ts";

/** When every test generation is built: the `Now:` line of its prompt. */
export const TEST_AI_PROMPT_NOW_MS = Date.parse("2026-10-15T04:12:00.000Z");

export function createTestAppContext(
  testDb: StartedTestDatabase,
  overrides?: {
    databaseUrl?: string;
    encryptionKey?: Buffer;
    encryptionKeyVersion?: number;
    encryptionKeysByVersion?: ReadonlyMap<number, Buffer>;
    /** The Fansly origin (a test's fake one); default an unroutable host. */
    fanslyBaseUrl?: string;
    fanslyDefaultDelayMs?: number;
    /** S for the context's Fansly send guards. 0 by default: a test that is
     *  not about pacing does not wait between its requests. */
    fanslySendGuardSettingMs?: number;
    logger?: StartedTestDatabase["logger"];
    onlyFansDefaultDelayMs?: number;
    ofapi?: AppContext["ofapi"];
    aiGatewayProvider?: AppContext["aiGatewayProvider"];
    pageBrowserEndpoints?: AppContext["pageBrowserEndpoints"];
    pageBrowserScreenWatch?: AppContext["pageBrowserScreenWatch"];
    pageBrowserProxyCheck?: AppContext["pageBrowserProxyCheck"];
    /** The AI prompts' `Now:` clock; TEST_AI_PROMPT_NOW_MS by default. */
    aiPromptClock?: AppContext["aiPromptClock"];
    ofapiEventWorkerReplicas?: number;
    ofapiDmBootstrapMaxRequestsPerRun?: number;
    ofapiDmDailyCreditBudget?: number;
    ofapiMirrorGlobalDailyCreditBudget?: number;
    ofapiMirrorPrincipalDailyCallCap?: number;
    ofapiMirrorPrincipalDailyCreditCap?: number;
    ofapiCreditFloor?: number;
    ofapiDmReconcileIntervalMinutes?: number;
    ofapiCreditAlertThreshold?: number;
    ofapiWebhookSilenceThresholdMinutes?: number;
    ofapiWebhookAutoRedeliveryDailyCap?: number;
    ofapiMediaDailyCapCredits?: number;
    ofapiBurnAlertCreditsPerHour?: number;
    ofapiCreditMicroUsdPrice?: number;
    ofapiAudienceMaxRequestsPerRun?: number;
    ofapiAudienceDailyCreditBudget?: number;
    ofapiBackfillDailyCreditBudget?: number;
    ofapiLinkStatsDailyCreditBudget?: number;
    ofapiAudienceSweepIntervalMinutes?: number;
    ofapiExportArtifactDir?: string;
    chatMuseAiGatewayEnabled?: boolean;
    chatMuseAiGatewayDailyMicroUsdLimit?: number;
    chatMuseAiGatewayRequestMicroUsdLimit?: number;
    sessionTtlDays?: number;
    syncPageExecutorConcurrency?: number;
    healthSyncMonitoringToken?: string | null;
    telegramProxyPageLabel?: string | null;
    serviceEgressProxyUrl?: string | null;
    serviceEgressProxyUsername?: string | null;
    serviceEgressProxyPassword?: string | null;
    trustProxy?: boolean;
    accountLinksEnabled?: boolean;
  },
) {
  const encryptionKey = overrides?.encryptionKey ?? Buffer.alloc(32, 7);
  const encryptionKeyVersion = overrides?.encryptionKeyVersion ?? 1;
  const encryptionKeysByVersion = new Map(overrides?.encryptionKeysByVersion ?? []);
  if (!encryptionKeysByVersion.has(encryptionKeyVersion)) {
    encryptionKeysByVersion.set(encryptionKeyVersion, encryptionKey);
  }

  const config = {
      databaseUrl: overrides?.databaseUrl ?? "",
      encryptionKey,
      encryptionKeyVersion,
      encryptionKeysByVersion,
      logLevel: "silent",
      apiHost: "0.0.0.0",
      apiPort: 3000,
      isProduction: false,
      trustProxy: overrides?.trustProxy ?? false,
      sessionTtlDays: overrides?.sessionTtlDays ?? 30,
      fanslyBaseUrl: overrides?.fanslyBaseUrl ?? "https://example.invalid",
      syncHttpTraceFile: null,
      fanslyDefaultDelayMs: overrides?.fanslyDefaultDelayMs ?? 2500,
      onlyFansDefaultDelayMs: overrides?.onlyFansDefaultDelayMs ?? 1000,
      lakeDir: "lake",
      syncPageExecutorConcurrency: overrides?.syncPageExecutorConcurrency ?? 1,
      syncObservabilityRetentionDays: 30,
      healthSyncLightMaxAgeMinutes: 180,
      healthSyncMonitoringToken: overrides?.healthSyncMonitoringToken ?? null,
      telegramBotToken: null,
      telegramChatId: null,
      telegramEnabled: false,
      telegramReportHourUtc: 9,
      telegramProxyPageLabel: overrides?.telegramProxyPageLabel ?? null,
      serviceEgressProxyUrl:
        overrides?.serviceEgressProxyUrl === undefined
          ? "socks5://proxy.example.internal:1080"
          : overrides.serviceEgressProxyUrl,
      serviceEgressProxyUsername:
        overrides?.serviceEgressProxyUsername === undefined
          ? "fake-service-user"
          : overrides.serviceEgressProxyUsername,
      serviceEgressProxyPassword:
        overrides?.serviceEgressProxyPassword === undefined
          ? "fake-service-password"
          : overrides.serviceEgressProxyPassword,
      ofapiEventWorkerReplicas: overrides?.ofapiEventWorkerReplicas ?? 1,
      ofapiRestDelayMs: 0,
      ofapiDmBootstrapMaxRequestsPerRun: overrides?.ofapiDmBootstrapMaxRequestsPerRun ?? 25,
      ofapiDmDailyCreditBudget: overrides?.ofapiDmDailyCreditBudget ?? 500,
      ofapiMirrorGlobalDailyCreditBudget:
        overrides?.ofapiMirrorGlobalDailyCreditBudget
          ?? OFAPI_MIRROR_BUDGET_DEFAULTS.globalDailyCreditBudget,
      ofapiMirrorPrincipalDailyCallCap:
        overrides?.ofapiMirrorPrincipalDailyCallCap
          ?? OFAPI_MIRROR_BUDGET_DEFAULTS.principalDailyCallCap,
      ofapiMirrorPrincipalDailyCreditCap:
        overrides?.ofapiMirrorPrincipalDailyCreditCap
          ?? OFAPI_MIRROR_BUDGET_DEFAULTS.principalDailyCreditCap,
      ofapiCreditFloor: overrides?.ofapiCreditFloor ?? 500,
      ofapiDmReconcileIntervalMinutes: overrides?.ofapiDmReconcileIntervalMinutes ?? 360,
      ofapiCreditAlertThreshold: overrides?.ofapiCreditAlertThreshold ?? 1000,
      ofapiWebhookSilenceThresholdMinutes: overrides?.ofapiWebhookSilenceThresholdMinutes ?? 720,
      ofapiWebhookAutoRedeliveryDailyCap: overrides?.ofapiWebhookAutoRedeliveryDailyCap ?? 1000,
      ofapiMediaDailyCapCredits: overrides?.ofapiMediaDailyCapCredits ?? 100,
      ofapiBurnAlertCreditsPerHour: overrides?.ofapiBurnAlertCreditsPerHour ?? 300,
      ofapiCreditMicroUsdPrice: overrides?.ofapiCreditMicroUsdPrice ?? 0,
      ofapiAudienceMaxRequestsPerRun: overrides?.ofapiAudienceMaxRequestsPerRun ?? 25,
      ofapiAudienceDailyCreditBudget: overrides?.ofapiAudienceDailyCreditBudget ?? 300,
      ofapiBackfillDailyCreditBudget: overrides?.ofapiBackfillDailyCreditBudget ?? 200,
      ofapiLinkStatsDailyCreditBudget: overrides?.ofapiLinkStatsDailyCreditBudget ?? 50,
      ofapiAudienceSweepIntervalMinutes: overrides?.ofapiAudienceSweepIntervalMinutes ?? 1440,
      ofapiExportArtifactDir:
        overrides?.ofapiExportArtifactDir ?? "/var/lib/agency-hub/ofapi-export-artifacts",
      accountLinksEnabled: overrides?.accountLinksEnabled ?? true,
      chatMuseAiGatewayEnabled: overrides?.chatMuseAiGatewayEnabled ?? false,
      chatMuseAiGatewayDailyMicroUsdLimit:
        overrides?.chatMuseAiGatewayDailyMicroUsdLimit ?? 5_000_000,
      chatMuseAiGatewayRequestMicroUsdLimit:
        overrides?.chatMuseAiGatewayRequestMicroUsdLimit ?? 5_000_000,
    } as AppContext["config"];

  const logger = overrides?.logger ?? testDb.logger;
  const sendGuardSettingMs = overrides?.fanslySendGuardSettingMs ?? 0;
  return {
    db: testDb.db,
    pool: testDb.pool,
    logger,
    config,
    // Tests apply no boot overrides, so the raw env baseline equals the effective config.
    rawConfig: config,
    ofapi: overrides?.ofapi,
    aiGatewayProvider: overrides?.aiGatewayProvider,
    pageBrowserEndpoints: overrides?.pageBrowserEndpoints,
    pageBrowserScreenWatch: overrides?.pageBrowserScreenWatch,
    pageBrowserProxyCheck: overrides?.pageBrowserProxyCheck,
    // Pinned: suites compare the prompts of two generations byte for byte,
    // and a wall clock would split them at a minute boundary.
    aiPromptClock: overrides?.aiPromptClock ?? (() => TEST_AI_PROMPT_NOW_MS),
    fanslySendGuards: createFanslySendGuards({
      db: testDb.db,
      config,
      logger,
      role: "test",
      readSettingMs: async () => sendGuardSettingMs,
    }),
    async close() {},
  } satisfies AppContext;
}
