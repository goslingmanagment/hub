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
  type StoredPlatformCredentialBundle,
  type ProxyConfig,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { handleSuccessfulPageVerificationRecovery } from "./notification-incidents.ts";
import { findOnlyFansAccountByUsername } from "./onlyfans.ts";
import { removeProxy, resolveStoredProxyConfig, resolveStoredProxyEgressKey, saveProxy } from "./page-context.ts";
import { assertAllowedProxyTarget } from "./proxy-validation.ts";
import { createSyncRateLimitWaiter } from "./sync/rate-limiter.ts";
import { buildPageSyncUx } from "./sync-ux.ts";
import { getSyncStatusSnapshot } from "./sync-status.ts";

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

function isAuthError(errorSummary: string | null): boolean {
  if (!errorSummary) return false;
  const lower = errorSummary.toLowerCase();
  return (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("auth") ||
    lower.includes("token")
  );
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
      : getSyncStatusSnapshot(app, { pageIds: allPageIds }),
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

  const storedProxy = resolveStoredProxyConfig(app, stored.proxy);
  const storedEgressKey = resolveStoredProxyEgressKey(stored.proxy);
  const hasExplicitProxyInput = body.proxy !== undefined;
  const explicitProxy = body.proxy ? normalizeProxyInput(body.proxy) : null;
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
  const rateLimitWaiter = createSyncRateLimitWaiter(app, {
    egressKey: proxyEgressKey,
  });

  if (stored.page.platform !== body.platform) {
    throw new BadRequestError(
      `Platform mismatch: page is ${stored.page.platform}, credentials are for ${body.platform}`,
    );
  }

  const storedCredentials = body.platform === "fansly"
    ? body.session === undefined
      ? decryptStoredCredentials(app, stored)
      : null
    : body.auth === undefined
      ? decryptStoredCredentials(app, stored)
      : null;

  // Verify credentials with platform adapter
  if (body.platform === "fansly") {
    const session = body.session ?? (
      storedCredentials?.platform === "fansly" ? storedCredentials.session : null
    );
    if (!session) {
      throw new BadRequestError(`Page "${stored.page.label}" has no stored Fansly session`);
    }

    const verification = await app.adapter.verifySession({
      session,
      proxy,
      egressKey: proxyEgressKey,
      rateLimitWaiter,
    });
    assertVerifiedAccountIdentity(
      stored.page.label,
      stored.page.platformAccountId,
      verification.parsed.account.id,
    );
  } else {
    const auth = body.auth ?? (
      storedCredentials?.platform === "onlyfans" ? storedCredentials.auth : null
    );
    if (!auth) {
      throw new BadRequestError(`Page "${stored.page.label}" has no stored OnlyFans auth token`);
    }
    const username = body.username ?? stored.page.username;
    if (!username) {
      throw new BadRequestError(`Page "${stored.page.label}" has no stored OnlyFans username`);
    }

    const context = {
      auth,
      proxy,
      egressKey: proxyEgressKey,
      requestObserver: null,
      rateLimitWaiter,
    };
    const account = await findOnlyFansAccountByUsername(app.onlyFansAdapter, context, username);
    assertVerifiedAccountIdentity(
      stored.page.label,
      stored.page.platformAccountId,
      account.platform_account_id,
    );
  }

  // Save encrypted credentials
  const credentials: StoredPlatformCredentialBundle | null = body.platform === "fansly"
    ? body.session
      ? { platform: "fansly", session: body.session }
      : null
    : body.auth
      ? { platform: "onlyfans", auth: body.auth }
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

  if (hasExplicitProxyInput) {
    if (proxy) {
      await saveProxy(app, stored.page.id, proxy, {
        rateLimitScopeKey: preservesStoredProxyRoute ? stored.proxy?.rateLimitScopeKey : undefined,
      });
    } else {
      await removeProxy(app, stored.page.id);
    }
  }

  await handleSuccessfulPageVerificationRecovery(app, {
    platformAccountId: stored.page.id,
    pageLabel: stored.page.label,
    platform: stored.page.platform,
  });

  return { updated: true, verified: true };
}
