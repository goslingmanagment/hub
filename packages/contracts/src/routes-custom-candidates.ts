/**
 * Заказ кастома, the candidates of a custom with no order (customs facts spec §8): Hub never guesses a custom from the
 * stream of tips — the word «custom» is almost never in a tip's note — so it gives the agent's reader the sales worth
 * reading the chat around. The reader reads them and posts a finding, or leaves the sale. For an agent key that writes
 * the customs and reads money and messages (`write:customs` + `read:money` + `read:messages`), of the key's pages only.
 * Database only.
 */
import { z } from "zod";

import { customOrderFanSchema } from "./custom-orders.ts";
import { errorResponseSchema, isoTimestamp, mills } from "./primitives.ts";

/** A tip of this size or more is a candidate. */
export const CUSTOM_CANDIDATE_TIP_MIN_MILLS = 40_000;
/** … of this many last days. */
export const CUSTOM_CANDIDATE_DAYS = 14;

export const agentCustomCandidateTipSchema = z.object({
  /** Hub's id of the sale (`saleRef` of the agent doors): a finding of it is `{source: "sale", ref: <this>}`. */
  saleRef: z.string(),
  pageLabel: z.string(),
  fan: customOrderFanSchema.nullable(),
  grossMills: mills,
  at: isoTimestamp,
  /** The fan's note with the tip; null — none known. */
  note: z.string().nullable(),
});

export const agentCustomCandidateTierSchema = z.object({
  pageLabel: z.string(),
  fan: customOrderFanSchema.nullable(),
  /** The tier the fan holds now, one that includes a custom (its words, corrected by the setting `customTierOverrides`). */
  tierRef: z.string(),
  tierName: z.string().nullable(),
  /** When the current subscription ends; null — not known. */
  endsAt: isoTimestamp.nullable(),
  /** The sale of the current period (Hub's id), its gross and time; null — no such sale seen. */
  saleRef: z.string().nullable(),
  grossMills: mills.nullable(),
  at: isoTimestamp.nullable(),
});

export const agentCustomCandidatesResponseSchema = z.object({
  /** Tips of $40 and more of the last 14 days that pay no order and have no finding, the newest first. */
  tips: z.array(agentCustomCandidateTipSchema),
  /** Fans holding a tier that includes a custom whose current period has no resolved finding. */
  tiers: z.array(agentCustomCandidateTierSchema),
  serverNow: isoTimestamp,
});

export type AgentCustomCandidatesResponse = z.infer<typeof agentCustomCandidatesResponseSchema>;

export const customCandidateRouteSchemas = {
  agentCustomCandidates: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Sales that may be a custom with no order, for the reader to read the chat around (needs write:customs, read:money, read:messages)",
    description: "Database only, the key's pages only: tips of $40 and more of the last 14 days that pay no order and have no finding, "
      + "and fans holding a tier that includes a custom whose current period has no resolved finding. Hub records nothing from them.",
    response: {
      200: agentCustomCandidatesResponseSchema,
      400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 429: errorResponseSchema, 503: errorResponseSchema,
    },
  },
} as const;
