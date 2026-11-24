/**
 * The ledger's feed of computed sale homes (0441, Contract K1): every `sale_homes` row change (`upsert` or `retract`)
 * after a cursor, with the person (`personCode`) and report day (`reportDate`, `daySource`) of every share. Needs
 * `read:money` and page grants; test-realm rows are filtered before `held` so they never enter a live key's feed, held
 * list, or cursor.
 */
import { z } from "zod";

import { CHATTER_SALE_KINDS } from "./chatter-stats.ts";
import { businessDate, errorResponseSchema, intId, isoTimestamp, mills } from "./primitives.ts";

export const SALE_HOME_SHARE_DAY_SOURCES = ["report", "shift", "visit", "holding_shift", "sale_day", "unresolved"] as const;
export type SaleHomeShareDaySourceContract = (typeof SALE_HOME_SHARE_DAY_SOURCES)[number];

export const agentSaleHomesFeedQuerySchema = z.object({
  /** The `next` of the previous answer; absent — from the first change. */
  since: z.string().regex(/^\d{1,18}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const agentSaleHomeShareSchema = z.object({
  /** The person's code in the people registry; null — login not linked to a person. */
  personCode: z.string().nullable(),
  userId: intId,
  /** The shift row credited; null — visit, sale_day, unresolved, or shift row not synced yet. */
  shiftId: intId.nullable(),
  /** The work credited (`<userId>:<startedAt>`); null — none held the sale. */
  workRef: z.string().nullable(),
  /** The share's Moscow report date (YYYY-MM-DD); null when `daySource` is `unresolved`. */
  reportDate: businessDate.nullable(),
  daySource: z.enum(SALE_HOME_SHARE_DAY_SOURCES),
  percent: z.number().int().min(0).max(100),
  mills,
});

export const agentSaleHomeFeedItemSchema = z.object({
  seq: intId,
  at: isoTimestamp,
  op: z.enum(["upsert", "retract"]),
  transactionId: intId,
  pageLabel: z.string().nullable(),
  occurredAt: isoTimestamp.nullable(),
  netMills: mills.nullable(),
  saleKind: z.enum(CHATTER_SALE_KINDS).nullable(),
  home: z.string().nullable(),
  reason: z.string().nullable(),
  pot: z.string().nullable(),
  waitsUntil: isoTimestamp.nullable(),
  ruleVersion: z.string().nullable(),
  shares: z.array(agentSaleHomeShareSchema),
});

export const agentSaleHomesFeedResponseSchema = z.object({
  /**
   * Every computed sale home change after the cursor, in the order the feed placed it (`seq`): `upsert` carries the
   * current computed row (including empty `shares` for pot/nobody/waiting/decide), `retract` carries null upsert-only
   * fields and `shares: []`. Safe to replay: apply whenever `seq` is greater.
   */
  homes: z.array(agentSaleHomeFeedItemSchema),
  /** Changes on pages outside the key's grant: listed on every read until granted, then re-placed at the end. */
  held: z.array(z.object({ seq: intId, transactionId: intId, reason: z.enum(["page_outside_key"]) })).default([]),
  /** Ask again with `since` = this (the last place read in the key's realm, served or held); unchanged when idle. */
  next: z.string(),
  /**
   * Whether places follow `next`. `limit` counts places (including held ones), so a page may carry fewer `homes` than
   * `limit` while more follow: read on while `more` is true.
   */
  more: z.boolean(),
  serverNow: isoTimestamp,
});

export type AgentSaleHomeShare = z.infer<typeof agentSaleHomeShareSchema>;
export type AgentSaleHomeFeedItem = z.infer<typeof agentSaleHomeFeedItemSchema>;
export type AgentSaleHomesFeedResponse = z.infer<typeof agentSaleHomesFeedResponseSchema>;

const agentErrors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 429: errorResponseSchema, 503: errorResponseSchema,
} as const;

export const saleHomesRouteSchemas = {
  agentSaleHomesFeed: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Feed of computed sale homes (`upsert`/`retract`) after a cursor, with person and report day of every share (needs read:money)",
    description: "Database only. Every change of `sale_homes` is placed once committed under an advisory lock so late commits land after "
      + "the cursor. Test-realm changes are filtered before `held` and never enter a live key's feed, held list, or cursor. Changes on "
      + "pages outside the key's grant are listed in `held` and re-placed at the end once granted. `limit` (1..500) counts placed positions.",
    querystring: agentSaleHomesFeedQuerySchema,
    response: { 200: agentSaleHomesFeedResponseSchema, ...agentErrors },
  },
} as const;
