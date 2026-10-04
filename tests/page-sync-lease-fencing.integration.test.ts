import { describe, expect, it } from "vitest";

import {
  acquirePageSyncLease,
  blockPageSync,
  completePageSync,
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  getPageSyncState,
  heartbeatPageSyncLease,
  listRunnablePageSync,
  markPageSyncAuthBlocked,
  PageSyncLeaseLostError,
  pausePageSync,
  reclaimExpiredPageSync,
  refreshPageSyncDependencies,
  requestPageSync,
  resolvePageSyncPriority,
  retryPageSync,
  runWithPageSyncExecutionContext,
  scheduleDuePageSync,
  upsertCheckpoint,
  withOwnedPageSyncTransaction,
  yieldPageSync,
} from "@agency_hub_core/db";

import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import { startIntegrationTestDatabase } from "./helpers/db.ts";
import { EVERY_PLATFORM } from "./helpers/page-sync-scope.ts";

describe("page sync lease fencing", () => {
  it("makes lease expiry terminal instead of allowing heartbeat resurrection", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    try {
      const model = await createModel(testDb.db, {
        slug: "expired-lease-model",
        name: "Expired Lease Model",
      });
      if (!model) {
        throw new Error("Expected to create a model");
      }
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "expired-lease-page",
      });
      if (!page) {
        throw new Error("Expected to create a page");
      }
      await ensurePageSyncStates(testDb.db, { pageId: page.id });
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["light"],
        source: "manual",
      });
      const lease = await acquirePageSyncLease(testDb.db, {
        platforms: EVERY_PLATFORM,
        pageId: page.id,
        workerId: "old-worker",
        leaseToken: "old-token",
        leaseTtlMs: 60_000,
      });
      if (!lease) {
        throw new Error("Expected to acquire a page sync lease");
      }
      expect(lease.stream).toBe("light");
      const leasedSeq = lease.leasedSeq ?? lease.requestSeq;

      await testDb.pool.query(
        `
          update page_sync_states
          set lease_expires_at = now() - interval '1 second'
          where page_id = $1 and stream = 'light'
        `,
        [page.id],
      );

      await expect(heartbeatPageSyncLease(testDb.db, {
        pageId: page.id,
        stream: "light",
        leaseToken: "old-token",
        leaseTtlMs: 60_000,
      })).resolves.toBe(false);
      await expect(completePageSync(testDb.db, {
        pageId: page.id,
        stream: "light",
        requestSeq: leasedSeq,
        leaseToken: "old-token",
      })).resolves.toBe(false);
      await expect(runWithPageSyncExecutionContext({
        pageId: page.id,
        stream: "light",
        requestSeq: leasedSeq,
        leaseToken: "old-token",
      }, async () => withOwnedPageSyncTransaction(testDb.db, async () => undefined)))
        .rejects.toBeInstanceOf(PageSyncLeaseLostError);

      // Process time is deliberately behind the database; reclaim must still
      // follow lease_expires_at against PostgreSQL time.
      await reclaimExpiredPageSync(testDb.db, new Date("2000-01-01T00:00:00.000Z"));
      const replacement = await acquirePageSyncLease(testDb.db, {
        platforms: EVERY_PLATFORM,
        pageId: page.id,
        workerId: "new-worker",
        leaseToken: "new-token",
        leaseTtlMs: 60_000,
      });
      expect(replacement).toMatchObject({ leaseToken: "new-token" });
      await expect(completePageSync(testDb.db, {
        pageId: page.id,
        stream: "light",
        requestSeq: leasedSeq,
        leaseToken: "old-token",
      })).resolves.toBe(false);
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("does not expire a live lease when the process clock is far ahead", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    try {
      const model = await createModel(testDb.db, {
        slug: "live-db-clock-model",
        name: "Live DB Clock Model",
      });
      if (!model) {
        throw new Error("Expected to create a model");
      }
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "live-db-clock-page",
      });
      if (!page) {
        throw new Error("Expected to create a page");
      }
      await ensurePageSyncStates(testDb.db, { pageId: page.id });
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["light"],
        source: "manual",
      });
      const lease = await acquirePageSyncLease(testDb.db, {
        platforms: EVERY_PLATFORM,
        pageId: page.id,
        workerId: "live-worker",
        leaseToken: "live-token",
        leaseTtlMs: 60_000,
      });
      if (!lease) {
        throw new Error("Expected a live lease");
      }

      const processFuture = new Date("2100-01-01T00:00:00.000Z");
      await expect(reclaimExpiredPageSync(testDb.db, processFuture)).resolves.toEqual([]);
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["light"],
        source: "manual",
        now: processFuture,
      });

      expect(await getPageSyncState(testDb.db, page.id, "light")).toMatchObject({
        status: "running",
        requestSeq: lease.requestSeq + 1,
        leasedSeq: lease.leasedSeq,
        leaseToken: "live-token",
      });
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("does not let an old delayed yield overwrite a newer manual generation", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    const now = new Date();
    try {
      const model = await createModel(testDb.db, {
        slug: "yield-generation-model",
        name: "Yield Generation Model",
      });
      if (!model) {
        throw new Error("Expected to create a model");
      }
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "yield-generation-page",
      });
      if (!page) {
        throw new Error("Expected to create a page");
      }
      await ensurePageSyncStates(testDb.db, { pageId: page.id, now });
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["light"],
        source: "scheduled",
        now,
      });
      const lease = await acquirePageSyncLease(testDb.db, {
        platforms: EVERY_PLATFORM,
        pageId: page.id,
        workerId: "worker-1",
        leaseToken: "lease-1",
        leaseTtlMs: 60_000,
        now,
      });
      if (!lease) {
        throw new Error("Expected to acquire a page sync lease");
      }
      expect(lease.stream).toBe("light");
      const leasedSeq = lease.leasedSeq ?? lease.requestSeq;

      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["light"],
        source: "manual",
        now: new Date(now.getTime() + 1_000),
      });
      const yieldResult = await yieldPageSync(testDb.db, {
        pageId: page.id,
        stream: "light",
        requestSeq: leasedSeq,
        leaseToken: lease.leaseToken ?? "",
        retryAt: new Date(now.getTime() + 60 * 60_000),
        dispatchSource: "scheduled",
        now: new Date(now.getTime() + 2_000),
      });

      expect(yieldResult).toEqual({ updated: true, superseded: true });
      expect(await getPageSyncState(testDb.db, page.id, "light")).toMatchObject({
        status: "pending",
        requestSeq: leasedSeq + 1,
        requestSource: "manual",
        dispatchSource: "manual",
        retryAt: null,
        leasedSeq: null,
      });
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("consumes dispatch boosts without rewriting immutable request origin", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    try {
      const model = await createModel(testDb.db, {
        slug: "dispatch-source-model",
        name: "Dispatch Source Model",
      });
      if (!model) {
        throw new Error("Expected to create a model");
      }
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "dispatch-source-page",
      });
      if (!page) {
        throw new Error("Expected to create a page");
      }
      await ensurePageSyncStates(testDb.db, { pageId: page.id });
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["light", "followers"],
        source: "manual",
      });

      const lightLease = await acquirePageSyncLease(testDb.db, {
        platforms: EVERY_PLATFORM,
        pageId: page.id,
        workerId: "worker-light",
        leaseToken: "lease-light",
        leaseTtlMs: 60_000,
      });
      expect(lightLease).toMatchObject({
        stream: "light",
        requestSource: "manual",
        dispatchSource: "manual",
      });
      if (!lightLease) {
        throw new Error("Expected light lease");
      }
      await yieldPageSync(testDb.db, {
        pageId: page.id,
        stream: "light",
        requestSeq: lightLease.leasedSeq ?? lightLease.requestSeq,
        leaseToken: lightLease.leaseToken ?? "",
        dispatchSource: "scheduled",
      });
      expect(await getPageSyncState(testDb.db, page.id, "light")).toMatchObject({
        requestSource: "manual",
        dispatchSource: "scheduled",
      });

      const followersLease = await acquirePageSyncLease(testDb.db, {
        platforms: EVERY_PLATFORM,
        pageId: page.id,
        workerId: "worker-followers",
        leaseToken: "lease-followers",
        leaseTtlMs: 60_000,
      });
      expect(followersLease).toMatchObject({
        stream: "followers",
        requestSource: "manual",
        dispatchSource: "manual",
      });
      if (!followersLease) {
        throw new Error("Expected followers lease");
      }
      const runnableWhileFollowersIsLeased = await listRunnablePageSync(testDb.db, new Date(), { platforms: EVERY_PLATFORM });
      expect(runnableWhileFollowersIsLeased.find((row) => row.pageId === page.id)).toMatchObject({
        priority: resolvePageSyncPriority("light", "scheduled"),
      });
      await retryPageSync(testDb.db, {
        pageId: page.id,
        stream: "followers",
        requestSeq: followersLease.leasedSeq ?? followersLease.requestSeq,
        leaseToken: followersLease.leaseToken ?? "",
        retryKind: "transient_network",
        errorCode: "timeout",
        errorSummary: "temporary timeout",
      });
      expect(await getPageSyncState(testDb.db, page.id, "followers")).toMatchObject({
        requestSource: "manual",
        dispatchSource: "scheduled",
        status: "retrying",
      });
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("rolls back writes after pause clears the active lease", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    try {
      const model = await createModel(testDb.db, {
        slug: "lease-model",
        name: "Lease Model",
      });
      if (!model) {
        throw new Error("Expected to create a model");
      }
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "lease-page",
      });
      if (!page) {
        throw new Error("Expected to create a page");
      }

      await ensurePageSyncStates(testDb.db, {
        pageId: page.id,
      });
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["followers"],
        source: "manual",
      });

      const lease = await acquirePageSyncLease(testDb.db, {
        platforms: EVERY_PLATFORM,
        pageId: page.id,
        workerId: "worker-1",
        leaseToken: "lease-1",
        leaseTtlMs: 60_000,
      });
      if (!lease) {
        throw new Error("Expected to acquire a page sync lease");
      }
      expect(lease).toMatchObject({
        pageId: page.id,
        stream: "followers",
        leaseToken: "lease-1",
      });

      await testDb.pool.query(`
        create table lease_fencing_probe (
          id serial primary key,
          marker text not null
        )
      `);

      let releaseTransaction!: () => void;
      const releaseTransactionPromise = new Promise<void>((resolve) => {
        releaseTransaction = () => resolve();
      });
      let writeStarted!: () => void;
      const writeStartedPromise = new Promise<void>((resolve) => {
        writeStarted = () => resolve();
      });

      const transaction = runWithPageSyncExecutionContext({
        pageId: page.id,
        stream: lease.stream,
        requestSeq: lease.leasedSeq ?? lease.requestSeq,
        leaseToken: lease.leaseToken ?? "",
      }, async () => withOwnedPageSyncTransaction(testDb.db, async (dbTx) => {
        await dbTx.execute(sql`
          insert into lease_fencing_probe (marker)
          values ('before-pause')
        `);
        writeStarted();
        await releaseTransactionPromise;
      }));

      await writeStartedPromise;

      await pausePageSync(testDb.db, {
        pageId: page.id,
        streams: [lease.stream],
      });

      releaseTransaction();

      await expect(transaction).rejects.toBeInstanceOf(PageSyncLeaseLostError);

      const probeRows = await testDb.pool.query<{ count: number }>(
        "select count(*)::int as count from lease_fencing_probe",
      );
      expect(probeRows.rows[0]?.count).toBe(0);
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("rejects checkpoint writes that race with lease loss", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    try {
      const model = await createModel(testDb.db, {
        slug: "checkpoint-lease-model",
        name: "Checkpoint Lease Model",
      });
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "checkpoint-lease-page",
      });

      await ensurePageSyncStates(testDb.db, {
        pageId: page.id,
      });
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["transactions"],
        source: "manual",
      });

      const lease = await acquirePageSyncLease(testDb.db, {
        platforms: EVERY_PLATFORM,
        pageId: page.id,
        workerId: "worker-1",
        leaseToken: "lease-1",
        leaseTtlMs: 60_000,
      });
      if (!lease) {
        throw new Error("Expected to acquire a page sync lease");
      }

      const client = await testDb.pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `
            select 1
            from page_sync_states
            where page_id = $1
              and stream = 'transactions'
            for update
          `,
          [page.id],
        );

        const checkpointWrite = runWithPageSyncExecutionContext({
          pageId: page.id,
          stream: lease.stream,
          requestSeq: lease.leasedSeq ?? lease.requestSeq,
          leaseToken: lease.leaseToken ?? "",
        }, async () => upsertCheckpoint(testDb.db, {
          platformAccountId: page.id,
          stream: lease.stream,
          cursorText: "cursor-after-reset",
          cursorTimestamp: new Date("2026-03-24T12:00:00.000Z"),
          state: { phase: "after-reset" },
          lastSuccessfulRunId: null,
        }));

        await client.query(
          `
            update page_sync_states
            set status = 'paused',
                leased_seq = null,
                lease_owner = null,
                lease_token = null,
                lease_heartbeat_at = null,
                lease_expires_at = null
            where page_id = $1
              and stream = 'transactions'
          `,
          [page.id],
        );
        await client.query("commit");

        await expect(checkpointWrite).rejects.toBeInstanceOf(PageSyncLeaseLostError);
      } finally {
        await client.query("rollback").catch(() => undefined);
        client.release();
      }

      const checkpointRows = await testDb.pool.query<{ count: number }>(
        `
          select count(*)::int as count
          from page_sync_cursors
          where page_id = $1
            and stream = 'transactions'
        `,
        [page.id],
      );
      expect(checkpointRows.rows[0]?.count).toBe(0);
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("reclaims expired leases to pending when a new request arrives after the initial read", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    const now = new Date();

    try {
      const model = await createModel(testDb.db, {
        slug: "reclaim-model",
        name: "Reclaim Model",
      });
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "reclaim-page",
      });

      await ensurePageSyncStates(testDb.db, {
        pageId: page.id,
        now,
      });

      await testDb.pool.query(
        `
          update page_sync_states
          set status = 'running',
              request_seq = 0,
              applied_seq = 0,
              leased_seq = 0,
              lease_owner = 'worker-1',
              lease_token = 'lease-1',
              lease_heartbeat_at = $1,
              lease_expires_at = $2,
              updated_at = $1
          where page_id = $3
            and stream = 'followers'
        `,
        [now, new Date(now.getTime() - 1_000), page.id],
      );

      const dbWithInjectedRequest = Object.create(testDb.db) as typeof testDb.db;
      dbWithInjectedRequest.transaction = async (callback) => {
        await requestPageSync(testDb.db, {
          pageId: page.id,
          streams: ["followers"],
          source: "manual",
          now,
        });
        return testDb.db.transaction(callback);
      };

      await reclaimExpiredPageSync(dbWithInjectedRequest, now);

      const state = await getPageSyncState(testDb.db, page.id, "followers");
      expect(state).toMatchObject({
        status: "pending",
        requestSeq: 1,
        appliedSeq: 0,
        leasedSeq: null,
        leaseToken: null,
      });
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("keeps active leases running when a manual request arrives", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    const now = new Date("2026-03-24T12:00:00.000Z");

    try {
      const model = await createModel(testDb.db, {
        slug: "running-request-model",
        name: "Running Request Model",
      });
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "running-request-page",
      });

      await ensurePageSyncStates(testDb.db, {
        pageId: page.id,
        now,
      });
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["light"],
        source: "manual",
        now,
      });

      const lease = await acquirePageSyncLease(testDb.db, {
        platforms: EVERY_PLATFORM,
        pageId: page.id,
        workerId: "worker-1",
        leaseToken: "lease-1",
        leaseTtlMs: 60_000,
        now,
      });
      if (!lease) {
        throw new Error("Expected to acquire a page sync lease");
      }

      const leasedSeq = lease.leasedSeq ?? lease.requestSeq;
      const nextRequestSeq = lease.requestSeq + 1;
      const countRunnableLightRows = async () => {
        const result = await testDb.pool.query<{ count: number }>(
          `
            select count(*)::int as count
            from page_sync_states
            where page_id = $1
              and stream = 'light'
              and request_seq > applied_seq
              and status <> 'paused'
              and blocker_kind is null
              and leased_seq is null
          `,
          [page.id],
        );

        return result.rows[0]?.count ?? 0;
      };

      const nextRequestAt = new Date(now.getTime() + 1_000);
      const requests = await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["light"],
        source: "manual",
        now: nextRequestAt,
      });

      expect(requests).toEqual([{ stream: "light", requestedSeq: nextRequestSeq }]);
      expect(await getPageSyncState(testDb.db, page.id, "light")).toMatchObject({
        status: "running",
        requestSeq: nextRequestSeq,
        appliedSeq: lease.appliedSeq,
        leasedSeq,
        leaseToken: "lease-1",
      });
      expect(await countRunnableLightRows()).toBe(0);

      await completePageSync(testDb.db, {
        pageId: page.id,
        stream: "light",
        requestSeq: leasedSeq,
        leaseToken: lease.leaseToken ?? "",
        now: new Date(now.getTime() + 2_000),
      });

      expect(await getPageSyncState(testDb.db, page.id, "light")).toMatchObject({
        status: "pending",
        requestSeq: nextRequestSeq,
        appliedSeq: leasedSeq,
        leasedSeq: null,
        leaseToken: null,
      });
      expect(await countRunnableLightRows()).toBe(1);
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("fences active leases when auth blocking a page", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    try {
      const model = await createModel(testDb.db, {
        slug: "auth-block-lease-model",
        name: "Auth Block Lease Model",
      });
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "auth-block-lease-page",
      });
      await ensurePageSyncStates(testDb.db, {
        pageId: page.id,
      });

      const now = new Date("2026-03-16T12:00:00.000Z");
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["light"],
        source: "manual",
        now,
      });
      const lease = await acquirePageSyncLease(testDb.db, {
        platforms: EVERY_PLATFORM,
        pageId: page.id,
        workerId: "worker-1",
        leaseToken: "lease-auth-block",
        leaseTtlMs: 60_000,
        now,
      });
      if (!lease) {
        throw new Error("Expected to acquire a page sync lease");
      }
      const leasedSeq = lease.leasedSeq ?? lease.requestSeq;

      await markPageSyncAuthBlocked(testDb.db, {
        pageId: page.id,
        errorCode: "auth_blocked",
        errorSummary: "session expired",
        now: new Date(now.getTime() + 1_000),
      });

      expect(await getPageSyncState(testDb.db, page.id, "light")).toMatchObject({
        status: "blocked",
        blockerKind: "auth",
        leasedSeq: null,
        leaseOwner: null,
        leaseToken: null,
        leaseHeartbeatAt: null,
        leaseExpiresAt: null,
      });
      await expect(heartbeatPageSyncLease(testDb.db, {
        pageId: page.id,
        stream: "light",
        leaseToken: "lease-auth-block",
        leaseTtlMs: 60_000,
        now: new Date(now.getTime() + 2_000),
      })).resolves.toBe(false);
      await expect(completePageSync(testDb.db, {
        pageId: page.id,
        stream: "light",
        requestSeq: leasedSeq,
        leaseToken: "lease-auth-block",
        now: new Date(now.getTime() + 3_000),
      })).resolves.toBe(false);
      expect(await getPageSyncState(testDb.db, page.id, "light")).toMatchObject({
        status: "blocked",
        blockerKind: "auth",
        appliedSeq: lease.appliedSeq,
      });
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("keeps active leases running when the scheduler races after its setup phase", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    const now = new Date("2026-03-24T12:00:00.000Z");

    try {
      const model = await createModel(testDb.db, {
        slug: "schedule-lease-model",
        name: "Schedule Lease Model",
      });
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "schedule-lease-page",
      });

      await ensurePageSyncStates(testDb.db, {
        pageId: page.id,
        now,
      });
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["light"],
        source: "manual",
        now,
      });

      const dbWithInjectedLease = Object.create(testDb.db) as typeof testDb.db;
      let transactionCount = 0;
      dbWithInjectedLease.transaction = async (callback) => {
        transactionCount += 1;
        if (transactionCount === 2) {
          await acquirePageSyncLease(testDb.db, {
            platforms: EVERY_PLATFORM,
            pageId: page.id,
            workerId: "worker-1",
            leaseToken: "lease-1",
            leaseTtlMs: 60_000,
            now,
          });
        }
        return testDb.db.transaction(callback);
      };

      await scheduleDuePageSync(dbWithInjectedLease, {
        pageId: page.id,
        now,
      });

      expect(await getPageSyncState(testDb.db, page.id, "light")).toMatchObject({
        status: "running",
        requestSeq: 2,
        appliedSeq: 0,
        leasedSeq: 2,
        leaseToken: "lease-1",
      });
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("keeps newer manual requests pending and the failure streak when an older lease retries", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    const now = new Date("2026-03-24T12:00:00.000Z");

    try {
      const model = await createModel(testDb.db, {
        slug: "retry-request-model",
        name: "Retry Request Model",
      });
      if (!model) {
        throw new Error("Expected to create a model");
      }
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "retry-request-page",
      });
      if (!page) {
        throw new Error("Expected to create a page");
      }

      await ensurePageSyncStates(testDb.db, {
        pageId: page.id,
        now,
      });
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["followers"],
        source: "manual",
        now,
      });
      // The stream was already failing before this chunk.
      await testDb.pool.query(
        `update page_sync_states
         set consecutive_failures = 9, last_error_code = 'http_502', last_error_summary = 'Earlier failure'
         where page_id = $1 and stream = 'followers'`,
        [page.id],
      );

      const lease = await acquirePageSyncLease(testDb.db, {
        platforms: EVERY_PLATFORM,
        pageId: page.id,
        workerId: "worker-1",
        leaseToken: "lease-1",
        leaseTtlMs: 60_000,
        now,
      });
      if (!lease) {
        throw new Error("Expected to acquire a page sync lease");
      }
      const leasedSeq = lease.leasedSeq ?? lease.requestSeq;
      const nextRequestSeq = lease.requestSeq + 1;

      // "Sync now" while the chunk is failing.
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["followers"],
        source: "manual",
        now: new Date(now.getTime() + 1_000),
      });

      const retryResult = await retryPageSync(testDb.db, {
        pageId: page.id,
        stream: "followers",
        requestSeq: leasedSeq,
        leaseToken: lease.leaseToken ?? "",
        retryKind: "transport",
        errorCode: "http_500",
        errorSummary: "Upstream failed",
        now: new Date(now.getTime() + 2_000),
      });
      expect(retryResult).toEqual({
        updated: true,
        retried: false,
      });

      expect(await getPageSyncState(testDb.db, page.id, "followers")).toMatchObject({
        status: "pending",
        requestSeq: nextRequestSeq,
        appliedSeq: lease.appliedSeq,
        leasedSeq: null,
        leaseToken: null,
        retryKind: null,
        retryAt: null,
        failedAt: new Date(now.getTime() + 2_000),
        consecutiveFailures: 10,
        lastErrorCode: "http_500",
        lastErrorSummary: "Upstream failed",
      });
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("keeps newer manual requests pending and the failure streak when an older lease blocks", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    const now = new Date("2026-03-24T12:00:00.000Z");

    try {
      const model = await createModel(testDb.db, {
        slug: "block-request-model",
        name: "Block Request Model",
      });
      if (!model) {
        throw new Error("Expected to create a model");
      }
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "block-request-page",
      });
      if (!page) {
        throw new Error("Expected to create a page");
      }

      await ensurePageSyncStates(testDb.db, {
        pageId: page.id,
        now,
      });
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["followers"],
        source: "manual",
        now,
      });
      // The stream was already failing before this chunk.
      await testDb.pool.query(
        `update page_sync_states
         set consecutive_failures = 2, last_error_code = 'http_502', last_error_summary = 'Earlier failure'
         where page_id = $1 and stream = 'followers'`,
        [page.id],
      );

      const lease = await acquirePageSyncLease(testDb.db, {
        platforms: EVERY_PLATFORM,
        pageId: page.id,
        workerId: "worker-1",
        leaseToken: "lease-1",
        leaseTtlMs: 60_000,
        now,
      });
      if (!lease) {
        throw new Error("Expected to acquire a page sync lease");
      }
      const leasedSeq = lease.leasedSeq ?? lease.requestSeq;
      const nextRequestSeq = lease.requestSeq + 1;

      // "Sync now" while the chunk is failing.
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["followers"],
        source: "manual",
        now: new Date(now.getTime() + 1_000),
      });

      const blockResult = await blockPageSync(testDb.db, {
        pageId: page.id,
        stream: "followers",
        requestSeq: leasedSeq,
        leaseToken: lease.leaseToken ?? "",
        blockerKind: "manual_action_required",
        blockerCode: "upstream_blocked",
        blockerMessage: "Upstream blocked",
        errorCode: "http_403",
        errorSummary: "Upstream blocked",
        now: new Date(now.getTime() + 2_000),
      });
      expect(blockResult).toEqual({
        updated: true,
        blocked: false,
      });

      expect(await getPageSyncState(testDb.db, page.id, "followers")).toMatchObject({
        status: "pending",
        requestSeq: nextRequestSeq,
        appliedSeq: lease.appliedSeq,
        leasedSeq: null,
        leaseToken: null,
        blockerKind: null,
        blockerCode: null,
        failedAt: new Date(now.getTime() + 2_000),
        consecutiveFailures: 3,
        lastErrorCode: "http_403",
        lastErrorSummary: "Upstream blocked",
      });
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("clears expired leases when a manual request arrives", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    const now = new Date();

    try {
      const model = await createModel(testDb.db, {
        slug: "expired-request-model",
        name: "Expired Request Model",
      });
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "expired-request-page",
      });

      await ensurePageSyncStates(testDb.db, {
        pageId: page.id,
        now,
      });
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["followers"],
        source: "manual",
        now,
      });

      const lease = await acquirePageSyncLease(testDb.db, {
        platforms: EVERY_PLATFORM,
        pageId: page.id,
        workerId: "worker-1",
        leaseToken: "lease-1",
        leaseTtlMs: 1_000,
        now,
      });
      if (!lease) {
        throw new Error("Expected to acquire a page sync lease");
      }

      await testDb.pool.query(
        `
          update page_sync_states
          set lease_expires_at = clock_timestamp() - interval '1 second'
          where page_id = $1 and stream = 'followers'
        `,
        [page.id],
      );

      // Process time is deliberately behind the database; the expired DB
      // lease must still be cleared by the manual request.
      const requestedAt = new Date("2000-01-01T00:00:00.000Z");
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["followers"],
        source: "manual",
        now: requestedAt,
      });

      expect(await getPageSyncState(testDb.db, page.id, "followers")).toMatchObject({
        status: "pending",
        requestSeq: lease.requestSeq + 1,
        appliedSeq: lease.appliedSeq,
        leasedSeq: null,
        leaseToken: null,
      });

      const nextLease = await acquirePageSyncLease(testDb.db, {
        platforms: EVERY_PLATFORM,
        pageId: page.id,
        workerId: "worker-2",
        leaseToken: "lease-2",
        leaseTtlMs: 60_000,
        now: requestedAt,
      });
      expect(nextLease).toMatchObject({
        pageId: page.id,
        stream: "followers",
        leaseToken: "lease-2",
      });
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("reclaims expired leases even when stale rows are already marked pending", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    const now = new Date("2026-03-24T12:00:00.000Z");

    try {
      const model = await createModel(testDb.db, {
        slug: "reclaim-pending-model",
        name: "Reclaim Pending Model",
      });
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "reclaim-pending-page",
      });

      await ensurePageSyncStates(testDb.db, {
        pageId: page.id,
        now,
      });

      await testDb.pool.query(
        `
          update page_sync_states
          set status = 'pending',
              request_seq = 2,
              applied_seq = 1,
              leased_seq = 1,
              lease_owner = 'worker-1',
              lease_token = 'lease-1',
              lease_heartbeat_at = $1,
              lease_expires_at = $2,
              updated_at = $1
          where page_id = $3
            and stream = 'followers_reconcile'
        `,
        [now, new Date(now.getTime() - 1_000), page.id],
      );

      await reclaimExpiredPageSync(testDb.db, new Date("2000-01-01T00:00:00.000Z"));

      const state = await getPageSyncState(testDb.db, page.id, "followers_reconcile");
      expect(state).toMatchObject({
        status: "pending",
        requestSeq: 2,
        appliedSeq: 1,
        leasedSeq: null,
        leaseToken: null,
      });
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("refreshes dependency blockers immediately after manual requests", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    try {
      const model = await createModel(testDb.db, {
        slug: "dependency-model",
        name: "Dependency Model",
      });
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "dependency-page",
      });

      await ensurePageSyncStates(testDb.db, {
        pageId: page.id,
      });
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["dm_messages"],
        source: "manual",
      });

      const state = await getPageSyncState(testDb.db, page.id, "dm_messages");
      expect(state).toMatchObject({
        status: "blocked",
        blockerKind: "dependency",
        blockerCode: "unmet_dependency",
      });
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("keeps paused dependency-blocked streams paused when dependencies refresh", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    const now = new Date("2026-03-24T12:00:00.000Z");

    try {
      const model = await createModel(testDb.db, {
        slug: "paused-dependency-model",
        name: "Paused Dependency Model",
      });
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "paused-dependency-page",
      });

      await ensurePageSyncStates(testDb.db, {
        pageId: page.id,
        now,
      });
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["dm_messages"],
        source: "manual",
        now,
      });
      await pausePageSync(testDb.db, {
        pageId: page.id,
        streams: ["dm_messages"],
        now: new Date(now.getTime() + 1_000),
      });
      await testDb.pool.query(
        `
          update page_sync_states
          set applied_seq = greatest(applied_seq, request_seq),
              succeeded_at = $1,
              updated_at = $1
          where page_id = $2
            and stream = any($3::sync_stream[])
        `,
        [
          new Date(now.getTime() + 2_000),
          page.id,
          ["light", "top_spenders", "transactions", "subscribers", "followers", "dm_conversations"],
        ],
      );

      await refreshPageSyncDependencies(testDb.db, {
        pageId: page.id,
        now: new Date(now.getTime() + 3_000),
      });

      expect(await getPageSyncState(testDb.db, page.id, "dm_messages")).toMatchObject({
        status: "paused",
        blockerKind: "dependency",
        blockerCode: "unmet_dependency",
      });
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("coalesces an intent-free request into outstanding work without touching its row", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    const now = new Date("2026-03-24T12:00:00.000Z");
    const at = (seconds: number) => new Date(now.getTime() + seconds * 1_000);

    try {
      const model = await createModel(testDb.db, {
        slug: "coalesce-model",
        name: "Coalesce Model",
      });
      if (!model) {
        throw new Error("Expected to create a model");
      }
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "coalesce-page",
      });
      if (!page) {
        throw new Error("Expected to create a page");
      }

      await ensurePageSyncStates(testDb.db, {
        pageId: page.id,
        now,
      });
      // Settle every other stream so the lease below can only take the reconcile.
      await testDb.pool.query(
        `
          update page_sync_states
          set applied_seq = greatest(applied_seq, request_seq),
              status = 'idle',
              succeeded_at = $1,
              updated_at = $1
          where page_id = $2
            and stream <> 'followers_reconcile'
        `,
        [now, page.id],
      );
      await refreshPageSyncDependencies(testDb.db, {
        pageId: page.id,
        now,
      });
      const [requested] = await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["followers_reconcile"],
        source: "manual",
        now,
      });
      const outstandingSeq = requested!.requestedSeq;

      const reconcileRow = async () => {
        const result = await testDb.pool.query<{ row: Record<string, unknown> }>(
          `
            select to_jsonb(s) as row
            from page_sync_states s
            where page_id = $1
              and stream = 'followers_reconcile'
          `,
          [page.id],
        );
        return result.rows[0]?.row;
      };
      const expectCoalesced = async (requestAt: Date) => {
        const before = await reconcileRow();
        const receipts = await requestPageSync(testDb.db, {
          pageId: page.id,
          streams: ["followers_reconcile"],
          source: "anomaly",
          includeQueueState: true,
          coalesceOutstanding: true,
          now: requestAt,
        });
        expect(receipts).toEqual([{
          stream: "followers_reconcile",
          requestedSeq: outstandingSeq,
          coalesced: true,
          queueBefore: { requestedSeq: outstandingSeq, appliedSeq: before?.applied_seq },
        }]);
        expect(await reconcileRow()).toEqual(before);
      };
      const lease = async (leaseToken: string, leaseAt: Date) => {
        const acquired = await acquirePageSyncLease(testDb.db, {
          platforms: EVERY_PLATFORM,
          pageId: page.id,
          workerId: "worker-1",
          leaseToken,
          leaseTtlMs: 60_000,
          now: leaseAt,
        });
        expect(acquired).toMatchObject({
          stream: "followers_reconcile",
          leasedSeq: outstandingSeq,
        });
        return acquired!;
      };

      // A live lease keeps its revision, so the running sweep's cursor stays valid.
      await lease("lease-1", at(1));
      await expectCoalesced(at(2));

      // The snapshot-restart wait keeps its retry_at instead of restarting at once.
      const restartAt = at(900);
      await yieldPageSync(testDb.db, {
        pageId: page.id,
        stream: "followers_reconcile",
        requestSeq: outstandingSeq,
        leaseToken: "lease-1",
        retryAt: restartAt,
        now: at(3),
      });
      await expectCoalesced(at(4));
      expect(await getPageSyncState(testDb.db, page.id, "followers_reconcile")).toMatchObject({
        status: "pending",
        requestSeq: outstandingSeq,
        retryAt: restartAt,
      });

      // A non-provider backoff is honoured instead of being cancelled.
      await lease("lease-2", at(901));
      await retryPageSync(testDb.db, {
        pageId: page.id,
        stream: "followers_reconcile",
        requestSeq: outstandingSeq,
        leaseToken: "lease-2",
        retryKind: "transient_network",
        errorCode: null,
        errorSummary: "fetch failed",
        now: at(902),
      });
      await expectCoalesced(at(903));
      expect(await getPageSyncState(testDb.db, page.id, "followers_reconcile")).toMatchObject({
        status: "retrying",
        retryKind: "transient_network",
        retryAt: at(962),
      });

      // A blast-radius block keeps the request its cursor revision is bound to.
      await lease("lease-3", at(1_000));
      await blockPageSync(testDb.db, {
        pageId: page.id,
        stream: "followers_reconcile",
        requestSeq: outstandingSeq,
        leaseToken: "lease-3",
        blockerKind: "provider_bad_data",
        blockerCode: "followers_reconcile_deactivation_blast_radius",
        blockerMessage: "Blast radius exceeded",
        errorCode: null,
        errorSummary: "Blast radius exceeded",
        now: at(1_001),
      });
      await expectCoalesced(at(1_002));
      expect(await getPageSyncState(testDb.db, page.id, "followers_reconcile")).toMatchObject({
        status: "blocked",
        requestSeq: outstandingSeq,
      });

      // Ordinary callers still bump outstanding work.
      expect(await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["followers_reconcile"],
        source: "anomaly",
        now: at(1_003),
      })).toEqual([{ stream: "followers_reconcile", requestedSeq: outstandingSeq + 1 }]);

      // Settled work still gets exactly one new request.
      await testDb.pool.query(
        `
          update page_sync_states
          set applied_seq = request_seq,
              status = 'idle',
              blocker_kind = null,
              blocker_code = null,
              blocker_message = null,
              blocked_at = null
          where page_id = $1
            and stream = 'followers_reconcile'
        `,
        [page.id],
      );
      expect(await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["followers_reconcile"],
        source: "anomaly",
        includeQueueState: true,
        coalesceOutstanding: true,
        now: at(1_004),
      })).toEqual([{
        stream: "followers_reconcile",
        requestedSeq: outstandingSeq + 2,
        queueBefore: { requestedSeq: outstandingSeq + 1, appliedSeq: outstandingSeq + 1 },
      }]);
      expect(await getPageSyncState(testDb.db, page.id, "followers_reconcile")).toMatchObject({
        status: "pending",
        requestSeq: outstandingSeq + 2,
        dispatchSource: "anomaly",
      });
    } finally {
      await testDb.stop();
    }
  }, 30_000);
});
