import { describe, expect, it } from "vitest";

import { chainReportDateOf } from "../apps/runtime/src/services/sale-chain.ts";
import { SALE_RULE, homesOfSales, type RuleSale, type RuleWork } from "../apps/runtime/src/services/sale-rule.ts";
import { peopleLoginsOf } from "../apps/runtime/src/services/sale-rule-screens.ts";
import { classifySale, type DraftContext, type DraftSale } from "../apps/runtime/src/services/shift-handin-rules.ts";

const msk = (iso: string) => Date.parse(`${iso.replace(" ", "T")}+03:00`);

describe("Wave 1 unit regressions (OA-004, OP-H5, solo-page draft)", () => {
  it("matches multi-login users by canonical person in oldHolders, oneUser, agreedHome, judgeMarks, and everyoneSaysNotMine (OA-004)", () => {
    const logins = peopleLoginsOf([
      { userId: 101, username: "alpha-old", personId: 1, personCode: "alpha", displayName: "Alpha" },
      { userId: 102, username: "alpha-new", personId: 1, personCode: "alpha", displayName: "Alpha" },
      { userId: 201, username: "beta-old", personId: 2, personCode: "beta", displayName: "Beta" },
      { userId: 202, username: "beta-new", personId: 2, personCode: "beta", displayName: "Beta" },
    ]);
    const works: RuleWork[] = [
      { ref: "101:2026-11-10T09:00:00.000Z", userId: 101, kind: "shift", startedAt: msk("2026-11-10 12:00"), endedAt: msk("2026-11-10 20:00") },
      { ref: "201:2026-11-10T09:00:00.000Z", userId: 201, kind: "shift", startedAt: msk("2026-11-10 12:00"), endedAt: msk("2026-11-10 20:00") },
    ];
    const baseSale: RuleSale = {
      ref: "tx-1",
      pageId: 10,
      kind: "tip",
      netMills: 10_000,
      occurredAt: msk("2026-11-10 15:00"),
      holders: [works[0]!.ref, works[1]!.ref],
      ppvSender: null,
      postTip: false,
      campaign: false,
      lastWriter: null,
      marks: [],
      resolution: null,
      claimedBy: null,
    };

    // 1. Two shifts of two people, last writer wrote from person 1's second login (102): resolves to person 1 as last_writer.
    const [byLastWriter] = homesOfSales([{ ...baseSale, lastWriter: 102 }], works, [], msk("2026-11-10 22:00"), SALE_RULE, logins);
    expect(byLastWriter).toMatchObject({ kind: "shift", reason: "last_writer", shares: [{ userId: 101, mills: 10_000 }] });

    // 2. Two shifts of the SAME person's two logins: resolves as single holder (not junction dispute).
    const samePersonWorks: RuleWork[] = [
      { ref: "101:2026-11-10T09:00:00.000Z", userId: 101, kind: "shift", startedAt: msk("2026-11-10 12:00"), endedAt: msk("2026-11-10 20:00") },
      { ref: "102:2026-11-10T09:00:00.000Z", userId: 102, kind: "shift", startedAt: msk("2026-11-10 12:00"), endedAt: msk("2026-11-10 20:00") },
    ];
    const [singlePerson] = homesOfSales(
      [{ ...baseSale, holders: [samePersonWorks[0]!.ref, samePersonWorks[1]!.ref] }],
      samePersonWorks, [], msk("2026-11-10 22:00"), SALE_RULE, logins,
    );
    expect(singlePerson).toMatchObject({ kind: "shift", reason: "holder", shares: [{ userId: 101, mills: 10_000 }] });

    // 3. Mutual share marks referencing each other's alternate login settle as 50/50 marks (not dispute).
    const [mutualShare] = homesOfSales([{
      ...baseSale,
      marks: [
        { userId: 102, mark: "share", shareWith: 201, ownAmountMills: null, confirmed: true },
        { userId: 202, mark: "share", shareWith: 101, ownAmountMills: null, confirmed: true },
      ],
    }], works, [], msk("2026-11-10 22:00"), SALE_RULE, logins);
    expect(mutualShare).toMatchObject({ kind: "shift", reason: "marks" });
    expect(mutualShare!.shares.map((s) => s.mills)).toEqual([5_000, 5_000]);

    // 4. Both people confirm not_mine using their alternate logins: everyoneSaysNotMine -> nobody.
    const [allNotMine] = homesOfSales([{
      ...baseSale,
      marks: [
        { userId: 102, mark: "not_mine", shareWith: null, ownAmountMills: null, confirmed: true },
        { userId: 202, mark: "not_mine", shareWith: null, ownAmountMills: null, confirmed: true },
      ],
    }], works, [], msk("2026-11-10 22:00"), SALE_RULE, logins);
    expect(allNotMine).toMatchObject({ kind: "nobody", reason: "marks" });

    // 5. agreedHome: person 1 holds via 101, says not_mine via 102, person 2 claims via 202 -> transfers to person 2.
    const [transferred] = homesOfSales([{
      ...baseSale,
      holders: [works[0]!.ref],
      marks: [
        { userId: 102, mark: "not_mine", shareWith: null, ownAmountMills: null, confirmed: true },
        { userId: 202, mark: "mine", shareWith: null, ownAmountMills: null, confirmed: true },
      ],
    }], works, [], msk("2026-11-10 22:00"), SALE_RULE, logins);
    expect(transferred).toMatchObject({ kind: "shift", reason: "agreed", shares: [{ userId: 202, mills: 10_000 }] });
  });

  it("resolves per-recipient applied delivery dates for split decisions in chainReportDateOf (OP-H5)", () => {
    const occurredAt = new Date("2026-11-10T10:00:00Z");
    const decision = { appliedUserId: 201, appliedReportDate: "2026-11-12" };
    const deliveries = [
      { recipient: 101, state: "applied" as const, reportDate: "2026-11-11" },
      { recipient: 201, state: "applied" as const, reportDate: "2026-11-12" },
    ];
    expect(chainReportDateOf({ handedIn: null, decision, deliveries, logins: [101], shift: null, occurredAt })).toBe("2026-11-11");
    expect(chainReportDateOf({ handedIn: null, decision, deliveries, logins: [201], shift: null, occurredAt })).toBe("2026-11-12");
    // Pending delivery falls back to shift/occurredAt rather than leaking the other recipient's applied date.
    const partialDeliveries = [
      { recipient: 101, state: "pending" as const, reportDate: null },
      { recipient: 201, state: "applied" as const, reportDate: "2026-11-12" },
    ];
    expect(chainReportDateOf({ handedIn: null, decision, deliveries: partialDeliveries, logins: [101], shift: null, occurredAt })).toBe("2026-11-10");
  });

  it("shows unclaimed nobody sales in near on solo pages while hiding shared-page and owner_nobody sales", () => {
    const context: DraftContext = {
      shiftId: 10,
      workRef: "101:2026-11-10T09:00:00.000Z",
      userIds: new Set([101]),
      switchOnAt: msk("2026-11-01 00:00"),
      submittedShiftIds: new Set(),
      reported: new Map(),
      handinId: null,
      soloPages: new Set(["solo-1"]),
    };
    const makeSale = (pageLabel: string, reason: "no_holder" | "owner_nobody"): DraftSale => ({
      transactionId: 1,
      pageLabel,
      platform: "fansly",
      kind: "subscription",
      occurredAt: msk("2026-11-10 04:00"),
      netMills: 9_000,
      home: { kind: "nobody", reason, pot: null, shares: [] },
      ppvSenderUserId: null,
      source: "window",
      heldByShift: false,
      inReportWindow: true,
    });

    expect(classifySale(makeSale("solo-1", "no_holder"), context)).toMatchObject({ group: "near", shareMills: 0 });
    expect(classifySale(makeSale("solo-1", "owner_nobody"), context)).toBeNull();
    expect(classifySale(makeSale("shared-1", "no_holder"), context)).toBeNull();
  });
});
