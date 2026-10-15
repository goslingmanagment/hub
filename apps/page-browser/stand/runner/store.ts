// What the runner's engine commits, in the stand's own Postgres — the stand's
// stand-in for Hub's: the events of each operator buffer, keyed by (buffer
// id, number) as the engine keys them (plan §3.2), the outcomes of the
// attempts it issued, keyed by attempt, and its own state (the owner
// generation and the next attempt id of each page, which outlive a restart
// of the engine as `sync_pages` does).
//
// An event or an outcome delivered again is not committed twice: the key
// holds, and the repeat is counted (`pb_redeliveries`) — a repeat is the
// protocol at work, not an error. The naive tables have no key: a control
// scenario commits there to show that the exactly-once check does see a
// duplicate.

import { lit, Pg } from "./pg.ts";
import { mono } from "../shared.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pb_pages (page text PRIMARY KEY, generation bigint NOT NULL DEFAULT 0, next_attempt bigint NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS pb_events (
  buffer_id text NOT NULL, seq bigint NOT NULL, page text NOT NULL, run text NOT NULL, kind text NOT NULL,
  at_wall bigint NOT NULL, at_mono double precision NOT NULL, committed_mono double precision NOT NULL,
  frame bigint, reason text, body jsonb NOT NULL, PRIMARY KEY (buffer_id, seq));
CREATE TABLE IF NOT EXISTS pb_attempts (page text NOT NULL, attempt_id bigint NOT NULL, run text NOT NULL, kind text NOT NULL, rid text, issued_mono double precision NOT NULL, PRIMARY KEY (page, attempt_id));
CREATE TABLE IF NOT EXISTS pb_outcomes (
  page text NOT NULL, attempt_id bigint NOT NULL, run text NOT NULL, type text NOT NULL, kind text NOT NULL, sent boolean,
  committed_mono double precision NOT NULL, body jsonb NOT NULL, PRIMARY KEY (page, attempt_id));
CREATE TABLE IF NOT EXISTS pb_outcomes_naive (page text NOT NULL, attempt_id bigint NOT NULL, run text NOT NULL, type text NOT NULL, kind text NOT NULL, sent boolean, committed_mono double precision NOT NULL);
CREATE TABLE IF NOT EXISTS pb_redeliveries (page text NOT NULL, run text NOT NULL, what text NOT NULL, key text NOT NULL, at_mono double precision NOT NULL);
`;

export interface StoredEvent {
  seq: number;
  atMono: number;
  atWall: number;
  kind: string;
  [field: string]: unknown;
}

export interface OutcomeRow {
  attemptId: number;
  run: string;
  type: string;
  kind: string;
  sent: boolean | null;
  committedMono: number;
}

export interface EventRow {
  bufferId: string;
  seq: number;
  run: string;
  kind: string;
  reason: string | null;
  frame: number | null;
  atMono: number;
  committedMono: number;
}

export class Store {
  readonly #host: string;
  readonly #port: number;
  #pg: Pg | null = null;
  #connecting: Promise<Pg> | null = null;

  constructor(host: string, port = 5432) {
    this.#host = host;
    this.#port = port;
  }

  async #db(): Promise<Pg> {
    if (this.#pg && !this.#pg.closed) return this.#pg;
    this.#connecting ??= Pg.connect(this.#host, this.#port, "postgres", "postgres").finally(() => (this.#connecting = null));
    const pg = await this.#connecting;
    this.#pg = pg;
    return pg;
  }

  async query(sql: string): Promise<Array<Array<string | null>>> {
    return (await (await this.#db()).query(sql)).rows;
  }

  async init(): Promise<void> {
    await this.query(SCHEMA);
  }

  /** Waits until the database answers (it may be down on purpose). */
  async reachable(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.query("SELECT 1");
        return true;
      } catch {
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }

  close(): void {
    this.#pg?.close();
    this.#pg = null;
  }

  /** The next owner generation of the page: higher than any before. */
  async nextGeneration(page: string): Promise<number> {
    const rows = await this.query(`INSERT INTO pb_pages (page, generation) VALUES (${lit(page)}, 1) ON CONFLICT (page) DO UPDATE SET generation = pb_pages.generation + 1 RETURNING generation`);
    return Number(rows[0]?.[0]);
  }

  async raiseGeneration(page: string, to: number): Promise<void> {
    await this.query(`UPDATE pb_pages SET generation = GREATEST(generation, ${lit(to)}) WHERE page = ${lit(page)}`);
  }

  /** `count` new attempt ids of the page, recorded as issued. */
  async issue(page: string, run: string, kind: string, rids: Array<string | null>): Promise<number[]> {
    const rows = await this.query(`INSERT INTO pb_pages (page, next_attempt) VALUES (${lit(page)}, ${rids.length + 1}) ON CONFLICT (page) DO UPDATE SET next_attempt = pb_pages.next_attempt + ${rids.length} RETURNING next_attempt`);
    const next = Number(rows[0]?.[0]);
    const first = next - rids.length;
    const ids = rids.map((_, index) => first + index);
    if (ids.length > 0) {
      const at = mono();
      await this.query(`INSERT INTO pb_attempts (page, attempt_id, run, kind, rid, issued_mono) VALUES ${ids.map((id, index) => `(${lit(page)}, ${id}, ${lit(run)}, ${lit(kind)}, ${lit(rids[index] ?? null)}, ${at})`).join(", ")}`);
    }
    return ids;
  }

  /** The attempts issued for a run (any page, any kind). */
  async attemptsOfRun(run: string): Promise<Array<{ page: string; attemptId: number; kind: string; rid: string | null }>> {
    const rows = await this.query(`SELECT page, attempt_id, kind, rid FROM pb_attempts WHERE run = ${lit(run)} ORDER BY attempt_id`);
    return rows.map((row) => ({ page: String(row[0]), attemptId: Number(row[1]), kind: String(row[2]), rid: row[3] ?? null }));
  }

  /** The last number of the buffer committed (everything before it is). */
  async committedUpTo(bufferId: string): Promise<number> {
    const rows = await this.query(`SELECT COALESCE(max(seq), 0) FROM pb_events WHERE buffer_id = ${lit(bufferId)}`);
    return Number(rows[0]?.[0] ?? 0);
  }

  /** A batch of events, in one statement; returns how many were new. */
  async commitEvents(page: string, run: string, bufferId: string, events: StoredEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const at = mono();
    const values = events.map((event) => {
      const text = typeof event.frame === "string" ? event.frame : null;
      const frame = text === null ? null : standFrameOf(text);
      const reason = typeof event.reason === "string" ? event.reason : null;
      return `(${lit(bufferId)}, ${event.seq}, ${lit(page)}, ${lit(run)}, ${lit(event.kind)}, ${Math.round(event.atWall)}, ${event.atMono}, ${at}, ${lit(frame)}, ${lit(reason)}, ${lit(JSON.stringify(event))}::jsonb)`;
    });
    const rows = await this.query(`INSERT INTO pb_events (buffer_id, seq, page, run, kind, at_wall, at_mono, committed_mono, frame, reason, body) VALUES ${values.join(", ")} ON CONFLICT (buffer_id, seq) DO NOTHING RETURNING seq`);
    const fresh = new Set(rows.map((row) => Number(row[0])));
    const again = events.filter((event) => !fresh.has(event.seq));
    if (again.length > 0) await this.query(`INSERT INTO pb_redeliveries (page, run, what, key, at_mono) VALUES ${again.map((event) => `(${lit(page)}, ${lit(run)}, 'event', ${lit(`${bufferId}:${event.seq}`)}, ${at})`).join(", ")}`);
    return fresh.size;
  }

  /** An attempt's outcome (result, siteDone, wsDone); false: it was
   *  committed before (a redelivery). `naive`: no key — the control. */
  async commitOutcome(page: string, run: string, attemptId: number, type: string, kind: string, sent: boolean | null, body: unknown, naive = false): Promise<boolean> {
    const at = mono();
    if (naive) {
      await this.query(`INSERT INTO pb_outcomes_naive (page, attempt_id, run, type, kind, sent, committed_mono) VALUES (${lit(page)}, ${attemptId}, ${lit(run)}, ${lit(type)}, ${lit(kind)}, ${lit(sent)}, ${at})`);
      return true;
    }
    const rows = await this.query(
      `INSERT INTO pb_outcomes (page, attempt_id, run, type, kind, sent, committed_mono, body) VALUES (${lit(page)}, ${attemptId}, ${lit(run)}, ${lit(type)}, ${lit(kind)}, ${lit(sent)}, ${at}, ${lit(JSON.stringify(body))}::jsonb) ON CONFLICT (page, attempt_id) DO NOTHING RETURNING attempt_id`,
    );
    if (rows.length === 0) await this.query(`INSERT INTO pb_redeliveries (page, run, what, key, at_mono) VALUES (${lit(page)}, ${lit(run)}, 'outcome', ${lit(String(attemptId))}, ${at})`);
    return rows.length > 0;
  }

  async outcomes(page: string, attemptIds: number[], naive = false): Promise<OutcomeRow[]> {
    if (attemptIds.length === 0) return [];
    const rows = await this.query(`SELECT attempt_id, run, type, kind, sent, committed_mono FROM ${naive ? "pb_outcomes_naive" : "pb_outcomes"} WHERE page = ${lit(page)} AND attempt_id IN (${attemptIds.join(", ")}) ORDER BY attempt_id, committed_mono`);
    return rows.map((row) => ({ attemptId: Number(row[0]), run: String(row[1]), type: String(row[2]), kind: String(row[3]), sent: row[4] === null ? null : row[4] === "t", committedMono: Number(row[5]) }));
  }

  async eventsOfRun(run: string): Promise<EventRow[]> {
    const rows = await this.query(`SELECT buffer_id, seq, run, kind, reason, frame, at_mono, committed_mono FROM pb_events WHERE run = ${lit(run)} ORDER BY buffer_id, seq`);
    return rows.map((row) => ({ bufferId: String(row[0]), seq: Number(row[1]), run: String(row[2]), kind: String(row[3]), reason: row[4] ?? null, frame: row[5] === null ? null : Number(row[5]), atMono: Number(row[6]), committedMono: Number(row[7]) }));
  }

  /** The stand's frames committed for a run: when each was committed. */
  async framesOfRun(run: string): Promise<Array<{ frame: number; committedMono: number }>> {
    const rows = await this.query(`SELECT frame, committed_mono FROM pb_events WHERE run = ${lit(run)} AND frame IS NOT NULL ORDER BY frame`);
    return rows.map((row) => ({ frame: Number(row[0]), committedMono: Number(row[1]) }));
  }

  /** The stand's frame numbers a page has stored as `ws.in` events, from
   *  number `from` on. */
  async storedFrames(page: string, from: number): Promise<number[]> {
    const rows = await this.query(`SELECT frame FROM pb_events WHERE page = ${lit(page)} AND kind = 'ws.in' AND frame >= ${Math.floor(from)}`);
    return rows.map((row) => Number(row[0]));
  }

  /** The request ids of the site's answers a page has stored as
   *  `site.response` events (complete or marked incomplete). */
  async storedResponses(page: string): Promise<string[]> {
    const rows = await this.query(`SELECT body->>'query' FROM pb_events WHERE page = ${lit(page)} AND kind = 'site.response'`);
    return rows.flatMap((row) => {
      const rid = /(?:^|[?&])rid=([^&]+)/.exec(row[0] ?? "")?.[1];
      return rid === undefined ? [] : [rid];
    });
  }

  /** The gap marks committed for the pages: where each says the stream
   *  broke (the operator's wall clock; null: unknown) and when it was
   *  written. */
  async gapsOf(pages: readonly string[]): Promise<Array<{ page: string; reason: string | null; fromWall: number | null; atWall: number }>> {
    if (pages.length === 0) return [];
    const rows = await this.query(`SELECT page, reason, body->>'fromWall', at_wall FROM pb_events WHERE kind = 'gap' AND page IN (${pages.map((page) => lit(page)).join(", ")}) ORDER BY at_wall`);
    return rows.map((row) => ({ page: String(row[0]), reason: row[1] ?? null, fromWall: row[2] === null || row[2] === undefined ? null : Number(row[2]), atWall: Number(row[3]) }));
  }

  /** Every number of a buffer committed so far, for the contiguity check. */
  async seqsOf(bufferId: string): Promise<number[]> {
    const rows = await this.query(`SELECT seq FROM pb_events WHERE buffer_id = ${lit(bufferId)} ORDER BY seq`);
    return rows.map((row) => Number(row[0]));
  }

  /** Stand frames committed more than once (under different numbers). */
  async duplicateFrames(): Promise<Array<{ frame: number; count: number }>> {
    const rows = await this.query("SELECT frame, count(*) FROM pb_events WHERE frame IS NOT NULL GROUP BY frame HAVING count(*) > 1 ORDER BY frame LIMIT 100");
    return rows.map((row) => ({ frame: Number(row[0]), count: Number(row[1]) }));
  }

  async redeliveries(run: string): Promise<{ events: number; outcomes: number }> {
    const rows = await this.query(`SELECT what, count(*) FROM pb_redeliveries WHERE run = ${lit(run)} GROUP BY what`);
    const counts = new Map(rows.map((row) => [String(row[0]), Number(row[1])]));
    return { events: counts.get("event") ?? 0, outcomes: counts.get("outcome") ?? 0 };
  }
}

/** The stand's frame number inside a socket frame the stand pushed. */
export function standFrameOf(text: string): number | null {
  const match = /"standFrame\\?":(\d+)/.exec(text);
  return match ? Number(match[1]) : null;
}
