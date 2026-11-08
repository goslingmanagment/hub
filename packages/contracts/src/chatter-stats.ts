import { z } from "zod";

import { businessDate, intId, isoTimestamp, mills } from "./primitives.ts";
import { teamShiftSchema } from "./routes-client.ts";

// A chatter's own statistics (the cabinet's «Статистика»): the money of their
// actual shifts, how they write and sell, their records. One read, database
// only; the same body for the owner's and a team lead's view of a chatter.
//
// A shift and a visit are what routes-client.ts says. The money of a shift is
// the net of the sales on the pages it worked, from the chatter's first action
// there to its end — a guide, not a basis for pay: what a sale pays whom is the
// confirmed shift report's (Chat Memory week 4). A sale another chatter's shift
// holds by the same rule is the money of who last wrote to its fan; neither
// wrote — it counts for both and is marked: Hub does not split it.
//
// From SALE_RULE_SINCE_DAY (the owner, 2026-11-08) a sale goes by the team's
// rule (runtime sale-rule.ts): a PPV a chatter sent is theirs whoever's shift
// it was bought in («долёт отправителю»), a tip under a wall post and an
// OnlyFans Campaign contribution are the общак, no shift's; the rest as above.

const count = z.number().int().nonnegative();

/** The Moscow day from which the team's rule settles a sale (owner, 2026-11-08); the weeks before keep the old one. */
export const SALE_RULE_SINCE_DAY = "2026-11-02";
/** A PPV a chatter sent, bought while they are off, waits this long for their next shift; later it is nobody's. */
export const SALE_RULE_WAIT_DAYS = 7;
/** Where a sale outside the shifts' money went: a look-in's, nobody's, the общак, or waiting for its sender's next shift. */
export const OUTSIDE_SALE_HOMES = ["visit", "nobody", "common", "waiting"] as const;

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
  /** Another chatter's shift holds it too and neither wrote to the fan: it counts for both. */
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
    /** Of `salesNetMills`: sales that count for another chatter too (`overlap`). */
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
  /** Every Moscow day of the window, the oldest first: the shifts of the day (`shifts[].date`) and their money. */
  daily: z.array(z.object({
    date: businessDate,
    salesNetMills: mills,
    byKind: byKindSchema,
    shifts: count,
    workedMinutes: count,
  })),
  /** The shifts of the window's days, the newest first. */
  shifts: z.array(z.object({
    /** The Moscow day holding most of the shift. */
    date: businessDate,
    startedAt: isoTimestamp,
    endedAt: isoTimestamp,
    ongoing: z.boolean(),
    workedMinutes: count,
    pauses: z.array(z.object({ from: isoTimestamp, to: isoTimestamp })),
    /** The pages the shift worked, the most active first. */
    pages: z.array(z.string()),
    salesNetMills: mills,
    overlapNetMills: mills,
    /** Who else a sale of this one counts for (`overlap`). */
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
  /** The window's visits, the newest first: not shifts, and not in the money above. Their sales: on the pages they wrote on, from the first action there, to a fan the chatter was the last to write to. */
  visits: z.array(z.object({
    date: businessDate,
    startedAt: isoTimestamp,
    endedAt: isoTimestamp,
    workedMinutes: count,
    messages: count,
    salesNetMills: mills,
    sales: count,
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

// ── The team's shifts and their money (teamShiftSales) ──────────────────────
//
// «Команда → Смены»: every chatter's shifts of the window with their sales, by
// the rules above, in one read for the whole team — who earned what and when,
// against the window of the same length before. A chatter's sale another
// chatter's shift holds too and neither wrote to its fan counts for both of
// them (`overlapNetMills`); the team's own totals count every sale once.

export const teamShiftSalesQuerySchema = z.object({
  /** Whole Moscow days back from today, today included. */
  days: z.coerce.number().int().min(1).max(CHATTER_STATS_MAX_DAYS).default(7),
  /**
   * The window's last Moscow day; default today. A past one shows that window
   * (a calendar week); a later one keeps today inside the window and lists the
   * days to come empty.
   */
  until: businessDate.optional(),
  /** One page only: the shifts made of the work on it, its sales. */
  pageLabel: z.string().min(1).max(120).optional(),
});

const dayMoneySchema = z.object({
  date: businessDate,
  salesNetMills: mills,
  shifts: count,
  workedMinutes: count,
});

export const teamShiftSalesResponseSchema = z.object({
  /** The start of the window's first Moscow day. */
  from: isoTimestamp,
  /** The end of its last day, or now while it goes on. */
  to: isoTimestamp,
  /** The first minute of anyone's activity Hub has; null — none. Before it shifts are unknown, never zero. */
  knownSince: isoTimestamp.nullable(),
  /** The whole team: every sale once, though two shifts hold it; a day per Moscow day of the window, the oldest first. */
  team: periodTotalsSchema.extend({ daily: z.array(dayMoneySchema) }),
  /**
   * The same for the window of the same length just before, cut at the same point
   * (this week so far against last week up to the same hour); null — Hub does not
   * have the activity for all of it.
   */
  previous: periodTotalsSchema.nullable(),
  /** Everyone with a shift in the window or the one before, the most money first. */
  chatters: z.array(periodTotalsSchema.extend({
    userId: intId,
    username: z.string(),
    /** Of `salesNetMills`: sales that count for another chatter too. */
    overlapNetMills: mills,
    /** Their window before; null — Hub did not have their activity for all of it (a newcomer, or before Hub counted). */
    previous: periodTotalsSchema.nullable(),
    daily: z.array(dayMoneySchema),
  })),
  /** The window's shifts, the newest first, with their money. */
  shifts: z.array(teamShiftSchema.extend({
    /** The Moscow day holding most of the shift. */
    date: businessDate,
    salesNetMills: mills,
    overlapNetMills: mills,
    sales: count,
  })),
  /**
   * The window's sales in no shift's money, outside the money above: `visits` — a look-in's, its person the last to
   * write to the fan (as a visit's sales); `common` — the общак (from SALE_RULE_SINCE_DAY: a tip under a wall post, a
   * Campaign contribution); `waiting` — a chatter's PPV bought while they were off, until their next shift; `nobody` —
   * the rest. By the Moscow day of the sale (one per day of the window, the oldest first) and by page (the most first),
   * and each sale, the oldest first.
   */
  outside: z.object({
    visitsNetMills: mills,
    nobodyNetMills: mills,
    commonNetMills: mills,
    waitingNetMills: mills,
    daily: z.array(z.object({ date: businessDate, visitsNetMills: mills, nobodyNetMills: mills, commonNetMills: mills, waitingNetMills: mills })),
    pages: z.array(z.object({ pageLabel: z.string(), visitsNetMills: mills, nobodyNetMills: mills, commonNetMills: mills, waitingNetMills: mills })),
    sales: z.array(z.object({
      at: isoTimestamp,
      pageLabel: z.string(),
      fanName: z.string().nullable(),
      kind: z.enum(CHATTER_SALE_KINDS),
      netMills: mills,
      /** The look-in's person; null — not a look-in's. */
      visitBy: z.string().nullable(),
      home: z.enum(OUTSIDE_SALE_HOMES),
      /** `waiting` — the chatter whose PPV it is; null otherwise. */
      waitingFor: z.string().nullable(),
    })),
  }),
  serverNow: isoTimestamp,
});

export type TeamShiftSalesQuery = z.infer<typeof teamShiftSalesQuerySchema>;
export type TeamShiftSalesResponse = z.infer<typeof teamShiftSalesResponseSchema>;
