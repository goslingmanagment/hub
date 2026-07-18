import { eq, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { pageVoiceProfiles, type VoiceProfileSettings } from "../schema.ts";

export type VoiceProfileRow = typeof pageVoiceProfiles.$inferSelect;

export interface UpsertVoiceProfileInput {
  platformAccountId: number;
  voiceId: string;
  model: string;
  settings: VoiceProfileSettings;
  outputFormat: string;
}

/**
 * Upserts the page's voice binding. `version` starts at 1 and bumps on every
 * subsequent upsert so a render job can pin the exact profile it rendered
 * against. Returns the resulting version.
 */
export async function upsertVoiceProfile(
  db: Database,
  input: UpsertVoiceProfileInput,
): Promise<{ version: number }> {
  const [row] = await db
    .insert(pageVoiceProfiles)
    .values({
      platformAccountId: input.platformAccountId,
      voiceId: input.voiceId,
      model: input.model,
      settings: input.settings,
      outputFormat: input.outputFormat,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: pageVoiceProfiles.platformAccountId,
      set: {
        voiceId: input.voiceId,
        model: input.model,
        settings: input.settings,
        outputFormat: input.outputFormat,
        version: sql`${pageVoiceProfiles.version} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning({ version: pageVoiceProfiles.version });

  if (!row) {
    // An upsert with RETURNING always yields exactly one row; this guard is
    // defensive and narrows the destructured value for the type checker.
    throw new Error("upsertVoiceProfile: no row returned from upsert");
  }
  return { version: row.version };
}

export async function getVoiceProfile(
  db: Database,
  platformAccountId: number,
): Promise<VoiceProfileRow | null> {
  const row = await db.query.pageVoiceProfiles.findFirst({
    where: eq(pageVoiceProfiles.platformAccountId, platformAccountId),
  });
  return row ?? null;
}

export async function clearVoiceProfile(
  db: Database,
  platformAccountId: number,
): Promise<void> {
  await db
    .delete(pageVoiceProfiles)
    .where(eq(pageVoiceProfiles.platformAccountId, platformAccountId));
}
