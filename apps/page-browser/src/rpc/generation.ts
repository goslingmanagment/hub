// The highest owner generation the operator accepted (plan §4.7: commands
// of an earlier owner are never executed). Kept on the buffer volume, so a
// restarted operator still refuses an engine that lost the page before it
// restarted. A generation that cannot be written is not accepted.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import { errorMessage, makeLog, type Logger } from "../shared/util.ts";

export class GenerationStore {
  readonly #path: string | null;
  readonly #log: Logger;
  #current = 0;

  /** `path` null: in memory only (tests). */
  constructor(path: string | null, log?: Logger) {
    this.#path = path;
    this.#log = log ?? makeLog("generation");
    if (path === null) return;
    try {
      const value = Number(readFileSync(path, "utf8").trim());
      if (Number.isSafeInteger(value) && value >= 0) this.#current = value;
      else this.#log("unreadable", { error: "not a generation" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#log("unreadable", { error: errorMessage(error) });
    }
  }

  get current(): number {
    return this.#current;
  }

  /** Record a higher generation (written and synced before it counts). */
  raise(to: number): void {
    if (to <= this.#current) return;
    if (this.#path !== null) {
      mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temp = `${this.#path}.tmp`;
      const fd = openSync(temp, "w", 0o600);
      try {
        writeSync(fd, `${to}\n`);
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
    this.#current = to;
  }
}
