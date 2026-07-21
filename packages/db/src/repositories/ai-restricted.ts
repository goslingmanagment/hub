import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { aiAcceptanceEvents, aiGenerationContent } from "../schema.ts";
import { ECMASCRIPT_TRIM_CHARACTERS } from "./ai-completion.ts";

// Stage 29 restricted capture class (DP 6-A). Writes happen at gateway
// finalize and via the acceptance canonicalizer; reads are owner-only at
// the route layer — nothing here widens access.

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

/** Two-slot recap selection (spec §5): newest usable full + newest usable
 * short for one conversation. Usable = completed outcome, non-empty
 * completion, a PRESENT and non-exhausted stopReason, and modern params
 * (`summaryMode` plus a matching persona definition when the caller supplies
 * one — legacy rows are excluded from attach by design). A
 * modern row with a NULL stopReason is fail-closed unusable (P1-5b): a
 * truncated generation that never recorded its terminal reason must never be
 * attached as a recap. The exhausted stop-reason literals mirror the shared
 * `isOutputExhausted` predicate (packages/shared/src/ai-stop-reason.ts):
 * Anthropic 'max_tokens', OpenRouter 'length'. Served by the existing
 * ai_generation_content_page_conversation_idx (pageId, conversationRef). */
export async function getFreshestUsableRecaps(
  db: Database,
  input: FreshestRecapsInput,
): Promise<FreshestRecaps> {
  const pick = async (mode: "full" | "short") => {
    const rows = await db
      .select()
      .from(aiGenerationContent)
      .where(and(
        eq(aiGenerationContent.pageId, input.pageId),
        inArray(aiGenerationContent.conversationRef, input.conversationRefs),
        eq(aiGenerationContent.feature, "fan-summary"),
        sql`${aiGenerationContent.params} ->> 'summaryMode' = ${mode}`,
        ...(input.personaDefinitionId
          ? [sql`${aiGenerationContent.params} ->> 'personaDefinitionId' = ${input.personaDefinitionId}`]
          : []),
        sql`${aiGenerationContent.params} ->> 'outcome' = 'completed'`,
        sql`${aiGenerationContent.params} ->> 'stopReason' is not null`,
        sql`${aiGenerationContent.params} ->> 'stopReason' not in ('max_tokens', 'length')`,
        // Defense in depth for rows written before terminal empty-output
        // rejection: whitespace-only recaps are not usable status/attach slots.
        sql`btrim(${aiGenerationContent.completion}, ${ECMASCRIPT_TRIM_CHARACTERS}) <> ''`,
      ))
      .orderBy(desc(aiGenerationContent.createdAt), desc(aiGenerationContent.id))
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
