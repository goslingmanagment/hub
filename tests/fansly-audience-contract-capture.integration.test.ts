import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquirePageSyncLease, createFanslyPage, createModel, ensurePageSyncStates, findPageById,
  getCheckpoint, runWithPageSyncExecutionContext, startSyncRun, upsertCheckpointProgress,
  upsertFans, upsertPageFollow, upsertPageSubscription,
} from "@agency_hub_core/db";
import { FanslyAdapter } from "@agency_hub_core/fansly";
import { millsFromInteger } from "@agency_hub_core/shared";
import {
  executeFollowersChunk, executeFollowersReconcileChunk, fanslySubscribersChunk,
} from "../apps/runtime/src/services/sync/executor-handlers.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { SyncRunTelemetry } from "../apps/runtime/src/services/sync/observability.ts";
import type { StreamChunkResult } from "../apps/runtime/src/services/sync/executor-types.ts";
import { resetIntegrationDatabase, startTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const require = createRequire(new URL("../packages/fansly/src/adapter.ts", import.meta.url));
type MockTransport = {
  disableNetConnect(): void;
  assertNoPendingInterceptors(): void;
  get(origin: string): {
    intercept(options: { path: RegExp; method: string }): {
      reply(status: number, body: () => string): unknown;
    };
  };
  close(): Promise<void>;
};
const { MockAgent } = require("undici") as { MockAgent: new () => MockTransport };

describe("Fansly audience journal before contract rejection", () => {
  let db: Awaited<ReturnType<typeof startTestDatabase>>;
  let adapter: FanslyAdapter;
  let transport: MockTransport;
  let baseUrl: string;
  beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
  afterAll(async () => { await db?.stop(); });
  beforeEach(async () => {
    await resetIntegrationDatabase(db.pool);
    baseUrl = `https://fansly-${randomUUID()}.audit.invalid`;
    transport = new MockAgent();
    transport.disableNetConnect();
    adapter = new FanslyAdapter({ baseUrl, globalDelayMs: 0 });
    // This suite replaces dispatcher transport only. Proxy selection/refusal is
    // covered by the adapter proxy suites; no real network is permitted here.
    vi.spyOn(adapter as unknown as { getDispatcher(): MockTransport }, "getDispatcher")
      .mockReturnValue(transport);
  });
  afterEach(async () => {
    try { await adapter?.close(); } finally { await transport?.close(); vi.restoreAllMocks(); }
  });

  it.each(["subscribers", "followers", "followers_reconcile"] as const)(
    "retains rejected %s evidence with no cursor movement or membership writes", async stream => {
      const raw = stream === "subscribers"
        ? { subscriptions: [], providerDetail: "retain permitted subscribers raw" }
        : {
          followers: [{ id: "follow-1", followerId: "fan-1", lastSeenAt: 123 }, null],
          aggregationData: { accounts: [{ id: "fan-1", username: "allowed", lastSeenAt: 456 }] },
          unknownPrivateText: "must not enter follower capture",
        };
      // Only the physical transport is mocked: real adapter, observer, handlers,
      // journal repositories and owned-cursor writes execute against Postgres.
      const serve = vi.fn(() => JSON.stringify({ success: true, response: raw }));
      transport.get(baseUrl).intercept({ path: /.*/, method: "GET" }).reply(200, serve);
      const app = createTestAppContext(db, { adapter, fanslyDefaultDelayMs: 0 });
      const model = await createModel(db.db, { slug: "audience-contract", name: "Audience contract" });
      if (!model) throw new Error("Missing test model");
      const page = await createFanslyPage(db.db, { modelId: model.id, label: "audience-contract" });
      if (!page) throw new Error("Missing test page");
      await ensurePageSyncStates(db.db, { pageId: page.id });
      await db.pool.query(`update page_sync_states set status = case when stream = $2
        then 'pending'::page_sync_status else 'paused'::page_sync_status end,
        succeeded_at = case when stream = $2 then null else now() end where page_id = $1`, [page.id, stream]);
      const lease = await acquirePageSyncLease(db.db, {
        pageId: page.id, workerId: "contract-test", leaseToken: "owned-contract-test", leaseTtlMs: 120_000,
      });
      if (!lease || lease.stream !== stream || lease.leasedSeq === null || !lease.leaseToken) {
        throw new Error("Missing test lease");
      }
      const revision = lease.leasedSeq;
      const state = stream === "subscribers"
        ? { revision, generation: 2, mode: "active", historyBackfilledAt: null,
          offset: 100, observedCount: 100, pageCount: 1, providerReportedTotal: 101 }
        : stream === "followers"
        ? { revision, offset: 100, pageCount: 1, knownFollowId: "known",
          newestFollowId: "newest", sourceFollowerCount: 101 }
        : { revision, generation: 2, fullSweepStartedAt: new Date().toISOString(),
          offset: 100, observedCount: 100, pageCount: 1, sourceFollowerCount: 101,
          snapshotRestartCount: 0, restartReason: null, verificationPending: false };
      await upsertCheckpointProgress(db.db, { platformAccountId: page.id, stream, state });
      const [fan] = await upsertFans(db.db, [{ platform: "fansly", platformUserId: "fan-1" }]);
      if (!fan) throw new Error("Missing test fan");
      await upsertPageFollow(db.db, { platformAccountId: page.id, fanId: fan.id, platformFollowId: "follow-1",
        followedAt: new Date("2026-01-01T00:00:00Z") });
      await upsertPageSubscription(db.db, { platformAccountId: page.id, fanId: fan.id,
        platformSubscriptionId: "subscription-1", rawStatus: 3, canonicalStatus: "active",
        priceMills: millsFromInteger(1_000), renewPriceMills: millsFromInteger(1_000) });
      const beforeCursor = await getCheckpoint(db.db, page.id, stream);
      const beforeFollows = (await db.pool.query("select * from page_follows order by id")).rows;
      const beforeSubscriptions = (await db.pool.query("select * from page_subscriptions order by id")).rows;
      const stored = await findPageById(db.db, page.id);
      const run = await startSyncRun(db.db, { platformAccountId: page.id, stream, trigger: "manual" });
      if (!stored || !run) throw new Error("Missing test run");
      const telemetry = new SyncRunTelemetry(app, { runId: run.id, platformAccountId: page.id,
        pageLabel: page.label, provider: "fansly", stream, trigger: "manual", egressKey: lease.egressKey });
      const input = {
        pageContext: { platform: "fansly" as const, page: { ...stored.page, platformAccountId: "account-1" },
          session: { authorization: "synthetic-token" }, proxy: { url: "socks5://proxy.example:1080" }, egressKey: lease.egressKey },
        streamState: lease, syncRunId: run.id, telemetry, budget: new SyncChunkBudget(2),
      };
      const handler = stream === "subscribers" ? fanslySubscribersChunk
        : stream === "followers" ? executeFollowersChunk : executeFollowersReconcileChunk;
      await expect(runWithPageSyncExecutionContext<StreamChunkResult>({ pageId: page.id, stream, requestSeq: revision,
        leaseToken: lease.leaseToken }, () => handler(app, input))).rejects.toThrow("response contract rejected");

      expect(serve).toHaveBeenCalledTimes(1);
      transport.assertNoPendingInterceptors();
      expect(await getCheckpoint(db.db, page.id, stream)).toEqual(beforeCursor);
      expect((await db.pool.query("select * from page_follows order by id")).rows).toEqual(beforeFollows);
      expect((await db.pool.query("select * from page_subscriptions order by id")).rows).toEqual(beforeSubscriptions);
      const observations = (await db.pool.query("select payload from observations where account_id = $1", [page.id])).rows;
      expect(observations).toHaveLength(1);
      expect(observations[0].payload).toMatchObject({ contractAccepted: false });
      if (stream === "subscribers") {
        expect(observations[0].payload).toEqual({ contractAccepted: false, raw });
      } else {
        expect(observations[0].payload).not.toHaveProperty("followers");
        expect(observations[0].payload).toMatchObject({
          responseShape: { response: "object", followers: "array" },
          captured: { followers: [{ id: "follow-1", followerId: "fan-1" }],
            aggregationData: { accounts: [{ id: "fan-1", username: "allowed" }] } },
        });
        expect(JSON.stringify(observations[0].payload)).not.toMatch(/lastSeenAt|unknownPrivateText|must not enter/);
      }
      const attempts = (await db.pool.query("select state, http_status from sync_http_attempts where sync_run_id = $1", [run.id])).rows;
      expect(attempts).toEqual([{ state: "success", http_status: 200 }]);
    },
  );
});
