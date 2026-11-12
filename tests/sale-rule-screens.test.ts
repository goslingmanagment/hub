import { describe, expect, it } from "vitest";

import { oldShiftCounts } from "../apps/runtime/src/services/chatter-stats.ts";
import {
  creditedPiece, openWindowFrom, piecesByUser, ruleWorkRef, ruledWork, salesToCompute, standOverrides, type ScreenHome,
} from "../apps/runtime/src/services/sale-rule-screens.ts";

// The screens' side of the one rule: a stand's switch never applies in production; a share finds the screen's work
// though its start moved; the open window is computed now; the switch's day cuts by the report date.

const at = (iso: string) => Date.parse(iso);

describe("the screens' switch", () => {
  it("takes a stand's override only outside production", () => {
    expect(standOverrides({ NODE_ENV: "production", HUB_SALE_RULE_SCREENS_FROM: "2026-11-09", HUB_SALE_HOMES_LIVE: "1" })).toEqual({ live: false });
    expect(standOverrides({ NODE_ENV: "development", HUB_SALE_RULE_SCREENS_FROM: "2026-11-09" })).toEqual({ screensFrom: "2026-11-09", live: false });
    expect(standOverrides({ HUB_SALE_RULE_SCREENS_FROM: "off", HUB_SALE_HOMES_LIVE: "1" })).toEqual({ screensFrom: null, live: true });
    expect(standOverrides({})).toEqual({ live: false });
    expect(() => standOverrides({ HUB_SALE_RULE_SCREENS_FROM: "9.11" })).toThrow();
  });

  it("cuts a shift by its report date and a look-in by its day", () => {
    const rule = { from: "2026-11-09", live: false };
    // Sunday 21:00 to Monday 05:00 (Moscow): its middle is Monday, its report date Sunday — the old count keeps it.
    expect(ruledWork(rule, { kind: "shift", startedAt: at("2026-11-08T18:00:00Z"), endedAt: at("2026-11-09T02:00:00Z") })).toBe(false);
    // 23:00 to 07:00: mostly after midnight, begun within two hours of it — Monday's.
    expect(ruledWork(rule, { kind: "shift", startedAt: at("2026-11-08T20:00:00Z"), endedAt: at("2026-11-09T04:00:00Z") })).toBe(true);
    expect(ruledWork(rule, { kind: "visit", startedAt: at("2026-11-08T20:50:00Z"), endedAt: at("2026-11-08T21:20:00Z") })).toBe(true);
    expect(ruledWork(null, { kind: "shift", startedAt: at("2026-11-10T05:00:00Z"), endedAt: at("2026-11-10T13:00:00Z") })).toBe(false);
  });
});

describe("the screen's work a share credits", () => {
  const shift = { startedAt: at("2026-11-10T05:00:00Z"), endedAt: at("2026-11-10T13:00:00Z") };
  const pieces = piecesByUser([{ userId: 7, work: shift }, { userId: 8, work: shift }]);

  it("is the same work, or the person's work holding the start the rule named", () => {
    expect(creditedPiece(pieces, { userId: 7, workRef: ruleWorkRef(7, shift) })?.userId).toBe(7);
    // A look-in before it joined it since the home was stored: its start moved earlier.
    expect(creditedPiece(pieces, { userId: 7, workRef: `7:${new Date(at("2026-11-10T06:10:00Z")).toISOString()}` })?.work).toBe(shift);
    expect(creditedPiece(pieces, { userId: 7, workRef: `7:${new Date(at("2026-11-10T14:00:00Z")).toISOString()}` })).toBeNull();
    expect(creditedPiece(pieces, { userId: 9, workRef: ruleWorkRef(9, shift) })).toBeNull();
    expect(creditedPiece(pieces, { userId: 7, workRef: null })).toBeNull();
  });
});

describe("the open window", () => {
  const now = new Date("2026-11-12T09:00:00Z");

  it("begins at today's Moscow midnight, or the start of a work going on before it", () => {
    expect(new Date(openWindowFrom(now, [])).toISOString()).toBe("2026-11-11T21:00:00.000Z");
    expect(new Date(openWindowFrom(now, [{ startedAt: at("2026-11-11T15:00:00Z"), ongoing: true }, { startedAt: at("2026-11-10T15:00:00Z"), ongoing: false }])).toISOString())
      .toBe("2026-11-11T15:00:00.000Z");
  });

  it("computes now the open window's sales, a waiting PPV's and a sale no stored home has", () => {
    const sale = (id: number, iso: string) => ({ transactionId: id, occurredAt: new Date(iso) });
    const sales = [sale(1, "2026-11-10T10:00:00Z"), sale(2, "2026-11-11T10:00:00Z"), sale(3, "2026-11-12T08:00:00Z")];
    type Stored = Map<number, { kind: ScreenHome["kind"] }>;
    const stored: Stored = new Map([[1, { kind: "shift" }], [2, { kind: "shift" }], [3, { kind: "shift" }]]);
    const openFrom = openWindowFrom(now, []);
    expect(salesToCompute({ sales, stored, openFrom, live: false })).toBe(at("2026-11-12T08:00:00Z"));
    expect(salesToCompute({ sales, stored: new Map([...stored, [2, { kind: "waiting" }]]) as Stored, openFrom, live: false })).toBe(at("2026-11-11T10:00:00Z"));
    expect(salesToCompute({ sales, stored: new Map([[2, { kind: "shift" }], [3, { kind: "shift" }]]) as Stored, openFrom, live: false })).toBe(at("2026-11-10T10:00:00Z"));
    expect(salesToCompute({ sales: sales.slice(0, 2), stored, openFrom, live: false })).toBeNull();
    expect(salesToCompute({ sales, stored, openFrom, live: true })).toBe(at("2026-11-10T10:00:00Z"));
  });
});

describe("a sale an old shift counts", () => {
  it("is the old shift's when it held it alone, or its person wrote last, or nobody of the holders did", () => {
    expect(oldShiftCounts([{ userId: 1, ruled: false }], null)).toBe(true);
    expect(oldShiftCounts([{ userId: 1, ruled: false }, { userId: 2, ruled: true }], 2)).toBe(false);
    expect(oldShiftCounts([{ userId: 1, ruled: false }, { userId: 2, ruled: true }], 1)).toBe(true);
    // Neither wrote: the old count gives it to both, so the ruled one does not take it again.
    expect(oldShiftCounts([{ userId: 1, ruled: false }, { userId: 2, ruled: true }], null)).toBe(true);
    expect(oldShiftCounts([{ userId: 2, ruled: true }], null)).toBe(false);
  });
});
