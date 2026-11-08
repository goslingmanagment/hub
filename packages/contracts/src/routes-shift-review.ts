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

import { CHATTER_SALE_KINDS } from "./chatter-stats.ts";
import { errorResponseSchema, intId, isoDateTime, isoTimestamp, mills } from "./primitives.ts";

const count = z.number().int().nonnegative();

/** An AI text counts as the source of a message when this share of the message's words comes straight from it. */
export const SHIFT_REVIEW_AI_SHARE = 0.7;
/** An AI text is looked for this long before the message (the study of 2026-10-29). */
export const SHIFT_REVIEW_AI_LOOKBACK_MINUTES = 90;
/** Messages shown before the shift's start in each chat, for context. */
export const SHIFT_REVIEW_CONTEXT_MESSAGES = 8;
/** A PPV of the shift bought this long after it still shows with the shift (`laterSales`). */
export const SHIFT_REVIEW_LATER_SALES_DAYS = 14;
/**
 * A fan's message older than this before a reply — or, for a wait still open at the end, before the shift's start (the
 * window the review reads) — is not waited on (as `teamChatterNumbers`).
 */
export const SHIFT_REVIEW_WAIT_HORIZON_HOURS = 72;
/** The person's previous and next shift are looked for this far from the shift. */
export const SHIFT_REVIEW_NEIGHBOUR_DAYS = 14;
/**
 * A message deleted sooner than this after it was sent the other side most likely never saw (owner, 2026-11-08): a fan's
 * starts no wait, a page's answers none, and the chatter's is not counted. One deleted later counts as sent.
 */
export const SHIFT_REVIEW_DELETED_UNSEEN_SECONDS = 60;

export const SHIFT_REVIEW_ORIGINS = ["ai", "fix", "own"] as const;
export const SHIFT_REVIEW_MARKS = ["dash", "cyrillic", "leak"] as const;
export const SHIFT_REVIEW_AUTHORS = ["me", "other", "none", "auto"] as const;
export const SHIFT_REVIEW_SALE_VERDICTS = ["mine", "both", "theirs", "none"] as const;
export const SHIFT_REVIEW_SALE_ORIGINS = ["own", "colleague_ppv", "no_author_ppv", "other_wrote", "nobody_wrote_48h", "post_tip", "campaign"] as const;

export const teamShiftReviewQuerySchema = z.object({
  userId: z.coerce.number().int().positive(),
  /** A moment inside the shift; «Смены» gives its start. */
  at: isoDateTime({ offset: true }),
});

const shiftReviewMineSchema = z.object({
  /**
   * What the extension said: hand, reply, fix, hi, ping, coach, unknown; null from an older client. A later part of an AI
   * text sent in pieces (`part`) has the button its first part was sent with.
   */
  composedWith: z.string().nullable(),
  /** A later part of one AI text sent in pieces ([NEXT]) after the first went by a button: its number, from 2; absent — not one. */
  part: z.number().int().min(2).optional(),
  /** Changed in the composer after an AI text was put there; null when the extension did not say. */
  edited: z.boolean().nullable(),
  /**
   * `ai` — at least SHIFT_REVIEW_AI_SHARE of the words come from an AI text of this chat (a Fix whose draft was a
   * command, not a text, is the AI's too); `fix` — the chatter's own draft run through Fix (translated, polished);
   * `own` — no AI text of the chat holds it. Null: a message with no words (media, emoji).
   */
  origin: z.enum(SHIFT_REVIEW_ORIGINS).nullable(),
  /**
   * The share of the words that come from the closest AI text, 0–1; null without words or AI texts. For `own`, cut down
   * to the hundredth, and 0 when the two share no run of 3 words.
   */
  aiShare: z.number().nullable(),
  /**
   * That AI text's feature (fast-reply, improve-draft, coach-chat, ping, hi-greeting) and its words; for `own`, only with
   * a shared run of 3 words, or the text the extension says the chatter put in and replaced.
   */
  aiFeature: z.string().nullable(),
  aiText: z.string().nullable(),
  /** A Fix's draft: what the chatter typed before Fix. */
  draft: z.string().nullable(),
  /** `fix` of a draft the AI made far longer: the chatter's thought, the AI's words. Absent — no. */
  fixExpanded: z.boolean().optional(),
  /** Seconds the fan had waited (from the shift's start at most) when this message answered them; null — no one waited. */
  replySeconds: count.nullable(),
  /** Other chats the chatter sent the same text to in this shift; a Hi greeting (the page's A/B set) repeats nothing. */
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
  /**
   * A reported send the platform's archive does not hold: the page socket's copy (Fansly), no price. Fansly may never
   * give the archive a message of a chat it refuses or drops from sync; the fan's wait still ended then. Absent — false.
   */
  unarchived: z.boolean().optional(),
  /**
   * When the platform said the message was deleted (by the side that sent it): the text stays shown. Under
   * SHIFT_REVIEW_DELETED_UNSEEN_SECONDS after it was sent it counts for nothing. Absent — not deleted.
   */
  deletedAt: isoTimestamp.optional(),
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
  /** The fan's net on this page within the shift (any author's sale); whose each sale is — `sales`. */
  shiftNetMills: mills,
  /** Messages before the shift that are not sent (only the last SHIFT_REVIEW_CONTEXT_MESSAGES are). */
  earlierHidden: count,
  /** Oldest first. */
  messages: z.array(shiftReviewMessageSchema),
});

const shiftReviewSaleSchema = z.object({
  /** The transaction's id. */
  saleRef: z.string(),
  at: isoTimestamp,
  pageLabel: z.string(),
  fanRef: z.string().nullable(),
  fanName: z.string().nullable(),
  /** The fan's chat in `chats`; null — the fan has none there. */
  chatKey: z.string().nullable(),
  kind: z.enum(CHATTER_SALE_KINDS),
  netMills: mills,
  /**
   * Whose it is, as `salesNetMills` settles it. `mine` — the shift's; `both` — a colleague's overlapping shift holds it
   * too and neither of them was the last to write to the fan: it counts for both; `theirs` — the colleague's: they were
   * the last to write, or their shift holds it and this one does not; `none` — no shift holds it.
   */
  verdict: z.enum(SHIFT_REVIEW_SALE_VERDICTS),
  /** `theirs` — the colleague whose it is; `both` — the colleague it counts for too. */
  holderName: z.string().nullable(),
  /** Who sent the PPV the fan bought (the chatter too); null — not a PPV, its message not found, or sent without an author. */
  ppvSender: z.string().nullable(),
  /** When that PPV was sent; null — not a PPV, or its message not found. */
  ppvSentAt: isoTimestamp.nullable(),
  /** Who last wrote to the fan on the page in the 48 hours before the sale (the chatter too); null — nobody with an author. */
  lastWriter: z.string().nullable(),
  /** Everyone who wrote to the fan on the page in those 48 hours, most messages first. */
  writers: z.array(z.object({ name: z.string(), messages: count })),
  /**
   * Where it came from, facts for the reviewed chatter, not whose it is: `own` — the chatter's PPV, or the chatter wrote
   * to the fan last; `colleague_ppv` — a colleague's PPV; `no_author_ppv` — a PPV sent without an author (an old or a
   * mass one); `other_wrote` — another person wrote to the fan last; `nobody_wrote_48h` — nobody with an author wrote
   * to the fan in the 48 hours before; `post_tip` — a tip under a wall post; `campaign` — an OnlyFans Campaign
   * contribution. A PPV with a known author goes by it, whoever wrote last.
   */
  origin: z.enum(SHIFT_REVIEW_SALE_ORIGINS),
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
   * The sales on the shift's pages within it, oldest first: every one the shift holds (`mine` and `both` add up to
   * `salesNetMills`), and the rest to the fans of `chats`.
   */
  sales: z.array(shiftReviewSaleSchema),
  /**
   * Before the shift, no shift's: the sales on its pages from the person's previous shift's end (a day back at most) to
   * its start that no shift or look-in holds («вне смен» of «Смены»), to a fan the person sent the bought PPV to or was
   * the last to write to. `verdict` is `none`. Empty for a look-in.
   */
  beforeSales: z.array(shiftReviewSaleSchema),
  /**
   * After the shift: the person's PPVs sent in it that fans bought after it, within SHIFT_REVIEW_LATER_SALES_DAYS.
   * `theirs` and `holderName` — the shift that held the purchase (the person's own later one too); `none` — no shift
   * held it. Empty for a look-in.
   */
  laterSales: z.array(shiftReviewSaleSchema),
  /**
   * Every wait that overlaps the shift, cut to it: `since` is when the fan really started waiting — their first message
   * within SHIFT_REVIEW_WAIT_HORIZON_HOURS. `by` — who ended it (`me`, `other`, `none` — a message without an author);
   * null — still waiting at the shift's end. `pending` — ended by the chatter's send that neither the archive nor the
   * page's socket holds yet, at the moment the extension saw the page confirm it: the answer is still being checked.
   */
  waits: z.array(z.object({
    chat: z.string(),
    since: isoTimestamp,
    from: isoTimestamp,
    to: isoTimestamp,
    by: z.enum(["me", "other", "none"]).nullable(),
    pending: z.boolean().optional(),
  })),
  /** The chatter's messages of the shift neither the archive nor the page's socket holds yet (no text, not in `chats`). */
  unarchived: count,
  /**
   * The chatter's messages of the shift deleted after they were sent. They are in `chats` with `deletedAt`, but for
   * the ones deleted within SHIFT_REVIEW_DELETED_UNSEEN_SECONDS whose text the archive never got: those are only here.
   */
  deleted: count,
  serverNow: isoTimestamp,
});

export type TeamShiftReviewQuery = z.infer<typeof teamShiftReviewQuerySchema>;
export type TeamShiftReviewResponse = z.infer<typeof teamShiftReviewResponseSchema>;
export type ShiftReviewChat = z.infer<typeof shiftReviewChatSchema>;
export type ShiftReviewMessage = z.infer<typeof shiftReviewMessageSchema>;
export type ShiftReviewMine = z.infer<typeof shiftReviewMineSchema>;
export type ShiftReviewSale = z.infer<typeof shiftReviewSaleSchema>;
export type ShiftReviewSaleOrigin = (typeof SHIFT_REVIEW_SALE_ORIGINS)[number];

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
