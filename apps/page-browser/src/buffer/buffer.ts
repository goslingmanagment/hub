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
// The space acknowledged records leave is given back to the disk in bounded
// steps for as long as SQLite holds free pages (store.ts `reclaim`); a
// commit that failed (a full disk) is tried again with a growing pause, so
// an acknowledgement is never lost to one failed deletion.
//
// A buffer that cannot be opened — locked by another process, a failing
// disk, a corrupt file, a format newer than this operator — does not take
// the operator down: the buffer is `buffer_unavailable`, refuses every
// write, the page does not start, and the operator reports it. Locks and
// I/O failures are tried again with a growing pause; a corrupt or too new
// file is left exactly as it is, for the owner.
//
// Bodies (BodyRef in `result`, and in `site.response` with PR 7) are files
// of the buffer volume (bodies.ts): written as they arrive, sealed only
// whole, and named by the outcome stored after the seal; the outcome's
// bytes count its body's, so the caps do too. They go to the engine as
// binary frames before the JSON that names them (replay.ts), and their file
// goes with the outcome's resultAck.
//
// The site's socket (PR 10) keeps its connections here too
// (`changeConnection`, or in the commit of an event: schema.ts v3) —
// admitted, opened, gone — so an operator that starts again ends in the
// stream what the previous one left there.
//
// Hub attempts (PR 9) leave their steps here too (`markAttempt`: received,
// issued in the page, released to the network), each written before it is
// taken: a repeated `send` does nothing twice across restarts, and the
// engine's `recover` learns which requests never left (store.ts).

import { readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";

import type { BufferEvent, Result, SiteDone, WsDone } from "../rpc/protocol.ts";
import { errorMessage, makeLog, monoMs, type Logger } from "../shared/util.ts";
import { BodyFiles, type BodyReader, type BodyWriter } from "./bodies.ts";
import type { Migration } from "./schema.ts";
import {
  BufferStore,
  openFailure,
  type AttemptMark,
  type AttemptRecord,
  type AttemptStep,
  type Commit,
  type ConnectionChange,
  type NewEventRow,
  type StoredConnection,
  type NewOutcomeRow,
  type OpenCause,
  type StoredEvent,
  type StoredOutcome,
} from "./store.ts";

export type { AttemptRecord, AttemptStep, ConnectionChange, StoredConnection };

/** Why a write is refused: a cap (`buffer_full`), the disk (`disk_full`),
 *  or a buffer that could not be opened (`buffer_unavailable`). */
export type BufferRefusal = "buffer_full" | "disk_full" | "buffer_unavailable";
export type FullReason = Exclude<BufferRefusal, "buffer_unavailable">;

/** A buffer that could not be opened, and whether it is tried again. */
export interface BufferUnavailable {
  cause: OpenCause;
  recoverable: boolean;
  detail: string;
  attempts: number;
}

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
  /** Tests: an error to fail a commit with (store.ts). */
  commitFault?: (batch: Commit) => Error | null;
  /** Tests: an error for the first read after an open (store.ts). */
  totalsFault?: () => Error | null;
  /** Tests: an error for a read of a body's part (bodies.ts). */
  bodyReadFault?: (bodyId: string, part: number) => Error | null;
  /** The pauses before a failed open is tried again (locked, I/O). */
  openRetryMs?: readonly number[];
  /** The pauses before a failed commit is tried again. */
  retryMs?: readonly number[];
  /** Free pages given back per step, and the pause between steps. */
  reclaimPages?: number;
  reclaimEveryMs?: number;
  /** The buffer stopped taking writes: the page must stop (spec §5, 2). */
  onFull?: (reason: FullReason, alarm: BufferAlarm, detail: string) => void;
  /** Room again, the gap written: the page may start again (spec §5, 4). */
  onRoom?: (reason: FullReason) => void;
  /** The buffer could not be opened (at start, and again while it lasts
   *  only when its cause changes). */
  onUnavailable?: (unavailable: BufferUnavailable) => void;
  /** A buffer that could not be opened is open now. */
  onOpened?: () => void;
  /** 50 % or 80 % of a cap crossed upwards. */
  onAlarm?: (alarm: BufferAlarm) => void;
  /** A batch is durable: its events may be streamed, its outcomes sent
   *  (each after its body). */
  onCommitted?: (committed: { events: number; outcomes: CommittedOutcome[] }) => void;
}

/** An outcome stored by a commit: its JSON, and the body it names. */
export interface CommittedOutcome {
  attemptId: number;
  json: string;
  bodyId: string | null;
}

/** A body an outcome names, as `putOutcome` takes it. */
export interface OutcomeBody {
  bodyId: string;
  bytes: number;
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
const OPEN_RETRY_MS: readonly number[] = [1000, 2000, 5000, 10_000, 30_000, 60_000];
const RETRY_MS: readonly number[] = [100, 200, 500, 1000, 2000, 5000];
/** 1024 pages of 4 KiB: a few milliseconds of the event loop per step. */
const RECLAIM_PAGES = 1024;
const RECLAIM_EVERY_MS = 10;
/** Hub attempts are forgotten a day after their outcome's resultAck, and a
 *  week after they came whatever they are; looked at every 10 minutes. */
const ATTEMPT_ACKED_KEEP_MS = 24 * 3600_000;
const ATTEMPT_KEEP_MS = 7 * 24 * 3600_000;
const ATTEMPT_PURGE_EVERY_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
  connection?: ConnectionChange;
}

/** What a producer says of an event besides the event itself (PR 10). */
export interface AppendOptions {
  /** A change of the site socket's connection, in the same commit. */
  connection?: ConnectionChange;
}

interface PendingOutcome {
  type: "outcome";
  attemptId: number;
  outcomeType: string;
  json: string;
  atWall: number;
  bytes: number;
  body: OutcomeBody | null;
  resolve: (durable: Durable) => void;
}

interface PendingMark {
  type: "mark";
  mark: AttemptMark;
  bytes: number;
  resolve: (durable: Durable) => void;
}

interface PendingConnection {
  type: "connection";
  change: ConnectionChange;
  atWall: number;
  bytes: number;
  resolve: (durable: Durable) => void;
}

type Pending = PendingEvent | PendingOutcome | PendingMark | PendingConnection;

function defaultDiskFree(dir: string): number {
  const stats = statfsSync(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The id the buffer had when it was last open (its copy in stateDir), or
 *  "": what helloResult says while the buffer cannot be opened. */
function rememberedId(idFile: string): string {
  try {
    const id = readFileSync(idFile, "utf8").trim();
    return UUID.test(id) ? id : "";
  } catch {
    return "";
  }
}

function pause(ladder: readonly number[], index: number): number {
  return ladder[Math.min(index, ladder.length - 1)] ?? 1000;
}

export class EventBuffer {
  readonly dir: string;
  readonly #options: BufferOptions;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #diskFree: (dir: string) => number;
  readonly #minFreeBytes: number;
  readonly #resumePercent: number;
  readonly #checkEveryMs: number;
  readonly #openRetryMs: readonly number[];
  readonly #retryMs: readonly number[];
  readonly #reclaimPages: number;
  readonly #reclaimEveryMs: number;
  readonly #onFull: NonNullable<BufferOptions["onFull"]>;
  readonly #onRoom: NonNullable<BufferOptions["onRoom"]>;
  readonly #onAlarm: NonNullable<BufferOptions["onAlarm"]>;
  readonly #onCommitted: NonNullable<BufferOptions["onCommitted"]>;
  readonly #onUnavailable: NonNullable<BufferOptions["onUnavailable"]>;
  readonly #onOpened: NonNullable<BufferOptions["onOpened"]>;
  /** Null while the buffer cannot be opened. */
  #store: BufferStore | null = null;
  /** The bodies' files; null while the buffer cannot be opened. */
  #bodies: BodyFiles | null = null;
  /** Steps of Hub attempts not committed yet. */
  #pendingMarks = new Map<number, AttemptStep[]>();

  #lastPurge = 0;
  #purgeDue = false;
  #unavailable: BufferUnavailable | null = null;
  #knownId: string;
  #started = false;
  #batchMs: number;
  #caps: BufferCaps;
  #pending: Pending[] = [];
  #pendingBytes = 0;
  #pendingOutcomes = new Map<number, PendingOutcome>();
  #timer: NodeJS.Timeout | null = null;
  /** A commit is due at the next turn (a large batch). */
  #immediate = false;
  #checkTimer: NodeJS.Timeout | null = null;
  #openTimer: NodeJS.Timeout | null = null;
  /** A failed commit tried again, with a growing pause. */
  #retryTimer: NodeJS.Timeout | null = null;
  #retries = 0;
  /** Space given back to the disk, step by step. */
  #reclaimTimer: NodeJS.Timeout | null = null;
  #reclaimFailures = 0;
  /** Commits since the WAL was last truncated. */
  #walDirty = false;
  /** Stored, unacknowledged bytes and counts (the file may be larger). */
  #bytes = 0;
  #events = 0;
  #outcomes = 0;
  #firstSeq: number | null = null;
  #oldestEventWall: number | null = null;
  #oldestOutcomeWall: number | null = null;
  /** The engine acknowledged up to here: deleted with the next commits. */
  #ackedUpTo = 0;
  #outcomeAcks = new Set<number>();
  #full: FullReason | null = null;
  #fullDetail = "";
  #fullAlarm: BufferAlarm | null = null;
  /** The highest alarm threshold raised and not re-armed (0: none). */
  #alarmed = 0;
  #freeDisk = Number.POSITIVE_INFINITY;
  #commits = 0;
  #closed = false;

  constructor(options: BufferOptions) {
    this.dir = options.dir;
    this.#options = options;
    this.#log = options.log ?? makeLog("buffer");
    this.#now = options.now ?? Date.now;
    this.#diskFree = options.diskFree ?? defaultDiskFree;
    this.#minFreeBytes = options.minFreeBytes ?? DEFAULT_MIN_FREE;
    this.#resumePercent = options.resumePercent ?? 90;
    this.#checkEveryMs = options.checkEveryMs ?? 1000;
    this.#openRetryMs = options.openRetryMs ?? OPEN_RETRY_MS;
    this.#retryMs = options.retryMs ?? RETRY_MS;
    this.#reclaimPages = options.reclaimPages ?? RECLAIM_PAGES;
    this.#reclaimEveryMs = options.reclaimEveryMs ?? RECLAIM_EVERY_MS;
    this.#onFull = options.onFull ?? (() => undefined);
    this.#onRoom = options.onRoom ?? (() => undefined);
    this.#onAlarm = options.onAlarm ?? (() => undefined);
    this.#onCommitted = options.onCommitted ?? (() => undefined);
    this.#onUnavailable = options.onUnavailable ?? (() => undefined);
    this.#onOpened = options.onOpened ?? (() => undefined);
    this.#batchMs = clampBatch(options.batchMs ?? 20);
    this.#caps = normalizeCaps({ ...DEFAULT_CAPS, ...options.caps });
    this.#knownId = rememberedId(options.idFile);
    this.#open();
  }

  /** The caps looked at now and every second from now on, a buffer that
   *  could not be opened reported (the operator's handlers are in place by
   *  then). */
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#checkTimer = setInterval(() => this.check(), this.#checkEveryMs);
    this.#checkTimer.unref();
    const unavailable = this.#unavailable;
    if (unavailable) {
      this.#notify("unavailable", () => this.#onUnavailable({ ...unavailable }));
      this.#scheduleOpen();
      return;
    }
    this.check();
    this.#maintain();
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

  /** The buffer's id; while it cannot be opened, the one it had when it was
   *  last open ("" if none is known). */
  get id(): string {
    return this.#store?.id ?? this.#knownId;
  }

  /** The last number given; 0 before the first event. */
  get lastSeq(): number {
    return this.#store?.lastSeq ?? 0;
  }

  /** The wall time of the last event given; null before the first. */
  get lastWall(): number | null {
    return this.#store?.lastWall ?? null;
  }

  /** Why the buffer cannot be opened, or null. */
  get unavailable(): BufferUnavailable | null {
    return this.#unavailable ? { ...this.#unavailable } : null;
  }

  /** Why the buffer takes no writes now, or null. A site request is not
   *  admitted while it is not null (plan §4.3). */
  refusal(): BufferRefusal | null {
    if (this.#closed || this.#store === null) return "buffer_unavailable";
    return this.#full;
  }

  /** Why the buffer is full, as it was said when it filled up. */
  get fullness(): { reason: FullReason; detail: string; alarm: BufferAlarm } | null {
    return this.#full === null || this.#fullAlarm === null ? null : { reason: this.#full, detail: this.#fullDetail, alarm: this.#fullAlarm };
  }

  /** What `state.buffer` says (spec §6.1), and more for tools and tests. */
  stats(): { bytes: number; oldestAgeMs: number; events: number; outcomes: number; pending: number; lastSeq: number; commits: number; full: FullReason | null; unavailable: OpenCause | null; freeDiskBytes: number } {
    return {
      bytes: this.#bytes,
      oldestAgeMs: this.#oldestAgeMs(),
      events: this.#events,
      outcomes: this.#outcomes,
      pending: this.#pending.length,
      lastSeq: this.lastSeq,
      commits: this.#commits,
      full: this.#full,
      unavailable: this.#unavailable?.cause ?? null,
      freeDiskBytes: this.#freeDisk,
    };
  }

  // ── opening ────────────────────────────────────────────────────────────

  #open(): boolean {
    const options = this.#options;
    let opened: BufferStore | null = null;
    try {
      const store = new BufferStore({
        dir: options.dir,
        idFile: options.idFile,
        operatorVersion: options.operatorVersion ?? "dev",
        now: this.#now,
        ...(options.migrations ? { migrations: options.migrations } : {}),
        ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
        ...(options.commitFault ? { commitFault: options.commitFault } : {}),
        ...(options.totalsFault ? { totalsFault: options.totalsFault } : {}),
      });
      opened = store;
      const totals = store.totals();
      this.#knownId = store.id;
      this.#unavailable = null;
      this.#bytes = totals.bytes;
      this.#events = totals.events;
      this.#outcomes = totals.outcomes;
      this.#firstSeq = totals.firstSeq;
      this.#oldestEventWall = totals.oldestEventWall;
      this.#oldestOutcomeWall = totals.oldestOutcomeWall;
      this.#walDirty = true;
      // What a crash left between a body's seal and its outcome's commit, or
      // between a deletion and its file, goes now.
      const bodies = new BodyFiles(join(options.dir, "bodies"), options.bodyReadFault);
      const swept = bodies.sweep(new Set(store.bodyIds()));
      this.#log("opened", { bufferId: store.id, schema: store.schema.version, created: store.schema.created, lastSeq: store.lastSeq, events: this.#events, outcomes: this.#outcomes, bytes: this.#bytes, bodiesSwept: swept });
      this.#store = store;
      this.#bodies = bodies;
      opened = null;
      return true;
    } catch (error) {
      // An open that failed after the file was opened: its connection holds
      // the lock and would refuse every retry — it goes first.
      try {
        opened?.close();
      } catch {
        // closing is all that is left to try
      }
      const { cause, recoverable } = openFailure(error);
      const code = (error as { errcode?: unknown }).errcode;
      const detail = `the buffer could not be opened: ${errorMessage(error)}${typeof code === "number" ? ` (SQLite ${code})` : ""}`;
      const attempts = (this.#unavailable?.attempts ?? 0) + 1;
      const changed = this.#unavailable?.cause !== cause;
      this.#unavailable = { cause, recoverable, detail, attempts };
      // Logged on the first failure and whenever its cause changes.
      if (changed) this.#log("unavailable", { cause, recoverable, detail, attempts });
      if (changed && this.#started) this.#notify("unavailable", () => this.#onUnavailable({ cause, recoverable, detail, attempts }));
      return false;
    }
  }

  /** A lock or an I/O failure may pass: the open is tried again, with a
   *  growing pause. Nothing is ever done to the file but opening it. */
  #scheduleOpen(): void {
    const unavailable = this.#unavailable;
    if (this.#closed || this.#openTimer || !unavailable?.recoverable) return;
    this.#openTimer = setTimeout(() => {
      this.#openTimer = null;
      if (this.#closed) return;
      if (!this.#open()) {
        this.#scheduleOpen();
        return;
      }
      this.check();
      this.#maintain();
      this.#notify("opened", () => this.#onOpened());
    }, pause(this.#openRetryMs, unavailable.attempts - 1));
    this.#openTimer.unref();
  }

  // ── the producers ──────────────────────────────────────────────────────

  /** An event of the stream, stamped now unless `at` says when. */
  append(event: EventBody, at?: { mono: number; wall: number }, options: AppendOptions = {}): Appended {
    if (!EVENT_KINDS.has(event.kind)) throw new Error(`not an event a producer appends: ${String(event.kind)}`);
    const body = JSON.stringify(event);
    const item: PendingEvent = { type: "event", kind: event.kind, body, atMono: at?.mono ?? monoMs(), atWall: at?.wall ?? this.#now(), bytes: stampedBytes(body), resolve: () => undefined };
    if (options.connection !== undefined) item.connection = options.connection;
    return this.#accept(item);
  }

  /** A change of the site socket's connection on its own (admitted, tied),
   *  durable when its promise says so. */
  changeConnection(change: ConnectionChange): Appended {
    return this.#accept({ type: "connection", change, atWall: this.#now(), bytes: 0, resolve: () => undefined });
  }

  /** Every connection kept (committed), oldest first. */
  connections(): StoredConnection[] {
    const store = this.#store;
    if (this.#closed || store === null) return [];
    try {
      return store.connections();
    } catch (error) {
      this.#storageFailed(error, "read");
      return [];
    }
  }

  /** A gap mark: the stream broke after `from` (default: the event just
   *  before the mark) and the engine backfills it (plan §4.4, step 6). */
  markGap(reason: GapReason, from?: { seq: number | null; wall: number | null }): Appended {
    const body = JSON.stringify({ kind: "gap", fromSeq: from?.seq ?? null, fromWall: from?.wall ?? null, reason });
    return this.#accept({ type: "event", kind: "gap", body, atMono: monoMs(), atWall: this.#now(), bytes: stampedBytes(body), resolve: () => undefined, gap: { reason, from: from ?? null } });
  }

  /** An attempt's outcome, kept until the engine's resultAck. The first
   *  outcome of an attempt stands: a second one is not stored again. `body`:
   *  the sealed body it names (bodies.ts) — its bytes count in the caps; the
   *  caller removes its file when the outcome is not stored. */
  putOutcome(outcome: Outcome, body: OutcomeBody | null = null): Appended {
    if (!OUTCOME_TYPES.has(outcome.type) || !Number.isSafeInteger(outcome.attemptId)) throw new Error("not an attempt's outcome");
    const pending = this.#pendingOutcomes.get(outcome.attemptId);
    if (pending) return { ok: true, durable: new Promise((resolve) => (pending.resolve = chain(pending.resolve, resolve))) };
    const store = this.#store;
    if (this.#closed || store === null) return { ok: false, reason: "buffer_unavailable" };
    try {
      if (store.hasOutcome(outcome.attemptId)) return { ok: true, durable: Promise.resolve({ ok: true, seq: null }) };
    } catch (error) {
      this.#storageFailed(error, "read");
      return { ok: false, reason: "disk_full" };
    }
    const json = JSON.stringify(outcome);
    return this.#accept({ type: "outcome", attemptId: outcome.attemptId, outcomeType: outcome.type, json, atWall: this.#now(), bytes: utf8Bytes(json) + (body?.bytes ?? 0), body, resolve: () => undefined });
  }

  /** A step of a Hub attempt, durable before the step is taken (store.ts):
   *  received, issued in the page, released to the network. Refused like
   *  any write when the buffer takes none. */
  markAttempt(attemptId: number, step: AttemptStep): Appended {
    if (!Number.isSafeInteger(attemptId)) throw new Error("not an attempt id");
    const appended = this.#accept({ type: "mark", mark: { attemptId, atWall: this.#now(), step }, bytes: 0, resolve: () => undefined });
    if (appended.ok) this.#pendingMarks.set(attemptId, [...(this.#pendingMarks.get(attemptId) ?? []), step]);
    return appended;
  }

  /** What the buffer knows of a Hub attempt — its steps, committed or not,
   *  and whether its outcome is kept — or null when nothing. */
  attempt(attemptId: number): (AttemptRecord & { outcome: boolean }) | null {
    const store = this.#store;
    if (this.#closed || store === null) return null;
    let stored: AttemptRecord | null;
    let outcome: boolean;
    try {
      stored = store.attempt(attemptId);
      outcome = this.#pendingOutcomes.has(attemptId) || store.hasOutcome(attemptId);
    } catch (error) {
      this.#storageFailed(error, "read");
      return null;
    }
    const steps = this.#pendingMarks.get(attemptId) ?? [];
    if (stored === null && steps.length === 0 && !outcome) return null;
    return {
      issued: (stored?.issued ?? false) || steps.some((step) => step !== "received"),
      released: (stored?.released ?? false) || steps.includes("released"),
      acked: stored?.acked ?? false,
      outcome,
    };
  }

  /** A new body's file (bodies.ts), or null while the buffer cannot be
   *  opened or its directory written. */
  beginBody(): BodyWriter | null {
    const bodies = this.#bodies;
    if (this.#closed || bodies === null) return null;
    try {
      return bodies.begin();
    } catch (error) {
      this.#log("body.unwritable", { error: errorMessage(error) });
      return null;
    }
  }

  /** A stored body, open for one transmission (bodies.ts), or null when it
   *  is not there. Other failures throw. */
  openBody(bodyId: string): BodyReader | null {
    return this.#bodies?.open(bodyId) ?? null;
  }

  /** The order number of the last outcome stored (0: none): what a
   *  delivery round goes up to (replay.ts). */
  get lastOutcomeSeq(): number {
    return this.#store?.lastOutcomeSeq ?? 0;
  }

  /** Stored outcomes after `afterSeq` and up to `uptoSeq`, in the order
   *  they were stored, a page at a time (replay.ts). */
  outcomesBySeq(afterSeq: number, uptoSeq: number, maxCount: number, maxBytes: number): StoredOutcome[] {
    const store = this.#store;
    if (this.#closed || store === null) return [];
    try {
      return store.outcomesBySeq(afterSeq, uptoSeq, maxCount, maxBytes);
    } catch (error) {
      this.#storageFailed(error, "read");
      return [];
    }
  }

  /** A stored body's size, or null when it is not there. */
  bodySize(bodyId: string): number | null {
    return this.#bodies?.size(bodyId) ?? null;
  }

  /** Part `part` of a stored body, or null when it is not there. */
  readBody(bodyId: string, part: number, partBytes: number): Buffer | null {
    return this.#bodies?.read(bodyId, part, partBytes) ?? null;
  }

  /** A sealed body nothing names any more (its outcome was not stored). */
  removeBody(bodyId: string): void {
    try {
      this.#bodies?.remove(bodyId);
    } catch (error) {
      this.#log("body.remove_failed", { error: errorMessage(error) });
    }
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
    const store = this.#store;
    if (this.#closed || store === null) return [];
    try {
      return store.readEvents(afterSeq, maxEvents, maxBytes);
    } catch (error) {
      this.#storageFailed(error, "read");
      return [];
    }
  }

  /** The stored outcomes of these attempts. */
  outcomes(attemptIds: readonly number[]): StoredOutcome[] {
    const store = this.#store;
    if (this.#closed || store === null) return [];
    try {
      return store.outcomes(attemptIds);
    } catch (error) {
      this.#storageFailed(error, "read");
      return [];
    }
  }

  /** Stored outcomes after this attempt id, a page at a time (replay.ts). */
  outcomePage(afterAttemptId: number, maxCount: number, maxBytes: number): StoredOutcome[] {
    const store = this.#store;
    if (this.#closed || store === null) return [];
    try {
      return store.outcomePage(afterAttemptId, maxCount, maxBytes);
    } catch (error) {
      this.#storageFailed(error, "read");
      return [];
    }
  }

  /** The engine has the events up to this number in Postgres: they go with
   *  the next commit. Only the stream checks the engine's word (stream.ts). */
  acknowledge(uptoSeq: number): void {
    if (this.#store === null || uptoSeq <= this.#ackedUpTo) return;
    this.#ackedUpTo = Math.min(uptoSeq, this.#store.lastSeq);
    this.#schedule();
  }

  /** The engine wrote this attempt's outcome (resultAck): it goes with the
   *  next commit. */
  acknowledgeOutcome(attemptId: number): void {
    if (this.#store === null) return;
    this.#outcomeAcks.add(attemptId);
    this.#schedule();
  }

  /** Everything accepted so far is committed (or failed) when it settles. */
  async flush(): Promise<void> {
    this.#flush();
  }

  /** For tests and diagnostics: SQLite's own check of the file. */
  integrity(): string {
    return this.#store?.integrity() ?? "unavailable";
  }

  /** May the page start (plan §4.1)? The buffer is open, everything
   *  written so far is durable, and there is room. */
  async ready(): Promise<{ ok: true } | { ok: false; reason: BufferRefusal; detail: string }> {
    if (this.#closed) return { ok: false, reason: "buffer_unavailable", detail: "the buffer is closed" };
    if (this.#unavailable) return { ok: false, reason: "buffer_unavailable", detail: this.#unavailable.detail };
    this.#flush();
    this.check();
    if (this.#full) return { ok: false, reason: this.#full, detail: this.#fullDetail };
    return { ok: true };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    for (const timer of [this.#checkTimer, this.#openTimer, this.#reclaimTimer]) if (timer) clearInterval(timer);
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#checkTimer = this.#openTimer = this.#reclaimTimer = this.#retryTimer = null;
    this.#flush();
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    for (const item of this.#pending.splice(0)) item.resolve({ ok: false, reason: "buffer_unavailable" });
    this.#store?.close();
  }

  // ── the caps ───────────────────────────────────────────────────────────

  /** The caps and the disk, now: alarms, full, room again. */
  check(): void {
    const store = this.#store;
    if (this.#closed || store === null) return;
    try {
      this.#freeDisk = this.#diskFree(this.dir);
    } catch (error) {
      // Not knowing is not full: SQLite's own error says when it is.
      this.#freeDisk = Number.POSITIVE_INFINITY;
      this.#log("disk.unknown", { error: errorMessage(error) });
    }
    // Space SQLite holds and the disk could have: given back now (a delete
    // whose reclaim was cut short, a file from before this operator), and
    // the WAL truncated while the buffer is full.
    try {
      if (store.freePages() > 0 || (this.#full !== null && this.#walDirty)) this.#maintain();
    } catch (error) {
      this.#log("reclaim.unknown", { error: errorMessage(error) });
    }
    if (this.#now() - this.#lastPurge >= ATTEMPT_PURGE_EVERY_MS && !this.#purgeDue) {
      this.#purgeDue = true;
      this.#schedule();
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
    // Marks of Hub attempts and connection changes are no record of their
    // own: they do not age.
    for (const item of this.#pending) if (item.type !== "mark" && item.type !== "connection") walls.push(item.atWall);
    if (walls.length === 0) return 0;
    return Math.max(0, this.#now() - Math.min(...walls));
  }

  #enterFull(reason: FullReason, by: BufferAlarm["by"], detail: string): void {
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
    this.#log("room", { reason, gapSeq: this.lastSeq });
    this.#notify("room", () => this.#onRoom(reason));
  }

  // ── giving space back ──────────────────────────────────────────────────

  /** Free pages out of the file and the WAL truncated, one bounded step at
   *  a time, with a pause between steps: for as long as free pages remain,
   *  whether or not anything is deleted meanwhile. */
  #maintain(): void {
    if (this.#closed || this.#store === null || this.#reclaimTimer) return;
    this.#reclaimTimer = setTimeout(() => this.#reclaimStep(), this.#reclaimFailures === 0 ? this.#reclaimEveryMs : pause(this.#retryMs, this.#reclaimFailures - 1));
    this.#reclaimTimer.unref();
  }

  #reclaimStep(): void {
    this.#reclaimTimer = null;
    const store = this.#store;
    if (this.#closed || store === null) return;
    let left: number;
    try {
      left = store.reclaim(this.#reclaimPages);
    } catch (error) {
      // A disk too full for even this: tried again after a growing pause.
      this.#reclaimFailures += 1;
      this.#log("reclaim.failed", { error: errorMessage(error), failures: this.#reclaimFailures });
      this.#maintain();
      return;
    }
    this.#reclaimFailures = 0;
    this.#walDirty = false;
    if (left > 0) this.#maintain();
    // The disk may have room now.
    if (this.#full !== null) this.check();
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

  /** Acknowledged events or outcomes still to delete. */
  #deletionsPending(): boolean {
    return (this.#firstSeq !== null && this.#ackedUpTo >= this.#firstSeq) || this.#outcomeAcks.size > 0;
  }

  /** A failed commit — and the deletions it carried — tried again after a
   *  growing pause, whatever the caps say and whether or not the page runs:
   *  an acknowledgement is not lost to one failure. */
  #retryLater(): void {
    if (this.#closed || this.#retryTimer || !this.#deletionsPending()) return;
    const delay = pause(this.#retryMs, this.#retries);
    this.#retries += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#flush();
    }, delay);
    this.#retryTimer.unref();
  }

  /** One commit: the batch, the acknowledged deletes; then the producers
   *  hear, and the engine gets what is durable. False: the commit failed. */
  #flush(): boolean {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const store = this.#store;
    if (this.#closed || store === null) return false;
    const items = this.#pending;
    const deleteTo = this.#ackedUpTo > 0 && this.#firstSeq !== null && this.#firstSeq <= this.#ackedUpTo ? Math.min(this.#ackedUpTo, this.#firstSeq + DELETE_CHUNK - 1) : null;
    const deleteOutcomes = [...this.#outcomeAcks];
    const purge = this.#purgeDue ? { ackedBefore: this.#now() - ATTEMPT_ACKED_KEEP_MS, before: this.#now() - ATTEMPT_KEEP_MS } : null;
    if (items.length === 0 && deleteTo === null && deleteOutcomes.length === 0 && purge === null) return true;
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#pendingOutcomes.clear();
    this.#outcomeAcks.clear();
    // Marks that fail with their commit were never written: their producers
    // hear so (`durable`), and nothing here remembers them.
    this.#pendingMarks = new Map();
    this.#purgeDue = false;

    const events: NewEventRow[] = [];
    const outcomes: NewOutcomeRow[] = [];
    const marks: AttemptMark[] = [];
    const connections: NonNullable<Commit["connections"]> = [];
    const settled: Array<{ item: Pending; seq: number | null }> = [];
    let seq = store.lastSeq;
    let previousWall = store.lastWall;
    for (const item of items) {
      if (item.type === "outcome") {
        outcomes.push({ attemptId: item.attemptId, atWall: item.atWall, type: item.outcomeType, json: item.json, bytes: item.bytes, bodyId: item.body?.bodyId ?? null, bodyBytes: item.body?.bytes ?? null });
        settled.push({ item, seq: null });
        continue;
      }
      if (item.type === "mark") {
        marks.push(item.mark);
        settled.push({ item, seq: null });
        continue;
      }
      if (item.type === "connection") {
        connections.push({ ...item.change, atWall: item.atWall });
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
      if (item.connection) connections.push({ ...item.connection, atWall: item.atWall });
      settled.push({ item, seq });
      previousWall = item.atWall;
    }

    let committed;
    try {
      committed = store.commit({ events, outcomes, marks, connections, deleteEventsUpTo: deleteTo, deleteOutcomes, purgeAttempts: purge });
    } catch (error) {
      for (const attemptId of deleteOutcomes) this.#outcomeAcks.add(attemptId);
      if (purge !== null) this.#purgeDue = true;
      for (const { item } of settled) item.resolve({ ok: false, reason: "disk_full" });
      this.#storageFailed(error, "write");
      this.#retryLater();
      return false;
    }
    if (purge !== null) this.#lastPurge = this.#now();
    // The bodies of acknowledged outcomes: their rows are gone, their files
    // go now (a crash in between leaves them to the next open's sweep).
    for (const bodyId of committed.deletedBodies) this.removeBody(bodyId);
    this.#commits += 1;
    this.#retries = 0;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#walDirty = true;
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
        const first = store.first();
        this.#firstSeq = first.seq;
        this.#oldestEventWall = first.atWall;
      }
      if (committed.insertedOutcomes.length > 0 || committed.deletedOutcomes > 0) this.#oldestOutcomeWall = store.oldestOutcomeWall();
    } catch (error) {
      // Committed all the same; the file cannot be read now.
      this.#storageFailed(error, "read");
    }
    this.#notify("committed", () =>
      this.#onCommitted({
        events: events.length,
        outcomes: outcomes.filter((outcome) => insertedOutcomes.has(outcome.attemptId)).map((outcome) => ({ attemptId: outcome.attemptId, json: outcome.json, bodyId: outcome.bodyId })),
      }),
    );
    // The alarms as soon as a batch crosses a threshold, not at the next check.
    this.#raiseAlarms(this.#level());
    const deleted = committed.deletedEvents > 0 || committed.deletedOutcomes > 0;
    // The space of what was deleted goes back to the disk, step by step.
    if (deleted) this.#maintain();
    // A long acknowledged backlog: the next step soon.
    if (this.#firstSeq !== null && this.#firstSeq <= this.#ackedUpTo) this.#schedule();
    // Room made by the engine's acks is seen at once, not at the next check.
    if (this.#full !== null && deleted) queueMicrotask(() => this.check());
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
      this.#store?.reload();
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
