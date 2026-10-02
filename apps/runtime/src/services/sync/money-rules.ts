import type { UpsertTransactionInput } from "@agency_hub_core/db";
import {
  mapFanslyTransactionState,
  mapFanslyTransactionType,
  type FanslyEarningsTransaction,
} from "@agency_hub_core/fansly";
import { calculateGrossMillsFromNet, millsFromInteger } from "@agency_hub_core/shared";

import type { TopSpendersCursorState, TopSpendersCursorWindow } from "./cursor-state.ts";

// The money rules both Fansly engines apply (transactions, top spenders): the
// legacy chunk handlers (transactions.ts, executor-handlers.ts) and the Sync
// Engine's resources (sync/fansly/resources/transactions.ts, top-spenders.ts).
// Pure; moved here from those files unchanged, so the two engines cannot drift
// while both run (step 2 shadow, step 3 per page).

// ── transactions ────────────────────────────────────────────────────────────

/**
 * The commission a Fansly transaction states (`destinationTax`, basis points
 * of 10 000), or the page's configured rate when the provider omitted it or
 * stated something out of range.
 */
export function resolveFanslyCommissionRate(
  destinationTax: number | null,
  fallbackCommissionRate: number,
) {
  if (
    destinationTax !== null &&
    Number.isInteger(destinationTax) &&
    destinationTax >= 0 &&
    destinationTax <= 10_000
  ) {
    return { commissionRate: destinationTax / 10_000, fellBack: false };
  }

  return { commissionRate: fallbackCommissionRate, fellBack: true };
}

/** One ledger row of a served Fansly transaction, before the writer adds the
 *  page, the source, the fan and the observation it came from. */
export type FanslyTransactionLedgerRow = Omit<
  UpsertTransactionInput,
  "platformAccountId" | "source" | "fanId" | "sourceObservationId"
>;

/**
 * A served Fansly earnings transaction as its ledger row (BIGINT mills).
 * `amount == destinationAmount` means the provider reported the net only, so
 * the gross is derived from the stated (or the page's) commission;
 * `commissionFellBack` says the page's rate was used for that.
 */
export function mapFanslyTransactionItem(
  item: FanslyEarningsTransaction,
  pageCommissionRate: number,
): { row: FanslyTransactionLedgerRow; commissionFellBack: boolean } {
  const sourceAmountMills = millsFromInteger(item.amount);
  const destinationAmountMills = millsFromInteger(item.destinationAmount);
  const creatorNetAmountMills = destinationAmountMills;
  const { commissionRate, fellBack } = resolveFanslyCommissionRate(item.destinationTax, pageCommissionRate);
  const grossFromNet = sourceAmountMills === destinationAmountMills;
  const grossAmountMills = grossFromNet
    ? calculateGrossMillsFromNet(creatorNetAmountMills, commissionRate)
    : sourceAmountMills;
  return {
    commissionFellBack: grossFromNet && fellBack,
    row: {
      transactionId: item.transactionId,
      walletId: item.walletId,
      accountId: item.accountId,
      correlationId: item.correlationId,
      correlationAccountId: item.correlationAccountId,
      rawType: item.type,
      canonicalType: mapFanslyTransactionType(item.type),
      transactionState: mapFanslyTransactionState(item.status),
      destination: item.destination,
      rawStatus: item.status,
      grossAmountMills,
      sourceDestinationAmountMills: destinationAmountMills,
      creatorNetAmountMills,
      rawDestinationTax: item.destinationTax,
      newBalanceMills: item.newBalance64 !== null && item.newBalance64 !== undefined
        ? millsFromInteger(item.newBalance64)
        : null,
      senderId: item.senderId,
      receiverId: item.receiverId,
      occurredAt: new Date(item.createdAt),
      sourceUpdatedAt: item.updatedAt ? new Date(item.updatedAt) : null,
    },
  };
}

/** Transaction ids served on the previous offset page and again on this one:
 *  the offsets moved under the walk. */
export function findTransactionPageOverlap(
  previousTransactionIds: readonly string[] | undefined,
  items: readonly Pick<FanslyEarningsTransaction, "transactionId">[],
) {
  if (!previousTransactionIds || previousTransactionIds.length === 0) {
    return [];
  }

  const previous = new Set(previousTransactionIds);
  return items
    .map((item) => item.transactionId)
    .filter((transactionId) => previous.has(transactionId));
}

// The early stop trusts the listing's newest-first order. A row inside the
// window listed after an older one breaks that premise: later pages could
// hold in-window rows the stop never reads.
export function inWindowItemsAfterOlder<T extends Pick<FanslyEarningsTransaction, "createdAt">>(
  items: readonly T[],
  after: Date,
): T[] {
  const bound = after.getTime();
  let seenOlder = false;
  const late: T[] = [];
  for (const item of items) {
    if (item.createdAt < bound) {
      seenOlder = true;
    } else if (seenOlder) {
      late.push(item);
    }
  }
  return late;
}

// ── top spenders ────────────────────────────────────────────────────────────

/** Rows `/account/wallets/earnings/accounts` serves at most: a full answer may
 *  have been cut, so its window is split (month → weeks → days). */
export const TOP_SPENDERS_PROVIDER_CAP = 100;
export const TOP_SPENDERS_STEADY_STATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const TOP_SPENDERS_WINDOW_DAY_MS = 24 * 60 * 60 * 1000;
export const TOP_SPENDERS_WINDOW_WEEK_MS = 7 * TOP_SPENDERS_WINDOW_DAY_MS;

export function buildUtcMonthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function nextUtcMonthBoundary(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

export function buildTopSpendersBootstrapWindows(
  accountCreatedAt: Date,
  now: Date,
) {
  const windows: TopSpendersCursorWindow[] = [];
  let cursor = new Date(accountCreatedAt);

  while (cursor.getTime() < now.getTime()) {
    const boundary = nextUtcMonthBoundary(cursor);
    const endedAt = new Date(Math.min(boundary.getTime(), now.getTime()));
    windows.push({
      kind: "month",
      monthKey: buildUtcMonthKey(cursor),
      startedAt: cursor.toISOString(),
      endedAt: endedAt.toISOString(),
    });
    cursor = endedAt;
  }

  return windows;
}

export function splitTopSpendersWindow(window: TopSpendersCursorWindow) {
  const nextWindowMs = window.kind === "month"
    ? TOP_SPENDERS_WINDOW_WEEK_MS
    : window.kind === "week"
      ? TOP_SPENDERS_WINDOW_DAY_MS
      : null;
  const nextKind = window.kind === "month"
    ? "week"
    : window.kind === "week"
      ? "day"
      : null;
  if (nextWindowMs === null || nextKind === null) {
    return null;
  }

  const windows: TopSpendersCursorWindow[] = [];
  let cursor = new Date(window.startedAt);
  const endedAt = new Date(window.endedAt);

  while (cursor.getTime() < endedAt.getTime()) {
    const next = new Date(Math.min(cursor.getTime() + nextWindowMs, endedAt.getTime()));
    windows.push({
      kind: nextKind,
      monthKey: window.monthKey,
      startedAt: cursor.toISOString(),
      endedAt: next.toISOString(),
    });
    cursor = next;
  }

  return windows;
}

export function computeCompletedTopSpenderMonths(
  totalMonths: number,
  pendingWindows: TopSpendersCursorWindow[],
) {
  const remainingMonths = new Set(pendingWindows.map((window) => window.monthKey)).size;
  return Math.max(0, totalMonths - remainingMonths);
}

export function buildTopSpendersBootstrapState(
  accountCreatedAt: Date,
  now: Date,
): TopSpendersCursorState {
  const pendingWindows = buildTopSpendersBootstrapWindows(accountCreatedAt, now);
  return {
    version: 1,
    mode: "bootstrap",
    accountCreatedAt: accountCreatedAt.toISOString(),
    totalMonths: new Set(pendingWindows.map((window) => window.monthKey)).size,
    completedMonths: 0,
    pendingWindows,
    lastWindowStartedAt: null,
    lastWindowEndedAt: null,
  };
}

export function normalizeTopSpenderIdentityValue(value: string | null | undefined) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function resolveTopSpenderSourceIdentity(input: {
  accountId?: string | null;
  correlationAccountId?: string | null;
}) {
  const correlationAccountId = normalizeTopSpenderIdentityValue(input.correlationAccountId);
  if (correlationAccountId) {
    return {
      sourceIdentityKey: `fan:${correlationAccountId}`,
      correlationAccountId,
      accountId: normalizeTopSpenderIdentityValue(input.accountId),
    };
  }

  const accountId = normalizeTopSpenderIdentityValue(input.accountId);
  if (accountId) {
    return {
      sourceIdentityKey: `account:${accountId}`,
      correlationAccountId: null,
      accountId,
    };
  }

  return null;
}

export interface TopSpenderItem {
  totalGross: number;
  totalNet: number;
  accountId?: string | null;
  correlationAccountId?: string | null;
}

export interface TopSpenderRanking {
  totalGross: number;
  totalNet: number;
  sourceIdentityKey: string;
  accountId: string | null;
  correlationAccountId: string | null;
}

/** The served rows that name a spender, and (up to five) examples of the ones
 *  that name neither a correlation account nor an account. */
export function partitionTopSpenderItems(items: readonly TopSpenderItem[]): {
  valid: TopSpenderRanking[];
  skippedCount: number;
  skippedExamples: Array<{ accountId: string | null; correlationAccountId: string | null }>;
} {
  const valid: TopSpenderRanking[] = [];
  const skippedExamples: Array<{ accountId: string | null; correlationAccountId: string | null }> = [];
  for (const item of items) {
    const identity = resolveTopSpenderSourceIdentity(item);
    if (!identity) {
      if (skippedExamples.length < 5) {
        skippedExamples.push({
          accountId: normalizeTopSpenderIdentityValue(item.accountId),
          correlationAccountId: normalizeTopSpenderIdentityValue(item.correlationAccountId),
        });
      }
      continue;
    }
    valid.push({
      totalGross: item.totalGross,
      totalNet: item.totalNet,
      sourceIdentityKey: identity.sourceIdentityKey,
      accountId: identity.accountId,
      correlationAccountId: identity.correlationAccountId,
    });
  }
  return { valid, skippedCount: items.length - valid.length, skippedExamples };
}
