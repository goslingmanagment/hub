import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  finishSyncRun,
  getLatestSyncRunPerPage,
  startSyncRun,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  // Physical: a case asserts plan nodes and buffers after ANALYZE.
  await resetIntegrationDatabase(testDb.pool, { physical: true });
});

// The lateral `limit 1` rewrite must return exactly what `distinct on (page_id)
// ... order by page_id, started_at desc, id desc` returned — including the
// `id desc` tiebreak when two runs share a `started_at`.
describe("getLatestSyncRunPerPage", () => {
  it("returns the newest run per page, breaking started_at ties by id", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = (await createModel(testDb.db, { slug: "lana", name: "Lana" }))!;
    const pageA = (await createFanslyPage(testDb.db, { modelId: model.id, label: "lana-1" }))!;
    const pageB = (await createFanslyPage(testDb.db, { modelId: model.id, label: "lana-2" }))!;
    const pageC = (await createFanslyPage(testDb.db, { modelId: model.id, label: "lana-3" }))!;

    const older = new Date("2026-03-24T10:00:00.000Z");
    const newer = new Date("2026-03-24T11:00:00.000Z");

    const staleA = (await startSyncRun(testDb.db, {
      platformAccountId: pageA.id,
      stream: "light",
      trigger: "scheduled",
      startedAt: older,
    }))!;
    await finishSyncRun(testDb.db, staleA.id, { status: "failed", errorSummary: "stale" });
    const latestA = (await startSyncRun(testDb.db, {
      platformAccountId: pageA.id,
      stream: "light",
      trigger: "scheduled",
      startedAt: newer,
    }))!;
    await finishSyncRun(testDb.db, latestA.id, { status: "success" });

    // Page B: two runs sharing `started_at` — the higher id must win.
    const tieLow = (await startSyncRun(testDb.db, {
      platformAccountId: pageB.id,
      stream: "light",
      trigger: "scheduled",
      startedAt: newer,
    }))!;
    await finishSyncRun(testDb.db, tieLow.id, { status: "failed", errorSummary: "tie-low" });
    const tieHigh = (await startSyncRun(testDb.db, {
      platformAccountId: pageB.id,
      stream: "light",
      trigger: "scheduled",
      startedAt: newer,
    }))!;
    await finishSyncRun(testDb.db, tieHigh.id, { status: "success" });

    // A newer run on ANOTHER stream must not shadow the light-stream answer.
    const followersB = (await startSyncRun(testDb.db, {
      platformAccountId: pageB.id,
      stream: "followers",
      trigger: "scheduled",
      startedAt: new Date("2026-03-24T12:00:00.000Z"),
    }))!;
    await finishSyncRun(testDb.db, followersB.id, { status: "success" });

    // Page C has no runs at all: the lateral join must simply drop it.
    const rows = await getLatestSyncRunPerPage(
      testDb.db,
      [pageA.id, pageB.id, pageC.id],
      { stream: "light" },
    );

    const byPage = new Map(rows.map((row) => [row.platformAccountId, row]));
    expect([...byPage.keys()].sort((a, b) => a - b)).toEqual([pageA.id, pageB.id]);
    expect(byPage.get(pageA.id)).toMatchObject({
      runId: latestA.id,
      stream: "light",
      status: "success",
      trigger: "scheduled",
      errorSummary: null,
    });
    expect(byPage.get(pageA.id)?.startedAt.toISOString()).toBe(newer.toISOString());
    expect(byPage.get(pageB.id)).toMatchObject({
      runId: tieHigh.id,
      stream: "light",
      status: "success",
    });

    // Scoping still bites: a page id outside the list is never returned.
    const scoped = await getLatestSyncRunPerPage(testDb.db, [pageB.id], { stream: "light" });
    expect(scoped.map((row) => row.runId)).toEqual([tieHigh.id]);

    expect(await getLatestSyncRunPerPage(testDb.db, [], { stream: "light" })).toEqual([]);
    expect(await getLatestSyncRunPerPage(testDb.db, [pageC.id], { stream: "light" })).toEqual([]);
  });

  it("reads a fraction of the blocks the `distinct on` query read", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = (await createModel(testDb.db, { slug: "lana", name: "Lana" }))!;
    const pages = [];
    for (let index = 0; index < 8; index += 1) {
      pages.push((await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: `lana-${index}`,
      }))!);
    }
    const pageIds = pages.map((page) => page.id);

    // Prod shape: 8 pages x 3 streams x 500 runs — the `light` slice alone is
    // 4 000 rows, and the old `distinct on (page_id)` had to read and sort all
    // of it to return 8 rows.
    await testDb.pool.query(
      `insert into sync_runs (page_id, stream, outcome, source, started_at)
       select p.page_id,
              s.stream::sync_stream,
              'succeeded',
              'scheduled',
              timestamptz '2026-03-24T00:00:00Z' + (n || ' seconds')::interval
       from unnest($1::bigint[]) as p(page_id)
       cross join unnest(array['light', 'followers', 'transactions']) as s(stream)
       cross join generate_series(1, 500) as n`,
      [pageIds],
    );
    await testDb.pool.query("analyze sync_runs");

    async function measure(query: string, params: unknown[]) {
      const explained = await testDb!.pool.query<{ "QUERY PLAN": unknown }>(
        `explain (analyze, buffers, format json) ${query}`,
        params,
      );
      const root = (explained.rows[0]!["QUERY PLAN"] as Array<Record<string, never>>)[0]!;
      const plan = root["Plan"] as unknown as Record<string, number>;
      const text = JSON.stringify(root);
      return {
        blocks: (plan["Shared Hit Blocks"] ?? 0) + (plan["Shared Read Blocks"] ?? 0),
        rows: plan["Actual Rows"] ?? 0,
        text,
      };
    }

    const legacy = await measure(
      `select distinct on (sync_runs.page_id)
              sync_runs.page_id, sync_runs.id, sync_runs.started_at
       from sync_runs
       where sync_runs.page_id = any($1::bigint[])
         and sync_runs.stream = $2
       order by sync_runs.page_id, sync_runs.started_at desc, sync_runs.id desc`,
      [pageIds, "light"],
    );
    const lateral = await measure(
      `select latest.*
       from unnest($1::bigint[]) as scoped(page_id)
       cross join lateral (
         select sync_runs.page_id, sync_runs.id, sync_runs.started_at
         from sync_runs
         where sync_runs.page_id = scoped.page_id
           and sync_runs.stream = $2
         order by sync_runs.started_at desc, sync_runs.id desc
         limit 1
       ) as latest`,
      [pageIds, "light"],
    );

    expect(legacy.rows).toBe(pages.length);
    expect(lateral.rows).toBe(pages.length);
    expect(lateral.text).not.toContain("Seq Scan");
    // The old plan reads the whole `light` slice; the new one probes per page.
    expect(lateral.blocks * 4).toBeLessThan(legacy.blocks);

    // And it still answers correctly on that fixture: one row per page.
    const rows = await getLatestSyncRunPerPage(testDb.db, pageIds, { stream: "light" });
    expect(rows).toHaveLength(pages.length);
    expect(rows.every((row) => row.stream === "light")).toBe(true);
    expect(
      rows.every((row) => row.startedAt.toISOString() === "2026-03-24T00:08:20.000Z"),
    ).toBe(true);
  });
});
