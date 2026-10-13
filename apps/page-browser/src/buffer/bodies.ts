// Response bodies on the buffer volume (plan §4.2, step 7; §4.13): one file
// per body in the buffer's bodies/ directory, named by the body's id (a
// UUID), next to the database that names it (outcomes.body_id).
//
// - A body is written as it arrives, chunk by chunk, to `<id>.part`: the
//   operator's memory does not grow with it. Only a body proven whole is
//   kept (stage 1, amendment 34): `seal` syncs the file, renames it to `<id>`
//   and syncs the directory — the outcome that names it is committed only
//   after that. A body that is not whole is never sealed: its part file
//   goes.
// - A body is sent in parts of up to 1 MiB (`read`), read from the file each
//   time: what is in memory is one part.
// - At the buffer's open, `sweep` removes every part file and every body no
//   stored outcome names — what a crash left between a seal and its commit,
//   or between a deletion's commit and its file.
// - The bytes are the response's as the page got them (decoded). They are
//   the engine's input, like the bytes Hub holds in memory today: the
//   engine's codec decides what of them is journaled (plan §3.2; the CDN
//   tokens of the describer's sources must stay usable).
//
// Synchronous on purpose, like the store (store.ts): a chunk is tens of KB,
// and the writes keep their order without a queue.

import { createHash, randomUUID, type Hash } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

import { errorMessage } from "../shared/util.ts";

const NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.part)?$/;

export interface SealedBody {
  bodyId: string;
  bytes: number;
  sha256: string;
}

/** One body as it arrives. */
export class BodyWriter {
  readonly bodyId: string;
  readonly #dir: string;
  readonly #hash: Hash = createHash("sha256");
  #fd: number | null;
  #bytes = 0;
  #error: string | null = null;
  #done = false;

  constructor(dir: string, bodyId: string) {
    this.#dir = dir;
    this.bodyId = bodyId;
    this.#fd = openSync(this.#partPath, "wx", 0o600);
  }

  get #partPath(): string {
    return join(this.#dir, `${this.bodyId}.part`);
  }

  /** Bytes written so far. */
  get bytes(): number {
    return this.#bytes;
  }

  /** Why the file could not be written, or null. */
  get error(): string | null {
    return this.#error;
  }

  /** False once the file could not be written (a full disk): the body is
   *  not whole any more. */
  write(chunk: Buffer): boolean {
    if (this.#done || this.#error !== null || this.#fd === null) return false;
    try {
      let offset = 0;
      while (offset < chunk.length) offset += writeSync(this.#fd, chunk, offset, chunk.length - offset);
      this.#hash.update(chunk);
      this.#bytes += chunk.length;
      return true;
    } catch (error) {
      this.#error = errorMessage(error);
      return false;
    }
  }

  /** The whole body, durable under its name; null if it could not be (the
   *  part file is gone then). */
  seal(): SealedBody | null {
    if (this.#done) return null;
    this.#done = true;
    const fd = this.#fd;
    this.#fd = null;
    if (fd === null || this.#error !== null) {
      if (fd !== null) closeQuietly(fd);
      rmSync(this.#partPath, { force: true });
      return null;
    }
    try {
      fsyncSync(fd);
      closeSync(fd);
      renameSync(this.#partPath, join(this.#dir, this.bodyId));
      syncDir(this.#dir);
    } catch (error) {
      this.#error = errorMessage(error);
      closeQuietly(fd);
      rmSync(this.#partPath, { force: true });
      rmSync(join(this.#dir, this.bodyId), { force: true });
      return null;
    }
    return { bodyId: this.bodyId, bytes: this.#bytes, sha256: this.#hash.digest("hex") };
  }

  /** Not whole, or not wanted: the part file goes. */
  abandon(): void {
    if (this.#done) return;
    this.#done = true;
    if (this.#fd !== null) closeQuietly(this.#fd);
    this.#fd = null;
    rmSync(this.#partPath, { force: true });
  }
}

export class BodyFiles {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  begin(): BodyWriter {
    return new BodyWriter(this.dir, randomUUID());
  }

  /** A sealed body's size, or null when it is not there. */
  size(bodyId: string): number | null {
    if (!NAME.test(bodyId)) return null;
    try {
      return statSync(join(this.dir, bodyId)).size;
    } catch {
      return null;
    }
  }

  /** Part `part` of a sealed body (`partBytes` a part), or null when the
   *  body is not there. */
  read(bodyId: string, part: number, partBytes: number): Buffer | null {
    if (!NAME.test(bodyId)) return null;
    let fd: number;
    try {
      fd = openSync(join(this.dir, bodyId), "r");
    } catch {
      return null;
    }
    try {
      const size = fstatSync(fd).size;
      const start = part * partBytes;
      const length = Math.max(0, Math.min(partBytes, size - start));
      const out = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const n = readSync(fd, out, read, length - read, start + read);
        if (n === 0) break;
        read += n;
      }
      return read === length ? out : null;
    } finally {
      closeQuietly(fd);
    }
  }

  remove(bodyId: string): void {
    if (!NAME.test(bodyId)) return;
    rmSync(join(this.dir, bodyId), { force: true });
  }

  /** Part files, and sealed bodies `keep` does not name, go. Returns how
   *  many files went. */
  sweep(keep: ReadonlySet<string>): number {
    let removed = 0;
    for (const name of readdirSync(this.dir)) {
      const match = NAME.exec(name);
      if (!match || (match[2] === undefined && keep.has(match[1]!))) continue;
      rmSync(join(this.dir, name), { force: true });
      removed += 1;
    }
    return removed;
  }
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // closing is all that was left
  }
}

function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
