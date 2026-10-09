import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { aiPersonas } from "../schema.ts";

// Stage 30: personas as kernel config records (DP 9-A — global,
// single-tenant). Seeding is idempotent by key; archiving soft-retires.

export interface UpsertAiPersonaInput {
  key: string;
  displayName: string;
  systemBlock: string;
  featureOverrides?: Record<string, unknown>;
  /**
   * Omitted is the historical last-write-wins form: identical active content
   * is a no-op; divergent content and archived rows use last-write-wins. No
   * HTTP route reaches it any more (the legacy bearer write lane is retired);
   * the owner admin lane always sends a token. `null` is create-only
   * (including against archived tombstones); a number updates exactly that
   * active revision.
   */
  expectedVersion?: number | null;
}

export const AI_PERSONA_BUNDLED_VERSION_KEY = "__kernelBundledVersion";

export type SeedBundledAiPersonaAction = "created" | "preserved";

export class AiPersonaVersionConflictError extends Error {
  constructor(
    readonly key: string,
    readonly expectedVersion: number | null,
    readonly actualVersion: number | null,
  ) {
    super(
      `AI persona version conflict for "${key}": expected ${expectedVersion ?? "absent"}, found ${actualVersion ?? "absent"}`,
    );
    this.name = "AiPersonaVersionConflictError";
  }
}

async function readPersonaLifecycle(db: Database, key: string) {
  const row = await db.query.aiPersonas.findFirst({
    where: eq(aiPersonas.key, key),
  });
  return row ?? null;
}

async function readPersonaVersion(db: Database, key: string): Promise<number | null> {
  return (await readPersonaLifecycle(db, key))?.revision ?? null;
}

export async function upsertAiPersona(db: Database, input: UpsertAiPersonaInput) {
  const values = {
    key: input.key,
    displayName: input.displayName,
    systemBlock: input.systemBlock,
    featureOverrides: input.featureOverrides ?? {},
  };

  if (input.expectedVersion === null) {
    const [created] = await db.insert(aiPersonas).values(values)
      .onConflictDoNothing({ target: aiPersonas.key })
      .returning();
    if (created !== undefined) {
      return created;
    }
    throw new AiPersonaVersionConflictError(
      input.key,
      null,
      await readPersonaVersion(db, input.key),
    );
  }

  if (input.expectedVersion !== undefined) {
    const [updated] = await db.update(aiPersonas).set({
      displayName: input.displayName,
      systemBlock: input.systemBlock,
      // API persona edits do not own kernel seed metadata. Preserve existing
      // overrides unless an internal caller explicitly supplies a replacement.
      ...(input.featureOverrides !== undefined
        ? { featureOverrides: input.featureOverrides }
        : {}),
      updatedAt: new Date(),
      revision: sql`${aiPersonas.revision} + 1`,
    }).where(and(
      eq(aiPersonas.key, input.key),
      isNull(aiPersonas.archivedAt),
      eq(aiPersonas.revision, input.expectedVersion),
    )).returning();
    if (updated !== undefined) {
      return updated;
    }
    throw new AiPersonaVersionConflictError(
      input.key,
      input.expectedVersion,
      await readPersonaVersion(db, input.key),
    );
  }

  // Historical last-write-wins form, including resurrection of an archived
  // key. It served the retired legacy bearer write lane; no HTTP route reaches
  // it now. Owner dashboard writes never use this form; they send CAS tokens.
  const [legacyRow] = await db.insert(aiPersonas).values(values)
    .onConflictDoUpdate({
      target: aiPersonas.key,
      set: {
        displayName: input.displayName,
        systemBlock: input.systemBlock,
        ...(input.featureOverrides !== undefined
          ? { featureOverrides: input.featureOverrides }
          : {}),
        updatedAt: new Date(),
        archivedAt: null,
        revision: sql`${aiPersonas.revision} + 1`,
      },
      setWhere: sql`${aiPersonas.displayName} is distinct from ${input.displayName}
        or ${aiPersonas.systemBlock} is distinct from ${input.systemBlock}
        or ${aiPersonas.archivedAt} is not null`,
    })
    .returning();
  if (legacyRow !== undefined) {
    return legacyRow;
  }
  const identical = await readPersonaLifecycle(db, input.key);
  if (identical === null) {
    throw new Error(`AI persona "${input.key}" disappeared during legacy replay`);
  }
  return identical;
}

/**
 * Create-only bundled-persona seed. The database is owner content: once a key
 * exists, neither a rerun nor a newer binary may change its prompt, metadata,
 * lifecycle state, timestamps, or revision. Owner edits therefore survive
 * every deploy and an archived built-in is never resurrected by seeding.
 */
export async function seedBundledAiPersona(
  db: Database,
  input: {
    key: string;
    displayName: string;
    systemBlock: string;
    bundledVersion: number;
  },
): Promise<{ persona: typeof aiPersonas.$inferSelect; action: SeedBundledAiPersonaAction }> {
  if (!Number.isInteger(input.bundledVersion) || input.bundledVersion <= 0) {
    throw new Error(`Invalid bundled persona version: ${input.bundledVersion}`);
  }

  const [created] = await db.insert(aiPersonas).values({
    key: input.key,
    displayName: input.displayName,
    systemBlock: input.systemBlock,
    featureOverrides: { [AI_PERSONA_BUNDLED_VERSION_KEY]: input.bundledVersion },
  }).onConflictDoNothing({ target: aiPersonas.key }).returning();
  if (created !== undefined) {
    return { persona: created, action: "created" };
  }

  const existing = await readPersonaLifecycle(db, input.key);
  if (existing === null) {
    // A concurrent transaction deleted the key between INSERT and SELECT.
    // There is no supported production delete path; fail closed if one appears.
    throw new Error(`Bundled persona "${input.key}" disappeared during seed`);
  }
  return { persona: existing, action: "preserved" };
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

/** Full lifecycle state for the metadata catalog and owner administration. */
export async function listAiPersonaStates(db: Database) {
  return db.select().from(aiPersonas).orderBy(aiPersonas.key);
}

export async function archiveAiPersona(
  db: Database,
  key: string,
  expectedVersion?: number | null,
) {
  if (expectedVersion === undefined) {
    // Historical last-write-wins archive of the retired legacy bearer lane; no
    // HTTP route reaches it now (the admin lane always sends a revision).
    const [archived] = await db.update(aiPersonas)
      .set({
        archivedAt: new Date(),
        updatedAt: new Date(),
        revision: sql`${aiPersonas.revision} + 1`,
      })
      .where(and(eq(aiPersonas.key, key), isNull(aiPersonas.archivedAt)))
      .returning();
    return archived ?? null;
  }

  if (expectedVersion !== undefined && expectedVersion !== null) {
    const [updated] = await db.update(aiPersonas)
      .set({
        archivedAt: new Date(),
        updatedAt: new Date(),
        revision: sql`${aiPersonas.revision} + 1`,
      })
      .where(and(
        eq(aiPersonas.key, key),
        isNull(aiPersonas.archivedAt),
        eq(aiPersonas.revision, expectedVersion),
      ))
      .returning();
    if (updated !== undefined) {
      return updated;
    }
  }

  const current = await readPersonaLifecycle(db, key);
  if (current === null) {
    return null;
  }
  throw new AiPersonaVersionConflictError(
    key,
    expectedVersion ?? null,
    current.revision,
  );
}
