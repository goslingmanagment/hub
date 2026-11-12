import { millsFromInteger, millsPercentOf, millsToNumber } from "@agency_hub_core/shared";

import { SALE_LAST_WRITER_HOURS, dayOfWork, moscowDayOf } from "./chatter-shifts.ts";

/**
 * Whose a sale is: one rule for the whole of Hub, a pure function of the facts
 * (`now` is an argument). A port of the agency ledger's `internal/split`
 * (split.go and marks.go, ledger origin/main 52968b6) with the owner's newer
 * answers of Gengar's shift report skill (SKILL.md §4, 2026-11-12), each behind
 * its own line of SALE_RULE. In shadow: the homes it gives are written to
 * `sale_homes` (sale-homes.ts) and read by no screen yet.
 *
 * From SALE_RULE.since (2026-11-02 00:00 MSK), in this order:
 *
 *  1. A PPV a chatter sent is the sender's whoever's shift it was bought in: in
 *     their own shift or look-in that holds it; else in their shift going at
 *     the purchase, on another page; else in their next shift, if it begins
 *     within SALE_RULE.ppvWaitMs (till then it waits, later nobody's). A PPV of
 *     a team lead or the owner has no sender here. NEWER (owner, 2026-10-20 and
 *     2026-11-12, `senderLeftGoesToHolders`): when no shift of a sender who has
 *     left the team takes it, it goes by the shifts that held it, as 3.
 *  2. A tip under a wall post and an OnlyFans Campaign contribution are the
 *     page's pot (общак), no shift's.
 *  3. The rest by the shifts that hold the sale (H): one person's — theirs;
 *     several — the one whose person last wrote to the fan (48 h, Hub's fact);
 *     none of them — NEWER (owner, 2026-11-12 10:36, `junctionToSlotOwner`):
 *     the one person of H whose schedule slot on the page runs at the sale
 *     (`slots`, an argument), when exactly one does, whether or not she wrote;
 *     else it waits for a decision (the owner's split of the disputed sale, or
 *     the chatters' confirmed marks when they agree). A holder outside the slot
 *     who last wrote keeps it («sold it personally»): that is the last-writer
 *     step above, before the slot is asked. No shift holds it: the look-in
 *     whose person last wrote, else nobody's.
 *  4. A sale before the rule, or one the old rule gives to work of a Moscow day
 *     before it (the night of 1 November past midnight), is before the rule.
 *  5. A nobody's sale the owner gave to a person who claimed it (ledger's
 *     sale_claims) is theirs whole, on no work. A claim moves no other home:
 *     when later facts find a holder, the claim stops applying.
 *
 * The same examples pin this file and ledger's Go (tests/sale-rule.test.ts is
 * split_test.go case by case). Money is mills, split through money.ts as the
 * ledger splits it.
 */

const DAY_MS = 86_400_000;

/**
 * The owner's rule, every date and threshold of it: a new answer of the owner
 * is one line here, and `version` names it on every home written.
 */
export const SALE_RULE = {
  version: "2026-11-12.1",
  /** The first instant the rule settles; its Moscow date is the first day of work it pays (owner, 2026-11-08). */
  since: Date.parse("2026-11-02T00:00:00+03:00"),
  /** How long a chatter's bought PPV waits for its sender's next shift (owner, 2026-11-08). */
  ppvWaitMs: 7 * DAY_MS,
  /**
   * How far back «who last wrote to the fan» looks. Hub's fact, read where the facts are
   * (chatter-shifts.ts SALE_LAST_WRITER_HOURS): the screens read the same one.
   */
  lastWriterHours: SALE_LAST_WRITER_HOURS,
  /** A PPV of a sender who left the team goes by the shifts that held it (owner, 2026-10-20, 2026-11-12). Go: off. */
  senderLeftGoesToHolders: true,
  /** At a junction where no holder wrote last, the one holder whose schedule slot runs takes it (owner, 2026-11-12). Go: off. */
  junctionToSlotOwner: true,
} as const;

export type SaleRuleConfig = {
  readonly version: string;
  readonly since: number;
  readonly ppvWaitMs: number;
  readonly lastWriterHours: number;
  readonly senderLeftGoesToHolders: boolean;
  readonly junctionToSlotOwner: boolean;
};

/** Ledger's Go `internal/split` as it stands: the owner's newer answers off. For the comparison with `fact_homes`. */
export const LEDGER_GO_RULE: SaleRuleConfig = { ...SALE_RULE, version: "ledger-go", senderLeftGoesToHolders: false, junctionToSlotOwner: false };

/** The kinds of a home. */
export const SALE_HOME_KINDS = ["shift", "visit", "pot", "waiting", "decide", "nobody", "before_rule", "unknown"] as const;
export type SaleHomeKind = (typeof SALE_HOME_KINDS)[number];

/** The one pot of the rule: tips under wall posts and Campaign contributions. */
export const POT_OBSHAK = "obshak";

/** Why a sale's home is what it is: ledger's reasons, and the two of the owner's newer answers. */
export const SALE_HOME_REASONS = [
  "sale_before_rule",
  "work_before_rule",
  "holder_not_in_works",
  "ppv_sender",
  "ppv_sender_other_page",
  "ppv_sender_next_shift",
  "ppv_sender_waiting",
  "ppv_sender_no_shift",
  "ppv_sender_left",
  "post_tip",
  "campaign",
  "holder",
  "last_writer",
  "slot_owner",
  "look_in_last_writer",
  "no_holder",
  "no_last_writer",
  "marks_disagree",
  "marks",
  "owner_split",
  "owner_claim",
] as const;
export type SaleHomeReason = (typeof SALE_HOME_REASONS)[number];

const waitDays = SALE_RULE.ppvWaitMs / DAY_MS;

/** A reason in the owner's words, for the comparison tool and the screens to come. */
export const SALE_HOME_REASON_TEXT: Readonly<Record<SaleHomeReason, string>> = {
  sale_before_rule: "продажа до правила",
  work_before_rule: "по-старому: смена дня до правила",
  holder_not_in_works: "факты неполны: смены держателя нет",
  ppv_sender: "PPV отправителя, его смена",
  ppv_sender_other_page: "PPV отправителя, его смена на другой странице",
  ppv_sender_next_shift: "PPV отправителя, следующая смена",
  ppv_sender_waiting: "PPV ждёт смены отправителя",
  ppv_sender_no_shift: `PPV отправителя, смены за ${waitDays} дней не было`,
  ppv_sender_left: "PPV ушедшего из команды: смене, в которую купили",
  post_tip: "чаевые под постом, общак",
  campaign: "Campaign OnlyFans, общак",
  holder: "страницу держала одна смена",
  last_writer: "держали несколько смен, последним фану писал он",
  slot_owner: "стык смен, никто из них не писал фану: смене, чей слот идёт",
  look_in_last_writer: "заход, последним фану писал он",
  no_holder: "страницу никто не держал",
  no_last_writer: "держали несколько смен, последним не писал никто из них",
  marks_disagree: "метки чаттеров не сходятся",
  marks: "по меткам чаттеров",
  owner_split: "раздел владельца",
  owner_claim: "ничья, отдана по слову владельца",
};

/** The days of the week a slot runs on, as the people registry writes them (0384 `person_schedule_slots.weekdays`). */
export const RULE_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type RuleWeekday = (typeof RULE_WEEKDAYS)[number];

/**
 * A person's schedule slot: from `startMinute` to `endMinute` of the Moscow day (minutes from 00:00; a slot whose end
 * is not after its start crosses midnight), on one page (`pageId`) or on every page (null), on the Moscow days of its
 * start that are within [validFrom, validTo] (null — open) and are one of its `weekdays` (null — every day). A slot of
 * a page valid on a day stands for the person on that page that day instead of their every-page slot: an earlier end on
 * one page (today: an evening slot that ends at 00:00 on one of its two pages). `personId` names the person as a work
 * does (`RuleWork.userId`, Hub's users.id); the provider maps its people to it.
 */
export interface RuleSlot {
  personId: number;
  pageId: number | null;
  startMinute: number;
  endMinute: number;
  /** The days of its start it runs on; null — every day. */
  weekdays: readonly RuleWeekday[] | null;
  /** YYYY-MM-DD (Moscow) or null. */
  validFrom: string | null;
  validTo: string | null;
}

/** A person's shift or look-in, as Hub computes it (chatter-shifts.ts). */
export interface RuleWork {
  /** `<userId>:<startedAt ISO>`, as a sale's `holders` name it. */
  ref: string;
  userId: number;
  kind: "shift" | "visit";
  startedAt: number;
  endedAt: number;
}

export type RuleRole = "owner" | "team_lead" | "chatter";

export interface RuleMark {
  userId: number;
  mark: "mine" | "share" | "not_mine";
  /** The colleague a «делим» names; two «делим» agree only naming each other. */
  shareWith: number | null;
  /** The chatter's own amount of a «моё» (never above the net); null — the whole net. */
  ownAmountMills: number | null;
  /** The chatter's confirmed shift report holds it: a draft mark decides nothing. */
  confirmed: boolean;
}

/** One sale with the facts the rule reads. */
export interface RuleSale {
  ref: string;
  /** The page of the sale: the schedule slots it is read against; null — unknown, no slot runs. */
  pageId: number | null;
  kind: "ppv" | "tip" | "subscription" | "post";
  netMills: number;
  occurredAt: number;
  /** The refs of every work holding the page at the sale (Hub's `workHoldsSale`; a look-in only to its person's fan). */
  holders: readonly string[];
  /** The bought PPV's sender with their role now and when they left the team (null — still in it); null — no sender. */
  ppvSender: { userId: number; role: RuleRole; leftAt: number | null } | null;
  postTip: boolean;
  campaign: boolean;
  /** Who last wrote to the fan on the page within the last-writer hours before the sale; null — nobody known. */
  lastWriter: number | null;
  marks: readonly RuleMark[];
  /** The owner's split of a disputed sale; null or empty — none. */
  resolution: ReadonlyArray<{ userId: number; percent: number }> | null;
  /** Whom the owner gives the sale if it is nobody's (ledger's sale_claims); null — nobody. */
  claimedBy: number | null;
}

export interface SaleShare {
  /** The work credited; null — a person the owner or a «делим» gave a share who has no work holding the sale: date it by the sale. */
  workRef: string | null;
  userId: number;
  /** Percent of the net: 100, the halves' 50, the owner's; an own amount's, rounded down. Count `mills`. */
  percent: number;
  mills: number;
}

export interface SaleHome {
  kind: SaleHomeKind;
  reason: SaleHomeReason;
  /** A shift or visit home's shares: they sum to the net, except a «моё» with an own amount below it (the rest is nobody's). */
  shares: SaleShare[];
  /** A pot home's pot. */
  pot: string | null;
  /** A waiting PPV's last moment for its sender's shift. */
  waitsUntil: number | null;
  /**
   * Several people's shifts held it and none of them wrote last to the fan: the home is the schedule slot's (one
   * holder's slot running) or, without one, the owner's to decide. Such a home moves when the slots do.
   */
  slotJunction: boolean;
}

interface Index {
  works: readonly RuleWork[];
  byRef: Map<string, number>;
  slots: readonly RuleSlot[];
}

function indexOf(works: readonly RuleWork[], slots: readonly RuleSlot[]): Index {
  const byRef = new Map<string, number>();
  works.forEach((work, at) => {
    if (!byRef.has(work.ref)) byRef.set(work.ref, at);
  });
  return { works, byRef, slots };
}

/**
 * A sale's home. `works` — everyone's around it (the wait and a day more on each side), any order; `slots` — the
 * schedule slots of the people (none: a junction nobody wrote to waits for the owner, as ledger's Go). Pure.
 */
export function homeOfSale(sale: RuleSale, works: readonly RuleWork[], slots: readonly RuleSlot[], now: number, rule: SaleRuleConfig = SALE_RULE): SaleHome {
  return home(rule, sale, indexOf(works, slots), now);
}

/** Every sale's home, in the order given. Pure. */
export function homesOfSales(
  sales: readonly RuleSale[],
  works: readonly RuleWork[],
  slots: readonly RuleSlot[],
  now: number,
  rule: SaleRuleConfig = SALE_RULE,
): SaleHome[] {
  const ix = indexOf(works, slots);
  return sales.map((sale) => home(rule, sale, ix, now));
}

const MINUTES_OF_DAY = 1440;

/** The day of the week of a Moscow day (YYYY-MM-DD). Pure. */
export function weekdayOfDay(day: string): RuleWeekday {
  return RULE_WEEKDAYS[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7]!;
}

/**
 * Whether a person's schedule slot on a page runs at an instant: a slot that began today or, crossing midnight, the
 * day before, among the person's lines of the day it began — their lines of that page valid that day if any, else
 * their every-page ones — and that runs on that day's weekday. Pure.
 */
export function slotRuns(slots: readonly RuleSlot[], input: { personId: number; pageId: number | null; at: number }): boolean {
  const own = slots.filter((slot) => slot.personId === input.personId);
  const day = moscowDayOf(input.at);
  const minute = Math.floor((input.at - Date.parse(`${day}T00:00:00+03:00`)) / 60_000);
  // Begun today; or the day before, `minute` past its midnight being a day more of minutes from its start.
  const begun = [{ on: day, minute }, { on: moscowDayOf(input.at - DAY_MS), minute: minute + MINUTES_OF_DAY }];
  return begun.some(({ on, minute: sinceMidnight }) => {
    const weekday = weekdayOfDay(on);
    return linesOn(own, input.pageId, on).some((slot) => {
      const length = (slot.endMinute - slot.startMinute + MINUTES_OF_DAY) % MINUTES_OF_DAY;
      return length > 0 && sinceMidnight >= slot.startMinute && sinceMidnight - slot.startMinute < length
        && (slot.weekdays === null || slot.weekdays.includes(weekday));
    });
  });
}

/** A person's lines on a page for a Moscow day: the page's own valid that day, else the every-page ones valid that day. */
function linesOn(own: readonly RuleSlot[], pageId: number | null, on: string): RuleSlot[] {
  const valid = own.filter((slot) => (slot.validFrom === null || slot.validFrom <= on) && (slot.validTo === null || on <= slot.validTo));
  const ofPage = pageId === null ? [] : valid.filter((slot) => slot.pageId === pageId);
  return ofPage.length > 0 ? ofPage : valid.filter((slot) => slot.pageId === null);
}

const homeOf = (
  kind: SaleHomeKind,
  reason: SaleHomeReason,
  extra: Partial<Pick<SaleHome, "shares" | "pot" | "waitsUntil" | "slotJunction">> = {},
): SaleHome => ({
  kind, reason, shares: extra.shares ?? [], pot: extra.pot ?? null, waitsUntil: extra.waitsUntil ?? null, slotJunction: extra.slotJunction ?? false,
});

function home(rule: SaleRuleConfig, sale: RuleSale, ix: Index, now: number): SaleHome {
  const found = ruleHome(rule, sale, ix, now);
  if (found.kind === "nobody" && sale.claimedBy !== null) {
    return homeOf("shift", "owner_claim", {
      shares: [{ workRef: null, userId: sale.claimedBy, percent: 100, mills: sale.netMills }], slotJunction: found.slotJunction,
    });
  }
  return found;
}

/** The home by the rule alone, the claims aside. */
function ruleHome(rule: SaleRuleConfig, sale: RuleSale, ix: Index, now: number): SaleHome {
  if (sale.occurredAt < rule.since) return homeOf("before_rule", "sale_before_rule");
  const shifts: RuleWork[] = [];
  const visits: RuleWork[] = [];
  const seen = new Set<string>();
  for (const ref of sale.holders) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const at = ix.byRef.get(ref);
    if (at === undefined) return homeOf("unknown", "holder_not_in_works");
    const work = ix.works[at]!;
    if (work.kind === "visit") visits.push(work);
    else shifts.push(work);
  }
  // Hub's old rule: the shifts holding it that `settleSale` does not call a colleague's.
  const old = oldHolders(shifts, sale.lastWriter);
  if (old.some((work) => beforeRule(rule, work))) return homeOf("before_rule", "work_before_rule");
  if (sale.kind === "ppv" || sale.kind === "tip") {
    if (sale.postTip) return homeOf("pot", "post_tip", { pot: POT_OBSHAK });
    if (sale.campaign) return homeOf("pot", "campaign", { pot: POT_OBSHAK });
    if (sale.ppvSender !== null && sale.ppvSender.role === "chatter") {
      const sender = sale.ppvSender;
      const own = homeOfSender(rule, sale, sender.userId, [...shifts, ...visits], ix, now);
      const left = sender.leftAt !== null && sender.leftAt <= now;
      const noShiftTakesIt = own.kind === "waiting" || own.reason === "ppv_sender_no_shift";
      if (!(rule.senderLeftGoesToHolders && left && noShiftTakesIt)) return own;
      // A sender who left the team: the PPV is the shift's that held it (owner, 2026-10-20 and 2026-11-12).
      const byHolders = holdersHome(rule, sale, shifts, visits, old, ix);
      return byHolders.shares.length > 0 ? { ...byHolders, reason: "ppv_sender_left" } : byHolders;
    }
  }
  return holdersHome(rule, sale, shifts, visits, old, ix);
}

/** Rule 3: by the shifts that hold the sale, a look-in when none does. */
function holdersHome(rule: SaleRuleConfig, sale: RuleSale, shifts: readonly RuleWork[], visits: readonly RuleWork[], old: readonly RuleWork[], ix: Index): SaleHome {
  if (old.length === 0) {
    for (const visit of visits) {
      if (sale.lastWriter !== null && visit.userId === sale.lastWriter) {
        if (beforeRule(rule, visit)) return homeOf("before_rule", "work_before_rule");
        return whole(visit, sale.netMills, "look_in_last_writer");
      }
    }
    return homeOf("nobody", "no_holder");
  }
  if (oneUser(old) && oneUser(shifts)) return whole(old[0]!, sale.netMills, "holder");
  if (oneUser(old)) return whole(old[0]!, sale.netMills, "last_writer");
  // Several people's shifts, none of them wrote last: the one whose slot runs, else the owner decides.
  if (rule.junctionToSlotOwner) {
    const slotted = [...new Set(shifts.map((work) => work.userId))]
      .filter((personId) => slotRuns(ix.slots, { personId, pageId: sale.pageId, at: sale.occurredAt }));
    if (slotted.length === 1) {
      return { ...whole(shifts.find((work) => work.userId === slotted[0])!, sale.netMills, "slot_owner"), slotJunction: true };
    }
  }
  return { ...decide(sale, [...shifts, ...visits], shifts, ix), slotJunction: true };
}

/**
 * The shifts Hub's `settleSale` gives the sale to: each that is alone or whose person wrote last; when the last writer
 * is a colleague among them, only theirs; when none of them is, all of them.
 */
function oldHolders(shifts: readonly RuleWork[], lastWriter: number | null): RuleWork[] {
  return shifts.filter((work) => {
    let others = false;
    let writerAmong = false;
    for (const other of shifts) {
      if (other.userId === work.userId) continue;
      others = true;
      if (lastWriter !== null && other.userId === lastWriter) writerAmong = true;
    }
    const mine = !others || (lastWriter !== null && lastWriter === work.userId);
    return mine || !writerAmong;
  });
}

function oneUser(works: readonly RuleWork[]): boolean {
  return works.length > 0 && works.every((work) => work.userId === works[0]!.userId);
}

/**
 * A chatter's PPV goes to their own work holding it, their shift going then, their next one within the wait; till the
 * wait is over it waits. Their work of a day before the rule takes nothing.
 */
function homeOfSender(rule: SaleRuleConfig, sale: RuleSale, sender: number, holders: readonly RuleWork[], ix: Index, now: number): SaleHome {
  const at = sale.occurredAt;
  const theirs = (work: RuleWork) => work.userId === sender && !beforeRule(rule, work);
  for (const work of holders) {
    if (theirs(work)) return whole(work, sale.netMills, "ppv_sender");
  }
  const next: RuleWork[] = [];
  for (const work of ix.works) {
    if (work.kind === "visit" || !theirs(work)) continue;
    if (work.startedAt <= at && at < work.endedAt) return whole(work, sale.netMills, "ppv_sender_other_page");
    if (work.startedAt > at && work.startedAt <= at + rule.ppvWaitMs) next.push(work);
  }
  if (next.length > 0) {
    // Stable, as Go's sort.SliceStable: of two starting together, the one listed first.
    const first = next.reduce((best, work) => (work.startedAt < best.startedAt ? work : best));
    return whole(first, sale.netMills, "ppv_sender_next_shift");
  }
  const until = at + rule.ppvWaitMs;
  if (until > now) return homeOf("waiting", "ppv_sender_waiting", { waitsUntil: until });
  return homeOf("nobody", "ppv_sender_no_shift");
}

/**
 * Work of a Moscow day before the rule's first day keeps what the old rule gives it, takes nothing new. Its day is
 * Hub's `dayOfWork` (the day of its middle instant), as ledger's `DayOfWork`.
 */
function beforeRule(rule: SaleRuleConfig, work: RuleWork): boolean {
  return dayOfWork(work) < moscowDayOf(rule.since);
}

function whole(work: RuleWork, net: number, reason: SaleHomeReason): SaleHome {
  return homeOf(work.kind, reason, { shares: [{ workRef: work.ref, userId: work.userId, percent: 100, mills: net }] });
}

// ─── marks.go ────────────────────────────────────────────────────────────────

/**
 * Several shifts hold the sale and none of their people wrote last to the fan. The owner's split wins; else the
 * chatters' confirmed marks, when they agree (Hub's `judgeMarks` and `dueCreditsOf`); else it waits for a decision.
 * `holders` — every work holding it, shifts first; `shifts` — the shifts among them.
 */
function decide(sale: RuleSale, holders: readonly RuleWork[], shifts: readonly RuleWork[], ix: Index): SaleHome {
  const net = sale.netMills;
  const resolution = sale.resolution ?? [];
  if (resolution.length > 0) {
    let given = 0;
    const shares = resolution.map((share, at): SaleShare => {
      // The last share takes the rounding: the shares sum to the net exactly.
      const mills = at === resolution.length - 1 ? net - given : millsToNumber(millsPercentOf(net, share.percent));
      given += mills;
      return { workRef: workRefOf(share.userId, holders), userId: share.userId, percent: share.percent, mills };
    });
    return sharesHome(shares, "owner_split", ix);
  }
  const settled = judgeMarks(sale.marks);
  if (settled.kind === "mine") {
    const user = settled.users[0]!;
    const mark = markOf(sale.marks, user);
    if (mark.confirmed) {
      // «моё» claims the net, or the chatter's own amount, never above it.
      const mills = mark.ownAmountMills !== null && mark.ownAmountMills < net ? mark.ownAmountMills : net;
      return sharesHome([{ workRef: workRefOf(user, holders), userId: user, percent: percentOfNet(mills, net), mills }], "marks", ix);
    }
  } else if (settled.kind === "share") {
    const [a, b] = settled.users as [number, number];
    if (markOf(sale.marks, a).confirmed || markOf(sale.marks, b).confirmed) {
      const low = Math.min(a, b);
      const high = Math.max(a, b);
      const first = millsToNumber(millsPercentOf(net, 50)); // the odd mill to the lower user id
      return sharesHome([
        { workRef: workRefOf(low, holders), userId: low, percent: 50, mills: first },
        { workRef: workRefOf(high, holders), userId: high, percent: 50, mills: net - first },
      ], "marks", ix);
    }
  } else if (settled.kind === "not_mine") {
    if (sale.marks.length > 0 && everyoneSaysNotMine(sale.marks, shifts)) return homeOf("nobody", "marks");
  } else {
    return homeOf("decide", "marks_disagree");
  }
  return homeOf("decide", "no_last_writer");
}

/**
 * Hub's `judgeMarks`: the marks agree only as one «моё» or as two «делим» naming each other («не моё» beside them is
 * fine); no claim at all — nobody's; anything else is a dispute the owner splits.
 */
function judgeMarks(marks: readonly RuleMark[]): { kind: "mine" | "share" | "not_mine" | "dispute"; users: number[] } {
  const claims = marks.filter((mark) => mark.mark !== "not_mine");
  if (claims.length === 0) return { kind: "not_mine", users: [] };
  if (claims.length === 1 && claims[0]!.mark === "mine") return { kind: "mine", users: [claims[0]!.userId] };
  if (claims.length === 2) {
    const [a, b] = claims as [RuleMark, RuleMark];
    if (a.mark === "share" && b.mark === "share" && a.shareWith === b.userId && b.shareWith === a.userId) {
      return { kind: "share", users: [a.userId, b.userId] };
    }
  }
  return { kind: "dispute", users: [] };
}

const NO_MARK: RuleMark = { userId: 0, mark: "not_mine", shareWith: null, ownAmountMills: null, confirmed: false };

function markOf(marks: readonly RuleMark[], user: number): RuleMark {
  return marks.find((mark) => mark.userId === user) ?? NO_MARK;
}

/** Every person whose shift holds the sale confirmed «не моё». */
function everyoneSaysNotMine(marks: readonly RuleMark[], shifts: readonly RuleWork[]): boolean {
  return shifts.every((work) => {
    const mark = markOf(marks, work.userId);
    return mark.userId === work.userId && mark.mark === "not_mine" && mark.confirmed;
  });
}

/** The user's work holding the sale (a shift before a look-in), or null — none holds it. */
function workRefOf(user: number, holders: readonly RuleWork[]): string | null {
  return holders.find((work) => work.userId === user)?.ref ?? null;
}

/** A home of shares: a visit's when every share is a look-in's, else a shift's. */
function sharesHome(shares: SaleShare[], reason: SaleHomeReason, ix: Index): SaleHome {
  const allVisits = shares.every((share) => {
    const at = share.workRef === null ? undefined : ix.byRef.get(share.workRef);
    return at !== undefined && ix.works[at]!.kind === "visit";
  });
  return homeOf(allVisits ? "visit" : "shift", reason, { shares });
}

/** The whole percent of the net an amount is, rounded down; all of it — 100. */
function percentOfNet(mills: number, net: number): number {
  if (net === 0 || mills === net) return 100;
  return millsToNumber((millsFromInteger(mills) * 100n) / millsFromInteger(net));
}
