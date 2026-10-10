import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, ensureDomainEventPartitions } from "@agency_hub_core/db";

import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// 0264: every BRIN index summarizes a page range as soon as the next one opens
// (autosummarize). Without it, every range written since a table's last vacuum
// stays unsummarized and a BRIN scan reads it whole: the minutely canonicalize
// sample read ~200 MB a run on prod. A partitioned index cannot hold the
// option, so ensureDomainEventPartitions switches each partition it creates.

let harness: StartedTestDatabase;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) {
    throw new Error("Docker-backed Postgres is required for this integration test");
  }
  harness = started;
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

/** BRIN indexes (not partitioned parents) without autosummarize. */
async function brinIndexesWithoutAutosummarize(): Promise<string[]> {
  const result = await harness.pool.query<{ index: string }>(`
    select c.relname as index
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_am am on am.oid = c.relam
    where c.relkind = 'i' and am.amname = 'brin' and n.nspname = 'public'
      and not exists (
        select 1 from unnest(coalesce(c.reloptions, '{}'::text[])) as o(option)
        where o.option in ('autosummarize=on', 'autosummarize=true')
      )
    order by 1
  `);
  return result.rows.map((row) => row.index);
}

async function partitionBrinOptions(partition: string): Promise<string[] | null> {
  const result = await harness.pool.query<{ reloptions: string[] | null }>(`
    select c.reloptions
    from pg_index x
    join pg_class c on c.oid = x.indexrelid
    join pg_am am on am.oid = c.relam
    where x.indrelid = to_regclass($1) and am.amname = 'brin'
  `, [`public.${partition}`]);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!.reloptions;
}

describe("BRIN autosummarize", () => {
  it("is on for every BRIN index the migrations leave", async () => {
    const brin = await harness.pool.query<{ n: string }>(`
      select count(*)::text as n from pg_class c join pg_am am on am.oid = c.relam
      where c.relkind = 'i' and am.amname = 'brin'
    `);
    // domain_events' partitions and ofapi_webhook_events.
    expect(Number(brin.rows[0]!.n)).toBeGreaterThan(1);
    expect(await brinIndexesWithoutAutosummarize()).toEqual([]);
  });

  it("is switched on for a domain_events partition created later", async () => {
    const ensured = await ensureDomainEventPartitions(harness.db, {
      now: new Date("2029-05-01T00:00:00.000Z"),
      monthsAhead: 1,
    });
    expect(ensured).toEqual(["domain_events_2029_05", "domain_events_2029_06"]);
    for (const partition of ensured) {
      expect(await partitionBrinOptions(partition)).toEqual(["autosummarize=on"]);
    }
    expect(await brinIndexesWithoutAutosummarize()).toEqual([]);
  });

  it("leaves a locked partition's switch to the next run instead of failing the job", async () => {
    const partition = "domain_events_2029_09";
    // A partition made by hand clones the parent's plain BRIN, as one created
    // before 0264 or by any other path would.
    await harness.pool.query(`
      create table ${partition} partition of domain_events
      for values from ('2029-09-01') to ('2029-10-01')
    `);
    expect(await partitionBrinOptions(partition)).toBeNull();

    // A reader holds ACCESS SHARE on the partition's indexes until it ends.
    const readerPool = createPool(harness.connectionString);
    const reader = await readerPool.connect();
    try {
      await reader.query("begin");
      await reader.query(`select * from ${partition} limit 1`);

      const ensured = await ensureDomainEventPartitions(harness.db, {
        now: new Date("2029-09-01T00:00:00.000Z"),
        monthsAhead: 0,
      });
      expect(ensured).toEqual([partition]);
      expect(await partitionBrinOptions(partition)).toBeNull();
    } finally {
      await reader.query("rollback");
      reader.release();
      await readerPool.end();
    }

    await ensureDomainEventPartitions(harness.db, {
      now: new Date("2029-09-01T00:00:00.000Z"),
      monthsAhead: 0,
    });
    expect(await partitionBrinOptions(partition)).toEqual(["autosummarize=on"]);
  }, 30_000);

  it("waits out a reader in 1 s slices when 0264 switches an existing index", async () => {
    const partition = "domain_events_2030_01";
    await harness.pool.query(`
      create table ${partition} partition of domain_events
      for values from ('2030-01-01') to ('2030-02-01')
    `);
    // 0264's first statement generates one bounded-wait switch per BRIN
    // index still without the option; this partition's is the only one.
    const migration = await readFile("packages/db/migrations/0264_brin_autosummarize.sql", "utf8");
    const statements = migration.split("-- agency-hub:statement").slice(1).map((part) => part.trim());
    expect(statements).toHaveLength(2);
    const generator = statements[0]!.replace("-- agency-hub:execute-returned-statements", "");
    const generated = await harness.pool.query<{ statement: string }>(generator);
    expect(generated.rows).toHaveLength(1);
    expect(generated.rows[0]!.statement).toContain(`alter index public.${partition}_created_at_idx set (autosummarize = on)`);

    const readerPool = createPool(harness.connectionString);
    const reader = await readerPool.connect();
    try {
      await reader.query("begin");
      await reader.query(`select * from ${partition} limit 1`);
      const switching = harness.pool.query(generated.rows[0]!.statement);
      // Two lock waits time out while the reader holds the index.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(await partitionBrinOptions(partition)).toBeNull();
      await reader.query("commit");
      await switching;
    } finally {
      reader.release();
      await readerPool.end();
    }
    expect(await partitionBrinOptions(partition)).toEqual(["autosummarize=on"]);

    // Its second statement summarizes whatever every BRIN index holds unsummarized.
    const summarize = statements[1]!.replace("-- agency-hub:execute-returned-statements", "");
    const summaries = await harness.pool.query<{ statement: string }>(summarize);
    expect(summaries.rows.length).toBeGreaterThan(1);
    for (const { statement } of summaries.rows) {
      expect(statement).toMatch(/^select brin_summarize_new_values\('public\.[a-z0-9_]+'::regclass\)$/);
      await harness.pool.query(statement);
    }
  }, 60_000);
});
