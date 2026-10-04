import { describe, expect, it } from "vitest";

import {
  acquirePageSyncLease,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  getPageSyncState,
  listPageSyncStates,
  ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_CODE,
  ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND,
  requestPageSync,
  resumePageSync,
  retireLegacyOnlyFansDmMessages,
} from "@agency_hub_core/db";

import { startIntegrationTestDatabase } from "./helpers/db.ts";
import { EVERY_PLATFORM } from "./helpers/page-sync-scope.ts";

describe("permanent OnlyFans legacy DM retirement", () => {
  it("creates a retired tombstone and prevents every normal resurrection path", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) return;

    try {
      const model = await createModel(testDb.db, {
        slug: "of-dm-retirement",
        name: "OF DM Retirement",
      });
      if (!model) throw new Error("Expected to create the retirement test model");
      const onlyFansPage = await createOnlyFansPage(testDb.db, {
        modelId: model.id,
        label: "of-dm-retirement",
      });
      if (!onlyFansPage) throw new Error("Expected to create the OnlyFans test page");
      const fanslyPage = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "fansly-dm-control",
      });
      if (!fanslyPage) throw new Error("Expected to create the Fansly control page");
      await ensurePageSyncStates(testDb.db, { pageId: onlyFansPage.id });
      await ensurePageSyncStates(testDb.db, { pageId: fanslyPage.id });
      expect(await listPageSyncStates(testDb.db, {
        pageId: onlyFansPage.id,
        streams: ["dm_messages"],
      })).toEqual([]);

      expect(await retireLegacyOnlyFansDmMessages(testDb.db)).toBe(1);
      expect(await getPageSyncState(testDb.db, onlyFansPage.id, "dm_messages"))
        .toMatchObject({
          status: "paused",
          blockerKind: ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND,
          blockerCode: ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_CODE,
          leaseToken: null,
        });

      // Simulate a rolled-back image seeding the retired stream for a page
      // created after cutover. The DB, not the binary, owns the invariant.
      const rollbackOnlyFansPage = await createOnlyFansPage(testDb.db, {
        modelId: model.id,
        label: "of-dm-rollback-control",
      });
      if (!rollbackOnlyFansPage) throw new Error("Expected to create the rollback control page");
      await testDb.pool.query(`
        insert into page_sync_states (
          page_id, stream, status, cadence_seconds, slot_offset_seconds,
          request_seq, applied_seq, blocker_kind, blocker_code,
          lease_owner, lease_token, lease_expires_at
        ) values ($1, 'dm_messages', 'running', 86400, 0, 1, 0, null, null,
                  'old-image', 'old-insert-token', now() + interval '1 minute')
      `, [rollbackOnlyFansPage.id]);
      expect(await getPageSyncState(testDb.db, rollbackOnlyFansPage.id, "dm_messages"))
        .toMatchObject({
          status: "paused",
          blockerKind: ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND,
          blockerCode: ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_CODE,
          leaseToken: null,
        });

      // Simulate a pre-S0 application image trying to resume and lease the
      // row directly. The migration trigger is the rollback-proof fence.
      await testDb.pool.query(`
        update page_sync_states
        set status = 'running',
            blocker_kind = null,
            blocker_code = null,
            blocker_message = null,
            leased_seq = request_seq,
            lease_owner = 'old-image',
            lease_token = 'old-image-token',
            lease_expires_at = now() + interval '1 minute'
        where page_id = $1 and stream = 'dm_messages'
      `, [onlyFansPage.id]);
      expect(await getPageSyncState(testDb.db, onlyFansPage.id, "dm_messages"))
        .toMatchObject({
          status: "paused",
          blockerKind: ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND,
          blockerCode: ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_CODE,
          leaseToken: null,
        });

      await requestPageSync(testDb.db, {
        pageId: onlyFansPage.id,
        streams: ["dm_messages"],
        source: "manual",
      });
      await resumePageSync(testDb.db, {
        pageId: onlyFansPage.id,
        streams: ["dm_messages"],
      });
      const acquired = await acquirePageSyncLease(testDb.db, {
        platforms: EVERY_PLATFORM,
        pageId: onlyFansPage.id,
        workerId: "should-not-run",
        leaseToken: "retired-lane",
        leaseTtlMs: 60_000,
      });
      expect(acquired?.stream).not.toBe("dm_messages");
      expect(await getPageSyncState(testDb.db, onlyFansPage.id, "dm_messages"))
        .toMatchObject({
          status: "paused",
          blockerKind: ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_KIND,
          blockerCode: ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_CODE,
        });

      const fanslyHistory = await getPageSyncState(testDb.db, fanslyPage.id, "dm_messages");
      expect(fanslyHistory).not.toBeNull();
      expect(fanslyHistory?.blockerCode).not.toBe(ONLYFANS_LEGACY_DM_MESSAGES_BLOCKER_CODE);
      await testDb.pool.query(`
        update page_sync_states
        set status = 'running',
            blocker_kind = null,
            blocker_code = null,
            lease_owner = 'fansly-worker',
            lease_token = 'fansly-token',
            lease_expires_at = now() + interval '1 minute'
        where page_id = $1 and stream = 'dm_messages'
      `, [fanslyPage.id]);
      expect(await getPageSyncState(testDb.db, fanslyPage.id, "dm_messages"))
        .toMatchObject({
          status: "running",
          blockerKind: null,
          leaseToken: "fansly-token",
        });
      expect(await retireLegacyOnlyFansDmMessages(testDb.db)).toBe(0);
    } finally {
      await testDb.stop();
    }
  });
});
