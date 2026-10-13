// The operator's buffer (plan §4.4; spec §5): what the page captured, kept
// on the buffer volume until the engine has it in Postgres.
//
//   events   — the stream of plan §4.4: the site socket's frames (ws.open,
//              ws.in, ws.close), gap marks, the site's responses for
//              `observations` (§4.3). Each gets the next number of this
//              buffer: an event's id is (buffer id, number), and the engine
//              keys it `browser:<buffer id>:<number>` (plan §3.2). They go to
//              the engine in order (stream.ts) and are deleted only by its
//              `ack`.
//   outcomes — an attempt's outcome (`result`, `siteDone`, `wsDone`) under
//              its attempt id, until the engine's `resultAck` (plan §4.2;
//              spec §6.2).
//
// The producers (PR 7 the site's requests, PR 9 Hub's, PR 10 the socket)
// call `append`, `putOutcome` and `markGap`. A write is accepted or refused
// at once — refused with `buffer_full` or `disk_full`, so a producer can
// refuse the site's request it stands for (plan §4.3) — and an accepted one
// is durable when its promise says so: writes are gathered for at most 20 ms
// (plan §4.14) and committed with one fsync. A crash loses nothing that was
// confirmed. Nothing is sent before it is durable.
//
// The caps (spec §5; plan §4.14): 2 GiB of what is stored and 72 h of the
// oldest of it, an alarm at 50 % and at 80 % of either, and the disk's own
// free space. When a cap or the disk runs out:
//   1. new writes are refused (`buffer_full`, `disk_full`);
//   2. the operator stops the page (`onFull`: the exit closes, the start
//      fails with that reason);
//   3. nothing unacknowledged is deleted to make room; once there is room
//      again, a `gap` mark from the last saved event is written first;
//   4. and the page may start again (`onRoom`).
//
// Bodies (BodyRef in `site.response` and `result`) are not stored here yet:
// the PRs that capture them (7, 9) add a `bodies` table with a migration
// (schema.ts) and send their parts as binary frames before the batch that
// names them (plan §4.13); the caps count them then.

import { statfsSync } from "node:fs";

import type { BufferEvent, Result, SiteDone, WsDone } from "../rpc/protocol.ts";
import { errorMessage, makeLog, monoMs, type Logger } from "../shared/util.ts";
import type { Migration } from "./schema.ts";
import { BufferStore, type NewEventRow, type NewOutcomeRow, type StoredEvent, type StoredOutcome } from "./store.ts";

export type BufferRefusal = "buffer_full" | "disk_full";

type WithoutStamp<T> = T extends unknown ? Omit<T, "seq" | "atMono" | "atWall"> : never;
/** An event as a producer gives it: the buffer numbers and stamps it. */
export type EventBody = Exclude<WithoutStamp<BufferEvent>, { kind: "gap" }>;
export type GapReason = Extract<BufferEvent, { kind: "gap" }>["reason"];
/** The outcomes kept until the engine's resultAck (spec §6.2). */
export type Outcome = Result | SiteDone | WsDone;

/** A write's fate once its batch is committed: the event's number (null
 *  for an outcome), or why it was not written. Never rejects. */
export type Durable = { ok: true; seq: number | null } | { ok: false; reason: BufferRefusal };
export type Appended = { ok: true; durable: Promise<Durable> } | { ok: false; reason: BufferRefusal };

export interface BufferAlarm {
  /** The threshold crossed (50, 80), or 100: full. */
  percent: number;
  /** What crossed it. */
  by: "bytes" | "age" | "disk";
  bytes: number;
  capBytes: number;
  oldestAgeMs: number;
  capAgeMs: number;
  freeDiskBytes: number;
}

export interface BufferCaps {
  bytes: number;
  ageMs: number;
  alarmPercents: readonly number[];
}

export interface BufferOptions {
  /** The database's directory, on the buffer volume. */
  dir: string;
  /** stateDir/buffer-id: a copy of the id for tools. */
  idFile: string;
  operatorVersion?: string;
  /** Gathering writes, at most this long (plan §4.14: ≤ 20 ms). */
  batchMs?: number;
  caps?: Partial<BufferCaps>;
  /** Full stays full until the buffer is below this share of both caps. */
  resumePercent?: number;
  /** Below this much free disk the buffer is full (`disk_full`); room again
   *  at twice as much. */
  minFreeBytes?: number;
  /** How often the caps are looked at (age grows without writes). */
  checkEveryMs?: number;
  /** The disk's free bytes at `dir` (statfs; tests replace it). */
  diskFree?: (dir: string) => number;
  now?: () => number;
  log?: Logger;
  /** Tests: another list of migrations. */
  migrations?: readonly Migration[];
  /** Tests: SQLite's own "database or disk is full" past this many pages. */
  maxPages?: number;
  /** The buffer stopped taking writes: the page must stop (spec §5, 2). */
  onFull?: (reason: BufferRefusal, alarm: BufferAlarm, detail: string) => void;
  /** Room again, the gap written: the page may start again (spec §5, 4). */
  onRoom?: (reason: BufferRefusal) => void;
  /** 50 % or 80 % of a cap crossed upwards. */
  onAlarm?: (alarm: BufferAlarm) => void;
  /** A batch is durable: its events may be streamed, its outcomes sent. */
  onCommitted?: (committed: { events: number; outcomes: string[] }) => void;
}

export const DEFAULT_CAPS: BufferCaps = { bytes: 2 * 1024 * 1024 * 1024, ageMs: 72 * 3600_000, alarmPercents: [50, 80] };
const DEFAULT_MIN_FREE = 256 * 1024 * 1024;
/** A batch this large is committed at the next turn, not after the batch
 *  time: what waits in memory stays small. */
const EARLY_BYTES = 4 * 1024 * 1024;
const EARLY_ITEMS = 2000;
/** Acknowledged events deleted per commit at most: a long backlog goes in
 *  steps, the event loop is not held for seconds. */
const DELETE_CHUNK = 5000;
/** A re-armed alarm needs the level this far below its threshold. */
const REARM_FACTOR = 0.9;
const EVENT_KINDS = new Set(["ws.open", "ws.in", "ws.close", "site.response"]);
const OUTCOME_TYPES = new Set(["result", "siteDone", "wsDone"]);

interface PendingEvent {
  type: "event";
  kind: string;
  /** The body's JSON, `{...}` — the stamp is put in front at commit. */
  body: string;
  atMono: number;
  atWall: number;
  bytes: number;
  resolve: (durable: Durable) => void;
  /** A gap mark: its "from" is the event before it, unless given. */
  gap?: { reason: GapReason; from: { seq: number | null; wall: number | null } | null };
}

interface PendingOutcome {
  type: "outcome";
  attemptId: number;
  outcomeType: string;
  json: string;
  atWall: number;
  bytes: number;
  resolve: (durable: Durable) => void;
}

type Pending = PendingEvent | PendingOutcome;

function defaultDiskFree(dir: string): number {
  const stats = statfsSync(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export class EventBuffer {
  readonly id: string;
  readonly dir: string;
  readonly #store: BufferStore;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #diskFree: (dir: string) => number;
  readonly #minFreeBytes: number;
  readonly #resumePercent: number;
  readonly #checkEveryMs: number;
  readonly #onFull: NonNullable<BufferOptions["onFull"]>;
  readonly #onRoom: NonNullable<BufferOptions["onRoom"]>;
  readonly #onAlarm: NonNullable<BufferOptions["onAlarm"]>;
  readonly #onCommitted: NonNullable<BufferOptions["onCommitted"]>;
  #batchMs: number;
  #caps: BufferCaps;
  #pending: Pending[] = [];
  #pendingBytes = 0;
  #pendingOutcomes = new Map<number, PendingOutcome>();
  #timer: NodeJS.Timeout | null = null;
  /** A commit is due at the next turn (a large batch). */
  #immediate = false;
  #checkTimer: NodeJS.Timeout | null = null;
  /** Stored, unacknowledged bytes and counts (the file may be larger). */
  #bytes: number;
  #events: number;
  #outcomes: number;
  #firstSeq: number | null;
  #oldestEventWall: number | null;
  #oldestOutcomeWall: number | null;
  /** The engine acknowledged up to here: deleted with the next commits. */
  #ackedUpTo = 0;
  #outcomeAcks = new Set<number>();
  #full: BufferRefusal | null = null;
  #fullDetail = "";
  #fullAlarm: BufferAlarm | null = null;
  /** The highest alarm threshold raised and not re-armed (0: none). */
  #alarmed = 0;
  #freeDisk = Number.POSITIVE_INFINITY;
  #commits = 0;
  #closed = false;

  constructor(options: BufferOptions) {
    this.dir = options.dir;
    this.#log = options.log ?? makeLog("buffer");
    this.#now = options.now ?? Date.now;
    this.#diskFree = options.diskFree ?? defaultDiskFree;
    this.#minFreeBytes = options.minFreeBytes ?? DEFAULT_MIN_FREE;
    this.#resumePercent = options.resumePercent ?? 90;
    this.#checkEveryMs = options.checkEveryMs ?? 1000;
    this.#onFull = options.onFull ?? (() => undefined);
    this.#onRoom = options.onRoom ?? (() => undefined);
    this.#onAlarm = options.onAlarm ?? (() => undefined);
    this.#onCommitted = options.onCommitted ?? (() => undefined);
    this.#batchMs = clampBatch(options.batchMs ?? 20);
    this.#caps = normalizeCaps({ ...DEFAULT_CAPS, ...options.caps });
    this.#store = new BufferStore({
      dir: options.dir,
      idFile: options.idFile,
      operatorVersion: options.operatorVersion ?? "dev",
      now: this.#now,
      ...(options.migrations ? { migrations: options.migrations } : {}),
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    });
    this.id = this.#store.id;
    const totals = this.#store.totals();
    this.#bytes = totals.bytes;
    this.#events = totals.events;
    this.#outcomes = totals.outcomes;
    this.#firstSeq = totals.firstSeq;
    this.#oldestEventWall = totals.oldestEventWall;
    this.#oldestOutcomeWall = totals.oldestOutcomeWall;
    this.#log("opened", { bufferId: this.id, schema: this.#store.schema.version, created: this.#store.schema.created, lastSeq: this.#store.lastSeq, events: this.#events, outcomes: this.#outcomes, bytes: this.#bytes });
  }

  /** The caps looked at now and every second from now on (the operator's
   *  handlers are in place by then). */
  start(): void {
    if (this.#checkTimer || this.#closed) return;
    this.check();
    this.#checkTimer = setInterval(() => this.check(), this.#checkEveryMs);
    this.#checkTimer.unref();
  }

  /** The engine's parameters (plan §4.14). */
  setParams(batchMs: number, caps: BufferCaps): void {
    this.#batchMs = clampBatch(batchMs);
    this.#caps = normalizeCaps(caps);
    this.check();
  }

  get caps(): BufferCaps {
    return this.#caps;
  }

  /** The last number given; 0 before the first event. */
  get lastSeq(): number {
    return this.#store.lastSeq;
  }

  /** Why the buffer takes no writes now, or null. A site request is not
   *  admitted while it is not null (plan §4.3). */
  refusal(): BufferRefusal | null {
    if (this.#closed) return "disk_full";
    return this.#full;
  }

  /** Why the buffer is full, as it was said when it filled up. */
  get fullness(): { reason: BufferRefusal; detail: string; alarm: BufferAlarm } | null {
    return this.#full === null || this.#fullAlarm === null ? null : { reason: this.#full, detail: this.#fullDetail, alarm: this.#fullAlarm };
  }

  /** What `state.buffer` says (spec §6.1), and more for tools and tests. */
  stats(): { bytes: number; oldestAgeMs: number; events: number; outcomes: number; pending: number; lastSeq: number; commits: number; full: BufferRefusal | null; freeDiskBytes: number } {
    return {
      bytes: this.#bytes,
      oldestAgeMs: this.#oldestAgeMs(),
      events: this.#events,
      outcomes: this.#outcomes,
      pending: this.#pending.length,
      lastSeq: this.#store.lastSeq,
      commits: this.#commits,
      full: this.#full,
      freeDiskBytes: this.#freeDisk,
    };
  }

  // ── the producers ──────────────────────────────────────────────────────

  /** An event of the stream, stamped now unless `at` says when. */
  append(event: EventBody, at?: { mono: number; wall: number }): Appended {
    if (!EVENT_KINDS.has(event.kind)) throw new Error(`not an event a producer appends: ${String(event.kind)}`);
    const body = JSON.stringify(event);
    return this.#accept({ type: "event", kind: event.kind, body, atMono: at?.mono ?? monoMs(), atWall: at?.wall ?? this.#now(), bytes: stampedBytes(body), resolve: () => undefined });
  }

  /** A gap mark: the stream broke after `from` (default: the event just
   *  before the mark) and the engine backfills it (plan §4.4, step 6). */
  markGap(reason: GapReason, from?: { seq: number | null; wall: number | null }): Appended {
    const body = JSON.stringify({ kind: "gap", fromSeq: from?.seq ?? null, fromWall: from?.wall ?? null, reason });
    return this.#accept({ type: "event", kind: "gap", body, atMono: monoMs(), atWall: this.#now(), bytes: stampedBytes(body), resolve: () => undefined, gap: { reason, from: from ?? null } });
  }

  /** An attempt's outcome, kept until the engine's resultAck. The first
   *  outcome of an attempt stands: a second one is not stored again. */
  putOutcome(outcome: Outcome): Appended {
    if (!OUTCOME_TYPES.has(outcome.type) || !Number.isSafeInteger(outcome.attemptId)) throw new Error("not an attempt's outcome");
    const pending = this.#pendingOutcomes.get(outcome.attemptId);
    if (pending) return { ok: true, durable: new Promise((resolve) => (pending.resolve = chain(pending.resolve, resolve))) };
    if (this.#closed) return { ok: false, reason: "disk_full" };
    try {
      if (this.#store.hasOutcome(outcome.attemptId)) return { ok: true, durable: Promise.resolve({ ok: true, seq: null }) };
    } catch (error) {
      this.#storageFailed(error, "read");
      return { ok: false, reason: "disk_full" };
    }
    const json = JSON.stringify(outcome);
    return this.#accept({ type: "outcome", attemptId: outcome.attemptId, outcomeType: outcome.type, json, atWall: this.#now(), bytes: utf8Bytes(json), resolve: () => undefined });
  }

  #accept(item: Pending): Appended {
    const refused = this.refusal();
    if (refused) return { ok: false, reason: refused };
    if (this.#bytes + this.#pendingBytes + item.bytes > this.#caps.bytes) {
      this.#enterFull("buffer_full", "bytes", `${item.bytes} more bytes would pass the cap of ${this.#caps.bytes}`);
      return { ok: false, reason: "buffer_full" };
    }
    const durable = new Promise<Durable>((resolve) => (item.resolve = resolve));
    this.#pending.push(item);
    this.#pendingBytes += item.bytes;
    if (item.type === "outcome") this.#pendingOutcomes.set(item.attemptId, item);
    this.#schedule();
    return { ok: true, durable };
  }

  // ── the engine ─────────────────────────────────────────────────────────

  /** Events in order after `afterSeq`, durable ones only (stream.ts). */
  readEvents(afterSeq: number, maxEvents: number, maxBytes: number): StoredEvent[] {
    if (this.#closed) return [];
    try {
      return this.#store.readEvents(afterSeq, maxEvents, maxBytes);
    } catch (error) {
      this.#storageFailed(error, "read");
      return [];
    }
  }

  /** Stored outcomes (of these attempts, or all), oldest first. */
  outcomes(attemptIds?: readonly number[]): StoredOutcome[] {
    if (this.#closed) return [];
    try {
      return this.#store.outcomes(attemptIds);
    } catch (error) {
      this.#storageFailed(error, "read");
      return [];
    }
  }

  /** The engine has the events up to this number in Postgres: they go with
   *  the next commit. Only the stream checks the engine's word (stream.ts). */
  acknowledge(uptoSeq: number): void {
    if (uptoSeq <= this.#ackedUpTo) return;
    this.#ackedUpTo = Math.min(uptoSeq, this.#store.lastSeq);
    this.#schedule();
  }

  /** The engine wrote this attempt's outcome (resultAck): it goes with the
   *  next commit. */
  acknowledgeOutcome(attemptId: number): void {
    this.#outcomeAcks.add(attemptId);
    this.#schedule();
  }

  /** Everything accepted so far is committed (or failed) when it settles. */
  async flush(): Promise<void> {
    this.#flush();
  }

  /** For tests and diagnostics: SQLite's own check of the file. */
  integrity(): string {
    return this.#store.integrity();
  }

  /** May the page start (plan §4.1)? Everything written so far is durable
   *  and there is room. */
  async ready(): Promise<{ ok: true } | { ok: false; reason: BufferRefusal; detail: string }> {
    if (this.#closed) return { ok: false, reason: "disk_full", detail: "the buffer is closed" };
    this.#flush();
    this.check();
    if (this.#full) return { ok: false, reason: this.#full, detail: this.#fullDetail };
    return { ok: true };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#checkTimer) clearInterval(this.#checkTimer);
    this.#checkTimer = null;
    this.#flush();
    this.#closed = true;
    for (const item of this.#pending.splice(0)) item.resolve({ ok: false, reason: "disk_full" });
    this.#store.close();
  }

  // ── the caps ───────────────────────────────────────────────────────────

  /** The caps and the disk, now: alarms, full, room again. */
  check(): void {
    if (this.#closed) return;
    try {
      this.#freeDisk = this.#diskFree(this.dir);
    } catch (error) {
      // Not knowing is not full: SQLite's own error says when it is.
      this.#freeDisk = Number.POSITIVE_INFINITY;
      this.#log("disk.unknown", { error: errorMessage(error) });
    }
    const level = this.#level();
    this.#raiseAlarms(level);
    if (this.#full === null) {
      if (level.percent >= 100) this.#enterFull("buffer_full", level.by, `${level.by === "age" ? `the oldest unacknowledged record is ${level.ageMs} ms old` : `${level.bytes} bytes are stored`}: the cap is reached`);
      else if (this.#freeDisk < this.#minFreeBytes) this.#enterFull("disk_full", "disk", `${this.#freeDisk} bytes free on the disk`);
      return;
    }
    if (level.percent < this.#resumePercent && this.#freeDisk >= 2 * this.#minFreeBytes) this.#tryRoom();
  }

  #level(): { percent: number; by: "bytes" | "age"; bytes: number; ageMs: number } {
    const bytes = this.#bytes + this.#pendingBytes;
    const ageMs = this.#oldestAgeMs();
    const byBytes = (bytes / this.#caps.bytes) * 100;
    const byAge = (ageMs / this.#caps.ageMs) * 100;
    return byAge > byBytes ? { percent: byAge, by: "age", bytes, ageMs } : { percent: byBytes, by: "bytes", bytes, ageMs };
  }

  #alarmOf(percent: number, by: BufferAlarm["by"]): BufferAlarm {
    return { percent, by, bytes: this.#bytes + this.#pendingBytes, capBytes: this.#caps.bytes, oldestAgeMs: this.#oldestAgeMs(), capAgeMs: this.#caps.ageMs, freeDiskBytes: Number.isFinite(this.#freeDisk) ? this.#freeDisk : -1 };
  }

  #raiseAlarms(level: { percent: number; by: "bytes" | "age" }): void {
    const thresholds = this.#caps.alarmPercents;
    // Re-armed once the level fell well below a threshold raised before.
    while (this.#alarmed > 0 && level.percent < this.#alarmed * REARM_FACTOR) {
      this.#alarmed = [...thresholds].reverse().find((threshold) => threshold < this.#alarmed) ?? 0;
    }
    const crossed = [...thresholds].reverse().find((threshold) => level.percent >= threshold && threshold > this.#alarmed);
    if (crossed === undefined) return;
    this.#alarmed = crossed;
    const alarm = this.#alarmOf(crossed, level.by);
    this.#log("alarm", { ...alarm });
    this.#notify("alarm", () => this.#onAlarm(alarm));
  }

  #oldestAgeMs(): number {
    const walls = [this.#oldestEventWall, this.#oldestOutcomeWall].filter((wall): wall is number => wall !== null);
    for (const item of this.#pending) walls.push(item.atWall);
    if (walls.length === 0) return 0;
    return Math.max(0, this.#now() - Math.min(...walls));
  }

  #enterFull(reason: BufferRefusal, by: BufferAlarm["by"], detail: string): void {
    if (this.#full !== null) return;
    this.#full = reason;
    this.#fullDetail = detail;
    const alarm = this.#alarmOf(100, by);
    this.#fullAlarm = alarm;
    this.#log("full", { reason, detail, ...alarm });
    this.#notify("full", () => this.#onFull(reason, alarm, detail));
  }

  /** Room again: the gap from the last saved event goes first; only when it
   *  is durable does the buffer take writes (and the page start) again. */
  #tryRoom(): void {
    const reason = this.#full;
    if (reason === null) return;
    // Whatever was accepted before it filled up is in before the gap.
    this.#flush();
    if (this.#full !== reason) return;
    const body = JSON.stringify({ kind: "gap", fromSeq: null, fromWall: null, reason });
    this.#pending.unshift({ type: "event", kind: "gap", body, atMono: monoMs(), atWall: this.#now(), bytes: stampedBytes(body), resolve: () => undefined, gap: { reason, from: null } });
    this.#pendingBytes += stampedBytes(body);
    if (!this.#flush()) return;
    this.#full = null;
    this.#fullDetail = "";
    this.#fullAlarm = null;
    this.#log("room", { reason, gapSeq: this.#store.lastSeq });
    this.#notify("room", () => this.#onRoom(reason));
  }

  // ── the writer ─────────────────────────────────────────────────────────

  #schedule(): void {
    if (this.#closed || this.#immediate) return;
    if (this.#pending.length >= EARLY_ITEMS || this.#pendingBytes >= EARLY_BYTES) {
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = null;
      this.#immediate = true;
      setImmediate(() => {
        this.#immediate = false;
        this.#flush();
      });
      return;
    }
    if (this.#timer) return;
    this.#timer = setTimeout(() => this.#flush(), this.#batchMs);
  }

  /** One commit: the batch, the acknowledged deletes; then the producers
   *  hear, and the engine gets what is durable. False: the commit failed. */
  #flush(): boolean {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#closed) return false;
    const items = this.#pending;
    const deleteTo = this.#ackedUpTo > 0 && this.#firstSeq !== null && this.#firstSeq <= this.#ackedUpTo ? Math.min(this.#ackedUpTo, this.#firstSeq + DELETE_CHUNK - 1) : null;
    const deleteOutcomes = [...this.#outcomeAcks];
    if (items.length === 0 && deleteTo === null && deleteOutcomes.length === 0) return true;
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#pendingOutcomes.clear();
    this.#outcomeAcks.clear();

    const events: NewEventRow[] = [];
    const outcomes: NewOutcomeRow[] = [];
    const settled: Array<{ item: Pending; seq: number | null }> = [];
    let seq = this.#store.lastSeq;
    let previousWall = this.#store.lastWall;
    for (const item of items) {
      if (item.type === "outcome") {
        outcomes.push({ attemptId: item.attemptId, atWall: item.atWall, type: item.outcomeType, json: item.json, bytes: item.bytes });
        settled.push({ item, seq: null });
        continue;
      }
      let body = item.body;
      if (item.gap && item.gap.from === null) {
        body = JSON.stringify({ kind: "gap", fromSeq: seq === 0 ? null : seq, fromWall: seq === 0 ? null : previousWall, reason: item.gap.reason });
      }
      seq += 1;
      const json = `{"seq":${seq},"atMono":${item.atMono},"atWall":${item.atWall},${body.slice(1)}`;
      events.push({ seq, atWall: item.atWall, kind: item.kind, json, bytes: utf8Bytes(json) });
      settled.push({ item, seq });
      previousWall = item.atWall;
    }

    let committed;
    try {
      committed = this.#store.commit({ events, outcomes, deleteEventsUpTo: deleteTo, deleteOutcomes });
    } catch (error) {
      for (const attemptId of deleteOutcomes) this.#outcomeAcks.add(attemptId);
      for (const { item } of settled) item.resolve({ ok: false, reason: "disk_full" });
      this.#storageFailed(error, "write");
      return false;
    }
    this.#commits += 1;
    const insertedOutcomes = new Set(committed.insertedOutcomes.map((outcome) => outcome.attemptId));
    this.#bytes += committed.addedBytes - committed.deletedBytes;
    this.#events += events.length - committed.deletedEvents;
    this.#outcomes += committed.insertedOutcomes.length - committed.deletedOutcomes;
    if (events.length > 0 && this.#firstSeq === null) {
      this.#firstSeq = events[0]!.seq;
      this.#oldestEventWall = events[0]!.atWall;
    }
    for (const { item, seq: given } of settled) item.resolve({ ok: true, seq: given });
    try {
      if (committed.deletedEvents > 0) {
        const first = this.#store.first();
        this.#firstSeq = first.seq;
        this.#oldestEventWall = first.atWall;
      }
      if (committed.insertedOutcomes.length > 0 || committed.deletedOutcomes > 0) this.#oldestOutcomeWall = this.#store.oldestOutcomeWall();
    } catch (error) {
      // Committed all the same; the file cannot be read now.
      this.#storageFailed(error, "read");
    }
    this.#notify("committed", () => this.#onCommitted({ events: events.length, outcomes: outcomes.filter((outcome) => insertedOutcomes.has(outcome.attemptId)).map((outcome) => outcome.json) }));
    // The alarms as soon as a batch crosses a threshold, not at the next check.
    this.#raiseAlarms(this.#level());
    // A long acknowledged backlog: the next step soon.
    if (this.#firstSeq !== null && this.#firstSeq <= this.#ackedUpTo) this.#schedule();
    // Room made by the engine's acks is seen at once, not at the next check.
    if (this.#full !== null && (committed.deletedEvents > 0 || committed.deletedOutcomes > 0)) queueMicrotask(() => this.check());
    return true;
  }

  /** The operator's handlers run inside the writer: a throw of theirs must
   *  not undo what was committed or stop the next batch. */
  #notify(what: string, handler: () => void): void {
    try {
      handler();
    } catch (error) {
      this.#log("handler.failed", { what, error: errorMessage(error) });
    }
  }

  /** The file could not be written (or read): a full disk, or worse. The
   *  page stops (`disk_full`); the next check tries again. */
  #storageFailed(error: unknown, what: "write" | "read"): void {
    const code = (error as { errcode?: unknown }).errcode;
    const detail = `the buffer could not ${what}: ${errorMessage(error)}${typeof code === "number" ? ` (SQLite ${code})` : ""}`;
    this.#log("storage.failed", { what, error: errorMessage(error), errcode: typeof code === "number" ? code : null });
    try {
      this.#store.reload();
    } catch {
      // the file says nothing more now
    }
    this.#enterFull("disk_full", "disk", detail);
  }
}

/** The bytes of the event's JSON once it is stamped (a number and two
 *  moments in front of its body). */
function stampedBytes(body: string): number {
  return utf8Bytes(body) + 64;
}

function chain(first: (durable: Durable) => void, second: (durable: Durable) => void): (durable: Durable) => void {
  return (durable) => {
    first(durable);
    second(durable);
  };
}

function clampBatch(ms: number): number {
  return Math.min(20, Math.max(1, Math.floor(ms)));
}

function normalizeCaps(caps: BufferCaps): BufferCaps {
  return {
    bytes: Math.max(1024, caps.bytes),
    ageMs: Math.max(1000, caps.ageMs),
    alarmPercents: [...new Set(caps.alarmPercents.filter((percent) => percent > 0 && percent < 100))].sort((a, b) => a - b),
  };
}
