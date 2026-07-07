import { describe, expect, it } from "vitest";

import {
  acquirePageSyncLease,
  createFanslyPage,
  createModel,
  deletePageByLabel,
  ensurePageSyncStates,
  listRunnablePageSync,
  requestPageSync,
  scheduleDuePageSync,
} from "@agency_hub_core/db";

import { startIntegrationTestDatabase } from "./helpers/db.ts";

// Review finding (P1): deletePageByLabel only tombstones the page, and the
// planner/lease queries used to ignore page status entirely — a deleted page
// kept getting scheduled, leased, and thrown on ("Page not found") every
// reclaim cycle, forever. These pins hold the planner surface to the
// tombstone: no seeding, no runnable rows, no lease for a deleted page.
describe("page sync tombstone", () => {
  it("stops seeding, scheduling and leasing a page once it is tombstoned", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    try {
      const model = await createModel(testDb.db, {
        slug: "tombstone-model",
        name: "Tombstone Model",
      });
      if (!model) {
        throw new Error("Expected the model to be created");
      }
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "tombstone-page",
      });
      if (!page) {
        throw new Error("Expected the page to be created");
      }

      await ensurePageSyncStates(testDb.db, { pageId: page.id });
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["followers"],
        source: "manual",
      });

      // Pre-condition: with the page active, the planner sees it.
      const runnableBefore = await listRunnablePageSync(testDb.db);
      expect(runnableBefore.some((row) => row.pageId === page.id)).toBe(true);

      await deletePageByLabel(testDb.db, "tombstone-page");

      // Seeding/maintenance skips the tombstone (it used to re-seed it).
      const reseeded = await ensurePageSyncStates(testDb.db, { pageId: page.id });
      expect(reseeded).toEqual([]);

      // A full planner cycle produces no runnable work for the page…
      await scheduleDuePageSync(testDb.db);
      const runnableAfter = await listRunnablePageSync(testDb.db);
      expect(runnableAfter.some((row) => row.pageId === page.id)).toBe(false);

      // …and the executor can no longer lease it, despite the pending request.
      const lease = await acquirePageSyncLease(testDb.db, {
        pageId: page.id,
        workerId: "worker-tombstone",
        leaseToken: "lease-tombstone",
        leaseTtlMs: 60_000,
      });
      expect(lease).toBeNull();
    } finally {
      await testDb.stop();
    }
  }, 60_000);
});
