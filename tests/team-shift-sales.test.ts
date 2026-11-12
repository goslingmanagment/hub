import { describe, expect, it } from "vitest";

import type { ShiftSale } from "@agency_hub_core/db";
import type { ComputedWork } from "../apps/runtime/src/services/chatter-shifts.ts";
import { ruleWorkRef, type ScreenHome, type ScreensRule } from "../apps/runtime/src/services/sale-rule-screens.ts";
import {
  contestedSales, outsideByRule, outsideMoney, outsideMoneyByRule, salesNoShiftHolds, salesOfWork, settleOutsideShifts, shiftSalesWindow, teamShiftMoney,
  teamShiftMoneyOf, type HeldShift, type RuledShiftsInput,
} from "../apps/runtime/src/services/team-shift-sales.ts";

// The team's money by shift: a sale two shifts hold is the last writer's; neither
// wrote — both have it, and the team still counts it once.

const HOUR = 3_600_000;
// 2026-11-04 15:00 MSK.
const NOW = new Date("2026-11-04T12:00:00Z");
const at = (iso: string) => Date.parse(iso);

function work(startedAt: string, endedAt: string, page = "ari-1"): ComputedWork {
  const start = at(startedAt);
  const end = at(endedAt);
  return {
    kind: "shift",
    startedAt: start,
    endedAt: end,
    ongoing: false,
    workedMinutes: Math.round((end - start) / 60_000),
    pauses: [],
    lastInputAt: end - 60_000,
    lastBeatAt: end - 60_000,
    pages: new Map([[page, Math.round((end - start) / 60_000)]]),
    messages: new Map([[page, 60]]),
    salesSince: new Map([[page, start]]),
  };
}

let nextId = 1;
function sale(occurredAt: string, netMills: number, page = "ari-1"): ShiftSale {
  return {
    transactionId: nextId++,
    pageId: 1,
    pageLabel: page,
    platform: "fansly",
    fanId: null,
    fanRef: "fan",
    fanName: null,
    kind: "tip",
    grossMills: netMills,
    netMills,
    occurredAt: new Date(occurredAt),
  };
}

function held(userId: number, shift: ComputedWork, sales: readonly ShiftSale[]): HeldShift {
  return { userId, username: `user${userId}`, work: shift, held: salesOfWork(shift, sales) };
}

const LONG_AGO = new Map([[1, new Date("2026-01-01T00:00:00Z")], [2, new Date("2026-01-01T00:00:00Z")]]);

describe("teamShiftMoney", () => {
  it("gives a sale both shifts hold to who last wrote, and counts it once for the team", () => {
    const shared = sale("2026-11-04T08:00:00Z", 30_000);
    const mine = sale("2026-11-04T07:00:00Z", 10_000);
    const sales = [mine, shared];
    const shifts = [held(1, work("2026-11-04T06:00:00Z", "2026-11-04T10:00:00Z"), sales), held(2, work("2026-11-04T07:30:00Z", "2026-11-04T11:00:00Z"), sales)];
    expect(contestedSales(shifts).map((one) => one.transactionId)).toEqual([shared.transactionId]);

    const money = teamShiftMoney({ days: 7, now: NOW, shifts, lastWriters: new Map([[shared.transactionId, 2]]), firstActivity: LONG_AGO });
    const byUser = new Map(money.chatters.map((one) => [one.userId, one]));
    expect(byUser.get(1)!.salesNetMills).toBe(10_000);
    expect(byUser.get(2)!.salesNetMills).toBe(30_000);
    expect(money.team.salesNetMills).toBe(40_000);
    expect(money.team.daily.at(-1)).toMatchObject({ date: "2026-11-04", salesNetMills: 40_000, shifts: 2 });
  });

  it("counts a sale neither of them wrote for both, and for the team once", () => {
    const shared = sale("2026-11-04T08:00:00Z", 30_000);
    const shifts = [held(1, work("2026-11-04T06:00:00Z", "2026-11-04T10:00:00Z"), [shared]), held(2, work("2026-11-04T07:30:00Z", "2026-11-04T11:00:00Z"), [shared])];
    const money = teamShiftMoney({ days: 7, now: NOW, shifts, lastWriters: new Map(), firstActivity: LONG_AGO });
    for (const chatter of money.chatters) expect(chatter).toMatchObject({ salesNetMills: 30_000, overlapNetMills: 30_000 });
    expect(money.team.salesNetMills).toBe(30_000);
    expect(money.shifts.map((one) => one.overlapNetMills)).toEqual([30_000, 30_000]);
  });

  it("puts the week before in `previous`, and none for whom Hub did not watch all of it", () => {
    const sales = [sale("2026-10-30T08:00:00Z", 5_000), sale("2026-11-03T08:00:00Z", 8_000)];
    const thisWeek = work("2026-11-03T06:00:00Z", "2026-11-03T10:00:00Z");
    const weekBefore = work("2026-10-27T06:00:00Z", "2026-10-27T10:00:00Z");
    const earlier = sale("2026-10-27T07:00:00Z", 2_000);
    const all = [earlier, ...sales];
    const shifts = [held(1, thisWeek, all), held(1, weekBefore, all), held(2, work("2026-11-02T06:00:00Z", "2026-11-02T08:00:00Z", "lora-1"), all)];
    const money = teamShiftMoney({
      days: 7, now: NOW, shifts, lastWriters: new Map(),
      firstActivity: new Map([[1, new Date("2026-10-01T00:00:00Z")], [2, new Date(NOW.getTime() - 3 * 24 * HOUR)]]),
    });
    const byUser = new Map(money.chatters.map((one) => [one.userId, one]));
    expect(byUser.get(1)).toMatchObject({ shifts: 1, salesNetMills: 8_000, previous: { shifts: 1, salesNetMills: 2_000, workedMinutes: 240 } });
    expect(byUser.get(2)!.previous).toBeNull();
    // The team's week before is known: Hub watched it; the newcomer simply was not there.
    expect(money.previous).toMatchObject({ shifts: 1, salesNetMills: 2_000 });
    expect(money.knownSince).toBe("2026-10-01T00:00:00.000Z");
    const late = teamShiftMoney({ days: 7, now: NOW, shifts, lastWriters: new Map(), firstActivity: new Map([[1, new Date("2026-10-25T00:00:00Z")]]) });
    expect(late.previous).toBeNull();
  });

  it("compares this week so far with last week up to the same hour, not all of it", () => {
    // Wednesday 4 Nov 15:00 MSK; the week is Mon 2 – Sun 8 Nov.
    const sales = [sale("2026-10-27T08:00:00Z", 4_000), sale("2026-10-31T08:00:00Z", 9_000), sale("2026-11-03T08:00:00Z", 6_000)];
    const shifts = [
      held(1, work("2026-10-27T06:00:00Z", "2026-10-27T10:00:00Z"), sales), // last Tuesday: before the same hour
      held(1, work("2026-10-31T06:00:00Z", "2026-10-31T10:00:00Z"), sales), // last Saturday: after it
      held(1, work("2026-11-03T06:00:00Z", "2026-11-03T10:00:00Z"), sales),
    ];
    const money = teamShiftMoney({ days: 7, now: NOW, until: "2026-11-08", shifts, lastWriters: new Map(), firstActivity: LONG_AGO });
    expect(money.team.daily.map((day) => day.date)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
    expect(money.team.salesNetMills).toBe(6_000);
    expect(money.previous).toMatchObject({ shifts: 1, salesNetMills: 4_000 });
  });

  it("shows a past week whole, against the week before it whole", () => {
    const window = shiftSalesWindow({ days: 7, now: NOW, until: "2026-11-01" });
    expect(new Date(window.from).toISOString()).toBe("2026-10-25T21:00:00.000Z");
    expect(new Date(window.to).toISOString()).toBe("2026-11-01T21:00:00.000Z");
    expect(window.previousTo).toBe(window.from);
    // A day far ahead keeps today inside the window.
    expect(shiftSalesWindow({ days: 7, now: NOW, until: "2026-12-31" }).dates.at(-1)).toBe("2026-11-10");
  });
});

// Sales no shift held were nowhere on the screens: $1,213.50 of $10,493.57 in the week to 07.11 (the shift audit).
describe("the money outside shifts", () => {
  const sales = [
    sale("2026-11-04T06:30:00Z", 10_000),
    sale("2026-11-04T07:30:00Z", 20_000),
    sale("2026-11-04T08:10:00Z", 40_000),
    sale("2026-11-04T08:20:00Z", 8_000),
    sale("2026-11-04T08:40:00Z", 16_000),
    sale("2026-11-04T09:30:00Z", 5_000, "lora-1"),
  ];
  const [early, inShift, visited, visitedOther, nobodys, otherPage] = sales;
  // A shift on ari-1 07:00–08:00, a look-in on ari-1 08:00–09:00 and no one on lora-1.
  const shifts = [held(1, work("2026-11-04T07:00:00Z", "2026-11-04T08:00:00Z"), sales)];
  const visits = [{ userId: 2, username: "user2", work: { ...work("2026-11-04T08:00:00Z", "2026-11-04T09:00:00Z"), kind: "visit" as const } }];
  const from = at("2026-11-04T00:00:00Z");
  const to = at("2026-11-04T12:00:00Z");

  it("is every sale less the ones a shift or a look-in holds, a look-in holding only those its person last wrote to", () => {
    const unheld = salesNoShiftHolds({ from, to, sales, shifts });
    expect(unheld.map((one) => one.transactionId)).toEqual([early, visited, visitedOther, nobodys, otherPage].map((one) => one!.transactionId));
    const lastWriters = new Map([[visited!.transactionId, 2], [visitedOther!.transactionId, 1]]);
    const settled = settleOutsideShifts(unheld, visits, lastWriters);
    const money = outsideMoney(settled, ["2026-11-04"]);
    expect(money.visitsNetMills).toBe(visited!.netMills);
    expect(money.nobodyNetMills).toBe(early!.netMills + visitedOther!.netMills + nobodys!.netMills + otherPage!.netMills);
    const total = sales.reduce((sum, one) => sum + one.netMills, 0);
    expect(money.visitsNetMills + money.nobodyNetMills + inShift!.netMills).toBe(total);
    expect(money.daily).toEqual([{ date: "2026-11-04", visitsNetMills: 40_000, nobodyNetMills: 39_000 }]);
    expect(money.pages[0]).toEqual({ pageLabel: "ari-1", visitsNetMills: 40_000, nobodyNetMills: 34_000 });
  });

  it("leaves the shifts' money alone", () => {
    const money = teamShiftMoney({ days: 1, now: NOW, shifts, lastWriters: new Map(), firstActivity: LONG_AGO });
    expect(money.team.salesNetMills).toBe(inShift!.netMills);
  });
});

// From the screens' switch on (sale-rule-screens.ts) a shift of a report date of the switch's day or later has what
// the rule's homes credit it: a junction sale once, never for both; a week before the switch stays as it was.
describe("teamShiftMoney by the one rule", () => {
  const RULED: ScreensRule = { from: "2026-11-04", live: false };
  const homeOf = (sale: ShiftSale, kind: ScreenHome["kind"], shares: Array<{ userId: number; shift: ComputedWork }> = []): [number, ScreenHome] => [
    sale.transactionId,
    { transactionId: sale.transactionId, kind, reason: kind === "decide" ? "no_last_writer" : "holder", shares: shares.map(({ userId, shift }) => ({ userId, workRef: ruleWorkRef(userId, shift), mills: sale.netMills })) },
  ];
  const ruleOf = (sales: readonly ShiftSale[], homes: Array<[number, ScreenHome]>, rule = RULED): RuledShiftsInput => ({
    rule, homes: new Map(homes), sales: new Map(sales.map((one) => [one.transactionId, one])), visits: [],
  });

  it("counts a junction sale nobody wrote to once: the owner's to decide, or the slot's", () => {
    const shared = sale("2026-11-04T08:00:00Z", 30_000);
    const mine = sale("2026-11-04T07:00:00Z", 10_000);
    const sales = [mine, shared];
    const first = work("2026-11-04T06:00:00Z", "2026-11-04T10:00:00Z");
    const second = work("2026-11-04T07:30:00Z", "2026-11-04T11:00:00Z");
    const shifts = [held(1, first, sales), held(2, second, sales)];
    const before = teamShiftMoney({ days: 7, now: NOW, shifts, lastWriters: new Map(), firstActivity: LONG_AGO });
    expect(before.chatters.map((one) => [one.userId, one.salesNetMills, one.overlapNetMills])).toEqual([[1, 40_000, 30_000], [2, 30_000, 30_000]]);

    const decided = ruleOf(sales, [homeOf(mine, "shift", [{ userId: 1, shift: first }]), homeOf(shared, "decide")]);
    const byRule = teamShiftMoneyOf({ days: 7, now: NOW, shifts, lastWriters: new Map(), firstActivity: LONG_AGO, rule: decided });
    const byUser = new Map(byRule.result.chatters.map((one) => [one.userId, one]));
    expect(byUser.get(1)).toMatchObject({ salesNetMills: 10_000, overlapNetMills: 0, sales: 1 });
    expect(byUser.get(2)).toMatchObject({ salesNetMills: 0, overlapNetMills: 0, sales: 0 });
    expect(byRule.result.team.salesNetMills).toBe(10_000);
    // Not dropped: «вне смен», the owner's to decide.
    const outside = outsideByRule({
      from: at("2026-11-04T00:00:00Z"), to: NOW.getTime(), sales, rule: decided, oldWay: [],
      counted: new Set([...byRule.oldCounted, ...byRule.credited]), heldByRuled: new Set(sales.map((one) => one.transactionId)), usernames: new Map(),
    });
    expect(outsideMoneyByRule(outside, ["2026-11-04"])).toMatchObject({ decideNetMills: 30_000, nobodyNetMills: 0, potNetMills: 0, visitsNetMills: 0 });

    const slotted = ruleOf(sales, [homeOf(mine, "shift", [{ userId: 1, shift: first }]), homeOf(shared, "shift", [{ userId: 2, shift: second }])]);
    const bySlot = teamShiftMoney({ days: 7, now: NOW, shifts, lastWriters: new Map(), firstActivity: LONG_AGO, rule: slotted });
    expect(bySlot.chatters.map((one) => [one.userId, one.salesNetMills, one.overlapNetMills])).toEqual([[2, 30_000, 0], [1, 10_000, 0]]);
    expect(bySlot.team.salesNetMills).toBe(40_000);
    expect(bySlot.shifts.map((one) => one.overlapNetMills)).toEqual([0, 0]);
  });

  it("leaves every shift before the switch as it was", () => {
    const sales = [sale("2026-11-02T08:00:00Z", 5_000), sale("2026-11-03T08:00:00Z", 7_000), sale("2026-11-03T09:00:00Z", 9_000)];
    const monday = work("2026-11-02T06:00:00Z", "2026-11-02T10:00:00Z");
    const tuesday = work("2026-11-03T06:00:00Z", "2026-11-03T10:00:00Z");
    const shifts = [held(1, monday, sales), held(1, tuesday, sales), held(2, work("2026-11-03T08:30:00Z", "2026-11-03T11:00:00Z"), sales)];
    const input = { days: 7, now: NOW, until: "2026-11-08", shifts, lastWriters: new Map<number, number>(), firstActivity: LONG_AGO };
    // Homes that would move everything, from a day after these shifts: nothing moves.
    const homes = sales.map((one) => homeOf(one, "pot"));
    const after = teamShiftMoney({ ...input, rule: ruleOf(sales, homes, { from: "2026-11-04", live: false }) });
    expect(after).toEqual(teamShiftMoney(input));
  });

  it("does not count again a sale an old shift counts, and dates a ruled shift by its report date", () => {
    // The evening before the switch holds a PPV bought at 22:00 whose sender's next shift is after it.
    const ppv = { ...sale("2026-11-03T19:00:00Z", 24_000), kind: "message_purchase" };
    const late = sale("2026-11-04T19:30:00Z", 6_000);
    const sales = [ppv, late];
    const evening = work("2026-11-03T15:00:00Z", "2026-11-03T20:30:00Z");
    // 21:00 on the 4th to 05:00 on the 5th (Moscow): most of it after midnight, begun more than two hours before it.
    const night = work("2026-11-04T18:00:00Z", "2026-11-05T02:00:00Z");
    const now = new Date("2026-11-05T09:00:00Z");
    const shifts = [held(1, evening, sales), held(2, night, sales)];
    const rule = ruleOf(sales, [homeOf(ppv, "shift", [{ userId: 2, shift: night }]), homeOf(late, "shift", [{ userId: 2, shift: night }])]);
    const money = teamShiftMoney({ days: 7, now, until: "2026-11-08", shifts, lastWriters: new Map(), firstActivity: LONG_AGO, rule });
    const byUser = new Map(money.chatters.map((one) => [one.userId, one]));
    expect(byUser.get(1)!.salesNetMills).toBe(24_000);
    expect(byUser.get(2)!.salesNetMills).toBe(6_000);
    expect(money.team.salesNetMills).toBe(30_000);
    // The old count dates it by its middle (the 5th); the rule by its report date (the day it began, the 4th).
    expect(money.shifts.find((one) => one.userId === 2)!.date).toBe("2026-11-04");
    expect(teamShiftMoney({ days: 7, now, until: "2026-11-08", shifts, lastWriters: new Map(), firstActivity: LONG_AGO }).shifts.find((one) => one.userId === 2)!.date).toBe("2026-11-05");
  });
});
