// Where the `operator_start` gap's boundary waits for its commit (ws/
// sockets.ts, afterRestart): the last event saved before this operator,
// written and synced before the gap is tried, removed once the gap is
// durable. An operator that dies before then leaves it to the next one, which
// writes its gap from that first boundary — not from what it finds later in
// the buffer (the ends of connections that may have gone in by then).
// Kept on the state volume, beside the buffer's id.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import type { Boundary, BoundaryStore } from "./sockets.ts";

function syncDir(path: string): void {
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

function boundaryOf(text: string): Boundary | null {
  const parsed = JSON.parse(text) as Partial<Boundary> | null;
  if (parsed === null || typeof parsed !== "object") return null;
  const { bufferId, seq, wall } = parsed;
  if (typeof bufferId !== "string") return null;
  if (seq !== null && !(Number.isSafeInteger(seq) && seq! > 0)) return null;
  if (wall !== null && !Number.isFinite(wall)) return null;
  return { bufferId, seq: seq ?? null, wall: wall ?? null };
}

export class BoundaryFile implements BoundaryStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  /** The boundary a previous operator left, or null. Throws when the file
   *  is there and cannot be read. */
  load(): Boundary | null {
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const boundary = boundaryOf(text);
    if (boundary === null) throw new Error("the start's boundary file is not a boundary");
    return boundary;
  }

  save(boundary: Boundary): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temp = `${this.#path}.tmp`;
    const fd = openSync(temp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(boundary));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.#path);
    syncDir(this.#path);
  }

  clear(): void {
    rmSync(this.#path, { force: true });
    syncDir(this.#path);
  }
}
