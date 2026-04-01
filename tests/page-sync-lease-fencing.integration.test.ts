import { describe, expect, it } from "vitest";

import {
  acquirePageSyncLease,
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  PageSyncLeaseLostError,
  pausePageSync,
  requestPageSync,
  runWithPageSyncExecutionContext,
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
});
