import {
  countPageFollowsByGeneration,
  readPageFollowReconcileActivity,
  startSyncRun,
  upsertFans,
  upsertPageFollow,
} from "@agency_hub_core/db";
import { SyncRunTelemetry } from "../../apps/runtime/src/services/sync/observability.ts";
import type { StartedTestDatabase } from "./db.ts";
import { followersDiagnosticFixture } from "./followers-diagnostic-fixture.ts";

export const MEMBERSHIP_START = new Date("2026-09-01T12:00:00.000Z");
const GENERATION = 10;

export type MembershipOutcome = "complete" | "restart" | "non_destructive_complete" | "blast_radius_blocked";

/** One page's follows across every membership protection of a generation-10
 *  sweep that began at MEMBERSHIP_START, and a followers_reconcile run whose
 *  membership receipt (fansly_followers_diagnostic_timeline, 0185) is written
 *  as the legacy reconcile walk wrote it at its terminal verification. The
 *  walk is deleted (step 4, S4-17); the reader stays for the receipts
 *  production holds. */
export async function followersMembershipFixture(db: StartedTestDatabase) {
  const { app, page } = await followersDiagnosticFixture(db);
  const rows = [
    { id: "current", generation: 10, touched: false, active: true },
    { id: "inactive", generation: 10, touched: false, active: false },
    { id: "old", generation: 8, touched: false, active: true },
    { id: "old-null", generation: null, touched: false, active: true },
    { id: "grace", generation: 9, touched: false, active: true },
    { id: "touch", generation: 8, touched: true, active: true },
    { id: "touch-null", generation: null, touched: true, active: true },
    { id: "both", generation: 9, touched: true, active: true },
    { id: "future", generation: 11, touched: false, active: true },
  ];
  for (const row of rows) {
    const [fan] = await upsertFans(db.db, [{ platform: "fansly", platformUserId: row.id }]);
    if (!fan) throw new Error("membership fan seed failed");
    await upsertPageFollow(db.db, {
      platformAccountId: page.id, fanId: fan.id, platformFollowId: row.id,
      followedAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    await db.pool.query(`update page_follows set last_seen_generation = $1, is_active = $2,
      first_seen_at = $3::timestamptz - interval '1 day', last_seen_at = $4
      where platform_account_id = $5 and platform_follow_id = $6`, [
      row.generation, row.active, MEMBERSHIP_START,
      new Date(MEMBERSHIP_START.getTime() - (row.touched ? 0 : 1)), page.id, row.id,
    ]);
  }
  const run = await startSyncRun(db.db, {
    platformAccountId: page.id, stream: "followers_reconcile", trigger: "manual",
  });
  if (!run) throw new Error("membership run seed failed");
  const telemetry = new SyncRunTelemetry(app, {
    runId: run.id, platformAccountId: page.id, pageLabel: page.label,
    provider: "fansly", stream: "followers_reconcile", trigger: "manual", egressKey: "direct",
  });
  /** The walk's membership receipt over the seeded rows, then its run's end.
   *  Only a complete walk retired follows; its count is the guarded UPDATE's
   *  own result (the candidates unless a test says otherwise). */
  const recordMembershipAndFinishTelemetry = async (input: {
    outcome: MembershipOutcome;
    sourceFollowerCount?: number;
    deactivatedCount?: number;
    receipt?: boolean;
  }) => {
    const activity = await readPageFollowReconcileActivity(db.db, {
      platformAccountId: page.id, generation: GENERATION, fullSweepStartedAt: MEMBERSHIP_START,
    });
    if (input.receipt !== false) {
      await telemetry.addNote("Fansly followers membership verification", {
        followersMembership: {
          schemaVersion: 1,
          outcome: input.outcome,
          generation: GENERATION,
          fullSweepStartedAt: MEMBERSHIP_START.toISOString(),
          sourceFollowerCount: input.sourceFollowerCount ?? 2,
          generationObservedCount: Number(await countPageFollowsByGeneration(db.db, {
            platformAccountId: page.id, generation: GENERATION,
          })),
          activeFollowerCount: activity.activeFollowerCount,
          activeInGenerationCount: activity.activeInGenerationCount,
          activeOutsideGenerationCount: activity.activeOutsideGenerationCount,
          deactivationCandidateCount: activity.deactivationCandidateCount,
          generationGraceOnlyCount: activity.generationGraceOnlyCount,
          touchedSinceStartOnlyCount: activity.touchedSinceStartOnlyCount,
          generationGraceAndTouchCount: activity.generationGraceAndTouchCount,
          futureGenerationCount: activity.futureGenerationCount,
          deactivatedCount: input.outcome === "complete"
            ? input.deactivatedCount ?? activity.deactivationCandidateCount
            : null,
        },
      });
    }
    await telemetry.finish(input.outcome === "restart" ? "partial" : "success");
  };
  return { app, page, run, recordMembershipAndFinishTelemetry };
}
