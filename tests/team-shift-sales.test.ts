import { describe, expect, it } from "vitest";

import type { ShiftSale } from "@agency_hub_core/db";
import type { ComputedWork } from "../apps/runtime/src/services/chatter-shifts.ts";
import { homesOfSales, reportSalesOf, type Piece, type SaleRuleFacts } from "../apps/runtime/src/services/sale-rule.ts";
import {
  outsideMoney, salesOfWork, salesOutsideShifts, shiftSalesWindow, teamShiftMoney, type HeldShift,
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
  const window = { from: at("2026-11-04T00:00:00Z"), to: at("2026-11-04T12:00:00Z") };

  it("is every sale less the shifts' money, a look-in holding only those its person last wrote to", () => {
    const lastWriters = new Map([[visited!.transactionId, 2], [visitedOther!.transactionId, 1]]);
    const settled = homesOfSales({ sales, shifts, visits, lastWriters, facts: new Map(), now: NOW.getTime() });
    const outside = salesOutsideShifts(settled, window);
    expect(outside.map((one) => one.sale.transactionId)).toEqual([early, visited, visitedOther, nobodys, otherPage].map((one) => one!.transactionId));
    const money = outsideMoney(outside, ["2026-11-04"]);
    expect(money.visitsNetMills).toBe(visited!.netMills);
    expect(money.nobodyNetMills).toBe(early!.netMills + visitedOther!.netMills + nobodys!.netMills + otherPage!.netMills);
    const total = sales.reduce((sum, one) => sum + one.netMills, 0);
    expect(money.visitsNetMills + money.nobodyNetMills + inShift!.netMills).toBe(total);
    expect(money.daily).toEqual([{ date: "2026-11-04", visitsNetMills: 40_000, nobodyNetMills: 39_000, commonNetMills: 0, waitingNetMills: 0 }]);
    expect(money.pages[0]).toEqual({ pageLabel: "ari-1", visitsNetMills: 40_000, nobodyNetMills: 34_000, commonNetMills: 0, waitingNetMills: 0 });
  });

  it("leaves the shifts' money alone", () => {
    const money = teamShiftMoney({ days: 1, now: NOW, shifts, lastWriters: new Map(), firstActivity: LONG_AGO });
    expect(money.team.salesNetMills).toBe(inShift!.netMills);
  });
});

// The owner, 2026-11-08: from 02.11 00:00 Moscow a PPV is its sender's («долёт отправителю»), a tip under a wall post and
// an OnlyFans Campaign contribution the общак; renewals and the rest stay the shift's. The weeks before keep the old rule.
describe("the team's rule: долёт to the PPV's sender, the общак apart", () => {
  const SENDER = 3;
  const HOLDER = 4;
  // Thu 5 Nov: the holder on lora-vip 13:00–20:00 MSK; the PPV's sender's night shift there from 03:39 MSK on the 6th.
  const holder = held(HOLDER, work("2026-11-05T10:00:00Z", "2026-11-05T17:00:00Z", "lora-vip"), []);
  const senderNight = held(SENDER, work("2026-11-06T00:39:00Z", "2026-11-06T08:00:00Z", "lora-vip"), []);
  const piece = (one: HeldShift): Piece => ({ userId: one.userId, username: one.username, work: one.work });
  const ppvOf = (sender: number, name: string): SaleRuleFacts => ({ ppvSender: { userId: sender, username: name }, common: null });
  const now = at("2026-11-08T12:00:00Z");

  it("moves a colleague's PPV bought in my shift to the sender's next shift, and counts it once for the team", () => {
    const ppv = { ...sale("2026-11-05T13:44:00Z", 30_000, "lora-vip"), kind: "message_purchase" };
    const mine = sale("2026-11-05T12:00:00Z", 10_000, "lora-vip");
    const sales = [mine, ppv];
    const shifts = [{ ...holder, held: salesOfWork(holder.work, sales) }, { ...senderNight, held: salesOfWork(senderNight.work, sales) }];
    const facts = new Map([[ppv.transactionId, ppvOf(SENDER, "sender")]]);
    const settled = homesOfSales({ sales, shifts, visits: [], lastWriters: new Map(), facts, now });
    expect(settled.find((one) => one.sale === ppv)!.home).toMatchObject({ kind: "pieces", bySender: true, pieces: [{ userId: SENDER }] });

    const money = teamShiftMoney({ days: 7, now: new Date(now), until: "2026-11-08", shifts, lastWriters: new Map(), firstActivity: new Map([[HOLDER, new Date(0)], [SENDER, new Date(0)]]), settled });
    const byUser = new Map(money.chatters.map((one) => [one.userId, one]));
    expect(byUser.get(HOLDER)!.salesNetMills).toBe(10_000);
    expect(byUser.get(SENDER)!.salesNetMills).toBe(30_000);
    expect(money.team.salesNetMills).toBe(40_000);
    // The shift it came to is the sender's: a sale outside its pages' time, in its money.
    expect(money.shifts.find((one) => one.userId === SENDER)).toMatchObject({ date: "2026-11-06", salesNetMills: 30_000, sales: 1 });
    // Its report lists it for the sender, not for the holder, whose shift held it.
    expect(reportSalesOf({ settled, lastWriters: new Map() }, senderNight)).toEqual([ppv]);
    expect(reportSalesOf({ settled, lastWriters: new Map() }, holder)).toEqual([mine]);
  });

  it("puts the sender's PPV in their shift going then on another page, else waits for their next one, a week at most", () => {
    const ppv = { ...sale("2026-11-05T14:00:00Z", 24_000, "lora-vip"), kind: "message_purchase" };
    const elsewhere = work("2026-11-05T12:00:00Z", "2026-11-05T18:00:00Z", "lora-2");
    const going = homesOfSales({ sales: [ppv], shifts: [piece(holder), { userId: SENDER, username: "sender", work: elsewhere }], visits: [], lastWriters: new Map(), facts: new Map([[ppv.transactionId, ppvOf(SENDER, "sender")]]), now });
    expect(going[0]!.home).toMatchObject({ kind: "pieces", pieces: [{ work: elsewhere }] });

    const off = homesOfSales({ sales: [ppv], shifts: [piece(holder)], visits: [], lastWriters: new Map(), facts: new Map([[ppv.transactionId, ppvOf(SENDER, "sender")]]), now });
    expect(off[0]!.home).toEqual({ kind: "waiting", userId: SENDER, username: "sender" });
    const late = homesOfSales({ sales: [ppv], shifts: [piece(holder)], visits: [], lastWriters: new Map(), facts: new Map([[ppv.transactionId, ppvOf(SENDER, "sender")]]), now: at("2026-11-13T12:00:00Z") });
    expect(late[0]!.home).toEqual({ kind: "nobody", bySender: true });

    const outside = outsideMoney(salesOutsideShifts(off, { from: at("2026-11-04T21:00:00Z"), to: at("2026-11-05T21:00:00Z") }), ["2026-11-05"]);
    expect(outside).toMatchObject({ waitingNetMills: 24_000, nobodyNetMills: 0, sales: [{ home: "waiting", waitingFor: "sender" }] });
  });

  it("keeps a PPV the sender's own look-in holds in it", () => {
    const look = { userId: SENDER, username: "sender", work: { ...work("2026-11-05T09:00:00Z", "2026-11-05T09:50:00Z", "lora-vip"), kind: "visit" as const } };
    const ppv = { ...sale("2026-11-05T09:30:00Z", 50_000, "lora-vip"), kind: "message_purchase" };
    const homes = homesOfSales({ sales: [ppv], shifts: [], visits: [look], lastWriters: new Map(), facts: new Map([[ppv.transactionId, ppvOf(SENDER, "sender")]]), now });
    expect(homes[0]!.home).toMatchObject({ kind: "pieces", pieces: [look] });
  });

  it("gives the общак no shift, and lists it apart", () => {
    const postTip = sale("2026-11-05T14:00:00Z", 300_000, "lora-vip");
    const campaign = sale("2026-11-05T15:00:00Z", 100_000, "lora-vip");
    const sales = [postTip, campaign];
    const facts = new Map<number, SaleRuleFacts>([[postTip.transactionId, { ppvSender: null, common: "post_tip" }], [campaign.transactionId, { ppvSender: null, common: "campaign" }]]);
    const shifts = [{ ...holder, held: salesOfWork(holder.work, sales) }];
    const settled = homesOfSales({ sales, shifts, visits: [], lastWriters: new Map(), facts, now });
    const money = teamShiftMoney({ days: 7, now: new Date(now), until: "2026-11-08", shifts, lastWriters: new Map(), firstActivity: LONG_AGO, settled });
    expect(money.team.salesNetMills).toBe(0);
    const outside = outsideMoney(salesOutsideShifts(settled, { from: at("2026-11-01T21:00:00Z"), to: now }), ["2026-11-05"]);
    expect(outside.commonNetMills).toBe(400_000);
    expect(reportSalesOf({ settled, lastWriters: new Map() }, holder)).toEqual([]);
  });

  it("leaves a renewal, a chat tip and a PPV without a chatter author to the shift that holds it", () => {
    const renewal = { ...sale("2026-11-05T12:00:00Z", 40_000, "lora-vip"), kind: "subscription" };
    const ownerPpv = { ...sale("2026-11-05T12:10:00Z", 20_000, "lora-vip"), kind: "message_purchase" };
    const sales = [renewal, ownerPpv];
    const shifts = [{ ...holder, held: salesOfWork(holder.work, sales) }];
    // A PPV the owner's account sent has no chatter sender: `saleRuleFactsOf` gives it none.
    const settled = homesOfSales({ sales, shifts, visits: [], lastWriters: new Map(), facts: new Map([[ownerPpv.transactionId, { ppvSender: null, common: null }]]), now });
    for (const one of settled) expect(one.home).toMatchObject({ kind: "pieces", bySender: false, pieces: [{ userId: HOLDER }] });
  });

  it("does not move a cent of the weeks before 2 November", () => {
    // Sun 1 Nov: the sender's PPV bought in the holder's shift — before the rule, the holder's.
    const sunday = held(HOLDER, work("2026-11-01T08:00:00Z", "2026-11-01T13:30:00Z", "lora-vip"), []);
    const before = { ...sale("2026-11-01T13:00:00Z", 30_000, "lora-vip"), kind: "message_purchase" };
    // The holder's night of 1 Nov past midnight: a shift of the 1st keeps what the old rule gives it.
    const night = held(HOLDER, work("2026-11-01T16:00:00Z", "2026-11-01T22:30:00Z", "lora-vip"), []);
    const afterMidnight = { ...sale("2026-11-01T21:20:00Z", 12_000, "lora-vip"), kind: "message_purchase" };
    const sales = [before, afterMidnight];
    const shifts = [sunday, night, senderNight].map((one) => ({ ...one, held: salesOfWork(one.work, sales) }));
    const facts = new Map([[before.transactionId, ppvOf(SENDER, "sender")], [afterMidnight.transactionId, ppvOf(SENDER, "sender")]]);
    const settled = homesOfSales({ sales, shifts, visits: [], lastWriters: new Map(), facts, now });
    expect(settled.map((one) => one.home)).toMatchObject([
      { kind: "pieces", bySender: false, pieces: [{ userId: HOLDER }] },
      { kind: "pieces", bySender: false, pieces: [{ userId: HOLDER }] },
    ]);
    const lastWeek = teamShiftMoney({ days: 7, now: new Date(now), until: "2026-11-01", shifts, lastWriters: new Map(), firstActivity: LONG_AGO, settled });
    const oldRule = teamShiftMoney({ days: 7, now: new Date(now), until: "2026-11-01", shifts, lastWriters: new Map(), firstActivity: LONG_AGO });
    expect(lastWeek.chatters).toEqual(oldRule.chatters);
    expect(lastWeek.team.salesNetMills).toBe(42_000);
  });
});
