/**
 * Which line of a person's reports pays which of their sales: the one pairing «Смены»' note (shift-report-notes.ts)
 * and the comparison tool (sale-rule-compare.ts) both read. Pure.
 *
 * People are paid by the day's report: the breakdown the chat agent saves to the agency ledger, a line a sale. A line
 * names its sale by a reference — the platform's reference of the transaction, or Hub's own id of it (the ledger
 * holds both as one sale, its internal/hub/salerefs.go). An amount added by hand before the agent's script wrote a
 * reference names its sale only in words («долёт ппв 01:05»): it is the sale of the same page and amount whose Moscow
 * time stands in those words.
 *
 *  1. A counted line with a reference pays the sale of that reference, Hub's id before the platform's (as the ledger
 *     reads a string that could be both). A reference that is none of these sales pays none of them: it never falls
 *     back to the words.
 *  2. Then a counted line without a reference pays at most one sale still unpaid: the same page, the same amount to the
 *     cent, its Moscow `HH:MM` in the line's words; of several the earliest.
 *
 * A line pays at most one sale and a sale is paid by at most one line (the first in the order given: a second line of
 * the same sale pays nothing). A line held out of its report's sum pays nothing and is nowhere in the answer.
 */

/**
 * Which reports may pay a sale: those dated from this many Moscow days before the sale's shift day (a night's report
 * may be dated a day off the shift) to this many after it (a late sale is paid in a later report: a PPV waits for its
 * sender up to a week). Whoever pairs reads the reports of the days it asks about this far around them — and, the
 * mirror of it, the sales this far around the reports it judges.
 */
export const REPORTS_BEFORE_DAYS = 2;
export const REPORTS_AFTER_DAYS = 8;

/** A person's sale by the rule, as much as the pairing reads. Each sale once. */
export interface PairSale {
  /** Hub's own id of the sale, as text. */
  hubRef: string;
  /** The platform's reference of its transaction; null — Hub does not know it. */
  platformRef: string | null;
  pageLabel: string;
  /** What of it is the person's by the rule, mills: the whole net but a split's. */
  netMills: number;
  /** When the fan paid, ms. */
  occurredAt: number;
}

/** A line of a person's report. */
export interface PairLine {
  /** The sale it names: the platform's reference or Hub's id; null — none (an amount added by hand, in words). */
  ref: string | null;
  pageLabel: string;
  netMills: number;
  /** In the report's sum. */
  counted: boolean;
  /** An added amount's words. */
  what: string;
}

export interface ReportLinePairs<Sale, Line> {
  /** Each paid sale and the line that pays it. */
  paidBy: Map<Sale, Line>;
  /** The sales no line pays, in the order given. */
  unpaid: Sale[];
  /** The counted lines that pay none of the sales, in the order given. */
  loose: Line[];
}

const MOSCOW_OFFSET_MS = 3 * 3_600_000;

/** `01:05`: the Moscow clock of an instant. Moscow keeps UTC+3 all year. */
function moscowClock(at: number): string {
  return new Date(at + MOSCOW_OFFSET_MS).toISOString().slice(11, 16);
}

/** Whether the words name this time: `HH:MM` on its own, not the tail of a longer number («101:05» is not 01:05). */
function namesTime(what: string, clock: string): boolean {
  for (let at = what.indexOf(clock); at >= 0; at = what.indexOf(clock, at + 1)) {
    const before = what[at - 1];
    const after = what[at + clock.length];
    if (!(before !== undefined && /\d/.test(before)) && !(after !== undefined && /\d/.test(after))) return true;
  }
  return false;
}

/**
 * The same amount to the cent. A sale keeps its thousandths, an amount typed by hand is whole cents — cut as Hub
 * prints money, or rounded: either reading of the sale's cents is the same amount.
 */
function sameCents(left: number, right: number): boolean {
  return Math.trunc(left / 10) === Math.trunc(right / 10) || Math.round(left / 10) === Math.round(right / 10);
}

export function pairReportLines<Sale extends PairSale, Line extends PairLine>(sales: readonly Sale[], lines: readonly Line[]): ReportLinePairs<Sale, Line> {
  const byHub = new Map<string, Sale>();
  const byPlatform = new Map<string, Sale>();
  for (const sale of sales) {
    if (!byHub.has(sale.hubRef)) byHub.set(sale.hubRef, sale);
    if (sale.platformRef !== null && sale.platformRef !== "" && !byPlatform.has(sale.platformRef)) byPlatform.set(sale.platformRef, sale);
  }
  const paidBy = new Map<Sale, Line>();
  const pays = new Set<Line>();
  const refOf = (line: Line) => {
    const ref = line.ref?.trim() ?? "";
    return ref === "" ? null : ref;
  };

  // 1. By reference.
  for (const line of lines) {
    const ref = refOf(line);
    if (!line.counted || ref === null) continue;
    const sale = byHub.get(ref) ?? byPlatform.get(ref);
    if (sale === undefined || paidBy.has(sale)) continue;
    paidBy.set(sale, line);
    pays.add(line);
  }

  // 2. By the words: the page, the amount to the cent, the sale's Moscow time.
  const byTime = [...sales].sort((left, right) => left.occurredAt - right.occurredAt);
  for (const line of lines) {
    if (!line.counted || refOf(line) !== null) continue;
    const sale = byTime.find((one) => !paidBy.has(one) && one.pageLabel === line.pageLabel && sameCents(one.netMills, line.netMills)
      && namesTime(line.what, moscowClock(one.occurredAt)));
    if (sale === undefined) continue;
    paidBy.set(sale, line);
    pays.add(line);
  }

  return {
    paidBy,
    unpaid: sales.filter((sale) => !paidBy.has(sale)),
    loose: lines.filter((line) => line.counted && !pays.has(line)),
  };
}
