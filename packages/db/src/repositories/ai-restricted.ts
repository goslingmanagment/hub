import { and, desc, eq, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { aiAcceptanceEvents, aiGenerationContent } from "../schema.ts";

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
