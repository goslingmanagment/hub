import {
  getCheckpoint,
  getCurrentSubscribers,
  rebuildSubscriberRollups,
  setPageSubscriptionsCurrentFlag,
  upsertCheckpoint,
  upsertFanPage,
  upsertPageSubscription,
} from "@agency_hub_core/db";
import {
  FANSLY_MAPPER_VERSION,
  mapFanslySubscriptionStatus,
} from "@agency_hub_core/fansly";
import { sql } from "drizzle-orm";
import { toMills } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { hydrateFans } from "./fan-hydration.ts";
import { summarizeCheckpoint, type SyncRunTelemetry } from "./observability.ts";
import { persistRawPayload, retentionDate } from "./shared.ts";

export async function syncSubscribers(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    requestContext: Parameters<AppContext["adapter"]["getSubscribersPage"]>[0];
    syncRunId: number;
    telemetry: SyncRunTelemetry;
  },
) {
  const checkpoint = await getCheckpoint(app.db, input.platformAccountId, "subscribers");
  await input.telemetry.recordCheckpointLoaded("subscribers", summarizeCheckpoint(checkpoint));
  let offset = 0;
  const items: Awaited<ReturnType<AppContext["adapter"]["getSubscribersPage"]>>["items"] = [];
  let stats: { totalActive: number; totalExpired: number; total: number } | null = null;
  let pageCount = 0;
  let providerReportedTotal: number | null = null;

  while (true) {
    const page = await app.adapter.getSubscribersPage(
      input.requestContext,
      { limit: 100, offset, status: "3,4" },
    );
    pageCount += 1;
    providerReportedTotal ??= page.total ?? null;

    items.push(...page.items);
    stats = stats ?? {
      totalActive: page.total ?? 0,
      totalExpired: 0,
      total: page.total ?? 0,
    };

    await persistRawPayload(app.db, {
      platformAccountId: input.platformAccountId,
      syncRunId: input.syncRunId,
      endpoint: "subscribers",
      requestParams: { offset, limit: 100, status: "3,4" },
      responsePayload: page.raw,
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting subscribers raw payload",
    });

    if (page.done) {
      break;
    }
    offset += 100;
  }

  if (items.length === 0) {
    const currentSubscribers = await getCurrentSubscribers(app.db, input.platformAccountId);
    if (currentSubscribers.rows.length > 0) {
      await input.telemetry.addAnomaly({
        code: "partial_stream_failure",
        severity: "warn",
        message: "Subscriber sync returned zero rows while current subscriptions already existed",
        details: {
          existingCurrentSubscribers: currentSubscribers.rows.length,
        },
      });
      throw new Error("Subscriber sync returned zero rows; refusing to clear existing current subscriptions");
    }
  }

  const fanMap = await hydrateFans(app, {
    requestContext: input.requestContext,
    platformUserIds: items.map((item) => item.subscriberId),
    telemetry: input.telemetry,
  });

  const activeIds: string[] = [];
  for (const item of items) {
    const fanId = fanMap.get(item.subscriberId);
    if (!fanId) {
      continue;
    }

    const sourceCreatedAt = item.createdAt ? new Date(item.createdAt) : null;
    const endsAt = item.endsAt ? new Date(item.endsAt) : null;
    const canonicalStatus = mapFanslySubscriptionStatus(item.status);
    const autoRenew = item.autoRenew === null ? null : item.autoRenew === 1;

    await upsertPageSubscription(app.db, {
      platformSubscriptionId: item.id,
      platformAccountId: input.platformAccountId,
      fanId,
      platformHistoryId: item.historyId,
      subscriptionTierId: item.subscriptionTierId,
      subscriptionTierName: item.subscriptionTierName,
      subscriptionTierColor: item.subscriptionTierColor,
      planId: item.planId,
      rawStatus: item.status,
      canonicalStatus,
      priceMills: toMills(item.price),
      renewPriceMills: toMills(item.renewPrice),
      autoRenew,
      billingCycleDays: item.billingCycle,
      durationDays: item.duration,
      renewDate: item.renewDate ? new Date(item.renewDate) : null,
      sourceCreatedAt,
      sourceUpdatedAt: item.updatedAt ? new Date(item.updatedAt) : null,
      endsAt,
    });

    await upsertFanPage(app.db, {
      fanId,
      platformAccountId: input.platformAccountId,
      isSubscriber: canonicalStatus === "active",
      subscriberSince: sourceCreatedAt,
      subscriptionExpiresAt: endsAt,
      autoRenew,
    });
    activeIds.push(item.id);
  }

  await setPageSubscriptionsCurrentFlag(app.db, input.platformAccountId, activeIds);
  await app.db.execute(sql`
    update fan_pages
    set is_subscriber = false,
        subscription_expires_at = null,
        auto_renew = null,
        last_seen_at = now()
    where platform_account_id = ${input.platformAccountId}
      and fan_id not in (
        select fan_id
        from page_subscriptions
        where platform_account_id = ${input.platformAccountId}
          and is_current = true
      )
  `);
  await rebuildSubscriberRollups(app.db, input.platformAccountId);
  const checkpointAfter = await upsertCheckpoint(app.db, {
    platformAccountId: input.platformAccountId,
    stream: "subscribers",
    state: { count: activeIds.length, pageLabel: input.pageLabel },
    lastSuccessfulRunId: input.syncRunId,
  });
  await input.telemetry.recordCheckpointAdvanced("subscribers", summarizeCheckpoint(checkpointAfter));
  input.telemetry.setScanSummary({
    subscriberPages: pageCount,
    processedSubscribers: items.length,
    activeSubscribers: activeIds.length,
  });

  if (providerReportedTotal !== null && providerReportedTotal !== items.length) {
    await input.telemetry.addAnomaly({
      code: "subscribers_total_mismatch",
      severity: "warn",
      message: "Provider-reported subscriber total differed from the fetched subscription rows",
      details: {
        providerReportedTotal,
        fetchedRows: items.length,
        pageCount,
      },
    });
  }

  return {
    processed: items.length,
    totalActive: activeIds.length,
  };
}
