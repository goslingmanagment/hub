// The highest owner generation the operator accepted (plan §4.7: commands
// of an earlier owner are never executed). Kept on the buffer volume, so a
// restarted operator still refuses an engine that lost the page before it
// restarted. A generation that cannot be written is not accepted.
//
// Hub counts owner generations per page (`sync_pages.owner_generation`), and
// the volume belongs to the profile, which moves to another page without a
// copy (plan §3.2). So the highest generation is kept for every page the
// profile has served: one of another page says nothing about this one, and
// going back to a page finds its own floor again.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import { errorMessage, makeLog, type Logger } from "../shared/util.ts";

export class GenerationStore {
  readonly #path: string | null;
  readonly #log: Logger;
  readonly #floors = new Map<number, number>();

  /** `path` null: in memory only (tests). */
  constructor(path: string | null, log?: Logger) {
    this.#path = path;
    this.#log = log ?? makeLog("generation");
    if (path === null) return;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#log("unreadable", { error: errorMessage(error) });
      return;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const [page, generation] = line.trim().split(/\s+/).map(Number);
      if (Number.isSafeInteger(page) && page! > 0 && Number.isSafeInteger(generation) && generation! >= 0) {
        this.#floors.set(page!, Math.max(generation!, this.#floors.get(page!) ?? 0));
      } else {
        this.#log("unreadable", { error: "a line that is not a page and a generation" });
      }
    }
  }

  /** The highest generation accepted for `pageId` (0: none yet). */
  current(pageId: number): number {
    return this.#floors.get(pageId) ?? 0;
  }

  /** Record a higher generation of `pageId` (written and synced before it
   *  counts). */
  raise(pageId: number, to: number): void {
    if (to <= this.current(pageId)) return;
    const next = new Map(this.#floors).set(pageId, to);
    if (this.#path !== null) {
      mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temp = `${this.#path}.tmp`;
      const fd = openSync(temp, "w", 0o600);
      try {
        writeSync(fd, [...next].map(([page, generation]) => `${page} ${generation}\n`).join(""));
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
    this.#floors.set(pageId, to);
  }
}
