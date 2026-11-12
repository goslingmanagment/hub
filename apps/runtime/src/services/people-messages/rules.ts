import type { PeopleMessageChat, PeopleMessageKind, PeopleMessageKindsOn } from "@agency_hub_core/shared";

import { PEOPLE_MESSAGE_QUIET_FROM_HOUR, PEOPLE_MESSAGE_QUIET_TO_HOUR } from "@agency_hub_core/contracts";

/**
 * Сообщения людям (package S), the rules, pure (tests/people-messages-rules.test.ts):
 * whether a message may leave, or why it is held. Sending needs both locks — the
 * bot token and the kind turned on — and a recipient Telegram can reach, and an
 * event that happened after the kind was turned on: a message held once is never
 * sent later by itself. The service writes every decision as a row first.
 */

export type HeldReason = "kind_off" | "no_token" | "no_telegram" | "no_chat" | "cap" | "before_on";

/** Who a message is for. */
export type MessageRecipient =
  | { kind: "person"; userId: number; telegramUserId: number | null; name: string }
  | { kind: "chat"; chat: PeopleMessageChat | null; words: string };

export interface MessageCandidate {
  kind: PeopleMessageKind;
  /** The matter's reason key or the object's version: the same never makes a second message. */
  key: string;
  recipient: MessageRecipient;
  objectType: string | null;
  objectId: string | null;
  about: string;
  text: string;
  /** When the event that made it happened. */
  eventAt: Date;
}

export interface MessageLocks {
  /** The bot token is set (env PEOPLE_TELEGRAM_BOT_TOKEN). */
  tokenSet: boolean;
  /** The kinds turned on, and since when. */
  kindsOn: PeopleMessageKindsOn;
}

export type MessageDecision =
  | { send: true; chatId: string; topicId: number | null }
  | { send: false; reason: HeldReason };

/** Where Telegram is told to put it; null — nowhere it can reach. */
export function destinationOf(recipient: MessageRecipient): { chatId: string; topicId: number | null } | null {
  if (recipient.kind === "person") return recipient.telegramUserId === null ? null : { chatId: String(recipient.telegramUserId), topicId: null };
  return recipient.chat === null ? null : { chatId: recipient.chat.chatId, topicId: recipient.chat.topicId };
}

/**
 * Send, or held and why. The order says the most useful reason first: a recipient
 * Telegram cannot reach, the day's cap, the kind off, an event before it was turned
 * on, no token. Every reason but the last two holds a message whatever the locks.
 */
export function decideMessage(candidate: MessageCandidate, locks: MessageLocks, cap: { used: number; max: number }): MessageDecision {
  const destination = destinationOf(candidate.recipient);
  if (destination === null) return { send: false, reason: candidate.recipient.kind === "person" ? "no_telegram" : "no_chat" };
  if (cap.used >= cap.max) return { send: false, reason: "cap" };
  const onSince = locks.kindsOn[candidate.kind];
  if (onSince === undefined) return { send: false, reason: "kind_off" };
  if (candidate.eventAt.getTime() < onSince.getTime()) return { send: false, reason: "before_on" };
  if (!locks.tokenSet) return { send: false, reason: "no_token" };
  return { send: true, ...destination };
}

/** The last guard before the transport: throws when either lock is open or nobody can get it. */
export function assertSendable(candidate: Pick<MessageCandidate, "kind" | "eventAt">, locks: MessageLocks, token: string | null | undefined, chatId: string | null): asserts token is string {
  if (!locks.tokenSet || token === null || token === undefined || token === "") throw new Error("people messages: no bot token, nothing may leave");
  const onSince = locks.kindsOn[candidate.kind];
  if (onSince === undefined || candidate.eventAt.getTime() < onSince.getTime()) throw new Error(`people messages: ${candidate.kind} is not on for this event`);
  if (chatId === null || chatId === "") throw new Error("people messages: no recipient");
}

const MOSCOW_OFFSET_MS = 3 * 3_600_000;

/** The Moscow hour of a moment (Moscow keeps +03:00 all year). */
export function moscowHour(at: Date): number {
  return new Date(at.getTime() + MOSCOW_OFFSET_MS).getUTCHours();
}

/** 23:00–10:00 Moscow time: the people's night, no personal reminder is made. */
export function inQuietHours(at: Date): boolean {
  const hour = moscowHour(at);
  return hour >= PEOPLE_MESSAGE_QUIET_FROM_HOUR || hour < PEOPLE_MESSAGE_QUIET_TO_HOUR;
}

/** The Moscow day a moment is in, as [start, end). */
export function moscowDayOf(at: Date): { from: Date; to: Date } {
  const shifted = new Date(at.getTime() + MOSCOW_OFFSET_MS);
  const start = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - MOSCOW_OFFSET_MS;
  return { from: new Date(start), to: new Date(start + 86_400_000) };
}

/** An invitation's one-time link is not kept: the stored text says where it was. */
export function withoutJoinSecret(text: string): string {
  return text.replace(/(\/join)#[A-Za-z0-9_\-.~%]+/gu, "$1#‹ссылка не хранится›");
}

export const HELD_WORDS: Readonly<Record<HeldReason, string>> = {
  kind_off: "задержано: вид выключен",
  no_token: "задержано: нет токена бота",
  no_telegram: "задержано: у человека нет Telegram id в реестре",
  no_chat: "задержано: для модели не задан чат",
  cap: "задержано: больше дневного предела этому получателю",
  before_on: "задержано: событие было до включения вида",
};

export const STATE_WORDS: Readonly<Record<"sending" | "sent" | "failed" | "unknown", string>> = {
  sending: "отправляется",
  sent: "отправлено",
  failed: "не ушло: Telegram отказал",
  unknown: "неизвестно, ушло ли: не повторяется само",
};
