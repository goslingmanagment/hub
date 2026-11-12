import { describe, expect, it } from "vitest";

import {
  claimedSale,
  classifySale,
  lineAmount,
  pageSums,
  postTexts,
  slotWindowOf,
  type DraftContext,
  type DraftSale,
} from "../apps/runtime/src/services/shift-handin-rules.ts";
import { draftLines } from "../apps/runtime/src/services/shift-handins.ts";

// The shift report's money (ecosystem package F): which sales a draft holds,
// what each line counts, the page sums and the post. Pure.

const ME = 7;
const OTHER = 9;
const SHIFT = 101;
const WORK = `${ME}:2026-11-11T15:14:00.000Z`;
const START = Date.parse("2026-11-11T18:14:00+03:00");

function sale(over: Partial<DraftSale> & { transactionId: number }): DraftSale {
  return {
    pageLabel: "page-1",
    platform: "fansly",
    kind: "message_purchase",
    occurredAt: START + 3_600_000,
    netMills: 40_000,
    home: { kind: "shift", reason: "holder", pot: null, shares: [{ userId: ME, workRef: WORK, shiftId: null, mills: 40_000 }] },
    ppvSenderUserId: null,
    source: "window",
    heldByShift: true,
    inReportWindow: false,
    ...over,
  };
}

const context = (over: Partial<DraftContext> = {}): DraftContext => ({
  shiftId: SHIFT,
  workRef: WORK,
  userIds: new Set([ME]),
  switchOnAt: Date.parse("2026-11-05T00:00:00+03:00"),
  submittedShiftIds: new Set(),
  reported: new Map(),
  handinId: 5,
  ...over,
});

describe("which sales a shift's draft holds", () => {
  it("puts the person's share of the shift's work in «Ваши продажи», another's held sale in «Рядом», an unheld one nowhere", () => {
    expect(classifySale(sale({ transactionId: 1 }), context())).toMatchObject({ group: "mine", shareMills: 40_000, added: false });
    const theirs = sale({
      transactionId: 2,
      home: { kind: "shift", reason: "ppv_sender", pot: null, shares: [{ userId: OTHER, workRef: "9:x", shiftId: null, mills: 40_000 }] },
    });
    expect(classifySale(theirs, context())).toMatchObject({ group: "near", shareMills: 0, toUserId: OTHER });
    expect(classifySale({ ...theirs, heldByShift: false }, context())).toBeNull();
    const pot = sale({ transactionId: 3, home: { kind: "pot", reason: "post_tip", pot: "obshak", shares: [] } });
    expect(classifySale(pot, context())).toMatchObject({ group: "near", toUserId: null });
  });

  it("takes a sale of the days before the shift that the rule gives to this shift (a PPV waiting for its sender's next shift)", () => {
    const next = sale({
      transactionId: 4, source: "before", heldByShift: false, occurredAt: START - 86_400_000,
      home: { kind: "shift", reason: "ppv_sender_next_shift", pot: null, shares: [{ userId: ME, workRef: WORK, shiftId: SHIFT, mills: 40_000 }] },
    });
    expect(classifySale(next, context())).toMatchObject({ group: "mine", added: false });
  });

  it("adds «долёт» only after the switch, only from a shift handed in without it, and only once", () => {
    const late = (over: Partial<DraftSale> = {}) => sale({
      transactionId: 6, source: "before", heldByShift: false, occurredAt: START - 2 * 86_400_000,
      home: { kind: "shift", reason: "holder", pot: null, shares: [{ userId: ME, workRef: "7:prev", shiftId: 99, mills: 12_000 }] },
      ...over,
    });
    // Its own shift's report still to come: it belongs there.
    expect(classifySale(late(), context())).toBeNull();
    // Its own shift was handed in without it: today's report takes it.
    expect(classifySale(late(), context({ submittedShiftIds: new Set([99]) }))).toMatchObject({ group: "mine", added: true, shareMills: 12_000 });
    // Before the switch: the old way (the post) had it.
    expect(classifySale(late(), context({ submittedShiftIds: new Set([99]), switchOnAt: START }))).toBeNull();
    // A report of the person holds it already.
    expect(classifySale(late(), context({ submittedShiftIds: new Set([99]), reported: new Map([[6, { handinId: 3, shiftId: 99, reportDate: "2026-11-09" }]]) }))).toBeNull();
    // A look-in's sale has no report of its own.
    const lookIn = late({ home: { kind: "visit", reason: "look_in_last_writer", pot: null, shares: [{ userId: ME, workRef: "7:visit", shiftId: null, mills: 12_000 }] } });
    expect(classifySale(lookIn, context())).toMatchObject({ group: "mine", added: true });
  });

  it("marks a sale another report of the person holds: it counts nothing here", () => {
    const held = classifySale(sale({ transactionId: 8 }), context({ reported: new Map([[8, { handinId: 4, shiftId: 100, reportDate: "2026-11-10" }]]) }));
    expect(held?.alreadyIn).toEqual({ shiftId: 100, reportDate: "2026-11-10" });
    expect(classifySale(sale({ transactionId: 8 }), context({ reported: new Map([[8, { handinId: 5, shiftId: SHIFT, reportDate: "2026-11-11" }]]) }))?.alreadyIn).toBeNull();
  });
});

describe("the report's window and sales added by hand", () => {
  it("takes the slot the shift ran in: from the earlier start to the later end, with the slot's pages", () => {
    // A slot of 18:00–02:00 (Moscow) on page 11 and a shift of 19:53–02:04.
    const slots = [{ personId: ME, pageId: 11, startMinute: 18 * 60, endMinute: 2 * 60, weekdays: null, validFrom: null, validTo: null }];
    const window = slotWindowOf(slots, {
      userIds: new Set([ME]), startedAt: Date.parse("2026-11-09T19:53:00+03:00"), endedAt: Date.parse("2026-11-10T02:04:00+03:00"),
    });
    expect(window).toEqual({ from: Date.parse("2026-11-09T18:00:00+03:00"), to: Date.parse("2026-11-10T02:00:00+03:00"), pageIds: [11] });
    expect(slotWindowOf(slots, { userIds: new Set([OTHER]), startedAt: 0, endedAt: 1 })).toBeNull();
  });

  it("shows a sale nobody held in the report's window nearby, «ничья», and «моё» counts it plainly", () => {
    const nobody = sale({
      transactionId: 21, heldByShift: false, inReportWindow: true, netMills: 4_000,
      home: { kind: "nobody", reason: "no_holder", pot: null, shares: [] },
    });
    expect(classifySale(nobody, context())).toMatchObject({ group: "near", toUserId: null });
    expect(classifySale({ ...nobody, inReportWindow: false }, context())).toBeNull();
    expect(lineAmount({ group: "near", netMills: 4_000, shareMills: 0, homeKind: "nobody", statement: "mine", alreadyIn: false })).toEqual({ amountMills: 4_000, disputed: false });
  });

  it("counts a sale added by hand only with «моё»: plainly when nobody's; disputed — claimed, counting nothing — when the rule or another report gives it away", () => {
    const base = { group: "mine" as const, netMills: 120_000, shareMills: 0, alreadyIn: false, claimed: true };
    expect(lineAmount({ ...base, homeKind: "nobody", statement: "mine" })).toEqual({ amountMills: 120_000, disputed: false });
    expect(lineAmount({ ...base, homeKind: "shift", statement: "mine" })).toEqual({ amountMills: 0, disputed: true, claimedMills: 120_000 });
    expect(lineAmount({ ...base, homeKind: "nobody", statement: "mine", otherReport: true })).toEqual({ amountMills: 0, disputed: true, claimedMills: 120_000 });
    expect(lineAmount({ ...base, homeKind: "nobody", statement: null })).toEqual({ amountMills: 0, disputed: false });
    const added = claimedSale(sale({ transactionId: 22, source: "before", home: { kind: "shift", reason: "last_writer", pot: null, shares: [{ userId: OTHER, workRef: "9:x", shiftId: 7, mills: 120_000 }] } }), context(), false);
    expect(added).toMatchObject({ group: "mine", added: true, claimed: true, toUserId: OTHER, shareMills: 0 });
  });
});

describe("what a line counts", () => {
  const base = { netMills: 40_000, shareMills: 40_000, homeKind: "shift" as const, alreadyIn: false };
  it("is the share by the rule, 0 for «не моё», half the net for «делим с…»", () => {
    expect(lineAmount({ ...base, group: "mine", statement: null })).toEqual({ amountMills: 40_000, disputed: false });
    expect(lineAmount({ ...base, group: "mine", statement: "not_mine" })).toEqual({ amountMills: 0, disputed: false });
    expect(lineAmount({ ...base, group: "mine", statement: "share" })).toEqual({ amountMills: 20_000, disputed: false });
    expect(lineAmount({ ...base, netMills: 7_201, group: "mine", statement: "share" }).amountMills).toBe(3_601);
  });
  it("counts «моё» on a near sale whole when nobody's; when someone else's it is disputed: claimed, counting nothing until settled", () => {
    expect(lineAmount({ ...base, shareMills: 0, homeKind: "nobody", group: "near", statement: "mine" })).toEqual({ amountMills: 40_000, disputed: false });
    expect(lineAmount({ ...base, shareMills: 0, homeKind: "shift", group: "near", statement: "mine" })).toEqual({ amountMills: 0, disputed: true, claimedMills: 40_000 });
    expect(lineAmount({ ...base, shareMills: 0, homeKind: "pot", group: "near", statement: "mine" })).toEqual({ amountMills: 0, disputed: true, claimedMills: 40_000 });
    expect(lineAmount({ ...base, shareMills: 0, group: "near", statement: null })).toEqual({ amountMills: 0, disputed: false });
  });
  it("counts nothing of a sale another report holds", () => {
    expect(lineAmount({ ...base, alreadyIn: true, group: "mine", statement: null }).amountMills).toBe(0);
  });
});

describe("the draft's lines and sums", () => {
  it("applies the person's words, sets aside a word the line no longer takes, and sums pages", () => {
    const facts = {
      classified: [
        classifySale(sale({ transactionId: 1 }), context())!,
        classifySale(sale({ transactionId: 2, pageLabel: "page-2", netMills: 10_000, home: { kind: "shift", reason: "holder", pot: null, shares: [{ userId: ME, workRef: WORK, shiftId: null, mills: 10_000 }] } }), context())!,
        classifySale(sale({ transactionId: 3, home: { kind: "nobody", reason: "no_holder", pot: null, shares: [] } }), context())!,
      ],
      senders: new Map<number, number>(),
    };
    const at = new Date();
    const lines = draftLines(facts, [
      { transactionId: 1, statement: "share", shareWithUserId: OTHER, note: null, updatedAt: at },
      // «моё» was said when the sale was near; it is the person's now: the word is set aside.
      { transactionId: 2, statement: "mine", shareWithUserId: null, note: "обещал вернуться", updatedAt: at },
      { transactionId: 3, statement: "mine", shareWithUserId: null, note: "договорился в личке", updatedAt: at },
    ]);
    expect(lines.map((line) => [line.transactionId, line.group, line.statement, line.amountMills, line.disputed])).toEqual([
      [1, "mine", "share", 20_000, false],
      [2, "mine", null, 10_000, false],
      [3, "near", "mine", 40_000, false],
    ]);
    expect(lines[0]!.shareWithUserId).toBe(OTHER);
    expect(lines[1]!.note).toBe("обещал вернуться");
    const sums = pageSums(lines.filter((line) => line.group === "mine" || line.amountMills !== 0), ["page-1", "page-2", "page-3"]);
    expect(sums).toEqual({
      pages: [{ pageLabel: "page-1", amountMills: 60_000 }, { pageLabel: "page-2", amountMills: 10_000 }, { pageLabel: "page-3", amountMills: 0 }],
      totalMills: 70_000,
    });
  });
});

describe("the sums add up", () => {
  it("rounds each page to the cent and makes the total of the pages, so the post's page lines equal its total", () => {
    // Three pages of $7.992 each: exactly $23.976, but $7.99 + $7.99 + $7.99 is what a person sees and the ledger reads.
    const lines = ["a-1", "b-1", "c-1"].map((pageLabel) => ({ pageLabel, amountMills: 7_992 }));
    const sums = pageSums(lines, ["a-1", "b-1", "c-1"]);
    expect(sums.pages.map((page) => page.amountMills)).toEqual([7_990, 7_990, 7_990]);
    expect(sums.totalMills).toBe(23_970);
    const [post] = postTexts({
      reportDate: "2026-11-11",
      tag: "#alex",
      pages: sums.pages.map((page) => ({ ...page, platform: "fansly", modelSlug: "mia", modelName: "Mia" })),
      lines: lines.map((line) => ({ ...line, platform: "fansly", kind: "tip", fan: { name: "A", username: null, fanRef: "1" }, note: null })),
      comment: "",
      offPlatform: [],
    });
    const dollars = (text: string) => Math.round(Number(text.replace(/[$,]/g, "")) * 100);
    const pageLines = [...post!.text.matchAll(/^• \S+ - (\$[\d,.]+)$/gmu)].map((match) => dollars(match[1]!));
    const total = dollars(/Общий доход: (\$[\d,.]+)/u.exec(post!.text)![1]!);
    expect(pageLines).toEqual([799, 799, 799]);
    expect(pageLines.reduce((sum, cents) => sum + cents, 0)).toBe(total);
    // Half a cent goes up.
    expect(pageSums([{ pageLabel: "a-1", amountMills: 7_995 }], ["a-1"]).totalMills).toBe(8_000);
  });
});

describe("the post in «Отчётность»", () => {
  it("writes one post per model, the accounts and total of its pages, the fans by sum, off-platform only in the comment", () => {
    const posts = postTexts({
      reportDate: "2026-11-11",
      tag: "#alex",
      pages: [
        { pageLabel: "mia-1", platform: "fansly", modelSlug: "mia", modelName: "Mia", amountMills: 119_200 },
        { pageLabel: "zoe-1", platform: "fansly", modelSlug: "zoe", modelName: "Zoe", amountMills: 36_000 },
        { pageLabel: "mia-of", platform: "onlyfans", modelSlug: "mia", modelName: "Mia", amountMills: 0 },
      ],
      lines: [
        { pageLabel: "mia-1", platform: "fansly", kind: "tip", amountMills: 80_000, fan: { name: "A", username: "fan_a", fanRef: "1" }, note: "секстинг" },
        { pageLabel: "mia-1", platform: "fansly", kind: "message_purchase", amountMills: 39_200, fan: { name: "B", username: null, fanRef: "2" }, note: null },
        { pageLabel: "zoe-1", platform: "fansly", kind: "message_purchase", amountMills: 12_000, fan: { name: "C", username: "fan_c", fanRef: "3" }, note: null },
        { pageLabel: "zoe-1", platform: "fansly", kind: "message_purchase", amountMills: 24_000, fan: { name: "C", username: "fan_c", fanRef: "3" }, note: null },
        { pageLabel: "zoe-1", platform: "fansly", kind: "subscription", amountMills: 0, fan: { name: "D", username: "fan_d", fanRef: "4" }, note: null },
      ],
      comment: "Без оплаты, на следующую смену: фан B ждёт кастом",
      offPlatform: [{ amountMills: 50_000, fromWhom: "фан E", whatFor: "кастом" }],
    });
    expect(posts.map((post) => post.modelSlug)).toEqual(["mia", "zoe"]);
    expect(posts[0]!.text).toBe([
      "🗓 Дата: 11.11.2026",
      "👤 Чаттер: #alex",
      "",
      "📌 Аккаунты:",
      "Fansly",
      "• mia-1 - $119.20",
      "OF",
      "• mia-of - $0.00",
      "",
      "💰Общий доход: $119.20",
      "",
      "📈 Основные продажи:",
      "https://fansly.com/fan_a/posts - tip $80.00. секстинг",
      "B - ppv $39.20",
      "",
      "📝 Комментарий:",
      "Без оплаты, на следующую смену: фан B ждёт кастом",
      "Мимо площадки, ждёт подтверждения владельца: $50.00 от фан E, кастом",
    ].join("\n"));
    expect(posts[1]!.text).toContain("💰Общий доход: $36.00");
    expect(posts[1]!.text).toContain("https://fansly.com/fan_c/posts - ppv x2 $36.00");
    expect(posts[1]!.text).not.toContain("fan_d");
    expect(posts[1]!.text).not.toContain("Мимо площадки");
  });
});
