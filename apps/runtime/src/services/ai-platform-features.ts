import type { Platform } from "@agency_hub_core/shared";

/**
 * The AI features a platform's pages run, where the platform limits them
 * (chat-extension Telegram spec §5.6). A platform without an entry runs every
 * feature, as OnlyFans and Fansly always have.
 *
 * Telegram: Reply, Fix and Coach only. Checked twice with one answer
 * (409 `client_feature_disabled`, `platform_unsupported`): in the narrow
 * token's AI switch (client-ai-switch.ts) and again in the AI feature route
 * (features/index.ts), which a full device token reaches without the switch.
 */
const AI_PLATFORM_FEATURES: Readonly<Partial<Record<Platform, ReadonlySet<string>>>> = {
  telegram: new Set(["fast-reply", "improve-draft", "coach-chat"]),
};

/** Whether pages of this platform run this AI feature. */
export function aiFeatureRunsOnPlatform(feature: string, platform: Platform): boolean {
  return AI_PLATFORM_FEATURES[platform]?.has(feature) ?? true;
}
