import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  countArchiveCoverageGaps,
  createModel,
  createOnlyFansPage,
  deleteExpiredSyncObservability,
  ensurePageSyncStates,
  startSyncRun,
  finishSyncRun,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  isPageDmPruneAllowed,
  resetPageDmPruneCoverageCache,
} from "../apps/runtime/src/services/page-dm-retention.ts";
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
  resetPageDmPruneCoverageCache();
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

describe("archive-coverage-gated prune (Stage 28)", () => {
  async function seedHotMessage(pageId: number, opts: { archived: boolean }) {
    const thread = await testDb!.pool.query<{ id: string }>(
      `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id)
       values ($1, 'conv-1', 'fan-9') returning id::text as id`,
      [pageId],
    );
    await testDb!.pool.query(
      `insert into page_dm_messages (platform_account_id, conversation_id, platform_message_id,
                                     sender_role, content, created_at, total_tip_amount_cents)
       values ($1, $2, 'msg-1', 'fan', 'hello', now(), 0)`,
      [pageId, Number(thread.rows[0]!.id)],
    );
    if (opts.archived) {
      await testDb!.pool.query(
        `insert into message_archive (account_id, platform, conversation_ref, message_ref,
                                      fan_native_id, sender_role, is_sent_by_me, occurred_at,
                                      text_plain, tip_amount_mills, is_tip, backfill_source)
         values ($1, 'onlyfans', 'conv-1', 'msg-1', 'fan-9', 'fan', false, now(), 'hello', 0, false, 'hot_table')`,
        [pageId],
      );
    }
  }

  it("prune stays OFF while any hot message is uncovered; opens once the archive covers it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage("retention-prune");
    appContext.config.pageDmPruneEnabled = true;
    await seedHotMessage(page.id, { archived: false });

    expect(await countArchiveCoverageGaps(appContext.db)).toBe(1);
    expect(await isPageDmPruneAllowed(appContext)).toBe(false);

    // Archive catches up → the gate opens (cache reset simulates TTL expiry).
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref,
                                    fan_native_id, sender_role, is_sent_by_me, occurred_at,
                                    text_plain, tip_amount_mills, is_tip, backfill_source)
       values ($1, 'onlyfans', 'conv-1', 'msg-1', 'fan-9', 'fan', false, now(), 'hello', 0, false, 'hot_table')`,
      [page.id],
    );
    resetPageDmPruneCoverageCache();
    expect(await countArchiveCoverageGaps(appContext.db)).toBe(0);
    expect(await isPageDmPruneAllowed(appContext)).toBe(true);

    // Kill-switch semantics survive one release: flag off wins regardless.
    appContext.config.pageDmPruneEnabled = false;
    resetPageDmPruneCoverageCache();
    expect(await isPageDmPruneAllowed(appContext)).toBe(false);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
