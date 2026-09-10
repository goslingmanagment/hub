import { vi } from "vitest";
import {
  createFanslyPage, createModel, ensurePageSyncStates, findPageById,
  startSyncRun, upsertCheckpointProgress,
} from "@agency_hub_core/db";
import { executeFollowersChunk } from "../../apps/runtime/src/services/sync/executor-handlers.ts";
import { SyncChunkBudget } from "../../apps/runtime/src/services/sync/chunk-budget.ts";
import { SyncRunTelemetry } from "../../apps/runtime/src/services/sync/observability.ts";
import type { StartedTestDatabase } from "./db.ts";
import { createTestAppContext } from "./runtime.ts";

export async function followersDiagnosticFixture(
  db: StartedTestDatabase, mode: "none" | "count" | "missing" | "unchanged" = "none",
) {
  const known = mode === "missing" || mode === "unchanged" ? "1001" : null;
  const items = [{ id: "1000", followerId: "fan-1", lastSeenAt: Date.now() }];
  if (mode === "unchanged") items.push({ id: "1001", followerId: "fan-2", lastSeenAt: Date.now() });
  const accounts = items.map(row => ({
    id: row.followerId, username: row.followerId, displayName: "Fan",
    createdAt: 1_770_000_000_000, lastSeenAt: row.lastSeenAt,
  }));
  const getFollowersPage = vi.fn(async () => ({
    items, accounts, done: mode !== "unchanged", raw: { data: items, aggregationData: { accounts } },
  }));
  const app = createTestAppContext(db, { adapter: { getFollowersPage } as never });
  const model = await createModel(db.db, { slug: "followers-diagnostic", name: "Followers" });
  if (!model) throw new Error("model seed failed");
  const page = await createFanslyPage(db.db, { modelId: model.id, label: "followers-diagnostic" });
  if (!page) throw new Error("page seed failed");
  await ensurePageSyncStates(db.db, { pageId: page.id });
  await upsertCheckpointProgress(db.db, {
    platformAccountId: page.id, stream: "followers", state: {
      revision: 1, knownFollowId: known, newestFollowId: mode === "unchanged" ? known : null,
      offset: 0, pageCount: 0, sourceFollowerCount: mode === "count" ? 2 : 1,
    },
  });
  const stored = await findPageById(db.db, page.id);
  const run = await startSyncRun(db.db, { platformAccountId: page.id, stream: "followers", trigger: "manual" });
  if (!stored || !run) throw new Error("run seed failed");
  const telemetry = new SyncRunTelemetry(app, {
    runId: run.id, platformAccountId: page.id, pageLabel: page.label, provider: "fansly",
    stream: "followers", trigger: "manual", egressKey: "direct",
  });
  const queue = async () => (await db.pool.query(
    "select request_seq::text from page_sync_states where page_id = $1 and stream = 'followers_reconcile'",
    [page.id],
  )).rows[0].request_seq;
  const runChunk = async () => {
    const result = await executeFollowersChunk(app, {
      pageContext: {
        ...stored, platform: "fansly", page: { ...stored.page, platformAccountId: "account-1" },
        session: { authorization: "test-token" }, proxy: null, egressKey: "direct",
      },
      streamState: { requestSeq: 1 }, syncRunId: run.id, telemetry,
      budget: new SyncChunkBudget(10),
    } as never);
    await telemetry.finish(result.satisfied ? "success" : "partial");
    return result;
  };
  return { app, page, run, telemetry, runChunk, queue, getFollowersPage };
}
