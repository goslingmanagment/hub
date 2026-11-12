import { describe, expect, it } from "vitest";

import { homeLinkOf, payLinksOf, postReportLinkOf, type ChainSums } from "../apps/runtime/src/services/sale-chain.ts";

// Цепочка продажи (package T), pure: a ledger that did not answer is «неизвестно», never «оплачено»; pay sums appear only
// for a reader who may see them; the day's states read as the ledger keeps them. Synthetic people 101, 102.

const ALL: ChainSums = { share: true, hubLine: true, post: true, pay: true };
const STATES: ChainSums = { share: true, hubLine: true, post: false, pay: false };

const pay = (days: Array<{ amountMills: number; paidMills: number; unpaidMills: number; paidBy?: number[]; model?: string }>) => ({
  reportsFrom: "2026-11-07",
  payouts: [{ date: "2026-11-12", document: 77, amountMills: 50_000 }],
  days: days.map((one) => ({
    date: "2026-11-11", model: one.model ?? "Mia", amountMills: one.amountMills, worked: true, source: "reports",
    state: (one.unpaidMills > 0 ? "to_pay" : one.paidMills > 0 ? "paid" : "none") as "to_pay" | "paid" | "none",
    paidMills: one.paidMills, unpaidMills: one.unpaidMills, paidBy: one.paidBy ?? [],
  })),
});

describe("the ledger's links of a person's day", () => {
  it("says «неизвестно» with why when the ledger did not answer, never «оплачено»", () => {
    const links = payLinksOf({ pay: null, unknown: "ledger не ответил", reportDate: "2026-11-11", model: null, sums: ALL, link: null });
    for (const link of [links.accrual, links.payout]) {
      expect(link).toMatchObject({ state: "unknown", amountMills: null });
      expect(link.words).toBe("неизвестно: ledger не ответил");
      expect(link.words).not.toMatch(/оплачено/u);
    }
  });

  it("reads paid, partly paid and to pay, the sums only for a reader who may see them", () => {
    const paid = payLinksOf({ pay: pay([{ amountMills: 40_000, paidMills: 40_000, unpaidMills: 0, paidBy: [77] }]), unknown: null, reportDate: "2026-11-11", model: "Mia", sums: ALL, link: null });
    expect(paid.accrual).toMatchObject({ state: "done", amountMills: 40_000 });
    expect(paid.payout).toMatchObject({ state: "done", amountMills: 40_000 });
    expect(paid.payout.words).toBe("оплачено 12 нояб.");
    const part = payLinksOf({ pay: pay([{ amountMills: 40_000, paidMills: 10_000, unpaidMills: 30_000, paidBy: [77] }]), unknown: null, reportDate: "2026-11-11", model: "Mia", sums: STATES, link: null });
    expect(part.accrual).toMatchObject({ state: "done", amountMills: null });
    expect(part.payout).toMatchObject({ state: "wait", amountMills: null });
    expect(part.payout.words).toBe("оплачено частично 12 нояб., остальное к выплате");
    expect(`${part.accrual.words} ${part.payout.words}`).not.toMatch(/\$/u);
    const toPay = payLinksOf({ pay: pay([{ amountMills: 40_000, paidMills: 0, unpaidMills: 40_000 }]), unknown: null, reportDate: "2026-11-11", model: "Mia", sums: ALL, link: null });
    expect(toPay.payout).toMatchObject({ state: "wait", words: "к выплате: $40.00" });
  });

  it("takes the sale's model of a day with several, and says a day not accrued yet", () => {
    const two = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 40_000, unpaidMills: 0, model: "Mia", paidBy: [77] }, { amountMills: 9_000, paidMills: 0, unpaidMills: 9_000, model: "Ivy" }]),
      unknown: null, reportDate: "2026-11-11", model: "Ivy", sums: ALL, link: null,
    });
    expect(two.accrual.amountMills).toBe(9_000);
    expect(two.payout.state).toBe("wait");
    const none = payLinksOf({ pay: pay([]), unknown: null, reportDate: "2026-11-11", model: null, sums: ALL, link: null });
    expect(none.accrual).toMatchObject({ state: "wait", amountMills: null });
    expect(none.payout).toMatchObject({ state: "none" });
  });
});

describe("the report of a day as the ledger has it", () => {
  const day = {
    key: "person:anna:2026-11-11", person: { slug: "anna", hubUser: null, name: "anna" }, reportDate: "2026-11-11",
    pages: [{ pageLabel: "mia-1", model: "Mia", postedMills: 83_200, draftMills: null, diffMills: null, state: "post_only", postedAt: null, hubMills: null, hubState: null, basis: "post" }],
    postedMills: 83_200, draftMills: null, hubMills: null, postedAt: null, draft: null, postIds: [5],
  };
  it("says a post does not list sales one by one, the page's sum only for a reader who may see it", () => {
    const owner = postReportLinkOf({ day, posts: [], pageLabel: "mia-1", reportDate: "2026-11-11", sums: ALL, link: null });
    expect(owner).toMatchObject({ state: "done", amountMills: 83_200 });
    expect(owner.words).toContain("пост не перечисляет продажи по одной");
    const lead = postReportLinkOf({ day, posts: [], pageLabel: "mia-1", reportDate: "2026-11-11", sums: STATES, link: null });
    expect(lead.amountMills).toBeNull();
    expect(lead.words).not.toMatch(/\$/u);
  });

  it("says a post the ledger could not use is not accrued", () => {
    const flagged = postReportLinkOf({
      day, pageLabel: "mia-1", reportDate: "2026-11-11", sums: ALL, link: null,
      posts: [{ id: 5, postedAt: "2026-11-11T21:00:00Z", sender: "", tag: "", person: day.person, model: "Mia", reportDate: "2026-11-11", totalMills: 0, pagesMills: 0, flags: ["sum_mismatch"], blocking: true, pages: [], link: null }],
    });
    expect(flagged).toMatchObject({ state: "wait" });
    expect(flagged.words).toContain("не начислен");
  });
});

describe("whose a sale is", () => {
  const sale = { transactionId: 9, occurredAt: new Date("2026-11-11T15:00:00Z") };
  const names = new Map([[101, "Аня"], [102, "Боря"]]);
  it("says the owner's decision and an open dispute above the rule's home", () => {
    const link = homeLinkOf({
      sale: { ...sale, home: { home: "shift", reason: "owner_split", pot: null, shares: [{ userId: 101, workRef: null, shiftId: null, mills: 18_001 }, { userId: 102, workRef: null, shiftId: 4, mills: 18_000 }] } },
      names, decision: { kind: "split", shares: [{ userId: 101, percent: 50 }, { userId: 102, percent: 50 }], pot: null, outcome: "half", source: "dispute", saidBy: null },
      claims: [], ownerReads: true, silenceMs: 86_400_000,
    });
    expect(link).toMatchObject({ state: "done", kind: "shift", above: "решение владельца: Аня 50% и Боря 50%", dispute: null });
    expect(link.words).toBe("Аня $18.00, Боря $18.00: раздел владельца");
    const open = homeLinkOf({
      sale: { ...sale, home: { home: "shift", reason: "holder", pot: null, shares: [{ userId: 102, workRef: null, shiftId: 4, mills: 36_000 }] } },
      names, decision: null, claims: [{ state: "asked", sideUserId: 102, claimantUserId: 101, statement: "mine", createdAt: new Date("2026-11-12T10:00:00Z") }],
      ownerReads: false, silenceMs: 86_400_000,
    });
    expect(open).toMatchObject({ state: "open", link: null });
    expect(open.dispute).toMatch(/^спор открыт: ждёт ответа Боря до 13 нояб\./u);
  });

  it("says a sale before the rule keeps the old way, and an uncomputed one is unknown", () => {
    expect(homeLinkOf({ sale: { transactionId: 1, occurredAt: new Date("2026-10-05T10:00:00Z"), home: null }, names, decision: null, claims: [], ownerReads: true, silenceMs: 1 }))
      .toMatchObject({ state: "none", kind: null });
    expect(homeLinkOf({ sale: { ...sale, home: null }, names, decision: null, claims: [], ownerReads: true, silenceMs: 1 }))
      .toMatchObject({ state: "unknown" });
  });
});
