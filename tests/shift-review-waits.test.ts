import { describe, expect, it } from "vitest";

import type { ShiftReviewSendRow } from "@agency_hub_core/db";
import { pendingSendsByChat, waitsOf, type ChatMessage } from "../apps/runtime/src/services/shift-review.ts";

// The waits of «Разбор смены» (services/shift-review.ts). The cases are the audit's of 2026-11-07: a fan's old unanswered
// message took their fresh ones out of «Без ответа» with it; a send Fansly never gave the archive left its fan waiting; a fan
// who later deleted their messages took their waits away with them, and a send recalled in seconds answered the fan.

const HOUR = 3_600_000;
const START = Date.parse("2026-11-04T19:00:00Z");
const END = START + 8 * HOUR;
const USER = 7;

function message(at: number, side: "fan" | "page", extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    pageId: 1, platform: "fansly", conv: "100", ref: String(at), at: new Date(at), sent: side === "page", text: "", priceMills: null, tipMills: null,
    media: 0, fanNativeId: null, mass: false, authorId: side === "page" ? USER : null, authorName: null, bought: null, unarchived: false,
    deletedAt: null, by: side === "page" ? "me" : null, personal: side === "page", pending: false, ...extra,
  };
}

describe("waitsOf", () => {
  it("starts a wait at the fan's first message within the horizon: an old unanswered one does not take the fresh ones with it", () => {
    const old = START - 80 * HOUR;
    const fresh = START + 3 * HOUR;
    const waits = waitsOf([message(old, "fan"), message(fresh, "fan"), message(fresh + 600_000, "fan")], USER, START, END);
    expect(waits).toEqual([{ since: fresh, to: END, by: null, answerRef: null, pending: false }]);
    // Answered: from the first message within the horizon before the answer.
    const answered = waitsOf([message(old, "fan"), message(fresh, "fan"), message(fresh + HOUR, "page")], USER, START, END);
    expect(answered).toEqual([{ since: fresh, to: fresh + HOUR, by: "me", answerRef: String(fresh + HOUR), pending: false }]);
  });

  it("has no wait when every message of the fan is older than the horizon", () => {
    expect(waitsOf([message(START - 80 * HOUR, "fan"), message(START - 75 * HOUR, "fan")], USER, START, END)).toEqual([]);
  });

  it("keeps a wait still open at the end from a message within the horizon before the shift's start", () => {
    const since = START - 70 * HOUR;
    expect(waitsOf([message(since, "fan")], USER, START, END)).toEqual([{ since, to: END, by: null, answerRef: null, pending: false }]);
  });

  it("ends a wait at the chatter's send Fansly never gave the archive, the socket's copy or a send only reported", () => {
    const fan = START + HOUR;
    const socket = message(fan + 277_000, "page", { unarchived: true });
    expect(waitsOf([message(fan, "fan"), socket], USER, START, END)).toEqual([{ since: fan, to: fan + 277_000, by: "me", answerRef: socket.ref, pending: false }]);
    const reported = message(fan + 21_000, "page", { pending: true });
    expect(waitsOf([message(fan, "fan"), reported], USER, START, END)).toEqual([{ since: fan, to: fan + 21_000, by: "me", answerRef: null, pending: true }]);
  });
});

describe("waitsOf with deleted messages", () => {
  const deletedAfter = (at: number, seconds: number) => ({ deletedAt: new Date(at + seconds * 1000) });

  it("keeps the wait of a fan who deleted the message a minute or more after it, not of one who deleted it in seconds", () => {
    const fan = START + HOUR;
    const answer = message(fan + 32 * 60_000, "page");
    // Deleted the next day: the chatter saw it, the fan waited 32 minutes.
    expect(waitsOf([message(fan, "fan", deletedAfter(fan, 86_400)), answer], USER, START, END))
      .toEqual([{ since: fan, to: answer.at.getTime(), by: "me", answerRef: answer.ref, pending: false }]);
    // Deleted after a minute exactly: still seen.
    expect(waitsOf([message(fan, "fan", deletedAfter(fan, 60)), answer], USER, START, END)).toHaveLength(1);
    // Deleted after 40 s, before anyone could read it: no wait, and the next message waits from its own time.
    const later = fan + 10 * 60_000;
    expect(waitsOf([message(fan, "fan", deletedAfter(fan, 40)), message(later, "fan"), answer], USER, START, END))
      .toEqual([{ since: later, to: answer.at.getTime(), by: "me", answerRef: answer.ref, pending: false }]);
    expect(waitsOf([message(fan, "fan", deletedAfter(fan, 40))], USER, START, END)).toEqual([]);
  });

  it("takes no answer from the chatter's send deleted 6 s after it: the fan waits on to the next one", () => {
    const fan = START + HOUR;
    const recalled = message(fan + 60_000, "page", deletedAfter(fan + 60_000, 6));
    const next = message(fan + 90_000, "page");
    expect(waitsOf([message(fan, "fan"), recalled, next], USER, START, END))
      .toEqual([{ since: fan, to: next.at.getTime(), by: "me", answerRef: next.ref, pending: false }]);
    // A send deleted minutes later the fan saw: it answered.
    const seen = message(fan + 60_000, "page", deletedAfter(fan + 60_000, 385));
    expect(waitsOf([message(fan, "fan"), seen], USER, START, END))
      .toEqual([{ since: fan, to: seen.at.getTime(), by: "me", answerRef: seen.ref, pending: false }]);
  });
});

describe("pendingSendsByChat", () => {
  const send = (extra: Partial<ShiftReviewSendRow>): ShiftReviewSendRow => ({
    pageId: 1, platform: "fansly", ref: "900", conversationRef: "100", fanRef: "555", composedWith: "hand", edited: null,
    observedAt: new Date(START + HOUR), inArchive: false, inSocket: false, deleted: false, ...extra,
  });

  it("answers in the reported chat only a send neither the archive nor the socket holds; on OnlyFans the chat is the fan", () => {
    const byChat = pendingSendsByChat([
      send({ ref: "901" }),
      send({ ref: "902", inArchive: true }),
      send({ ref: "903", inSocket: true }),
      send({ ref: "904", platform: "onlyfans", conversationRef: null, fanRef: "777" }),
    ], USER, "chatter");
    expect([...byChat.keys()]).toEqual(["1:100", "1:777"]);
    expect(byChat.get("1:100")!.map((one) => [one.ref, one.pending, one.by])).toEqual([["901", true, "me"]]);
  });
});
