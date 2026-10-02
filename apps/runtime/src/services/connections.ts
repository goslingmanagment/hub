import {
  getLatestSyncRunPerPage,
  listVisiblePages,
  findPageByLabel,
  storePlatformCredentials,
  type Database,
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
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { handleSuccessfulPageVerificationRecovery } from "./notification-incidents.ts";
import { resolveStoredProxyConfig, resolveStoredProxyEgressKey, saveProxy } from "./page-context.ts";
import { assertAllowedProxyTarget } from "./proxy-validation.ts";
import { fanslyPageSendGuard } from "./fansly-send-guard/index.ts";
import { checkFanslyIdentityThroughEngine, fanslyAccountRoute, trustStoredFanslyCredentials } from "./sync-engine-account.ts";
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

function assertVerifiedAccountIdentity(
  pageLabel: string,
  expectedPlatformAccountId: string | null,
  actualPlatformAccountId: string,
) {
  if (!expectedPlatformAccountId || expectedPlatformAccountId === actualPlatformAccountId) {
    return;
  }

  throw new ConflictError(
    `Submitted credentials belong to upstream account "${actualPlatformAccountId}", ` +
      `but page "${pageLabel}" is bound to "${expectedPlatformAccountId}"`,
  );
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
  const [latestRuns, snapshot] = await Promise.all([
    getLatestSyncRunPerPage(app.db, allPageIds, {
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

    const connectionStatus = classifyConnectionStatus(
      hasCredentials,
      page.lastLightSyncAt,
      latestRun,
    );

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
      lastSyncError: latestRun?.errorSummary ?? null,
      subscriberCount: serializePageMetric(page.subscriberCount),
      followerCount: serializePageMetric(page.followerCount),
      proxyUrl: page.proxyUrl ?? null,
      proxyHasAuth: page.proxyHasAuth ?? false,
      syncUx: syncByPageId.get(page.id) ?? buildPageSyncUx([]),
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
  // Step-3 design §3.5 item 6: on a live page the session check is the
  // engine's (`account.identity` with the candidate); a page being switched
  // refuses (409) before anything is sent or stored.
  const route = await fanslyAccountRoute(app, stored.page);

  const storedProxy = resolveStoredProxyConfig(app, stored.proxy);
  const storedEgressKey = resolveStoredProxyEgressKey(stored.proxy);
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
  const proxyEgressKey = preservesStoredProxyRoute
    ? storedEgressKey
    : buildProxyEgressKey(proxy);
  const storedCredentials = body.session === undefined
    ? decryptStoredCredentials(app, stored)
    : null;

  // Verify credentials with platform adapter
  const session = body.session ?? (
    storedCredentials?.platform === "fansly" ? storedCredentials.session : null
  );
  if (!session) {
    throw new BadRequestError(`Page "${stored.page.label}" has no stored Fansly session`);
  }

  if (route === "engine") {
    return updateEnginePageCredentials(app, stored.page, {
      // A parsed JSON body never carries an `undefined` member.
      session: (body.session ?? null) as FanslySessionBundle | null,
      proxy: explicitProxy && proxy ? proxy : null,
      rateLimitScopeKey: preservesStoredProxyRoute ? stored.proxy?.rateLimitScopeKey ?? null : null,
    });
  }

  const verification = await app.adapter.verifySession({
    session,
    proxy,
    egressKey: proxyEgressKey,
    // The page's own guard, whatever proxy the check rides (plan §2.4).
    sendGuard: fanslyPageSendGuard(app, stored.page.id, "account_me_api"),
  });
  assertVerifiedAccountIdentity(
    stored.page.label,
    stored.page.platformAccountId,
    verification.parsed.account.id,
  );

  // Save encrypted credentials
  const credentials: StoredPlatformCredentialBundle | null = body.session
    ? { platform: "fansly", session: body.session }
    : null;

  if (credentials) {
    const encrypted = encryptJson(
      credentials,
      app.config.encryptionKey,
      app.config.encryptionKeyVersion,
    );
    await storePlatformCredentials(app.db, {
      platformAccountId: stored.page.id,
      encryptedSession: JSON.stringify(encrypted),
      keyVersion: app.config.encryptionKeyVersion,
    });
  }

  if (explicitProxy && proxy) {
    await saveProxy(app, stored.page.id, proxy, {
      rateLimitScopeKey: preservesStoredProxyRoute ? stored.proxy?.rateLimitScopeKey : undefined,
    });
  }

  const recoveredAt = new Date();
  const recovery = await handleSuccessfulPageVerificationRecovery(app, {
    platformAccountId: stored.page.id,
    pageLabel: stored.page.label,
    platform: stored.page.platform,
    recoveredAt,
  });

  return { updated: true, verified: true, syncUnblocked: recovery.syncUnblocked };
}

/**
 * The credentials change of a live engine page (design step 3 §3.5 item 6):
 * the candidate is checked through the page's actor, then stored as the
 * legacy path stores it and trusted by the engine in ONE transaction (the
 * new digest lifts an auth hold of the old one). Nothing is stored when the
 * check does not match.
 */
async function updateEnginePageCredentials(
  app: AppContext,
  page: { id: number; label: string; platform: string },
  candidate: { session: FanslySessionBundle | null; proxy: ProxyConfig | null; rateLimitScopeKey: string | null },
) {
  await checkFanslyIdentityThroughEngine(app, page, { session: candidate.session, proxy: candidate.proxy });
  await app.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
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
    await trustStoredFanslyCredentials(tx, page);
  });
  const recovery = await handleSuccessfulPageVerificationRecovery(app, {
    platformAccountId: page.id,
    pageLabel: page.label,
    platform: "fansly",
    recoveredAt: new Date(),
    unblockLegacyStreams: false,
  });
  return { updated: true, verified: true, syncUnblocked: recovery.syncUnblocked };
}
