import { describe, expect, it } from "vitest";

import {
  acquirePageSyncLease,
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  getPageSyncState,
  PageSyncLeaseLostError,
  pausePageSync,
  reclaimExpiredPageSync,
  requestPageSync,
  runWithPageSyncExecutionContext,
  upsertCheckpoint,
  withOwnedPageSyncTransaction,
} from "@agency_hub_core/db";

import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import { startIntegrationTestDatabase } from "./helpers/db.ts";

describe("page sync lease fencing", () => {
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
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "lease-page",
      });

      await ensurePageSyncStates(testDb.db, {
        pageId: page.id,
      });
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["followers"],
        source: "manual",
      });

      const lease = await acquirePageSyncLease(testDb.db, {
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

    const now = new Date("2026-03-24T12:00:00.000Z");

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

      await reclaimExpiredPageSync(testDb.db, now);

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
});
