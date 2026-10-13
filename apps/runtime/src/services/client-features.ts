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
 * edit, not a branch in every handler. The bootstrap then asks one thing more,
 * the hub lane a feature runs on (evaluateClientPageFeatures, R20 HF-4б).
 *
 * The owner's switches it reads come from client-switches.ts, which also holds
 * `requireClientFeature`, the server-side check every client route runs.
 */

/**
 * A lane of the hub with switches of its own that a feature runs on: the
 * voice notes (`voiceNotesEnabled`, the synthesis provider, the page allowlist,
 * the page's voice profile; voice-lane.ts). Whether it serves a page is live
 * state, not a capability this hub build serves.
 */
export type ClientFeatureLane = "voice-notes";

/** What a feature needs before the hub can offer it. */
export interface ClientFeatureRequirement {
  /** The platforms the feature exists on. */
  platforms: readonly Platform[];
  /** Hub capabilities that must be served (SERVED_CLIENT_CAPABILITIES). */
  capabilities: readonly ClientHubCapabilityName[];
  /**
   * The hub lane the feature runs on, if any (R20 HF-4б). The bootstrap's
   * page `features` read `lane_off` where the lane does not serve the page;
   * a call is answered by the lane's own admission instead (see
   * evaluateClientPageFeatures).
   */
  lane?: ClientFeatureLane;
}

const ONLYFANS: readonly Platform[] = ["onlyfans"];
const FANSLY: readonly Platform[] = ["fansly"];
const ONLYFANS_AND_FANSLY: readonly Platform[] = ["onlyfans", "fansly"];

/**
 * Every flag the extension knows, with what it needs. The pilot is OnlyFans
 * only; the flags of Fansly's own AI generations (R20 HF-12) exist on Fansly
 * alone, and fresh text (R20 HF-8б) on both.
 */
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
  // R20 HF-8б: the fresh text of the open chat on Fansly too, by the same
  // switch (`aiLiveTextContextMode` and the page's flag, live-text.ts).
  freshText: { platforms: ONLYFANS_AND_FANSLY, capabilities: ["live-text-v1"] },
  splitAll: { platforms: ONLYFANS, capabilities: ["split-all-v1"] },
  recap: { platforms: ONLYFANS, capabilities: ["shared-recaps-v1", "recap-profile-v1"] },
  preview: { platforms: ONLYFANS, capabilities: ["archive-feed-v1"] },
  stats: { platforms: ONLYFANS, capabilities: ["spenders-stats-v1", "awaiting-reply-v1"] },
  newcomers: { platforms: ONLYFANS, capabilities: ["audience-new-v1", "preview-send-custody-v1"] },
  previewSend: { platforms: ONLYFANS, capabilities: ["preview-send-custody-v1"] },
  // R20 HF-12: on Fansly the narrow token's AI switch puts Reply, Fix, Hi and
  // Ping behind `drafts`, the voice script behind `voice` and the notes fill
  // behind `notesFill` (client-ai-switch.ts). On OnlyFans these flags do not
  // exist and those generations keep the master switch and the version.
  drafts: { platforms: FANSLY, capabilities: [] },
  // R20 HF-4б: `voice` also opens the voice-note routes to the narrow token
  // (`voice-notes-v1`, modules/voice), and the bootstrap offers it only on a
  // page the voice-notes lane serves.
  voice: { platforms: FANSLY, capabilities: ["voice-notes-v1"], lane: "voice-notes" },
  notesFill: { platforms: FANSLY, capabilities: [] },
};

/**
 * R20 HF-10: the platforms whose chats have ids of their own (a Fansly chat is
 * a group). A client read by conversation there names the chat apart from its
 * fan, and the hub checks the pair (client-conversation.ts). On every other
 * platform the chat id IS the fan id (OnlyFans).
 */
const OWN_CONVERSATION_ID_PLATFORMS: readonly Platform[] = FANSLY;

/** Whether a page of this platform keys its chats by ids of their own, not by their fans. */
export function clientConversationsHaveOwnIds(platform: Platform): boolean {
  return OWN_CONVERSATION_ID_PLATFORMS.includes(platform);
}

/**
 * The host apps the extension runs over, by the prefix of a host account
 * (`onlymonster:36408`), with the platforms of the accounts each one holds: an
 * OnlyMonster account is an OnlyFans account. An owner's host binding counts
 * only toward a page of one of those platforms, and a host the hub does not
 * know binds nothing.
 */
const CLIENT_HOST_PLATFORMS: ReadonlyMap<string, readonly Platform[]> = new Map([
  ["onlymonster", ONLYFANS],
]);

/** Whether the owner's binding of this host account can point at a page of
 *  this platform. The bootstrap's `bindingsByHost` keeps only such bindings. */
export function hostBindingFitsPlatform(hostAccount: string, platform: Platform): boolean {
  const [host = ""] = hostAccount.split(":", 1);
  return CLIENT_HOST_PLATFORMS.get(host)?.includes(platform) ?? false;
}

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
 *  account id, or by an explicit owner binding from a host of the page's platform. */
function bindable(settings: ClientFeatureSettings, page: ClientFeaturePage): boolean {
  return page.platformAccountId !== null || Object.entries(settings.hostBindings).some(
    ([hostAccount, label]) => label === page.label && hostBindingFitsPlatform(hostAccount, page.platform),
  );
}

/**
 * Whether a flagged feature exists on a platform at all: the first thing the
 * evaluation asks. Also for a client route or action that has no flag of its
 * own but exists only where a feature does (the claim status and
 * registerNativeSend exist where the greeting custody does: where every flag
 * of one of its sends exists, client-claim-admission.ts).
 */
export function clientFeatureExistsOn(flag: ClientFeatureFlagName, platform: Platform): boolean {
  return CLIENT_FEATURE_REQUIREMENTS[flag].platforms.includes(platform);
}

/**
 * The reasons, in the order they are checked: the feature does not exist on the
 * page's platform; the master switch is off; the flag is off for the page; the
 * extension has no way to bind a host account to the page; the hub does not
 * serve what the feature needs yet. (The bootstrap then asks the feature's
 * hub lane, evaluateClientPageFeatures.)
 */
export function evaluateClientFeature(input: {
  settings: ClientFeatureSettings;
  page: ClientFeaturePage;
  flag: ClientFeatureFlagName;
  served: readonly string[];
}): ClientFeatureAvailability {
  const requirement = CLIENT_FEATURE_REQUIREMENTS[input.flag];
  if (!clientFeatureExistsOn(input.flag, input.page.platform)) {
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

/**
 * A page's `features` (the bootstrap): every known flag, evaluated, and then,
 * for a feature that the evaluation offers and that runs on a hub lane, that
 * lane: `lane_off` when it does not serve the page right now (R20 HF-4б). The
 * owner's flag on a page whose voice-notes lane is off reads unavailable, so
 * the extension offers no voice there.
 *
 * Only the bootstrap asks about the lane. A call is decided by the evaluation
 * above (requireClientFeature) and then by the lane's own admission, which
 * re-reads each of its switches live and answers with its own codes; and a
 * render the lane already admitted stays readable while its spend switch is
 * off, as the lane intends.
 */
export function evaluateClientPageFeatures(input: {
  settings: ClientFeatureSettings;
  page: ClientFeaturePage;
  served: readonly string[];
  /** The hub lanes that serve this page right now. */
  lanes: ReadonlySet<ClientFeatureLane>;
}): Record<ClientFeatureFlagName, ClientFeatureAvailability> {
  return Object.fromEntries(CLIENT_FEATURE_FLAG_NAMES.map((flag) => {
    const availability = evaluateClientFeature({ ...input, flag });
    const lane = CLIENT_FEATURE_REQUIREMENTS[flag].lane;
    return [
      flag,
      availability.available && lane !== undefined && !input.lanes.has(lane) ? unavailable("lane_off") : availability,
    ];
  })) as Record<ClientFeatureFlagName, ClientFeatureAvailability>;
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
