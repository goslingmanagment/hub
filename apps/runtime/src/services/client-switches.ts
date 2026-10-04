import type { ClientFeatureFlagName, ClientReceiptProfile } from "@agency_hub_core/contracts";
import { getConfigOverrides, listClientBootstrapPages, type ClientBootstrapPageRow } from "@agency_hub_core/db";
import {
  parseChatExtensionFeatures,
  parseChatExtensionHostBindings,
  parseChatExtensionMinVersion,
  parseChatExtensionReceiptProfiles,
  validateConfigOverride,
  type AppConfig,
  type ChatExtensionParseResult,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, type HumanAuthPrincipal } from "./auth.ts";
import { SERVED_CLIENT_CAPABILITIES } from "./client-capabilities.ts";
import {
  CLIENT_FEATURE_CODE_DEFAULTS,
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
 * must go further and read the switch inside its own transaction.
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
 * The settings whose change moves the bootstrap's `configRevision`. The three
 * keys later PRs add are listed already, so the revision means the same thing
 * from the first client on; a key that does not exist yet has no audit row.
 */
export const CLIENT_BOOTSTRAP_CONFIG_KEYS = [
  ...CLIENT_SWITCH_KEYS,
  "aiLiveTextContextMode",
  "aiTranscriptDeepMaxRows",
  "chatExtensionHealthIngestEnabled",
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
}

/** A stored switch the process could not read. */
export interface ClientSwitchProblem {
  key: string;
  error: string;
}

type ClientSwitchConfig = Pick<AppConfig, (typeof CLIENT_SWITCH_KEYS)[number]>;

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
 * Fails closed on every switch it cannot read: a stored override that no
 * longer validates (`stored`, from storedClientSwitchProblems) or an
 * environment value that does not parse. The extension is then switched off as
 * a whole, the unreadable key takes its resting value (never the value the
 * broken one would have hidden), and the problems are returned for the caller
 * to log.
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
  return {
    switches: {
      settings: {
        enabled: config.chatExtensionEnabled === true && problems.length === 0,
        features,
        hostBindings,
      },
      minVersion,
      receiptProfiles,
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
  for (const problem of problems) {
    const fingerprint = `${problem.key}\u0000${problem.error}`;
    if (loggedProblems.has(fingerprint) || loggedProblems.size >= LOGGED_PROBLEMS_MAX) {
      continue;
    }
    loggedProblems.add(fingerprint);
    app.logger?.error(
      { key: problem.key, error: problem.error },
      "chat-extension switch unreadable; the chat extension is off until it is fixed",
    );
  }
  return switches;
}

/** The request as the check reads it: only the client's version header. */
export interface ClientFeatureRequest {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * The server-side check of a chat-extension feature, which every client route
 * runs after resolving its page: the client may switch a feature off in its own
 * UI, but the hub decides for itself on every call.
 *
 * Refuses with 409 `client_feature_disabled` and the reason, in this order:
 * - `not_granted`: the page is not an active page granted to the caller (a
 *   missing page answers the same, so the refusal reveals nothing);
 * - the feature evaluation (`platform_unsupported`, `disabled`, `flag_off`,
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
): Promise<ClientBootstrapPageRow> {
  const [row] = canAccessPage(principal, page.id) ? await listClientBootstrapPages(app.db, [page.id]) : [];
  if (row === undefined) {
    throw new ClientFeatureDisabledError(flag, "not_granted");
  }
  const switches = await loadClientSwitches(app);
  const availability = evaluateClientFeature({
    settings: switches.settings,
    page: { label: row.label, platform: row.platform, platformAccountId: row.platformAccountId },
    flag,
    served: SERVED_CLIENT_CAPABILITIES,
  });
  if (!availability.available) {
    throw new ClientFeatureDisabledError(flag, availability.reason ?? "disabled");
  }
  const outdated = clientVersionRefusal(switches.minVersion, request.headers["x-client-version"]);
  if (outdated !== null) {
    throw new ClientFeatureDisabledError(flag, outdated);
  }
  return row;
}
