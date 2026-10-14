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
// one stands. Hub keeps only a mirror of it (for the owner's view).
//
// The file is replaced whole — written, synced, renamed, its directory
// synced — and read once, when the operator starts. A file that cannot be
// read or understood is no halt to forget: the operator does not start (the
// owner looks at the volume).

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
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

export class HaltStore {
  readonly #path: string | null;
  #memory: HeldHalt | null = null;

  /** `path` null: in memory only (tests). */
  constructor(path: string | null) {
    this.#path = path;
  }

  get path(): string | null {
    return this.#path;
  }

  /** The halt held on the volume (null: none). Throws `HaltFileUnreadable`
   *  for a file that is there and cannot be read or understood. */
  read(): HeldHalt | null {
    if (this.#path === null) return this.#memory;
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new HaltFileUnreadable(this.#path, (error as NodeJS.ErrnoException).code ?? "unreadable");
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new HaltFileUnreadable(this.#path, "not JSON");
    }
    if (value === null) return null;
    const halt = value as Partial<HeldHalt>;
    if (typeof value !== "object" || typeof halt.id !== "string" || !UUID.test(halt.id) || typeof halt.reason !== "string" || !REASONS.has(halt.reason)
      || typeof halt.atWall !== "number" || !Number.isFinite(halt.atWall)) {
      throw new HaltFileUnreadable(this.#path, "not a halt");
    }
    return { id: halt.id, reason: halt.reason as StopReason, atWall: halt.atWall };
  }

  /** Replace what is held (null: none), synced before it returns. Throws
   *  when it could not be written: nothing held changes on the volume then. */
  write(halt: HeldHalt | null): void {
    if (this.#path === null) {
      this.#memory = halt;
      return;
    }
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temp = `${this.#path}.tmp`;
    const fd = openSync(temp, "w", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(halt)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.#path);
    const dir = openSync(dirname(this.#path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
}
