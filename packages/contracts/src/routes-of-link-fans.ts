import { z } from "zod";

import {
  ofLinkFansResponseSchema,
  ofLinkSourcePutBodySchema,
  ofLinkSourcePutResponseSchema,
  ofLinkSourceResponseSchema,
} from "./of-link-fans.ts";
import { ofLinkKindSchema } from "./of-links.ts";
import { errorResponseSchema } from "./primitives.ts";

const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema };
const pageId = z.coerce.number().int().positive();
const linkRef = z.string().regex(/^[0-9]{1,20}$/);

// The page of one OnlyFans link (./of-link-fans.ts): its fans from the local
// walks of its lists, and its source when it has none. Owner only; no vendor
// egress. The one write binds a link that never had a source, through the
// owner CLI's own writer (repositories/traffic-bindings.ts).
export const ofLinkFansRouteSchemas = {
  ofLinkFansGet: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Read the fans one OnlyFans link brought, from the last walks of its fan lists, by money then newest",
    querystring: z.object({
      pageId,
      linkKind: ofLinkKindSchema,
      linkRef,
      /** Default 20. */
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
    response: { 200: ofLinkFansResponseSchema, ...errors },
  },
  ofLinkSourceGet: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Read whether one OnlyFans link ever had a source, which source it probably is, and every source to choose from",
    querystring: z.object({ pageId, linkKind: ofLinkKindSchema, linkRef }),
    response: { 200: ofLinkSourceResponseSchema, ...errors },
  },
  ofLinkSourcePut: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Give an OnlyFans link that never had a source its first one, from the link's creation (basis confirmed)",
    description: "The owner CLI's writer (traffic:bindings:set): the link's lock, the overlap check and an audit row "
      + "with the owner as the actor. 409 when the link has a binding at any time: changing a source stays with the CLI.",
    body: ofLinkSourcePutBodySchema,
    response: { 200: ofLinkSourcePutResponseSchema, ...errors, 409: errorResponseSchema },
  },
} as const;
