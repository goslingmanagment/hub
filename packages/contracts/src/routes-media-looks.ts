import { errorResponseSchema } from "./primitives.ts";
import {
  agentMediaLookCreateBodySchema,
  agentMediaLookGetQuerySchema,
  mediaLookPageParamsSchema,
  mediaLookParamsSchema,
  mediaLookSchema,
} from "./media-looks.ts";

// Media looks (owner 2026-11-11): an agent key with look:media asks for the
// frames of a file of a post in its page's schedule, and reads a look again by
// its id. The page's engine makes one image request at its pace; Hub cuts the
// frames. A page outside the grant, and a look or publication of another
// page, is the plane's one static 404.

const agentErrors = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  // media_look_in_flight | media_look_fansly_only | media_look_not_scheduled | media_look_not_in_schedule | …
  409: errorResponseSchema,
  // media_look_daily_limit
  429: errorResponseSchema,
  // media_look_off
  503: errorResponseSchema,
} as const;

export const mediaLookRouteSchemas = {
  agentMediaLookCreate: {
    auth: { kind: "agentKey", scope: "page" }, tags: ["agent"],
    summary: "Look at a file of a post in the page's Fansly schedule (needs look:media): frames of a video (the"
      + " platform's thumbnail sheet, a sample — per second or evenly spaced) or its cover, a photo downscaled; each"
      + " frame ≤ 512 px, a JPEG without metadata. One image request through the page's engine at its pace, a daily"
      + " limit per page; a fresh look of the same file answers cached and costs nothing. Answers queued when the"
      + " engine takes longer: read it again by its id",
    params: mediaLookPageParamsSchema,
    body: agentMediaLookCreateBodySchema,
    response: { 200: mediaLookSchema, ...agentErrors },
  },
  agentMediaLookGet: {
    auth: { kind: "agentKey", scope: "page" }, tags: ["agent"],
    summary: "A media look of the page by its id (needs look:media): its status and frames, finished now when the"
      + " engine has answered since",
    params: mediaLookParamsSchema,
    querystring: agentMediaLookGetQuerySchema,
    response: { 200: mediaLookSchema, ...agentErrors },
  },
} as const;
