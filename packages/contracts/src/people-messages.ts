import { PEOPLE_MESSAGE_KINDS } from "@agency_hub_core/shared";
import { z } from "zod";

/**
 * Система → «Сообщения людям» (ecosystem plan 2026-11-12, package S): the
 * server's own sender of messages to people in Telegram, off twice — no bot
 * token, no kind on. The owner's screen shows each kind, its exact template, an
 * example from the newest real object, whether it is on, and the messages held
 * in the last 7 days word for word. A message's states: `held` (nothing left
 * the server), `sending` (the one attempt is under way), `sent`, `failed`,
 * `unknown` (the attempt did not say: never repeated by itself).
 */

export const peopleMessageKindSchema = z.enum(PEOPLE_MESSAGE_KINDS);
export const peopleMessageStateSchema = z.enum(["held", "sending", "sent", "failed", "unknown"]);
export type PeopleMessageState = z.infer<typeof peopleMessageStateSchema>;

/** Why a message was held: the kind off, no token, no recipient, the day's cap, an event before the kind was turned on. */
export const peopleMessageHeldReasonSchema = z.enum(["kind_off", "no_token", "no_telegram", "no_chat", "cap", "before_on"]);
export type PeopleMessageHeldReason = z.infer<typeof peopleMessageHeldReasonSchema>;

/** Who a kind writes to: a work chat's topic, a person, a person on the owner's press. */
export const peopleMessageAudienceSchema = z.enum(["group", "person", "press"]);

export const peopleMessageRowSchema = z.object({
  id: z.number().int(),
  at: z.string(),
  /** To whom, in words: «Lora · Отчётность», «Мирон». */
  to: z.string(),
  /** What it is about, in words: «смена 11 нояб., 18:14–02:36», «заказ K-12». */
  about: z.string(),
  text: z.string(),
  state: peopleMessageStateSchema,
  reason: peopleMessageHeldReasonSchema.nullable(),
  /** The state and its reason in a sentence. */
  words: z.string(),
});
export type PeopleMessageRow = z.infer<typeof peopleMessageRowSchema>;

export const peopleMessageKindViewSchema = z.object({
  kind: peopleMessageKindSchema,
  title: z.string(),
  audience: peopleMessageAudienceSchema,
  /** To whom, in words. */
  toWhom: z.string(),
  /** When it fires, in words. */
  when: z.string(),
  /** The template: the exact text with its places in «‹…›». */
  template: z.string(),
  /** Rendered from the newest real object; null — none yet (`exampleMissing` says why). */
  example: z.object({ text: z.string(), about: z.string() }).nullable(),
  exampleMissing: z.string().nullable(),
  on: z.boolean(),
  onSince: z.string().nullable(),
  /** The newest turn on or off: when and by whom (the config's audit). */
  lastSwitch: z.object({ at: z.string(), by: z.string(), on: z.boolean() }).nullable(),
  /** `not_connected`: the kind and its words are here, the event that fires it comes with its package. */
  trigger: z.enum(["ready", "not_connected"]),
  triggerNote: z.string().nullable(),
  cap: z.number().int(),
  capWords: z.string(),
  quietWords: z.string(),
  /** What turning it on needs besides the switch (the token, the chats, the person writing to the bot first). */
  needs: z.array(z.string()),
  /** What starts happening when it is turned on. */
  onSentence: z.string(),
  /** What keeps it from anybody now: «нет чата: ‹модель›». */
  blockedFor: z.array(z.string()),
  counts: z.object({ held: z.number().int(), sent: z.number().int(), failed: z.number().int(), unknown: z.number().int() }),
  /** The last held messages of the 7 days, newest first, word for word. */
  held: z.array(peopleMessageRowSchema),
});
export type PeopleMessageKindView = z.infer<typeof peopleMessageKindViewSchema>;

export const peopleMessagesResponseSchema = z.object({
  /** Whether the bot token is set; its value is never here. */
  tokenSet: z.boolean(),
  /** «Отправка невозможна: нет токена» or what the token means now. */
  sentence: z.string(),
  /** The kinds setting's version, for the next switch; null — never written. */
  kindsVersion: z.number().int().nullable(),
  chats: z.array(z.object({ modelSlug: z.string(), modelName: z.string(), reports: z.boolean(), customs: z.boolean() })),
  kinds: z.array(peopleMessageKindViewSchema),
  serverNow: z.string(),
});
export type PeopleMessagesResponse = z.infer<typeof peopleMessagesResponseSchema>;

export const peopleMessageKindParamsSchema = z.object({ kind: peopleMessageKindSchema });

export const peopleMessageSwitchBodySchema = z.object({
  on: z.boolean(),
  /** The kinds setting's version the screen read; a change in between is 409. */
  expectedVersion: z.number().int().nonnegative().optional(),
});
export type PeopleMessageSwitchBody = z.infer<typeof peopleMessageSwitchBodySchema>;

export const peopleMessageSwitchResponseSchema = z.object({
  kind: peopleMessageKindSchema,
  on: z.boolean(),
  onSince: z.string().nullable(),
  /** What starts (or stops) happening now. */
  sentence: z.string(),
  kindsVersion: z.number().int(),
  audit: z.object({ at: z.string(), by: z.string() }),
});
export type PeopleMessageSwitchResponse = z.infer<typeof peopleMessageSwitchResponseSchema>;

/** The kinds the owner sends by a press: the payout text, the invitation. */
export const peopleMessagePressKindSchema = z.enum(["payout.text", "newcomer.invite"]);

export const peopleMessagePressBodySchema = z.object({
  kind: peopleMessagePressKindSchema,
  /** The person by registry code (the payout panel) … */
  person: z.string().trim().min(1).max(63).optional(),
  /** … or by login (the invitation). */
  userId: z.number().int().positive().optional(),
  /** The text the screen shows beside its «Скопировать»: what is sent. */
  text: z.string().trim().min(1).max(4000),
});
export type PeopleMessagePressBody = z.infer<typeof peopleMessagePressBodySchema>;

export const peopleMessagePressResponseSchema = z.object({
  /** The message's row; null — the same message was already made (`duplicate`). */
  id: z.number().int().nullable(),
  state: z.union([peopleMessageStateSchema, z.literal("duplicate")]),
  reason: peopleMessageHeldReasonSchema.nullable(),
  words: z.string(),
});
export type PeopleMessagePressResponse = z.infer<typeof peopleMessagePressResponseSchema>;
