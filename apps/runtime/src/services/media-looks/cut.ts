import type SharpFactory from "sharp";

import { MEDIA_LOOK_FRAME_MAX_EDGE_PX } from "@agency_hub_core/contracts";

import { sniffImageFormat } from "../ai-media-describe/image.ts";

// A media look's frames, cut from the one image the page's engine fetched (in
// the API process, never in the page's actor): in memory, no temp file, no
// cache, bounded input pixels. Every frame is re-encoded as a JPEG without
// metadata (sharp keeps none unless asked), never enlarged, at most 512 px on
// either side.
//
// A thumbnail sheet is cut only when its decoded size is exactly its grid of
// cells (`thumbnailGrid` × the variant's width and height); which side of the
// grid is the columns is the size's to say (production lists [3, 2] and [4, 3]
// grids). Anything else is `sprite_geometry_mismatch`: no frame is guessed,
// and the next look of the file takes the cover. Perceptual hashes are
// deliberately not computed.

/** ~40 MP: far above an 11×11 sheet of 256 px cells, far below a decompression bomb. */
const MAX_INPUT_PIXELS = 40_000_000;
const JPEG_QUALITY = 80;
const RESIZE = {
  width: MEDIA_LOOK_FRAME_MAX_EDGE_PX,
  height: MEDIA_LOOK_FRAME_MAX_EDGE_PX,
  fit: "inside",
  withoutEnlargement: true,
} as const;

let sharpModule: Promise<typeof SharpFactory> | null = null;
function loadSharp(): Promise<typeof SharpFactory> {
  sharpModule ??= import("sharp").then((module) => {
    const sharp = module.default;
    sharp.cache(false);
    sharp.concurrency(1);
    return sharp;
  });
  return sharpModule;
}

export type MediaLookCutPlan =
  | {
    kind: "sprite";
    /** `thumbnailGrid` as listed. */
    gridA: number;
    gridB: number;
    cellWidth: number;
    cellHeight: number;
    /** Cells holding a frame, row by row. */
    count: number;
    /** Cell i is at i × this (ms). */
    intervalMs: number;
  }
  /** A cover or a photo: one frame, its first for an animated image. */
  | { kind: "still" };

export interface MediaLookCutFrame {
  index: number;
  atMs: number | null;
  width: number;
  height: number;
  jpeg: Buffer;
}

export type MediaLookCutResult =
  | { ok: true; gridCols: number | null; gridRows: number | null; frames: MediaLookCutFrame[] }
  | { ok: false; reason: "sprite_geometry_mismatch" | "unsupported_format" | "decode_failed" };

/** The sheet's columns and rows, when its decoded size is exactly its grid of cells. */
export function spriteLayout(
  decoded: { width: number; height: number },
  plan: Extract<MediaLookCutPlan, { kind: "sprite" }>,
): { cols: number; rows: number } | null {
  const fits = (cols: number, rows: number) => decoded.width === cols * plan.cellWidth
    && decoded.height === rows * plan.cellHeight
    && plan.count <= cols * rows;
  if (fits(plan.gridA, plan.gridB)) return { cols: plan.gridA, rows: plan.gridB };
  if (fits(plan.gridB, plan.gridA)) return { cols: plan.gridB, rows: plan.gridA };
  return null;
}

/** Cut the fetched image into a look's frames. */
export async function cutMediaLookFrames(bytes: Uint8Array, plan: MediaLookCutPlan): Promise<MediaLookCutResult> {
  if (sniffImageFormat(bytes) === null) return { ok: false, reason: "unsupported_format" };
  const sharp = await loadSharp();
  try {
    if (plan.kind === "still") {
      const { data, info } = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", pages: 1 })
        .autoOrient()
        .resize(RESIZE)
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer({ resolveWithObject: true });
      return { ok: true, gridCols: null, gridRows: null, frames: [{ index: 0, atMs: null, width: info.width, height: info.height, jpeg: data }] };
    }
    const metadata = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).metadata();
    const layout = spriteLayout({ width: metadata.width ?? 0, height: metadata.height ?? 0 }, plan);
    if (layout === null) return { ok: false, reason: "sprite_geometry_mismatch" };
    // Decoded once; each cell is cut from the raw pixels.
    const raw = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .flatten({ background: "#ffffff" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const frames: MediaLookCutFrame[] = [];
    for (let index = 0; index < plan.count; index += 1) {
      const col = index % layout.cols;
      const row = Math.floor(index / layout.cols);
      const { data, info } = await sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: raw.info.channels } })
        .extract({ left: col * plan.cellWidth, top: row * plan.cellHeight, width: plan.cellWidth, height: plan.cellHeight })
        .resize(RESIZE)
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer({ resolveWithObject: true });
      frames.push({ index, atMs: Math.round(index * plan.intervalMs), width: info.width, height: info.height, jpeg: data });
    }
    return { ok: true, gridCols: layout.cols, gridRows: layout.rows, frames };
  } catch {
    return { ok: false, reason: "decode_failed" };
  }
}
