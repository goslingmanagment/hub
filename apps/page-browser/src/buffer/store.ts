// The buffer's database (plan §4.4): one SQLite file on the buffer volume,
// through Node's own `node:sqlite` (no dependency; in Node 22 it is marked
// experimental — the operator runs with --no-warnings).
//
// - WAL with synchronous=FULL: every commit is fsync'ed before it returns,
//   so what a commit confirmed survives a crash of the process and of the
//   machine; a commit cut short leaves nothing of itself (SQLite's own
//   atomicity), never a torn row. NORMAL would skip the fsync of each commit
//   in WAL mode and could lose the last confirmed batch on a power loss.
// - locking_mode=EXCLUSIVE: the operator holds the file while it runs; a
//   second operator on the same volume cannot open it (it would give the
//   same numbers twice). The wal-index lives in the process, no -shm file.
// - auto_vacuum=INCREMENTAL: acknowledged rows are deleted in chunks and
//   their pages given back a little at a time (plan §4.4, step 4) by
//   `reclaim`, which the buffer runs in bounded steps for as long as free
//   pages remain — and truncates the WAL after each, so the disk gets the
//   space back, not only SQLite.
// - journal_size_limit: the WAL file shrinks back after a checkpoint.
// - The open does not wait for a lock (busy_timeout 0): a buffer another
//   process holds is reported at once and opened again later, not waited
//   for on the event loop.
//
// Synchronous on purpose: the buffer's writer batches (≤ 20 ms, plan §4.14)
// so the event loop waits for one fsync per batch, not per event. If the
// stand measures that as too long, the store moves into a worker thread
// without the producers noticing (buffer.ts's API is already asynchronous).

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { BufferVersionError, MIGRATIONS, migrate, ROW_FORMAT, type Migration, type SchemaState } from "./schema.ts";

export const DB_FILE = "buffer.sqlite";

export interface StoredEvent {
  seq: number;
  /** The event as the protocol sends it. */
  json: string;
  bytes: number;
}

export interface StoredOutcome {
  attemptId: number;
  json: string;
  /** The row's bytes: its JSON and its body's. */
  bytes: number;
  /** The body the outcome names (bodies.ts), or null. */
  bodyId: string | null;
  bodyBytes: number;
  /** The order it was stored in (schema.ts, v2). */
  seq: number;
}

export interface NewEventRow {
  seq: number;
  atWall: number;
  kind: string;
  json: string;
  bytes: number;
}

/** A change of a site socket's connection (schema.ts, v3). */
export type ConnectionChange = { connectionId: string; admitted: { attemptId: number } } | { connectionId: string; opened: true } | { connectionId: string; gone: true };

/** A site socket's connection as the buffer has it (v3). */
export interface StoredConnection {
  connectionId: string;
  attemptId: number;
  /** Its ws.open is in the stream. */
  opened: boolean;
}

export interface NewOutcomeRow {
  attemptId: number;
  atWall: number;
  type: string;
  json: string;
  /** Its JSON's bytes and its body's: the caps count both. */
  bytes: number;
  bodyId: string | null;
  bodyBytes: number | null;
}

/** A step of a Hub attempt, written before it is taken (schema.ts, v2). */
export type AttemptStep = "received" | "issued" | "released";

export interface AttemptMark {
  attemptId: number;
  atWall: number;
  step: AttemptStep;
}

/** What the buffer knows of a Hub attempt. */
export interface AttemptRecord {
  issued: boolean;
  released: boolean;
  /** Its outcome's resultAck came. */
  acked: boolean;
}

export interface Commit {
  events: NewEventRow[];
  outcomes: NewOutcomeRow[];
  /** Steps of Hub attempts (schema.ts, v2). */
  marks?: AttemptMark[];
  /** Changes of the site socket's connections, in order (v3). */
  connections?: Array<ConnectionChange & { atWall: number }>;
  /** Delete the events up to this number (acknowledged), or nothing. */
  deleteEventsUpTo: number | null;
  /** Delete these outcomes (their resultAck came). */
  deleteOutcomes: number[];
  /** Forget attempts acknowledged before `ackedBefore`, and any without an
   *  outcome from before `before` (wall clock). */
  purgeAttempts?: { ackedBefore: number; before: number } | null;
}

export interface Committed {
  /** Outcomes stored now (an attempt's outcome already stored stays). */
  insertedOutcomes: NewOutcomeRow[];
  addedBytes: number;
  deletedBytes: number;
  deletedEvents: number;
  deletedOutcomes: number;
  /** The bodies of the deleted outcomes: their files go now. */
  deletedBodies: string[];
}

export interface Totals {
  bytes: number;
  events: number;
  outcomes: number;
  /** The first event still stored, and its moment. */
  firstSeq: number | null;
  oldestEventWall: number | null;
  oldestOutcomeWall: number | null;
}

/** Why a buffer could not be opened (buffer.ts reports it). `locked` and
 *  `io` may pass: the open is tried again. `corrupt` and `too_new` stay for
 *  the owner: the file is never replaced or deleted. */
export type OpenCause = "locked" | "corrupt" | "too_new" | "io";

export function openFailure(error: unknown): { cause: OpenCause; recoverable: boolean } {
  if (error instanceof BufferVersionError) return { cause: "too_new", recoverable: false };
  const errcode = (error as { errcode?: unknown }).errcode;
  if (typeof errcode === "number") {
    const primary = errcode & 0xff;
    // SQLITE_BUSY, SQLITE_LOCKED
    if (primary === 5 || primary === 6) return { cause: "locked", recoverable: true };
    // SQLITE_CORRUPT, SQLITE_NOTADB
    if (primary === 11 || primary === 26) return { cause: "corrupt", recoverable: false };
  }
  // A full or failing disk, a directory that could not be made...
  return { cause: "io", recoverable: true };
}

export interface StoreOptions {
  /** The directory of the database (on the buffer volume). */
  dir: string;
  /** Where the buffer's id is also kept for tools (stateDir/buffer-id). */
  idFile: string;
  operatorVersion: string;
  now: () => number;
  migrations?: readonly Migration[];
  /** Tests: SQLite's own "database or disk is full" past this many pages. */
  maxPages?: number;
  /** Tests: an error to fail a commit with, inside its transaction. */
  commitFault?: (batch: Commit) => Error | null;
  /** Tests: an error for `totals` to throw (a read failing right after the
   *  open). */
  totalsFault?: () => Error | null;
  /** Tests: an error to fail a write of the sent mark with. */
  markFault?: () => Error | null;
}

const WAL_LIMIT_BYTES = 64 * 1024 * 1024;

function row(statement: StatementSync, ...params: Array<number | string | null>): Record<string, unknown> | undefined {
  return statement.get(...params) as Record<string, unknown> | undefined;
}

function connectionOf(found: Record<string, unknown>): StoredConnection {
  return { connectionId: String(found.connection_id), attemptId: Number(found.attempt_id), opened: Number(found.opened) === 1 };
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export class BufferStore {
  readonly path: string;
  readonly id: string;
  readonly schema: SchemaState;
  readonly #db: DatabaseSync;
  readonly #insertEvent: StatementSync;
  readonly #insertOutcome: StatementSync;
  readonly #setMeta: StatementSync;
  readonly #sumUpTo: StatementSync;
  readonly #deleteUpTo: StatementSync;
  readonly #deleteOutcome: StatementSync;
  readonly #sizesAfter: StatementSync;
  readonly #readRange: StatementSync;
  readonly #first: StatementSync;
  readonly #oldestOutcome: StatementSync;
  readonly #outcome: StatementSync;
  readonly #outcomeSizes: StatementSync;
  readonly #outcomeRange: StatementSync;
  readonly #mark: StatementSync;
  readonly #ackAttempt: StatementSync;
  readonly #attempt: StatementSync;
  readonly #purgeAttempts: StatementSync;
  readonly #bodyIds: StatementSync;
  readonly #outcomeSeqSizes: StatementSync;
  readonly #outcomeSeqRange: StatementSync;
  readonly #admitConnection: StatementSync;
  readonly #openConnection: StatementSync;
  readonly #dropConnection: StatementSync;
  readonly #allConnections: StatementSync;
  readonly #commitFault: StoreOptions["commitFault"];
  readonly #totalsFault: StoreOptions["totalsFault"];
  readonly #markFault: StoreOptions["markFault"];
  readonly #nowWall: () => number;
  #lastSeq: number;
  #lastWall: number | null;
  #lastOutcomeSeq: number;
  #sentMax: number;
  #closed = false;

  constructor(options: StoreOptions) {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    this.path = join(options.dir, DB_FILE);
    const db = new DatabaseSync(this.path);
    try {
      // The order matters: exclusive before WAL (no shared memory), auto
      // vacuum before the first table — and only then: on a file that has
      // tables it rewrites the header, and a file this operator refuses
      // (too new, corrupt) must stay exactly as it is. The first read takes
      // the lock (or finds it taken) and finds a file that is no database.
      db.exec("PRAGMA locking_mode = EXCLUSIVE");
      db.exec("PRAGMA busy_timeout = 0");
      if ((db.prepare("SELECT count(*) AS n FROM sqlite_schema").get() as { n: number }).n === 0) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      const mode = (db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | undefined)?.journal_mode;
      if (mode !== "wal") throw new Error(`the buffer could not enter WAL mode (${String(mode)})`);
      db.exec("PRAGMA synchronous = FULL");
      db.exec(`PRAGMA journal_size_limit = ${WAL_LIMIT_BYTES}`);
      if (options.maxPages !== undefined) db.exec(`PRAGMA max_page_count = ${Math.max(1, Math.floor(options.maxPages))}`);
      this.schema = migrate(db, options.migrations ?? MIGRATIONS, options.operatorVersion, options.now);
      // A database made now gets an id made now: its numbers start again,
      // so the pairs (id, number) never repeat (plan §4.4) — even when the
      // file was lost and the old id stayed behind.
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('buffer_id', ?), ('created_wall', ?), ('last_seq', '0'), ('last_wall', ''), ('sent_max', '0')").run(randomUUID(), String(options.now()));
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('opened_wall', ?)").run(String(options.now()));
      db.exec("COMMIT");
    } catch (error) {
      db.close();
      throw error;
    }
    // Whatever fails from here on, the connection goes with it: an open
    // connection holds the lock and would refuse every retry.
    try {
      this.#db = db;
      const meta = (key: string) => String(row(db.prepare("SELECT value FROM meta WHERE key = ?"), key)?.value ?? "");
      this.id = meta("buffer_id");
      this.#lastSeq = Number(meta("last_seq"));
      const lastWall = meta("last_wall");
      this.#lastWall = lastWall === "" ? null : Number(lastWall);
      this.#lastOutcomeSeq = Number(meta("last_outcome_seq") || "0");
      this.#sentMax = Number(meta("sent_max") || "0");
      this.#insertEvent = db.prepare(`INSERT INTO events (seq, at_wall, kind, format, bytes, json) VALUES (?, ?, ?, ${ROW_FORMAT}, ?, ?)`);
      this.#admitConnection = db.prepare("INSERT OR REPLACE INTO ws_connections (connection_id, attempt_id, opened, at_wall) VALUES (?, ?, 0, ?)");
      this.#openConnection = db.prepare("UPDATE ws_connections SET opened = 1 WHERE connection_id = ?");
      this.#dropConnection = db.prepare("DELETE FROM ws_connections WHERE connection_id = ?");
      this.#allConnections = db.prepare("SELECT connection_id, attempt_id, opened FROM ws_connections ORDER BY at_wall, connection_id");
      this.#insertOutcome = db.prepare(`INSERT OR IGNORE INTO outcomes (attempt_id, at_wall, type, format, bytes, json, body_id, body_bytes, seq) VALUES (?, ?, ?, ${ROW_FORMAT}, ?, ?, ?, ?, ?)`);
      this.#setMeta = db.prepare("UPDATE meta SET value = ? WHERE key = ?");
      this.#sumUpTo = db.prepare("SELECT coalesce(sum(bytes), 0) AS bytes, count(*) AS n FROM events WHERE seq <= ?");
      this.#deleteUpTo = db.prepare("DELETE FROM events WHERE seq <= ?");
      this.#deleteOutcome = db.prepare("DELETE FROM outcomes WHERE attempt_id = ? RETURNING bytes, body_id");
      this.#sizesAfter = db.prepare("SELECT seq, bytes FROM events WHERE seq > ? ORDER BY seq LIMIT ?");
      this.#readRange = db.prepare("SELECT seq, bytes, json FROM events WHERE seq > ? AND seq <= ? ORDER BY seq");
      this.#first = db.prepare("SELECT seq, at_wall FROM events ORDER BY seq LIMIT 1");
      this.#oldestOutcome = db.prepare("SELECT min(at_wall) AS at_wall FROM outcomes");
      this.#outcome = db.prepare("SELECT attempt_id, json, bytes, body_id, body_bytes, seq FROM outcomes WHERE attempt_id = ?");
      this.#outcomeSizes = db.prepare("SELECT attempt_id, bytes FROM outcomes WHERE attempt_id > ? ORDER BY attempt_id LIMIT ?");
      this.#outcomeRange = db.prepare("SELECT attempt_id, json, bytes, body_id, body_bytes, seq FROM outcomes WHERE attempt_id > ? AND attempt_id <= ? ORDER BY attempt_id");
      this.#outcomeSeqSizes = db.prepare("SELECT seq, bytes FROM outcomes WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?");
      this.#outcomeSeqRange = db.prepare("SELECT attempt_id, json, bytes, body_id, body_bytes, seq FROM outcomes WHERE seq > ? AND seq <= ? ORDER BY seq");
      this.#mark = db.prepare(
        "INSERT INTO hub_attempts (attempt_id, at_wall, issued, released, acked) VALUES (?, ?, ?, ?, 0) ON CONFLICT (attempt_id) DO UPDATE SET issued = max(issued, excluded.issued), released = max(released, excluded.released)",
      );
      this.#ackAttempt = db.prepare("UPDATE hub_attempts SET acked = 1, at_wall = ? WHERE attempt_id = ?");
      this.#attempt = db.prepare("SELECT issued, released, acked FROM hub_attempts WHERE attempt_id = ?");
      this.#purgeAttempts = db.prepare("DELETE FROM hub_attempts WHERE ((acked = 1 AND at_wall < ?) OR at_wall < ?) AND attempt_id NOT IN (SELECT attempt_id FROM outcomes)");
      this.#bodyIds = db.prepare("SELECT body_id FROM outcomes WHERE body_id IS NOT NULL");
      this.#commitFault = options.commitFault;
      this.#totalsFault = options.totalsFault;
      this.#markFault = options.markFault;
      this.#nowWall = options.now;
      syncIdFile(options.idFile, this.id);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** The last number given (0: none yet); it never goes back. */
  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** The moment of the event with the last number. */
  get lastWall(): number | null {
    return this.#lastWall;
  }

  /** The last outcome's order number (0: none yet); it never goes back. */
  get lastOutcomeSeq(): number {
    return this.#lastOutcomeSeq;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The highest number ever handed to a stream (schema v4); it never goes
   *  back. */
  get sentMax(): number {
    return this.#sentMax;
  }

  /** Raise the sent mark to `upto`, durably (its own transaction, one
   *  fsync), before anything past the old mark is sent. Throws when it
   *  cannot be written: nothing past the old mark may go then. */
  raiseSentMax(upto: number): void {
    if (upto <= this.#sentMax) return;
    const db = this.#db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const fault = this.#markFault?.();
      if (fault) throw fault;
      this.#setMeta.run(String(upto), "sent_max");
      db.exec("COMMIT");
      this.#sentMax = upto;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // SQLite rolled it back itself
      }
      throw error;
    }
  }

  /** One transaction, one fsync. Throws (and leaves nothing of itself) when
   *  it cannot be written. */
  commit(batch: Commit): Committed {
    const db = this.#db;
    const result: Committed = { insertedOutcomes: [], addedBytes: 0, deletedBytes: 0, deletedEvents: 0, deletedOutcomes: 0, deletedBodies: [] };
    db.exec("BEGIN IMMEDIATE");
    try {
      const fault = this.#commitFault?.(batch);
      if (fault) throw fault;
      let lastSeq = this.#lastSeq;
      let lastWall = this.#lastWall;
      let lastOutcomeSeq = this.#lastOutcomeSeq;
      for (const event of batch.events) {
        if (event.seq !== lastSeq + 1) throw new Error(`event ${event.seq} does not follow ${lastSeq}`);
        this.#insertEvent.run(event.seq, event.atWall, event.kind, event.bytes, event.json);
        lastSeq = event.seq;
        lastWall = event.atWall;
        result.addedBytes += event.bytes;
      }
      for (const outcome of batch.outcomes) {
        if (Number(this.#insertOutcome.run(outcome.attemptId, outcome.atWall, outcome.type, outcome.bytes, outcome.json, outcome.bodyId, outcome.bodyBytes, lastOutcomeSeq + 1).changes) === 0) continue;
        lastOutcomeSeq += 1;
        result.insertedOutcomes.push(outcome);
        result.addedBytes += outcome.bytes;
      }
      if (lastOutcomeSeq !== this.#lastOutcomeSeq) this.#setMeta.run(String(lastOutcomeSeq), "last_outcome_seq");
      for (const mark of batch.marks ?? []) {
        this.#mark.run(mark.attemptId, mark.atWall, mark.step === "received" ? 0 : 1, mark.step === "released" ? 1 : 0);
      }
      for (const change of batch.connections ?? []) {
        if ("admitted" in change) this.#admitConnection.run(change.connectionId, change.admitted.attemptId, change.atWall);
        else if ("opened" in change) this.#openConnection.run(change.connectionId);
        else this.#dropConnection.run(change.connectionId);
      }
      if (batch.deleteEventsUpTo !== null) {
        const gone = row(this.#sumUpTo, batch.deleteEventsUpTo);
        result.deletedBytes += Number(gone?.bytes ?? 0);
        result.deletedEvents = Number(gone?.n ?? 0);
        if (result.deletedEvents > 0) this.#deleteUpTo.run(batch.deleteEventsUpTo);
      }
      for (const attemptId of batch.deleteOutcomes) {
        const gone = row(this.#deleteOutcome, attemptId);
        if (gone === undefined) continue;
        result.deletedBytes += Number(gone.bytes);
        result.deletedOutcomes += 1;
        if (typeof gone.body_id === "string") result.deletedBodies.push(gone.body_id);
        this.#ackAttempt.run(this.#nowWall(), attemptId);
      }
      if (batch.purgeAttempts) this.#purgeAttempts.run(batch.purgeAttempts.ackedBefore, batch.purgeAttempts.before);
      if (lastSeq !== this.#lastSeq) {
        this.#setMeta.run(String(lastSeq), "last_seq");
        this.#setMeta.run(lastWall === null ? "" : String(lastWall), "last_wall");
      }
      db.exec("COMMIT");
      this.#lastSeq = lastSeq;
      this.#lastWall = lastWall;
      this.#lastOutcomeSeq = lastOutcomeSeq;
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // SQLite rolled it back itself (a full disk does)
      }
      throw error;
    }
  }

  /** What a failed commit left: the numbers as the file has them. */
  reload(): void {
    const value = (key: string) => String(row(this.#db.prepare("SELECT value FROM meta WHERE key = ?"), key)?.value ?? "");
    this.#lastSeq = Number(value("last_seq"));
    const lastWall = value("last_wall");
    this.#lastWall = lastWall === "" ? null : Number(lastWall);
    this.#lastOutcomeSeq = Number(value("last_outcome_seq") || "0");
    this.#sentMax = Number(value("sent_max") || "0");
  }

  /** Events after `afterSeq` in order: at most `maxEvents`, and no more
   *  than `maxBytes` of them (counting a comma between two) — but always the
   *  first, however big it is. The sizes first, then only the rows that fit:
   *  what is read into memory is one batch. */
  readEvents(afterSeq: number, maxEvents: number, maxBytes: number): StoredEvent[] {
    const sizes = this.#sizesAfter.all(afterSeq, Math.max(1, Math.floor(maxEvents))) as Array<{ seq: number; bytes: number }>;
    if (sizes.length === 0) return [];
    let upto = sizes[0]!.seq;
    let bytes = sizes[0]!.bytes;
    for (const size of sizes.slice(1)) {
      bytes += size.bytes + 1;
      if (bytes > maxBytes) break;
      upto = size.seq;
    }
    return (this.#readRange.all(afterSeq, upto) as Array<{ seq: number; bytes: number; json: string }>).map((event) => ({ seq: Number(event.seq), json: event.json, bytes: Number(event.bytes) }));
  }

  /** The stored outcomes of these attempts. */
  outcomes(attemptIds: readonly number[]): StoredOutcome[] {
    return attemptIds
      .map((id) => row(this.#outcome, id))
      .filter((found) => found !== undefined)
      .map(storedOutcome);
  }

  /** Outcomes after `afterAttemptId` by attempt id, a page at a time: at
   *  most `maxCount`, no more than `maxBytes` — but always the first. */
  outcomePage(afterAttemptId: number, maxCount: number, maxBytes: number): StoredOutcome[] {
    const sizes = this.#outcomeSizes.all(afterAttemptId, Math.max(1, Math.floor(maxCount))) as Array<{ attempt_id: number; bytes: number }>;
    if (sizes.length === 0) return [];
    let upto = sizes[0]!.attempt_id;
    let bytes = sizes[0]!.bytes;
    for (const size of sizes.slice(1)) {
      bytes += size.bytes;
      if (bytes > maxBytes) break;
      upto = size.attempt_id;
    }
    return (this.#outcomeRange.all(afterAttemptId, upto) as Array<Record<string, unknown>>).map(storedOutcome);
  }

  /** Outcomes stored after `afterSeq` and up to `uptoSeq`, in the order
   *  they were stored: at most `maxCount`, no more than `maxBytes` — but
   *  always the first. */
  outcomesBySeq(afterSeq: number, uptoSeq: number, maxCount: number, maxBytes: number): StoredOutcome[] {
    const sizes = this.#outcomeSeqSizes.all(afterSeq, uptoSeq, Math.max(1, Math.floor(maxCount))) as Array<{ seq: number; bytes: number }>;
    if (sizes.length === 0) return [];
    let upto = sizes[0]!.seq;
    let bytes = sizes[0]!.bytes;
    for (const size of sizes.slice(1)) {
      bytes += size.bytes;
      if (bytes > maxBytes) break;
      upto = size.seq;
    }
    return (this.#outcomeSeqRange.all(afterSeq, upto) as Array<Record<string, unknown>>).map(storedOutcome);
  }

  /** What the buffer knows of a Hub attempt, or null. */
  attempt(attemptId: number): AttemptRecord | null {
    const found = row(this.#attempt, attemptId);
    return found === undefined ? null : { issued: Number(found.issued) === 1, released: Number(found.released) === 1, acked: Number(found.acked) === 1 };
  }

  /** Every body a stored outcome names (the rest of bodies/ goes). */
  bodyIds(): string[] {
    return (this.#bodyIds.all() as Array<{ body_id: string }>).map((found) => found.body_id);
  }

  /** Every connection kept, oldest first. */
  connections(): StoredConnection[] {
    return (this.#allConnections.all() as Array<Record<string, unknown>>).map(connectionOf);
  }

  /** Pages SQLite holds free (deleted rows), not yet given back. */
  freePages(): number {
    return Number(row(this.#db.prepare("PRAGMA freelist_count"))?.freelist_count ?? 0);
  }

  /** One bounded step of giving space back: up to `pages` free pages out of
   *  the file (their own commit), then the WAL checkpointed and truncated —
   *  in WAL mode the file only shrinks at a checkpoint. Returns the free
   *  pages left. */
  reclaim(pages: number): number {
    this.#db.exec(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(pages))})`);
    this.#db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
    return this.freePages();
  }

  hasOutcome(attemptId: number): boolean {
    return row(this.#outcome, attemptId) !== undefined;
  }

  /** Counted once at open; the buffer keeps them up to date after. */
  totals(): Totals {
    const fault = this.#totalsFault?.();
    if (fault) throw fault;
    const db = this.#db;
    const events = row(db.prepare("SELECT coalesce(sum(bytes), 0) AS bytes, count(*) AS n FROM events"));
    const outcomes = row(db.prepare("SELECT coalesce(sum(bytes), 0) AS bytes, count(*) AS n FROM outcomes"));
    const first = this.first();
    return {
      bytes: Number(events?.bytes ?? 0) + Number(outcomes?.bytes ?? 0),
      events: Number(events?.n ?? 0),
      outcomes: Number(outcomes?.n ?? 0),
      firstSeq: first.seq,
      oldestEventWall: first.atWall,
      oldestOutcomeWall: this.oldestOutcomeWall(),
    };
  }

  first(): { seq: number | null; atWall: number | null } {
    const found = row(this.#first);
    return { seq: numberOrNull(found?.seq), atWall: numberOrNull(found?.at_wall) };
  }

  oldestOutcomeWall(): number | null {
    return numberOrNull(row(this.#oldestOutcome)?.at_wall);
  }

  /** For tests and diagnostics: SQLite's own check of the file. */
  integrity(): string {
    return (this.#db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>).map((found) => found.integrity_check).join("; ");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

function storedOutcome(found: Record<string, unknown>): StoredOutcome {
  return {
    attemptId: Number(found.attempt_id),
    json: String(found.json),
    bytes: Number(found.bytes),
    bodyId: typeof found.body_id === "string" ? found.body_id : null,
    bodyBytes: Number(found.body_bytes ?? 0),
    seq: Number(found.seq ?? 0),
  };
}

/** The id also sits in stateDir/buffer-id (where PR 4 kept it): the file
 *  follows the database, never the other way. */
function syncIdFile(path: string, id: string): void {
  try {
    if (readFileSync(path, "utf8").trim() === id) return;
  } catch {
    // written below
  }
  try {
    writeFileSync(`${path}.tmp`, `${id}\n`, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  } catch {
    // Only a copy for tools: the database has the id.
  }
}
