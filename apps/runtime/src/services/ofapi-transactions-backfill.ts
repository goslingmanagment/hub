import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";

import {
  findPageByLabel,
  ofapiSpendProjectionEvents,
  pageCredentials,
  pages,
  rebuildRevenueRollups,
  rebuildSpenderProjections,
  transactions,
  upsertFanPages,
  upsertFans,
  upsertTransaction,
  withOfapiSpendTransactionPageLock,
  type Database,
} from "@agency_hub_core/db";
import {
  createProxyRequestDispatcher,
  dollarsToMills,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import type { OfapiRequestContext } from "./ofapi.ts";
import {
  mapOfapiTransactionStatusForSpendProjection,
  mapTransactionCategory,
  ofapiSpendProjectionTransactionId,
  type OfapiSpendProjectionCategory,
} from "./ofapi-spend-projection-contract.ts";
import {
  mapOfapiSpendCategoryToTransactionType,
  mapOfapiSpendStatusToTransactionState,
  normalizeOfapiSpendAmountMills,
} from "./ofapi-spend-transaction-mapping.ts";
import {
  resolveStoredProxyConfig,
  resolveStoredProxyEgressKey,
} from "./page-context.ts";

const OFAPI_TRANSACTION_BACKFILL_LIMIT = 100;
const OVERLAP_CHUNK_SIZE = 500;

type BackfillMode = "dry-run" | "write";

type NormalizedBackfillTransaction = {
  rawTransactionId: string;
  transactionId: string;
  fanPlatformUserId: string;
  rawType: string;
  category: OfapiSpendProjectionCategory;
  rawStatus: string;
  eventStatus: "pending" | "settled" | "reversed";
  grossAmountMills: bigint;
  creatorNetAmountMills: bigint;
  occurredAt: Date;
  sourceUpdatedAt: Date | null;
};

export interface OfapiTransactionsBackfillInput {
  pageLabels: string[];
  from: Date;
  to?: Date | null;
  mode?: BackfillMode;
  limit?: number;
}

export interface OfapiTransactionsBackfillMonthSummary {
  month: string;
  rows: number;
  grossAmountMills: bigint;
  creatorNetAmountMills: bigint;
}

export interface OfapiTransactionsBackfillPageResult {
  pageLabel: string;
  pageId: number | null;
  ofapiAccountId: string | null;
  status: "blocked" | "dry_run" | "written";
  reason: string | null;
  hasCredentials: boolean;
  activeNonOfapiTransactions: number;
  apiPages: number;
  rawRows: number;
  normalizedRows: number;
  skippedRows: number;
  writtenRows: number;
  minOccurredAt: Date | null;
  maxOccurredAt: Date | null;
  typeHistogram: Record<string, number>;
  statusHistogram: Record<string, number>;
  skippedReasons: Record<string, number>;
  overlap: {
    checked: number;
    matched: number;
    matchRate: number | null;
  };
  months: OfapiTransactionsBackfillMonthSummary[];
}

export interface OfapiTransactionsBackfillResult {
  mode: BackfillMode;
  from: Date;
  to: Date | null;
  pages: OfapiTransactionsBackfillPageResult[];
}

function bump(histogram: Record<string, number>, key: string) {
  histogram[key] = (histogram[key] ?? 0) + 1;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asStringId(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstStringId(...values: unknown[]) {
  for (const value of values) {
    const id = asStringId(value);
    if (id) {
      return id;
    }
  }
  return null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const raw = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(" ", "T")}Z`
    : raw;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseDollarMills(value: unknown): bigint | null {
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  const normalized = typeof value === "string"
    ? value.trim().replace(/^\$/, "").replace(/,/g, "")
    : value;
  try {
    return dollarsToMills(normalized);
  } catch {
    return null;
  }
}

function formatOfapiStartDate(date: Date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function extractFanPlatformUserId(row: Record<string, unknown>) {
  const user = asRecord(row.user)
    ?? asRecord(row.fan)
    ?? asRecord(row.fromUser)
    ?? asRecord(row.from_user)
    ?? asRecord(row.sender);

  return firstStringId(
    row.fan_id,
    row.fanId,
    row.user_id,
    row.userId,
    row.chat_id,
    row.chatId,
    user?.id,
    user?.user_id,
    user?.userId,
    user?.chat_id,
    user?.chatId,
  );
}

function normalizeRestTransaction(
  row: Record<string, unknown>,
  input: {
    from: Date;
    to: Date | null;
  },
): { status: "ok"; transaction: NormalizedBackfillTransaction } | { status: "skipped"; reason: string } {
  const rawTransactionId = firstStringId(row.id, row.transaction_id, row.transactionId);
  if (!rawTransactionId) {
    return { status: "skipped", reason: "missing_transaction_id" };
  }

  const fanPlatformUserId = extractFanPlatformUserId(row);
  if (!fanPlatformUserId) {
    return { status: "skipped", reason: "missing_fan_id" };
  }

  const occurredAt = parseDate(
    row.createdAt ?? row.created_at ?? row.date ?? row.timestamp ?? row.time,
  );
  if (!occurredAt) {
    return { status: "skipped", reason: "missing_occurred_at" };
  }
  if (occurredAt < input.from || (input.to !== null && occurredAt >= input.to)) {
    return { status: "skipped", reason: "outside_window" };
  }

  const currency = typeof row.currency === "string"
    ? row.currency
    : typeof row.currency_code === "string"
      ? row.currency_code
      : null;
  if (currency !== null && currency.toUpperCase() !== "USD") {
    return { status: "skipped", reason: "unsupported_currency" };
  }

  const grossAmountMills = parseDollarMills(
    row.amount ?? row.gross ?? row.gross_amount ?? row.grossAmount ?? row.price,
  );
  if (grossAmountMills === null) {
    return { status: "skipped", reason: "missing_gross_amount" };
  }

  const explicitNet = parseDollarMills(
    row.net ?? row.net_amount ?? row.netAmount ?? row.creator_net_amount ?? row.creatorNetAmount,
  );
  const fee = parseDollarMills(row.fee ?? row.platform_fee ?? row.platformFee);
  const creatorNetAmountMills = explicitNet ?? (fee === null ? null : grossAmountMills - fee);
  if (creatorNetAmountMills === null) {
    return { status: "skipped", reason: "missing_net_amount" };
  }

  const rawType = typeof row.type === "string" && row.type.trim().length > 0
    ? row.type.trim()
    : "other";
  const rawStatus = typeof row.status === "string" && row.status.trim().length > 0
    ? row.status.trim()
    : "pending";
  const eventStatus = mapOfapiTransactionStatusForSpendProjection(rawStatus);

  return {
    status: "ok",
    transaction: {
      rawTransactionId,
      transactionId: ofapiSpendProjectionTransactionId(rawTransactionId, eventStatus),
      fanPlatformUserId,
      rawType,
      category: mapTransactionCategory(rawType),
      rawStatus: eventStatus,
      eventStatus,
      grossAmountMills,
      creatorNetAmountMills,
      occurredAt,
      sourceUpdatedAt: parseDate(row.updatedAt ?? row.updated_at),
    },
  };
}

function summarizeMonths(rows: NormalizedBackfillTransaction[]) {
  const months = new Map<string, OfapiTransactionsBackfillMonthSummary>();
  for (const row of rows) {
    const month = row.occurredAt.toISOString().slice(0, 7);
    const existing = months.get(month);
    if (existing) {
      existing.rows += 1;
      existing.grossAmountMills += normalizeOfapiSpendAmountMills(row.eventStatus, row.grossAmountMills);
      existing.creatorNetAmountMills += normalizeOfapiSpendAmountMills(
        row.eventStatus,
        row.creatorNetAmountMills,
      );
    } else {
      months.set(month, {
        month,
        rows: 1,
        grossAmountMills: normalizeOfapiSpendAmountMills(row.eventStatus, row.grossAmountMills),
        creatorNetAmountMills: normalizeOfapiSpendAmountMills(row.eventStatus, row.creatorNetAmountMills),
      });
    }
  }
  return Array.from(months.values()).sort((a, b) => a.month.localeCompare(b.month));
}

function occurredRange(rows: NormalizedBackfillTransaction[]) {
  let min: Date | null = null;
  let max: Date | null = null;
  for (const row of rows) {
    min = min === null || row.occurredAt.getTime() < min.getTime() ? row.occurredAt : min;
    max = max === null || row.occurredAt.getTime() > max.getTime() ? row.occurredAt : max;
  }
  return { min, max };
}

async function countActiveNonOfapiTransactions(
  db: Database,
  input: {
    pageId: number;
    from: Date;
    to: Date | null;
  },
) {
  const result = await db.execute<{ count: number }>(sql`
    select count(*)::int as count
    from ${transactions}
    where ${transactions.platformAccountId} = ${input.pageId}
      and ${transactions.isActive} = true
      and ${transactions.occurredAt} >= ${input.from}
      ${input.to ? sql`and ${transactions.occurredAt} < ${input.to}` : sql``}
      and ${transactions.rawType} not like 'ofapi:%'
  `);
  return Number(result.rows[0]?.count ?? 0);
}

async function loadWriteEligibility(
  db: Database,
  input: {
    pageId: number;
    from: Date;
    to: Date | null;
  },
) {
  const [page] = await db
    .select({
      id: pages.id,
      platform: pages.platform,
      label: pages.label,
      ofapiAccountId: pages.ofapiAccountId,
      credentialId: pageCredentials.id,
    })
    .from(pages)
    .leftJoin(pageCredentials, eq(pageCredentials.platformAccountId, pages.id))
    .where(eq(pages.id, input.pageId))
    .limit(1);

  if (!page) {
    return {
      eligible: false as const,
      reason: "page_not_found",
      hasCredentials: false,
      activeNonOfapiTransactions: 0,
      ofapiAccountId: null,
    };
  }

  const activeNonOfapiTransactions = await countActiveNonOfapiTransactions(db, input);
  const hasCredentials = page.credentialId !== null;
  const reason = page.platform !== "onlyfans"
    ? "not_onlyfans"
    : !page.ofapiAccountId
      ? "missing_ofapi_account_id"
      : hasCredentials
        ? "has_page_credentials"
        : activeNonOfapiTransactions > 0
          ? "active_non_ofapi_transactions"
          : null;

  return {
    eligible: reason === null,
    reason,
    hasCredentials,
    activeNonOfapiTransactions,
    ofapiAccountId: page.ofapiAccountId,
  };
}

async function fetchBackfillRows(
  app: AppContext,
  input: {
    pageId: number;
    ofapiAccountId: string;
    requestContext: OfapiRequestContext;
    from: Date;
    to: Date | null;
    limit: number;
  },
) {
  if (!app.ofapi?.listTransactions) {
    throw new Error("OFAPI client is not configured");
  }

  let marker: string | null = null;
  let pageIndex = 0;
  let rawRows = 0;
  const normalized: NormalizedBackfillTransaction[] = [];
  const typeHistogram: Record<string, number> = {};
  const statusHistogram: Record<string, number> = {};
  const skippedReasons: Record<string, number> = {};

  for (;;) {
    const page = await app.ofapi.listTransactions(
      input.requestContext,
      input.ofapiAccountId,
      {
        limit: input.limit,
        startDate: formatOfapiStartDate(input.from),
        marker,
        pageIndex,
      },
    );
    rawRows += page.items.length;

    for (const item of page.items) {
      const rawType = typeof item.type === "string" && item.type.trim().length > 0
        ? item.type.trim()
        : "other";
      const rawStatus = typeof item.status === "string" && item.status.trim().length > 0
        ? item.status.trim()
        : "pending";
      bump(typeHistogram, rawType);
      bump(statusHistogram, rawStatus);

      const result = normalizeRestTransaction(item, { from: input.from, to: input.to });
      if (result.status === "ok") {
        normalized.push(result.transaction);
      } else {
        bump(skippedReasons, result.reason);
      }
    }

    pageIndex += 1;
    if (!page.hasNextPage) {
      break;
    }
    if (!page.nextMarker || page.nextMarker === marker) {
      throw new Error(
        `OFAPI transactions pagination returned next_page without a usable marker for account ${input.ofapiAccountId}`,
      );
    }
    marker = page.nextMarker;
  }

  return {
    apiPages: pageIndex,
    rawRows,
    normalizedRows: normalized,
    typeHistogram,
    statusHistogram,
    skippedReasons,
  };
}

async function calculateProjectionOverlap(
  db: Database,
  input: {
    pageId: number;
    rows: NormalizedBackfillTransaction[];
    from: Date;
    to: Date | null;
  },
) {
  const ids = Array.from(new Set(input.rows.map((row) => row.transactionId)));
  if (ids.length === 0) {
    return { checked: 0, matched: 0, matchRate: null };
  }

  let matched = 0;
  for (let index = 0; index < ids.length; index += OVERLAP_CHUNK_SIZE) {
    const batch = ids.slice(index, index + OVERLAP_CHUNK_SIZE);
    const rows = await db
      .select({ transactionId: ofapiSpendProjectionEvents.transactionId })
      .from(ofapiSpendProjectionEvents)
      .where(and(
        eq(ofapiSpendProjectionEvents.pageId, input.pageId),
        eq(ofapiSpendProjectionEvents.sourceEventType, "transactions.new"),
        eq(ofapiSpendProjectionEvents.projectionStatus, "projected"),
        gte(ofapiSpendProjectionEvents.occurredAt, input.from),
        input.to ? lt(ofapiSpendProjectionEvents.occurredAt, input.to) : sql`true`,
        inArray(ofapiSpendProjectionEvents.transactionId, batch),
      ));
    matched += new Set(rows.map((row) => row.transactionId)).size;
  }

  return {
    checked: ids.length,
    matched,
    matchRate: ids.length === 0 ? null : matched / ids.length,
  };
}

async function writeBackfillRows(
  app: AppContext,
  input: {
    pageId: number;
    ofapiAccountId: string;
    from: Date;
    to: Date | null;
    rows: NormalizedBackfillTransaction[];
  },
) {
  if (input.rows.length === 0) {
    return 0;
  }

  return withOfapiSpendTransactionPageLock(app.db, input.pageId, async (db) => {
    const eligibility = await loadWriteEligibility(db, {
      pageId: input.pageId,
      from: input.from,
      to: input.to,
    });
    if (!eligibility.eligible) {
      throw new Error(`OFAPI transaction backfill write blocked: ${eligibility.reason}`);
    }

    const fanPlatformUserIds = Array.from(new Set(input.rows.map((row) => row.fanPlatformUserId)));
    const fanRows = await upsertFans(db, fanPlatformUserIds.map((platformUserId) => ({
      platform: "onlyfans",
      platformUserId,
    })));
    await upsertFanPages(db, fanRows.map((fan) => ({
      fanId: fan.id,
      platformAccountId: input.pageId,
    })));

    const fanIdByPlatformUserId = new Map(
      fanRows.map((fan) => [fan.platformUserId, fan.id]),
    );
    let dirtyFrom: Date | null = null;
    let written = 0;

    for (const row of input.rows) {
      const grossAmountMills = normalizeOfapiSpendAmountMills(row.eventStatus, row.grossAmountMills);
      const creatorNetAmountMills = normalizeOfapiSpendAmountMills(
        row.eventStatus,
        row.creatorNetAmountMills,
      );
      await upsertTransaction(db, {
        platformAccountId: input.pageId,
        fanId: fanIdByPlatformUserId.get(row.fanPlatformUserId) ?? null,
        transactionId: row.transactionId,
        accountId: input.ofapiAccountId,
        correlationAccountId: row.fanPlatformUserId,
        rawType: `ofapi:rest:${row.rawType}`,
        canonicalType: mapOfapiSpendCategoryToTransactionType(row.category, row.eventStatus),
        transactionState: mapOfapiSpendStatusToTransactionState(row.eventStatus),
        rawStatus: row.eventStatus,
        grossAmountMills,
        sourceDestinationAmountMills: grossAmountMills,
        creatorNetAmountMills,
        senderId: row.fanPlatformUserId,
        occurredAt: row.occurredAt,
        sourceUpdatedAt: row.sourceUpdatedAt ?? row.occurredAt,
      });
      dirtyFrom = dirtyFrom === null || row.occurredAt.getTime() < dirtyFrom.getTime()
        ? row.occurredAt
        : dirtyFrom;
      written += 1;
    }

    if (dirtyFrom) {
      await rebuildSpenderProjections(db, input.pageId, dirtyFrom);
      await rebuildRevenueRollups(db, input.pageId, dirtyFrom);
    }

    return written;
  });
}

function blockedPageResult(input: {
  pageLabel: string;
  pageId: number | null;
  ofapiAccountId: string | null;
  reason: string;
  hasCredentials?: boolean;
  activeNonOfapiTransactions?: number;
}): OfapiTransactionsBackfillPageResult {
  return {
    pageLabel: input.pageLabel,
    pageId: input.pageId,
    ofapiAccountId: input.ofapiAccountId,
    status: "blocked",
    reason: input.reason,
    hasCredentials: input.hasCredentials ?? false,
    activeNonOfapiTransactions: input.activeNonOfapiTransactions ?? 0,
    apiPages: 0,
    rawRows: 0,
    normalizedRows: 0,
    skippedRows: 0,
    writtenRows: 0,
    minOccurredAt: null,
    maxOccurredAt: null,
    typeHistogram: {},
    statusHistogram: {},
    skippedReasons: {},
    overlap: { checked: 0, matched: 0, matchRate: null },
    months: [],
  };
}

export async function runOfapiTransactionsBackfill(
  app: AppContext,
  input: OfapiTransactionsBackfillInput,
): Promise<OfapiTransactionsBackfillResult> {
  const mode = input.mode ?? "dry-run";
  const limit = Math.min(input.limit ?? OFAPI_TRANSACTION_BACKFILL_LIMIT, OFAPI_TRANSACTION_BACKFILL_LIMIT);
  const to = input.to ?? null;
  const results: OfapiTransactionsBackfillPageResult[] = [];

  for (const pageLabel of input.pageLabels) {
    const stored = await findPageByLabel(app.db, pageLabel);
    if (!stored) {
      results.push(blockedPageResult({
        pageLabel,
        pageId: null,
        ofapiAccountId: null,
        reason: "page_not_found",
      }));
      continue;
    }

    const eligibility = await loadWriteEligibility(app.db, {
      pageId: stored.page.id,
      from: input.from,
      to,
    });
    if (!eligibility.eligible || !eligibility.ofapiAccountId) {
      results.push(blockedPageResult({
        pageLabel,
        pageId: stored.page.id,
        ofapiAccountId: eligibility.ofapiAccountId,
        reason: eligibility.reason ?? "not_eligible",
        hasCredentials: eligibility.hasCredentials,
        activeNonOfapiTransactions: eligibility.activeNonOfapiTransactions,
      }));
      continue;
    }

    const proxy = resolveStoredProxyConfig(app, stored.proxy);
    const dispatcher = proxy ? createProxyRequestDispatcher(proxy) : null;
    let fetched: Awaited<ReturnType<typeof fetchBackfillRows>>;
    try {
      fetched = await fetchBackfillRows(app, {
        pageId: stored.page.id,
        ofapiAccountId: eligibility.ofapiAccountId,
        requestContext: {
          pageId: stored.page.id,
          dispatcher,
          egressKey: resolveStoredProxyEgressKey(stored.proxy),
        },
        from: input.from,
        to,
        limit,
      });
    } finally {
      if (dispatcher) {
        await dispatcher.close().catch((error: unknown) => {
          app.logger.warn({ error, pageId: stored.page.id }, "Failed to close OFAPI backfill dispatcher");
        });
      }
    }
    const range = occurredRange(fetched.normalizedRows);
    const overlap = await calculateProjectionOverlap(app.db, {
      pageId: stored.page.id,
      rows: fetched.normalizedRows,
      from: input.from,
      to,
    });
    const writtenRows = mode === "write"
      ? await writeBackfillRows(app, {
        pageId: stored.page.id,
        ofapiAccountId: eligibility.ofapiAccountId,
        from: input.from,
        to,
        rows: fetched.normalizedRows,
      })
      : 0;

    results.push({
      pageLabel,
      pageId: stored.page.id,
      ofapiAccountId: eligibility.ofapiAccountId,
      status: mode === "write" ? "written" : "dry_run",
      reason: null,
      hasCredentials: false,
      activeNonOfapiTransactions: 0,
      apiPages: fetched.apiPages,
      rawRows: fetched.rawRows,
      normalizedRows: fetched.normalizedRows.length,
      skippedRows: fetched.rawRows - fetched.normalizedRows.length,
      writtenRows,
      minOccurredAt: range.min,
      maxOccurredAt: range.max,
      typeHistogram: fetched.typeHistogram,
      statusHistogram: fetched.statusHistogram,
      skippedReasons: fetched.skippedReasons,
      overlap,
      months: summarizeMonths(fetched.normalizedRows),
    });
  }

  return {
    mode,
    from: input.from,
    to,
    pages: results,
  };
}
