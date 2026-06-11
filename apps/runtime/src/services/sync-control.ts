import { setTimeout as delay } from "node:timers/promises";

import {
  ensurePageSyncStates,
  findPageByLabel,
  listPageSyncStates,
  listPlatformAccounts,
  requestPageSync as requestPageSyncRows,
  resolvePageSyncPriority,
  type SyncRequestSource,
  type SyncStream,
} from "@agency_hub_core/db";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import { resolveStoredProxyEgressKey } from "./page-context.ts";
import { sendSyncPageWakeup, type SyncTriggerScope } from "./sync-queue.ts";
import {
  filterOnlyFansAudienceStreams,
  pauseDisabledOnlyFansAudienceForPage,
} from "./sync/ofapi-audience-sync.ts";
import {
  filterOnlyFansDmPollingStreams,
  ONLYFANS_DM_POLLING_DISABLED_MESSAGE,
  pauseDisabledOnlyFansDmPollingForPage,
} from "./sync/onlyfans-dm-polling.ts";

export interface RequestedSyncRequest {
  stream: SyncStream;
  requestedSeq: number;
}

export const filterStreamsForSyncConfig = filterOnlyFansDmPollingStreams;

export function resolveStreamsForScope(
  platform: "fansly" | "onlyfans",
  scope: SyncTriggerScope,
): SyncStream[] {
  if (scope === "light") {
    return platform === "fansly"
      ? ["light"]
      : ["light", "transactions", "fan_identities"];
  }

  if (scope === "followers") {
    if (platform !== "fansly") {
      throw new Error("Follower sync is not supported for OnlyFans pages");
    }
    return ["followers"];
  }

  if (scope === "data") {
    return platform === "fansly"
      ? ["light", "transactions", "top_spenders", "subscribers", "followers", "followers_reconcile"]
      : ["light", "transactions", "fan_identities", "subscribers"];
  }

  if (scope === "messages") {
    return ["dm_conversations", "dm_messages"];
  }

  return platform === "fansly"
    ? [
      "light",
      "transactions",
      "top_spenders",
      "subscribers",
      "followers",
      "followers_reconcile",
      "dm_conversations",
      "dm_messages",
    ]
    : ["light", "transactions", "fan_identities", "subscribers", "dm_conversations", "dm_messages"];
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

  const requestedStreams = resolveStreamsForScope(storedPage.page.platform, input.scope);
  const streams = filterOnlyFansAudienceStreams(
    storedPage.page.platform,
    filterStreamsForSyncConfig(
      storedPage.page.platform,
      requestedStreams,
      app.config,
      storedPage.page,
    ),
    app.config,
    storedPage.page,
  );
  const now = new Date();
  await ensurePageSyncStates(app.db, {
    pageId: storedPage.page.id,
    onboarding: input.reason === "onboarding",
    now,
  });
  if (storedPage.page.platform === "onlyfans") {
    await pauseDisabledOnlyFansDmPollingForPage(app, storedPage.page.id, now);
    await pauseDisabledOnlyFansAudienceForPage(app, storedPage.page.id, now);
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
  const requests = await requestPageSyncRows(app.db, {
    pageId: storedPage.page.id,
    streams,
    source: input.reason,
    requestPayloadByStream,
    now,
  });

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
