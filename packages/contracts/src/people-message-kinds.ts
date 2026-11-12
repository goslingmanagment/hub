import type { PeopleMessageKind } from "@agency_hub_core/shared";

// One home for the kinds' words: the server's sender (apps/runtime/src/services/people-messages) and the demo read them.

/**
 * Сообщения людям (package S): the kinds, one row of code and words each — to
 * whom, when, the exact template, the day's cap per recipient and the quiet
 * hours. Not a table the owner edits: what the owner decides is whether a kind
 * is on (the live setting peopleMessageKinds) and where the work chats are
 * (peopleMessageChats). The group kinds' texts are exactly today's formats:
 * the ledger's post reader parses the report's post.
 */

export type PeopleMessageSpecAudience = "group" | "person" | "press";

export interface PeopleMessageKindSpec {
  kind: PeopleMessageKind;
  title: string;
  audience: PeopleMessageSpecAudience;
  toWhom: string;
  when: string;
  /** The exact text with its places in «‹…›». */
  template: string;
  /** At most this many a Moscow day to one recipient (a person, or a chat's topic). */
  cap: number;
  /** Personal reminders wait out the people's night: none is made 23:00–10:00 Moscow time. */
  quiet: boolean;
  /** `false`: the kind and its words are here, the event that fires it comes with its package. */
  connected: boolean;
  triggerNote: string | null;
  needs: readonly string[];
  /** What starts happening when it is turned on. */
  onSentence: string;
}

/** The people's night by Moscow time: a personal reminder is not made from 23:00 to 10:00. */
export const PEOPLE_MESSAGE_QUIET_FROM_HOUR = 23;
export const PEOPLE_MESSAGE_QUIET_TO_HOUR = 10;
const QUIET_WORDS = `Ночью не пишет: с ${PEOPLE_MESSAGE_QUIET_FROM_HOUR}:00 до ${PEOPLE_MESSAGE_QUIET_TO_HOUR}:00 по Москве напоминание не создаётся, утром уходит, если причина ещё есть`;
const NO_QUIET_GROUP = "Без тихих часов: рабочий чат, команда пишет туда и ночью";
const NO_QUIET_PRESS = "Без тихих часов: уходит, когда вы нажали";

const TOKEN_NEED = "Токен бота в PEOPLE_TELEGRAM_BOT_TOKEN на сервере (один на все виды)";
const PERSON_NEED = "Telegram id человека в реестре людей, и человек хоть раз написал боту: бот не может начать разговор сам";
const GROUP_NEED = "Бот в группе с правом писать в разделы";

export const PEOPLE_MESSAGE_KIND_SPECS: readonly PeopleMessageKindSpec[] = [
  {
    kind: "shift.report.copy",
    title: "Копия сданного отчёта в «Отчётность»",
    audience: "group",
    toWhom: "Раздел «Отчётность» в чате чаттеров модели",
    when: "Через 5 минут после сдачи смены в системе: последняя версия отчёта, по посту на каждую модель смены",
    template: [
      "🗓 Дата: ‹дд.мм.гггг›",
      "👤 Чаттер: ‹#тег›",
      "",
      "📌 Аккаунты:",
      "Fansly",
      "• ‹страница› - ‹сумма›",
      "OF",
      "• ‹страница› - ‹сумма›",
      "",
      "💰Общий доход: ‹сумма›",
      "",
      "📈 Основные продажи:",
      "‹ссылка на фана› - ‹ppv|sub|tip› ‹сумма›. ‹заметка›",
      "",
      "📝 Комментарий:",
      "‹комментарий›",
    ].join("\n"),
    cap: 40,
    quiet: false,
    connected: true,
    triggerNote: null,
    needs: [TOKEN_NEED, `${GROUP_NEED} «Отчётность»`, "Чат и номер раздела «Отчётность» каждой модели в настройке peopleMessageChats"],
    onSentence: "С этой минуты каждый отчёт, сданный в системе, сервер сам кладёт постом в «Отчётность» модели, тем же текстом, что даёт «Скопировать пост». Отчёты, сданные раньше, не уходят.",
  },
  {
    kind: "custom.card.to_model",
    title: "Карточка заказа в группу модели",
    audience: "group",
    toWhom: "Раздел кастомов в группе модели",
    when: "Когда ведущий нажимает «У модели» и карточка ещё не лежит в группе",
    template: [
      "📦 Описание заказа ‹K-номер›",
      "Дата: ‹дд.мм.гггг›",
      "Покупатель: ‹ссылка на фана›",
      "Имя: ‹имя›",
      "Оплата: ‹сумма и условия›",
      "Длительность: ‹длительность›",
      "",
      "🎥 Описание задания:",
      "‹задание›",
      "",
      "👗 Одежда:",
      "‹одежда›",
      "",
      "🗒 Заметки:",
      "‹заметки›",
      "",
      "🔥Срочность: ‹срочность›",
      "⏳Сроки: До ‹дд.мм.гггг›",
    ].join("\n"),
    cap: 20,
    quiet: false,
    connected: true,
    triggerNote: null,
    needs: [TOKEN_NEED, `${GROUP_NEED} кастомов группы модели`, "Чат и номер раздела кастомов каждой модели в настройке peopleMessageChats"],
    onSentence: "С этой минуты, когда ведущий нажимает «У модели», сервер сам кладёт карточку заказа в раздел кастомов группы модели, тем же текстом, что даёт «Скопировать карточку». Ведущему больше не нужно её переносить.",
  },
  {
    kind: "shift.report.missing",
    title: "Напоминание о несданной смене",
    audience: "person",
    toWhom: "Чаттеру, чья смена не сдана (в личку)",
    when: "Когда открывается дело «Сдайте смену»: через 2 часа после конца смены, только у тех, кто сдаёт смену в системе",
    template: "Смена ‹дата, время› не сдана. Сдайте её, пожалуйста: ‹ссылка на смену в Workboard›",
    cap: 2,
    quiet: true,
    connected: true,
    triggerNote: null,
    needs: [TOKEN_NEED, PERSON_NEED],
    onSentence: "С этой минуты чаттер, у которого открылось дело «Сдайте смену», получает от бота одно сообщение в личку со ссылкой на смену. Ночью сообщение ждёт утра.",
  },
  {
    kind: "custom.shot.give",
    title: "«Кастом снят, отдайте фану»",
    audience: "person",
    toWhom: "Чаттеру, который принял заказ (в личку)",
    when: "Когда открывается дело «Кастом снят, отдайте фану»: снят и 12 часов не отдан, у тех, кто записывает кастомы в системе",
    template: "Кастом ‹K-номер› снят, отдайте его фану: ‹ссылка на заказ в Workboard›",
    cap: 3,
    quiet: true,
    connected: true,
    triggerNote: null,
    needs: [TOKEN_NEED, PERSON_NEED],
    onSentence: "С этой минуты чаттер, принявший снятый кастом, получает от бота одно сообщение в личку: номер заказа и ссылку на него. Фана в сообщении нет, он виден в заказе. Ночью сообщение ждёт утра.",
  },
  {
    kind: "claim.confirm",
    title: "«Подтвердите договорённость»",
    audience: "person",
    toWhom: "Второй стороне заявки «моё / делим» (в личку)",
    when: "Когда коллега заявляет продажу своей или общей, и ждут вашего согласия",
    template: "‹Кто› считает продажу ‹сумма› на ‹страница› своей. Подтвердите договорённость или ответьте в Workboard: ‹ссылка›",
    cap: 5,
    quiet: true,
    connected: true,
    triggerNote: null,
    needs: [TOKEN_NEED, PERSON_NEED],
    onSentence: "С этой минуты вторая сторона заявки «моё / делим» получает от бота одно сообщение в личку со ссылкой, где согласиться. Ночью сообщение ждёт утра.",
  },
  {
    kind: "payout.text",
    title: "Текст о выплате",
    audience: "press",
    toWhom: "Человеку, которому выплата (в личку)",
    when: "Когда вы нажимаете «Отправить в Telegram» в «Выплате» человека; без нажатия не уходит никогда",
    template: "Текст из расчёта выплаты ledger с суммой перевода: тот же, что копирует «Скопировать» в «Выплате».",
    cap: 2,
    quiet: false,
    connected: true,
    triggerNote: null,
    needs: [TOKEN_NEED, PERSON_NEED],
    onSentence: "С этой минуты рядом с «Скопировать» в «Выплате» человека появляется «Отправить в Telegram»: по вашему нажатию бот отправляет человеку тот же текст. Сам по себе текст не уходит никогда.",
  },
  {
    kind: "newcomer.invite",
    title: "Приглашение новичку",
    audience: "press",
    toWhom: "Новичку (в личку)",
    when: "Когда вы нажимаете «Отправить в Telegram» в окне приглашения; без нажатия не уходит никогда",
    // The words of packages/ui/src/teamAccess.ts `telegramMessage` (the invitation's window): the text sent is the window's own.
    template: "Привет, ‹имя›! Твой аккаунт ChatGoose готов.\nСсылка: ‹одноразовая ссылка›\nЛогин: ‹логин›\nОткрой ссылку и придумай пароль: дальше сайт сам покажет, что осталось сделать до первой смены.",
    cap: 2,
    quiet: false,
    connected: true,
    triggerNote: null,
    needs: [TOKEN_NEED, `${PERSON_NEED}; у новичка его обычно ещё нет`],
    onSentence: "С этой минуты в окне приглашения рядом с «Скопировать сообщение» появляется «Отправить в Telegram»: по вашему нажатию бот отправляет новичку текст со ссылкой. Ссылка в журнале сообщений не хранится.",
  },
];

const SPEC_BY_KIND: ReadonlyMap<PeopleMessageKind, PeopleMessageKindSpec> = new Map(PEOPLE_MESSAGE_KIND_SPECS.map((spec) => [spec.kind, spec]));

export function peopleMessageKindSpec(kind: PeopleMessageKind): PeopleMessageKindSpec {
  return SPEC_BY_KIND.get(kind)!;
}

export function peopleMessageQuietWords(spec: PeopleMessageKindSpec): string {
  if (spec.quiet) return QUIET_WORDS;
  return spec.audience === "group" ? NO_QUIET_GROUP : NO_QUIET_PRESS;
}

export function peopleMessageCapWords(spec: PeopleMessageKindSpec): string {
  const who = spec.audience === "group" ? "в один раздел" : "одному человеку";
  return `Не больше ${spec.cap} в сутки ${who}: следующие задерживаются`;
}

// ── The owner's press: its words ─────────────────────────────────────────────

type PressHeldReason = "kind_off" | "no_token" | "no_telegram" | "no_chat" | "cap" | "before_on";
export type PeopleMessageRefusal = "never_wrote" | "blocked";

const PRESS_HELD_WHY: Readonly<Record<PressHeldReason, string>> = {
  kind_off: "вид выключен",
  no_token: "нет токена бота",
  no_telegram: "в карточке человека нет Telegram id",
  no_chat: "не задан чат",
  cap: "сегодня этому человеку уже ушёл дневной предел таких сообщений",
  before_on: "событие было до включения вида",
};

const REFUSAL_WHY: Readonly<Record<PeopleMessageRefusal, string>> = {
  never_wrote: "человек ещё не писал боту, а бот не может начать разговор сам",
  blocked: "человек заблокировал бота",
};

/** The press's button, to whom: «Отправить Алексу в Telegram»; a name without its case: «Отправить в Telegram: Rick». */
export function peopleMessagePressLabel(name: string, toWhom: string | null): string {
  return toWhom === null ? `Отправить в Telegram: ${name}` : `Отправить ${toWhom} в Telegram`;
}

/** The one quiet line in place of the button: why the press cannot reach the person. */
export function peopleMessageCannotLine(why: "no_telegram" | PeopleMessageRefusal): string {
  return `Не отправить в Telegram: ${why === "no_telegram" ? PRESS_HELD_WHY.no_telegram : REFUSAL_WHY[why]}.`;
}

/** What became of the press, in one sentence: never a silent success. `toWhom` — «Алексу», else the name. */
export function peopleMessagePressWords(
  outcome: { state: "held" | "sending" | "sent" | "failed" | "unknown" | "duplicate"; reason: PressHeldReason | null; refusal?: PeopleMessageRefusal | undefined },
  toWhom: string,
): string {
  switch (outcome.state) {
    case "sent": return `Отправлено ${toWhom} в Telegram.`;
    case "held": return `Не отправлено: ${PRESS_HELD_WHY[outcome.reason ?? "kind_off"]}. Сообщение задержано на сервере.`;
    case "failed": return `Не отправлено: ${outcome.refusal ? REFUSAL_WHY[outcome.refusal] : "Telegram отказал"}. Скопируйте текст и отправьте сами.`;
    case "unknown": return "Неизвестно, ушло ли: Telegram не ответил. Само не повторится, спросите человека.";
    case "duplicate": return "Это сообщение уже отправлялось: второй раз не уходит.";
    default: return "Отправляется.";
  }
}
