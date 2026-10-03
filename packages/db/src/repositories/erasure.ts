import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { erasureLog } from "../schema.ts";

export interface InsertErasureLogInput {
  scopeType: "page" | "model" | "fan";
  scopeRef: string;
  initiatedBy: number;
  dryRun: boolean;
  plan: Record<string, unknown>;
  executionProtocol?: "global-erasure-lock-v1";
}

export const ERASURE_EXECUTION_PROTOCOL = "global-erasure-lock-v1" as const;

export async function insertErasureLog(db: Database, input: InsertErasureLogInput) {
  const [created] = await db.insert(erasureLog).values({
    scopeType: input.scopeType,
    scopeRef: input.scopeRef,
    initiatedBy: input.initiatedBy,
    dryRun: input.dryRun,
    plan: input.executionProtocol === undefined
      ? input.plan
      : { ...input.plan, executionProtocol: input.executionProtocol },
    executionProtocol: input.executionProtocol ?? null,
  }).returning();
  return created!;
}

export async function completeErasureLog(
  db: Database,
  input: { id: number; executedCounts?: Record<string, unknown> },
) {
  const completedAt = new Date();
  const [updated] = await db.update(erasureLog).set({
    executedCounts: input.executedCounts ?? null,
    completedAt,
    resolutionKind: "completed",
    resolvedAt: completedAt,
  }).where(eq(erasureLog.id, input.id)).returning();
  return updated ?? null;
}

/**
 * Completes one converged execution and resolves only older/unresolved attempts
 * for the exact same immutable target. The service holds the global advisory
 * lock across the full database + lake run; the protocol marker limits
 * automatic adoption to attempts that participated in that lock protocol.
 */
export async function completeErasureLogAndSupersedeScope(
  db: Database,
  input: {
    id: number;
    scopeType: "page" | "model" | "fan";
    scopeRef: string;
    resolvedPageIds: number[];
    executionProtocol: "global-erasure-lock-v1";
    executedCounts?: Record<string, unknown>;
  },
) {
  return db.transaction(async (tx) => {
    const resolvedAt = new Date();
    const [completed] = await tx.update(erasureLog).set({
      executedCounts: input.executedCounts ?? null,
      completedAt: resolvedAt,
      resolutionKind: "completed",
      resolvedAt,
    }).where(and(
      eq(erasureLog.id, input.id),
      eq(erasureLog.scopeType, input.scopeType),
      eq(erasureLog.scopeRef, input.scopeRef),
      eq(erasureLog.dryRun, false),
      eq(erasureLog.executionProtocol, input.executionProtocol),
      sql`${erasureLog.plan}->>'executionProtocol' = ${input.executionProtocol}`,
      isNull(erasureLog.resolutionKind),
    )).returning();
    if (!completed) {
      return null;
    }

    const resolvedPageIds = JSON.stringify(
      [...new Set(input.resolvedPageIds)].sort((left, right) => left - right),
    );
    const superseded = await tx.update(erasureLog).set({
      resolutionKind: "superseded",
      resolvedAt,
      supersededById: input.id,
    }).where(and(
      // Only attempts that existed before this converged retry may be adopted.
      // A newer row from a rolling old process remains unresolved/fail-closed.
      lt(erasureLog.id, input.id),
      eq(erasureLog.scopeType, input.scopeType),
      eq(erasureLog.scopeRef, input.scopeRef),
      eq(erasureLog.dryRun, false),
      // Protocol-null rows may belong to a still-running pre-cutover process
      // that never acquired the global lock. They require explicit operator
      // resolution and are never adopted automatically.
      eq(erasureLog.executionProtocol, input.executionProtocol),
      sql`${erasureLog.plan}->>'executionProtocol' = ${input.executionProtocol}`,
      isNull(erasureLog.resolutionKind),
      isNull(erasureLog.completedAt),
      // Mutable/reusable labels and slugs are selectors, not entity identity.
      // Adopt only attempts whose stored immutable page-id set is identical.
      sql`jsonb_typeof(${erasureLog.plan}->'resolvedPageIds') = 'array'
        and (${erasureLog.plan}->'resolvedPageIds') @> ${resolvedPageIds}::jsonb
        and (${erasureLog.plan}->'resolvedPageIds') <@ ${resolvedPageIds}::jsonb`,
    )).returning({ id: erasureLog.id });

    return {
      completed,
      supersededIds: superseded.map((row) => row.id),
    };
  });
}

export async function listErasureLog(db: Database, input?: { limit?: number }) {
  return db.select().from(erasureLog)
    .orderBy(desc(erasureLog.startedAt))
    .limit(input?.limit ?? 50);
}
