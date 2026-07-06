import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "../client.ts";
import { aiPersonas } from "../schema.ts";

// Stage 30: personas as kernel config records (DP 9-A — global,
// single-tenant). Seeding is idempotent by key; archiving soft-retires.

export interface UpsertAiPersonaInput {
  key: string;
  displayName: string;
  systemBlock: string;
  featureOverrides?: Record<string, unknown>;
}

export async function upsertAiPersona(db: Database, input: UpsertAiPersonaInput) {
  const [row] = await db.insert(aiPersonas).values({
    key: input.key,
    displayName: input.displayName,
    systemBlock: input.systemBlock,
    featureOverrides: input.featureOverrides ?? {},
  }).onConflictDoUpdate({
    target: aiPersonas.key,
    set: {
      displayName: input.displayName,
      systemBlock: input.systemBlock,
      featureOverrides: input.featureOverrides ?? {},
      updatedAt: new Date(),
      archivedAt: null,
    },
  }).returning();
  return row!;
}

export async function findAiPersonaByKey(db: Database, key: string) {
  return db.query.aiPersonas.findFirst({
    where: and(eq(aiPersonas.key, key), isNull(aiPersonas.archivedAt)),
  });
}

export async function listAiPersonas(db: Database) {
  return db.select().from(aiPersonas)
    .where(isNull(aiPersonas.archivedAt))
    .orderBy(aiPersonas.key);
}
