import type { ClientBootstrapPage, ClientBootstrapResponse } from "@agency_hub_core/contracts";
import { getClientConfigRevision, listClientBootstrapPages, type ClientBootstrapPageRow } from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { SERVED_CLIENT_CAPABILITIES } from "./client-capabilities.ts";
import {
  clientBootstrapFlags,
  evaluateClientPageFeatures,
  hostBindingFitsPlatform,
  type ClientFeatureSettings,
} from "./client-features.ts";
import { CLIENT_BOOTSTRAP_LIMITS } from "./client-limits.ts";
import { CLIENT_BOOTSTRAP_CONFIG_KEYS, loadClientSwitches } from "./client-switches.ts";

/** The bootstrap protocol this hub speaks; a client that does not speak it asks the chatter to update. */
export const CLIENT_BOOTSTRAP_PROTOCOL = 1;
/** How long a client may serve one bootstrap from its cache. */
export const CLIENT_BOOTSTRAP_TTL_SEC = 300;

/** A page's binding revision: OnlyFans pages are rebound upstream (their OFAPI
 *  binding generation counts it); Fansly pages have no rebinding. */
const BINDING_REVISION: Readonly<Record<Platform, (row: ClientBootstrapPageRow) => number>> = {
  onlyfans: (row) => row.ofapiBindingGeneration,
  fansly: () => 1,
};

export interface ClientBootstrapCaller {
  user: { id: number; username: string; role: string };
  /** The caller's page scope: null = every page (the owner). */
  pageIds: readonly number[] | null;
}

function toBootstrapPage(
  row: ClientBootstrapPageRow,
  settings: ClientFeatureSettings,
  served: readonly string[],
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
    }),
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
 * (client-switches.ts). The revision is read BEFORE the switches: a change that
 * lands between the two reads is then served under the older revision, and the
 * client's next bootstrap sees the revision move. The other order could pair a
 * newer revision with older switches, and the client would keep them.
 */
export async function buildClientBootstrap(
  app: AppContext,
  caller: ClientBootstrapCaller,
  now: Date = new Date(),
): Promise<ClientBootstrapResponse> {
  const configRevision = await getClientConfigRevision(app.db, CLIENT_BOOTSTRAP_CONFIG_KEYS);
  const switches = await loadClientSwitches(app);
  const served = SERVED_CLIENT_CAPABILITIES;
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
      tokenClient: null,
    },
    pages: rows.map((row) => toBootstrapPage(row, switches.settings, served)),
    bindingsByHost: bindingsForCaller(switches.settings.hostBindings, rows),
    flags: clientBootstrapFlags(switches.settings),
    limits: { ...CLIENT_BOOTSTRAP_LIMITS, previewSendReceiptProfiles: [...switches.receiptProfiles] },
    capabilities: [...served],
  };
}
