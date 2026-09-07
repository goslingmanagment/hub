import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";
export type OfapiBannedWord = { word: string; riskLevel: string; category: string | null; alternatives: string | null };
export type OfapiBannedDictionary = { version: string; observedAt: string; complete: boolean; pages: number; entries: OfapiBannedWord[] };
export async function getOfapiBannedDictionary(db: Database): Promise<OfapiBannedDictionary | null> {
  const result = await db.execute<{ version_hash: string; entries: OfapiBannedWord[]; observed_at: Date; complete: boolean; pages: number }>(sql`select version_hash,entries,observed_at,complete,pages from ofapi_banned_word_dictionaries order by observed_at desc,id desc limit 1`);
  const row = result.rows[0];
  return row ? { version: row.version_hash, entries: row.entries, observedAt: new Date(row.observed_at).toISOString(), complete: row.complete, pages: row.pages } : null;
}
export async function saveOfapiBannedDictionary(db: Database, input: OfapiBannedDictionary & { observationId: number; observationIds: number[] }) {
  await db.execute(sql`insert into ofapi_banned_word_dictionaries(version_hash,observation_id,entries,observed_at,complete,pages,observation_ids)
    values (${input.version},${input.observationId},${JSON.stringify(input.entries)}::jsonb,${new Date(input.observedAt)},${input.complete},${input.pages},${JSON.stringify(input.observationIds)}::jsonb)`);
}
