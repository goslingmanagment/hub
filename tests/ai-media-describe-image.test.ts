import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MEDIA_DESCRIBE_MAX_EDGE_PX,
  prepareMediaImage,
  sniffImageFormat,
} from "../apps/runtime/src/services/ai-media-describe/image.ts";

// sharp is a runtime-package dependency; resolve it the way the runtime does.
interface SharpChain {
  jpeg(): SharpChain;
  png(): SharpChain;
  gif(): SharpChain;
  webp(): SharpChain;
  withExifMerge(exif: Record<string, Record<string, string>>): SharpChain;
  toBuffer(): Promise<Buffer>;
  metadata(): Promise<{ format?: string; exif?: Buffer }>;
}
type SharpFactory = (input?: Buffer | { create: Record<string, unknown> }) => SharpChain;
const sharp = createRequire(path.resolve("apps/runtime/package.json"))("sharp") as SharpFactory;

async function solidImage(width: number, height: number, format: "jpeg" | "png" | "gif" | "webp") {
  const base = sharp({ create: { width, height, channels: 3, background: "#cc3322" } });
  switch (format) {
    case "jpeg":
      return base.jpeg().withExifMerge({ IFD0: { Copyright: "gps-and-camera-secret" } }).toBuffer();
    case "png":
      return base.png().toBuffer();
    case "gif":
      return base.gif().toBuffer();
    case "webp":
      return base.webp().toBuffer();
  }
}

describe("AI media describer image preparation", () => {
  it("downscales to the 1024 px long edge and strips metadata", async () => {
    const input = await solidImage(3000, 2000, "jpeg");
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const prepared = await prepareMediaImage(input);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(Math.max(prepared.width, prepared.height)).toBe(MEDIA_DESCRIBE_MAX_EDGE_PX);
    expect(prepared.height).toBe(683);
    const output = await sharp(prepared.jpeg).metadata();
    expect(output.format).toBe("jpeg");
    expect(output.exif).toBeUndefined();
    expect(prepared.jpeg.includes(Buffer.from("gps-and-camera-secret"))).toBe(false);
  });

  it("never enlarges a small-but-usable image", async () => {
    const prepared = await prepareMediaImage(await solidImage(480, 854, "png"));
    expect(prepared).toMatchObject({ ok: true, width: 480, height: 854, sourceFormat: "png" });
  });

  it("takes the first frame of a GIF and accepts WebP", async () => {
    await expect(prepareMediaImage(await solidImage(400, 300, "gif"))).resolves.toMatchObject({ ok: true, width: 400 });
    await expect(prepareMediaImage(await solidImage(640, 640, "webp"))).resolves.toMatchObject({ ok: true, width: 640 });
  });

  it("reports images under 200 px as too small", async () => {
    await expect(prepareMediaImage(await solidImage(150, 120, "png"))).resolves.toEqual({ ok: false, reason: "too_small" });
  });

  it("rejects non-images before decoding", async () => {
    expect(sniffImageFormat(Buffer.from("<html>not an image</html>"))).toBeNull();
    await expect(prepareMediaImage(Buffer.from("<html>not an image</html>"))).resolves.toEqual({
      ok: false,
      reason: "unsupported_format",
    });
  });

  it("reports a truncated image as a decode failure", async () => {
    const input = await solidImage(800, 600, "jpeg");
    await expect(prepareMediaImage(input.subarray(0, 200))).resolves.toEqual({ ok: false, reason: "decode_failed" });
  });
});
