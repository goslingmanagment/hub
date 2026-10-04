import { and, desc, eq, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { aiGenerationContent, aiUsageEvents, fanProfiles } from "../schema.ts";
import { ECMASCRIPT_TRIM_CHARACTERS } from "./ai-completion.ts";
import { usableFanSummaryPredicate } from "./ai-restricted.ts";

// chat-extension H-5: the reads behind the dossier save from a stored
// generation (`clientFanProfileFromGeneration`).
//
// The restricted generation records are read back by the owner only, with two
// narrow exceptions. One is the shared recap text (ai-restricted.ts,
// getFreshestUsableRecapBodies). The other is here: the AUTHOR of a generation
// has its text copied into the fan's dossier. The reader is scoped to the
// caller's own rows, names its columns (no prompt block, no manifest), and the
// text goes to the dossier write, never back to the caller.

/** One generation of the caller, as the dossier save needs it. */
export interface OwnGenerationForProfile {
  pageId: number | null;
  conversationRef: string | null;
  fanRef: string | null;
  createdAt: Date;
  completion: string;
  /**
   * The verdict: `usableFanSummaryPredicate("full")`, the one definition of a
   * usable full recap. The dossier's generation proof selects by the same
   * predicate, so a generation saved on this verdict always proves its dossier.
   */
  usableFullSummary: boolean;
  // The facts behind the verdict, for the refusal's reason only.
  feature: string;
  summaryMode: string | null;
  outcome: string | null;
  stopReason: string | null;
  blank: boolean;
  contextScoped: boolean;
}

/**
 * The caller's own generation with this ref, or null. A generation of another
 * user reads as absent: the answer never depends on a row that is not the
 * caller's. Served by the unique index on `generation_ref`.
 */
export async function findOwnGenerationForProfile(
  db: Database,
  input: { generationRef: string; userId: number },
): Promise<OwnGenerationForProfile | null> {
  const params = aiGenerationContent.params;
  const [row] = await db
    .select({
      pageId: aiGenerationContent.pageId,
      conversationRef: aiGenerationContent.conversationRef,
      fanRef: aiGenerationContent.fanRef,
      createdAt: aiGenerationContent.createdAt,
      completion: aiGenerationContent.completion,
      usableFullSummary: sql<boolean>`${usableFanSummaryPredicate("full")}`,
      feature: aiGenerationContent.feature,
      summaryMode: sql<string | null>`${params} ->> 'summaryMode'`,
      outcome: sql<string | null>`${params} ->> 'outcome'`,
      stopReason: sql<string | null>`${params} ->> 'stopReason'`,
      blank: sql<boolean>`btrim(${aiGenerationContent.completion}, ${ECMASCRIPT_TRIM_CHARACTERS}) = ''`,
      contextScoped: sql<boolean>`${params} ->> 'contextScope' is not null`,
    })
    .from(aiGenerationContent)
    .where(and(
      eq(aiGenerationContent.generationRef, input.generationRef),
      eq(aiGenerationContent.userId, input.userId),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * Whether the gateway admitted an AI request of this user under this client
 * request id on this page: a reservation still in flight, or one already
 * settled. Its generation record is written right after the settlement, so a
 * request found here whose record is missing is "not recorded yet". A request
 * the quota refused and a usage row a client reported itself (the direct-mode
 * batch) were never admitted, and no record follows them. Served by the unique
 * index on (user_id, client_event_id).
 */
export async function hasAdmittedAiGatewayRequest(
  db: Database,
  input: { userId: number; clientRequestId: string; pageId: number },
): Promise<boolean> {
  const [row] = await db
    .select({ id: aiUsageEvents.id })
    .from(aiUsageEvents)
    .where(and(
      eq(aiUsageEvents.userId, input.userId),
      eq(aiUsageEvents.clientEventId, input.clientRequestId),
      eq(aiUsageEvents.pageId, input.pageId),
      eq(aiUsageEvents.quotaAccepted, true),
    ))
    .limit(1);
  return row !== undefined;
}

/** A dossier version without its body. */
export interface FanProfileVersionRef {
  version: number;
  createdAt: Date;
  sourceGeneratedAt: Date | null;
}

/**
 * The newest version of the fan's dossier on the page whose body is exactly
 * this text, or null. Compared as the dossier write compares bodies (exact
 * equality), over the few versions one fan has on one page.
 */
export async function findFanProfileVersionByBody(
  db: Database,
  input: { fanId: number; platformAccountId: number; body: string },
): Promise<FanProfileVersionRef | null> {
  const [row] = await db
    .select({
      version: fanProfiles.version,
      createdAt: fanProfiles.createdAt,
      sourceGeneratedAt: fanProfiles.sourceGeneratedAt,
    })
    .from(fanProfiles)
    .where(and(
      eq(fanProfiles.fanId, input.fanId),
      eq(fanProfiles.platformAccountId, input.platformAccountId),
      eq(fanProfiles.body, input.body),
    ))
    .orderBy(desc(fanProfiles.version))
    .limit(1);
  return row ?? null;
}
