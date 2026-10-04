import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFanslyPage,
  readPageFollowReconcileActivity,
  upsertFans,
  upsertPageFollow,
} from "@agency_hub_core/db";
import { resetIntegrationDatabase, startTestDatabase } from "./helpers/db.ts";
import { followersMembershipFixture, MEMBERSHIP_START } from "./helpers/followers-membership-fixture.ts";

const FROM = new Date(Date.now() - 3_600_000).toISOString();
const TO = new Date(Date.now() + 3_600_000).toISOString();

// The membership receipts the deleted legacy reconcile walk wrote stay
// readable through fansly_followers_diagnostic_timeline (0185); the fixture
// writes them as the walk did over seeded follows.
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

  it("exposes a complete walk's partition and its guarded retirement result", async () => {
    const fixture = await followersMembershipFixture(db);
    await fixture.recordMembershipAndFinishTelemetry({ outcome: "complete" });
    const row = await read(fixture.run.id);
    expect(row).toMatchObject({ membership_receipt_count: 1, membership_receipt_valid: true,
      sections: { membership: {
        schemaVersion: 1, outcome: "complete", generation: 10, generationObservedCount: 2,
        fullSweepStartedAt: MEMBERSHIP_START.toISOString(),
        activeFollowerCount: 8, activeInGenerationCount: 1, activeOutsideGenerationCount: 7,
        deactivationCandidateCount: 2, generationGraceOnlyCount: 1, touchedSinceStartOnlyCount: 2,
        generationGraceAndTouchCount: 1, futureGenerationCount: 1, deactivatedCount: 2,
      } },
    });
    expect(JSON.stringify(row)).not.toMatch(/old-null|touch-null|authorization/);
  });

  it("keeps a retirement below its candidates valid: the UPDATE's own result, not the SELECT", async () => {
    const fixture = await followersMembershipFixture(db);
    await fixture.recordMembershipAndFinishTelemetry({ outcome: "complete", deactivatedCount: 1 });
    expect(await read(fixture.run.id)).toMatchObject({ membership_receipt_valid: true, sections: { membership: {
      outcome: "complete", deactivationCandidateCount: 2, deactivatedCount: 1,
    } } });
  });

  it.each(["non_destructive_complete", "restart", "blast_radius_blocked"] as const)(
    "keeps withheld retirement null on a %s receipt",
    async (outcome) => {
      const fixture = await followersMembershipFixture(db);
      await fixture.recordMembershipAndFinishTelemetry({ outcome, sourceFollowerCount: 20 });
      expect(await read(fixture.run.id)).toMatchObject({ membership_receipt_valid: true, sections: { membership: {
        outcome, sourceFollowerCount: 20, deactivatedCount: null, deactivationCandidateCount: 2,
      } } });
    },
  );

  it("reads the receipt's own sweep start when the run's checkpoints carry none", async () => {
    const fixture = await followersMembershipFixture(db);
    await fixture.recordMembershipAndFinishTelemetry({ outcome: "restart" });
    const row = await read(fixture.run.id);
    expect(row.sections.checkpointBefore.fullSweepStartedAt).toBeUndefined();
    expect(row.sections.checkpointAfter.fullSweepStartedAt).toBeUndefined();
    expect(row.sections.membership.fullSweepStartedAt).toBe(MEMBERSHIP_START.toISOString());
  });

  it("leaves a run without a membership receipt unknown", async () => {
    const fixture = await followersMembershipFixture(db);
    await fixture.recordMembershipAndFinishTelemetry({ outcome: "complete", receipt: false });
    expect(await read(fixture.run.id)).toMatchObject({
      membership_receipt_count: 0, membership_receipt_valid: false, sections: { membership: {} },
    });
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
    await fixture.recordMembershipAndFinishTelemetry({ outcome: "complete" });
    await db.pool.query(`update sync_run_events set details = jsonb_set(details, $1, $2::jsonb)
      where sync_run_id = $3 and details ? 'followersMembership'`,
    [["followersMembership", key], JSON.stringify(value), fixture.run.id]);
    const row = await read(fixture.run.id);
    expect(row.membership_receipt_valid).toBe(false);
    expect(JSON.stringify(row)).not.toContain("secret");
  });

  it("marks duplicate and out-of-window receipts as unknown", async () => {
    const fixture = await followersMembershipFixture(db);
    await fixture.recordMembershipAndFinishTelemetry({ outcome: "complete" });
    await db.pool.query(`insert into sync_run_events
      (sync_run_id, page_id, provider, stream, event_type, severity, message, details)
      select sync_run_id, page_id, provider, stream, event_type, severity, message, details from sync_run_events
      where sync_run_id = $1 and details ? 'followersMembership'`, [fixture.run.id]);
    expect(await read(fixture.run.id)).toMatchObject({ membership_receipt_count: 2, membership_receipt_valid: false });
    await db.pool.query("update sync_run_events set emitted_at = $1 where sync_run_id = $2", [TO, fixture.run.id]);
    expect(await read(fixture.run.id)).toMatchObject({ membership_receipt_count: 0, membership_receipt_valid: false });
  });
});
