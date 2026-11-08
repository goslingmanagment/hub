/**
 * Команда → «Разбор смены» (owner, 2026-11-06): one chatter's shift, opened up.
 * The pulse of the shift minute by minute, every chat it touched with the whole
 * transcript, and what is known of each of the chatter's messages: which AI text
 * it came from, how long the fan had waited, whether the same text went to other
 * fans. Facts only, no grades: the owner reads them.
 *
 * Owner session only: it carries the AI's own texts (prompt content).
 *
 * The shift is services/chatter-shifts.ts's; the author of a message is
 * `client_send_attributions`; a mass message is the one of `teamChatterNumbers`
 * (a Fansly mass message, or one text with its price and files sent to
 * MASS_SEND_MIN_CHATS chats of a page or more in a clock hour). A wait runs from
 * the fan's first message after the page's last personal one to the next
 * personal one, any author's, as in the «Обучалка» shift audit.
 */
import { z } from "zod";

import { errorResponseSchema, intId, isoDateTime, isoTimestamp, mills } from "./primitives.ts";

const count = z.number().int().nonnegative();

/** An AI text counts as the source of a message when this share of the message's words comes straight from it. */
export const SHIFT_REVIEW_AI_SHARE = 0.7;
/** An AI text is looked for this long before the message (the study of 2026-10-29). */
export const SHIFT_REVIEW_AI_LOOKBACK_MINUTES = 90;
/** Messages shown before the shift's start in each chat, for context. */
export const SHIFT_REVIEW_CONTEXT_MESSAGES = 8;
/** A fan's message older than this before a reply is not waited on (as `teamChatterNumbers`). */
export const SHIFT_REVIEW_WAIT_HORIZON_HOURS = 72;
/** The person's previous and next shift are looked for this far from the shift. */
export const SHIFT_REVIEW_NEIGHBOUR_DAYS = 14;

export const SHIFT_REVIEW_ORIGINS = ["ai", "fix", "own"] as const;
export const SHIFT_REVIEW_MARKS = ["dash", "cyrillic", "leak"] as const;
export const SHIFT_REVIEW_AUTHORS = ["me", "other", "none", "auto"] as const;

export const teamShiftReviewQuerySchema = z.object({
  userId: z.coerce.number().int().positive(),
  /** A moment inside the shift; «Смены» gives its start. */
  at: isoDateTime({ offset: true }),
});

const shiftReviewMineSchema = z.object({
  /** What the extension said: hand, reply, fix, hi, ping, coach, unknown; null from an older client. */
  composedWith: z.string().nullable(),
  /** Changed in the composer after an AI text was put there; null when the extension did not say. */
  edited: z.boolean().nullable(),
  /**
   * `ai` — at least SHIFT_REVIEW_AI_SHARE of the words come from an AI text of this chat (a Fix whose draft was a
   * command, not a text, is the AI's too); `fix` — the chatter's own draft run through Fix (translated, polished);
   * `own` — no AI text of the chat holds it. Null: a message with no words (media, emoji).
   */
  origin: z.enum(SHIFT_REVIEW_ORIGINS).nullable(),
  /** The share of the words that come from the closest AI text, 0–1; null without words or AI texts. */
  aiShare: z.number().nullable(),
  /** That AI text's feature (fast-reply, improve-draft, coach-chat, ping, hi-greeting) and its words. */
  aiFeature: z.string().nullable(),
  aiText: z.string().nullable(),
  /** A Fix's draft: what the chatter typed before Fix. */
  draft: z.string().nullable(),
  /** Seconds the fan had waited (from the shift's start at most) when this message answered them; null — no one waited. */
  replySeconds: count.nullable(),
  /** Other chats the chatter sent the same text to in this shift. */
  repeats: count,
  /** `dash` — a long dash (an AI tell), `cyrillic` — Russian letters to a fan who writes none, `leak` — the AI's service text. */
  marks: z.array(z.enum(SHIFT_REVIEW_MARKS)),
});

const shiftReviewMessageSchema = z.object({
  ref: z.string(),
  at: isoTimestamp,
  side: z.enum(["fan", "page"]),
  /** The plain text, at most 2,000 characters. */
  text: z.string(),
  /** A PPV's price; null — not priced. */
  priceMills: mills.nullable(),
  /** A PPV: bought; null — not a PPV. */
  bought: z.boolean().nullable(),
  /** A fan's tip with the message. */
  tipMills: mills.nullable(),
  media: count,
  /** Within the shift; the rest is the context before it. */
  inShift: z.boolean(),
  /**
   * A page message: whose. `none` — no author reported; `auto` — no author and the text of one of the pages'
   * automated messages. Null for a fan's message.
   */
  by: z.enum(SHIFT_REVIEW_AUTHORS).nullable(),
  /** A page message sent as a mass message (a Fansly one, or a burst): it answers nobody. */
  mass: z.boolean(),
  /** `other`: the colleague's name. */
  byName: z.string().nullable(),
  /** The chatter's own message in the shift. */
  mine: shiftReviewMineSchema.nullable(),
});

const shiftReviewChatSchema = z.object({
  /** `<page label>:<conversation ref>`. */
  key: z.string(),
  pageLabel: z.string(),
  platform: z.string(),
  conversationRef: z.string(),
  fanRef: z.string().nullable(),
  fanUsername: z.string().nullable(),
  fanDisplayName: z.string().nullable(),
  /** The fan's net on this page, all time; null — Hub knows none. */
  fanLifetimeNetMills: mills.nullable(),
  /** The fan's net on this page within the shift (any author's sale). */
  shiftNetMills: mills,
  /** Messages before the shift that are not sent (only the last SHIFT_REVIEW_CONTEXT_MESSAGES are). */
  earlierHidden: count,
  /** Oldest first. */
  messages: z.array(shiftReviewMessageSchema),
});

export const teamShiftReviewResponseSchema = z.object({
  shift: z.object({
    userId: intId,
    username: z.string(),
    kind: z.enum(["shift", "visit"]),
    startedAt: isoTimestamp,
    endedAt: isoTimestamp,
    /** As «Смены»: under CHATTER_SHIFT_END_IDLE_MINUTES since its last action, a break included. */
    ongoing: z.boolean(),
    workedMinutes: count,
    /** A break going on now is one too, up to the hub's now. */
    pauses: z.array(z.object({ from: isoTimestamp, to: isoTimestamp })),
    /** The start of the shift's last minute with an action. */
    lastInputAt: isoTimestamp,
    /** The start of its last minute the extension beat in: older than CLIENT_ACTIVITY_LOST_MINUTES — closed or offline. */
    lastBeatAt: isoTimestamp,
    /**
     * The pages of the shift, most messages first: `messages` — the person's there; `worked` — the shift works the page
     * (CHATTER_SHIFT_PAGE_MIN_MESSAGES or more, as «Смены», going on or over), its fans' chats are in `chats`; a page only
     * looked at, and every page of a look-in, brings in just the chats the person wrote in.
     */
    pages: z.array(z.object({ pageLabel: z.string(), platform: z.string(), messages: count, worked: z.boolean() })),
    /**
     * The shift's sales, net, as «Смены → Заработок» settles them: the sales on its pages while it held them
     * (`salesHeldBy`), less those a colleague's overlapping shift held too when the colleague last wrote to the fan.
     */
    salesNetMills: mills,
  }),
  /** The person's shifts just before and after, within SHIFT_REVIEW_NEIGHBOUR_DAYS; their start. */
  previousAt: isoTimestamp.nullable(),
  nextAt: isoTimestamp.nullable(),
  /** The minutes the extension beat on the shift's pages; `input` — the person did something in one of them. A minute missing — closed. */
  activity: z.array(z.object({ at: isoTimestamp, input: z.boolean() })),
  chats: z.array(shiftReviewChatSchema),
  /**
   * Every wait that overlaps the shift, cut to it: `since` is when the fan really started waiting. `by` — who ended it
   * (`me`, `other`, `none` — a message without an author); null — still waiting at the shift's end.
   */
  waits: z.array(z.object({
    chat: z.string(),
    since: isoTimestamp,
    from: isoTimestamp,
    to: isoTimestamp,
    by: z.enum(["me", "other", "none"]).nullable(),
  })),
  /** The chatter's messages of the shift the archive does not hold yet (no text, not in `chats`). */
  unarchived: count,
  /** The chatter's messages of the shift deleted after they were sent (not in `chats`). */
  deleted: count,
  serverNow: isoTimestamp,
});

export type TeamShiftReviewQuery = z.infer<typeof teamShiftReviewQuerySchema>;
export type TeamShiftReviewResponse = z.infer<typeof teamShiftReviewResponseSchema>;
export type ShiftReviewChat = z.infer<typeof shiftReviewChatSchema>;
export type ShiftReviewMessage = z.infer<typeof shiftReviewMessageSchema>;
export type ShiftReviewMine = z.infer<typeof shiftReviewMineSchema>;

export const shiftReviewRouteSchemas = {
  teamShiftReview: {
    auth: { kind: "owner-session" },
    tags: ["client"],
    summary: "One chatter's shift opened up: its pulse, every chat, and where each message's text came from",
    description: "The owner only; read-only, database only. The shift of `userId` that holds `at` (a shift or a look-in), "
      + "its activity minutes, every chat where the chatter wrote within it and, on the pages it worked, every chat where the "
      + "fan wrote within it or was waiting at its start, with the messages of the shift and the last few before it, and the waits that overlap it. Each of "
      + "the chatter's messages carries the closest AI text of its chat and the share of its words taken from it. "
      + "404 when the person has no shift there.",
    querystring: teamShiftReviewQuerySchema,
    response: {
      200: teamShiftReviewResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
} as const;
