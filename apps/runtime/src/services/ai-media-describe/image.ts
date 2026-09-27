import type SharpFactory from "sharp";

// In-memory image preparation for the AI media describer. No temp files, no
// cache, bounded input pixels and libvips threads; metadata (EXIF/GPS/ICC
// comments) never survives — sharp drops it unless explicitly kept.

export const MEDIA_DESCRIBE_MAX_EDGE_PX = 1024;
export const MEDIA_DESCRIBE_MIN_EDGE_PX = 200;
/** ~40 MP: far above any chat photo, far below a decompression bomb. */
export const MEDIA_DESCRIBE_MAX_INPUT_PIXELS = 40_000_000;

const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp", "gif", "avif", "heif"]);

// Loaded lazily: a native-binding problem must fail one describe attempt,
// never the worker's startup (every role imports the sweep module).
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

export type PreparedMediaImage =
  | { ok: true; jpeg: Buffer; width: number; height: number; sourceFormat: string }
  | { ok: false; reason: "unsupported_format" | "too_small" | "decode_failed" };

/** Sniff the container before handing bytes to libvips. */
export function sniffImageFormat(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "gif";
  }
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "webp";
  }
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return "heif";
  }
  return null;
}

/** Downscale to ≤1024 px on the long edge (never enlarge), auto-orient, strip
 * metadata, re-encode as JPEG. Images under 200 px on the long edge are too
 * small to describe reliably and are reported unavailable. */
export async function prepareMediaImage(bytes: Uint8Array): Promise<PreparedMediaImage> {
  if (sniffImageFormat(bytes) === null) {
    return { ok: false, reason: "unsupported_format" };
  }
  const sharp = await loadSharp();
  try {
    const source = sharp(bytes, {
      limitInputPixels: MEDIA_DESCRIBE_MAX_INPUT_PIXELS,
      failOn: "error",
      // First frame only for GIF/animated WebP.
      pages: 1,
    });
    const metadata = await source.metadata();
    if (!metadata.format || !ACCEPTED_FORMATS.has(metadata.format)) {
      return { ok: false, reason: "unsupported_format" };
    }
    const width = metadata.autoOrient?.width ?? metadata.width ?? 0;
    const height = metadata.autoOrient?.height ?? metadata.height ?? 0;
    if (Math.max(width, height) < MEDIA_DESCRIBE_MIN_EDGE_PX) {
      return { ok: false, reason: "too_small" };
    }
    const { data, info } = await source
      .autoOrient()
      .resize({
        width: MEDIA_DESCRIBE_MAX_EDGE_PX,
        height: MEDIA_DESCRIBE_MAX_EDGE_PX,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return { ok: true, jpeg: data, width: info.width, height: info.height, sourceFormat: metadata.format };
  } catch {
    return { ok: false, reason: "decode_failed" };
  }
}
