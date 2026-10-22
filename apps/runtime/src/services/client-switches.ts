import type { ClientFeatureFlagName, ClientHubCapabilityName, ClientReceiptProfile } from "@agency_hub_core/contracts";
import {
  findPageSummaryByLabel,
  getConfigOverrides,
  listClientBootstrapPages,
  lockConfigOverridesForShare,
  type ClientBootstrapPageRow,
  type Database,
} from "@agency_hub_core/db";
import {
  parseChatExtensionFeatures,
  parseChatExtensionHostBindings,
  parseChatExtensionMinVersion,
  parseChatExtensionReceiptProfiles,
  validateConfigOverride,
  type AppConfig,
  type ChatExtensionParseResult,
  type Platform,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, type HumanAuthPrincipal } from "./auth.ts";
import { SERVED_CLIENT_CAPABILITIES } from "./client-capabilities.ts";
import {
  CLIENT_FEATURE_CODE_DEFAULTS,
  clientFeatureExistsOn,
  clientFeatureNeedsOn,
  clientVersionRefusal,
  evaluateClientFeature,
  type ClientFeatureSettings,
} from "./client-features.ts";
import { applyEffectiveOverrides } from "./effective-config.ts";
import { ClientFeatureDisabledError } from "./errors.ts";

/**
 * The owner's switches for the chat extension (hub-pr-plan H-2b): the five
 * `chatExtension*` config keys, live and audited, read per request.
 *
 * Nothing here caches. Every bootstrap and every check reads the effective
 * config afresh (one `config_settings` read), so a switch the owner turns off
 * holds from the very next request. Sending from the preview (H-7b `dispatch`)
 * goes further and reads the switches inside its own transaction, from rows it
 * holds locked: loadClientSwitchesForSend.
 */

/** The owner's five switches of the chat extension. */
export const CLIENT_SWITCH_KEYS = [
  "chatExtensionEnabled",
  "chatExtensionFeatures",
  "chatExtensionMinVersion",
  "chatExtensionHostBindings",
  "chatExtensionPreviewSendReceiptProfiles",
] as const;

/**
 * The settings whose change moves the bootstrap's `configRevision`: the five
 * switches, the health intake's own switch (H-11b; it is not one of the five,
 * see `ClientSwitches.healthIngestEnabled`), the retired fresh-text mode
 * (its audit rows stay; without them the revision could step back, and a
 * running extension ignores a revision older than the one it holds), and the
 * full Recap's depth (`limits.deepMax`). Then the two switches of the
 * voice-notes lane that the bootstrap's `voice` reads (R20 HF-4б,
 * voice-lane.ts); the lane's other two conditions are no setting (the provider
 * is built at boot, a voice profile is a row of its own), and the client sees
 * them within the bootstrap's TTL.
 */
export const CLIENT_BOOTSTRAP_CONFIG_KEYS = [
  ...CLIENT_SWITCH_KEYS,
  "aiLiveTextContextMode",
  "aiTranscriptDeepMaxRows",
  "chatExtensionHealthIngestEnabled",
  "aiLiveImagesEnabled",
  "voiceNotesEnabled",
  "voiceNotesPageAllowlist",
] as const;

/** The resting minimum: every readable extension version passes until the owner sets one. */
export const CLIENT_MIN_VERSION_DEFAULT = "0.0.0";

export interface ClientSwitches {
  /** What the feature evaluation reads: master switch, flags, host bindings. */
  settings: ClientFeatureSettings;
  /** The lowest extension version the client routes serve (MAJOR.MINOR.PATCH). */
  minVersion: string;
  /** The admitted send paths of sending from the preview (X8); empty = X8 off. */
  receiptProfiles: readonly ClientReceiptProfile[];
  /**
   * Whether the hub keeps `client_health` reports and the bootstrap lists
   * `client-health-perf-v1` (H-11b): the owner's
   * `chatExtensionHealthIngestEnabled`, and only while the master switch is
   * on. Not one of the five switches: a stored override of it that no longer
   * validates falls back to the environment value (off unless a deployment
   * sets it).
   */
  healthIngestEnabled: boolean;
  /**
   * Whether the AI stream attaches the fan's photos the client sends
   * (`liveImages`) and the bootstrap lists `live-images-v1`: the owner's
   * `aiLiveImagesEnabled` (on unless switched off).
   */
  liveImagesEnabled: boolean;
}

/** A stored switch the process could not read. */
export interface ClientSwitchProblem {
  key: string;
  error: string;
}

type ClientSwitchConfig = Pick<AppConfig, (typeof CLIENT_SWITCH_KEYS)[number] | "chatExtensionHealthIngestEnabled" | "aiLiveImagesEnabled">;

/**
 * The stored overrides of the five switches that no longer validate. Pure.
 *
 * The write refuses a value that does not parse, but a row can still go bad
 * later: a hand-written SQL fix, or a parser a later PR makes stricter. The
 * live overlay (effective-config.ts) skips such a row silently and serves the
 * environment value in its place, which for a switch is failing OPEN: a
 * broken stored minimum would drop back to `0.0.0` and admit every outdated
 * client again. So the switches look at the stored rows themselves.
 */
export function storedClientSwitchProblems(
  overrides: ReadonlyMap<string, { value: unknown }>,
): ClientSwitchProblem[] {
  return CLIENT_SWITCH_KEYS.flatMap((key) => {
    const override = overrides.get(key);
    if (override === undefined) {
      return [];
    }
    const validated = validateConfigOverride(key, override.value);
    return validated.ok ? [] : [{ key, error: `the stored override is refused: ${validated.error}` }];
  });
}

/**
 * The switches from an effective config. Pure.
 *
 * A switch it cannot read — a stored override that no longer validates
 * (`stored`, from storedClientSwitchProblems) or an environment value that
 * does not parse — takes its resting value (never the value the broken one
 * would have hidden): no flags, no host bindings, no receipt profiles, no
 * minimum version, the master switch off. Only what that one switch governs
 * changes; the rest of the extension keeps working. The problems are returned
 * for the caller to log.
 */
export function readClientSwitches(
  config: Partial<ClientSwitchConfig>,
  stored: readonly ClientSwitchProblem[] = [],
): {
  switches: ClientSwitches;
  problems: ClientSwitchProblem[];
} {
  const problems: ClientSwitchProblem[] = [...stored];
  const unreadable = new Set(stored.map((problem) => problem.key));
  function read<T>(
    key: keyof ClientSwitchConfig,
    resting: T,
    parse: (text: string) => ChatExtensionParseResult<T>,
  ): T {
    const raw = config[key];
    if (unreadable.has(key) || typeof raw !== "string") {
      return resting;
    }
    const parsed = parse(raw.trim());
    if (parsed.ok) {
      return parsed.value;
    }
    problems.push({ key, error: parsed.error });
    return resting;
  }

  const features = read("chatExtensionFeatures", CLIENT_FEATURE_CODE_DEFAULTS.features, parseChatExtensionFeatures);
  const hostBindings = read("chatExtensionHostBindings", CLIENT_FEATURE_CODE_DEFAULTS.hostBindings, parseChatExtensionHostBindings);
  const minVersion = read("chatExtensionMinVersion", CLIENT_MIN_VERSION_DEFAULT, parseChatExtensionMinVersion);
  const receiptProfiles = read<readonly ClientReceiptProfile[]>(
    "chatExtensionPreviewSendReceiptProfiles",
    [],
    parseChatExtensionReceiptProfiles,
  );
  const enabled = !unreadable.has("chatExtensionEnabled") && config.chatExtensionEnabled === true;
  return {
    switches: {
      settings: { enabled, features, hostBindings },
      minVersion,
      receiptProfiles,
      healthIngestEnabled: enabled && config.chatExtensionHealthIngestEnabled === true,
      liveImagesEnabled: config.aiLiveImagesEnabled !== false,
    },
    problems,
  };
}

/** One log line per distinct problem per process: a bad env value is read on
 *  every request and would otherwise flood the log. Bounded. */
const loggedProblems = new Set<string>();
const LOGGED_PROBLEMS_MAX = 100;

/** The switches as a process reads them right now: the effective config (the
 *  owner's live overrides over the environment, as loadEffectiveConfig builds
 *  it from the same single read), parsed, with every stored switch that no
 *  longer validates counted as unreadable. */
export async function loadClientSwitches(app: AppContext): Promise<ClientSwitches> {
  const overrides = await getConfigOverrides(app.db);
  const effective = applyEffectiveOverrides(app.config, overrides);
  const { switches, problems } = readClientSwitches(effective, storedClientSwitchProblems(overrides));
  logClientSwitchProblems(app, problems);
  return switches;
}

/**
 * The switches as a send from the preview is decided (hub-pr-plan H-7b
 * `dispatch`, critic 7): read inside the dispatch's own transaction `tx`, from
 * the five stored rows locked FOR SHARE until it ends. The owner's change of a
 * switch that has a row waits for the dispatch, and a dispatch waits for a
 * change already under way and then reads it: a send is never admitted on a
 * switch value older than the last committed one.
 *
 * Only a STORED row of `chatExtensionEnabled` and of `chatExtensionFeatures`
 * admits a send. Without the row the key reads at rest (off, no flag), whatever
 * the environment says: a value the environment alone sets has no row to lock,
 * so turning it off would not wait for a send in flight, and no audit row says
 * who switched sending on. The other three switches keep their environment
 * value when they have no row, as everywhere else.
 */
export async function loadClientSwitchesForSend(app: AppContext, tx: Database): Promise<ClientSwitches> {
  const overrides = await lockConfigOverridesForShare(tx, CLIENT_SWITCH_KEYS);
  const atRest = {
    ...app.config,
    chatExtensionEnabled: CLIENT_FEATURE_CODE_DEFAULTS.enabled,
    chatExtensionFeatures: JSON.stringify(CLIENT_FEATURE_CODE_DEFAULTS.features),
  };
  const effective = applyEffectiveOverrides(atRest, overrides);
  const { switches, problems } = readClientSwitches(effective, storedClientSwitchProblems(overrides));
  logClientSwitchProblems(app, problems);
  return switches;
}

function logClientSwitchProblems(app: AppContext, problems: readonly ClientSwitchProblem[]): void {
  for (const problem of problems) {
    const fingerprint = `${problem.key}\u0000${problem.error}`;
    if (loggedProblems.has(fingerprint) || loggedProblems.size >= LOGGED_PROBLEMS_MAX) {
      continue;
    }
    loggedProblems.add(fingerprint);
    app.logger?.error(
      { key: problem.key, error: problem.error },
      "chat-extension switch unreadable; it serves its resting value until it is fixed",
    );
  }
}

/** The request as the check reads it: only the client's version header. */
export interface ClientFeatureRequest {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * The first step of every client page route, and the whole check of the claim
 * actions that no switch may refuse (H-7b): `release`, `sent` and `failed`,
 * which only end what the hub already admitted, and `registerNativeSend`,
 * which reports a send that has already happened. The page is an active page
 * granted to the caller, else 409 `client_feature_disabled` / `not_granted` (a
 * missing page answers the same, so the refusal reveals nothing). No switch
 * and no version is read: turning one off must not strand a lease, a send in
 * flight or the proof of a send. Returns the page as the bootstrap lists it.
 *
 * `existsWith` names the flagged feature the action belongs to, when it exists
 * only where that feature does: `platform_unsupported` on any other platform.
 * That is no switch: nothing of the feature can have happened there.
 */
export async function requireClientGrantedPage(
  app: AppContext,
  principal: HumanAuthPrincipal,
  page: { id: number } | null | undefined,
  feature: string,
  existsWith?: ClientFeatureFlagName,
): Promise<ClientBootstrapPageRow> {
  const [row] = page && canAccessPage(principal, page.id) ? await listClientBootstrapPages(app.db, [page.id]) : [];
  if (row === undefined) {
    throw new ClientFeatureDisabledError(feature, "not_granted");
  }
  if (existsWith !== undefined && !clientFeatureExistsOn(existsWith, row.platform)) {
    throw new ClientFeatureDisabledError(feature, "platform_unsupported");
  }
  return row;
}

/**
 * Why these switches refuse a flagged feature on a page, null when they do not:
 * the feature evaluation (`disabled`, `platform_unsupported`, `flag_off`,
 * `binding_missing`, `hub_not_ready`). Pure: requireClientFeature reads the
 * switches per request, a dispatch (H-7b) from rows locked in its transaction.
 */
export function clientFeatureRefusal(
  switches: ClientSwitches,
  row: ClientBootstrapPageRow,
  flag: ClientFeatureFlagName,
): string | null {
  const availability = evaluateClientFeature({
    settings: switches.settings,
    page: { label: row.label, platform: row.platform, platformAccountId: row.platformAccountId },
    flag,
    served: SERVED_CLIENT_CAPABILITIES,
  });
  return availability.available ? null : availability.reason ?? "disabled";
}

/**
 * The one check behind both requireClientFeature and requireClientPage, so a
 * refusal added here reaches every client route. In this order:
 * - `not_granted`: the page is not an active page granted to the caller (a
 *   missing page answers the same, so the refusal reveals nothing);
 * - what the route asks of the owner's switches on that page (`refusal`);
 * - `client_outdated`: the caller's `x-client-version` is below the owner's
 *   minimum or unreadable.
 *
 * `feature` is how the refusal names what was asked for. Returns the page as
 * the bootstrap lists it.
 */
async function requireClientPageRow(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  page: { id: number } | null | undefined,
  feature: string,
  refusal: (switches: ClientSwitches, row: ClientBootstrapPageRow) => string | null,
): Promise<ClientBootstrapPageRow> {
  const row = await requireClientGrantedPage(app, principal, page, feature);
  const switches = await loadClientSwitches(app);
  const reason = refusal(switches, row);
  if (reason !== null) {
    throw new ClientFeatureDisabledError(feature, reason);
  }
  const outdated = clientVersionRefusal(switches.minVersion, request.headers["x-client-version"]);
  if (outdated !== null) {
    throw new ClientFeatureDisabledError(feature, outdated);
  }
  return row;
}

/**
 * The server-side check of a chat-extension feature, which every client route
 * behind a flag runs after resolving its page: the client may switch a feature
 * off in its own UI, but the hub decides for itself on every call.
 *
 * Refuses with 409 `client_feature_disabled` and the reason, in this order:
 * - `not_granted`: the page is not an active page granted to the caller (a
 *   missing page answers the same, so the refusal reveals nothing);
 * - `disabled`: the master switch is off, on every platform;
 * - `platform_unsupported` when the route serves one part of the feature
 *   (`part`, its capability) and the feature needs no such part on the page's
 *   platform (clientFeatureNeedsOn: the list of new subscribers on Fansly,
 *   R20 HF-2);
 * - the feature evaluation (`platform_unsupported`, `flag_off`,
 *   `binding_missing`, `hub_not_ready`);
 * - `client_outdated`: the caller's `x-client-version` is below the owner's
 *   minimum or unreadable.
 *
 * Returns the page as the bootstrap lists it.
 */
export async function requireClientFeature(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  page: { id: number },
  flag: ClientFeatureFlagName,
  part?: ClientHubCapabilityName,
): Promise<ClientBootstrapPageRow> {
  return requireClientPageRow(app, request, principal, page, flag, (switches, row) => {
    if (!switches.settings.enabled) {
      return "disabled";
    }
    return part !== undefined && !clientFeatureNeedsOn(flag, part, row.platform)
      ? "platform_unsupported"
      : clientFeatureRefusal(switches, row, flag);
  });
}

/**
 * requireClientFeature for a page the request names by its label: the narrow
 * token's AI generations behind a flag (client-ai-switch.ts) and its voice
 * notes (R20 HF-4б, modules/voice). A label no page has answers like a page
 * not granted, so the refusal reveals nothing.
 */
export async function requireClientFeatureOnLabel(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  pageLabel: string,
  flag: ClientFeatureFlagName,
): Promise<ClientBootstrapPageRow> {
  const page = await findPageSummaryByLabel(app.db, pageLabel);
  return requireClientPageRow(app, request, principal, page, flag, (switches, row) => (
    clientFeatureRefusal(switches, row, flag)
  ));
}

/**
 * The same check for a client route that has no flag of its own (the
 * own-AI-spend read, H-15; the claim status, H-7b):
 * `not_granted`, then `disabled` while the owner's master switch is off, then
 * `client_outdated`. No flag, host binding or served capability is asked for.
 *
 * `page` is what the route resolved from its path, null or undefined when
 * there is no such page; `feature` is how the refusal names the route.
 * `existsWith` says where the route exists, when not on every platform: the
 * flagged feature it belongs to (it exists only where that feature does), or
 * a test of the platform (the claim status: where the greeting custody
 * exists, client-claim-admission.ts). `platform_unsupported` on any other
 * platform, after `disabled`, as in the feature evaluation. Without it no
 * platform is asked for.
 */
export async function requireClientPage(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  page: { id: number } | null | undefined,
  feature: string,
  existsWith?: ClientFeatureFlagName | ((platform: Platform) => boolean),
): Promise<ClientBootstrapPageRow> {
  const exists = existsWith === undefined ? null
    : typeof existsWith === "function" ? existsWith
    : (platform: Platform) => clientFeatureExistsOn(existsWith, platform);
  return requireClientPageRow(app, request, principal, page, feature, (switches, row) => {
    if (!switches.settings.enabled) {
      return "disabled";
    }
    if (exists !== null && !exists(row.platform)) {
      return "platform_unsupported";
    }
    return null;
  });
}
