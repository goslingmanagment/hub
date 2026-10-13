// The buffer's file format (plan §4.4, §4.10): a SQLite database whose
// schema has a version, and a forward-only list of migrations. A newer
// operator reads an older buffer — it migrates it, one version at a time,
// each in its own transaction. An older operator (the image rolled back, plan
// §4.10) may open a newer buffer only when every migration it lacks says it
// can (`readableFrom`); otherwise it refuses the buffer and the page stands.
//
// The rows keep their own `format` too: `json` of format 1 is the event or
// the outcome exactly as protocol 1.x sends it (rpc/protocol.ts), so a batch
// is sent as stored, without parsing it again.

import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  /** The schema version this migration makes (1, 2, ... — no gaps). */
  version: number;
  /** The lowest schema version an operator must know to still use a buffer
   *  at this version. A migration that only adds (a table, a nullable
   *  column, an index) keeps it; one an older operator would write wrongly
   *  (a NOT NULL column without a default, a changed meaning) raises it to
   *  its own version. */
  readableFrom: number;
  /** Runs inside the migration's transaction. */
  up: (db: DatabaseSync) => void;
}

/** Version 1 (PR 11).
 *  - meta: the buffer's id, the last number given and its moment (they
 *    outlive the events they describe: numbers are never given twice).
 *  - schema_version: every migration applied, with the lowest version that
 *    can still use the buffer.
 *  - events: the stream of plan §4.4 — numbered, sent and deleted in order.
 *  - outcomes: the attempts' outcomes (result, siteDone, wsDone) until the
 *    engine's resultAck (plan §4.2; spec §6.2).
 *  `bytes` comes before `json`: a batch's size is read without walking the
 *  overflow pages of big rows. */
const V1 = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  readable_from INTEGER NOT NULL,
  applied_wall INTEGER NOT NULL,
  operator_version TEXT NOT NULL
) STRICT;
CREATE TABLE events (
  seq INTEGER PRIMARY KEY,
  at_wall INTEGER NOT NULL,
  kind TEXT NOT NULL,
  format INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  json TEXT NOT NULL
) STRICT;
CREATE TABLE outcomes (
  attempt_id INTEGER PRIMARY KEY,
  at_wall INTEGER NOT NULL,
  type TEXT NOT NULL,
  format INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  json TEXT NOT NULL
) STRICT;
CREATE INDEX outcomes_by_age ON outcomes (at_wall);
`;

/** Version 2 (PR 9): Hub requests.
 *  - outcomes.body_id, body_bytes: the body a result names (BodyRef), a
 *    file of the buffer volume's bodies/ directory (bodies.ts); its bytes
 *    count in the outcome's `bytes`, and so in the caps.
 *  - outcomes.seq: the order outcomes were stored in (meta
 *    `last_outcome_seq`), so their delivery follows the file with a cursor
 *    (replay.ts), not a queue in memory; outcomes from before take their
 *    attempt id (unique, and below every later number).
 *  - hub_attempts: what the operator did with each Hub attempt it was sent
 *    — received, the request issued in the page, released to the network,
 *    its outcome acknowledged — written before the step it stands for. A
 *    repeated `send` does nothing twice, across restarts too, and `recover`
 *    can say `not_sent` of a request that was never released (plan §3.2,
 *    §4.13). Rows outlive their outcome's resultAck by a day; nothing
 *    stays longer than a week.
 *  Readable from 2: an older operator would send results naming bodies it
 *  cannot deliver, and never delete their files. */
const V2 = `
ALTER TABLE outcomes ADD COLUMN body_id TEXT;
ALTER TABLE outcomes ADD COLUMN body_bytes INTEGER;
ALTER TABLE outcomes ADD COLUMN seq INTEGER;
UPDATE outcomes SET seq = attempt_id;
CREATE UNIQUE INDEX outcomes_by_seq ON outcomes (seq);
INSERT OR REPLACE INTO meta (key, value) SELECT 'last_outcome_seq', CAST(coalesce(max(attempt_id), 0) AS TEXT) FROM outcomes;
CREATE TABLE hub_attempts (
  attempt_id INTEGER PRIMARY KEY,
  at_wall INTEGER NOT NULL,
  issued INTEGER NOT NULL,
  released INTEGER NOT NULL,
  acked INTEGER NOT NULL
) STRICT;
CREATE INDEX hub_attempts_by_age ON hub_attempts (at_wall);
`;

/** Version 3 (PR 10): the site's socket.
 *  - ws_receipts: the Chrome messages events were made of — the socket (CDP
 *    session and request id) and the holder's number of the message — with
 *    the event's number, written in the event's commit. A message the
 *    holder delivers again after an operator restart (its acknowledgement
 *    had not reached the holder) is not written twice. A receipt outlives
 *    its event (the engine's ack deletes events, not receipts): it goes once
 *    the acknowledgement was written to the holder, and every receipt goes
 *    when a new Chrome starts — its holder is a new one, nothing older can
 *    come again; a cap bounds them besides.
 *  - ws_connections: every admitted connection of the site's socket — its
 *    attempt and session, Chrome's socket once the handshake ties it, and
 *    whether its ws.open is in the stream — written before the CONNECT goes
 *    on, tied before the tie's event is acknowledged, opened in the commit
 *    of ws.open, deleted in the commit of ws.close (or of its outcome, when
 *    it never opened). A restarted operator rebuilds from it the open of a
 *    connection whose ws.open died with the previous one, ties the frames
 *    the holder delivers again, and closes in the stream what the previous
 *    Chrome left open.
 *  Readable from 2: an older operator writes no socket events. */
const V3 = `
CREATE TABLE ws_receipts (
  origin TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  at_wall INTEGER NOT NULL
) STRICT;
CREATE INDEX ws_receipts_by_age ON ws_receipts (at_wall);
CREATE TABLE ws_connections (
  connection_id TEXT PRIMARY KEY,
  attempt_id INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  socket_key TEXT,
  opened INTEGER NOT NULL,
  at_wall INTEGER NOT NULL
) STRICT;
CREATE INDEX ws_connections_by_socket ON ws_connections (socket_key) WHERE socket_key IS NOT NULL;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, readableFrom: 1, up: (db) => db.exec(V1) },
  { version: 2, readableFrom: 2, up: (db) => db.exec(V2) },
  { version: 3, readableFrom: 2, up: (db) => db.exec(V3) },
];

/** The format of a row's `json` this operator writes. */
export const ROW_FORMAT = 1;

/** The buffer was made by an operator this one cannot follow. */
export class BufferVersionError extends Error {}

export interface SchemaState {
  /** The buffer's schema version after the migrations. */
  version: number;
  /** The lowest version that can use it. */
  readableFrom: number;
  /** The newest version this operator knows. */
  known: number;
  /** The database was empty: version 1 made it. */
  created: boolean;
}

function scalar(db: DatabaseSync, sql: string): unknown {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  return row === undefined ? undefined : Object.values(row)[0];
}

/** Brings the database to the newest known version, or checks that this
 *  operator may use a newer one. */
export function migrate(db: DatabaseSync, migrations: readonly Migration[], operatorVersion: string, now: () => number): SchemaState {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error(`the migrations are not numbered 1..n (${migration.version} at ${index})`);
  });
  const known = migrations.length;
  const fresh = scalar(db, "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'schema_version'") === 0;
  const current = fresh ? 0 : Number(scalar(db, "SELECT coalesce(max(version), 0) FROM schema_version"));
  if (current > known) {
    const readableFrom = Number(scalar(db, "SELECT coalesce(max(readable_from), 0) FROM schema_version"));
    if (readableFrom > known) throw new BufferVersionError(`the buffer is at schema version ${current}, readable from ${readableFrom}; this operator knows up to ${known}`);
    return { version: current, readableFrom, known, created: false };
  }
  for (const migration of migrations.slice(current)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.prepare("INSERT INTO schema_version (version, readable_from, applied_wall, operator_version) VALUES (?, ?, ?, ?)").run(migration.version, migration.readableFrom, now(), operatorVersion);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // SQLite rolled it back itself
      }
      throw error;
    }
  }
  const readableFrom = Number(scalar(db, "SELECT coalesce(max(readable_from), 0) FROM schema_version"));
  return { version: known, readableFrom, known, created: fresh };
}
