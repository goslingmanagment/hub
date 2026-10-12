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
import { errorMessage, makeLog, urlForLog, type Logger } from "../shared/util.ts";

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
  /** "fulfilled": answered by the operator, nothing sent (env/check.ts). */
  decision: "continued" | "failed" | "fulfilled";
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
  const { scheme, path } = urlForLog(url);
  if (path === "") return { host: "", path: scheme === "" ? "" : `${scheme}:` };
  try {
    return { host: new URL(url).hostname.toLowerCase(), path };
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
  /** Bytes a journal may have waiting for the disk (default 8 MiB). */
  maxPendingBytes?: number;
  /** The journals cannot keep up or cannot write: what passes through the
   *  page would go unrecorded, so the operator stops the page's traffic. */
  onTrouble?: (reason: string) => void;
}

export class Journals {
  readonly #dir: string;
  readonly #retentionDays: number;
  readonly #now: () => number;
  readonly #log: Logger;
  #day = "";
  readonly #streams = new Map<JournalKind, WriteStream>();
  readonly #maxPendingBytes: number;
  readonly #onTrouble: (reason: string) => void;
  /** Journals over their pending bytes, until they drain: their lines are
   *  dropped meanwhile, counted, and the gap is written when they drain. */
  readonly #behind = new Set<JournalKind>();
  readonly #dropped = new Map<JournalKind, number>();
  /** Write errors so far. */
  #errors = 0;
  #housekeeping: Promise<void> = Promise.resolve();

  constructor(options: JournalOptions) {
    this.#dir = options.dir;
    this.#retentionDays = options.retentionDays ?? 30;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? makeLog("journal");
    this.#maxPendingBytes = options.maxPendingBytes ?? 8 * 1024 * 1024;
    this.#onTrouble = options.onTrouble ?? (() => undefined);
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
    for (const [kind, stream] of this.#streams) this.#writeGap(kind, stream);
    this.#behind.clear();
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

  /** Everything written so far reached the disk: true when it all did,
   *  and nothing failed or fell behind meanwhile (a start waits for it). */
  async flushed(timeoutMs = 2000): Promise<boolean> {
    if (this.#behind.size > 0) return false;
    const errors = this.#errors;
    const written = Promise.all(
      [...this.#streams.values()].map((stream) => new Promise<boolean>((resolve) => stream.write("", (error) => resolve(!error)))),
    ).then((results) => results.every(Boolean));
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)));
    const ok = await Promise.race([written, late]);
    clearTimeout(timer);
    return ok && this.#errors === errors && this.#behind.size === 0;
  }

  #write(kind: JournalKind, line: object): void {
    if (this.#behind.has(kind)) {
      this.#dropped.set(kind, (this.#dropped.get(kind) ?? 0) + 1);
      return;
    }
    this.#roll();
    const stream = this.#stream(kind);
    const text = scrub(JSON.stringify({ at: new Date(this.#now()).toISOString(), ...line }));
    stream.write(`${text}\n`, () => this.#maybeCaughtUp(kind, stream));
    if (stream.writableLength > this.#maxPendingBytes) {
      this.#behind.add(kind);
      this.#log("write.behind", { kind, pendingBytes: stream.writableLength });
      this.#onTrouble(`the ${kind} journal is ${stream.writableLength} bytes behind the disk`);
    }
  }

  #stream(kind: JournalKind): WriteStream {
    let stream = this.#streams.get(kind);
    if (!stream) {
      stream = createWriteStream(join(this.#dir, `${kind}-${this.#day}.jsonl`), { flags: "a", mode: 0o600 });
      const opened = stream;
      opened.on("error", (error) => {
        // A full disk must not take the operator down: the page's traffic
        // stops instead, and the next line opens the file anew.
        if (this.#streams.get(kind) === opened) this.#streams.delete(kind);
        // No drain comes from a failed file: the next line opens a new one,
        // which carries the gap first.
        this.#behind.delete(kind);
        this.#errors += 1;
        this.#log("write.failed", { kind, error: errorMessage(error) });
        this.#onTrouble(`the ${kind} journal could not be written: ${errorMessage(error)}`);
      });
      this.#writeGap(kind, opened);
      this.#streams.set(kind, stream);
    }
    return stream;
  }

  /** A journal that was behind has written everything: it takes lines again,
   *  the first being the gap. */
  #maybeCaughtUp(kind: JournalKind, stream: WriteStream): void {
    if (!this.#behind.has(kind) || stream.writableLength > 0 || stream.writableEnded || this.#streams.get(kind) !== stream) return;
    this.#behind.delete(kind);
    this.#log("write.caught_up", { kind, dropped: this.#dropped.get(kind) ?? 0 });
    this.#writeGap(kind, stream);
  }

  /** The lines dropped while the journal was behind or failing: one line. */
  #writeGap(kind: JournalKind, stream: WriteStream): void {
    const dropped = this.#dropped.get(kind) ?? 0;
    if (dropped === 0) return;
    this.#dropped.delete(kind);
    stream.write(`${JSON.stringify({ at: new Date(this.#now()).toISOString(), gap: true, dropped })}\n`);
  }

  #roll(): void {
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    if (day === this.#day) return;
    this.#day = day;
    // Yesterday's files are compressed only once everything written to them
    // is on disk.
    // A journal that was behind has caught up once yesterday's file is
    // written: its next line opens today's file, the gap first.
    const ending = [...this.#streams].map(
      ([kind, stream]) =>
        new Promise<void>((resolve) =>
          stream.end(() => {
            this.#behind.delete(kind);
            resolve();
          }),
        ),
    );
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
