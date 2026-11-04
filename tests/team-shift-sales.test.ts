import { describe, expect, it } from "vitest";

import type { ShiftSale } from "@agency_hub_core/db";
import type { ComputedWork } from "../apps/runtime/src/services/chatter-shifts.ts";
import { contestedSales, salesOfWork, teamShiftMoney, type HeldShift } from "../apps/runtime/src/services/team-shift-sales.ts";

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
});
