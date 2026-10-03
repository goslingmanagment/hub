import type { ClientBootstrapPage, ClientBootstrapResponse } from "@agency_hub_core/contracts";
import { listClientBootstrapPages, type ClientBootstrapPageRow, type Database } from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import { SERVED_CLIENT_CAPABILITIES } from "./client-capabilities.ts";
import {
  CLIENT_FEATURE_CODE_DEFAULTS,
  clientBootstrapFlags,
  evaluateClientPageFeatures,
  type ClientFeatureSettings,
} from "./client-features.ts";
import { CLIENT_BOOTSTRAP_LIMITS } from "./client-limits.ts";

/** The bootstrap protocol this hub speaks; a client that does not speak it asks the chatter to update. */
export const CLIENT_BOOTSTRAP_PROTOCOL = 1;
/** How long a client may serve one bootstrap from its cache. */
export const CLIENT_BOOTSTRAP_TTL_SEC = 300;
/** No client version is refused until the owner sets a minimum. */
export const CLIENT_MIN_VERSION_DEFAULT = "0.0.0";

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
      page: { label: row.label, platform: row.platform },
      served,
    }),
  };
}

/**
 * The chat extension's bootstrap. Database only: one read of the caller's
 * pages, no platform request and no queued work.
 *
 * The owner's switches do not exist yet, so the hub answers with its code
 * defaults: the master switch off, every feature `disabled` (or
 * `platform_unsupported` where the feature does not exist), every flag off, no
 * host bindings, no admitted send profiles, nothing served.
 */
export async function buildClientBootstrap(
  db: Database,
  caller: ClientBootstrapCaller,
  now: Date = new Date(),
): Promise<ClientBootstrapResponse> {
  const settings = CLIENT_FEATURE_CODE_DEFAULTS;
  const served = SERVED_CLIENT_CAPABILITIES;
  const rows = await listClientBootstrapPages(db, caller.pageIds);
  return {
    protocol: CLIENT_BOOTSTRAP_PROTOCOL,
    issuedAt: now.toISOString(),
    ttlSec: CLIENT_BOOTSTRAP_TTL_SEC,
    configRevision: 0,
    minVersion: CLIENT_MIN_VERSION_DEFAULT,
    identity: {
      userId: caller.user.id,
      username: caller.user.username,
      role: caller.user.role,
      tokenClient: null,
    },
    pages: rows.map((row) => toBootstrapPage(row, settings, served)),
    bindingsByHost: {},
    flags: clientBootstrapFlags(settings),
    limits: { ...CLIENT_BOOTSTRAP_LIMITS, previewSendReceiptProfiles: [] },
    capabilities: [...served],
  };
}
