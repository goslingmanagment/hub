import {
  CLIENT_NUMERIC_ID_PATTERN,
  clientSendCustodyResolveBodySchema,
  type ClientSendCustodyListItem,
  type ClientSendCustodyResolveBody,
} from "@agency_hub_core/contracts";
import { formatDateTime } from "./format.js";
import { ruPlural } from "./plural.js";

/**
 * A held send of the chat extension and its manual resolve, as words and a
 * body ready to send (chat-extension H-7e), for Workboard's «Ждут вас» (the
 * console's page it replaced said the same): nothing preselected, «why» required, a message id only
 * with «sent», the contract's schema has the last word, every refusal in words.
 * The words name the platform of the send's page — 92 % of held sends are
 * Fansly's; an OnlyFans send reads as the console always said. Times are
 * Moscow's unless the caller passes its own clock (`greetingCell`).
 */

type Item = ClientSendCustodyListItem;

/** The contract's bound of the resolver's note. */
export const RESOLVE_NOTE_MAX = 500;

/** «Fansly», «OnlyFans»; null when the page's platform is not known. */
export function platformWord(platform: string | null | undefined): string | null {
  if (platform === "fansly") return "Fansly";
  if (platform === "onlyfans") return "OnlyFans";
  if (platform === "telegram") return "Telegram";
  return null;
}

/** «на Fansly»; without a known platform — where the person works with this page. */
function onPlatform(platform: string | null | undefined): string {
  const word = platformWord(platform);
  return word ? `на ${word}` : "там, где вы работаете с этой страницей";
}

const PURPOSE_LABELS: Readonly<Record<string, string>> = {
  greeting: "Приветствие",
  "preview-reply": "Ответ из превью",
};

export function purposeLabel(purpose: string): string {
  return PURPOSE_LABELS[purpose] ?? purpose;
}

/** «часть 2 из 3»; one message says so. A greeting names its variant: Hi offers up to three. */
export function partLabel(item: Pick<Item, "purpose" | "variant" | "partIndex" | "partCount">): string {
  const part = item.partCount === 1 ? "одно сообщение" : `часть ${item.partIndex + 1} из ${item.partCount}`;
  return item.purpose === "greeting" ? `${part}, вариант ${item.variant + 1}` : part;
}

/** An install is a UUID nobody reads whole: its first group tells two installs of one person apart. */
export function shortId(id: string): string {
  return id.split("-")[0] ?? id;
}

/** «меньше минуты», «25 мин», «3 ч 5 мин», «2 дня 4 ч». */
export function formatSpan(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "меньше минуты";
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} ч` : `${hours} ч ${minutes % 60} мин`;
  const days = Math.floor(hours / 24);
  const dayWord = ruPlural(days, "день", "дня", "дней");
  return hours % 24 === 0 ? `${days} ${dayWord}` : `${days} ${dayWord} ${hours % 24} ч`;
}

/** The moment a send became held: its ticket ran out. A row without one counts from its dispatch. */
export function heldSince(item: Pick<Item, "ticketExpiresAt" | "createdAt">): number {
  return Date.parse(item.ticketExpiresAt ?? item.createdAt);
}

const GREETING_SOURCE_LABELS: Readonly<Record<string, string>> = {
  "preview-send": "отправлено из превью",
  "native-register": "отправлено вручную из поля ввода",
  resolve: "записано при разборе",
  "desktop-outbox": "отправлено из десктопа",
};

export interface GreetingCell {
  /** The short answer: is the fan's greeting on record. */
  label: string;
  hint: string | null;
  /** This very part went out by hand while it was held: the case not to misread. */
  sentByHand: boolean;
}

/** A moment of a greeting in the words: Moscow's date and time by default. */
function moscowMoment(iso: string): string {
  return formatDateTime(iso, { yearUnlessCurrent: true });
}

/**
 * The fan's greeting next to a held greeting; null for any other send (it says
 * nothing about a reply). `formatAt` writes the greeting's moment: Moscow's by
 * default; the console's cabinet passes the viewer's own clock («как в чате»).
 */
export function greetingCell(item: Pick<Item, "purpose" | "greeting">, formatAt: (iso: string) => string = moscowMoment): GreetingCell | null {
  if (item.purpose !== "greeting") return null;
  const { greeting } = item;
  if (greeting.state !== "confirmed") return { label: "Нет", hint: null, sentByHand: false };
  const when = greeting.at === null ? "" : `, ${formatAt(greeting.at)}`;
  const how = greeting.source === null ? "" : GREETING_SOURCE_LABELS[greeting.source] ?? greeting.source;
  if (greeting.firstPartIsThisAttempt && greeting.source === "native-register") {
    return {
      label: "Есть: эту часть отправили вручную",
      hint: `Сотрудник отправил эту же часть из поля ввода${when}. То сообщение записано отдельно; `
        + "здесь ответьте только про отправку из превью.",
      sentByHand: true,
    };
  }
  return { label: "Есть", hint: how === "" ? null : `${how}${when}`, sentByHand: false };
}

/** The label of the optional message id, for the send's platform. */
export function messageIdLabel(platform: string | null | undefined): string {
  const word = platformWord(platform);
  return `ID сообщения${word ? ` в ${word}` : ""}, если вы его знаете (необязательно)`;
}

// ── the resolve form ─────────────────────────────────────────────────────────

export type ResolveOutcome = "sent" | "not_sent";

export interface ResolveDraft {
  /** Null: not chosen yet. Nothing is preselected: neither answer is the safe default. */
  outcome: ResolveOutcome | null;
  platformMessageId: string;
  note: string;
}

export const EMPTY_RESOLVE_DRAFT: ResolveDraft = { outcome: null, platformMessageId: "", note: "" };

export interface ResolveForm {
  /** The body of the resolve route; null until the form may be sent. */
  body: ClientSendCustodyResolveBody | null;
  platformMessageIdError: string | null;
  /** Characters left in the note; negative when it is too long. */
  noteLeft: number;
  /** What is still missing, next to the button; null when nothing is. */
  missing: string | null;
}

/**
 * The draft as Hub will take it. A message id rides only with «sent»: Hub
 * refuses it next to «not sent», so a value typed before the resolver changed
 * their mind is dropped, not sent.
 */
export function resolveForm(draft: ResolveDraft): ResolveForm {
  const note = draft.note.trim();
  const messageId = draft.outcome === "sent" ? draft.platformMessageId.trim() : "";
  const platformMessageIdError = messageId !== "" && !CLIENT_NUMERIC_ID_PATTERN.test(messageId)
    ? "ID сообщения — только цифры, без пробелов, не длиннее 30 и не с нуля."
    : null;
  const noteLeft = RESOLVE_NOTE_MAX - note.length;
  const missing = draft.outcome === null ? "Выберите, ушло сообщение или нет."
    : platformMessageIdError !== null ? "Исправьте ID сообщения или сотрите его."
    : note === "" ? "Напишите, почему вы так решили."
    : noteLeft < 0 ? `Заметка длиннее ${RESOLVE_NOTE_MAX} знаков.`
    : null;
  if (missing !== null || draft.outcome === null) return { body: null, platformMessageIdError, noteLeft, missing };
  const parsed = clientSendCustodyResolveBodySchema.safeParse({
    outcome: draft.outcome,
    note,
    ...(messageId === "" ? {} : { platformMessageId: messageId }),
  });
  return parsed.success
    ? { body: parsed.data, platformMessageIdError, noteLeft, missing: null }
    : { body: null, platformMessageIdError, noteLeft, missing: "Hub не примет такой разбор. Проверьте поля." };
}

/** What «sent» records. Only a greeting's resolve says anything about a greeting. */
export function sentOutcomeHint(item: Pick<Item, "purpose">): string {
  return item.purpose === "greeting"
    ? "Оно есть в чате. Отправка закрывается как состоявшаяся; первая часть приветствия отмечает фана поприветствованным."
    : "Оно есть в чате. Отправка закрывается как состоявшаяся.";
}

export const NOT_SENT_OUTCOME_HINT = "В чате его нет. Отправка закрывается как несостоявшаяся; что это меняет для фана, написано ниже.";

function archiveIsNoProof(platform: string | null | undefined): string {
  return "Правила «в архиве Hub нет — значит не ушло» не существует: архив мог ещё не получить это сообщение. "
    + `Смотрите сам чат ${onPlatform(platform)}.`;
}

/** What «not sent» does to this send, by Hub's rules for the case in hand. */
export function notSentWarning(item: Pick<Item, "purpose" | "greeting">, platform: string | null | undefined): string[] {
  const { greeting } = item;
  if (greeting.state === "confirmed" && greeting.firstPartIsThisAttempt && greeting.source === "native-register") {
    return [
      "Запись закроет только отправку из превью. Приветствие уже записано за сообщением, отправленным вручную: "
        + "заново фана не поприветствуют и эту часть из превью больше не отправят.",
      "Если в чате это сообщение стоит дважды, ушли обе отправки: тогда правильный ответ — «ушло».",
    ];
  }
  if (item.purpose === "greeting" && greeting.state !== "confirmed") {
    return [
      "После этого фана снова можно будет поприветствовать, и это сможет сделать любой сотрудник страницы. "
        + "Если сообщение на самом деле ушло, фан получит приветствие дважды.",
      archiveIsNoProof(platform),
    ];
  }
  return [
    "После этого фану снова можно будет отправить эту часть из превью. Если сообщение на самом деле ушло, фан получит его дважды.",
    archiveIsNoProof(platform),
  ];
}

// ── a refused resolve, in words ──────────────────────────────────────────────

export interface ResolveFailure {
  message: string;
  /** Nothing is left to resolve here: the window offers only to close. */
  gone: boolean;
}

function failureParts(error: unknown): { status: number | null; code: string | null; reason: string | null } {
  if (typeof error !== "object" || error === null) return { status: null, code: null, reason: null };
  const { status, code, body } = error as { status?: unknown; code?: unknown; body?: unknown };
  const reason = typeof body === "object" && body !== null ? (body as { reason?: unknown }).reason : null;
  return {
    status: typeof status === "number" ? status : null,
    code: typeof code === "string" ? code : null,
    reason: typeof reason === "string" ? reason : null,
  };
}

/** Hub's answer to a resolve it did not record (the console's words, docs/error-handling.md §3). */
export function resolveFailure(error: unknown, draft: Pick<ResolveDraft, "outcome">): ResolveFailure {
  const { status, code, reason } = failureParts(error);
  if (status === 409 && reason === "ticket_live") {
    return {
      message: "Эта отправка ещё в пути: Hub ждёт отчёт расширения 10 секунд, и сообщение может уйти прямо сейчас. "
        + "Отметить «не ушло» можно, когда это время выйдет. Подождите и нажмите ещё раз.",
      gone: false,
    };
  }
  if (status === 409 && reason === "custody_not_held") {
    return { message: "Разбирать уже нечего: расширение само сообщило, чем закончилась отправка. Ничего не записано, список обновлён.", gone: true };
  }
  if (status === 409 && code === "attempt_conflict") {
    return draft.outcome === "sent"
      ? {
        message: "Не записано. Либо эту отправку уже разобрали иначе, либо такой ID сообщения уже записан за другой отправкой. "
          + "Сверьте ID с сообщением в чате, исправьте или сотрите его и нажмите ещё раз. "
          + "Если ID вы не вводили, отправку уже разобрали: закройте окно.",
        gone: false,
      }
      : { message: "Не записано: эту отправку уже разобрали как ушедшую. Делать ничего не нужно.", gone: true };
  }
  if (status === 404) return { message: "Hub не нашёл эту отправку на этой странице. Ничего не записано, список обновлён.", gone: true };
  if (status === 403) return { message: "У вас нет доступа к этой странице. Ничего не записано.", gone: true };
  if (status === 401) return { message: "Вход закончился. Войдите снова и повторите: ничего не записано.", gone: false };
  if (status === 400) return { message: "Hub не принял поля. Проверьте ID сообщения и заметку. Ничего не записано.", gone: false };
  return {
    message: "Hub не подтвердил запись: неизвестно, записан ли разбор. Нажмите ещё раз: одинаковый разбор записывается один раз.",
    gone: false,
  };
}
