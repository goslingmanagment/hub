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

/** What a feature needs on one platform before the hub can offer it there. */
export interface ClientFeaturePlatformRequirement {
  /** Hub capabilities that must be served (SERVED_CLIENT_CAPABILITIES). */
  capabilities: readonly ClientHubCapabilityName[];
  /**
   * The hub lane the feature runs on there, if any (R20 HF-4б). The
   * bootstrap's page `features` read `lane_off` where the lane does not serve
   * the page; a call is answered by the lane's own admission instead (see
   * evaluateClientPageFeatures).
   */
  lane?: ClientFeatureLane;
}

/**
 * What a feature needs, by platform (R20 HF-2): one entry per platform the
 * feature exists on. A platform with no entry has no such feature: every page
 * of it reads `platform_unsupported` while the master switch is on; with the
 * master off every feature on every platform reads `disabled`.
 */
export type ClientFeatureRequirement = Readonly<Partial<Record<Platform, ClientFeaturePlatformRequirement>>>;

/** A feature the hub has no action behind (the client's alone), or one whose action needs nothing new. */
const NOTHING: ClientFeaturePlatformRequirement = { capabilities: [] };

/**
 * Every flag the extension knows, by the platforms it exists on, with what it
 * needs there (chat-extension R20 architecture §1.4, §11.1).
 *
 * OnlyFans (ChatSpace) has every flag but Fansly's own; since 2026-10-28 the
 * fan's notes and their fill too (`notes`, `notesFill`): the extension keeps
 * them in OnlyMonster's own fan notes there, and the fill reads the hub's
 * archive as on every OnlyFans page. Fansly (R20 HF-2) has
 * what the extension does there: the dock's drafts behind `drafts`, insertion,
 * fresh text, Split, Recap, Review, Coach, the Spenders board with its
 * preview and its statistics with «Ждут ответа» (`stats`: silence reads the
 * store a generation of the page reads, spender-stats.ts), the fan panel, the
 * sound, «Новые» with their greeting custody, and its own voice notes, notes,
 * notes fill, vault and «Регистрация». It has no sending from the preview (X8:
 * `previewSend`, `previewSendMarkAiGenerated`), no ChatSpace navigation or
 * socket tap.
 *
 * Where a Fansly feature reads by conversation it also needs
 * `conversation-recaps-v1` (R20 HF-10: a Fansly chat is a group apart from its
 * fan), and Fansly's «Новые» need the manual greeting group, not the hub's
 * list of new subscribers (`audience-new-v1`): the extension finds them itself
 * (architecture §8.7).
 */
export const CLIENT_FEATURE_REQUIREMENTS: Readonly<Record<ClientFeatureFlagName, ClientFeatureRequirement>> = {
  // Client-only: the hub has no action behind these.
  insertion: { onlyfans: NOTHING, fansly: NOTHING },
  navigation: { onlyfans: NOTHING },
  wsTap: { onlyfans: NOTHING },
  sound: { onlyfans: NOTHING, fansly: NOTHING },
  fanPanel: { onlyfans: NOTHING, fansly: NOTHING },
  previewSendMarkAiGenerated: { onlyfans: NOTHING },
  // Client-only too: the existing spenders reads are not changed.
  spenders: { onlyfans: NOTHING, fansly: NOTHING },
  // AI features the narrow token's AI switch checks.
  review: { onlyfans: NOTHING, fansly: NOTHING },
  coach: { onlyfans: NOTHING, fansly: NOTHING },
  // R20 HF-8б: the fresh text of the open chat on Fansly too, by the page's
  // own flag (live-text.ts).
  freshText: { onlyfans: { capabilities: ["live-text-v1"] }, fansly: { capabilities: ["live-text-v1"] } },
  // Split for Ping, Hi and Coach drafts: the same gate on both (client-split-all.ts).
  splitAll: { onlyfans: { capabilities: ["split-all-v1"] }, fansly: { capabilities: ["split-all-v1"] } },
  recap: {
    onlyfans: { capabilities: ["shared-recaps-v1", "recap-profile-v1"] },
    fansly: { capabilities: ["shared-recaps-v1", "recap-profile-v1", "conversation-recaps-v1"] },
  },
  preview: {
    onlyfans: { capabilities: ["archive-feed-v1"] },
    fansly: { capabilities: ["archive-feed-v1", "conversation-recaps-v1"] },
  },
  // The stats and the queue read the page's own stores; a queue row names the
  // fan, and on Fansly the extension finds the fan's group itself, as it does
  // for a row of the board.
  stats: {
    onlyfans: { capabilities: ["spenders-stats-v1", "awaiting-reply-v1"] },
    fansly: { capabilities: ["spenders-stats-v1", "awaiting-reply-v1"] },
  },
  // On Fansly the greeting custody alone (client-claim-admission.ts): a greeting
  // under `newcomers` without `previewSend`, an AI or a manual group. On
  // OnlyFans a greeting and a reply from the preview take a manual group too
  // (the chatter's own or edited text, audit 2026-10-20 row 1): the name
  // `manual-greeting-v1` is historical and covers both there.
  newcomers: {
    onlyfans: { capabilities: ["audience-new-v1", "preview-send-custody-v1", "manual-greeting-v1"] },
    fansly: { capabilities: ["preview-send-custody-v1", "manual-greeting-v1"] },
  },
  previewSend: { onlyfans: { capabilities: ["preview-send-custody-v1", "manual-greeting-v1"] } },
  // R20 HF-12: on Fansly the narrow token's AI switch puts Reply, Fix, Hi and
  // Ping behind `drafts`, the voice script behind `voice` and the notes fill
  // behind `notesFill` (client-ai-switch.ts). On OnlyFans these flags do not
  // exist and those generations keep the master switch and the version.
  drafts: { fansly: NOTHING },
  // R20 HF-4б: `voice` also opens the voice-note routes to the narrow token
  // (`voice-notes-v1`, modules/voice), and the bootstrap offers it only on a
  // page the voice-notes lane serves. On OnlyFans (the extension over
  // ChatSpace) the same flag gates the voice script and the voice-note routes; the
  // chat id is the fan id there, so the render names one ref.
  voice: {
    onlyfans: { capabilities: ["voice-notes-v1"], lane: "voice-notes" },
    fansly: { capabilities: ["voice-notes-v1"], lane: "voice-notes" },
  },
  // The notes fill on both: on OnlyFans the extension fills the questionnaire
  // it keeps in OnlyMonster's fan notes (2026-10-28).
  notesFill: { onlyfans: NOTHING, fansly: NOTHING },
  // R20 HF-2: the fan's notes in the chat's header, the vault panel and
  // «Регистрация» are the extension's own on Fansly; the hub has no action
  // behind them. The notes are on OnlyFans too, kept in OnlyMonster's fan
  // notes by the extension (2026-10-28).
  notes: { onlyfans: NOTHING, fansly: NOTHING },
  vault: { fansly: NOTHING },
  registration: { fansly: NOTHING },
};

/** What a flagged feature needs on a platform; undefined where it does not exist. */
export function clientFeatureRequirementOn(
  flag: ClientFeatureFlagName,
  platform: Platform,
): ClientFeaturePlatformRequirement | undefined {
  const requirement = CLIENT_FEATURE_REQUIREMENTS[flag];
  return Object.hasOwn(requirement, platform) ? requirement[platform] : undefined;
}

/**
 * The platforms whose pages take the owner's `"*"` row (R20 HF-2). A Fansly
 * page is switched on by its own row alone: the `"*"` row was written for the
 * OnlyFans pages, and no owner's row reaches a Fansly page it does not name
 * (architecture §11.1). The bootstrap's top-level `flags`, which carry the
 * `"*"` row, are therefore never a Fansly page's.
 */
const STAR_ROW_PLATFORMS: readonly Platform[] = ["onlyfans"];

/** Whether the owner's `"*"` row reaches the pages of this platform. */
export function clientStarRowReaches(platform: Platform): boolean {
  return STAR_ROW_PLATFORMS.includes(platform);
}

/**
 * R20 HF-10: the platforms whose chats have ids of their own (a Fansly chat is
 * a group). A client read by conversation there names the chat apart from its
 * fan, and the hub checks the pair (client-conversation.ts). On every other
 * platform the chat id IS the fan id (OnlyFans).
 */
const OWN_CONVERSATION_ID_PLATFORMS: readonly Platform[] = ["fansly"];

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
  ["onlymonster", ["onlyfans"]],
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
   * Flag values by scope: `"*"` for every page of a platform that takes it
   * (OnlyFans; clientStarRowReaches), a page label for that page. A page's own
   * value wins over `"*"`; a flag set nowhere is off. Unknown flag names are
   * ignored.
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
 * Whether a flagged feature exists on a platform at all: the evaluation asks
 * after the master switch. Also for a client route or action that has no flag
 * of its own but exists only where a feature does (the claim status and
 * registerNativeSend exist where the greeting custody does: where every flag
 * of one of its sends exists, client-claim-admission.ts).
 */
export function clientFeatureExistsOn(flag: ClientFeatureFlagName, platform: Platform): boolean {
  return clientFeatureRequirementOn(flag, platform) !== undefined;
}

/**
 * Whether a flagged feature needs this capability on a platform: false where
 * the feature does not exist. A client route that serves one part of a
 * feature exists where the feature's requirement there names the route's
 * capability: the list of new subscribers (`audience-new-v1`) is part of
 * `newcomers` on OnlyFans, and Fansly's «Новые» are found by the extension
 * itself (R20 architecture §8.7), so the list does not exist there.
 */
export function clientFeatureNeedsOn(
  flag: ClientFeatureFlagName,
  capability: ClientHubCapabilityName,
  platform: Platform,
): boolean {
  return clientFeatureRequirementOn(flag, platform)?.capabilities.includes(capability) ?? false;
}

/**
 * The reasons, in the order they are checked: the master switch is off
 * (`disabled` for every feature on every platform); the feature does not exist
 * on the page's platform; the flag is off for the page (its
 * own row, else the `"*"` row where the page's platform takes it: a Fansly
 * page reads its own row alone, R20 HF-2); the extension has no way to bind a
 * host account to the page; the hub does not serve what the feature needs on
 * the page's platform yet. (The bootstrap then asks the feature's hub lane,
 * evaluateClientPageFeatures.)
 */
export function evaluateClientFeature(input: {
  settings: ClientFeatureSettings;
  page: ClientFeaturePage;
  flag: ClientFeatureFlagName;
  served: readonly string[];
}): ClientFeatureAvailability {
  if (!input.settings.enabled) {
    return unavailable("disabled");
  }
  const requirement = clientFeatureRequirementOn(input.flag, input.page.platform);
  if (requirement === undefined) {
    return unavailable("platform_unsupported");
  }
  const on = flagValue(input.settings, input.page.label, input.flag)
    ?? (clientStarRowReaches(input.page.platform) ? flagValue(input.settings, "*", input.flag) : undefined)
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
    const lane = clientFeatureRequirementOn(flag, input.page.platform)?.lane;
    return [
      flag,
      availability.available && lane !== undefined && !input.lanes.has(lane) ? unavailable("lane_off") : availability,
    ];
  })) as Record<ClientFeatureFlagName, ClientFeatureAvailability>;
}

/**
 * The bootstrap's top-level `flags`: a flag is on only with the master switch
 * on and `"*"` on. The `"*"` row alone, as it always was: it reaches the pages
 * of the platforms that take it (OnlyFans) and no Fansly page, so a client
 * reads a page's switch from the page's own `features` (R20 HF-2).
 */
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
