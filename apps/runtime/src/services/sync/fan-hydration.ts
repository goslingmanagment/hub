import {
  reconcileFanslyFanPageIdentity,
  upsertFanPages,
  upsertFans,
  type Database,
  type UpsertFanInput,
} from "@agency_hub_core/db";
import type { FanslyAccount, FanslyAccountNote } from "@agency_hub_core/fansly";

import type { AppContext } from "../../bootstrap.ts";
import type { SyncRunTelemetry } from "./observability.ts";

type HydratedLookupResult = {
  accounts: FanslyAccount[];
  fallbackIds: string[];
};

function normalizeHydratedFan(account: FanslyAccount): UpsertFanInput {
  return {
    platform: "fansly",
    platformUserId: account.id,
    username: account.username,
    displayName: account.displayName,
    createdAtExternal: account.createdAt ? new Date(account.createdAt) : null,
    metadata: {},
  };
}

function normalizeFanslyNote(note: FanslyAccountNote) {
  return {
    externalNoteId: note.id,
    contentType: note.contentType ?? null,
    contentId: note.contentId ?? null,
    title: note.title ?? null,
    body: note.note ?? null,
    createdAtExternal: note.createdAt ? new Date(note.createdAt) : null,
    updatedAtExternal: note.updatedAt ? new Date(note.updatedAt) : null,
    raw: note as unknown as Record<string, unknown>,
  };
}

export async function lookupHydratedFans(
  app: AppContext,
  input: {
    requestContext: Parameters<AppContext["adapter"]["getAccountsByIdsPage"]>[0];
    platformUserIds: string[];
    telemetry?: SyncRunTelemetry;
  },
) {
  if (input.platformUserIds.length === 0) {
    return {
      accounts: [],
      fallbackIds: [],
    } satisfies HydratedLookupResult;
  }

  const uniqueIds = Array.from(new Set(input.platformUserIds.filter(Boolean)));
  const accounts: FanslyAccount[] = [];

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

  return {
    accounts,
    fallbackIds,
  } satisfies HydratedLookupResult;
}

export async function prepareHydratedFans(
  app: AppContext,
  input: {
    requestContext: Parameters<AppContext["adapter"]["getAccountsByIdsPage"]>[0];
    platformUserIds: string[];
    telemetry?: SyncRunTelemetry;
  },
) {
  const { accounts, fallbackIds } = await lookupHydratedFans(app, input);
  const deletedDetectedAt = new Date();

  return [
    ...accounts.map(normalizeHydratedFan),
    ...fallbackIds.map((id) => ({
      platform: "fansly" as const,
      platformUserId: id,
      metadata: {},
      deletedDetectedAt,
    })),
  ] satisfies UpsertFanInput[];
}

export async function upsertHydratedFansForPage(
  db: Database,
  input: {
    platformAccountId: number;
    accounts: FanslyAccount[];
    fallbackIds?: string[];
  },
) {
  const result = await upsertHydratedFansForPageDetailed(db, input);
  return result.fanMap;
}

export async function upsertHydratedFansForPageDetailed(
  db: Database,
  input: {
    platformAccountId: number;
    accounts: FanslyAccount[];
    fallbackIds?: string[];
  },
) {
  const deletedDetectedAt = new Date();
  const fans = await upsertFans(db, [
    ...input.accounts.map(normalizeHydratedFan),
    ...(input.fallbackIds ?? []).map((platformUserId) => ({
      platform: "fansly" as const,
      platformUserId,
      metadata: {},
      deletedDetectedAt,
    })),
  ]);
  const fanMap = new Map(fans.map((fan) => [fan.platformUserId, fan.id] as const));

  if (fans.length > 0) {
    await upsertFanPages(db, fans.map((fan) => ({
      fanId: fan.id,
      platformAccountId: input.platformAccountId,
    })));
  }

  let reconciledAccountCount = 0;
  let noteCount = 0;
  let upsertedNoteCount = 0;
  let deactivatedNoteCount = 0;
  let aliasesSet = 0;
  let aliasesCleared = 0;

  for (const account of input.accounts) {
    const fanId = fanMap.get(account.id);
    if (!fanId || !Array.isArray(account.notes)) {
      continue;
    }

    const reconciliation = await reconcileFanslyFanPageIdentity(db, {
      platformAccountId: input.platformAccountId,
      fanId,
      notes: account.notes.map(normalizeFanslyNote),
    });
    reconciledAccountCount += 1;
    noteCount += reconciliation.noteCount;
    upsertedNoteCount += reconciliation.upsertedNoteCount;
    deactivatedNoteCount += reconciliation.deactivatedNoteCount;
    aliasesSet += reconciliation.aliasSet ? 1 : 0;
    aliasesCleared += reconciliation.aliasCleared ? 1 : 0;
  }

  return {
    fanMap,
    accountCount: input.accounts.length,
    fallbackCount: (input.fallbackIds ?? []).length,
    reconciledAccountCount,
    noteCount,
    upsertedNoteCount,
    deactivatedNoteCount,
    aliasesSet,
    aliasesCleared,
  };
}

export async function hydrateFans(
  app: AppContext,
  input: {
    db?: Database;
    platformAccountId?: number;
    requestContext: Parameters<AppContext["adapter"]["getAccountsByIdsPage"]>[0];
    platformUserIds: string[];
    telemetry?: SyncRunTelemetry;
  },
) {
  const { accounts, fallbackIds } = await lookupHydratedFans(app, input);
  const db = input.db ?? app.db;
  const deletedDetectedAt = new Date();

  if (input.platformAccountId !== undefined) {
    return upsertHydratedFansForPage(db, {
      platformAccountId: input.platformAccountId,
      accounts,
      fallbackIds,
    });
  }

  const fans = await upsertFans(db, [
    ...accounts.map(normalizeHydratedFan),
    ...fallbackIds.map((platformUserId) => ({
      platform: "fansly" as const,
      platformUserId,
      metadata: {},
      deletedDetectedAt,
    })),
  ]);
  return new Map(fans.map((fan) => [fan.platformUserId, fan.id]));
}
