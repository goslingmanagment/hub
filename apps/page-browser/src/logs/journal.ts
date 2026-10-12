// The operator's journals (plan §4.11): JSON Lines on the buffer volume
// (/data/buffer/logs), one file per kind and UTC day; a day that ended is
// compressed (gzip), and files older than the retention (30 days,
// preliminary — spec §8.2) are removed.
//
//   connections — every tunnel of the proxy and every refusal: host, port,
//                 class, opened and closed, bytes both ways, held, result
//   requests    — every request the interception decided: method, host,
//                 path, admission, time, decision, result
//   states      — every transition of the page (plan §4.1) and its reason
//
// What never goes in: passwords, 2FA codes, tokens, cookies, the SOCKS5
// login and password, headers, query strings, request and response bodies.
// The records are narrow on purpose — a path, never a URL — and every line
// goes through the secret scrubber (shared/secrets.ts) as well.

import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { scrub } from "../shared/secrets.ts";
import { errorMessage, makeLog, type Logger } from "../shared/util.ts";

export type JournalKind = "connections" | "requests" | "states";
const KINDS: readonly JournalKind[] = ["connections", "requests", "states"];

export interface ConnectionLine {
  id: number;
  host: string;
  port: number;
  cls: string;
  openedWall: number;
  closedWall: number | null;
  durationMs: number | null;
  up: number;
  down: number;
  held: number;
  refused: boolean;
  result: string;
}

export interface RequestLine {
  method: string;
  host: string;
  /** The URL's path only: never its query (a token or a CDN signature may
   *  ride there) or fragment. */
  path: string;
  resourceType: string;
  /** The engine's admission (attempt id), or why there was none. */
  admission: string | null;
  decision: "continued" | "failed";
  result: string;
}

export interface StateLine {
  from: string;
  to: string;
  stopReason: string | null;
  retryAtWall: number | null;
  halted: boolean;
  note: string;
}

/** A URL's host and path, nothing else. */
export function hostAndPath(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname.toLowerCase(), path: parsed.pathname };
  } catch {
    return { host: "", path: "" };
  }
}

const FILE = /^(connections|requests|states)-(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/;

export interface JournalOptions {
  dir: string;
  retentionDays?: number;
  now?: () => number;
  log?: Logger;
}

export class Journals {
  readonly #dir: string;
  readonly #retentionDays: number;
  readonly #now: () => number;
  readonly #log: Logger;
  #day = "";
  readonly #streams = new Map<JournalKind, WriteStream>();
  #failed = false;
  #housekeeping: Promise<void> = Promise.resolve();

  constructor(options: JournalOptions) {
    this.#dir = options.dir;
    this.#retentionDays = options.retentionDays ?? 30;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? makeLog("journal");
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    this.#roll();
  }

  connection(line: ConnectionLine): void {
    this.#write("connections", line);
  }

  request(line: RequestLine): void {
    this.#write("requests", line);
  }

  state(line: StateLine): void {
    this.#write("states", line);
  }

  /** Settles when the files written so far are flushed and closed. */
  async close(): Promise<void> {
    const streams = [...this.#streams.values()];
    this.#streams.clear();
    await Promise.all(streams.map((stream) => new Promise<void>((resolve) => stream.end(() => resolve()))));
    await this.#housekeeping;
  }

  /** Compression and retention, now (they also run at each new day). */
  housekeep(): Promise<void> {
    this.#housekeeping = this.#housekeeping.then(() => this.#compressAndExpire());
    return this.#housekeeping;
  }

  #write(kind: JournalKind, line: object): void {
    this.#roll();
    const stream = this.#stream(kind);
    const text = scrub(JSON.stringify({ at: new Date(this.#now()).toISOString(), ...line }));
    stream.write(`${text}\n`);
  }

  #stream(kind: JournalKind): WriteStream {
    let stream = this.#streams.get(kind);
    if (!stream) {
      stream = createWriteStream(join(this.#dir, `${kind}-${this.#day}.jsonl`), { flags: "a", mode: 0o600 });
      stream.on("error", (error) => {
        // A full disk must not take the operator down; the journal says so once.
        if (!this.#failed) this.#log("write.failed", { kind, error: errorMessage(error) });
        this.#failed = true;
      });
      this.#streams.set(kind, stream);
    }
    return stream;
  }

  #roll(): void {
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    if (day === this.#day) return;
    this.#day = day;
    // Yesterday's files are compressed only once everything written to them
    // is on disk.
    const ending = [...this.#streams.values()].map((stream) => new Promise<void>((resolve) => stream.end(() => resolve())));
    this.#streams.clear();
    this.#housekeeping = this.#housekeeping.then(() => Promise.all(ending)).then(() => this.#compressAndExpire());
  }

  async #compressAndExpire(): Promise<void> {
    const today = new Date(this.#now()).toISOString().slice(0, 10);
    const oldest = new Date(this.#now() - this.#retentionDays * 86_400_000).toISOString().slice(0, 10);
    let names: string[];
    try {
      names = readdirSync(this.#dir);
    } catch (error) {
      this.#log("housekeep.failed", { error: errorMessage(error) });
      return;
    }
    for (const name of names) {
      const match = FILE.exec(name);
      if (!match || !KINDS.includes(match[1] as JournalKind)) continue;
      const day = match[2]!;
      const path = join(this.#dir, name);
      try {
        if (day < oldest) {
          rmSync(path, { force: true });
          continue;
        }
        if (match[3] === undefined && day < today) {
          const gz = `${path}.gz`;
          await pipeline(createReadStream(path), createGzip(), createWriteStream(`${gz}.tmp`, { mode: 0o600 }));
          renameSync(`${gz}.tmp`, gz);
          rmSync(path, { force: true });
        }
      } catch (error) {
        this.#log("housekeep.failed", { file: name, error: errorMessage(error) });
      }
    }
  }

  /** The journal files, for the operator's own tools and tests. */
  files(): Array<{ name: string; bytes: number }> {
    return readdirSync(this.#dir)
      .filter((name) => FILE.test(name))
      .map((name) => ({ name, bytes: statSync(join(this.#dir, name)).size }));
  }
}
