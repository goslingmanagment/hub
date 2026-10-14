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
// sequence is what is held. A write is checked whole (its bytes, then its
// sync): a short one is a failed one. A slot that is not empty and not
// valid when the operator starts means a halt was being written (Astra round
// 5): the operator starts holding a strict halt of its own (`halt_unreadable`,
// a new id) that only the owner's decision clears — never "no halt"; so does
// a file that cannot be read. A file that cannot be made (the disk full when
// the operator starts) holds nothing: every halt is held in memory then, and
// Hub's mirror of it refuses every start until the owner clears it.
//
// What is left (the accepted residual, plan §4.9): a write that fails with
// both slots still valid — the volume refused it — leaves the record before
// it, which may hold no halt; if the operator then restarts before Hub
// received that halt in a state, it is gone. Hub's mirror holds it whenever
// a state carried it.
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


const REASONS: ReadonlySet<string> = new Set(STOP_REASONS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the volume holds: the halt (null: none), the last halt cleared. */
export interface HaltRecord {
  halt: HeldHalt | null;
  lastClearedId: string | null;
  /** Read back: a slot was spoilt or the file could not be read — the halt
   *  is a new `halt_unreadable` the operator holds (and writes). */
  unreadable?: true;
}

/** The halt the operator holds when its halt file is spoilt or unreadable. */
export const HALT_UNREADABLE: StopReason = "halt_unreadable";

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

type WriteSync = (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;

export class HaltStore {
  readonly #path: string | null;
  readonly #writeSync: WriteSync;
  #memory: HaltRecord = { halt: null, lastClearedId: null };
  /** Each slot's sequence (null: empty, spoilt, or written last and failed —
   *  the next write goes there first). */
  #slots: Array<number | null> = [null, null];
  /** The file could be made: writes go to it (else they make it first). */
  #ready = false;

  /** `path` null: in memory only (tests). `writeSync`: tests' disk. */
  constructor(path: string | null, options: { writeSync?: WriteSync } = {}) {
    this.#path = path;
    this.#writeSync = options.writeSync ?? ((fd, buffer, offset, length, position) => writeSync(fd, buffer, offset, length, position));
  }

  get path(): string | null {
    return this.#path;
  }

  /** What the volume holds, read when the operator starts — the file made
   *  (both slots preallocated, synced) if it is not there yet. A spoilt slot
   *  or a file that cannot be read: a new strict halt (`halt_unreadable`). */
  read(): HaltRecord {
    if (this.#path === null) return this.#memory;
    const path = this.#path;
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return unreadable(null);
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
    } catch {
      return unreadable(null);
    } finally {
      closeSync(fd);
    }
    this.#ready = true;
    // A file shorter than its two slots: what is missing was being written.
    const slots = [0, 1].map((index) => (read < (index + 1) * SLOT_BYTES ? "invalid" as const : parseSlot(bytes.subarray(index * SLOT_BYTES, (index + 1) * SLOT_BYTES))));
    this.#slots = slots.map((slot) => (typeof slot === "object" ? slot.seq : null));
    const valid = slots.filter((slot): slot is { seq: number; record: HaltRecord } => typeof slot === "object");
    const latest = valid.length === 0 ? null : valid.reduce((a, b) => (b.seq > a.seq ? b : a));
    // A slot neither empty nor valid: a halt was being written — held.
    if (slots.some((slot) => slot === "invalid")) return unreadable(latest?.record.lastClearedId ?? null);
    return latest?.record ?? { halt: null, lastClearedId: null };
  }

  /** What is held from now on, in place into a spoilt or empty slot, else
   *  the older one; its bytes checked and synced before it returns. Throws
   *  when it could not be written: what the other slot holds stays. */
  write(record: HaltRecord): void {
    if (this.#path === null) {
      this.#memory = { halt: record.halt, lastClearedId: record.lastClearedId };
      return;
    }
    if (!this.#ready) this.#make();
    const a = this.#slots[0] ?? null;
    const b = this.#slots[1] ?? null;
    const target = a === null ? 0 : b === null ? 1 : a < b ? 0 : 1;
    const seq = Math.max(a ?? 0, b ?? 0) + 1;
    // Until it is written whole, that slot holds nothing known.
    this.#slots[target] = null;
    const fd = openSync(this.#path, "r+");
    try {
      const written = this.#writeSync(fd, slotBytes(seq, { halt: record.halt, lastClearedId: record.lastClearedId }), 0, SLOT_BYTES, target * SLOT_BYTES);
      if (written !== SLOT_BYTES) throw new Error(`a short write of the halt file (${written} of ${SLOT_BYTES} bytes)`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#slots[target] = seq;
  }

  /** The file, both slots preallocated (zeros) and synced, its directory too. */
  #make(): void {
    const path = this.#path!;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, "wx", 0o600);
    try {
      const written = writeSync(fd, Buffer.alloc(2 * SLOT_BYTES), 0, 2 * SLOT_BYTES, 0);
      if (written !== 2 * SLOT_BYTES) throw new Error(`a short write of the halt file (${written} of ${2 * SLOT_BYTES} bytes)`);
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
    this.#slots = [null, null];
  }
}

/** A spoilt or unreadable halt file: a new strict halt only the owner clears. */
function unreadable(lastClearedId: string | null): HaltRecord {
  return { halt: newHalt(HALT_UNREADABLE), lastClearedId, unreadable: true };
}
