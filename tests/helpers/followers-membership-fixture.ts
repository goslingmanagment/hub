import { vi } from "vitest";
import {
  findPageById,
  listPageSyncStates,
  startSyncRun,
  upsertCheckpointProgress,
  upsertFans,
  upsertPageFollow,
} from "@agency_hub_core/db";
import { executeFollowersReconcileChunk } from "../../apps/runtime/src/services/sync/executor-handlers.ts";
import { SyncChunkBudget } from "../../apps/runtime/src/services/sync/chunk-budget.ts";
import { SyncRunTelemetry } from "../../apps/runtime/src/services/sync/observability.ts";
import type { StartedTestDatabase } from "./db.ts";
import { followersDiagnosticFixture } from "./followers-diagnostic-fixture.ts";

export const MEMBERSHIP_START = new Date("2026-09-01T12:00:00.000Z");

export async function followersMembershipFixture(db: StartedTestDatabase, sourceCount = 2) {
  const { app, page } = await followersDiagnosticFixture(db);
  const rows = [
    { id: "current", generation: 10, touched: false, active: true },
    { id: "inactive", generation: 10, touched: false, active: false },
    { id: "old", generation: 8, touched: false, active: true },
    { id: "old-null", generation: null, touched: false, active: true },
    { id: "grace", generation: 9, touched: false, active: true },
    { id: "touch", generation: 8, touched: true, active: true },
    { id: "touch-null", generation: null, touched: true, active: true },
    { id: "both", generation: 9, touched: true, active: true },
    { id: "future", generation: 11, touched: false, active: true },
  ];
  for (const row of rows) {
    const [fan] = await upsertFans(db.db, [{ platform: "fansly", platformUserId: row.id }]);
    if (!fan) throw new Error("membership fan seed failed");
    await upsertPageFollow(db.db, {
      platformAccountId: page.id, fanId: fan.id, platformFollowId: row.id,
      followedAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    await db.pool.query(`update page_follows set last_seen_generation = $1, is_active = $2,
      first_seen_at = $3::timestamptz - interval '1 day', last_seen_at = $4
      where platform_account_id = $5 and platform_follow_id = $6`, [
      row.generation, row.active, MEMBERSHIP_START,
      new Date(MEMBERSHIP_START.getTime() - (row.touched ? 0 : 1)), page.id, row.id,
    ]);
  }
  app.adapter.getAccountMe = vi.fn(async () => ({
    parsed: { account: {
      id: "account-1", username: "fixture", displayName: "Fixture",
      createdAt: 1_770_000_000_000, followCount: sourceCount, subscriberCount: 0,
      earningsWallet: null, walls: [], subscriptionTiers: [],
    } },
    raw: {},
  }));
  const state = (await listPageSyncStates(db.db, { pageId: page.id }))
    .find(row => row.stream === "followers_reconcile");
  const stored = await findPageById(db.db, page.id);
  const run = await startSyncRun(db.db, {
    platformAccountId: page.id, stream: "followers_reconcile", trigger: "manual",
  });
  if (!state || !stored || !run) throw new Error("membership run seed failed");
  await upsertCheckpointProgress(db.db, {
    platformAccountId: page.id, stream: "followers_reconcile",
    state: {
      revision: state.requestSeq, generation: 10, fullSweepStartedAt: MEMBERSHIP_START.toISOString(),
      offset: 0, observedCount: 2, pageCount: 1, sourceFollowerCount: sourceCount,
      snapshotRestartCount: sourceCount === 2 ? 0 : 2, verificationPending: true,
      restartReason: sourceCount === 2 ? null : "snapshot_mismatch",
    },
  });
  const telemetry = new SyncRunTelemetry(app, {
    runId: run.id, platformAccountId: page.id, pageLabel: page.label,
    provider: "fansly", stream: "followers_reconcile", trigger: "manual", egressKey: "direct",
  });
  const execute = async () => {
    const result = await executeFollowersReconcileChunk(app, {
      pageContext: {
        platform: "fansly", page: { ...stored.page, platformAccountId: "account-1" },
        session: { authorization: "test-token" }, proxy: null, egressKey: "direct",
      },
      streamState: { ...state, platform: "fansly", proxyUrl: null, egressKey: "direct" },
      syncRunId: run.id, telemetry, budget: new SyncChunkBudget(1),
    });
    // Exercise the handler and reader; executor lease/CAS completion has separate tests.
    await telemetry.finish(result.satisfied ? "success" : "partial");
    return result;
  };
  return { app, page, run, execute };
}
