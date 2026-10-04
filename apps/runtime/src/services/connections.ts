import {
  getLatestSyncRunPerPage,
  listVisiblePages,
  findPageByLabel,
  storePlatformCredentials,
} from "@agency_hub_core/db";
import type { SyncUxSummary, UpdateCredentialsBody } from "@agency_hub_core/contracts";
import {
  buildProxyEgressKey,
  decryptJsonWithKeyVersion,
  encryptJson,
  normalizeProxyConfig,
  redactSensitiveText,
  type FanslySessionBundle,
  type StoredPlatformCredentialBundle,
  type ProxyConfig,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, NotFoundError } from "./errors.ts";
import { handleSuccessfulPageVerificationRecovery } from "./notification-incidents.ts";
import { resolveStoredProxyConfig, saveProxy } from "./page-context.ts";
import { assertAllowedProxyTarget } from "./proxy-validation.ts";
import { legacyExecutorPlatforms } from "../sync/onlyfans/boundary.ts";
import { assertFanslyPageOnEngine, checkFanslyIdentityThroughEngine, saveVerifiedFanslyCredentials } from "./sync-engine-account.ts";
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

function decryptStoredCredentials(
  app: Pick<AppContext, "config">,
  stored: NonNullable<Awaited<ReturnType<typeof findPageByLabel>>>,
): StoredPlatformCredentialBundle {
  if (!stored.credentials) {
    throw new BadRequestError(`Page "${stored.page.label}" has no stored credentials`);
  }

  const decrypted = decryptJsonWithKeyVersion<StoredPlatformCredentialBundle>(
    stored.credentials.encryptedSession,
    app.config.encryptionKeysByVersion,
  );
  if (decrypted.platform !== stored.page.platform) {
    throw new BadRequestError(
      `Stored credentials for page "${stored.page.label}" do not match platform ${stored.page.platform}`,
    );
  }

  return decrypted;
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
 *  engine holds the page for its credentials (the page's sync summary asks for
 *  new ones), else by the age of the account read the engine stamps on the
 *  page (`account.poll`, hourly). No legacy run is consulted. */
function classifyEngineConnectionStatus(
  hasCredentials: boolean,
  lastLightSyncAt: Date | null,
  credentialsRefused: boolean,
): ConnectionStatus {
  if (!hasCredentials) {
    return "unverified";
  }
  if (credentialsRefused) {
    return "expired";
  }
  return classifyConnectionStatus(hasCredentials, lastLightSyncAt, null);
}

function normalizeProxyInput(proxy: ProxyConfig) {
  try {
    return normalizeProxyConfig(proxy);
  } catch (error) {
    throw new BadRequestError(
      `Invalid proxy URL: ${redactSensitiveText(error instanceof Error ? error.message : "Invalid proxy URL")}`,
    );
  }
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
    // The engine's summary requires action for one thing on a page that has
    // credentials: the engine holds the page until new ones are saved.
    const engineCredentialsRefused = !legacy && hasCredentials && syncUx.requiresAction;

    const connectionStatus = legacy
      ? classifyConnectionStatus(hasCredentials, page.lastLightSyncAt, latestRun)
      : classifyEngineConnectionStatus(hasCredentials, page.lastLightSyncAt, engineCredentialsRefused);

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

export async function updatePageCredentials(
  app: AppContext,
  pageLabel: string,
  body: UpdateCredentialsBody,
) {
  const stored = await findPageByLabel(app.db, pageLabel);
  if (!stored) {
    throw new NotFoundError(`Page "${pageLabel}" not found`);
  }

  if (stored.page.platform !== body.platform) {
    throw new BadRequestError(
      `Platform mismatch: page is ${stored.page.platform}, credentials are for ${body.platform}`,
    );
  }
  if (body.platform === "onlyfans") {
    // Stage 18: OnlyMonster retired. OnlyFans pages hold no pasted
    // credentials or hub-side proxy — identity and egress live at the OFAPI
    // vendor (setPageOfapiAccountId), so there is nothing to update here.
    throw new BadRequestError(
      `OnlyFans pages have no stored credentials to update: page "${stored.page.label}" syncs via its OFAPI account mapping`,
    );
  }
  // Step-3 design §3.5 item 6: the session check is the engine's
  // (`account.identity` with the candidate). A page being switched, or one the
  // engine does not run, refuses (409) before anything is sent or stored — no
  // legacy `/account/me` is left to check it with (step 4, S4-19).
  await assertFanslyPageOnEngine(app, stored.page);

  const storedProxy = resolveStoredProxyConfig(app, stored.proxy);
  const explicitProxy = body.proxy === undefined ? null : normalizeProxyInput(body.proxy);
  if (explicitProxy) {
    await assertAllowedProxyTarget(explicitProxy);
  }
  const storedProxyRouteKey = storedProxy ? buildProxyEgressKey(storedProxy) : null;
  const explicitProxyRouteKey = explicitProxy ? buildProxyEgressKey(explicitProxy) : null;
  const matchesStoredProxyRoute = Boolean(
    storedProxyRouteKey && explicitProxyRouteKey && storedProxyRouteKey === explicitProxyRouteKey,
  );
  const reusesStoredProxyAuth = explicitProxy && storedProxy && matchesStoredProxyRoute &&
    explicitProxy.username === null && explicitProxy.password === null &&
    (storedProxy.username !== null || storedProxy.password !== null);
  const proxy = body.proxy === undefined
    ? storedProxy
    : reusesStoredProxyAuth
      ? storedProxy
      : explicitProxy;
  const proxyRouteKey = proxy ? buildProxyEgressKey(proxy) : null;
  const preservesStoredProxyRoute = Boolean(
    proxyRouteKey && storedProxyRouteKey && proxyRouteKey === storedProxyRouteKey,
  );
  // A change without a session rides the stored one: it must be there and
  // readable as this page's (400 otherwise, before any work is queued).
  if (body.session === undefined) {
    decryptStoredCredentials(app, stored);
  }

  return updateEnginePageCredentials(app, stored.page, {
    // A parsed JSON body never carries an `undefined` member.
    session: (body.session ?? null) as FanslySessionBundle | null,
    proxy: explicitProxy && proxy ? proxy : null,
    rateLimitScopeKey: preservesStoredProxyRoute ? stored.proxy?.rateLimitScopeKey ?? null : null,
  });
}

/**
 * The credentials change of a live engine page (design step 3 §3.5 item 6):
 * the candidate is checked through the page's actor, then stored and trusted
 * by the engine in ONE transaction that is
 * a CAS on the pair the check proved (step 3b ruling 5). Nothing is stored
 * when the check does not match or the stored credentials changed since. An
 * auth hold of the old credentials ends when the engine's verify of the new
 * ones passes (A3).
 */
async function updateEnginePageCredentials(
  app: AppContext,
  page: { id: number; label: string; platform: string },
  candidate: { session: FanslySessionBundle | null; proxy: ProxyConfig | null; rateLimitScopeKey: string | null },
) {
  const verified = await checkFanslyIdentityThroughEngine(app, page, { session: candidate.session, proxy: candidate.proxy });
  await saveVerifiedFanslyCredentials(app, page, verified, async (tx) => {
    if (candidate.session !== null) {
      const encrypted = encryptJson(
        { platform: "fansly", session: candidate.session } satisfies StoredPlatformCredentialBundle,
        app.config.encryptionKey,
        app.config.encryptionKeyVersion,
      );
      await storePlatformCredentials(tx, {
        platformAccountId: page.id,
        encryptedSession: JSON.stringify(encrypted),
        keyVersion: app.config.encryptionKeyVersion,
      });
    }
    if (candidate.proxy !== null) {
      await saveProxy({ config: app.config, db: tx }, page.id, candidate.proxy,
        candidate.rateLimitScopeKey === null ? {} : { rateLimitScopeKey: candidate.rateLimitScopeKey });
    }
  });
  await handleSuccessfulPageVerificationRecovery(app, {
    platformAccountId: page.id,
    pageLabel: page.label,
    platform: "fansly",
    recoveredAt: new Date(),
  });
  // `syncUnblocked` stays in the contract for its clients (see
  // `verifyPageOnEngine`): nothing of the legacy engine is left to unblock.
  return { updated: true, verified: true, syncUnblocked: true };
}
