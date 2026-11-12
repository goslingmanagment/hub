import type { KernelOperationResponse, ShiftReportClaim, ShiftReportLine } from "@agency_hub_core/contracts";
import { millsPercentOf, millsToNumber } from "@agency_hub_core/shared";

import { demoError, hashString, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";
import { DEMO_USERS, demoUserByRole, type DemoUser } from "../world.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS, chatterWorld, mskDay, type DemoSale, type DemoShift } from "./account-model.ts";

/**
 * Заявки и договорённости (ecosystem package G) in the demo, kept in memory
 * until the demo server restarts. Three chatters on one model: Катя (kate.v)
 * says «моё» of two sales of Алекс (alex.k, the demo's chatter) and Алекс
 * shares one with her:
 *  - one claim waits for Алекс's answer (the strip «Ждут вас» opens his
 *    shift report at the line, «Согласен» / «Не согласен» under it);
 *  - one he answered «Не согласен» a day ago, and one he did not answer for a
 *    day: both are the owner's disputes, with both statements and the facts;
 *  - Алекс's own «делим с Катей» waits for her.
 * The owner also has a report of Алекс with «мимо площадки» waiting, the week's
 * sales nobody claimed, and two decisions carried over from the ledger that
 * wait to be tied to a sale. Every answer writes: an agreement or a decision
 * gives the report a new version (made by the system), as in Hub.
 *
 * Invented names, fans and sums only.
 */

/** A shift row's id: the Moscow day it is reported on and whose it is, so it stays the same across requests. */
export const demoShiftId = (shift: DemoShift, user: DemoUser) => Number(mskDay(shift.start).replaceAll("-", "").slice(2)) * 10 + user.id;
/** A sale's id, as a line names it. */
export const demoLineId = (sale: DemoSale) => (hashString(sale.ref) % 900_000_000) + 1;

const ALEX = () => DEMO_USERS.find((user) => user.username === "alex.k")!;
const KATE = () => DEMO_USERS.find((user) => user.username === "kate.v")!;
const LENA = () => DEMO_USERS.find((user) => user.username === "lena.r")!;

type Outcome = "first" | "second" | "half" | "nobody";

interface DemoClaim {
  id: number;
  transactionId: number;
  pageLabel: string;
  claimant: DemoUser;
  side: DemoUser;
  claimantShiftId: number;
  sideShiftId: number;
  statement: "mine" | "share";
  note: string;
  claimedAt: number;
  createdAt: number;
  state: "asked" | "agreed" | "owner" | "decided";
  answer: "agree" | "disagree" | null;
  answerNote: string | null;
  answeredAt: number | null;
  escalatedWhy: "disagree" | "silence" | null;
  decision: { outcome: Outcome; note: string | null; decidedAt: number } | null;
  sale: { kind: string; occurredAt: string; netMills: number; fan: ShiftReportLine["fan"]; platform: string };
}

interface DemoOff {
  id: number;
  shiftId: number;
  user: DemoUser;
  reportDate: string;
  pages: string[];
  amountMills: number;
  fromWhom: string;
  whatFor: string;
  state: "pending" | "confirmed" | "rejected";
  pageLabel: string | null;
  addedAt: number;
}

/** A change the claims make to a handed-in report: a line's amount, or a «мимо площадки» decided. */
export type DemoSettle =
  | { kind: "line"; transactionId: number; amountMills: number; madeFor: string }
  | { kind: "off_platform"; offPlatformId: number; madeFor: string };

const hooks: Array<(shiftId: number, change: DemoSettle, now: Date) => void> = [];
/** shift-reports.ts listens: a settled claim is a new version of the report. */
export function onDemoSettle(hook: (shiftId: number, change: DemoSettle, now: Date) => void) {
  hooks.push(hook);
}

const shiftsOf = (user: DemoUser, now: Date) => chatterWorld(user, now).shifts.filter((shift) => !shift.visit);
const backOf = (shift: DemoShift, now: Date) => Math.round((Date.parse(`${mskDay(now.getTime())}T00:00:00Z`) - Date.parse(`${mskDay(shift.start)}T00:00:00Z`)) / DAY_MS);
const kindOf = (sale: DemoSale) => (sale.kind === "ppv" ? "message_purchase" : sale.kind === "post" ? "post_purchase" : sale.kind);

let state: { day: string; claims: DemoClaim[]; offs: DemoOff[]; kept: Set<number>; linked: Set<number> } | null = null;

/** The claims of the demo, made the first time the demo is asked on a day. */
function world(now: Date) {
  const day = mskDay(now.getTime());
  if (state?.day === day) return state;
  const alex = ALEX();
  const kate = KATE();
  const shifts = shiftsOf(alex, now);
  const ofBack = (back: number) => shifts.find((shift) => backOf(shift, now) === back) ?? null;
  const kateShift = (back: number) => shiftsOf(kate, now).find((shift) => backOf(shift, now) === back) ?? shiftsOf(kate, now)[0]!;
  // The newest report of Алекс handed in (the demo's switch is five days old; the shift of three days ago is the empty one).
  const five = [5, 4].map(ofBack).find((shift) => shift !== null && shift.sales.length >= 4) ?? null;
  // Алекс's own sales on the page they share (mia-1), the larger first.
  const own = (shift: DemoShift | null) => (shift?.sales ?? [])
    .filter((sale) => !sale.overlap && (sale.ppvSender === null || sale.ppvSender === alex.username))
    .sort((a, b) => Number(b.pageLabel === "mia-1") - Number(a.pageLabel === "mia-1") || b.netMills - a.netMills);
  const ofFive = own(five);
  const at = now.getTime();
  const claimOf = (id: number, sale: DemoSale | undefined, shift: DemoShift | null, claimant: DemoUser, side: DemoUser, fields: Partial<DemoClaim>): DemoClaim[] => {
    if (sale === undefined || shift === null) return [];
    const claimantShift = claimant.id === alex.id ? shift : kateShift(backOf(shift, now));
    return [{
      id, transactionId: demoLineId(sale), pageLabel: sale.pageLabel, claimant, side,
      claimantShiftId: demoShiftId(claimantShift, claimant), sideShiftId: demoShiftId(side.id === alex.id ? shift : kateShift(backOf(shift, now)), side),
      statement: "mine", note: "", claimedAt: at - 3 * HOUR_MS, createdAt: at - 3 * HOUR_MS, state: "asked", answer: null, answerNote: null,
      answeredAt: null, escalatedWhy: null, decision: null,
      sale: { kind: kindOf(sale), occurredAt: new Date(sale.at).toISOString(), netMills: sale.netMills, platform: sale.platform,
        fan: { fanRef: sale.fan.platformUserId, name: sale.fanName ?? sale.fan.displayName, username: sale.fan.username } },
      ...fields,
    }];
  };
  const claims = [
    ...claimOf(1001, ofFive[0], five, kate, alex, { note: "фан пришёл с моей рассылки, договорились в «Обучалке»", claimedAt: at - 3 * HOUR_MS, createdAt: at - 3 * HOUR_MS }),
    ...claimOf(1002, ofFive[1], five, kate, alex, {
      note: "вела его весь вечер, купил после моего сообщения", claimedAt: at - 31 * HOUR_MS, createdAt: at - 31 * HOUR_MS,
      state: "owner", answer: "disagree", answerNote: "фан мой: писал ему последним, PPV тоже моё", answeredAt: at - 27 * HOUR_MS, escalatedWhy: "disagree",
    }),
    ...claimOf(1003, ofFive[2], five, alex, kate, { statement: "share", note: "вели вдвоём, она начала, я закрыл", claimedAt: at - 2 * HOUR_MS, createdAt: at - 2 * HOUR_MS }),
    ...claimOf(1004, ofFive[3], five, kate, alex, { note: "мой постоянный, договорились о продлении", claimedAt: at - 29 * HOUR_MS, createdAt: at - 29 * HOUR_MS, state: "owner", escalatedWhy: "silence" }),
  ];
  const offs: DemoOff[] = five === null ? [] : [{
    id: 9501, shiftId: demoShiftId(five, alex), user: alex, reportDate: mskDay(five.start), pages: [...new Set(five.sales.map((sale) => sale.pageLabel))].length > 0 ? [...new Set(five.sales.map((sale) => sale.pageLabel))] : five.pages,
    amountMills: 150_000, fromWhom: "фан с mia-1, ник «dk_rider»", whatFor: "кастом: видео 5 минут, оплатил на карту", state: "pending", pageLabel: null, addedAt: five.end + 4 * MINUTE_MS,
  }];
  state = { day, claims, offs, kept: new Set(), linked: new Set() };
  return state;
}

const answerByOf = (claim: DemoClaim) => (claim.state === "asked" || (claim.state === "owner" && claim.escalatedWhy === "silence" && claim.answer === null)
  ? new Date(claim.createdAt + 24 * HOUR_MS).toISOString() : null);

function wire(claim: DemoClaim) {
  return {
    id: claim.id,
    kind: "claim" as const,
    transactionId: claim.transactionId,
    pageLabel: claim.pageLabel,
    claimant: { userId: claim.claimant.id, name: claim.claimant.name },
    statement: claim.statement,
    note: claim.note,
    claimedAt: new Date(claim.claimedAt).toISOString(),
    side: { userId: claim.side.id, name: claim.side.name },
    sideShiftId: claim.sideShiftId,
    state: claim.state,
    answer: claim.answer,
    answerNote: claim.answerNote,
    answeredAt: claim.answeredAt === null ? null : new Date(claim.answeredAt).toISOString(),
    escalatedWhy: claim.escalatedWhy,
    decision: claim.decision === null ? null : { outcome: claim.decision.outcome, note: claim.decision.note, decidedAt: new Date(claim.decision.decidedAt).toISOString() },
    answerBy: answerByOf(claim),
    question: null,
  };
}

/** The claims a shift report shows: the reader's incoming ones (answerable by its person) and the report's own. */
export function demoReportClaims(input: { now: Date; shiftId: number; ownerId: number; lineIds: ReadonlySet<number>; own: boolean }): ShiftReportClaim[] {
  return world(input.now).claims.flatMap((claim): ShiftReportClaim[] => {
    const incoming = claim.side.id === input.ownerId && (claim.sideShiftId === input.shiftId || input.lineIds.has(claim.transactionId));
    const outgoing = claim.claimant.id === input.ownerId && claim.claimantShiftId === input.shiftId;
    if (!incoming && !outgoing) return [];
    const answerable = claim.state === "asked" || (claim.state === "owner" && claim.escalatedWhy === "silence" && claim.answer === null);
    return [{
      ...wire(claim),
      direction: incoming ? "incoming" : "outgoing",
      canAnswer: input.own && incoming && answerable,
      sale: input.lineIds.has(claim.transactionId) ? null : { kind: claim.sale.kind, occurredAt: claim.sale.occurredAt, netMills: claim.sale.netMills, fan: claim.sale.fan },
    }];
  });
}

/** What a settled claim makes of a line of a person: their amount and the rule's words, or null — nothing settled. */
export function demoLineOutcome(now: Date, transactionId: number, userId: number): { amountMills: number; mine: boolean; reason: string; words: string; toName: string | null } | null {
  const claim = world(now).claims.find((one) => one.transactionId === transactionId && (one.state === "agreed" || one.state === "decided"));
  if (claim === undefined) return null;
  const net = claim.sale.netMills;
  const half = (id: number) => {
    const low = Math.min(claim.claimant.id, claim.side.id);
    const first = millsToNumber(millsPercentOf(net, 50));
    return id === low ? first : net - first;
  };
  const other = userId === claim.claimant.id ? claim.side : claim.claimant;
  if (claim.state === "agreed") {
    if (claim.statement === "share") return { amountMills: half(userId), mine: true, reason: "agreed", words: "по согласию второй стороны: пополам", toName: null };
    return userId === claim.claimant.id
      ? { amountMills: net, mine: true, reason: "agreed", words: "по согласию второй стороны", toName: null }
      : { amountMills: 0, mine: false, reason: "agreed", words: `по согласию: ${other.name}`, toName: other.name };
  }
  const outcome = claim.decision!.outcome;
  if (outcome === "nobody") return { amountMills: 0, mine: false, reason: "owner_nobody", words: "владелец решил: никому", toName: null };
  if (outcome === "half") return { amountMills: half(userId), mine: true, reason: "owner_split", words: "раздел владельца: пополам", toName: null };
  const winner = outcome === "first" ? claim.claimant : claim.side;
  return winner.id === userId
    ? { amountMills: net, mine: true, reason: "owner_split", words: "раздел владельца", toName: null }
    : { amountMills: 0, mine: false, reason: "owner_split", words: `раздел владельца: ${winner.name}`, toName: winner.name };
}

/** Цепочка продажи (sale-chain.ts): the claims of one sale, for «Чья». */
export function demoClaimsOfSale(now: Date, transactionId: number) {
  return world(now).claims.filter((claim) => claim.transactionId === transactionId).map((claim) => ({
    state: claim.state, claimant: claim.claimant, side: claim.side, statement: claim.statement, createdAt: claim.createdAt, outcome: claim.decision?.outcome ?? null,
  }));
}

/** A person's own «делим с …» waiting for the colleague: the word on their line. Null — none. */
export function demoOwnShare(now: Date, transactionId: number, userId: number): { shareWithUserId: number; shareWithName: string; note: string } | null {
  const claim = world(now).claims.find((one) => one.transactionId === transactionId && one.claimant.id === userId && one.statement === "share"
    && (one.state === "asked" || one.state === "owner"));
  return claim === undefined ? null : { shareWithUserId: claim.side.id, shareWithName: claim.side.name, note: claim.note };
}

/** The sales a person claimed of a colleague's, as lines of their own report (added by hand). */
export function demoClaimedLines(now: Date, userId: number, shiftId: number): ShiftReportLine[] {
  return world(now).claims.filter((claim) => claim.claimant.id === userId && claim.claimantShiftId === shiftId && claim.statement === "mine").map((claim) => {
    const outcome = demoLineOutcome(now, claim.transactionId, userId);
    const disputed = claim.state === "asked" || claim.state === "owner";
    // A disputed «моё» counts nothing until it is settled, and says what it claims (as Hub, review R2b-2).
    const amount = outcome !== null ? outcome.amountMills : disputed ? 0 : claim.sale.netMills;
    return {
      transactionId: claim.transactionId, group: "mine", pageLabel: claim.pageLabel, platform: claim.sale.platform, kind: claim.sale.kind,
      occurredAt: claim.sale.occurredAt, netMills: claim.sale.netMills, fan: claim.sale.fan,
      rule: { home: "shift", reason: outcome?.reason ?? "holder", words: outcome?.words ?? `по правилу ${claim.side.name}`, toUserId: claim.side.id, toName: claim.side.name, shareMills: 0 },
      statement: "mine", shareWithUserId: null, shareWithName: null, note: claim.note, amountMills: amount,
      claimedMills: outcome === null && disputed ? claim.sale.netMills : null, added: true, disputed: outcome === null && disputed, alreadyIn: null,
      facts: null,
    };
  });
}

/** «Мимо площадки» of a report the owner decides, by shift. */
export function demoOffPlatformOf(now: Date, shiftId: number) {
  return world(now).offs.filter((one) => one.shiftId === shiftId).map((one) => ({
    id: one.id, amountMills: one.amountMills, fromWhom: one.fromWhom, whatFor: one.whatFor, state: one.state, pageLabel: one.pageLabel,
  }));
}

// ── The matters ─────────────────────────────────────────────────────────────

export interface DemoClaimMatter {
  kind: string;
  key: string;
  title: string;
  pages: string[];
  owner: { kind: "role"; role: "owner" } | { kind: "user"; userId: number; username: string; displayName: string | null };
  money: boolean;
  evidence: Record<string, unknown>;
  link: string;
  agoMs: number;
}

const money = (mills: number) => `$${(mills / 1000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const DAY_MONTH = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "Europe/Moscow" });
const KIND_ACC: Readonly<Record<string, string>> = { message_purchase: "PPV", post_purchase: "покупку поста", subscription: "подписку", tip: "чаевые" };
const KIND_NOM: Readonly<Record<string, string>> = { message_purchase: "PPV", post_purchase: "покупка поста", subscription: "подписка", tip: "чаевые" };

/** The matters the demo's claims open: the other side's, the owner's disputes, «мимо площадки», the week, the ledger's. */
export function demoClaimMatters(now: Date): DemoClaimMatter[] {
  const { claims, offs } = world(now);
  const out: DemoClaimMatter[] = [];
  for (const claim of claims) {
    const day = DAY_MONTH.format(new Date(claim.sale.occurredAt));
    const fan = claim.sale.fan.name ?? (claim.sale.fan.username ? `@${claim.sale.fan.username}` : "фан");
    if (claim.state === "asked") {
      out.push({
        kind: "sale.claim", key: `sale.claim:${claim.id}`,
        title: claim.statement === "share"
          ? `${claim.claimant.name} делит с вами пополам: ${KIND_ACC[claim.sale.kind] ?? "продажу"}, ${fan}, ${money(claim.sale.netMills)}, ${day}`
          : `${claim.claimant.name} считает своей: ${KIND_ACC[claim.sale.kind] ?? "продажу"}, ${fan}, ${money(claim.sale.netMills)}, ${day}`,
        pages: [claim.pageLabel], owner: { kind: "user", userId: claim.side.id, username: claim.side.username, displayName: claim.side.name }, money: false,
        evidence: { claimId: claim.id, transactionId: claim.transactionId, saidAt: new Date(claim.claimedAt).toISOString(), answerBy: answerByOf(claim) },
        link: `/workboard/my/shifts/${claim.sideShiftId}?sale=${claim.transactionId}`, agoMs: now.getTime() - claim.createdAt,
      });
    }
    if (claim.state === "owner") {
      out.push({
        kind: "sale.dispute", key: `sale.dispute:${claim.transactionId}`,
        title: `Спор о продаже: ${claim.claimant.name} и ${claim.side.name}, ${KIND_NOM[claim.sale.kind] ?? "продажа"}, ${money(claim.sale.netMills)}, ${day}`,
        pages: [claim.pageLabel], owner: { kind: "role", role: "owner" }, money: true,
        evidence: { transactionId: claim.transactionId, claimIds: [claim.id], netMills: claim.sale.netMills, why: [claim.escalatedWhy], saidAt: new Date(claim.claimedAt).toISOString() },
        link: `/workboard/decisions?dispute=${claim.transactionId}#questions`, agoMs: now.getTime() - claim.claimedAt,
      });
    }
  }
  for (const off of offs.filter((one) => one.state === "pending")) {
    out.push({
      kind: "off_platform.pending", key: `off_platform.pending:${off.shiftId}`,
      title: `Мимо площадки: ${off.user.name}, ${DAY_MONTH.format(new Date(`${off.reportDate}T12:00:00+03:00`))}, ${money(off.amountMills)}`,
      pages: off.pages, owner: { kind: "role", role: "owner" }, money: true,
      evidence: { shiftId: off.shiftId, reportDate: off.reportDate, totalMills: off.amountMills, saidAt: new Date(off.addedAt).toISOString(), lines: [{ id: off.id, amountMills: off.amountMills, fromWhom: off.fromWhom, whatFor: off.whatFor }] },
      link: `/workboard/decisions?offPlatform=${off.shiftId}#reports`, agoMs: now.getTime() - off.addedAt,
    });
  }
  const week = nobodyWeek(now);
  if (week.sales.length > 0) {
    out.push({
      kind: "sale.nobody_week", key: `sale.nobody_week:${week.from}`,
      title: `Ничьи продажи за неделю с ${DAY_MONTH.format(new Date(`${week.from}T12:00:00+03:00`))} по ${DAY_MONTH.format(new Date(`${week.to}T12:00:00+03:00`))}: ${week.sales.length} на ${money(week.sales.reduce((sum, sale) => sum + sale.netMills, 0))}`,
      pages: [], owner: { kind: "role", role: "owner" }, money: true, evidence: { week: week.from, count: week.sales.length }, link: `/workboard/decisions?nobody=${week.from}#questions`, agoMs: 26 * HOUR_MS,
    });
  }
  const unlinked = UNLINKED.filter((one) => !world(now).linked.has(one.id));
  if (unlinked.length > 0) {
    out.push({
      kind: "sale.decisions.unlinked", key: "sale.decisions.unlinked:ledger", title: `Решения «чья продажа» из ledger без продажи: ${unlinked.length}, привяжите`,
      pages: [], owner: { kind: "role", role: "owner" }, money: true, evidence: { count: unlinked.length }, link: "/workboard/decisions?unlinked=1#questions", agoMs: 3 * DAY_MS,
    });
  }
  return out;
}

// ── The week's nobody's sales, the ledger's unlinked decisions ──────────────

function nobodyWeek(now: Date) {
  const today = mskDay(now.getTime());
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const from = mskDay(Date.parse(`${today}T12:00:00+03:00`) - weekday * DAY_MS - (weekday < 2 ? 7 * DAY_MS : 0));
  const to = mskDay(Date.parse(`${from}T12:00:00+03:00`) + 6 * DAY_MS);
  const lena = LENA();
  const sales = chatterWorld(lena, now).shifts.flatMap((shift) => shift.sales).filter((sale) => sale.kind !== "ppv").slice(0, 7);
  const kept = world(now).kept;
  return {
    from, to,
    days: [from, mskDay(Date.parse(`${from}T12:00:00+03:00`) + DAY_MS), mskDay(Date.parse(`${from}T12:00:00+03:00`) + 2 * DAY_MS)],
    sales: sales.filter((sale) => !kept.has(demoLineId(sale))).map((sale, index) => ({
      transactionId: demoLineId(sale), pageLabel: index % 3 === 0 ? "mia-2" : "mia-1", platform: sale.platform, kind: kindOf(sale),
      occurredAt: new Date(Math.min(sale.at, now.getTime() - DAY_MS)).toISOString(), netMills: sale.netMills,
      fan: { fanRef: sale.fan.platformUserId, name: sale.fanName ?? sale.fan.displayName, username: sale.fan.username },
      home: index === 4 ? "decide" : "nobody",
      words: index === 4 ? "держали несколько смен, фану никто из них не писал" : "страницу никто не держал",
    })),
  };
}

const UNLINKED = [
  { id: 71, ledgerDecisionId: 41, pageLabel: "mia-3", words: "фан «sunset_k», сумма не названа: «тир дороже базового, договаривалась я»", saidBy: "Катя", kind: "split" as const, user: "kate.v" },
  { id: 72, ledgerDecisionId: 44, pageLabel: "mia-1", words: "фан «blue_harbor», $275.00: кастом оплачен частями, вёл Алекс", saidBy: "владелец", kind: "split" as const, user: "alex.k" },
];

// ── The handlers ────────────────────────────────────────────────────────────

const ownerOnly = (request: DemoRequest): DemoReply | null => (request.role === "owner" ? null : demoError(403, "Forbidden", "Only the owner decides"));

function disputeOf(claim: DemoClaim, now: Date): KernelOperationResponse<"saleDispute"> {
  const net = claim.sale.netMills;
  const half = millsToNumber(millsPercentOf(net, 50));
  const [low, high] = claim.claimant.id < claim.side.id ? [claim.claimant, claim.side] : [claim.side, claim.claimant];
  const says = (user: DemoUser) => {
    if (user.id === claim.claimant.id) return [`«Моё»: ${claim.note}`];
    if (claim.answer === "disagree") return [`«Не согласен»: ${claim.answerNote ?? ""}`];
    if (claim.escalatedWhy === "silence") return [`нет ответа ${Math.floor((now.getTime() - claim.createdAt) / HOUR_MS)} ч`];
    return [];
  };
  const kate = KATE();
  return {
    sale: { transactionId: claim.transactionId, pageLabel: claim.pageLabel, platform: claim.sale.platform, kind: claim.sale.kind, occurredAt: claim.sale.occurredAt, netMills: net, fan: claim.sale.fan },
    home: { kind: "shift", reason: "slot_owner", words: "стык смен, никто из них не писал фану: смене, чей слот идёт", shares: [{ userId: claim.side.id, name: claim.side.name, mills: net }] },
    parties: [
      // The claimant's «моё» counts nothing while it is disputed: it claims the net (review R2b-2).
      { userId: claim.claimant.id, name: claim.claimant.name, role: "first", says: says(claim.claimant), countedMills: 0, claimedMills: net, shiftId: claim.claimantShiftId },
      { userId: claim.side.id, name: claim.side.name, role: "second", says: says(claim.side), countedMills: net, claimedMills: null, shiftId: claim.sideShiftId },
    ],
    claims: [wire(claim)],
    facts: {
      ppv: claim.sale.kind === "message_purchase" ? { senderUserId: claim.side.id, senderName: claim.side.name, sentAt: new Date(Date.parse(claim.sale.occurredAt) - 50 * MINUTE_MS).toISOString(), withoutAuthor: false } : null,
      lastWriter: { userId: kate.id, name: kate.name, at: new Date(Date.parse(claim.sale.occurredAt) - 70 * MINUTE_MS).toISOString(), within48h: true },
      writers: [{ userId: kate.id, name: kate.name, messages: 14 }, { userId: claim.side.id, name: claim.side.name, messages: 9 }],
      holders: [{ userId: kate.id, name: kate.name, slotRunning: false }],
      ownSlotRunning: true,
      otherReports: [{ userId: kate.id, name: kate.name, shiftId: claim.claimantShiftId, reportDate: claim.sale.occurredAt.slice(0, 10) }],
      pot: null,
      renewalOf: null,
    },
    outcomes: [
      { outcome: "first", label: `${claim.claimant.name}: целиком`, gives: [{ userId: claim.claimant.id, mills: net }, { userId: claim.side.id, mills: 0 }] },
      { outcome: "second", label: `${claim.side.name}: целиком`, gives: [{ userId: claim.claimant.id, mills: 0 }, { userId: claim.side.id, mills: net }] },
      { outcome: "half", label: "Пополам", gives: [{ userId: low.id, mills: half }, { userId: high.id, mills: net - half }] },
      { outcome: "nobody", label: "Никому", gives: [{ userId: claim.claimant.id, mills: 0 }, { userId: claim.side.id, mills: 0 }] },
    ],
    decision: claim.decision === null ? null : { outcome: claim.decision.outcome, note: claim.decision.note, decidedAt: new Date(claim.decision.decidedAt).toISOString(), by: "Владелец" },
    serverNow: now.toISOString(),
  };
}

function settle(claim: DemoClaim, now: Date, madeFor: string) {
  for (const user of [claim.claimant, claim.side]) {
    const outcome = demoLineOutcome(now, claim.transactionId, user.id);
    const shiftId = user.id === claim.claimant.id ? claim.claimantShiftId : claim.sideShiftId;
    for (const hook of hooks) hook(shiftId, { kind: "line", transactionId: claim.transactionId, amountMills: outcome?.amountMills ?? 0, madeFor }, now);
  }
}

export const saleClaimHandlers: DemoHandlers = {
  saleClaimAnswer: (request) => {
    const claim = world(request.now).claims.find((one) => one.id === Number(request.params.claimId));
    if (claim === undefined) return demoError(404, "Not Found", "No such claim");
    if (demoUserByRole(request.role).id !== claim.side.id) return demoError(403, "Forbidden", "Only the other side answers a claim");
    const body = request.body as { answer: "agree" | "disagree"; note?: string | null };
    const note = body.note?.trim() || null;
    if (body.answer === "disagree" && note === null) return demoError(400, "Bad Request", "«Не согласен» needs one line of why");
    claim.answer = body.answer;
    claim.answerNote = note;
    claim.answeredAt = request.now.getTime();
    if (body.answer === "agree") {
      claim.state = "agreed";
      settle(claim, request.now, `согласие: ${claim.side.name}`);
    } else {
      claim.state = "owner";
      claim.escalatedWhy = "disagree";
    }
    return { claim: wire(claim), savedAt: request.now.toISOString() };
  },
  saleDispute: (request) => {
    const denied = ownerOnly(request);
    if (denied) return denied;
    const claim = world(request.now).claims.find((one) => one.transactionId === Number(request.params.transactionId));
    return claim === undefined ? demoError(404, "Not Found", "No dispute of this sale") : disputeOf(claim, request.now);
  },
  saleDisputeOfClaim: (request) => {
    const denied = ownerOnly(request);
    if (denied) return denied;
    const claim = world(request.now).claims.find((one) => one.id === Number(request.params.claimId));
    return claim === undefined ? demoError(404, "Not Found", "No such claim") : disputeOf(claim, request.now);
  },
  saleDisputeDecide: (request) => {
    const denied = ownerOnly(request);
    if (denied) return denied;
    const body = request.body as { transactionId?: number; outcome: Outcome | "dismiss"; note?: string | null };
    const claim = world(request.now).claims.find((one) => one.transactionId === body.transactionId && one.state === "owner");
    if (claim === undefined || body.outcome === "dismiss") return demoError(404, "Not Found", "No dispute of this sale waits for a decision");
    claim.state = "decided";
    claim.decision = { outcome: body.outcome, note: body.note?.trim() || null, decidedAt: request.now.getTime() };
    const words = { first: "решение владельца по спору о продаже", second: "решение владельца по спору о продаже", half: "решение владельца: пополам", nobody: "решение владельца: никому" }[body.outcome];
    settle(claim, request.now, words);
    return { decided: true, versions: [{ shiftId: claim.sideShiftId, version: 2 }, { shiftId: claim.claimantShiftId, version: 2 }], savedAt: request.now.toISOString() };
  },
  offPlatformPending: (request) => {
    const denied = ownerOnly(request);
    if (denied) return denied;
    const shiftId = request.query.shiftId === undefined ? null : Number(request.query.shiftId);
    const pending = world(request.now).offs.filter((one) => one.state === "pending" && (shiftId === null || one.shiftId === shiftId));
    return {
      reports: pending.map((one) => ({
        shiftId: one.shiftId, person: { userId: one.user.id, name: one.user.name }, reportDate: one.reportDate, pages: one.pages, totalMills: 186_400,
        lines: [{ id: one.id, amountMills: one.amountMills, fromWhom: one.fromWhom, whatFor: one.whatFor, addedAt: new Date(one.addedAt).toISOString() }],
      })),
      serverNow: request.now.toISOString(),
    };
  },
  offPlatformDecide: (request) => {
    const denied = ownerOnly(request);
    if (denied) return denied;
    const off = world(request.now).offs.find((one) => one.id === Number(request.params.offPlatformId));
    if (off === undefined) return demoError(404, "Not Found", "No such «мимо площадки» line");
    if (off.state !== "pending") return demoError(409, "Conflict", "This line is already decided");
    const body = request.body as { decision: "confirm" | "reject"; pageLabel?: string };
    off.state = body.decision === "confirm" ? "confirmed" : "rejected";
    off.pageLabel = body.decision === "confirm" ? body.pageLabel ?? off.pages[0] ?? null : null;
    for (const hook of hooks) hook(off.shiftId, { kind: "off_platform", offPlatformId: off.id, madeFor: off.state === "confirmed" ? "владелец подтвердил «мимо площадки»" : "владелец отклонил «мимо площадки»" }, request.now);
    return { state: off.state, version: 2, savedAt: request.now.toISOString() };
  },
  saleNobody: (request) => {
    const denied = ownerOnly(request);
    if (denied) return denied;
    const week = nobodyWeek(request.now);
    return { ...week, totalMills: week.sales.reduce((sum, sale) => sum + sale.netMills, 0), serverNow: request.now.toISOString() };
  },
  saleNobodyKeep: (request) => {
    const denied = ownerOnly(request);
    if (denied) return denied;
    const week = nobodyWeek(request.now);
    for (const sale of week.sales) world(request.now).kept.add(sale.transactionId);
    return { kept: week.sales.length, savedAt: request.now.toISOString() };
  },
  saleDecisionsUnlinked: (request) => {
    const denied = ownerOnly(request);
    if (denied) return denied;
    const linked = world(request.now).linked;
    return {
      decisions: UNLINKED.filter((one) => !linked.has(one.id)).map((one) => {
        const user = DEMO_USERS.find((candidate) => candidate.username === one.user)!;
        const sales = chatterWorld(user, request.now).shifts.flatMap((shift) => shift.sales).filter((sale) => sale.pageLabel === one.pageLabel).slice(0, 4);
        return {
          id: one.id, ledgerDecisionId: one.ledgerDecisionId, pageLabel: one.pageLabel, words: one.words, saidBy: one.saidBy,
          shares: [{ userId: user.id, name: user.name, percent: 100 }], kind: one.kind,
          candidates: sales.map((sale) => ({
            transactionId: demoLineId(sale), pageLabel: sale.pageLabel, platform: sale.platform, kind: kindOf(sale), occurredAt: new Date(sale.at).toISOString(),
            netMills: sale.netMills, fan: { fanRef: sale.fan.platformUserId, name: sale.fanName ?? sale.fan.displayName, username: sale.fan.username },
          })),
        };
      }),
      serverNow: request.now.toISOString(),
    };
  },
  saleDecisionLink: (request) => {
    const denied = ownerOnly(request);
    if (denied) return denied;
    world(request.now).linked.add(Number(request.params.decisionId));
    return { linked: true, savedAt: request.now.toISOString() };
  },
};
