import {
  markFanPageAccountLookups,
  reconcileFanslyFanPageIdentity,
  upsertFanPages,
  upsertFans,
  type Database,
  type UpsertFanInput,
} from "@agency_hub_core/db";
import type { FanslyAccount, FanslyAccountNote } from "@agency_hub_core/fansly";
import { sanitizeLoneSurrogatesDeep } from "@agency_hub_core/shared";

// The fan-hydration writers of the Sync Engine's resources (fan-profiles,
// dm-conversations, subscribers, followers, transactions): a page's Fansly
// fans, their page links, the account-lookup stamp and the creator's notes on
// each fan. The legacy transactions and DM walks (with their account lookup
// and partner probe) and the alias backfill import them from here until
// step 4 deletes them.

/**
 * Owner decision 2026-09-30: a fan's Fansly profile (username, display name,
 * the creator's notes and custom name on the fan) is read at most once a day
 * per page, an absent account included; a fan never looked up through the page
 * is looked up at once. Accepted cost: a note or custom name edited in Fansly
 * reaches Hub up to a day later. Per page because the notes a lookup returns
 * belong to the page whose session asked.
 */
export const FANSLY_ACCOUNT_LOOKUP_REUSE_MS = 24 * 60 * 60_000;

/** What one account lookup sent. upsertHydratedFansForPage stamps these ids in
 * the transaction that stores the result, never before. */
export type FanslyAccountLookupStamp = {
  lookedUpAt: Date;
  platformUserIds: string[];
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

type HydratedFansForPageInput = {
  platformAccountId: number;
  accounts: FanslyAccount[];
  /** Ids an account lookup asked for and did not get back: marked deleted. */
  fallbackIds?: string[];
  /** Ids seen without an account snapshot and never looked up: the fan row is
   * ensured and linked, but nothing about the account is inferred. */
  unverifiedIds?: string[];
  /** Ids a lookup did not send because their lookup through this page ran
   * within the day: linked like unverifiedIds, row kept as it is. */
  reusedIds?: string[];
  /** The lookup that produced `accounts` and `fallbackIds`: its ids are
   * stamped with the result, so a rolled-back write leaves no stamp. */
  lookup?: FanslyAccountLookupStamp | null;
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
    ...[...(input.unverifiedIds ?? []), ...(input.reusedIds ?? [])].map((platformUserId) => ({
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
  if (input.lookup) {
    await markFanPageAccountLookups(db, {
      platformAccountId: input.platformAccountId,
      fanIds: input.lookup.platformUserIds.flatMap((id) => fanMap.get(id) ?? []),
      lookedUpAt: input.lookup.lookedUpAt,
    });
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
