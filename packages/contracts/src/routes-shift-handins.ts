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

import { businessDate, errorResponseSchema, intId, isoTimestamp, mills } from "./primitives.ts";
import { shiftReportClaimSchema } from "./sale-claims.ts";

export const SHIFT_REPORT_STATEMENTS = ["mine", "not_mine", "share"] as const;
export const SHIFT_REPORT_DOORS = ["extension", "workboard", "telegram"] as const;
export const shiftReportStatementEnum = z.enum(SHIFT_REPORT_STATEMENTS);
export const shiftReportDoorEnum = z.enum(SHIFT_REPORT_DOORS);

/** The longest note of a line, and the comment. */
export const SHIFT_REPORT_NOTE_MAX = 300;
export const SHIFT_REPORT_COMMENT_MAX = 2000;
/** The widest window of `shiftReportsList`, Moscow days. */
export const SHIFT_REPORTS_LIST_MAX_DAYS = 62;

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
  /** The Moscow day the shift is reported on (the ledger's rule). */
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
  fan: z.object({ fanRef: z.string().nullable(), name: z.string().nullable(), username: z.string().nullable() }),
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
  comment: z.string(),
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
  posts: z.array(z.object({ modelName: z.string(), text: z.string() })),
  /** Own: the people a «делим с…» may name. */
  colleagues: z.array(z.object({ userId: intId, name: z.string() })),
  /**
   * The claims of the report's sales (package G): incoming — someone claims a sale of the person (the person answers
   * «Согласен» / «Не согласен» here); outgoing — the person's own claims, with the other side's answer and the owner's
   * decision. A reader of shared pages sees those of the pages they may open; the owner every one.
   */
  claims: z.array(shiftReportClaimSchema).default([]),
  serverNow: isoTimestamp,
});

export const shiftReportLineBodySchema = z.object({
  /** null — back to the rule's word. «не моё», «делим с…» on «Ваши продажи»; «моё» on «Рядом». */
  statement: shiftReportStatementEnum.nullable(),
  /** With «делим с…»: the colleague. */
  shareWithUserId: intId.nullable().optional(),
  /** Empty or null — none. «Моё» on «Рядом» needs one line of why. */
  note: z.string().trim().max(SHIFT_REPORT_NOTE_MAX).nullable().optional(),
});

export const shiftReportCommentBodySchema = z.object({
  comment: z.string().max(SHIFT_REPORT_COMMENT_MAX),
});

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
});

export const shiftReportsListResponseSchema = z.object({
  /** The person's switch. Off — the list is empty and «Мои смены» stays as before. */
  enabled: z.boolean(),
  /** When it was turned on: a shift that began earlier keeps its old report (the post). */
  enabledSince: isoTimestamp.nullable(),
  shifts: z.array(shiftReportsListItemSchema),
  serverNow: isoTimestamp,
});

/** «Добавить → продажу»: a sale of the last 7 days the person may add to the report by hand. */
export const shiftReportClaimableSaleSchema = z.object({
  transactionId: intId,
  pageLabel: z.string(),
  platform: z.string(),
  kind: z.string(),
  occurredAt: isoTimestamp,
  netMills: mills,
  fan: z.object({ fanRef: z.string().nullable(), name: z.string().nullable(), username: z.string().nullable() }),
  /** The rule's home: nobody — «ничья» (it counts plainly when added); anything else — counted and disputed when added. */
  home: z.string(),
  /** Whose it is by the rule, in plain words. */
  words: z.string(),
});

export const shiftReportClaimableResponseSchema = z.object({
  /** On the pages the person may open, in no report of theirs; nobody's first, then the newest first. */
  sales: z.array(shiftReportClaimableSaleSchema),
  serverNow: isoTimestamp,
});

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
   * before. The feed's order and its cursor: `next` is the last place served. Every version written before 0405 has its
   * id as its place.
   */
  seq: intId,
  /** The person's code (the ledger's slug); null — a login no person holds. */
  person: z.string().nullable(),
  hubUserId: intId,
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
   * listed on every read until the key may read its pages; then the next read serves it in `reports`, ahead of the new
   * ones, at its own `seq` (below the cursor): take every item of `reports` whatever its seq. The cursor passing a held
   * version never loses it.
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
  serverNow: isoTimestamp,
});

export type ShiftReportStatement = z.infer<typeof shiftReportStatementEnum>;
export type ShiftReportDoor = z.infer<typeof shiftReportDoorEnum>;
export type ShiftReportLine = z.infer<typeof shiftReportLineSchema>;
export type ShiftReportLineFacts = z.infer<typeof shiftReportLineFactsSchema>;
export type ShiftReportBody = z.infer<typeof shiftReportBodySchema>;
export type ShiftReportResponse = z.infer<typeof shiftReportResponseSchema>;
export type ShiftReportLineBody = z.infer<typeof shiftReportLineBodySchema>;
export type ShiftReportOffPlatformBody = z.infer<typeof shiftReportOffPlatformBodySchema>;
export type ShiftReportsListResponse = z.infer<typeof shiftReportsListResponseSchema>;
export type ShiftReportClaimableResponse = z.infer<typeof shiftReportClaimableResponseSchema>;
export type ShiftReportsListItem = z.infer<typeof shiftReportsListItemSchema>;
export type AgentShiftReportsFeedResponse = z.infer<typeof agentShiftReportsFeedResponseSchema>;
export type AgentShiftReportsFeedItem = z.infer<typeof agentShiftReportsFeedItemSchema>;

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
    response: { 200: shiftReportSavedResponseSchema, ...personErrors },
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
    summary: "«Сдать смену»: the draft as it is now becomes the report's next version",
    description: `${ANY} Own shift, switched on; a shift still going may be handed in. A version handed in after the ledger paid `
      + "the day is kept and raises a matter for the owner.",
    params: shiftReportParamsSchema,
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
  agentShiftReportsFeed: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Every version of every shift report handed in, after a cursor: the ledger's feed (needs read:team and read:money)",
    description: "Database only. A version is served as soon as it is committed, in the order the feed placed it (`seq`): a "
      + "version committed after a later one is placed after it, so `next` never passes a version not served yet. A "
      + "version with a line on a page outside the key's grant is held back and listed in `held` on every read until the key "
      + "may read it; then it is served in `reports` at its own place.",
    querystring: agentShiftReportsFeedQuerySchema,
    response: { 200: agentShiftReportsFeedResponseSchema, ...agentErrors },
  },
} as const;
