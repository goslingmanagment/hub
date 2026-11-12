import { describe, expect, it } from "vitest";

import { parsePeopleMessageChats, parsePeopleMessageKinds, peopleMessageKindsOf, withPeopleMessageKind } from "@agency_hub_core/shared";

import {
  assertSendable,
  decideMessage,
  inQuietHours,
  moscowDayOf,
  withoutJoinSecret,
  type MessageCandidate,
  type MessageLocks,
} from "../apps/runtime/src/services/people-messages/rules.ts";

// Сообщения людям (package S): a message to a living person leaves only with
// both locks open — the bot token and the kind turned on, for an event after it
// was turned on — and a recipient Telegram can reach. Every other case is held.

const ON_AT = new Date("2026-11-13T07:00:00.000Z");
const AFTER = new Date("2026-11-13T08:00:00.000Z");
const BEFORE = new Date("2026-11-13T06:00:00.000Z");

const toPerson = (telegramUserId: number | null): MessageCandidate["recipient"] => ({ kind: "person", userId: 5, telegramUserId, name: "Катя" });
const toChat = (chatId: string | null): MessageCandidate["recipient"] => ({ kind: "chat", chat: chatId === null ? null : { chatId, topicId: 4 }, words: "Mia · Отчётность" });

function candidate(recipient: MessageCandidate["recipient"], eventAt: Date = AFTER): MessageCandidate {
  return { kind: "custom.shot.give", key: "custom.shot.give:custom.shot_not_given:K-1", recipient, objectType: "matter", objectId: "m", about: "заказ K-1", text: "Кастом K-1 снят", eventAt };
}

const locks = (tokenSet: boolean, on: boolean): MessageLocks => ({ tokenSet, kindsOn: on ? { "custom.shot.give": ON_AT } : {} });
const free = { used: 0, max: 3 };

describe("people messages: may a message leave", () => {
  it("sends only with the token, the kind on, a reachable recipient and an event after the switch", () => {
    expect(decideMessage(candidate(toPerson(1001)), locks(true, true), free)).toEqual({ send: true, chatId: "1001", topicId: null });
    expect(decideMessage(candidate(toChat("-1009")), locks(true, true), free)).toEqual({ send: true, chatId: "-1009", topicId: 4 });
  });

  it("never sends without the bot token, whatever else holds", () => {
    for (const recipient of [toPerson(1001), toChat("-1009")]) {
      for (const on of [true, false]) {
        expect(decideMessage(candidate(recipient), locks(false, on), free).send).toBe(false);
      }
    }
    expect(decideMessage(candidate(toPerson(1001)), locks(false, true), free)).toEqual({ send: false, reason: "no_token" });
  });

  it("never sends with the kind off, the token set or not", () => {
    for (const tokenSet of [true, false]) {
      expect(decideMessage(candidate(toPerson(1001)), locks(tokenSet, false), free)).toEqual({ send: false, reason: "kind_off" });
    }
    // Another kind on does not open this one.
    expect(decideMessage(candidate(toPerson(1001)), { tokenSet: true, kindsOn: { "shift.report.copy": ON_AT } }, free)).toEqual({ send: false, reason: "kind_off" });
  });

  it("never sends to a person without a Telegram id, nor to a model without its chat", () => {
    expect(decideMessage(candidate(toPerson(null)), locks(true, true), free)).toEqual({ send: false, reason: "no_telegram" });
    expect(decideMessage(candidate(toChat(null)), locks(true, true), free)).toEqual({ send: false, reason: "no_chat" });
  });

  it("an event before the kind was turned on stays held: only new events send", () => {
    expect(decideMessage(candidate(toPerson(1001), BEFORE), locks(true, true), free)).toEqual({ send: false, reason: "before_on" });
  });

  it("holds what is over the day's cap of the recipient", () => {
    expect(decideMessage(candidate(toPerson(1001)), locks(true, true), { used: 2, max: 3 }).send).toBe(true);
    expect(decideMessage(candidate(toPerson(1001)), locks(true, true), { used: 3, max: 3 })).toEqual({ send: false, reason: "cap" });
  });

  it("the last guard before the transport refuses an open lock", () => {
    expect(() => assertSendable(candidate(toPerson(1001)), locks(false, true), null, "1001")).toThrow(/no bot token/u);
    expect(() => assertSendable(candidate(toPerson(1001)), locks(true, true), "", "1001")).toThrow(/no bot token/u);
    expect(() => assertSendable(candidate(toPerson(1001)), locks(true, false), "stub", "1001")).toThrow(/not on/u);
    expect(() => assertSendable(candidate(toPerson(1001), BEFORE), locks(true, true), "stub", "1001")).toThrow(/not on/u);
    expect(() => assertSendable(candidate(toPerson(1001)), locks(true, true), "stub", null)).toThrow(/no recipient/u);
    expect(() => assertSendable(candidate(toPerson(1001)), locks(true, true), "stub", "1001")).not.toThrow();
  });
});

describe("people messages: the night and the day", () => {
  it("23:00 to 10:00 Moscow time is the people's night", () => {
    expect(inQuietHours(new Date("2026-11-13T19:59:00.000Z"))).toBe(false); // 22:59
    expect(inQuietHours(new Date("2026-11-13T20:00:00.000Z"))).toBe(true); // 23:00
    expect(inQuietHours(new Date("2026-11-14T06:59:00.000Z"))).toBe(true); // 09:59
    expect(inQuietHours(new Date("2026-11-14T07:00:00.000Z"))).toBe(false); // 10:00
  });

  it("the cap's day is the Moscow day", () => {
    const day = moscowDayOf(new Date("2026-11-13T22:30:00.000Z")); // 01:30 on the 14th in Moscow
    expect(day.from.toISOString()).toBe("2026-11-13T21:00:00.000Z");
    expect(day.to.toISOString()).toBe("2026-11-14T21:00:00.000Z");
  });

  it("an invitation's one-time link is not kept", () => {
    const text = "Привет, Аня! Твой аккаунт ChatGoose готов.\nСсылка: https://chatgoose.example/join#abc_DEF-123\nЛогин: anya";
    expect(withoutJoinSecret(text)).not.toContain("abc_DEF-123");
    expect(withoutJoinSecret(text)).toContain("/join#‹ссылка не хранится›");
  });
});

describe("people messages: the owner's settings", () => {
  it("turns one kind on at a moment and off, the others as they were", () => {
    const one = withPeopleMessageKind("{}", "shift.report.copy", true, ON_AT);
    const two = withPeopleMessageKind(one, "payout.text", true, AFTER);
    expect(peopleMessageKindsOf(two)).toEqual({ "shift.report.copy": ON_AT, "payout.text": AFTER });
    // Turned on again: it keeps the moment it was first turned on.
    expect(peopleMessageKindsOf(withPeopleMessageKind(two, "shift.report.copy", true, AFTER))["shift.report.copy"]).toEqual(ON_AT);
    expect(peopleMessageKindsOf(withPeopleMessageKind(two, "shift.report.copy", false, AFTER))).toEqual({ "payout.text": AFTER });
  });

  it("refuses an unknown kind, a missing moment and a chat that is not a Telegram id", () => {
    expect(parsePeopleMessageKinds(`{"everything": "2026-11-13T07:00:00.000Z"}`).ok).toBe(false);
    expect(parsePeopleMessageKinds(`{"payout.text": true}`).ok).toBe(false);
    expect(parsePeopleMessageKinds("[]").ok).toBe(false);
    expect(parsePeopleMessageChats(`{"mia": {"reports": {"chatId": "-1001", "topicId": 4}}}`)).toEqual({ ok: true, value: { mia: { reports: { chatId: "-1001", topicId: 4 } } } });
    expect(parsePeopleMessageChats(`{"mia": {"reports": {"chatId": "@group"}}}`).ok).toBe(false);
    expect(parsePeopleMessageChats(`{"mia": {"everyone": {"chatId": "-1001"}}}`).ok).toBe(false);
  });
});
