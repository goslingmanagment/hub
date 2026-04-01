import { randomUUID } from "node:crypto";

import {
  assertOwnedPageSyncLease,
  getCheckpoint,
  getOldestPendingTransactionAt,
  markTransactionsScanToken,
  mergePageMetadata,
  retireTransactionsMissingFromWindow,
  rebuildSpenderProjections,
  rebuildRevenueRollups,
  upsertCheckpoint,
  upsertCheckpointProgress,
  upsertFanPages,
  upsertFans,
  upsertTransaction,
  withOwnedPageSyncTransaction,
} from "@agency_hub_core/db";
import {
  ONLYMONSTER_MAPPER_VERSION,
  isKnownOnlyMonsterTransactionType,
  mapOnlyMonsterTransactionState,
  mapOnlyMonsterTransactionType,
  OnlyMonsterApiError,
  type OnlyMonsterChargeback,
  type OnlyMonsterTransaction,
} from "@agency_hub_core/onlyfans";
import {
  calculateNetMillsFromGross,
  dollarsToMills,
  startOfBusinessDay,
  UTC_TIME_ZONE,
} from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import {
  ONLYFANS_TRANSACTION_BACKFILL_LOWER_BOUND_METADATA_KEY,
  parseOnlyFansMetadataAccountCreatedAt,
  parseOnlyFansTransactionBackfillLowerBound,
} from "../onlyfans.ts";
import type { SyncChunkBudget, SyncChunkYieldReason } from "./chunk-budget.ts";
import { summarizeCheckpoint, type SyncRunTelemetry } from "./observability.ts";
import { DAY_MS, persistRawPayload, retentionDate } from "./shared.ts";
import {
  buildBackfillProgressMessage,
  isoDateOrNull,
  parseTransactionBackfillState,
  type OnlyFansTransactionBackfillState,
} from "./transaction-backfill.ts";

const ONLYFANS_SYNTHETIC_BACKFILL_START = new Date("2016-01-01T00:00:00.000Z");
const ONLYFANS_SAFE_CURSOR_PAGES = 4;
const ONLYFANS_HISTORICAL_WINDOW_MS = 365 * DAY_MS;
const ONLYFANS_EMPTY_WINDOW_LIMIT = 2;

type OnlyFansTransactionSyncResult = {
  satisfied: boolean;
  yieldReason: SyncChunkYieldReason | null;
  processed: number;
  processedTransactions: number;
  processedChargebacks: number;
  newestSeenAt: Date;
};

function buildOnlyFansFanInputs(
  fanPlatformIds: string[],
) {
  if (fanPlatformIds.length === 0) {
    return [];
  }

  return Array.from(new Set(fanPlatformIds)).map((platformUserId) => ({
    platform: "onlyfans" as const,
    platformUserId,
    metadata: {},
  }));
}

function minDate(a: Date | null, b: Date | null) {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return a <= b ? a : b;
}

function maxDate(a: Date | null, b: Date | null) {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return a >= b ? a : b;
}

async function recordUnknownOnlyFansTransactionType(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    telemetry: SyncRunTelemetry;
  },
  rawType: string,
  seenRawTypes: Set<string>,
) {
  if (isKnownOnlyMonsterTransactionType(rawType) || seenRawTypes.has(rawType)) {
    return;
  }

  seenRawTypes.add(rawType);
  app.logger.warn({
    pageLabel: input.pageLabel,
    platformAccountId: input.platformAccountId,
    rawType,
  }, "Unmapped OnlyFans transaction type fell back to other");
  await input.telemetry.addAnomaly({
    code: "unknown_transaction_type",
    severity: "warn",
    message: "Unmapped OnlyFans transaction type fell back to other",
    details: {
      provider: "onlyfans",
      rawType,
      pageLabel: input.pageLabel,
      platformAccountId: input.platformAccountId,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maxLowerBound(a: Date, b: Date) {
  return a >= b ? a : b;
}

function resolveOnlyFansBackfillLowerBound(metadata: Record<string, unknown>) {
  const persisted = parseOnlyFansTransactionBackfillLowerBound(metadata);
  if (persisted) {
    return {
      date: persisted,
      source: "persisted" as const,
    };
  }

  const legacy = parseOnlyFansMetadataAccountCreatedAt(metadata);
  if (legacy) {
    return {
      date: legacy,
      source: "legacy" as const,
    };
  }

  return {
    date: ONLYFANS_SYNTHETIC_BACKFILL_START,
    source: "synthetic" as const,
  };
}

function getOnlyFansHistoricalWindowStart(windowEnd: Date, lowerBound: Date) {
  return maxLowerBound(new Date(windowEnd.getTime() - ONLYFANS_HISTORICAL_WINDOW_MS), lowerBound);
}

function getOnlyFansSyntheticLowerBound() {
  return ONLYFANS_SYNTHETIC_BACKFILL_START;
}

function buildOnlyFansSyntheticWindow(snapshotEnd: Date) {
  return {
    start: getOnlyFansHistoricalWindowStart(snapshotEnd, getOnlyFansSyntheticLowerBound()),
    end: snapshotEnd,
  };
}

function usesSyntheticOnlyFansBackfillBound(state: OnlyFansTransactionBackfillState) {
  return state.fallbackStartUsed;
}

function canAdvanceOnlyFansHistoricalWindow(
  state: OnlyFansTransactionBackfillState,
  windowEnd: Date,
) {
  return usesSyntheticOnlyFansBackfillBound(state) &&
    windowEnd.getTime() > getOnlyFansSyntheticLowerBound().getTime();
}

function buildNextOnlyFansHistoricalWindow(
  state: OnlyFansTransactionBackfillState,
  pageOldestSeenAt: Date | null,
) {
  const lowerBound = getOnlyFansSyntheticLowerBound();
  const nextWindowEnd = pageOldestSeenAt ?? new Date(state.start);
  if (!canAdvanceOnlyFansHistoricalWindow(state, nextWindowEnd)) {
    return null;
  }

  const nextWindowStart = getOnlyFansHistoricalWindowStart(nextWindowEnd, lowerBound);
  if (
    nextWindowStart.getTime() === new Date(state.start).getTime() &&
    nextWindowEnd.getTime() === new Date(state.windowEnd).getTime()
  ) {
    return null;
  }

  return {
    start: nextWindowStart,
    end: nextWindowEnd,
  };
}

function bufferOnlyFansBackfillLowerBound(oldestSeenAt: Date, lookbackDays: number) {
  return maxLowerBound(
    new Date(oldestSeenAt.getTime() - lookbackDays * DAY_MS),
    getOnlyFansSyntheticLowerBound(),
  );
}

async function persistOnlyFansBackfillLowerBound(
  app: AppContext,
  platformAccountId: number,
  lowerBound: Date,
) {
  await withOwnedPageSyncTransaction(app.db, async (db) => {
    await mergePageMetadata(db, platformAccountId, {
      [ONLYFANS_TRANSACTION_BACKFILL_LOWER_BOUND_METADATA_KEY]: lowerBound.toISOString(),
    });
  });
}

function isLegacyOnlyFansTransactionBackfillState(value: unknown) {
  if (!isRecord(value) || value.provider !== "onlyfans" || value.phase !== "transactions") {
    return false;
  }

  const windowEndValid = typeof value.windowEnd === "string" &&
    !Number.isNaN(new Date(value.windowEnd).getTime());
  const windowPageCountValid = typeof value.windowPageCount === "number" &&
    Number.isInteger(value.windowPageCount) &&
    value.windowPageCount >= 0;

  return !windowEndValid || !windowPageCountValid;
}

function upgradeOnlyFansBackfillState(
  state: OnlyFansTransactionBackfillState,
  rawState: unknown,
) {
  if (isLegacyOnlyFansTransactionBackfillState(rawState)) {
    return {
      ...state,
      windowEnd: state.dirtyFrom ?? state.snapshotEnd,
      windowPageCount: 0,
      cursor: null,
      emptyWindowCount: 0,
    } satisfies OnlyFansTransactionBackfillState;
  }

  if (
    isRecord(rawState) &&
    rawState.provider === "onlyfans" &&
    rawState.phase === "chargebacks" &&
    typeof rawState.cursor === "string"
  ) {
    return {
      ...state,
      cursor: null,
      windowPageCount: 0,
      emptyWindowCount: 0,
    } satisfies OnlyFansTransactionBackfillState;
  }

  return state;
}

function getOnlyFansBackfillWindowPageLimit(budget: SyncChunkBudget) {
  return Math.min(ONLYFANS_SAFE_CURSOR_PAGES, Math.max(1, budget.maxRequests - 1));
}

function isOnlyFansBackfillRangeError(error: unknown) {
  if (!(error instanceof OnlyMonsterApiError)) {
    return false;
  }

  if (![400, 422].includes(error.status ?? 0)) {
    return false;
  }

  const details = `${error.message} ${error.responseSnippet ?? ""}`.toLowerCase();
  return ["range", "start", "date", "before", "after", "old", "invalid"].some((term) =>
    details.includes(term)
  );
}

async function flushOnlyFansDirtyRange(
  app: AppContext,
  platformAccountId: number,
  dirtyFrom: Date | null,
) {
  if (!dirtyFrom) {
    return;
  }

  await withOwnedPageSyncTransaction(app.db, async (db) => {
    await rebuildSpenderProjections(db, platformAccountId, dirtyFrom);
    await rebuildRevenueRollups(db, platformAccountId, dirtyFrom);
  });
}

async function flushAndClearOnlyFansDirtyRange(
  app: AppContext,
  platformAccountId: number,
  state: OnlyFansTransactionBackfillState,
) {
  const dirtyFrom = state.dirtyFrom ? new Date(state.dirtyFrom) : null;
  await flushOnlyFansDirtyRange(app, platformAccountId, dirtyFrom);
  if (!dirtyFrom) {
    return state;
  }

  const clearedState: OnlyFansTransactionBackfillState = {
    ...state,
    cursor: null,
    dirtyFrom: null,
    windowPageCount: 0,
  };
  await upsertCheckpointProgress(app.db, {
    platformAccountId,
    stream: "transactions",
    state: clearedState,
  });

  return clearedState;
}

function buildOnlyFansPersistedResumeState(
  state: OnlyFansTransactionBackfillState,
  input: {
    phase?: OnlyFansTransactionBackfillState["phase"];
    start?: Date | string;
    windowEnd?: Date | string;
    oldestSeenAt?: Date | null;
    newestSeenAt?: Date | null;
    dirtyFrom?: Date | null;
    processedTransactions?: number;
    processedChargebacks?: number;
    transactionPages?: number;
    chargebackPages?: number;
    emptyWindowCount?: number;
  },
): OnlyFansTransactionBackfillState {
  const start = input.start ?? state.start;
  const windowEnd = input.windowEnd ?? state.windowEnd;

  return {
    ...state,
    phase: input.phase ?? state.phase,
    cursor: null,
    start: typeof start === "string" ? new Date(start).toISOString() : start.toISOString(),
    oldestSeenAt: input.oldestSeenAt === undefined ? state.oldestSeenAt : isoDateOrNull(input.oldestSeenAt),
    newestSeenAt: input.newestSeenAt === undefined ? state.newestSeenAt : isoDateOrNull(input.newestSeenAt),
    dirtyFrom: input.dirtyFrom === undefined ? state.dirtyFrom : isoDateOrNull(input.dirtyFrom),
    processedTransactions: input.processedTransactions ?? state.processedTransactions,
    processedChargebacks: input.processedChargebacks ?? state.processedChargebacks,
    transactionPages: input.transactionPages ?? state.transactionPages,
    chargebackPages: input.chargebackPages ?? state.chargebackPages,
    windowEnd: typeof windowEnd === "string" ? new Date(windowEnd).toISOString() : windowEnd.toISOString(),
    windowPageCount: 0,
    emptyWindowCount: input.emptyWindowCount ?? state.emptyWindowCount,
  };
}

type OnlyFansIncrementalResumeState = {
  mode: "incremental";
  completed: false;
  provider: "onlyfans";
  phase: "transactions" | "chargebacks";
  start: string;
  end: string;
  cursor: string | null;
  newestSeenAt: string | null;
  oldestSeenAt: string | null;
  dirtyFrom: string | null;
  processedTransactions: number;
  processedChargebacks: number;
  transactionPages: number;
  chargebackPages: number;
  olderThanBoundaryItems: number;
  olderThanBoundaryPages: number;
  scanToken: string;
};

type LegacyOnlyFansIncrementalResumeState = Omit<OnlyFansIncrementalResumeState, "scanToken"> & {
  keepTransactionIds: string[];
};

type ParsedOnlyFansIncrementalResumeState =
  | OnlyFansIncrementalResumeState
  | LegacyOnlyFansIncrementalResumeState;

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.every((item) => typeof item === "string")
    ? value
    : null;
}

function asIsoString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asNullableIsoString(value: unknown) {
  if (value === null) {
    return null;
  }

  return asIsoString(value);
}

function asNonNegativeInt(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function asNullableString(value: unknown) {
  return value === null || typeof value === "string" ? value : null;
}

function parseOnlyFansIncrementalResumeState(value: unknown): ParsedOnlyFansIncrementalResumeState | null {
  const state = isRecord(value) ? value : null;
  if (
    !state ||
    state.mode !== "incremental" ||
    state.completed !== false ||
    state.provider !== "onlyfans"
  ) {
    return null;
  }

  const start = asIsoString(state.start);
  const end = asIsoString(state.end);
  const cursor = asNullableString(state.cursor);
  const newestSeenAt = asNullableIsoString(state.newestSeenAt);
  const oldestSeenAt = asNullableIsoString(state.oldestSeenAt);
  const dirtyFrom = asNullableIsoString(state.dirtyFrom);
  const processedTransactions = asNonNegativeInt(state.processedTransactions);
  const processedChargebacks = asNonNegativeInt(state.processedChargebacks);
  const transactionPages = asNonNegativeInt(state.transactionPages);
  const chargebackPages = asNonNegativeInt(state.chargebackPages);
  const olderThanBoundaryItems = asNonNegativeInt(state.olderThanBoundaryItems);
  const olderThanBoundaryPages = asNonNegativeInt(state.olderThanBoundaryPages);
  const scanToken = typeof state.scanToken === "string" ? state.scanToken : null;
  const hasLegacyKeepTransactionIds = Object.prototype.hasOwnProperty.call(state, "keepTransactionIds");
  const keepTransactionIds = hasLegacyKeepTransactionIds ? asStringArray(state.keepTransactionIds) : undefined;

  if (
    start === null ||
    end === null ||
    cursor === undefined ||
    newestSeenAt === undefined ||
    oldestSeenAt === undefined ||
    dirtyFrom === undefined ||
    processedTransactions === null ||
    processedChargebacks === null ||
    transactionPages === null ||
    chargebackPages === null ||
    olderThanBoundaryItems === null ||
    olderThanBoundaryPages === null ||
    keepTransactionIds === null ||
    (scanToken === null && keepTransactionIds === undefined) ||
    (state.phase !== "transactions" && state.phase !== "chargebacks")
  ) {
    return null;
  }

  const parsedState = {
    mode: "incremental",
    completed: false,
    provider: "onlyfans",
    phase: state.phase,
    start,
    end,
    cursor,
    newestSeenAt,
    oldestSeenAt,
    dirtyFrom,
    processedTransactions,
    processedChargebacks,
    transactionPages,
    chargebackPages,
    olderThanBoundaryItems,
    olderThanBoundaryPages,
  };

  if (scanToken !== null) {
    return {
      ...parsedState,
      scanToken,
    };
  }

  return {
    ...parsedState,
    keepTransactionIds: keepTransactionIds ?? [],
  };
}

function buildOnlyFansIncrementalResumeState(input: {
  phase: OnlyFansIncrementalResumeState["phase"];
  start: Date | string;
  end: Date | string;
  cursor: string | null;
  newestSeenAt: Date | null;
  oldestSeenAt: Date | null;
  dirtyFrom: Date | null;
  processedTransactions: number;
  processedChargebacks: number;
  transactionPages: number;
  chargebackPages: number;
  olderThanBoundaryItems: number;
  olderThanBoundaryPages: number;
  scanToken: string;
}): OnlyFansIncrementalResumeState {
  return {
    mode: "incremental",
    completed: false,
    provider: "onlyfans",
    phase: input.phase,
    start: typeof input.start === "string" ? new Date(input.start).toISOString() : input.start.toISOString(),
    end: typeof input.end === "string" ? new Date(input.end).toISOString() : input.end.toISOString(),
    cursor: input.cursor,
    newestSeenAt: isoDateOrNull(input.newestSeenAt),
    oldestSeenAt: isoDateOrNull(input.oldestSeenAt),
    dirtyFrom: isoDateOrNull(input.dirtyFrom),
    processedTransactions: input.processedTransactions,
    processedChargebacks: input.processedChargebacks,
    transactionPages: input.transactionPages,
    chargebackPages: input.chargebackPages,
    olderThanBoundaryItems: input.olderThanBoundaryItems,
    olderThanBoundaryPages: input.olderThanBoundaryPages,
    scanToken: input.scanToken,
  };
}

function getLegacyOnlyFansKeepTransactionIds(
  state: ParsedOnlyFansIncrementalResumeState,
) {
  return "keepTransactionIds" in state ? state.keepTransactionIds : [];
}

function normalizeOnlyFansIncrementalResumeState(
  state: ParsedOnlyFansIncrementalResumeState,
  scanToken = "scanToken" in state ? state.scanToken : randomUUID(),
): {
  legacyKeepTransactionIds: string[];
  state: OnlyFansIncrementalResumeState;
} {
  const legacyKeepTransactionIds = getLegacyOnlyFansKeepTransactionIds(state);
  const { keepTransactionIds: _keepTransactionIds, ...normalizedState } = state as ParsedOnlyFansIncrementalResumeState & {
    keepTransactionIds?: string[];
  };

  return {
    legacyKeepTransactionIds,
    state: {
      ...normalizedState,
      scanToken,
    },
  };
}

async function flushAndClearOnlyFansIncrementalDirtyRange(
  app: AppContext,
  platformAccountId: number,
  state: OnlyFansIncrementalResumeState,
) {
  const dirtyFrom = state.dirtyFrom ? new Date(state.dirtyFrom) : null;
  await flushOnlyFansDirtyRange(app, platformAccountId, dirtyFrom);
  if (!dirtyFrom) {
    return state;
  }

  const clearedState: OnlyFansIncrementalResumeState = {
    ...state,
    dirtyFrom: null,
  };
  await upsertCheckpointProgress(app.db, {
    platformAccountId,
    stream: "transactions",
    state: clearedState,
  });

  return clearedState;
}

async function upsertOnlyFansIncrementalTransactionsPage(
  db: AppContext["db"],
  input: {
    platformAccountId: number;
    commissionRate: number;
    scanToken: string;
  },
  items: OnlyMonsterTransaction[],
) {
  const fanPlatformIds = Array.from(new Set(items.map((item) => item.fan.id)));
  const fans = fanPlatformIds.length > 0
    ? await upsertFans(db, buildOnlyFansFanInputs(fanPlatformIds))
    : [];
  if (fans.length > 0) {
    await upsertFanPages(db, fans.map((fan) => ({
      fanId: fan.id,
      platformAccountId: input.platformAccountId,
    })));
  }
  const fanMap = new Map(fans.map((fan) => [fan.platformUserId, fan.id]));

  for (const item of items) {
    const grossAmountMills = dollarsToMills(item.amount);
    const creatorNetAmountMills = calculateNetMillsFromGross(
      grossAmountMills,
      input.commissionRate,
    );

    await upsertTransaction(db, {
      platformAccountId: input.platformAccountId,
      fanId: fanMap.get(item.fan.id) ?? null,
      transactionId: item.id,
      correlationAccountId: item.fan.id,
      rawType: item.type,
      canonicalType: mapOnlyMonsterTransactionType(item.type),
      transactionState: mapOnlyMonsterTransactionState(item.status),
      rawStatus: item.status,
      grossAmountMills,
      sourceDestinationAmountMills: grossAmountMills,
      creatorNetAmountMills,
      occurredAt: new Date(item.timestamp),
      scanToken: input.scanToken,
    });
  }
}

async function upsertOnlyFansIncrementalChargebacksPage(
  db: AppContext["db"],
  input: {
    platformAccountId: number;
    commissionRate: number;
    scanToken: string;
  },
  items: OnlyMonsterChargeback[],
) {
  const fanPlatformIds = Array.from(new Set(items.map((item) => item.fan.id)));
  const fans = fanPlatformIds.length > 0
    ? await upsertFans(db, buildOnlyFansFanInputs(fanPlatformIds))
    : [];
  if (fans.length > 0) {
    await upsertFanPages(db, fans.map((fan) => ({
      fanId: fan.id,
      platformAccountId: input.platformAccountId,
    })));
  }
  const fanMap = new Map(fans.map((fan) => [fan.platformUserId, fan.id]));

  for (const item of items) {
    const grossAmountMills = -dollarsToMills(item.amount);
    const creatorNetAmountMills = calculateNetMillsFromGross(
      grossAmountMills,
      input.commissionRate,
    );

    await upsertTransaction(db, {
      platformAccountId: input.platformAccountId,
      fanId: fanMap.get(item.fan.id) ?? null,
      transactionId: item.id,
      correlationAccountId: item.fan.id,
      rawType: item.type,
      canonicalType: "chargeback",
      transactionState: mapOnlyMonsterTransactionState(item.status),
      rawStatus: item.status,
      grossAmountMills,
      sourceDestinationAmountMills: grossAmountMills,
      creatorNetAmountMills,
      occurredAt: new Date(item.chargeback_timestamp),
      sourceUpdatedAt: new Date(item.transaction_timestamp),
      scanToken: input.scanToken,
    });
  }
}

async function syncOnlyFansTransactionsIncremental(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    platformAccountIdValue: string;
    commissionRate: number;
    rescanStart?: Date | null;
    requestContext: Parameters<AppContext["onlyFansAdapter"]["getTransactionsPage"]>[0];
    syncRunId: number;
    telemetry: SyncRunTelemetry;
    budget: SyncChunkBudget;
  },
  checkpoint: Awaited<ReturnType<typeof getCheckpoint>>,
  existingState: ParsedOnlyFansIncrementalResumeState | null,
): Promise<OnlyFansTransactionSyncResult> {
  const oldestPendingAt = await getOldestPendingTransactionAt(app.db, input.platformAccountId);
  const lookbackStart = checkpoint?.cursorTimestamp
    ? new Date(
      checkpoint.cursorTimestamp.getTime() -
        app.config.transactionLookbackDays * DAY_MS,
    )
    : null;
  const earliestRescanStart = lookbackStart && oldestPendingAt
    ? (oldestPendingAt < lookbackStart ? oldestPendingAt : lookbackStart)
    : (lookbackStart ?? oldestPendingAt);
  const rescanCapStart = startOfBusinessDay(
    new Date(Date.now() - app.config.transactionRescanCapDays * DAY_MS),
    UTC_TIME_ZONE,
  );
  let state = existingState;
  if (!state) {
    const start = input.rescanStart ?? (
      earliestRescanStart && earliestRescanStart < rescanCapStart
        ? rescanCapStart
        : (earliestRescanStart ?? rescanCapStart)
    );
    const end = new Date();

    if (start >= end) {
      throw new Error(`OnlyFans transaction rescan start must be before ${end.toISOString()}`);
    }

    if (input.rescanStart) {
      await input.telemetry.addNote("Manual rescan override was applied", {
        start: input.rescanStart.toISOString(),
      });
    }

    state = buildOnlyFansIncrementalResumeState({
      phase: "transactions",
      start,
      end,
      cursor: null,
      newestSeenAt: checkpoint?.cursorTimestamp ?? null,
      oldestSeenAt: null,
      dirtyFrom: null,
      processedTransactions: 0,
      processedChargebacks: 0,
      transactionPages: 0,
      chargebackPages: 0,
      olderThanBoundaryItems: 0,
      olderThanBoundaryPages: 0,
      scanToken: randomUUID(),
    });
  } else {
    const normalized = normalizeOnlyFansIncrementalResumeState(state);
    state = normalized.state;

    if (normalized.legacyKeepTransactionIds.length > 0 || !("scanToken" in existingState)) {
      await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
        if (normalized.legacyKeepTransactionIds.length > 0) {
          await markTransactionsScanToken(dbTx, {
            platformAccountId: input.platformAccountId,
            transactionIds: normalized.legacyKeepTransactionIds,
            scanToken: normalized.state.scanToken,
          });
        }

        await upsertCheckpointProgress(dbTx, {
          platformAccountId: input.platformAccountId,
          stream: "transactions",
          state: normalized.state,
        });
      });
    }
  }

  const start = new Date(state.start);
  const end = new Date(state.end);
  if (start >= end) {
    throw new Error(`OnlyFans transaction rescan start must be before ${end.toISOString()}`);
  }

  let newestSeenAt: Date | null = state.newestSeenAt
    ? new Date(state.newestSeenAt)
    : (checkpoint?.cursorTimestamp ?? null);
  let oldestSeenAt: Date | null = state.oldestSeenAt ? new Date(state.oldestSeenAt) : null;
  let olderThanBoundaryItems = state.olderThanBoundaryItems;
  let olderThanBoundaryPages = state.olderThanBoundaryPages;
  const seenUnknownRawTypes = new Set<string>();
  let cleanupApplied = false;
  let currentRunProcessedTransactions = 0;
  let currentRunProcessedChargebacks = 0;

  await input.telemetry.addNote(
    existingState
      ? "Resuming incomplete OnlyFans incremental transaction rescan"
      : "Starting OnlyFans incremental transaction rescan",
    {
      phase: state.phase,
      start: state.start,
      end: state.end,
      cursor: state.cursor,
      processedTransactions: state.processedTransactions,
      processedChargebacks: state.processedChargebacks,
      transactionPages: state.transactionPages,
      chargebackPages: state.chargebackPages,
      scanToken: state.scanToken,
    },
  );

  input.telemetry.setBoundarySummary({
    kind: "start",
    requestedLowerBound: start.toISOString(),
    end: end.toISOString(),
    lookbackStart: lookbackStart?.toISOString() ?? null,
    oldestPendingAt: oldestPendingAt?.toISOString() ?? null,
    rescanCapStart: rescanCapStart.toISOString(),
    olderThanBoundaryItems,
    olderThanBoundaryPages,
  });
  input.telemetry.setScanSummary({
    transactionPages: state.transactionPages,
    chargebackPages: state.chargebackPages,
    processedTransactions: state.processedTransactions,
    processedChargebacks: state.processedChargebacks,
    oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
    newestSeenAt: newestSeenAt?.toISOString() ?? null,
    deleteWindowApplied: cleanupApplied,
    mode: "incremental",
  });

  try {
    while (state.phase === "transactions") {
      await assertOwnedPageSyncLease(app.db);
      const transactionCursor = state.cursor;
      const page = await app.onlyFansAdapter.getTransactionsPage(
        input.requestContext,
        input.platformAccountIdValue,
        {
          start,
          end,
          cursor: transactionCursor,
          limit: 100,
          pageIndex: state.transactionPages,
        },
      );

      await persistRawPayload(app.db, {
        platformAccountId: input.platformAccountId,
        syncRunId: input.syncRunId,
        endpoint: "onlymonster_transactions",
        requestParams: {
          start: start.toISOString(),
          end: end.toISOString(),
          cursor: transactionCursor,
          limit: 100,
        },
        responsePayload: page.raw,
        mapperVersion: ONLYMONSTER_MAPPER_VERSION,
        payloadKind: "mapping_critical",
        retainUntil: retentionDate(),
      }, {
        action: "inserting onlymonster_transactions raw payload",
      });

      const pageOldestSeenAt = page.parsed.items.reduce<Date | null>(
        (oldest, item) => minDate(oldest, new Date(item.timestamp)),
        null,
      );
      const pageNewestSeenAt = page.parsed.items.reduce<Date | null>(
        (latest, item) => maxDate(latest, new Date(item.timestamp)),
        null,
      );
      oldestSeenAt = minDate(oldestSeenAt, pageOldestSeenAt);
      newestSeenAt = maxDate(newestSeenAt, pageNewestSeenAt);

      const olderItemsInPage = page.parsed.items.filter(
        (item) => new Date(item.timestamp).getTime() < start.getTime(),
      ).length;
      olderThanBoundaryItems += olderItemsInPage;
      if (olderItemsInPage > 0 && olderItemsInPage === page.parsed.items.length) {
        olderThanBoundaryPages += 1;
      }

      const nextState = buildOnlyFansIncrementalResumeState({
        phase: page.parsed.cursor ? "transactions" : "chargebacks",
        start,
        end,
        cursor: page.parsed.cursor ?? null,
        newestSeenAt,
        oldestSeenAt,
        dirtyFrom: minDate(state.dirtyFrom ? new Date(state.dirtyFrom) : null, pageOldestSeenAt),
        processedTransactions: state.processedTransactions + page.parsed.items.length,
        processedChargebacks: state.processedChargebacks,
        transactionPages: state.transactionPages + 1,
        chargebackPages: state.chargebackPages,
        olderThanBoundaryItems,
        olderThanBoundaryPages,
        scanToken: state.scanToken,
      });

      for (const item of page.parsed.items) {
        await recordUnknownOnlyFansTransactionType(app, input, item.type, seenUnknownRawTypes);
      }

      await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
        await upsertOnlyFansIncrementalTransactionsPage(dbTx, {
          platformAccountId: input.platformAccountId,
          commissionRate: input.commissionRate,
          scanToken: state.scanToken,
        }, page.parsed.items);
        await upsertCheckpointProgress(dbTx, {
          platformAccountId: input.platformAccountId,
          stream: "transactions",
          state: nextState,
        });
      });

      state = nextState;
      currentRunProcessedTransactions += page.parsed.items.length;

      if (input.budget.shouldYield()) {
        state = await flushAndClearOnlyFansIncrementalDirtyRange(
          app,
          input.platformAccountId,
          state,
        );
        input.telemetry.setScanSummary({
          transactionPages: state.transactionPages,
          chargebackPages: state.chargebackPages,
          processedTransactions: state.processedTransactions,
          processedChargebacks: state.processedChargebacks,
          oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
          newestSeenAt: newestSeenAt?.toISOString() ?? null,
          deleteWindowApplied: false,
          mode: "incremental",
        });
        return {
          satisfied: false,
          yieldReason: input.budget.resolveYieldReason(),
          processed: currentRunProcessedTransactions + currentRunProcessedChargebacks,
          processedTransactions: currentRunProcessedTransactions,
          processedChargebacks: currentRunProcessedChargebacks,
          newestSeenAt: newestSeenAt ?? end,
        };
      }
    }

    while (true) {
      await assertOwnedPageSyncLease(app.db);
      const chargebackCursor = state.cursor;
      const page = await app.onlyFansAdapter.getChargebacksPage(
        input.requestContext,
        input.platformAccountIdValue,
        {
          start,
          end,
          cursor: chargebackCursor,
          limit: 100,
          pageIndex: state.chargebackPages,
        },
      );

      await persistRawPayload(app.db, {
        platformAccountId: input.platformAccountId,
        syncRunId: input.syncRunId,
        endpoint: "onlymonster_chargebacks",
        requestParams: {
          start: start.toISOString(),
          end: end.toISOString(),
          cursor: chargebackCursor,
          limit: 100,
        },
        responsePayload: page.raw,
        mapperVersion: ONLYMONSTER_MAPPER_VERSION,
        payloadKind: "mapping_critical",
        retainUntil: retentionDate(),
      }, {
        action: "inserting onlymonster_chargebacks raw payload",
      });

      const pageOldestSeenAt = page.parsed.items.reduce<Date | null>(
        (oldest, item) => minDate(oldest, new Date(item.chargeback_timestamp)),
        null,
      );
      const pageNewestSeenAt = page.parsed.items.reduce<Date | null>(
        (latest, item) => maxDate(latest, new Date(item.chargeback_timestamp)),
        null,
      );
      oldestSeenAt = minDate(oldestSeenAt, pageOldestSeenAt);
      newestSeenAt = maxDate(newestSeenAt, pageNewestSeenAt);

      const olderItemsInPage = page.parsed.items.filter(
        (item) => new Date(item.chargeback_timestamp).getTime() < start.getTime(),
      ).length;
      olderThanBoundaryItems += olderItemsInPage;
      if (olderItemsInPage > 0 && olderItemsInPage === page.parsed.items.length) {
        olderThanBoundaryPages += 1;
      }

      const nextState = buildOnlyFansIncrementalResumeState({
        phase: "chargebacks",
        start,
        end,
        cursor: page.parsed.cursor ?? null,
        newestSeenAt,
        oldestSeenAt,
        dirtyFrom: minDate(state.dirtyFrom ? new Date(state.dirtyFrom) : null, pageOldestSeenAt),
        processedTransactions: state.processedTransactions,
        processedChargebacks: state.processedChargebacks + page.parsed.items.length,
        transactionPages: state.transactionPages,
        chargebackPages: state.chargebackPages + 1,
        olderThanBoundaryItems,
        olderThanBoundaryPages,
        scanToken: state.scanToken,
      });

      await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
        await upsertOnlyFansIncrementalChargebacksPage(dbTx, {
          platformAccountId: input.platformAccountId,
          commissionRate: input.commissionRate,
          scanToken: state.scanToken,
        }, page.parsed.items);
        await upsertCheckpointProgress(dbTx, {
          platformAccountId: input.platformAccountId,
          stream: "transactions",
          state: nextState,
        });
      });

      state = nextState;
      currentRunProcessedChargebacks += page.parsed.items.length;

      if (!page.parsed.cursor) {
        break;
      }

      if (input.budget.shouldYield()) {
        state = await flushAndClearOnlyFansIncrementalDirtyRange(
          app,
          input.platformAccountId,
          state,
        );
        input.telemetry.setScanSummary({
          transactionPages: state.transactionPages,
          chargebackPages: state.chargebackPages,
          processedTransactions: state.processedTransactions,
          processedChargebacks: state.processedChargebacks,
          oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
          newestSeenAt: newestSeenAt?.toISOString() ?? null,
          deleteWindowApplied: false,
          mode: "incremental",
        });
        return {
          satisfied: false,
          yieldReason: input.budget.resolveYieldReason(),
          processed: currentRunProcessedTransactions + currentRunProcessedChargebacks,
          processedTransactions: currentRunProcessedTransactions,
          processedChargebacks: currentRunProcessedChargebacks,
          newestSeenAt: newestSeenAt ?? end,
        };
      }
    }
  } catch (error) {
    state = await flushAndClearOnlyFansIncrementalDirtyRange(
      app,
      input.platformAccountId,
      state,
    );
    throw error;
  }

  let checkpointAfter = null;
  await withOwnedPageSyncTransaction(app.db, async (tx) => {
    cleanupApplied = true;
    await retireTransactionsMissingFromWindow(tx, {
      platformAccountId: input.platformAccountId,
      from: start,
      to: end,
      cleanupMode: "scan_token",
      scanToken: state.scanToken,
    });
    await rebuildSpenderProjections(tx, input.platformAccountId, start);
    await rebuildRevenueRollups(tx, input.platformAccountId, start);

    if (newestSeenAt) {
      checkpointAfter = await upsertCheckpoint(tx, {
        platformAccountId: input.platformAccountId,
        stream: "transactions",
        cursorTimestamp: newestSeenAt,
        state: {
          pageLabel: input.pageLabel,
          processedTransactions: state.processedTransactions,
          processedChargebacks: state.processedChargebacks,
        },
        lastSuccessfulRunId: input.syncRunId,
      });
    }
  });

  await input.telemetry.recordCheckpointAdvanced("transactions", summarizeCheckpoint(checkpointAfter));
  input.telemetry.setBoundarySummary({
    kind: "start",
    requestedLowerBound: start.toISOString(),
    end: end.toISOString(),
    lookbackStart: lookbackStart?.toISOString() ?? null,
    oldestPendingAt: oldestPendingAt?.toISOString() ?? null,
    rescanCapStart: rescanCapStart.toISOString(),
    olderThanBoundaryItems,
    olderThanBoundaryPages,
  });
  input.telemetry.setScanSummary({
    transactionPages: state.transactionPages,
    chargebackPages: state.chargebackPages,
    processedTransactions: state.processedTransactions,
    processedChargebacks: state.processedChargebacks,
    oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
    newestSeenAt: newestSeenAt?.toISOString() ?? null,
    deleteWindowApplied: cleanupApplied,
    mode: "incremental",
  });
  if (cleanupApplied) {
    await input.telemetry.addNote("Delete-missing-in-window cleanup was applied to the OnlyFans transaction scan", {
      from: start.toISOString(),
      to: end.toISOString(),
      scanToken: state.scanToken,
    });
  }

  if (oldestPendingAt && oldestPendingAt < rescanCapStart) {
    await input.telemetry.addAnomaly({
      code: "rescan_cap_clamped",
      severity: "warn",
      message: "OnlyFans scan window was clamped by the configured rescan cap",
      details: {
        oldestPendingAt: oldestPendingAt.toISOString(),
        rescanCapStart: rescanCapStart.toISOString(),
      },
    });
  }

  if (lookbackStart && start.getTime() < lookbackStart.getTime() - DAY_MS) {
    await input.telemetry.addAnomaly({
      code: "wide_rescan",
      severity: "warn",
      message: "OnlyFans scan expanded materially beyond the normal incremental lookback window",
      details: {
        start: start.toISOString(),
        lookbackStart: lookbackStart.toISOString(),
      },
    });
  }

  if (
    checkpoint?.cursorTimestamp &&
    newestSeenAt &&
    newestSeenAt.getTime() <= checkpoint.cursorTimestamp.getTime() &&
    (state.processedTransactions + state.processedChargebacks) > 0
  ) {
    await input.telemetry.addAnomaly({
      code: "checkpoint_stalled",
      severity: "error",
      message: "OnlyFans transaction checkpoint did not advance despite scanning source data",
      details: {
        checkpointTimestamp: checkpoint.cursorTimestamp.toISOString(),
        newestSeenAt: newestSeenAt.toISOString(),
      },
    });
  }

  if (
    olderThanBoundaryPages > 1 ||
    (
      olderThanBoundaryItems > 100 &&
      checkpoint?.cursorTimestamp &&
      newestSeenAt &&
      newestSeenAt.getTime() <= checkpoint.cursorTimestamp.getTime()
    )
  ) {
    await input.telemetry.addAnomaly({
      code: "after_ineffective",
      severity: "error",
      message: "The OnlyFans lower-bound filter behaved ineffectively and scanned materially old data",
      details: {
        start: start.toISOString(),
        olderThanBoundaryItems,
        olderThanBoundaryPages,
        oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
      },
    });
  }

  return {
    satisfied: true,
    yieldReason: null,
    processed: currentRunProcessedTransactions + currentRunProcessedChargebacks,
    processedTransactions: currentRunProcessedTransactions,
    processedChargebacks: currentRunProcessedChargebacks,
    newestSeenAt: newestSeenAt ?? end,
  };
}

async function fetchOnlyFansBackfillTransactionsPage(
  app: AppContext,
  input: {
    platformAccountIdValue: string;
    requestContext: Parameters<AppContext["onlyFansAdapter"]["getTransactionsPage"]>[0];
    pageMetadata: Record<string, unknown>;
    telemetry: SyncRunTelemetry;
  },
  state: OnlyFansTransactionBackfillState,
  pageIndex: number,
) {
  const windowEnd = new Date(state.windowEnd);

  try {
    return {
      page: await app.onlyFansAdapter.getTransactionsPage(
        input.requestContext,
        input.platformAccountIdValue,
        {
          start: new Date(state.start),
          end: windowEnd,
          cursor: state.cursor,
          limit: 100,
          pageIndex,
        },
      ),
      state,
    };
  } catch (error) {
    if (
      state.transactionPages === 0 &&
      state.chargebackPages === 0 &&
      isOnlyFansBackfillRangeError(error)
    ) {
      const resolvedLowerBound = resolveOnlyFansBackfillLowerBound(input.pageMetadata);
      const fallbackStart = maxLowerBound(
        resolvedLowerBound.date,
        getOnlyFansSyntheticLowerBound(),
      );
      const syntheticWindow = buildOnlyFansSyntheticWindow(new Date(state.snapshotEnd));
      const nextState: OnlyFansTransactionBackfillState = {
        ...state,
        start: resolvedLowerBound.source === "synthetic"
          ? syntheticWindow.start.toISOString()
          : fallbackStart.toISOString(),
        fallbackStartUsed: resolvedLowerBound.source === "synthetic",
        windowEnd: resolvedLowerBound.source === "synthetic"
          ? syntheticWindow.end.toISOString()
          : state.windowEnd,
      };
      await input.telemetry.addNote("OnlyFans full-history backfill start was clamped after provider rejection", {
        rejectedStart: state.start,
        fallbackStart: nextState.start,
      });
      return {
        page: await app.onlyFansAdapter.getTransactionsPage(
          input.requestContext,
          input.platformAccountIdValue,
          {
            start: new Date(nextState.start),
            end: new Date(nextState.windowEnd),
            cursor: null,
            limit: 100,
            pageIndex,
          },
        ),
        state: nextState,
      };
    }

    throw error;
  }
}

async function syncOnlyFansTransactionsBackfill(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    platformAccountIdValue: string;
    pageMetadata: Record<string, unknown>;
    commissionRate: number;
    rescanStart?: Date | null;
    requestContext: Parameters<AppContext["onlyFansAdapter"]["getTransactionsPage"]>[0];
    syncRunId: number;
    telemetry: SyncRunTelemetry;
    budget: SyncChunkBudget;
  },
  existingState: OnlyFansTransactionBackfillState | null,
): Promise<OnlyFansTransactionSyncResult> {
  if (existingState && input.rescanStart) {
    throw new Error("Manual OnlyFans transaction rescans are not allowed while an incomplete backfill exists");
  }

  const initialSnapshotEnd = new Date().toISOString();
  const initialLowerBound = resolveOnlyFansBackfillLowerBound(input.pageMetadata);
  const initialTrustedLowerBound = maxLowerBound(
    initialLowerBound.date,
    getOnlyFansSyntheticLowerBound(),
  );
  const initialSyntheticWindow = buildOnlyFansSyntheticWindow(new Date(initialSnapshotEnd));
  let state: OnlyFansTransactionBackfillState = existingState ?? {
    mode: "backfill",
    completed: false,
    provider: "onlyfans",
    phase: "transactions",
    snapshotEnd: initialSnapshotEnd,
    oldestSeenAt: null,
    newestSeenAt: null,
    dirtyFrom: null,
    processedTransactions: 0,
    processedChargebacks: 0,
    transactionPages: 0,
    chargebackPages: 0,
    start: initialLowerBound.source === "synthetic"
      ? initialSyntheticWindow.start.toISOString()
      : initialTrustedLowerBound.toISOString(),
    fallbackStartUsed: initialLowerBound.source === "synthetic",
    cursor: null,
    windowEnd: initialLowerBound.source === "synthetic"
      ? initialSyntheticWindow.end.toISOString()
      : initialSnapshotEnd,
    windowPageCount: 0,
    emptyWindowCount: 0,
  };

  if (state.fallbackStartUsed) {
    const floor = getOnlyFansSyntheticLowerBound();
    const clampedStart = maxLowerBound(new Date(state.start), floor);
    if (clampedStart.getTime() !== new Date(state.start).getTime()) {
      state = {
        ...state,
        start: clampedStart.toISOString(),
      };
    }
  }

  const snapshotEnd = new Date(state.snapshotEnd);
  const transactionWindowPageLimit = getOnlyFansBackfillWindowPageLimit(input.budget);
  const requestedLowerBound = state.fallbackStartUsed
    ? getOnlyFansSyntheticLowerBound().toISOString()
    : state.start;
  let oldestSeenAt = state.oldestSeenAt ? new Date(state.oldestSeenAt) : null;
  let newestSeenAt = state.newestSeenAt ? new Date(state.newestSeenAt) : null;
  let currentRunProcessedTransactions = 0;
  let currentRunProcessedChargebacks = 0;
  const seenUnknownRawTypes = new Set<string>();
  let persistedState = buildOnlyFansPersistedResumeState(state, {});

  await input.telemetry.addNote(
    existingState
      ? "Resuming incomplete OnlyFans transaction backfill"
      : "Starting OnlyFans full-history transaction backfill",
    {
      snapshotEnd: state.snapshotEnd,
      start: requestedLowerBound,
      windowStart: state.start,
      windowEnd: state.windowEnd,
      windowPageCount: state.windowPageCount,
      emptyWindowCount: state.emptyWindowCount,
      phase: state.phase,
      oldestSeenAt: state.oldestSeenAt,
      processedTransactions: state.processedTransactions,
      processedChargebacks: state.processedChargebacks,
    },
  );

  input.telemetry.setBoundarySummary({
    kind: "backfill",
    requestedLowerBound,
    end: state.snapshotEnd,
    windowStart: state.start,
    windowEnd: state.windowEnd,
    phase: state.phase,
    fallbackStartUsed: state.fallbackStartUsed,
    windowPageLimit: transactionWindowPageLimit,
  });
  input.telemetry.setScanSummary({
    mode: "backfill",
    phase: state.phase,
    transactionPages: state.transactionPages,
    chargebackPages: state.chargebackPages,
    processedTransactions: state.processedTransactions,
    processedChargebacks: state.processedChargebacks,
    processedTransactionsThisRun: currentRunProcessedTransactions,
    processedChargebacksThisRun: currentRunProcessedChargebacks,
    oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
    newestSeenAt: newestSeenAt?.toISOString() ?? null,
    windowStart: state.start,
    windowEnd: state.windowEnd,
    windowPageCount: state.windowPageCount,
    windowPageLimit: transactionWindowPageLimit,
    emptyWindowCount: state.emptyWindowCount,
    fallbackStartUsed: state.fallbackStartUsed,
  });

  try {
    while (true) {
      await assertOwnedPageSyncLease(app.db);
      if (state.phase === "transactions") {
        const pageResult = await fetchOnlyFansBackfillTransactionsPage(
          app,
          {
            platformAccountIdValue: input.platformAccountIdValue,
            requestContext: input.requestContext,
            pageMetadata: input.pageMetadata,
            telemetry: input.telemetry,
          },
          state,
          state.transactionPages,
        );
        state = pageResult.state;
        const page = pageResult.page;
        const requestWindowEnd = state.windowEnd;
        const requestCursor = state.cursor;

        await persistRawPayload(app.db, {
          platformAccountId: input.platformAccountId,
          syncRunId: input.syncRunId,
          endpoint: "onlymonster_transactions",
          requestParams: {
            start: state.start,
            end: requestWindowEnd,
            cursor: requestCursor,
            limit: 100,
          },
          responsePayload: page.raw,
          mapperVersion: ONLYMONSTER_MAPPER_VERSION,
          payloadKind: "mapping_critical",
          retainUntil: retentionDate(),
        }, {
          action: "inserting onlymonster_transactions raw payload",
        });

        const pageOldestSeenAt = page.parsed.items.reduce<Date | null>(
          (oldest, item) => minDate(oldest, new Date(item.timestamp)),
          null,
        );
        const pageNewestSeenAt = page.parsed.items.reduce<Date | null>(
          (latest, item) => maxDate(latest, new Date(item.timestamp)),
          null,
        );
        oldestSeenAt = minDate(oldestSeenAt, pageOldestSeenAt);
        newestSeenAt = maxDate(newestSeenAt, pageNewestSeenAt);

        const fanPlatformIds = Array.from(new Set(page.parsed.items.map((item) => item.fan.id)));
        const nextCursor = page.parsed.cursor ?? null;
        if (nextCursor && !pageOldestSeenAt) {
          throw new Error("OnlyFans transaction backfill cannot resume cursorlessly without page items");
        }
        const nextWindowPageCount = state.windowPageCount + 1;
        const shouldRollWindow = Boolean(nextCursor) &&
          nextWindowPageCount >= transactionWindowPageLimit;
        const nextDirtyFrom = minDate(
          state.dirtyFrom ? new Date(state.dirtyFrom) : null,
          pageOldestSeenAt,
        );
        const nextHistoricalWindow = nextCursor
          ? null
          : buildNextOnlyFansHistoricalWindow(state, pageOldestSeenAt);
        const nextEmptyWindowCount = page.parsed.items.length === 0
          ? state.emptyWindowCount + 1
          : 0;
        const shouldContinueHistoricalTransactions = Boolean(nextHistoricalWindow) &&
          nextEmptyWindowCount < ONLYFANS_EMPTY_WINDOW_LIMIT;
        const nextChargebackWindow = usesSyntheticOnlyFansBackfillBound(state)
          ? buildOnlyFansSyntheticWindow(snapshotEnd)
          : {
            start: new Date(state.start),
            end: snapshotEnd,
          };
        const nextState: OnlyFansTransactionBackfillState = {
          ...state,
          phase: nextCursor || shouldContinueHistoricalTransactions ? "transactions" : "chargebacks",
          cursor: nextCursor
            ? (shouldRollWindow ? null : nextCursor)
            : null,
          transactionPages: state.transactionPages + 1,
          processedTransactions: state.processedTransactions + page.parsed.items.length,
          oldestSeenAt: isoDateOrNull(oldestSeenAt),
          newestSeenAt: isoDateOrNull(newestSeenAt),
          dirtyFrom: isoDateOrNull(nextDirtyFrom),
          start: nextCursor
            ? state.start
            : shouldContinueHistoricalTransactions
              ? nextHistoricalWindow!.start.toISOString()
              : nextChargebackWindow.start.toISOString(),
          windowEnd: nextCursor
            ? (shouldRollWindow ? pageOldestSeenAt!.toISOString() : state.windowEnd)
            : shouldContinueHistoricalTransactions
              ? nextHistoricalWindow!.end.toISOString()
              : nextChargebackWindow.end.toISOString(),
          windowPageCount: nextCursor
            ? (shouldRollWindow ? 0 : nextWindowPageCount)
            : 0,
          emptyWindowCount: nextCursor
            ? state.emptyWindowCount
            : shouldContinueHistoricalTransactions
              ? nextEmptyWindowCount
              : 0,
        };
        const persistedNextState = buildOnlyFansPersistedResumeState(nextState, {
          phase: nextState.phase,
          start: nextState.start,
          windowEnd: nextCursor
            ? pageOldestSeenAt!
            : nextState.windowEnd,
          oldestSeenAt,
          dirtyFrom: nextDirtyFrom,
          newestSeenAt,
          emptyWindowCount: nextState.emptyWindowCount,
        });

        for (const item of page.parsed.items) {
          await recordUnknownOnlyFansTransactionType(app, input, item.type, seenUnknownRawTypes);
        }

        await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
          const fans = await upsertFans(dbTx, buildOnlyFansFanInputs(fanPlatformIds));
          const fanMap = new Map(fans.map((fan) => [fan.platformUserId, fan.id]));
          await upsertFanPages(dbTx, fans.map((fan) => ({
            fanId: fan.id,
            platformAccountId: input.platformAccountId,
          })));

          for (const item of page.parsed.items) {
            const grossAmountMills = dollarsToMills(item.amount);
            const creatorNetAmountMills = calculateNetMillsFromGross(
              grossAmountMills,
              input.commissionRate,
            );

            await upsertTransaction(dbTx, {
              platformAccountId: input.platformAccountId,
              fanId: fanMap.get(item.fan.id) ?? null,
              transactionId: item.id,
              correlationAccountId: item.fan.id,
              rawType: item.type,
              canonicalType: mapOnlyMonsterTransactionType(item.type),
              transactionState: mapOnlyMonsterTransactionState(item.status),
              rawStatus: item.status,
              grossAmountMills,
              sourceDestinationAmountMills: grossAmountMills,
              creatorNetAmountMills,
              occurredAt: new Date(item.timestamp),
            });
          }

          await upsertCheckpointProgress(dbTx, {
            platformAccountId: input.platformAccountId,
            stream: "transactions",
            state: persistedNextState,
          });
        });

        state = nextState;
        persistedState = persistedNextState;
        currentRunProcessedTransactions += page.parsed.items.length;

        const progressMessage = buildBackfillProgressMessage({
          provider: "onlyfans",
          phase: "transactions",
          page: state.transactionPages,
          processedTransactions: state.processedTransactions,
          processedChargebacks: state.processedChargebacks,
          oldestSeenAt,
          newestSeenAt,
        });
        await input.telemetry.addNote(progressMessage, {
          phase: "transactions",
          page: state.transactionPages,
          processedTransactions: state.processedTransactions,
          processedChargebacks: state.processedChargebacks,
          windowStart: state.start,
          windowEnd: state.windowEnd,
          emptyWindowCount: state.emptyWindowCount,
          oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
          newestSeenAt: newestSeenAt?.toISOString() ?? null,
        });
        app.logger.info({
          pageLabel: input.pageLabel,
          platformAccountId: input.platformAccountId,
          provider: "onlyfans",
          stream: "transactions",
          phase: "transactions",
          page: state.transactionPages,
          processedTransactions: state.processedTransactions,
          processedChargebacks: state.processedChargebacks,
          windowStart: state.start,
          windowEnd: state.windowEnd,
          emptyWindowCount: state.emptyWindowCount,
          oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
          newestSeenAt: newestSeenAt?.toISOString() ?? null,
          fallbackStartUsed: state.fallbackStartUsed,
        }, progressMessage);
        input.telemetry.setScanSummary({
          mode: "backfill",
          phase: state.phase,
          transactionPages: state.transactionPages,
          chargebackPages: state.chargebackPages,
          processedTransactions: state.processedTransactions,
          processedChargebacks: state.processedChargebacks,
          processedTransactionsThisRun: currentRunProcessedTransactions,
          processedChargebacksThisRun: currentRunProcessedChargebacks,
          oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
          newestSeenAt: newestSeenAt?.toISOString() ?? null,
          windowStart: state.start,
          windowEnd: state.windowEnd,
          windowPageCount: state.windowPageCount,
          windowPageLimit: transactionWindowPageLimit,
          emptyWindowCount: state.emptyWindowCount,
          fallbackStartUsed: state.fallbackStartUsed,
        });

        if (input.budget.shouldYield()) {
          persistedState = await flushAndClearOnlyFansDirtyRange(
            app,
            input.platformAccountId,
            persistedState,
          );
          return {
            satisfied: false,
            yieldReason: input.budget.resolveYieldReason(),
            processed: currentRunProcessedTransactions + currentRunProcessedChargebacks,
            processedTransactions: currentRunProcessedTransactions,
            processedChargebacks: currentRunProcessedChargebacks,
            newestSeenAt: newestSeenAt ?? snapshotEnd,
          };
        }

        continue;
      }

      const page = await app.onlyFansAdapter.getChargebacksPage(
        input.requestContext,
        input.platformAccountIdValue,
        {
          start: new Date(state.start),
          end: new Date(state.windowEnd),
          cursor: state.cursor,
          limit: 100,
          pageIndex: state.chargebackPages,
        },
      );

      await persistRawPayload(app.db, {
        platformAccountId: input.platformAccountId,
        syncRunId: input.syncRunId,
        endpoint: "onlymonster_chargebacks",
        requestParams: {
          start: state.start,
          end: state.windowEnd,
          cursor: state.cursor,
          limit: 100,
        },
        responsePayload: page.raw,
        mapperVersion: ONLYMONSTER_MAPPER_VERSION,
        payloadKind: "mapping_critical",
        retainUntil: retentionDate(),
      }, {
        action: "inserting onlymonster_chargebacks raw payload",
      });

      const pageOldestSeenAt = page.parsed.items.reduce<Date | null>(
        (oldest, item) => minDate(oldest, new Date(item.chargeback_timestamp)),
        null,
      );
      const pageNewestSeenAt = page.parsed.items.reduce<Date | null>(
        (latest, item) => maxDate(latest, new Date(item.chargeback_timestamp)),
        null,
      );
      oldestSeenAt = minDate(oldestSeenAt, pageOldestSeenAt);
      newestSeenAt = maxDate(newestSeenAt, pageNewestSeenAt);

      const fanPlatformIds = Array.from(new Set(page.parsed.items.map((item) => item.fan.id)));
      const nextCursor = page.parsed.cursor ?? null;
      if (nextCursor && !pageOldestSeenAt) {
        throw new Error("OnlyFans chargeback backfill cannot resume cursorlessly without page items");
      }
      const nextDirtyFrom = minDate(
        state.dirtyFrom ? new Date(state.dirtyFrom) : null,
        pageOldestSeenAt,
      );
      const nextHistoricalWindow = nextCursor
        ? null
        : buildNextOnlyFansHistoricalWindow(state, pageOldestSeenAt);
      const nextEmptyWindowCount = page.parsed.items.length === 0
        ? state.emptyWindowCount + 1
        : 0;
      const shouldContinueHistoricalChargebacks = Boolean(nextHistoricalWindow) &&
        nextEmptyWindowCount < ONLYFANS_EMPTY_WINDOW_LIMIT;
      const nextState: OnlyFansTransactionBackfillState = {
        ...state,
        cursor: nextCursor,
        chargebackPages: state.chargebackPages + 1,
        processedChargebacks: state.processedChargebacks + page.parsed.items.length,
        oldestSeenAt: isoDateOrNull(oldestSeenAt),
        newestSeenAt: isoDateOrNull(newestSeenAt),
        dirtyFrom: isoDateOrNull(nextDirtyFrom),
        start: shouldContinueHistoricalChargebacks
          ? nextHistoricalWindow!.start.toISOString()
          : state.start,
        windowEnd: shouldContinueHistoricalChargebacks
          ? nextHistoricalWindow!.end.toISOString()
          : state.windowEnd,
        windowPageCount: 0,
        emptyWindowCount: nextCursor
          ? state.emptyWindowCount
          : shouldContinueHistoricalChargebacks
            ? nextEmptyWindowCount
            : 0,
      };
      const persistedNextState = buildOnlyFansPersistedResumeState(nextState, {
        phase: "chargebacks",
        start: nextState.start,
        windowEnd: nextCursor
          ? pageOldestSeenAt!
          : nextState.windowEnd,
        oldestSeenAt,
        dirtyFrom: nextDirtyFrom,
        newestSeenAt,
        emptyWindowCount: nextState.emptyWindowCount,
      });

      await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
        const fans = await upsertFans(dbTx, buildOnlyFansFanInputs(fanPlatformIds));
        const fanMap = new Map(fans.map((fan) => [fan.platformUserId, fan.id]));
        await upsertFanPages(dbTx, fans.map((fan) => ({
          fanId: fan.id,
          platformAccountId: input.platformAccountId,
        })));

        for (const item of page.parsed.items) {
          const grossAmountMills = -dollarsToMills(item.amount);
          const creatorNetAmountMills = calculateNetMillsFromGross(
            grossAmountMills,
            input.commissionRate,
          );

          await upsertTransaction(dbTx, {
            platformAccountId: input.platformAccountId,
            fanId: fanMap.get(item.fan.id) ?? null,
            transactionId: item.id,
            correlationAccountId: item.fan.id,
            rawType: item.type,
            canonicalType: "chargeback",
            transactionState: mapOnlyMonsterTransactionState(item.status),
            rawStatus: item.status,
            grossAmountMills,
            sourceDestinationAmountMills: grossAmountMills,
            creatorNetAmountMills,
            occurredAt: new Date(item.chargeback_timestamp),
            sourceUpdatedAt: new Date(item.transaction_timestamp),
          });
        }

        await upsertCheckpointProgress(dbTx, {
          platformAccountId: input.platformAccountId,
          stream: "transactions",
          state: persistedNextState,
        });
      });

      state = nextState;
      persistedState = persistedNextState;
      currentRunProcessedChargebacks += page.parsed.items.length;

      const progressMessage = buildBackfillProgressMessage({
        provider: "onlyfans",
        phase: "chargebacks",
        page: state.chargebackPages,
        processedTransactions: state.processedTransactions,
        processedChargebacks: state.processedChargebacks,
        oldestSeenAt,
        newestSeenAt,
      });
      await input.telemetry.addNote(progressMessage, {
        phase: "chargebacks",
        page: state.chargebackPages,
        processedTransactions: state.processedTransactions,
        processedChargebacks: state.processedChargebacks,
        windowStart: state.start,
        windowEnd: state.windowEnd,
        emptyWindowCount: state.emptyWindowCount,
        oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
        newestSeenAt: newestSeenAt?.toISOString() ?? null,
      });
      app.logger.info({
        pageLabel: input.pageLabel,
        platformAccountId: input.platformAccountId,
        provider: "onlyfans",
        stream: "transactions",
        phase: "chargebacks",
        page: state.chargebackPages,
        processedTransactions: state.processedTransactions,
        processedChargebacks: state.processedChargebacks,
        windowStart: state.start,
        windowEnd: state.windowEnd,
        emptyWindowCount: state.emptyWindowCount,
        oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
        newestSeenAt: newestSeenAt?.toISOString() ?? null,
        fallbackStartUsed: state.fallbackStartUsed,
      }, progressMessage);
      input.telemetry.setScanSummary({
        mode: "backfill",
        phase: "chargebacks",
        transactionPages: state.transactionPages,
        chargebackPages: state.chargebackPages,
        processedTransactions: state.processedTransactions,
        processedChargebacks: state.processedChargebacks,
        processedTransactionsThisRun: currentRunProcessedTransactions,
        processedChargebacksThisRun: currentRunProcessedChargebacks,
        oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
        newestSeenAt: newestSeenAt?.toISOString() ?? null,
        windowStart: state.start,
        windowEnd: state.windowEnd,
        windowPageCount: 0,
        windowPageLimit: transactionWindowPageLimit,
        emptyWindowCount: state.emptyWindowCount,
        fallbackStartUsed: state.fallbackStartUsed,
      });

      if (!page.parsed.cursor && !shouldContinueHistoricalChargebacks) {
        break;
      }

      if (input.budget.shouldYield()) {
        persistedState = await flushAndClearOnlyFansDirtyRange(
          app,
          input.platformAccountId,
          persistedState,
        );
        return {
          satisfied: false,
          yieldReason: input.budget.resolveYieldReason(),
          processed: currentRunProcessedTransactions + currentRunProcessedChargebacks,
          processedTransactions: currentRunProcessedTransactions,
          processedChargebacks: currentRunProcessedChargebacks,
          newestSeenAt: newestSeenAt ?? snapshotEnd,
        };
      }
    }
  } catch (error) {
    persistedState = await flushAndClearOnlyFansDirtyRange(
      app,
      input.platformAccountId,
      persistedState,
    );
    throw error;
  }

  await flushOnlyFansDirtyRange(
    app,
    input.platformAccountId,
    state.dirtyFrom ? new Date(state.dirtyFrom) : null,
  );

  if (oldestSeenAt) {
    await persistOnlyFansBackfillLowerBound(
      app,
      input.platformAccountId,
      bufferOnlyFansBackfillLowerBound(oldestSeenAt, app.config.transactionLookbackDays),
    );
  }

  const checkpointAfter = await upsertCheckpoint(app.db, {
    platformAccountId: input.platformAccountId,
    stream: "transactions",
    cursorTimestamp: newestSeenAt ?? snapshotEnd,
    state: {
      pageLabel: input.pageLabel,
      processedTransactions: state.processedTransactions,
      processedChargebacks: state.processedChargebacks,
    },
    lastSuccessfulRunId: input.syncRunId,
  });

  await input.telemetry.recordCheckpointAdvanced("transactions", summarizeCheckpoint(checkpointAfter));
  input.telemetry.setBoundarySummary({
    kind: "backfill",
    requestedLowerBound,
    end: state.snapshotEnd,
    phase: "complete",
    fallbackStartUsed: state.fallbackStartUsed,
  });
  input.telemetry.setScanSummary({
    mode: "backfill",
    phase: "complete",
    transactionPages: state.transactionPages,
    chargebackPages: state.chargebackPages,
    processedTransactions: state.processedTransactions,
    processedChargebacks: state.processedChargebacks,
    processedTransactionsThisRun: currentRunProcessedTransactions,
    processedChargebacksThisRun: currentRunProcessedChargebacks,
    oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
    newestSeenAt: newestSeenAt?.toISOString() ?? null,
    windowStart: null,
    windowEnd: null,
    windowPageCount: 0,
    windowPageLimit: transactionWindowPageLimit,
    emptyWindowCount: 0,
    fallbackStartUsed: state.fallbackStartUsed,
  });

  return {
    satisfied: true,
    yieldReason: null,
    processed: currentRunProcessedTransactions + currentRunProcessedChargebacks,
    processedTransactions: currentRunProcessedTransactions,
    processedChargebacks: currentRunProcessedChargebacks,
    newestSeenAt: newestSeenAt ?? snapshotEnd,
  };
}

export async function syncOnlyFansTransactions(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    platformAccountIdValue: string;
    pageMetadata: Record<string, unknown>;
    commissionRate: number;
    rescanStart?: Date | null;
    requestContext: Parameters<AppContext["onlyFansAdapter"]["getTransactionsPage"]>[0];
    syncRunId: number;
    telemetry: SyncRunTelemetry;
    budget: SyncChunkBudget;
  },
): Promise<OnlyFansTransactionSyncResult> {
  const checkpoint = await getCheckpoint(app.db, input.platformAccountId, "transactions");
  await input.telemetry.recordCheckpointLoaded("transactions", summarizeCheckpoint(checkpoint));

  const rawBackfillState = checkpoint?.state;
  const backfillState = parseTransactionBackfillState(checkpoint?.state);
  if (backfillState?.provider === "onlyfans") {
    return syncOnlyFansTransactionsBackfill(
      app,
      input,
      upgradeOnlyFansBackfillState(backfillState, rawBackfillState),
    );
  }

  const incrementalState = parseOnlyFansIncrementalResumeState(checkpoint?.state);
  if (incrementalState) {
    return syncOnlyFansTransactionsIncremental(app, input, checkpoint, incrementalState);
  }

  if (checkpoint?.cursorTimestamp) {
    return syncOnlyFansTransactionsIncremental(app, input, checkpoint, null);
  }

  return syncOnlyFansTransactionsBackfill(app, input, null);
}
