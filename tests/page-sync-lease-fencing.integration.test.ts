import { describe, expect, it } from "vitest";

import {
  acquirePageSyncLease,
  blockPageSync,
  completePageSync,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  getPageSyncState,
  heartbeatPageSyncLease,
  markPageSyncAuthBlocked,
  PageSyncLeaseLostError,
  pausePageSync,
  reclaimExpiredPageSync,
  requestPageSync,
  retryPageSync,
  runWithPageSyncExecutionContext,
  upsertCheckpoint,
  withOwnedPageSyncTransaction,
  yieldPageSync,
} from "@agency_hub_core/db";

import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import { startIntegrationTestDatabase } from "./helpers/db.ts";
import { EVERY_PLATFORM } from "./helpers/page-sync-scope.ts";

// The legacy page-sync executor's leases, on a page of a platform it serves
// (OnlyFans, step 4) and on the streams it runs.
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
      const page = await createOnlyFansPage(testDb.db, {
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
      const page = await createOnlyFansPage(testDb.db, {
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
      const page = await createOnlyFansPage(testDb.db, {
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
      const page = await createOnlyFansPage(testDb.db, {
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
        streams: ["subscribers"],
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
        stream: "subscribers",
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
      const page = await createOnlyFansPage(testDb.db, {
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
      const page = await createOnlyFansPage(testDb.db, {
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
      const page = await createOnlyFansPage(testDb.db, {
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
      const page = await createOnlyFansPage(testDb.db, {
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
        streams: ["subscribers"],
        source: "manual",
        now,
      });
      // The stream was already failing before this chunk.
      await testDb.pool.query(
        `update page_sync_states
         set consecutive_failures = 9, last_error_code = 'http_502', last_error_summary = 'Earlier failure'
         where page_id = $1 and stream = 'subscribers'`,
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
        streams: ["subscribers"],
        source: "manual",
        now: new Date(now.getTime() + 1_000),
      });

      const retryResult = await retryPageSync(testDb.db, {
        pageId: page.id,
        stream: "subscribers",
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

      expect(await getPageSyncState(testDb.db, page.id, "subscribers")).toMatchObject({
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
      const page = await createOnlyFansPage(testDb.db, {
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
        streams: ["subscribers"],
        source: "manual",
        now,
      });
      // The stream was already failing before this chunk.
      await testDb.pool.query(
        `update page_sync_states
         set consecutive_failures = 2, last_error_code = 'http_502', last_error_summary = 'Earlier failure'
         where page_id = $1 and stream = 'subscribers'`,
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
        streams: ["subscribers"],
        source: "manual",
        now: new Date(now.getTime() + 1_000),
      });

      const blockResult = await blockPageSync(testDb.db, {
        pageId: page.id,
        stream: "subscribers",
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

      expect(await getPageSyncState(testDb.db, page.id, "subscribers")).toMatchObject({
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
      const page = await createOnlyFansPage(testDb.db, {
        modelId: model.id,
        label: "expired-request-page",
      });

      await ensurePageSyncStates(testDb.db, {
        pageId: page.id,
        now,
      });
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["subscribers"],
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
          where page_id = $1 and stream = 'subscribers'
        `,
        [page.id],
      );

      // Process time is deliberately behind the database; the expired DB
      // lease must still be cleared by the manual request.
      const requestedAt = new Date("2000-01-01T00:00:00.000Z");
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["subscribers"],
        source: "manual",
        now: requestedAt,
      });

      expect(await getPageSyncState(testDb.db, page.id, "subscribers")).toMatchObject({
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
        stream: "subscribers",
        leaseToken: "lease-2",
      });
    } finally {
      await testDb.stop();
    }
  }, 30_000);
});
