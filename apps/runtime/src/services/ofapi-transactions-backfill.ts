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
  withOfapiSpendTransactionPageLock,
  type Database,
} from "@agency_hub_core/db";
import {
  dollarsToMills,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import type { OfapiRequestContext } from "./ofapi.ts";
import { upsertTransactionWithNegationGuards } from "./money-negation-guards.ts";
import { createOfapiRestGuard, type OfapiBudgetBlock } from "./sync/ofapi-dm-sync.ts";
import {
  mapOfapiTransactionStatusForSpendProjection,
  mapTransactionCategory,
  ofapiSpendProjectionTransactionId,
  type OfapiSpendProjectionCategory,
} from "./ofapi-spend-projection-contract.ts";
import { isOfapiSpendTransactionIngestEnabled } from "./ofapi-spend-transaction-ingest.ts";
import {
  mapOfapiSpendCategoryToTransactionType,
  mapOfapiSpendStatusToTransactionState,
  normalizeOfapiSpendAmountMills,
} from "./ofapi-spend-transaction-mapping.ts";
import { resolveEgress } from "./egress/resolver.ts";

const OFAPI_TRANSACTION_BACKFILL_LIMIT = 100;
const OVERLAP_CHUNK_SIZE = 500;
// Safety backstop on the paginated REST walk. The window-end stop (below) bounds
// any run with a `to`; this cap bounds the open-ended (`to`-less) case and guards
// against a feed that never reports hasNextPage=false, so a backfill can never
// page — and pay credits — through an unbounded forward history.
const OFAPI_TRANSACTION_BACKFILL_MAX_PAGES = 1000;
// Stage 14 (DP 2): backfills run only under the day-budget reservation
// machinery. Conservative default; the ofapiBackfillDailyCreditBudget knob
// raises it deliberately.
const DEFAULT_BACKFILL_DAILY_CREDIT_BUDGET = 200;

type BackfillMode = "dry-run" | "write";

// How the paginated fetch terminated, surfaced per page so a truncated run is
// never mistaken for full window coverage. budget_exhausted = the day-budget
// reservation (or credit floor) refused before the walk finished — re-run
// after the UTC-day rollover; the upserts make re-runs convergent.
type BackfillPaginationStopReason =
  | "completed"
  | "reached_window_end"
  | "page_cap"
  | "budget_exhausted";

type WriteBackfillOutcome =
  | { status: "written"; writtenRows: number }
  | { status: "blocked"; reason: string; hasCredentials: boolean; activeNonOfapiTransactions: number };

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
  platformFeeMills: bigint | null;
  vatAmountMills: bigint | null;
  taxAmountMills: bigint | null;
  occurredAt: Date;
};

export interface OfapiTransactionsBackfillInput {
  pageLabels: string[];
  from: Date;
  to?: Date | null;
  mode?: BackfillMode;
  limit?: number;
  // Hard cap on paginated OFAPI requests per page (safety backstop). Defaults to
  // OFAPI_TRANSACTION_BACKFILL_MAX_PAGES.
  maxApiPages?: number;
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
  // null for pages that never fetched (blocked before the API walk).
  paginationStopReason: BackfillPaginationStopReason | null;
  // Which budget check stopped the walk when paginationStopReason is
  // budget_exhausted (day budget vs. balance floor); null otherwise.
  budgetBlock: OfapiBudgetBlock | null;
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
):
  | { status: "ok"; transaction: NormalizedBackfillTransaction }
  | { status: "skipped"; reason: string; occurredAt?: Date }
{
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
  if (occurredAt < input.from) {
    return { status: "skipped", reason: "before_window", occurredAt };
  }
  // `after_window` is distinguished from `before_window` so the paginated walk
  // can stop once it crosses the upper bound (see fetchBackfillRows). The
  // occurredAt is returned so the ordering guard there can verify the feed is
  // actually ascending before trusting that stop.
  if (input.to !== null && occurredAt >= input.to) {
    return { status: "skipped", reason: "after_window", occurredAt };
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
  const fee = parseDollarMills(row.fee_amount ?? row.fee ?? row.platform_fee ?? row.platformFee);
  const creatorNetAmountMills = explicitNet ?? (fee === null ? null : grossAmountMills - fee);
  if (creatorNetAmountMills === null) {
    return { status: "skipped", reason: "missing_net_amount" };
  }
  // Stage 14 fee capture — same dollars-float field family as the webhook
  // payload (fee_amount/vat_amount/tax_amount). Only explicitly reported
  // values are stored; NULL keeps "derivable as gross − net" a query-time
  // fallback instead of baking a derivation into the explicit-fee column.
  const platformFeeMills = fee;
  const vatAmountMills = parseDollarMills(row.vat_amount ?? row.vatAmount ?? row.vat);
  const taxAmountMills = parseDollarMills(row.tax_amount ?? row.taxAmount ?? row.tax);

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
      platformFeeMills,
      vatAmountMills,
      taxAmountMills,
      occurredAt,
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

// Existing transactions on this page already in a terminal (posted) state, out of
// the given ids. Used so a stale REST `pending` row never demotes truth the
// webhook path already settled.
async function loadPostedTransactionIds(
  db: Database,
  input: { pageId: number; transactionIds: string[] },
): Promise<Set<string>> {
  const unique = Array.from(new Set(input.transactionIds));
  const found = new Set<string>();
  for (let index = 0; index < unique.length; index += OVERLAP_CHUNK_SIZE) {
    const batch = unique.slice(index, index + OVERLAP_CHUNK_SIZE);
    const rows = await db
      .select({ transactionId: transactions.transactionId })
      .from(transactions)
      .where(and(
        eq(transactions.platformAccountId, input.pageId),
        eq(transactions.transactionState, "posted"),
        inArray(transactions.transactionId, batch),
      ));
    for (const row of rows) {
      found.add(row.transactionId);
    }
  }
  return found;
}

/** Exported for tests (the tombstone-race regression drives it directly). */
export async function loadWriteEligibility(
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
      status: pages.status,
      ofapiAccountId: pages.ofapiAccountId,
      transactionsWriter: pages.transactionsWriter,
      credentialId: pageCredentials.id,
    })
    .from(pages)
    .leftJoin(pageCredentials, eq(pageCredentials.platformAccountId, pages.id))
    .where(eq(pages.id, input.pageId))
    .limit(1);

  // Soft delete clears neither ofapiAccountId nor the writer assignment, so a
  // queued job could pass eligibility after the tombstone landed (review
  // R2-4). Refuse quietly — no incident noise for racing in-flight chunks.
  if (!page || page.status !== "active") {
    return {
      eligible: false as const,
      reason: page ? "page_not_active" : "page_not_found",
      hasCredentials: false,
      activeNonOfapiTransactions: 0,
      ofapiAccountId: null,
    };
  }

  const activeNonOfapiTransactions = await countActiveNonOfapiTransactions(db, input);
  const hasCredentials = page.credentialId !== null;
  // Stage 13: the writer column subsumes and formalizes the
  // active_non_ofapi_transactions heuristic below; both stay — the heuristic
  // still catches data written before the writer registry existed.
  const reason = page.platform !== "onlyfans"
    ? "not_onlyfans"
    : !page.ofapiAccountId
      ? "missing_ofapi_account_id"
      : page.transactionsWriter !== "ofapi"
        ? "wrong_transactions_writer"
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
    maxApiPages: number;
    guard: ReturnType<typeof createOfapiRestGuard>;
  },
) {
  if (!app.ofapi?.listTransactions) {
    throw new Error("OFAPI client is not configured");
  }

  let marker: string | null = null;
  let pageIndex = 0;
  let rawRows = 0;
  let stopReason: BackfillPaginationStopReason = "completed";
  let budgetBlock: OfapiBudgetBlock | null = null;
  // The after_window early-stop below only holds if the feed is ascending from
  // startDate, and we have no vendor contract proving that order. So we honor the
  // early-stop only after POSITIVELY observing ascending order across a page
  // boundary (a page whose earliest row is at/after everything a prior page
  // showed), and never once we observe a backwards jump. Crucially this means we
  // never early-stop on the FIRST page (or any unproven prefix): a descending or
  // mixed first page that happens to contain an after_window row keeps paginating
  // instead of dropping in-window rows that later pages may still hold. Cost stays
  // bounded by the page cap; the perf win is retained for genuinely ascending
  // feeds (at most one extra confirmation page).
  let ascendingObserved = false;
  let ascendingViolated = false;
  let seenMaxOccurredMs: number | null = null;
  const normalized: NormalizedBackfillTransaction[] = [];
  const typeHistogram: Record<string, number> = {};
  const statusHistogram: Record<string, number> = {};
  const skippedReasons: Record<string, number> = {};

  for (;;) {
    // Reserve-before-request (DP 2): a refused reservation ends the walk with
    // an explicit stop reason instead of paging on. The walk is convergent on
    // re-run, so "resume tomorrow" loses nothing.
    const block = await input.guard.resolveBlock();
    if (block !== null) {
      stopReason = "budget_exhausted";
      budgetBlock = block;
      break;
    }
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
    await input.guard.recordResponse(page);
    rawRows += page.items.length;

    let crossedWindowEnd = false;
    let pageMinOccurredMs: number | null = null;
    let pageMaxOccurredMs: number | null = null;
    const trackOccurred = (occurredAt: Date) => {
      const ms = occurredAt.getTime();
      pageMinOccurredMs = pageMinOccurredMs === null ? ms : Math.min(pageMinOccurredMs, ms);
      pageMaxOccurredMs = pageMaxOccurredMs === null ? ms : Math.max(pageMaxOccurredMs, ms);
    };

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
        trackOccurred(result.transaction.occurredAt);
      } else {
        bump(skippedReasons, result.reason);
        if (result.reason === "after_window") {
          crossedWindowEnd = true;
        }
        if (result.occurredAt) {
          trackOccurred(result.occurredAt);
        }
      }
    }

    // Compare this page's earliest row against the max timestamp all strictly
    // prior pages showed. Started at/after it -> observed an ascending step;
    // started before it -> the feed is not globally ascending (violated). Both
    // need a prior page, so neither can be set on the first page.
    if (seenMaxOccurredMs !== null && pageMinOccurredMs !== null) {
      if (pageMinOccurredMs < seenMaxOccurredMs) {
        ascendingViolated = true;
      } else {
        ascendingObserved = true;
      }
    }
    if (pageMaxOccurredMs !== null) {
      seenMaxOccurredMs = seenMaxOccurredMs === null
        ? pageMaxOccurredMs
        : Math.max(seenMaxOccurredMs, pageMaxOccurredMs);
    }

    pageIndex += 1;
    // Only trust the early-stop once ascending order is positively observed and
    // never violated. Under a proven-ascending feed, a row at/after `to` implies
    // every later row is too, so stop instead of paging (and paying credits)
    // through the rest of the forward history.
    if (input.to !== null && crossedWindowEnd && ascendingObserved && !ascendingViolated) {
      stopReason = "reached_window_end";
      break;
    }
    if (!page.hasNextPage) {
      break;
    }
    if (pageIndex >= input.maxApiPages) {
      stopReason = "page_cap";
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
    stopReason,
    budgetBlock,
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
): Promise<WriteBackfillOutcome> {
  if (input.rows.length === 0) {
    return { status: "written", writtenRows: 0 };
  }

  return withOfapiSpendTransactionPageLock(app.db, input.pageId, async (db) => {
    const eligibility = await loadWriteEligibility(db, {
      pageId: input.pageId,
      from: input.from,
      to: input.to,
    });
    if (!eligibility.eligible) {
      // Audit B3: eligibility can change between the pre-fetch check and this
      // in-lock re-check (credentials added, a non-OFAPI truth row inserted).
      // Surface it — with the FRESH in-lock counts — as a per-page blocked
      // result so the caller skips this page and continues the batch, instead of
      // throwing and aborting the run.
      return {
        status: "blocked" as const,
        reason: eligibility.reason ?? "not_eligible",
        hasCredentials: eligibility.hasCredentials,
        activeNonOfapiTransactions: eligibility.activeNonOfapiTransactions,
      };
    }

    // Audit (state precedence): OFAPI's transactions feed emits loading/pending
    // even for spend that has already settled, so a REST backfill can re-read a
    // transaction the webhook path already promoted to posted as `pending`. Since
    // pending and settled share the same transactionId, a blind upsert would
    // demote the canonical row (posted -> pending) and rebuild rollups from it.
    // Terminal state wins: skip pending rows whose row is already posted. (settled
    // and reversed always write — they either converge or upgrade in place.)
    const postedTransactionIds = await loadPostedTransactionIds(db, {
      pageId: input.pageId,
      transactionIds: input.rows
        .filter((row) => row.eventStatus === "pending")
        .map((row) => row.transactionId),
    });
    // Also drop a pending row when the SAME batch already carries a settled row
    // for the same transactionId (they share the bare id), so intra-batch write
    // order can't demote it either.
    const settledTransactionIds = new Set(
      input.rows
        .filter((row) => row.eventStatus === "settled")
        .map((row) => row.transactionId),
    );

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
      if (
        row.eventStatus === "pending" &&
        (postedTransactionIds.has(row.transactionId) || settledTransactionIds.has(row.transactionId))
      ) {
        continue;
      }
      const grossAmountMills = normalizeOfapiSpendAmountMills(row.eventStatus, row.grossAmountMills);
      const creatorNetAmountMills = normalizeOfapiSpendAmountMills(
        row.eventStatus,
        row.creatorNetAmountMills,
      );
      // Stage 14: fees carry the same reversal sign treatment as the amounts.
      const normalizeFee = (value: bigint | null) =>
        value === null ? null : normalizeOfapiSpendAmountMills(row.eventStatus, value);
      // Audit B2: the webhook→projection ingest path is canonical. The REST
      // backfill writes the SAME row shape for the same (transactionId,
      // eventStatus) — identical rawType (`ofapi:<category>`), canonicalType,
      // transactionState, rawStatus, and sourceUpdatedAt — so when both paths
      // touch a transaction the upsert converges instead of flipping the row's
      // type/state on every run. (Provenance lives in the histograms/report, not
      // in a divergent rawType.) The shared transactionId carries the
      // settled/pending/reversed distinction, so a pending REST row transitions
      // in place when the terminal projection later arrives, and vice versa.
      // W7.3: same guard wrapper as the webhook ingest — negatives are
      // suppressed when twinned/orphaned; settled positives run the fixup.
      const guarded = await upsertTransactionWithNegationGuards(db, {
        platformAccountId: input.pageId,
        source: "ofapi:rest",
        fanId: fanIdByPlatformUserId.get(row.fanPlatformUserId) ?? null,
        transactionId: row.transactionId,
        accountId: input.ofapiAccountId,
        correlationAccountId: row.fanPlatformUserId,
        rawType: `ofapi:${row.category}`,
        canonicalType: mapOfapiSpendCategoryToTransactionType(row.category, row.eventStatus),
        transactionState: mapOfapiSpendStatusToTransactionState(row.eventStatus),
        rawStatus: row.eventStatus,
        grossAmountMills,
        sourceDestinationAmountMills: grossAmountMills,
        creatorNetAmountMills,
        platformFeeMills: normalizeFee(row.platformFeeMills),
        vatAmountMills: normalizeFee(row.vatAmountMills),
        taxAmountMills: normalizeFee(row.taxAmountMills),
        senderId: row.fanPlatformUserId,
        occurredAt: row.occurredAt,
        sourceUpdatedAt: row.occurredAt,
      });
      dirtyFrom = dirtyFrom === null || row.occurredAt.getTime() < dirtyFrom.getTime()
        ? row.occurredAt
        : dirtyFrom;
      if (guarded.reactivatedFrom && (dirtyFrom === null || guarded.reactivatedFrom.getTime() < dirtyFrom.getTime())) {
        dirtyFrom = guarded.reactivatedFrom;
      }
      written += 1;
    }

    if (dirtyFrom) {
      await rebuildSpenderProjections(db, input.pageId, dirtyFrom);
      await rebuildRevenueRollups(db, input.pageId, dirtyFrom);
    }

    return { status: "written" as const, writtenRows: written };
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
    paginationStopReason: null,
    budgetBlock: null,
  };
}

export async function runOfapiTransactionsBackfill(
  app: AppContext,
  input: OfapiTransactionsBackfillInput,
): Promise<OfapiTransactionsBackfillResult> {
  const mode = input.mode ?? "dry-run";
  const limit = Math.min(input.limit ?? OFAPI_TRANSACTION_BACKFILL_LIMIT, OFAPI_TRANSACTION_BACKFILL_LIMIT);
  const maxApiPages = Math.max(1, input.maxApiPages ?? OFAPI_TRANSACTION_BACKFILL_MAX_PAGES);
  const to = input.to ?? null;
  const results: OfapiTransactionsBackfillPageResult[] = [];
  // One guard for the whole run (both modes — dry-run pays credits too): the
  // page caps bound the request count, so the request-cap block is set beyond
  // them and only the day budget / balance floor can stop the walk.
  const guard = createOfapiRestGuard(app, {
    maxRequestsPerRun: maxApiPages * Math.max(1, input.pageLabels.length),
    dailyCreditBudget:
      app.config.ofapiBackfillDailyCreditBudget ?? DEFAULT_BACKFILL_DAILY_CREDIT_BUDGET,
    budgetScope: "backfill",
  });

  // Audit B2: the backfill writes into the same `transactions` truth table as the
  // webhook→projection ingest, so its write mode is gated by the SAME master
  // switch. With ingest disabled we make ZERO OFAPI calls (no credit spend) and
  // report every page blocked; dry-run still runs so operators can preview spend
  // shape without enabling truth ingest.
  if (mode === "write" && !isOfapiSpendTransactionIngestEnabled(app.config)) {
    return {
      mode,
      from: input.from,
      to,
      pages: input.pageLabels.map((pageLabel) =>
        blockedPageResult({
          pageLabel,
          pageId: null,
          ofapiAccountId: null,
          reason: "ingest_disabled",
        })),
    };
  }

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

    const egress = await resolveEgress(app, { kind: "vendor", vendor: "ofapi" });
    let fetched: Awaited<ReturnType<typeof fetchBackfillRows>>;
    try {
      fetched = await fetchBackfillRows(app, {
        pageId: stored.page.id,
        ofapiAccountId: eligibility.ofapiAccountId,
        requestContext: {
          pageId: stored.page.id,
          dispatcher: egress.dispatcher,
          egressKey: egress.egressKey,
          creditBudgetScope: "backfill",
        },
        from: input.from,
        to,
        limit,
        maxApiPages,
        guard,
      });
    } finally {
      await egress.close();
    }
    const range = occurredRange(fetched.normalizedRows);
    const overlap = await calculateProjectionOverlap(app.db, {
      pageId: stored.page.id,
      rows: fetched.normalizedRows,
      from: input.from,
      to,
    });
    const writeOutcome: WriteBackfillOutcome | { status: "dry_run" } = mode === "write"
      ? await writeBackfillRows(app, {
        pageId: stored.page.id,
        ofapiAccountId: eligibility.ofapiAccountId,
        from: input.from,
        to,
        rows: fetched.normalizedRows,
      })
      : { status: "dry_run" };

    results.push({
      pageLabel,
      pageId: stored.page.id,
      ofapiAccountId: eligibility.ofapiAccountId,
      status: writeOutcome.status === "blocked"
        ? "blocked"
        : writeOutcome.status === "written"
          ? "written"
          : "dry_run",
      reason: writeOutcome.status === "blocked" ? writeOutcome.reason : null,
      // Surface the FRESH in-lock eligibility readout on a block (not the stale
      // pre-fetch one) so the operator sees why the page was skipped after it was
      // fetched.
      hasCredentials: writeOutcome.status === "blocked" ? writeOutcome.hasCredentials : false,
      activeNonOfapiTransactions: writeOutcome.status === "blocked"
        ? writeOutcome.activeNonOfapiTransactions
        : 0,
      apiPages: fetched.apiPages,
      rawRows: fetched.rawRows,
      normalizedRows: fetched.normalizedRows.length,
      skippedRows: fetched.rawRows - fetched.normalizedRows.length,
      writtenRows: writeOutcome.status === "written" ? writeOutcome.writtenRows : 0,
      minOccurredAt: range.min,
      maxOccurredAt: range.max,
      typeHistogram: fetched.typeHistogram,
      statusHistogram: fetched.statusHistogram,
      skippedReasons: fetched.skippedReasons,
      overlap,
      months: summarizeMonths(fetched.normalizedRows),
      paginationStopReason: fetched.stopReason,
      budgetBlock: fetched.budgetBlock,
    });
  }

  return {
    mode,
    from: input.from,
    to,
    pages: results,
  };
}
