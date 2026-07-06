import { desc, eq } from "drizzle-orm";

import type { Database } from "../client.ts";
import { erasureLog } from "../schema.ts";

export interface InsertErasureLogInput {
  scopeType: "page" | "model" | "fan";
  scopeRef: string;
  initiatedBy: number;
  dryRun: boolean;
  plan: Record<string, unknown>;
}

export async function insertErasureLog(db: Database, input: InsertErasureLogInput) {
  const [created] = await db.insert(erasureLog).values({
    scopeType: input.scopeType,
    scopeRef: input.scopeRef,
    initiatedBy: input.initiatedBy,
    dryRun: input.dryRun,
    plan: input.plan,
  }).returning();
  return created!;
}

export async function completeErasureLog(
  db: Database,
  input: { id: number; executedCounts?: Record<string, unknown> },
) {
  const [updated] = await db.update(erasureLog).set({
    executedCounts: input.executedCounts ?? null,
    completedAt: new Date(),
  }).where(eq(erasureLog.id, input.id)).returning();
  return updated ?? null;
}

export async function listErasureLog(db: Database, input?: { limit?: number }) {
  return db.select().from(erasureLog)
    .orderBy(desc(erasureLog.startedAt))
    .limit(input?.limit ?? 50);
}
