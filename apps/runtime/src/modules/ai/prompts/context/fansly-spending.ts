// chat-extension R20 HF-7г (parity row AI-145): the FAN SPENDING DATA block of a
// Fansly fan, built by the hub from its own ledger for a request that carries
// no `clientContext`.
//
// The reference is the block the released Fansly extension sends in
// `clientContext.fanSpendingData` (fansly-chat 2.10.1, `ff30d00`:
// `src/shared/earnings.ts` formatFanSpendingData, assembled in
// `src/background/operations.ts:2685-2785`). Line for line:
//
//   FAN SPENDING DATA:
//   Correlation account ID: <fan>
//   Total gross (all-time): $G
//   Total net (all-time): $N
//   Type breakdown (all-time):          when the fan has any row
//   - <type>: $gross                    largest first
//   Monthly totals:                     when the fan has any row
//   - <Mon YYYY>: $gross                newest first, every month
//   Monthly breakdown by type:          deep features only
//   - <Mon YYYY>: <type> $g, <type> $g  the twelve newest months
//
// What differs from the reference, by name:
//  - TYPE LABELS are the ledger's, not the extension's. The extension named the
//    raw codes 2110 "Subscription", 2116 "Subscription renewal", 7101 "Tip or
//    media purchase" and 15001 "Message tip / paid message"; in Fansly's own
//    client and in this ledger 2110/2116 are media purchases, 7101 tips and
//    15001 subscriptions (packages/shared/src/fansly-revenue-types.ts,
//    packages/fansly/src/mappers.ts). The hub labels a row by its canonical
//    type, in the words the OnlyFans block already uses; a row the ledger
//    cannot classify keeps the reference's `Unknown (type <code>)`.
//  - "(some months could not be fetched)" never appears: the extension asked
//    Fansly once per month, the hub reads every month in one query.
//  - The all-time lines are whole. The extension summed Fansly's per-fan stats
//    answer, which the platform cuts at 100 rows.
//
// Amounts are ledger mills; a dollar figure is `mills / 1000` to two places,
// the extension's own expression.

import { millsToDollarsNumber } from "@agency_hub_core/shared";

import { formatUsd } from "./spending.ts";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** The months a deep feature reads by type: the extension's twelve newest. */
export const FANSLY_SPENDING_BREAKDOWN_MONTHS = 12;

/** The ledger's canonical revenue types, in the words of the OnlyFans block. */
const LABEL_BY_CANONICAL_TYPE: Readonly<Record<string, string>> = {
  subscription: "Subscriptions",
  tip: "Tips",
  message_purchase: "Paid messages",
  post_purchase: "Paid posts",
  stream_tip: "Streams",
};

/** One ledger aggregate of a fan: a UTC month, a type, its sums in mills. */
export interface FanslySpendingLedgerRow {
  year: number;
  /** 1-based. */
  month: number;
  canonicalType: string;
  /** Fansly's raw type code, as the ledger keeps it. */
  rawType: string;
  grossMills: bigint;
  netMills: bigint;
}

export interface FanslySpendingTypeAmount {
  label: string;
  grossMills: bigint;
}

export interface FanslySpendingMonth {
  year: number;
  month: number;
  grossMills: bigint;
  /** Largest first. */
  breakdown: FanslySpendingTypeAmount[];
}

export interface FanslyFanSpendingData {
  /** The fan's Fansly account id. */
  fanId: string;
  totalGrossMills: bigint;
  totalNetMills: bigint;
  /** All-time, largest first. */
  breakdown: FanslySpendingTypeAmount[];
  /** Every month with a ledger row, newest first. */
  months: FanslySpendingMonth[];
  /** A deep feature (Recap, Review, the notes fill) also reads the newest
   *  months by type. */
  monthlyBreakdown: boolean;
}

export function fanslySpendingTypeLabel(row: Pick<FanslySpendingLedgerRow, "canonicalType" | "rawType">): string {
  return LABEL_BY_CANONICAL_TYPE[row.canonicalType] ?? `Unknown (type ${row.rawType})`;
}

/** Largest first; equal amounts by label, so the order never depends on the
 *  order the database returned its groups in. */
function largestFirst(amounts: Map<string, bigint>): FanslySpendingTypeAmount[] {
  return [...amounts.entries()]
    .map(([label, grossMills]) => ({ label, grossMills }))
    .sort((left, right) => (
      left.grossMills === right.grossMills
        ? (left.label < right.label ? -1 : 1)
        : left.grossMills > right.grossMills ? -1 : 1
    ));
}

function add(amounts: Map<string, bigint>, key: string, mills: bigint) {
  amounts.set(key, (amounts.get(key) ?? 0n) + mills);
}

/** The block's data from a fan's ledger aggregates. Sums stay in mills. */
export function buildFanslyFanSpendingData(input: {
  fanId: string;
  rows: readonly FanslySpendingLedgerRow[];
  deep: boolean;
}): FanslyFanSpendingData {
  let totalGrossMills = 0n;
  let totalNetMills = 0n;
  const allTime = new Map<string, bigint>();
  const months = new Map<string, { year: number; month: number; grossMills: bigint; byLabel: Map<string, bigint> }>();
  for (const row of input.rows) {
    const label = fanslySpendingTypeLabel(row);
    totalGrossMills += row.grossMills;
    totalNetMills += row.netMills;
    add(allTime, label, row.grossMills);
    const key = `${row.year}-${row.month}`;
    const month = months.get(key) ?? { year: row.year, month: row.month, grossMills: 0n, byLabel: new Map<string, bigint>() };
    month.grossMills += row.grossMills;
    add(month.byLabel, label, row.grossMills);
    months.set(key, month);
  }
  return {
    fanId: input.fanId,
    totalGrossMills,
    totalNetMills,
    breakdown: largestFirst(allTime),
    months: [...months.values()]
      .sort((left, right) => right.year - left.year || right.month - left.month)
      .map((month) => ({
        year: month.year,
        month: month.month,
        grossMills: month.grossMills,
        breakdown: largestFirst(month.byLabel),
      })),
    monthlyBreakdown: input.deep,
  };
}

function usd(mills: bigint): string {
  return formatUsd(millsToDollarsNumber(mills));
}

function monthLabel(month: Pick<FanslySpendingMonth, "year" | "month">): string {
  return `${MONTH_NAMES[month.month - 1]} ${month.year}`;
}

/** The block text. A fan without a ledger row reads the zero totals, as the
 *  extension's block did when Fansly answered with no earnings (the loader
 *  gives no block at all for an account the hub does not know). Does not
 *  escape: the prompt builder does. */
export function formatFanslyFanSpendingData(data: FanslyFanSpendingData): string {
  const lines: string[] = [
    "FAN SPENDING DATA:",
    `Correlation account ID: ${data.fanId}`,
    `Total gross (all-time): ${usd(data.totalGrossMills)}`,
    `Total net (all-time): ${usd(data.totalNetMills)}`,
  ];

  if (data.breakdown.length > 0) {
    lines.push("Type breakdown (all-time):");
    for (const entry of data.breakdown) {
      lines.push(`- ${entry.label}: ${usd(entry.grossMills)}`);
    }
  }

  if (data.months.length > 0) {
    lines.push("Monthly totals:");
    for (const month of data.months) {
      lines.push(`- ${monthLabel(month)}: ${usd(month.grossMills)}`);
    }
  }

  const byType = data.monthlyBreakdown ? data.months.slice(0, FANSLY_SPENDING_BREAKDOWN_MONTHS) : [];
  if (byType.length > 0) {
    lines.push("Monthly breakdown by type:");
    for (const month of byType) {
      const parts = month.breakdown.map((entry) => `${entry.label} ${usd(entry.grossMills)}`);
      lines.push(`- ${monthLabel(month)}: ${parts.join(", ")}`);
    }
  }

  return lines.join("\n");
}
