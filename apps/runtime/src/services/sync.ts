import {
  findPageByLabel,
  getCurrentSubscribers,
  getFanSpendByIdentifier,
  getFollowersForPage,
  getRevenueBreakdown,
  getSyncRun,
  listModelsWithPageCounts,
  listPageSummaries,
  listRecentSyncRuns,
  listRunningSyncRuns,
  listSyncRequestAttempts,
  listSyncRunEvents,
  listTopFansForPage,
} from "@agency_hub_core/db";
import { resolveRevenuePeriodBoundsForPlatform } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";

const DEFAULT_WATCH_LIMIT = 10;

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
    listSyncRequestAttempts(app.db, { runId, limit: 2_000 }),
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
