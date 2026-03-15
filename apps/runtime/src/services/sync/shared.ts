import {
  type Database,
  insertRawPayload,
  updatePageMetadata,
} from "@agency_hub_core/db";
import { FANSLY_MAPPER_VERSION } from "@agency_hub_core/fansly";
import { ONLYMONSTER_MAPPER_VERSION } from "@agency_hub_core/onlyfans";
import { toMills } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import {
  type ResolvedFanslyPageContext,
  type ResolvedOnlyFansPageContext,
  type ResolvedPageContext,
} from "../page-context.ts";
import { buildOnlyFansMetadata, getOnlyMonsterAccountId } from "../onlyfans.ts";
import type { NormalizedSyncError } from "./errors.ts";
import { SyncPayloadPersistenceError } from "./errors.ts";
import type { SyncRunTelemetry } from "./observability.ts";
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;

export function retentionDate(now = new Date()) {
  return new Date(now.getTime() + 180 * DAY_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asNullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type RawPayloadInsertInput = Parameters<typeof insertRawPayload>[1];

export async function persistRawPayload(
  db: Database,
  input: RawPayloadInsertInput,
  options?: {
    action?: string;
  },
) {
  try {
    await insertRawPayload(db, input);
  } catch (error) {
    throw new SyncPayloadPersistenceError({
      endpoint: input.endpoint,
      action: options?.action ?? `inserting ${input.endpoint} raw payload`,
      cause: error,
    });
  }
}

export function trimFanslyFollowerPayload(raw: unknown) {
  const payload = isRecord(raw) ? raw : {};
  const followers = Array.isArray(payload.followers)
    ? payload.followers.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }

      const id = asNullableString(item.id);
      const followerId = asNullableString(item.followerId);
      if (!id || !followerId) {
        return [];
      }

      return [{
        id,
        followerId,
      }];
    })
    : [];
  const aggregationData = isRecord(payload.aggregationData) ? payload.aggregationData : {};
  const accounts = Array.isArray(aggregationData.accounts)
    ? aggregationData.accounts.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }

      const id = asNullableString(item.id);
      if (!id) {
        return [];
      }

      return [{
        id,
        username: asNullableString(item.username),
        displayName: asNullableString(item.displayName),
        createdAt: asNullableNumber(item.createdAt),
      }];
    })
    : [];

  return {
    followers,
    aggregationData: {
      accounts,
    },
  };
}

export function refreshPageMetadata(
  app: AppContext,
  pageContext: ResolvedFanslyPageContext,
  syncType?: "light" | "followers",
  telemetry?: SyncRunTelemetry,
): ReturnType<AppContext["adapter"]["getAccountMe"]>;
export function refreshPageMetadata(
  app: AppContext,
  pageContext: ResolvedOnlyFansPageContext,
  syncType?: "light" | "followers",
  telemetry?: SyncRunTelemetry,
): ReturnType<AppContext["onlyFansAdapter"]["getAccount"]>;
export async function refreshPageMetadata(
  app: AppContext,
  pageContext: ResolvedPageContext,
  syncType?: "light" | "followers",
  telemetry?: SyncRunTelemetry,
) {
  const rateLimitWaiter = createSyncRateLimitWaiter(app);

  if (pageContext.platform === "fansly") {
    const accountMe = await app.adapter.getAccountMe({
      session: pageContext.session,
      proxy: pageContext.proxy,
      requestObserver: telemetry?.getRequestObserver() ?? null,
      rateLimitWaiter,
    });

    await updatePageMetadata(app.db, pageContext.page.id, {
      platformAccountIdValue: accountMe.parsed.account.id,
      username: accountMe.parsed.account.username,
      displayName: accountMe.parsed.account.displayName,
      followerCount: accountMe.parsed.account.followCount,
      subscriberCount: accountMe.parsed.account.subscriberCount,
      earningsBalanceMills: toMills(accountMe.parsed.account.earningsWallet?.balance ?? 0),
      metadata: {
        walls: accountMe.parsed.account.walls ?? [],
        subscriptionTiers: accountMe.parsed.account.subscriptionTiers ?? [],
      },
      ...(syncType ? { syncType } : {}),
    });

    return accountMe;
  }

  const account = await app.onlyFansAdapter.getAccount(
    {
      auth: pageContext.auth,
      proxy: pageContext.proxy,
      requestObserver: telemetry?.getRequestObserver() ?? null,
      rateLimitWaiter,
    },
    getOnlyMonsterAccountId(pageContext.page.metadata),
  );

  await updatePageMetadata(app.db, pageContext.page.id, {
    platformAccountIdValue: account.parsed.account.platform_account_id,
    username: account.parsed.account.username,
    displayName: account.parsed.account.name,
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: buildOnlyFansMetadata(account.parsed.account, pageContext.page.metadata),
      ...(syncType ? { syncType } : {}),
    });

  return account;
}

export async function persistFailedSyncPayload(
  app: Pick<AppContext, "db" | "logger">,
  input: {
    platformAccountId: number;
    syncRunId: number;
    endpoint: string;
    platform: "fansly" | "onlyfans";
    failure: NormalizedSyncError;
  },
) {
  try {
    await insertRawPayload(app.db, {
      platformAccountId: input.platformAccountId,
      syncRunId: input.syncRunId,
      endpoint: input.endpoint,
      requestParams: {},
      responsePayload: { error: input.failure.error },
      mapperVersion: input.platform === "fansly"
        ? FANSLY_MAPPER_VERSION
        : ONLYMONSTER_MAPPER_VERSION,
      payloadKind: "failed",
      errorMessage: input.failure.summary,
      retainUntil: retentionDate(),
    });
  } catch (error) {
    app.logger.warn(
      {
        syncRunId: input.syncRunId,
        platformAccountId: input.platformAccountId,
        endpoint: input.endpoint,
        err: error,
      },
      "Failed to persist failed sync payload; continuing",
    );
  }
}
