import { z } from "zod";

import { CHATTER_SALE_KINDS } from "./chatter-stats.ts";
import { errorResponseSchema, intId, isoDateTime, isoTimestamp, mills } from "./primitives.ts";

/**
 * The team's sale facts for the agency ledger (ledger release 2,
 * docs/plans/2026-11-09-release-2.md in the ledger repo): every piece of the
 * team's work and every sale on the key's pages in a window, with the facts the
 * ledger's split rules read — who held the page, who sent the bought PPV, a tip
 * under a post or to a Campaign, who wrote to the fan last, the chatters' marks
 * and the owner's split. Facts only: whose a sale is, and what anyone is paid,
 * is the ledger's (owner, 2026-11-08). Needs `read:team` and `read:money`.
 */

/** The longest window of one read, days. */
export const AGENT_TEAM_SALES_MAX_DAYS = 31;
/** Work is read this far past the window's end (up to now): a PPV bought between its sender's shifts waits for the next. */
export const AGENT_TEAM_SALES_WORK_AFTER_DAYS = 7;
/** And this far before its start: a shift that began the evening before holds the window's first sales. */
export const AGENT_TEAM_SALES_WORK_BEFORE_DAYS = 1;

const count = z.number().int().nonnegative();
const role = z.enum(["owner", "team_lead", "chatter"]);

export const agentTeamSalesBodySchema = z.object({
  from: isoDateTime({ offset: true }),
  to: isoDateTime({ offset: true }),
}).superRefine((body, context) => {
  const from = Date.parse(body.from);
  const to = Date.parse(body.to);
  if (!(from < to)) context.addIssue({ code: "custom", path: ["to"], message: "`from` must be strictly before `to`" });
  else if (to - from > AGENT_TEAM_SALES_MAX_DAYS * 86_400_000) {
    context.addIssue({ code: "custom", path: ["to"], message: `at most ${AGENT_TEAM_SALES_MAX_DAYS} days` });
  }
});

const agentTeamWorkSchema = z.object({
  /** `<userId>:<startedAt>`: a sale's `holders` name works by it. */
  ref: z.string(),
  userId: intId,
  username: z.string(),
  role,
  /** A shift, or a look-in shorter than a shift (it holds only the sales to fans its person wrote to last). */
  kind: z.enum(["shift", "visit"]),
  startedAt: isoTimestamp,
  /** Hub's now for one going on. */
  endedAt: isoTimestamp,
  ongoing: z.boolean(),
  workedMinutes: count,
  /** The pages it worked; `salesFrom` — from when it holds the page's sales (null: it worked the page but holds none). */
  pages: z.array(z.object({ pageLabel: z.string(), messages: count, salesFrom: isoTimestamp.nullable() })),
});

const agentTeamSaleSchema = z.object({
  transactionRef: z.string(),
  pageLabel: z.string(),
  platform: z.string(),
  /** The fan's platform id; null — Hub knows no fan of it. */
  fanRef: z.string().nullable(),
  kind: z.enum(CHATTER_SALE_KINDS),
  /** The creator's net, mills. */
  netMills: mills,
  occurredAt: isoTimestamp,
  /** The works (`ref`) that held the page at the sale, by Hub's rule (chatter-shifts.ts `workHoldsSale`; a look-in only to its person's fan). */
  holders: z.array(z.string()),
  /** Who sent the PPV the fan bought (any role); null — not a PPV, its message not found, or sent without an author. */
  ppvSender: z.object({ userId: intId, username: z.string(), role }).nullable(),
  ppvSentAt: isoTimestamp.nullable(),
  /** A PPV whose message has no author (from a phone, a mass send). */
  ppvWithoutAuthor: z.boolean(),
  /** A tip under a wall post. */
  postTip: z.boolean(),
  /** An OnlyFans Campaign contribution. */
  campaign: z.boolean(),
  /** Who last wrote to the fan on the page in the 48 hours before the sale; null — nobody with an author. */
  lastWriterUserId: intId.nullable(),
  /** Everyone who wrote to the fan on the page in those 48 hours, most messages first. */
  writers: z.array(z.object({ userId: intId, username: z.string(), messages: count })),
  /** The chatters' marks of the sale in their shift reports. */
  marks: z.array(z.object({
    userId: intId,
    mark: z.enum(["mine", "share", "not_mine"]),
    shareWithUserId: intId.nullable(),
    /** «моё» with the chatter's own (lower) amount, mills. */
    amountMills: mills.nullable(),
  })),
  /** The owner's split of a disputed sale, percent per person; null — none. */
  resolution: z.array(z.object({ userId: intId, percent: z.number().int().min(0).max(100) })).nullable(),
});

export const agentTeamSalesResponseSchema = z.object({
  from: isoTimestamp,
  to: isoTimestamp,
  /** The work read: from AGENT_TEAM_SALES_WORK_BEFORE_DAYS before `from` to AGENT_TEAM_SALES_WORK_AFTER_DAYS after `to`, or now. */
  workFrom: isoTimestamp,
  workTo: isoTimestamp,
  /** The key's pages the sales were read on. */
  pages: z.array(z.string()),
  works: z.array(agentTeamWorkSchema),
  /** Every active sale on those pages in [from, to), oldest first. */
  sales: z.array(agentTeamSaleSchema),
  serverNow: isoTimestamp,
});

export type AgentTeamSalesBody = z.infer<typeof agentTeamSalesBodySchema>;
export type AgentTeamSalesResponse = z.infer<typeof agentTeamSalesResponseSchema>;
export type AgentTeamWork = z.infer<typeof agentTeamWorkSchema>;
export type AgentTeamSale = z.infer<typeof agentTeamSaleSchema>;

const agentErrors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 429: errorResponseSchema, 503: errorResponseSchema,
} as const;

export const agentTeamRouteSchemas = {
  agentTeamSales: {
    // No page in the path: the handler reads the key's own pages.
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "The team's work and every sale on the key's pages in a window (at most 31 days), with the facts whose a sale is"
      + " read from: who held the page, the bought PPV's sender, a post tip or Campaign, the last writer, the chatters' marks"
      + " and the owner's split. Facts only (needs read:team and read:money)",
    body: agentTeamSalesBodySchema,
    response: { 200: agentTeamSalesResponseSchema, ...agentErrors },
  },
} as const;
