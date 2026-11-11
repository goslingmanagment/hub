import { z } from "zod";

import { intId } from "./primitives.ts";

// Media looks (owner 2026-11-11): an agent key with look:media sees FRAMES
// (≤ 512 px each) of a file of its page's posts, pulled through the page's own
// session at its pace — never the file, never a link. A look of a video is the
// platform's own thumbnail sheet cut into frames (a sample of the video, one
// per second or evenly spaced), or its cover; a look of a photo is the photo
// downscaled. Nothing here carries a URL, a location or a variant list.
//
// What can be looked at (Fansly only): a post in the platform's schedule
// (placed by Hub or by hand) and a Hub publication in status `scheduled` — the
// schedule's own read names the image, one request; a published post of the
// page (one Hub has among its posts) and a Hub publication in status
// `published`, and a file of the page's own vault — the page's engine reads the
// post or the vault page first, two requests, still one look.

/** The longest edge of a frame, in pixels: a frame is never larger. */
export const MEDIA_LOOK_FRAME_MAX_EDGE_PX = 512;
/** At most this many frames in one look (an 11×11 sheet holds 121). */
export const MEDIA_LOOK_FRAMES_MAX = 256;
/** The highest attachment index a look names (0-based, a post's files in order). */
export const MEDIA_LOOK_INDEX_MAX = 99;

/**
 * How much of the media the frames show — a sample, never the whole of a video:
 * - `per_second`: a video, one frame for each second (the platform's own sheet);
 * - `sampled`: a video, frames evenly spaced `frameIntervalMs` apart — what is
 *   between them is not seen;
 * - `cover_only`: a video, its cover alone (one picture of the platform's
 *   choosing) — the video itself is not seen;
 * - `whole_image`: a photo, all of it, downscaled;
 * - `first_frame`: an animated image (GIF), its first frame only.
 */
export const mediaLookCoverageSchema = z.enum(["per_second", "sampled", "cover_only", "whole_image", "first_frame"]);

/** `ready`: the frames are here; `queued`: the page's engine has not answered yet (its read of the post or
 *  the vault page, or the image) — read it again by its id;
 *  `failed`: no frames (`failure` says why). */
export const mediaLookStatusSchema = z.enum(["ready", "queued", "failed"]);

export const mediaLookFramesModeSchema = z.enum(["inline", "none"]);

export const mediaLookPageParamsSchema = z.object({ pageLabel: z.string().min(1) });
export const mediaLookParamsSchema = z.object({ pageLabel: z.string().min(1), lookId: z.coerce.number().int().positive() });

export const agentMediaLookCreateBodySchema = z.strictObject({
  /** A Hub publication of the page in status `scheduled` or `published`. */
  publicationId: intId.optional(),
  /** A post of the page (Fansly's post id): in the platform's schedule, by Hub or by hand, or published. */
  postRef: z.string().regex(/^[0-9]{1,24}$/).optional(),
  /** A file of the page's own vault (Fansly's media id, `mediaRef` of the `raw_media` / `vault_media` datasets). */
  mediaRef: z.string().regex(/^[0-9]{1,24}$/).optional(),
  /** Which of the post's files (0-based, in the post's order, an album's files in its order); not for `mediaRef`. */
  index: z.number().int().min(0).max(MEDIA_LOOK_INDEX_MAX).default(0),
  /** A video's cover instead of its frames. */
  cover: z.boolean().default(false),
  /** Look again even when a look of the same file is still fresh (it costs one of the page's looks). */
  fresh: z.boolean().default(false),
  /** `inline`: each frame's JPEG in base64; `none`: the frames' facts only. */
  frames: mediaLookFramesModeSchema.default("inline"),
}).superRefine((value, ctx) => {
  const named = [value.publicationId, value.postRef, value.mediaRef].filter((target) => target !== undefined).length;
  if (named !== 1) {
    ctx.addIssue({ code: "custom", path: ["publicationId"], message: "name exactly one of publicationId, postRef, mediaRef" });
  }
  if (value.mediaRef !== undefined && value.index !== 0) {
    ctx.addIssue({ code: "custom", path: ["index"], message: "a vault file has no index: name it by its mediaRef alone" });
  }
});

export const agentMediaLookGetQuerySchema = z.strictObject({
  frames: mediaLookFramesModeSchema.default("inline"),
});

export const mediaLookFrameSchema = z.object({
  /** 0-based, in the order of the media's time. */
  index: z.number().int().nonnegative(),
  /** Where in the video the frame is; null for a cover (its place is the platform's) and for a photo. */
  atMs: z.number().int().nonnegative().nullable(),
  width: z.number().int().positive().max(MEDIA_LOOK_FRAME_MAX_EDGE_PX),
  height: z.number().int().positive().max(MEDIA_LOOK_FRAME_MAX_EDGE_PX),
  /** The frame as a JPEG without metadata, base64 — only with `frames: inline`. */
  jpegBase64: z.string().max(1_000_000).optional(),
});

export const mediaLookSchema = z.object({
  lookId: z.number().int().positive(),
  status: mediaLookStatusSchema,
  /** Why there are no frames (a closed code), or null. */
  failure: z.string().nullable(),
  /** What was asked: the post and which of its files, or the vault file. */
  target: z.object({
    publicationId: z.number().int().positive().nullable(),
    postRef: z.string().nullable(),
    index: z.number().int().nonnegative().nullable(),
    /** The file (Fansly's media id): asked for, or named by the read; null until then. */
    mediaRef: z.string().nullable(),
  }),
  /** Where the image came from: the schedule's own read (one request), or the engine's read of the
   *  post or the vault page first (two requests, still one look). */
  source: z.enum(["schedule_read", "post_read", "vault_read"]),
  /** The requests this look sent to the platform so far (a read and an image at most); a `cached` answer cost
   *  nothing now. */
  requestsSent: z.number().int().nonnegative(),
  media: z.object({
    /** Null until the engine's read named the file. */
    type: z.enum(["video", "image"]).nullable(),
    /** A video's length; null for a photo. */
    durationMs: z.number().int().nonnegative().nullable(),
  }),
  /** How much of the media the frames show; null while queued or failed before a choice. */
  coverage: mediaLookCoverageSchema.nullable(),
  /** The time between two frames of a `per_second` or `sampled` look; null otherwise. */
  frameIntervalMs: z.number().int().positive().nullable(),
  /** One sentence on what the frames do and do not show. */
  coverageNote: z.string().nullable(),
  frames: z.array(mediaLookFrameSchema).max(MEDIA_LOOK_FRAMES_MAX),
  /** A look of the same file taken earlier and still fresh: it cost nothing. */
  cached: z.boolean(),
  /** The page's looks that sent a request today (UTC) against its daily limit. */
  budget: z.object({
    usedToday: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
  }),
});

export type MediaLookCoverage = z.infer<typeof mediaLookCoverageSchema>;
export type MediaLookStatus = z.infer<typeof mediaLookStatusSchema>;
export type MediaLookFramesMode = z.infer<typeof mediaLookFramesModeSchema>;
export type AgentMediaLookCreateBody = z.infer<typeof agentMediaLookCreateBodySchema>;
export type MediaLookFrame = z.infer<typeof mediaLookFrameSchema>;
export type MediaLook = z.infer<typeof mediaLookSchema>;
