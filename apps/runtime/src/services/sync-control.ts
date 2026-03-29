import { setTimeout as delay } from "node:timers/promises";

import {
  clearSyncPageAuthFailed,
  ensureSyncStreamStateRows,
  findPageByLabel,
  listPlatformAccounts,
  listSyncStreamRevisionStates,
  requestSyncStreamRevisions,
  resolveSyncRequestPriority,
  updateSyncStreamStateRequestPayload,
  type SyncControlStream,
  type SyncRequestReason,
} from "@agency_hub_core/db";
import { buildProxyEgressKey } from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import { sendSyncPageWakeup, type SyncTriggerScope } from "./sync-queue.ts";

export interface RequestedSyncRevision {
  stream: SyncControlStream;
  desiredRevision: number;
}

export function resolveStreamsForScope(
  platform: "fansly" | "onlyfans",
  scope: SyncTriggerScope,
): SyncControlStream[] {
  if (scope === "light") {
    return platform === "fansly"
      ? ["light"]
      : ["light", "transactions"];
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
      : ["light", "transactions"];
  }

  if (scope === "messages") {
    if (platform !== "fansly") {
      throw new Error("Message sync is not supported for OnlyFans pages");
    }
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
    : ["light", "transactions"];
}

export async function requestPageSync(
  app: AppContext,
  boss: Pick<PgBoss, "send">,
  input: {
    pageLabel: string;
    scope: SyncTriggerScope;
    reason: SyncRequestReason;
    onlyFansTransactionsStart?: Date | null;
  },
) {
  const storedPage = await findPageByLabel(app.db, input.pageLabel);
  if (!storedPage) {
    throw new Error(`Page not found for label "${input.pageLabel}"`);
  }

  const streams = resolveStreamsForScope(storedPage.page.platform, input.scope);
  const now = new Date();
  await ensureSyncStreamStateRows(app.db, {
    platformAccountId: storedPage.page.id,
    onboarding: input.reason === "onboarding",
    now,
  });
  await clearSyncPageAuthFailed(app.db, storedPage.page.id, now);

  const requestedRevisions = await requestSyncStreamRevisions(app.db, {
    platformAccountId: storedPage.page.id,
    streams,
    reason: input.reason,
    now,
  });

  if (input.onlyFansTransactionsStart) {
    if (storedPage.page.platform !== "onlyfans" || !streams.includes("transactions")) {
      throw new Error("OnlyFans transaction rescan overrides are only supported for OnlyFans transaction syncs");
    }

    const transactionRevision = requestedRevisions.find((revision) => revision.stream === "transactions");
    if (!transactionRevision) {
      throw new Error("Expected a requested transactions revision for OnlyFans rescan override");
    }

    await updateSyncStreamStateRequestPayload(app.db, {
      platformAccountId: storedPage.page.id,
      stream: "transactions",
      requestPayload: {
        revision: transactionRevision.desiredRevision,
        onlyFansTransactionsStart: input.onlyFansTransactionsStart.toISOString(),
      },
      now,
    });
  }

  const priority = streams.reduce((current, stream) => {
    return Math.max(current, resolveSyncRequestPriority(stream, input.reason));
  }, 0);
  const wakeupId = await sendSyncPageWakeup(boss, {
    platformAccountId: storedPage.page.id,
    priority,
    provider: storedPage.page.platform,
    egressKey: buildProxyEgressKey(storedPage.proxy ? { url: storedPage.proxy.url } : null),
  });

  return {
    page: storedPage.page,
    wakeupId,
    revisions: requestedRevisions,
  };
}

export async function requestAllPagesSync(
  app: AppContext,
  boss: Pick<PgBoss, "send">,
  input: {
    scope: SyncTriggerScope;
    reason: SyncRequestReason;
  },
) {
  const pages = await listPlatformAccounts(app.db);
  const results = [] as Array<{
    pageLabel: string;
    revisions: RequestedSyncRevision[];
  }>;

  for (const page of pages) {
    const request = await requestPageSync(app, boss, {
      pageLabel: page.label,
      scope: input.scope,
      reason: input.reason,
    });
    results.push({
      pageLabel: page.label,
      revisions: request.revisions,
    });
  }

  return results;
}

export async function waitForRequestedSyncRevisions(
  app: AppContext,
  input: {
    platformAccountId: number;
    revisions: RequestedSyncRevision[];
    timeoutMs?: number;
    pollMs?: number;
  },
) {
  const timeoutMs = input.timeoutMs ?? 10 * 60 * 1000;
  const pollMs = input.pollMs ?? 2000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = await listSyncStreamRevisionStates(
      app.db,
      input.platformAccountId,
      input.revisions.map((revision) => revision.stream),
    );
    const byStream = new Map(rows.map((row) => [row.stream, row]));
    const unsatisfied = input.revisions.filter((revision) => {
      const row = byStream.get(revision.stream);
      if (!row) {
        return true;
      }

      if (row.status === "auth_failed") {
        throw new Error(`Sync for stream "${row.stream}" is blocked by auth_failed`);
      }

      if ((row.status === "paused" || row.status === "disabled") && row.satisfiedRevision < revision.desiredRevision) {
        throw new Error(`Sync for stream "${row.stream}" is ${row.status}`);
      }

      return row.satisfiedRevision < revision.desiredRevision;
    });

    if (unsatisfied.length === 0) {
      return;
    }

    await delay(pollMs);
  }

  throw new Error("Timed out waiting for requested sync revisions to converge");
}
