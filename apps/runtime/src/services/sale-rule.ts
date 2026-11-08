import { SALE_RULE_SINCE_DAY, SALE_RULE_WAIT_DAYS } from "@agency_hub_core/contracts";
import { listSaleFacts, listSaleLastWriters, listShiftSales, type Database, type SaleFacts, type ShiftSale } from "@agency_hub_core/db";

import {
  SALE_LAST_WRITER_HOURS,
  dayOfWork,
  lastWriterQuery,
  readPeopleWork,
  workHoldsSale,
  type ComputedWork,
  type PersonWork,
} from "./chatter-shifts.ts";

/**
 * Whose a sale is — the one rule of «Заработок», the chatter statistics, «Разбор смены», the shift report and its
 * export («Выплаты»).
 *
 * THE OLD RULE, for every sale before SALE_RULE_SINCE_DAY and, after it, for every sale the team's rule says nothing
 * of: a sale is the money of the shift that holds it (chatter-shifts.ts `workHoldsSale`); one two shifts hold is the
 * one's who last wrote to its fan, neither — both of theirs (`settleSale`); one no shift holds is a look-in's whose
 * person last wrote to the fan, else nobody's.
 *
 * THE TEAM'S RULE (the owner, 2026-11-08), for the sales from SALE_RULE_SINCE_DAY 00:00 Moscow:
 * - a PPV a chatter sent (its message has them as the author, `listSaleFacts`) is theirs whoever's shift it was bought
 *   in — «долёт отправителю»: in their own shift or look-in that holds it; else in their shift going at the purchase,
 *   on another page; else in their next shift, if it begins within SALE_RULE_WAIT_DAYS (till then it is `waiting`,
 *   and later nobody's). So it is counted when it is bought, never back in a week already over: a week paid stays
 *   paid;
 * - a tip under a wall post and an OnlyFans Campaign contribution are the общак: no shift's, a line of their own in
 *   «Выплаты» (Hub cannot tell a donation goal's tip from any tip under a post: all of them);
 * - the rest, renewals included, by the old rule. A deal on one sale (50/50) is the owner's own amount in «Выплаты».
 * A shift of a Moscow day before SALE_RULE_SINCE_DAY keeps what the old rule gives it and takes nothing new: the
 * weeks before the rule do not move by a cent.
 *
 * Pure but for `readTeamSales`, which reads what the rule needs; database only and read-only.
 */

const DAY_MS = 86_400_000;
const WAIT_MS = SALE_RULE_WAIT_DAYS * DAY_MS;

/** 00:00 Moscow of SALE_RULE_SINCE_DAY: the first instant the team's rule settles. */
export const SALE_RULE_SINCE = Date.parse(`${SALE_RULE_SINCE_DAY}T00:00:00+03:00`);

/** What the team's rule reads of a sale. */
export interface SaleRuleFacts {
  /** The chatter who sent the PPV the fan bought; null — not a PPV, sent without an author, or not by a chatter. */
  ppvSender: { userId: number; username: string } | null;
  /** The общак: a tip under a wall post, an OnlyFans Campaign contribution; null — neither. */
  common: "post_tip" | "campaign" | null;
}

/** The rule's facts of a sale from `listSaleFacts`. Pure. */
export function saleRuleFactsOf(facts: Pick<SaleFacts, "ppvSender" | "postTip" | "campaign">): SaleRuleFacts {
  const sender = facts.ppvSender;
  return {
    ppvSender: sender !== null && sender.role === "chatter" ? { userId: sender.userId, username: sender.username } : null,
    common: facts.postTip ? "post_tip" : facts.campaign ? "campaign" : null,
  };
}

export type SaleVerdict = "mine" | "theirs" | "both" | "common";

/**
 * Whose a sale of the chatter's shift is, by who else's shifts hold it and who last wrote to its fan (null — nobody we
 * know of): the chatter's, a colleague's, or both of theirs. `rule` — the team's facts of the sale, when the team's
 * rule settles it: a chatter's PPV is its sender's, a post tip or a Campaign contribution the общак. Pure.
 */
export function settleSale(userId: number, others: readonly number[], lastWriter: number | null, rule: SaleRuleFacts | null = null): SaleVerdict {
  if (rule?.common) return "common";
  if (rule?.ppvSender) return rule.ppvSender.userId === userId ? "mine" : "theirs";
  if (others.length === 0 || lastWriter === userId) return "mine";
  return lastWriter !== null && others.includes(lastWriter) ? "theirs" : "both";
}

/** A person's shift or look-in. */
export interface Piece {
  userId: number;
  username: string;
  work: ComputedWork;
}

/**
 * Where a sale went. `pieces` — the shifts whose money it is (two when it counts for both), or a look-in; `bySender` —
 * the team's rule gave it to its PPV's sender (`nobody` too: their next shift did not come within the wait). `common` —
 * the общак. `waiting` — a chatter's PPV bought while they were off, till their next shift. `nobody` — no one's.
 */
export type SaleHome =
  | { kind: "pieces"; pieces: readonly Piece[]; bySender: boolean }
  | { kind: "common"; source: "post_tip" | "campaign" }
  | { kind: "waiting"; userId: number; username: string }
  | { kind: "nobody"; bySender: boolean };

/** Whether the team's rule placed the sale (a chatter's PPV, the общак), not the old one. Pure. */
export function byTeamRule(home: SaleHome): boolean {
  return home.kind === "common" || home.kind === "waiting" || home.bySender;
}

/** A piece of work of a Moscow day before the team's rule: it keeps the old rule's money. Pure. */
export function beforeSaleRule(work: Pick<ComputedWork, "startedAt" | "endedAt">): boolean {
  return dayOfWork(work) < SALE_RULE_SINCE_DAY;
}

/**
 * The home of one sale (see the file's head). `shifts`, `visits` — everyone's pieces around it, any order;
 * `lastWriter` — who last wrote to its fan, needed when two shifts hold it or a look-in is around it; `facts` — the
 * team's rule's, for a PPV or a tip from SALE_RULE_SINCE; `now` — till when a PPV may still wait. Pure.
 */
export function homeOfSale(sale: ShiftSale, input: {
  shifts: readonly Piece[];
  visits: readonly Piece[];
  lastWriter: number | null;
  facts: SaleRuleFacts | undefined;
  now: number;
}): SaleHome {
  const at = sale.occurredAt.getTime();
  const holds = (piece: Piece) => workHoldsSale(piece.work, { pageLabel: sale.pageLabel, at });
  const holders = input.shifts.filter(holds);
  const ids = holders.map((holder) => holder.userId);
  const old = holders.filter((holder) => settleSale(holder.userId, ids.filter((id) => id !== holder.userId), input.lastWriter) !== "theirs");
  const rule = at >= SALE_RULE_SINCE && !old.some((holder) => beforeSaleRule(holder.work)) ? input.facts : undefined;
  if (rule?.common) return { kind: "common", source: rule.common };
  if (rule?.ppvSender) return homeOfSender(sale, rule.ppvSender, input);
  if (old.length > 0) return { kind: "pieces", pieces: old, bySender: false };
  const visit = input.visits.find((piece) => holds(piece) && input.lastWriter === piece.userId);
  return visit === undefined ? { kind: "nobody", bySender: false } : { kind: "pieces", pieces: [visit], bySender: false };
}

/** A chatter's PPV: their own piece holding it, their shift going then, their next one within the wait. Pure. */
function homeOfSender(
  sale: ShiftSale,
  sender: { userId: number; username: string },
  input: { shifts: readonly Piece[]; visits: readonly Piece[]; now: number },
): SaleHome {
  const at = sale.occurredAt.getTime();
  const theirs = (piece: Piece) => piece.userId === sender.userId && !beforeSaleRule(piece.work);
  const holding = [...input.shifts, ...input.visits].find((piece) => theirs(piece) && workHoldsSale(piece.work, { pageLabel: sale.pageLabel, at }));
  const going = input.shifts.find((piece) => theirs(piece) && piece.work.startedAt <= at && at < piece.work.endedAt);
  const next = input.shifts
    .filter((piece) => theirs(piece) && piece.work.startedAt > at && piece.work.startedAt <= at + WAIT_MS)
    .sort((a, b) => a.work.startedAt - b.work.startedAt)[0];
  const piece = holding ?? going ?? next;
  if (piece !== undefined) return { kind: "pieces", pieces: [piece], bySender: true };
  return at + WAIT_MS > input.now ? { kind: "waiting", userId: sender.userId, username: sender.username } : { kind: "nobody", bySender: true };
}

export interface SettledHome {
  sale: ShiftSale;
  home: SaleHome;
}

/** Every sale's home, in the order given (see `homeOfSale`). Pure. */
export function homesOfSales(input: {
  sales: readonly ShiftSale[];
  shifts: readonly Piece[];
  visits: readonly Piece[];
  lastWriters: ReadonlyMap<number, number>;
  facts: ReadonlyMap<number, SaleRuleFacts>;
  now: number;
}): SettledHome[] {
  return input.sales.map((sale) => ({
    sale,
    home: homeOfSale(sale, {
      shifts: input.shifts,
      visits: input.visits,
      lastWriter: input.lastWriters.get(sale.transactionId) ?? null,
      facts: input.facts.get(sale.transactionId),
      now: input.now,
    }),
  }));
}

/** Each piece's money: the sales whose home it is, in the order given, by the piece's work. Pure. */
export function moneyOfPieces(settled: readonly SettledHome[]): Map<ComputedWork, ShiftSale[]> {
  const money = new Map<ComputedWork, ShiftSale[]>();
  for (const { sale, home } of settled) {
    if (home.kind !== "pieces") continue;
    for (const piece of home.pieces) {
      const known = money.get(piece.work);
      if (known === undefined) money.set(piece.work, [sale]);
      else known.push(sale);
    }
  }
  return money;
}

/** The sales that need who last wrote to the fan: two shifts hold it, or a look-in is around it (`lookInSalesOf`). Pure. */
export function salesNeedingWriter(sales: readonly ShiftSale[], shifts: readonly Piece[], visits: readonly Piece[]): ShiftSale[] {
  return sales.filter((sale) => {
    const holds = (piece: Piece) => workHoldsSale(piece.work, { pageLabel: sale.pageLabel, at: sale.occurredAt.getTime() });
    return shifts.filter(holds).length >= 2 || visits.some(holds);
  });
}

/** The sales the team's rule may move: a PPV or a tip from SALE_RULE_SINCE. Pure. */
export function salesTheRuleReads(sales: readonly ShiftSale[]): ShiftSale[] {
  return sales.filter((sale) => sale.occurredAt.getTime() >= SALE_RULE_SINCE && (sale.kind === "message_purchase" || sale.kind === "tip"));
}

/** The team's rule's facts of these sales (the PPV or tip ones from SALE_RULE_SINCE), by transaction. */
export async function readSaleRuleFacts(db: Database, sales: readonly ShiftSale[]): Promise<Map<number, SaleRuleFacts>> {
  const read = salesTheRuleReads(sales);
  const facts = await listSaleFacts(db, { transactionIds: read.map((sale) => sale.transactionId), lean: true });
  return new Map(facts.map((fact) => [fact.transactionId, saleRuleFactsOf(fact)]));
}

export interface TeamSales {
  /** Everyone's work over the read (on `pages`, as `readPeopleWork` cuts it). */
  people: Map<number, PersonWork>;
  shifts: Piece[];
  visits: Piece[];
  /** Every sale read, oldest first, with its home. */
  settled: SettledHome[];
  homeOf: Map<number, SaleHome>;
  /** Who last wrote to the fan, for the sales whose home needed it and `writersFor`. */
  lastWriters: Map<number, number>;
  /** A piece's money (one of `people`'s works): the sales whose home it is, oldest first. */
  moneyOf: (work: ComputedWork) => ShiftSale[];
}

/** Everyone's pieces of one kind. Pure. */
export function piecesOf(people: ReadonlyMap<number, PersonWork>, kind: ComputedWork["kind"]): Piece[] {
  return [...people].flatMap(([userId, person]) => person.work.filter((work) => work.kind === kind).map((work) => ({ userId, username: person.username, work })));
}

/**
 * The homes of the sales around [from, to): everyone's work SALE_RULE_WAIT_DAYS and a day more on each side (a PPV
 * bought before a shift of the window waits for it; one bought in the window may go to a shift after it), the sales of
 * `pages` from that far before `from` to a day after `to`. `writersFor` — sales whose last writer the caller wants too.
 */
export async function readTeamSales(
  db: Database,
  input: { from: Date; to: Date; now: Date; pages: "all" | readonly number[]; writersFor?: (sale: ShiftSale) => boolean },
): Promise<TeamSales> {
  const { now } = input;
  const margin = (SALE_RULE_WAIT_DAYS + 1) * DAY_MS;
  const people = await readPeopleWork(db, {
    from: new Date(input.from.getTime() - margin - DAY_MS),
    to: new Date(Math.min(now.getTime(), input.to.getTime() + margin)),
    now,
    pages: input.pages,
  });
  const shifts = piecesOf(people, "shift");
  const visits = piecesOf(people, "visit");
  const pageIds = input.pages === "all" ? [...new Set([...people.values()].flatMap((person) => [...person.pageIds.values()]))] : input.pages;
  const sales = await listShiftSales(db, {
    pageIds,
    from: new Date(input.from.getTime() - margin),
    to: new Date(Math.min(now.getTime(), input.to.getTime() + DAY_MS)),
  });
  const needed = new Set(salesNeedingWriter(sales, shifts, visits).map((sale) => sale.transactionId));
  const writersFor = input.writersFor;
  const [lastWriters, facts] = await Promise.all([
    listSaleLastWriters(db, {
      hours: SALE_LAST_WRITER_HOURS,
      sales: lastWriterQuery(sales.filter((sale) => needed.has(sale.transactionId) || (writersFor !== undefined && writersFor(sale)))),
    }),
    readSaleRuleFacts(db, sales),
  ]);
  const settled = homesOfSales({ sales, shifts, visits, lastWriters, facts, now: now.getTime() });
  const money = moneyOfPieces(settled);
  return {
    people,
    shifts,
    visits,
    settled,
    homeOf: new Map(settled.map((one) => [one.sale.transactionId, one.home])),
    lastWriters,
    moneyOf: (work) => money.get(work) ?? [],
  };
}

/**
 * What a piece lists as its sales — its shift report for the chatter to mark, a look-in in the statistics and among the
 * shifts «Выплаты» waits for: by the old rule every sale a shift holds (both chatters of an overlap mark it), and the
 * ones on a look-in's pages and time to a fan its person last wrote to (though a shift holds them too); by the team's
 * rule only the piece's money (the chatter's PPVs, wherever bought), never the общак or a colleague's PPV. A piece of a
 * day before the rule lists as it did. `lastWriters` — `readTeamSales`'s. Pure.
 */
export function reportSalesOf(
  team: { settled: readonly SettledHome[]; lastWriters: ReadonlyMap<number, number> },
  piece: { userId: number; work: ComputedWork },
): ShiftSale[] {
  const { work } = piece;
  const old = beforeSaleRule(work);
  return team.settled.filter(({ sale, home }) => {
    const inMoney = home.kind === "pieces" && home.pieces.some((one) => one.work === work);
    if (!old && byTeamRule(home)) return inMoney;
    if (inMoney) return true;
    if (!workHoldsSale(work, { pageLabel: sale.pageLabel, at: sale.occurredAt.getTime() })) return false;
    return work.kind === "shift" || team.lastWriters.get(sale.transactionId) === piece.userId;
  }).map((one) => one.sale);
}

/** One person's piece among `people` that is `work` (the same start), or the one overlapping it most. Pure. */
export function samePiece(people: ReadonlyMap<number, PersonWork>, userId: number, work: Pick<ComputedWork, "startedAt" | "endedAt">): ComputedWork | null {
  const pieces = people.get(userId)?.work ?? [];
  const same = pieces.find((piece) => piece.startedAt === work.startedAt);
  if (same !== undefined) return same;
  const overlap = (piece: ComputedWork) => Math.min(piece.endedAt, work.endedAt) - Math.max(piece.startedAt, work.startedAt);
  return pieces.filter((piece) => overlap(piece) > 0).sort((a, b) => overlap(b) - overlap(a))[0] ?? null;
}
