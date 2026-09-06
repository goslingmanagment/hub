import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";

/** Account IDs and CDN capabilities contain no newline; SQL migration uses the same bytes. */
export function ofapiMediaTokenHash(accountId: string, token: string): string {
  return createHash("sha256").update(`${accountId}\n${token}`).digest("hex");
}

/** Must run inside the caller's transaction. A false result must roll back the
 * complete multi-token claim. Only a previously authorized operation may reuse
 * its own reservation; this function grants no retry or provider replay authority. */
export async function claimOfapiMediaTokenFence(db: Database, input: {
  accountId: string; token: string; operationId: string;
}): Promise<boolean> {
  const hash = ofapiMediaTokenHash(input.accountId, input.token);
  await db.execute(sql`insert into ofapi_media_token_fences(token_hash,operation_id)
    values(${hash},${input.operationId}::uuid) on conflict do nothing`);
  const held = (await db.execute<{ operation_id: string }>(sql`
    select operation_id from ofapi_media_token_fences where token_hash=${hash} for update
  `)).rows[0];
  return held?.operation_id === input.operationId;
}

/** Read-only availability check; physical execution still claims atomically. */
export async function isOfapiMediaTokenReserved(db: Database, accountId: string, token: string): Promise<boolean> {
  const result = await db.execute(sql`select 1 from ofapi_media_token_fences
    where token_hash=${ofapiMediaTokenHash(accountId, token)}`);
  return result.rows.length > 0;
}
