// OFAPI-backed OnlyFans DM sync (Phase 2 of docs/ofapi-integration-plan.md,
// D3/D4): the dm_conversations / dm_messages executor streams for OnlyFans
// pages mapped to an OFAPI account, behind OFAPI_DM_SYNC_ENABLED. REST is used
// only for bootstrap + reconcile — live messages arrive through the webhook
// projection (Phase 1). Every request is credit-budgeted: a per-chunk request
// cap, a UTC-day credit ceiling, and a hard floor on the last-observed balance;
// budget exhaustion yields gracefully and page_sync_cursors checkpoints resume
// the walk on the next run, Fansly-style.

import {
  assertOwnedPageSyncLease,
  finalizePageDmConversationMessageSync,
  getCheckpoint,
  getExistingPageDmMessageIds,
  getOfapiCreditState,
  getPageDmConversationById,
  getPageDmMessageRetentionLimit,
  listPageDmConversationsByPlatformConversationIds,
  requestPageSync,
  reserveOfapiDayCredits,
  selectNextPageDmMessageSyncCandidate,
  settleOfapiDayCreditReservation,
  upsertCheckpoint,
  upsertCheckpointProgress,
  upsertFanPages,
  upsertFans,
  upsertPageDmConversation,
  upsertPageDmMessages,
  withOwnedPageSyncTransaction,
  type Database,
  type DmSenderRole,
  type MessageCoverageStatus,
  type OfapiDayBudgetScope,
  type PageSyncLease,
} from "@agency_hub_core/db";
import { normalizeDmMessageText } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { isPageDmPruneEnabled } from "../page-dm-retention.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { isOfapiCreditLedgerEnabled } from "../ofapi-credits.ts";
import { asRecord, idToString } from "../ofapi-payloads.ts";
import type { OfapiClient, OfapiListPage, OfapiRequestContext } from "../ofapi.ts";
import type { ResolvedPageContext } from "../page-context.ts";
import { composeRequestObservers, type SyncChunkBudget } from "./chunk-budget.ts";
import {
  emptyDmMessagesCursorState,
  emptyOfapiDmConversationCursorState,
  parseDmMessagesCursorState,
  parseOfapiDmConversationCursorState,
  type DmMessagesCursorState,
} from "./cursor-state.ts";
import { pageSyncDependencyInput } from "./dependencies.ts";
import { summarizeCheckpoint, type SyncRunTelemetry } from "./observability.ts";
import { dmRetentionDate, persistRawPayload } from "./shared.ts";

const OFAPI_CHATS_PAGE_LIMIT = 100;
const OFAPI_MESSAGES_PAGE_LIMIT = 100;
// Versions the parseOfapiRestMessage mapping for raw-payload provenance.
const OFAPI_DM_MAPPER_VERSION = "ofapi-dm-rest-v1";
const DM_PREVIEW_MAX_LENGTH = 280;

const DEFAULT_MAX_REQUESTS_PER_RUN = 25;
const DEFAULT_DAILY_CREDIT_BUDGET = 500;
const DEFAULT_CREDIT_FLOOR = 500;
const DEFAULT_RECONCILE_INTERVAL_MINUTES = 360;
// Daily-budget / balance-floor blocks park the stream for a while instead of
// hot-looping yields; budgets refill at UTC midnight (or after a top-up).
const BUDGET_BLOCK_RETRY_DELAY_MS = 60 * 60 * 1000;

type ExecutorRequestContext = {
  budget: SyncChunkBudget;
  pageContext: ResolvedPageContext;
  telemetry: SyncRunTelemetry;
};

// Mirrors StreamChunkResult in executor-handlers.ts (type-only import would be
// fine, but redeclaring avoids any executor-handlers <-> ofapi-dm-sync cycle).
export type OfapiStreamChunkResult = {
  satisfied: boolean;
  yieldReason: "request_budget" | "wall_clock" | null;
  continuationRetryAt?: Date | null;
  continuationRequestSource?: "scheduled" | null;
  stats?: Record<string, unknown>;
};

export function isOfapiDmSyncEnabled(
  config?: Pick<AppContext["config"], "ofapiDmSyncEnabled">,
) {
  return config?.ofapiDmSyncEnabled === true;
}

/** D8: page eligibility = OnlyFans platform + OFAPI account mapping + flag on. */
export function isOfapiDmSyncEligiblePage(
  config: Pick<AppContext["config"], "ofapiDmSyncEnabled"> | undefined,
  page: { platform: string; ofapiAccountId: string | null },
) {
  return isOfapiDmSyncEnabled(config) &&
    page.platform === "onlyfans" &&
    typeof page.ofapiAccountId === "string" &&
    page.ofapiAccountId.length > 0;
}

function resolveOfapiSyncClient(app: AppContext): OfapiClient {
  if (!app.ofapi) {
    throw new Error("OFAPI DM sync requires OFAPI_API_KEY to be configured");
  }
  return app.ofapi;
}

function requireOfapiAccountId(pageContext: ResolvedPageContext) {
  const ofapiAccountId = pageContext.page.ofapiAccountId;
  if (pageContext.platform !== "onlyfans" || !ofapiAccountId) {
    throw new Error("OFAPI DM sync requires an OnlyFans page mapped to an OFAPI account");
  }
  return ofapiAccountId;
}

export type OfapiBudgetBlock = "ofapi_request_budget" | "ofapi_daily_credit_budget" | "ofapi_credit_floor";

// The per-request reservation estimate: the standard uncached account-scoped
// read costs 1 credit; recordResponse settles to the _meta-reported actuals.
const OFAPI_REQUEST_CREDIT_ESTIMATE = 1;

/**
 * Audit F7: a sub-floor balance only parks while the observation is fresh.
 * Parked streams make no requests, so nothing would ever refresh a stale
 * balance and a floor crossing would outlive an account top-up — with the
 * optional balance ping off, permanently. Once the observation is older than
 * the park delay, one probe request per park cycle is let through; its _meta
 * (via the ledger sink or the settle path) refreshes the balance and the
 * stream resumes or re-parks on real data.
 */
export const OFAPI_FLOOR_BALANCE_FRESHNESS_MS = BUDGET_BLOCK_RETRY_DELAY_MS;

export function isOfapiCreditFloorBlocking(input: {
  creditFloor: number;
  lastBalance: number | null;
  lastBalanceAt: Date | null;
  now?: Date;
}) {
  if (
    input.creditFloor <= 0 ||
    input.lastBalance === null ||
    input.lastBalance >= input.creditFloor
  ) {
    return false;
  }
  const nowMs = (input.now ?? new Date()).getTime();
  return input.lastBalanceAt !== null &&
    nowMs - input.lastBalanceAt.getTime() < OFAPI_FLOOR_BALANCE_FRESHNESS_MS;
}

/**
 * D4/D6 budget guard, checked before every REST request. The per-chunk request
 * cap yields like a normal budget exhaustion; daily-budget and floor blocks add
 * a retry delay so the stream parks instead of spinning. Streams with their own
 * ceiling (audience, D6) pass `budgetScope: "audience"` so their budget counts
 * only their own spend (its dedicated day counter with the ledger on, the
 * global day counter fallback otherwise, per decision #50).
 *
 * Audit F9: the day-budget check is reserve-before-request — the comparison
 * and the counter increment are one conditional update, so concurrent streams
 * near the cap can never pass the check together and overspend. recordResponse
 * settles each reservation to the server-reported actuals; a request that
 * throws in between leaks at most the 1-credit estimate until the UTC-day
 * rollover (conservative direction).
 */
export function createOfapiRestGuard(app: AppContext, options?: {
  maxRequestsPerRun?: number;
  dailyCreditBudget?: number;
  budgetScope?: OfapiDayBudgetScope;
}) {
  const maxRequestsPerRun = Math.max(
    1,
    options?.maxRequestsPerRun ??
      app.config.ofapiDmBootstrapMaxRequestsPerRun ?? DEFAULT_MAX_REQUESTS_PER_RUN,
  );
  const dailyCreditBudget = Math.max(
    1,
    options?.dailyCreditBudget ??
      app.config.ofapiDmDailyCreditBudget ?? DEFAULT_DAILY_CREDIT_BUDGET,
  );
  const creditFloor = Math.max(0, app.config.ofapiCreditFloor ?? DEFAULT_CREDIT_FLOOR);
  // The audience's dedicated counter mirrors its ledger-attributed spend, so
  // it applies only with the ledger on; off, the audience falls back to the
  // shared global day counter exactly as before (decision #50).
  const scope: OfapiDayBudgetScope =
    options?.budgetScope === "audience" && isOfapiCreditLedgerEnabled(app.config)
      ? "audience"
      : "global";
  let requestsUsed = 0;

  return {
    get requestsUsed() {
      return requestsUsed;
    },
    async resolveBlock(): Promise<OfapiBudgetBlock | null> {
      if (requestsUsed >= maxRequestsPerRun) {
        return "ofapi_request_budget";
      }

      const credit = await getOfapiCreditState(app.db);
      if (isOfapiCreditFloorBlocking({
        creditFloor,
        lastBalance: credit.lastBalance,
        lastBalanceAt: credit.lastBalanceAt,
      })) {
        return "ofapi_credit_floor";
      }

      const reserved = await reserveOfapiDayCredits(app.db, {
        scope,
        estimate: OFAPI_REQUEST_CREDIT_ESTIMATE,
        budget: dailyCreditBudget,
      });
      return reserved ? null : "ofapi_daily_credit_budget";
    },
    async recordResponse(page: OfapiListPage) {
      requestsUsed += 1;
      const actualCredits = page.meta?.creditsUsed ?? OFAPI_REQUEST_CREDIT_ESTIMATE;
      // With the ledger on, the client's onCreditSpend sink already recorded
      // the actuals (ledger row + global day counter + balance, one
      // transaction) before the response reached us — only the reservation
      // remains to release. The audience counter settles to actuals because
      // the sink maintains only the global one. Flag off keeps the pre-ledger
      // accounting (uncached reads cost 1 credit; trust _meta when present),
      // applied as a settle against the reservation.
      if (isOfapiCreditLedgerEnabled(app.config)) {
        await settleOfapiDayCreditReservation(app.db, {
          scope,
          creditsDelta: scope === "audience"
            ? actualCredits - OFAPI_REQUEST_CREDIT_ESTIMATE
            : -OFAPI_REQUEST_CREDIT_ESTIMATE,
        });
        return;
      }
      await settleOfapiDayCreditReservation(app.db, {
        scope,
        creditsDelta: actualCredits - OFAPI_REQUEST_CREDIT_ESTIMATE,
        balance: page.meta?.creditBalance ?? null,
      });
    },
  };
}

export function budgetBlockResult(
  block: OfapiBudgetBlock,
  stats: Record<string, unknown>,
): OfapiStreamChunkResult {
  if (block === "ofapi_request_budget") {
    return {
      satisfied: false,
      yieldReason: "request_budget",
      stats: { ...stats, ofapiBudgetBlock: block },
    };
  }

  return {
    satisfied: false,
    yieldReason: "request_budget",
    continuationRetryAt: new Date(Date.now() + BUDGET_BLOCK_RETRY_DELAY_MS),
    continuationRequestSource: "scheduled",
    stats: { ...stats, ofapiBudgetBlock: block },
  };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function truncatePreview(content: string) {
  if (!content) {
    return null;
  }

  return content.length <= DM_PREVIEW_MAX_LENGTH
    ? content
    : `${content.slice(0, DM_PREVIEW_MAX_LENGTH - 1).trimEnd()}…`;
}

function parseOfapiTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Message ids are numeric strings; numeric compare with a lexicographic fallback.
function compareMessageIds(a: string, b: string) {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function headAdvances(
  head: { messageId: string; createdAt: Date },
  existing: { lastMessageAt: Date | null; lastMessageId: string | null },
) {
  if (!existing.lastMessageAt) {
    return true;
  }
  if (head.createdAt.getTime() !== existing.lastMessageAt.getTime()) {
    return head.createdAt.getTime() > existing.lastMessageAt.getTime();
  }
  return existing.lastMessageId === null ||
    compareMessageIds(head.messageId, existing.lastMessageId) > 0;
}

function laterOf(a: Date | null, b: Date | null) {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return a.getTime() >= b.getTime() ? a : b;
}

interface OfapiChatSummary {
  fanId: string;
  username: string | null;
  displayName: string | null;
  unreadCount: number;
  lastMessage: {
    messageId: string;
    createdAt: Date;
    senderId: string | null;
    senderRole: DmSenderRole;
    preview: string | null;
  } | null;
}

/** Maps one chats-list item; returns null when the fan id is missing. */
export function parseOfapiChatSummary(item: Record<string, unknown>): OfapiChatSummary | null {
  const fan = asRecord(item.fan);
  const fanId = idToString(fan?.id);
  if (!fan || !fanId) {
    return null;
  }

  const unread = item.unreadMessagesCount;
  const lastMessageRecord = asRecord(item.lastMessage);
  const lastMessageId = idToString(lastMessageRecord?.id);
  const lastMessageAt = parseOfapiTimestamp(lastMessageRecord?.createdAt);

  let lastMessage: OfapiChatSummary["lastMessage"] = null;
  if (lastMessageRecord && lastMessageId && lastMessageAt) {
    const senderId = idToString(asRecord(lastMessageRecord.fromUser)?.id);
    const sentByMe = lastMessageRecord.isSentByMe;
    const senderRole: DmSenderRole = typeof sentByMe === "boolean"
      ? (sentByMe ? "model" : "fan")
      : senderId === null
        ? "unknown"
        : senderId === fanId
          ? "fan"
          : "model";
    lastMessage = {
      messageId: lastMessageId,
      createdAt: lastMessageAt,
      senderId,
      senderRole,
      preview: truncatePreview(normalizeDmMessageText(
        typeof lastMessageRecord.text === "string" ? lastMessageRecord.text : "",
      )),
    };
  }

  return {
    fanId,
    username: nonEmpty(fan.username),
    // OnlyFans user objects carry the display name in "name".
    displayName: nonEmpty(fan.name) ?? nonEmpty(fan.displayName),
    unreadCount: typeof unread === "number" && Number.isFinite(unread)
      ? Math.max(0, Math.trunc(unread))
      : 0,
    lastMessage,
  };
}

interface OfapiRestMessage {
  messageId: string;
  senderRole: DmSenderRole;
  senderId: string | null;
  createdAt: Date;
  content: string;
  tipAmountCents: number;
  inReplyToMessageId: string | null;
}

/** Maps one chat-messages item; returns null when id/timestamp are unusable. */
export function parseOfapiRestMessage(
  item: Record<string, unknown>,
  fanId: string,
): OfapiRestMessage | null {
  const messageId = idToString(item.id);
  const createdAt = parseOfapiTimestamp(item.createdAt);
  if (!messageId || !createdAt) {
    return null;
  }

  const senderId = idToString(asRecord(item.fromUser)?.id);
  const sentByMe = item.isSentByMe;
  const senderRole: DmSenderRole = typeof sentByMe === "boolean"
    ? (sentByMe ? "model" : "fan")
    : senderId === null
      ? "unknown"
      : senderId === fanId
        ? "fan"
        : "model";

  return {
    messageId,
    senderRole,
    senderId,
    createdAt,
    content: normalizeDmMessageText(typeof item.text === "string" ? item.text : ""),
    // Priced non-tip messages are PPV; only tip messages carry revenue here.
    tipAmountCents: item.isTip === true &&
        typeof item.price === "number" && Number.isFinite(item.price) && item.price > 0
      ? Math.round(item.price * 100)
      : 0,
    inReplyToMessageId: idToString(asRecord(item.replyToMessage)?.id),
  };
}

// Local copy of executor-handlers' followup predicate (kept duplicated so this
// module never imports executor-handlers — that would be an import cycle).
function needsDmMessagesFollowup(conversation: {
  fanId: number | null;
  isVisible: boolean;
  lastMessageId: string | null;
  newestStoredMessageId: string | null;
  lastMessageAt: Date | null;
  lastMessageSyncAt: Date | null;
  messageCoverageStatus: MessageCoverageStatus;
}) {
  if (!conversation.isVisible || conversation.fanId === null) {
    return false;
  }
  if (conversation.messageCoverageStatus === "pending_backfill") {
    return true;
  }
  if (conversation.lastMessageId === conversation.newestStoredMessageId) {
    return false;
  }
  return conversation.lastMessageSyncAt === null ||
    (conversation.lastMessageAt !== null && conversation.lastMessageSyncAt < conversation.lastMessageAt);
}

function resolveOfapiCoverageStatus(input: {
  currentMode: "backfill" | "incremental";
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
  if (input.hitWindowCap) {
    return "partial_window";
  }
  return input.existingStatus;
}

async function recordOfapiTimestampAnomaly(
  telemetry: SyncRunTelemetry,
  context: string,
  rawValue: unknown,
) {
  await telemetry.addAnomaly({
    code: "dm_timestamp_invalid",
    severity: "warn",
    message: "OFAPI DM payload row was skipped because its id/createdAt is unusable",
    details: {
      context,
      rawValue: typeof rawValue === "string" ? rawValue : String(rawValue),
    },
  });
}

/**
 * dm_conversations for OFAPI-fed OnlyFans pages. One full chats walk per page
 * (bootstrap, offset-checkpointed), then page-1 reconciles every
 * OFAPI_DM_RECONCILE_INTERVAL_MINUTES: unread counts and heads are corrected
 * from the authoritative chats list (heads only ever advance — a fresher
 * webhook projection is never regressed), and diverged conversations get a
 * dm_messages follow-up request.
 */
export async function executeOfapiDmConversationsChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: PageSyncLease;
    syncRunId: number;
  },
): Promise<OfapiStreamChunkResult> {
  const ofapiAccountId = requireOfapiAccountId(input.pageContext);
  const client = resolveOfapiSyncClient(app);
  await input.telemetry.recordPhaseStarted("dm_conversations");

  const requestContext: OfapiRequestContext = {
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    pageId: input.pageContext.page.id,
  };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "dm_conversations");
  await input.telemetry.recordCheckpointLoaded("dm_conversations", summarizeCheckpoint(checkpoint));

  // A non-OFAPI checkpoint (parked OnlyMonster full_scan state) parses to null
  // and restarts as a fresh OFAPI bootstrap.
  let state = parseOfapiDmConversationCursorState(checkpoint?.state) ??
    emptyOfapiDmConversationCursorState();
  const guard = createOfapiRestGuard(app);
  const effective = await loadEffectiveConfig(app.db, app.config);
  const reconcileIntervalMs = Math.max(
    1,
    effective.ofapiDmReconcileIntervalMinutes ?? DEFAULT_RECONCILE_INTERVAL_MINUTES,
  ) * 60 * 1000;

  const bootstrapping = state.bootstrapCompletedAt === null;
  if (!bootstrapping) {
    const lastReconcileAtMs = state.lastReconcileAt ? Date.parse(state.lastReconcileAt) : Number.NaN;
    const reconcileDue = Number.isNaN(lastReconcileAtMs) ||
      Date.now() - lastReconcileAtMs >= reconcileIntervalMs;
    if (!reconcileDue) {
      return {
        satisfied: true,
        yieldReason: null,
        stats: {
          mode: "reconcile",
          skipped: "reconcile_not_due",
          lastReconcileAt: state.lastReconcileAt,
        },
      };
    }
  }

  let processedConversations = 0;
  let followupNeeded = false;
  let pagesFetched = 0;

  const processChatsPage = async (offset: number, pageIndex: number) => {
    const page = await client.listChats(requestContext, ofapiAccountId, {
      limit: OFAPI_CHATS_PAGE_LIMIT,
      offset,
      order: "recent",
      pageIndex,
    });
    await guard.recordResponse(page);
    pagesFetched += 1;

    const summaries: OfapiChatSummary[] = [];
    for (const item of page.items) {
      const summary = parseOfapiChatSummary(item);
      if (summary) {
        summaries.push(summary);
      } else {
        await input.telemetry.addAnomaly({
          code: "ofapi_chat_unparseable",
          severity: "warn",
          message: "Skipped an OFAPI chats item without a fan id",
          details: { context: "ofapi_dm_conversations", offset },
        });
      }
    }

    return { page, summaries };
  };

  const applyChatSummaries = async (
    dbTx: Database,
    summaries: OfapiChatSummary[],
  ) => {
    if (summaries.length === 0) {
      return;
    }

    // B11: lock the conversation rows for the whole read-compute-upsert cycle
    // so a concurrent webhook projection cannot land a fresher head between
    // our read and our full-row upsert (which would then regress it to this
    // stale snapshot and re-burn credits on the re-walk). Lock order matters:
    // conversations before fans, the same order the projection acquires them.
    const existingConversations = await listPageDmConversationsByPlatformConversationIds(dbTx, {
      platformAccountId: input.pageContext.page.id,
      platformConversationIds: summaries.map((summary) => summary.fanId),
      forUpdate: true,
    });

    const fanRows = await upsertFans(dbTx, summaries.map((summary) => ({
      platform: "onlyfans" as const,
      platformUserId: summary.fanId,
      ...(summary.username !== null ? { username: summary.username } : {}),
      ...(summary.displayName !== null ? { displayName: summary.displayName } : {}),
    })));
    await upsertFanPages(dbTx, fanRows.map((fan) => ({
      fanId: fan.id,
      platformAccountId: input.pageContext.page.id,
    })));
    const fanByPlatformUserId = new Map(fanRows.map((fan) => [fan.platformUserId, fan] as const));

    const existingByFanId = new Map(
      existingConversations.map((conversation) => [
        conversation.platformConversationId,
        conversation,
      ]),
    );

    for (const summary of summaries) {
      const existing = existingByFanId.get(summary.fanId) ?? null;
      const fan = fanByPlatformUserId.get(summary.fanId);
      const advance = summary.lastMessage !== null &&
        (existing === null || headAdvances(summary.lastMessage, existing));
      const head = summary.lastMessage;

      const upserted = await upsertPageDmConversation(dbTx, {
        platformAccountId: input.pageContext.page.id,
        fanId: existing?.fanId ?? fan?.id ?? null,
        platformConversationId: summary.fanId,
        partnerPlatformUserId: summary.fanId,
        partnerUsername: summary.username ?? existing?.partnerUsername ?? null,
        partnerDisplayName: summary.displayName ?? existing?.partnerDisplayName ?? null,
        conversationFlags: existing?.conversationFlags ?? 0,
        // The chats list is authoritative for unread counts (reconcile corrects
        // the projection's heuristic drift).
        unreadCount: summary.unreadCount,
        subscriptionTierId: existing?.subscriptionTierId ?? null,
        lastMessageId: advance && head ? head.messageId : existing?.lastMessageId ?? null,
        lastUnreadMessageId: summary.unreadCount > 0
          ? (advance && head && head.senderRole === "fan"
            ? head.messageId
            : existing?.lastUnreadMessageId ?? null)
          : null,
        lastMessageAt: advance && head ? head.createdAt : existing?.lastMessageAt ?? null,
        lastMessageSenderId: advance && head ? head.senderId : existing?.lastMessageSenderId ?? null,
        lastMessageSenderRole: advance && head
          ? head.senderRole
          : existing?.lastMessageSenderRole ?? "unknown",
        lastMessagePreview: advance && head ? head.preview : existing?.lastMessagePreview ?? null,
        lastFanMessageAt: head && head.senderRole === "fan"
          ? laterOf(existing?.lastFanMessageAt ?? null, head.createdAt)
          : existing?.lastFanMessageAt ?? null,
        lastModelMessageAt: head && head.senderRole === "model"
          ? laterOf(existing?.lastModelMessageAt ?? null, head.createdAt)
          : existing?.lastModelMessageAt ?? null,
        storedMessageCount: existing?.storedMessageCount ?? 0,
        newestStoredMessageId: existing?.newestStoredMessageId ?? null,
        oldestStoredMessageId: existing?.oldestStoredMessageId ?? null,
        messageCoverageStatus: existing?.messageCoverageStatus ?? "pending_backfill",
        lastMessageSyncAt: existing?.lastMessageSyncAt ?? null,
        isVisible: true,
        // The OFAPI chats list is not generation-retired (same stance as the
        // parked OnlyMonster path); the stamp only satisfies the upsert contract.
        lastSeenGeneration: existing?.lastSeenGeneration ?? null,
        metadata: {
          ...existing?.metadata,
          provider: nonEmpty(existing?.metadata.provider) ?? "ofapi",
        },
        // B11 insert-race defense: when the row did not exist at read time
        // there was nothing to lock, so the upsert itself refuses to move the
        // head backwards (decision #50: heads only ever advance).
        headForwardOnly: true,
      });
      processedConversations += 1;
      if (upserted && needsDmMessagesFollowup(upserted)) {
        followupNeeded = true;
      }
    }
  };

  let result: OfapiStreamChunkResult | null = null;

  if (bootstrapping) {
    while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
      const block = await guard.resolveBlock();
      if (block) {
        result = budgetBlockResult(block, {
          mode: "bootstrap",
          offset: state.offset,
          pageCount: state.pageCount,
          processedConversations,
        });
        break;
      }

      await assertOwnedPageSyncLease(app.db);
      const { page, summaries } = await processChatsPage(state.offset, state.pageCount);
      const bootstrapComplete = !page.hasNextPage || page.items.length === 0;
      const nowIso = new Date().toISOString();
      const nextState = bootstrapComplete
        ? {
          ...state,
          offset: 0,
          pageCount: state.pageCount + 1,
          bootstrapCompletedAt: nowIso,
          lastReconcileAt: nowIso,
        }
        : {
          ...state,
          offset: state.offset + page.items.length,
          pageCount: state.pageCount + 1,
        };

      const written = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
        await applyChatSummaries(dbTx, summaries);
        return bootstrapComplete
          ? upsertCheckpoint(dbTx, {
            platformAccountId: input.pageContext.page.id,
            stream: "dm_conversations",
            state: nextState,
            lastSuccessfulRunId: input.syncRunId,
          })
          : upsertCheckpointProgress(dbTx, {
            platformAccountId: input.pageContext.page.id,
            stream: "dm_conversations",
            state: nextState,
          });
      });
      state = nextState;
      await input.telemetry.recordCheckpointAdvanced("dm_conversations", summarizeCheckpoint(written));

      if (bootstrapComplete) {
        result = {
          satisfied: true,
          yieldReason: null,
          stats: {
            mode: "bootstrap",
            offset: state.offset,
            pageCount: state.pageCount,
            processedConversations,
            pagesFetched,
            fullSweepCompleted: true,
          },
        };
        break;
      }
    }

    result ??= {
      satisfied: false,
      yieldReason: input.budget.resolveYieldReason(),
      stats: {
        mode: "bootstrap",
        offset: state.offset,
        pageCount: state.pageCount,
        processedConversations,
        pagesFetched,
        fullSweepCompleted: false,
      },
    };
  } else {
    const block = await guard.resolveBlock();
    if (block) {
      result = budgetBlockResult(block, { mode: "reconcile", processedConversations });
    } else {
      await assertOwnedPageSyncLease(app.db);
      const { summaries } = await processChatsPage(0, 0);
      const nextState = {
        ...state,
        lastReconcileAt: new Date().toISOString(),
      };
      const written = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
        await applyChatSummaries(dbTx, summaries);
        return upsertCheckpoint(dbTx, {
          platformAccountId: input.pageContext.page.id,
          stream: "dm_conversations",
          state: nextState,
          lastSuccessfulRunId: input.syncRunId,
        });
      });
      state = nextState;
      await input.telemetry.recordCheckpointAdvanced("dm_conversations", summarizeCheckpoint(written));
      result = {
        satisfied: true,
        yieldReason: null,
        stats: {
          mode: "reconcile",
          processedConversations,
          pagesFetched,
        },
      };
    }
  }

  if (followupNeeded) {
    await requestPageSync(app.db, {
      pageId: input.pageContext.page.id,
      streams: ["dm_messages"],
      source: "scheduled",
      ...pageSyncDependencyInput(app),
    });
  }

  return result;
}

/**
 * dm_messages for OFAPI-fed OnlyFans pages: per-conversation message pages
 * (order=desc, first_id cursor) straight down to the retention tier — 200
 * regular / 1000 spender, resolved from existing spender data — with Fansly's
 * coverage transitions (history exhausted/overlap → complete, retention cap →
 * partial_window). first_id is inclusive at OFAPI, so the cursor row is dropped
 * when it reappears.
 */
export async function executeOfapiDmMessagesChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: PageSyncLease;
    syncRunId: number;
  },
): Promise<OfapiStreamChunkResult> {
  const ofapiAccountId = requireOfapiAccountId(input.pageContext);
  const client = resolveOfapiSyncClient(app);
  await input.telemetry.recordPhaseStarted("dm_messages");

  const requestContext: OfapiRequestContext = {
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    pageId: input.pageContext.page.id,
  };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "dm_messages");
  await input.telemetry.recordCheckpointLoaded("dm_messages", summarizeCheckpoint(checkpoint));

  let state = parseDmMessagesCursorState(checkpoint?.state) ?? emptyDmMessagesCursorState();
  const guard = createOfapiRestGuard(app);

  let processedMessages = 0;
  let completedConversations = 0;
  let overlapHits = 0;
  let exhaustedEligibleConversations = false;
  let budgetBlock: OfapiBudgetBlock | null = null;

  conversationLoop: while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
    await assertOwnedPageSyncLease(app.db);
    let conversation = state.currentConversationId
      ? await getPageDmConversationById(app.db, state.currentConversationId)
      : null;

    if (!conversation || !conversation.isVisible || conversation.fanId === null) {
      const candidate = await selectNextPageDmMessageSyncCandidate(app.db, {
        platformAccountId: input.pageContext.page.id,
      });
      if (!candidate) {
        exhaustedEligibleConversations = true;
        break;
      }

      conversation = await getPageDmConversationById(app.db, candidate.id);
      if (!conversation) {
        exhaustedEligibleConversations = true;
        break;
      }

      const currentMode = conversation.storedMessageCount === 0
        ? "backfill"
        : conversation.lastMessageId !== conversation.newestStoredMessageId
          ? "incremental"
          : conversation.messageCoverageStatus === "pending_backfill"
            ? "backfill"
            : "incremental";

      state = {
        ...emptyDmMessagesCursorState(),
        currentConversationId: conversation.id,
        currentPlatformConversationId: conversation.platformConversationId,
        currentBeforeMessageId: currentMode === "backfill"
          ? conversation.oldestStoredMessageId
          : null,
        currentMode,
      };
      const progressCheckpoint = await upsertCheckpointProgress(app.db, {
        platformAccountId: input.pageContext.page.id,
        stream: "dm_messages",
        state,
      });
      await input.telemetry.recordCheckpointAdvanced("dm_messages", summarizeCheckpoint(progressCheckpoint));
    }

    if (!conversation || state.currentMode === null || state.currentMode === "deep_backfill") {
      exhaustedEligibleConversations = true;
      break;
    }

    const currentMode = state.currentMode;
    let collectedThisConversation = 0;
    while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
      const currentConversation = conversation;
      budgetBlock = await guard.resolveBlock();
      if (budgetBlock) {
        break conversationLoop;
      }
      await assertOwnedPageSyncLease(app.db);

      const cursor = state.currentBeforeMessageId;
      const page = await client.listChatMessages(
        requestContext,
        ofapiAccountId,
        currentConversation.platformConversationId,
        {
          limit: OFAPI_MESSAGES_PAGE_LIMIT,
          firstId: cursor,
        },
      );
      await guard.recordResponse(page);

      // Stage 1: DM message pages are captured raw (previously zero raw
      // persistence on this path). The OFAPI client exposes no raw response
      // envelope, so the unfiltered item records are persisted instead.
      await persistRawPayload(app.db, {
        platformAccountId: input.pageContext.page.id,
        syncRunId: input.syncRunId,
        endpoint: "dm_messages",
        requestParams: {
          conversationId: currentConversation.platformConversationId,
          limit: OFAPI_MESSAGES_PAGE_LIMIT,
          firstId: cursor ?? null,
        },
        responsePayload: { items: page.items },
        mapperVersion: OFAPI_DM_MAPPER_VERSION,
        payloadKind: "dm_messages",
        retainUntil: dmRetentionDate(),
      }, {
        action: "inserting dm_messages raw payload",
        platform: "onlyfans",
      });

      // first_id is inclusive — drop the cursor echo before any bookkeeping.
      const items = page.items.filter((item) => {
        const itemId = idToString(item.id);
        return !(cursor !== null && itemId !== null && itemId === cursor);
      });

      const normalizedMessages: Parameters<typeof upsertPageDmMessages>[1] = [];
      const pageMessageIds: string[] = [];
      for (const item of items) {
        const parsed = parseOfapiRestMessage(item, currentConversation.platformConversationId);
        if (!parsed) {
          await recordOfapiTimestampAnomaly(
            input.telemetry,
            "ofapi_dm_messages:message",
            asRecord(item)?.createdAt ?? null,
          );
          continue;
        }

        pageMessageIds.push(parsed.messageId);
        normalizedMessages.push({
          conversationId: currentConversation.id,
          platformAccountId: input.pageContext.page.id,
          platformMessageId: parsed.messageId,
          senderPlatformUserId: parsed.senderRole === "fan"
            ? currentConversation.platformConversationId
            : parsed.senderId,
          senderRole: parsed.senderRole,
          createdAt: parsed.createdAt,
          content: parsed.content,
          totalTipAmountCents: parsed.tipAmountCents,
          inReplyToMessageId: parsed.inReplyToMessageId,
          inReplyToRootMessageId: null,
        });
      }

      const existingIds = await getExistingPageDmMessageIds(app.db, {
        conversationId: currentConversation.id,
        platformMessageIds: pageMessageIds,
      });
      const overlapFound = pageMessageIds.some((messageId) => existingIds.has(messageId));
      // Already-stored rows are skipped (not re-upserted) so the projection's
      // tip/purchase annotations survive the REST walk.
      const insertableMessages = normalizedMessages.filter(
        (message) => !existingIds.has(message.platformMessageId),
      );
      collectedThisConversation += insertableMessages.length;
      processedMessages += normalizedMessages.length;

      const retentionLimit = await getPageDmMessageRetentionLimit(app.db, currentConversation.id);
      const oldestMessageId = pageMessageIds.at(-1) ?? null;
      const providerHistoryExhausted = !page.hasNextPage || items.length === 0 || !oldestMessageId;
      const hitWindowCap = currentMode === "backfill" &&
        (currentConversation.storedMessageCount + collectedThisConversation) >= retentionLimit;
      const shouldComplete = currentMode === "incremental"
        ? overlapFound || providerHistoryExhausted
        : overlapFound || providerHistoryExhausted || hitWindowCap;

      if (shouldComplete) {
        if (overlapFound) {
          overlapHits += 1;
        }
        const messageCoverageStatus = resolveOfapiCoverageStatus({
          currentMode,
          existingStatus: currentConversation.messageCoverageStatus,
          overlapFound,
          providerHistoryExhausted,
          hitWindowCap,
        });
        const finalized = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
          await upsertPageDmMessages(dbTx, insertableMessages);
          const finalizedConversation = await finalizePageDmConversationMessageSync(dbTx, {
            conversationId: currentConversation.id,
            messageCoverageStatus,
            enforceRetention: isPageDmPruneEnabled(app.config),
          });
          const progressCheckpoint = await upsertCheckpointProgress(dbTx, {
            platformAccountId: input.pageContext.page.id,
            stream: "dm_messages",
            state: emptyDmMessagesCursorState(),
          });
          return { finalizedConversation, progressCheckpoint };
        });
        conversation = finalized.finalizedConversation.conversation;
        completedConversations += 1;
        state = emptyDmMessagesCursorState();
        await input.telemetry.recordCheckpointAdvanced(
          "dm_messages",
          summarizeCheckpoint(finalized.progressCheckpoint),
        );
        continue conversationLoop;
      }

      state = {
        ...state,
        currentBeforeMessageId: oldestMessageId,
      };
      const progressCheckpoint = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
        await upsertPageDmMessages(dbTx, insertableMessages);
        return upsertCheckpointProgress(dbTx, {
          platformAccountId: input.pageContext.page.id,
          stream: "dm_messages",
          state,
        });
      });
      await input.telemetry.recordCheckpointAdvanced(
        "dm_messages",
        summarizeCheckpoint(progressCheckpoint),
      );

      if (input.budget.shouldYield()) {
        break;
      }
    }
  }

  const stats = {
    currentConversationId: state.currentConversationId,
    currentBeforeMessageId: state.currentBeforeMessageId,
    currentMode: state.currentMode,
    processedMessages,
    completedConversations,
    overlapHits,
    ofapiRequests: guard.requestsUsed,
  };

  if (budgetBlock) {
    return budgetBlockResult(budgetBlock, stats);
  }

  if (!exhaustedEligibleConversations) {
    return {
      satisfied: false,
      yieldReason: input.budget.resolveYieldReason(),
      stats,
    };
  }

  const completedCheckpoint = await upsertCheckpoint(app.db, {
    platformAccountId: input.pageContext.page.id,
    stream: "dm_messages",
    state,
    lastSuccessfulRunId: input.syncRunId,
  });
  await input.telemetry.recordCheckpointAdvanced(
    "dm_messages",
    summarizeCheckpoint(completedCheckpoint),
  );

  return {
    satisfied: true,
    yieldReason: null,
    stats,
  };
}
