/**
 * The chatters' pay as the agency ledger counts it (ledger release 2, H2):
 * what each person accrued and was paid in a window of Moscow days, and what
 * the agency owes them now. Hub keeps the facts, the ledger keeps the money
 * (owner, 2026-11-08): Hub's server reads the ledger's GET /v1/payouts with a
 * `payouts` key (LEDGER_PAYOUTS_KEY) on the owner's behalf and passes it on,
 * micro-dollars turned into mills. Owner session only: a person's pay is the
 * owner's. 503 — the ledger is not connected or did not answer.
 */
import { z } from "zod";

import { businessDate, errorResponseSchema, intId, isoTimestamp, mills } from "./primitives.ts";
import { accountReportSchema } from "./routes-account-reports.ts";

/** The ledger's widest window of one read (ledger MaxPayoutDays). */
export const TEAM_LEDGER_PAYOUTS_MAX_DAYS = 62;

export const teamLedgerPayoutsQuerySchema = z.object({
  /** Moscow dates, both included. */
  from: businessDate,
  to: businessDate,
});

export const teamLedgerPayoutPersonSchema = z.object({
  /** The ledger's code of the person. */
  slug: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  /** The ledger's status of the person (active, left, …). */
  status: z.string(),
  /** The Hub user the person is (their username is the slug, the name or an alias); null — none. */
  hubUser: z.object({ userId: intId, username: z.string() }).nullable(),
  /** The window's accrued days, one per tab and day. */
  days: z.array(z.object({
    date: businessDate,
    /** The tab's model. */
    model: z.string(),
    amountMills: mills,
    worked: z.boolean(),
    /** Where the day came from: «sheet» — the payout sheet, «facts» — Hub's facts, «reports» — the posted shift report; another value as the ledger wrote it. */
    source: z.string(),
  })),
  /** Accrued over the window's days. */
  accruedMills: mills,
  /** Paid out on the window's days. */
  paidMills: mills,
  /** What the agency owes the person now: plus — owes, minus — paid ahead. */
  balanceMills: mills,
  /** «К выплате» of the person's payout tabs now; null — not known. */
  toPayMills: mills.nullable(),
  /** The oldest day still unpaid now; null — nothing owed. */
  oldestUnpaidDate: businessDate.nullable(),
  /** What is left unpaid now, oldest first. opening: the debt from before `accrualFrom` in one sum. */
  unpaidDays: z.array(z.object({
    date: businessDate,
    kind: z.string(),
    model: z.string().nullable(),
    unpaidMills: mills,
  })),
  /** «Не занесено» now: the tab's empty days on which Hub shows money in the person's scheduled shift — pay the sheet
   *  has not got yet, so not in the debt. shareMills is an estimate at the tab's rate; unknown — days Hub did not prove. */
  unentered: z.object({ days: z.number().int().nonnegative(), shareMills: mills, unknown: z.number().int().nonnegative() }),
  /** Paid days whose report changed after the payout (a paid day never moves by itself): each waits for the owner's word.
   *  Empty — none, or a ledger that does not say yet. */
  pendingChanges: z.array(z.object({
    id: intId,
    day: businessDate,
    model: z.string(),
    /** What the day was paid by. */
    postedMills: mills,
    /** What the report says now. */
    newMills: mills,
    reason: z.string(),
  })),
});

export const teamLedgerPayoutsResponseSchema = z.object({
  from: businessDate,
  to: businessDate,
  /** Days before it are in the opening debt, not one by one. */
  accrualFrom: businessDate,
  /** From this day on the days are accrued from Hub's facts; null — not switched (or a ledger that does not say). */
  factsFrom: businessDate.nullable(),
  /** From this day on the days are accrued from the posted shift reports; null — not switched (or a ledger that does not say). */
  reportsFrom: businessDate.nullable(),
  /** When the ledger answered. */
  generatedAt: isoTimestamp,
  people: z.array(teamLedgerPayoutPersonSchema),
  checks: z.object({
    /** The sheets were last collected, or the debts last rebuilt, too long ago (the ledger's own word). */
    stale: z.boolean(),
    lastSheetsCollectAt: isoTimestamp.nullable(),
    lastRebuildAt: isoTimestamp.nullable(),
    /** The debts were last rebuilt more than 2 hours ago, or never (the ledger's limit): every sum may lag. */
    debtsStale: z.boolean(),
    /** The payout sheets were last read more than 3 hours ago, or never (the ledger's limit): only «в таблице» may lag. */
    sheetsStale: z.boolean(),
  }),
  serverNow: isoTimestamp,
});

/** A day's state by the FIFO of payouts (the ledger's two): paid, still owed (in part or whole); none — accrued nothing. */
export const LEDGER_DAY_STATES = ["paid", "to_pay", "none"] as const;
export const ledgerDayStateEnum = z.enum(LEDGER_DAY_STATES);

export const teamLedgerPayoutPersonQuerySchema = z.object({
  /** The ledger's code of the person. */
  person: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  /** Moscow dates, both included, at most 62 days. */
  from: businessDate,
  to: businessDate,
});

/**
 * One person's pay in a window as the ledger keeps it (GET /v1/payouts/person): each day accrued with its state by the
 * payouts, the manual postings on the debt with their memo (a bonus adds, a fine or an advance takes off), the
 * payouts, the last payout and the debt now. Owner session only; no rate, no fix, no revenue a day was priced from.
 */
export const teamLedgerPayoutPersonResponseSchema = z.object({
  slug: z.string(),
  name: z.string(),
  from: businessDate,
  to: businessDate,
  /** Days before it are in the opening debt, not one by one. */
  accrualFrom: businessDate,
  factsFrom: businessDate.nullable(),
  reportsFrom: businessDate.nullable(),
  generatedAt: isoTimestamp,
  /** The window's days added up. */
  accruedMills: mills,
  /** The payouts dated in the window. */
  paidMills: mills,
  /** The debt now, as `ledger payables` counts it: plus — owed, minus — paid ahead. */
  balanceMills: mills,
  oldestUnpaidDate: businessDate.nullable(),
  /** The latest payout ever; null — none yet. */
  lastPayout: z.object({ date: businessDate, document: z.number().int().nonnegative(), amountMills: mills }).nullable(),
  /** One per date and model. */
  days: z.array(z.object({
    date: businessDate,
    model: z.string(),
    amountMills: mills,
    worked: z.boolean(),
    /** sheet · facts · reports; another value as the ledger wrote it. */
    source: z.string(),
    state: ledgerDayStateEnum,
    paidMills: mills,
    unpaidMills: mills,
    /** The journal rows (documents.num) of the payouts that paid the day, in order. */
    paidBy: z.array(z.number().int()),
  })),
  /** The manual postings on the debt dated in the window: plus — a bonus, minus — a fine or an advance. */
  adjustments: z.array(z.object({ date: businessDate, amountMills: mills, memo: z.string(), document: z.number().int().nullable() })),
  /** The payouts dated in the window. */
  payouts: z.array(z.object({ date: businessDate, document: z.number().int().nonnegative(), amountMills: mills })),
  /** The debts are rebuilt every hour; stale — not for 2 hours. */
  checks: z.object({ stale: z.boolean(), lastRebuildAt: isoTimestamp.nullable() }),
  serverNow: isoTimestamp,
});

export const teamLedgerPayoutPrepareQuerySchema = z.object({
  /** The ledger's code of the person. */
  person: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
});

/** One person's payout brief (ledger L5 `payout prepare`): read-only, nothing is recorded or sent. */
export const teamLedgerPayoutPrepareResponseSchema = z.object({
  slug: z.string(),
  name: z.string(),
  generatedAt: isoTimestamp,
  /** What the agency owes now; ≤ 0 — nothing to pay (`nothing` says why). */
  amountMills: mills,
  nothing: z.string().nullable(),
  toPayMills: mills.nullable(),
  period: z.object({ from: businessDate, to: businessDate }).nullable(),
  /**
   * The message's lines: a week of a tab «дд–дд.мм: a+b = база × ставка% = зп», a remainder of a day, an opening debt,
   * a manual posting («поправка дд.мм: +X — {за что}»), what the days do not explain. `from`/`to` — its days; null — not said.
   */
  lines: z.array(z.object({
    kind: z.string(),
    model: z.string().nullable(),
    text: z.string(),
    shownMills: mills,
    from: businessDate.nullable(),
    to: businessDate.nullable(),
  })),
  /** What the owner should know before paying; a blocker stops the payout until it is understood. */
  flags: z.array(z.object({ kind: z.string(), blocker: z.boolean(), text: z.string() })),
  blockers: z.number().int().nonnegative(),
  /** The transfer the owner usually makes (rounded to a dollar), what goes above the table, and a note. */
  suggestion: z.object({ transferMills: mills, aboveTableMills: mills, note: z.string() }).nullable(),
  /** The chatter's message; `placeholder` stands where the transferred amount goes after the transfer. */
  message: z.string().nullable(),
  placeholder: z.string().nullable(),
});

/**
 * Every chatter's shift reports of a window (Workboard «Выплаты → Отчёты», the owner's): the pay base the ledger
 * reads from the posts in «Отчётность» — posted and drafted page by page — each day with the agent's draft as the
 * chatter sees it, and the posts the ledger could not use in full. Read from the ledger's GET /v1/reports,
 * /v1/report-days and /v1/report-posts with Hub's payouts key. No post text reaches Hub.
 */
export const TEAM_LEDGER_REPORTS_MAX_DAYS = 62;

export const teamLedgerReportsQuerySchema = z.object({
  /** Report dates (the Moscow day a shift started), both included. */
  from: businessDate,
  to: businessDate,
});

/** Whose a report or a post is. */
export const teamLedgerReportPersonSchema = z.object({
  /** The ledger's code of the person; null — the ledger could not tell. */
  slug: z.string().nullable(),
  /** The Hub user they are: by the report's Hub user id, else by name; null — none. */
  hubUser: z.object({ userId: intId, username: z.string() }).nullable(),
  /** How to name them: the Hub login, else the ledger's name or code, else the post's sender. */
  name: z.string(),
});

/** One page of a person's report day in the pay base. */
export const teamLedgerReportPageSchema = z.object({
  pageLabel: z.string(),
  /** The ledger's model of the page; "" — not known. */
  model: z.string(),
  /** The page's amount in the chatter's post; null — not posted. */
  postedMills: mills.nullable(),
  /** The agent's draft of the page; null — written without the agent. */
  draftMills: mills.nullable(),
  /** posted − draft, when the chatter changed the amount; else null. */
  diffMills: mills.nullable(),
  /** posted_equal · posted_changed · post_only · draft_only; another value as the ledger wrote it. */
  state: z.string(),
  postedAt: isoTimestamp.nullable(),
  /** The page in the report handed in in Hub for the person and day (their shifts added); null — none. */
  hubMills: mills.nullable().default(null),
  /** How the post compares with it: hub_equal · hub_changed · hub_only · hub_missing; null — no report in Hub. */
  hubState: z.string().nullable().default(null),
  /** What the day accrues from: hub · post; null — the ledger did not say. */
  basis: z.string().nullable().default(null),
});

/** A post in «Отчётность» the ledger could not use in full (a flag on it). */
export const teamLedgerReportPostSchema = z.object({
  id: intId,
  postedAt: isoTimestamp,
  /** The Telegram name of who sent it. */
  sender: z.string(),
  /** The #tag the post carries; "" — none. */
  tag: z.string(),
  person: teamLedgerReportPersonSchema,
  model: z.string(),
  /** The day the post reports; null — not read. */
  reportDate: businessDate.nullable(),
  /** «Общий доход» as the post writes it. */
  totalMills: mills,
  /** The post's account lines added up. */
  pagesMills: mills,
  /** unknown_author · tag_mismatch · no_date · date_mismatch · sum_mismatch · unknown_page · duplicate; another as written. */
  flags: z.array(z.string()),
  /** A flag keeps the whole post out of the pay base: unknown_author, no_date, sum_mismatch, date_mismatch. */
  blocking: z.boolean(),
  pages: z.array(z.object({ name: z.string(), pageLabel: z.string().nullable(), inShift: z.boolean(), amountMills: mills })),
  /** The post in Telegram; null — the chat's id does not make a link. */
  link: z.string().nullable(),
});

/** One person's report day: the pay base by page, the draft, the posts of it the ledger could not use. */
export const teamLedgerReportDaySchema = z.object({
  /** Stable within a window: the person (or the draft) and the day. */
  key: z.string(),
  person: teamLedgerReportPersonSchema,
  reportDate: businessDate,
  pages: z.array(teamLedgerReportPageSchema),
  /** The pages' posted amounts added up; null — nothing posted. */
  postedMills: mills.nullable(),
  /** The pages' drafted amounts added up; null — no draft. */
  draftMills: mills.nullable(),
  /** The pages of the report handed in in Hub added up; null — none handed in in Hub. */
  hubMills: mills.nullable().default(null),
  /** The latest post that touched a page of the day; null — none. */
  postedAt: isoTimestamp.nullable(),
  /** The agent's current draft, as the chatter sees it in «Мои смены»; null — written without the agent. */
  draft: accountReportSchema.nullable(),
  /** `posts` of this person and day. */
  postIds: z.array(intId),
});

export const teamLedgerReportsResponseSchema = z.object({
  from: businessDate,
  to: businessDate,
  /** The newest day first. */
  reports: z.array(teamLedgerReportDaySchema),
  /** The window's posts with a flag, the newest first; a post whose person or day is not known belongs to no day. */
  posts: z.array(teamLedgerReportPostSchema),
  /** false — the ledger does not let Hub read the posts yet: `posts` is empty for that, not because there are none. */
  postsRead: z.boolean(),
  serverNow: isoTimestamp,
});

/**
 * The open questions «whose is this sale» (Workboard «Решения → Чья продажа», the owner's): when the team's chat agent
 * cannot tell whose a sale is (a custom two chatters worked on, a subscription one arranged and another closed), it asks
 * in the chat and the agency ledger keeps the question until the decision is recorded. Read from the ledger's
 * GET /v1/questions?open=1 with Hub's payouts key; Hub only reads — the owner answers the agent in the chat.
 */
export const teamLedgerQuestionSchema = z.object({
  /** The ledger's id of the question. */
  id: intId,
  /** The sale's page; "" — not known (the question is every page's). */
  pageLabel: z.string(),
  /** The platform's id of the fan; null — not known. */
  fanRef: z.string().nullable(),
  /** The fan's name as the agent wrote it; null — not known. */
  fanName: z.string().nullable(),
  /** The sale, when it is known (Hub's transaction reference); null — not known, or not paid yet. */
  transactionRef: z.string().nullable(),
  /** The sale's net; null — not known, or not paid yet. */
  netMills: mills.nullable(),
  /** When the sale was; null — not known, or not paid yet. */
  occurredAt: isoTimestamp.nullable(),
  /** The question itself, as the agent asked it. */
  question: z.string(),
  /** Who the question is about or who decides it, as the agent wrote it; "" — not said. */
  who: z.string(),
  /** When it was asked. */
  askedAt: isoTimestamp,
  /** The message in the chat where it was asked (http/https only); null — none. */
  sourceLink: z.string().nullable(),
  /** The agent's note: what it knows of the sale; "" — none. */
  note: z.string(),
});

export const teamLedgerQuestionsResponseSchema = z.object({
  /** The questions that wait for the owner's word, the oldest first. Each is one decision. */
  owner: z.array(teamLedgerQuestionSchema),
  /** The questions the chatters settle among themselves, the oldest first: for the owner's information, not his decision. */
  chatters: z.array(teamLedgerQuestionSchema),
  /** false — the ledger does not let Hub read the questions yet (403/404): both lists are empty for that, not because there are none. */
  questionsRead: z.boolean(),
  serverNow: isoTimestamp,
});

// ── The month card (Деньги → Месяц) ─────────────────────────────────────────

/** A calendar month, «2026-11»: Moscow days. */
export const ledgerMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const teamLedgerMonthQuerySchema = z.object({ month: ledgerMonthSchema });

/** One model's line of the month card. Money in mills of the ledger's whole cents. */
export const teamLedgerMonthModelSchema = z.object({
  model: z.string(),
  pagesNetMills: mills,
  offPlatformMills: mills,
  earnedMills: mills,
  arrivedMills: mills,
  ridingMills: mills,
});

/**
 * The ledger's month card as its hub read serves it (GET /v1/payouts/month/{month}, ledger#85): no expenses, no
 * decision figure, no owner's draws. `pagesNetMills` is the card's «Оборот» less what came past the platforms, the
 * «не согласовано» pages included: the pages' income after the platforms' commission as the ledger read it from Hub;
 * the screen sets it beside Hub's own income of the same Moscow month. The totals are the ledger's own (its lines
 * are rounded one by one, so the models may sum a cent apart). Nothing here is counted by Hub.
 */
export const teamLedgerMonthCardSchema = z.object({
  /**
   * `unknown`: the month was never computed (every money field null) or a check of the card failed (the figures stay,
   * `reason` says what): never hide them.
   */
  status: z.enum(["proven", "unknown"]),
  reason: z.string().nullable(),
  /** The ledger's cut the card is of. */
  asOf: isoTimestamp.nullable(),
  computedAt: isoTimestamp.nullable(),
  pagesNetMills: mills.nullable(),
  offPlatformMills: mills.nullable(),
  turnoverMills: mills.nullable(),
  earnedMills: mills.nullable(),
  arrivedMills: mills.nullable(),
  ridingMills: mills.nullable(),
  holdMills: mills.nullable(),
  stuckMills: mills.nullable(),
  onPageMills: mills.nullable(),
  models: z.array(teamLedgerMonthModelSchema),
  notes: z.array(z.string()),
});

export const teamLedgerMonthResponseSchema = z.object({
  month: ledgerMonthSchema,
  /** The month's Moscow days, both included. */
  from: businessDate,
  to: businessDate,
  /** false: the ledger does not serve the month card to Hub's key yet (an older ledger): `card` is null for that. */
  served: z.boolean(),
  card: teamLedgerMonthCardSchema.nullable(),
  serverNow: isoTimestamp,
});

export type TeamLedgerPayoutsResponse = z.infer<typeof teamLedgerPayoutsResponseSchema>;
export type TeamLedgerPayoutPrepareResponse = z.infer<typeof teamLedgerPayoutPrepareResponseSchema>;
export type TeamLedgerPayoutPerson = z.infer<typeof teamLedgerPayoutPersonSchema>;
export type TeamLedgerPayoutPersonResponse = z.infer<typeof teamLedgerPayoutPersonResponseSchema>;
export type LedgerDayState = z.infer<typeof ledgerDayStateEnum>;
export type TeamLedgerReportsQuery = z.infer<typeof teamLedgerReportsQuerySchema>;
export type TeamLedgerReportsResponse = z.infer<typeof teamLedgerReportsResponseSchema>;
export type TeamLedgerReportDay = z.infer<typeof teamLedgerReportDaySchema>;
export type TeamLedgerReportPage = z.infer<typeof teamLedgerReportPageSchema>;
export type TeamLedgerReportPost = z.infer<typeof teamLedgerReportPostSchema>;
export type TeamLedgerReportPerson = z.infer<typeof teamLedgerReportPersonSchema>;
export type TeamLedgerQuestion = z.infer<typeof teamLedgerQuestionSchema>;
export type TeamLedgerQuestionsResponse = z.infer<typeof teamLedgerQuestionsResponseSchema>;
export type TeamLedgerMonthResponse = z.infer<typeof teamLedgerMonthResponseSchema>;
export type TeamLedgerMonthCard = z.infer<typeof teamLedgerMonthCardSchema>;

export const teamLedgerRouteSchemas = {
  teamLedgerMonth: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "The agency's month card from the ledger: the pages' income, past the platforms, turnover, earned and where it is",
    description: "Read from the ledger's GET /v1/payouts/month/{month} with Hub's payouts key; the money is the ledger's to "
      + "the cent. `served: false` — the ledger does not serve the month yet (it answered 403 or 404); 503 — the ledger is "
      + "not connected or did not answer.",
    querystring: teamLedgerMonthQuerySchema,
    response: {
      200: teamLedgerMonthResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  teamLedgerPayouts: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "The chatters' pay as the agency ledger counts it: accrued, paid, owed now",
    description: "Read from the ledger's GET /v1/payouts with Hub's payouts key. The days are Moscow days, at most 62. "
      + "503 when the ledger is not connected or did not answer.",
    querystring: teamLedgerPayoutsQuerySchema,
    response: {
      200: teamLedgerPayoutsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  teamLedgerPayoutPrepare: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "One person's payout brief from the agency ledger: the transfer, the lines, the blockers, the message",
    description: "Read from the ledger's GET /v1/payouts/prepare with Hub's payouts key. Read-only: nothing is recorded "
      + "or sent. 404 — the ledger has no payout tab of the person; 503 — the ledger is not connected or did not answer.",
    querystring: teamLedgerPayoutPrepareQuerySchema,
    response: {
      200: teamLedgerPayoutPrepareResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  teamLedgerPayoutPerson: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "One person's pay in a window from the agency ledger: days with their state, adjustments with their memo, payouts",
    description: "Read from the ledger's GET /v1/payouts/person with Hub's payouts key. The days are Moscow days, at most "
      + "62. 404 — the ledger has no payout tab of the person; 503 — the ledger is not connected or did not answer.",
    querystring: teamLedgerPayoutPersonQuerySchema,
    response: {
      200: teamLedgerPayoutPersonResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  teamLedgerReports: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Every chatter's shift reports from the agency ledger: posted and drafted by page, the drafts, the posts it could not use",
    description: "Read from the ledger's GET /v1/reports, /v1/report-days and /v1/report-posts with Hub's payouts key. Report "
      + "dates are Moscow days, at most 62. While the ledger refuses Hub the posts (403/404), `posts` is empty and "
      + "`postsRead` false. 503 when the ledger is not connected or did not answer.",
    querystring: teamLedgerReportsQuerySchema,
    response: {
      200: teamLedgerReportsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  teamLedgerQuestions: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "The open questions «whose is this sale» from the agency ledger, split by whom they wait for",
    description: "Read from the ledger's GET /v1/questions?open=1 with Hub's payouts key. Read-only: the owner answers the "
      + "agent in the chat. While the ledger refuses Hub the questions (403/404), both lists are empty and `questionsRead` "
      + "false. 503 when the ledger is not connected or did not answer.",
    response: {
      200: teamLedgerQuestionsResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
} as const;
