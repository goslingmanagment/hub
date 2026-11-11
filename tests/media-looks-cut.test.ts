import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { cutMediaLookFrames, spriteLayout, type MediaLookCutPlan } from "../apps/runtime/src/services/media-looks/cut.ts";

// A media look's frames, cut from one fetched image (owner 2026-11-11): a
// thumbnail sheet cut only when its decoded size is exactly its grid of cells
// (either side of the grid may be the columns: the size says which), cell i
// at i × the interval, row by row; every frame a JPEG ≤ 512 px, never
// enlarged; a cover or a photo one frame.

interface SharpChain {
  composite(items: Array<{ input: Buffer; left: number; top: number }>): SharpChain;
  jpeg(options?: { quality?: number }): SharpChain;
  png(): SharpChain;
  toBuffer(): Promise<Buffer>;
  stats(): Promise<{ channels: Array<{ mean: number }> }>;
  metadata(): Promise<{ width?: number; height?: number; format?: string; exif?: Buffer }>;
}
type SharpFactory = (input?: Buffer | { create: { width: number; height: number; channels: 3; background: string } }) => SharpChain;
const sharp = createRequire(path.resolve("apps/runtime/package.json"))("sharp") as SharpFactory;

/** Distinct colors, one per cell, far enough apart to survive JPEG. */
const COLORS: Array<[number, number, number]> = [
  [220, 30, 30], [30, 200, 30], [30, 30, 220], [230, 230, 30], [30, 220, 220], [220, 30, 220], [250, 250, 250], [20, 20, 20], [240, 140, 20],
];
const hex = ([r, g, b]: [number, number, number]) => `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;

/** A sheet of `cols` × `rows` cells, cell i (row by row) in COLORS[i]. */
async function sheet(cols: number, rows: number, cell: { width: number; height: number }): Promise<Buffer> {
  const cells = await Promise.all(Array.from({ length: cols * rows }, (_, index) =>
    sharp({ create: { width: cell.width, height: cell.height, channels: 3, background: hex(COLORS[index % COLORS.length]!) } }).png().toBuffer()));
  return sharp({ create: { width: cols * cell.width, height: rows * cell.height, channels: 3, background: "#808080" } })
    .composite(cells.map((input, index) => ({ input, left: (index % cols) * cell.width, top: Math.floor(index / cols) * cell.height })))
    .jpeg({ quality: 95 })
    .toBuffer();
}

async function meanColor(jpeg: Buffer): Promise<number[]> {
  return (await sharp(jpeg).stats()).channels.slice(0, 3).map((channel) => Math.round(channel.mean));
}

const close = (actual: number[], expected: number[]) => actual.every((value, index) => Math.abs(value - expected[index]!) <= 25);

const plan = (gridA: number, gridB: number, count: number, intervalMs = 1000): Extract<MediaLookCutPlan, { kind: "sprite" }> => ({
  kind: "sprite", gridA, gridB, cellWidth: 144, cellHeight: 256, count, intervalMs,
});

describe("cutting a thumbnail sheet", () => {
  it("cuts `count` cells row by row, each at i × the interval, never enlarged", async () => {
    const bytes = await sheet(3, 3, { width: 144, height: 256 });
    const cut = await cutMediaLookFrames(bytes, plan(3, 3, 7));
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.frames).toHaveLength(7);
    expect([cut.gridCols, cut.gridRows]).toEqual([3, 3]);
    expect(cut.frames.map((frame) => frame.atMs)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000]);
    for (const frame of cut.frames) {
      expect([frame.width, frame.height]).toEqual([144, 256]);
      const meta = await sharp(frame.jpeg).metadata();
      expect(meta).toMatchObject({ format: "jpeg", width: 144, height: 256 });
      expect(meta.exif).toBeUndefined();
      expect(close(await meanColor(frame.jpeg), COLORS[frame.index]!), `frame ${frame.index}`).toBe(true);
    }
  });

  it("which side of the grid is the columns is the decoded size's to say ([3, 2] served for a 2 × 3 sheet)", async () => {
    const tall = await sheet(2, 3, { width: 144, height: 256 });
    const cut = await cutMediaLookFrames(tall, plan(3, 2, 6, 3200));
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect([cut.gridCols, cut.gridRows]).toEqual([2, 3]);
    expect(cut.frames.map((frame) => frame.atMs)).toEqual([0, 3200, 6400, 9600, 12800, 16000]);
    for (const frame of cut.frames) expect(close(await meanColor(frame.jpeg), COLORS[frame.index]!), `frame ${frame.index}`).toBe(true);
    expect(spriteLayout({ width: 432, height: 512 }, plan(3, 2, 6))).toEqual({ cols: 3, rows: 2 });
    expect(spriteLayout({ width: 288, height: 768 }, plan(3, 2, 6))).toEqual({ cols: 2, rows: 3 });
  });

  it("a sheet whose size is not its grid of cells is not cut: no frame is guessed", async () => {
    const bytes = await sheet(3, 3, { width: 144, height: 256 });
    expect(await cutMediaLookFrames(bytes, { ...plan(3, 3, 7), cellHeight: 244 })).toEqual({ ok: false, reason: "sprite_geometry_mismatch" });
    expect(await cutMediaLookFrames(bytes, plan(4, 3, 10))).toEqual({ ok: false, reason: "sprite_geometry_mismatch" });
    expect(await cutMediaLookFrames(Buffer.from("not an image"), plan(3, 3, 7))).toEqual({ ok: false, reason: "unsupported_format" });
  });

  it("a large sheet's cells are downscaled to 512 px at most", async () => {
    const big = await sheet(2, 1, { width: 600, height: 1066 });
    const cut = await cutMediaLookFrames(big, { kind: "sprite", gridA: 2, gridB: 1, cellWidth: 600, cellHeight: 1066, count: 2, intervalMs: 1000 });
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    for (const frame of cut.frames) {
      expect(Math.max(frame.width, frame.height)).toBe(512);
      expect(frame.width).toBeLessThanOrEqual(512);
    }
  });
});

describe("cutting a cover or a photo", () => {
  it("one frame, downscaled to 512 px, its place unknown", async () => {
    const cover = await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#3366cc" } }).jpeg().toBuffer();
    const cut = await cutMediaLookFrames(cover, { kind: "still" });
    expect(cut).toMatchObject({ ok: true, gridCols: null, gridRows: null });
    if (!cut.ok) return;
    expect(cut.frames).toHaveLength(1);
    expect(cut.frames[0]).toMatchObject({ index: 0, atMs: null, width: 288, height: 512 });
    const small = await sharp({ create: { width: 240, height: 426, channels: 3, background: "#3366cc" } }).jpeg().toBuffer();
    const kept = await cutMediaLookFrames(small, { kind: "still" });
    expect(kept.ok && kept.frames[0]).toMatchObject({ width: 240, height: 426 });
  });
});
