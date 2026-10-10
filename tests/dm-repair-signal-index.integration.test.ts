import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createModel, createOnlyFansPage, listDmRepairSignalRows } from "@agency_hub_core/db";

import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// 0265: the corrections reconciler's work list (listDmRepairSignalRows) reads
// pending rows in id order from a partial index on (id) whose predicate is the
// list's own. 0076's (platform_account_id, id) index could not give that order,
// and the planner priced `is distinct from` at ~99.5% of the rows, so it walked
// the whole archive by primary key every minute (prod: 100 037 rows, 45 428
// buffers) for a list that is empty in the steady state.

let harness: StartedTestDatabase;
let pageId = 0;
let message = 0;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) {
    throw new Error("Docker-backed Postgres is required for this integration test");
  }
  harness = started;
  const model = await createModel(harness.db, { slug: "repair-index", name: "Repair Index" });
  pageId = (await createOnlyFansPage(harness.db, { modelId: model!.id, label: "repair-index" }))!.id;
  // The steady state: every row's ledger caught up with its material.
  await archive(3000, { material: "\\x01", emitted: "\\x01" });
  await harness.pool.query("analyze dm_message_archive");
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

async function archive(count: number, fingerprints: { material: string | null; emitted: string | null }) {
  const result = await harness.pool.query<{ id: string }>(`
    insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_message_id,
      source, source_event_type, source_idempotency_key, source_received_at, retain_until,
      material_fingerprint, emitted_fingerprint)
    select 'onlyfans', $1, 'acct_repair', 'm' || ($2 + n), 'webhook', 'messages.received',
      'repair-' || ($2 + n), now(), now() + interval '1 year', $3::bytea, $4::bytea
    from generate_series(1, $5) n
    returning id::text as id
  `, [pageId, message, fingerprints.material, fingerprints.emitted, count]);
  message += count;
  return result.rows.map((row) => Number(row.id)).sort((a, b) => a - b);
}

/** EXPLAIN ANALYZE of the statement the repository itself sends. */
async function planOf(input: Parameters<typeof listDmRepairSignalRows>[1]) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const pool = harness.pool as unknown as { query: (config: unknown, values?: unknown) => Promise<unknown> };
  const original = pool.query.bind(pool);
  pool.query = (config, values) => {
    const text = typeof config === "string" ? config : (config as { text?: string }).text;
    if (typeof text === "string" && text.includes("dm_message_archive")) {
      statements.push({ text, values: (values as unknown[] | undefined) ?? (config as { values?: unknown[] }).values ?? [] });
    }
    return original(config, values);
  };
  try {
    await listDmRepairSignalRows(harness.db, input);
  } finally {
    pool.query = original;
  }
  expect(statements).toHaveLength(1);
  const plan = await harness.pool.query<{ "QUERY PLAN": string }>(
    `explain (analyze, buffers) ${statements[0]!.text}`,
    statements[0]!.values,
  );
  return plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

describe("the corrections work list's index (0265)", () => {
  it("is the only repair-signal index, with the work list's predicate", async () => {
    const result = await harness.pool.query<{ indexname: string; indexdef: string }>(`
      select indexname, indexdef from pg_indexes
      where tablename = 'dm_message_archive' and indexname like '%repair_signal%'
    `);
    expect(result.rows).toEqual([{
      indexname: "dm_message_archive_repair_signal_id_idx",
      indexdef: "CREATE INDEX dm_message_archive_repair_signal_id_idx ON public.dm_message_archive USING btree (id) "
        + "WHERE ((material_fingerprint IS DISTINCT FROM emitted_fingerprint) AND (material_fingerprint IS NOT NULL))",
    }]);
    const migration = await readFile("packages/db/migrations/0265_dm_archive_repair_signal_by_id.sql", "utf8");
    expect(migration).toContain("where material_fingerprint is distinct from emitted_fingerprint and material_fingerprint is not null;");
  });

  it("serves an empty work list without walking the archive", async () => {
    expect(await listDmRepairSignalRows(harness.db, {})).toEqual([]);
    const plan = await planOf({});
    expect(plan).toContain("dm_message_archive_repair_signal_id_idx");
    expect(plan).not.toContain("dm_message_archive_pkey");
    expect(plan).not.toMatch(/Rows Removed by Filter: [1-9]/);
  });

  it("returns the pending rows in id order, after the cursor, as before", async () => {
    const advanced = await archive(3, { material: "\\x02", emitted: "\\x01" });
    const never = await archive(2, { material: "\\x03", emitted: null });
    await archive(2, { material: null, emitted: "\\x01" }); // refless stubs stay out
    const pending = [...advanced, ...never].sort((a, b) => a - b);

    expect((await listDmRepairSignalRows(harness.db, {})).map((row) => row.id)).toEqual(pending);
    expect((await listDmRepairSignalRows(harness.db, { limit: 2 })).map((row) => row.id)).toEqual(pending.slice(0, 2));
    expect((await listDmRepairSignalRows(harness.db, { afterId: pending[1]! })).map((row) => row.id))
      .toEqual(pending.slice(2));
    expect(await planOf({ afterId: pending[1]! })).toContain("dm_message_archive_repair_signal_id_idx");
  });
});
