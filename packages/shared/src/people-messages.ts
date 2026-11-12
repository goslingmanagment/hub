// Сообщения людям (ecosystem plan 2026-11-12, package S): the server's own
// sender of messages to people in Telegram, built complete and left off twice.
// The two live settings it reads, checked on write (config-registry `format`),
// so a stored value always parses:
//
//   peopleMessageKinds  the kinds the owner turned on, each with the moment it
//                       was turned on: {"shift.report.copy": "2026-11-13T10:00:00.000Z"}.
//                       Only an event after that moment sends; {} (the default) — none.
//   peopleMessageChats  the work chats, per model slug: the chat and the topic of
//                       «Отчётность» (the chatters' group) and of customs (the
//                       model's group). A model without its chat cannot get a
//                       group kind; the owner's screen says so.
//
// The bot token is not here: it is the env secret PEOPLE_TELEGRAM_BOT_TOKEN.

/** Every kind, in the owner's list order (stop-list М1–М3). */
export const PEOPLE_MESSAGE_KINDS = [
  "shift.report.copy",
  "custom.card.to_model",
  "shift.report.missing",
  "custom.shot.give",
  "claim.confirm",
  "payout.text",
  "newcomer.invite",
] as const;
export type PeopleMessageKind = (typeof PEOPLE_MESSAGE_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(PEOPLE_MESSAGE_KINDS);
export function isPeopleMessageKind(value: string): value is PeopleMessageKind {
  return KIND_SET.has(value);
}

/** The turned-on kinds and since when. */
export type PeopleMessageKindsOn = Partial<Record<PeopleMessageKind, Date>>;

/** A chat and, in a forum group, its topic. */
export interface PeopleMessageChat {
  chatId: string;
  topicId: number | null;
}

export interface PeopleMessageModelChats {
  /** «Отчётность»: the chatters' group of the model. */
  reports?: PeopleMessageChat;
  /** Customs: the model's own group. */
  customs?: PeopleMessageChat;
}

export type PeopleMessageChats = Record<string, PeopleMessageModelChats>;

type Parse<T> = { ok: true; value: T } | { ok: false; error: string };

const KINDS_EXAMPLE = `{"shift.report.copy": "2026-11-13T10:00:00.000Z"}`;
const CHATS_EXAMPLE = `{"<model slug>": {"reports": {"chatId": "-100…", "topicId": 4}, "customs": {"chatId": "-100…", "topicId": 3}}}`;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A Telegram chat id: a user, a group or a supergroup («-100…»). */
const CHAT_ID = /^-?[1-9]\d{0,19}$/;

export function parsePeopleMessageKinds(text: string): Parse<PeopleMessageKindsOn> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `is not JSON: an object kind -> the moment it was turned on, e.g. ${KINDS_EXAMPLE}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `is an object kind -> the moment it was turned on, e.g. ${KINDS_EXAMPLE}` };
  }
  const value: PeopleMessageKindsOn = {};
  for (const [kind, raw] of Object.entries(parsed)) {
    if (!isPeopleMessageKind(kind)) {
      return { ok: false, error: `"${kind}" is not a kind; the kinds are ${PEOPLE_MESSAGE_KINDS.join(", ")}` };
    }
    const at = typeof raw === "string" ? new Date(raw) : null;
    if (at === null || Number.isNaN(at.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(raw as string)) {
      return { ok: false, error: `"${kind}" must be the ISO moment it was turned on, e.g. ${KINDS_EXAMPLE}` };
    }
    value[kind] = at;
  }
  return { ok: true, value };
}

function chatOf(raw: unknown, where: string): Parse<PeopleMessageChat> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `${where} must be {"chatId": "<id>", "topicId": <id or null>}` };
  }
  const { chatId, topicId, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return { ok: false, error: `${where} has unknown fields ${Object.keys(rest).join(", ")}; only chatId and topicId` };
  const id = typeof chatId === "number" && Number.isSafeInteger(chatId) ? String(chatId) : chatId;
  if (typeof id !== "string" || !CHAT_ID.test(id)) return { ok: false, error: `${where}.chatId must be a Telegram chat id (digits, «-100…» for a group)` };
  if (topicId !== undefined && topicId !== null && (typeof topicId !== "number" || !Number.isSafeInteger(topicId) || topicId <= 0)) {
    return { ok: false, error: `${where}.topicId must be the topic's id (a positive integer) or null` };
  }
  return { ok: true, value: { chatId: id, topicId: typeof topicId === "number" ? topicId : null } };
}

export function parsePeopleMessageChats(text: string): Parse<PeopleMessageChats> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `is not JSON: an object keyed by model slug, e.g. ${CHATS_EXAMPLE}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `is an object keyed by model slug, e.g. ${CHATS_EXAMPLE}` };
  }
  const value: PeopleMessageChats = {};
  for (const [slug, raw] of Object.entries(parsed)) {
    if (!SLUG.test(slug)) return { ok: false, error: `"${slug}" is not a model slug (lowercase latin, digits, _ or -)` };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, error: `"${slug}" must be {"reports": {…}, "customs": {…}}` };
    }
    const { reports, customs, ...rest } = raw as Record<string, unknown>;
    if (Object.keys(rest).length > 0) return { ok: false, error: `"${slug}" has unknown fields ${Object.keys(rest).join(", ")}; only reports and customs` };
    const model: PeopleMessageModelChats = {};
    if (reports !== undefined) {
      const chat = chatOf(reports, `"${slug}".reports`);
      if (!chat.ok) return chat;
      model.reports = chat.value;
    }
    if (customs !== undefined) {
      const chat = chatOf(customs, `"${slug}".customs`);
      if (!chat.ok) return chat;
      model.customs = chat.value;
    }
    value[slug] = model;
  }
  return { ok: true, value };
}

/** The stored value, parsed; an unset or unparsable one turns nothing on. */
export function peopleMessageKindsOf(text: string | undefined): PeopleMessageKindsOn {
  if (text === undefined) return {};
  const parsed = parsePeopleMessageKinds(text);
  return parsed.ok ? parsed.value : {};
}

/** The stored value, parsed; an unset or unparsable one names no chat. */
export function peopleMessageChatsOf(text: string | undefined): PeopleMessageChats {
  if (text === undefined) return {};
  const parsed = parsePeopleMessageChats(text);
  return parsed.ok ? parsed.value : {};
}

/** The kinds setting's text with one kind turned on at `at` or off; the others as they were. */
export function withPeopleMessageKind(text: string | undefined, kind: PeopleMessageKind, on: boolean, at: Date): string {
  const current = peopleMessageKindsOf(text);
  const out: Record<string, string> = {};
  for (const one of PEOPLE_MESSAGE_KINDS) {
    if (one === kind) {
      if (on) out[one] = (current[one] ?? at).toISOString();
      continue;
    }
    const since = current[one];
    if (since !== undefined) out[one] = since.toISOString();
  }
  return JSON.stringify(out);
}
