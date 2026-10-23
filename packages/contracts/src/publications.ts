import { z } from "zod";

import {
  PUBLICATION_ACTOR_KINDS,
  PUBLICATION_AUTHOR_KINDS,
  PUBLICATION_FINDING_CODES,
  PUBLICATION_FINDING_SEVERITIES,
  PUBLICATION_KINDS,
  PUBLICATION_MEDIA_MAX,
  PUBLICATION_PREVIEWS_MAX,
  PUBLICATION_STATUSES,
  PUBLICATION_TEXT_MAX_LENGTH,
} from "@agency_hub_core/shared";

import { intId, isoDateTime, mills, platformEnum } from "./primitives.ts";
import { agentCursorString } from "./routes-agent.ts";

// Publications: wall posts Hub publishes on Fansly and OnlyFans
// (docs/plans/2026-10-23-wall-posts). Agents and people draft, a person
// approves, Hub publishes. Money is mills (1000 = $1), as everywhere in Hub.

export const publicationKindSchema = z.enum(PUBLICATION_KINDS);
export const publicationStatusSchema = z.enum(PUBLICATION_STATUSES);

/** A file of the page's vault (the platform's media id) or one uploaded to Hub. */
export const publicationMediaInputSchema = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("vault"), mediaRef: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/) }),
  z.strictObject({ source: z.literal("file"), fileId: intId }),
]);

const refList = z.array(z.string().regex(/^[0-9A-Za-z_-]{1,64}$/)).max(20);

/**
 * What a draft says. Kind decides the rest: a story is one file; previews and a
 * price are a paid post's; FYP, walls and tiers exist on Fansly only. An empty
 * `wallRefs` on Fansly means the page's default wall, resolved when the draft
 * is saved so the approval freezes it.
 */
export const publicationContentSchema = z.strictObject({
  kind: publicationKindSchema,
  text: z.string().max(PUBLICATION_TEXT_MAX_LENGTH).default(""),
  media: z.array(publicationMediaInputSchema).max(PUBLICATION_MEDIA_MAX),
  previews: z.array(publicationMediaInputSchema).max(PUBLICATION_PREVIEWS_MAX).default([]),
  publishAt: isoDateTime({ offset: true }),
  /** When the post leaves the wall; null = never. */
  expiresAt: isoDateTime({ offset: true }).nullable().default(null),
  wallRefs: refList.default([]),
  /** Fansly subscription tiers that see a subscriber post; empty = every subscriber. */
  tierRefs: refList.default([]),
  priceMills: mills.positive().nullable().default(null),
  /** "Перезалив": the person or agent says the file is posted again on purpose. */
  repost: z.boolean().default(false),
});
export type PublicationContentBody = z.infer<typeof publicationContentSchema>;

export const publicationCreateBodySchema = publicationContentSchema.extend({
  pageLabel: z.string().min(1),
});
export type PublicationCreateBody = z.infer<typeof publicationCreateBodySchema>;

export const publicationUpdateBodySchema = publicationContentSchema.extend({
  /** The version the editor saw; a newer one answers 409 publication_version_conflict. */
  version: z.number().int().positive(),
});
export type PublicationUpdateBody = z.infer<typeof publicationUpdateBodySchema>;

export const agentPublicationCreateBodySchema = publicationContentSchema.extend({
  /** The same key with the same body answers the same draft; with another body, 409. */
  idempotencyKey: z.string().min(1).max(200),
});
export type AgentPublicationCreateBody = z.infer<typeof agentPublicationCreateBodySchema>;

export const publicationFindingSchema = z.object({
  code: z.enum(PUBLICATION_FINDING_CODES),
  severity: z.enum(PUBLICATION_FINDING_SEVERITIES),
  /** Which media it is about: `vault:<ref>` or `file:<id>`. */
  mediaKey: z.string().nullable().default(null),
  /** When the file last went out, or the day in question. */
  at: z.string().nullable().default(null),
  /** The post or the publication it collides with. */
  postRef: z.string().nullable().default(null),
  publicationId: z.number().int().nullable().default(null),
  /** Numbers behind the finding: the range, the usual day, the count. */
  detail: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).default({}),
});
export type PublicationFinding = z.infer<typeof publicationFindingSchema>;

export const publicationMediaSchema = z.object({
  role: z.enum(["media", "preview"]),
  position: z.number().int().nonnegative(),
  source: z.enum(["vault", "file"]),
  mediaRef: z.string().nullable(),
  fileId: z.number().int().nullable(),
});

export const publicationSchema = z.object({
  id: intId,
  pageLabel: z.string(),
  platform: platformEnum,
  kind: publicationKindSchema,
  status: publicationStatusSchema,
  version: z.number().int().positive(),
  text: z.string(),
  publishAt: z.string(),
  expiresAt: z.string().nullable(),
  wallRefs: z.array(z.string()),
  tierRefs: z.array(z.string()),
  priceMills: mills.nullable(),
  repost: z.boolean(),
  media: z.array(publicationMediaSchema),
  findings: z.array(publicationFindingSchema),
  /** A blocking finding: the draft cannot be approved as it is. */
  blocked: z.boolean(),
  author: z.object({
    kind: z.enum(PUBLICATION_AUTHOR_KINDS),
    userId: z.number().int().nullable(),
    agentKeyId: z.number().int().nullable(),
  }),
  approvedRevisionId: z.number().int().nullable(),
  platformPostRef: z.string().nullable(),
  statusReason: z.string().nullable(),
  previousPublicationId: z.number().int().nullable(),
  /**
   * Its withdrawal from the platform's schedule, when Hub sent one (plan PR 5b):
   * the command's state — prepared (never left; may be pressed again),
   * confirmed, rejected (nothing removed), indeterminate. The outcome itself is
   * the publication's status (withdrawn / unknown).
   */
  withdrawal: z.object({ state: z.string(), errorCode: z.string().nullable(), at: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  statusChangedAt: z.string(),
});
export type PublicationWire = z.infer<typeof publicationSchema>;

export const publicationStatusEventSchema = z.object({
  fromStatus: publicationStatusSchema.nullable(),
  toStatus: publicationStatusSchema,
  actorKind: z.enum(PUBLICATION_ACTOR_KINDS),
  actorUserId: z.number().int().nullable(),
  actorAgentKeyId: z.number().int().nullable(),
  reason: z.string().nullable(),
  at: z.string(),
});

export const publicationDetailSchema = publicationSchema.extend({
  events: z.array(publicationStatusEventSchema),
  revision: z.object({
    id: intId,
    fingerprint: z.string(),
    approvedByUserId: z.number().int(),
    approvedAt: z.string(),
  }).nullable(),
});
export type PublicationDetail = z.infer<typeof publicationDetailSchema>;

export const publicationListQuerySchema = z.object({
  pageLabel: z.string().min(1).optional(),
  status: publicationStatusSchema.optional(),
  /** Publish time window, `from` inclusive, `to` exclusive. */
  from: isoDateTime({ offset: true }).optional(),
  to: isoDateTime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
export const agentPublicationListQuerySchema = publicationListQuerySchema.omit({ pageLabel: true });

export const publicationListResponseSchema = z.object({ publications: z.array(publicationSchema) });

export const publicationIdParamsSchema = z.object({ id: z.coerce.number().int().positive() });

export const publicationApproveBodySchema = z.strictObject({
  /** One or many; each with the version the person saw. Approved in this order. */
  items: z.array(z.strictObject({ id: intId, version: z.number().int().positive() })).min(1).max(200),
});
export const publicationApproveResponseSchema = z.object({
  results: z.array(z.object({
    id: intId,
    outcome: z.enum(["approved", "refused"]),
    /** Why it was refused: blocking findings, a newer version, a status that cannot be approved. */
    reason: z.string().nullable(),
    publication: publicationSchema.nullable(),
  })),
});

/** The person's answer to "unknown" (spec §8.2). */
export const publicationResolveBodySchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("went_out"),
    state: z.enum(["scheduled", "published"]),
    platformPostRef: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/),
  }),
  z.strictObject({ outcome: z.literal("did_not_go_out") }),
]);
export const publicationResolveResponseSchema = z.object({
  publication: publicationSchema,
  /** "It did not go out" drafts a new publication linked to this one; it is approved again. */
  replacement: publicationSchema.nullable(),
});

export const publicationSettingsSchema = z.object({
  pageLabel: z.string(),
  platform: platformEnum,
  enabled: z.boolean(),
  autostopReason: z.string().nullable(),
  autostoppedAt: z.string().nullable(),
  paidPriceMinMills: mills.nullable(),
  paidPriceMaxMills: mills.nullable(),
  repostThresholdDays: z.number().int(),
  dailyLimit: z.number().int().nullable(),
  updatedAt: z.string().nullable(),
});
export const publicationSettingsListResponseSchema = z.object({
  /** The global switch `publishingEnabled`: off stops every page. */
  globalEnabled: z.boolean(),
  pages: z.array(publicationSettingsSchema),
});
export const publicationSettingsUpdateBodySchema = z.strictObject({
  enabled: z.boolean(),
  paidPriceMinMills: mills.positive().nullable(),
  paidPriceMaxMills: mills.positive().nullable(),
  repostThresholdDays: z.number().int().min(1).max(365),
  dailyLimit: z.number().int().min(1).max(10000).nullable(),
}).refine((value) => (value.paidPriceMinMills === null) === (value.paidPriceMaxMills === null), {
  message: "set both ends of the price range or neither",
}).refine((value) => value.paidPriceMinMills === null || value.paidPriceMaxMills === null
  || value.paidPriceMinMills <= value.paidPriceMaxMills, { message: "the price range is upside down" });
export const publicationPageParamsSchema = z.object({ pageLabel: z.string().min(1) });

// --- The platform's schedule and withdrawal (plan PR 5b, spec §6, §8.2, §9) ---

export const publicationWithdrawResultSchema = z.object({
  id: intId,
  /**
   * withdrawn — gone from the schedule, confirmed by a fresh complete read;
   * unknown — the answer was lost, or the read after could not confirm;
   * rejected — OnlyFans said no, the post stays scheduled;
   * not_sent — the command never left (busy, transport down), press again;
   * refused — Hub did not send: too close to the time, the schedule read
   * incomplete or without the post, the page stopped for its authorization;
   * accepted — Fansly (plan PR 9): Hub queued the cancel on the page's engine;
   * it goes after a fresh read of the schedule still shows the post, and its
   * result comes as the publication's status within minutes.
   */
  outcome: z.enum(["withdrawn", "unknown", "rejected", "not_sent", "refused", "accepted"]),
  reason: z.string().nullable(),
  publication: publicationSchema.nullable(),
});
export type PublicationWithdrawResult = z.infer<typeof publicationWithdrawResultSchema>;
export const publicationWithdrawResponseSchema = z.object({ results: z.array(publicationWithdrawResultSchema) });
export const publicationWithdrawPageBodySchema = z.strictObject({ pageLabel: z.string().min(1) });

export const publicationQueueEntrySchema = z.object({
  queueId: z.string(),
  /** The post inside the schedule entry, when OnlyFans names it. */
  postRef: z.string().nullable(),
  publishAt: z.string().nullable(),
  /** The caption's head, as words. */
  text: z.string(),
  mediaCount: z.number().int().nullable(),
  /** Hub's publication this entry is; null = put in the schedule by hand. */
  publicationId: z.number().int().nullable(),
});
export const publicationQueueSnapshotSchema = z.object({
  pageLabel: z.string(),
  platform: z.enum(["fansly", "onlyfans"]),
  readAt: z.string().nullable(),
  windowFrom: z.string().nullable(),
  windowTo: z.string().nullable(),
  /** Every day read whole. An incomplete read proves nothing about a post being absent. */
  complete: z.boolean(),
  incompleteReasons: z.array(z.string()),
  /** Older than twice its cadence (OnlyFans: hourly while Hub posts are in it, otherwise daily; Fansly: hourly), or never read. */
  stale: z.boolean(),
  postsPerDay: z.record(z.string(), z.number().int()),
  refreshRequestedAt: z.string().nullable(),
  lastFailure: z.string().nullable(),
  lastFailedAt: z.string().nullable(),
  entries: z.array(publicationQueueEntrySchema),
});
export type PublicationQueueSnapshotWire = z.infer<typeof publicationQueueSnapshotSchema>;
export const publicationQueueListResponseSchema = z.object({ pages: z.array(publicationQueueSnapshotSchema) });
export const publicationQueueRefreshBodySchema = z.strictObject({ pageLabel: z.string().min(1) });
export const publicationQueueRefreshResponseSchema = z.object({ requestedAt: z.string() });

// --- The page's media, for the agents who draft (plan PR 10, spec §7) ---------

/** What a file is, as far as Hub knows. */
export const publicationMediaTypeSchema = z.enum(["image", "video", "audio"]);

export const agentPublicationMediaQuerySchema = z.object({
  /** Only images, only videos or only audio. */
  type: publicationMediaTypeSchema.optional(),
  /** The time the agent plans to post at (default now): the nearest live
   *  publication and `repostWithinThreshold` are measured from it. */
  publishAt: isoDateTime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  /** Continues a listing. It carries `type`, `publishAt` and `limit`: resending
   *  `type` or `publishAt` beside it is a 400. */
  cursor: agentCursorString.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.cursor === undefined) return;
  for (const field of ["type", "publishAt"] as const) {
    if (value[field] !== undefined) {
      ctx.addIssue({ code: "custom", path: ["cursor"], message: `cursor pins the listing; do not resend \`${field}\`` });
    }
  }
});

export const publicationPageMediaSchema = z.object({
  /** The platform's media id: what a draft names as `{source: "vault", mediaRef}`. */
  mediaRef: z.string(),
  /** null: Hub does not know (read `mimeType`). */
  type: publicationMediaTypeSchema.nullable(),
  mimeType: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  /** Bytes, when the platform says (OnlyFans and Fansly mostly do not). */
  byteSize: z.number().int().nullable(),
  filename: z.string().nullable(),
  /** When the platform made the file (Fansly); null on OnlyFans. */
  createdAt: z.string().nullable(),
  /** The newest post of the page Hub collected that carries the file. */
  lastPost: z.object({ at: z.string(), postRef: z.string() }).nullable(),
  /** The page's live publication (approved, on its way, on the platform or
   *  unknown) with the file, closest in time to `publishAt`. */
  nearestPublication: z.object({ id: intId, publishAt: z.string(), status: publicationStatusSchema }).nullable(),
  /** The last post or the nearest publication is closer to `publishAt` than
   *  the page's repeat threshold: a draft with this file at that time is
   *  blocked unless marked `repost`. */
  repostWithinThreshold: z.boolean(),
});
export type PublicationPageMediaWire = z.infer<typeof publicationPageMediaSchema>;

export const agentPublicationMediaResponseSchema = z.object({
  pageLabel: z.string(),
  platform: platformEnum,
  /** The time the distances were measured from. */
  publishAt: z.string(),
  /** The page's repeat threshold (spec §8.1 "Повтор"). */
  repostThresholdDays: z.number().int(),
  /** Newest first (by the platform's media id, which grows with each upload). */
  media: z.array(publicationPageMediaSchema),
  /** null: the listing is complete. */
  nextCursor: z.string().nullable(),
});
export type AgentPublicationMediaResponse = z.infer<typeof agentPublicationMediaResponseSchema>;
