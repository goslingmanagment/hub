import { listFanslyFansLookedUpSince } from "@agency_hub_core/db";
import { FANSLY_MAPPER_VERSION, type FanslyAccount } from "@agency_hub_core/fansly";

import type { AppContext } from "../../bootstrap.ts";
import {
  FANSLY_ACCOUNT_LOOKUP_REUSE_MS,
  type FanslyAccountLookupStamp,
} from "../../sync/fansly/lib/fan-hydration.ts";
import type { SyncRunTelemetry } from "./observability.ts";
import { persistRawPayload, retentionDate } from "./shared.ts";

type HydratedLookupResult = {
  accounts: FanslyAccount[];
  fallbackIds: string[];
  /** Ids looked up through this page within the day: not sent again, their
   * stored fan row is kept as it is. */
  reusedIds: string[];
  /** Null when the call sent no request. */
  lookup: FanslyAccountLookupStamp | null;
};

/** Stage 7 producer 2: callers with a page + run in hand pass this so every
 *  hydration lookup page is persisted + journaled like any other fetch. */
export type HydrationCaptureContext = {
  platformAccountId: number;
  syncRunId: number | null;
};

export async function lookupHydratedFans(
  app: AppContext,
  input: {
    requestContext: Parameters<AppContext["adapter"]["getAccountsByIdsPage"]>[0];
    /** The page whose session asks: keys the once-a-day reuse. */
    platformAccountId: number;
    platformUserIds: string[];
    telemetry?: SyncRunTelemetry;
    capture?: HydrationCaptureContext;
  },
) {
  if (input.platformUserIds.length === 0) {
    return {
      accounts: [],
      fallbackIds: [],
      reusedIds: [],
      lookup: null,
    } satisfies HydratedLookupResult;
  }

  const uniqueIds = Array.from(new Set(input.platformUserIds.filter(Boolean)));
  const lookedUpToday = new Set(await listFanslyFansLookedUpSince(app.db, {
    platformAccountId: input.platformAccountId,
    platformUserIds: uniqueIds,
    since: new Date(Date.now() - FANSLY_ACCOUNT_LOOKUP_REUSE_MS),
  }));
  const reusedIds = uniqueIds.filter((id) => lookedUpToday.has(id));
  const dueIds = uniqueIds.filter((id) => !lookedUpToday.has(id));
  const accounts: FanslyAccount[] = [];

  for (let index = 0; index < dueIds.length; index += 100) {
    const chunk = dueIds.slice(index, index + 100);
    const response = await app.adapter.getAccountsByIdsPage(input.requestContext, chunk);
    if (input.capture) {
      await persistRawPayload(app.db, {
        platformAccountId: input.capture.platformAccountId,
        syncRunId: input.capture.syncRunId,
        endpoint: "account_lookup",
        requestParams: { ids: chunk },
        responsePayload: response.raw,
        mapperVersion: FANSLY_MAPPER_VERSION,
        payloadKind: "mapping_critical",
        retainUntil: retentionDate(),
      }, {
        action: "inserting account_lookup raw payload",
        platform: "fansly",
      });
    }
    accounts.push(...response.parsed);
  }

  const fallbackIds = dueIds.filter(
    (id) => !accounts.some((account) => account.id === id),
  );
  input.telemetry?.mergeHydrationSummary({
    uniqueFanIds: uniqueIds.length,
    reusedFanIds: reusedIds.length,
    lookupBatches: Math.ceil(dueIds.length / 100),
    fallbackMisses: fallbackIds.length,
    requestCount: Math.ceil(dueIds.length / 100),
  });

  return {
    accounts,
    fallbackIds,
    reusedIds,
    lookup: dueIds.length > 0 ? { lookedUpAt: new Date(), platformUserIds: dueIds } : null,
  } satisfies HydratedLookupResult;
}
