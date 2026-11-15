/**
 * Вопросы тому, кто решает (products plan 2026-11-13 §4.6): a chatter asks before doing what is the decider's to allow;
 * the decider of the page's model (`deciderOf`, services/teams.ts: the team's lead, the owner when there is none or when
 * the lead asks) answers «Можно» or «Нельзя» with a line; the answer comes back to the asker. ONE object, two doors:
 *
 * - Workboard «Ждут вас» → «Спросить» (these operations from a person's session);
 * - the extension's fan panel (a later package): the same two operations, `teamQuestionAsk` with the fan filled in
 *   (`fanRef`, `fanName`, `door: "extension"`) and `teamQuestions` for the panel's own questions — both open to the
 *   narrow session the extension opens; the answer reaches the extension's icon number as the asker's matter
 *   (`question.answered`, `clientMatters`).
 *
 * Answering is a decision: a full session only (never the extension's narrow one). Database only; no money of anyone.
 */
import { z } from "zod";

import { errorResponseSchema, intId, isoTimestamp } from "./primitives.ts";

/**
 * The kinds, in the form's order: скидка больше 50 %, бесплатно платное, цена кастома, условия киту, подмена, опоздание;
 * and «График» (products package W): a lead's proposal of the standing schedule, always the owner's to answer.
 */
export const TEAM_QUESTION_KINDS = ["discount_over_50", "free_paid", "custom_price", "whale_terms", "swap", "late", "schedule"] as const;
export type TeamQuestionKind = (typeof TEAM_QUESTION_KINDS)[number];

/** The kinds' words, the same in every door. */
export const TEAM_QUESTION_KIND_WORDS: Readonly<Record<TeamQuestionKind, string>> = {
  discount_over_50: "Скидка больше 50 %",
  free_paid: "Отправить платное бесплатно",
  custom_price: "Цена кастома",
  whale_terms: "Условия киту",
  swap: "Подмена",
  late: "Опоздание",
  schedule: "График",
};

/** A slot's edge by Moscow time, `HH:MM` (an end may be `24:00`). */
const swapTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, "a time is HH:MM by Moscow time");

/**
 * «Подмена» (products package W, 0422): the day, the pages, the hours of the slot, who covers (a person of the same team)
 * and who cannot come (the asker's person when absent; a lead may ask for a person of their team). Its «Можно» writes the
 * registry's one-day lines of that day: the covering person's on top of their own, the absent person's «off» there.
 */
export const teamQuestionSwapBodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pageLabels: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
  start: swapTime,
  end: swapTime,
  coverPersonCode: z.string().trim().min(1).max(80),
  absentPersonCode: z.string().trim().min(1).max(80).optional(),
});
export type TeamQuestionSwapBody = z.infer<typeof teamQuestionSwapBodySchema>;

export const teamQuestionSwapSchema = z.object({
  date: z.string(),
  pages: z.array(z.string()),
  start: z.string(),
  end: z.string(),
  absent: z.object({ code: z.string(), name: z.string() }),
  cover: z.object({ code: z.string(), name: z.string() }),
  /** «Можно» wrote its day lines and they stand (not taken back). */
  approved: z.boolean(),
  /** Taken back by the decider before the day. */
  revoked: z.boolean(),
  /** The viewer may take the approved swap back: its decider or the owner, before the day. */
  canRevoke: z.boolean(),
});
export type TeamQuestionSwap = z.infer<typeof teamQuestionSwapSchema>;

/**
 * The matters of a question, the question service their one writer (an agent key opens or closes none): the decider's
 * «ждёт ответа» (`question.asked`) while it is open, the asker's answer (`question.answered`) until they have read it.
 */
export const TEAM_QUESTION_MATTER_KINDS = ["question.asked", "question.answered"] as const;
const QUESTION_KIND_SET: ReadonlySet<string> = new Set(TEAM_QUESTION_MATTER_KINDS);
export function isTeamQuestionMatterKind(kind: string): boolean {
  return QUESTION_KIND_SET.has(kind);
}

export const TEAM_QUESTION_STATES = ["open", "answered", "withdrawn"] as const;
export const TEAM_QUESTION_ANSWERS = ["yes", "no"] as const;

export const teamQuestionSchema = z.object({
  id: intId,
  kind: z.enum(TEAM_QUESTION_KINDS),
  text: z.string(),
  pageLabel: z.string(),
  /** The fan it is about; null — none. */
  fan: z.object({ fanRef: z.string().nullable(), name: z.string().nullable() }).nullable(),
  asker: z.object({ userId: intId, name: z.string() }),
  /** Who decides: a team lead by name, or the owner. */
  decider: z.object({ kind: z.enum(["owner", "team_lead"]), name: z.string() }),
  door: z.enum(["workboard", "extension"]),
  askedAt: isoTimestamp,
  state: z.enum(TEAM_QUESTION_STATES),
  /** «Можно» (`yes`) or «Нельзя» (`no`); null — not answered. */
  answer: z.enum(TEAM_QUESTION_ANSWERS).nullable(),
  answerText: z.string().nullable(),
  answeredBy: z.string().nullable(),
  answeredAt: isoTimestamp.nullable(),
  /** The asker has read the answer. */
  seen: z.boolean(),
  /** The viewer is the one to answer it (the decider, or the owner). */
  canAnswer: z.boolean(),
  /** The viewer asked it: they may withdraw it while open, mark the answer read. */
  mine: z.boolean(),
  /** «Подмена»'s details; null — any other kind (and a swap asked without them). */
  swap: teamQuestionSwapSchema.nullable(),
});
export type TeamQuestion = z.infer<typeof teamQuestionSchema>;

export const teamQuestionsQuerySchema = z.object({
  /** One question (a matter's link opens it). */
  id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

export const teamQuestionsResponseSchema = z.object({
  /** The viewer's own of the last 30 days (open and answered, newest first), and those waiting for their answer. */
  questions: z.array(teamQuestionSchema),
  serverNow: isoTimestamp,
});
export type TeamQuestionsResponse = z.infer<typeof teamQuestionsResponseSchema>;

export const teamQuestionAskBodySchema = z.object({
  /** A page of the asker's teams or their own. */
  pageLabel: z.string().trim().min(1).max(200),
  kind: z.enum(TEAM_QUESTION_KINDS),
  text: z.string().trim().min(1).max(500),
  fanRef: z.string().trim().min(1).max(200).optional(),
  fanName: z.string().trim().min(1).max(200).optional(),
  door: z.enum(["workboard", "extension"]).default("workboard"),
  /** «Подмена»'s details (kind `swap` only); its «Можно» writes the day's lines of the schedule. */
  swap: teamQuestionSwapBodySchema.optional(),
});
export type TeamQuestionAskBody = z.infer<typeof teamQuestionAskBodySchema>;

export const teamQuestionAnswerBodySchema = z.object({
  answer: z.enum(TEAM_QUESTION_ANSWERS),
  text: z.string().trim().max(500).optional(),
});
export type TeamQuestionAnswerBody = z.infer<typeof teamQuestionAnswerBodySchema>;

export const teamQuestionCloseBodySchema = z.object({
  /** `withdraw` — the asker takes back an open question; `seen` — the asker read the answer. */
  how: z.enum(["withdraw", "seen"]),
});
export type TeamQuestionCloseBody = z.infer<typeof teamQuestionCloseBodySchema>;

export const teamQuestionParamsSchema = z.object({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

export const teamQuestionWriteResponseSchema = z.object({ question: teamQuestionSchema, savedAt: isoTimestamp });
export type TeamQuestionWriteResponse = z.infer<typeof teamQuestionWriteResponseSchema>;

/** «График»'s swaps of the days ahead (products package W): the approved ones whose lines stand, on the viewer's teams' pages. */
export const teamSwapsResponseSchema = z.object({
  swaps: z.array(teamQuestionSwapSchema.extend({ questionId: intId })),
  serverNow: isoTimestamp,
});
export type TeamSwapsResponse = z.infer<typeof teamSwapsResponseSchema>;

const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema } as const;

export const teamQuestionRouteSchemas = {
  teamQuestions: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "The viewer's questions to whoever decides, and those waiting for their answer",
    description: "Any session (the extension's narrow one too: the fan panel's door). A person's own questions, the ones "
      + "they decide (a team's lead), every open one for the owner. Database only.",
    querystring: teamQuestionsQuerySchema,
    response: { 200: teamQuestionsResponseSchema, ...errors },
  },
  teamQuestionAsk: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "Ask whoever decides: a kind, the fan when there is one, one line",
    description: "Any session (the extension's narrow one too). A page of the asker's teams or their own; the decider is "
      + "the lead of the page's model, the owner when the team has none or its lead asks. Opens the decider's matter.",
    body: teamQuestionAskBodySchema,
    response: { 200: teamQuestionWriteResponseSchema, ...errors },
  },
  teamQuestionAnswer: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "Answer a question «Можно» or «Нельзя», with a line",
    description: "Its decider or the owner, a full session (a decision: never the extension's). Closes the decider's "
      + "matter and opens the asker's.",
    params: teamQuestionParamsSchema,
    body: teamQuestionAnswerBodySchema,
    response: { 200: teamQuestionWriteResponseSchema, ...errors },
  },
  teamQuestionClose: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "The asker withdraws an open question, or marks the answer read",
    description: "The asker only; the narrow session too. Closes the matter it opened.",
    params: teamQuestionParamsSchema,
    body: teamQuestionCloseBodySchema,
    response: { 200: teamQuestionWriteResponseSchema, ...errors },
  },
  teamSwaps: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "«График»: the approved swaps of the next 14 days on the viewer's teams' pages",
    description: "Any session (the extension's narrow one too: a chatter reads the team's «График»). Cut to the viewer's "
      + "teams (services/teams.ts). Database only; no money.",
    response: { 200: teamSwapsResponseSchema, ...errors },
  },
  teamSwapRevoke: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "Take an approved swap back before its day: its one-day lines are marked taken back, nothing is deleted",
    description: "The swap's decider or the owner, a full session. The asker's answer matter says it.",
    params: teamQuestionParamsSchema,
    response: { 200: teamQuestionWriteResponseSchema, ...errors },
  },
} as const;
