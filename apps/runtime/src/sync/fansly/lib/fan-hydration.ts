import {
  markFanPageAccountLookups,
  recordFanPageAccountLookupAnswers,
  reconcileFanslyFanPageIdentity,
  upsertFanPages,
  upsertFans,
  type Database,
  type UpsertFanInput,
} from "@agency_hub_core/db";
import type { FanslyAccount, FanslyAccountNote } from "@agency_hub_core/fansly";
import { sanitizeLoneSurrogatesDeep, sanitizePostgresText } from "@agency_hub_core/shared";

// The fan-hydration writers of the Sync Engine's resources (fan-profiles,
// dm-conversations, subscribers, followers, transactions): a page's Fansly
// fans, their page links, the account-lookup stamp and answer, and the
// creator's notes on each fan. The legacy transactions and DM walks (with
// their account lookup and partner probe) and the alias backfill import them
// from here until step 4 deletes them.

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

/** The fan's own profile text as an account answer gives it: trimmed, and in
 * a form Postgres stores (like a note, it is served text: one broken emoji
 * would fail the page transaction on every retry). Null when the fan wrote
 * none. */
function servedAbout(account: FanslyAccount): string | null {
  if (typeof account.about !== "string") {
    return null;
  }
  const about = sanitizePostgresText(account.about).trim();
  return about.length > 0 ? about : null;
}

/**
 * `fullProfile`: the account is an account lookup's answer (`/account?ids=`),
 * the one answer that carries the fan's profile text. chat-extension R20
 * HF-7б keeps it in `fans.metadata.about` for the AI context
 * (modules/ai/context/fansly-fan-identity.ts). Fansly serves `about` only for
 * an account that wrote one, so a lookup's answer without it clears the stored
 * text. An account served beside a list (the inbox, the followers) never
 * carries the text and says nothing about it: the stored one stays.
 */
function normalizeHydratedFan(account: FanslyAccount, fullProfile: boolean): UpsertFanInput {
  const about = fullProfile ? servedAbout(account) : null;
  return {
    platform: "fansly",
    platformUserId: account.id,
    username: account.username,
    displayName: account.displayName,
    createdAtExternal: account.createdAt ? new Date(account.createdAt) : null,
    ...(fullProfile ? { metadata: about === null ? {} : { about } } : {}),
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
  /** Ids seen without an account snapshot and never looked up: the fan row is
   * ensured and linked, but nothing about the account is inferred. */
  unverifiedIds?: string[];
  /** Ids a lookup did not send because their lookup through this page ran
   * within the day: linked like unverifiedIds, row kept as it is. */
  reusedIds?: string[];
  /** The lookup that produced `accounts`. Every id it asked for is ensured and
   * linked, stamped as looked up and given the page's own answer
   * (`page_fans.account_probe_*`): resolved when its account came back,
   * unresolved when it did not. An id the answer omits is ensured like an
   * unverified one and marks nothing on the shared fan row: a fan who blocked
   * the page is omitted too, so a page's miss is no evidence the account is
   * gone (arena "vanished chat" D2). Written with the result, so a rolled-back
   * write leaves no stamp. */
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
  const returnedIds = new Set(input.accounts.map((account) => account.id));
  const missedIds = (input.lookup?.platformUserIds ?? []).filter((id) => !returnedIds.has(id));
  // Only a lookup's own answer is a full profile (see normalizeHydratedFan).
  const fullProfiles = input.lookup != null;
  const fans = await upsertFans(db, [
    ...input.accounts.map((account) => normalizeHydratedFan(account, fullProfiles)),
    ...[...missedIds, ...(input.unverifiedIds ?? []), ...(input.reusedIds ?? [])].map((platformUserId) => ({
      platform: "fansly" as const,
      platformUserId,
    })),
  ]);
  const fanMap = new Map(fans.map((fan) => [fan.platformUserId, fan.id] as const));
  const fanIdsOf = (ids: readonly string[]) => ids.flatMap((id) => fanMap.get(id) ?? []);

  if (fans.length > 0) {
    await upsertFanPages(db, fans.map((fan) => ({
      fanId: fan.id,
      platformAccountId: input.platformAccountId,
    })));
  }
  if (input.lookup) {
    await markFanPageAccountLookups(db, {
      platformAccountId: input.platformAccountId,
      fanIds: fanIdsOf(input.lookup.platformUserIds),
      lookedUpAt: input.lookup.lookedUpAt,
    });
    await recordFanPageAccountLookupAnswers(db, {
      platformAccountId: input.platformAccountId,
      answeredAt: input.lookup.lookedUpAt,
      resolvedFanIds: fanIdsOf(input.lookup.platformUserIds.filter((id) => returnedIds.has(id))),
      unresolvedFanIds: fanIdsOf(missedIds),
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
    missedCount: missedIds.length,
    reconciledAccountCount,
    noteCount,
    upsertedNoteCount,
    deactivatedNoteCount,
    aliasesSet,
    aliasesCleared,
  };
}
