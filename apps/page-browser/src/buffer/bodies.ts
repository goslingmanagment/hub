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
// - A body is sent in parts of up to 1 MiB through one open descriptor
//   (`open`) for the whole transmission: a resultAck that deletes the file
//   meanwhile (an earlier delivery's) does not tear the body — the
//   descriptor keeps reading what the file held. What is in memory is one
//   part. A part that cannot be read (an I/O error, a short read) fails the
//   transmission, never the next body's.
// - At the buffer's open, `sweep` removes every part file and every body no
//   stored outcome names — what a crash left between a seal and its commit,
//   or between a deletion's commit and its file.
// - The bytes are the response's as the page got them (decoded). They are
//   the engine's input, like the bytes Hub holds in memory today: the
//   engine's codec decides what of them is journaled (plan §3.2; the CDN
//   tokens of the describer's sources must stay usable).
//
// - A body that grows counts in the buffer's caps while it grows (its
//   `quota`): room is reserved before each chunk is written, and a chunk
//   the caps have no room for is not written — the body is not whole any
//   more, and the buffer is full. The reservation ends with the body: a
//   sealed body counts again with the record that names it.
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

/** Room in the buffer's caps for a body while it grows. */
export interface BodyQuota {
  /** Room for `bytes` more; false: none (the chunk is not written). */
  reserve(bytes: number): boolean;
  /** The body is sealed or gone: what it reserved is given back. */
  release(bytes: number): void;
}

/** One body as it arrives. */
export class BodyWriter {
  readonly bodyId: string;
  readonly #dir: string;
  readonly #hash: Hash = createHash("sha256");
  readonly #quota: BodyQuota | null;
  #fd: number | null;
  #bytes = 0;
  #reserved = 0;
  #error: string | null = null;
  #done = false;

  constructor(dir: string, bodyId: string, quota: BodyQuota | null = null) {
    this.#dir = dir;
    this.bodyId = bodyId;
    this.#quota = quota;
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
    if (this.#quota !== null) {
      // The full buffer's handler may end this body meanwhile.
      if (!this.#quota.reserve(chunk.length)) {
        this.#error ??= "the buffer's cap leaves no room for it";
        return false;
      }
      if (this.#done || this.#fd === null) {
        this.#quota.release(chunk.length);
        return false;
      }
      this.#reserved += chunk.length;
    }
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
    this.#release();
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
    this.#release();
    if (this.#fd !== null) closeQuietly(this.#fd);
    this.#fd = null;
    rmSync(this.#partPath, { force: true });
  }

  #release(): void {
    const reserved = this.#reserved;
    this.#reserved = 0;
    if (reserved > 0) this.#quota?.release(reserved);
  }
}

/** One sealed body, open for one transmission: its size as it was opened,
 *  read part by part, closed at the end. */
export class BodyReader {
  readonly bodyId: string;
  readonly size: number;
  #fd: number | null;
  readonly #fault: ((bodyId: string, part: number) => Error | null) | undefined;

  constructor(bodyId: string, fd: number, fault?: (bodyId: string, part: number) => Error | null) {
    this.bodyId = bodyId;
    this.#fd = fd;
    this.#fault = fault;
    this.size = fstatSync(fd).size;
  }

  /** Part `part` (`partBytes` a part); throws when it cannot be read whole. */
  read(part: number, partBytes: number): Buffer {
    const fd = this.#fd;
    if (fd === null) throw new Error("the body is closed");
    const fault = this.#fault?.(this.bodyId, part);
    if (fault) throw fault;
    const start = part * partBytes;
    const length = Math.max(0, Math.min(partBytes, this.size - start));
    const out = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, out, read, length - read, start + read);
      if (n === 0) throw new Error(`the body ended at ${start + read} bytes of ${this.size}`);
      read += n;
    }
    return out;
  }

  close(): void {
    if (this.#fd !== null) closeQuietly(this.#fd);
    this.#fd = null;
  }
}

export class BodyFiles {
  readonly dir: string;
  readonly #readFault: ((bodyId: string, part: number) => Error | null) | undefined;

  /** `readFault`: tests — an error for a read of a body's part. */
  constructor(dir: string, readFault?: (bodyId: string, part: number) => Error | null) {
    this.dir = dir;
    this.#readFault = readFault;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** A sealed body open for one transmission; null when it is not there (its
   *  outcome acknowledged, or the file lost). Other failures throw. */
  open(bodyId: string): BodyReader | null {
    if (!NAME.test(bodyId)) return null;
    let fd: number;
    try {
      fd = openSync(join(this.dir, bodyId), "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return new BodyReader(bodyId, fd, this.#readFault);
    } catch (error) {
      closeQuietly(fd);
      throw error;
    }
  }

  begin(quota: BodyQuota | null = null): BodyWriter {
    return new BodyWriter(this.dir, randomUUID(), quota);
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
