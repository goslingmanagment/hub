import { upsertFans } from "@agency_hub_core/db";
import type { UpsertFanInput } from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import type { SyncRunTelemetry } from "./observability.ts";

export async function prepareHydratedFans(
  app: AppContext,
  input: {
    requestContext: Parameters<AppContext["adapter"]["getAccountsByIdsPage"]>[0];
    platformUserIds: string[];
    telemetry?: SyncRunTelemetry;
  },
) {
  if (input.platformUserIds.length === 0) {
    return [] as UpsertFanInput[];
  }

  const uniqueIds = Array.from(new Set(input.platformUserIds.filter(Boolean)));
  const accounts: Awaited<ReturnType<AppContext["adapter"]["getAccountsByIdsPage"]>>["parsed"] = [];

  for (let index = 0; index < uniqueIds.length; index += 100) {
    const chunk = uniqueIds.slice(index, index + 100);
    const response = await app.adapter.getAccountsByIdsPage(input.requestContext, chunk);
    accounts.push(...response.parsed);
  }

  const fallbackIds = uniqueIds.filter(
    (id) => !accounts.some((account) => account.id === id),
  );
  input.telemetry?.mergeHydrationSummary({
    uniqueFanIds: uniqueIds.length,
    lookupBatches: Math.ceil(uniqueIds.length / 100),
    fallbackMisses: fallbackIds.length,
    requestCount: Math.ceil(uniqueIds.length / 100),
  });

  return [
    ...accounts.map((account) => ({
      platform: "fansly" as const,
      platformUserId: account.id,
      username: account.username,
      displayName: account.displayName,
      createdAtExternal: account.createdAt ? new Date(account.createdAt) : null,
      metadata: {},
    })),
    ...fallbackIds.map((id) => ({
      platform: "fansly" as const,
      platformUserId: id,
      metadata: {},
    })),
  ] satisfies UpsertFanInput[];
}

export async function hydrateFans(
  app: AppContext,
  input: {
    requestContext: Parameters<AppContext["adapter"]["getAccountsByIdsPage"]>[0];
    platformUserIds: string[];
    telemetry?: SyncRunTelemetry;
  },
) {
  const fans = await upsertFans(app.db, await prepareHydratedFans(app, input));
  return new Map(fans.map((fan) => [fan.platformUserId, fan.id]));
}
