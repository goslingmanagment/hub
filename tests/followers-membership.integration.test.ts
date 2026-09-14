import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFanslyPage,
  readPageFollowReconcileActivity,
  upsertFans,
  upsertPageFollow,
  upsertCheckpointProgress,
} from "@agency_hub_core/db";
import { resetIntegrationDatabase, startTestDatabase } from "./helpers/db.ts";
import { followersMembershipFixture, MEMBERSHIP_START } from "./helpers/followers-membership-fixture.ts";

const FROM = new Date(Date.now() - 3_600_000).toISOString();
const TO = new Date(Date.now() + 3_600_000).toISOString();

describe("C1 membership protection and retirement evidence", () => {
  let db: Awaited<ReturnType<typeof startTestDatabase>>;
  beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
  afterAll(async () => { await db?.stop(); });
  beforeEach(async () => { await resetIntegrationDatabase(db.pool); });

  const read = async (runId: number) => {
    const { rows } = await db.pool.query("select fansly_followers_diagnostic_timeline($1, $2) as r", [FROM, TO]);
    return rows[0].r.records.find((row: { run_id: number }) => row.run_id === runId);
  };

  it("partitions every protection including equal timestamps, inactive rows and another page", async () => {
    const fixture = await followersMembershipFixture(db);
    const other = await createFanslyPage(db.db, { modelId: fixture.page.modelId, label: "other" });
    const [fan] = await upsertFans(db.db, [{ platform: "fansly", platformUserId: "other" }]);
    if (!other || !fan) throw new Error("other-page seed failed");
    await upsertPageFollow(db.db, {
      platformAccountId: other.id, fanId: fan.id, platformFollowId: "other", lastSeenGeneration: 9,
      followedAt: MEMBERSHIP_START,
    });
    expect(await readPageFollowReconcileActivity(db.db, {
      platformAccountId: fixture.page.id, generation: 10, fullSweepStartedAt: MEMBERSHIP_START,
    })).toEqual({
      firstSeenDuringSweepOutsideGeneration: 0,
      activeFollowerCount: 8, activeInGenerationCount: 1, activeOutsideGenerationCount: 7,
      deactivationCandidateCount: 2, generationGraceOnlyCount: 1, touchedSinceStartOnlyCount: 2,
      generationGraceAndTouchCount: 1, futureGenerationCount: 1,
    });
  });

  it("records the real guarded update result without promoting the SELECT to an after count", async () => {
    const fixture = await followersMembershipFixture(db);
    expect((await fixture.execute()).satisfied).toBe(true);
    const row = await read(fixture.run.id);
    expect(row).toMatchObject({ membership_receipt_count: 1, membership_receipt_valid: true,
      sections: { membership: {
        schemaVersion: 1, outcome: "complete", generation: 10, generationObservedCount: 2,
        activeFollowerCount: 8, activeInGenerationCount: 1, activeOutsideGenerationCount: 7,
        deactivationCandidateCount: 2, generationGraceOnlyCount: 1, touchedSinceStartOnlyCount: 2,
        generationGraceAndTouchCount: 1, futureGenerationCount: 1, deactivatedCount: 2,
      } },
    });
    const result = await db.pool.query("select platform_follow_id from page_follows where is_active = false");
    expect(result.rows.map(row => row.platform_follow_id).sort()).toEqual(["inactive", "old", "old-null"]);
    expect(fixture.app.adapter.getAccountMe).toHaveBeenCalledTimes(1);
    expect(fixture.app.adapter.getFollowersPage).not.toHaveBeenCalled();
    expect(JSON.stringify(row)).not.toMatch(/test-token|old-null|touch-null|authorization/);
  });

  it("keeps withheld retirement null on a non-destructive completion", async () => {
    const fixture = await followersMembershipFixture(db, 20);
    expect((await fixture.execute()).satisfied).toBe(true);
    expect(await read(fixture.run.id)).toMatchObject({ membership_receipt_valid: true, sections: { membership: {
      outcome: "non_destructive_complete", deactivatedCount: null, deactivationCandidateCount: 2,
    } } });
    const result = await db.pool.query("select count(*)::int as n from page_follows where is_active = false");
    expect(result.rows[0].n).toBe(1);
  });

  it("retains the sweep's own timestamp when a first-chunk restart discards it from checkpoints", async () => {
    const fixture = await followersMembershipFixture(db, 20);
    await upsertCheckpointProgress(db.db, {
      platformAccountId: fixture.page.id, stream: "followers_reconcile", state: { generation: 11 },
    });
    const before = Date.now();
    expect((await fixture.execute()).satisfied).toBe(false);
    const row = await read(fixture.run.id);
    expect(row).toMatchObject({ membership_receipt_valid: true, sections: { membership: {
      outcome: "restart", generation: 12, deactivatedCount: null,
    } } });
    expect(row.sections.checkpointBefore.fullSweepStartedAt).toBeUndefined();
    expect(row.sections.checkpointAfter.fullSweepStartedAt).toBeUndefined();
    const startedAt = Date.parse(row.sections.membership.fullSweepStartedAt);
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(startedAt).toBeLessThanOrEqual(Date.now());
  });

  it("reports returned UPDATE rows when a candidate is not updated", async () => {
    const fixture = await followersMembershipFixture(db);
    await db.pool.query(`create function skip_one_retirement() returns trigger language plpgsql as $$
      begin if new.is_active = false and old.platform_follow_id = 'old-null' then return null; end if;
      return new; end $$;
      create trigger skip_one_retirement before update on page_follows
      for each row execute function skip_one_retirement()`);
    try {
      expect((await fixture.execute()).satisfied).toBe(true);
      expect(await read(fixture.run.id)).toMatchObject({ membership_receipt_valid: true, sections: { membership: {
        outcome: "complete", deactivationCandidateCount: 2, deactivatedCount: 1,
      } } });
      const result = await db.pool.query("select platform_follow_id from page_follows where is_active = false");
      expect(result.rows.map(row => row.platform_follow_id).sort()).toEqual(["inactive", "old"]);
    } finally {
      await db.pool.query("drop trigger skip_one_retirement on page_follows; drop function skip_one_retirement()");
    }
  });

  it("leaves a failed note unknown without undoing successful retirement", async () => {
    const fixture = await followersMembershipFixture(db);
    await db.pool.query(`create function reject_membership_note() returns trigger language plpgsql as $$
      begin if new.details ? 'followersMembership' then raise exception 'diagnostic unavailable'; end if;
      return new; end $$;
      create trigger reject_membership_note before insert on sync_run_events
      for each row execute function reject_membership_note()`);
    try {
      expect((await fixture.execute()).satisfied).toBe(true);
      expect(await read(fixture.run.id)).toMatchObject({
        membership_receipt_count: 0, membership_receipt_valid: false, sections: { membership: {} },
      });
      const result = await db.pool.query("select count(*)::int as n from page_follows where is_active = false");
      expect(result.rows[0].n).toBe(3);
    } finally {
      await db.pool.query("drop trigger reject_membership_note on sync_run_events; drop function reject_membership_note()");
    }
  });

  it.each([
    ["missing field", "activeOutsideGenerationCount", null],
    ["negative count", "generationGraceOnlyCount", -1],
    ["fractional count", "deactivatedCount", 0.5],
    ["inconsistent partition", "activeOutsideGenerationCount", 99],
    ["private text", "futureGenerationCount", "secret-token"],
    ["unknown outcome", "outcome", "secret-outcome"],
    ["invalid sweep timestamp", "fullSweepStartedAt", "secret-time"],
  ])("keeps %s invalid and never emits free text", async (_name, key, value) => {
    const fixture = await followersMembershipFixture(db);
    await fixture.execute();
    await db.pool.query(`update sync_run_events set details = jsonb_set(details, $1, $2::jsonb)
      where sync_run_id = $3 and details ? 'followersMembership'`,
    [["followersMembership", key], JSON.stringify(value), fixture.run.id]);
    const row = await read(fixture.run.id);
    expect(row.membership_receipt_valid).toBe(false);
    expect(JSON.stringify(row)).not.toContain("secret");
  });

  it("marks duplicate and out-of-window receipts as unknown", async () => {
    const fixture = await followersMembershipFixture(db);
    await fixture.execute();
    await db.pool.query(`insert into sync_run_events
      (sync_run_id, page_id, provider, stream, event_type, severity, message, details)
      select sync_run_id, page_id, provider, stream, event_type, severity, message, details from sync_run_events
      where sync_run_id = $1 and details ? 'followersMembership'`, [fixture.run.id]);
    expect(await read(fixture.run.id)).toMatchObject({ membership_receipt_count: 2, membership_receipt_valid: false });
    await db.pool.query("update sync_run_events set emitted_at = $1 where sync_run_id = $2", [TO, fixture.run.id]);
    expect(await read(fixture.run.id)).toMatchObject({ membership_receipt_count: 0, membership_receipt_valid: false });
  });
});
