// OFAPI-backed OnlyFans chats-list sync. REST bootstraps and reconciles
// conversation heads; the retired per-chat message crawler is not registered.
// Every request is credit-budgeted and page_sync_cursors checkpoints resume
// the walk after a per-chunk request cap, daily ceiling, or balance-floor hold.

import {
  assertOwnedPageSyncLease,
  getCheckpoint,
  getOfapiCreditState,
  listPageDmConversationsByPlatformConversationIds,
  reserveOfapiDayCredits,
  settleOfapiDayCreditReservation,
  upsertCheckpoint,
  upsertCheckpointProgress,
  upsertFanPages,
  upsertFans,
  upsertPageDmConversation,
  withOwnedPageSyncTransaction,
  type Database,
  type DmSenderRole,
  type OfapiDayBudgetScope,
  type PageSyncLease,
} from "@agency_hub_core/db";
import {
  normalizeDmMessageText,
  OFAPI_MIRROR_BUDGET_DEFAULTS,
} from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { isOfapiCreditLedgerEnabled } from "../ofapi-credits.ts";
import { asRecord, idToString } from "../ofapi-payloads.ts";
import type { OfapiClient, OfapiListPage, OfapiRequestContext } from "../ofapi.ts";
import type { ResolvedPageContext } from "../page-context.ts";
import { composeRequestObservers, type SyncChunkBudget } from "./chunk-budget.ts";
import {
  emptyOfapiDmConversationCursorState,
  parseOfapiDmConversationCursorState,
} from "./cursor-state.ts";
import { summarizeCheckpoint, type SyncRunTelemetry } from "./observability.ts";
import { dmRetentionDate, persistRawPayload } from "./shared.ts";

const OFAPI_CHATS_PAGE_LIMIT = 100;
// Raw-payload provenance for the OFAPI chats-list mapping.
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
  qualityHold?: string | null;
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
 * ceiling (audience, D6) pass `budgetScope: "audience"`. With the ledger on,
 * dedicated lanes atomically reserve both their own counter and the shared
 * physical cap; without it they fall back to the global day counter.
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
  const globalDailyCreditBudget = Math.max(
    1,
    // Decision #160/#170: dedicated legacy lanes and mirror admission share
    // one physical stop-loss; the retired DM crawler's 500-credit cap is not
    // that shared ceiling.
    app.config.ofapiMirrorGlobalDailyCreditBudget ??
      OFAPI_MIRROR_BUDGET_DEFAULTS.globalDailyCreditBudget,
  );
  const creditFloor = Math.max(0, app.config.ofapiCreditFloor ?? DEFAULT_CREDIT_FLOOR);
  // Dedicated counters (audience per decision #50, backfill per Stage 14)
  // mirror ledger-attributed spend. With the ledger on they are reserved in
  // the same statement as the shared cap; off, both fall back to that global
  // counter exactly as before.
  const scope: OfapiDayBudgetScope =
    (options?.budgetScope === "audience" || options?.budgetScope === "backfill" ||
      options?.budgetScope === "link_stats") &&
      isOfapiCreditLedgerEnabled(app.config)
      ? options.budgetScope
      : "global";
  let requestsUsed = 0;
  let reservationReceipt: Awaited<ReturnType<typeof reserveOfapiDayCredits>> = null;

  return {
    get requestsUsed() {
      return requestsUsed;
    },
    abandonPendingReservation() {
      // A transport/classified request failure has no response to settle.
      // Clear only the in-memory lifecycle token; the DB estimate deliberately
      // remains charged until UTC rollover as a conservative unknown outcome.
      const abandoned = reservationReceipt !== null;
      reservationReceipt = null;
      return abandoned;
    },
    async resolveBlock(): Promise<OfapiBudgetBlock | null> {
      if (requestsUsed >= maxRequestsPerRun) {
        return "ofapi_request_budget";
      }
      if (reservationReceipt !== null) {
        throw new Error("OFAPI day-budget reservation is still pending settlement");
      }

      const credit = await getOfapiCreditState(app.db);
      if (isOfapiCreditFloorBlocking({
        creditFloor,
        lastBalance: credit.lastBalance,
        lastBalanceAt: credit.lastBalanceAt,
      })) {
        return "ofapi_credit_floor";
      }

      const receipt = await reserveOfapiDayCredits(app.db, {
        scope,
        estimate: OFAPI_REQUEST_CREDIT_ESTIMATE,
        budget: dailyCreditBudget,
        ...(scope === "global" ? {} : { globalBudget: globalDailyCreditBudget }),
      });
      if (receipt) reservationReceipt = receipt;
      return receipt ? null : "ofapi_daily_credit_budget";
    },
    async recordResponse(page: OfapiListPage) {
      requestsUsed += 1;
      const receipt = reservationReceipt;
      reservationReceipt = null;
      if (!receipt) {
        throw new Error("OFAPI response cannot settle without a day-budget receipt");
      }
      const actualCredits = page.meta?.creditsUsed ?? OFAPI_REQUEST_CREDIT_ESTIMATE;
      // With the ledger on, the client's onCreditSpend sink already recorded
      // every physical attempt in both the global counter and the attributed
      // dedicated lane. Release only the original reservation here; retry
      // spend must not disappear behind the final logical response. Custom
      // clients without the sink retain the legacy final-response settlement.
      // Flag off keeps the pre-ledger accounting (uncached reads cost 1 credit;
      // trust _meta when present), applied as a settle against the reservation.
      if (isOfapiCreditLedgerEnabled(app.config)) {
        await settleOfapiDayCreditReservation(app.db, {
          scope,
          receipt,
          creditsDelta: page.creditSpendAccounted === true
            ? -OFAPI_REQUEST_CREDIT_ESTIMATE
            : actualCredits - OFAPI_REQUEST_CREDIT_ESTIMATE,
        });
        if (scope !== "global") {
          await settleOfapiDayCreditReservation(app.db, {
            scope: "global",
            receipt,
            creditsDelta: -OFAPI_REQUEST_CREDIT_ESTIMATE,
          });
        }
        return;
      }
      await settleOfapiDayCreditReservation(app.db, {
        scope,
        receipt,
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

/**
 * dm_conversations for OFAPI-fed OnlyFans pages. One full chats walk per page
 * (bootstrap, offset-checkpointed), then page-1 reconciles every
 * OFAPI_DM_RECONCILE_INTERVAL_MINUTES: unread counts and heads are corrected
 * from the authoritative chats list (heads only ever advance — a fresher
 * webhook projection is never regressed). Message capture uses the separate
 * intent-driven OF mirror stream.
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
  let pagesFetched = 0;

  const processChatsPage = async (offset: number, pageIndex: number) => {
    const page = await client.listChats(requestContext, ofapiAccountId, {
      limit: OFAPI_CHATS_PAGE_LIMIT,
      offset,
      order: "recent",
      pageIndex,
    });
    await guard.recordResponse(page);
    // The OFAPI client exposes no raw response envelope, so persist the
    // unfiltered chats-list items for provenance.
    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: "dm_conversations",
      requestParams: { limit: OFAPI_CHATS_PAGE_LIMIT, offset, order: "recent" },
      responsePayload: { items: page.items },
      mapperVersion: OFAPI_DM_MAPPER_VERSION,
      payloadKind: "dm_metadata",
      retainUntil: dmRetentionDate(),
    }, {
      action: "inserting dm_conversations raw payload",
      platform: "onlyfans",
    });
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

      await upsertPageDmConversation(dbTx, {
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

  return result;
}
