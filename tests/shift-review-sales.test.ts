import { describe, expect, it } from "vitest";

import type { ShiftSale } from "@agency_hub_core/db";
import type { ComputedWork } from "../apps/runtime/src/services/chatter-shifts.ts";
import { saleOriginOf } from "../apps/runtime/src/services/chatter-stats.ts";
import { heldNetMills, settleShiftSales } from "../apps/runtime/src/services/shift-review.ts";
import { salesOfWork, teamShiftMoney } from "../apps/runtime/src/services/team-shift-sales.ts";

// «Разбор смены»: whose each sale on the shift's pages is. The header must stay «Заработок»'s number; the chat
// labels used to add up every sale of the fan in the shift, a colleague's too (#1058 fixed the header only).

const ME = 1;
const NIKITA = 2;
const SOFIA = 3;

function work(startedAt: string, endedAt: string, page = "ari-1", salesFrom = startedAt): ComputedWork {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return {
    kind: "shift", startedAt: start, endedAt: end, ongoing: false, workedMinutes: Math.round((end - start) / 60_000), pauses: [], lastInputAt: end, lastBeatAt: end,
    pages: new Map([[page, 60]]), messages: new Map([[page, 60]]), salesSince: new Map([[page, Date.parse(salesFrom)]]),
  };
}

let nextId = 1;
function sale(occurredAt: string, netMills: number, page = "ari-1"): ShiftSale {
  return {
    transactionId: nextId++, pageId: page === "ari-1" ? 10 : 1, pageLabel: page, platform: "fansly", fanId: nextId, fanRef: `fan${nextId}`,
    fanName: null, kind: "message_purchase", grossMills: netMills, netMills, occurredAt: new Date(occurredAt),
  };
}

describe("settleShiftSales", () => {
  // My night on ari-1 from 21:00; Nikita on ari-1 till 23:00; Sofia on lora-1 all evening.
  const mine = work("2026-11-02T21:00:00Z", "2026-11-03T05:00:00Z");
  const nikita = work("2026-11-02T15:00:00Z", "2026-11-02T23:00:00Z");
  const sofia = work("2026-11-02T15:00:00Z", "2026-11-03T01:00:00Z", "lora-1");
  const colleagues = [{ userId: NIKITA, username: "Nikita", work: nikita }, { userId: SOFIA, username: "Sofia", work: sofia }];

  const alone = sale("2026-11-03T02:00:00Z", 10_000);
  const nikitaWrote = sale("2026-11-02T22:00:00Z", 30_000);
  const nobodyWrote = sale("2026-11-02T22:10:00Z", 4_000);
  const iWrote = sale("2026-11-02T22:20:00Z", 6_000);
  const onLora = sale("2026-11-02T22:30:00Z", 50_000, "lora-1");
  const before = sale("2026-11-02T21:05:00Z", 7_000);
  const sales = [before, nikitaWrote, nobodyWrote, iWrote, onLora, alone];
  // I took ari-1 over at 21:10: the sale at 21:05 is not mine. lora-1 is not my page at all.
  const shift = { ...mine, salesSince: new Map([["ari-1", Date.parse("2026-11-02T21:10:00Z")]]) };
  const held = new Set(salesOfWork(shift, sales).map((one) => one.transactionId));
  const lastWriters = new Map([[nikitaWrote.transactionId, NIKITA], [iWrote.transactionId, ME]]);
  const settled = settleShiftSales({ userId: ME, kind: "shift", sales, held, colleagues, lastWriters });
  const of = (one: ShiftSale) => settled.find((row) => row.sale.transactionId === one.transactionId)!;

  it("gives a sale both shifts hold to the one who last wrote, and to both when neither did", () => {
    expect(of(alone)).toMatchObject({ held: true, verdict: "mine", holder: null });
    expect(of(iWrote)).toMatchObject({ held: true, verdict: "mine", holder: null });
    expect(of(nikitaWrote)).toMatchObject({ held: true, verdict: "theirs", holder: "Nikita" });
    expect(of(nobodyWrote)).toMatchObject({ held: true, verdict: "both", holder: "Nikita" });
  });

  it("names whose shift holds a sale this one does not, or nobody", () => {
    expect(of(onLora)).toMatchObject({ held: false, verdict: "theirs", holder: "Sofia" });
    expect(of(before)).toMatchObject({ held: false, verdict: "theirs", holder: "Nikita" });
    const night = settleShiftSales({ userId: ME, kind: "shift", sales: [before], held: new Set(), colleagues: [], lastWriters: new Map() });
    expect(night[0]).toMatchObject({ held: false, verdict: "none", holder: null });
  });

  it("keeps the header «Заработок»'s: the shift's own sales and the shared ones, never a colleague's", () => {
    expect(heldNetMills(settled)).toBe(alone.netMills + iWrote.netMills + nobodyWrote.netMills);
    const money = teamShiftMoney({
      days: 7,
      now: new Date("2026-11-04T12:00:00Z"),
      shifts: [
        { userId: ME, username: "me", work: shift, held: salesOfWork(shift, sales) },
        { userId: NIKITA, username: "Nikita", work: nikita, held: salesOfWork(nikita, sales) },
        { userId: SOFIA, username: "Sofia", work: sofia, held: salesOfWork(sofia, sales) },
      ],
      lastWriters,
      firstActivity: new Map([[ME, new Date("2026-01-01T00:00:00Z")]]),
    });
    expect(money.chatters.find((one) => one.userId === ME)!.salesNetMills).toBe(heldNetMills(settled));
  });

  it("leaves a look-in its own sales", () => {
    const visit = settleShiftSales({ userId: ME, kind: "visit", sales: [nikitaWrote], held: new Set([nikitaWrote.transactionId]), colleagues, lastWriters });
    expect(visit[0]).toMatchObject({ held: true, verdict: "mine" });
  });
});

// Where a sale came from (2026-11-07): the team credits a PPV to its sender and keeps tips under a post and Campaign
// money apart, while the screen showed one sum. The facts, not a rule: whose it is stays `settleShiftSales`'s.
describe("saleOriginOf", () => {
  const facts = { kind: "message_purchase", ppvSenderId: null, ppvWithoutAuthor: false, postTip: false, campaign: false, lastWriter: null };

  it("goes by the PPV's sender, whoever wrote last", () => {
    expect(saleOriginOf(ME, { ...facts, ppvSenderId: ME, lastWriter: NIKITA })).toBe("own");
    expect(saleOriginOf(ME, { ...facts, ppvSenderId: NIKITA, lastWriter: ME })).toBe("colleague_ppv");
    expect(saleOriginOf(ME, { ...facts, ppvWithoutAuthor: true, lastWriter: ME })).toBe("no_author_ppv");
  });

  it("goes by who last wrote when no PPV says", () => {
    expect(saleOriginOf(ME, { ...facts, kind: "tip", lastWriter: ME })).toBe("own");
    expect(saleOriginOf(ME, { ...facts, kind: "subscription", lastWriter: SOFIA })).toBe("other_wrote");
    expect(saleOriginOf(ME, { ...facts, kind: "tip" })).toBe("nobody_wrote_48h");
    expect(saleOriginOf(ME, { ...facts, lastWriter: ME })).toBe("own");
  });

  it("keeps a tip under a post and a Campaign contribution apart, whoever wrote", () => {
    expect(saleOriginOf(ME, { ...facts, kind: "tip", postTip: true, lastWriter: ME })).toBe("post_tip");
    expect(saleOriginOf(ME, { ...facts, kind: "tip", campaign: true, lastWriter: ME })).toBe("campaign");
  });
});
