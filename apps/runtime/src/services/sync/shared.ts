import { createHash, randomUUID } from "node:crypto";

import {
  type Database,
  getPageSyncExecutionContext,
  insertObservation,
  insertRawPayload,
  nextPageSyncObservationSeq,
  updatePageMetadata,
} from "@agency_hub_core/db";
import { FANSLY_MAPPER_VERSION } from "@agency_hub_core/fansly";
import { type HttpRequestObserver, millsFromInteger } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import {
  type ResolvedFanslyPageContext,
  type ResolvedPageContext,
} from "../page-context.ts";
import { buildFanslyMetadata } from "../fansly.ts";
import type { NormalizedSyncError } from "./errors.ts";
import { SyncPayloadPersistenceError } from "./errors.ts";
import type { SyncRunTelemetry } from "./observability.ts";
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";

// Legacy mapper tag for OnlyFans failed-payload rows (kept byte-identical to
// the retired packages/onlyfans export so recorded rows stay comparable).
const ONLYMONSTER_MAPPER_VERSION = "onlymonster-phase3-v1";

export const DAY_MS = 24 * 60 * 60 * 1000;
// Stage 1 retention stand-down: raw payloads are captured business facts. Rows
// are stamped far-future so the existing `retain_until < now` purge
// (packages/db repositories/sync.ts deleteExpiredRawPayloads) never matches;
// the cleanup job stays in place as a no-op.
const RAW_RETENTION_DAYS = 36500;
const DM_RAW_RETENTION_DAYS = 36500;

export function retentionDate(now = new Date()) {
  return new Date(now.getTime() + RAW_RETENTION_DAYS * DAY_MS);
}

export function dmRetentionDate(now = new Date()) {
  return new Date(now.getTime() + DM_RAW_RETENTION_DAYS * DAY_MS);
}

export function normalizeFanslyTimestamp(value: number) {
  const ms = value >= 1_000_000_000_000 ? value : value * 1000;
  return new Date(ms);
}

export function normalizeDmTipAmountCents(
  platform: ResolvedPageContext["platform"],
  totalTipAmount: number | null | undefined,
) {
  if (typeof totalTipAmount !== "number" || !Number.isFinite(totalTipAmount) || totalTipAmount <= 0) {
    return 0;
  }

  // Fansly live DM payloads emit tip totals in mills; the stored field and API contract are cents.
  const normalizedAmount = platform === "fansly"
    ? totalTipAmount / 10
    : totalTipAmount;

  return Math.max(0, Math.round(normalizedAmount));
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
    /** Producer platform for the observation (Stage 7); callers know theirs. */
    platform?: "fansly" | "onlyfans";
    /** Optional contextual observation envelope. The raw table still stores
     * `responsePayload` verbatim; this is reserved for a quarantined response
     * that a future parser needs request context to replay safely. */
    observationPayload?: unknown;
  },
) {
  let rawPayload;
  try {
    rawPayload = await insertRawPayload(db, input);
  } catch (error) {
    throw new SyncPayloadPersistenceError({
      endpoint: input.endpoint,
      action: options?.action ?? `inserting ${input.endpoint} raw payload`,
      cause: error,
    });
  }

  // Stage 7 producer 2: every fetched page is also an observation. As loud as
  // the raw insert — a failed capture fails the chunk (which retries); never a
  // silent drop. The idempotency key is unique per fetch by construction
  // (page:stream:run:requestSeq.fetchN — the fetch counter lives on the
  // executor context, so multi-page walks journal every page); outside the
  // page-executor context a UUID takes its place — retries then produce extra
  // observations with distinct keys, which the Stage 7 reconciliation expects.
  const context = getPageSyncExecutionContext();
  const stream = context?.stream ?? null;
  const platform = options?.platform ?? null;
  // Normalized so an adapter (or test stub) handing back undefined still
  // hashes and journals deterministically as JSON null.
  const observedPayload = options !== undefined
      && Object.hasOwn(options, "observationPayload")
    ? options.observationPayload ?? null
    : input.responsePayload ?? null;
  try {
    await insertObservation(db, {
      source: "pull",
      producer: `sync:${platform ?? "unknown"}:${stream ?? input.endpoint}`,
      platform,
      accountId: input.platformAccountId,
      kind: input.endpoint,
      payload: observedPayload,
      payloadHash: createHash("sha256").update(JSON.stringify(observedPayload)).digest(),
      idempotencyKey: [
        input.platformAccountId,
        stream ?? input.endpoint,
        input.syncRunId ?? "norun",
        nextPageSyncObservationSeq() ?? randomUUID(),
      ].join(":"),
    });
  } catch (error) {
    throw new SyncPayloadPersistenceError({
      endpoint: input.endpoint,
      action: `inserting ${input.endpoint} observation`,
      cause: error,
    });
  }

  return rawPayload;
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
        lastSeenAt: asNullableNumber(item.lastSeenAt),
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
        lastSeenAt: asNullableNumber(item.lastSeenAt),
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

function redactFanslyMessageLike(raw: unknown) {
  if (!isRecord(raw)) {
    return null;
  }

  const id = asNullableString(raw.id);
  const senderId = asNullableString(raw.senderId);
  const groupId = asNullableString(raw.groupId);
  const correlationId = asNullableString(raw.correlationId);
  const inReplyTo = asNullableString(raw.inReplyTo);
  const inReplyToRoot = asNullableString(raw.inReplyToRoot);
  const createdAt = asNullableNumber(raw.createdAt);
  const type = asNullableNumber(raw.type);
  const dataVersion = asNullableNumber(raw.dataVersion);
  const totalTipAmount = asNullableNumber(raw.totalTipAmount);

  return {
    id,
    type,
    dataVersion,
    groupId,
    senderId,
    correlationId,
    inReplyTo,
    inReplyToRoot,
    createdAt,
    attachments: [],
    embeds: [],
    interactions: [],
    likes: [],
    totalTipAmount,
  };
}

export function trimFanslyMessagingGroupsPayload(raw: unknown) {
  const payload = isRecord(raw) ? raw : {};
  const data = Array.isArray(payload.data)
    ? payload.data.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }

      const groupId = asNullableString(item.groupId);
      if (!groupId) {
        return [];
      }

      return [{
        account_id: asNullableString(item.account_id),
        groupId,
        partnerAccountId: asNullableString(item.partnerAccountId),
        partnerUsername: asNullableString(item.partnerUsername),
        flags: asNullableNumber(item.flags),
        unreadCount: asNullableNumber(item.unreadCount),
        subscriptionTierId: asNullableString(item.subscriptionTierId),
        lastMessageId: asNullableString(item.lastMessageId),
        lastUnreadMessageId: asNullableString(item.lastUnreadMessageId),
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
  const groups = Array.isArray(aggregationData.groups)
    ? aggregationData.groups.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }

      const id = asNullableString(item.id);
      if (!id) {
        return [];
      }

      return [{
        id,
        type: asNullableNumber(item.type),
        groupFlags: asNullableNumber(item.groupFlags),
        createdBy: asNullableString(item.createdBy),
        users: Array.isArray(item.users)
          ? item.users.flatMap((user) => {
            if (!isRecord(user)) {
              return [];
            }

            const userId = asNullableString(user.userId);
            const groupId = asNullableString(user.groupId);
            const type = asNullableNumber(user.type);
            const permissionFlags = asNullableNumber(user.permissionFlags);
            if (!userId || !groupId || type === null || permissionFlags === null) {
              return [];
            }

            return [{
              groupId,
              userId,
              type,
              permissionFlags,
            }];
          })
          : [],
        lastMessage: redactFanslyMessageLike(item.lastMessage),
      }];
    })
    : [];

  return {
    data,
    aggregationData: {
      total: asNullableNumber(aggregationData.total),
      accounts,
      groups,
    },
  };
}

/** Fansly-only since Stage 18: the OnlyMonster metadata refresh is retired
 * (OnlyFans page identity is static post-onboarding; counts ride the OFAPI
 * audience sweep). */
export async function refreshPageMetadata(
  app: AppContext,
  pageContext: ResolvedFanslyPageContext,
  syncType?: "light" | "followers",
  telemetry?: SyncRunTelemetry,
  requestObserver?: HttpRequestObserver | null,
) {
  const rateLimitWaiter = createSyncRateLimitWaiter(app, {
    egressKey: pageContext.egressKey,
  });

  {
    const accountMe = await app.adapter.getAccountMe({
      session: pageContext.session,
      proxy: pageContext.proxy,
      egressKey: pageContext.egressKey,
      requestObserver: requestObserver ?? telemetry?.getRequestObserver() ?? null,
      rateLimitWaiter,
    });
    await persistRawPayload(app.db, {
      platformAccountId: pageContext.page.id,
      endpoint: "account_me",
      requestParams: {},
      responsePayload: accountMe.raw,
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting account_me raw payload",
      platform: "fansly",
    });

    await updatePageMetadata(app.db, pageContext.page.id, {
      platformAccountIdValue: accountMe.parsed.account.id,
      username: accountMe.parsed.account.username,
      displayName: accountMe.parsed.account.displayName,
      followerCount: accountMe.parsed.account.followCount,
      subscriberCount: accountMe.parsed.account.subscriberCount,
      earningsBalanceMills: millsFromInteger(accountMe.parsed.account.earningsWallet?.balance ?? 0),
      metadata: buildFanslyMetadata(accountMe.parsed.account, pageContext.page.metadata),
      ...(syncType ? { syncType } : {}),
    });

    return accountMe;
  }
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
    // Stage 7 producer 2: failed fetches are pull facts too. Best-effort like
    // the raw insert above — this path already runs inside error handling.
    const failedPayload = { error: input.failure.error, summary: input.failure.summary };
    await insertObservation(app.db, {
      source: "pull",
      producer: `sync:${input.platform}:${getPageSyncExecutionContext()?.stream ?? input.endpoint}`,
      platform: input.platform,
      accountId: input.platformAccountId,
      kind: `${input.endpoint}:failed`,
      payload: failedPayload,
      payloadHash: createHash("sha256").update(JSON.stringify(failedPayload)).digest(),
      idempotencyKey: [
        input.platformAccountId,
        `${input.endpoint}:failed`,
        input.syncRunId,
        nextPageSyncObservationSeq() ?? randomUUID(),
      ].join(":"),
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
