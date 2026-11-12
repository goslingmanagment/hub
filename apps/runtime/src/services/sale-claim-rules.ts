import { formatUsdFromMills } from "@agency_hub_core/shared";

import type { RuleMark } from "./sale-rule.ts";
import { halvesOf, splitShares } from "./sale-rule.ts";
import { dayWords, pageSums } from "./shift-handin-rules.ts";

/**
 * Заявки и договорённости (ecosystem plan 2026-11-12, package G), pure: which
 * statements of handed-in reports touch another person and who the other side
 * is, whether a claim still stands, what the people's statements and the
 * owner's decisions give the one rule as its inputs, and what a settled claim
 * makes of a report's version. No database (tests/sale-claim-rules.test.ts);
 * sale-claims.ts reads the reports and writes the claims.
 *
 * A claim is one of:
 *  - «моё» the report counts as disputed (F1 flags it: the rule or another
 *    person's handed-in report gives it to someone else): the other side is
 *    whom the rule gave it to at the hand-in, the sender of a PPV that waits,
 *    and every other person whose newest report counts it; none of them — the
 *    owner's alone (a pot's sale, one the facts do not settle);
 *  - «делим с …»: the colleague named;
 *  - a sale the newest reports count for more than its net, no claim between
 *    the two (kind double, the owner's at once): the later hand-in against the
 *    earlier one.
 * A lone «моё» on a junction sale the rule leaves to the owner and on a
 * nobody's sale is no claim: the rule settles the first (Go's marks), the
 * second counts plainly.
 */

/** A line of a report's newest version, as a claim reads it. */
export interface ReportLine {
  transactionId: number | null;
  pageLabel: string | null;
  netMills: number;
  amountMills: number;
  group: "mine" | "near";
  statement: "mine" | "not_mine" | "share" | null;
  shareWithUserId: number | null;
  note: string | null;
  disputed: boolean;
  settled?: "agreed" | "owner";
  rule: { home: string; reason: string; shareMills: number; toUserId: number | null; senderUserId: number | null };
}

/** A report's newest version, as a claim reads it. */
export interface ReportView {
  handinId: number;
  shiftId: number;
  userId: number;
  version: number;
  submittedAt: number;
  lines: readonly ReportLine[];
}

export type ClaimKind = "claim" | "double";

/** A claim the reports make. */
export interface DerivedClaim {
  kind: ClaimKind;
  transactionId: number;
  pageLabel: string | null;
  claimantUserId: number;
  claimantHandinId: number;
  claimantShiftId: number;
  claimantVersion: number;
  statement: "mine" | "share" | null;
  shareWithUserId: number | null;
  note: string | null;
  claimedAt: number;
  /** The other side; null — nobody to ask: the owner's at once. */
  sideUserId: number | null;
  /** The side's report that counts the sale, if any. */
  sideShiftId: number | null;
}

const counts = (line: ReportLine) => line.transactionId !== null && line.amountMills > 0;

/** The claims the newest versions of the handed-in reports make. Pure. */
export function deriveClaims(reports: readonly ReportView[]): DerivedClaim[] {
  const bySale = new Map<number, Array<{ report: ReportView; line: ReportLine }>>();
  for (const report of reports) {
    for (const line of report.lines) {
      if (!counts(line)) continue;
      const list = bySale.get(line.transactionId!) ?? [];
      list.push({ report, line });
      bySale.set(line.transactionId!, list);
    }
  }
  const out: DerivedClaim[] = [];
  const pairs = new Set<string>();
  const pairKey = (sale: number, a: number, b: number) => `${sale}:${Math.min(a, b)}:${Math.max(a, b)}`;
  const base = (report: ReportView, line: ReportLine) => ({
    transactionId: line.transactionId!,
    pageLabel: line.pageLabel,
    claimantUserId: report.userId,
    claimantHandinId: report.handinId,
    claimantShiftId: report.shiftId,
    claimantVersion: report.version,
    note: line.note,
    claimedAt: report.submittedAt,
  });
  for (const [sale, held] of bySale) {
    for (const { report, line } of held) {
      if (line.settled !== undefined) continue;
      const others = held.filter((one) => one.report.userId !== report.userId);
      if (line.statement === "share" && line.shareWithUserId !== null && line.shareWithUserId !== report.userId) {
        const side = line.shareWithUserId;
        const sideReport = others.find((one) => one.report.userId === side)?.report ?? null;
        out.push({ ...base(report, line), kind: "claim", statement: "share", shareWithUserId: side, sideUserId: side, sideShiftId: sideReport?.shiftId ?? null });
        pairs.add(pairKey(sale, report.userId, side));
        continue;
      }
      if (line.statement !== "mine" || !line.disputed) continue;
      const sides = new Map<number, number | null>();
      if (line.rule.toUserId !== null && line.rule.toUserId !== report.userId) sides.set(line.rule.toUserId, null);
      if (line.rule.home === "waiting" && line.rule.senderUserId !== null && line.rule.senderUserId !== report.userId) sides.set(line.rule.senderUserId, null);
      for (const other of others) sides.set(other.report.userId, other.report.shiftId);
      for (const [userId, known] of sides) {
        const shiftId = known ?? others.find((one) => one.report.userId === userId)?.report.shiftId ?? null;
        out.push({ ...base(report, line), kind: "claim", statement: "mine", shareWithUserId: null, sideUserId: userId, sideShiftId: shiftId });
        pairs.add(pairKey(sale, report.userId, userId));
      }
      if (sides.size === 0 && line.rule.home !== "nobody" && line.rule.home !== "decide") {
        out.push({ ...base(report, line), kind: "claim", statement: "mine", shareWithUserId: null, sideUserId: null, sideShiftId: null });
      }
    }
    // Counted for more than its net in all: a dispute by itself, the later hand-in against the earlier one.
    const total = held.reduce((sum, one) => sum + one.line.amountMills, 0);
    const net = held[0]!.line.netMills;
    if (total <= net) continue;
    const ordered = [...held].sort((a, b) => a.report.submittedAt - b.report.submittedAt || a.report.handinId - b.report.handinId);
    for (let later = 1; later < ordered.length; later += 1) {
      for (let earlier = 0; earlier < later; earlier += 1) {
        const a = ordered[later]!;
        const b = ordered[earlier]!;
        if (a.report.userId === b.report.userId || pairs.has(pairKey(sale, a.report.userId, b.report.userId))) continue;
        if (a.line.settled !== undefined && b.line.settled !== undefined) continue;
        pairs.add(pairKey(sale, a.report.userId, b.report.userId));
        out.push({ ...base(a.report, a.line), kind: "double", statement: null, shareWithUserId: null, sideUserId: b.report.userId, sideShiftId: b.report.shiftId });
      }
    }
  }
  return out;
}

/** What a stored claim is, as `claimStands` reads it. */
export interface ClaimView {
  kind: "claim" | "double" | "imported";
  transactionId: number | null;
  claimantUserId: number | null;
  claimantHandinId: number | null;
  sideUserId: number | null;
  statement: "mine" | "share" | null;
  shareWithUserId: number | null;
  state: "asked" | "agreed" | "owner" | "decided" | "withdrawn";
  answer: "agree" | "disagree" | null;
}

/**
 * Whether a claim still stands: its report's newest version still counts the sale (a double: the reports still count it
 * for more than its net). A claim the owner decided or the person withdrew is over either way. Pure.
 */
export function claimStands(claim: ClaimView, reports: readonly ReportView[]): boolean {
  if (claim.kind === "imported") return claim.state === "owner";
  if (claim.transactionId === null) return false;
  const own = reports.find((report) => report.handinId === claim.claimantHandinId);
  const line = own?.lines.find((one) => one.transactionId === claim.transactionId);
  if (line === undefined || line.amountMills <= 0) return false;
  if (claim.kind === "claim") return true;
  const held = reports.flatMap((report) => report.lines.filter((one) => one.transactionId === claim.transactionId && one.amountMills > 0));
  return held.reduce((sum, one) => sum + one.amountMills, 0) > line.netMills;
}

/**
 * The people's statements as the rule's marks (each confirmed: in a handed-in report or an answer), by sale: the
 * newest version's statements of every report, and over them the claims' — the claimant's word while the claim
 * stands, the other side's agreement («не моё» to a «моё», «делим» back to a «делим»). Pure.
 */
export function ruleMarksOf(input: { reports: readonly ReportView[]; claims: readonly ClaimView[] }): Map<number, RuleMark[]> {
  const bySale = new Map<number, Map<number, RuleMark>>();
  const put = (sale: number, mark: RuleMark) => {
    const marks = bySale.get(sale) ?? new Map<number, RuleMark>();
    marks.set(mark.userId, mark);
    bySale.set(sale, marks);
  };
  for (const report of input.reports) {
    for (const line of report.lines) {
      if (line.transactionId === null || line.statement === null) continue;
      put(line.transactionId, {
        userId: report.userId, mark: line.statement, shareWith: line.statement === "share" ? line.shareWithUserId : null, ownAmountMills: null, confirmed: true,
      });
    }
  }
  for (const claim of input.claims) {
    if (claim.kind !== "claim" || claim.transactionId === null || claim.claimantUserId === null || claim.statement === null) continue;
    if (claim.state === "withdrawn") continue;
    put(claim.transactionId, {
      userId: claim.claimantUserId, mark: claim.statement, shareWith: claim.statement === "share" ? claim.shareWithUserId : null, ownAmountMills: null, confirmed: true,
    });
    if (claim.answer === "agree" && claim.sideUserId !== null) {
      put(claim.transactionId, claim.statement === "share"
        ? { userId: claim.sideUserId, mark: "share", shareWith: claim.claimantUserId, ownAmountMills: null, confirmed: true }
        : { userId: claim.sideUserId, mark: "not_mine", shareWith: null, ownAmountMills: null, confirmed: true });
    }
  }
  return new Map([...bySale].map(([sale, marks]) => [sale, [...marks.values()]]));
}

/** An owner's decision as the rule reads it. */
export interface DecisionView {
  kind: "split" | "nobody" | "pot";
  shares: ReadonlyArray<{ userId: number; percent: number }>;
  pot: string | null;
  /** The sale's home when decided. */
  ruleHome: string | null;
}

/**
 * An owner's decision as the rule's inputs: a whole sale given on a sale that was nobody's is his claim of it
 * (`claimedBy`: it stops applying when later facts find a holder); any other split is `resolution` (it always
 * applies); «никому» and a pot are their own inputs. Pure.
 */
export function ruleDecisionOf(decision: DecisionView): { resolution: Array<{ userId: number; percent: number }> | null; claimedBy: number | null; ownerNobody: boolean; ownerPot: string | null } {
  if (decision.kind === "nobody") return { resolution: null, claimedBy: null, ownerNobody: true, ownerPot: null };
  if (decision.kind === "pot") return { resolution: null, claimedBy: null, ownerNobody: false, ownerPot: decision.pot };
  const shares = decision.shares.filter((share) => share.percent > 0);
  if (shares.length === 1 && shares[0]!.percent === 100 && decision.ruleHome === "nobody") {
    return { resolution: null, claimedBy: shares[0]!.userId, ownerNobody: false, ownerPot: null };
  }
  return { resolution: shares.map((share) => ({ userId: share.userId, percent: share.percent })), claimedBy: null, ownerNobody: false, ownerPot: null };
}

// ── The owner's four answers ─────────────────────────────────────────────────

export type OwnerOutcome = "first" | "second" | "half" | "nobody";

/**
 * The owner's answer as a decision: «первому» — the claimant whole, «второму» — the other side whole, «пополам» — the
 * two in halves (the odd mill as the rule gives it: to the lower user id), «никому». The shares in user-id order. Pure.
 */
export function decisionOfOutcome(outcome: OwnerOutcome, first: number, second: number | null): { kind: "split" | "nobody"; shares: Array<{ userId: number; percent: number }> } {
  if (outcome === "nobody") return { kind: "nobody", shares: [] };
  if (outcome === "first") return { kind: "split", shares: [{ userId: first, percent: 100 }] };
  if (second === null) throw new Error("this dispute has no second side");
  if (outcome === "second") return { kind: "split", shares: [{ userId: second, percent: 100 }] };
  const [low, high] = first < second ? [first, second] : [second, first];
  return { kind: "split", shares: [{ userId: low, percent: 50 }, { userId: high, percent: 50 }] };
}

/** What a person's share of a sale is after a decision or an agreement: the rule's own arithmetic. Pure. */
export function shareAfter(input: { netMills: number; userId: number; outcome: OwnerOutcome | "agreed"; first: number; second: number | null; statement: "mine" | "share" | null }): number {
  const { netMills: net, userId } = input;
  if (input.outcome === "agreed") {
    if (input.statement === "share" && input.second !== null) return halvesOf(net, input.first, input.second).find((half) => half.userId === userId)?.mills ?? 0;
    return userId === input.first ? net : 0;
  }
  const decision = decisionOfOutcome(input.outcome, input.first, input.second);
  if (decision.kind === "nobody") return 0;
  return splitShares(net, decision.shares).find((share) => share.userId === userId)?.mills ?? 0;
}

/**
 * What a settled sale gives a person in every later draft and version (review R2-a): the owner's active decision over
 * every person (their share by it, 0 when they have none; «никому» and a pot give no person anything), else an
 * agreement over its two parties (`shareAfter`'s arithmetic, the one `settleReport` wrote). Null — not settled for
 * this person: their words count as before. Contesting it again is a new claim, never a side effect of a hand-in.
 * `userIds` — the person's logins. Pure.
 */
export function settledShareOf(input: {
  netMills: number;
  userIds: ReadonlySet<number>;
  decision: Pick<DecisionView, "kind" | "shares"> | null;
  agreed: ReadonlyArray<{ claimantUserId: number | null; sideUserId: number | null; statement: "mine" | "share" | null }>;
}): { amountMills: number; settled: "owner" | "agreed" } | null {
  if (input.decision !== null) {
    if (input.decision.kind !== "split") return { amountMills: 0, settled: "owner" };
    const shares = splitShares(input.netMills, input.decision.shares.filter((share) => share.percent > 0));
    return { amountMills: shares.filter((share) => input.userIds.has(share.userId)).reduce((sum, share) => sum + share.mills, 0), settled: "owner" };
  }
  for (const claim of input.agreed) {
    if (claim.claimantUserId === null || claim.sideUserId === null) continue;
    const party = input.userIds.has(claim.claimantUserId) ? claim.claimantUserId : input.userIds.has(claim.sideUserId) ? claim.sideUserId : null;
    if (party === null) continue;
    const amountMills = shareAfter({ netMills: input.netMills, userId: party, outcome: "agreed", first: claim.claimantUserId, second: claim.sideUserId, statement: claim.statement });
    return { amountMills, settled: "agreed" };
  }
  return null;
}

/** A version's lines with one sale's line settled at an amount, and the sums made again. Pure. */
export function settledVersion(input: {
  lines: readonly ReportLine[];
  pages: readonly string[];
  offPlatform: ReadonlyArray<{ amountMills: number; state: string; pageLabel?: string | null }>;
  transactionId: number;
  amountMills: number;
  settled: "agreed" | "owner";
}): { lines: ReportLine[]; pages: Array<{ pageLabel: string; amountMills: number }>; totalMills: number } {
  const lines = input.lines.map((line) => (line.transactionId === input.transactionId
    ? { ...line, amountMills: input.amountMills, disputed: false, settled: input.settled }
    : line));
  return { lines, ...reportSums(lines, input.pages, input.offPlatform) };
}

/**
 * A report's page sums (shift-handin-rules.ts `pageSums`, the one place a report's numbers are made): the counted lines
 * and, on its page, each «мимо площадки» the owner confirmed. Pure.
 */
export function reportSums(
  lines: ReadonlyArray<{ pageLabel: string | null; amountMills: number; group?: string }>,
  pages: readonly string[],
  offPlatform: ReadonlyArray<{ amountMills: number; state: string; pageLabel?: string | null }> = [],
) {
  const counted = lines.filter((line) => line.group === "mine" || line.amountMills !== 0);
  const confirmed = offPlatform
    .filter((line) => line.state === "confirmed" && typeof line.pageLabel === "string" && line.pageLabel !== "")
    .map((line) => ({ pageLabel: line.pageLabel!, amountMills: line.amountMills }));
  return pageSums([...counted, ...confirmed], pages);
}

// ── Words ────────────────────────────────────────────────────────────────────

const money = (mills: number) => formatUsdFromMills(mills);

/** «PPV», «подписку», «чаевые»: a sale's kind as the object of a sentence. */
export function saleKindAccusative(kind: string): string {
  switch (kind) {
    case "message_purchase": return "PPV";
    case "post_purchase": return "покупку поста";
    case "subscription": return "подписку";
    case "tip":
    case "stream_tip": return "чаевые";
    default: return "продажу";
  }
}

/**
 * The other side's matter: «Катя считает своей продажу: PPV, фан, $36.00, 11 нояб.» or «Катя делит с вами …».
 * `fan` — the fan's name or login, null — not known.
 */
export function claimTitle(input: { claimant: string; statement: "mine" | "share"; kind: string; fan: string | null; netMills: number; day: string }): string {
  const what = [saleKindAccusative(input.kind), input.fan, money(input.netMills), dayWords(input.day)].filter((part): part is string => part !== null && part !== "").join(", ");
  if (input.statement === "share") return `${input.claimant} делит с вами пополам: ${what}`;
  return `${input.claimant} считает своей: ${what}`;
}

/** The owner's matter: «Спор о продаже: Катя и Алекс, PPV, $36.00, 11 нояб.». */
export function disputeTitle(input: { names: readonly string[]; kind: string; netMills: number; day: string }): string {
  const who = input.names.length === 0 ? "" : `${input.names.join(" и ")}, `;
  return `Спор о продаже: ${who}${saleKindAccusative(input.kind) === "продажу" ? "продажа" : kindNominative(input.kind)}, ${money(input.netMills)}, ${dayWords(input.day)}`;
}

function kindNominative(kind: string): string {
  switch (kind) {
    case "message_purchase": return "PPV";
    case "post_purchase": return "покупка поста";
    case "subscription": return "подписка";
    case "tip":
    case "stream_tip": return "чаевые";
    default: return "продажа";
  }
}

/** The owner's weekly line: «Ничьи продажи за неделю с 10 нояб. по 16 нояб.: 7 на $212.00». */
export function nobodyWeekTitle(input: { count: number; mills: number; from: string; to: string }): string {
  return `Ничьи продажи за неделю с ${dayWords(input.from)} по ${dayWords(input.to)}: ${input.count} на ${money(input.mills)}`;
}

/** The owner's matter of a report's «мимо площадки»: «Мимо площадки: Алекс, 11 нояб., 2 на $150.00». */
export function offPlatformTitle(input: { person: string; reportDate: string; count: number; mills: number }): string {
  return `Мимо площадки: ${input.person}, ${dayWords(input.reportDate)}, ${input.count === 1 ? money(input.mills) : `${input.count} на ${money(input.mills)}`}`;
}
