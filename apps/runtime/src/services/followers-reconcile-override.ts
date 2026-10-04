import {
  closeQuarantinedWork,
  countActiveLiveWorkByResource,
  deactivatePageFollowsByGeneration,
  getOpenWorkForKey,
  getSyncPage,
  listPageFollowDeactivationCandidates,
  readPageFollowReconcileActivity,
  rebuildFollowerRollups,
  refreshFanPageFollowerState,
  syncWorkQuarantineOf,
  type Database,
  type PageFollowDeactivationCandidate,
  type SyncPageRow,
  type SyncStream,
} from "@agency_hub_core/db";
import { sql } from "drizzle-orm";

import type { AppContext } from "../bootstrap.ts";
import { fanslyKeysForStreams } from "../sync/fansly/legacy-streams.ts";
import {
  followersReconcileCursorAfterOverride,
  parseFollowersReconcileCursor,
} from "../sync/fansly/resources/followers.ts";
import { recordAudit } from "./auth.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { engineOwnedSyncPageByLabel } from "./sync-engine-levers.ts";
import {
  followersReconcileCandidateGenerationBuckets,
  followersReconcileCandidateSha256,
  followersReconcileDeactivationLimit,
} from "../sync/fansly/lib/followers-reconcile-safety.ts";

const FOLLOWERS_RECONCILE_BLAST_RADIUS_BLOCKER =
  "followers_reconcile_deactivation_blast_radius";
const AUDIENCE_STREAMS = [
  "subscribers",
  "followers",
  "followers_reconcile",
] as const satisfies readonly SyncStream[];

type OverrideAuditContext = {
  source: string;
  actorUserId?: number | null;
  actorAgentKeyId?: number | null;
};

type PageRow = {
  id: string;
  label: string;
  platform: string;
  followerCount: number | string | null;
};

type SyncStateRow = {
  stream: string;
  status: string;
  requestSeq: number | string;
  appliedSeq: number | string;
  blockerKind: string | null;
  blockerCode: string | null;
  blockedAt: Date | string | null;
  leasedSeq: number | string | null;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseHeartbeatAt: Date | string | null;
  leaseExpiresAt: Date | string | null;
};

type CursorRow = {
  state: unknown;
};

type BlockedReconcileState = {
  requestSeq: number;
  blockedAt: string;
  generation: number;
  fullSweepStartedAt: string;
};

function toInteger(value: unknown, field: string) {
  const normalized = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new ConflictError(`Follower reconcile ${field} is not a safe non-negative integer`);
  }
  return normalized;
}

function toIsoTimestamp(value: Date | string | null, field: string) {
  if (value === null) {
    throw new ConflictError(`Follower reconcile ${field} is missing`);
  }
  const normalized = new Date(value);
  if (Number.isNaN(normalized.getTime())) {
    throw new ConflictError(`Follower reconcile ${field} is invalid`);
  }
  return normalized.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasAnyLease(row: SyncStateRow) {
  return row.leasedSeq !== null ||
    row.leaseOwner !== null ||
    row.leaseToken !== null ||
    row.leaseHeartbeatAt !== null ||
    row.leaseExpiresAt !== null;
}

async function readPage(
  db: Database,
  pageLabel: string,
  options: { lock: boolean },
) {
  const result = await db.execute<PageRow>(sql`
    select id::text as id,
           label,
           platform,
           follower_count as "followerCount"
    from pages
    where label = ${pageLabel}
      and status = 'active'
    ${options.lock ? sql`for update` : sql``}
  `);
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError(`Page "${pageLabel}" not found`);
  }
  if (row.platform !== "fansly") {
    throw new BadRequestError("Follower reconcile is available only on Fansly pages");
  }
  return {
    id: toInteger(row.id, "page id"),
    label: row.label,
    followerCount: row.followerCount === null
      ? null
      : toInteger(row.followerCount, "headline follower count"),
  };
}

async function readAudienceStates(
  db: Database,
  pageId: number,
  options: { lock: boolean },
) {
  const result = await db.execute<SyncStateRow>(sql`
    select stream::text as stream,
           status::text as status,
           request_seq as "requestSeq",
           applied_seq as "appliedSeq",
           blocker_kind as "blockerKind",
           blocker_code as "blockerCode",
           blocked_at as "blockedAt",
           leased_seq as "leasedSeq",
           lease_owner as "leaseOwner",
           lease_token as "leaseToken",
           lease_heartbeat_at as "leaseHeartbeatAt",
           lease_expires_at as "leaseExpiresAt"
    from page_sync_states
    where page_id = ${pageId}
      and stream = any(${`{${AUDIENCE_STREAMS.join(",")}}`}::sync_stream[])
    order by stream asc
    ${options.lock ? sql`for update` : sql``}
  `);

  const rowsByStream = new Map(result.rows.map((row) => [row.stream, row]));
  const rows = AUDIENCE_STREAMS.map((stream) => rowsByStream.get(stream));
  if (rows.some((row) => row === undefined)) {
    throw new ConflictError("All audience sync states must exist before follower override");
  }
  return rows as SyncStateRow[];
}

async function readReconcileCursor(
  db: Database,
  pageId: number,
  options: { lock: boolean },
) {
  const result = await db.execute<CursorRow>(sql`
    select state
    from page_sync_cursors
    where page_id = ${pageId}
      and stream = 'followers_reconcile'
    ${options.lock ? sql`for update` : sql``}
  `);
  const row = result.rows[0];
  if (!row) {
    throw new ConflictError("Follower reconcile cursor is missing");
  }
  return row;
}

function parseBlockedReconcileState(
  audienceStates: SyncStateRow[],
  cursor: CursorRow,
): BlockedReconcileState {
  const reconcile = audienceStates.find((row) => row.stream === "followers_reconcile");
  if (!reconcile) {
    throw new ConflictError("Follower reconcile sync state is missing");
  }
  if (
    reconcile.blockerKind !== "provider_bad_data" ||
    reconcile.blockerCode !== FOLLOWERS_RECONCILE_BLAST_RADIUS_BLOCKER ||
    !["blocked", "paused"].includes(reconcile.status)
  ) {
    throw new ConflictError("Follower reconcile is not blocked by the blast-radius guard");
  }

  const requestSeq = toInteger(reconcile.requestSeq, "request sequence");
  const appliedSeq = toInteger(reconcile.appliedSeq, "applied sequence");
  if (requestSeq <= appliedSeq) {
    throw new ConflictError("Follower reconcile blast-radius block is no longer outstanding");
  }

  const state = asRecord(cursor.state);
  if (!state || state.verificationPending !== true) {
    throw new ConflictError("Follower reconcile cursor is not awaiting terminal verification");
  }
  const revision = toInteger(state.revision, "cursor revision");
  if (revision !== requestSeq) {
    throw new ConflictError("Follower reconcile cursor revision does not match the blocked request");
  }
  const generation = toInteger(state.generation, "generation");
  if (generation === 0) {
    throw new ConflictError("Follower reconcile generation must be positive");
  }
  if (typeof state.fullSweepStartedAt !== "string") {
    throw new ConflictError("Follower reconcile full-sweep start is missing");
  }

  return {
    requestSeq,
    blockedAt: toIsoTimestamp(reconcile.blockedAt, "blocked timestamp"),
    generation,
    fullSweepStartedAt: toIsoTimestamp(
      state.fullSweepStartedAt,
      "full-sweep start",
    ),
  };
}

function buildCandidateView(candidates: PageFollowDeactivationCandidate[]) {
  return {
    candidateCount: candidates.length,
    candidateSha256: followersReconcileCandidateSha256(candidates),
    candidateGenerationBuckets:
      followersReconcileCandidateGenerationBuckets(candidates),
  };
}

async function readCandidatesAndActivity(
  db: Database,
  input: {
    pageId: number;
    generation: number;
    fullSweepStartedAt: string;
    lockCandidates: boolean;
  },
) {
  const predicate = {
    platformAccountId: input.pageId,
    generation: input.generation,
    fullSweepStartedAt: new Date(input.fullSweepStartedAt),
  };
  const candidates = await listPageFollowDeactivationCandidates(
    db,
    predicate,
    { lock: input.lockCandidates },
  );
  const activity = await readPageFollowReconcileActivity(db, predicate);
  if (activity.deactivationCandidateCount !== candidates.length) {
    throw new ConflictError("Follower reconcile candidate set changed during verification; preview again");
  }
  return { candidates, activity };
}

// ── engine pages (design step 3 §3.2 item 4) ────────────────────────────────
//
// On a page the Fansly Sync Engine owns, the walk that refused its
// deactivation is the quarantined `followers.reconcile` work row: the engine
// apply threw `ApplyQuarantine("followers_reconcile_deactivation_blast_radius")`
// and rolled back, so the row's cursor still holds the walk (generation, full
// sweep start, verification pending) and `result.quarantine` records the
// refusal. The candidates, the hash echo and the deactivation are the same as
// on a legacy page; the pause precondition is the engine's (every audience key
// paused, no audience read in flight); the override closes the row done with
// the finished walk as its cursor, so the next walk anchors its daily floor on
// it. Legacy state is never touched.

const ENGINE_RECONCILE_KEY = "followers.reconcile";

type EngineBlockedReconcile = BlockedReconcileState & { workId: number; cursor: unknown };

async function readEngineBlockedReconcile(db: Database, pageId: number): Promise<EngineBlockedReconcile> {
  const work = await getOpenWorkForKey(db, { pageId, shadow: false, resource: ENGINE_RECONCILE_KEY, subject: "" });
  const quarantine = work === null ? null : syncWorkQuarantineOf(work.result);
  if (work === null || work.state !== "quarantined" || quarantine?.detail.refusal !== FOLLOWERS_RECONCILE_BLAST_RADIUS_BLOCKER) {
    throw new ConflictError("Follower reconcile is not blocked by the blast-radius guard");
  }
  const walk = parseFollowersReconcileCursor(work.cursor).walk;
  if (walk === null || !walk.verificationPending) {
    throw new ConflictError("Follower reconcile cursor is not awaiting terminal verification");
  }
  const generation = toInteger(walk.generation, "generation");
  if (generation === 0) {
    throw new ConflictError("Follower reconcile generation must be positive");
  }
  const fullSweepStartedAt = toIsoTimestamp(walk.fullSweepStartedAt, "full-sweep start");
  // The refusal recorded the walk it judged; a cursor that moved since is
  // another walk's.
  const recordedGeneration = quarantine.detail.generation;
  const recordedStart = quarantine.detail.fullSweepStartedAt;
  if (
    (recordedGeneration !== undefined && recordedGeneration !== generation) ||
    (typeof recordedStart === "string" && toIsoTimestamp(recordedStart, "recorded full-sweep start") !== fullSweepStartedAt)
  ) {
    throw new ConflictError("Follower reconcile cursor does not match the blocked walk");
  }
  return {
    workId: work.id,
    requestSeq: work.id,
    blockedAt: toIsoTimestamp(quarantine.at, "blocked timestamp"),
    generation,
    fullSweepStartedAt,
    cursor: work.cursor,
  };
}

/** The engine's audience precondition: every audience key paused (or the
 *  whole page), and no audience read in flight. */
async function readEngineAudience(db: Database, page: SyncPageRow) {
  const keys = fanslyKeysForStreams(AUDIENCE_STREAMS);
  const paused = page.pausedAll || keys.every((key) => page.pausedResources.includes(key));
  const counts = await countActiveLiveWorkByResource(db, { pageIds: [page.pageId] });
  const leaseFree = counts.every((row) => !keys.includes(row.resource) || row.running === 0);
  return { keys, paused, leaseFree };
}

async function readEngineSyncPage(db: Database, pageId: number): Promise<SyncPageRow> {
  const page = await getSyncPage(db, pageId);
  if (page === null || (page.mode !== "handover" && page.mode !== "live")) {
    throw new ConflictError("The page left the Fansly Sync Engine; preview again");
  }
  return page;
}

async function previewEngineFollowersOverride(app: Pick<AppContext, "db">, input: { pageLabel: string }) {
  return app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const page = await readPage(db, input.pageLabel, { lock: false });
    const syncPage = await readEngineSyncPage(db, page.id);
    const blocked = await readEngineBlockedReconcile(db, page.id);
    const { candidates, activity } = await readCandidatesAndActivity(db, {
      pageId: page.id,
      generation: blocked.generation,
      fullSweepStartedAt: blocked.fullSweepStartedAt,
      lockCandidates: false,
    });
    const candidateView = buildCandidateView(candidates);
    const deactivationLimit = followersReconcileDeactivationLimit(activity.activeFollowerCount);
    const audience = await readEngineAudience(db, syncPage);
    const overrideRequired = candidates.length > deactivationLimit;
    return {
      accepted: true as const,
      action: "preview" as const,
      pageLabel: page.label,
      stream: "followers_reconcile" as const,
      blockedRequestSeq: blocked.requestSeq,
      blockedAt: blocked.blockedAt,
      generation: blocked.generation,
      fullSweepStartedAt: blocked.fullSweepStartedAt,
      activeFollowerCount: activity.activeFollowerCount,
      deactivationLimit,
      ...candidateView,
      audiencePaused: audience.paused,
      audienceLeaseFree: audience.leaseFree,
      overrideRequired,
      readyToApply: audience.paused && audience.leaseFree && overrideRequired,
    };
  });
}

async function applyEngineFollowersOverride(
  app: Pick<AppContext, "db">,
  input: Parameters<typeof applyFollowersReconcileBlastRadiusOverride>[1],
  audit: OverrideAuditContext,
) {
  return app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const page = await readPage(db, input.pageLabel, { lock: false });
    const syncPage = await readEngineSyncPage(db, page.id);
    const audience = await readEngineAudience(db, syncPage);
    if (!audience.paused) {
      throw new ConflictError("Pause the entire audience block before applying follower override");
    }
    if (!audience.leaseFree) {
      throw new ConflictError("Audience sync still has a read in flight; wait for it to land");
    }
    const blocked = await readEngineBlockedReconcile(db, page.id);
    if (
      blocked.requestSeq !== input.blockedRequestSeq ||
      blocked.blockedAt !== input.blockedAt ||
      blocked.generation !== input.generation ||
      blocked.fullSweepStartedAt !== input.fullSweepStartedAt
    ) {
      throw new ConflictError("Follower reconcile blocked state changed; preview again");
    }
    if (page.followerCount === null) {
      throw new ConflictError("Follower headline is missing; run a fresh reconcile instead");
    }
    const { candidates, activity } = await readCandidatesAndActivity(db, {
      pageId: page.id,
      generation: blocked.generation,
      fullSweepStartedAt: blocked.fullSweepStartedAt,
      lockCandidates: true,
    });
    const candidateView = buildCandidateView(candidates);
    const deactivationLimit = followersReconcileDeactivationLimit(activity.activeFollowerCount);
    if (candidates.length <= deactivationLimit) {
      throw new ConflictError(
        `Follower reconcile now has ${candidates.length} candidates, within the normal limit ${deactivationLimit}; reset the stream instead of overriding`,
      );
    }
    if (candidateView.candidateSha256 !== input.candidateSha256) {
      throw new ConflictError("Follower reconcile candidate set changed; preview again");
    }

    const deactivatedIds = await deactivatePageFollowsByGeneration(db, {
      platformAccountId: page.id,
      generation: blocked.generation,
      lastSeenBefore: new Date(blocked.fullSweepStartedAt),
    });
    if (
      deactivatedIds.length !== candidates.length ||
      followersReconcileCandidateSha256(deactivatedIds.map((id) => ({ id }))) !== candidateView.candidateSha256
    ) {
      throw new ConflictError("Follower reconcile candidate set changed during apply; no rows committed");
    }
    await refreshFanPageFollowerState(db, page.id);
    await rebuildFollowerRollups(db, page.id, page.followerCount);

    // sync_work after the follow tables (the engine's lock order).
    const receipt = {
      outcome: "blast_radius_override_applied",
      destructiveFinalization: true,
      generation: blocked.generation,
      fullSweepStartedAt: blocked.fullSweepStartedAt,
      activeFollowerCount: activity.activeFollowerCount,
      deactivationLimit,
      ...candidateView,
      deactivatedCount: deactivatedIds.length,
    };
    const cursor = followersReconcileCursorAfterOverride(blocked.cursor, receipt);
    const closed = cursor !== null && await closeQuarantinedWork(db, {
      workId: blocked.workId,
      to: "done",
      closeReason: "blast_radius_override_applied",
      cursor,
      proof: receipt,
    });
    if (!closed) {
      throw new ConflictError("Follower reconcile blocked state changed; preview again");
    }
    await recordAudit({ db }, {
      ...audit,
      eventType: "admin.followers_reconcile_blast_radius_override_applied",
      platformAccountId: page.id,
      metadata: {
        stream: "followers_reconcile",
        engine: { mode: syncPage.mode, workId: blocked.workId, resource: ENGINE_RECONCILE_KEY },
        blockedRequestSeq: blocked.requestSeq,
        blockedAt: blocked.blockedAt,
        generation: blocked.generation,
        fullSweepStartedAt: blocked.fullSweepStartedAt,
        activeFollowerCount: activity.activeFollowerCount,
        deactivationLimit,
        ...candidateView,
        deactivatedCount: deactivatedIds.length,
        audienceResources: audience.keys,
      },
    });
    return {
      accepted: true as const,
      action: "apply" as const,
      pageLabel: page.label,
      stream: "followers_reconcile" as const,
      blockedRequestSeq: blocked.requestSeq,
      blockedAt: blocked.blockedAt,
      generation: blocked.generation,
      fullSweepStartedAt: blocked.fullSweepStartedAt,
      activeFollowerCount: activity.activeFollowerCount,
      deactivationLimit,
      ...candidateView,
      deactivatedCount: deactivatedIds.length,
      audienceRemainsPaused: true as const,
    };
  }, { isolationLevel: "serializable" });
}

/** Postgres refused the transaction for a concurrent change (40001) or a
 *  lock cycle (40P01): the owner previews again. */
function concurrentChange(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && (error.code === "40001" || error.code === "40P01");
}

export async function previewFollowersReconcileBlastRadiusOverride(
  app: Pick<AppContext, "db">,
  input: { pageLabel: string },
) {
  // A page the Fansly Sync Engine owns: the quarantined engine walk.
  if ((await engineOwnedSyncPageByLabel(app.db, input.pageLabel)) !== null) {
    return previewEngineFollowersOverride(app, input);
  }
  return app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const page = await readPage(db, input.pageLabel, { lock: false });
    const audienceStates = await readAudienceStates(db, page.id, { lock: false });
    const cursor = await readReconcileCursor(db, page.id, { lock: false });
    const blocked = parseBlockedReconcileState(audienceStates, cursor);
    const { candidates, activity } = await readCandidatesAndActivity(db, {
      pageId: page.id,
      generation: blocked.generation,
      fullSweepStartedAt: blocked.fullSweepStartedAt,
      lockCandidates: false,
    });
    const candidateView = buildCandidateView(candidates);
    const deactivationLimit = followersReconcileDeactivationLimit(
      activity.activeFollowerCount,
    );
    const audiencePaused = audienceStates.every((row) => row.status === "paused");
    const audienceLeaseFree = audienceStates.every((row) => !hasAnyLease(row));
    const overrideRequired = candidates.length > deactivationLimit;

    return {
      accepted: true as const,
      action: "preview" as const,
      pageLabel: page.label,
      stream: "followers_reconcile" as const,
      blockedRequestSeq: blocked.requestSeq,
      blockedAt: blocked.blockedAt,
      generation: blocked.generation,
      fullSweepStartedAt: blocked.fullSweepStartedAt,
      activeFollowerCount: activity.activeFollowerCount,
      deactivationLimit,
      ...candidateView,
      audiencePaused,
      audienceLeaseFree,
      overrideRequired,
      readyToApply: audiencePaused && audienceLeaseFree && overrideRequired,
    };
  });
}

export async function applyFollowersReconcileBlastRadiusOverride(
  app: Pick<AppContext, "db">,
  input: {
    pageLabel: string;
    blockedRequestSeq: number;
    blockedAt: string;
    generation: number;
    fullSweepStartedAt: string;
    candidateSha256: string;
  },
  audit: OverrideAuditContext,
) {
  if ((await engineOwnedSyncPageByLabel(app.db, input.pageLabel)) !== null) {
    try {
      return await applyEngineFollowersOverride(app, input, audit);
    } catch (error) {
      if (concurrentChange(error)) throw new ConflictError("Follower reconcile changed concurrently; preview again");
      throw error;
    }
  }
  try {
    return await app.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      const page = await readPage(db, input.pageLabel, { lock: true });
      const audienceStates = await readAudienceStates(db, page.id, { lock: true });
      if (!audienceStates.every((row) => row.status === "paused")) {
        throw new ConflictError(
          "Pause the entire audience block before applying follower override",
        );
      }
      if (!audienceStates.every((row) => !hasAnyLease(row))) {
        throw new ConflictError(
          "Audience sync still has a lease; wait for every lease to clear",
        );
      }

      const cursor = await readReconcileCursor(db, page.id, { lock: true });
      const blocked = parseBlockedReconcileState(audienceStates, cursor);
      if (
        blocked.requestSeq !== input.blockedRequestSeq ||
        blocked.blockedAt !== input.blockedAt ||
        blocked.generation !== input.generation ||
        blocked.fullSweepStartedAt !== input.fullSweepStartedAt
      ) {
        throw new ConflictError("Follower reconcile blocked state changed; preview again");
      }
      if (page.followerCount === null) {
        throw new ConflictError("Follower headline is missing; run a fresh reconcile instead");
      }

      const { candidates, activity } = await readCandidatesAndActivity(db, {
        pageId: page.id,
        generation: blocked.generation,
        fullSweepStartedAt: blocked.fullSweepStartedAt,
        lockCandidates: true,
      });
      const candidateView = buildCandidateView(candidates);
      const deactivationLimit = followersReconcileDeactivationLimit(
        activity.activeFollowerCount,
      );
      if (candidates.length <= deactivationLimit) {
        throw new ConflictError(
          `Follower reconcile now has ${candidates.length} candidates, within the normal limit ${deactivationLimit}; reset the stream instead of overriding`,
        );
      }
      if (candidateView.candidateSha256 !== input.candidateSha256) {
        throw new ConflictError("Follower reconcile candidate set changed; preview again");
      }

      const deactivatedIds = await deactivatePageFollowsByGeneration(db, {
        platformAccountId: page.id,
        generation: blocked.generation,
        lastSeenBefore: new Date(blocked.fullSweepStartedAt),
      });
      if (
        deactivatedIds.length !== candidates.length ||
        followersReconcileCandidateSha256(deactivatedIds.map((id) => ({ id }))) !==
          candidateView.candidateSha256
      ) {
        throw new ConflictError(
          "Follower reconcile candidate set changed during apply; no rows committed",
        );
      }

      await refreshFanPageFollowerState(db, page.id);
      await rebuildFollowerRollups(db, page.id, page.followerCount);
      await recordAudit({ db }, {
        ...audit,
        eventType: "admin.followers_reconcile_blast_radius_override_applied",
        platformAccountId: page.id,
        metadata: {
          stream: "followers_reconcile",
          blockedRequestSeq: blocked.requestSeq,
          blockedAt: blocked.blockedAt,
          generation: blocked.generation,
          fullSweepStartedAt: blocked.fullSweepStartedAt,
          activeFollowerCount: activity.activeFollowerCount,
          deactivationLimit,
          ...candidateView,
          deactivatedCount: deactivatedIds.length,
          audienceStreams: [...AUDIENCE_STREAMS],
        },
      });

      return {
        accepted: true as const,
        action: "apply" as const,
        pageLabel: page.label,
        stream: "followers_reconcile" as const,
        blockedRequestSeq: blocked.requestSeq,
        blockedAt: blocked.blockedAt,
        generation: blocked.generation,
        fullSweepStartedAt: blocked.fullSweepStartedAt,
        activeFollowerCount: activity.activeFollowerCount,
        deactivationLimit,
        ...candidateView,
        deactivatedCount: deactivatedIds.length,
        audienceRemainsPaused: true as const,
      };
    }, { isolationLevel: "serializable" });
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "40001"
    ) {
      throw new ConflictError("Follower reconcile changed concurrently; preview again");
    }
    throw error;
  }
}
