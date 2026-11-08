import { describe, expect, it } from "vitest";
import type { ShiftReviewChat, ShiftReviewMessage, TeamShiftReviewResponse } from "@agency_hub_core/contracts";
import { cameBack, chatBusyIn, myMessages, pulseOf, reviewWaits, summariesOf, totalsOf } from "@/pages/team/review/shiftReviewView";

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
    pauses: [], pages: [{ pageLabel: "page-1", platform: "fansly", messages: 3, worked: true }], salesNetMills: 0,
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
