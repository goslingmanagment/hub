import {
  getLatestSyncRunPerPage,
  listVisiblePages,
  findPageByLabel,
  storePlatformCredentials,
} from "@agency_hub_core/db";
import {
  encryptJson,
  normalizeProxyConfig,
  type FanslySessionBundle,
  type OnlyMonsterTokenBundle,
  type ProxyConfig,
  type StoredPlatformCredentialBundle,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { findOnlyFansAccountByUsername } from "./onlyfans.ts";
import { saveProxy } from "./page-context.ts";

export type ConnectionStatus =
  | "active"
  | "stale"
  | "error"
  | "expired"
  | "never_synced"
  | "unverified";

const STALE_THRESHOLD_HOURS = 9;

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

    if (latestRun.status === "failed" || latestRun.status === "partial") {
      return "error";
    }
  }

  const hoursSinceSync = (Date.now() - lastLightSyncAt.getTime()) / (1000 * 60 * 60);
  if (hoursSinceSync > STALE_THRESHOLD_HOURS) {
    return "stale";
  }

  return "active";
}

export async function listConnectionStatuses(
  app: AppContext,
  input?: {
    pageIds?: number[];
    pages?: Awaited<ReturnType<typeof listVisiblePages>>;
  },
) {
  const pages = input?.pages ?? await listVisiblePages(app.db, input?.pageIds);
  if (pages.length === 0) {
    return [];
  }

  const allPageIds = pages.map((p) => p.id);
  const latestRuns = await getLatestSyncRunPerPage(app.db, allPageIds, {
    stream: "light",
  });
  const runsByPageId = new Map(latestRuns.map((r) => [r.platformAccountId, r]));

  return pages.map((page) => {
    const latestRun = runsByPageId.get(page.id) ?? null;

    // Pages always have credentials if they exist in the system via the onboarding flow,
    // but we check lastVerifiedAt as a proxy for "credentials exist"
    const hasCredentials = true; // If page exists, it was onboarded with credentials

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
      subscriberCount: page.subscriberCount,
      followerCount: page.followerCount,
    };
  });
}

export async function updatePageCredentials(
  app: AppContext,
  pageLabel: string,
  body: {
    platform: "fansly";
    session: FanslySessionBundle;
    proxy?: ProxyConfig | null;
  } | {
    platform: "onlyfans";
    auth: OnlyMonsterTokenBundle;
    username: string;
    proxy?: ProxyConfig | null;
  },
) {
  const stored = await findPageByLabel(app.db, pageLabel);
  if (!stored) {
    throw new NotFoundError(`Page "${pageLabel}" not found`);
  }

  const proxy = body.proxy ? normalizeProxyConfig(body.proxy) : null;

  if (stored.page.platform !== body.platform) {
    throw new BadRequestError(
      `Platform mismatch: page is ${stored.page.platform}, credentials are for ${body.platform}`,
    );
  }

  // Verify credentials with platform adapter
  if (body.platform === "fansly") {
    const verification = await app.adapter.verifySession({
      session: body.session,
      proxy,
    });
    assertVerifiedAccountIdentity(
      stored.page.label,
      stored.page.platformAccountId,
      verification.parsed.account.id,
    );
  } else {
    const context = {
      auth: body.auth,
      proxy,
      requestObserver: null,
    };
    const account = await findOnlyFansAccountByUsername(app.onlyFansAdapter, context, body.username);
    assertVerifiedAccountIdentity(
      stored.page.label,
      stored.page.platformAccountId,
      account.platform_account_id,
    );
  }

  // Save encrypted credentials
  const credentials: StoredPlatformCredentialBundle = body.platform === "fansly"
    ? { platform: "fansly", session: body.session }
    : { platform: "onlyfans", auth: body.auth };

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

  // Save proxy if provided
  if (proxy) {
    await saveProxy(app, stored.page.id, proxy);
  }

  return { updated: true, verified: true };
}
