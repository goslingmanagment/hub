import { isMediaLookImageUrl } from "../../sync/fansly/resources/media-look.ts";

// What a media look fetches of one Fansly media object (owner 2026-11-11) —
// its own selector, not the describer's (ai-media-describe/fansly-source.ts):
//
// - a video: the platform's thumbnail sheet (variant type 4, a JPEG grid of
//   small frames, one per `thumbnailDistance` seconds), cut into frames by
//   Hub; coverage `per_second` when the distance is one second, `sampled`
//   otherwise. Asked for its cover, or with no usable sheet: the largest
//   poster (type 1), `cover_only`;
// - a photo: the smallest resize (type 1) whose long edge is 512 px or more,
//   else the largest resize, downscaled to ≤ 512 px — `whole_image`, or
//   `first_frame` for an animated image (GIF); the original only when it has
//   no resize at all.
//
// Never: a blurred copy (type 3), a stream (302 HLS, 303 DASH), the top-level
// location of a video (the video file itself), a URL whose path is not an
// image's, or a location not signed in its own query — one signed beside its
// URL (the streams' form: Hub never assembles a URL), or one the journal
// stripped (sync/fansly/lib/cdn-tokens.ts: a request to it would only be
// refused). One selector for every source of a look: the schedule's verbatim
// read and the engine's fresh read of a post or a vault page. Pure: no I/O.

/** The long edge a look's photo aims for: the smallest resize that covers it. */
export const MEDIA_LOOK_TARGET_EDGE_PX = 512;

/** Fansly's variant types (the describer's and the stand's reads). */
const VARIANT_POSTER = 1;
const VARIANT_BLURRED = 3;
const VARIANT_SPRITE = 4;
const VARIANT_HLS = 302;
const VARIANT_DASH = 303;
const NEVER_FETCHED: ReadonlySet<number> = new Set([VARIANT_BLURRED, VARIANT_HLS, VARIANT_DASH]);
/** A sheet's grid at most this many cells a side (11×11 on production). */
const SPRITE_GRID_MAX = 64;
/** At most this many frames in a look (the contract's own ceiling). */
const SPRITE_FRAMES_MAX = 256;
/** A cell at most this many pixels a side (144×256 on production). */
const SPRITE_CELL_MAX_PX = 4096;
const MS_PER_SECOND = 1000;
/** CloudFront's signing names: a location carrying them beside its URL is never assembled. */
const SIGNING_NAMES = ["Policy", "Signature", "Key-Pair-Id"];

/** The geometry a sheet's metadata states; which side of the grid is the
 *  columns is decided by the decoded size (cut.ts). */
export interface MediaLookSpriteGeometry {
  /** `thumbnailGrid` as listed: [a, b]. */
  gridA: number;
  gridB: number;
  /** The variant's width and height: one cell. */
  cellWidth: number;
  cellHeight: number;
  /** `thumbnailCount`: the cells that hold a frame, row by row. */
  count: number;
  /** `thumbnailDistance`, in milliseconds: cell i is at i × this. */
  intervalMs: number;
}

export type MediaLookSelection =
  | {
    ok: true; variant: "sprite"; mediaType: "video"; url: string; durationMs: number | null;
    geometry: MediaLookSpriteGeometry; coverage: "per_second" | "sampled";
  }
  | { ok: true; variant: "cover"; mediaType: "video"; url: string; durationMs: number | null; coverage: "cover_only" }
  | { ok: true; variant: "image"; mediaType: "image"; url: string; durationMs: null; coverage: "whole_image" | "first_frame" }
  | { ok: false; reason: "unsupported_media" | "no_image_variant" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((row): row is Record<string, unknown> => row !== null) : [];
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?[0-9]+(?:\.[0-9]+)?$/.test(value)) return Number(value);
  return null;
}

function positiveInt(value: unknown, max: number): number | null {
  const n = num(value);
  return n !== null && Number.isInteger(n) && n > 0 && n <= max ? n : null;
}

/** A metadata field: an object, or the JSON string Fansly serves. */
function metadataOf(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value)) ?? {};
    } catch {
      return {};
    }
  }
  return asRecord(value) ?? {};
}

/** How a look picks: `allowUnsigned` only tells a stripped answer (the
 *  journal's copy) from one without a still image — never what is fetched. */
export interface MediaLookSelectOptions {
  cover: boolean;
  spriteUnusable?: boolean;
  allowUnsigned?: boolean;
}

/** The first location of a node that a look may fetch: a Fansly media CDN URL
 *  of an image, signed in its own query — never one whose signature rides
 *  beside it, never an unsigned one (`allowUnsigned`: diagnosis only). */
export function mediaLookLocation(node: Record<string, unknown>, allowUnsigned = false): string | null {
  for (const location of records(node.locations)) {
    const url = text(location.location);
    if (url === null) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (!isMediaLookImageUrl(parsed)) continue;
    const metadata = asRecord(location.metadata) ?? {};
    const signedInQuery = parsed.searchParams.has("Signature") && parsed.searchParams.has("Key-Pair-Id");
    const signedBeside = SIGNING_NAMES.some((name) => typeof metadata[name] === "string");
    if (!signedInQuery && (signedBeside || !allowUnsigned)) continue;
    return url;
  }
  return null;
}

interface StillCandidate {
  edge: number;
  url: string;
  order: number;
}

/** The node's image variants of one type that a look may fetch, never a blurred copy or a stream. */
function imageVariants(media: Record<string, unknown>, type: number, allowUnsigned: boolean): StillCandidate[] {
  const out: StillCandidate[] = [];
  records(media.variants).forEach((variant, order) => {
    const variantType = num(variant.type);
    if (variantType === null || variantType !== type || NEVER_FETCHED.has(variantType)) return;
    if (!(text(variant.mimetype) ?? "").toLowerCase().startsWith("image/")) return;
    const url = mediaLookLocation(variant, allowUnsigned);
    if (url === null) return;
    out.push({ edge: Math.max(num(variant.width) ?? 0, num(variant.height) ?? 0), url, order });
  });
  return out;
}

/** A video's length from its metadata (seconds), in milliseconds. */
function durationMsOf(...metadata: Array<Record<string, unknown>>): number | null {
  for (const entry of metadata) {
    const seconds = num(entry.duration);
    if (seconds !== null && seconds >= 0) return Math.round(seconds * MS_PER_SECOND);
  }
  return null;
}

/** The video's thumbnail sheet and its geometry, when its metadata states a usable one. */
function spriteOf(
  media: Record<string, unknown>,
  allowUnsigned: boolean,
): { url: string; geometry: MediaLookSpriteGeometry; metadata: Record<string, unknown> } | null {
  for (const variant of records(media.variants)) {
    if (num(variant.type) !== VARIANT_SPRITE) continue;
    if (!(text(variant.mimetype) ?? "").toLowerCase().startsWith("image/")) continue;
    const url = mediaLookLocation(variant, allowUnsigned);
    if (url === null) continue;
    const metadata = metadataOf(variant.metadata);
    const grid = Array.isArray(metadata.thumbnailGrid) ? metadata.thumbnailGrid : [];
    const gridA = positiveInt(grid[0], SPRITE_GRID_MAX);
    const gridB = positiveInt(grid[1], SPRITE_GRID_MAX);
    const count = positiveInt(metadata.thumbnailCount, SPRITE_FRAMES_MAX);
    const distance = num(metadata.thumbnailDistance);
    const cellWidth = positiveInt(variant.width, SPRITE_CELL_MAX_PX);
    const cellHeight = positiveInt(variant.height, SPRITE_CELL_MAX_PX);
    if (grid.length !== 2 || gridA === null || gridB === null || count === null || cellWidth === null || cellHeight === null) continue;
    if (distance === null || !(distance > 0) || count > gridA * gridB) continue;
    return { url, metadata, geometry: { gridA, gridB, cellWidth, cellHeight, count, intervalMs: distance * MS_PER_SECOND } };
  }
  return null;
}

/**
 * What a look of `media` (a Fansly media object: `{mimetype, variants, …}`)
 * fetches, or why nothing can be. `cover`: a video's cover instead of its
 * frames; `spriteUnusable`: an earlier look found this video's sheet
 * uncuttable — take the cover.
 */
export function selectMediaLookSource(media: Record<string, unknown>, options: MediaLookSelectOptions): MediaLookSelection {
  const unsigned = options.allowUnsigned === true;
  const mime = (text(media.mimetype) ?? "").toLowerCase();
  if (mime.startsWith("video/")) {
    const mediaMetadata = metadataOf(media.metadata);
    if (!options.cover && options.spriteUnusable !== true) {
      const sprite = spriteOf(media, unsigned);
      if (sprite !== null) {
        return {
          ok: true,
          variant: "sprite",
          mediaType: "video",
          url: sprite.url,
          durationMs: durationMsOf(mediaMetadata, sprite.metadata),
          geometry: sprite.geometry,
          coverage: Math.abs(sprite.geometry.intervalMs - MS_PER_SECOND) < 0.5 ? "per_second" : "sampled",
        };
      }
    }
    // The largest poster; never the video's own location.
    const poster = imageVariants(media, VARIANT_POSTER, unsigned).sort((left, right) => right.edge - left.edge || left.order - right.order)[0];
    if (poster === undefined) return { ok: false, reason: "no_image_variant" };
    return { ok: true, variant: "cover", mediaType: "video", url: poster.url, durationMs: durationMsOf(mediaMetadata), coverage: "cover_only" };
  }
  if (mime.startsWith("image/")) {
    const coverage = mime === "image/gif" ? "first_frame" as const : "whole_image" as const;
    const resizes = imageVariants(media, VARIANT_POSTER, unsigned).sort((left, right) => left.edge - right.edge || left.order - right.order);
    const pick = resizes.find((candidate) => candidate.edge >= MEDIA_LOOK_TARGET_EDGE_PX) ?? resizes.at(-1);
    const url = pick?.url ?? mediaLookLocation(media, unsigned);
    if (url === null || url === undefined) return { ok: false, reason: "no_image_variant" };
    return { ok: true, variant: "image", mediaType: "image", url, durationMs: null, coverage };
  }
  return { ok: false, reason: "unsupported_media" };
}
