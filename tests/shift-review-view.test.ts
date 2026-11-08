import { describe, expect, it } from "vitest";
import type { ShiftReviewChat, ShiftReviewMessage, TeamShiftReviewResponse } from "@agency_hub_core/contracts";
import { cameBack, chatBusyIn, myMessages, pulseOf, reviewWaits, salesByOrigin, salesSplit, showPasses, sortSummaries, summariesOf, totalsOf } from "@/pages/team/review/shiftReviewView";

// «Разбор смены»: whose a fan's wait is when a page is shared or handed over (2026-11-07). The first version counted
// a colleague's chats, waits and money as the reviewed chatter's.

const at = (time: string) => `2026-11-06T${time}:00.000Z`;

function message(time: string, side: "fan" | "page", by: ShiftReviewMessage["by"], extra: Partial<ShiftReviewMessage> = {}): ShiftReviewMessage {
  return {
    ref: `${time}-${side}-${by ?? "fan"}`, at: at(time), side, text: "hey there", priceMills: null, bought: null, tipMills: null, media: 0,
    inShift: time >= "09:00", by, byName: by === "other" ? "Sofia" : null, mass: false, mine: null, ...extra,
  };
}

function mine(time: string, replySeconds: number | null): ShiftReviewMessage {
  return message(time, "page", "me", {
    mine: { composedWith: "reply", edited: false, origin: "ai", aiShare: 1, aiFeature: "fast-reply", aiText: "hey there", draft: null, replySeconds, repeats: 0, marks: [] },
  });
}

function chat(key: string, messages: ShiftReviewMessage[]): ShiftReviewChat {
  return {
    key, pageLabel: "page-1", platform: "fansly", conversationRef: key, fanRef: key, fanUsername: key, fanDisplayName: null,
    fanLifetimeNetMills: null, shiftNetMills: 0, earlierHidden: 0, messages,
  };
}

const wait = (key: string, since: string, to: string, by: TeamShiftReviewResponse["waits"][number]["by"]) => ({
  chat: key, since: at(since), from: at(since < "09:00" ? "09:00" : since), to: at(to), by,
});

const data: TeamShiftReviewResponse = {
  shift: {
    userId: 1, username: "chatter", kind: "shift", startedAt: at("09:00"), endedAt: at("11:00"), ongoing: false, workedMinutes: 120,
    pauses: [], lastInputAt: at("10:59"), lastBeatAt: at("10:59"), pages: [{ pageLabel: "page-1", platform: "fansly", messages: 3, worked: true }], salesNetMills: 0,
  },
  previousAt: null,
  nextAt: null,
  activity: [],
  chats: [
    // The chatter wrote last, the fan waited, a colleague who was not on the page then answered: the chatter's wait.
    chat("a", [mine("10:00", null), message("10:05", "fan", null), message("10:20", "page", "other")]),
    // The chatter answered, then a colleague wrote, the fan wrote back and the colleague was still on the page at the end.
    chat("b", [message("10:09", "fan", null), mine("10:10", 60), message("10:30", "page", "other"), message("10:31", "fan", null)]),
    // Only a colleague wrote: a colleague's chat.
    chat("c", [message("10:45", "page", "other"), message("10:50", "fan", null), message("10:55", "page", "other")]),
    // A fan waiting from before the shift who did not write in it.
    chat("d", [message("08:00", "fan", null)]),
    // A fan waiting from before the shift who wrote in it, and got no answer.
    chat("e", [message("08:30", "fan", null), message("09:40", "fan", null)]),
  ],
  waits: [
    wait("d", "08:00", "11:00", null),
    wait("e", "08:30", "11:00", null),
    wait("a", "10:05", "10:20", "other"),
    wait("b", "10:09", "10:10", "me"),
    wait("b", "10:31", "11:00", null),
    wait("c", "10:50", "10:55", "other"),
  ],
  sales: [],
  unarchived: 0,
  deleted: 0,
  serverNow: at("12:00"),
};

describe("shift review: whose a wait is", () => {
  const waits = reviewWaits(data);
  const summaries = summariesOf(data, waits);
  const totals = totalsOf(data, myMessages(data), summaries, waits);
  const kindOf = (key: string) => summaries.find((summary) => summary.chat.key === key)?.kind;

  it("keeps a wait on the chatter's watch, even when a colleague answered it", () => {
    const a = waits.find((one) => one.chat === "a")!;
    expect(a.his).toBe(true);
    expect(summaries.find((summary) => summary.chat.key === "a")).toMatchObject({ kind: "dialog", longestWaitSeconds: 900, longestWaitAnsweredBy: "Sofia" });
  });

  it("leaves to a colleague the wait after their message while they still write on the page, and a chat only they wrote in", () => {
    expect(waits.filter((one) => one.chat === "b").map((one) => one.his)).toEqual([true, false]);
    expect(kindOf("b")).toBe("dialog");
    expect(kindOf("c")).toBe("colleague");
    expect(totals).toMatchObject({ handedOverUnanswered: 1, colleagueChats: 1, colleagueUnanswered: 0 });
  });

  it("counts a fan from before the shift who wrote in it as unanswered, and a silent one apart", () => {
    expect(kindOf("d")).toBe("waiting");
    expect(kindOf("e")).toBe("dialog");
    expect(totals).toMatchObject({ unanswered: 1, unansweredInherited: 1, waitingSilently: 1 });
  });

  it("picks a chat in the minutes its fan is on the queue, not a silent wait from before", () => {
    const from = Date.parse(at("10:00"));
    const to = Date.parse(at("10:10"));
    expect(chatBusyIn(data.chats[4]!, waits, from, to)).toBe(true);
    expect(chatBusyIn(data.chats[3]!, waits, from, to)).toBe(false);
  });
});

// A colleague who sat on the page as the shift began wrote a minute before its start: the first version saw only the
// colleague's messages within the shift, and gave the chatter the fans from the last shift the colleague answered.
describe("shift review: a colleague on the page at the shift's start", () => {
  const handover: TeamShiftReviewResponse = {
    ...data,
    chats: [
      chat("f", [message("08:30", "fan", null), message("08:59", "page", "other"), message("09:30", "page", "other")]),
      chat("g", [message("07:00", "fan", null), message("09:20", "page", "other")]),
    ],
    waits: [wait("g", "07:00", "09:20", "other")],
  };
  const waits = reviewWaits(handover);

  it("leaves to the colleague a wait from the last shift they answered", () => {
    expect(waits[0]!.his).toBe(false);
    expect(summariesOf(handover, waits).find((summary) => summary.chat.key === "g")?.kind).toBe("colleague");
  });
});

describe("shift review: a fan who came back", () => {
  it("is one who went quiet, not one who kept writing", () => {
    expect(cameBack(40 * 60, 30, 25 * 60)).toBe(true);
    expect(cameBack(40 * 60, 30, 4 * 60)).toBe(false);
  });
});

// The pulse drew the fans from past shifts the chatter answered at the start as the shift's own queue, and their waits,
// counted from the start, as slow replies: a peak of 40 and a median line over 10 minutes in the first half hour.
describe("shift review: the pulse keeps the tail of past shifts apart", () => {
  const tail: TeamShiftReviewResponse = {
    ...data,
    chats: [
      // Silent in the shift, answered in it: the tail.
      chat("t", [message("08:00", "fan", null), mine("09:05", 300)]),
      // Waiting from before the shift, wrote in it: on the shift's queue.
      chat("u", [message("08:30", "fan", null), message("09:02", "fan", null), mine("09:06", 360)]),
      // Began waiting in the shift.
      chat("v", [message("09:01", "fan", null), mine("09:03", 120)]),
    ],
    waits: [wait("t", "08:00", "09:05", "me"), wait("u", "08:30", "09:06", "me"), wait("v", "09:01", "09:03", "me")],
  };
  const pulse = pulseOf(tail, reviewWaits(tail));

  it("puts a silent fan from a past shift off the queue, and one who wrote in the shift on it", () => {
    expect(pulse[4]).toMatchObject({ waiting: 1, waitingTail: 1 });
  });

  it("keeps the replies to fans from past shifts off the median", () => {
    expect(pulse[7]).toMatchObject({ replies: 1, replyMedianSeconds: 120, tailReplies: 2 });
  });
});

type Sale = TeamShiftReviewResponse["sales"][number];
const sale = (chatKey: string | null, netMills: number, verdict: Sale["verdict"], holderName: string | null = null): Sale => ({
  saleRef: `${chatKey}-${netMills}`, at: at("10:00"), pageLabel: "page-1", fanRef: chatKey, fanName: null, chatKey, kind: "ppv", netMills, verdict, holderName,
  ppvSender: null, ppvSentAt: null, lastWriter: null, writers: [], origin: "own",
});

// The chat labels added up every sale of the fan in the shift: a colleague's PPVs in a chat the chatter never wrote in
// stood first under «Больше денег» (2026-11-07; #1058 had fixed the header only).
describe("shift review: whose a chat's money is", () => {
  const sales = [
    sale("a", 12_000, "mine"), sale("a", 4_000, "both", "Sofia"), sale("a", 2_000, "none"),
    sale("c", 303_200, "theirs", "Sofia"),
    sale("b", 9_000, "mine"),
    sale(null, 5_000, "mine"),
  ];
  const money: TeamShiftReviewResponse = {
    ...data,
    shift: { ...data.shift, salesNetMills: 30_000 },
    chats: data.chats.map((one) => ({ ...one, shiftNetMills: sales.filter((x) => x.chatKey === one.key).reduce((sum, x) => sum + x.netMills, 0) })),
    sales,
  };
  const summaries = summariesOf(money, reviewWaits(money));
  const of = (key: string) => summaries.find((summary) => summary.chat.key === key)!;

  it("counts in a chat the sales that count for the chatter, and the rest apart by whose", () => {
    expect(of("a")).toMatchObject({ heldNetMills: 16_000, others: [{ name: null, netMills: 2_000 }] });
    expect(of("c")).toMatchObject({ heldNetMills: 0, others: [{ name: "Sofia", netMills: 303_200 }] });
  });

  it("adds the chats' money and the fans without a chat up to the header", () => {
    const split = salesSplit(money);
    expect(split).toEqual({ netMills: 30_000, bothNetMills: 4_000, withoutChatNetMills: 5_000 });
    expect(summaries.reduce((sum, summary) => sum + summary.heldNetMills, 0) + split.withoutChatNetMills).toBe(money.shift.salesNetMills);
  });

  it("filters and orders by money by the chatter's share, not the colleague's", () => {
    expect(sortSummaries(summaries, "money").slice(0, 2).map((summary) => summary.chat.key)).toEqual(["a", "b"]);
    expect(showPasses(of("c"), "money")).toBe(false);
  });
});

// The header was one sum: a colleague's PPV, tips under a post and Campaign money inside it, unseen (2026-11-07).
describe("shift review: where the shift's sales came from", () => {
  const of = (netMills: number, origin: Sale["origin"], extra: Partial<Sale> = {}): Sale => ({ ...sale("a", netMills, "mine"), origin, ...extra });
  const sales = [
    of(10_000, "own"), of(52_000, "colleague_ppv", { ppvSender: "Nikita" }), of(31_200, "colleague_ppv", { ppvSender: "Miron", verdict: "both" }),
    of(8_000, "no_author_ppv"), of(4_000, "other_wrote", { lastWriter: "Sofia" }), of(40_000, "nobody_wrote_48h"),
    of(44_800, "post_tip"), of(148_000, "campaign"),
    of(303_200, "colleague_ppv", { ppvSender: "Nikita", verdict: "theirs", holderName: "Nikita" }),
  ];
  const money: TeamShiftReviewResponse = { ...data, sales, shift: { ...data.shift, salesNetMills: 338_000 } };

  it("splits the sales that count for the chatter by origin, and the parts add up to the header", () => {
    const parts = salesByOrigin(money);
    expect(parts).toEqual({
      own: 10_000, colleaguePpv: [{ name: "Nikita", netMills: 52_000 }, { name: "Miron", netMills: 31_200 }], noAuthorPpv: 8_000,
      otherWrote: [{ name: "Sofia", netMills: 4_000 }], nobodyWrote: 40_000, postTip: 44_800, campaign: 148_000,
    });
    const total = parts.own + parts.noAuthorPpv + parts.nobodyWrote + parts.postTip + parts.campaign
      + [...parts.colleaguePpv, ...parts.otherWrote].reduce((sum, one) => sum + one.netMills, 0);
    expect(total).toBe(salesSplit(money).netMills);
    expect(total).toBe(money.shift.salesNetMills);
  });
});
