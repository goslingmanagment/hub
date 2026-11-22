import { describe, expect, it } from "vitest";

import { personNameForms, type ShiftReportBoard, type ShiftReportOwner, type ShiftReportRow } from "@agency_hub_core/contracts";
import { DEMO_BOARD_SHIFTS, demoBoardReport } from "../packages/demo/fixtures/shift-report-board.ts";
import type { DemoRequest } from "../packages/demo/core.ts";
import {
  allRows, amountOf, moment, ownerMenu, pickOf, pillOf, reasonOf, tickChoice, whyFormOf,
} from "../apps/workboard/src/screens/report/model.ts";
import { cardWordsOf, checksOf, noticesOf, pressLineOf, stripsOf, sumLabelOf } from "../apps/workboard/src/screens/report/words.ts";

// The «Отчёт» board's menu «Чья продажа» is built from Hub's `choices` alone: which words are plain items, which go to
// the colleagues' matrix (named once, «пополам / отдать»), what each says short and in full, how each is written
// (Hub's `via`), and the «чья» pill's word. These pin the grouping and the branches the board reads a row by, the
// amount column's part of a sale, and that no text the board makes of the demo's scenarios says a name empty.

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
const word = (owner: ShiftReportOwner, hint = "", asks: Choice["asks"] = null, current = false, via: Choice["via"] = "line"): Choice => ({ owner, asks, hint, current, via });
const toldOleg: Choice["asks"] = { to: "colleague", user: person(OLEG), words: "сообщим Олегу" };
const timurOldWay: Choice["asks"] = { to: "decider", user: person(TIMUR), words: "Тимур сдаёт смену по-старому, решит владелец" };
const asked = { claimId: 9, to: "owner" as const, toUser: null, want: me, note: "мне за вечер", state: "asked" as const, answerNote: null, answerBy: null, decision: null };

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

  it("writes one's own sale's word on an old-way colleague as the line's word, with one line of why for the decider", () => {
    const menu = ownerMenu(board([own]), own);
    const timur = menu.colleagues[1]!;
    expect(timur.give?.choice.question).toBeNull();
    expect(timur.give?.choice.line).toEqual({ statement: "give", toUserId: 3 });
    expect(timur.give?.choice.needsWhy).toBe(true);
    expect(timur.give?.foot).toBe("Отдать Тимуру. Тимур сдаёт смену по-старому, решит владелец: продажа сразу уйдёт из отчёта.");
    expect(timur.share?.foot).toBe("Пополам с Тимуром. Тимур сдаёт смену по-старому, решит владелец: ваша половина в отчёте сразу.");
    expect(whyFormOf(board([own]), own, timur.give!.choice)).toMatchObject({ label: "Почему продажа Тимура?", send: "Записать", reasons: false });
    expect(menu.colleagues[0]!.share?.foot).toBe("Пополам с Олегом. Продажа сразу станет пополам, Олег увидит.");
    expect(menu.colleagues[0]!.share?.choice.needsWhy).toBe(false);
  });

  it("keeps someone else's sale short: the rule's colleague by name, «Моя», «Пополам с …», each a question (Hub's via)", () => {
    const until = "2026-11-19T19:30:00.000Z";
    const sale = row({
      ticked: false, amountMills: 0, owner: waiting, reasonWords: "PPV от Олега, уйдёт в следующую смену Олега",
      rule: { owner: waiting, reason: "ppv_sender_waiting", words: "PPV от Олега, уйдёт в следующую смену Олега", waitsUntil: until },
      choices: [word(waiting, "по правилу", null, true), word(me, toldOleg!.words, toldOleg, false, "ask"), word(half(OLEG), toldOleg!.words, toldOleg, false, "ask")],
    });
    const menu = ownerMenu(board([sale]), sale);
    expect(menu.colleagues).toEqual([]);
    expect(menu.items.map((item) => [item.label, item.short])).toEqual([["Олег", "по правилу"], ["Моя", "сообщим"], ["Пополам с Олегом", "сообщим"]]);
    expect(menu.items[1]!.choice.question).toEqual({ statement: "mine", shareWithUserId: null });
    expect(menu.items[2]!.choice.question).toEqual({ statement: "share", shareWithUserId: 2 });
    expect(menu.foot).toBe("PPV от Олега, поэтому продажа Олега. Смены у Олега сейчас нет: продажа уйдёт в следующую. "
      + `Если смены не будет до ${moment(until)}, продажа станет ничьей.`);
  });

  it("takes a nobody's sale by the line's word when Hub says so, never as a question", () => {
    const sale = row({
      ticked: false, amountMills: 0, owner: nobody, rule: { owner: nobody, reason: "no_writer", words: "ничья: фану никто не писал" },
      choices: [word(nobody, "по правилу", null, true), word(me)],
    });
    const menu = ownerMenu(board([sale]), sale);
    expect(menu.items.map((item) => [item.label, item.short])).toEqual([["Ничья", "по правилу"], ["Моя", "сразу"]]);
    expect(menu.items[1]!.choice.question).toBeNull();
    expect(menu.items[1]!.choice.line).toEqual({ statement: "mine" });
    expect(menu.items[1]!.choice.needsWhy).toBe(true);
    expect(menu.foot).toBe("По правилу ничья: фану никто не писал.");
  });

  it("says the decider's rule whose first", () => {
    const decide: ShiftReportOwner = { kind: "decide", userId: null, name: null, words: "решит владелец" };
    const sale = row({
      ticked: false, amountMills: 0, owner: decide, rule: { owner: decide, reason: "seam", words: "стык смен, фану никто из них не писал: решит владелец" },
      choices: [word(decide, "по правилу", null, true)],
    });
    expect(ownerMenu(board([sale]), sale).foot).toBe("По правилу решит владелец: стык смен, фану никто из них не писал.");
  });

  it("keeps Hub's word checked while a question waits, marks the word asked for, and a second press of it asks nothing", () => {
    const sale = row({
      ticked: false, amountMills: 0, owner: pot, rule: { owner: pot, reason: "post_tip", words: "общак: чаевые под постом" }, ask: asked,
      choices: [word(pot, "по правилу", null, true), word(me, "решит владелец", { to: "decider", user: null, words: "решит владелец" }, false, "ask")],
    });
    const menu = ownerMenu(board([sale]), sale);
    expect(menu.currentKey).toBe("pot");
    expect(menu.askedKey).toBe("me");
    expect(menu.items.map((item) => item.short)).toEqual(["по правилу", "ждём ответа"]);
    expect(menu.foot).toBe("Вопрос задан. Выберите прежний вариант, чтобы отменить его.");
    expect(pickOf(sale, menu.items[1]!.choice)).toBe("none");
    expect(pickOf(sale, menu.items[0]!.choice)).toBe("unask");
  });

  it("checks Hub's word after one's own sale went to an old-way colleague: the rule's word takes it back by the line", () => {
    const sale = row({
      ticked: false, amountMills: 0, owner: theirs(TIMUR), statement: "not_mine", reasonWords: "Тимур сдаёт смену по-старому, решит владелец",
      ask: { ...asked, to: "colleague", toUser: person(TIMUR), note: "", oldWay: true },
      choices: [word(me, "по правилу"), word(half(TIMUR), timurOldWay!.words, timurOldWay), word(theirs(TIMUR), timurOldWay!.words, timurOldWay, true), word(nobody)],
    });
    const menu = ownerMenu(board([sale]), sale);
    expect(menu.currentKey).toBe("user:3");
    expect(menu.askedKey).toBeNull();
    const give = menu.colleagues[0]!.give!.choice;
    expect(pickOf(sale, give)).toBe("none");
    expect(pickOf(sale, menu.items[0]!.choice)).toBe("word");
    expect(pillOf(board([sale]), sale)?.text).toBe("ждём владельца");
    expect(stripsOf(board([sale]), sale, { own: true, editing: true }).map((one) => one.text).join(" ")).not.toContain("Вы спросили");
  });
});

describe("tickChoice", () => {
  it("unticks one's own sale to nobody, and ticks someone else's as «Моя» (a question)", () => {
    const own = row({ choices: [word(me, "по правилу", null, true), word(pot, "решит владелец"), word(nobody)] });
    expect(tickChoice(own)?.key).toBe("nobody");
    const colleague = row({
      ticked: false, amountMills: 0, owner: theirs(OLEG), rule: { owner: theirs(OLEG), reason: "slot_owner", words: "идёт слот Олега" },
      choices: [word(theirs(OLEG), "по правилу", null, true), word(me, toldOleg!.words, toldOleg, false, "ask")],
    });
    expect(tickChoice(colleague)?.question).toEqual({ statement: "mine", shareWithUserId: null });
  });

  it("gives a taken nobody's sale back to the rule's own word", () => {
    const taken = row({
      owner: me, statement: "mine", rule: { owner: nobody, reason: "no_writer", words: "ничья: фану никто не писал" },
      choices: [word(nobody, "по правилу"), word(me, "", null, true)],
    });
    expect(tickChoice(taken)).toMatchObject({ key: "nobody", line: { statement: null } });
  });
});

describe("amountOf", () => {
  it("shows the owner's split of one's own sale as the part «из» the sale", () => {
    expect(amountOf(row({ amountMills: 16_000, netMills: 48_000 }))).toEqual({ main: "+$16", sub: "из +$48", title: null });
  });

  it("keeps what the fan paid on OnlyFans in the title of a half", () => {
    const one = amountOf(row({ platform: "onlyfans", amountMills: 24_000, netMills: 48_000, grossMills: 60_000 }));
    expect(one.main).toBe("+$24");
    expect(one.sub).toBe("из +$48");
    expect(one.title).toBe("Фан заплатил $60.00, после комиссии $48.00");
  });

  it("shows a whole sale with the fan's payment under it", () => {
    expect(amountOf(row({ platform: "onlyfans", grossMills: 60_000 }))).toMatchObject({ main: "+$48", sub: "из $60.00" });
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

  it("says «чужая» of a colleague's and a waiting sale, «отдана …» of one's own given away", () => {
    expect(pill({ ticked: false, owner: theirs(OLEG), rule: { owner: theirs(OLEG), reason: "", words: "" } })?.text).toBe("чужая");
    expect(pill({ ticked: false, owner: waiting, rule: { owner: waiting, reason: "", words: "" } })?.text).toBe("чужая");
    expect(pill({ ticked: false, owner: theirs(OLEG), statement: "give" })).toEqual({ text: "отдана Олегу", tone: "plain", hidden: false });
  });

  it("says what waits in amber", () => {
    expect(pill({ ticked: false, sighting: { id: 1, seenAt: "2026-11-12T19:30:00.000Z", added: false } })).toEqual({ text: "нет в Hub", tone: "wait", hidden: false });
    expect(pill({ ticked: false, owner: pot, ask: { ...asked, note: "" } })).toEqual({ text: "ждём владельца", tone: "wait", hidden: false });
  });
});

describe("the board's words on the demo's scenarios", () => {
  const request = (role: DemoRequest["role"]): DemoRequest => ({
    params: {}, query: {}, body: null, now: new Date("2026-11-13T00:30:00.000Z"), role, cookie: () => `words-${role}`,
  });
  const bad = (text: string) => /—|\s,|\s\.|\(\s*\)|«\s*»|undefined|null|NaN|\s{2}/u.test(text) || text !== text.trim();

  for (const role of ["chatter", "owner"] as const) {
    it(`says every name and never a long dash, as ${role}`, () => {
      const found: string[] = [];
      for (const [scenario, shiftId] of Object.entries(DEMO_BOARD_SHIFTS)) {
        const report = demoBoardReport(request(role), shiftId);
        const view = report?.board;
        if (!report || !view) continue;
        const own = role === "chatter";
        const texts: string[] = [
          sumLabelOf(view, own),
          pressLineOf(view, report, { own, preview: !report.enabled, host: "tab" }),
          ...[...checksOf(view, own), ...noticesOf(view, report, own)].flatMap((one) => [one.text, one.small ?? "", one.link ?? ""]),
        ];
        for (const one of allRows(view)) {
          texts.push(pillOf(view, one)?.text ?? "", reasonOf(view, one)?.text ?? "", amountOf(one).main, amountOf(one).sub ?? "");
          for (const strip of stripsOf(view, one, { own, editing: view.phase === "draft" || view.phase === "fixing" })) texts.push(strip.lead ?? "", strip.text);
          if (one.proposal !== null) {
            const card = cardWordsOf(view, one, one.proposal);
            if (card !== null) texts.push(card.head, card.why ?? "", card.note);
          }
          const menu = ownerMenu(view, one);
          texts.push(menu.subject, menu.foot, ...menu.items.flatMap((item) => [item.label, item.short, item.foot]));
          texts.push(...menu.colleagues.flatMap((colleague) => [colleague.name, colleague.note, colleague.share?.foot ?? "", colleague.give?.foot ?? ""]));
        }
        found.push(...texts.filter((text) => text !== "" && bad(text)).map((text) => `${scenario}: ${text}`));
      }
      expect(found).toEqual([]);
    });
  }
});
