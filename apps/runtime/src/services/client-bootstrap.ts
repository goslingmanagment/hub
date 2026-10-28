import type { ClientBootstrapPage, ClientBootstrapResponse } from "@agency_hub_core/contracts";
import { getClientConfigRevision, listClientBootstrapPages, type ClientBootstrapPageRow } from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { loadAiTranscriptDeepMaxRows } from "./ai-transcript-depth.ts";
import { clientBootstrapCapabilities, SERVED_CLIENT_CAPABILITIES } from "./client-capabilities.ts";
import {
  clientBootstrapFlags,
  evaluateClientPageFeatures,
  hostBindingFitsPlatform,
  type ClientFeatureLane,
  type ClientFeatureSettings,
} from "./client-features.ts";
import { CLIENT_BOOTSTRAP_LIMITS } from "./client-limits.ts";
import { CLIENT_BOOTSTRAP_CONFIG_KEYS, loadClientSwitches } from "./client-switches.ts";
import { loadVoiceLane, type VoiceLanePage } from "./voice-lane.ts";

/** The bootstrap protocol this hub speaks; a client that does not speak it asks the chatter to update. */
export const CLIENT_BOOTSTRAP_PROTOCOL = 1;
/** How long a client may serve one bootstrap from its cache. */
export const CLIENT_BOOTSTRAP_TTL_SEC = 300;

/** A page's binding revision: OnlyFans pages are rebound upstream (their OFAPI
 *  binding generation counts it); Fansly and Telegram pages have no rebinding. */
const BINDING_REVISION: Readonly<Record<Platform, (row: ClientBootstrapPageRow) => number>> = {
  onlyfans: (row) => row.ofapiBindingGeneration,
  fansly: () => 1,
  telegram: () => 1,
};

export interface ClientBootstrapCaller {
  user: { id: number; username: string; role: string };
  /** The caller's page scope: null = every page (the owner). */
  pageIds: readonly number[] | null;
  /** The caller token's client profile (H-3): null = a full token. */
  tokenClient: string | null;
}

const NO_LANES: ReadonlySet<ClientFeatureLane> = new Set();
const VOICE_NOTES_LANE: ReadonlySet<ClientFeatureLane> = new Set(["voice-notes"]);

/**
 * The hub lanes that serve a page now (R20 HF-4б): the voice notes. A lookup
 * that fails serves none, so the bootstrap still answers and offers no voice:
 * the same fail-safe as the released clients' hint on GET /api/v1/pages.
 */
async function loadClientLanes(app: AppContext): Promise<(page: VoiceLanePage) => ReadonlySet<ClientFeatureLane>> {
  try {
    const voice = await loadVoiceLane(app);
    return (page) => (voice(page) ? VOICE_NOTES_LANE : NO_LANES);
  } catch (error) {
    app.logger.warn({ err: error }, "voice-notes lane lookup failed; the bootstrap offers no voice");
    return () => NO_LANES;
  }
}

function toBootstrapPage(
  row: ClientBootstrapPageRow,
  settings: ClientFeatureSettings,
  served: readonly string[],
  lanes: ReadonlySet<ClientFeatureLane>,
): ClientBootstrapPage {
  const displayName = row.displayName?.trim();
  return {
    pageId: row.id,
    pageLabel: row.label,
    title: displayName ? displayName : row.modelName,
    platform: row.platform,
    platformAccountId: row.platformAccountId,
    bindingRevision: BINDING_REVISION[row.platform](row),
    features: evaluateClientPageFeatures({
      settings,
      page: { label: row.label, platform: row.platform, platformAccountId: row.platformAccountId },
      served,
      lanes,
    }),
    // Additive and open (Telegram spec §5.5): only a page that names one.
    ...(row.defaultPersonaKey !== null ? { defaultPersonaKey: row.defaultPersonaKey } : {}),
  };
}

/** The owner's host bindings as page ids, kept only for the caller's own
 *  active pages: a binding to a page that is missing, inactive or not granted
 *  is dropped, so the bootstrap never reveals that someone else's page exists.
 *  A binding whose host does not hold accounts of the page's platform (an
 *  OnlyMonster account bound to a Fansly page) is dropped too. */
function bindingsForCaller(
  hostBindings: Readonly<Record<string, string>>,
  rows: readonly ClientBootstrapPageRow[],
): Record<string, number> {
  const pageByLabel = new Map(rows.map((row) => [row.label, row]));
  return Object.fromEntries(Object.entries(hostBindings).flatMap(([host, label]) => {
    const page = pageByLabel.get(label);
    return page === undefined || !hostBindingFitsPlatform(host, page.platform) ? [] : [[host, page.id] as const];
  }));
}

/**
 * The chat extension's bootstrap. Database only: the config revision, the
 * effective config and the caller's pages; no platform request and no queued
 * work.
 *
 * Every feature, flag and limit follows the owner's live switches
 * (client-switches.ts), and a feature that runs on a hub lane follows that
 * lane's live state too (`voice`: the voice-notes lane, R20 HF-4б). The
 * revision is read BEFORE the switches and the lanes: a change that lands
 * between the reads is then served under the older revision, and the client's
 * next bootstrap sees the revision move. The other order could pair a newer
 * revision with older switches, and the client would keep them.
 */
export async function buildClientBootstrap(
  app: AppContext,
  caller: ClientBootstrapCaller,
  now: Date = new Date(),
): Promise<ClientBootstrapResponse> {
  const configRevision = await getClientConfigRevision(app.db, CLIENT_BOOTSTRAP_CONFIG_KEYS);
  const switches = await loadClientSwitches(app);
  // The depth a full Recap may read: the same value the AI stream hands its
  // transcript readers.
  const deepMax = await loadAiTranscriptDeepMaxRows(app);
  const served = SERVED_CLIENT_CAPABILITIES;
  const lanes = await loadClientLanes(app);
  const rows = await listClientBootstrapPages(app.db, caller.pageIds);
  return {
    protocol: CLIENT_BOOTSTRAP_PROTOCOL,
    issuedAt: now.toISOString(),
    ttlSec: CLIENT_BOOTSTRAP_TTL_SEC,
    configRevision,
    minVersion: switches.minVersion,
    identity: {
      userId: caller.user.id,
      username: caller.user.username,
      role: caller.user.role,
      tokenClient: caller.tokenClient,
    },
    pages: rows.map((row) => toBootstrapPage(row, switches.settings, served, lanes(row))),
    bindingsByHost: bindingsForCaller(switches.settings.hostBindings, rows),
    flags: clientBootstrapFlags(switches.settings),
    limits: { ...CLIENT_BOOTSTRAP_LIMITS, deepMax, previewSendReceiptProfiles: [...switches.receiptProfiles] },
    capabilities: clientBootstrapCapabilities(switches),
  };
}
