import { describe, expect, it } from "vitest";

import { personNameForms, type ShiftReportBoard, type ShiftReportOwner, type ShiftReportRow } from "@agency_hub_core/contracts";
import { ownerMenu, pillOf, tickChoice } from "../apps/workboard/src/screens/report/model.ts";

// The «Отчёт» board's menu «Чья продажа» is built from Hub's `choices` alone: which words are plain items, which go to
// the colleagues' matrix (named once, «пополам / отдать»), what each says short and in full, and the «чья» pill's word.
// These pin the grouping and the branches the board reads a row by.

const OLEG = { userId: 2, name: "Олег" };
const TIMUR = { userId: 3, name: "Тимур" };
const person = (one: { userId: number; name: string }) => ({ ...one, forms: personNameForms(one.name) });

const me: ShiftReportOwner = { kind: "me", userId: 1, name: "Лев", words: "моя" };
const pot: ShiftReportOwner = { kind: "pot", userId: null, name: null, words: "общак" };
const nobody: ShiftReportOwner = { kind: "nobody", userId: null, name: null, words: "ничья" };
const half = (one: { userId: number; name: string }): ShiftReportOwner => ({ kind: "share", userId: one.userId, name: one.name, words: `пополам с ${personNameForms(one.name).ins}` });
const theirs = (one: { userId: number; name: string }): ShiftReportOwner => ({ kind: "user", userId: one.userId, name: one.name, words: personNameForms(one.name).gen });
const waiting: ShiftReportOwner = { kind: "waiting", userId: OLEG.userId, name: OLEG.name, words: "Олега" };

type Choice = NonNullable<ShiftReportRow["choices"]>[number];
const word = (owner: ShiftReportOwner, hint = "", asks: Choice["asks"] = null, current = false): Choice => ({ owner, asks, hint, current });
const toldOleg: Choice["asks"] = { to: "colleague", user: person(OLEG), words: "сообщим Олегу" };
const timurOldWay: Choice["asks"] = { to: "decider", user: person(TIMUR), words: "Тимур сдаёт смену по-старому, решит владелец" };

function row(over: Partial<ShiftReportRow>): ShiftReportRow {
  return {
    key: "t1", transactionId: 1, pageLabel: "Mia-2", platform: "fansly", platformRef: "981337562090745305", refLabel: "#…5305", kind: "message_purchase",
    siteWords: "Media Sale to", fan: { fanRef: "viggo", name: "Viggo", username: "viggo" }, occurredAt: "2026-11-12T19:30:00.000Z",
    netMills: 48_000, grossMills: null, rule: { owner: me, reason: "ppv_sender", words: "ваш PPV" }, owner: me, statement: null, reasonWords: "",
    ticked: true, amountMills: 48_000, before: null, late: false, ask: null, incoming: null, proposal: null, note: null, sighting: null,
    editable: true, canNote: true, attention: false,
    ...over,
  };
}

const board = (rows: ShiftReportRow[]): ShiftReportBoard => ({
  phase: "draft", chip: "Черновик", offShift: [],
  columns: [{ pageLabel: "Mia-2", platform: "fansly", pageHandle: null, modelName: "Mia", rows, before: { count: 0, until: "2026-11-12T15:00:00.000Z", people: [], rows: [] }, marked: 0, of: rows.length, sumMills: 0, attention: false }],
  candidate: null, totals: { count: 0, nowMills: 0, wasMills: null }, waiting: [], colleagues: [person(OLEG), person(TIMUR)],
  decider: { kind: "owner", user: null, words: "владелец" }, canConfirm: false, needsMe: false, handedInAt: null, countedAt: null,
});

describe("ownerMenu", () => {
  const own = row({
    choices: [
      word(me, "по правилу", null, true),
      word(half(OLEG)), word(half(TIMUR), timurOldWay!.words, timurOldWay),
      word(theirs(OLEG)), word(theirs(TIMUR), timurOldWay!.words, timurOldWay),
      word(pot, "решит владелец"), word(nobody),
    ],
  });

  it("puts one's own sale's words on colleagues into a matrix, each colleague named once", () => {
    const menu = ownerMenu(board([own]), own);
    expect(menu.items.map((item) => [item.label, item.short])).toEqual([["Моя", "по правилу"], ["Общак", "решит владелец"], ["Ничья", "уйдёт из отчёта"]]);
    expect(menu.colleagues.map((one) => [one.name, one.note, one.share?.choice.key, one.give?.choice.key]))
      .toEqual([["Олег", "", "share:2", "user:2"], ["Тимур", "решит владелец", "share:3", "user:3"]]);
    expect(menu.currentKey).toBe("me");
    expect(menu.foot).toBe("По правилу продажа ваша: ваш PPV.");
  });

  it("spells a matrix word out in full, and sends one's own sale as a mark, never a question", () => {
    const menu = ownerMenu(board([own]), own);
    const timur = menu.colleagues[1]!;
    expect(timur.give?.foot).toBe("Отдать Тимуру. Тимур сдаёт смену по-старому, решит владелец. До ответа продажа ждёт отдельно.");
    expect(timur.give?.choice.question).toBeNull();
    expect(timur.give?.choice.line).toEqual({ statement: "give", toUserId: 3 });
    expect(menu.colleagues[0]!.share?.foot).toBe("Пополам с Олегом. Продажа сразу станет пополам, Олег увидит.");
  });

  it("keeps someone else's sale short: the rule's colleague by name, «Моя», «Пополам с …», each telling him", () => {
    const sale = row({
      ticked: false, amountMills: 0, owner: waiting, reasonWords: "PPV отправил Олег, уйдёт в его следующую смену",
      rule: { owner: waiting, reason: "ppv_sender_waiting", words: "PPV отправил Олег, уйдёт в его следующую смену", waitsUntil: "2026-11-19T19:30:00.000Z" },
      choices: [word(waiting, "по правилу", null, true), word(me, toldOleg!.words, toldOleg), word(half(OLEG), toldOleg!.words, toldOleg)],
    });
    const menu = ownerMenu(board([sale]), sale);
    expect(menu.colleagues).toEqual([]);
    expect(menu.items.map((item) => [item.label, item.short])).toEqual([["Олег", "по правилу"], ["Моя", "сообщим"], ["Пополам с Олегом", "сообщим"]]);
    expect(menu.items[1]!.choice.question).toEqual({ statement: "mine", shareWithUserId: null });
    expect(menu.items[2]!.choice.question).toEqual({ statement: "share", shareWithUserId: 2 });
    expect(menu.foot).toBe("Олег отправил этот PPV, поэтому продажа его. Сейчас он не на смене: продажа уйдёт в его следующую смену. "
      + "Если смены не будет до 19 нояб., продажа станет ничьей.");
  });

  it("marks the word asked for while the question waits, and says how to take it back", () => {
    const sale = row({
      ticked: false, amountMills: 0, owner: pot, rule: { owner: pot, reason: "post_tip", words: "общак: чаевые под постом" },
      ask: { claimId: 9, to: "owner", toUser: null, want: me, note: "мне за вечер", state: "asked", answerNote: null, answerBy: null, decision: null },
      choices: [word(pot, "по правилу", null, true), word(me, "решит владелец", { to: "decider", user: null, words: "решит владелец" })],
    });
    const menu = ownerMenu(board([sale]), sale);
    expect(menu.currentKey).toBe("me");
    expect(menu.items.map((item) => item.short)).toEqual(["по правилу", "ждём ответа"]);
    expect(menu.foot).toBe("Вопрос задан. Выберите прежний вариант, чтобы отменить его.");
  });
});

describe("tickChoice", () => {
  it("unticks one's own sale to nobody, and ticks someone else's as «Моя» (a question)", () => {
    const own = row({ choices: [word(me, "по правилу", null, true), word(pot, "решит владелец"), word(nobody)] });
    expect(tickChoice(own)?.key).toBe("nobody");
    const colleague = row({
      ticked: false, amountMills: 0, owner: theirs(OLEG), rule: { owner: theirs(OLEG), reason: "slot_owner", words: "идёт слот Олега" },
      choices: [word(theirs(OLEG), "по правилу", null, true), word(me, toldOleg!.words, toldOleg)],
    });
    expect(tickChoice(colleague)?.question).toEqual({ statement: "mine", shareWithUserId: null });
  });
});

describe("pillOf", () => {
  const pill = (over: Partial<ShiftReportRow>) => {
    const one = row(over);
    return pillOf(board([one]), one);
  };

  it("hides «моя» on one's own ticked sale by the rule, and shows it on hover only", () => {
    expect(pill({})).toEqual({ text: "моя", tone: "tint", hidden: true });
  });

  it("says «чужая» of a colleague's and a waiting sale, «отдал …» of one's own given away", () => {
    expect(pill({ ticked: false, owner: theirs(OLEG), rule: { owner: theirs(OLEG), reason: "", words: "" } })?.text).toBe("чужая");
    expect(pill({ ticked: false, owner: waiting, rule: { owner: waiting, reason: "", words: "" } })?.text).toBe("чужая");
    expect(pill({ ticked: false, owner: theirs(OLEG), statement: "give" })).toEqual({ text: "отдал Олегу", tone: "plain", hidden: false });
  });

  it("says what waits in amber", () => {
    expect(pill({ ticked: false, sighting: { id: 1, seenAt: "2026-11-12T19:30:00.000Z", added: false } })).toEqual({ text: "нет в Hub", tone: "wait", hidden: false });
    expect(pill({
      ticked: false, owner: pot, ask: { claimId: 9, to: "owner", toUser: null, want: me, note: "", state: "asked", answerNote: null, answerBy: null, decision: null },
    })).toEqual({ text: "ждём владельца", tone: "wait", hidden: false });
  });
});
