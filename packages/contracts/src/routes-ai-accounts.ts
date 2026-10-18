/**
 * The Anthropic accounts Hub spends (ANTHROPIC_API_KEYS): each account's
 * state, what Hub spent through it, and the balance left by the owner's last
 * reading of the Anthropic console. Owner session only. Keys never appear:
 * only their last four characters.
 *
 * Money is micro-USD (1 000 000 = $1) — Hub's own price of every call it
 * made, not Anthropic's invoice. Anthropic has no API for an account's
 * remaining credit, so the balance is estimated: the owner's reading minus
 * Hub's spend through the account since.
 */
import { z } from "zod";

import { errorResponseSchema, intId, isoTimestamp } from "./primitives.ts";

const microUsd = z.number().int().nonnegative();

export const adminAiAccountSchema = z.object({
  id: intId,
  label: z.string(),
  /** Place in the spending order: lower first. */
  priority: z.number().int(),
  enabled: z.boolean(),
  /** active: in rotation; exhausted: Anthropic refused for credit (tried
   *  again hourly); invalid: Anthropic rejected the key. */
  status: z.enum(["active", "exhausted", "invalid"]),
  statusReason: z.string().nullable(),
  statusChangedAt: isoTimestamp.nullable(),
  /** False: the label is no longer in ANTHROPIC_API_KEYS (history only). */
  configured: z.boolean(),
  /** The account Hub spends right now. */
  serving: z.boolean(),
  keyHint: z.string().nullable(),
  lastUsedAt: isoTimestamp.nullable(),
  spent: z.object({
    last24hMicroUsd: microUsd,
    last7dMicroUsd: microUsd,
    last30dMicroUsd: microUsd,
  }),
  requests: z.object({
    last24h: z.number().int().nonnegative(),
    last30d: z.number().int().nonnegative(),
  }),
  /** Null until the owner notes a balance read in the Anthropic console. */
  balance: z.object({
    readMicroUsd: microUsd,
    readAt: isoTimestamp,
    spentSinceMicroUsd: microUsd,
    /** The reading minus the spend since; 0 once spent past it. */
    estimatedMicroUsd: microUsd,
    /** At the last 3 days' pace of all Anthropic spend; null without spend. */
    daysLeft: z.number().nonnegative().nullable(),
  }).nullable(),
});

export const adminAiAccountsResponseSchema = z.object({
  generatedAt: isoTimestamp,
  accounts: z.array(adminAiAccountSchema),
  /** All Anthropic spend per day over the last 3 days (every account). */
  dailyBurnMicroUsd: microUsd,
  /** Anthropic spend of the last 30 days that names no account (calls made
   *  before accounts were tracked). */
  unattributed30dMicroUsd: microUsd,
});

export const adminAiAccountParamsSchema = z.object({
  accountId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const adminAiAccountUpdateBodySchema = z.object({
  enabled: z.boolean().optional(),
  /** One place earlier or later in the spending order. */
  move: z.enum(["up", "down"]).optional(),
  /** The balance the owner reads in the Anthropic console now, in micro-USD;
   *  null forgets the reading. */
  balanceMicroUsd: z.number().int().nonnegative().max(100_000_000_000).nullable().optional(),
}).strict().refine(
  (body) => body.enabled !== undefined || body.move !== undefined || body.balanceMicroUsd !== undefined,
  { message: "Nothing to change" },
);

export type AdminAiAccount = z.infer<typeof adminAiAccountSchema>;
export type AdminAiAccountsResponse = z.infer<typeof adminAiAccountsResponseSchema>;
export type AdminAiAccountUpdateBody = z.infer<typeof adminAiAccountUpdateBodySchema>;

export const aiAccountRouteSchemas = {
  adminAiAccountsList: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "List the Anthropic accounts Hub spends: state, spend and estimated balance",
    response: {
      200: adminAiAccountsResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  adminAiAccountUpdate: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Change an Anthropic account's on/off, its place in the order or its noted balance",
    params: adminAiAccountParamsSchema,
    body: adminAiAccountUpdateBodySchema,
    response: {
      200: adminAiAccountsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
} as const;
