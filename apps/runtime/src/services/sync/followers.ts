import {
  countActivePageFollows,
  deactivatePageFollowsMissingFromSnapshot,
  getCheckpoint,
  insertRawPayload,
  refreshFanPageFollowerState,
  rebuildFollowerRollups,
  upsertCheckpoint,
  upsertFanPage,
  upsertFans,
  upsertPageFollow,
} from "@fansly-connect/db";
import { FANSLY_MAPPER_VERSION } from "@fansly-connect/fansly";
import { fanslyFollowIdToDate } from "@fansly-connect/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { ResolvedFanslyPageContext } from "../page-context.ts";
import { summarizeCheckpoint, type SyncRunTelemetry } from "./observability.ts";
import { insertFailedSyncPayload, refreshPageMetadata, retentionDate } from "./shared.ts";

export async function runFollowerSyncUnlocked(
  app: AppContext,
  pageContext: ResolvedFanslyPageContext,
  observedRun: {
    run: {
      id: number;
    };
    telemetry: SyncRunTelemetry;
  },
  trigger = "cli",
) {
  const { run, telemetry } = observedRun;

  try {
    await telemetry.recordPhaseStarted("page_metadata", {
      trigger,
    });
    const accountMe = await refreshPageMetadata(app, pageContext, "followers", telemetry);
    const checkpoint = await getCheckpoint(app.db, pageContext.page.id, "followers");
    await telemetry.recordCheckpointLoaded("followers", summarizeCheckpoint(checkpoint));
    const knownFollowId = checkpoint?.cursorText ?? null;
    const requestContext = {
      session: pageContext.session,
      proxy: pageContext.proxy,
      telemetry,
    };

    let offset = 0;
    let processed = 0;
    let delta = 0;
    let newestFollowId: string | null = knownFollowId;
    let done = false;
    let incrementalPages = 0;
    let reconcilePages = 0;
    let sawKnownCheckpoint = false;
    let stopReason: "checkpoint_hit" | "end_of_list" | null = null;

    const fetchFollowersPage = async (pageOffset: number, mode: "incremental" | "reconcile") => {
      const page = await app.adapter.getFollowersPage(
        requestContext,
        accountMe.parsed.account.id,
        {
          offset: pageOffset,
          limit: 100,
          minDelayMs: app.config.followerPageDelayMs,
        },
      );

      await insertRawPayload(app.db, {
        platformAccountId: pageContext.page.id,
        syncRunId: run.id,
        endpoint: "followers",
        requestParams: { offset: pageOffset, limit: 100, mode },
        responsePayload: page.raw,
        mapperVersion: FANSLY_MAPPER_VERSION,
        payloadKind: "mapping_critical",
        retainUntil: retentionDate(),
      });

      return page;
    };

    await telemetry.recordPhaseStarted("followers_incremental");
    while (!done) {
      const page = await fetchFollowersPage(offset, "incremental");
      incrementalPages += 1;

      if (offset === 0 && page.items[0]?.id) {
        newestFollowId = page.items[0].id;
      }

      const fanRows = await upsertFans(app.db, page.accounts.map((account) => ({
        platform: "fansly" as const,
        platformUserId: account.id,
        username: account.username,
        displayName: account.displayName,
        createdAtExternal: account.createdAt ? new Date(account.createdAt) : null,
        metadata: {},
      })));
      const fanMap = new Map(fanRows.map((fan) => [fan.platformUserId, fan.id]));

      for (const follower of page.items) {
        processed += 1;
        if (knownFollowId && follower.id === knownFollowId) {
          done = true;
          sawKnownCheckpoint = true;
          stopReason = "checkpoint_hit";
          break;
        }

        const fanId = fanMap.get(follower.followerId);
        if (!fanId) {
          continue;
        }

        const followedAt = fanslyFollowIdToDate(follower.id);
        await upsertPageFollow(app.db, {
          platformAccountId: pageContext.page.id,
          fanId,
          platformFollowId: follower.id,
          followedAt,
        });
        await upsertFanPage(app.db, {
          fanId,
          platformAccountId: pageContext.page.id,
          isFollower: true,
          followerSince: followedAt,
        });
        delta += 1;
      }

      if (page.done) {
        done = true;
        stopReason = stopReason ?? "end_of_list";
      } else {
        offset += 100;
      }
    }

    const activeFollowerCount = await countActivePageFollows(app.db, pageContext.page.id);
    if (activeFollowerCount !== accountMe.parsed.account.followCount) {
      await telemetry.addAnomaly({
        code: "followers_reconcile_triggered",
        severity: "warn",
        message: "Follower reconcile was triggered because active follow count drifted from the source",
        details: {
          activeFollowerCount,
          sourceFollowerCount: accountMe.parsed.account.followCount,
        },
      });
      await telemetry.recordPhaseStarted("followers_reconcile");
      const activeFollowIds = new Set<string>();
      let reconcileOffset = 0;
      let reconcileDone = false;

      while (!reconcileDone) {
        const page = await fetchFollowersPage(reconcileOffset, "reconcile");
        reconcilePages += 1;
        if (reconcileOffset === 0 && page.items[0]?.id) {
          newestFollowId = page.items[0].id;
        }

        const fanRows = await upsertFans(app.db, page.accounts.map((account) => ({
          platform: "fansly" as const,
          platformUserId: account.id,
          username: account.username,
          displayName: account.displayName,
          createdAtExternal: account.createdAt ? new Date(account.createdAt) : null,
          metadata: {},
        })));
        const fanMap = new Map(fanRows.map((fan) => [fan.platformUserId, fan.id]));

        for (const follower of page.items) {
          activeFollowIds.add(follower.id);

          const fanId = fanMap.get(follower.followerId);
          if (!fanId) {
            continue;
          }

          const followedAt = fanslyFollowIdToDate(follower.id);
          await upsertPageFollow(app.db, {
            platformAccountId: pageContext.page.id,
            fanId,
            platformFollowId: follower.id,
            followedAt,
          });
          await upsertFanPage(app.db, {
            fanId,
            platformAccountId: pageContext.page.id,
            isFollower: true,
            followerSince: followedAt,
          });
        }

        if (page.done) {
          reconcileDone = true;
        } else {
          reconcileOffset += 100;
        }
      }

      await deactivatePageFollowsMissingFromSnapshot(
        app.db,
        pageContext.page.id,
        Array.from(activeFollowIds),
      );
      await refreshFanPageFollowerState(app.db, pageContext.page.id);
    }

    let checkpointAfter = null;
    await rebuildFollowerRollups(
      app.db,
      pageContext.page.id,
      accountMe.parsed.account.followCount,
    );
    if (newestFollowId) {
      checkpointAfter = await upsertCheckpoint(app.db, {
        platformAccountId: pageContext.page.id,
        stream: "followers",
        cursorText: newestFollowId,
        state: {
          pageLabel: pageContext.page.label,
          followerCount: accountMe.parsed.account.followCount,
        },
        lastSuccessfulRunId: run.id,
      });
    }
    await telemetry.recordCheckpointAdvanced("followers", summarizeCheckpoint(checkpointAfter));

    if (knownFollowId && !sawKnownCheckpoint && stopReason === "end_of_list") {
      await telemetry.addAnomaly({
        code: "followers_checkpoint_missed",
        severity: "error",
        message: "Follower scan reached the end of the list without encountering the previous checkpoint",
        details: {
          knownFollowId,
          newestFollowId,
        },
      });
    }

    if (
      checkpoint?.cursorText &&
      checkpointAfter?.cursorText &&
      checkpointAfter.cursorText === checkpoint.cursorText &&
      processed > 0
    ) {
      await telemetry.addAnomaly({
        code: "checkpoint_stalled",
        severity: "error",
        message: "Follower checkpoint did not advance despite scanning follower data",
        details: {
          cursorText: checkpoint.cursorText,
          processed,
        },
      });
    }

    telemetry.setScanSummary({
      processed,
      delta,
      followerCount: accountMe.parsed.account.followCount,
      incrementalPages,
      reconcilePages,
      stopReason,
      knownFollowId,
      newestFollowId,
      approximateScanSpanMs: newestFollowId && knownFollowId
        ? Math.max(
          0,
          fanslyFollowIdToDate(newestFollowId).getTime() - fanslyFollowIdToDate(knownFollowId).getTime(),
        )
        : null,
    });
    const finishedRun = await telemetry.finish("success", null, {
      processed,
      delta,
      followerCount: accountMe.parsed.account.followCount,
    });

    return {
      runId: finishedRun.id,
      status: finishedRun.status,
      processed,
      delta,
      followerCount: accountMe.parsed.account.followCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await insertFailedSyncPayload(app, {
      platformAccountId: pageContext.page.id,
      syncRunId: run.id,
      endpoint: "followers",
      message,
      platform: "fansly",
    });
    await telemetry.finish("failed", message);
    throw error;
  }
}
