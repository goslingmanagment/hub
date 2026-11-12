import { z } from "zod";

import { CHATTER_SALE_KINDS } from "./chatter-stats.ts";
import { personCodeSchema } from "./people.ts";
import { errorResponseSchema, isoDateTime, isoTimestamp, mills } from "./primitives.ts";
import { teamShiftReviewResponseSchema } from "./routes-shift-review.ts";

/**
 * The agents' ready reads (ecosystem plan §3.3, package M1): what the agents'
 * scripts computed over `ssh … psql` from Hub's database, served to an agent
 * key from the one computation Hub already has.
 *
 * - `agentShiftReview` — «Разбор смены» (Workboard's) for one shift, and the
 *   «Обучалка» shift audit's numbers counted from it (`shiftAuditNumbers`).
 *   Needs read:team and read:money; message texts with read:messages too. The
 *   AI's own texts (`aiText`, `draft`) stay the owner's: never in this answer.
 * - `agentFanWatch` — the fan watch: a watched fan's new messages on a page
 *   and when the page last wrote to them. Needs read:messages; tips with
 *   read:money too.
 * - `agentSaleContext` — the report check: each sale's fan, the PPV it
 *   bought (its text with read:messages), who wrote to the fan before it.
 *   Needs read:team and read:money.
 *
 * Every page they read is one of the key's; a page outside its grant is the
 * plane's static 404.
 */

const count = z.number().int().nonnegative();

export const agentShiftReviewQuerySchema = z.object({
  /** A moment inside the shift. */
  at: isoDateTime({ offset: true }),
  /** The login (Hub user id) whose shift it is … */
  userId: z.coerce.number().int().positive().optional(),
  /** … or the person's code (people registry): their login whose shift holds `at`. */
  person: personCodeSchema.optional(),
}).superRefine((query, context) => {
  if ((query.userId === undefined) === (query.person === undefined)) {
    context.addIssue({ code: "custom", path: ["userId"], message: "give exactly one of `userId` and `person`" });
  }
});

const auditNumbersShape = {
  chats: count,
  messages: count,
  fanMessages: count,
  massMessages: count,
  unauthored: count,
  others: z.array(z.object({ name: z.string(), messages: count })),
  ppvSent: count,
  ppvBought: count,
  replies: count,
  replyMedianSeconds: z.number().nonnegative().nullable(),
  repliesOver15: count,
  longestReplySeconds: count.nullable(),
  longestReplyChat: z.string().nullable(),
  waitingAtStart: count,
  waitingAtStartWritten: count,
  waitingAtEnd: count,
  fanUnattended: count,
  follows: count,
  followsWritten: count,
  followsWrittenSoon: count,
  reactivations: count,
  reactivationsAnswered: count,
  salesNetMills: mills,
  tipsNetMills: mills,
  subscriptionsNetMills: mills,
  ppvPurchases: count,
  ai: z.record(z.string(), count),
};

/** `shiftAuditNumbers` on the wire: by page and in total. */
export const shiftAuditReportSchema = z.object({
  pages: z.array(z.object({ pageLabel: z.string(), ...auditNumbersShape })),
  total: z.object(auditNumbersShape),
});

export const agentShiftReviewResponseSchema = z.object({
  /**
   * The review as the owner's screen reads it, on the key's pages only. Without read:messages every message's `text`
   * is empty; `mine.aiText` and `mine.draft` are always null here.
   */
  review: teamShiftReviewResponseSchema,
  /** The shift audit's numbers, counted from `review` (`shiftAuditNumbers`). */
  numbers: shiftAuditReportSchema,
  /** The messages' texts are in `review` (the key holds read:messages). */
  texts: z.boolean(),
  /** Pages the shift worked or wrote on that the key does not reach: left out of `review` and `numbers`. */
  pagesLeftOut: z.array(z.string()),
});

const usernameSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, "a platform username: letters, digits, _ . -");

/** At most this many of the fan's messages per watch in one answer. */
export const AGENT_FAN_WATCH_MESSAGES_MAX = 200;

export const agentFanWatchBodySchema = z.object({
  watches: z.array(z.object({
    pageLabel: z.string().min(1).max(200),
    /** The fan's username on the platform (case does not matter). */
    username: usernameSchema,
    /** The watch's start: the fan's messages after it. */
    since: isoDateTime({ offset: true }),
    /**
     * The newest `archivedAt` already seen: only messages the archive took after it (the watch's progress). Compared at
     * the archive's own precision (microseconds): the message that set the mark never comes back.
     */
    archivedAfter: isoDateTime({ offset: true }).optional(),
  }).strict()).min(1).max(50),
}).strict();

export const agentFanWatchResponseSchema = z.object({
  watches: z.array(z.object({
    pageLabel: z.string(),
    username: z.string(),
    /** The fan's chats on the page by that username; 0 — none (the watch names nobody there). */
    chats: count,
    /** The fan's messages after `since` the archive took after `archivedAfter`, oldest first, deleted ones left out. */
    fanMessages: z.array(z.object({
      ref: z.string(),
      at: isoTimestamp,
      /** When the archive took it, to the microsecond (`2026-11-12T01:25:24.972892Z`): the next `archivedAfter`. */
      archivedAt: isoTimestamp,
      /** Empty without read:messages. At most 2,000 characters. */
      text: z.string(),
      media: z.boolean(),
      /** A tip with the message; null — none, or the key lacks read:money. */
      tipMills: mills.nullable(),
    })),
    /** More messages than AGENT_FAN_WATCH_MESSAGES_MAX: ask again from the last `archivedAt`. */
    more: z.boolean(),
    /** The page's newest message in those chats, any time; null — none. */
    pageLastAt: isoTimestamp.nullable(),
  })),
  serverNow: isoTimestamp,
});

const saleRequestSchema = z.union([
  /** Hub's own id of the sale (`saleRef` of the review, `transactionRef` of `agentTeamSales`). */
  z.object({ saleRef: z.string().regex(/^\d{1,19}$/) }).strict(),
  /** The platform's transaction id on a page (`transactionRef` of the `transactions` dataset). */
  z.object({ pageLabel: z.string().min(1).max(200), transactionRef: z.string().min(1).max(200) }).strict(),
]);

export const agentSaleContextBodySchema = z.object({
  sales: z.array(saleRequestSchema).min(1).max(500),
}).strict();

const writerSchema = z.object({ name: z.string(), messages: count });

/**
 * The fan's chat as the shift report check has read the archive since before Hub's own facts (`ppv`, `writers7d`,
 * `lastWriter`), so the check keeps every number when it leaves `ssh … psql`: the fan's latest chat on the page by the
 * fan's platform id, and in it the page's messages that are not deleted. Facts, no rule: the check decides with them.
 */
const saleArchiveSchema = z.object({
  /** The fan's latest chat on the page (by its last message); null — the fan has none there, and the rest is empty. */
  conversationRef: z.string().nullable(),
  /** That chat's partner name; null — none recorded. */
  partnerUsername: z.string().nullable(),
  /** The name of Hub's fan record with the fan's platform id; null — none. */
  fanRecordUsername: z.string().nullable(),
  /** Every name the fan has in the page's chats, in the database's own order (its collation): the greatest is last. */
  partnerUsernames: z.array(z.string()),
  /**
   * A PPV purchase: the page's latest message in that chat priced at the sale's gross and sent at or before it; null —
   * not a purchase of a message, or no such message.
   */
  pricedMessage: z.object({
    sentAt: isoTimestamp,
    /** Its author's login; null — sent without an author. */
    sender: z.string().nullable(),
    /** Its text, at most 2,000 characters; null — without read:messages. */
    text: z.string().nullable(),
  }).nullable(),
  /**
   * The page's messages in that chat in the 7 days before the sale, by author (`name` null — no author), most first,
   * then by name in the database's order with no author last.
   */
  pageMessages7d: z.array(z.object({ name: z.string().nullable(), messages: count })),
  /** The page's latest message with an author in that chat in the 60 days before the sale: who, when, within 48 hours. */
  lastAuthored60d: z.object({ name: z.string(), at: isoTimestamp, within48h: z.boolean() }).nullable(),
});

export const agentSaleContextResponseSchema = z.object({
  /** The sales found on the key's pages, oldest first. */
  sales: z.array(z.object({
    saleRef: z.string(),
    pageLabel: z.string(),
    /** The platform's transaction id. */
    transactionRef: z.string(),
    kind: z.enum(CHATTER_SALE_KINDS),
    occurredAt: isoTimestamp,
    grossMills: mills,
    netMills: mills,
    fanRef: z.string().nullable(),
    /** The fan's name in the page's chat, else Hub's fan record. */
    fanUsername: z.string().nullable(),
    /** The PPV the fan bought (Hub's match: `agentTeamSales`'s); null — not a PPV, or its message not found. */
    ppv: z.object({
      sentAt: isoTimestamp.nullable(),
      /** Its sender's login; null — sent without an author. */
      sender: z.string().nullable(),
      /** Its text, at most 2,000 characters; null — without read:messages, or the archive holds none. */
      text: z.string().nullable(),
    }).nullable(),
    postTip: z.boolean(),
    campaign: z.boolean(),
    /** Who wrote to the fan on the page in the 48 hours (Hub's rule) and in the 7 days before the sale, most messages first. */
    writers48h: z.array(writerSchema),
    writers7d: z.array(writerSchema),
    /** Who last wrote to the fan in the 60 days before it, when, and whether within 48 hours; null — nobody with an author. */
    lastWriter: z.object({ name: z.string(), at: isoTimestamp, within48h: z.boolean() }).nullable(),
    /** The fan's chat in the archive, as the shift report check reads it. */
    archive: saleArchiveSchema,
  })),
  /** Requested sales not found on the key's pages (unknown, or on a page the key does not reach), as asked. */
  notFound: z.array(saleRequestSchema),
  serverNow: isoTimestamp,
});

export type AgentShiftReviewQuery = z.infer<typeof agentShiftReviewQuerySchema>;
export type AgentShiftReviewResponse = z.infer<typeof agentShiftReviewResponseSchema>;
export type AgentFanWatchBody = z.infer<typeof agentFanWatchBodySchema>;
export type AgentFanWatchResponse = z.infer<typeof agentFanWatchResponseSchema>;
export type AgentSaleContextBody = z.infer<typeof agentSaleContextBodySchema>;
export type AgentSaleContextResponse = z.infer<typeof agentSaleContextResponseSchema>;

const agentErrors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema,
  429: errorResponseSchema, 503: errorResponseSchema,
} as const;

export const agentDoorRouteSchemas = {
  agentShiftReview: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "«Разбор смены» of one shift on the key's pages and the shift audit's numbers from it (needs read:team and"
      + " read:money; texts with read:messages)",
    description: "The shift of `userId` (or of the person `person`'s login) that holds `at`, as the owner's review reads it, "
      + "cut to the key's pages; the AI's own texts are never in it. 404 when there is no shift there. Database only.",
    querystring: agentShiftReviewQuerySchema,
    response: { 200: agentShiftReviewResponseSchema, ...agentErrors },
  },
  agentFanWatch: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Watched fans' new messages on the key's pages and when the page last wrote to them (needs read:messages; tips"
      + " with read:money)",
    body: agentFanWatchBodySchema,
    response: { 200: agentFanWatchResponseSchema, ...agentErrors },
  },
  agentSaleContext: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Each sale's fan, the PPV it bought and who wrote to the fan before it, for a shift report's check (needs"
      + " read:team and read:money; the PPV's text with read:messages)",
    body: agentSaleContextBodySchema,
    response: { 200: agentSaleContextResponseSchema, ...agentErrors },
  },
} as const;
