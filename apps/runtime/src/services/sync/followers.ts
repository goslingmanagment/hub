import {
  countActivePageFollows,
  deactivatePageFollowsMissingFromSnapshot,
  finishSyncRun,
  getCheckpoint,
  insertRawPayload,
  refreshFanPageFollowerState,
  rebuildFollowerRollups,
  startSyncRun,
  upsertCheckpoint,
  upsertFanPage,
  upsertFans,
  upsertPageFollow,
} from "@fansly-connect/db";
import { FANSLY_MAPPER_VERSION } from "@fansly-connect/fansly";
import { fanslyFollowIdToDate } from "@fansly-connect/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { ResolvedFanslyPageContext } from "../page-context.ts";
import { insertFailedSyncPayload, refreshPageMetadata, retentionDate } from "./shared.ts";

export async function runFollowerSyncUnlocked(
  app: AppContext,
  pageContext: ResolvedFanslyPageContext,
  trigger = "cli",
) {
  const run = await startSyncRun(app.db, {
    platformAccountId: pageContext.page.id,
    stream: "followers",
    trigger,
  });

  try {
    const accountMe = await refreshPageMetadata(app, pageContext, "followers");
    const checkpoint = await getCheckpoint(app.db, pageContext.page.id, "followers");
    const knownFollowId = checkpoint?.cursorText ?? null;
    const requestContext = { session: pageContext.session, proxy: pageContext.proxy };

    let offset = 0;
    let processed = 0;
    let delta = 0;
    let newestFollowId: string | null = knownFollowId;
    let done = false;

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

    while (!done) {
      const page = await fetchFollowersPage(offset, "incremental");

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
      } else {
        offset += 100;
      }
    }

    const activeFollowerCount = await countActivePageFollows(app.db, pageContext.page.id);
    if (activeFollowerCount !== accountMe.parsed.account.followCount) {
      const activeFollowIds = new Set<string>();
      let reconcileOffset = 0;
      let reconcileDone = false;

      while (!reconcileDone) {
        const page = await fetchFollowersPage(reconcileOffset, "reconcile");
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

    await rebuildFollowerRollups(
      app.db,
      pageContext.page.id,
      accountMe.parsed.account.followCount,
    );
    if (newestFollowId) {
      await upsertCheckpoint(app.db, {
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

    await finishSyncRun(app.db, run.id, {
      status: "success",
      stats: {
        processed,
        delta,
        followerCount: accountMe.parsed.account.followCount,
      },
    });

    return {
      runId: run.id,
      status: "success" as const,
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
    await finishSyncRun(app.db, run.id, {
      status: "failed",
      errorSummary: message,
    });
    throw error;
  }
}
