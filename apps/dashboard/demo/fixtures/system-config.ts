/**
 * «Конфигурация» and «Функции»: the hub's effective configuration across its
 * three processes (api, worker, sync), as the demo agency runs it. The
 * descriptors are the hub's own registry (system-config-registry.ts); the
 * values below are what a production hub of this agency would hold.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { hoursAgo, iso, type DemoRequest } from "../core.ts";
import { DEMO_CONFIG_DESCRIPTORS, type DemoConfigDescriptor } from "./system-config-registry.ts";

type ConfigView = KernelOperationResponse<"adminConfig">;
type ConfigItem = ConfigView["subsystems"][number]["items"][number];
type Scalar = string | number | boolean | null;

/** The image every process runs: the deployed commit. */
const IMAGE_TAG = "d97546581";

const INSTANCES = [
  { role: "api", instanceId: "api-7f3c9b2d", startedHoursAgo: 31.2 },
  { role: "worker", instanceId: "worker-1a8e44c0", startedHoursAgo: 31.2 },
  { role: "sync", instanceId: "sync-5d20e7f9", startedHoursAgo: 31.1 },
] as const;

/** Secrets and structured values: only whether each is set. */
const SET_SECRETS = new Set([
  "databaseUrl", "encryptionKey", "encryptionKeyRing", "telegramBotToken", "telegramChatId",
  "serviceEgressProxyUrl", "serviceEgressProxyUsername", "serviceEgressProxyPassword",
  "anthropicApiKey", "anthropicApiKeys", "anthropicMediaApiKey", "elevenLabsApiKey", "healthSyncMonitoringToken",
  "chatspaceBrowserScreenPassword",
]);

/** What the processes run with where it is not the registry's default. */
const RUNNING: Readonly<Record<string, Scalar>> = {
  isProduction: true,
  trustProxy: "1",
  logLevel: "info",
  telegramEnabled: true,
  telegramReportHourUtc: 6,
  telegramProxyPageLabel: "mia-1",
  ofapiBaseUrl: "https://app.onlyfansapi.com/api",
  ofapiWebhookManagementScope: "team",
  ofapiExpectedTeamSlug: "demo-agency",
  ofapiExportArtifactDir: "/opt/agency-hub/ofapi-export-artifacts",
  fanslyPublicLookupEnabled: true,
  chatMuseAiGatewayEnabled: true,
  chatMuseAiGatewayDailyMicroUsdLimit: 60_000_000,
  chatMuseAiGatewayFeatureDailyMicroUsdLimits: "{\"fan-summary\": 3000000, \"coach-chat\": 15000000}",
  chatMuseAiFanProfileContextFeatures: "fast-reply,ping",
  aiNotesTrimEnabled: true,
  fanFactsEnabled: true,
  fanFactsPages: "mia-1,nova-1",
  fanFactsModel: "anthropic:claude-sonnet-5-5",
  aiMediaDescribeEnabled: true,
  aiMediaDescribePagePolicies: "{\"mia-1\": {\"since\": \"2026-10-12T00:00:00Z\"}, \"nova-1\": {\"since\": \"2026-10-12T00:00:00Z\"}}",
  aiFeatureModels: "{\"coach-chat\": \"anthropic:claude-opus-5-5\", \"fast-reply\": \"anthropic:claude-opus-5-5\"}",
  aiFeatureEfforts: "{\"fast-reply\": \"low\", \"coach-chat\": \"low\", \"chat-review\": \"low\"}",
  aiFeatureWindows: "{\"fast-reply\": 25, \"coach-chat\": 50}",
  voiceNotesEnabled: true,
  voiceNotesPageAllowlist: "mia-1,nova-1",
  chatExtensionEnabled: true,
  chatExtensionFeatures: "{\"*\": {\"spenders\": true, \"newcomers\": true}, \"mia-1\": {\"voice\": true}}",
  chatExtensionMinVersion: "3.4.0",
  chatExtensionHealthIngestEnabled: true,
  crossSpendersLists: "{\"mia-1\": {}, \"mia-2\": {}}",
  ofHistoryAutoApproveEnabled: false,
  publicationFilesMaxTotalGb: 40,
};

/** Owner's overrides from the console (live/boot keys only), with their row version. */
const OVERRIDES: Readonly<Record<string, { value: string | number | boolean; version: number }>> = {
  fanslyPublicLookupEnabled: { value: true, version: 2 },
  chatMuseAiGatewayEnabled: { value: true, version: 1 },
  aiNotesTrimEnabled: { value: true, version: 3 },
  fanFactsEnabled: { value: true, version: 4 },
  fanFactsPages: { value: "mia-1,nova-1", version: 6 },
  aiMediaDescribeEnabled: { value: true, version: 2 },
  aiFeatureEfforts: { value: "{\"fast-reply\": \"low\", \"coach-chat\": \"low\", \"chat-review\": \"low\"}", version: 9 },
  aiFeatureModels: { value: "{\"coach-chat\": \"anthropic:claude-opus-5-5\", \"fast-reply\": \"anthropic:claude-opus-5-5\"}", version: 5 },
  voiceNotesEnabled: { value: true, version: 2 },
  voiceNotesPageAllowlist: { value: "mia-1,nova-1", version: 3 },
  chatExtensionMinVersion: { value: "3.4.0", version: 7 },
  chatExtensionHealthIngestEnabled: { value: true, version: 1 },
  ofHistoryAutoApproveEnabled: { value: false, version: 2 },
  // Saved a few minutes ago: the sync process has not re-read it yet.
  aiMediaDescribeDailyImageLimit: { value: 220, version: 3 },
};

/** A value the sync process still holds from before the last save (the one pending key). */
const LAGGING: Readonly<Record<string, { role: string; value: Scalar }>> = {
  aiMediaDescribeDailyImageLimit: { role: "sync", value: 150 },
};

function defaultValue(descriptor: DemoConfigDescriptor): Scalar {
  const raw = descriptor.default;
  if (raw === "(unset)" || raw === "(required)" || raw.startsWith("(")) return null;
  if (descriptor.kind === "boolean" || descriptor.kind === "derived") {
    if (raw === "true") return true;
    if (raw === "false") return false;
  }
  if (descriptor.kind === "number") {
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }
  return raw;
}

function runningValue(descriptor: DemoConfigDescriptor): Scalar {
  return descriptor.key in RUNNING ? RUNNING[descriptor.key] ?? null : defaultValue(descriptor);
}

function buildItem(descriptor: DemoConfigDescriptor, now: Date): ConfigItem {
  const masked = descriptor.kind === "secret" || descriptor.kind === "complex";
  const value = runningValue(descriptor);
  const running = INSTANCES.map((instance) => {
    const lagging = LAGGING[descriptor.key];
    const seen = iso(new Date(now.getTime() - (8 + instance.instanceId.length) * 1000));
    if (masked) {
      return {
        role: instance.role,
        instanceId: instance.instanceId,
        value: null,
        masked: true,
        state: SET_SECRETS.has(descriptor.key) ? "set" as const : "unset" as const,
        lastSeenAt: seen,
      };
    }
    return {
      role: instance.role,
      instanceId: instance.instanceId,
      value: lagging && lagging.role === instance.role ? lagging.value : value,
      masked: false,
      state: null,
      lastSeenAt: seen,
    };
  });
  const overridable = descriptor.runtimeApply === "live" || descriptor.runtimeApply === "boot";
  const override = overridable ? OVERRIDES[descriptor.key] : undefined;
  const scalars = masked ? [] : running.map((entry) => JSON.stringify(entry.value));
  const drift = descriptor.comparable && new Set(scalars).size > 1;
  const pendingApply = override !== undefined && running.some((entry) => entry.masked || entry.value !== override.value);
  const booleans = running.filter((entry) => typeof entry.value === "boolean");
  const runningState = booleans.length === 0 ? "unknown" as const : booleans.every((entry) => entry.value === true) ? "on" as const : "off" as const;
  const envValue = defaultValue(descriptor);
  const desiredEffective = override !== undefined
    ? (typeof override.value === "boolean" ? override.value : null)
    : (descriptor.kind === "boolean" && typeof value === "boolean" ? value : typeof envValue === "boolean" && descriptor.kind === "boolean" ? envValue : null);
  return {
    key: descriptor.key,
    envName: descriptor.envName,
    configField: descriptor.configField,
    kind: descriptor.kind,
    subsystem: descriptor.subsystem,
    label: descriptor.label,
    default: descriptor.default,
    editability: descriptor.editability,
    runtimeApply: descriptor.runtimeApply,
    comparable: descriptor.comparable,
    secret: descriptor.kind === "secret",
    note: descriptor.note,
    costWarning: descriptor.costWarning,
    destructive: descriptor.destructive,
    source: override ? "override" : "env",
    desired: override ? override.value : null,
    runningState,
    desiredEffective,
    overrideVersion: override ? override.version : null,
    pendingApply,
    drift,
    live: descriptor.runtimeApply === "live",
    running,
  };
}

export function demoConfigView(request: DemoRequest): ConfigView {
  const now = request.now;
  const bySubsystem = new Map<string, ConfigItem[]>();
  for (const descriptor of DEMO_CONFIG_DESCRIPTORS) {
    const items = bySubsystem.get(descriptor.subsystem) ?? [];
    items.push(buildItem(descriptor, now));
    bySubsystem.set(descriptor.subsystem, items);
  }
  return {
    generatedAt: iso(now),
    roleStatuses: INSTANCES.map((instance) => ({ role: instance.role, status: "active" as const })),
    instances: INSTANCES.map((instance) => ({
      role: instance.role,
      instanceId: instance.instanceId,
      startedAt: iso(hoursAgo(now, instance.startedHoursAgo)),
      lastSeenAt: iso(new Date(now.getTime() - 9_000)),
      imageTag: IMAGE_TAG,
      status: "active" as const,
      skippedOverrides: [],
    })),
    subsystems: [...bySubsystem.entries()].map(([subsystem, items]) => ({ subsystem, items })),
  };
}
