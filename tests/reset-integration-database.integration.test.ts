import { createModel } from "@agency_hub_core/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetIntegrationDatabase, startTestDatabase } from "./helpers/db.ts";
import { followersDiagnosticFixture } from "./helpers/followers-diagnostic-fixture.ts";

// resetIntegrationDatabase empties tables with DELETE by default and keeps
// TRUNCATE behind `physical: true`. Every integration file trusts the two to
// leave the same rows and the same sequences behind; this file holds them to it.
describe("resetIntegrationDatabase", () => {
  let db: Awaited<ReturnType<typeof startTestDatabase>>;
  beforeAll(async () => {
    db = await startTestDatabase();
  }, 120_000);
  afterAll(async () => {
    await db?.stop();
  });

  /** Row count of every public table (partitions included) and the state of
   * every sequence a column owns. */
  const snapshot = async () => {
    const tables = await db.pool.query<{ name: string; rows: number }>(`
      select c.relname as name,
             (xpath('/row/n/text()', query_to_xml(
               format('select count(*) as n from only %s', c.oid::regclass), false, true, '')))[1]::text::int as rows
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname
    `);
    const sequences = await db.pool.query<{ name: string; last_value: string | null }>(`
      select distinct s.sequencename as name, s.last_value::text
      from pg_sequences s
      join pg_depend d on d.objid = format('%I.%I', s.schemaname, s.sequencename)::regclass
      where s.schemaname = 'public' and d.deptype in ('a', 'i')
      order by s.sequencename
    `);
    return { tables: tables.rows, sequences: sequences.rows };
  };

  const seed = async () => {
    const fixture = await followersDiagnosticFixture(db, "count");
    expect((await fixture.recordWalkAndFinishTelemetry()).requested).toBe(true);
    await db.pool.query("select nextval('ofapi_webhook_events_fanout_seq')");
    const seeded = await snapshot();
    // Not vacuous: the fixture reaches an FK chain (models <- pages <- …) and
    // advances owned sequences.
    expect(seeded.tables.filter((table) => table.rows > 0).length).toBeGreaterThan(8);
    expect(seeded.sequences.filter((sequence) => sequence.last_value !== null).length).toBeGreaterThan(3);
  };

  const standaloneSequence = async () => (await db.pool.query<{ last_value: string | null }>(
    "select last_value::text from pg_sequences where schemaname = 'public' and sequencename = 'ofapi_webhook_events_fanout_seq'",
  )).rows[0]?.last_value;

  it("leaves the same rows and sequences as the TRUNCATE reset", async () => {
    await resetIntegrationDatabase(db.pool, { physical: true });
    await seed();
    await resetIntegrationDatabase(db.pool, { physical: true });
    const afterTruncate = await snapshot();

    await seed();
    await resetIntegrationDatabase(db.pool);
    const afterDelete = await snapshot();

    expect(afterDelete).toEqual(afterTruncate);
    // …and that state is: empty, except the reference data and the two
    // fixture singletons the reset reseeds.
    expect(afterDelete.tables.filter((table) => table.rows > 0).map((table) => table.name)).toEqual([
      "ofapi_collection_state",
      "ofapi_storage_health_state",
      "platforms",
      "schema_migrations",
    ]);
    expect(afterDelete.sequences.filter((sequence) => sequence.last_value !== null)).toEqual([]);
    const model = await createModel(db.db, { slug: "after-reset", name: "After reset" });
    expect(model?.id).toBe(1);
  });

  it("keeps a sequence no column owns, as TRUNCATE ... RESTART IDENTITY does", async () => {
    await resetIntegrationDatabase(db.pool);
    await db.pool.query("select nextval('ofapi_webhook_events_fanout_seq')");
    const before = await standaloneSequence();
    expect(before).not.toBeNull();
    await resetIntegrationDatabase(db.pool);
    expect(await standaloneSequence()).toBe(before);
  });

  it("returns the session to origin replication role", async () => {
    await resetIntegrationDatabase(db.pool);
    const client = await db.pool.connect();
    try {
      // Every pooled connection, including the one the reset ran on.
      const all = await Promise.all(Array.from({ length: 5 }, () => db.pool.query<{ role: string }>(
        "select current_setting('session_replication_role') as role",
      )));
      expect(new Set(all.map((result) => result.rows[0]?.role))).toEqual(new Set(["origin"]));
      expect((await client.query<{ role: string }>(
        "select current_setting('session_replication_role') as role",
      )).rows[0]?.role).toBe("origin");
    } finally {
      client.release();
    }
  });

  it("waits for a write still in flight and then removes its rows", async () => {
    await resetIntegrationDatabase(db.pool);
    const writer = await db.pool.connect();
    try {
      await writer.query("begin");
      await writer.query("insert into models (slug, name) values ('late-writer', 'Late writer')");
      const writerPid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

      const reset = resetIntegrationDatabase(db.pool);
      // The reset is queued behind the writer's lock, not finished around it.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await db.pool.query<{ n: number }>(`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and $1 = any(pg_blocking_pids(pid))
        `, [writerPid]);
        if (waiting.rows[0]!.n > 0) break;
        if (Date.now() > deadline) throw new Error("the reset never waited for the in-flight write");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await writer.query("commit");
      await reset;
    } finally {
      writer.release();
    }
    const left = await db.pool.query<{ n: number }>("select count(*)::int as n from models");
    expect(left.rows[0]!.n).toBe(0);
  });

  // A claimer (SELECT ... FOR UPDATE, then UPDATE) must not deadlock the reset:
  // under a SHARE lock the reset's DELETE waits for the claimed row while the
  // claimer's UPDATE waits for the reset (40P01). TRUNCATE's lock queues the
  // reset behind the claimer instead, and the reset must do the same.
  it("waits for a claimer that locked a row before updating it", async () => {
    await resetIntegrationDatabase(db.pool);
    await db.pool.query("insert into models (slug, name) values ('claimed', 'Claimed')");
    const claimer = await db.pool.connect();
    try {
      await claimer.query("begin");
      await claimer.query("select id from models where slug = 'claimed' for update");
      const claimerPid = (await claimer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

      const reset = resetIntegrationDatabase(db.pool);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await db.pool.query<{ n: number }>(`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and $1 = any(pg_blocking_pids(pid))
        `, [claimerPid]);
        if (waiting.rows[0]!.n > 0) break;
        if (Date.now() > deadline) throw new Error("the reset never waited for the claimer");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await claimer.query("update models set name = 'Claimed late' where slug = 'claimed'");
      await claimer.query("commit");
      await reset;
    } finally {
      claimer.release();
    }
    const left = await db.pool.query<{ n: number }>("select count(*)::int as n from models");
    expect(left.rows[0]!.n).toBe(0);
  });
});
