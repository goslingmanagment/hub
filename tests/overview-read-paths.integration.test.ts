import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
} from "@agency_hub_core/db";

import { listConnectionStatuses } from "../apps/runtime/src/services/connections.ts";
import { getSyncStatusSnapshot } from "../apps/runtime/src/services/sync-status.ts";
import { getSyncStatusSummarySnapshot } from "../apps/runtime/src/services/sync-summary.ts";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;

async function pageSyncStateFingerprint() {
  const result = await testDb!.pool.query<{ rows: number; fingerprint: string | null }>(`
    select count(*)::int as rows,
           md5(coalesce(string_agg(
             page_id || ':' || stream || ':' || updated_at, ',' order by page_id, stream
           ), '')) as fingerprint
    from page_sync_states
  `);
  return result.rows[0]!;
}

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
  await resetIntegrationDatabase(testDb.pool);
});

// Read paths never seed (PR 2): GET /overview and the Sidebar's
// /admin/connections used to run ensurePageSyncStates per page on every
// dashboard load, writing to `page_sync_states` from a GET. Seeding and legacy
// repair stay in the planner tick, the executor and the explicit admin paths.
describe("overview read paths", () => {
  it("report a page that has no sync-state rows without creating any", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const app = createTestAppContext(testDb);
    const model = (await createModel(testDb.db, { slug: "lana", name: "Lana" }))!;
    const page = (await createFanslyPage(testDb.db, { modelId: model.id, label: "lana-1" }))!;

    expect((await pageSyncStateFingerprint()).rows).toBe(0);

    const summary = await getSyncStatusSummarySnapshot(app, { pageIds: [page.id] });
    expect(summary.pages.map((p) => p.pageId)).toEqual([page.id]);
    expect(summary.pages[0]?.syncUx).toBeDefined();
    expect((await pageSyncStateFingerprint()).rows).toBe(0);

    const status = await getSyncStatusSnapshot(app, { pageIds: [page.id] });
    expect(status.pages.map((p) => p.pageId)).toEqual([page.id]);
    expect((await pageSyncStateFingerprint()).rows).toBe(0);

    const connections = await listConnectionStatuses(app);
    expect(connections.map((c) => c.id)).toEqual([page.id]);
    expect((await pageSyncStateFingerprint()).rows).toBe(0);
  });

  it("leave existing sync-state rows untouched — no repair writes on a GET", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const app = createTestAppContext(testDb);
    const model = (await createModel(testDb.db, { slug: "lana", name: "Lana" }))!;
    const pageA = (await createFanslyPage(testDb.db, { modelId: model.id, label: "lana-1" }))!;
    const pageB = (await createFanslyPage(testDb.db, { modelId: model.id, label: "lana-2" }))!;
    await ensurePageSyncStates(testDb.db, { pageId: pageA.id });
    await ensurePageSyncStates(testDb.db, { pageId: pageB.id });

    const before = await pageSyncStateFingerprint();
    expect(before.rows).toBeGreaterThan(0);

    // Unscoped (the /overview shape) and scoped (the /admin/connections shape).
    await getSyncStatusSummarySnapshot(app);
    await getSyncStatusSummarySnapshot(app, { pageIds: [pageA.id] });
    await getSyncStatusSnapshot(app);
    await listConnectionStatuses(app);

    expect(await pageSyncStateFingerprint()).toEqual(before);
  });
});
