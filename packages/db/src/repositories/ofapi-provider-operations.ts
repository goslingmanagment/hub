import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";

export class OfapiProviderOperationRefused extends Error {
  constructor(readonly reason: "replay_unavailable" | "media_token_already_used") { super(reason); }
}
type OperationRow = { operation_id: string; provider_key: string; team_slug: string; account_id: string; endpoint: string; body_hash: string; first_attempt_at: Date | string };
/** A manual recovery may retain the provider identity, but can never extend its first-attempt TTL. */
export async function reserveOfapiProviderOperation(db: Database, input: {
  commandId: string; parentCommandId: string | null; reuse: boolean; teamSlug: string; accountId: string;
  endpoint: string; bodyHash: string; tokens: string[]; now?: Date;
}) {
  const now = input.now ?? new Date();
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.commandId}, 6162))`);
    const existing = await tx.execute<OperationRow>(sql`select * from ofapi_command_provider_operations where command_id = ${input.commandId}`);
    // A dispatch identity is reserved once. A restarted executor must never turn this into an automatic resend.
    if (existing.rows[0]) throw new OfapiProviderOperationRefused("replay_unavailable");
    let operationId: string = randomUUID(); let providerKey: string = randomUUID(); let firstAttemptAt = now;
    if (input.reuse) {
      const source = await tx.execute<OperationRow>(sql`select * from ofapi_command_provider_operations where command_id = ${input.parentCommandId} for share`);
      const parent = source.rows[0];
      if (!parent || parent.team_slug !== input.teamSlug || parent.account_id !== input.accountId || parent.endpoint !== input.endpoint
        || parent.body_hash !== input.bodyHash || now.getTime() < new Date(parent.first_attempt_at).getTime()
        || now.getTime() - new Date(parent.first_attempt_at).getTime() >= 24 * 60 * 60 * 1000) throw new OfapiProviderOperationRefused("replay_unavailable");
      operationId = parent.operation_id; providerKey = parent.provider_key; firstAttemptAt = new Date(parent.first_attempt_at);
    }
    for (const token of [...new Set(input.tokens)].sort()) {
      await tx.execute(sql`insert into ofapi_media_token_custody(account_id,token,operation_id,command_id)
        values (${input.accountId},${token},${operationId},${input.commandId}) on conflict do nothing`);
      const held = await tx.execute<{ operation_id: string }>(sql`select operation_id from ofapi_media_token_custody where account_id=${input.accountId} and token=${token} for update`);
      if (held.rows[0]?.operation_id !== operationId) throw new OfapiProviderOperationRefused("media_token_already_used");
    }
    await tx.execute(sql`insert into ofapi_command_provider_operations
      (command_id,operation_id,provider_key,team_slug,account_id,endpoint,body_hash,first_attempt_at)
      values (${input.commandId},${operationId},${providerKey},${input.teamSlug},${input.accountId},${input.endpoint},${input.bodyHash},${firstAttemptAt})`);
    return { operationId, providerKey, firstAttemptAt: firstAttemptAt.toISOString() };
  });
}
