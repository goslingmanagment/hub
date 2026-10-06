import {
  CLIENT_NUMERIC_ID_PATTERN,
  clientSendCustodyResolveBodySchema,
  type ClientSendCustodyListItem,
  type ClientSendCustodyListState,
  type ClientSendCustodyResolveBody,
} from "@agency_hub_core/contracts";

import { ruPlural } from "@/lib/plural";

/**
 * The cabinet's "held sends" page as rows and a form ready to print
 * (chat-extension H-7e). Pure: the page renders what this returns, and the
 * resolve it sends is the body this builds.
 *
 * The hub answers ids, states and times, so there is no text of a message
 * here: the hub does not know which text went out. (`generationRef` names the
 * AI generation the text came from, a record only the owner reads, elsewhere.)
 * Everything this model words for a person, it words without the hub's own
 * terms: a "ticket" is "the hub waited 10 seconds for the report", custody is
 * "the fan is held".
 */

type Item = ClientSendCustodyListItem;

export const HELD_SENDS_PAGE_SIZE = 25;
/** The contract's bound of the resolver's note. */
export const RESOLVE_NOTE_MAX = 500;

export const HELD_SENDS_TABS: ReadonlyArray<{ key: ClientSendCustodyListState; label: string }> = [
  { key: "held", label: "Ждут разбора" },
  { key: "resolved", label: "Разобранные" },
];

// ── the address of a view: tab, page filter and offset in the query string ───

export interface HeldSendsView {
  state: ClientSendCustodyListState;
  /** Null: every page the viewer reaches. */
  pageLabel: string | null;
  offset: number;
}

/**
 * A link someone edited by hand lands on the page, not on an error: an unknown
 * tab is the queue, a page the viewer does not have is "every page", a bad
 * offset is the start. `pageLabels` null: the catalog is not loaded yet, and
 * the filter is kept until it can be checked.
 */
export function parseHeldSendsView(search: URLSearchParams, pageLabels: readonly string[] | null): HeldSendsView {
  const page = search.get("page");
  const offset = Number(search.get("offset"));
  return {
    state: search.get("state") === "resolved" ? "resolved" : "held",
    pageLabel: page !== null && page !== "" && (pageLabels === null || pageLabels.includes(page)) ? page : null,
    offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
  };
}

/** The query string of a view; the defaults are left out, so the plain address is the queue of every page. */
export function heldSendsSearch(view: HeldSendsView): URLSearchParams {
  const search = new URLSearchParams();
  if (view.state !== "held") search.set("state", view.state);
  if (view.pageLabel !== null) search.set("page", view.pageLabel);
  if (view.offset > 0) search.set("offset", String(view.offset));
  return search;
}

/**
 * The address after one change of the view, built from the address given.
 *
 * `current` must be the address the browser shows NOW (`location.search` at
 * the moment of the click), not the one the page last rendered. The router
 * publishes a new address to React in a transition, so a second change made
 * before that render commits would otherwise start from the old view and undo
 * the first: a tab click followed at once by a change of the page filter left
 * the page on the other tab.
 *
 * A new tab or page filter starts its list from the top; only a change of the
 * offset itself keeps a position in the list.
 */
export function changeHeldSendsView(
  current: URLSearchParams,
  pageLabels: readonly string[] | null,
  change: Partial<HeldSendsView>,
): URLSearchParams {
  return heldSendsSearch({ ...parseHeldSendsView(current, pageLabels), ...change, offset: change.offset ?? 0 });
}

/**
 * The platforms whose pages can hold a send at all: sending from the preview
 * exists on them and nowhere else. One table, so the page filter compares no
 * platform to decide which pages to offer.
 */
const PREVIEW_SEND_PLATFORMS: ReadonlySet<string> = new Set(["onlyfans"]);

/** The pages the filter offers, in the catalog's order. */
export function heldSendsPageLabels(pages: ReadonlyArray<{ label: string; platform: string }>): string[] {
  return pages.filter((page) => PREVIEW_SEND_PLATFORMS.has(page.platform)).map((page) => page.label);
}

// ── words ────────────────────────────────────────────────────────────────────

const PURPOSE_LABELS: Readonly<Record<string, string>> = {
  greeting: "Приветствие",
  "preview-reply": "Ответ из превью",
};

/** A purpose this build does not know prints its code. */
export function purposeLabel(purpose: string): string {
  return PURPOSE_LABELS[purpose] ?? purpose;
}

/** "часть 2 из 3"; a send that was one message says so. A greeting names its variant: Hi offers up to three. */
export function partLabel(item: Pick<Item, "purpose" | "variant" | "partIndex" | "partCount">): string {
  const part = item.partCount === 1 ? "одно сообщение" : `часть ${item.partIndex + 1} из ${item.partCount}`;
  return item.purpose === "greeting" ? `${part}, вариант ${item.variant + 1}` : part;
}

/** A client install is a UUID nobody reads whole: its first group tells two installs of one person apart. */
export function shortId(id: string): string {
  return id.split("-")[0] ?? id;
}

function parts(format: Intl.DateTimeFormat, date: Date): Record<string, string> {
  return Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
}

/**
 * "5 октября, 14:02", with the year when it is not `now`'s. Put together from
 * parts, so the wording does not follow the runtime's own date pattern. The
 * page prints the viewer's local time (no `timeZone`): it is the clock of the
 * chat the resolver compares against.
 */
export function formatMoment(iso: string, now: Date, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const format = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  const at = parts(format, date);
  const year = at.year === parts(format, now).year ? "" : ` ${at.year}`;
  return `${at.day} ${at.month}${year}, ${at.hour}:${at.minute}`;
}

/** How long a span is, in the two largest units: "меньше минуты", "25 мин", "3 ч 5 мин", "2 дня 4 ч". */
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

/** "1 отправка ждёт разбора", "3 отправки ждут разбора", "5 отправок ждут разбора". */
export function heldCountLabel(total: number): string {
  return `${total} ${ruPlural(total, "отправка ждёт", "отправки ждут", "отправок ждут")} разбора`;
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
  /** What that means for the resolver; null when there is nothing to add. */
  hint: string | null;
  /** The case the resolver must not misread: this very part went out by hand while it was held. */
  sentByHand: boolean;
}

/**
 * The fan's greeting as the resolver reads it next to a held greeting. Null for
 * any other send: whether the fan was greeted says nothing about a held reply,
 * and its resolve changes nothing about the greeting.
 */
export function greetingCell(item: Pick<Item, "purpose" | "greeting">, now: Date, timeZone?: string): GreetingCell | null {
  if (item.purpose !== "greeting") return null;
  const { greeting } = item;
  if (greeting.state !== "confirmed") {
    return { label: "Нет", hint: null, sentByHand: false };
  }
  const when = greeting.at === null ? "" : `, ${formatMoment(greeting.at, now, timeZone)}`;
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

// ── rows ─────────────────────────────────────────────────────────────────────

export interface HeldSendRow {
  key: string;
  item: Item;
  pageLabel: string;
  fanRef: string;
  purpose: string;
  part: string;
  /** Who dispatched, and the short id of the client install it came from. */
  username: string;
  install: string;
  dispatchedAt: string;
  /** How long ago the hub stopped waiting for the client's report. */
  heldFor: string;
  /** Null for a send that is not a greeting. */
  greeting: GreetingCell | null;
}

export interface ResolvedSendRow {
  key: string;
  /** The attempt id: the audit event of the resolve names the send by it. */
  attemptId: string;
  pageLabel: string;
  fanRef: string;
  purpose: string;
  part: string;
  username: string;
  dispatchedAt: string;
  outcome: string;
  /** True for "sent": the row reads as a send that happened. */
  sent: boolean;
  resolvedBy: string;
  resolvedAt: string;
  note: string;
  /** The OnlyFans message id the resolver recorded; null when they recorded none. */
  platformMessageId: string | null;
}

/** The moment a send became held: its ticket ran out. A row without one counts from its dispatch. */
function heldSince(item: Pick<Item, "ticketExpiresAt" | "createdAt">): number {
  return Date.parse(item.ticketExpiresAt ?? item.createdAt);
}

export function heldSendRows(items: readonly Item[], serverNow: string, timeZone?: string): HeldSendRow[] {
  const now = new Date(serverNow);
  return items.map((item) => ({
    key: item.attemptId,
    item,
    pageLabel: item.pageLabel,
    fanRef: item.fanRef,
    purpose: purposeLabel(item.purpose),
    part: partLabel(item),
    username: item.username,
    install: shortId(item.instanceId),
    dispatchedAt: formatMoment(item.createdAt, now, timeZone),
    heldFor: formatSpan(now.getTime() - heldSince(item)),
    greeting: greetingCell(item, now, timeZone),
  }));
}

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  sent: "Сообщение ушло",
  not_sent: "Сообщение не ушло",
};

/** The audit trail of the resolves: one row per send a person ended. A row the hub sent without a resolve is skipped. */
export function resolvedSendRows(items: readonly Item[], serverNow: string, timeZone?: string): ResolvedSendRow[] {
  const now = new Date(serverNow);
  return items.flatMap((item) => {
    const { resolution } = item;
    if (resolution === null) return [];
    return [{
      key: item.attemptId,
      attemptId: item.attemptId,
      pageLabel: item.pageLabel,
      fanRef: item.fanRef,
      purpose: purposeLabel(item.purpose),
      part: partLabel(item),
      username: item.username,
      dispatchedAt: formatMoment(item.createdAt, now, timeZone),
      outcome: OUTCOME_LABELS[resolution.outcome] ?? resolution.outcome,
      sent: resolution.outcome === "sent",
      resolvedBy: resolution.username,
      resolvedAt: formatMoment(resolution.at, now, timeZone),
      note: resolution.note,
      platformMessageId: resolution.platformMessageId,
    }];
  });
}

// ── the resolve form ─────────────────────────────────────────────────────────

export type ResolveOutcome = "sent" | "not_sent";

export interface ResolveDraft {
  /** Null: the resolver has not chosen yet. Nothing is preselected: neither answer is the safe default. */
  outcome: ResolveOutcome | null;
  platformMessageId: string;
  note: string;
}

export const EMPTY_RESOLVE_DRAFT: ResolveDraft = { outcome: null, platformMessageId: "", note: "" };

export interface ResolveForm {
  /** The body of the resolve route; null until the form may be sent. */
  body: ClientSendCustodyResolveBody | null;
  /** Why the message id cannot be recorded as typed; null when it can, or is empty. */
  platformMessageIdError: string | null;
  /** Characters left in the note; negative when it is too long. */
  noteLeft: number;
  /** What is still missing, for the line next to the button; null when nothing is. */
  missing: string | null;
}

/**
 * The draft as the hub will take it. A message id rides only with "sent": it
 * is evidence of a send, and the hub refuses it next to "not sent", so a value
 * typed before the resolver changed their mind is dropped, not sent.
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
  if (missing !== null || draft.outcome === null) {
    return { body: null, platformMessageIdError, noteLeft, missing };
  }
  // The contract's own schema has the last word: the page never sends what the hub refuses.
  const parsed = clientSendCustodyResolveBodySchema.safeParse({
    outcome: draft.outcome,
    note,
    ...(messageId === "" ? {} : { platformMessageId: messageId }),
  });
  return parsed.success
    ? { body: parsed.data, platformMessageIdError, noteLeft, missing: null }
    : { body: null, platformMessageIdError, noteLeft, missing: "Hub не примет такой разбор. Проверьте поля." };
}

/** What "sent" records, under that answer. Only a greeting's resolve says anything about a greeting. */
export function sentOutcomeHint(item: Pick<Item, "purpose">): string {
  return item.purpose === "greeting"
    ? "Оно есть в чате. Отправка закрывается как состоявшаяся; первая часть приветствия отмечает фана поприветствованным."
    : "Оно есть в чате. Отправка закрывается как состоявшаяся.";
}

/** What "not sent" records, under that answer; what it changes for the fan is the warning's (notSentWarning). */
export const NOT_SENT_OUTCOME_HINT = "В чате его нет. Отправка закрывается как несостоявшаяся; что это меняет для фана, написано ниже.";

const ARCHIVE_IS_NO_PROOF = "Правила «в архиве Hub нет — значит не ушло» не существует: архив мог ещё не получить это сообщение. "
  + "Смотрите сам чат на OnlyFans.";

/**
 * What "not sent" does to this send, said before the resolver presses the
 * button and shown whenever that answer is chosen. It follows the hub's rules
 * for the case in hand, so it never warns of a second greeting the hub would
 * refuse:
 * - a greeting with none on record: the fan is free for anyone's greeting;
 * - this very part already sent by hand: the part counts as sent whatever is
 *   answered here, nothing goes out again;
 * - anything else (a reply, a later part of a recorded greeting): that part
 *   may be dispatched again.
 */
export function notSentWarning(item: Pick<Item, "purpose" | "greeting">): string[] {
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
      ARCHIVE_IS_NO_PROOF,
    ];
  }
  return [
    "После этого фану снова можно будет отправить эту часть из превью. Если сообщение на самом деле ушло, фан получит его дважды.",
    ARCHIVE_IS_NO_PROOF,
  ];
}

// ── a refused resolve, in words ──────────────────────────────────────────────

export interface ResolveFailure {
  message: string;
  /**
   * The send is no longer held, or is not where the page thought: there is
   * nothing left to resolve here, and the dialog offers only to close.
   */
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

/** The hub's answer to a resolve it did not record, as the resolver reads it (docs/error-handling.md §3). */
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
    return {
      message: "Разбирать уже нечего: расширение само сообщило, чем закончилась отправка. Ничего не записано, список обновлён.",
      gone: true,
    };
  }
  if (status === 409 && code === "attempt_conflict") {
    return draft.outcome === "sent"
      ? {
        message: "Не записано. Либо эту отправку уже разобрали иначе, либо такой ID сообщения уже записан за другой отправкой. "
          + "Откройте «Разобранные» и проверьте ID.",
        gone: false,
      }
      : { message: "Не записано: эту отправку уже разобрали как ушедшую. Откройте «Разобранные».", gone: true };
  }
  if (status === 404) {
    return { message: "Hub не нашёл эту отправку на этой странице. Ничего не записано, список обновлён.", gone: true };
  }
  if (status === 403) {
    return { message: "У вас нет доступа к этой странице. Ничего не записано.", gone: true };
  }
  if (status === 401) {
    return { message: "Вход закончился. Войдите снова и повторите: ничего не записано.", gone: false };
  }
  if (status === 400) {
    return { message: "Hub не принял поля. Проверьте ID сообщения и заметку. Ничего не записано.", gone: false };
  }
  return {
    message: "Hub не подтвердил запись: неизвестно, записан ли разбор. Нажмите ещё раз: одинаковый разбор записывается один раз.",
    gone: false,
  };
}
