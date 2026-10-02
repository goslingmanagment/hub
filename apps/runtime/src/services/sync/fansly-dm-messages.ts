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
import { FANSLY_MAPPER_VERSION, FanslyApiError, type FanslyMessage } from "@agency_hub_core/fansly";
import type { HttpRequestEvent, HttpRequestObserver } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { isFanslyPageOwnedBySyncEngineError } from "../fansly-send-guard/index.ts";
import type { ResolvedPageContext } from "../page-context.ts";
import type { DmMessagesChunkSummary, SyncRunTelemetry } from "./observability.ts";
import { materializeFanslyDmTipContextsBestEffort } from "./fansly-tip-contexts.ts";
import { dmRetentionDate, normalizeDmTipAmountCents, normalizeFanslyTimestamp, persistRawPayload } from "./shared.ts";

/** Vendor page size for every DM message fetch (executor and targeted run). */
export const FANSLY_DM_MESSAGE_PAGE_LIMIT = 25;

export type FanslyDmMessageRequestContext = Parameters<AppContext["adapter"]["getMessagesPage"]>[0];

// Per-thread breaker outage guard, shared by the executor's dm_messages walk
// and the targeted thread backfill: a failure while this many OTHER groups of
// the page failed since its last successful /message read (3+ distinct
// threads) is a page-wide outage, not a poison thread.
export const DM_MESSAGES_BREAKER_OUTAGE_OTHER_FAILING_GROUPS = 2;
// Scan window for that guard; also lets a guarded pin fall to the breaker
// once nothing else has failed for this long.
export const DM_MESSAGES_BREAKER_OUTAGE_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/** An application answer about this request that may be the thread's own: a
 * terminal HTTP 500 after in-process retries, or a 404/4xx. Everything else
 * is page-level and never opens a per-thread breaker: auth (401/403), a
 * timeout (408), rate limits (429), a provider Retry-After deadline, gateway
 * and edge answers (502/503/504 and every 5xx but 500 describe the path to
 * Fansly, not the thread), an envelope failure at HTTP 200 (as likely a
 * proxy's page as Fansly's verdict), every status-less failure (transport,
 * proxy, capture, contract drift), and the send guard's refusal of a page the
 * Fansly Sync Engine owns (sync engine design §2.7: a page-level stop, so the
 * engine's import of `page_dm_message_sync_health` never inherits it). */
export function isThreadAttributableFanslyFailure(error: unknown): error is FanslyApiError & { status: number } {
  if (isFanslyPageOwnedBySyncEngineError(error)) {
    return false;
  }
  if (!(error instanceof FanslyApiError) || typeof error.status !== "number" || error.retryAfterAt !== null) {
    return false;
  }
  const status = error.status;
  if (status >= 500) {
    return status === 500;
  }
  return status >= 400 && status !== 401 && status !== 403 && status !== 408 && status !== 429;
}
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
  // it cannot revisit the gap and may certify the thread complete again, also
  // over an unparseable tail of its own that no re-pick could store (the
  // executor waives that debt), so the dm_message_timestamp_unparseable
  // anomaly is the lasting signal.
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

/**
 * Every message on this page was sent at or after the page's DM onboarding
 * (getPageDmOnboardedAt): it is history of a conversation that began while
 * Hub was watching the page, which a first read may walk on through past its
 * start window. An older message is the pre-onboarding depth the deep
 * backfill owns (off), and a message without a parseable date cannot be
 * placed, so either one ends the walk as before.
 */
export function isDmMessagePageAfterOnboarding(
  page: { normalizedMessages: readonly { createdAt: Date }[]; normalizationDebt: boolean },
  onboardedAt: Date | null,
) {
  return onboardedAt !== null && !page.normalizationDebt && page.normalizedMessages.length > 0 &&
    page.normalizedMessages.every((message) => message.createdAt.getTime() >= onboardedAt.getTime());
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
   * unstored; the walk that read it cannot certify the thread complete, save
   * the executor's deep walk that reached the provider's end. */
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

export interface FanslyDmMessageNormalizeContext {
  conversationId: number;
  platformAccountId: number;
  platform: ResolvedPageContext["platform"];
  /** The page's own platform account id — sender-role classification. */
  pageAccountId: string;
  partnerPlatformUserId: string | null;
  /** What an implausibly future timestamp is judged against (default: now). */
  now?: Date;
}

export interface NormalizedFanslyDmMessages {
  /** One hot-table row per message with a parseable `createdAt`, in response order. */
  rows: FanslyDmMessageUpsertInput;
  /** Messages left unstored: no parseable `createdAt` (still journaled). */
  unparseable: Array<{ id: string; valueType: string }>;
  /** Stored messages whose timestamp normalized to an implausible instant
   *  (the legacy lane records each as a `dm_timestamp_implausible` anomaly). */
  implausible: Array<{ id: string; rawValue: number; normalizedAt: Date }>;
  /** Every message id as served (newest first by contract). */
  idsInResponseOrder: string[];
}

/**
 * The pure part of a `/message` page's normalization (design §5.4 step 2):
 * hot-table rows (timestamps via `normalizeFanslyTimestamp`, tips mills →
 * cents, the sender role against the page and the thread's partner), the
 * messages without a parseable `createdAt`, and the served id order. No
 * database read, no overlap lookup, no exhaustion verdict, no telemetry: the
 * legacy page normalization below and the Fansly Sync Engine's DM apply both
 * call it.
 */
export function normalizeFanslyDmMessages(
  items: readonly FanslyMessage[],
  context: FanslyDmMessageNormalizeContext,
): NormalizedFanslyDmMessages {
  const now = context.now ?? new Date();
  const rows: FanslyDmMessageUpsertInput = [];
  const unparseable: NormalizedFanslyDmMessages["unparseable"] = [];
  const implausible: NormalizedFanslyDmMessages["implausible"] = [];
  for (const message of items) {
    const raw = message.createdAt as unknown;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      // The row stays in the verbatim journal; the hot table cannot hold it
      // without a date. Overlap, cursor and exhaustion still count it.
      unparseable.push({ id: message.id, valueType: raw === null ? "null" : typeof raw });
      continue;
    }
    const createdAt = normalizeFanslyTimestamp(raw);
    if (isClearlyImplausibleDmTimestamp(createdAt, now)) {
      implausible.push({ id: message.id, rawValue: raw, normalizedAt: createdAt });
    }
    rows.push({
      conversationId: context.conversationId,
      platformAccountId: context.platformAccountId,
      platformMessageId: message.id,
      senderPlatformUserId: message.senderId ?? null,
      senderRole: resolveDmSenderRole(message.senderId ?? null, context.pageAccountId, context.partnerPlatformUserId),
      createdAt,
      content: message.content ?? "",
      totalTipAmountCents: normalizeDmTipAmountCents(context.platform, message.totalTipAmount),
      inReplyToMessageId: message.inReplyTo ?? null,
      inReplyToRootMessageId: message.inReplyToRoot ?? null,
    });
  }
  return { rows, unparseable, implausible, idsInResponseOrder: items.map((message) => message.id) };
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

  const normalized = normalizeFanslyDmMessages(page.items, {
    conversationId: input.conversation.id,
    platformAccountId: input.platformAccountId,
    platform: input.platform,
    pageAccountId: input.pageAccountId,
    partnerPlatformUserId: input.conversation.partnerPlatformUserId,
  });
  for (const item of normalized.implausible) {
    await recordDmTimestampAnomaly(input.telemetry, {
      context: "dm_messages:message",
      rawValue: item.rawValue,
      normalizedAt: item.normalizedAt,
    });
  }
  const normalizedMessages = normalized.rows;
  const unparseable = normalized.unparseable;
  const insertedMessageCount = normalizedMessages
    .filter((message) => !existingIds.has(message.platformMessageId))
    .length;
  if (unparseable.length > 0) {
    await input.telemetry.addAnomaly({
      code: "dm_message_timestamp_unparseable",
      severity: "error",
      message: "DM message without a parseable createdAt was left unstored",
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
