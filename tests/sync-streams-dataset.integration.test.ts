import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { queryAgentDataset, setPagePause, upsertDemand, type Database } from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { seedSyncPage } from "./helpers/sync-engine-host.ts";

/**
 * The agent dataset `sync_streams` (design step 3 §3.2 item 6) against a real
 * database: a page the Fansly Sync Engine owns (`handover`/`live`) reports
 * its streams from the engine's live journal — each registry key counted
 * under the legacy stream it took over — instead of its frozen
 * `page_sync_states`; every other page reads exactly as before.
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

async function legacyRows(pageId: number): Promise<void> {
  for (const [stream, status, failures] of [["light", "idle", 0], ["transactions", "retrying", 4]] as const) {
    await testDb!.pool.query(
      `insert into page_sync_states (page_id, stream, status, cadence_seconds, slot_offset_seconds, succeeded_at,
              failed_at, consecutive_failures, updated_at)
       values ($1, $2, $3, 3600, 0, '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z', $4, '2026-09-01T11:00:00Z')`,
      [pageId, stream, status, failures],
    );
  }
}

async function liveAttempt(
  pageId: number,
  resource: string,
  outcome: { appliedAgoS?: number; errorClass?: string; completedAgoS: number; applyState?: string },
): Promise<void> {
  const work = await upsertDemand(db(), { pageId, shadow: false, resource, kind: "poll", class: "planned" });
  await testDb!.pool.query(
    `insert into sync_attempts (page_id, shadow, work_id, resource, subject, class, owner_generation, setting_ms,
            jitter_u, pause_ms, operation, request, outcome, http_status, error_class, sent_at, completed_at,
            apply_state, applied_at)
     values ($1, false, $2, $3, '', 'planned', 1, 2500, 0.1, 2750, 'polls', '{}'::jsonb, 'response', 200, $4,
             clock_timestamp() - $5::double precision * interval '1 second',
             clock_timestamp() - $5::double precision * interval '1 second', $6,
             case when $7::double precision is null then null
                  else clock_timestamp() - $7::double precision * interval '1 second' end)`,
    [pageId, work.id, resource, outcome.errorClass ?? null, outcome.completedAgoS,
      outcome.applyState ?? (outcome.appliedAgoS === undefined ? "none" : "applied"), outcome.appliedAgoS ?? null],
  );
}

describe("the sync_streams dataset", () => {
  it("an engine page reads its streams from the live journal; a legacy page as before", async () => {
    const handles = { db: db(), pool: testDb!.pool };
    const engine = (await seedSyncPage(handles, { label: "lilly-1" })).pageId;
    const legacy = (await seedSyncPage(handles, { label: "ari-1", mode: "shadow" })).pageId;
    await legacyRows(engine);
    await legacyRows(legacy);
    const legacyBefore = await streams(legacy);
    expect([...legacyBefore.keys()].sort()).toEqual(["light", "transactions"]);
    // While the engine does not own it, the page reads its legacy rows.
    expect([...(await streams(engine)).keys()].sort()).toEqual(["light", "transactions"]);

    await testDb!.pool.query("update sync_pages set mode = 'live' where page_id = $1", [engine]);
    // transactions: an applied insurance read, a failed head read, a quarantined rescan.
    await liveAttempt(engine, "transactions.insurance", { appliedAgoS: 300, completedAgoS: 300 });
    await liveAttempt(engine, "transactions.head", { errorClass: "rate_limit", completedAgoS: 120 });
    await upsertDemand(db(), { pageId: engine, shadow: false, resource: "transactions.rescan", kind: "poll", class: "planned" });
    await testDb!.pool.query(
      "update sync_work set state = 'quarantined', failure_count = 2 where page_id = $1 and resource = 'transactions.rescan'",
      [engine],
    );
    // top_spenders: applied an hour ago, nothing wrong.
    await liveAttempt(engine, "top-spenders.window", { appliedAgoS: 3_600, completedAgoS: 3_600 });
    // A subject's final 404 is an answer, not a failure.
    await liveAttempt(engine, "top-spenders.bootstrap", { errorClass: "subject_terminal", completedAgoS: 60 });
    // subscribers: a read in flight.
    await upsertDemand(db(), { pageId: engine, shadow: false, resource: "subscribers.poll", kind: "poll", class: "planned" });
    await testDb!.pool.query("update sync_work set state = 'running' where page_id = $1 and resource = 'subscribers.poll'", [engine]);
    // followers: every key of the stream paused by the owner.
    await upsertDemand(db(), { pageId: engine, shadow: false, resource: "followers.head", kind: "poll", class: "planned" });
    await setPagePause(db(), { pageId: engine, resources: ["fan-profiles.lookup", "followers.head"] });
    // The shadow journal is not the page's any more.
    await upsertDemand(db(), { pageId: engine, shadow: true, resource: "notifications.forward", kind: "poll", class: "planned" });

    const rows = await streams(engine);
    expect([...rows.keys()].sort()).toEqual(["followers", "subscribers", "top_spenders", "transactions"]);
    const transactions = rows.get("transactions")!;
    expect(transactions).toMatchObject({ syncStatus: "failed", consecutiveFailures: 2 });
    expect(transactions.succeededAt).toEqual(transactions.cursorAt);
    const failedAt = new Date(String(transactions.failedAt)).getTime();
    const succeededAt = new Date(String(transactions.succeededAt)).getTime();
    expect(failedAt - succeededAt).toBeGreaterThan(150_000);
    const topSpenders = rows.get("top_spenders")!;
    expect(topSpenders).toMatchObject({ syncStatus: "ok", failedAt: null, consecutiveFailures: 0 });
    expect(topSpenders.succeededAt).not.toBeNull();
    expect(rows.get("subscribers")).toMatchObject({ syncStatus: "running", succeededAt: null });
    expect(rows.get("followers")).toMatchObject({ syncStatus: "paused" });

    // The legacy page is untouched by the engine page's switch.
    expect(await streams(legacy)).toEqual(legacyBefore);
  });
});
