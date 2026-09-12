import { vi } from "vitest";
import {
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  findPageById,
  startSyncRun,
  upsertCheckpointProgress,
} from "@agency_hub_core/db";
import type { AppContext } from "../../apps/runtime/src/bootstrap.ts";
import { executeFollowersChunk } from "../../apps/runtime/src/services/sync/executor-handlers.ts";
import { SyncChunkBudget } from "../../apps/runtime/src/services/sync/chunk-budget.ts";
import { SyncRunTelemetry } from "../../apps/runtime/src/services/sync/observability.ts";
import type { StartedTestDatabase } from "./db.ts";
import { createTestAppContext } from "./runtime.ts";

export async function followersDiagnosticFixture(
  db: StartedTestDatabase,
  mode: "none" | "count" | "missing" | "unchanged" = "none",
) {
  const knownFollowId = mode === "missing" || mode === "unchanged" ? "1001" : null;
  const items = [{ id: "1000", followerId: "fan-1", lastSeenAt: Date.now() }];
  if (mode === "unchanged") {
    items.push({ id: "1001", followerId: "fan-2", lastSeenAt: Date.now() });
  }
  const accounts = items.map(row => ({
    id: row.followerId,
    username: row.followerId,
    displayName: "Fan",
    createdAt: 1_770_000_000_000,
    lastSeenAt: row.lastSeenAt,
  }));
  const getFollowersPage = vi.fn<AppContext["adapter"]["getFollowersPage"]>(async () => ({
    items,
    accounts,
    offset: 0,
    done: mode !== "unchanged",
    raw: { data: items, aggregationData: { accounts } },
  }));
  const app = createTestAppContext(db);
  app.adapter.getFollowersPage = getFollowersPage;
  const model = await createModel(db.db, { slug: "followers-diagnostic", name: "Followers" });
  if (!model) throw new Error("model seed failed");
  const page = await createFanslyPage(db.db, { modelId: model.id, label: "followers-diagnostic" });
  if (!page) throw new Error("page seed failed");
  const states = await ensurePageSyncStates(db.db, { pageId: page.id });
  const followerState = states.find(state => state.stream === "followers");
  if (!followerState) throw new Error("followers state seed failed");
  await upsertCheckpointProgress(db.db, {
    platformAccountId: page.id,
    stream: "followers",
    state: {
      revision: followerState.requestSeq,
      knownFollowId,
      newestFollowId: mode === "unchanged" ? knownFollowId : null,
      offset: 0,
      pageCount: 0,
      sourceFollowerCount: mode === "count" ? 2 : 1,
    },
  });
  const stored = await findPageById(db.db, page.id);
  const run = await startSyncRun(db.db, {
    platformAccountId: page.id,
    stream: "followers",
    trigger: "manual",
  });
  if (!stored || !run) throw new Error("run seed failed");
  const telemetry = new SyncRunTelemetry(app, {
    runId: run.id,
    platformAccountId: page.id,
    pageLabel: page.label,
    provider: "fansly",
    stream: "followers",
    trigger: "manual",
    egressKey: "direct",
  });
  const queue = async () => {
    const result = await db.pool.query<{ request_seq: string }>(
      "select request_seq::text from page_sync_states where page_id = $1 and stream = 'followers_reconcile'",
      [page.id],
    );
    const row = result.rows[0];
    if (!row) throw new Error("followers reconcile queue seed missing");
    return row.request_seq;
  };
  const runHandlerAndFinishTelemetry = async () => {
    const input: Parameters<typeof executeFollowersChunk>[1] = {
      pageContext: {
        platform: "fansly",
        page: { ...stored.page, platformAccountId: "account-1" },
        session: { authorization: "test-token" },
        proxy: null,
        egressKey: "direct",
      },
      streamState: {
        ...followerState,
        platform: "fansly",
        proxyUrl: null,
        egressKey: "direct",
      },
      syncRunId: run.id,
      telemetry,
      budget: new SyncChunkBudget(10),
    };
    const result = await executeFollowersChunk(app, input);
    // This fixture exercises the handler and readers, not executor lease/CAS completion.
    await telemetry.finish(result.satisfied ? "success" : "partial");
    return result;
  };
  return { app, page, run, telemetry, runHandlerAndFinishTelemetry, queue, getFollowersPage };
}
