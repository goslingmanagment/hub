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
