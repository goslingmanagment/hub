/**
 * Отчёт смены (ecosystem plan 2026-11-12, package F): the shift and its report
 * as one object in Hub, behind three doors that call one service — Workboard by
 * the person's session (the narrow one the extension opens included), the chat
 * extension by its device token, and an agent key «со слов» (Gengar's /smena,
 * `write:shift_reports`). One report per shift row (`shifts.id`); its draft is
 * computed from the shift and the one rule of whose a sale is, and the person's
 * edits (не моё, делим с…, моё, a note, the comment, «мимо площадки») are saved
 * as made. «Сдать смену» makes an immutable version; the newest version is the
 * report. Accrued and paid are the ledger's, which reads the versions through
 * `agentShiftReportsFeed`.
 *
 * Who reads what: the person their own (draft and versions); the owner every
 * report; a team lead and a colleague the reports of shifts on pages they may
 * open, cut to those pages, the submitted version only (a team lead also the
 * draft before it), never edits. Everything new is behind the person's switch
 * «сдаёт смену в системе» (people registry right `submits_shift`): off, nothing
 * writes and «Мои смены» is as before. Sales only: no rate, accrual or payout
 * reaches any session here.
 */
import { z } from "zod";

import { CHATTER_SALE_KINDS, CHATTER_STATS_MAX_DAYS } from "./chatter-stats.ts";
import { businessDate, errorResponseSchema, intId, isoTimestamp, mills } from "./primitives.ts";
import { shiftReportClaimSchema } from "./sale-claims.ts";
import { shiftReportBoardSchema, shiftReportPhaseEnum, shiftReportWordEnum } from "./shift-report-board.ts";

export const SHIFT_REPORT_STATEMENTS = ["mine", "not_mine", "share"] as const;
export const SHIFT_REPORT_DOORS = ["extension", "workboard", "telegram"] as const;
export const shiftReportStatementEnum = z.enum(SHIFT_REPORT_STATEMENTS);
export const shiftReportDoorEnum = z.enum(SHIFT_REPORT_DOORS);

/** The longest note of a line, and the comment. */
export const SHIFT_REPORT_NOTE_MAX = 300;
export const SHIFT_REPORT_COMMENT_MAX = 2000;

const shiftIdParam = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const shiftReportParamsSchema = z.object({ shiftId: shiftIdParam });
export const shiftReportLineParamsSchema = z.object({ shiftId: shiftIdParam, transactionId: shiftIdParam });
export const shiftReportOffPlatformParamsSchema = z.object({ shiftId: shiftIdParam, offPlatformId: shiftIdParam });

export const shiftReportShiftSchema = z.object({
  /** The shift row's id (`shifts.id`). */
  id: intId,
  userId: intId,
  /** The person's name in the registry, else the login. */
  personName: z.string(),
  /** going — still on (it may be handed in now); closed — over. */
  ongoing: z.boolean(),
  startedAt: isoTimestamp,
  /** A shift still going: the last time Hub looked. */
  endedAt: isoTimestamp,
  workedMinutes: z.number().int().nonnegative(),
  /**
   * The Moscow day the shift is reported on: once handed in, the report's own day (its newest version's) — the day the
   * ledger's feed and the post name; before that, the shift's day by the ledger's rule.
   */
  reportDate: businessDate,
  pages: z.array(z.string()),
});

const person = { userId: intId, name: z.string() };

export const shiftReportLineFactsSchema = z.object({
  /** A bought PPV: who sent the message the fan paid for and when; `withoutAuthor` — found, sent with no author. Null — not a PPV. */
  ppv: z.object({ senderUserId: intId.nullable(), senderName: z.string().nullable(), sentAt: isoTimestamp.nullable(), withoutAuthor: z.boolean() }).nullable(),
  /** Who last wrote to the fan on the page before the sale (60 days back), when, and whether within the rule's 48 hours. */
  lastWriter: z.object({ ...person, at: isoTimestamp, within48h: z.boolean() }).nullable(),
  /** Everyone who wrote to the fan in the 48 hours before it, most messages first. */
  writers: z.array(z.object({ ...person, messages: z.number().int().nonnegative() })),
  /** The other people's shifts that held the page at the sale, and whether each one's schedule slot ran (null — no schedule known). Null — not read (a sale of the days before the shift). */
  holders: z.array(z.object({ ...person, slotRunning: z.boolean().nullable() })).nullable(),
  /** Whether the person's own schedule slot ran at the sale; null — no schedule known. */
  ownSlotRunning: z.boolean().nullable(),
  /** The sale counts in another person's handed-in report: whose, which shift and day. */
  otherReports: z.array(z.object({ ...person, shiftId: intId, reportDate: businessDate })),
  /** The pot the rule gives it to (`obshak`); null — none. */
  pot: z.string().nullable(),
  /** A subscription renewing a charge of the same price 27 to 32 days before: when that charge was; null — none found. */
  renewalOf: isoTimestamp.nullable(),
});

export const shiftReportLineSchema = z.object({
  /** Hub's `transactions.id`. */
  transactionId: intId,
  /** mine — «Ваши продажи» (the person's by the rule, or «долёт»); near — «Рядом, но не ваши по правилу». */
  group: z.enum(["mine", "near"]),
  pageLabel: z.string(),
  platform: z.string(),
  /** Hub's canonical type: message_purchase, post_purchase, tip, stream_tip, subscription. */
  kind: z.string(),
  occurredAt: isoTimestamp,
  netMills: mills,
  fan: z.object({ fanRef: z.string().nullable(), name: z.string().nullable(), username: z.string().nullable(), alias: z.string().nullable().optional() }),
  rule: z.object({
    /** The rule's home: shift, visit, pot, waiting, decide, nobody, before_rule, unknown. */
    home: z.string(),
    reason: z.string(),
    /** The reason in plain words, from the reader's side: «ваш PPV», «PPV отправил Максим», «общак: чаевые под постом». */
    words: z.string(),
    /** Whose the rule says it is, when it is not this person's; null — nobody's, a pot's, waiting. */
    toUserId: intId.nullable(),
    toName: z.string().nullable(),
    /** The person's share by the rule (0 for a near line). */
    shareMills: mills,
  }),
  /** What the person says: null — the rule stands. */
  statement: shiftReportStatementEnum.nullable(),
  shareWithUserId: intId.nullable(),
  shareWithName: z.string().nullable(),
  note: z.string().nullable(),
  /** What the line counts in the report: a disputed «моё» counts 0 until it is settled (review R2b-2). */
  amountMills: mills,
  /** What a disputed «моё» claims while it counts nothing: «спорно, ждёт решения: $X»; null — not disputed. */
  claimedMills: mills.nullable().default(null),
  /** «Долёт»: of the days before the shift, by the rule the person's, in no report of theirs yet. */
  added: z.boolean(),
  /** «Моё» while the rule gives it to someone else: counted nowhere until the other side or the owner settles it. */
  disputed: z.boolean(),
  /** Another report of the person holds it: it counts 0 here. */
  alreadyIn: z.object({ shiftId: intId, reportDate: businessDate }).nullable(),
  /**
   * The facts the rule read of the sale, for «почему» (shown on a click) and for an agent that talks with the person
   * about it: the same facts `sale_homes` is computed from, exposed, no other rule. Null — a version handed in (the
   * facts are of the draft, read now).
   */
  facts: shiftReportLineFactsSchema.nullable(),
});

/**
 * The comment of each model of a report (0432), in the posts' order: the model's own when written (an empty one too),
 * else the general `comment`. The models whose pages the reader sees and that make a post.
 */
export const shiftReportModelCommentsSchema = z.array(z.object({ modelSlug: z.string(), modelName: z.string(), comment: z.string() }));

export const shiftReportOffPlatformSchema = z.object({
  id: intId,
  amountMills: mills,
  fromWhom: z.string(),
  whatFor: z.string(),
  /** pending — waits for the owner, never in the sums; confirmed — counts in its page's sum; rejected. */
  state: z.enum(["pending", "confirmed", "rejected"]),
  /** A confirmed amount's page (package G); null — none. */
  pageLabel: z.string().nullable().default(null),
});

/** A report as one reads it: the person's draft, or a submitted version. */
export const shiftReportBodySchema = z.object({
  source: z.enum(["draft", "version"]),
  /** The version shown; null — the draft. */
  version: z.number().int().positive().nullable(),
  submittedAt: isoTimestamp.nullable(),
  door: shiftReportDoorEnum.nullable(),
  /** «Ваши продажи» then «Рядом», each oldest first. */
  lines: z.array(shiftReportLineSchema),
  offPlatform: z.array(shiftReportOffPlatformSchema),
  /** The general comment: what a write without a model sets, and the comment of a model without its own. */
  comment: z.string(),
  /** Each model's comment, as its post carries it (one per post, the posts' order); empty — the report has no page yet. */
  comments: shiftReportModelCommentsSchema.default([]),
  /** The shift's pages first, a page of a «долёт» after; a page at zero too. */
  pages: z.array(z.object({ pageLabel: z.string(), platform: z.string(), amountMills: mills })),
  totalMills: mills,
  /** A colleague's or a team lead's view: only the pages they may open are here. */
  cut: z.boolean(),
  /** When the draft was computed, or the version made. */
  computedAt: isoTimestamp,
});

export const shiftReportVersionSummarySchema = z.object({
  version: z.number().int().positive(),
  submittedAt: isoTimestamp,
  door: shiftReportDoorEnum,
  /** The person who pressed «Сдать смену», or the agent key's name «со слов». */
  by: z.string(),
  totalMills: mills,
  /** Made by the system on a decision (package G): why, in plain words («Алекс согласился», «решение владельца: пополам»); null — handed in by the person. */
  madeFor: z.string().nullable().default(null),
});

export const shiftReportResponseSchema = z.object({
  shift: shiftReportShiftSchema,
  /** own — the reader's own shift; read — someone else's. */
  access: z.enum(["own", "read"]),
  /** The person's switch «сдаёт смену в системе». */
  enabled: z.boolean(),
  /** The reader may change the draft and hand it in (own, switched on). */
  canEdit: z.boolean(),
  /** open — nothing handed in yet; submitted — the newest version is the report. */
  state: z.enum(["open", "submitted"]),
  /** The newest version; null — none. */
  latest: shiftReportVersionSummarySchema.nullable(),
  /** Every version, the newest first. */
  versions: z.array(shiftReportVersionSummarySchema),
  /** What the reader sees: own — the draft; else the newest version (a team lead and the owner: the draft while none). Null — not handed in yet. */
  view: shiftReportBodySchema.nullable(),
  /** Own, handed in: the draft's sales of the person that the report does not hold yet («после сдачи»); null — none. */
  afterSubmission: z.object({ count: z.number().int().positive(), mills }).nullable(),
  /** Own: the newest version as today's post in «Отчётность», one per model. */
  /**
   * One post per model of the shift, each its own text: «Отчётность» takes one post per model (the ledger's post reader
   * reads one model from a text), so they are copied one by one, never joined.
   */
  posts: z.array(z.object({ modelSlug: z.string(), modelName: z.string(), text: z.string() })),
  /** Own: the people a «делим с…» may name. */
  colleagues: z.array(z.object({ userId: intId, name: z.string() })),
  /**
   * The claims of the report's sales (package G): incoming — someone claims a sale of the person (the person answers
   * «Согласен» / «Не согласен» here); outgoing — the person's own claims, with the other side's answer and the owner's
   * decision. A reader of shared pages sees those of the pages they may open; the owner every one.
   */
  claims: z.array(shiftReportClaimSchema).default([]),
  /**
   * The «Отчёт» board (package R, shift-report-board.ts): everything the board draws, a column per page. Null — the
   * person has no board (the right is off) or the reader may not see it.
   */
  board: shiftReportBoardSchema.nullable().default(null),
  /**
   * Whether THIS shift is a board shift: the person's right was on when it began (the agent's /smena decides by the
   * shift, not by the person). Absent from an older server.
   */
  boardShift: z.boolean().optional(),
  serverNow: isoTimestamp,
});

/** A change the phase does not take now (ticks and «чья» in «Проверка», «Подтвердите», «Учтён»): 409 with the fresh board. */
export const shiftReportPhaseConflictSchema = errorResponseSchema.extend({
  report: shiftReportResponseSchema.optional(),
});

export const shiftReportLineBodySchema = z.object({
  /**
   * null — back to the rule's word. «не моё», «делим с…» on «Ваши продажи»; «моё» on «Рядом»; on the board also
   * `give` (one's own sale to a colleague, `toUserId`) and `pot` (one's own sale to the pot). A word that makes the
   * person's share larger at someone's cost is not a mark: it is a question (`shiftReportAsk`). Absent — the word as it
   * stands (a comment alone).
   */
  statement: shiftReportWordEnum.nullable().optional(),
  /** With «делим с…»: the colleague. */
  shareWithUserId: intId.nullable().optional(),
  /** With `give`: the colleague the sale is given to. */
  toUserId: intId.nullable().optional(),
  /** Empty or null — none; absent — the comment as it stands. «Моё» on «Рядом» needs one line of why. */
  note: z.string().trim().max(SHIFT_REPORT_NOTE_MAX).nullable().optional(),
});

export const shiftReportCommentBodySchema = z.object({
  comment: z.string().max(SHIFT_REPORT_COMMENT_MAX),
  /**
   * The model whose post the comment is for (its slug, as the report's `comments` and `posts` name it): only its own is
   * set. Absent — the one comment of every post (each model's own is dropped). A model none of the report's pages is: 400.
   */
  modelSlug: z.string().trim().min(1).max(100).optional(),
});

/** «Добавить продажу» (H8): exact match by transactionRef OR (fan + amountMills), within caller's granted pages and realm. */
const shiftReportReportSaleFields = {
  /** Platform transaction reference or Hub transaction id. */
  transactionRef: z.string().trim().min(1).max(120).optional(),
  /** Fan username, display name, page alias, or platform id (paired with `amountMills`). */
  fan: z.string().trim().min(1).max(200).optional(),
  /** Sale amount in mills (paired with `fan`). */
  amountMills: mills.min(1).max(100_000_000).optional(),
  /** Required one line of why the sale is the person's (the line's note). */
  note: z.string().trim().min(1).max(SHIFT_REPORT_NOTE_MAX),
};

export const shiftReportReportSaleBodySchema = z.object(shiftReportReportSaleFields).refine(
  (body) => body.transactionRef !== undefined || (body.fan !== undefined && body.amountMills !== undefined),
  "name transactionRef or fan with amountMills",
);

export const shiftReportReportSaleResponseSchema = z.object({
  transactionId: intId,
  savedAt: isoTimestamp,
});

export const agentShiftReportReportSaleBodySchema = z.object({
  shiftId: intId,
  ...shiftReportReportSaleFields,
  /** The sender of the Telegram message: must be the person's, else 409 `sender_not_person`. */
  telegramUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** Optional message reference. */
  sourceRef: z.string().trim().min(1).max(300).optional(),
}).refine(
  (body) => body.transactionRef !== undefined || (body.fan !== undefined && body.amountMills !== undefined),
  "name transactionRef or fan with amountMills",
);

export const shiftReportOffPlatformBodySchema = z.object({
  amountMills: mills.min(1).max(100_000_000),
  fromWhom: z.string().trim().min(1).max(200),
  whatFor: z.string().trim().min(1).max(300),
});

export const shiftReportSavedResponseSchema = z.object({
  savedAt: isoTimestamp,
});

export const shiftReportOffPlatformResponseSchema = z.object({
  line: shiftReportOffPlatformSchema,
  savedAt: isoTimestamp,
});

export const shiftReportsListQuerySchema = z.object({
  /** Moscow days of the shifts' start, both included. */
  from: businessDate,
  to: businessDate,
  /** Someone else's shifts (the owner, a team lead, a colleague on shared pages); absent — the reader's own. */
  userId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

export const shiftReportsListItemSchema = z.object({
  shiftId: intId,
  startedAt: isoTimestamp,
  endedAt: isoTimestamp,
  ongoing: z.boolean(),
  reportDate: businessDate,
  pages: z.array(z.string()),
  state: z.enum(["open", "submitted"]),
  version: z.number().int().positive().nullable(),
  submittedAt: isoTimestamp.nullable(),
  /** The newest version's total (a colleague's: the pages they may open); null — not handed in. */
  totalMills: mills.nullable(),
  /** The person's own shift not handed in yet: the draft's total now (by the rule and their words), «предварительно»; null — handed in, someone else's, or not computed. */
  draftTotalMills: mills.nullable(),
  /**
   * The «Отчёт» board's phase of a board shift (the person's right was on when it began): what the person does next on
   * «Мои смены» («Сдать смену», «Подтвердить»); null — no board (the report goes the old way). Absent from an older server.
   */
  phase: shiftReportPhaseEnum.nullable().optional(),
  /** The reader's own counted board report: its post for «Отчётность» was copied; null — not counted, not one's own, or no board. */
  postCopied: z.boolean().nullable().optional(),
});

export const shiftReportsListResponseSchema = z.object({
  /** The person's switch. Off — the list is empty and «Мои смены» stays as before. */
  enabled: z.boolean(),
  /** When it was turned on: a shift that began earlier keeps its old report (the post). */
  enabledSince: isoTimestamp.nullable(),
  shifts: z.array(shiftReportsListItemSchema),
  serverNow: isoTimestamp,
});

// ── The team's reports (teamShiftReports) ───────────────────────────────────
//
// Workboard «Смены → Отчёты» (owner, 2026-11-19): every shift's report of the people the reader sees, in one read for
// the window. The cut is `teamShiftSales`' (the pages of the reader's teams and their own, services/teams.ts; the
// reader's realm); each report is as Hub counts it FOR THIS READER, cut to their pages as `shiftReportsList` cuts it (the
// owner and the person see it whole). Nobody's draft is computed here (a draft is its person's): a shift with nothing
// handed in carries its sales by the rule, the very count of `teamShiftSales`. Sales only: no rate, accrual or payout.

const teamCount = z.number().int().nonnegative();

export const teamShiftReportsQuerySchema = z.object({
  /** Whole Moscow days of the reports' dates back from `until` (default today), that day included. */
  days: z.coerce.number().int().min(1).max(CHATTER_STATS_MAX_DAYS).default(7),
  /** The window's last Moscow day; default today. A later one keeps today inside the window (as `teamShiftSales`). */
  until: businessDate.optional(),
  /** One page only (404 for a page that does not exist, 403 for one the reader does not reach): its part of each report. */
  pageLabel: z.string().min(1).max(120).optional(),
  /** One person: the person behind this login, every login of theirs. */
  userId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

/** What a report's sales are made of, or a shift's by the rule: counted on the server, the parts add up to `mills`. */
export const teamShiftReportPartsSchema = z.object({
  /** Sales that count something. */
  count: teamCount,
  /** What they count together: the whole the parts by kind make. */
  mills,
  byKind: z.object({ ppv: mills, tip: mills, subscription: mills, post: mills }),
  /** Each sale at its minute, the oldest first (the card's line in time): what it counts here. */
  sales: z.array(z.object({
    at: isoTimestamp,
    netMills: mills,
    kind: z.enum(CHATTER_SALE_KINDS),
    pageLabel: z.string(),
    fanName: z.string().nullable(),
  })),
});

export const teamShiftReportSchema = z.object({
  /** The shift row's id (`shifts.id`): its board is `/report/:shiftId`. */
  shiftId: intId,
  userId: intId,
  /** The person's name in the registry, else the login. */
  personName: z.string(),
  startedAt: isoTimestamp,
  endedAt: isoTimestamp,
  ongoing: z.boolean(),
  workedMinutes: teamCount,
  pauses: z.array(z.object({ from: isoTimestamp, to: isoTimestamp })),
  /** The shift's pages the reader sees, in the shift's order. */
  pages: z.array(z.string()),
  /** The Moscow day the shift is reported on (handed in: the report's own). */
  reportDate: businessDate,
  /** The reader's own shift (by any login of theirs). */
  own: z.boolean(),
  /** A board shift: the person's right «сдаёт смену в системе» was on when it began. false — the old way (a post in «Отчётность»). */
  board: z.boolean(),
  /** The board's phase; null — the old way, nothing handed in in Hub. */
  phase: shiftReportPhaseEnum.nullable(),
  /**
   * What was handed in, as Hub counts it for this reader: the newest version (counted; reopened — «Правка», the counted
   * one stands), or, before one, the candidate on the check or waiting for «Подтверждаю». Null — nothing handed in.
   */
  report: z.object({
    source: z.enum(["version", "candidate"]),
    /** The version's number; a candidate's — its number among the hand-ins. */
    number: z.number().int().positive(),
    /** When it was counted (a version) or handed in (a candidate). */
    at: isoTimestamp,
    door: shiftReportDoorEnum,
    totalMills: mills,
    /** Each page's sum, the reader's pages. */
    pages: z.array(z.object({ pageLabel: z.string(), amountMills: mills })),
    /** The report has pages the reader does not see: only theirs are counted here. */
    cut: z.boolean(),
    parts: teamShiftReportPartsSchema,
  }).nullable(),
  /** The newest counted version: «Учтён в 16:04, версия 1». Null — none. */
  counted: z.object({ version: z.number().int().positive(), at: isoTimestamp }).nullable(),
  /** Hub's check and Gengar's of the newest hand-in, as the board's candidate says them (the reader's pages). Null — no hand-in on the board. */
  check: z.object({
    hub: z.enum(["running", "matched", "found", "unchecked", "statement"]),
    foundCount: teamCount,
    foundMills: mills,
    gengar: z.enum(["idle", "reading", "found", "clean", "silent"]),
    proposals: teamCount,
  }).nullable(),
  /** The candidate waits for the person's «Подтверждаю»: not counted until then. */
  waitsConfirm: z.boolean(),
  /**
   * The comment for the next shift, each model's of the reader's pages, those with words only: what the next shift
   * reads (the report's as handed in, else the one being written).
   */
  comments: z.array(z.object({ modelName: z.string(), comment: z.string() })),
  /** The shift's sales by the rule, as «Команда» counts them (`teamShiftSales`): the card's number before a hand-in. Null — Hub counted no such shift on the reader's pages. */
  rule: teamShiftReportPartsSchema.nullable(),
  /**
   * The reader's OWN board shift with nothing handed in: the draft's total now (by the rule and their words),
   * «предварительно», as `shiftReportsList` gives it (the newest few). Null — handed in, someone else's, or not computed.
   */
  draftTotalMills: mills.nullable(),
  /** The reader's own counted report: its post for «Отчётность» was copied; null — not counted, not one's own, or no board. */
  postCopied: z.boolean().nullable(),
});

/** A tally of reports (a day's, the window's): counts and Hub's sum, as this reader sees each report. */
export const teamShiftReportsTallySchema = z.object({
  /** Shifts: every card. */
  shifts: teamCount,
  /** Reports handed in (counted, reopened, on the check, waiting for «Подтверждаю»). */
  handedIn: teamCount,
  /** The reports due or in: handed in, and board shifts over with nothing handed in. */
  expected: teamCount,
  /** The sum of the handed-in reports' totals. */
  reportedMills: mills,
  /** Board shifts over with nothing handed in. */
  notHandedIn: teamCount,
  /** Of `handedIn`: waiting for the person's «Подтверждаю». */
  waitingConfirm: teamCount,
  /** Going on, nothing handed in yet. */
  ongoing: teamCount,
  /** Over, reported the old way (a post in «Отчётность»): Hub holds no report. */
  oldWay: teamCount,
});

export const teamShiftReportsResponseSchema = z.object({
  /** The window's Moscow days (the reports' dates), both included. */
  from: businessDate,
  to: businessDate,
  /** The window's days that have a report, the newest first. */
  days: z.array(teamShiftReportsTallySchema.extend({ date: businessDate })),
  totals: teamShiftReportsTallySchema,
  /** The newest first (by the report's day, then the start). */
  reports: z.array(teamShiftReportSchema),
  /** The people with a shift in the window on the reader's pages (whatever `userId` asks), by name: the filter's choices. */
  people: z.array(z.object({ userId: intId, name: z.string() })),
  serverNow: isoTimestamp,
});

export type TeamShiftReportsQuery = z.infer<typeof teamShiftReportsQuerySchema>;
export type TeamShiftReportsResponse = z.infer<typeof teamShiftReportsResponseSchema>;
export type TeamShiftReport = z.infer<typeof teamShiftReportSchema>;
export type TeamShiftReportParts = z.infer<typeof teamShiftReportPartsSchema>;

/** «Добавить → продажу»: a sale of the last 7 days the person may add to the report by hand. */
export const shiftReportClaimableSaleSchema = z.object({
  transactionId: intId,
  pageLabel: z.string(),
  platform: z.string(),
  kind: z.string(),
  occurredAt: isoTimestamp,
  netMills: mills,
  fan: z.object({ fanRef: z.string().nullable(), name: z.string().nullable(), username: z.string().nullable(), alias: z.string().nullable().optional() }),
  /** The rule's home: nobody — «ничья» (disputed when added); anything else — counted and disputed when added. */
  home: z.string(),
  /** Whose it is by the rule, in plain words. */
  words: z.string(),
  /** For a waiting PPV (`home === 'waiting'`): the deadline for its sender's next shift; null/absent otherwise. */
  waitsUntil: isoTimestamp.nullable().optional(),
});

export const shiftReportClaimableResponseSchema = z.object({
  /** On the pages the person may open, in no report of theirs; nobody's first, then the newest first. */
  sales: z.array(shiftReportClaimableSaleSchema),
  serverNow: isoTimestamp,
});

// ── The «Отчёт» board's operations (package R) ──────────────────────────────

export const shiftReportAskParamsSchema = z.object({ shiftId: shiftIdParam, transactionId: shiftIdParam });
export const shiftReportProposalParamsSchema = z.object({ shiftId: shiftIdParam, proposalId: shiftIdParam });
export const shiftReportSightingParamsSchema = z.object({ shiftId: shiftIdParam, sightingId: shiftIdParam });

/**
 * «Сдать смену»: what the person saw on the draft's bar. When it equals what the candidate holds, the hand-in is the
 * person's signature: a check that changes nothing counts the report by it, with no second press. Absent (an older
 * client) or different — the person confirms with «Подтверждаю» as before.
 */
export const shiftReportSubmitBodySchema = z.object({
  /** The total the bar showed («Сдать смену» = подтверждаю: 18 продаж на $461.40). */
  seenTotalMills: mills.optional(),
  /** The count the bar showed. */
  seenCount: z.number().int().nonnegative().optional(),
}).strict();

/** «Подтверждаю»: signs one exact candidate — and what the board showed of it. */
export const shiftReportConfirmBodySchema = z.object({
  candidateId: intId,
  /** The total the board showed («Вы подтверждаете: 18 продаж на $461.40»): a version that would differ is not made (`changed`). */
  seenTotalMills: mills.optional(),
  /** The count the board showed. */
  seenCount: z.number().int().nonnegative().optional(),
});

export const shiftReportConfirmResponseSchema = z.object({
  /** A version was made from the candidate. */
  confirmed: z.boolean(),
  /** Why not: superseded — a correction or a re-check made a newer candidate (it is in `report`); not_ready — the phase is not «Подтвердите». Null — confirmed. */
  refused: z.enum(["superseded", "not_ready", "changed"]).nullable(),
  /** The fresh board. */
  report: shiftReportResponseSchema,
});

/** «Досдать»: late sales the rule gives the person, into the next version at once. */
export const shiftReportResendBodySchema = z.object({
  transactionIds: z.array(intId).min(1).max(200),
});

/** «Почему продажа ваша?» → «Спросить Олега» / «Спросить владельца»: a question from the draft. */
export const shiftReportAskBodySchema = z.object({
  transactionId: intId,
  /** What the person wants: «моя» or «пополам с …». */
  statement: z.enum(["mine", "share"]),
  shareWithUserId: intId.nullable().optional(),
  /** The one line of why. */
  note: z.string().trim().min(1).max(SHIFT_REPORT_NOTE_MAX),
});

/** A card of Gengar: decline it («Не согласен»), restore it («Вернуть правку»), or accept a late one («Принять»). */
export const shiftReportPostCopiedQuerySchema = z.object({
  /** The model whose post was copied: its slug, as the report's `posts` name it. */
  model: z.string().trim().min(1).max(100).optional(),
});

export const shiftReportProposalAnswerBodySchema = z.object({
  answer: z.enum(["decline", "restore", "accept"]),
  /** With «Не согласен» on a card of whose the sale is: the person's line of why, for whoever decides it. */
  note: z.string().trim().max(SHIFT_REPORT_NOTE_MAX).nullable().optional(),
});

export const shiftReportCurrentResponseSchema = z.object({
  /** The person's own shift that needs them most: the running one, else the newest not counted, else the newest; null — none. */
  report: shiftReportResponseSchema.nullable(),
  /** The pulse's view of it: the bar and the fifth button. */
  phase: shiftReportPhaseEnum.nullable(),
  serverNow: isoTimestamp,
});

// ── «Нет в Hub»: what the site's own list showed (the extension) ────────────

export const clientSaleSightingsBodySchema = z.object({
  pageLabel: z.string().min(1).max(63),
  rows: z.array(z.object({
    /** Fansly's transaction id; ChatSpace's statement id when it has one. */
    platformRef: z.string().trim().min(1).max(200),
    /** Hub's canonical type the site's words read as: message_purchase, post_purchase, tip, stream_tip, subscription. */
    kind: z.string().min(1).max(64),
    occurredAt: isoTimestamp,
    grossMills: mills.min(0).max(100_000_000).nullable(),
    netMills: mills.min(0).max(100_000_000),
    fanRef: z.string().trim().min(1).max(200).nullable(),
    fanName: z.string().trim().min(1).max(200).nullable(),
  }).strict()).min(1).max(200),
}).strict();

export const clientSaleSightingsResponseSchema = z.object({
  /** Rows Hub does not hold as transactions: kept (new or seen again). */
  kept: z.number().int().nonnegative(),
  /** Rows Hub already holds: nothing kept. */
  known: z.number().int().nonnegative(),
  serverNow: isoTimestamp,
});

// ── Gengar's check after the hand-in (review:shift_reports) ─────────────────

export const agentShiftReportChecksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const agentShiftReportCheckSchema = z.object({
  candidateId: intId,
  shiftId: intId,
  /** The person's code; null — a login no person holds. */
  person: z.string().nullable(),
  userId: intId,
  personName: z.string(),
  startedAt: isoTimestamp,
  endedAt: isoTimestamp,
  cutoffAt: isoTimestamp,
  handedInAt: isoTimestamp,
  pages: z.array(z.string()),
  /** The candidate's lines as handed in, with the fan (the agent reads the chats by it). */
  lines: z.array(z.object({
    transactionId: intId,
    pageLabel: z.string(),
    kind: z.string(),
    occurredAt: isoTimestamp,
    netMills: mills,
    fan: z.object({ fanRef: z.string().nullable(), name: z.string().nullable(), username: z.string().nullable(), alias: z.string().nullable().optional() }),
    statement: shiftReportWordEnum.nullable(),
    /** The colleague of «пополам» or of «отдал»; null — none. */
    withUserId: intId.nullable(),
    note: z.string().nullable(),
    amountMills: mills,
    ruleWords: z.string(),
  })),
  /** The general comment; each model's, as its post carries it, in `comments`. */
  comment: z.string(),
  comments: shiftReportModelCommentsSchema.default([]),
  /** The people a proposal may name. */
  colleagues: z.array(z.object({ userId: intId, name: z.string() })),
});

export const agentShiftReportChecksResponseSchema = z.object({
  /** Candidates waiting for the check on the key's pages (every page of the shift in the grant), oldest first. */
  checks: z.array(agentShiftReportCheckSchema),
  /**
   * The reports standing in «Подтвердите» on the key's pages and of its realm (every page of the shift in the grant;
   * a report with a page outside is left out whole), oldest first: what the reminder «Отчёт не подтверждён сутки» reads.
   * `confirmSince` — when the report entered «Подтвердите» for its current candidate (the check finished, or the 10
   * minutes ran out; a candidate re-made since counts from its own hand-in).
   */
  awaitingConfirm: z.array(z.object({
    shiftId: intId,
    candidateId: intId,
    /** The person's code; null — a login no person holds. */
    person: z.string().nullable(),
    personName: z.string(),
    pages: z.array(z.string()),
    startedAt: isoTimestamp,
    confirmSince: isoTimestamp,
  })).default([]),
  serverNow: isoTimestamp,
});

export const agentShiftReportCheckParamsSchema = z.object({ candidateId: shiftIdParam });

export const agentShiftReportCheckBodySchema = z.object({
  /** «замечаний нет» when there is no proposal. */
  proposals: z.array(z.object({
    /** A sale of the candidate (else 400 `not_in_candidate`). */
    transactionId: intId,
    kind: z.enum(["owner_change", "note"]),
    /** owner_change: the word it should be (`rule` — back to the rule); `share` and `give` with `userId`. */
    to: z.object({
      word: z.enum(["rule", "mine", "not_mine", "share", "give", "pot"]),
      userId: intId.nullable().optional(),
    }).optional(),
    /** note: the comment. */
    note: z.string().trim().min(1).max(SHIFT_REPORT_NOTE_MAX).optional(),
    /** One or two sentences of why. */
    why: z.string().trim().min(1).max(600),
    /** The messages it read (links or `<chat>:<message>`). */
    messageRefs: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  }).strict()).max(100),
}).strict();

export const agentShiftReportCheckResponseSchema = z.object({
  candidateId: intId,
  /** Proposals recorded. */
  recorded: z.number().int().nonnegative(),
  /** The report was already counted: the proposals became a matter for the person, nothing changed by itself. */
  late: z.boolean(),
  /** The candidate was superseded: nothing recorded, the newer one comes in the next `checks`. */
  superseded: z.boolean(),
  serverNow: isoTimestamp,
});

export type ShiftReportConfirmResponse = z.infer<typeof shiftReportConfirmResponseSchema>;
export type ShiftReportSubmitBody = z.infer<typeof shiftReportSubmitBodySchema>;
export type ShiftReportCurrentResponse = z.infer<typeof shiftReportCurrentResponseSchema>;
export type ShiftReportAskBody = z.infer<typeof shiftReportAskBodySchema>;
export type ClientSaleSightingsBody = z.infer<typeof clientSaleSightingsBodySchema>;
export type AgentShiftReportChecksResponse = z.infer<typeof agentShiftReportChecksResponseSchema>;
export type AgentShiftReportCheckBody = z.infer<typeof agentShiftReportCheckBodySchema>;

// ── The agent's door (write:shift_reports) ──────────────────────────────────

/** Whose words: the sender of the Telegram message, checked against the person. */
const agentWords = {
  /** The Telegram id of the message's sender: must be the person's (people registry), else 409 `sender_not_person`. */
  telegramUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** The message the words are in (a link or `<chat>:<message>`). */
  sourceRef: z.string().trim().min(1).max(300).optional(),
};

export const agentShiftReportQuerySchema = z.object({
  /** The person by Telegram id (the sender of /smena)… */
  telegramUserId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  /** …or by the registry's code. */
  person: z.string().min(1).max(63).optional(),
  /** The shift; absent — the person's latest. */
  shiftId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).refine((query) => query.telegramUserId !== undefined || query.person !== undefined || query.shiftId !== undefined, "name the person or the shift");

export const agentShiftReportClaimableQuerySchema = z.object({
  shiftId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** The Telegram id of the person asking: must be the person's, else 409 `sender_not_person`. */
  telegramUserId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const agentShiftReportLineBodySchema = shiftReportLineBodySchema.extend({
  shiftId: intId,
  transactionId: intId,
  ...agentWords,
});

export const agentShiftReportCommentBodySchema = shiftReportCommentBodySchema.extend({ shiftId: intId, ...agentWords });

export const agentShiftReportOffPlatformBodySchema = shiftReportOffPlatformBodySchema.extend({ shiftId: intId, ...agentWords });

export const agentShiftReportSubmitBodySchema = z.object({
  shiftId: intId,
  telegramUserId: agentWords.telegramUserId,
  /** Required: a report is handed in «со слов» only with the message the words are in. */
  sourceRef: z.string().trim().min(1).max(300),
});

export const agentShiftReportsFeedQuerySchema = z.object({
  /** The `next` of the previous answer; absent — from the first version. */
  since: z.string().regex(/^\d{1,18}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const agentShiftReportsFeedItemSchema = z.object({
  /** The version's own id. */
  id: intId,
  /**
   * Its place in the feed (review R2-b): given when the feed first finds the version committed, after every place given
   * before. The feed's order and its cursor: `next` is the last place read. Every version written before 0405 has its
   * id as its place. A place moves only to the end: a version held back for a key gets a new one when the key may read
   * it, so the same version may come again at a later place — keep versions by `id`.
   */
  seq: intId,
  /** The person's code (the ledger's slug); null — a login no person holds. */
  person: z.string().nullable(),
  hubUserId: intId,
  /**
   * The shift the version was made under — the version's own, never changed (0426): a report moved to the shift that
   * remains after a merge keeps its earlier versions under the shift that is gone (the last of them a version with no
   * lines) and makes its next ones under the new shift. A shift's report is its highest version.
   */
  shiftId: intId,
  reportDate: businessDate,
  version: z.number().int().positive(),
  submittedAt: isoTimestamp,
  door: shiftReportDoorEnum,
  /** The Telegram message of a report handed in «со слов»; null — by the person's own session. */
  telegramMessageRef: z.string().nullable(),
  totalMills: mills,
  pages: z.array(z.object({ pageLabel: z.string(), amountMills: mills })),
  /** Every line of the version: what the person reported of each sale. */
  lines: z.array(z.object({
    transactionId: intId,
    pageLabel: z.string(),
    group: z.enum(["mine", "near"]),
    netMills: mills,
    /** The person's share by the rule. */
    ruleShareMills: mills,
    ruleHome: z.string(),
    ruleReason: z.string(),
    statement: shiftReportStatementEnum.nullable(),
    shareWithUserId: intId.nullable(),
    note: z.string().nullable(),
    /** What the line counts in the report: a disputed line counts 0 until it is settled (review R2b-2). */
    amountMills: mills,
    /** What a disputed «моё» claims while it counts nothing; null — not disputed. */
    claimedMills: mills.nullable().default(null),
    added: z.boolean(),
    disputed: z.boolean(),
    /** A claim on it settled (package G): agreed — the other side agreed; owner — the owner decided; the amount is what that gives. Null — not settled. */
    settled: z.enum(["agreed", "owner"]).nullable().default(null),
  })),
  /** «Мимо площадки»: never in `totalMills` until the owner confirms it; a confirmed one counts in its page's sum (`pageLabel`). */
  offPlatform: z.array(shiftReportOffPlatformSchema),
  /**
   * The comment as one text: the general one while no model has its own; else each model's (0432) — one text when they
   * are the same, otherwise a line «Model»: text per model.
   */
  comment: z.string(),
  /** Whether the ledger said the report date was paid when this version was made; null — not known. */
  dayPaid: z.boolean().nullable(),
  ruleVersion: z.string(),
  /**
   * Made by the system on someone's decision (package G), never by the person: a claim settled (`claim`: agreed by the
   * other side, or the owner's first, second, half, nobody) or the owner's word on «мимо площадки» (`off_platform`).
   * Null — handed in by the person. Such a version supersedes the one before it like any other.
   */
  madeFor: z.object({
    kind: z.enum(["claim", "off_platform", "decision"]),
    claimId: intId.nullable(),
    /** A decision recorded «со слов» through the agent's door (kind decision, review R2b-3). */
    decisionId: intId.nullable().default(null),
    offPlatformId: intId.nullable(),
    transactionId: intId.nullable(),
    outcome: z.string(),
    byUserId: intId.nullable(),
  }).nullable().default(null),
});

export const agentShiftReportsFeedResponseSchema = z.object({
  reports: z.array(agentShiftReportsFeedItemSchema),
  /**
   * The versions held back for the key (review R2b-4): each has a line of a page outside the key's pages. Who and when
   * and which pages, no sums, no lines — the reader records a problem instead of never knowing. A held version is
   * listed on every read until the key may read its pages. Then it gets a NEW place at the end of the feed and leaves
   * this list: it comes in `reports` through the cursor like any other version, so an answer that never arrived is
   * asked again with the same `since` and brings it again. It may come after newer versions of its report: a report's
   * newest version is the one with the highest `version`, not the last one read.
   */
  held: z.array(z.object({
    id: intId,
    seq: intId,
    shiftId: intId,
    person: z.string().nullable(),
    reportDate: z.string(),
    reason: z.enum(["page_outside_key"]),
    pageLabels: z.array(z.string()),
  })).default([]),
  /** Ask again with `since` = this (the last place read, served or held); the same as asked when nothing is new. */
  next: z.string(),
  /**
   * Whether places follow `next`. `limit` counts places, held ones too, so a page may carry fewer `reports` than
   * `limit` — none even — while more follow: read on while this is true (or until `next` is the `since` asked).
   */
  more: z.boolean(),
  serverNow: isoTimestamp,
});

export type ShiftReportStatement = z.infer<typeof shiftReportStatementEnum>;
export type ShiftReportDoor = z.infer<typeof shiftReportDoorEnum>;
export type ShiftReportLine = z.infer<typeof shiftReportLineSchema>;
export type ShiftReportLineFacts = z.infer<typeof shiftReportLineFactsSchema>;
export type ShiftReportBody = z.infer<typeof shiftReportBodySchema>;
export type ShiftReportResponse = z.infer<typeof shiftReportResponseSchema>;
export type ShiftReportLineBody = z.infer<typeof shiftReportLineBodySchema>;
export type ShiftReportReportSaleBody = z.infer<typeof shiftReportReportSaleBodySchema>;
export type ShiftReportReportSaleResponse = z.infer<typeof shiftReportReportSaleResponseSchema>;
export type ShiftReportOffPlatformBody = z.infer<typeof shiftReportOffPlatformBodySchema>;
export type ShiftReportsListResponse = z.infer<typeof shiftReportsListResponseSchema>;
export type ShiftReportClaimableResponse = z.infer<typeof shiftReportClaimableResponseSchema>;
export type AgentShiftReportsFeedResponse = z.infer<typeof agentShiftReportsFeedResponseSchema>;

const personErrors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema,
} as const;
const agentErrors = { ...personErrors, 503: errorResponseSchema } as const;

const ANY = "Any session (the narrow one the extension opens included) or the chat extension's device token: the person's own "
  + "report to write; a reader's to read. Database only.";

export const shiftHandinRouteSchemas = {
  shiftReport: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "A shift and its report: the draft with every sale and why, the versions handed in, the post in «Отчётность»",
    description: `${ANY} The person: the draft (computed now) and their versions; the owner every report; a team lead and a `
      + "colleague a shift on pages they may open, cut to those pages, the version handed in (a team lead also the draft).",
    params: shiftReportParamsSchema,
    response: { 200: shiftReportResponseSchema, ...personErrors },
  },
  shiftReportsList: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "The shifts of a person in a window with their report's state: «Идёт», «Сдайте смену», «Сдан»",
    description: `${ANY} Without userId the reader's own; with it someone else's shifts on pages the reader may open.`,
    querystring: shiftReportsListQuerySchema,
    response: { 200: shiftReportsListResponseSchema, ...personErrors },
  },
  teamShiftReports: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "The reports of the window's shifts of everyone the reader sees: state, Hub's sum for this reader, what they are made of",
    description: "Workboard «Смены → Отчёты»; read-only, database only. A cookie session of any role (the narrow one too); the "
      + "shifts on the pages of the reader's teams and their own (as `teamShiftSales`; `pageLabel` narrows to one, `userId` to "
      + "one person). The owner and the person read a report whole, anyone else cut to their pages (as `shiftReportsList`). "
      + "No draft is computed: a shift with nothing handed in carries its sales by the rule. No pay.",
    querystring: teamShiftReportsQuerySchema,
    response: { 200: teamShiftReportsResponseSchema, ...personErrors },
  },
  shiftReportClaimable: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "«Добавить → продажу»: the sales of the last 7 days the person may add to their report by hand",
    description: `${ANY} Own shift, switched on. Only pages the person may open; a sale any report of theirs holds is left out. `
      + "Adding one is `shiftReportLineSet` with «моё» and a line of why.",
    params: shiftReportParamsSchema,
    response: { 200: shiftReportClaimableResponseSchema, ...personErrors },
  },
  shiftReportLineSet: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "What the person says of a sale of the draft: «не моё», «делим с…», «моё», a note; saved at once",
    description: `${ANY} Own shift, switched on. «моё» on a sale of no line adds it by hand when it is one of shiftReportClaimable `
      + "(else 404); a statement the line does not take is 400.",
    params: shiftReportLineParamsSchema,
    body: shiftReportLineBodySchema,
    response: { 200: shiftReportSavedResponseSchema, ...personErrors, 409: shiftReportPhaseConflictSchema },
  },
  shiftReportReportSale: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "«Добавить продажу»: add an exact nobody's sale by transactionRef or fan + amount without revealing hidden sales",
    description: `${ANY} Own shift, switched on. Matches strictly 1 nobody's sale within caller's granted pages and realm; 0 or >1 matches return the identical 404 refusal with no candidate list. On exact match, writes the person's «моё» on it: the line counts the whole net like any other (another person's report holding it makes the hand-in's claim one with that colleague). No owner claim.`,
    params: shiftReportParamsSchema,
    body: shiftReportReportSaleBodySchema,
    response: { 200: shiftReportReportSaleResponseSchema, ...personErrors, 409: shiftReportPhaseConflictSchema },
  },
  shiftReportCommentSet: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "The draft's comment for the next shift and the owner; saved at once",
    description: ANY,
    params: shiftReportParamsSchema,
    body: shiftReportCommentBodySchema,
    response: { 200: shiftReportSavedResponseSchema, ...personErrors },
  },
  shiftReportOffPlatformAdd: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "«Мимо площадки»: money that came past the platform; waits for the owner, never in the sums before",
    description: ANY,
    params: shiftReportParamsSchema,
    body: shiftReportOffPlatformBodySchema,
    response: { 200: shiftReportOffPlatformResponseSchema, ...personErrors },
  },
  shiftReportOffPlatformWithdraw: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "Take back a «мимо площадки» line the owner has not decided yet",
    description: ANY,
    params: shiftReportOffPlatformParamsSchema,
    response: { 200: shiftReportSavedResponseSchema, ...personErrors },
  },
  shiftReportSubmit: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "«Сдать смену»: the draft as it is now becomes the report's next candidate, signed by the person when it is what they saw",
    description: `${ANY} Own shift, switched on; a shift still going may be handed in. Hub and Gengar check the candidate; `
      + "with `seenTotalMills` and `seenCount` equal to the candidate's it is signed, and a check that changes nothing makes "
      + "the version by that signature (no «Подтверждаю»). Unsigned, or changed by the check — the person confirms. A version "
      + "made after the ledger paid the day is kept and raises a matter for the owner.",
    params: shiftReportParamsSchema,
    // No body at all (an older client, a test, `inject` without payload) reaches the route as null: the same as none.
    body: shiftReportSubmitBodySchema.nullish(),
    response: { 200: shiftReportResponseSchema, ...personErrors },
  },
  agentShiftReport: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "A person's shift report as the person sees it, for their words (needs write:shift_reports)",
    description: "Database only. The person by Telegram id or code; the shift by id or the person's latest. Every page of the "
      + "shift must be of the key's grant, else 404.",
    querystring: agentShiftReportQuerySchema,
    response: { 200: shiftReportResponseSchema, ...agentErrors },
  },
  agentShiftReportClaimable: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "The sales a person may add to their report by hand, «со слов» (needs write:shift_reports)",
    description: "The pages the person may open and the key's grant both; the sender's Telegram id must be the person's.",
    querystring: agentShiftReportClaimableQuerySchema,
    response: { 200: shiftReportClaimableResponseSchema, ...agentErrors },
  },
  agentShiftReportLineSet: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Set what the person says of a sale, «со слов» (needs write:shift_reports)",
    description: "The sender's Telegram id must be the person's: else 409 `sender_not_person`.",
    body: agentShiftReportLineBodySchema,
    response: { 200: shiftReportSavedResponseSchema, ...agentErrors },
  },
  agentShiftReportReportSale: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Add an exact nobody's sale to the person's report «со слов» (needs write:shift_reports)",
    description: "Exact match by transactionRef or fan + amount within the person's pages, key's grant, and realm; 0 or >1 matches return the identical 404 refusal. Writes the person's «моё» on it: the line counts the whole net like any other (another person's report holding it makes the hand-in's claim one with that colleague). No owner claim.",
    body: agentShiftReportReportSaleBodySchema,
    response: { 200: shiftReportReportSaleResponseSchema, ...agentErrors },
  },
  agentShiftReportCommentSet: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Set the draft's comment, «со слов» (needs write:shift_reports)",
    body: agentShiftReportCommentBodySchema,
    response: { 200: shiftReportSavedResponseSchema, ...agentErrors },
  },
  agentShiftReportOffPlatformAdd: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Add «мимо площадки», «со слов» (needs write:shift_reports)",
    body: agentShiftReportOffPlatformBodySchema,
    response: { 200: shiftReportOffPlatformResponseSchema, ...agentErrors },
  },
  agentShiftReportSubmit: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Hand the shift in «со слов»: never without the message and its sender, who must be the person (needs write:shift_reports)",
    description: "The version records the door `telegram`, the message reference, the sender's Telegram id and the key.",
    body: agentShiftReportSubmitBodySchema,
    response: { 200: shiftReportResponseSchema, ...agentErrors },
  },
  shiftReportCurrent: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "The «Отчёт» board of the person's own shift that needs them most: the running one, else the newest not counted, else the newest",
    description: `${ANY} The board's frame opens with it when no shift is named.`,
    response: { 200: shiftReportCurrentResponseSchema, ...personErrors },
  },
  shiftReportConfirm: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "«Подтверждаю»: the named candidate, with Gengar's proposals not declined, becomes the report's next version",
    description: `${ANY} Own shift, switched on, phase «Подтвердите». A superseded candidate is refused with the fresh board; `
      + "no agent door confirms.",
    params: shiftReportParamsSchema,
    body: shiftReportConfirmBodySchema,
    response: { 200: shiftReportConfirmResponseSchema, ...personErrors },
  },
  shiftReportPostCopied: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "«Скопировать пост»: remember the copy of one model's post, so a later version that changes its page sums says «Пост изменился»",
    description: `${ANY} Own counted report. \`model\` — the model whose post was copied (one of the report's posts); absent — every post (a client before the per-model copy).`,
    params: shiftReportParamsSchema,
    querystring: shiftReportPostCopiedQuerySchema,
    response: { 200: shiftReportResponseSchema, ...personErrors },
  },
  shiftReportReopen: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "«Исправить»: back to editing («Правка»); a counted version stands until a new one is confirmed",
    description: ANY,
    params: shiftReportParamsSchema,
    response: { 200: shiftReportResponseSchema, ...personErrors },
  },
  shiftReportReopenCancel: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "«Отмена» of «Правка»: back to the counted report as it was",
    description: ANY,
    params: shiftReportParamsSchema,
    response: { 200: shiftReportResponseSchema, ...personErrors },
  },
  shiftReportResend: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "«Досдать»: sales that came after the hand-in and are the person's by the rule go into the next version at once",
    description: `${ANY} Own counted report. Only sales the rule gives the person and the report does not hold (else 400).`,
    params: shiftReportParamsSchema,
    body: shiftReportResendBodySchema,
    response: { 200: shiftReportResponseSchema, ...personErrors },
  },
  shiftReportAsk: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "«Записать себе» / «Спросить владельца»: a word from the draft about a sale the rule gives a colleague or the pot",
    description: `${ANY} Own draft. A colleague who hands shifts in by the board is told, not asked: the sale counts for `
      + "the person at once (all or the half), and the colleague may object («Не согласен»). The pot's, a colleague handing "
      + "in the old way, or a sale someone else already took, disputed or had decided is the decider's: it counts in "
      + "nobody's sum until decided.",
    params: shiftReportParamsSchema,
    body: shiftReportAskBodySchema,
    response: { 200: shiftReportResponseSchema, ...personErrors, 409: shiftReportPhaseConflictSchema },
  },
  shiftReportAskWithdraw: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "«Отменить» a question or a take: the sale back to what the rule gives",
    description: ANY,
    params: shiftReportAskParamsSchema,
    response: { 200: shiftReportResponseSchema, ...personErrors, 409: shiftReportPhaseConflictSchema },
  },
  shiftReportProposalAnswer: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "A card of Gengar: «Не согласен», «Вернуть правку», or «Принять» a late one (opens «Правка» with it applied)",
    description: ANY,
    params: shiftReportProposalParamsSchema,
    body: shiftReportProposalAnswerBodySchema,
    response: { 200: shiftReportResponseSchema, ...personErrors },
  },
  shiftReportSightingAdd: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "«Добавить» a «нет в Hub» row: it counts on the board, a version takes it once Hub holds the sale",
    description: ANY,
    params: shiftReportSightingParamsSchema,
    response: { 200: shiftReportResponseSchema, ...personErrors, 409: shiftReportPhaseConflictSchema },
  },
  clientSaleSightings: {
    auth: { kind: "apiKey" }, tags: ["client"],
    summary: "«Нет в Hub»: the sales a page's own list showed on the site, as the extension saw them",
    description: "Database only. A device token's. Hub keeps only rows it does not hold as transactions, once per "
      + "(page, platform reference). Sent only for a person whose pulse carries `report`.",
    body: clientSaleSightingsBodySchema,
    response: { 200: clientSaleSightingsResponseSchema, ...personErrors },
  },
  agentShiftReportChecks: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Candidates handed in and waiting for Gengar's check, on the key's pages (needs review:shift_reports)",
    description: "Database only. Every page of the shift must be of the key's grant. Oldest first.",
    querystring: agentShiftReportChecksQuerySchema,
    response: { 200: agentShiftReportChecksResponseSchema, ...agentErrors },
  },
  agentShiftReportCheckAnswer: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Gengar's answer to a candidate: «замечаний нет» or proposals (needs review:shift_reports); never a confirmation",
    description: "A proposal names a sale of the candidate and a legal word. After the report is counted the proposals "
      + "become a matter for the person and change nothing by themselves.",
    params: agentShiftReportCheckParamsSchema,
    body: agentShiftReportCheckBodySchema,
    response: { 200: agentShiftReportCheckResponseSchema, ...agentErrors },
  },
  agentShiftReportsFeed: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Every version of every shift report handed in, after a cursor: the ledger's feed (needs read:team and read:money)",
    description: "Database only. A version is served as soon as it is committed, in the order the feed placed it (`seq`): a "
      + "version committed after a later one is placed after it, so `next` never passes a version not served yet. A "
      + "version with a line on a page outside the key's grant is held back and listed in `held` on every read until the key "
      + "may read it; then it gets a new place at the end of the feed and comes in `reports` through the cursor (a lost "
      + "answer is asked again and brings it again). `limit` counts places: a page may carry fewer reports than asked "
      + "while `more` is true.",
    querystring: agentShiftReportsFeedQuerySchema,
    response: { 200: agentShiftReportsFeedResponseSchema, ...agentErrors },
  },
} as const;
