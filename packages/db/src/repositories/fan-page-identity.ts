import { and, eq, gt, inArray, notInArray, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  fanPageAliases,
  fanPageExternalNotes,
  fanPages,
  fans,
  pages,
} from "../schema.ts";

export const FANSLY_PAGE_ALIAS_SOURCE = "fansly_custom_username_note" as const;

export interface FanslyExternalNoteInput {
  externalNoteId: string;
  contentType?: number | null;
  title?: string | null;
  body?: string | null;
  createdAtExternal?: Date | null;
  updatedAtExternal?: Date | null;
  raw?: Record<string, unknown>;
}

export interface ReconcileFanslyFanPageIdentityInput {
  platformAccountId: number;
  fanId: number;
  notes: FanslyExternalNoteInput[];
  seenAt?: Date;
}

function normalizeTrimmedText(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function noteFreshnessTime(note: Pick<FanslyExternalNoteInput, "updatedAtExternal" | "createdAtExternal">) {
  return (note.updatedAtExternal ?? note.createdAtExternal ?? new Date(0)).getTime();
}

function compareFreshestNotes(left: FanslyExternalNoteInput, right: FanslyExternalNoteInput) {
  const timeDiff = noteFreshnessTime(right) - noteFreshnessTime(left);
  if (timeDiff !== 0) {
    return timeDiff;
  }

  return right.externalNoteId.localeCompare(left.externalNoteId);
}

function isFanslyAliasNote(note: Pick<FanslyExternalNoteInput, "title" | "contentType">) {
  return note.title === "Custom Username" || note.contentType === 12002;
}

function dedupeNotesById(notes: FanslyExternalNoteInput[]) {
  const byId = new Map<string, FanslyExternalNoteInput>();

  for (const note of notes) {
    const current = byId.get(note.externalNoteId);
    if (!current || compareFreshestNotes(current, note) > 0) {
      byId.set(note.externalNoteId, note);
    }
  }

  return Array.from(byId.values());
}

function dedupeAliasHistoryNotes(notes: FanslyExternalNoteInput[]) {
  const byAlias = new Map<string, FanslyExternalNoteInput>();

  for (const note of notes) {
    const alias = normalizeTrimmedText(note.body);
    if (!alias || !isFanslyAliasNote(note)) {
      continue;
    }

    const current = byAlias.get(alias);
    if (!current || compareFreshestNotes(current, note) > 0) {
      byAlias.set(alias, note);
    }
  }

  return Array.from(byAlias.entries()).map(([alias, note]) => ({
    alias,
    sourceNoteId: note.externalNoteId,
  }));
}

function selectCurrentAliasNote(notes: FanslyExternalNoteInput[]) {
  const aliasCandidates = notes
    .filter(isFanslyAliasNote)
    .sort(compareFreshestNotes);
  return aliasCandidates[0] ?? null;
}

export async function reconcileFanslyFanPageIdentity(
  db: Database,
  input: ReconcileFanslyFanPageIdentityInput,
) {
  const seenAt = input.seenAt ?? new Date();
  const [existingMembership] = await db.select({
    pageAlias: fanPages.pageAlias,
  }).from(fanPages)
    .where(and(
      eq(fanPages.platformAccountId, input.platformAccountId),
      eq(fanPages.fanId, input.fanId),
    ))
    .limit(1);
  const notes = dedupeNotesById(input.notes);
  const activeNoteIds = notes.map((note) => note.externalNoteId);

  const upsertedNotes = notes.length === 0
    ? []
    : await db.insert(fanPageExternalNotes)
      .values(notes.map((note) => ({
        platformAccountId: input.platformAccountId,
        fanId: input.fanId,
        provider: "fansly" as const,
        externalNoteId: note.externalNoteId,
        contentType: note.contentType ?? null,
        title: note.title ?? null,
        body: note.body ?? null,
        createdAtExternal: note.createdAtExternal ?? null,
        updatedAtExternal: note.updatedAtExternal ?? null,
        isActive: true,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        raw: note.raw ?? {},
      })))
      .onConflictDoUpdate({
        target: [
          fanPageExternalNotes.platformAccountId,
          fanPageExternalNotes.provider,
          fanPageExternalNotes.externalNoteId,
        ],
        set: {
          fanId: sql`excluded.fan_id`,
          contentType: sql`excluded.content_type`,
          title: sql`excluded.title`,
          body: sql`excluded.body`,
          createdAtExternal: sql`excluded.created_at_external`,
          updatedAtExternal: sql`excluded.updated_at_external`,
          isActive: true,
          lastSeenAt: sql`excluded.last_seen_at`,
          raw: sql`excluded.raw`,
        },
      })
      .returning({ externalNoteId: fanPageExternalNotes.externalNoteId });

  const deactivatedNotes = activeNoteIds.length === 0
    ? await db.update(fanPageExternalNotes)
      .set({
        isActive: false,
        lastSeenAt: seenAt,
      })
      .where(and(
        eq(fanPageExternalNotes.platformAccountId, input.platformAccountId),
        eq(fanPageExternalNotes.fanId, input.fanId),
        eq(fanPageExternalNotes.provider, "fansly"),
        eq(fanPageExternalNotes.isActive, true),
      ))
      .returning({ externalNoteId: fanPageExternalNotes.externalNoteId })
    : await db.update(fanPageExternalNotes)
      .set({
        isActive: false,
        lastSeenAt: seenAt,
      })
      .where(and(
        eq(fanPageExternalNotes.platformAccountId, input.platformAccountId),
        eq(fanPageExternalNotes.fanId, input.fanId),
        eq(fanPageExternalNotes.provider, "fansly"),
        eq(fanPageExternalNotes.isActive, true),
        notInArray(fanPageExternalNotes.externalNoteId, activeNoteIds),
      ))
      .returning({ externalNoteId: fanPageExternalNotes.externalNoteId });

  const aliasHistoryRows = dedupeAliasHistoryNotes(notes);
  if (aliasHistoryRows.length > 0) {
    await db.insert(fanPageAliases)
      .values(aliasHistoryRows.map((row) => ({
        platformAccountId: input.platformAccountId,
        fanId: input.fanId,
        alias: row.alias,
        sourceNoteId: row.sourceNoteId,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      })))
      .onConflictDoUpdate({
        target: [
          fanPageAliases.platformAccountId,
          fanPageAliases.fanId,
          fanPageAliases.alias,
        ],
        set: {
          sourceNoteId: sql`excluded.source_note_id`,
          firstSeenAt: sql`least(${fanPageAliases.firstSeenAt}, excluded.first_seen_at)`,
          lastSeenAt: sql`greatest(${fanPageAliases.lastSeenAt}, excluded.last_seen_at)`,
        },
      });
  }

  const currentAliasNote = selectCurrentAliasNote(notes);
  const currentAlias = normalizeTrimmedText(currentAliasNote?.body);
  const hasCurrentAlias = currentAlias !== null;
  const nextAliasSourceNoteId = hasCurrentAlias ? currentAliasNote?.externalNoteId ?? null : null;

  await db.update(fanPages)
    .set({
      pageAlias: currentAlias,
      pageAliasSource: hasCurrentAlias ? FANSLY_PAGE_ALIAS_SOURCE : null,
      pageAliasSourceNoteId: nextAliasSourceNoteId,
      pageAliasSyncedAt: seenAt,
    })
    .where(and(
      eq(fanPages.platformAccountId, input.platformAccountId),
      eq(fanPages.fanId, input.fanId),
    ));

  const previousAlias = existingMembership?.pageAlias ?? null;

  return {
    noteCount: notes.length,
    upsertedNoteCount: upsertedNotes.length,
    deactivatedNoteCount: deactivatedNotes.length,
    currentAlias,
    aliasSet: currentAlias !== null && currentAlias !== previousAlias,
    aliasCleared: currentAlias === null && previousAlias !== null,
    aliasHistoryCount: aliasHistoryRows.length,
  };
}

export async function listFanslyFanPageIdentityBackfillTargets(
  db: Database,
  input?: {
    platformAccountIds?: number[];
    /** Keyset of a one-page walk (the Sync Engine's alias backfill): only
     *  fans whose platform user id sorts after this one. */
    afterPlatformUserId?: string | null;
    /** At most this many targets (a one-page walk's batch). */
    limit?: number;
  },
) {
  const clauses = [eq(pages.platform, "fansly")];

  if (input?.platformAccountIds) {
    if (input.platformAccountIds.length === 0) {
      return [];
    }
    clauses.push(inArray(fanPages.platformAccountId, input.platformAccountIds));
  }
  const keyset = input?.afterPlatformUserId ?? null;
  if (keyset !== null) {
    if (input?.platformAccountIds?.length !== 1) {
      throw new Error("A keyset over alias backfill targets walks exactly one page");
    }
    clauses.push(gt(fans.platformUserId, keyset));
  }

  const query = db.select({
    platformAccountId: fanPages.platformAccountId,
    pageLabel: pages.label,
    fanId: fanPages.fanId,
    platformUserId: fans.platformUserId,
  }).from(fanPages)
    .innerJoin(fans, eq(fans.id, fanPages.fanId))
    .innerJoin(pages, eq(pages.id, fanPages.platformAccountId))
    .where(and(...clauses))
    .orderBy(pages.label, fans.platformUserId);
  return input?.limit === undefined ? query : query.limit(Math.max(1, input.limit));
}
