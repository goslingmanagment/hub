import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_DATASET_SQL,
  createModel,
  createOnlyFansPage,
  queryAgentDataset,
  upsertDemand,
  type Database,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { seedSyncPage } from "./helpers/sync-engine-host.ts";

/**
 * The agent dataset `sync_streams` against a real database (step 4, S4-24):
 * it lists the legacy page-sync executor's stream rows, and that executor
 * serves OnlyFans only. A Fansly page has no row in it — not its parked
 * legacy rows, and not the Fansly Sync Engine's work dressed as streams (the
 * arm step 3 added): the engine's state is read through its own surfaces
 * (`agentSyncStatus`, `agentSyncWhy`). The source reads no engine table.
 */

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 180_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function streams(pageId: number) {
  const result = await queryAgentDataset(db(), {
    dataset: "sync_streams",
    pageId,
    from: new Date("2000-01-01T00:00:00Z"),
    to: new Date("2100-01-01T00:00:00Z"),
    filters: [],
    sort: null,
    limit: 100,
  });
  return new Map(result.rows.map((row) => [String(row.fields.stream), row.fields]));
}

async function seedOnlyFansPage(label: string): Promise<number> {
  const model = await createModel(db(), { slug: `model-${label}`, name: label });
  const page = await createOnlyFansPage(db(), { modelId: model!.id, label });
  return page!.id;
}

async function legacyRows(
  pageId: number,
  rows: ReadonlyArray<readonly [stream: string, status: string, failures: number, blocker: string | null]>,
): Promise<void> {
  for (const [stream, status, failures, blocker] of rows) {
    await testDb!.pool.query(
      `insert into page_sync_states (page_id, stream, status, cadence_seconds, slot_offset_seconds, succeeded_at,
              failed_at, consecutive_failures, blocker_kind, updated_at)
       values ($1, $2, $3, 3600, 0, '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z', $4, $5, '2026-09-01T11:00:00Z')`,
      [pageId, stream, status, failures, blocker],
    );
  }
}

/** A Fansly page's rows as step 4 (S4-21) parked them. */
const PARKED = [
  ["light", "paused", 0, "retired"],
  ["transactions", "paused", 4, "retired"],
  ["followers", "paused", 0, "retired"],
  ["dm_messages", "paused", 0, "retired"],
] as const;

describe("the sync_streams dataset", () => {
  it("lists an OnlyFans page's legacy stream rows, its retired record included, as before", async () => {
    const onlyfans = await seedOnlyFansPage("lora-of");
    await legacyRows(onlyfans, [
      ["light", "idle", 0, null],
      ["transactions", "retrying", 4, null],
      ["dm_messages", "paused", 0, "retired"],
    ]);
    await testDb!.pool.query(
      `insert into page_sync_cursors (page_id, stream, cursor_timestamp, state)
       values ($1, 'transactions', '2026-09-01T09:30:00Z', '{}'::jsonb)`,
      [onlyfans],
    );

    const rows = await streams(onlyfans);

    expect([...rows.keys()].sort()).toEqual(["dm_messages", "light", "transactions"]);
    expect(rows.get("light")).toMatchObject({ syncStatus: "idle", consecutiveFailures: 0, cursorAt: null });
    expect(rows.get("transactions")).toMatchObject({ syncStatus: "retrying", consecutiveFailures: 4 });
    expect(new Date(String(rows.get("transactions")!.cursorAt)).toISOString()).toBe("2026-09-01T09:30:00.000Z");
    expect(new Date(String(rows.get("transactions")!.succeededAt)).toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(new Date(String(rows.get("transactions")!.failedAt)).toISOString()).toBe("2026-09-01T11:00:00.000Z");
    expect(rows.get("dm_messages")).toMatchObject({ syncStatus: "paused" });
  });

  it("has no row of a Fansly page: not its parked legacy rows, and not the engine's live work", async () => {
    const handles = { db: db(), pool: testDb!.pool };
    const live = (await seedSyncPage(handles, { label: "lilly-1", mode: "live" })).pageId;
    const off = (await seedSyncPage(handles, { label: "ari-1", mode: "off" })).pageId;
    const shadow = (await seedSyncPage(handles, { label: "lora-1", mode: "shadow" })).pageId;
    const onlyfans = await seedOnlyFansPage("lora-of");
    for (const pageId of [live, off, shadow]) await legacyRows(pageId, PARKED);
    await legacyRows(onlyfans, [["light", "idle", 0, null]]);
    // The live page's engine is at work: a poll open, a read in flight, a row
    // in quarantine. None of it is a stream row any more.
    await upsertDemand(db(), { pageId: live, resource: "account.poll", kind: "poll", class: "planned" });
    await upsertDemand(db(), { pageId: live, resource: "subscribers.poll", kind: "poll", class: "planned" });
    await testDb!.pool.query("update sync_work set state = 'running' where page_id = $1 and resource = 'subscribers.poll'", [live]);
    await upsertDemand(db(), { pageId: live, resource: "transactions.rescan", kind: "poll", class: "planned" });
    await testDb!.pool.query(
      "update sync_work set state = 'quarantined', waiting_reason = 'quarantined' where page_id = $1 and resource = 'transactions.rescan'",
      [live],
    );

    for (const pageId of [live, off, shadow]) expect([...(await streams(pageId)).keys()]).toEqual([]);
    // The other platform's page beside them is listed as ever.
    expect([...(await streams(onlyfans)).keys()]).toEqual(["light"]);
  });

  it("reads the legacy rows alone: the engine's journal is no part of the source", async () => {
    const source = AGENT_DATASET_SQL.sync_streams!.source;
    expect(source).toContain("where p.platform::text in ('onlyfans')");
    const onlyfans = await seedOnlyFansPage("lora-of");
    await legacyRows(onlyfans, [["light", "idle", 0, null]]);
    const result = await testDb!.pool.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
      `explain (analyze, format json) with src as (${source}) select * from src where src.k_page_id = $1`,
      [onlyfans],
    );
    const relations = new Set<string>();
    const visit = (node: PlanNode): void => {
      if (node["Relation Name"] !== undefined) relations.add(node["Relation Name"]);
      for (const child of node.Plans ?? []) visit(child);
    };
    visit(result.rows[0]!["QUERY PLAN"][0]!.Plan);
    expect([...relations].sort()).toEqual(["page_sync_cursors", "page_sync_states", "pages"]);
  });
});

interface PlanNode {
  "Relation Name"?: string;
  Plans?: PlanNode[];
}
