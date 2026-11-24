import { describe, expect, it } from "vitest";

import type { AgentTeamWork } from "@agency_hub_core/contracts";
import type { ShiftRowRecord } from "@agency_hub_core/db";

import { workRef } from "../apps/runtime/src/services/agent-team-sales.ts";
import { SALE_RULE, homeOfSale, homesOfSales, type RuleSale, type RuleWork } from "../apps/runtime/src/services/sale-rule.ts";
import { homeCredit, landShare, peopleLoginsOf, type CreditPiece } from "../apps/runtime/src/services/sale-rule-screens.ts";
import { saleHomeRowOf, workPiecesOf } from "../apps/runtime/src/services/sale-homes.ts";

// Pure unit tests for:
// 1. Multi-login `workRefFor` / `workRefOf` in `sale-rule.ts`: a decision or agreement naming login A of a person
//    resolves to the work held by login B of the same person (own login preferred, shift before visit).
// 2. Unified `landShare` (`sale-rule-screens.ts`) used by both `homeCredit` and `saleHomeRowOf` (`sale-homes.ts`),
//    covering all six `daySource` values: report, shift, visit, holding_shift, sale_day, unresolved (reportDate: null),
//    including verifying that a named `workRef`'s login belongs to the share's person.

const msk = (at: string) => Date.parse(`${at.replace(" ", "T")}:00+03:00`);

const LOGINS = peopleLoginsOf([
  { userId: 101, username: "anna-main", personId: 1, personCode: "anna", displayName: "Anna" },
  { userId: 102, username: "anna-alt", personId: 1, personCode: "anna", displayName: "Anna" },
  { userId: 201, username: "boris-main", personId: 2, personCode: "boris", displayName: "Boris" },
  { userId: 301, username: "unlinked-login", personId: null, personCode: null, displayName: null },
]);

function teamWork(input: {
  userId: number;
  kind: "shift" | "visit";
  from: string;
  to: string;
  pageLabel: string;
}): AgentTeamWork {
  const startedAt = new Date(msk(input.from)).toISOString();
  const endedAt = new Date(msk(input.to)).toISOString();
  return {
    ref: `${input.userId}:${startedAt}`,
    userId: input.userId,
    username: LOGINS.usernameOf(input.userId),
    role: "chatter",
    personCode: LOGINS.codeOf(input.userId),
    reportDate: input.from.slice(0, 10),
    kind: input.kind,
    startedAt,
    endedAt,
    ongoing: false,
    workedMinutes: Math.round((msk(input.to) - msk(input.from)) / 60_000),
    pages: [{ pageLabel: input.pageLabel, messages: 20, salesFrom: startedAt }],
  };
}

function ruleWork(work: AgentTeamWork): RuleWork {
  return { ref: work.ref, userId: work.userId, kind: work.kind, startedAt: Date.parse(work.startedAt), endedAt: Date.parse(work.endedAt) };
}

function shiftRow(id: number, work: AgentTeamWork, reportDate: string): ShiftRowRecord {
  return {
    id,
    userId: work.userId,
    state: "closed",
    startedAt: new Date(work.startedAt),
    endedAt: new Date(work.endedAt),
    workedMinutes: work.workedMinutes,
    messages: 20,
    reportDate,
    pages: [{ pageLabel: work.pages[0]!.pageLabel, activeMinutes: work.workedMinutes, messages: 20, salesFrom: work.startedAt }],
    pauses: [],
    mergedInto: null,
  };
}

describe("multi-login workRefFor / workRefOf in sale-rule", () => {
  const annaAltShift = teamWork({ userId: 102, kind: "shift", from: "2026-11-11 10:00", to: "2026-11-11 18:00", pageLabel: "mia-1" });
  const borisShift = teamWork({ userId: 201, kind: "shift", from: "2026-11-11 10:00", to: "2026-11-11 18:00", pageLabel: "mia-1" });
  const works = [ruleWork(annaAltShift), ruleWork(borisShift)];
  const now = msk("2026-11-12 12:00");

  it("matches a person's holding shift under another login on an owner decision (workRefFor)", () => {
    const sale: RuleSale = {
      ref: "5001",
      pageId: 1,
      kind: "tip",
      netMills: 20_000,
      occurredAt: msk("2026-11-11 12:00"),
      holders: [annaAltShift.ref],
      ppvSender: null,
      postTip: false,
      campaign: false,
      lastWriter: null,
      marks: [],
      // Decision names Anna's main login (101) while her alt login (102) held the shift.
      resolution: [{ userId: 101, percent: 100 }],
      claimedBy: null,
    };
    const [home] = homesOfSales([sale], works, [], now, SALE_RULE, LOGINS);
    expect(home).toMatchObject({
      kind: "shift",
      reason: "owner_split",
      shares: [{ userId: 101, workRef: annaAltShift.ref, percent: 100, mills: 20_000 }],
    });
  });

  it("matches a person's holding shift under another login at a junction (workRefOf in decide)", () => {
    const sale: RuleSale = {
      ref: "5002",
      pageId: 1,
      kind: "tip",
      netMills: 30_000,
      occurredAt: msk("2026-11-11 12:00"),
      holders: [annaAltShift.ref, borisShift.ref],
      ppvSender: null,
      postTip: false,
      campaign: false,
      lastWriter: null,
      marks: [],
      resolution: [{ userId: 101, percent: 50 }, { userId: 201, percent: 50 }],
      claimedBy: null,
    };
    const home = homeOfSale(sale, works, [], now, SALE_RULE, LOGINS);
    expect(home).toMatchObject({
      kind: "shift",
      reason: "owner_split",
      shares: [
        { userId: 101, workRef: annaAltShift.ref, percent: 50, mills: 15_000 },
        { userId: 201, workRef: borisShift.ref, percent: 50, mills: 15_000 },
      ],
    });
  });

  it("prefers the share's own login and prefers a shift over a visit of another login", () => {
    const annaMainVisit = teamWork({ userId: 101, kind: "visit", from: "2026-11-11 11:30", to: "2026-11-11 12:30", pageLabel: "mia-1" });
    const sale: RuleSale = {
      ref: "5003",
      pageId: 1,
      kind: "tip",
      netMills: 10_000,
      occurredAt: msk("2026-11-11 12:00"),
      holders: [annaMainVisit.ref, annaAltShift.ref, borisShift.ref],
      ppvSender: null,
      postTip: false,
      campaign: false,
      lastWriter: null,
      marks: [],
      resolution: [{ userId: 101, percent: 100 }],
      claimedBy: null,
    };
    const home = homeOfSale(sale, [ruleWork(annaMainVisit), ...works], [], now, SALE_RULE, LOGINS);
    expect(home.shares[0]!.workRef).toBe(annaAltShift.ref);
  });
});

describe("unified share landing (landShare, homeCredit, saleHomeRowOf)", () => {
  const annaAltShift = teamWork({ userId: 102, kind: "shift", from: "2026-11-11 18:00", to: "2026-11-12 02:00", pageLabel: "mia-1" });
  const borisShift = teamWork({ userId: 201, kind: "shift", from: "2026-11-11 10:00", to: "2026-11-11 18:00", pageLabel: "mia-1" });
  const borisVisit = teamWork({ userId: 201, kind: "visit", from: "2026-11-12 10:00", to: "2026-11-12 10:40", pageLabel: "mia-1" });
  const pieces = workPiecesOf([annaAltShift, borisShift, borisVisit]);
  const shiftRows: ShiftRowRecord[] = [
    shiftRow(71, annaAltShift, "2026-11-11"),
    shiftRow(72, borisShift, "2026-11-11"),
  ];
  const handedInDates = new Map<number, string>([[71, "2026-11-10"]]);

  const baseSale = {
    transactionRef: "6001",
    pageLabel: "mia-1",
    occurredAt: new Date(msk("2026-11-11 21:00")).toISOString(),
    netMills: 24_000,
  };

  it("resolves handed-in shift to versionReportDate with daySource='report' (even across logins of the same person)", () => {
    const row = saleHomeRowOf({
      sale: baseSale,
      home: {
        kind: "shift",
        reason: "owner_split",
        pot: null,
        waitsUntil: null,
        slotJunction: false,
        shares: [{ userId: 101, workRef: annaAltShift.ref, percent: 100, mills: 24_000 }],
      },
      pageId: 1,
      pieces,
      logins: LOGINS,
      shiftRows,
      handedInDates,
      rule: SALE_RULE,
    });
    expect(row.shares).toEqual([{
      personCode: "anna",
      userId: 101,
      shiftId: 71,
      workRef: annaAltShift.ref,
      reportDate: "2026-11-10",
      daySource: "report",
      percent: 100,
      mills: 24_000,
    }]);
    const credit = homeCredit({
      home: { kind: "shift", shares: [{ userId: 101, workRef: annaAltShift.ref, mills: 24_000 }] },
      sale: { pageLabel: "mia-1", occurredAt: new Date(baseSale.occurredAt), netMills: 24_000 },
      pieces,
      logins: LOGINS,
    });
    expect(credit.shares[0]).toMatchObject({ userId: 101, person: "person:1", elsewhere: false });
    expect(credit.shares[0]!.piece?.userId).toBe(102);
  });

  it("resolves non-handed-in shift to shifts.report_date with daySource='shift'", () => {
    const row = saleHomeRowOf({
      sale: { ...baseSale, occurredAt: new Date(msk("2026-11-11 12:00")).toISOString() },
      home: {
        kind: "shift",
        reason: "holder",
        pot: null,
        waitsUntil: null,
        slotJunction: false,
        shares: [{ userId: 201, workRef: borisShift.ref, percent: 100, mills: 24_000 }],
      },
      pageId: 1,
      pieces,
      logins: LOGINS,
      shiftRows,
      handedInDates,
      rule: SALE_RULE,
    });
    expect(row.shares[0]).toEqual({
      personCode: "boris",
      userId: 201,
      shiftId: 72,
      workRef: borisShift.ref,
      reportDate: "2026-11-11",
      daySource: "shift",
      percent: 100,
      mills: 24_000,
    });
  });

  it("resolves visit to dayOfWork with daySource='visit'", () => {
    const row = saleHomeRowOf({
      sale: { ...baseSale, occurredAt: new Date(msk("2026-11-12 10:15")).toISOString() },
      home: {
        kind: "visit",
        reason: "look_in_last_writer",
        pot: null,
        waitsUntil: null,
        slotJunction: false,
        shares: [{ userId: 201, workRef: borisVisit.ref, percent: 100, mills: 24_000 }],
      },
      pageId: 1,
      pieces,
      logins: LOGINS,
      shiftRows,
      handedInDates,
      rule: SALE_RULE,
    });
    expect(row.shares[0]).toEqual({
      personCode: "boris",
      userId: 201,
      shiftId: null,
      workRef: borisVisit.ref,
      reportDate: "2026-11-12",
      daySource: "visit",
      percent: 100,
      mills: 24_000,
    });
  });

  it("resolves share without workRef to a holding shift of ANY login of the same person with daySource='holding_shift'", () => {
    const row = saleHomeRowOf({
      sale: baseSale,
      home: {
        kind: "shift",
        reason: "owner_claim",
        pot: null,
        waitsUntil: null,
        slotJunction: false,
        shares: [{ userId: 101, workRef: null, percent: 100, mills: 24_000 }],
      },
      pageId: 1,
      pieces,
      logins: LOGINS,
      shiftRows,
      handedInDates,
      rule: SALE_RULE,
    });
    expect(row.shares[0]).toEqual({
      personCode: "anna",
      userId: 101,
      shiftId: 71,
      workRef: null,
      reportDate: "2026-11-10",
      daySource: "holding_shift",
      percent: 100,
      mills: 24_000,
    });
  });

  it("resolves proven share without workRef and without holding shift to sale's Moscow day with daySource='sale_day'", () => {
    const row = saleHomeRowOf({
      sale: { ...baseSale, occurredAt: new Date(msk("2026-11-13 01:30")).toISOString() },
      home: {
        kind: "shift",
        reason: "owner_claim",
        pot: null,
        waitsUntil: null,
        slotJunction: false,
        shares: [{ userId: 301, workRef: null, percent: 100, mills: 24_000 }],
      },
      pageId: 1,
      pieces,
      logins: LOGINS,
      shiftRows,
      handedInDates,
      rule: SALE_RULE,
    });
    expect(row.shares[0]).toEqual({
      personCode: null,
      userId: 301,
      shiftId: null,
      workRef: null,
      reportDate: "2026-11-13",
      daySource: "sale_day",
      percent: 100,
      mills: 24_000,
    });
  });

  it("returns reportDate=null and daySource='unresolved' when named workRef is missing or belongs to another person", () => {
    const missingRef = workRef(101, { startedAt: msk("2026-11-15 10:00") });
    const foreignRef = borisShift.ref; // belongs to Boris (201), NOT Anna (101)
    const row = saleHomeRowOf({
      sale: baseSale,
      home: {
        kind: "shift",
        reason: "owner_split",
        pot: null,
        waitsUntil: null,
        slotJunction: false,
        shares: [
          { userId: 101, workRef: missingRef, percent: 50, mills: 12_000 },
          { userId: 101, workRef: foreignRef, percent: 50, mills: 12_000 },
        ],
      },
      pageId: 1,
      pieces,
      logins: LOGINS,
      shiftRows,
      handedInDates,
      rule: SALE_RULE,
    });
    expect(row.shares).toEqual([
      { personCode: "anna", userId: 101, shiftId: null, workRef: missingRef, reportDate: null, daySource: "unresolved", percent: 50, mills: 12_000 },
      { personCode: "anna", userId: 101, shiftId: null, workRef: foreignRef, reportDate: null, daySource: "unresolved", percent: 50, mills: 12_000 },
    ]);
    const landedForeign = landShare(
      { userId: 101, workRef: foreignRef },
      { pageLabel: "mia-1", occurredAt: new Date(baseSale.occurredAt) },
      pieces as ReadonlyMap<number, readonly CreditPiece[]>,
      LOGINS,
    );
    expect(landedForeign).toEqual({ kind: "unresolved", piece: null, elsewhere: true });
  });
});
