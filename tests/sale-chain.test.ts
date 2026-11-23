import { describe, expect, it } from "vitest";

import {
  chainReportDateOf,
  homeLinkOf,
  hubReportEvidenceOf,
  nonReportDayModelOf,
  payLinksOf,
  postReportLinkOf,
  reportPageMetaOf,
  type ChainSums,
} from "../apps/runtime/src/services/sale-chain.ts";

// Цепочка продажи (package T, OA-003), pure: the chain never claims «this sale is paid». On Hub-basis days it reports
// what active version N counted plus whether the day for the sale's exact model is paid; on sheet/post/facts days it
// reports that inclusion of this sale is unconfirmed; when model or basis is unknown it says «неизвестно», never
// mixing another model of the day. Synthetic people 101, 102 and synthetic models Mia, Ivy.

const ALL: ChainSums = { share: true, hubLine: true, post: true, pay: true };
const STATES: ChainSums = { share: true, hubLine: true, post: false, pay: false };

const pay = (
  days: Array<{ date?: string; amountMills: number; paidMills: number; unpaidMills: number; paidBy?: number[]; model?: string; source?: string }>,
) => ({
  reportsFrom: "2026-11-07",
  payouts: [{ date: "2026-11-12", document: 77, amountMills: 50_000 }],
  days: days.map((one) => ({
    date: one.date ?? "2026-11-11",
    model: one.model ?? "Mia",
    amountMills: one.amountMills,
    worked: true,
    source: one.source ?? "reports",
    state: (one.unpaidMills > 0 ? "to_pay" : one.paidMills > 0 ? "paid" : "none") as "to_pay" | "paid" | "none",
    paidMills: one.paidMills,
    unpaidMills: one.unpaidMills,
    paidBy: one.paidBy ?? [],
  })),
});

describe("the ledger's links of a person's day", () => {
  it("says «неизвестно» with why when the ledger did not answer, never «оплачено»", () => {
    const links = payLinksOf({
      pay: null, unknown: "ledger не ответил", reportDate: "2026-11-11", model: null, basis: null, hubReport: null, sums: ALL, link: null,
    });
    for (const link of [links.accrual, links.payout]) {
      expect(link).toMatchObject({ state: "unknown", amountMills: null });
      expect(link.words).toBe("неизвестно: ledger не ответил");
      expect(link.words).not.toMatch(/оплачен/u);
    }
  });

  it("on a Hub-basis day reports active version N verdict (counted, disputed, zero) plus model day pay status", () => {
    const countedPaid = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 40_000, unpaidMills: 0, paidBy: [77] }]),
      unknown: null, reportDate: "2026-11-11", model: "Mia", basis: "hub", hubReport: { version: 2, status: "counted" }, sums: ALL, link: null,
    });
    expect(countedPaid.accrual).toMatchObject({ state: "done", amountMills: 40_000 });
    expect(countedPaid.accrual.words).toBe("начислено за 11 нояб. по модели Mia (отчёт Hub): $40.00 за день");
    expect(countedPaid.payout).toMatchObject({ state: "done", amountMills: 40_000 });
    expect(countedPaid.payout.words).toBe("в версии 2 — засчитано; день по модели Mia оплачен полностью 12 нояб.");

    const countedPartial = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 10_000, unpaidMills: 30_000, paidBy: [77] }]),
      unknown: null, reportDate: "2026-11-11", model: "Mia", basis: "hub", hubReport: { version: 3, status: "counted" }, sums: STATES, link: null,
    });
    expect(countedPartial.accrual).toMatchObject({ state: "done", amountMills: null });
    expect(countedPartial.payout).toMatchObject({ state: "wait", amountMills: null });
    expect(countedPartial.payout.words).toBe("в версии 3 — засчитано; день по модели Mia оплачен частично 12 нояб., остальное к выплате");
    expect(`${countedPartial.accrual.words} ${countedPartial.payout.words}`).not.toMatch(/\$/u);

    const countedToPay = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 0, unpaidMills: 40_000 }]),
      unknown: null, reportDate: "2026-11-11", model: "Mia", basis: "hub", hubReport: { version: 1, status: "counted" }, sums: ALL, link: null,
    });
    expect(countedToPay.payout).toMatchObject({ state: "wait", amountMills: null });
    expect(countedToPay.payout.words).toBe("в версии 1 — засчитано; день по модели Mia к выплате: $40.00");

    const disputedPaid = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 40_000, unpaidMills: 0, paidBy: [77] }]),
      unknown: null, reportDate: "2026-11-11", model: "Mia", basis: "hub", hubReport: { version: 2, status: "disputed" }, sums: ALL, link: null,
    });
    expect(disputedPaid.payout).toMatchObject({ state: "open", amountMills: 40_000 });
    expect(disputedPaid.payout.words).toBe("в версии 2 — спорно; день по модели Mia оплачен полностью 12 нояб.");

    const disputedPartial = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 10_000, unpaidMills: 30_000, paidBy: [77] }]),
      unknown: null, reportDate: "2026-11-11", model: "Mia", basis: "hub", hubReport: { version: 2, status: "disputed" }, sums: ALL, link: null,
    });
    expect(disputedPartial.payout).toMatchObject({ state: "open", amountMills: 10_000 });
    expect(disputedPartial.payout.words).toBe("в версии 2 — спорно; день по модели Mia оплачен частично 12 нояб., остальное к выплате: $30.00");

    const zeroPaid = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 40_000, unpaidMills: 0, paidBy: [77] }]),
      unknown: null, reportDate: "2026-11-11", model: "Mia", basis: "hub", hubReport: { version: 2, status: "zero" }, sums: ALL, link: null,
    });
    expect(zeroPaid.payout).toMatchObject({ state: "none", amountMills: 40_000 });
    expect(zeroPaid.payout.words).toBe("в версии 2 — ноль; день по модели Mia оплачен полностью 12 нояб.");

    const zeroPartial = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 10_000, unpaidMills: 30_000, paidBy: [77] }]),
      unknown: null, reportDate: "2026-11-11", model: "Mia", basis: "hub", hubReport: { version: 4, status: "zero" }, sums: ALL, link: null,
    });
    expect(zeroPartial.payout).toMatchObject({ state: "none", amountMills: 10_000 });
    expect(zeroPartial.payout.words).toBe("в версии 4 — ноль; день по модели Mia оплачен частично 12 нояб., остальное к выплате: $30.00");

    const missingInHub = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 40_000, unpaidMills: 0, paidBy: [77] }]),
      unknown: null, reportDate: "2026-11-11", model: "Mia", basis: "hub", hubReport: null, sums: ALL, link: null,
    });
    expect(missingInHub.payout).toMatchObject({ state: "wait", amountMills: 40_000 });
    expect(missingInHub.payout.words).toBe("этой продажи нет в сданном отчёте; день по модели Mia оплачен полностью 12 нояб.");
  });

  it("on a post, sheet or facts day says the day is paid/partly/to-pay while this sale's inclusion is unconfirmed", () => {
    const postPaid = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 40_000, unpaidMills: 0, paidBy: [77], source: "reports" }]),
      unknown: null, reportDate: "2026-11-11", model: "Mia", basis: "post", hubReport: null, sums: ALL, link: null,
    });
    expect(postPaid.accrual).toMatchObject({ state: "done", amountMills: 40_000 });
    expect(postPaid.payout).toMatchObject({ state: "unknown", amountMills: 40_000 });
    expect(postPaid.payout.words).toBe("день оплачен, включение этой продажи не подтверждено (12 нояб.)");

    // Even if a Hub version was handed in during shadow mode, a post-basis day stays unconfirmed.
    const shadowHubOnPost = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 40_000, unpaidMills: 0, paidBy: [77], source: "reports" }]),
      unknown: null, reportDate: "2026-11-11", model: "Mia", basis: "post", hubReport: { version: 1, status: "counted" }, sums: STATES, link: null,
    });
    expect(shadowHubOnPost.payout).toMatchObject({ state: "unknown", amountMills: null });
    expect(shadowHubOnPost.payout.words).toBe("день оплачен, включение этой продажи не подтверждено (12 нояб.)");
    expect(`${shadowHubOnPost.accrual.words} ${shadowHubOnPost.payout.words}`).not.toMatch(/\$/u);

    const sheetPaid = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 40_000, unpaidMills: 0, source: "sheet" }]),
      unknown: null, reportDate: "2026-11-11", model: "Mia", basis: null, hubReport: null, sums: ALL, link: null,
    });
    expect(sheetPaid.accrual.words).toContain("(таблица)");
    expect(sheetPaid.payout).toMatchObject({ state: "unknown", words: "день оплачен, включение этой продажи не подтверждено" });

    const factsPartial = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 15_000, unpaidMills: 25_000, paidBy: [77], source: "facts" }]),
      unknown: null, reportDate: "2026-11-11", model: "Mia", basis: null, hubReport: null, sums: ALL, link: null,
    });
    expect(factsPartial.accrual.words).toContain("(факты)");
    expect(factsPartial.payout).toMatchObject({
      state: "wait",
      amountMills: 15_000,
      words: "день оплачен частично 12 нояб., остальное к выплате: $25.00; включение этой продажи не подтверждено",
    });

    const postUnpaid = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 0, unpaidMills: 40_000, source: "reports" }]),
      unknown: null, reportDate: "2026-11-11", model: "Mia", basis: "post", hubReport: null, sums: STATES, link: null,
    });
    expect(postUnpaid.payout).toMatchObject({
      state: "wait",
      amountMills: null,
      words: "день к выплате; включение этой продажи не подтверждено",
    });
    expect(`${postUnpaid.accrual.words} ${postUnpaid.payout.words}`).not.toMatch(/\$/u);
  });

  it("checks only the sale's exact model when two models share a day, never substituting another model", () => {
    const two = payLinksOf({
      pay: pay([
        { amountMills: 40_000, paidMills: 40_000, unpaidMills: 0, model: "Mia", paidBy: [77] },
        { amountMills: 9_000, paidMills: 0, unpaidMills: 9_000, model: "Ivy" },
      ]),
      unknown: null, reportDate: "2026-11-11", model: "Ivy", basis: "hub", hubReport: { version: 2, status: "counted" }, sums: ALL, link: null,
    });
    expect(two.accrual).toMatchObject({ state: "done", amountMills: 9_000 });
    expect(two.payout).toMatchObject({ state: "wait", amountMills: null });
    expect(two.payout.words).toBe("в версии 2 — засчитано; день по модели Ivy к выплате: $9.00");
    expect(two.payout.words).not.toMatch(/оплачен/u);

    // If Ivy is not accrued yet while Mia is already paid on the same day, Ivy must NOT fall back to Mia.
    const otherModelPaid = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 40_000, unpaidMills: 0, model: "Mia", paidBy: [77] }]),
      unknown: null, reportDate: "2026-11-11", model: "Ivy", basis: "hub", hubReport: { version: 2, status: "counted" }, sums: ALL, link: null,
    });
    expect(otherModelPaid.accrual).toMatchObject({ state: "wait", amountMills: null });
    expect(otherModelPaid.accrual.words).toContain("по модели Ivy");
    expect(otherModelPaid.payout).toMatchObject({ state: "none", amountMills: null });
    expect(otherModelPaid.payout.words).toBe("в версии 2 — засчитано; день по модели Ivy не начислен");
    expect(otherModelPaid.payout.words).not.toMatch(/оплачен/u);

    const none = payLinksOf({
      pay: pay([]), unknown: null, reportDate: "2026-11-11", model: null, basis: null, hubReport: null, sums: ALL, link: null,
    });
    expect(none.accrual).toMatchObject({ state: "wait", amountMills: null });
    expect(none.payout).toMatchObject({ state: "none" });
  });

  it("says «неизвестно» when the model, basis, source or report-days read is unknown", () => {
    const unknownModel = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 40_000, unpaidMills: 0, model: "Mia", paidBy: [77] }]),
      unknown: null, reportDate: "2026-11-11", model: null, basis: "hub", hubReport: { version: 1, status: "counted" }, sums: ALL, link: null,
    });
    for (const link of [unknownModel.accrual, unknownModel.payout]) {
      expect(link).toMatchObject({ state: "unknown", amountMills: null });
      expect(link.words).toMatch(/^неизвестно:/u);
      expect(link.words).not.toMatch(/оплачен/u);
    }

    const unknownBasis = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 40_000, unpaidMills: 0, model: "Mia", paidBy: [77], source: "reports" }]),
      unknown: null, reportDate: "2026-11-11", model: "Mia", basis: null, hubReport: { version: 1, status: "counted" }, sums: ALL, link: null,
    });
    for (const link of [unknownBasis.accrual, unknownBasis.payout]) {
      expect(link).toMatchObject({ state: "unknown", amountMills: null });
      expect(link.words).toMatch(/^неизвестно:/u);
      expect(link.words).not.toMatch(/оплачен/u);
    }

    const unknownSource = payLinksOf({
      pay: pay([{ amountMills: 40_000, paidMills: 40_000, unpaidMills: 0, model: "Mia", paidBy: [77], source: "manual" }]),
      unknown: null, reportDate: "2026-11-11", model: "Mia", basis: "hub", hubReport: { version: 1, status: "counted" }, sums: ALL, link: null,
    });
    for (const link of [unknownSource.accrual, unknownSource.payout]) {
      expect(link).toMatchObject({ state: "unknown", amountMills: null });
      expect(link.words).toMatch(/^неизвестно:/u);
    }

    const reportsDown = payLinksOf({
      pay: pay([]),
      unknown: null, reportDate: "2026-11-11", model: null, basis: null, hubReport: { version: 1, status: "counted" }, reportsUnknown: "ledger не ответил", sums: ALL, link: null,
    });
    for (const link of [reportsDown.accrual, reportsDown.payout]) {
      expect(link).toMatchObject({ state: "unknown", amountMills: null, words: "неизвестно: ledger не ответил" });
    }
  });
});

describe("report date, page metadata and Hub report evidence", () => {
  it("uses decision.appliedReportDate when there is no handedIn, respecting logins and handedIn priority", () => {
    const occurredAt = new Date("2026-11-10T15:00:00Z");
    const shift = { reportDate: "2026-11-10" };
    // Shifted report applied to this person (via a secondary login) without handedIn.
    expect(chainReportDateOf({
      handedIn: null,
      decision: { appliedReportDate: "2026-11-12", appliedUserId: 201 },
      logins: [101, 201],
      shift,
      occurredAt,
    })).toBe("2026-11-12");

    // Shifted report with unspecified appliedUserId applies when there is no handedIn.
    expect(chainReportDateOf({
      handedIn: null,
      decision: { appliedReportDate: "2026-11-13", appliedUserId: null },
      logins: [101],
      shift: null,
      occurredAt,
    })).toBe("2026-11-13");

    // On a split, another person's appliedReportDate does not shift this person's day.
    expect(chainReportDateOf({
      handedIn: null,
      decision: { appliedReportDate: "2026-11-12", appliedUserId: 102 },
      logins: [101],
      shift,
      occurredAt,
    })).toBe("2026-11-10");

    // Handed-in Hub version wins over decision.appliedReportDate.
    expect(chainReportDateOf({
      handedIn: { reportDate: "2026-11-11" },
      decision: { appliedReportDate: "2026-11-12", appliedUserId: 101 },
      logins: [101],
      shift,
      occurredAt,
    })).toBe("2026-11-11");

    // Without handedIn, decision or shift, falls back to the sale's Moscow day.
    expect(chainReportDateOf({
      handedIn: null,
      decision: null,
      logins: [101],
      shift: null,
      occurredAt: new Date("2026-11-10T22:30:00Z"),
    })).toBe("2026-11-11");
  });

  it("reads the exact page's model and basis from ledger report-days on multi-model days", () => {
    const reports = {
      reports: [{
        key: "person:anna:2026-11-11",
        person: { slug: "anna", hubUser: null, name: "anna" },
        reportDate: "2026-11-11",
        pages: [
          { pageLabel: "mia-1", model: "Mia", postedMills: null, draftMills: null, diffMills: null, state: "hub_only", postedAt: null, hubMills: 40_000, hubState: "hub_only", basis: "hub" },
          { pageLabel: "ivy-1", model: "Ivy", postedMills: 15_000, draftMills: null, diffMills: null, state: "post_only", postedAt: null, hubMills: null, hubState: null, basis: "post" },
          { pageLabel: "bare-1", model: "  ", postedMills: 5_000, draftMills: null, diffMills: null, state: "post_only", postedAt: null, hubMills: null, hubState: null, basis: null },
        ],
        postedMills: 20_000, draftMills: null, hubMills: 40_000, postedAt: null, draft: null, postIds: [],
      }],
    };
    expect(reportPageMetaOf(reports, { personCode: "anna", reportDate: "2026-11-11", pageLabel: "mia-1" }))
      .toMatchObject({ model: "Mia", basis: "hub" });
    expect(reportPageMetaOf(reports, { personCode: "anna", reportDate: "2026-11-11", pageLabel: "ivy-1" }))
      .toMatchObject({ model: "Ivy", basis: "post" });
    expect(reportPageMetaOf(reports, { personCode: "anna", reportDate: "2026-11-11", pageLabel: "bare-1" }))
      .toMatchObject({ model: null, basis: null });
    expect(reportPageMetaOf(reports, { personCode: "anna", reportDate: "2026-11-11", pageLabel: "other-1" }))
      .toMatchObject({ model: null, basis: null });
  });

  it("resolves sheet/facts model only when it unambiguously maps to the sale's Hub model", () => {
    const models = [{ slug: "mia", name: "Mia" }, { slug: "ivy", name: "Ivy" }];
    expect(nonReportDayModelOf({
      days: [
        { date: "2026-11-04", model: "Mia", source: "sheet" },
        { date: "2026-11-04", model: "Ivy", source: "sheet" },
      ],
      reportDate: "2026-11-04", saleModel: models[1]!, models,
    })).toBe("Ivy");

    // Another known model only -> returns sale model name so payLinksOf sees zero accrual for Ivy, never Mia.
    expect(nonReportDayModelOf({
      days: [{ date: "2026-11-04", model: "Mia", source: "sheet" }],
      reportDate: "2026-11-04", saleModel: models[1]!, models,
    })).toBe("Ivy");

    // Unrecognised tab name alongside another known model -> null (never guesses).
    expect(nonReportDayModelOf({
      days: [
        { date: "2026-11-04", model: "Mia", source: "sheet" },
        { date: "2026-11-04", model: "MysteryTab", source: "reports" },
      ],
      reportDate: "2026-11-04", saleModel: models[1]!, models,
    })).toBeNull();

    // Unrecognised tab name -> null (never guesses).
    expect(nonReportDayModelOf({
      days: [{ date: "2026-11-04", model: "MysteryTab", source: "sheet" }],
      reportDate: "2026-11-04", saleModel: models[0]!, models,
    })).toBeNull();

    // Reports days are never resolved here (must come from readReports).
    expect(nonReportDayModelOf({
      days: [{ date: "2026-11-11", model: "Mia", source: "reports" }],
      reportDate: "2026-11-11", saleModel: models[0]!, models,
    })).toBeNull();
  });

  it("extracts active Hub version status for counted, disputed (with or without claimedMills), and zero lines", () => {
    const line = (patch: Partial<{ transactionId: number; amountMills: number; disputed: boolean; claimedMills: number }>) => ({
      transactionId: patch.transactionId ?? 9,
      offPlatformId: null,
      group: "mine" as const,
      pageLabel: "mia-1",
      kind: "tip",
      occurredAt: "2026-11-11T15:00:00Z",
      netMills: 20_000,
      rule: { home: "shift", reason: "holder", shareMills: 20_000, toUserId: null, senderUserId: null },
      alreadyIn: null,
      statement: null,
      shareWithUserId: null,
      note: null,
      amountMills: patch.amountMills ?? 20_000,
      added: false,
      disputed: patch.disputed ?? false,
      ...(patch.claimedMills !== undefined ? { claimedMills: patch.claimedMills } : {}),
    });
    expect(hubReportEvidenceOf(null, 9)).toBeNull();
    expect(hubReportEvidenceOf({ version: 2, lines: [line({ amountMills: 20_000 })] }, 9)).toEqual({ version: 2, status: "counted" });
    expect(hubReportEvidenceOf({ version: 2, lines: [line({ amountMills: 0, disputed: true, claimedMills: 20_000 })] }, 9)).toEqual({ version: 2, status: "disputed" });
    expect(hubReportEvidenceOf({ version: 2, lines: [line({ amountMills: 0, disputed: true })] }, 9)).toEqual({ version: 2, status: "disputed" });
    expect(hubReportEvidenceOf({ version: 2, lines: [line({ amountMills: 0, disputed: false })] }, 9)).toEqual({ version: 2, status: "zero" });
    expect(hubReportEvidenceOf({ version: 2, lines: [line({ transactionId: 10 })] }, 9)).toBeNull();
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

  it("says a Hub-basis day handed in without this sale does not hold it", () => {
    const hubDay = {
      ...day,
      pages: [{ pageLabel: "mia-1", model: "Mia", postedMills: null, draftMills: null, diffMills: null, state: "hub_only", postedAt: null, hubMills: 83_200, hubState: "hub_only", basis: "hub" }],
      postedMills: null, hubMills: 83_200, postIds: [],
    };
    const missing = postReportLinkOf({ day: hubDay, posts: [], pageLabel: "mia-1", reportDate: "2026-11-11", sums: ALL, link: null });
    expect(missing).toMatchObject({ state: "wait", amountMills: null });
    expect(missing.words).toBe("отчёт за 11 нояб. сдан в системе, но без этой продажи");
  });
});

describe("whose a sale is", () => {
  const sale = { transactionId: 9, occurredAt: new Date("2026-11-11T15:00:00Z") };
  const names = new Map([[101, "Аня"], [102, "Боря"]]);
  it("says the owner's decision and an open dispute above the rule's home", () => {
    const link = homeLinkOf({
      sale: { ...sale, home: { home: "shift", reason: "owner_split", pot: null, shares: [{ userId: 101, workRef: null, shiftId: null, mills: 18_001 }, { userId: 102, workRef: null, shiftId: 4, mills: 18_000 }] } },
      names, decision: { kind: "split", shares: [{ userId: 101, percent: 50 }, { userId: 102, percent: 50 }], pot: null, outcome: "half", source: "dispute", saidBy: null },
      claims: [], ownerReads: true,
    });
    expect(link).toMatchObject({ state: "done", kind: "shift", above: "решение владельца: Аня 50% и Боря 50%", dispute: null });
    expect(link.words).toBe("Аня $18.00, Боря $18.00: раздел владельца");
    const open = homeLinkOf({
      sale: { ...sale, home: { home: "shift", reason: "holder", pot: null, shares: [{ userId: 102, workRef: null, shiftId: 4, mills: 36_000 }] } },
      names, decision: null, claims: [{ state: "asked", sideUserId: 102, claimantUserId: 101, statement: "mine", createdAt: new Date("2026-11-12T10:00:00Z") }],
      ownerReads: false,
    });
    expect(open).toMatchObject({ state: "open", link: null });
    expect(open.dispute).toMatch(/^спор открыт: ждёт ответа Боря/u);
  });

  it("says a sale before the rule keeps the old way, and an uncomputed one is unknown", () => {
    expect(homeLinkOf({ sale: { transactionId: 1, occurredAt: new Date("2026-10-05T10:00:00Z"), home: null }, names, decision: null, claims: [], ownerReads: true }))
      .toMatchObject({ state: "none", kind: null });
    expect(homeLinkOf({ sale: { ...sale, home: null }, names, decision: null, claims: [], ownerReads: true }))
      .toMatchObject({ state: "unknown" });
  });
});
