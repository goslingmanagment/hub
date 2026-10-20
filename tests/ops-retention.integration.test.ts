import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  deleteExpiredSyncObservability,
  ensurePageSyncStates,
  startSyncRun,
  finishSyncRun,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;

async function seedPage(label = "retention-of") {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label });
  await ensurePageSyncStates(appContext.db, { pageId: page.id });
  return page;
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
  appContext = createTestAppContext(testDb);
});

describe("ops telemetry retention (Stage 28)", () => {
  it("the observability sweep now bounds sync_runs — old finished rows go, running rows stay", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage();
    const oldFinished = await startSyncRun(appContext.db, {
      platformAccountId: page.id,
      stream: "light",
      trigger: "manual",
    });
    await finishSyncRun(appContext.db, oldFinished.id, {
      status: "success",
      stats: {},
    });
    const oldRunning = await startSyncRun(appContext.db, {
      platformAccountId: page.id,
      stream: "transactions",
      trigger: "manual",
    });
    const fresh = await startSyncRun(appContext.db, {
      platformAccountId: page.id,
      stream: "subscribers",
      trigger: "manual",
    });
    await finishSyncRun(appContext.db, fresh.id, { status: "success", stats: {} });

    // Age the first two beyond the 30-day cutoff.
    await testDb.pool.query(
      `update sync_runs set started_at = now() - interval '40 days',
              finished_at = case when finished_at is null then null else now() - interval '40 days' end
       where id = any($1::bigint[])`,
      [[oldFinished.id, oldRunning.id]],
    );

    await deleteExpiredSyncObservability(
      appContext.db,
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    );

    const { rows } = await testDb.pool.query<{ id: string }>(
      "select id::text as id from sync_runs order by id",
    );
    const surviving = rows.map((row) => Number(row.id));
    expect(surviving).not.toContain(oldFinished.id);
    // A wedged run is diagnostic evidence — never swept while 'running'.
    expect(surviving).toContain(oldRunning.id);
    expect(surviving).toContain(fresh.id);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
