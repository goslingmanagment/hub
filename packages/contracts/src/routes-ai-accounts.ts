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

/**
 * The ElevenLabs account behind voice notes, as Hub's account check last saw
 * it (every 30 min while voice notes are on). Read from Hub's own record —
 * opening this never asks ElevenLabs. Characters are ElevenLabs credits of
 * the current billing period.
 */
export const adminVoiceAccountResponseSchema = z.object({
  generatedAt: isoTimestamp,
  /** ELEVENLABS_API_KEY and the service proxy were set when the runtime started. */
  configured: z.boolean(),
  /** The live voiceNotesEnabled switch: Hub checks the account only while it is on. */
  enabled: z.boolean(),
  /** Null until the first check. */
  check: z.object({
    /** healthy; characters_low / characters_out (less than one voice note
     *  left); subscription_inactive; key_rejected; unreadable (the key may
     *  not read the account); check_failed (network, ElevenLabs down — not
     *  the account). */
    state: z.enum([
      "healthy",
      "characters_low",
      "characters_out",
      "subscription_inactive",
      "key_rejected",
      "unreadable",
      "check_failed",
    ]),
    checkedAt: isoTimestamp,
    /** The last check's HTTP status when it got no reading (0: no answer). */
    httpStatus: z.number().int().nullable(),
    /** The last successful reading; a failed check keeps it. */
    readAt: isoTimestamp.nullable(),
    tier: z.string().nullable(),
    subscriptionStatus: z.string().nullable(),
    charactersUsed: z.number().int().nonnegative().nullable(),
    charactersLimit: z.number().int().nonnegative().nullable(),
    nextResetAt: isoTimestamp.nullable(),
    /** Hub pages the owner when fewer characters than this are left. */
    lowThresholdChars: z.number().int().nonnegative().nullable(),
  }).nullable(),
});

export type AdminAiAccount = z.infer<typeof adminAiAccountSchema>;
export type AdminAiAccountsResponse = z.infer<typeof adminAiAccountsResponseSchema>;
export type AdminAiAccountUpdateBody = z.infer<typeof adminAiAccountUpdateBodySchema>;
export type AdminVoiceAccountResponse = z.infer<typeof adminVoiceAccountResponseSchema>;

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
  adminVoiceAccount: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "The ElevenLabs account behind voice notes: Hub's last check and reading",
    response: {
      200: adminVoiceAccountResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
} as const;
