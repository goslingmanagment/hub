import {
  reconcileFanslyFanPageIdentity,
  upsertFanPages,
  upsertFans,
  type Database,
  type UpsertFanInput,
} from "@agency_hub_core/db";
import { FANSLY_MAPPER_VERSION, type FanslyAccount, type FanslyAccountNote } from "@agency_hub_core/fansly";
import { sanitizeLoneSurrogatesDeep } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { SyncRunTelemetry } from "./observability.ts";
import { persistRawPayload, retentionDate } from "./shared.ts";

type HydratedLookupResult = {
  accounts: FanslyAccount[];
  fallbackIds: string[];
};

/** Stage 7 producer 2: callers with a page + run in hand pass this so every
 *  hydration lookup page is persisted + journaled like any other fetch. */
export type HydrationCaptureContext = {
  platformAccountId: number;
  syncRunId: number | null;
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

function normalizeFanslyNote(served: FanslyAccountNote) {
  // The note is served text (a creator's free-form note, a custom username)
  // and `raw` is jsonb, which refuses an unpaired UTF-16 surrogate: one broken
  // emoji would fail the page transaction on every retry
  // (./journal-lone-surrogates.ts). Every field comes from ONE copy so the
  // alias compared and deduplicated here is the text the columns store.
  const note = sanitizeLoneSurrogatesDeep(served);
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
    capture?: HydrationCaptureContext;
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

type HydratedFansForPageInput = {
  platformAccountId: number;
  accounts: FanslyAccount[];
  /** Ids an account lookup asked for and did not get back: marked deleted. */
  fallbackIds?: string[];
  /** Ids seen without an account snapshot and never looked up: the fan row is
   * ensured and linked, but nothing about the account is inferred. */
  unverifiedIds?: string[];
};

export async function upsertHydratedFansForPage(
  db: Database,
  input: HydratedFansForPageInput,
) {
  const result = await upsertHydratedFansForPageDetailed(db, input);
  return result.fanMap;
}

export async function upsertHydratedFansForPageDetailed(
  db: Database,
  input: HydratedFansForPageInput,
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
    ...(input.unverifiedIds ?? []).map((platformUserId) => ({
      platform: "fansly" as const,
      platformUserId,
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
