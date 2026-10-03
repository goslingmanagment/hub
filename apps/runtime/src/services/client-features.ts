import {
  CLIENT_FEATURE_FLAG_NAMES,
  type ClientFeatureAvailability,
  type ClientFeatureFlagName,
  type ClientFeatureUnavailableReason,
  type ClientHubCapabilityName,
} from "@agency_hub_core/contracts";
import {
  compareClientSemver,
  parseChatExtensionClientVersion,
  parseClientSemver,
  type Platform,
} from "@agency_hub_core/shared";

/**
 * Whether a chat-extension feature is available on a page, and if not, why.
 *
 * ONE pure function decides it for every surface: the bootstrap's
 * `pages[].features`, and the server-side check of every client route and AI
 * call that a later PR puts behind a flag. It is also the only place that asks
 * about a page's platform for these features, so a new platform is one table
 * edit, not a branch in every handler.
 *
 * The owner's switches it reads come from client-switches.ts, which also holds
 * `requireClientFeature`, the server-side check every client route runs.
 */

/** What a feature needs before the hub can offer it. */
export interface ClientFeatureRequirement {
  /** The platforms the feature exists on. */
  platforms: readonly Platform[];
  /** Hub capabilities that must be served (SERVED_CLIENT_CAPABILITIES). */
  capabilities: readonly ClientHubCapabilityName[];
}

const ONLYFANS: readonly Platform[] = ["onlyfans"];

/** Every flag the extension knows, with what it needs. The pilot is OnlyFans only. */
export const CLIENT_FEATURE_REQUIREMENTS: Readonly<Record<ClientFeatureFlagName, ClientFeatureRequirement>> = {
  // Client-only: the hub has no action behind these.
  insertion: { platforms: ONLYFANS, capabilities: [] },
  navigation: { platforms: ONLYFANS, capabilities: [] },
  wsTap: { platforms: ONLYFANS, capabilities: [] },
  sound: { platforms: ONLYFANS, capabilities: [] },
  fanPanel: { platforms: ONLYFANS, capabilities: [] },
  previewSendMarkAiGenerated: { platforms: ONLYFANS, capabilities: [] },
  // Client-only too: the existing spenders reads are not changed.
  spenders: { platforms: ONLYFANS, capabilities: [] },
  // AI features the narrow token's AI switch checks.
  review: { platforms: ONLYFANS, capabilities: [] },
  coach: { platforms: ONLYFANS, capabilities: [] },
  freshText: { platforms: ONLYFANS, capabilities: ["live-text-v1"] },
  splitAll: { platforms: ONLYFANS, capabilities: ["split-all-v1"] },
  recap: { platforms: ONLYFANS, capabilities: ["shared-recaps-v1", "recap-profile-v1"] },
  preview: { platforms: ONLYFANS, capabilities: ["archive-feed-v1"] },
  stats: { platforms: ONLYFANS, capabilities: ["spenders-stats-v1", "awaiting-reply-v1"] },
  newcomers: { platforms: ONLYFANS, capabilities: ["audience-new-v1", "preview-send-custody-v1"] },
  previewSend: { platforms: ONLYFANS, capabilities: ["preview-send-custody-v1"] },
};

/** The owner's switches, as the evaluation reads them. */
export interface ClientFeatureSettings {
  /** The master switch: off = every feature off on every page. */
  enabled: boolean;
  /**
   * Flag values by scope: `"*"` for every page, a page label for that page. A
   * page's own value wins over `"*"`; a flag set nowhere is off. Unknown flag
   * names are ignored.
   */
  features: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  /** The owner's explicit host-account bindings: host account → page label. */
  hostBindings: Readonly<Record<string, string>>;
}

/** The switches at rest, and what a broken one falls back to: everything off. */
export const CLIENT_FEATURE_CODE_DEFAULTS: ClientFeatureSettings = Object.freeze({
  enabled: false,
  features: Object.freeze({}),
  hostBindings: Object.freeze({}),
});

export interface ClientFeaturePage {
  label: string;
  platform: Platform;
  /** `pages.external_page_id`: what the extension binds a host account by. */
  platformAccountId: string | null;
}

function unavailable(reason: ClientFeatureUnavailableReason): ClientFeatureAvailability {
  return { available: false, reason };
}

function flagValue(settings: ClientFeatureSettings, scope: string, flag: ClientFeatureFlagName): boolean | undefined {
  const value = settings.features[scope]?.[flag];
  return typeof value === "boolean" ? value : undefined;
}

/** The extension can bind a host account to the page: by the page's platform
 *  account id, or by an explicit owner binding. */
function bindable(settings: ClientFeatureSettings, page: ClientFeaturePage): boolean {
  return page.platformAccountId !== null || Object.values(settings.hostBindings).includes(page.label);
}

/**
 * The reasons, in the order they are checked: the feature does not exist on the
 * page's platform; the master switch is off; the flag is off for the page; the
 * extension has no way to bind a host account to the page; the hub does not
 * serve what the feature needs yet.
 */
export function evaluateClientFeature(input: {
  settings: ClientFeatureSettings;
  page: ClientFeaturePage;
  flag: ClientFeatureFlagName;
  served: readonly string[];
}): ClientFeatureAvailability {
  const requirement = CLIENT_FEATURE_REQUIREMENTS[input.flag];
  if (!requirement.platforms.includes(input.page.platform)) {
    return unavailable("platform_unsupported");
  }
  if (!input.settings.enabled) {
    return unavailable("disabled");
  }
  const on = flagValue(input.settings, input.page.label, input.flag)
    ?? flagValue(input.settings, "*", input.flag)
    ?? false;
  if (!on) {
    return unavailable("flag_off");
  }
  if (!bindable(input.settings, input.page)) {
    return unavailable("binding_missing");
  }
  if (!requirement.capabilities.every((capability) => input.served.includes(capability))) {
    return unavailable("hub_not_ready");
  }
  return { available: true };
}

/** A page's `features`: every known flag, evaluated. */
export function evaluateClientPageFeatures(input: {
  settings: ClientFeatureSettings;
  page: ClientFeaturePage;
  served: readonly string[];
}): Record<ClientFeatureFlagName, ClientFeatureAvailability> {
  return Object.fromEntries(CLIENT_FEATURE_FLAG_NAMES.map((flag) => [
    flag,
    evaluateClientFeature({ ...input, flag }),
  ])) as Record<ClientFeatureFlagName, ClientFeatureAvailability>;
}

/** The bootstrap's top-level `flags`: a flag is on only with the master switch on and `"*"` on. */
export function clientBootstrapFlags(settings: ClientFeatureSettings): Record<ClientFeatureFlagName, boolean> {
  return Object.fromEntries(CLIENT_FEATURE_FLAG_NAMES.map((flag) => [
    flag,
    settings.enabled && flagValue(settings, "*", flag) === true,
  ])) as Record<ClientFeatureFlagName, boolean>;
}

/**
 * The server's own check of the extension's version (the owner's
 * `chatExtensionMinVersion`): `client_outdated` when the caller's
 * `x-client-version` is not `chat-extension/<MAJOR.MINOR.PATCH>` at or above the
 * minimum, null when it is. Unreadable fails closed, both ways: a header that
 * does not parse, and a minimum that does not parse.
 */
export function clientVersionRefusal(minVersion: string, clientVersionHeader: unknown): "client_outdated" | null {
  const minimum = parseClientSemver(minVersion);
  const version = parseChatExtensionClientVersion(clientVersionHeader);
  if (minimum === null || version === null) {
    return "client_outdated";
  }
  return compareClientSemver(version, minimum) < 0 ? "client_outdated" : null;
}
