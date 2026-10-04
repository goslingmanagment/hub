import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import { aiAcceptanceEvents, aiGenerationContent } from "../schema.ts";
import { ECMASCRIPT_TRIM_CHARACTERS } from "./ai-completion.ts";

// Stage 29 restricted capture class (DP 6-A). Writes happen at gateway
// finalize and via the acceptance canonicalizer; reads are owner-only at
// the route layer, with ONE exception: the text of a usable fan-summary recap
// is shared with every chatter granted its page (chat-extension H-13, owner
// ruling "recaps are shared"). That exception is getFreshestUsableRecapBodies
// below and nothing else: it selects no prompt block, no other feature and no
// row outside usableFanSummaryPredicate.

export interface InsertAiGenerationContentInput {
  usageEventId: number | null;
  generationRef: string;
  feature: string;
  model: string;
  provider: string;
  userId: number | null;
  pageId: number | null;
  conversationRef: string | null;
  /** The fan this generation is about (spec §5). NULL when the request carried
   * no separate fanRef (legacy/raw-gateway/internal); Stage 28 fan erasure
   * matches on conversation_ref OR fan_ref. */
  fanRef: string | null;
  promptBlocks: unknown[];
  completion: string;
  params: Record<string, unknown>;
}

export async function insertAiGenerationContent(
  db: Database,
  input: InsertAiGenerationContentInput,
) {
  const [created] = await db.insert(aiGenerationContent).values(input)
    .onConflictDoNothing({ target: aiGenerationContent.generationRef })
    .returning();
  return created ?? null;
}

export interface InsertAiAcceptanceEventInput {
  generationRef: string;
  lifecycle: "shown" | "copied" | "inserted" | "edited" | "sent";
  userId: number | null;
  occurredAt: Date;
  sourceObservationId: number | null;
}

export async function insertAiAcceptanceEvent(
  db: Database,
  input: InsertAiAcceptanceEventInput,
) {
  const [created] = await db.insert(aiAcceptanceEvents).values(input)
    .onConflictDoNothing()
    .returning();
  return created ?? null;
}

export async function listAiGenerationContent(
  db: Database,
  input?: { feature?: string; pageId?: number; limit?: number },
) {
  const clauses = [];
  if (input?.feature) {
    clauses.push(eq(aiGenerationContent.feature, input.feature));
  }
  if (input?.pageId !== undefined) {
    clauses.push(eq(aiGenerationContent.pageId, input.pageId));
  }
  return db.select().from(aiGenerationContent)
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(desc(aiGenerationContent.createdAt))
    .limit(input?.limit ?? 50);
}

export async function getAiGenerationContentByRef(db: Database, generationRef: string) {
  const row = await db.query.aiGenerationContent.findFirst({
    where: eq(aiGenerationContent.generationRef, generationRef),
  });
  if (!row) {
    return null;
  }
  const acceptance = await db.select().from(aiAcceptanceEvents)
    .where(eq(aiAcceptanceEvents.generationRef, generationRef))
    .orderBy(aiAcceptanceEvents.occurredAt);
  return { generation: row, acceptance };
}

export type AiGenerationContentRow = typeof aiGenerationContent.$inferSelect;

export interface FreshestRecapsInput {
  pageId: number;
  conversationRefs: string[]; // canonical groupId first, legacy fanAccountId second
  /** Opaque identity of the resolved persona. Omitted only for rollout
   * compatibility with callers predating persona-scoped recap status. */
  personaDefinitionId?: string;
}

export interface FreshestRecaps {
  full: AiGenerationContentRow | null;
  short: AiGenerationContentRow | null;
}

/**
 * A usable fan-summary recap of one mode, as a condition over
 * `ai_generation_content`. The ONE definition for every reader that selects a
 * recap: the two-slot selection below (recap status, the Coach attach, the
 * shared recaps read), the dossier's generation proof (fan-profiles.ts) and
 * the dossier save from a stored generation (chat-extension H-5).
 *
 * Usable = a `fan-summary` row of that `summaryMode` with a completed outcome,
 * a non-empty completion, a PRESENT and non-exhausted stopReason, and no
 * `contextScope`. A modern row with a NULL stopReason is fail-closed unusable
 * (P1-5b): a truncated generation that never recorded its terminal reason must
 * never be attached as a recap. The exhausted stop-reason literals mirror the
 * shared `isOutputExhausted` predicate (packages/shared/src/ai-stop-reason.ts):
 * Anthropic 'max_tokens', OpenRouter 'length'.
 *
 * `params.contextScope` marks a generation whose context held something only
 * its caller saw (the fresh text of an open chat: `principal-draft`). Such a
 * row is one person's draft, never a shared recap and never the proof of a
 * dossier, so every value excludes it; only a missing key or a JSON null reads
 * as "no scope". Nothing writes the key on a fan-summary row, so the condition
 * is a guard: it changes nothing an existing client sees.
 */
export function usableFanSummaryPredicate(mode: "full" | "short"): SQL {
  return sql`(${sql.join([
    eq(aiGenerationContent.feature, "fan-summary"),
    sql`${aiGenerationContent.params} ->> 'summaryMode' = ${mode}`,
    sql`${aiGenerationContent.params} ->> 'outcome' = 'completed'`,
    sql`${aiGenerationContent.params} ->> 'stopReason' is not null`,
    sql`${aiGenerationContent.params} ->> 'stopReason' not in ('max_tokens', 'length')`,
    // Defense in depth for rows written before terminal empty-output
    // rejection: whitespace-only recaps are not usable status/attach slots.
    sql`btrim(${aiGenerationContent.completion}, ${ECMASCRIPT_TRIM_CHARACTERS}) <> ''`,
    sql`${aiGenerationContent.params} ->> 'contextScope' is null`,
  ], sql` and `)})`;
}

/** One slot of the two-slot selection: the usable recaps of one mode for one
 * conversation, plus the caller's persona definition when it supplies one
 * (legacy rows without one are then excluded by design). Newest first. Served
 * by ai_generation_content_page_conversation_idx (pageId, conversationRef). */
function recapSlotWhere(input: FreshestRecapsInput, mode: "full" | "short") {
  return and(
    eq(aiGenerationContent.pageId, input.pageId),
    inArray(aiGenerationContent.conversationRef, input.conversationRefs),
    usableFanSummaryPredicate(mode),
    ...(input.personaDefinitionId
      ? [sql`${aiGenerationContent.params} ->> 'personaDefinitionId' = ${input.personaDefinitionId}`]
      : []),
  );
}

const recapSlotOrder = [desc(aiGenerationContent.createdAt), desc(aiGenerationContent.id)] as const;

/** Two-slot recap selection (spec §5): newest usable full + newest usable
 * short for one conversation (usableFanSummaryPredicate). */
export async function getFreshestUsableRecaps(
  db: Database,
  input: FreshestRecapsInput,
): Promise<FreshestRecaps> {
  const pick = async (mode: "full" | "short") => {
    const rows = await db
      .select()
      .from(aiGenerationContent)
      .where(recapSlotWhere(input, mode))
      .orderBy(...recapSlotOrder)
      .limit(1);
    return rows[0] ?? null;
  };
  const [full, short] = await Promise.all([pick("full"), pick("short")]);
  return { full, short };
}

/**
 * What a chatter of the page may read of one shared recap: its text and where
 * it came from. No prompt block, no user, no context manifest. The four
 * provenance values are JSON as the gateway stored it in `params` (any type,
 * null when absent); the caller shapes them for the wire.
 */
export interface UsableRecapBody {
  generationRef: string;
  createdAt: Date;
  completion: string;
  personaDefinitionId: unknown;
  transcriptCoverage: unknown;
  requestedCount: unknown;
  keptCount: unknown;
}

export interface FreshestRecapBodies {
  full: UsableRecapBody | null;
  short: UsableRecapBody | null;
}

/**
 * The same two slots as getFreshestUsableRecaps (same rows, same order), read
 * for the shared recaps route (chat-extension H-13): the one read of this
 * restricted class that is not the owner's. It names its columns, so
 * `prompt_blocks` and the rest of `params` never leave the database for it.
 */
export async function getFreshestUsableRecapBodies(
  db: Database,
  input: FreshestRecapsInput,
): Promise<FreshestRecapBodies> {
  const pick = async (mode: "full" | "short") => {
    const rows = await db
      .select({
        generationRef: aiGenerationContent.generationRef,
        createdAt: aiGenerationContent.createdAt,
        completion: aiGenerationContent.completion,
        personaDefinitionId: sql<unknown>`${aiGenerationContent.params} -> 'personaDefinitionId'`,
        transcriptCoverage: sql<unknown>`${aiGenerationContent.params} -> 'transcriptCoverage'`,
        requestedCount: sql<unknown>`${aiGenerationContent.params} -> 'requestedCount'`,
        keptCount: sql<unknown>`${aiGenerationContent.params} -> 'keptCount'`,
      })
      .from(aiGenerationContent)
      .where(recapSlotWhere(input, mode))
      .orderBy(...recapSlotOrder)
      .limit(1);
    return rows[0] ?? null;
  };
  const [full, short] = await Promise.all([pick("full"), pick("short")]);
  return { full, short };
}

/** Daily volume guard (DP 6 owner note: monitor, trim later if ever). */
export async function getAiGenerationContentVolume(db: Database) {
  const result = await db.execute<{ rows: string; bytes: string }>(sql`
    select count(*)::text as rows,
           pg_total_relation_size('ai_generation_content')::text as bytes
    from ai_generation_content
  `);
  const row = result.rows[0];
  return {
    rowCount: Number(row?.rows ?? 0),
    totalBytes: Number(row?.bytes ?? 0),
  };
}
