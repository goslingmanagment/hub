import {
  deleteExpiredRawPayloads,
  deleteExpiredSyncObservability,
  findPageByLabel,
  getCurrentSubscribers,
  getFollowersForPage,
  getFanSpendByIdentifier,
  getSyncRun,
  getRevenueBreakdown,
  listPlatformAccounts,
  listModelsWithPageCounts,
  listPageSummaries,
  listRecentSyncRuns,
  listRunningSyncRuns,
  listSyncRequestAttempts,
  listSyncRunEvents,
  listTopFansForPage,
  startSyncRun,
} from "@agency_hub_core/db";
import { FANSLY_MAPPER_VERSION } from "@agency_hub_core/fansly";
import { ONLYMONSTER_MAPPER_VERSION } from "@agency_hub_core/onlyfans";
import { resolveRevenuePeriodBoundsForPlatform } from "@agency_hub_core/shared";
import type PgBoss from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import { resolvePageContext, type ResolvedPageContext } from "./page-context.ts";
import {
  ensureQueueCreated,
  followerQueueName,
  lightQueueName,
  RAW_PAYLOAD_CLEANUP_QUEUE,
} from "./sync-queue.ts";
import { normalizeSyncError } from "./sync/errors.ts";
import { runFollowerSyncUnlocked } from "./sync/followers.ts";
import {
  summarizeCheckpoint,
  SyncRunTelemetry,
} from "./sync/observability.ts";
import { PageSyncLockedError, withPageSyncLock } from "./sync/locking.ts";
import { syncOnlyFansTransactions } from "./sync/onlyfans-transactions.ts";
import {
  persistFailedSyncPayload,
  persistRawPayload,
  refreshPageMetadata,
  retentionDate,
} from "./sync/shared.ts";
import { syncSubscribers } from "./sync/subscribers.ts";
import { syncTransactions } from "./sync/transactions.ts";

const WORKER_PAGE_DISCOVERY_MS = 60_000;
const DEFAULT_WATCH_LIMIT = 10;

type SyncCommandResult = {
  runId: number;
  status: "success" | "partial" | "failed" | "skipped";
  stats: Record<string, unknown>;
  errors: string[];
};

type ScheduledQueueBoss = Pick<PgBoss, "createQueue" | "schedule" | "work">;

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

async function createObservedRun(
  app: AppContext,
  pageContext: ResolvedPageContext,
  stream: "light" | "followers",
  trigger: string,
) {
  const run = await startSyncRun(app.db, {
    platformAccountId: pageContext.page.id,
    stream,
    trigger,
  });
  const telemetry = new SyncRunTelemetry(app, {
    runId: run.id,
    platformAccountId: pageContext.page.id,
    pageLabel: pageContext.page.label,
    provider: pageContext.platform,
    stream,
    trigger,
  }, {
    runStartedAt: run.startedAt,
  });
  await telemetry.recordRunStarted();
  return { run, telemetry };
}

function toSyncCommandResult(
  run: {
    id: number;
    status: "running" | "success" | "partial" | "failed" | "skipped";
    stats: Record<string, unknown>;
    errorSummary: string | null;
  },
): SyncCommandResult {
  return {
    runId: run.id,
    status: run.status === "running" ? "failed" : run.status,
    stats: run.stats ?? {},
    errors: run.errorSummary ? [run.errorSummary] : [],
  };
}

async function runLightSyncUnlocked(
  app: AppContext,
  pageContext: ResolvedPageContext,
  observedRun: Awaited<ReturnType<typeof createObservedRun>>,
  input?: {
    trigger?: string;
    onlyFansTransactionStart?: Date | null;
  },
) {
  const { run, telemetry } = observedRun;
  const errors: string[] = [];
  const stats: Record<string, unknown> = {};

  try {
    await telemetry.recordPhaseStarted("page_metadata");

    if (pageContext.platform === "fansly") {
      const accountMe = await refreshPageMetadata(app, pageContext, "light", telemetry);
      await persistRawPayload(app.db, {
        platformAccountId: pageContext.page.id,
        syncRunId: run.id,
        endpoint: "account_me",
        requestParams: {},
        responsePayload: accountMe.raw,
        mapperVersion: FANSLY_MAPPER_VERSION,
        payloadKind: "mapping_critical",
        retainUntil: retentionDate(),
      }, {
        action: "inserting account_me raw payload",
      });

      try {
        if (input?.onlyFansTransactionStart) {
          throw new Error("Manual transaction rescans are only supported for OnlyFans pages");
        }

        await telemetry.recordPhaseStarted("transactions");
        stats.transactions = await syncTransactions(app, {
          pageLabel: pageContext.page.label,
          platformAccountId: pageContext.page.id,
          commissionRate: pageContext.page.commissionRate,
          requestContext: {
            session: pageContext.session,
            proxy: pageContext.proxy,
            requestObserver: telemetry.getRequestObserver(),
          },
          syncRunId: run.id,
          telemetry,
        });
      } catch (error) {
        const failure = normalizeSyncError(error, {
          endpoint: "earnings_transactions",
          action: "running transaction sync",
        });
        errors.push(`transactions: ${failure.summary}`);
      }

      try {
        await telemetry.recordPhaseStarted("subscribers");
        stats.subscribers = await syncSubscribers(app, {
          pageLabel: pageContext.page.label,
          platformAccountId: pageContext.page.id,
          requestContext: {
            session: pageContext.session,
            proxy: pageContext.proxy,
            requestObserver: telemetry.getRequestObserver(),
          },
          syncRunId: run.id,
          telemetry,
        });
        const subscriberStats = stats.subscribers as { totalActive?: number } | undefined;
        if (
          typeof subscriberStats?.totalActive === "number" &&
          accountMe.parsed.account.subscriberCount !== subscriberStats.totalActive
        ) {
          await telemetry.addAnomaly({
            code: "subscriber_count_mismatch",
            severity: "warn",
            message: "Account metadata subscriber count differed from the synced active subscriptions",
            details: {
              accountMeSubscriberCount: accountMe.parsed.account.subscriberCount,
              syncedActiveSubscribers: subscriberStats.totalActive,
            },
          });
        }
      } catch (error) {
        const failure = normalizeSyncError(error, {
          endpoint: "subscribers",
          action: "running subscriber sync",
        });
        errors.push(`subscribers: ${failure.summary}`);
      }
    } else {
      const account = await refreshPageMetadata(app, pageContext, "light", telemetry);
      await persistRawPayload(app.db, {
        platformAccountId: pageContext.page.id,
        syncRunId: run.id,
        endpoint: "onlymonster_account",
        requestParams: {},
        responsePayload: account.raw,
        mapperVersion: ONLYMONSTER_MAPPER_VERSION,
        payloadKind: "mapping_critical",
        retainUntil: retentionDate(),
      }, {
        action: "inserting onlymonster_account raw payload",
      });

      try {
        await telemetry.recordPhaseStarted("transactions");
        stats.transactions = await syncOnlyFansTransactions(app, {
          pageLabel: pageContext.page.label,
          platformAccountId: pageContext.page.id,
          platformAccountIdValue: account.parsed.account.platform_account_id,
          pageMetadata: pageContext.page.metadata,
          commissionRate: pageContext.page.commissionRate,
          rescanStart: input?.onlyFansTransactionStart ?? null,
          requestContext: {
            auth: pageContext.auth,
            proxy: pageContext.proxy,
            requestObserver: telemetry.getRequestObserver(),
          },
          syncRunId: run.id,
          telemetry,
        });
      } catch (error) {
        const failure = normalizeSyncError(error, {
          endpoint: "onlymonster_transactions",
          action: "running OnlyFans transaction sync",
        });
        errors.push(`transactions: ${failure.summary}`);
      }
    }

    const hydration = telemetry.getHydrationSummary();
    const requestTotals = telemetry.getRequestTotalsSnapshot();
    const hydrationRequests = typeof hydration?.requestCount === "number" ? hydration.requestCount : 0;
    if (
      pageContext.platform === "fansly" &&
      hydrationRequests >= 2 &&
      requestTotals.totalAttempts > 0 &&
      hydrationRequests / requestTotals.totalAttempts >= 0.4
    ) {
      await telemetry.addAnomaly({
        code: "high_hydration_ratio",
        severity: "warn",
        message: "Hydration traffic consumed an unusually large share of the light sync",
        details: {
          hydrationRequests,
          totalAttempts: requestTotals.totalAttempts,
        },
      });
    }

    const finishedRun = await telemetry.finish(
      errors.length ? "partial" : "success",
      errors.length ? errors.join("; ") : null,
      stats,
    );

    return {
      runId: finishedRun.id,
      status: finishedRun.status,
      stats: finishedRun.stats,
      errors,
    };
  } catch (error) {
    app.logger.error(
      {
        err: error,
        runId: run.id,
        pageLabel: pageContext.page.label,
        stream: "light",
      },
      "Light sync failed",
    );
    const failure = normalizeSyncError(error, {
      endpoint: "light_sync",
      action: "running light sync",
    });
    await telemetry.finish("failed", failure, stats);
    await persistFailedSyncPayload(app, {
      platformAccountId: pageContext.page.id,
      syncRunId: run.id,
      endpoint: "light_sync",
      platform: pageContext.platform,
      failure,
    });
    throw error;
  }
}

export async function runLightSync(
  app: AppContext,
  label: string,
  input?: {
    trigger?: string;
    onlyFansTransactionStart?: Date | null;
  },
) {
  const pageContext = await resolvePageContext(app, label);
  const observedRun = await createObservedRun(
    app,
    pageContext,
    "light",
    input?.trigger ?? "cli",
  );

  try {
    return await withPageSyncLock(
      app,
      {
        pageId: pageContext.page.id,
        pageLabel: pageContext.page.label,
      },
      () => runLightSyncUnlocked(app, pageContext, observedRun, input),
    );
  } catch (error) {
    if (error instanceof PageSyncLockedError) {
      const skippedRun = await observedRun.telemetry.recordSkipped(
        "Skipped sync because the page lock is already held",
      );
      return toSyncCommandResult(skippedRun);
    }

    throw error;
  }
}

export async function runFollowerSync(
  app: AppContext,
  label: string,
  trigger = "cli",
) {
  const pageContext = await resolvePageContext(app, label);
  if (pageContext.platform === "onlyfans") {
    throw new Error("Follower sync is not supported for OnlyFans pages");
  }

  const observedRun = await createObservedRun(app, pageContext, "followers", trigger);

  try {
    return await withPageSyncLock(
      app,
      {
        pageId: pageContext.page.id,
        pageLabel: pageContext.page.label,
      },
      () => runFollowerSyncUnlocked(app, pageContext, observedRun, trigger),
    );
  } catch (error) {
    if (error instanceof PageSyncLockedError) {
      const skippedRun = await observedRun.telemetry.recordSkipped(
        "Skipped sync because the page lock is already held",
      );
      return {
        runId: skippedRun.id,
        status: skippedRun.status,
        processed: 0,
        delta: 0,
        followerCount: pageContext.page.followerCount,
      };
    }

    throw error;
  }
}

export async function runAllSync(
  app: AppContext,
  label: string,
  input?: {
    trigger?: string;
    onlyFansTransactionStart?: Date | null;
  },
) {
  const pageContext = await resolvePageContext(app, label);
  const trigger = input?.trigger ?? "cli";
  const lightRun = await createObservedRun(app, pageContext, "light", trigger);
  const followerRun = pageContext.platform === "fansly"
    ? await createObservedRun(app, pageContext, "followers", trigger)
    : null;

  try {
    return await withPageSyncLock(
      app,
      {
        pageId: pageContext.page.id,
        pageLabel: pageContext.page.label,
      },
      async () => {
        try {
          const light = await runLightSyncUnlocked(app, pageContext, lightRun, input);
          if (pageContext.platform === "onlyfans") {
            return {
              light,
              followers: null,
            };
          }

          const followers = await runFollowerSyncUnlocked(
            app,
            pageContext,
            followerRun!,
            trigger,
          );

          return {
            light,
            followers,
          };
        } catch (error) {
          if (followerRun) {
            await followerRun.telemetry.finish(
              "skipped",
              "Follower phase did not start because the light sync failed",
              {
                skippedReason: "light_sync_failed",
              },
            );
          }
          throw error;
        }
      },
    );
  } catch (error) {
    if (error instanceof PageSyncLockedError) {
      const light = toSyncCommandResult(
        await lightRun.telemetry.recordSkipped(
          "Skipped sync because the page lock is already held",
        ),
      );
      const followers = followerRun
        ? {
          runId: (await followerRun.telemetry.recordSkipped(
            "Skipped sync because the page lock is already held",
          )).id,
          status: "skipped" as const,
          processed: 0,
          delta: 0,
          followerCount: pageContext.page.followerCount,
        }
        : null;

      return {
        light,
        followers,
      };
    }

    throw error;
  }
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
    since?: Date;
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
    since: input?.since,
  });
}

export async function getStatusDetail(
  app: AppContext,
  runId: number,
) {
  const run = await getSyncRun(app.db, runId);
  if (!run) {
    throw new Error(`Sync run ${runId} was not found`);
  }

  const [events, attempts] = await Promise.all([
    listSyncRunEvents(app.db, { runId, limit: 500 }),
    listSyncRequestAttempts(app.db, { runId, limit: 2000 }),
  ]);

  return {
    run,
    events,
    attempts,
  };
}

export async function getStatusWatchSnapshot(
  app: AppContext,
  input?: {
    pageLabel?: string;
    limit?: number;
    since?: Date;
    afterEventId?: number;
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

  const [runningRuns, recentRuns, inflightAttempts, events] = await Promise.all([
    listRunningSyncRuns(app.db, {
      platformAccountId,
      limit: input?.limit ?? DEFAULT_WATCH_LIMIT,
    }),
    listRecentSyncRuns(app.db, {
      platformAccountId,
      limit: input?.limit ?? DEFAULT_WATCH_LIMIT,
      since: input?.since,
    }),
    listSyncRequestAttempts(app.db, {
      platformAccountId,
      inFlightOnly: true,
      limit: 200,
    }),
    listSyncRunEvents(app.db, {
      platformAccountId,
      afterId: input?.afterEventId,
      since: input?.since,
      limit: 200,
    }),
  ]);

  return {
    runningRuns,
    recentRuns,
    inflightAttempts,
    events,
  };
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

  const bounds = resolveRevenuePeriodBoundsForPlatform(
    page.page.platform,
    period,
    new Date(),
    custom,
  );
  const rows = await getRevenueBreakdown(
    app.db,
    page.page.id,
    page.page.platform,
    bounds.from,
    bounds.to,
  );

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

export async function scheduleExistingPages(app: AppContext, boss: ScheduledQueueBoss) {
  const createdQueues = new Set<string>();
  const scheduledQueues = new Set<string>();
  const workerQueues = new Set<string>();

  const ensureScheduledWork = async (
    queueName: string,
    cron: string,
    data: Record<string, unknown> | undefined,
    worker: (jobs: Array<{ data?: { label: string } }>) => Promise<void>,
  ) => {
    await ensureQueueCreated(boss, queueName, createdQueues);

    if (!scheduledQueues.has(queueName)) {
      if (data) {
        await boss.schedule(queueName, cron, data);
      } else {
        await boss.schedule(queueName, cron);
      }
      scheduledQueues.add(queueName);
    }
    if (!workerQueues.has(queueName)) {
      await boss.work(queueName, { batchSize: 1 }, worker);
      workerQueues.add(queueName);
    }
  };

  const discoverPages = async () => {
    const pages = await listPlatformAccounts(app.db);
    for (const page of pages) {
      const lightQueue = lightQueueName(page);
      await ensureScheduledWork(lightQueue, "0 * * * *", { label: page.label }, async (jobs) => {
        const label = (jobs[0]?.data as { label: string }).label;
        await runWorkerSync(app, {
          label,
          stream: "light",
          run: () => runLightSync(app, label, { trigger: "worker" }),
        });
      });

      if (page.platform === "fansly") {
        const followerQueue = followerQueueName(page);
        await ensureScheduledWork(
          followerQueue,
          "0 */12 * * *",
          { label: page.label },
          async (jobs) => {
            const label = (jobs[0]?.data as { label: string }).label;
            await runWorkerSync(app, {
              label,
              stream: "followers",
              run: () => runFollowerSync(app, label, "worker"),
            });
          },
        );
      }
    }
  };

  await discoverPages();
  await ensureScheduledWork(RAW_PAYLOAD_CLEANUP_QUEUE, "0 2 * * *", undefined, async () => {
    await deleteExpiredRawPayloads(app.db, new Date());
    await deleteExpiredSyncObservability(
      app.db,
      new Date(Date.now() - app.config.syncObservabilityRetentionDays * 24 * 60 * 60 * 1000),
    );
  });

  const discoveryTimer = setInterval(() => {
    void discoverPages().catch((error) => {
      app.logger.error({ err: error }, "Failed to discover worker pages");
    });
  }, WORKER_PAGE_DISCOVERY_MS);
  discoveryTimer.unref?.();

  return {
    discoverPages,
  };
}

export { PageSyncLockedError } from "./sync/locking.ts";
