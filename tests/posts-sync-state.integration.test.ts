import { describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  listPageSyncStates,
  pausePageSync,
  requestPageSync,
  resumePageSync,
} from "@agency_hub_core/db";

import { startIntegrationTestDatabase } from "./helpers/db.ts";

describe("posts sync rollout state", () => {
  it("seeds inert without a blocker and opens through the ordinary resume FSM", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) return;

    try {
      const model = await createModel(testDb.db, { slug: "posts-state", name: "Posts State" });
      if (!model) throw new Error("Expected model seed");
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "posts-state-page",
      });
      if (!page) throw new Error("Expected page seed");

      await ensurePageSyncStates(testDb.db, { pageId: page.id });
      let [posts] = await listPageSyncStates(testDb.db, { pageId: page.id, streams: ["posts"] });
      expect(posts).toMatchObject({
        status: "paused",
        requestSeq: 0,
        appliedSeq: 0,
        blockerKind: null,
        blockerCode: null,
        blockerMessage: null,
        blockedAt: null,
      });

      await resumePageSync(testDb.db, { pageId: page.id, streams: ["posts"] });
      [posts] = await listPageSyncStates(testDb.db, { pageId: page.id, streams: ["posts"] });
      expect(posts?.status).toBe("idle");

      await pausePageSync(testDb.db, {
        pageId: page.id,
        streams: ["posts"],
      });
      await requestPageSync(testDb.db, {
        pageId: page.id,
        streams: ["posts"],
        source: "manual",
      });
      await resumePageSync(testDb.db, { pageId: page.id, streams: ["posts"] });
      [posts] = await listPageSyncStates(testDb.db, { pageId: page.id, streams: ["posts"] });
      expect(posts).toMatchObject({ status: "pending", requestSeq: 1, appliedSeq: 0 });
    } finally {
      await testDb.stop();
    }
  }, 60_000);
});
