import { describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  listPageSyncStates,
  pausePageSync,
  resumePageSync,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import { requestPageSync } from "../apps/runtime/src/services/sync-control.ts";
import { pauseIneligibleOnlyFansPostsForPage } from "../apps/runtime/src/services/sync/posts.ts";
import { startIntegrationTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

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
      const boss = { send: vi.fn(async () => "posts-wakeup") };
      const result = await requestPageSync(createTestAppContext(testDb), boss as never, {
        pageLabel: page.label,
        scope: "posts",
        reason: "manual",
      });
      [posts] = await listPageSyncStates(testDb.db, { pageId: page.id, streams: ["posts"] });
      expect(posts).toMatchObject({ status: "pending", requestSeq: 1, appliedSeq: 0 });
      expect(result.requests).toEqual([{ stream: "posts", requestedSeq: 1 }]);
      expect(boss.send).toHaveBeenCalledTimes(1);
    } finally {
      await testDb.stop();
    }
  }, 60_000);

  it("preflights OnlyFans prerequisites before opening a page and re-parks it when they disappear", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) return;

    try {
      const model = await createModel(testDb.db, { slug: "posts-of-state", name: "Posts OF State" });
      if (!model) throw new Error("Expected model seed");
      const page = await createOnlyFansPage(testDb.db, {
        modelId: model.id,
        label: "posts-of-state-page",
      });
      if (!page) throw new Error("Expected page seed");
      await ensurePageSyncStates(testDb.db, { pageId: page.id });

      const boss = { send: vi.fn(async () => "posts-of-wakeup") };
      const disabledApp = createTestAppContext(testDb, {
        ofapiMirrorBackgroundCaptureEnabled: false,
      });
      await expect(requestPageSync(disabledApp, boss as never, {
        pageLabel: page.label,
        scope: "posts",
        reason: "manual",
      })).rejects.toThrow(/posts capture is disabled/i);

      const enabledApp = createTestAppContext(testDb, {
        ofapiMirrorBackgroundCaptureEnabled: true,
      });
      await expect(requestPageSync(enabledApp, boss as never, {
        pageLabel: page.label,
        scope: "posts",
        reason: "manual",
      })).rejects.toThrow(/requires an OFAPI account mapping/i);

      let [posts] = await listPageSyncStates(testDb.db, { pageId: page.id, streams: ["posts"] });
      expect(posts).toMatchObject({ status: "paused", requestSeq: 0, appliedSeq: 0 });
      expect(boss.send).not.toHaveBeenCalled();

      await setPageOfapiAccountId(testDb.db, {
        pageId: page.id,
        ofapiAccountId: "ofapi-posts-page",
      });
      await requestPageSync(enabledApp, boss as never, {
        pageLabel: page.label,
        scope: "posts",
        reason: "manual",
      });
      [posts] = await listPageSyncStates(testDb.db, { pageId: page.id, streams: ["posts"] });
      expect(posts).toMatchObject({ status: "pending", requestSeq: 1, appliedSeq: 0 });

      expect(await pauseIneligibleOnlyFansPostsForPage(disabledApp, page.id)).toBe(true);
      [posts] = await listPageSyncStates(testDb.db, { pageId: page.id, streams: ["posts"] });
      expect(posts).toMatchObject({ status: "paused", requestSeq: 1, appliedSeq: 0 });
    } finally {
      await testDb.stop();
    }
  }, 60_000);
});
