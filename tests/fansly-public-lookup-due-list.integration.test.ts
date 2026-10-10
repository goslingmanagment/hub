import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, pickFanslyPublicLookupBatch } from "@agency_hub_core/db";

import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// pickFanslyPublicLookupBatch's page_lookup_miss demand reads `page_fans where
// account_probe_resolved is false`. Written as `= false`, the planner priced it
// as NOT x, 1 - P(true), ignoring that ~99% of the column is null: 71 520 rows
// expected for 51 on prod, which hash-joined every Fansly fan (317 ms a run).
// IS FALSE picks the same rows, is priced from the column's frequencies, and
// matches 0267's partial index.

let harness: StartedTestDatabase;
let pageId = 0;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) {
    throw new Error("Docker-backed Postgres is required for this integration test");
  }
  harness = started;
  const model = await createModel(harness.db, { slug: "lookup-due", name: "Lookup Due" });
  pageId = (await createFanslyPage(harness.db, { modelId: model!.id, label: "lookup-due" }))!.id;
  // 6 000 Fansly fans, a page_fans row each, as prod's shape: the probe answer
  // is null for nearly all, true for some, false for a few dozen.
  await harness.pool.query(`
    insert into fans (platform, platform_user_id, username, public_checked_at, public_found)
    select 'fansly', (900000000000 + n)::text, 'fan' || n, checked, case when checked is not null then true end
    from generate_series(1, 6000) n
    cross join lateral (select case when n % 7 = 0 then now() - interval '30 days'
      when n % 5 = 0 then now() - interval '1 day' end as checked) c
  `);
  await harness.pool.query(`
    insert into page_fans (fan_id, platform_account_id, account_probe_at, account_probe_resolved)
    select f.id, $1, now() - (n % 50) * interval '1 hour',
      case when n % 149 = 0 then false when n % 40 = 0 then true end
    from (select id, row_number() over (order by id) as n from fans where platform = 'fansly') f
  `, [pageId]);
  await harness.pool.query("vacuum analyze fans");
  await harness.pool.query("vacuum analyze page_fans");
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

/** The fans the page_lookup_miss demand names, as `= false` named them. */
async function legacyMisses(): Promise<Set<number>> {
  const result = await harness.pool.query<{ fan_id: string }>(`
    select pf.fan_id::text as fan_id from page_fans pf
    join fans f on f.id = pf.fan_id
    where pf.account_probe_resolved = false
      and f.platform = 'fansly' and f.platform_user_id ~ '^[0-9]{1,30}$'
      and (f.public_checked_at is null or f.public_checked_at < now() - interval '7 days')
  `);
  return new Set(result.rows.map((row) => Number(row.fan_id)));
}

describe("the public lookup's due list", () => {
  it("names the same fans as before", async () => {
    const batch = await pickFanslyPublicLookupBatch(harness.db, {
      limit: 1000,
      recheckBefore: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    });
    const misses = await legacyMisses();
    expect(misses.size).toBeGreaterThan(10);
    expect(new Set(batch.map((candidate) => candidate.fanId))).toEqual(misses);
    expect(batch.every((candidate) => candidate.demands.includes("page_lookup_miss"))).toBe(true);
  });

  it("reads the misses from 0267's partial index, priced at the rows that match", async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const pool = harness.pool as unknown as { query: (config: unknown, values?: unknown) => Promise<unknown> };
    const original = pool.query.bind(pool);
    pool.query = (config, values) => {
      const text = typeof config === "string" ? config : (config as { text?: string }).text;
      if (typeof text === "string" && text.includes("page_lookup_miss")) {
        statements.push({ text, values: (values as unknown[] | undefined) ?? (config as { values?: unknown[] }).values ?? [] });
      }
      return original(config, values);
    };
    try {
      await pickFanslyPublicLookupBatch(harness.db, { limit: 20, recheckBefore: new Date(Date.now() - 7 * 86_400_000) });
    } finally {
      pool.query = original;
    }
    expect(statements).toHaveLength(1);
    const plan = await harness.pool.query<{ "QUERY PLAN": string }>(
      `explain (analyze) ${statements[0]!.text}`,
      statements[0]!.values,
    );
    const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(text).toContain("page_fans_account_probe_unresolved_idx");
    expect(text).not.toContain("Seq Scan on page_fans");
    // The estimate is the matching rows', not the table's.
    const estimate = /Index Only Scan using page_fans_account_probe_unresolved_idx[^\n]*rows=(\d+)/.exec(text);
    expect(Number(estimate?.[1])).toBeLessThan(200);
  });

  it("keeps the query's predicate and the index's identical", async () => {
    const source = await readFile("packages/db/src/repositories/fansly-public-lookup.ts", "utf8");
    expect(source).toContain("where pf.account_probe_resolved is false");
    const index = await harness.pool.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where indexname = 'page_fans_account_probe_unresolved_idx'",
    );
    expect(index.rows[0]?.indexdef).toBe(
      "CREATE INDEX page_fans_account_probe_unresolved_idx ON public.page_fans USING btree (fan_id) "
        + "INCLUDE (account_probe_at) WHERE (account_probe_resolved IS FALSE)",
    );
  });
});
