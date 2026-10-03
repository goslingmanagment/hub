import { describe, expect, it, vi } from "vitest";

import {
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
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

/** An OnlyFans page the posts lane may open (mapped; background capture on).
 *  Since step 4 (S4-10) the legacy executor serves OnlyFans pages only. */
async function eligibleOnlyFansPage(testDb: StartedTestDatabase, slug: string, label: string) {
  const model = await createModel(testDb.db, { slug, name: slug });
  if (!model) throw new Error("Expected model seed");
  const page = await createOnlyFansPage(testDb.db, { modelId: model.id, label });
  if (!page) throw new Error("Expected page seed");
  await setPageOfapiAccountId(testDb.db, { pageId: page.id, ofapiAccountId: `ofapi-${label}` });
  return { page, app: createTestAppContext(testDb, { ofapiMirrorBackgroundCaptureEnabled: true }) };
}

describe("posts sync rollout state", () => {
  it("seeds inert without a blocker and opens through the ordinary resume FSM", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) return;

    try {
      const { page, app } = await eligibleOnlyFansPage(testDb, "posts-state", "posts-state-page");

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
      const result = await requestPageSync(app, boss as never, {
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

  it("clears a manual_action_required block on an explicit posts request, and only that kind (decision #249)", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) return;

    try {
      const { page, app } = await eligibleOnlyFansPage(testDb, "posts-unblock", "posts-unblock-page");
      await ensurePageSyncStates(testDb.db, { pageId: page.id });
      await resumePageSync(testDb.db, { pageId: page.id, streams: ["posts"] });

      // The production shape: the posts handler parked the stream because its
      // capture job was parked, the owner cancelled the job, and nothing
      // clears the stream's own block.
      const park = (kind: string, code: string) => testDb.pool.query(`
        update page_sync_states
        set status = 'blocked', blocker_kind = $2, blocker_code = $3,
            blocker_message = 'parked', blocked_at = now(), updated_at = now()
        where page_id = $1 and stream = 'posts'
      `, [page.id, kind, code]);
      await park("manual_action_required", "ofapi_capture_job_job_cap");
      const boss = { send: vi.fn(async () => "posts-wakeup") };

      await requestPageSync(app, boss as never, {
        pageLabel: page.label,
        scope: "posts",
        reason: "manual",
      });
      let [posts] = await listPageSyncStates(testDb.db, { pageId: page.id, streams: ["posts"] });
      expect(posts).toMatchObject({
        status: "pending",
        requestSeq: 1,
        appliedSeq: 0,
        blockerKind: null,
        blockerCode: null,
        blockerMessage: null,
        blockedAt: null,
      });

      // A provider_bad_data block is not the operator's to wave away: the
      // request is recorded, the block stays.
      await park("provider_bad_data", "provider_bad_data");
      await requestPageSync(app, boss as never, {
        pageLabel: page.label,
        scope: "posts",
        reason: "manual",
      });
      [posts] = await listPageSyncStates(testDb.db, { pageId: page.id, streams: ["posts"] });
      expect(posts).toMatchObject({
        status: "blocked",
        requestSeq: 2,
        blockerKind: "provider_bad_data",
        blockerCode: "provider_bad_data",
      });
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
