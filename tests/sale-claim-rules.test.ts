import { describe, expect, it } from "vitest";

import {
  claimStands,
  decisionOfOutcome,
  deriveClaims,
  reportSums,
  ruleDecisionOf,
  ruleMarksOf,
  settledVersion,
  shareAfter,
  type ClaimView,
  type ReportLine,
  type ReportView,
} from "../apps/runtime/src/services/sale-claim-rules.ts";
import { SALE_RULE, homeOfSale, homesOfSales, type RuleMark, type RuleSale, type RuleWork } from "../apps/runtime/src/services/sale-rule.ts";

// Заявки и договорённости (package G): what people say moves a sale's home only when the people the rule names agree,
// and the owner's decision comes before the rule; which statements of handed-in reports reach another person; what a
// settled claim makes of a report's numbers. Money: the halves, the odd mill, the page sums. Synthetic people 101–103.

const msk = (at: string) => Date.parse(`${at.replace(" ", "T")}:00+03:00`);
const later = msk("2026-11-20 12:00");

function work(user: number, from: string, to: string): RuleWork {
  const startedAt = msk(from);
  return { ref: `${user}:${new Date(startedAt).toISOString()}`, userId: user, kind: "shift", startedAt, endedAt: msk(to) };
}

function sale(at: string, net: number, holders: RuleWork[], extra: Partial<RuleSale> = {}): RuleSale {
  return {
    ref: `t-${at}`, pageId: 1, kind: "subscription", netMills: net, occurredAt: msk(at), holders: holders.map((one) => one.ref), ppvSender: null,
    postTip: false, campaign: false, lastWriter: null, marks: [], resolution: null, claimedBy: null, ...extra,
  };
}

const said = (userId: number, mark: RuleMark["mark"], shareWith: number | null = null): RuleMark => ({ userId, mark, shareWith, ownAmountMills: null, confirmed: true });

describe("the rule: the owner's decision and agreeing statements first", () => {
  const holder = work(102, "2026-11-05 12:00", "2026-11-05 20:00");
  const other = work(101, "2026-11-05 08:00", "2026-11-05 14:00");

  it("moves a holder's sale only when the holder agrees: a claim alone moves nothing", () => {
    const base = sale("2026-11-05 16:00", 36_000, [holder]);
    expect(homeOfSale(base, [holder, other], [], later)).toMatchObject({ kind: "shift", reason: "holder" });
    const claimOnly = homeOfSale({ ...base, marks: [said(101, "mine")] }, [holder, other], [], later);
    expect(claimOnly).toMatchObject({ kind: "shift", reason: "holder", shares: [{ userId: 102, mills: 36_000 }] });
    const agreed = homeOfSale({ ...base, marks: [said(101, "mine"), said(102, "not_mine")] }, [holder, other], [], later);
    expect(agreed).toMatchObject({ kind: "shift", reason: "agreed", shares: [{ userId: 101, mills: 36_000, percent: 100 }] });
    // The rule as Go has it does not take agreement before itself.
    expect(homeOfSale({ ...base, marks: [said(101, "mine"), said(102, "not_mine")] }, [holder, other], [], later, { ...SALE_RULE, ownerAndAgreementFirst: false }))
      .toMatchObject({ reason: "holder" });
  });

  it("splits a holder's sale in halves when both say «делим» naming each other, the odd mill to the lower user id", () => {
    const base = sale("2026-11-05 16:00", 36_001, [holder], { marks: [said(101, "share", 102), said(102, "share", 101)] });
    const got = homeOfSale(base, [holder, other], [], later);
    expect(got.reason).toBe("agreed");
    expect(got.shares.map((share) => [share.userId, share.mills])).toEqual([[101, 18_001], [102, 18_000]]);
    expect(got.shares.reduce((sum, share) => sum + share.mills, 0)).toBe(36_001);
    // One «делим» alone is no agreement.
    expect(homeOfSale({ ...base, marks: [said(101, "share", 102)] }, [holder, other], [], later).reason).toBe("holder");
  });

  it("makes a sale nobody's when everyone the rule names says «не моё», and never moves a nobody's sale by a claim", () => {
    expect(homeOfSale(sale("2026-11-05 16:00", 8_000, [holder], { marks: [said(102, "not_mine")] }), [holder], [], later))
      .toMatchObject({ kind: "nobody", reason: "agreed" });
    expect(homeOfSale(sale("2026-11-05 16:00", 8_000, [], { marks: [said(101, "mine")] }), [holder], [], later))
      .toMatchObject({ kind: "nobody", reason: "no_holder" });
  });

  it("takes the owner's split before the rule, the halves as the rule gives them, «никому» and a pot", () => {
    const base = sale("2026-11-05 16:00", 36_001, [holder]);
    const first = homeOfSale({ ...base, resolution: [{ userId: 101, percent: 100 }] }, [holder, other], [], later);
    expect(first).toMatchObject({ kind: "shift", reason: "owner_split", shares: [{ userId: 101, mills: 36_001, workRef: null }] });
    const half = homeOfSale({ ...base, resolution: [{ userId: 101, percent: 50 }, { userId: 102, percent: 50 }] }, [holder, other], [], later);
    expect(half.shares.map((share) => [share.userId, share.mills, share.workRef])).toEqual([[101, 18_001, null], [102, 18_000, holder.ref]]);
    expect(homeOfSale({ ...base, ownerNobody: true }, [holder], [], later)).toMatchObject({ kind: "nobody", reason: "owner_nobody" });
    expect(homeOfSale({ ...base, ownerPot: "dragon" }, [holder], [], later)).toMatchObject({ kind: "pot", reason: "owner_pot", pot: "dragon" });
    // Before the rule nothing moves.
    expect(homeOfSale({ ...sale("2026-10-30 16:00", 1_000, []), resolution: [{ userId: 101, percent: 100 }] }, [], [], later).kind).toBe("before_rule");
  });

  it("changes no home when nobody said anything and the owner decided nothing", () => {
    const sales = [
      sale("2026-11-05 13:00", 4_000, [holder, other]),
      sale("2026-11-05 16:00", 36_000, [holder]),
      sale("2026-11-05 21:00", 12_000, []),
      { ...sale("2026-11-05 13:30", 24_000, [holder, other]), lastWriter: 101 },
    ];
    expect(homesOfSales(sales, [holder, other], [], later)).toEqual(homesOfSales(sales, [holder, other], [], later, { ...SALE_RULE, ownerAndAgreementFirst: false }));
  });
});

function line(transactionId: number, extra: Partial<ReportLine> = {}): ReportLine {
  return {
    transactionId, pageLabel: "page-a", netMills: 36_000, amountMills: 0, group: "near", statement: null, shareWithUserId: null, note: null, disputed: false,
    rule: { home: "shift", reason: "holder", shareMills: 0, toUserId: null, senderUserId: null }, ...extra,
  };
}

function report(userId: number, handinId: number, submittedAt: string, lines: ReportLine[]): ReportView {
  return { handinId, shiftId: handinId * 10, userId, version: 1, submittedAt: msk(submittedAt), lines };
}

describe("which statements reach another person", () => {
  it("asks whom the rule gives it to of a disputed «моё», and the colleague a «делим» names", () => {
    const claims = deriveClaims([
      report(101, 1, "2026-11-05 22:00", [
        line(7, { statement: "mine", amountMills: 36_000, disputed: true, note: "договорились вчера", rule: { home: "shift", reason: "holder", shareMills: 0, toUserId: 102, senderUserId: null } }),
        line(8, { group: "mine", statement: "share", shareWithUserId: 103, amountMills: 2_000, netMills: 4_000, rule: { home: "shift", reason: "holder", shareMills: 4_000, toUserId: null, senderUserId: null } }),
      ]),
    ]);
    expect(claims.map((claim) => [claim.kind, claim.transactionId, claim.claimantUserId, claim.statement, claim.sideUserId])).toEqual([
      ["claim", 7, 101, "mine", 102],
      ["claim", 8, 101, "share", 103],
    ]);
    expect(claims[0]!.note).toBe("договорились вчера");
  });

  it("takes a «моё» of a sale nobody held as plain, a junction's to the rule, a pot's to the owner", () => {
    const claims = deriveClaims([
      report(101, 1, "2026-11-05 22:00", [
        line(1, { statement: "mine", amountMills: 36_000, disputed: false, rule: { home: "nobody", reason: "no_holder", shareMills: 0, toUserId: null, senderUserId: null } }),
        line(2, { statement: "mine", amountMills: 36_000, disputed: true, rule: { home: "decide", reason: "no_last_writer", shareMills: 0, toUserId: null, senderUserId: null } }),
        line(3, { statement: "mine", amountMills: 36_000, disputed: true, rule: { home: "pot", reason: "post_tip", shareMills: 0, toUserId: null, senderUserId: null } }),
      ]),
    ]);
    expect(claims.map((claim) => [claim.transactionId, claim.sideUserId])).toEqual([[3, null]]);
  });

  it("makes a sale counted for more than its net a dispute by itself, the later hand-in against the earlier", () => {
    const counted = { group: "mine" as const, amountMills: 36_000, rule: { home: "shift", reason: "holder", shareMills: 36_000, toUserId: null, senderUserId: null } };
    const claims = deriveClaims([
      report(101, 1, "2026-11-05 22:00", [line(9, counted)]),
      report(102, 2, "2026-11-06 02:00", [line(9, counted)]),
    ]);
    expect(claims.map((claim) => [claim.kind, claim.claimantUserId, claim.sideUserId, claim.sideShiftId])).toEqual([["double", 102, 101, 10]]);
    // A «моё» against a report that counts it is one claim, not a second dispute.
    const one = deriveClaims([
      report(101, 1, "2026-11-05 22:00", [line(9, counted)]),
      report(102, 2, "2026-11-06 02:00", [line(9, { statement: "mine", amountMills: 36_000, disputed: true, rule: { home: "shift", reason: "holder", shareMills: 0, toUserId: 101, senderUserId: null } })]),
    ]);
    expect(one.map((claim) => [claim.kind, claim.claimantUserId, claim.sideUserId])).toEqual([["claim", 102, 101]]);
  });

  it("withdraws a claim whose report no longer counts the sale", () => {
    const claim: ClaimView = { kind: "claim", transactionId: 7, claimantUserId: 101, claimantHandinId: 1, sideUserId: 102, statement: "mine", shareWithUserId: null, state: "asked", answer: null };
    expect(claimStands(claim, [report(101, 1, "2026-11-05 22:00", [line(7, { statement: "mine", amountMills: 36_000 })])])).toBe(true);
    expect(claimStands(claim, [report(101, 1, "2026-11-05 23:00", [line(7, { amountMills: 0 })])])).toBe(false);
  });
});

describe("the people's words and the owner's decisions as the rule's inputs", () => {
  it("gives the claimant's word while it stands and the side's agreement back", () => {
    const claims: ClaimView[] = [
      { kind: "claim", transactionId: 7, claimantUserId: 101, claimantHandinId: 1, sideUserId: 102, statement: "mine", shareWithUserId: null, state: "agreed", answer: "agree" },
      { kind: "claim", transactionId: 8, claimantUserId: 101, claimantHandinId: 1, sideUserId: 103, statement: "share", shareWithUserId: 103, state: "agreed", answer: "agree" },
      { kind: "claim", transactionId: 9, claimantUserId: 101, claimantHandinId: 1, sideUserId: 102, statement: "mine", shareWithUserId: null, state: "withdrawn", answer: null },
    ];
    const marks = ruleMarksOf({ reports: [report(102, 2, "2026-11-05 22:00", [line(9, { group: "mine", statement: "not_mine" })])], claims });
    expect(marks.get(7)).toEqual([said(101, "mine"), said(102, "not_mine")]);
    expect(marks.get(8)).toEqual([said(101, "share", 103), said(103, "share", 101)]);
    expect(marks.get(9)).toEqual([said(102, "not_mine")]);
  });

  it("reads a whole sale given on a nobody's sale as the owner's claim, any other as his split", () => {
    expect(ruleDecisionOf({ kind: "split", shares: [{ userId: 101, percent: 100 }], pot: null, ruleHome: "nobody" })).toMatchObject({ claimedBy: 101, resolution: null });
    expect(ruleDecisionOf({ kind: "split", shares: [{ userId: 101, percent: 100 }], pot: null, ruleHome: "shift" })).toMatchObject({ claimedBy: null, resolution: [{ userId: 101, percent: 100 }] });
    expect(ruleDecisionOf({ kind: "nobody", shares: [], pot: null, ruleHome: "shift" })).toMatchObject({ ownerNobody: true });
  });
});

describe("what a settlement gives, in mills", () => {
  it("gives the four answers as the rule splits them: halves with the odd mill to the lower user id", () => {
    expect(decisionOfOutcome("half", 102, 101).shares).toEqual([{ userId: 101, percent: 50 }, { userId: 102, percent: 50 }]);
    const net = 36_001;
    const half = (userId: number) => shareAfter({ netMills: net, userId, outcome: "half", first: 102, second: 101, statement: null });
    expect([half(101), half(102)]).toEqual([18_001, 18_000]);
    expect(half(101) + half(102)).toBe(net);
    expect(shareAfter({ netMills: net, userId: 102, outcome: "first", first: 102, second: 101, statement: null })).toBe(net);
    expect(shareAfter({ netMills: net, userId: 101, outcome: "first", first: 102, second: 101, statement: null })).toBe(0);
    expect(shareAfter({ netMills: net, userId: 101, outcome: "second", first: 102, second: 101, statement: null })).toBe(net);
    expect(shareAfter({ netMills: net, userId: 102, outcome: "nobody", first: 102, second: 101, statement: null })).toBe(0);
    // An agreed «делим» is the same halves as two «делим» in the rule.
    expect(shareAfter({ netMills: net, userId: 101, outcome: "agreed", first: 102, second: 101, statement: "share" })).toBe(18_001);
    expect(shareAfter({ netMills: net, userId: 102, outcome: "agreed", first: 102, second: 101, statement: "share" })).toBe(18_000);
    expect(shareAfter({ netMills: net, userId: 101, outcome: "agreed", first: 101, second: 102, statement: "mine" })).toBe(net);
  });

  it("makes a settled version's sums again from its lines, the line no longer disputed", () => {
    const made = settledVersion({
      lines: [
        line(1, { group: "mine", amountMills: 7_992 }),
        line(2, { statement: "mine", amountMills: 36_000, disputed: true }),
      ],
      pages: ["page-a"],
      offPlatform: [],
      transactionId: 2,
      amountMills: 18_000,
      settled: "owner",
    });
    expect(made.lines[1]).toMatchObject({ amountMills: 18_000, disputed: false, settled: "owner" });
    expect(made.pages).toEqual([{ pageLabel: "page-a", amountMills: 25_990 }]);
    expect(made.totalMills).toBe(25_990);
  });

  it("counts a confirmed «мимо площадки» on its page, a pending or rejected one nowhere", () => {
    const sums = reportSums([line(1, { group: "mine", amountMills: 10_000 })], ["page-a", "page-b"], [
      { amountMills: 50_000, state: "confirmed", pageLabel: "page-b" },
      { amountMills: 70_000, state: "pending", pageLabel: null },
      { amountMills: 90_000, state: "rejected", pageLabel: "page-a" },
    ]);
    expect(sums).toEqual({ pages: [{ pageLabel: "page-a", amountMills: 10_000 }, { pageLabel: "page-b", amountMills: 50_000 }], totalMills: 60_000 });
  });

  it("names the page of every line the report carries, with nothing where nothing is counted", () => {
    // A shift that held page-a; «Рядом» has a sale of page-d (its slot's page), and a disputed «моё» on page-e claims and counts 0.
    const sums = reportSums([
      line(1, { group: "mine", amountMills: 10_000 }),
      line(2, { pageLabel: "page-d" }),
      line(3, { pageLabel: "page-e", statement: "mine", disputed: true, claimedMills: 36_000 }),
    ], ["page-a"], []);
    expect(sums).toEqual({
      pages: [{ pageLabel: "page-a", amountMills: 10_000 }, { pageLabel: "page-d", amountMills: 0 }, { pageLabel: "page-e", amountMills: 0 }],
      totalMills: 10_000,
    });
  });
});
