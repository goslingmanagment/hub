import { getLatestSyncRunPerPage, listVisiblePages } from "@agency_hub_core/db";
import type { SyncUxSummary } from "@agency_hub_core/contracts";

import type { AppContext } from "../bootstrap.ts";
import { legacyExecutorPlatforms } from "../sync/onlyfans/boundary.ts";
import { buildPageSyncUx } from "./sync-ux.ts";
import { getSyncStatusSummarySnapshot } from "./sync-summary.ts";

export type ConnectionStatus =
  | "active"
  | "stale"
  | "error"
  | "expired"
  | "never_synced"
  | "unverified";

const STALE_THRESHOLD_HOURS = 9;

function serializePageMetric(value: number | null | undefined) {
  return {
    value: value ?? null,
    available: value !== null && value !== undefined,
  };
}

// Match only specific authentication-failure signals. Bare "auth"/"token"
// substrings are intentionally excluded so summaries mentioning "authority" or
// "token bucket" don't get misclassified as expired credentials.
const AUTH_ERROR_SIGNALS = [
  "401",
  "unauthorized",
  "403",
  "forbidden",
  "invalid token",
  "expired",
  "authentication",
] as const;

function isAuthError(errorSummary: string | null): boolean {
  if (!errorSummary) return false;
  const lower = errorSummary.toLowerCase();
  return AUTH_ERROR_SIGNALS.some((signal) => lower.includes(signal));
}

function classifyConnectionStatus(
  hasCredentials: boolean,
  lastLightSyncAt: Date | null,
  latestRun: {
    status: string;
    errorSummary: string | null;
  } | null,
): ConnectionStatus {
  if (!hasCredentials) {
    return "unverified";
  }

  if (!lastLightSyncAt) {
    return "never_synced";
  }

  if (latestRun) {
    if (
      (latestRun.status === "failed") &&
      isAuthError(latestRun.errorSummary)
    ) {
      return "expired";
    }

    if (latestRun.status === "failed") {
      return "error";
    }
  }

  const hoursSinceSync = (Date.now() - lastLightSyncAt.getTime()) / (1000 * 60 * 60);
  if (hoursSinceSync > STALE_THRESHOLD_HOURS) {
    return "stale";
  }

  return "active";
}

/** The connection of a page the Fansly Sync Engine reads: `expired` while the
 *  engine holds the page for its login (the page's sync summary asks for a
 *  new one), else by the age of the account read the engine stamps on the
 *  page (`account.poll`, hourly). No legacy run is consulted, and no session
 *  stored in Hub: the page's is its browser's. */
function classifyEngineConnectionStatus(
  lastLightSyncAt: Date | null,
  credentialsRefused: boolean,
): ConnectionStatus {
  if (credentialsRefused) {
    return "expired";
  }
  return classifyConnectionStatus(true, lastLightSyncAt, null);
}

export async function listConnectionStatuses(
  app: AppContext,
  input?: {
    pageIds?: number[];
    pages?: Awaited<ReturnType<typeof listVisiblePages>>;
    syncUxByPageId?: ReadonlyMap<number, SyncUxSummary>;
  },
) {
  const pages = input?.pages ?? await listVisiblePages(app.db, input?.pageIds);
  if (pages.length === 0) {
    return [];
  }

  const allPageIds = pages.map((p) => p.id);
  // Only a page the legacy executor serves has legacy runs to judge its
  // connection by; a Fansly page's is the engine's (its sync summary).
  const legacyPlatforms = legacyExecutorPlatforms();
  const [latestRuns, snapshot] = await Promise.all([
    getLatestSyncRunPerPage(app.db, pages.filter((p) => legacyPlatforms.includes(p.platform)).map((p) => p.id), {
      stream: "light",
    }),
    input?.syncUxByPageId
      ? Promise.resolve(null)
      : getSyncStatusSummarySnapshot(app, { pageIds: allPageIds }),
  ]);
  const runsByPageId = new Map(latestRuns.map((r) => [r.platformAccountId, r]));
  const syncByPageId = input?.syncUxByPageId ?? new Map(
    (snapshot?.pages ?? []).map((page) => [page.pageId, page.syncUx]),
  );

  return pages.map((page) => {
    const latestRun = runsByPageId.get(page.id) ?? null;
    const hasCredentials = page.hasCredentials;
    const syncUx = syncByPageId.get(page.id) ?? buildPageSyncUx([]);
    const legacy = legacyPlatforms.includes(page.platform);
    // The engine's summary requires action for one thing: the engine holds
    // the page until the owner logs its browser in again.
    const engineCredentialsRefused = !legacy && syncUx.requiresAction;

    const connectionStatus = legacy
      ? classifyConnectionStatus(hasCredentials, page.lastLightSyncAt, latestRun)
      : classifyEngineConnectionStatus(page.lastLightSyncAt, engineCredentialsRefused);

    return {
      id: page.id,
      label: page.label,
      platform: page.platform,
      modelSlug: page.modelSlug,
      modelName: page.modelName,
      username: page.username,
      displayName: page.displayName,
      connectionStatus,
      lastLightSyncAt: page.lastLightSyncAt?.toISOString() ?? null,
      lastFollowerSyncAt: page.lastFollowerSyncAt?.toISOString() ?? null,
      lastSyncError: legacy ? latestRun?.errorSummary ?? null : engineCredentialsRefused ? syncUx.detail : null,
      subscriberCount: serializePageMetric(page.subscriberCount),
      followerCount: serializePageMetric(page.followerCount),
      proxyUrl: page.proxyUrl ?? null,
      proxyHasAuth: page.proxyHasAuth ?? false,
      syncUx,
    };
  });
}
