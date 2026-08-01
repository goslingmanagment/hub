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
  type MessageCoverageStatus,
  type PageDmConversationRow,
  type upsertPageDmMessages,
} from "@agency_hub_core/db";
import { FANSLY_MAPPER_VERSION } from "@agency_hub_core/fansly";
import type { HttpRequestEvent, HttpRequestObserver } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { ResolvedPageContext } from "../page-context.ts";
import type { DmMessagesChunkSummary, SyncRunTelemetry } from "./observability.ts";
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

export function resolveDmConversationCoverageStatus(input: {
  currentMode: "backfill" | "deep_backfill" | "incremental";
  existingStatus: MessageCoverageStatus;
  overlapFound: boolean;
  providerHistoryExhausted: boolean;
  hitWindowCap: boolean;
}): MessageCoverageStatus {
  if (input.currentMode === "incremental") {
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
  page: FanslyDmMessagePage;
  normalizedMessages: FanslyDmMessageUpsertInput;
  /** Rows this page adds that page_dm_messages does not already hold. */
  insertedMessageCount: number;
  /** At least one returned message is already stored — the walk met known ground. */
  overlapFound: boolean;
  /** Oldest id on this page; the `before` cursor for the next request. */
  oldestMessageId: string | null;
  providerHistoryExhausted: boolean;
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
  await persistRawPayload(app.db, {
    platformAccountId: input.platformAccountId,
    syncRunId: input.syncRunId,
    endpoint: "dm_messages",
    requestParams: {
      groupId: input.conversation.platformConversationId,
      limit,
      before: input.before ?? null,
    },
    responsePayload: page.raw,
    mapperVersion: FANSLY_MAPPER_VERSION,
    payloadKind: "dm_messages",
    retainUntil: dmRetentionDate(),
  }, {
    action: "inserting dm_messages raw payload",
    platform: "fansly",
  });

  const existingIds = await getExistingPageDmMessageIds(app.db, {
    conversationId: input.conversation.id,
    platformMessageIds: page.items.map((message) => message.id),
  });
  const overlapFound = page.items.some((message) => existingIds.has(message.id));

  const normalizedMessages: FanslyDmMessageUpsertInput = [];
  for (const message of page.items) {
    const createdAt = await normalizeDmTimestampWithAnomaly(input.telemetry, {
      context: "dm_messages:message",
      value: message.createdAt,
    });
    if (!createdAt) {
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

  const oldestMessageId = page.items.at(-1)?.id ?? null;

  return {
    page,
    normalizedMessages,
    insertedMessageCount,
    overlapFound,
    oldestMessageId,
    providerHistoryExhausted: page.done || !oldestMessageId,
  };
}
