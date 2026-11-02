import { z } from "zod";

import { businessDate, intId, isoTimestamp, mills } from "./primitives.ts";

// A chatter's own statistics (the cabinet's «Статистика»): the money of their
// actual shifts, how they write and sell, their records. One read, database
// only; the same body for the owner's and a team lead's view of a chatter.
//
// The money of a shift is the net of the sales on a page the chatter had open
// in the extension while the shift went on — a guide, not a basis for pay:
// what a sale pays whom is the confirmed shift report's (Chat Memory week 4).
// A sale when another chatter, in their own shift, had the page open too is
// counted for both and marked: Hub does not split it.

const count = z.number().int().nonnegative();

/** The longest window of the statistics, Moscow days. */
export const CHATTER_STATS_MAX_DAYS = 31;

/**
 * How the cabinet groups a sale: `ppv` — a message purchase, `tip` — a tip or
 * a stream tip, `subscription`, `post` — a post purchase.
 */
export const CHATTER_SALE_KINDS = ["ppv", "tip", "subscription", "post"] as const;
export type ChatterSaleKind = (typeof CHATTER_SALE_KINDS)[number];

const byKindSchema = z.object({ ppv: mills, tip: mills, subscription: mills, post: mills });

export const accountChatterStatsQuerySchema = z.object({
  /** Whole Moscow days back from today, today included. */
  days: z.coerce.number().int().min(1).max(CHATTER_STATS_MAX_DAYS).default(7),
});

export const teamChatterStatsQuerySchema = accountChatterStatsQuerySchema.extend({
  /** The chatter to show; absent or not among `people` — the first of them. */
  userId: z.coerce.number().int().positive().optional(),
});

const periodTotalsSchema = z.object({
  shifts: count,
  workedMinutes: count,
  salesNetMills: mills,
  sales: count,
  /** `salesNetMills` per worked hour; null without worked time. */
  perHourMills: mills.nullable(),
});

const statsSaleSchema = z.object({
  at: isoTimestamp,
  netMills: mills,
  kind: z.enum(CHATTER_SALE_KINDS),
  pageLabel: z.string(),
  fanName: z.string().nullable(),
  /** Another chatter, in their own shift, had the page open too. */
  overlap: z.boolean(),
});

export const chatterStatsSchema = z.object({
  user: z.object({ userId: intId, username: z.string() }),
  days: count,
  /** The start of the window's first Moscow day. */
  from: isoTimestamp,
  to: isoTimestamp,
  /** The chatter's first minute in the extension Hub knows; null — none. Before it shifts are unknown, never zero. */
  activitySince: isoTimestamp.nullable(),
  totals: periodTotalsSchema.extend({
    /** Of `salesNetMills`: sales when another chatter, in their own shift, had the page open too. */
    overlapNetMills: mills,
    byKind: byKindSchema,
    /** Credited by the confirmed shift reports of the window's shifts. */
    confirmedNetMills: mills,
    /** Ended shifts no confirmed report holds yet. */
    unconfirmedShifts: count,
    /** Messages with the chatter as their author. */
    messages: count,
    /** Fans the chatter wrote to in a shift; of them, who paid on that page after it, before the shift's end. */
    fansWritten: count,
    fansPaid: count,
  }),
  /** The window of the same length just before; null when Hub does not have the chatter's activity for all of it. */
  previous: periodTotalsSchema.nullable(),
  /** Every Moscow day of the window, the oldest first: the shifts that began on it and their money. */
  daily: z.array(z.object({
    date: businessDate,
    salesNetMills: mills,
    byKind: byKindSchema,
    shifts: count,
    workedMinutes: count,
  })),
  /**
   * The shifts that began in the window, the newest first: the actual shifts (by the extension) as a person counts
   * them — two less than an hour apart are one, the gap a pause; under 15 minutes of work with no sale is a visit,
   * not a shift, and is left out.
   */
  shifts: z.array(z.object({
    startedAt: isoTimestamp,
    endedAt: isoTimestamp,
    ongoing: z.boolean(),
    workedMinutes: count,
    pauses: z.array(z.object({ from: isoTimestamp, to: isoTimestamp })),
    /** The pages the chatter was active on, the most active first. */
    pages: z.array(z.string()),
    salesNetMills: mills,
    overlapNetMills: mills,
    /** Who else was in their shift on a page of this one when a sale came. */
    together: z.array(z.string()),
    messages: count,
    /** Of `messages`: with a price. */
    ppvSent: count,
    fansWritten: count,
    fansPaid: count,
    /** Credited by the confirmed report that holds the shift; null — not confirmed. */
    confirmedNetMills: mills.nullable(),
    sales: z.array(statsSaleSchema),
  })),
  /** The pages of the window's shifts, the most money first. */
  pages: z.array(z.object({
    pageLabel: z.string(),
    platform: z.string(),
    salesNetMills: mills,
    sales: count,
    activeMinutes: count,
  })),
  /** Personal PPVs sent in the window (not a mass message, not a burst): the chatter's, and the team's on the same pages beside them. */
  ppv: z.object({
    sent: count,
    bought: count,
    netMills: mills,
    byPrice: z.array(z.object({ bucket: z.string(), sent: count, bought: count, netMills: mills, teamSent: count, teamBought: count })),
  }),
  /** Replies to a waiting fan and whether the fan bought within 24 hours: the chatter's, and the team's on the same pages. */
  replies: z.object({
    /** Replies up to here: a day before now, so each one's day for a purchase is over. */
    to: isoTimestamp,
    replies: count,
    bought: count,
    byDelay: z.array(z.object({ bucket: z.string(), replies: count, bought: count, teamReplies: count, teamBought: count })),
  }),
  /** How the chatter's messages were written: by hand, Reply, Fix, a greeting (Hi, Ping), anything else. */
  composed: z.object({ hand: count, reply: count, fix: count, greet: count, other: count }),
  /** The fans who brought the most in the chatter's shifts, up to five. */
  topFans: z.array(z.object({ fanName: z.string().nullable(), pageLabel: z.string(), netMills: mills, sales: count })),
  records: z.object({
    bestShift: z.object({ startedAt: isoTimestamp, salesNetMills: mills }).nullable(),
    bestDay: z.object({ date: businessDate, salesNetMills: mills }).nullable(),
    biggestSale: statsSaleSchema.omit({ overlap: true }).nullable(),
    /** Moscow days in a row with a shift, up to today (or up to yesterday while today has none yet). */
    streakDays: count,
    /** The longest such run in this window and the one before it. */
    longestStreakDays: count,
  }),
  serverNow: isoTimestamp,
});

export const teamChatterStatsResponseSchema = z.object({
  /** The chatters active on the viewer's pages in the last CHATTER_STATS_MAX_DAYS days. */
  people: z.array(z.object({ userId: intId, username: z.string() })),
  /** The chosen chatter's statistics, on their pages the viewer reaches; null — nobody to show. */
  stats: chatterStatsSchema.nullable(),
  serverNow: isoTimestamp,
});

export type AccountChatterStatsQuery = z.infer<typeof accountChatterStatsQuerySchema>;
export type TeamChatterStatsQuery = z.infer<typeof teamChatterStatsQuerySchema>;
export type ChatterStats = z.infer<typeof chatterStatsSchema>;
export type TeamChatterStatsResponse = z.infer<typeof teamChatterStatsResponseSchema>;
