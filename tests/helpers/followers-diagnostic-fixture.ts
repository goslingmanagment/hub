import {
  createFanslyPage,
  createModel,
  requestPageSync,
  startSyncRun,
} from "@agency_hub_core/db";
import { SyncRunTelemetry } from "../../apps/runtime/src/services/sync/observability.ts";
import { followersReconcileDecision } from "../../apps/runtime/src/sync/fansly/lib/followers-reconcile-decision.ts";
import type { StartedTestDatabase } from "./db.ts";
import { seedFormerFanslyRows } from "./fansly-legacy-rows.ts";
import { createTestAppContext } from "./runtime.ts";

// The C1 readers (fansly_followers_diagnostic_report and
// fansly_followers_diagnostic_timeline, migrations 0182-0185) read the
// receipts the legacy Fansly followers walk wrote into sync_run_events. The
// walk is deleted (step 4, S4-17); the readers stay for the receipts
// production holds. This fixture writes one walk's run and its decision
// receipt as the walk did: the decision over what the walk saw, and, when the
// decision asks for a reconcile, the locked queue receipt of the anomaly
// request it filed.

export type FollowersWalkMode = "none" | "count" | "missing" | "unchanged" | "crossed";

/** What one page of the walk saw in each mode (follow ids descend down the
 *  list, as Fansly serves them); every walk wrote one follow. "missing" ran
 *  off the end of the list without its known follow, "crossed" stopped at the
 *  first row older than it, "unchanged" met its known follow under a head that
 *  had not moved, "count" found fewer follows than the headline count. */
const WALKS: Record<FollowersWalkMode, {
  knownFollowId: string | null;
  newestFollowId: string;
  pageDone: boolean;
  crossedKnownBoundary: boolean;
  sawKnownCheckpoint: boolean;
  sourceFollowerCount: number;
}> = {
  none: {
    knownFollowId: null, newestFollowId: "1000", pageDone: true,
    crossedKnownBoundary: false, sawKnownCheckpoint: false, sourceFollowerCount: 1,
  },
  count: {
    knownFollowId: null, newestFollowId: "1000", pageDone: true,
    crossedKnownBoundary: false, sawKnownCheckpoint: false, sourceFollowerCount: 2,
  },
  missing: {
    knownFollowId: "999", newestFollowId: "1000", pageDone: true,
    crossedKnownBoundary: false, sawKnownCheckpoint: false, sourceFollowerCount: 1,
  },
  unchanged: {
    knownFollowId: "999", newestFollowId: "999", pageDone: false,
    crossedKnownBoundary: false, sawKnownCheckpoint: true, sourceFollowerCount: 1,
  },
  crossed: {
    knownFollowId: "1001", newestFollowId: "1002", pageDone: false,
    crossedKnownBoundary: true, sawKnownCheckpoint: false, sourceFollowerCount: 1,
  },
};

export async function followersDiagnosticFixture(
  db: StartedTestDatabase,
  mode: FollowersWalkMode = "none",
) {
  const app = createTestAppContext(db);
  const model = await createModel(db.db, { slug: "followers-diagnostic", name: "Followers" });
  if (!model) throw new Error("model seed failed");
  const page = await createFanslyPage(db.db, { modelId: model.id, label: "followers-diagnostic" });
  if (!page) throw new Error("page seed failed");
  // The page's legacy rows as an old planner seeded them (nothing seeds a
  // Fansly page's rows since step 4, S4-24): the diagnostics read records.
  await seedFormerFanslyRows(db.pool, page.id, new Date());
  const run = await startSyncRun(db.db, {
    platformAccountId: page.id,
    stream: "followers",
    trigger: "manual",
  });
  if (!run) throw new Error("run seed failed");
  const telemetry = new SyncRunTelemetry(app, {
    runId: run.id,
    platformAccountId: page.id,
    pageLabel: page.label,
    provider: "fansly",
    stream: "followers",
    trigger: "manual",
    egressKey: "direct",
  });
  const queue = async () => {
    const result = await db.pool.query<{ request_seq: string }>(
      "select request_seq::text from page_sync_states where page_id = $1 and stream = 'followers_reconcile'",
      [page.id],
    );
    const row = result.rows[0];
    if (!row) throw new Error("followers reconcile queue seed missing");
    return row.request_seq;
  };
  /** The walk's completion: its decision receipt (fail-open, as telemetry
   *  is) and its run finished as a success. */
  const recordWalkAndFinishTelemetry = async () => {
    const walk = WALKS[mode];
    const counts = {
      activeFollowerCount: 1,
      sourceFollowerCount: walk.sourceFollowerCount,
      pageCount: 1,
      processedThisChunk: 1,
    };
    const decision = followersReconcileDecision({ ...walk, ...counts });
    const receipt = decision.requested
      ? (await requestPageSync(db.db, {
        pageId: page.id,
        streams: ["followers_reconcile"],
        source: "anomaly",
        includeQueueState: true,
        coalesceOutstanding: true,
      }))?.find((row) => row.stream === "followers_reconcile") ?? null
      : null;
    await telemetry.addNote("Fansly followers reconcile decision", {
      followersReconcile: {
        schemaVersion: 1, ...decision, counts,
        knownCheckpoint: walk.knownFollowId !== null, pageDone: walk.pageDone,
        requestedSeq: receipt?.requestedSeq ?? null, queueBefore: receipt?.queueBefore ?? null,
        coalesced: receipt?.coalesced === true,
      },
    });
    await telemetry.finish("success");
    return decision;
  };
  return { app, page, run, telemetry, recordWalkAndFinishTelemetry, queue };
}
