import { z } from "zod";

import { isoTimestamp, mills } from "./primitives.ts";

// The page of one OnlyFans link, beside the reads of ./of-links.ts: the fans
// the link brought (a local read of the paid walks of its fan lists, tables
// page_link_fans and page_link_fan_periods — no request to OnlyFans) and the
// link's source when it has none: the proposal, the sources to choose from,
// and the owner's first binding.

const linkKind = z.enum(["tracking", "trial"]);

/**
 * Whether the fan is still subscribed, by the walks' own fields:
 *   active  in the link's subscriber list at its last walk, flagged active
 *           there, and not missed by two finished walks in a row — the
 *           period his spending counts for the link is open;
 *   left    flagged expired at his last sighting, or missed twice;
 *   null    known only from the tracking link's spenders list: the
 *           subscriber list never showed him.
 */
export const ofLinkFanStatusSchema = z.enum(["active", "left"]);

export const ofLinkFanSchema = z.object({
  /** Hub's fan id. */
  fanId: z.number().int().positive(),
  /** The platform's id of the fan (what the fan card's address carries). */
  fanRef: z.string(),
  /** The name Hub shows for the fan on this page (the chatters' name for him, else his profile name); null: none. */
  name: z.string().nullable(),
  username: z.string().nullable(),
  /** The fan deleted his account: no name, no login. */
  deleted: z.boolean(),
  /** When he subscribed by the link: the platform's own date when the walk carries one, otherwise the start of his
   *  first period. Null: before the link's first finished walk, or never in its subscriber list — he came no later
   *  than `firstSeenAt`. */
  subscribedAt: isoTimestamp.nullable(),
  /** The first walk that showed him. */
  firstSeenAt: isoTimestamp,
  status: ofLinkFanStatusSchema.nullable(),
  /** What he paid by the link, as OnlyFans counts it (net, a tracking link's spenders list). Null: unknown — a trial
   *  link, or a fan the spenders list has not shown; never zero for unknown. */
  paidMills: mills.nullable(),
});
export type OfLinkFan = z.infer<typeof ofLinkFanSchema>;

export const ofLinkFansResponseSchema = z.object({
  generatedAt: isoTimestamp,
  pageId: z.number().int().positive(),
  linkKind,
  linkRef: z.string(),
  /** Every fan the link's lists have shown. */
  total: z.number().int().nonnegative(),
  /** Fans whose money is above zero; null when no fan's money is known (a trial link). */
  paying: z.number().int().nonnegative().nullable(),
  /** When a list of the link was last read to the end; null: never — the list is as fresh as this. */
  walkedAt: isoTimestamp.nullable(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  /** By money, highest first (unknown last), then the newest first. */
  fans: z.array(ofLinkFanSchema),
});
export type OfLinkFansResponse = z.infer<typeof ofLinkFansResponseSchema>;

export const ofLinkSourceChoiceSchema = z.object({
  channelKey: z.string(),
  channelTitle: z.string(),
});
export type OfLinkSourceChoice = z.infer<typeof ofLinkSourceChoiceSchema>;

export const ofLinkSourceResponseSchema = z.object({
  pageId: z.number().int().positive(),
  linkKind,
  linkRef: z.string(),
  /** The link has a binding at some time (open, closed or to come): changing it stays with the owner's CLI. */
  bound: z.boolean(),
  /** Which source the link probably is, by its name (traffic-source-proposal.ts); null when bound, or nothing fits. */
  proposedChannel: ofLinkSourceChoiceSchema.nullable(),
  /** Every source, by title. */
  channels: z.array(ofLinkSourceChoiceSchema),
});
export type OfLinkSourceResponse = z.infer<typeof ofLinkSourceResponseSchema>;

export const ofLinkSourcePutBodySchema = z.object({
  pageId: z.number().int().positive(),
  linkKind,
  linkRef: z.string().regex(/^[0-9]{1,20}$/),
  channelKey: z.string().min(1).max(130),
});
export type OfLinkSourcePutBody = z.infer<typeof ofLinkSourcePutBodySchema>;

export const ofLinkSourcePutResponseSchema = ofLinkSourceResponseSchema.extend({
  /** Where the binding starts: the link's creation at OnlyFans, else the first time the series read it. */
  validFrom: isoTimestamp,
});
