/**
 * Workboard «Сегодня» and the person's own shifts (products plan §2.3, §3, §5; package W).
 *
 * - `accountShifts` — the signed-in person's shifts of a window, each with its report: Hub's shift (its sales by the
 *   rule), the ledger's report (the post in «Отчётность» or the agent's draft) and the report handed in in Hub. Which
 *   report is which shift's is decided on the server, in ONE place (services/own-shift-rows.ts); «Мои смены» and
 *   «Сегодня» read it from here. Two named numbers: the sales by the rule (`ruleMills`) and the counted report
 *   (`totalMills`). Sales only: no rate, pay or payout.
 * - `workboardToday` — what «Сегодня» shows beyond the person's own shifts: the previous shift's comment on the
 *   person's pages and the custom orders to give; for a person who leads a team (by its records) and the owner, the
 *   teams: who is on a shift, who the schedule names and is not on one, the schedule's gaps of the next three days,
 *   yesterday's shifts without a lead's note. Cut to the viewer's teams on the server (services/teams.ts). No money of
 *   people anywhere.
 */
import { z } from "zod";

import { chatterStatsSchema } from "./chatter-stats.ts";
import { personStartSchema } from "./person-start.ts";
import { businessDate, errorResponseSchema, intId, isoTimestamp, mills } from "./primitives.ts";
import { accountShiftReportSchema } from "./routes-account-reports.ts";
import { periodQualitySchema } from "./routes-client.ts";
import { shiftReportsListItemSchema } from "./routes-shift-handins.ts";

const count = z.number().int().nonnegative();

export const accountShiftsQuerySchema = z.object({
  /** Whole Moscow days back from `until` (default today), that day included; at most 31 (`accountChatterStats`). */
  days: z.coerce.number().int().min(1).max(31).default(7),
  until: businessDate.optional(),
});

/**
 * The state of a row: `posted` (posted in «Отчётность»), `draft` (the agent's draft, to check and post), `missing`
 * (ended, neither a draft nor a post), `ongoing` (going on), `unknown` (the reports, or the posts, did not come),
 * `other` (a state the ledger added later), and with the person's switch «сдаёт смену» on: `due` (hand it in),
 * `handed` (handed in).
 */
export const OWN_SHIFT_ROW_STATES = ["posted", "draft", "missing", "ongoing", "unknown", "other", "due", "handed"] as const;

export const ownShiftRowSchema = z.object({
  /** The shift's start, or `report:<id>` / `post:<date>` for a report Hub has no shift for. */
  key: z.string(),
  /** Hub's shift; null — a report whose shift Hub did not see. */
  shift: chatterStatsSchema.shape.shifts.element.nullable(),
  /** The ledger's report of the shift; null — none (yet), or the reports did not come. */
  report: accountShiftReportSchema.nullable(),
  /** Hub's worked time; null — a report alone. */
  workedMinutes: count.nullable(),
  /** «По правилу»: the shift's sales by the rule (Hub's); null — a report alone. */
  ruleMills: mills.nullable(),
  /** «По отчёту»: the report's one number (handed in; posted; else the draft's total); null — no report. */
  totalMills: mills.nullable(),
  /** The draft's total where the person posted another sum; null — the same, not posted, or no draft. */
  draftMills: mills.nullable(),
  /** Hub's figure shown where there is no report yet; null when there is one. */
  hubMills: mills.nullable(),
  state: z.enum(OWN_SHIFT_ROW_STATES),
  /** The shift's report in Hub (the switch on, a shift after it): the row opens it. Null — the old way. */
  hub: shiftReportsListItemSchema.nullable(),
  /** `totalMills` is a draft's, not handed in yet: «предварительно». */
  preliminary: z.boolean(),
});

export const accountShiftsResponseSchema = z.object({
  /** Hub's shifts of the window and their totals (`accountChatterStats`). */
  stats: chatterStatsSchema,
  /** The shown Moscow days, both included; `[startsAt, endsAt)` their instants. */
  window: z.object({ from: businessDate, to: businessDate, startsAt: isoTimestamp, endsAt: isoTimestamp }),
  /** false — the ledger's reports did not come: every row is Hub's shift, states `unknown`. */
  reportsRead: z.boolean(),
  /** false — the posts did not come (the drafts did): a shift without a draft may still have a post. */
  postsRead: z.boolean(),
  /** Newest first, a shift going on first. */
  rows: z.array(ownShiftRowSchema),
  /**
   * The window before, cut at the same point while this one goes on (at the start of the shift going on: its report
   * comes only when it ends), and its reports' sum; `reportedMills` null — nothing to compare with.
   */
  previous: z.object({ startsAt: isoTimestamp, endsAt: isoTimestamp, sameTime: z.boolean(), reportedMills: mills.nullable() }),
  serverNow: isoTimestamp,
});

const todayPersonSchema = z.object({ userId: intId, name: z.string() });

export const workboardTodayResponseSchema = z.object({
  /**
   * «От прошлой смены»: the comment a colleague left for the next shift on their last report (the last 36 hours) on
   * the person's pages, newest first; never the person's own.
   */
  handover: z.array(z.object({
    shiftId: intId,
    person: todayPersonSchema,
    pages: z.array(z.string()),
    endedAt: isoTimestamp,
    comment: z.string(),
  })),
  /** Custom orders shot and not given yet on the person's pages: «отдайте фану». */
  customsToGive: z.array(z.object({ code: z.string(), pageLabel: z.string().nullable(), fanName: z.string().nullable(), since: isoTimestamp })),
  /** The teams the viewer leads (the owner: every team); null — the viewer leads none (or a narrow session). */
  team: z.object({
    /** The viewer leads by a record granted in the last three days, or leads nothing yet: the card «Первый день». */
    firstDay: z.boolean(),
    teams: z.array(z.object({
      modelId: intId,
      name: z.string(),
      /** The team's lead; null — none: its matters are the owner's. */
      leadName: z.string().nullable(),
      people: count,
      /**
       * On a shift now. `endedAt` — the last time Hub looked at it; `pauses` — its pauses so far: a break going on now is
       * the last one, up to `endedAt` (a break inside the person's own slot goes on to the slot's end).
       */
      onShift: z.array(todayPersonSchema.extend({
        startedAt: isoTimestamp,
        endedAt: isoTimestamp,
        pauses: z.array(z.object({ from: isoTimestamp, to: isoTimestamp })),
        pages: z.array(z.string()),
      })),
      /** The schedule names them now (their slot began at least 15 minutes ago) and they are not on a shift. */
      absent: z.array(todayPersonSchema.extend({ start: z.string(), end: z.string() })),
      /** The hours of the next three days (from now) no slot of the team covers, Moscow time. */
      gaps: z.array(z.object({ day: businessDate, start: z.string(), end: z.string() })),
      /** Nobody of the team has a schedule: the gaps say nothing. */
      noSchedule: z.boolean(),
    })),
    /** Yesterday's closed shifts (Moscow) on the teams' pages with no note of a lead or the owner yet. */
    reviews: z.array(todayPersonSchema.extend({ startedAt: isoTimestamp, endedAt: isoTimestamp, pages: z.array(z.string()), workedMinutes: count })),
  }).nullable(),
  serverNow: isoTimestamp,
});

/** A shift's quality (the review's rules, shift-review-rules.ts), from the stored shift numbers. */
const shiftQualitySchema = z.object({
  replyMedianSeconds: count.nullable(),
  unansweredAtEnd: count,
  aiUneditedShare: z.number().min(0).max(1).nullable(),
});

export const teamNewcomersResponseSchema = z.object({
  /**
   * The newcomers of the viewer's teams (the owner: every one): a chatter not working yet (invited, set up), or working
   * for less than a week since their first minute in the extension. The newest first.
   */
  newcomers: z.array(z.object({
    code: z.string(),
    name: z.string(),
    state: z.enum(["invited", "set_up", "working"]),
    /** The teams (models) of the person's working pages; empty — none yet (the owner gives the pages). */
    teams: z.array(z.string()),
    /** «Начало»: the steps as Hub sees them; null — no login yet. Never where the person is paid. */
    start: personStartSchema.nullable(),
    /** The first minute in the extension; null — none yet. */
    firstActiveAt: isoTimestamp.nullable(),
    /** The first shifts (up to 5, from the first minute), oldest first, each with its quality and whether a lead wrote a note. */
    shifts: z.array(z.object({
      userId: intId,
      startedAt: isoTimestamp,
      endedAt: isoTimestamp,
      ongoing: z.boolean(),
      pages: z.array(z.string()),
      workedMinutes: count,
      /** null — the shift's numbers are not stored yet. */
      quality: shiftQualitySchema.nullable(),
      /** A lead (or the owner) left a note on its review. */
      noted: z.boolean(),
    })),
    /** The team's norm: its closed shifts of the last 14 days, «в среднем за смену»; null — no team, or no stored numbers. */
    team: periodQualitySchema.extend({ people: count }).nullable(),
  })),
  serverNow: isoTimestamp,
});

export type TeamNewcomersResponse = z.infer<typeof teamNewcomersResponseSchema>;
export type AccountShiftsQuery = z.infer<typeof accountShiftsQuerySchema>;
export type AccountShiftsResponse = z.infer<typeof accountShiftsResponseSchema>;
export type OwnShiftRow = z.infer<typeof ownShiftRowSchema>;
export type OwnShiftRowState = (typeof OWN_SHIFT_ROW_STATES)[number];
export type WorkboardTodayResponse = z.infer<typeof workboardTodayResponseSchema>;

export const workboardTodayRouteSchemas = {
  accountShifts: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "The caller's own shifts of a window, each with its report (Hub's shift, the ledger's report, the report handed in in Hub)",
    description: "Workboard «Мои смены» and «Сегодня»; read-only. Which report is which shift's is decided here, in one "
      + "place. Sales only, no pay. The ledger not answering leaves `reportsRead` false and the shifts still come.",
    querystring: accountShiftsQuerySchema,
    response: { 200: accountShiftsResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema },
  },
  workboardToday: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "Workboard «Сегодня»: the previous shift's comment, customs to give; the teams the viewer leads",
    description: "Any session; read-only, database only. The team part only for a person who leads a team by its "
      + "records and the owner (never a narrow session), cut to those teams. No money of people.",
    response: { 200: workboardTodayResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema },
  },
  teamNewcomers: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "«Команда → Новички»: each newcomer's first week in the teams the viewer leads",
    description: "The owner every team; a person who leads a team by its records, that team's newcomers; anyone else 403. "
      + "A full session (not the extension's). «Начало» as Hub sees it, the first shifts with their quality and notes, the "
      + "team's norm. Database only; no money of people, never where a person is paid.",
    response: { 200: teamNewcomersResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema },
  },
} as const;
