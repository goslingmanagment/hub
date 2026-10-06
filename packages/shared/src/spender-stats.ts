// Spenders statistics for one page (chat-extension H-8, metric version 1).
//
// The pure half of the definitions: calendar windows in the caller's IANA
// zone, money classification, tiers, silence, the awaiting-reply read state
// and coverage. The SQL half is packages/db/src/repositories/spender-stats.ts;
// the client routes (H-8b stats, H-8c awaiting reply) only serialise what it
// returns. The product definitions are chat-extension docs/architecture.md
// §8.7, with the hub corrections in chat-extension docs/hub-pr-plan.md §5
// item 12.
//
// Money is mills (bigint) end to end; the only division is the average check,
// which rounds once, here.

import { SPENDER_AUTO_LIST_BUCKETS } from "./spender-buckets.ts";
import {
  spenderAnalyticsTransactionTypes,
  transactionStates,
  transactionTypesByReportingBucket,
  type TransactionState,
  type TransactionType,
} from "./types.ts";

/** Bumped whenever a definition below changes what a number means. */
export const SPENDER_STATS_METRIC_VERSION = 1;
export const SPENDER_STATS_MONEY_UNIT = "USD-mills";
/** Totals are gross: what fans paid, before the platform fee. Net is a separate field. */
export const SPENDER_STATS_BASIS = "gross";

/** v1 serves one window length; the contract pins `windowDays` to it. */
export const SPENDER_STATS_WINDOW_DAYS = 30;
export const SPENDER_STATS_SUPPORTED_WINDOW_DAYS: readonly number[] = [SPENDER_STATS_WINDOW_DAYS];

/**
 * Every state counts: posted, pending and unknown. The hub's revenue rollups
 * and `/api/v2/spenders` include all three, and stats must reconcile with them.
 */
export const SPENDER_STATS_INCLUDED_STATES: readonly TransactionState[] = transactionStates;

/**
 * The transaction universe: the same types the revenue rollups and the
 * spender projections count (everything but payout reversals). Refunds and
 * chargebacks are in it with their negative amounts, so gross is already net
 * of them.
 */
export const SPENDER_STATS_TRANSACTION_TYPES: readonly TransactionType[] =
  spenderAnalyticsTransactionTypes;

/**
 * A purchase is a row of a revenue type with a positive gross amount.
 * Everything else in the universe (refunds, chargebacks, unclassified rows,
 * a negative row of a revenue type) is an adjustment, so
 * `grossMills = purchasesGrossMills + adjustmentsMills` holds exactly.
 */
export const SPENDER_STATS_PURCHASE_TYPES: readonly TransactionType[] =
  transactionTypesByReportingBucket.revenue;

/**
 * A payer of the page is a fan whose lifetime gross on it reaches the lowest
 * tier floor (10 mills): exactly the members of the hub's spender buckets, so
 * the Spenders shelves and these stats count the same people.
 */
export const SPENDER_STATS_PAYER_MIN_LIFETIME_GROSS_MILLS: bigint =
  SPENDER_AUTO_LIST_BUCKETS[0].minAmountMills;

/** Window spend by fans that belong to no tier (see `assembleSpenderStatsTiers`). */
export const SPENDER_STATS_UNTIERED_KEY = "untiered";
/** Window spend whose transaction names no fan. */
export const SPENDER_STATS_UNATTRIBUTED_KEY = "unattributed";

export const SPENDER_STATS_COVERAGE_STATES = ["complete", "partial", "unknown"] as const;
export type SpenderStatsCoverageState = (typeof SPENDER_STATS_COVERAGE_STATES)[number];

/**
 * Why coverage is not complete. Open on the wire: a client treats a reason it
 * does not know as "partial".
 * - `no_revenue_history`: the page has no transaction and its spender
 *   projection was never built, so nothing is known (state `unknown`).
 * - `projection_missing`: transactions exist but the spender projection was
 *   never built; tiers, silence and the queue read it.
 * - `projection_behind`: a transaction occurred after the projection was last
 *   rebuilt, so lifetime membership may lag the window totals. A row written
 *   late with an old date cannot lag unseen on OnlyFans: every writer there
 *   upserts and rebuilds in one transaction under the page lock
 *   (`withOfapiSpendTransactionPageLock`), and stats read one snapshot.
 * - `history_starts_in_window`: the page's oldest transaction is inside the
 *   window; earlier days may be missing and a "new" payer is only the first
 *   one observed.
 * - `messages_missing`: the page has payers but no message at all in the
 *   store(s) silence reads, so every payer's silence is unknown and the queue
 *   is empty for lack of data.
 */
export const SPENDER_STATS_COVERAGE_REASONS = [
  "no_revenue_history",
  "projection_missing",
  "projection_behind",
  "history_starts_in_window",
  "messages_missing",
] as const;
export type SpenderStatsCoverageReason = (typeof SPENDER_STATS_COVERAGE_REASONS)[number];

/**
 * Silence is counted in whole 24-hour periods from the payer's last TEXT
 * message to `asOf` — not from any message, which is where this deliberately
 * differs from the desktop. 8–21 whole days is one bucket, more than 21 the
 * other; fewer than 8 is not silence. No text message at all is `unknown`.
 * The lifetime spend of silent payers is context, not lost revenue.
 *
 * The messages are the ones a generation of the page reads
 * (`SpenderStatsMessageSource`), so the stats and the Ping chip of a chat do
 * not disagree about a fan who wrote a minute ago.
 */
export const SPENDER_SILENCE_MIN_DAYS = 8;
export const SPENDER_SILENCE_LONG_AFTER_DAYS = 21;
export const SPENDER_SILENCE_BUCKETS = ["d8to21", "over21", "unknown"] as const;
export type SpenderSilenceBucket = (typeof SPENDER_SILENCE_BUCKETS)[number];

/**
 * Where silence reads the fan's messages: the store(s) the page's AI
 * transcript is served from. `archive` is message_archive; `union` is the AI
 * transcript union with the webhook store (OnlyFans while the owner's
 * `aiTranscriptFreshUnionMode` is `serve`).
 */
export type SpenderStatsMessageSource = "archive" | "union";

/** `unknown`: the fan wrote after our last message, but whether we read it is not known. */
export const SPENDER_AWAITING_REPLY_READ_STATES = ["unread", "read", "unknown"] as const;
export type SpenderAwaitingReplyReadState = (typeof SPENDER_AWAITING_REPLY_READ_STATES)[number];

const MAX_TIME_ZONE_LENGTH = 64;
// IANA names only: "UTC", "Europe/Moscow", "America/Argentina/Buenos_Aires",
// "Etc/GMT+3". Offset strings ("+03:00"), which Intl also accepts, are not
// zones: they have no DST and Postgres reads their sign the other way round.
const IANA_TIME_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/**
 * The caller's zone, or null when it is not an IANA zone this runtime knows.
 * Only the letter case is canonicalised ("europe/moscow" → "Europe/Moscow"),
 * so the answer echoes the name the caller sent; Intl would also swap names
 * for their CLDR aliases ("Europe/Kyiv" → "Europe/Kiev").
 *
 * Intl is the only reader of the zone: `resolveSpenderStatsWindows` turns
 * the local dates into instants here and the SQL receives only those. The
 * hub's Postgres must not read it: its tzdata has no legacy links
 * ("Europe/Kiev", "Asia/Calcutta", "US/Pacific", which browsers still send)
 * and it takes "CET", "EET", "WET", "MET" as fixed-offset abbreviations,
 * where Intl reads them as zones with DST.
 */
export function normalizeSpenderStatsTimeZone(value: string): string | null {
  if (value.length === 0 || value.length > MAX_TIME_ZONE_LENGTH) return null;
  if (!IANA_TIME_ZONE_PATTERN.test(value)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return resolved.toLowerCase() === value.toLowerCase() ? resolved : value;
}

/** Inclusive range of local calendar dates (`YYYY-MM-DD`). */
export interface SpenderStatsDateRange {
  from: string;
  to: string;
}

export interface SpenderStatsWindows {
  timeZone: string;
  asOf: Date;
  windowDays: number;
  /** The window's local dates, ascending; the last one is today. */
  dates: string[];
  /**
   * The instant each of `dates` starts in the zone: its first second, which
   * is not local midnight when a DST change skips midnight.
   */
  dateStarts: Date[];
  /** The instant the date after today starts; the window never reads past `asOf`. */
  end: Date;
  /** Today so far: a partial day, it ends at `asOf`. */
  today: SpenderStatsDateRange;
  /** The last 7 dates, today included. */
  d7: SpenderStatsDateRange;
  /** The 7 dates before `d7`; the two never overlap. */
  prev7: SpenderStatsDateRange;
  /** The whole window: `windowDays` dates, today included. */
  d30: SpenderStatsDateRange;
}

function shiftLocalDate(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return [
    String(shifted.getUTCFullYear()).padStart(4, "0"),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function localDateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** The local date (`YYYY-MM-DD`) of an instant, by `formatter`'s zone. */
function localDateAt(formatter: Intl.DateTimeFormat, epochMs: number): string {
  let year = "";
  let month = "";
  let day = "";
  for (const part of formatter.formatToParts(epochMs)) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  return `${year.padStart(4, "0")}-${month}-${day}`;
}

const MS_PER_HOUR = 3_600_000;

/**
 * The first whole second whose local date is `date` or later. Local dates
 * never go backwards in time, so a bisection finds it, between 15 hours
 * before the UTC midnight of `date` and 37 hours after (offsets run from
 * −12 h to +14 h; a date the zone skipped, as Pacific/Apia did 2011-12-30,
 * comes out empty). The hub's `businessDateToUtcStart` corrects the offset
 * once and starts such dates an hour early when DST changes around local
 * midnight (Asia/Beirut and Asia/Jerusalem in spring, America/Santiago in
 * autumn), so it is not reused here.
 */
function startOfLocalDate(formatter: Intl.DateTimeFormat, date: string): Date {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(year, month - 1, day);
  let before = (utcMidnight - 15 * MS_PER_HOUR) / 1000;
  let atOrAfter = (utcMidnight + 37 * MS_PER_HOUR) / 1000;
  while (atOrAfter - before > 1) {
    const middle = Math.floor((before + atOrAfter) / 2);
    if (localDateAt(formatter, middle * 1000) >= date) atOrAfter = middle;
    else before = middle;
  }
  return new Date(atOrAfter * 1000);
}

/**
 * The calendar windows for one request. Dates are local to `timeZone`;
 * windows are whole calendar dates, so a DST change only makes one of them an
 * hour longer or shorter. Their instants are computed here, by the same Intl
 * that dates today, and the SQL buckets rows by those instants alone.
 */
export function resolveSpenderStatsWindows(input: {
  asOf: Date;
  timeZone: string;
  windowDays?: number;
}): SpenderStatsWindows {
  const timeZone = normalizeSpenderStatsTimeZone(input.timeZone);
  if (timeZone === null) {
    throw new RangeError(`Unsupported time zone "${input.timeZone}"`);
  }
  const windowDays = input.windowDays ?? SPENDER_STATS_WINDOW_DAYS;
  if (!SPENDER_STATS_SUPPORTED_WINDOW_DAYS.includes(windowDays)) {
    throw new RangeError(`Unsupported window of ${windowDays} days`);
  }
  if (Number.isNaN(input.asOf.getTime())) {
    throw new RangeError("asOf is not a valid instant");
  }

  const formatter = localDateFormatter(timeZone);
  const today = localDateAt(formatter, input.asOf.getTime());
  const dates = Array.from({ length: windowDays }, (_, index) =>
    shiftLocalDate(today, index - (windowDays - 1)));

  return {
    timeZone,
    asOf: input.asOf,
    windowDays,
    dates,
    dateStarts: dates.map((date) => startOfLocalDate(formatter, date)),
    end: startOfLocalDate(formatter, shiftLocalDate(today, 1)),
    today: { from: today, to: today },
    d7: { from: shiftLocalDate(today, -6), to: today },
    prev7: { from: shiftLocalDate(today, -13), to: shiftLocalDate(today, -7) },
    d30: { from: dates[0]!, to: today },
  };
}

/** One local date's money, from the transactions of that date. */
export interface SpenderStatsDayTotals {
  date: string;
  grossMills: bigint;
  purchasesGrossMills: bigint;
  adjustmentsMills: bigint;
  creatorNetMills: bigint;
  purchaseCount: number;
  /** Gross by transaction state; the three states sum to `grossMills`. */
  byState: Record<TransactionState, bigint>;
}

/** The SQL's per-(date, state) aggregate. */
export interface SpenderStatsDayStateRow {
  date: string;
  state: TransactionState;
  grossMills: bigint;
  purchasesGrossMills: bigint;
  creatorNetMills: bigint;
  purchaseCount: number;
}

function emptyByState(): Record<TransactionState, bigint> {
  return Object.fromEntries(
    SPENDER_STATS_INCLUDED_STATES.map((state) => [state, 0n]),
  ) as Record<TransactionState, bigint>;
}

/** One entry per window date, zero-filled, ascending. Rows outside the window are refused. */
export function assembleSpenderStatsDays(
  dates: readonly string[],
  rows: readonly SpenderStatsDayStateRow[],
): SpenderStatsDayTotals[] {
  const byDate = new Map<string, SpenderStatsDayTotals>(dates.map((date) => [date, {
    date,
    grossMills: 0n,
    purchasesGrossMills: 0n,
    adjustmentsMills: 0n,
    creatorNetMills: 0n,
    purchaseCount: 0,
    byState: emptyByState(),
  }]));
  for (const row of rows) {
    const day = byDate.get(row.date);
    if (!day) {
      throw new RangeError(`Aggregate for ${row.date} lies outside the window`);
    }
    day.grossMills += row.grossMills;
    day.purchasesGrossMills += row.purchasesGrossMills;
    day.adjustmentsMills += row.grossMills - row.purchasesGrossMills;
    day.creatorNetMills += row.creatorNetMills;
    day.purchaseCount += row.purchaseCount;
    day.byState[row.state] += row.grossMills;
  }
  return [...byDate.values()];
}

export interface SpenderStatsMoneyWindow {
  grossMills: bigint;
  purchasesGrossMills: bigint;
  adjustmentsMills: bigint;
  creatorNetMills: bigint;
  purchaseCount: number;
  /** Distinct fans with a purchase in the window; it cannot be summed from days. */
  payerCount: number;
}

/** Money of one window summed from its days; payers come from the SQL. */
export function sumSpenderStatsWindow(
  days: readonly SpenderStatsDayTotals[],
  range: SpenderStatsDateRange,
  payerCount: number,
): SpenderStatsMoneyWindow {
  const total: SpenderStatsMoneyWindow = {
    grossMills: 0n,
    purchasesGrossMills: 0n,
    adjustmentsMills: 0n,
    creatorNetMills: 0n,
    purchaseCount: 0,
    payerCount,
  };
  for (const day of days) {
    if (day.date < range.from || day.date > range.to) continue;
    total.grossMills += day.grossMills;
    total.purchasesGrossMills += day.purchasesGrossMills;
    total.adjustmentsMills += day.adjustmentsMills;
    total.creatorNetMills += day.creatorNetMills;
    total.purchaseCount += day.purchaseCount;
  }
  return total;
}

/** `(current − previous) / |previous|` in percent; null when the previous window is zero. */
export function spenderStatsDeltaPct(current: bigint, previous: bigint): number | null {
  if (previous === 0n) return null;
  const magnitude = previous < 0n ? -previous : previous;
  return (Number(current - previous) / Number(magnitude)) * 100;
}

/**
 * Average check: purchases gross over the number of purchases — adjustments
 * are not checks. Rounded half away from zero to whole mills; null without a
 * purchase.
 */
export function spenderStatsAverageCheckMills(
  purchasesGrossMills: bigint,
  purchaseCount: number,
): bigint | null {
  if (!Number.isSafeInteger(purchaseCount) || purchaseCount < 0) {
    throw new RangeError(`Invalid purchase count ${purchaseCount}`);
  }
  if (purchaseCount === 0) return null;
  const count = BigInt(purchaseCount);
  const negative = purchasesGrossMills < 0n;
  const magnitude = negative ? -purchasesGrossMills : purchasesGrossMills;
  const rounded = (2n * magnitude + count) / (2n * count);
  return negative ? -rounded : rounded;
}

export interface SpenderStatsTierCounts {
  /** Tiers: fans whose lifetime gross falls in the band, any time. Remainders: fans with window spend. */
  members: number;
  windowPayers: number;
  windowGrossMills: bigint;
}

export interface SpenderStatsTier extends SpenderStatsTierCounts {
  key: string;
  label: string;
  /** Inclusive lower bound of lifetime gross; null for the remainders. */
  minMills: bigint | null;
  /** Exclusive upper bound of lifetime gross; null for the top tier and the remainders. */
  maxMills: bigint | null;
}

const ZERO_TIER_COUNTS: SpenderStatsTierCounts = { members: 0, windowPayers: 0, windowGrossMills: 0n };

/**
 * The tier table: the hub's spender buckets in their order (membership by
 * lifetime gross, as the Spenders shelves), then two remainders so that the
 * window gross of all rows sums to the window total:
 * - `untiered`: window spend by fans in no tier — lifetime below the lowest
 *   floor (refunded to zero, say), a deleted account, or a fan the lifetime
 *   projection has not reached yet;
 * - `unattributed`: window spend whose transaction names no fan; it has no
 *   members and no payers.
 * Every row is always present, zero when empty.
 */
export function assembleSpenderStatsTiers(input: {
  byTierKey: ReadonlyMap<string, SpenderStatsTierCounts>;
  untiered: SpenderStatsTierCounts;
  unattributedGrossMills: bigint;
}): SpenderStatsTier[] {
  const known = new Set<string>(SPENDER_AUTO_LIST_BUCKETS.map((bucket) => bucket.key));
  for (const key of input.byTierKey.keys()) {
    if (!known.has(key)) throw new RangeError(`Unknown spender tier "${key}"`);
  }
  return [
    ...SPENDER_AUTO_LIST_BUCKETS.map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      minMills: bucket.minAmountMills,
      maxMills: bucket.maxAmountMillsExclusive,
      ...(input.byTierKey.get(bucket.key) ?? ZERO_TIER_COUNTS),
    })),
    {
      key: SPENDER_STATS_UNTIERED_KEY,
      label: "Untiered",
      minMills: null,
      maxMills: null,
      ...input.untiered,
    },
    {
      key: SPENDER_STATS_UNATTRIBUTED_KEY,
      label: "Unattributed",
      minMills: null,
      maxMills: null,
      members: 0,
      windowPayers: 0,
      windowGrossMills: input.unattributedGrossMills,
    },
  ];
}

/**
 * The silence bucket for a payer silent for `wholeDays` whole 24-hour
 * periods (null: no text message from the fan in the archive). `recent` is
 * not silence and is not reported.
 */
export function classifySpenderSilence(wholeDays: number | null): SpenderSilenceBucket | "recent" {
  if (wholeDays === null) return "unknown";
  if (wholeDays < SPENDER_SILENCE_MIN_DAYS) return "recent";
  if (wholeDays <= SPENDER_SILENCE_LONG_AFTER_DAYS) return "d8to21";
  return "over21";
}

/**
 * Read state of a chat whose fan wrote after our last message, from the
 * chat's own row: a positive unread count is unread; a zero count is "read"
 * only when the row's head is that fan message, otherwise the row lags the
 * timestamps and the count says nothing (`unknown`, and no count is served).
 */
export function deriveAwaitingReplyReadState(input: {
  unreadCount: number;
  lastMessageSenderRole: string;
}): { readState: SpenderAwaitingReplyReadState; unreadCount: number | null } {
  if (input.unreadCount > 0) return { readState: "unread", unreadCount: input.unreadCount };
  if (input.lastMessageSenderRole === "fan") return { readState: "read", unreadCount: 0 };
  return { readState: "unknown", unreadCount: null };
}

export interface SpenderStatsCoverage {
  state: SpenderStatsCoverageState;
  reasons: SpenderStatsCoverageReason[];
}

/** Coverage of one stats answer; the reasons are in `SPENDER_STATS_COVERAGE_REASONS` order. */
export function deriveSpenderStatsCoverage(input: {
  /** The newest transaction of the page in the universe; null when it has none. */
  newestTransactionAt: Date | null;
  /** The page has a transaction older than the window's first date. */
  historyBeforeWindow: boolean;
  /** When the spender projection was last rebuilt; null when never. */
  projectionAsOf: Date | null;
  payerCount: number;
  hasArchivedMessages: boolean;
}): SpenderStatsCoverage {
  if (input.newestTransactionAt === null && input.projectionAsOf === null) {
    return { state: "unknown", reasons: ["no_revenue_history"] };
  }
  const reasons: SpenderStatsCoverageReason[] = [];
  if (input.newestTransactionAt !== null) {
    if (input.projectionAsOf === null) {
      reasons.push("projection_missing");
    } else if (input.newestTransactionAt.getTime() > input.projectionAsOf.getTime()) {
      reasons.push("projection_behind");
    }
    if (!input.historyBeforeWindow) reasons.push("history_starts_in_window");
  }
  if (input.payerCount > 0 && !input.hasArchivedMessages) reasons.push("messages_missing");
  return { state: reasons.length === 0 ? "complete" : "partial", reasons };
}
