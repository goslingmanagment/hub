// The Fansly DM message-page unit, extracted from the sync executor's
// dm_messages chunk so the targeted thread backfill (slice C′) runs the SAME
// code: same adapter call through the page's egress context, same raw capture
// + observation journal, same normalization and overlap accounting.
//
// Nothing here decides WHICH conversation to walk or WHEN to stop — those are
// the callers' policies (the executor's candidate loop, the targeted run's
// bounded walk). This module is the shared inner step plus the DM helpers both
// callers need.

import {
  getExistingPageDmMessageIds,
  getPageDmMessageIdsAtOrBefore,
  type MessageCoverageStatus,
  type PageDmConversationRow,
  type upsertPageDmMessages,
} from "@agency_hub_core/db";
import { FANSLY_MAPPER_VERSION } from "@agency_hub_core/fansly";
import type { HttpRequestEvent, HttpRequestObserver } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { ResolvedPageContext } from "../page-context.ts";
import type { DmMessagesChunkSummary, SyncRunTelemetry } from "./observability.ts";
import { materializeFanslyDmTipContextsBestEffort } from "./fansly-tip-contexts.ts";
import { dmRetentionDate, normalizeDmTipAmountCents, normalizeFanslyTimestamp, persistRawPayload } from "./shared.ts";

/** Vendor page size for every DM message fetch (executor and targeted run). */
export const FANSLY_DM_MESSAGE_PAGE_LIMIT = 25;

export type FanslyDmMessageRequestContext = Parameters<AppContext["adapter"]["getMessagesPage"]>[0];
export type FanslyDmMessagePage = Awaited<ReturnType<AppContext["adapter"]["getMessagesPage"]>>;
export type FanslyDmMessageUpsertInput = Parameters<typeof upsertPageDmMessages>[1];

export function assertDmSharedRateLimitEnabled(app: AppContext) {
  if (!app.config.syncSharedRateLimitEnabled) {
    throw new Error("DM sync requires SYNC_SHARED_RATE_LIMIT_ENABLED=true");
  }
}

/** The list head differs from the newest stored message and arrived after the
 * last head read: a head read is due. Mirrors the time-based stale-head
 * predicate in page-dm.ts selectNextPageDmMessageSyncCandidate; keep the two
 * in step. */
export function isDmHeadStaleByTime(conversation: {
  lastMessageId: string | null;
  newestStoredMessageId: string | null;
  lastMessageAt: Date | null;
  lastMessageSyncAt: Date | null;
}) {
  return conversation.lastMessageId !== conversation.newestStoredMessageId && (
    conversation.lastMessageSyncAt === null ||
    (conversation.lastMessageAt !== null && conversation.lastMessageSyncAt < conversation.lastMessageAt)
  );
}

export function resolveDmConversationCoverageStatus(input: {
  currentMode: "backfill" | "deep_backfill" | "incremental";
  existingStatus: MessageCoverageStatus;
  overlapFound: boolean;
  providerHistoryExhausted: boolean;
  hitWindowCap: boolean;
  /** The walk left at least one message unstored (no parseable createdAt). */
  normalizationDebt?: boolean;
}): MessageCoverageStatus {
  const status = resolveDmWalkCoverageStatus(input);
  // A walk that skipped a message never proves the thread complete, in any
  // mode: an incremental walk would otherwise keep a prior 'complete' over the
  // gap. partial_window, never pending_backfill: the ordinary picker treats it
  // like complete, so the downgrade re-reads nothing. Only the deep backfill
  // (off by default) walks partial_window threads, from the oldest stored id;
  // it cannot revisit the gap and may certify the thread complete again, so
  // the dm_message_timestamp_unparseable anomaly is the lasting signal.
  return input.normalizationDebt === true && status === "complete" ? "partial_window" : status;
}

function resolveDmWalkCoverageStatus(
  input: Parameters<typeof resolveDmConversationCoverageStatus>[0],
): MessageCoverageStatus {
  if (input.currentMode === "incremental") {
    // An incremental walk starts at the head and its pages are contiguous, so
    // reaching the provider's end means the whole history is stored.
    if (input.providerHistoryExhausted && input.existingStatus === "pending_backfill") {
      return "complete";
    }
    return input.existingStatus;
  }

  if (input.providerHistoryExhausted || input.overlapFound) {
    return "complete";
  }

  if (input.currentMode === "deep_backfill") {
    return "partial_window";
  }

  if (input.hitWindowCap) {
    return "partial_window";
  }

  return input.existingStatus;
}

function isClearlyImplausibleDmTimestamp(timestamp: Date, now = new Date()) {
  return timestamp.getTime() < Date.UTC(2010, 0, 1) ||
    timestamp.getTime() > now.getTime() + (24 * 60 * 60 * 1000);
}

async function recordDmTimestampAnomaly(
  telemetry: SyncRunTelemetry,
  input: {
    context: string;
    rawValue: number | string;
    normalizedAt: Date;
  },
) {
  await telemetry.addAnomaly({
    code: "dm_timestamp_implausible",
    severity: "warn",
    message: "DM timestamp normalized to an implausible value",
    details: {
      context: input.context,
      rawValue: input.rawValue,
      normalizedAt: input.normalizedAt.toISOString(),
    },
  });
}

export async function normalizeDmTimestampWithAnomaly(
  telemetry: SyncRunTelemetry,
  input: {
    context: string;
    value: number | null | undefined;
  },
) {
  if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
    return null;
  }

  const normalized = normalizeFanslyTimestamp(input.value);
  if (isClearlyImplausibleDmTimestamp(normalized)) {
    await recordDmTimestampAnomaly(telemetry, {
      context: input.context,
      rawValue: input.value,
      normalizedAt: normalized,
    });
  }

  return normalized;
}

export function resolveDmSenderRole(
  senderId: string | null | undefined,
  pageAccountId: string,
  partnerPlatformUserId: string | null | undefined,
) {
  if (!senderId) {
    return "unknown" as const;
  }
  if (senderId === pageAccountId) {
    return "model" as const;
  }
  if (partnerPlatformUserId && senderId === partnerPlatformUserId) {
    return "fan" as const;
  }
  return "unknown" as const;
}

export class DmMessagesChunkRequestObserver implements HttpRequestObserver {
  private readonly touchedConversationIds = new Set<number>();
  private readonly requestGapsMs: number[] = [];
  private requestCount = 0;
  private rateLimit429s = 0;
  private lastStartedAtMs: number | null = null;

  recordConversationTouched(conversationId: number) {
    this.touchedConversationIds.add(conversationId);
  }

  async onRequestEvent(event: HttpRequestEvent) {
    if (event.operation !== "messages") {
      return;
    }

    if (event.state === "started") {
      this.requestCount += 1;

      const startedAtMs = event.timestamp instanceof Date ? event.timestamp.getTime() : Number.NaN;
      if (Number.isFinite(startedAtMs)) {
        if (this.lastStartedAtMs !== null) {
          this.requestGapsMs.push(startedAtMs - this.lastStartedAtMs);
        }
        this.lastStartedAtMs = startedAtMs;
      }
      return;
    }

    if ("httpStatus" in event && event.httpStatus === 429) {
      this.rateLimit429s += 1;
    }
  }

  buildSummary(chunkDurationMs: number): DmMessagesChunkSummary {
    const totalGapMs = this.requestGapsMs.reduce((sum, value) => sum + value, 0);
    return {
      conversationsProcessed: this.touchedConversationIds.size,
      messageFetchRequests: this.requestCount,
      rateLimit429s: this.rateLimit429s,
      chunkDurationMs,
      averageGapMs: this.requestGapsMs.length > 0
        ? Math.round(totalGapMs / this.requestGapsMs.length)
        : 0,
    };
  }
}

export interface FanslyDmMessagePageOutcome {
  rawPayloadId: number;
  page: FanslyDmMessagePage;
  normalizedMessages: FanslyDmMessageUpsertInput;
  /** Rows this page adds that page_dm_messages does not already hold. */
  insertedMessageCount: number;
  /** At least one returned message is already stored — the walk met known
   * ground. With overlapBoundaryMessageId, only a stored row at or before that
   * boundary counts. */
  overlapFound: boolean;
  /** Oldest id on this page; the `before` cursor for the next request. */
  oldestMessageId: string | null;
  providerHistoryExhausted: boolean;
  /** At least one returned message had no parseable createdAt and was left
   * unstored; the walk that read it cannot certify the thread complete. */
  normalizationDebt: boolean;
}

/**
 * One DM message page: fetch through the resolved page context, journal it
 * verbatim (raw payload + observation, DP 7), then normalize. Writes NOTHING
 * to page_dm_messages — the caller owns the upsert transaction and its lease
 * fencing.
 *
 * Callers keep their own error policy around this call: the executor's
 * terminal-5xx/partner-unresolvable recovery wraps it exactly as it wrapped
 * the bare adapter call before the extraction.
 */
export async function fetchAndJournalFanslyDmMessagePage(
  app: AppContext,
  input: {
    requestContext: FanslyDmMessageRequestContext;
    telemetry: SyncRunTelemetry;
    syncRunId: number;
    platformAccountId: number;
    platform: ResolvedPageContext["platform"];
    /** The page's own platform account id — sender-role classification. */
    pageAccountId: string;
    conversation: Pick<
      PageDmConversationRow,
      "id" | "platformConversationId" | "partnerPlatformUserId"
    >;
    before: string | null;
    limit?: number;
    /** An incremental head walk passes the thread's recorded newest stored
     * message: rows stored above it (a dropped walk's pages) are not known
     * ground, so the walk reads on through any gap below them. Omitted, any
     * stored row overlaps. */
    overlapBoundaryMessageId?: string | null;
  },
): Promise<FanslyDmMessagePageOutcome> {
  const limit = input.limit ?? FANSLY_DM_MESSAGE_PAGE_LIMIT;
  const page = await app.adapter.getMessagesPage(input.requestContext, {
    groupId: input.conversation.platformConversationId,
    limit,
    before: input.before,
  });

  // Stage 1: DM message pages are captured raw (previously zero raw
  // persistence on this path); far-future retention via dmRetentionDate.
  const requestParams = {
    groupId: input.conversation.platformConversationId,
    limit,
    before: input.before ?? null,
  };
  const rawPayload = await persistRawPayload(app.db, {
    platformAccountId: input.platformAccountId,
    syncRunId: input.syncRunId,
    endpoint: "dm_messages",
    requestParams,
    responsePayload: page.contractAccepted === false
      ? { contractAccepted: false, raw: page.raw }
      : page.raw,
    mapperVersion: FANSLY_MAPPER_VERSION,
    payloadKind: "dm_messages",
    retainUntil: dmRetentionDate(),
  }, {
    action: "inserting dm_messages raw payload",
    platform: "fansly",
  });
  // Refuse a drifted body only after it is journaled. Its empty item list
  // must never reach normalization, where no oldest id reads as provider
  // history exhausted and the thread would be finalized complete.
  if (page.contractAccepted === false) {
    throw new Error("Fansly messages response contract rejected; captured before refusal");
  }
  await materializeFanslyDmTipContextsBestEffort(app, {
    accountId: input.platformAccountId,
    requestParams,
    responsePayload: page.raw,
    sourceRawPayloadId: rawPayload.id,
    capturedAt: rawPayload.capturedAt,
  });

  return { ...await normalizeFanslyDmMessagePage(app, input, page), rawPayloadId: rawPayload.id };
}

/** Shared REST normalization for a newly captured page or an already durable
 * B1 page. Replaying it performs no HTTP and never writes the hot tables. */
export async function normalizeFanslyDmMessagePage(
  app: AppContext,
  input: Pick<Parameters<typeof fetchAndJournalFanslyDmMessagePage>[1],
    "telemetry" | "platformAccountId" | "platform" | "pageAccountId" | "conversation"
    | "overlapBoundaryMessageId">,
  page: FanslyDmMessagePage,
): Promise<Omit<FanslyDmMessagePageOutcome, "rawPayloadId">> {
  const existingIds = await getExistingPageDmMessageIds(app.db, {
    conversationId: input.conversation.id,
    platformMessageIds: page.items.map((message) => message.id),
  });
  const knownGroundIds = input.overlapBoundaryMessageId && existingIds.size > 0
    ? await getPageDmMessageIdsAtOrBefore(app.db, {
      conversationId: input.conversation.id,
      platformMessageIds: [...existingIds],
      boundaryMessageId: input.overlapBoundaryMessageId,
    })
    : existingIds;
  const overlapFound = page.items.some((message) => knownGroundIds.has(message.id));

  const normalizedMessages: FanslyDmMessageUpsertInput = [];
  const unparseable: Array<{ id: string; valueType: string }> = [];
  for (const message of page.items) {
    const createdAt = await normalizeDmTimestampWithAnomaly(input.telemetry, {
      context: "dm_messages:message",
      value: message.createdAt,
    });
    if (!createdAt) {
      // The row stays in the verbatim journal; the hot table cannot hold it
      // without a date. Overlap, cursor and exhaustion still count it below.
      unparseable.push({
        id: message.id,
        valueType: message.createdAt === null ? "null" : typeof message.createdAt,
      });
      continue;
    }

    normalizedMessages.push({
      conversationId: input.conversation.id,
      platformAccountId: input.platformAccountId,
      platformMessageId: message.id,
      senderPlatformUserId: message.senderId ?? null,
      senderRole: resolveDmSenderRole(
        message.senderId ?? null,
        input.pageAccountId,
        input.conversation.partnerPlatformUserId,
      ),
      createdAt,
      content: message.content ?? "",
      totalTipAmountCents: normalizeDmTipAmountCents(
        input.platform,
        message.totalTipAmount,
      ),
      inReplyToMessageId: message.inReplyTo ?? null,
      inReplyToRootMessageId: message.inReplyToRoot ?? null,
    });
  }
  const insertedMessageCount = normalizedMessages
    .filter((message) => !existingIds.has(message.platformMessageId))
    .length;
  if (unparseable.length > 0) {
    await input.telemetry.addAnomaly({
      code: "dm_message_timestamp_unparseable",
      severity: "error",
      message: "DM message without a parseable createdAt was left unstored; the thread is not certified complete",
      details: {
        conversationId: input.conversation.id,
        groupId: input.conversation.platformConversationId,
        count: unparseable.length,
        messageIds: unparseable.slice(0, 25).map((item) => item.id),
        valueTypes: [...new Set(unparseable.map((item) => item.valueType))],
      },
    });
  }

  const oldestMessageId = page.items.at(-1)?.id ?? null;

  return {
    page,
    normalizedMessages,
    insertedMessageCount,
    overlapFound,
    oldestMessageId,
    providerHistoryExhausted: page.done || !oldestMessageId,
    normalizationDebt: unparseable.length > 0,
  };
}
