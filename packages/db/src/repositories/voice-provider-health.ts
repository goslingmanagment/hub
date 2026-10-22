import { eq } from "drizzle-orm";

import type { Database } from "../client.ts";
import { voiceProviderHealthState, type VoiceProviderHealthStateName } from "../schema.ts";

// The latest answer of the ElevenLabs account check (0296), one row, for the
// owner's dashboard. Written by the worker's check, read by the admin API.

export type VoiceProviderHealthRow = typeof voiceProviderHealthState.$inferSelect;

/** One successful reading of the account's subscription. */
export interface VoiceProviderHealthReading {
  tier: string | null;
  subscriptionStatus: string;
  characterCount: number;
  characterLimit: number;
  nextResetAt: Date | null;
  /** The low-characters line the check judged this reading by. */
  lowThresholdChars: number;
}

/**
 * Record one check. With a reading the row takes it whole (`read_at` = the
 * check's time). Without one — a refused or failed check — only the state,
 * the time and the HTTP status move: the last reading stays, so the owner
 * still sees what the account had when it was last read.
 */
export async function recordVoiceProviderHealthCheck(
  db: Database,
  input: {
    state: VoiceProviderHealthStateName;
    checkedAt: Date;
    httpStatus: number | null;
    reading: VoiceProviderHealthReading | null;
  },
): Promise<void> {
  const check = {
    state: input.state,
    checkedAt: input.checkedAt,
    httpStatus: input.httpStatus,
    updatedAt: input.checkedAt,
  };
  const reading = input.reading
    ? {
      readAt: input.checkedAt,
      tier: input.reading.tier,
      subscriptionStatus: input.reading.subscriptionStatus,
      characterCount: input.reading.characterCount,
      characterLimit: input.reading.characterLimit,
      nextResetAt: input.reading.nextResetAt,
      lowThresholdChars: input.reading.lowThresholdChars,
    }
    : {};
  await db.insert(voiceProviderHealthState)
    .values({ id: 1, ...check, ...reading })
    .onConflictDoUpdate({
      target: voiceProviderHealthState.id,
      set: { ...check, ...reading },
    });
}

export async function getVoiceProviderHealthState(db: Database): Promise<VoiceProviderHealthRow | null> {
  const [row] = await db.select()
    .from(voiceProviderHealthState)
    .where(eq(voiceProviderHealthState.id, 1))
    .limit(1);
  return row ?? null;
}
