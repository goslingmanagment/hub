/**
 * Workboard pots (0443, H11): owner pot management, pure distribution preview, immutable posted distributions,
 * reversals, unrouted pot sales, legacy ledger pots archive, the K2 feed
 * (`GET /api/v1/agent/pot-distributions/feed`, `read:money`) for the agency ledger, and a person's own share
 * (`GET /api/v1/account/pots`, any session: their own lines and expected share, never a colleague's, never pay).
 */
import { z } from "zod";

import { businessDate, errorResponseSchema, intId, isoTimestamp, mills } from "./primitives.ts";

// ── Matter kinds owned by the pots service ───────────────────────────────────

export const POT_MATTER_KINDS = ["pot.unrouted", "pot.no_participants", "pot.sale_left", "pot.excess_base"] as const;
export type PotMatterKind = (typeof POT_MATTER_KINDS)[number];
const POT_MATTER_KIND_SET: ReadonlySet<string> = new Set(POT_MATTER_KINDS);
export function isPotMatterKind(kind: string): boolean {
  return POT_MATTER_KIND_SET.has(kind);
}

// ── Shared primitives ────────────────────────────────────────────────────────

const idParam = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const POT_INTAKE_REASONS = ["post_tip", "campaign"] as const;
export const POT_PARTICIPANTS_MODES = ["page_workers", "listed"] as const;
export const POT_FORMULA_KINDS = ["equal", "weights", "manual"] as const;
export const POT_STATES = ["open", "closed"] as const;

export const potCodeSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "lowercase latin letters, digits, hyphens and underscores");

export const potParticipantPeriodSchema = z.object({
  personCode: z.string().trim().min(1).max(64),
  fromDay: businessDate,
  toDay: businessDate.nullable(),
});

export const potFormulaSchema = z.object({
  kind: z.enum(POT_FORMULA_KINDS),
  params: z.record(z.string(), z.unknown()).default({}),
});

export const potDistributionLineSchema = z.object({
  personCode: z.string().min(1),
  baseMills: mills,
  basis: z.string(),
});

export const potDistributionPartSchema = z.object({
  transactionId: intId,
  pageId: intId,
  pageLabel: z.string(),
  baseMills: mills,
});

export const potSummarySchema = z.object({
  id: intId,
  code: z.string(),
  name: z.string(),
  modelId: intId,
  modelSlug: z.string(),
  modelName: z.string(),
  pageIds: z.array(intId),
  pageLabels: z.array(z.string()),
  intakeReasons: z.array(z.enum(POT_INTAKE_REASONS)),
  opensOn: businessDate,
  closesOn: businessDate.nullable(),
  participantsMode: z.enum(POT_PARTICIPANTS_MODES),
  participants: z.array(potParticipantPeriodSchema),
  formula: potFormulaSchema,
  autoPost: z.boolean(),
  state: z.enum(POT_STATES),
  eligibleBaseMills: mills,
  postedBaseMills: mills,
  balanceMills: mills,
  eligibleCount: z.number().int().nonnegative(),
  distributionsCount: z.number().int().nonnegative(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

export const potUnroutedSaleSchema = z.object({
  transactionId: intId,
  pageId: intId,
  pageLabel: z.string(),
  modelSlug: z.string(),
  kind: z.string(),
  occurredAt: isoTimestamp,
  day: businessDate,
  netMills: mills,
  remainingBaseMills: mills,
  reason: z.string(),
  pot: z.string().nullable(),
  why: z.enum(["unknown_code", "closed_or_outside", "no_matching_page_pot", "ambiguous_page_pot"]),
  matchingPotCodes: z.array(z.string()),
});

export const legacyLedgerPotSchema = z.object({
  slug: z.string(),
  name: z.string(),
  model: z.string(),
  pages: z.array(z.string()),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  status: z.string(),
  sales: z.number().int().nonnegative(),
  netMills: mills,
  participants: z.array(z.object({
    person: z.string(),
    from: z.string(),
    to: z.string().nullable(),
  })),
});

export const potDistributionItemSchema = z.object({
  id: intId,
  potId: intId,
  day: businessDate,
  formula: potFormulaSchema,
  baseMills: mills,
  lines: z.array(potDistributionLineSchema),
  parts: z.array(potDistributionPartSchema),
  postedAt: isoTimestamp,
  postedByName: z.string().nullable(),
  reversedAt: isoTimestamp.nullable(),
  reversedByName: z.string().nullable(),
  reversedReason: z.string().nullable(),
});

export const potEligibleSaleSchema = z.object({
  transactionId: intId,
  pageId: intId,
  pageLabel: z.string(),
  kind: z.string(),
  occurredAt: isoTimestamp,
  day: businessDate,
  netMills: mills,
  distributedElsewhereMills: mills,
  distributedHereMills: mills,
  remainingBaseMills: mills,
  reason: z.string(),
});

// ── Owner Workboard endpoints ────────────────────────────────────────────────

export const potsListResponseSchema = z.object({
  potsFrom: businessDate.nullable(),
  pots: z.array(potSummarySchema),
  unroutedCount: z.number().int().nonnegative(),
  unroutedBaseMills: mills,
  unrouted: z.array(potUnroutedSaleSchema),
  models: z.array(z.object({
    id: intId,
    slug: z.string(),
    name: z.string(),
    pages: z.array(z.object({ id: intId, label: z.string(), platform: z.string() })),
  })),
  people: z.array(z.object({
    code: z.string(),
    displayName: z.string(),
    role: z.string(),
    state: z.string(),
  })),
  legacyArchive: z.object({
    available: z.boolean(),
    error: z.string().nullable(),
    pots: z.array(legacyLedgerPotSchema),
  }),
  serverNow: isoTimestamp,
});

export const potIdParamsSchema = z.object({ potId: idParam });
export const potDistributionIdParamsSchema = z.object({ distributionId: idParam });

export const potDetailResponseSchema = z.object({
  potsFrom: businessDate.nullable(),
  pot: potSummarySchema,
  activeParticipants: z.array(z.string()),
  sales: z.array(potEligibleSaleSchema),
  distributions: z.array(potDistributionItemSchema),
  serverNow: isoTimestamp,
});

export const potCreateBodySchema = z.object({
  code: potCodeSchema,
  name: z.string().trim().min(1).max(160),
  modelId: intId,
  pageIds: z.array(intId).min(1).max(100),
  intakeReasons: z.array(z.enum(POT_INTAKE_REASONS)).max(2).default([]),
  opensOn: businessDate,
  closesOn: businessDate.nullable().default(null),
  participantsMode: z.enum(POT_PARTICIPANTS_MODES),
  participants: z.array(potParticipantPeriodSchema).max(200).default([]),
  formula: potFormulaSchema,
  autoPost: z.boolean().default(false),
});

export const potUpdateBodySchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  pageIds: z.array(intId).min(1).max(100).optional(),
  intakeReasons: z.array(z.enum(POT_INTAKE_REASONS)).max(2).optional(),
  opensOn: businessDate.optional(),
  closesOn: businessDate.nullable().optional(),
  participantsMode: z.enum(POT_PARTICIPANTS_MODES).optional(),
  participants: z.array(potParticipantPeriodSchema).max(200).optional(),
  formula: potFormulaSchema.optional(),
  autoPost: z.boolean().optional(),
});

export const potMutateResponseSchema = z.object({
  pot: potSummarySchema,
  savedAt: isoTimestamp,
});

export const potsCreatePagePotsBodySchema = z.object({
  opensOn: businessDate.optional(),
});

export const potsCreatePagePotsResponseSchema = z.object({
  created: z.array(potSummarySchema),
  skippedPageLabels: z.array(z.string()),
  savedAt: isoTimestamp,
});

export const potDistributionPartInputSchema = z.object({
  transactionId: intId,
  baseMills: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const potDistributionRequestBodySchema = z.object({
  day: businessDate.optional(),
  formula: potFormulaSchema.optional(),
  parts: z.array(potDistributionPartInputSchema).min(1, "empty_parts").max(1000).optional(),
});

export const potDistributionPreviewResponseSchema = z.object({
  potId: intId,
  day: businessDate,
  formula: potFormulaSchema,
  participants: z.array(z.string()),
  parts: z.array(potDistributionPartSchema),
  baseMills: mills,
  lines: z.array(potDistributionLineSchema),
  error: z.object({ reason: z.string(), message: z.string() }).nullable(),
  serverNow: isoTimestamp,
});

export const potDistributionPostResponseSchema = z.object({
  distribution: potDistributionItemSchema,
  savedAt: isoTimestamp,
});

export const potDistributionReverseBodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export const potDistributionReverseResponseSchema = z.object({
  distribution: potDistributionItemSchema,
  savedAt: isoTimestamp,
});

// ── Agent K2 feed (`GET /api/v1/agent/pot-distributions/feed`) ───────────────

export const agentPotDistributionsFeedQuerySchema = z.object({
  /** The `next` of the previous answer; absent or "0" — from the first change. */
  since: z.string().regex(/^\d{1,18}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const agentPotDistributionFeedItemSchema = z.object({
  seq: intId,
  change: z.enum(["posted", "reversed"]),
  at: isoTimestamp,
  distribution: z.object({
    id: intId,
    pot: z.object({
      code: z.string(),
      name: z.string(),
      modelSlug: z.string(),
    }),
    day: businessDate,
    formula: potFormulaSchema,
    inflows: z.array(z.object({
      transactionId: intId,
      pageLabel: z.string(),
      baseMills: mills,
    })),
    baseMills: mills,
    lines: z.array(potDistributionLineSchema),
  }),
});

export const agentPotDistributionsFeedResponseSchema = z.object({
  changes: z.array(agentPotDistributionFeedItemSchema),
  held: z.array(z.object({
    seq: intId,
    distributionId: intId,
    modelSlug: z.string(),
    pageLabels: z.array(z.string()),
    reason: z.enum(["page_outside_key"]),
  })),
  next: z.string(),
  more: z.boolean(),
  serverNow: isoTimestamp,
});

// ── The person's own share (`GET /api/v1/account/pots`, Workboard «Сегодня») ──

/** The widest window: the same as «Мои деньги» (`accountPay`). */
export const ACCOUNT_POTS_MAX_DAYS = 61;

export const accountPotsQuerySchema = z.object({
  /** Moscow days (a distribution's day: its sale's day), both included. */
  from: businessDate,
  to: businessDate,
});

/** One pot the caller has a share in: their own lines only, never anyone else's code, base or count of lines. */
export const accountPotSchema = z.object({
  code: z.string(),
  name: z.string(),
  pageLabels: z.array(z.string()),
  /** The caller's own lines of the window's non-reversed distributions, added up (base, not pay). */
  mineMills: mills,
  /** How many of the window's distributions carry a line of the caller. */
  distributions: z.number().int().nonnegative(),
  /** Among how many the caller's latest distribution of the window was split; null — none in the window. */
  lastSplit: z.number().int().positive().nullable(),
  /** The caller's expected line of the pot's base not distributed yet (any day since `potsFrom`). */
  pendingMills: mills,
  /** The caller is among the pot's participants today (Moscow). */
  participantToday: z.boolean(),
});

export const accountPotsResponseSchema = z.object({
  /** Pots live in Workboard for the window: `potsFrom` is set and not after `to`. */
  on: z.boolean(),
  potsFrom: businessDate.nullable(),
  from: businessDate,
  to: businessDate,
  /** The pots' `mineMills` added up. */
  totalMills: mills,
  /** The pots' `pendingMills` added up. */
  pendingMills: mills,
  /** Only pots with a line of the caller in the window, a pending share, or the caller among today's participants. */
  pots: z.array(accountPotSchema),
  serverNow: isoTimestamp,
});

// ── Exported types ───────────────────────────────────────────────────────────

export type AccountPotsQuery = z.infer<typeof accountPotsQuerySchema>;
export type AccountPot = z.infer<typeof accountPotSchema>;
export type AccountPotsResponse = z.infer<typeof accountPotsResponseSchema>;
export type PotFormula = z.infer<typeof potFormulaSchema>;
export type PotParticipantPeriod = z.infer<typeof potParticipantPeriodSchema>;
export type PotDistributionLine = z.infer<typeof potDistributionLineSchema>;
export type PotSummary = z.infer<typeof potSummarySchema>;
export type PotUnroutedSale = z.infer<typeof potUnroutedSaleSchema>;
export type LegacyLedgerPot = z.infer<typeof legacyLedgerPotSchema>;
export type PotDistributionItem = z.infer<typeof potDistributionItemSchema>;
export type PotEligibleSale = z.infer<typeof potEligibleSaleSchema>;
export type PotsListResponse = z.infer<typeof potsListResponseSchema>;
export type PotDetailResponse = z.infer<typeof potDetailResponseSchema>;
export type PotCreateBody = z.infer<typeof potCreateBodySchema>;
export type PotUpdateBody = z.infer<typeof potUpdateBodySchema>;
export type PotDistributionPreviewResponse = z.infer<typeof potDistributionPreviewResponseSchema>;
export type AgentPotDistributionFeedItem = z.infer<typeof agentPotDistributionFeedItemSchema>;
export type AgentPotDistributionsFeedResponse = z.infer<typeof agentPotDistributionsFeedResponseSchema>;

// ── Route schemas ────────────────────────────────────────────────────────────

const ownerErrors = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
} as const;

const agentErrors = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  429: errorResponseSchema,
  503: errorResponseSchema,
} as const;

export const potsRouteSchemas = {
  potsList: {
    auth: { kind: "owner-session" },
    tags: ["pots"],
    summary: "Workboard pots list, computed base balances, unrouted pot sales, and legacy ledger pots archive",
    response: { 200: potsListResponseSchema, ...ownerErrors },
  },
  potDetail: {
    auth: { kind: "owner-session" },
    tags: ["pots"],
    summary: "Single pot detail: eligible sales with remaining base, active participants, and distributions",
    params: potIdParamsSchema,
    querystring: z.object({ day: businessDate.optional() }),
    response: { 200: potDetailResponseSchema, ...ownerErrors },
  },
  potCreate: {
    auth: { kind: "owner-session" },
    tags: ["pots"],
    summary: "Create a Workboard pot (page pot or event pot)",
    body: potCreateBodySchema,
    response: { 200: potMutateResponseSchema, ...ownerErrors },
  },
  potUpdate: {
    auth: { kind: "owner-session" },
    tags: ["pots"],
    summary: "Edit an open Workboard pot and enqueue affected days for re-routing",
    params: potIdParamsSchema,
    body: potUpdateBodySchema,
    response: { 200: potMutateResponseSchema, ...ownerErrors },
  },
  potClose: {
    auth: { kind: "owner-session" },
    tags: ["pots"],
    summary: "Close an open Workboard pot",
    params: potIdParamsSchema,
    response: { 200: potMutateResponseSchema, ...ownerErrors },
  },
  potsCreatePagePots: {
    auth: { kind: "owner-session" },
    tags: ["pots"],
    summary: "Create default auto-post equal page pots for every active page without one",
    body: potsCreatePagePotsBodySchema,
    response: { 200: potsCreatePagePotsResponseSchema, ...ownerErrors },
  },
  potDistributionPreview: {
    auth: { kind: "owner-session" },
    tags: ["pots"],
    summary: "Pure preview of a pot distribution (no DB write)",
    params: potIdParamsSchema,
    body: potDistributionRequestBodySchema,
    response: { 200: potDistributionPreviewResponseSchema, ...ownerErrors },
  },
  potDistributionPost: {
    auth: { kind: "owner-session" },
    tags: ["pots"],
    summary: "Post an immutable pot distribution under the global pot lock",
    params: potIdParamsSchema,
    body: potDistributionRequestBodySchema,
    response: { 200: potDistributionPostResponseSchema, ...ownerErrors },
  },
  potDistributionReverse: {
    auth: { kind: "owner-session" },
    tags: ["pots"],
    summary: "Reverse a posted pot distribution with a mandatory reason, restoring remaining base",
    params: potDistributionIdParamsSchema,
    body: potDistributionReverseBodySchema,
    response: { 200: potDistributionReverseResponseSchema, ...ownerErrors },
  },
  accountPots: {
    auth: { kind: "any-session" },
    tags: ["client"],
    summary: "The caller's own share of the pots: their lines of the window's distributions and their expected share of the base not distributed yet",
    description: "Workboard «Сегодня»; read-only, database only. The person is the session user's, found through the people "
      + "registry; the query names only the window (Moscow days, at most 61). Base mills (the share of a pot's sales "
      + "counted into the person's sales), never pay, rates or terms; never a colleague's code, line or base. A login "
      + "that is nobody's — `on` as the switch says, no pots.",
    querystring: accountPotsQuerySchema,
    response: {
      200: accountPotsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  agentPotDistributionsFeed: {
    auth: { kind: "agentKey" },
    tags: ["agent"],
    summary: "Feed of posted and reversed Workboard pot distributions after a cursor (Contract K2, needs read:money)",
    description: "Database only. Every posted or reversed pot distribution is placed once committed under an advisory lock so late commits land after the cursor. Test-realm distributions are filtered before `held` and never enter a live key's feed, held list, or cursor. A distribution is held while any page of its pot or inflows is outside the key's granted pages.",
    querystring: agentPotDistributionsFeedQuerySchema,
    response: { 200: agentPotDistributionsFeedResponseSchema, ...agentErrors },
  },
} as const;
