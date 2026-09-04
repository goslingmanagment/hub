import { setTimeout as delay } from "node:timers/promises";

import {
  ensurePageSyncStates,
  findPageByLabel,
  listPageSyncStates,
  listPlatformAccounts,
  clearPageSyncManualActionBlock,
  requestPageSync as requestPageSyncRows,
  resumePageSync,
  resolvePageSyncPriority,
  type SyncRequestSource,
  type SyncStream,
} from "@agency_hub_core/db";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import { resolveStoredProxyEgressKey } from "./page-context.ts";
import { appPlatformRegistry } from "../platforms/registry.ts";
import { sendSyncPageWakeup, type SyncTriggerScope } from "./sync-queue.ts";
import { pageSyncDependencyInput } from "./sync/dependencies.ts";
import {
  filterOnlyFansAudienceStreams,
  pauseDisabledOnlyFansAudienceForPage,
} from "./sync/ofapi-audience-sync.ts";
import {
  filterOnlyFansTopSpendersStreams,
  pauseDisabledOnlyFansTopSpendersForPage,
} from "./sync/onlyfans-top-spenders.ts";
import {
  filterOnlyFansDmPollingStreams,
  ONLYFANS_DM_POLLING_DISABLED_MESSAGE,
  pauseDisabledOnlyFansDmPollingForPage,
} from "./sync/onlyfans-dm-polling.ts";
import { BadRequestError } from "./errors.ts";
import {
  getOnlyFansPostsCaptureIneligibility,
  pauseIneligibleOnlyFansPostsForPage,
  PostsCaptureConfigurationError,
} from "./sync/posts.ts";

export interface RequestedSyncRequest {
  stream: SyncStream;
  requestedSeq: number;
}

export const filterStreamsForSyncConfig = filterOnlyFansDmPollingStreams;

export function resolveStreamsForScope(
  platform: "fansly" | "onlyfans",
  scope: SyncTriggerScope,
): SyncStream[] {
  // Stage 18 Task 4: scope policy is adapter-owned (registry) — the
  // per-platform arrays moved behind the seam; outputs pinned unchanged.
  const streams = appPlatformRegistry.get(platform).syncScopes[scope];
  if (streams === undefined) {
    throw new Error(`${scope} sync is not supported for ${platform} pages`);
  }
  return [...streams];
}

export async function requestPageSync(
  app: AppContext,
  boss: Pick<PgBoss, "send">,
  input: {
    pageLabel: string;
    scope: SyncTriggerScope;
    reason: SyncRequestSource;
    onlyFansTransactionsStart?: Date | null;
  },
) {
  const storedPage = await findPageByLabel(app.db, input.pageLabel);
  if (!storedPage) {
    throw new Error(`Page not found for label "${input.pageLabel}"`);
  }

  if (input.scope === "posts") {
    if (input.reason !== "manual") {
      throw new BadRequestError("The posts sync scope is an explicit per-page operator action");
    }
    const ineligibility = getOnlyFansPostsCaptureIneligibility(app.config, storedPage.page);
    if (ineligibility !== null) {
      throw new BadRequestError(new PostsCaptureConfigurationError(ineligibility).message);
    }
  }

  const requestedStreams = resolveStreamsForScope(storedPage.page.platform, input.scope);
  const streams = filterOnlyFansTopSpendersStreams(
    storedPage.page.platform,
    filterOnlyFansAudienceStreams(
      storedPage.page.platform,
      filterStreamsForSyncConfig(
        storedPage.page.platform,
        requestedStreams,
        app.config,
        storedPage.page,
      ),
      app.config,
      storedPage.page,
    ),
    app.config,
  );
  const now = new Date();
  const dependencyInput = pageSyncDependencyInput(app);
  await ensurePageSyncStates(app.db, {
    pageId: storedPage.page.id,
    onboarding: input.reason === "onboarding",
    now,
    ...dependencyInput,
  });
  if (storedPage.page.platform === "onlyfans") {
    await pauseDisabledOnlyFansDmPollingForPage(app, storedPage.page.id, now);
    await pauseDisabledOnlyFansAudienceForPage(app, storedPage.page.id, now);
    await pauseDisabledOnlyFansTopSpendersForPage(app, storedPage.page.id, now);
    await pauseIneligibleOnlyFansPostsForPage(app, storedPage.page.id, now);
  }

  if (streams.length === 0) {
    app.logger.warn({
      pageLabel: input.pageLabel,
      platform: storedPage.page.platform,
      scope: input.scope,
      requestedStreams,
    }, "Sync request skipped because all requested streams are disabled");
    throw new Error(
      `${ONLYFANS_DM_POLLING_DISABLED_MESSAGE}; configure OnlyMonster chat.message webhooks or enable ONLYFANS_DM_POLLING_ENABLED=true to poll messages.`,
    );
  }

  const requestPayloadByStream = input.onlyFansTransactionsStart
    ? {
      transactions: {
        onlyFansTransactionsStart: input.onlyFansTransactionsStart.toISOString(),
      },
    }
    : undefined;
  if (input.scope === "posts") {
    // Decision #249: the explicit operator request IS the manual action a
    // `manual_action_required` block (e.g. a parked OFAPI capture job) asked
    // for. Clear it BEFORE recording the request, so the request lands on a
    // runnable row instead of a blocked one that nothing would ever release.
    await clearPageSyncManualActionBlock(app.db, {
      pageId: storedPage.page.id,
      streams,
      now,
    });
  }
  const requests = await requestPageSyncRows(app.db, {
    pageId: storedPage.page.id,
    streams,
    source: input.reason,
    requestPayloadByStream,
    now,
    ...dependencyInput,
  });
  if (input.scope === "posts") {
    // requestPageSyncRows intentionally preserves a durable pause. The
    // explicit operator-only scope first records the new generation, then
    // opens just this page through the ordinary resume FSM.
    await resumePageSync(app.db, {
      pageId: storedPage.page.id,
      streams,
      now,
    });
  }

  const priority = streams.reduce((current, stream) => {
    return Math.max(current, resolvePageSyncPriority(stream, input.reason));
  }, 0);
  const wakeupId = await sendSyncPageWakeup(boss, {
    platformAccountId: storedPage.page.id,
    priority,
    provider: storedPage.page.platform,
    egressKey: resolveStoredProxyEgressKey(storedPage.proxy),
  });

  return {
    page: storedPage.page,
    wakeupId,
    requests,
  };
}

export async function requestAllPagesSync(
  app: AppContext,
  boss: Pick<PgBoss, "send">,
  input: {
    scope: SyncTriggerScope;
    reason: SyncRequestSource;
  },
) {
  if (input.scope === "posts") {
    throw new BadRequestError("The posts sync scope is per-page only");
  }
  const pages = await listPlatformAccounts(app.db);
  const results = [] as Array<{
    pageLabel: string;
    requests: RequestedSyncRequest[];
  }>;

  for (const page of pages) {
    const request = await requestPageSync(app, boss, {
      pageLabel: page.label,
      scope: input.scope,
      reason: input.reason,
    });
    results.push({
      pageLabel: page.label,
      requests: request.requests,
    });
  }

  return results;
}

export async function waitForRequestedSyncRequests(
  app: AppContext,
  input: {
    pageId: number;
    requests: RequestedSyncRequest[];
    timeoutMs?: number;
    pollMs?: number;
  },
) {
  const timeoutMs = input.timeoutMs ?? 10 * 60 * 1000;
  const pollMs = input.pollMs ?? 2000;
  const deadline = Date.now() + timeoutMs;
  let lastRows = [] as Awaited<ReturnType<typeof listPageSyncStates>>;

  while (Date.now() < deadline) {
    const rows = await listPageSyncStates(app.db, {
      pageId: input.pageId,
      streams: input.requests.map((request) => request.stream),
    });
    lastRows = rows;
    const byStream = new Map(rows.map((row) => [row.stream, row] as const));
    const unsatisfied = input.requests.filter((request) => {
      const row = byStream.get(request.stream);
      if (!row) {
        return true;
      }

      if (row.status === "blocked" && row.blockerKind === "auth") {
        throw new Error(`Sync for stream "${request.stream}" is blocked by auth`);
      }

      if (
        row.status === "blocked" &&
        row.blockerKind !== "dependency" &&
        row.appliedSeq < request.requestedSeq
      ) {
        throw new Error(`Sync for stream "${request.stream}" is blocked`);
      }

      if (row.status === "paused" && row.appliedSeq < request.requestedSeq) {
        throw new Error(`Sync for stream "${request.stream}" is paused`);
      }

      return row.appliedSeq < request.requestedSeq;
    });

    if (unsatisfied.length === 0) {
      return;
    }

    await delay(pollMs);
  }

  const stateSummary = lastRows
    .map((row) =>
      `${row.stream}:${row.status}:${row.appliedSeq}/${row.requestSeq}` +
      (row.blockerKind ? `:${row.blockerKind}:${row.blockerCode ?? "unknown"}` : ""))
    .join(", ");
  throw new Error(`Timed out waiting for requested sync requests to converge${stateSummary ? ` (${stateSummary})` : ""}`);
}
