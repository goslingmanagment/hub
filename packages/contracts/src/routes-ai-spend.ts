/**
 * The owner's AI spend analytics ("Траты на ИИ"): Hub's ledger of every AI
 * call cut by day, hour, feature, model, effort, window, chatter, page,
 * Anthropic account and branch (a chatter's click or Hub's background lanes);
 * what each feature's answers cost per use; the dearest calls and chats; the
 * AI cost of a chatter's shift; and the live AI settings changed in the
 * period with the spend before and after. Owner session only.
 *
 * Money is micro-USD (1 000 000 = $1), Hub's own price of each call (the
 * provider's bill is the reconciliation's). Days and hours are Moscow time.
 * Numbers only: no prompt, answer or fan text.
 */
import { z } from "zod";

import { businessDate, errorResponseSchema, intId, isoTimestamp } from "./primitives.ts";

const count = z.number().int().nonnegative();
const microUsd = z.number().int();

export const adminAiSpendQuerySchema = z.object({
  from: businessDate,
  to: businessDate,
}).refine((value) => value.from <= value.to, { message: "from must be on or before to" });

/** Recorded spend split by token type at the model's list rates. `other` is
 *  what the split cannot place: estimated calls, refusal fallbacks priced at
 *  another model, and rounding. */
export const aiSpendPartsSchema = z.object({
  inputMicroUsd: microUsd,
  cacheReadMicroUsd: microUsd,
  cacheWriteMicroUsd: microUsd,
  outputMicroUsd: microUsd,
  otherMicroUsd: microUsd,
});

export const aiSpendTokensSchema = z.object({
  /** Input billed at the full rate: not read from the cache. */
  input: count,
  cacheRead: count,
  cacheWrite5m: count,
  cacheWrite1h: count,
  /** Cache writes of rows from before the TTL split was recorded. */
  cacheWriteUnsplit: count,
  /** Visible output and thinking: Anthropic bills them as one. */
  output: count,
});

export const aiSpendRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  calls: count,
  costMicroUsd: microUsd,
  /** Part of the cost that is an estimate (a call cut off before its usage). */
  approximateMicroUsd: microUsd,
  regenerationCalls: count,
  regenerationMicroUsd: microUsd,
  /** Failed and cancelled calls: the provider still billed what ran. */
  failedCalls: count,
  failedMicroUsd: microUsd,
  tokens: aiSpendTokensSchema,
  parts: aiSpendPartsSchema,
});

export const aiSpendFeatureUseSchema = z.object({
  feature: z.string(),
  calls: count,
  costMicroUsd: microUsd,
  perCallMicroUsd: microUsd.nullable(),
  /** False for features whose answer is not a draft (Recap, notes): the
   *  extension reports no use of them. */
  tracksUse: z.boolean(),
  usedCalls: count,
  sentCalls: count,
  sentMessages: count,
  /** The feature's whole cost over the messages sent from it. */
  perSentMessageMicroUsd: microUsd.nullable(),
  unusedCalls: count,
  unusedMicroUsd: microUsd,
});

export const aiSpendCallSchema = z.object({
  id: z.number().int().positive(),
  completedAt: isoTimestamp,
  feature: z.string(),
  model: z.string(),
  reasoningEffort: z.string().nullable(),
  contextMessages: count.nullable(),
  username: z.string().nullable(),
  pageLabel: z.string().nullable(),
  accountLabel: z.string().nullable(),
  conversationId: z.string().nullable(),
  inputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  outputTokens: count,
  costMicroUsd: microUsd,
  costApproximate: z.boolean(),
  outcome: z.string(),
  isRegeneration: z.boolean(),
});

const spendWindowSchema = z.object({
  hours: z.number().nonnegative(),
  microUsd: microUsd,
  /** Scaled to 24 hours; null for a window under an hour. */
  perDayMicroUsd: microUsd.nullable(),
});

export const aiSpendSettingChangeSchema = z.object({
  at: isoTimestamp,
  key: z.string(),
  username: z.string().nullable(),
  oldValue: z.unknown(),
  newValue: z.unknown(),
  /** For a per-feature setting, the features whose value changed; the spend
   *  windows below are theirs. Null: a whole-hub setting (all spend). */
  features: z.array(z.string()).nullable(),
  before: spendWindowSchema,
  after: spendWindowSchema,
});

export const aiSpendShiftsSchema = z.object({
  /** Shifts are read for the last days of the period only (at most 7). */
  from: isoTimestamp,
  to: isoTimestamp,
  shifts: count,
  workedMinutes: count,
  inShiftsMicroUsd: microUsd,
  outsideShiftsMicroUsd: microUsd,
  perShiftMicroUsd: microUsd.nullable(),
  perWorkedHourMicroUsd: microUsd.nullable(),
  byChatter: z.array(z.object({
    userId: z.number().int().positive(),
    username: z.string(),
    shifts: count,
    workedMinutes: count,
    inShiftsMicroUsd: microUsd,
    perShiftMicroUsd: microUsd.nullable(),
    perWorkedHourMicroUsd: microUsd.nullable(),
  })),
});

export const adminAiSpendResponseSchema = z.object({
  generatedAt: isoTimestamp,
  from: businessDate,
  to: businessDate,
  timeZone: z.string(),
  total: aiSpendRowSchema,
  breakdowns: z.object({
    feature: z.array(aiSpendRowSchema),
    model: z.array(aiSpendRowSchema),
    effort: z.array(aiSpendRowSchema),
    /** Chat messages the prompt held, bucketed. */
    window: z.array(aiSpendRowSchema),
    /** Key `background`: Hub's own lanes (facts, picture notes). */
    chatter: z.array(aiSpendRowSchema),
    page: z.array(aiSpendRowSchema),
    account: z.array(aiSpendRowSchema),
    /** `human`: a chatter's request; `background`: Hub's own lanes. */
    branch: z.array(aiSpendRowSchema),
    outcome: z.array(aiSpendRowSchema),
    day: z.array(aiSpendRowSchema),
    /** Hour of the day (00–23), summed over the period. */
    hour: z.array(aiSpendRowSchema),
    /** Key `YYYY-MM-DD|feature`: the daily chart's stacks. */
    dayFeature: z.array(aiSpendRowSchema),
  }),
  features: z.array(aiSpendFeatureUseSchema),
  conversations: z.object({
    count: count,
    costMicroUsd: microUsd,
    perConversationMicroUsd: microUsd.nullable(),
    top: z.array(z.object({
      pageLabel: z.string().nullable(),
      conversationId: z.string(),
      calls: count,
      costMicroUsd: microUsd,
      features: z.array(z.string()),
    })),
  }),
  topCalls: z.array(aiSpendCallSchema),
  shifts: aiSpendShiftsSchema,
  settingChanges: z.array(aiSpendSettingChangeSchema),
});

/**
 * The owner's personal daily AI limits: every living person, their limit and
 * what their AI cost in the current Moscow day over all pages. At the limit Hub
 * refuses every AI call of the person (429 quota_denied) until 00:00 Moscow time.
 */
export const adminAiChatterLimitSchema = z.object({
  userId: intId,
  username: z.string(),
  role: z.string(),
  /** Null: no personal limit (the common per-page cap still applies). */
  dailyLimitMicroUsd: z.number().int().nonnegative().nullable(),
  todayMicroUsd: count,
  /** What the person's AI cost yesterday. */
  yesterdayMicroUsd: count,
  /** What the person left unspent yesterday and so put into today's shared pool; null without a limit. */
  intoPoolMicroUsd: count.nullable(),
  /** Spent today past their own limit, out of the shared pool; null without a limit. */
  fromPoolMicroUsd: count.nullable(),
  /** Own limit and the shared pool both spent: AI is off for the person until `resetsAt`. */
  blocked: z.boolean(),
});

export const adminAiChatterLimitsResponseSchema = z.object({
  generatedAt: isoTimestamp,
  /** The Moscow day the spend is counted in. */
  day: businessDate,
  /** 00:00 Moscow time of the next day: every limit starts over. */
  resetsAt: isoTimestamp,
  /** Today's shared pool: yesterday's unspent limits of everyone with a limit; spent past one's own limit. */
  pool: z.object({ microUsd: count, usedMicroUsd: count, remainingMicroUsd: count }),
  chatters: z.array(adminAiChatterLimitSchema),
});

export const adminAiChatterLimitParamsSchema = z.object({
  userId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const adminAiChatterLimitUpdateBodySchema = z.object({
  /** Micro-USD per Moscow day; null removes the personal limit. */
  dailyLimitMicroUsd: z.number().int().nonnegative().max(1_000_000_000).nullable(),
}).strict();

export type AdminAiSpendQuery = z.infer<typeof adminAiSpendQuerySchema>;
export type AdminAiSpendResponse = z.infer<typeof adminAiSpendResponseSchema>;
export type AiSpendRow = z.infer<typeof aiSpendRowSchema>;
export type AdminAiChatterLimit = z.infer<typeof adminAiChatterLimitSchema>;
export type AdminAiChatterLimitsResponse = z.infer<typeof adminAiChatterLimitsResponseSchema>;
export type AdminAiChatterLimitUpdateBody = z.infer<typeof adminAiChatterLimitUpdateBodySchema>;

export const aiSpendRouteSchemas = {
  adminAiSpend: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "AI spend analytics: Hub's ledger by day, hour, feature, model, effort, window, chatter, page, account and branch",
    querystring: adminAiSpendQuerySchema,
    response: {
      200: adminAiSpendResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  adminAiChatterLimits: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Personal daily AI limits: each person's limit, AI spend today and yesterday, and today's shared pool",
    response: {
      200: adminAiChatterLimitsResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  adminAiChatterLimitUpdate: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Set or remove a person's personal daily AI limit",
    params: adminAiChatterLimitParamsSchema,
    body: adminAiChatterLimitUpdateBodySchema,
    response: {
      200: adminAiChatterLimitsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
} as const;
