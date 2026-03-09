import {
  deleteExpiredRawPayloads,
  findPageByLabel,
  finishSyncRun,
  getCurrentSubscribers,
  getFollowersForPage,
  getFanSpendByIdentifier,
  getRevenueBreakdown,
  insertRawPayload,
  listFanslyPages,
  listModelsWithPageCounts,
  listPageSummaries,
  listRecentSyncRuns,
  listTopFansForPage,
  startSyncRun,
} from "@fansly-connect/db";
import { FANSLY_MAPPER_VERSION } from "@fansly-connect/fansly";
import { ONLYMONSTER_MAPPER_VERSION } from "@fansly-connect/onlyfans";
import { resolvePeriodBounds } from "@fansly-connect/shared";

import type { AppContext } from "../bootstrap.ts";
import { resolvePageContext, type ResolvedPageContext } from "./page-context.ts";
import { runFollowerSyncUnlocked } from "./sync/followers.ts";
import { PageSyncLockedError, withPageSyncLock } from "./sync/locking.ts";
import { syncOnlyFansTransactions } from "./sync/onlyfans-transactions.ts";
import {
  insertFailedSyncPayload,
  refreshPageMetadata,
  retentionDate,
} from "./sync/shared.ts";
import { syncSubscribers } from "./sync/subscribers.ts";
import { syncTransactions } from "./sync/transactions.ts";

async function withResolvedPageLock<T>(
  app: AppContext,
  label: string,
  run: (pageContext: ResolvedPageContext) => Promise<T>,
) {
  const pageContext = await resolvePageContext(app, label);
  return withPageSyncLock(
    app,
    {
      pageId: pageContext.page.id,
      pageLabel: pageContext.page.label,
    },
    () => run(pageContext),
  );
}

async function runLightSyncUnlocked(
  app: AppContext,
  pageContext: ResolvedPageContext,
  trigger = "cli",
) {
  const run = await startSyncRun(app.db, {
    platformAccountId: pageContext.page.id,
    stream: "light",
    trigger,
  });

  const errors: string[] = [];
  const stats: Record<string, unknown> = {};

  try {
    if (pageContext.platform === "fansly") {
      const accountMe = await refreshPageMetadata(app, pageContext, "light");
      await insertRawPayload(app.db, {
        platformAccountId: pageContext.page.id,
        syncRunId: run.id,
        endpoint: "account_me",
        requestParams: {},
        responsePayload: accountMe.raw,
        mapperVersion: FANSLY_MAPPER_VERSION,
        payloadKind: "mapping_critical",
        retainUntil: retentionDate(),
      });

      try {
        stats.transactions = await syncTransactions(app, {
          pageLabel: pageContext.page.label,
          platformAccountId: pageContext.page.id,
          requestContext: { session: pageContext.session, proxy: pageContext.proxy },
          syncRunId: run.id,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`transactions: ${message}`);
      }

      try {
        stats.subscribers = await syncSubscribers(app, {
          pageLabel: pageContext.page.label,
          platformAccountId: pageContext.page.id,
          requestContext: { session: pageContext.session, proxy: pageContext.proxy },
          syncRunId: run.id,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`subscribers: ${message}`);
      }
    } else {
      const account = await refreshPageMetadata(app, pageContext, "light");
      await insertRawPayload(app.db, {
        platformAccountId: pageContext.page.id,
        syncRunId: run.id,
        endpoint: "onlymonster_account",
        requestParams: {},
        responsePayload: account.raw,
        mapperVersion: ONLYMONSTER_MAPPER_VERSION,
        payloadKind: "mapping_critical",
        retainUntil: retentionDate(),
      });

      try {
        stats.transactions = await syncOnlyFansTransactions(app, {
          pageLabel: pageContext.page.label,
          platformAccountId: pageContext.page.id,
          platformAccountIdValue: account.parsed.account.platform_account_id,
          commissionRate: pageContext.page.commissionRate,
          requestContext: { auth: pageContext.auth, proxy: pageContext.proxy },
          syncRunId: run.id,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`transactions: ${message}`);
      }
    }

    await finishSyncRun(app.db, run.id, {
      status: errors.length ? "partial" : "success",
      stats,
      errorSummary: errors.length ? errors.join("; ") : null,
    });

    return {
      runId: run.id,
      status: errors.length ? "partial" : "success",
      stats,
      errors,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await insertFailedSyncPayload(app, {
      platformAccountId: pageContext.page.id,
      syncRunId: run.id,
      endpoint: "light_sync",
      message,
      platform: pageContext.platform,
    });
    await finishSyncRun(app.db, run.id, {
      status: "failed",
      stats,
      errorSummary: message,
    });
    throw error;
  }
}

export async function runLightSync(
  app: AppContext,
  label: string,
  trigger = "cli",
) {
  return withResolvedPageLock(
    app,
    label,
    (pageContext) => runLightSyncUnlocked(app, pageContext, trigger),
  );
}

export async function runFollowerSync(
  app: AppContext,
  label: string,
  trigger = "cli",
) {
  return withResolvedPageLock(
    app,
    label,
    (pageContext) => {
      if (pageContext.platform === "onlyfans") {
        throw new Error("Follower sync is not supported for OnlyFans pages");
      }

      return runFollowerSyncUnlocked(app, pageContext, trigger);
    },
  );
}

export async function runAllSync(app: AppContext, label: string, trigger = "cli") {
  return withResolvedPageLock(app, label, async (pageContext) => {
    const light = await runLightSyncUnlocked(app, pageContext, trigger);
    if (pageContext.platform === "onlyfans") {
      return {
        light,
        followers: null,
      };
    }

    const followers = await runFollowerSyncUnlocked(app, pageContext, trigger);

    return {
      light,
      followers,
    };
  });
}

export async function listModels(app: AppContext) {
  const result = await listModelsWithPageCounts(app.db);
  return result.rows;
}

export async function listPages(app: AppContext) {
  const result = await listPageSummaries(app.db);
  return result.rows;
}

export async function listStatus(
  app: AppContext,
  input?: {
    limit?: number;
    pageLabel?: string;
  },
) {
  let platformAccountId: number | undefined;

  if (input?.pageLabel) {
    const page = await findPageByLabel(app.db, input.pageLabel);
    if (!page) {
      throw new Error(`Page not found for label "${input.pageLabel}"`);
    }
    platformAccountId = page.page.id;
  }

  return listRecentSyncRuns(app.db, {
    limit: input?.limit ?? 20,
    platformAccountId,
  });
}

export async function listFans(
  app: AppContext,
  label: string,
  limit = 20,
) {
  const page = await findPageByLabel(app.db, label);
  if (!page) {
    throw new Error(`Page not found for label "${label}"`);
  }

  const result = await listTopFansForPage(app.db, page.page.id, limit);
  return result.rows;
}

export async function listSubscribers(app: AppContext, label: string) {
  const page = await findPageByLabel(app.db, label);
  if (!page) {
    throw new Error(`Page not found for label "${label}"`);
  }
  const result = await getCurrentSubscribers(app.db, page.page.id);
  return result.rows;
}

export async function listFollowers(app: AppContext, label: string) {
  const page = await findPageByLabel(app.db, label);
  if (!page) {
    throw new Error(`Page not found for label "${label}"`);
  }
  const result = await getFollowersForPage(app.db, page.page.id);
  return result.rows;
}

export async function revenueBreakdownForPage(
  app: AppContext,
  label: string,
  period: "today" | "7d" | "30d" | "all" | "custom",
  custom?: { from: string; to: string },
) {
  const page = await findPageByLabel(app.db, label);
  if (!page) {
    throw new Error(`Page not found for label "${label}"`);
  }

  const bounds = resolvePeriodBounds(period, new Date(), custom);
  const rows = await getRevenueBreakdown(app.db, page.page.id, bounds.from, bounds.to);

  return {
    page: page.page,
    bounds,
    rows,
  };
}

export async function fanSpendForPage(app: AppContext, label: string, identifier: string) {
  const page = await findPageByLabel(app.db, label);
  if (!page) {
    throw new Error(`Page not found for label "${label}"`);
  }

  const result = await getFanSpendByIdentifier(app.db, page.page.id, identifier);
  return result.rows[0] ?? null;
}

async function runWorkerSync(
  app: AppContext,
  input: {
    label: string;
    stream: "light" | "followers";
    run: () => Promise<unknown>;
  },
) {
  try {
    await input.run();
  } catch (error) {
    if (error instanceof PageSyncLockedError) {
      app.logger.info(
        {
          pageLabel: input.label,
          stream: input.stream,
        },
        "Skipped sync because the page lock is already held",
      );
      return;
    }

    throw error;
  }
}

export async function scheduleExistingPages(app: AppContext, boss: {
  schedule: (...args: any[]) => Promise<unknown>;
  work: (...args: any[]) => Promise<unknown>;
}) {
  const pages = await listFanslyPages(app.db);
  for (const page of pages) {
    const lightQueue = `fansly.sync.light.${page.label}`;
    const followerQueue = `fansly.sync.followers.${page.label}`;

    await boss.schedule(lightQueue, "0 * * * *", { label: page.label });
    await boss.schedule(followerQueue, "0 */12 * * *", { label: page.label });
    await boss.work(lightQueue, async (job: { data?: { label: string } }) => {
      const label = (job.data as { label: string }).label;
      await runWorkerSync(app, {
        label,
        stream: "light",
        run: () => runLightSync(app, label, "worker"),
      });
    });
    await boss.work(followerQueue, async (job: { data?: { label: string } }) => {
      const label = (job.data as { label: string }).label;
      await runWorkerSync(app, {
        label,
        stream: "followers",
        run: () => runFollowerSync(app, label, "worker"),
      });
    });
  }

  await boss.schedule("fansly.raw-payload-cleanup", "0 2 * * *");
  await boss.work("fansly.raw-payload-cleanup", async () => {
    await deleteExpiredRawPayloads(app.db, new Date());
  });
}

export { PageSyncLockedError } from "./sync/locking.ts";
