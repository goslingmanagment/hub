import { and, desc, eq, getTableColumns, isNull, or, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { aiGenerationContent, fanPages, fanProfiles, fans } from "../schema.ts";
import { usableFanSummaryPredicate } from "./ai-restricted.ts";
import { findVisiblePageDmConversationByPlatformConversationId } from "./page-dm.ts";

export interface AppendFanProfileInput {
  fanId: number;
  platformAccountId: number;
  body: string;
  source: string;
  createdByUserId?: number | null;
  /** Scan generation time (#136) — null when the writing client predates it. */
  sourceGeneratedAt?: Date | null;
}

export async function appendFanProfile(
  db: Database,
  input: AppendFanProfileInput,
) {
  return db.transaction(async (tx) => {
    // Serialize version assignment per fan/page so version numbers stay gapless and monotonic.
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${`${input.platformAccountId}:${input.fanId}`}, 0))
    `);

    const [latest] = await tx
      .select()
      .from(fanProfiles)
      .where(and(
        eq(fanProfiles.fanId, input.fanId),
        eq(fanProfiles.platformAccountId, input.platformAccountId),
      ))
      .orderBy(desc(fanProfiles.version))
      .limit(1);

    // #136 hardening: the dedupe/ordering rules live HERE, inside the same
    // advisory-locked transaction that assigns the version — a client-side
    // preflight GET can always race another writer between its read and this
    // write, so the client check is only an optimization.
    if (latest) {
      // Identical body: already stored (a re-push whose ack was lost) — never
      // append a duplicate version.
      if (latest.body === input.body) {
        return latest;
      }
      // Stale write: an incoming dossier with a KNOWN source time never
      // supersedes a latest whose (source ?? append) time is not older —
      // another client re-scanned meanwhile. Legacy writes without a source
      // time keep the historical always-append semantics.
      if (input.sourceGeneratedAt) {
        const latestGeneratedAt = latest.sourceGeneratedAt ?? latest.createdAt;
        if (latestGeneratedAt.getTime() >= input.sourceGeneratedAt.getTime()) {
          return latest;
        }
      }
    }

    const [created] = await tx
      .insert(fanProfiles)
      .values({
        fanId: input.fanId,
        platformAccountId: input.platformAccountId,
        version: (latest?.version ?? 0) + 1,
        body: input.body,
        source: input.source,
        createdByUserId: input.createdByUserId ?? null,
        sourceGeneratedAt: input.sourceGeneratedAt ?? null,
      })
      .returning();

    return created;
  });
}

export async function getLatestFanProfile(
  db: Database,
  input: {
    fanId: number;
    platformAccountId: number;
  },
) {
  return db.query.fanProfiles.findFirst({
    where: and(
      eq(fanProfiles.fanId, input.fanId),
      eq(fanProfiles.platformAccountId, input.platformAccountId),
    ),
    orderBy: (table, { desc: orderDesc }) => [orderDesc(table.version)],
  });
}

/**
 * Newest dossier that Core can independently prove came from a complete full
 * fan-summary generation. The profile write is a separate, client-driven
 * request, so eligibility is established by an exact body match against the
 * restricted generation ledger plus page/fan identity and the same usable-recap
 * rule as recap attachment (usableFanSummaryPredicate: terminal outcome, and no
 * `contextScope`, so a generation that read one person's draft context proves
 * no dossier). Filtering happens before version ordering: an unproven newer
 * profile must never hide an older proven one.
 */
export async function getLatestPromptEligibleFanProfile(
  db: Database,
  input: {
    fanId: number;
    platformAccountId: number;
    platformUserId: string;
  },
) {
  const [row] = await db
    .select({
      ...getTableColumns(fanProfiles),
      proofCreatedAt: aiGenerationContent.createdAt,
    })
    .from(fanProfiles)
    .innerJoin(aiGenerationContent, and(
      eq(aiGenerationContent.pageId, fanProfiles.platformAccountId),
      eq(aiGenerationContent.completion, fanProfiles.body),
    ))
    .where(and(
      eq(fanProfiles.fanId, input.fanId),
      eq(fanProfiles.platformAccountId, input.platformAccountId),
      usableFanSummaryPredicate("full"),
      or(
        eq(aiGenerationContent.fanRef, input.platformUserId),
        and(
          isNull(aiGenerationContent.fanRef),
          eq(aiGenerationContent.conversationRef, input.platformUserId),
        ),
      ),
    ))
    .orderBy(
      desc(fanProfiles.version),
      desc(aiGenerationContent.createdAt),
      desc(aiGenerationContent.id),
    )
    .limit(1);

  return row ?? null;
}

export async function listFanProfileVersionSummaries(
  db: Database,
  input: {
    fanId: number;
    platformAccountId: number;
  },
) {
  return db
    .select({
      version: fanProfiles.version,
      createdAt: fanProfiles.createdAt,
    })
    .from(fanProfiles)
    .where(and(
      eq(fanProfiles.fanId, input.fanId),
      eq(fanProfiles.platformAccountId, input.platformAccountId),
    ))
    .orderBy(desc(fanProfiles.version));
}

export async function getFanProfileVersion(
  db: Database,
  input: {
    fanId: number;
    platformAccountId: number;
    version: number;
  },
) {
  return db.query.fanProfiles.findFirst({
    where: and(
      eq(fanProfiles.fanId, input.fanId),
      eq(fanProfiles.platformAccountId, input.platformAccountId),
      eq(fanProfiles.version, input.version),
    ),
  });
}

export async function getLatestFanProfileForConversation(
  db: Database,
  input: {
    platformAccountId: number;
    platformConversationId: string;
  },
) {
  const conversation = await findVisiblePageDmConversationByPlatformConversationId(db, input);
  if (!conversation?.fanId) {
    return null;
  }

  const fan = await db.query.fans.findFirst({
    where: eq(fans.id, conversation.fanId),
  });
  if (!fan) {
    return null;
  }

  const [fanPage] = await db.select({
    pageAlias: fanPages.pageAlias,
  }).from(fanPages)
    .where(and(
      eq(fanPages.platformAccountId, input.platformAccountId),
      eq(fanPages.fanId, fan.id),
    ))
    .limit(1);

  const profile = await getLatestFanProfile(db, {
    fanId: fan.id,
    platformAccountId: input.platformAccountId,
  });

  return {
    fan: {
      ...fan,
      pageAlias: fanPage?.pageAlias ?? null,
    },
    profile: profile ?? null,
  };
}
