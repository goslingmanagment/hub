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
//   their pages given back a little at a time (plan §4.4, step 4).
// - journal_size_limit: the WAL file shrinks back after a checkpoint.
//
// Synchronous on purpose: the buffer's writer batches (≤ 20 ms, plan §4.14)
// so the event loop waits for one fsync per batch, not per event. If the
// stand measures that as too long, the store moves into a worker thread
// without the producers noticing (buffer.ts's API is already asynchronous).

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { MIGRATIONS, migrate, ROW_FORMAT, type Migration, type SchemaState } from "./schema.ts";

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
  bytes: number;
}

export interface NewEventRow {
  seq: number;
  atWall: number;
  kind: string;
  json: string;
  bytes: number;
}

export interface NewOutcomeRow {
  attemptId: number;
  atWall: number;
  type: string;
  json: string;
  bytes: number;
}

export interface Commit {
  events: NewEventRow[];
  outcomes: NewOutcomeRow[];
  /** Delete the events up to this number (acknowledged), or nothing. */
  deleteEventsUpTo: number | null;
  /** Delete these outcomes (their resultAck came). */
  deleteOutcomes: number[];
}

export interface Committed {
  /** Outcomes stored now (an attempt's outcome already stored stays). */
  insertedOutcomes: NewOutcomeRow[];
  addedBytes: number;
  deletedBytes: number;
  deletedEvents: number;
  deletedOutcomes: number;
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
}

/** Pages given back to the file system after a delete (4 KiB each). */
const VACUUM_PAGES = 512;
const WAL_LIMIT_BYTES = 64 * 1024 * 1024;

function row(statement: StatementSync, ...params: Array<number | string | null>): Record<string, unknown> | undefined {
  return statement.get(...params) as Record<string, unknown> | undefined;
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
  readonly #allOutcomes: StatementSync;
  #lastSeq: number;
  #lastWall: number | null;
  #closed = false;

  constructor(options: StoreOptions) {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    this.path = join(options.dir, DB_FILE);
    const db = new DatabaseSync(this.path);
    try {
      // The order matters: exclusive before WAL (no shared memory), auto
      // vacuum before the first table.
      db.exec("PRAGMA locking_mode = EXCLUSIVE");
      db.exec("PRAGMA busy_timeout = 2000");
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
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
      db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('buffer_id', ?), ('created_wall', ?), ('last_seq', '0'), ('last_wall', '')").run(randomUUID(), String(options.now()));
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('opened_wall', ?)").run(String(options.now()));
      db.exec("COMMIT");
    } catch (error) {
      db.close();
      throw error;
    }
    this.#db = db;
    const meta = (key: string) => String(row(db.prepare("SELECT value FROM meta WHERE key = ?"), key)?.value ?? "");
    this.id = meta("buffer_id");
    this.#lastSeq = Number(meta("last_seq"));
    const lastWall = meta("last_wall");
    this.#lastWall = lastWall === "" ? null : Number(lastWall);
    this.#insertEvent = db.prepare(`INSERT INTO events (seq, at_wall, kind, format, bytes, json) VALUES (?, ?, ?, ${ROW_FORMAT}, ?, ?)`);
    this.#insertOutcome = db.prepare(`INSERT OR IGNORE INTO outcomes (attempt_id, at_wall, type, format, bytes, json) VALUES (?, ?, ?, ${ROW_FORMAT}, ?, ?)`);
    this.#setMeta = db.prepare("UPDATE meta SET value = ? WHERE key = ?");
    this.#sumUpTo = db.prepare("SELECT coalesce(sum(bytes), 0) AS bytes, count(*) AS n FROM events WHERE seq <= ?");
    this.#deleteUpTo = db.prepare("DELETE FROM events WHERE seq <= ?");
    this.#deleteOutcome = db.prepare("DELETE FROM outcomes WHERE attempt_id = ? RETURNING bytes");
    this.#sizesAfter = db.prepare("SELECT seq, bytes FROM events WHERE seq > ? ORDER BY seq LIMIT ?");
    this.#readRange = db.prepare("SELECT seq, bytes, json FROM events WHERE seq > ? AND seq <= ? ORDER BY seq");
    this.#first = db.prepare("SELECT seq, at_wall FROM events ORDER BY seq LIMIT 1");
    this.#oldestOutcome = db.prepare("SELECT min(at_wall) AS at_wall FROM outcomes");
    this.#outcome = db.prepare("SELECT attempt_id, json, bytes FROM outcomes WHERE attempt_id = ?");
    this.#allOutcomes = db.prepare("SELECT attempt_id, json, bytes FROM outcomes ORDER BY at_wall, attempt_id");
    syncIdFile(options.idFile, this.id);
  }

  /** The last number given (0: none yet); it never goes back. */
  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** The moment of the event with the last number. */
  get lastWall(): number | null {
    return this.#lastWall;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** One transaction, one fsync. Throws (and leaves nothing of itself) when
   *  it cannot be written. */
  commit(batch: Commit): Committed {
    const db = this.#db;
    const result: Committed = { insertedOutcomes: [], addedBytes: 0, deletedBytes: 0, deletedEvents: 0, deletedOutcomes: 0 };
    db.exec("BEGIN IMMEDIATE");
    try {
      let lastSeq = this.#lastSeq;
      let lastWall = this.#lastWall;
      for (const event of batch.events) {
        if (event.seq !== lastSeq + 1) throw new Error(`event ${event.seq} does not follow ${lastSeq}`);
        this.#insertEvent.run(event.seq, event.atWall, event.kind, event.bytes, event.json);
        lastSeq = event.seq;
        lastWall = event.atWall;
        result.addedBytes += event.bytes;
      }
      for (const outcome of batch.outcomes) {
        if (Number(this.#insertOutcome.run(outcome.attemptId, outcome.atWall, outcome.type, outcome.bytes, outcome.json).changes) === 0) continue;
        result.insertedOutcomes.push(outcome);
        result.addedBytes += outcome.bytes;
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
      }
      if (lastSeq !== this.#lastSeq) {
        this.#setMeta.run(String(lastSeq), "last_seq");
        this.#setMeta.run(lastWall === null ? "" : String(lastWall), "last_wall");
      }
      if (result.deletedEvents > 0 || result.deletedOutcomes > 0) db.prepare(`PRAGMA incremental_vacuum(${VACUUM_PAGES})`).all();
      db.exec("COMMIT");
      this.#lastSeq = lastSeq;
      this.#lastWall = lastWall;
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

  /** The stored outcomes of these attempts, or all of them (oldest first). */
  outcomes(attemptIds?: readonly number[]): StoredOutcome[] {
    const rows = attemptIds === undefined ? (this.#allOutcomes.all() as Array<Record<string, unknown>>) : attemptIds.map((id) => row(this.#outcome, id)).filter((found) => found !== undefined);
    return rows.map((found) => ({ attemptId: Number(found.attempt_id), json: String(found.json), bytes: Number(found.bytes) }));
  }

  hasOutcome(attemptId: number): boolean {
    return row(this.#outcome, attemptId) !== undefined;
  }

  /** Counted once at open; the buffer keeps them up to date after. */
  totals(): Totals {
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
