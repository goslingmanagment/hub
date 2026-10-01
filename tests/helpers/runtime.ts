import { OFAPI_MIRROR_BUDGET_DEFAULTS } from "@agency_hub_core/shared";

import type { AppContext } from "../../apps/runtime/src/bootstrap.ts";
import { createFanslySendGuards } from "../../apps/runtime/src/services/fansly-send-guard/index.ts";
import type { StartedTestDatabase } from "./db.ts";

export function createTestAppContext(
  testDb: StartedTestDatabase,
  overrides?: {
    adapter?: AppContext["adapter"];
    databaseUrl?: string;
    encryptionKey?: Buffer;
    encryptionKeyVersion?: number;
    encryptionKeysByVersion?: ReadonlyMap<number, Buffer>;
    fanslyDefaultDelayMs?: number;
    /** S for the context's Fansly send guards. 0 by default: a test that is
     *  not about pacing does not wait between its requests. */
    fanslySendGuardSettingMs?: number;
    fanslyDmConversationsDelayMs?: number;
    fanslyDmMessagesDelayMs?: number;
    fanslyFanEarningsSyncEnabled?: boolean;
    fanslyFanEarningsShadowPageAllowlist?: string;
    fanslyPurchaseHistorySyncEnabled?: boolean;
    fanslyNewStreamPageAllowlist?: string;
    followerPageDelayMs?: number;
    logger?: StartedTestDatabase["logger"];
    onlyFansDefaultDelayMs?: number;
    ofapi?: AppContext["ofapi"];
    aiGatewayProvider?: AppContext["aiGatewayProvider"];
    ofapiEventRetentionDays?: number;
    ofapiEventWorkerReplicas?: number;
    ofapiDmProjectionEnabled?: boolean;
    ofapiDmSyncEnabled?: boolean;
    ofapiDmColdArchiveEnabled?: boolean;
    ofapiDmColdArchiveRetentionDays?: number;
    ofapiDmBootstrapMaxRequestsPerRun?: number;
    ofapiDmDailyCreditBudget?: number;
    ofapiMirrorGlobalDailyCreditBudget?: number;
    ofapiMirrorPrincipalDailyCallCap?: number;
    ofapiMirrorPrincipalDailyCreditCap?: number;
    ofapiCreditFloor?: number;
    ofapiDmReconcileIntervalMinutes?: number;
    ofapiAccountHealthEnabled?: boolean;
    ofapiBindingReconcileEnabled?: boolean;
    ofapiCreditAlertThreshold?: number;
    ofapiWebhookSilenceThresholdMinutes?: number;
    ofapiWebhookAutoRedeliveryEnabled?: boolean;
    ofapiWebhookAutoRedeliveryDailyCap?: number;
    ofapiMediaDailyCapCredits?: number;
    ofapiCreditLedgerEnabled?: boolean;
    ofapiBurnAlertCreditsPerHour?: number;
    ofapiCreditMicroUsdPrice?: number;
    ofapiBalancePingEnabled?: boolean;
    ofapiAudienceSyncEnabled?: boolean;
    ofapiAudienceMaxRequestsPerRun?: number;
    ofapiAudienceDailyCreditBudget?: number;
    ofapiBackfillDailyCreditBudget?: number;
    ofapiChargebacksReconcileEnabled?: boolean;
    ofapiLinkStatsReconcileEnabled?: boolean;
    ofapiLinkStatsDailyCreditBudget?: number;
    ofapiFanIdentitiesSyncEnabled?: boolean;
    ofapiAudienceSweepIntervalMinutes?: number;
    ofapiPresenceProjectionEnabled?: boolean;
    ofapiSpendProjectionShadowEnabled?: boolean;
    ofapiSpendTransactionIngestEnabled?: boolean;
    ofapiDesktopReadGatewayEnabled?: boolean;
    ofapiMirrorInteractiveCaptureEnabled?: boolean;
    ofapiMirrorBackgroundCaptureEnabled?: boolean;
    ofapiExportArtifactDir?: string;
    ofapiMessageHistoryShadowEnabled?: boolean;
    ofapiMessageHistoryDbFallbackEnabled?: boolean;
    ofapiDesktopCommandOutboxEnabled?: boolean;
    ofapiDesktopCommandExecutionEnabled?: boolean;
    chatMuseAiGatewayEnabled?: boolean;
    chatMuseAiGatewayDailyRequestLimit?: number;
    chatMuseAiGatewayDailyMicroUsdLimit?: number;
    chatMuseAiGatewayRequestMicroUsdLimit?: number;
    onlyFansTopSpendersEnabled?: boolean;
    sessionTtlDays?: number;
    syncPageExecutorConcurrency?: number;
    syncSharedRateLimitEnabled?: boolean;
    healthSyncMonitoringToken?: string | null;
    telegramProxyPageLabel?: string | null;
    serviceEgressProxyUrl?: string | null;
    serviceEgressProxyUsername?: string | null;
    serviceEgressProxyPassword?: string | null;
    trustProxy?: boolean;
    authPolicyEnforcement?: "log" | "enforce";
    accessGrantsReadEnabled?: boolean;
    accountLinksEnabled?: boolean;
    revenueRouteRoleEnforcement?: "log" | "enforce";
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
      fanslyBaseUrl: "https://example.invalid",
      syncHttpTraceFile: null,
      fanslyDefaultDelayMs: overrides?.fanslyDefaultDelayMs ?? 2500,
      fanslyDmConversationsDelayMs: overrides?.fanslyDmConversationsDelayMs ?? 5000,
      fanslyDmMessagesDelayMs: overrides?.fanslyDmMessagesDelayMs ?? 5000,
      fanslyFanEarningsSyncEnabled: overrides?.fanslyFanEarningsSyncEnabled ?? false,
      fanslyFanEarningsShadowPageAllowlist: overrides?.fanslyFanEarningsShadowPageAllowlist ?? "none",
      fanslyPurchaseHistorySyncEnabled: overrides?.fanslyPurchaseHistorySyncEnabled ?? false,
      fanslyNewStreamPageAllowlist: overrides?.fanslyNewStreamPageAllowlist ?? "",
      followerPageDelayMs: overrides?.followerPageDelayMs ?? 0,
      onlyFansDefaultDelayMs: overrides?.onlyFansDefaultDelayMs ?? 1000,
      transactionLookbackDays: 7,
      transactionRescanCapDays: 30,
      syncSharedRateLimitEnabled: overrides?.syncSharedRateLimitEnabled ?? false,
      egressPacerMode: "off" as const,
      lakeDir: "lake",
      syncPageExecutorConcurrency: overrides?.syncPageExecutorConcurrency ?? 1,
      syncObservabilityRetentionDays: 30,
      healthSyncLightMaxAgeMinutes: 180,
      healthSyncFollowerMaxAgeMinutes: 1080,
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
      ofapiEventRetentionDays: overrides?.ofapiEventRetentionDays ?? 7,
      ofapiEventWorkerReplicas: overrides?.ofapiEventWorkerReplicas ?? 1,
      ofapiDmProjectionEnabled: overrides?.ofapiDmProjectionEnabled ?? false,
      ofapiDmSyncEnabled: overrides?.ofapiDmSyncEnabled ?? false,
      ofapiDmColdArchiveEnabled: overrides?.ofapiDmColdArchiveEnabled ?? false,
      ofapiDmColdArchiveRetentionDays: overrides?.ofapiDmColdArchiveRetentionDays ?? 3650,
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
      ofapiAccountHealthEnabled: overrides?.ofapiAccountHealthEnabled ?? false,
      ofapiBindingReconcileEnabled: overrides?.ofapiBindingReconcileEnabled ?? false,
      ofapiCreditAlertThreshold: overrides?.ofapiCreditAlertThreshold ?? 1000,
      ofapiWebhookSilenceThresholdMinutes: overrides?.ofapiWebhookSilenceThresholdMinutes ?? 720,
      ofapiWebhookAutoRedeliveryEnabled: overrides?.ofapiWebhookAutoRedeliveryEnabled ?? false,
      ofapiWebhookAutoRedeliveryDailyCap: overrides?.ofapiWebhookAutoRedeliveryDailyCap ?? 1000,
      ofapiMediaDailyCapCredits: overrides?.ofapiMediaDailyCapCredits ?? 100,
      ofapiCreditLedgerEnabled: overrides?.ofapiCreditLedgerEnabled ?? false,
      ofapiBurnAlertCreditsPerHour: overrides?.ofapiBurnAlertCreditsPerHour ?? 300,
      ofapiCreditMicroUsdPrice: overrides?.ofapiCreditMicroUsdPrice ?? 0,
      ofapiBalancePingEnabled: overrides?.ofapiBalancePingEnabled ?? false,
      ofapiAudienceSyncEnabled: overrides?.ofapiAudienceSyncEnabled ?? false,
      ofapiAudienceMaxRequestsPerRun: overrides?.ofapiAudienceMaxRequestsPerRun ?? 25,
      ofapiAudienceDailyCreditBudget: overrides?.ofapiAudienceDailyCreditBudget ?? 300,
      ofapiBackfillDailyCreditBudget: overrides?.ofapiBackfillDailyCreditBudget ?? 200,
      ofapiChargebacksReconcileEnabled: overrides?.ofapiChargebacksReconcileEnabled ?? false,
      ofapiLinkStatsReconcileEnabled: overrides?.ofapiLinkStatsReconcileEnabled ?? false,
      ofapiLinkStatsDailyCreditBudget: overrides?.ofapiLinkStatsDailyCreditBudget ?? 50,
      ofapiFanIdentitiesSyncEnabled: overrides?.ofapiFanIdentitiesSyncEnabled ?? false,
      ofapiAudienceSweepIntervalMinutes: overrides?.ofapiAudienceSweepIntervalMinutes ?? 1440,
      ofapiPresenceProjectionEnabled: overrides?.ofapiPresenceProjectionEnabled ?? false,
      ofapiSpendProjectionShadowEnabled: overrides?.ofapiSpendProjectionShadowEnabled ?? false,
      ofapiSpendTransactionIngestEnabled: overrides?.ofapiSpendTransactionIngestEnabled ?? false,
      ofapiDesktopReadGatewayEnabled: overrides?.ofapiDesktopReadGatewayEnabled ?? false,
      ofapiMirrorInteractiveCaptureEnabled:
        overrides?.ofapiMirrorInteractiveCaptureEnabled ?? false,
      ofapiMirrorBackgroundCaptureEnabled:
        overrides?.ofapiMirrorBackgroundCaptureEnabled ?? false,
      ofapiExportArtifactDir:
        overrides?.ofapiExportArtifactDir ?? "/var/lib/agency-hub/ofapi-export-artifacts",
      ofapiMessageHistoryShadowEnabled:
        overrides?.ofapiMessageHistoryShadowEnabled ?? false,
      ofapiMessageHistoryDbFallbackEnabled:
        overrides?.ofapiMessageHistoryDbFallbackEnabled ?? false,
      ofapiDesktopCommandOutboxEnabled:
        overrides?.ofapiDesktopCommandOutboxEnabled ?? false,
      ofapiDesktopCommandExecutionEnabled:
        overrides?.ofapiDesktopCommandExecutionEnabled ?? false,
      accountLinksEnabled: overrides?.accountLinksEnabled ?? true,
      chatMuseAiGatewayEnabled: overrides?.chatMuseAiGatewayEnabled ?? false,
      chatMuseAiGatewayDailyRequestLimit:
        overrides?.chatMuseAiGatewayDailyRequestLimit ?? 200,
      chatMuseAiGatewayDailyMicroUsdLimit:
        overrides?.chatMuseAiGatewayDailyMicroUsdLimit ?? 5_000_000,
      chatMuseAiGatewayRequestMicroUsdLimit:
        overrides?.chatMuseAiGatewayRequestMicroUsdLimit ?? 5_000_000,
      onlyFansTopSpendersEnabled: overrides?.onlyFansTopSpendersEnabled ?? false,
      authPolicyEnforcement: overrides?.authPolicyEnforcement ?? "log",
      accessGrantsReadEnabled: overrides?.accessGrantsReadEnabled ?? false,
      revenueRouteRoleEnforcement: overrides?.revenueRouteRoleEnforcement ?? "log",
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
    adapter: overrides?.adapter ?? ({} as AppContext["adapter"]),
    ofapi: overrides?.ofapi,
    aiGatewayProvider: overrides?.aiGatewayProvider,
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
