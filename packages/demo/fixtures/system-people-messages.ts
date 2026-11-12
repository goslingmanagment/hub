import {
  PEOPLE_MESSAGE_KIND_SPECS,
  peopleMessageCannotLine,
  peopleMessageCapWords,
  peopleMessagePressLabel,
  peopleMessagePressWords,
  peopleMessageQuietWords,
  type KernelOperationResponse,
  type PeopleMessageKindView,
  type PeopleMessageRow,
} from "@agency_hub_core/contracts";
import { nameToWhom } from "@agency_hub_core/look/words";
import type { PeopleMessageKind } from "@agency_hub_core/shared";

import { demoError, hoursAgo, iso, queryString, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DEMO_USERS } from "../world.ts";

/**
 * Система → «Сообщения людям» in the demo: the server's sender as merged — no
 * bot token, every kind off — with a week of messages it held, word for word,
 * on the invented agency. Chats: Mia Hart has both, Nova Lane only
 * «Отчётность», Ivy Rose none. A switch pressed in the demo turns the kind on
 * for this demo server's run (nothing is sent anywhere: there is no server).
 *
 * The cookie `hub-demo-people-messages` plays the owner's «да» (demo only): `on` — the bot token «set» and the payout
 * text and the invitation on, so Workboard shows «Отправить … в Telegram»; a press then says it was sent. `held` and
 * `failed` — the same, and a press says it was held (the day's cap) or refused by Telegram.
 */

type Answer = KernelOperationResponse<"peopleMessages">;

const MODELS = [
  { modelSlug: "mia-hart", modelName: "Mia Hart", reports: true, customs: true },
  { modelSlug: "nova-lane", modelName: "Nova Lane", reports: true, customs: false },
  { modelSlug: "ivy-rose", modelName: "Ivy Rose", reports: false, customs: false },
];

const POST = [
  "🗓 Дата: 11.11.2026",
  "👤 Чаттер: #Алекс",
  "",
  "📌 Аккаунты:",
  "Fansly",
  "• mia-1 - $83,20",
  "• mia-2 - $200,00",
  "",
  "💰Общий доход: $283,20",
  "",
  "📈 Основные продажи:",
  "https://fansly.com/sunnyriver/posts - tip $160,00. Сессия проведена",
  "https://fansly.com/quietfox/posts - ppv x2 $83,20",
  "https://fansly.com/northwind/posts - sub $40,00",
  "",
  "📝 Комментарий:",
  "Без оплаты, на следующую смену: quietfox обещал открыть ppv позже",
].join("\n");

const CARD = [
  "📦 Описание заказа K-14",
  "Дата: 11.11.2026",
  "Покупатель: https://fansly.com/sunnyriver/posts",
  "Имя: Рик",
  "Оплата: $250 уже оплачено",
  "Длительность: 6 минут",
  "",
  "🎥 Описание задания:",
  "1. Приветствие с именем в начале",
  "2. Танец в красном платье",
  "",
  "👗 Одежда:",
  "Красное платье, каблуки",
  "",
  "🗒 Заметки:",
  "-",
  "",
  "🔥Срочность: обычная",
  "⏳Сроки: До 15.11.2026",
].join("\n");

const CARD_IVY = CARD.replace("K-14", "K-17").replace("sunnyriver", "lakeshore").replace("Имя: Рик", "Имя: Том");

const MISSING_TEXT = (when: string, shiftId: number) => `Смена ${when} не сдана. Сдайте её, пожалуйста: https://chatgoose.example/workboard/my/shifts/${shiftId}`;
const SHOT_TEXT = "Кастом K-11 снят, отдайте его фану: https://chatgoose.example/workboard/customs/K-11";

interface HeldSeed {
  id: number;
  hours: number;
  to: string;
  about: string;
  text: string;
  reason: NonNullable<PeopleMessageRow["reason"]>;
}

const REASON_WORDS: Readonly<Record<NonNullable<PeopleMessageRow["reason"]>, string>> = {
  kind_off: "Задержано: вид выключен",
  no_token: "Задержано: нет токена бота",
  no_telegram: "Задержано: у человека нет Telegram id в реестре",
  no_chat: "Задержано: для модели не задан чат",
  cap: "Задержано: больше дневного предела этому получателю",
  before_on: "Задержано: событие было до включения вида",
};

const HELD: Readonly<Partial<Record<PeopleMessageKind, readonly HeldSeed[]>>> = {
  "shift.report.copy": [
    { id: 41, hours: 3, to: "Mia Hart · Отчётность", about: "отчёт Алекса, смена 11 нояб., 16:16–00:09", text: POST, reason: "kind_off" },
    { id: 37, hours: 11, to: "Nova Lane · Отчётность", about: "отчёт Дениса, смена 11 нояб., 08:00–16:02", text: POST.replace("#Алекс", "#Денис").replace(/mia-/gu, "nova-"), reason: "kind_off" },
    { id: 30, hours: 27, to: "Ivy Rose · Отчётность", about: "отчёт Ивана, смена 10 нояб., 18:14–02:36", text: POST.replace("#Алекс", "#Иван").replace(/mia-/gu, "ivy-"), reason: "no_chat" },
  ],
  "custom.card.to_model": [
    { id: 40, hours: 5, to: "Mia Hart · кастомы", about: "заказ K-14", text: CARD, reason: "kind_off" },
    { id: 33, hours: 20, to: "Ivy Rose · кастомы", about: "заказ K-17", text: CARD_IVY, reason: "no_chat" },
  ],
  "shift.report.missing": [
    { id: 39, hours: 7, to: "Катя", about: "смена 11 нояб., 08:00–16:00", text: MISSING_TEXT("11 нояб., 08:00–16:00", 2210), reason: "kind_off" },
    { id: 35, hours: 30, to: "Денис", about: "смена 10 нояб., 16:00–00:00", text: MISSING_TEXT("10 нояб., 16:00–00:00", 2188), reason: "no_telegram" },
  ],
  "custom.shot.give": [
    { id: 38, hours: 9, to: "Оля", about: "заказ K-11", text: SHOT_TEXT, reason: "kind_off" },
  ],
};

const EXAMPLE: Readonly<Partial<Record<PeopleMessageKind, { text: string; about: string }>>> = {
  "shift.report.copy": { text: POST, about: "последний сданный отчёт: смена 11 нояб., 16:16–00:09, Mia Hart" },
  "custom.card.to_model": { text: CARD, about: "последний заказ: K-14" },
  "shift.report.missing": { text: MISSING_TEXT("11 нояб., 08:00–16:00", 2210), about: "последнее дело: смена 11 нояб., 08:00–16:00, Катя" },
  "custom.shot.give": { text: SHOT_TEXT, about: "последнее дело: заказ K-11, Оля" },
};

const MISSING: Readonly<Partial<Record<PeopleMessageKind, string>>> = {
  "claim.confirm": "Заявок «моё / делим» в системе пока нет.",
  "payout.text": "Пример появится после первого нажатия: текст даёт расчёт выплаты ledger, сейчас он в «Выплате» человека под «Скопировать».",
  "newcomer.invite": "Пример появится после первого нажатия: сейчас текст в окне приглашения под «Скопировать сообщение».",
};

/** The kinds turned on in this demo run (a switch press). */
const turnedOn = new Map<PeopleMessageKind, Date>();
let version = 0;

/** The owner's «да» of the demo: the token «set» and the two kinds sent by a press on. */
function sayYes(request: DemoRequest): "sent" | "held" | "failed" | null {
  const value = request.cookie?.("hub-demo-people-messages");
  return value === "on" ? "sent" : value === "held" ? "held" : value === "failed" ? "failed" : null;
}

/** Who the press reaches in the demo: the team's logins and the newcomer have Telegram; Оля never wrote to the bot. */
function pressPerson(request: DemoRequest): { name: string; telegram: boolean; refusal: "never_wrote" | null } | null {
  const slug = queryString(request, "person") ?? (request.body as { person?: string } | null)?.person;
  const raw = queryString(request, "userId") ?? (request.body as { userId?: number } | null)?.userId;
  const userId = raw === undefined ? null : Number(raw);
  if (slug === "nika" || userId === 10) return { name: "Ника", telegram: true, refusal: null };
  const user = DEMO_USERS.find((one) => one.username === slug || one.id === userId);
  if (user) return { name: user.name, telegram: true, refusal: user.username === "olya.m" ? "never_wrote" : null };
  if (slug === "vika") return { name: "Вика", telegram: false, refusal: null };
  return userId !== null && userId >= 1000 ? { name: "новичок", telegram: false, refusal: null } : null;
}

function view(request: DemoRequest): Answer {
  const now = request.now;
  const yes = sayYes(request) !== null;
  const kinds: PeopleMessageKindView[] = PEOPLE_MESSAGE_KIND_SPECS.map((spec) => {
    const held = (HELD[spec.kind] ?? []).map((seed): PeopleMessageRow => ({
      id: seed.id, at: iso(hoursAgo(now, seed.hours)), to: seed.to, about: seed.about, text: seed.text, state: "held", reason: seed.reason, words: REASON_WORDS[seed.reason],
    }));
    const onSince = turnedOn.get(spec.kind) ?? (yes && spec.audience === "press" ? hoursAgo(now, 2) : null);
    const missingChats = spec.audience !== "group" ? [] : MODELS.filter((model) => !(spec.kind === "shift.report.copy" ? model.reports : model.customs));
    return {
      kind: spec.kind,
      title: spec.title,
      audience: spec.audience,
      toWhom: spec.toWhom,
      when: spec.when,
      template: spec.template,
      example: EXAMPLE[spec.kind] ?? null,
      exampleMissing: EXAMPLE[spec.kind] === undefined ? MISSING[spec.kind] ?? null : null,
      on: onSince !== null,
      onSince: onSince === null ? null : onSince.toISOString(),
      lastSwitch: onSince === null ? null : { at: onSince.toISOString(), by: "Владелец", on: true },
      trigger: spec.connected ? "ready" : "not_connected",
      triggerNote: spec.triggerNote,
      cap: spec.cap,
      capWords: peopleMessageCapWords(spec),
      quietWords: peopleMessageQuietWords(spec),
      needs: [...spec.needs],
      onSentence: spec.onSentence,
      blockedFor: missingChats.length === 0 ? [] : [`Нет чата: ${missingChats.map((model) => model.modelName).join(", ")}`],
      counts: { held: held.length + (spec.kind === "shift.report.copy" ? 9 : 0), sent: 0, failed: 0, unknown: 0 },
      held,
    };
  });
  return {
    tokenSet: yes,
    sentence: yes
      ? "Токен бота задан: включённые виды отправляются, выключенные задерживаются."
      : "Отправка невозможна: нет токена. Все сообщения задерживаются на сервере и никуда не уходят.",
    kindsVersion: version === 0 ? null : version,
    chats: MODELS,
    kinds,
    serverNow: now.toISOString(),
  };
}

export const peopleMessagesHandlers: DemoHandlers = {
  peopleMessages: (request) => view(request),
  peopleMessageRecipient: (request) => {
    const kind = queryString(request, "kind") as "payout.text" | "newcomer.invite";
    if (request.role !== "owner") return demoError(403, "Forbidden", "Owner only");
    if (sayYes(request) === null) return { kind, shown: false, sendable: false, label: null, why: null };
    const person = pressPerson(request);
    if (person === null || !person.telegram) return { kind, shown: true, sendable: false, label: null, why: peopleMessageCannotLine("no_telegram") };
    if (person.refusal !== null) return { kind, shown: true, sendable: false, label: null, why: peopleMessageCannotLine(person.refusal) };
    return { kind, shown: true, sendable: true, label: peopleMessagePressLabel(person.name, nameToWhom(person.name)), why: null };
  },
  peopleMessagePress: (request) => {
    if (request.role !== "owner") return demoError(403, "Forbidden", "Owner only");
    const person = pressPerson(request);
    const outcome = sayYes(request) ?? "held";
    const state = outcome === "sent" ? { state: "sent" as const, reason: null } : outcome === "held" ? { state: "held" as const, reason: "cap" as const } : { state: "failed" as const, reason: null };
    return { id: 77, ...state, words: peopleMessagePressWords(state, nameToWhom(person?.name ?? "") ?? person?.name ?? "") };
  },
  peopleMessageSwitch: (request) => {
    const kind = request.params.kind as PeopleMessageKind;
    const body = request.body as { on: boolean };
    const spec = PEOPLE_MESSAGE_KIND_SPECS.find((one) => one.kind === kind)!;
    if (body.on) turnedOn.set(kind, turnedOn.get(kind) ?? request.now);
    else turnedOn.delete(kind);
    version += 1;
    return {
      kind,
      on: body.on,
      onSince: turnedOn.get(kind)?.toISOString() ?? null,
      sentence: body.on
        ? `${spec.onSentence} Пока нет токена бота: сообщения этого вида задерживаются и не уходят.`
        : "Выключено: новые сообщения этого вида задерживаются и не уходят. Задержанные раньше не уйдут и после включения.",
      kindsVersion: version,
      audit: { at: request.now.toISOString(), by: "owner" },
    };
  },
};
