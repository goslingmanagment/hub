// The halt the operator holds for the owner's decision (Project Browser
// PR 17, Astra round 3: the halt lives where it is enforced). A stop that
// only the owner can decide — a changed exit IP, a header or socket the site
// changed, a guard that failed, Fansly signing the browser out — is written
// here, on the buffer volume, before the browser stops, and kept across
// restarts of the operator and of its container: an operator that starts
// with a halt on its volume stands halted, and refuses every start (and the
// exit's opening) until the halt is cleared — by the owner's `clearHalt`
// naming this very halt (his audited `sync browser start`), or, for
// `login_required` alone, by the operator itself once the expected account
// is confirmed after the owner's login.
//
// One halt is held at a time, the stricter one: any halt but
// `login_required` replaces a held `login_required` (the login may start the
// browser for it, nothing else) and is never replaced by it; else the first
// one stands. Hub keeps a mirror of it, which refuses starts besides until it
// sees the halt cleared by its own id (`state.lastClearedHaltId`).
//
// The file is preallocated once (two slots of `SLOT_BYTES`, written in
// place, synced): a write never needs room the disk may not have (Astra round
// 4: a full disk dropped a halt written by a replace), and a write cut midway
// spoils only the slot it wrote — the other keeps the record before it; each
// slot carries its digest and a sequence, the valid one with the higher
// sequence is what is held. A file that cannot be read or understood is no
// halt to forget: the operator does not start (the owner looks at the
// volume). A file that cannot be made (the disk full when the operator
// starts) holds nothing: every halt is held in memory then, and Hub's mirror
// of it refuses every start until the owner clears it.
//
// With the halt the store keeps the id of the last halt cleared — by the
// owner's clearHalt or by the operator's own login_required clearing — which
// the operator says (`state.lastClearedHaltId`): Hub lets its mirror of a
// halt go only on that word, never because the halt is no longer said.

import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import { STOP_REASONS, type StopReason } from "./steps.ts";

export interface HeldHalt {
  /** The halt's own id: a `clearHalt` clears only the halt it names. */
  id: string;
  reason: StopReason;
  atWall: number;
}

/** The stop reasons that are no halt for the owner's decision: the engine's
 *  own stop (the leave's, the owner's stop that Hub keeps), and a buffer that
 *  does not open (the operator stands again by itself once it opens). */
const NOT_THE_OWNERS_DECISION: ReadonlySet<StopReason> = new Set<StopReason>(["owner_stop", "buffer_unavailable"]);

/** The halt the owner's login decides. */
export const LOGIN_DECIDES: StopReason = "login_required";

/** Whether a halt with this reason is the owner's to decide (held). */
export function heldForTheOwner(reason: StopReason): boolean {
  return !NOT_THE_OWNERS_DECISION.has(reason);
}

/** Whether `next` replaces the held `current` (the stricter one holds). */
export function replacesHeld(current: StopReason | null, next: StopReason): boolean {
  return current === null || (current === LOGIN_DECIDES && next !== LOGIN_DECIDES);
}

export function newHalt(reason: StopReason, atWall = Date.now()): HeldHalt {
  return { id: randomUUID(), reason, atWall };
}

export class HaltFileUnreadable extends Error {
  readonly path: string;
  constructor(path: string, why: string) {
    super(`the held halt in ${path} cannot be read (${why}): the operator does not start — look at the volume`);
    this.name = "HaltFileUnreadable";
    this.path = path;
  }
}

const REASONS: ReadonlySet<string> = new Set(STOP_REASONS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the volume holds: the halt (null: none), the last halt cleared. */
export interface HaltRecord {
  halt: HeldHalt | null;
  lastClearedId: string | null;
}

/** One slot of the file: its record, its sequence and its digest. */
export const SLOT_BYTES = 2048;

function digest(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

/** A slot's bytes: `<sha256 hex>\n<payload>\n`, padded with spaces. */
function slotBytes(seq: number, record: HaltRecord): Buffer {
  const payload = JSON.stringify({ seq, halt: record.halt, lastClearedId: record.lastClearedId });
  const text = `${digest(payload)}\n${payload}\n`;
  if (Buffer.byteLength(text) > SLOT_BYTES) throw new Error("a halt record larger than its slot");
  const buffer = Buffer.alloc(SLOT_BYTES, 0x20);
  buffer.write(text, 0, "utf8");
  return buffer;
}

/** A slot read back: its record and sequence, `empty` (never written), or
 *  `invalid` (cut midway, or not this store's). */
function parseSlot(bytes: Buffer): { seq: number; record: HaltRecord } | "empty" | "invalid" {
  if (bytes.every((byte) => byte === 0)) return "empty";
  const text = bytes.toString("utf8");
  const newline = text.indexOf("\n");
  if (newline !== 64) return "invalid";
  const end = text.indexOf("\n", newline + 1);
  if (end < 0) return "invalid";
  const payload = text.slice(newline + 1, end);
  if (digest(payload) !== text.slice(0, 64)) return "invalid";
  let value: { seq?: unknown; halt?: unknown; lastClearedId?: unknown };
  try {
    value = JSON.parse(payload) as typeof value;
  } catch {
    return "invalid";
  }
  if (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 1) return "invalid";
  const lastClearedId = value.lastClearedId === null ? null : typeof value.lastClearedId === "string" && UUID.test(value.lastClearedId) ? value.lastClearedId : undefined;
  if (lastClearedId === undefined) return "invalid";
  if (value.halt === null) return { seq: value.seq, record: { halt: null, lastClearedId } };
  const halt = value.halt as Partial<HeldHalt>;
  if (typeof halt !== "object" || typeof halt.id !== "string" || !UUID.test(halt.id) || typeof halt.reason !== "string" || !REASONS.has(halt.reason)
    || typeof halt.atWall !== "number" || !Number.isFinite(halt.atWall)) {
    return "invalid";
  }
  return { seq: value.seq, record: { halt: { id: halt.id, reason: halt.reason as StopReason, atWall: halt.atWall }, lastClearedId } };
}

export class HaltStore {
  readonly #path: string | null;
  #memory: HaltRecord = { halt: null, lastClearedId: null };
  /** The sequence of the slot written last (0: none yet). */
  #seq = 0;
  /** The file could be made: writes go to it (else they throw). */
  #ready = false;

  /** `path` null: in memory only (tests). */
  constructor(path: string | null) {
    this.#path = path;
  }

  get path(): string | null {
    return this.#path;
  }

  /** What the volume holds, read when the operator starts — the file made
   *  (both slots preallocated, synced) if it is not there yet. Throws
   *  `HaltFileUnreadable` for a file that is there and cannot be read or
   *  understood. */
  read(): HaltRecord {
    if (this.#path === null) return this.#memory;
    const path = this.#path;
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HaltFileUnreadable(path, (error as NodeJS.ErrnoException).code ?? "unreadable");
      try {
        this.#make();
      } catch {
        // Made at the first write, if it can be then (held in memory until).
      }
      return { halt: null, lastClearedId: null };
    }
    const bytes = Buffer.alloc(2 * SLOT_BYTES);
    let read = 0;
    try {
      for (;;) {
        const n = readSync(fd, bytes, read, bytes.length - read, read);
        if (n === 0) break;
        read += n;
        if (read === bytes.length) break;
      }
    } catch (error) {
      throw new HaltFileUnreadable(path, (error as NodeJS.ErrnoException).code ?? "unreadable");
    } finally {
      closeSync(fd);
    }
    if (read !== bytes.length) throw new HaltFileUnreadable(path, `${read} bytes, not ${bytes.length}`);
    const slots = [parseSlot(bytes.subarray(0, SLOT_BYTES)), parseSlot(bytes.subarray(SLOT_BYTES))];
    const valid = slots.filter((slot): slot is { seq: number; record: HaltRecord } => typeof slot === "object");
    if (valid.length === 0) {
      // Preallocated and never written: nothing held. Anything else: unknown.
      if (slots.every((slot) => slot === "empty")) {
        this.#ready = true;
        return { halt: null, lastClearedId: null };
      }
      throw new HaltFileUnreadable(path, "no valid slot");
    }
    const latest = valid.reduce((a, b) => (b.seq > a.seq ? b : a));
    this.#seq = latest.seq;
    this.#ready = true;
    return latest.record;
  }

  /** What is held from now on, in place into the older slot, synced before
   *  it returns. Throws when it could not be written: what the volume held
   *  before stays (the other slot). */
  write(record: HaltRecord): void {
    if (this.#path === null) {
      this.#memory = record;
      return;
    }
    if (!this.#ready) this.#make();
    const seq = this.#seq + 1;
    const fd = openSync(this.#path, "r+");
    try {
      // Sequences alternate between the slots: the one written is never the
      // one that holds the newest record.
      writeSync(fd, slotBytes(seq, record), 0, SLOT_BYTES, (seq % 2) * SLOT_BYTES);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#seq = seq;
  }

  /** The file, both slots preallocated (zeros) and synced, its directory too. */
  #make(): void {
    const path = this.#path!;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, Buffer.alloc(2 * SLOT_BYTES), 0, 2 * SLOT_BYTES, 0);
      fsyncSync(fd);
    } catch (error) {
      // Not made (the disk full): no partial file is left to be taken for a
      // spoilt one.
      closeSync(fd);
      rmSync(path, { force: true });
      throw error;
    }
    closeSync(fd);
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
    this.#ready = true;
    this.#seq = 0;
  }
}
