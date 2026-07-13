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
   * Omitted is the pre-version compatibility form: it may create an absent row
   * or confirm identical active content, but divergent content conflicts.
   * `null` is create-only (including against archived tombstones); a number
   * updates exactly that active revision.
   */
  expectedVersion?: number | null;
}

export const AI_PERSONA_BUNDLED_VERSION_KEY = "__kernelBundledVersion";

export type SeedBundledAiPersonaAction = "created" | "adopted" | "preserved" | "upgraded";

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

  // Pre-version clients omit expectedVersion and automatically replay every
  // cached persona whenever they reconnect. They may still create an absent
  // key, and an identical replay is idempotent, but a divergent active payload
  // must not overwrite a newer CAS writer.
  const [created] = await db.insert(aiPersonas).values(values)
    .onConflictDoNothing({ target: aiPersonas.key })
    .returning();
  if (created !== undefined) {
    return created;
  }
  const current = await readPersonaLifecycle(db, input.key);
  if (
    current !== null
    && current.archivedAt === null
    && current.displayName === input.displayName
    && current.systemBlock === input.systemBlock
  ) {
    return current;
  }
  throw new AiPersonaVersionConflictError(
    input.key,
    null,
    current?.revision ?? null,
  );
}

/**
 * Idempotent bundled-persona seed with the legacy customization contract:
 * user edits survive every rerun of the same bundled version, while an actual
 * bundled-version increase replaces the stale built-in once. Missing metadata
 * is adopted without changing prompt content or its lifecycle revision, which
 * makes the first run safe for already-customized production rows.
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

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const [created] = await db.insert(aiPersonas).values({
      key: input.key,
      displayName: input.displayName,
      systemBlock: input.systemBlock,
      featureOverrides: { [AI_PERSONA_BUNDLED_VERSION_KEY]: input.bundledVersion },
    }).onConflictDoNothing({ target: aiPersonas.key }).returning();
    if (created !== undefined) {
      return { persona: created, action: "created" };
    }

    const current = await readPersonaLifecycle(db, input.key);
    if (current === null) {
      continue;
    }
    if (current.archivedAt !== null) {
      throw new Error(`Bundled persona "${input.key}" is archived; refusing to resurrect it`);
    }

    const rawVersion = current.featureOverrides[AI_PERSONA_BUNDLED_VERSION_KEY];
    if (rawVersion === undefined) {
      const [adopted] = await db.update(aiPersonas).set({
        featureOverrides: {
          ...current.featureOverrides,
          [AI_PERSONA_BUNDLED_VERSION_KEY]: input.bundledVersion,
        },
      }).where(and(
        eq(aiPersonas.key, input.key),
        isNull(aiPersonas.archivedAt),
        eq(aiPersonas.revision, current.revision),
      )).returning();
      if (adopted !== undefined) {
        return { persona: adopted, action: "adopted" };
      }
      continue;
    }
    if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion <= 0) {
      throw new Error(`Bundled persona "${input.key}" has invalid version metadata`);
    }
    if (rawVersion > input.bundledVersion) {
      throw new Error(
        `Bundled persona "${input.key}" is version ${rawVersion}; refusing binary downgrade to ${input.bundledVersion}`,
      );
    }
    if (rawVersion === input.bundledVersion) {
      return { persona: current, action: "preserved" };
    }

    const [upgraded] = await db.update(aiPersonas).set({
      displayName: input.displayName,
      systemBlock: input.systemBlock,
      featureOverrides: {
        ...current.featureOverrides,
        [AI_PERSONA_BUNDLED_VERSION_KEY]: input.bundledVersion,
      },
      updatedAt: new Date(),
      revision: sql`${aiPersonas.revision} + 1`,
    }).where(and(
      eq(aiPersonas.key, input.key),
      isNull(aiPersonas.archivedAt),
      eq(aiPersonas.revision, current.revision),
    )).returning();
    if (upgraded !== undefined) {
      return { persona: upgraded, action: "upgraded" };
    }
  }

  throw new Error(`Bundled persona "${input.key}" changed concurrently; retry the seed command`);
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

/** Full lifecycle state for migration/reconciliation. Archived prompt content
 * stays in the DB but the API state projection intentionally omits it. */
export async function listAiPersonaStates(db: Database) {
  return db.select().from(aiPersonas).orderBy(aiPersonas.key);
}

export async function archiveAiPersona(
  db: Database,
  key: string,
  expectedVersion?: number | null,
) {
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
      .returning({ key: aiPersonas.key, revision: aiPersonas.revision });
    if (updated !== undefined) {
      return updated;
    }
  }

  const current = await readPersonaLifecycle(db, key);
  if (current === null) {
    return null;
  }
  if (current.archivedAt !== null) {
    // A lost success response or a concurrent archive is already converged.
    return { key: current.key, revision: current.revision };
  }
  throw new AiPersonaVersionConflictError(
    key,
    expectedVersion ?? null,
    current.revision,
  );
}
