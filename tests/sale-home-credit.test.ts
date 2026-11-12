import { describe, expect, it } from "vitest";

import type { ShiftSale } from "@agency_hub_core/db";
import type { ComputedWork, PersonPiece } from "../apps/runtime/src/services/chatter-shifts.ts";
import {
  homeCredit, peopleLoginsOf, piecesByUser, ruleWorkRef, ruledWork, type ScreenHome, type ScreensRule,
} from "../apps/runtime/src/services/sale-rule-screens.ts";
import { SALE_HOME_KINDS } from "../apps/runtime/src/services/sale-rule.ts";
import {
  outsideByRule, salesNoShiftHolds, salesOfWork, settleOutsideShifts, shiftSalesWindow, teamShiftMoneyOf, type HeldShift, type RuledShiftsInput,
} from "../apps/runtime/src/services/team-shift-sales.ts";

// Whom and what a home credits, over generated cases: nothing of a sale is lost. Each home's shares, the rest no person
// takes and the old count add up to the net to the mill; and on «Смены» the shifts' credits and «вне смен» add up to
// every sale of the window — whatever the homes say (a decision to a person with no shift, a decision naming a
// person's other login, a split, a «моё» below the net, a look-in's share, a work the switch does not count).

const HOUR = 3_600_000;
const PAGES = ["ari-1", "lora-1"] as const;
const DAY0 = Date.parse("2026-11-08T21:00:00Z"); // 2026-11-09 00:00 MSK
const RULE: ScreensRule = { from: "2026-11-10", live: false };
const NOW = new Date(DAY0 + 4 * 24 * HOUR - 6 * HOUR);

/** A seeded generator: the same cases every run. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return { next, int: (below: number) => Math.floor(next() * below), pick: <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]! };
}

function work(kind: "shift" | "visit", startedAt: number, hours: number, page: string): ComputedWork {
  const endedAt = startedAt + hours * HOUR;
  const minutes = Math.round((endedAt - startedAt) / 60_000);
  return {
    kind, startedAt, endedAt, ongoing: false, workedMinutes: minutes, pauses: [], lastInputAt: endedAt - 60_000, lastBeatAt: endedAt - 60_000,
    pages: new Map([[page, minutes]]), messages: new Map([[page, 60]]), salesSince: new Map([[page, startedAt]]),
  };
}

// Two people with two logins each (an old one and the working one), one with one, a login no person holds.
const LOGINS = peopleLoginsOf([
  { userId: 1, username: "first-new", personId: 1, displayName: "First" },
  { userId: 11, username: "first-old", personId: 1, displayName: "First" },
  { userId: 2, username: "second", personId: 2, displayName: "Second" },
  { userId: 3, username: "third-new", personId: 3, displayName: "Third" },
  { userId: 33, username: "third-old", personId: 3, displayName: "Third" },
  { userId: 4, username: "alone", personId: null, displayName: null },
]);
const USERS = [1, 11, 2, 3, 33, 4, 5];

function caseOf(seed: number) {
  const r = random(seed);
  let id = 1;
  const pieces: PersonPiece[] = [];
  for (const userId of [1, 2, 3, 4]) {
    for (let day = 0; day < 4; day += 1) {
      if (r.next() < 0.3) continue;
      const start = DAY0 + day * 24 * HOUR + (8 + r.int(10)) * HOUR;
      pieces.push({ userId, username: LOGINS.usernameOf(userId), work: work("shift", start, 3 + r.int(5), r.pick(PAGES)) });
      if (r.next() < 0.4) pieces.push({ userId, username: LOGINS.usernameOf(userId), work: work("visit", start - (2 + r.int(3)) * HOUR, 1, r.pick(PAGES)) });
    }
  }
  const sales: ShiftSale[] = Array.from({ length: 40 }, () => {
    const net = 1 + r.int(90_000);
    return {
      transactionId: id++, pageId: 1, pageLabel: r.pick(PAGES), platform: "fansly", fanId: null, fanRef: `fan-${r.int(9)}`, fanName: null,
      kind: r.pick(["tip", "message_purchase"]), grossMills: net, netMills: net, occurredAt: new Date(DAY0 + r.int(4 * 24 * 60) * 60_000),
    };
  }).filter((sale) => sale.occurredAt < NOW).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const shiftsOf = (userId: number) => pieces.filter((piece) => piece.userId === userId);
  const homes = new Map<number, ScreenHome>();
  for (const sale of sales) {
    if (r.next() < 0.1) continue; // no home yet
    const kind = r.pick(SALE_HOME_KINDS);
    if (kind !== "shift" && kind !== "visit") {
      homes.set(sale.transactionId, { transactionId: sale.transactionId, kind, reason: "no_holder", shares: [] });
      continue;
    }
    const people = Array.from({ length: 1 + r.int(2) }, () => r.pick(USERS));
    const net = sale.netMills;
    // A split, the whole, or a «моё» below the net (the rest nobody's).
    const below = r.next() < 0.2 ? r.int(net) : net;
    const first = people.length === 1 ? below : Math.floor(net / 2);
    const shares = people.map((userId, at) => {
      const own = shiftsOf(userId);
      const named = own.length > 0 && r.next() < 0.6 ? r.pick(own) : null;
      return { userId, workRef: named === null ? null : ruleWorkRef(userId, named.work), mills: at === 0 ? first : net - first };
    });
    homes.set(sale.transactionId, { transactionId: sale.transactionId, kind, reason: "owner_split", shares });
  }
  return { pieces, sales, homes, lastWriters: new Map(sales.filter(() => r.next() < 0.5).map((sale) => [sale.transactionId, r.pick(USERS)])) };
}

describe("whom and what a home credits, generated", () => {
  it("adds every home's shares, the rest and the old count up to the net, to the mill", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const { pieces, sales, homes } = caseOf(seed);
      const byUser = piecesByUser(pieces);
      for (const sale of sales) {
        const home = homes.get(sale.transactionId);
        if (home === undefined) continue;
        for (const oldCounted of [false, true]) {
          const credit = homeCredit({ home, sale, pieces: byUser, logins: LOGINS, counts: (piece) => ruledWork(RULE, piece.work), oldCounted });
          const total = credit.shares.reduce((sum, share) => sum + share.mills, 0) + (credit.outside?.mills ?? 0) + (credit.old ? sale.netMills : 0);
          expect(total, `seed ${seed}, sale ${sale.transactionId}`).toBe(sale.netMills);
          // A share is its person's: on a work of one of their logins, or none.
          for (const share of credit.shares) {
            if (share.piece !== null) expect(LOGINS.personOf(share.piece.userId)).toBe(share.person);
            expect(share.elsewhere).toBe(false);
          }
        }
      }
    }
  });

  it("on «Смены», adds the shifts' credits and «вне смен» up to every sale of the window", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const { pieces, sales, homes, lastWriters } = caseOf(seed);
      const window = shiftSalesWindow({ days: 7, now: NOW, until: "2026-11-12" });
      const held: HeldShift[] = pieces.filter((piece) => piece.work.kind === "shift").map((piece) => ({ ...piece, held: salesOfWork(piece.work, sales) }));
      const visits = pieces.filter((piece) => piece.work.kind === "visit");
      const rule: RuledShiftsInput = { rule: RULE, homes, sales: new Map(sales.map((sale) => [sale.transactionId, sale])), visits, logins: LOGINS };
      const firstActivity = new Map(USERS.map((userId) => [userId, new Date("2026-10-01T00:00:00Z")]));
      const { result, credits, withoutShift } = teamShiftMoneyOf({ days: 7, now: NOW, until: "2026-11-12", shifts: held, lastWriters, firstActivity, rule });
      const unheld = salesNoShiftHolds({ from: window.from, to: window.to, sales, shifts: held });
      const oldWay = settleOutsideShifts(unheld, visits, lastWriters);
      const heldByRuled = new Set(held.filter((shift) => ruledWork(RULE, shift.work)).flatMap((shift) => shift.held.map((sale) => sale.transactionId)));
      const outside = outsideByRule({ from: window.from, to: window.to, sales, rule, oldWay, credits, heldByRuled });

      const shiftMills = new Map<number, number>();
      for (const list of credits.credits.values()) for (const part of list) shiftMills.set(part.transactionId, (shiftMills.get(part.transactionId) ?? 0) + part.netMills);
      const outsideMills = new Map<number, number>();
      for (const one of outside) outsideMills.set(one.sale.transactionId, (outsideMills.get(one.sale.transactionId) ?? 0) + one.sale.netMills);
      for (const sale of sales) {
        const id = sale.transactionId;
        if (sale.occurredAt.getTime() < window.from || sale.occurredAt.getTime() >= window.to) continue;
        // An old shift counts it (once for the team), or the rule's parts and the old way's line: the net, to the mill.
        const placed = credits.oldCounted.has(id) ? sale.netMills : (shiftMills.get(id) ?? 0) + (outsideMills.get(id) ?? 0);
        expect(placed, `seed ${seed}, sale ${id}`).toBe(sale.netMills);
      }
      // A person's money with no work: in «вне смен» by name, and in their login's row on the sale's day.
      for (const one of withoutShift) {
        expect(outside).toContainEqual(expect.objectContaining({ home: "person", visitBy: LOGINS.nameOf(one.userId) }));
        const row = result.chatters.find((chatter) => chatter.userId === one.userId)!;
        expect(row.daily.find((day) => day.date === one.day)!.salesNetMills).toBeGreaterThanOrEqual(one.sale.netMills);
      }
      // Each login's row: its shifts' money and what the rule gives it with no work, nothing else.
      for (const row of result.chatters) {
        const own = withoutShift.filter((one) => one.userId === row.userId).reduce((sum, one) => sum + one.sale.netMills, 0);
        const ofShifts = result.shifts.filter((one) => one.userId === row.userId).reduce((sum, one) => sum + one.salesNetMills, 0);
        expect(row.salesNetMills, `seed ${seed}, login ${row.userId}`).toBe(ofShifts + own);
      }
    }
  });
});
