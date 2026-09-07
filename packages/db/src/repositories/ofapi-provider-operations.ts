import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";
import { claimOfapiMediaTokenFence, ofapiMediaTokenHash } from "./ofapi-media-token-fences.ts";

export class OfapiProviderOperationRefused extends Error {
  constructor(readonly reason: "replay_unavailable" | "media_token_already_used") { super(reason); }
}
type OperationRow = { operation_id: string; provider_key: string; team_slug: string; account_id: string; endpoint: string; body_hash: string; first_attempt_at: Date | string };
/** A released custody row (0170) is re-armed in place for the new holder; a live
 * row is left alone so the caller's row-lock check refuses it. */
function custodyClaimSql(input: { accountId: string; token: string; operationId: string; commandId: string | null; actionIntentId: string | null }) {
  return sql`insert into ofapi_media_token_custody(account_id,token,operation_id,command_id,action_intent_id)
    values (${input.accountId},${input.token},${input.operationId}::uuid,${input.commandId}::uuid,${input.actionIntentId}::uuid)
    on conflict (account_id,token) do update
      set operation_id=excluded.operation_id, command_id=excluded.command_id, action_intent_id=excluded.action_intent_id,
          released_at=null, released_reason=null, created_at=clock_timestamp()
      where ofapi_media_token_custody.released_at is not null`;
}

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
      if (!await claimOfapiMediaTokenFence(tx as unknown as Database, { accountId: input.accountId, token, operationId })) {
        throw new OfapiProviderOperationRefused("media_token_already_used");
      }
      await tx.execute(custodyClaimSql({ accountId: input.accountId, token, operationId, commandId: input.commandId, actionIntentId: null }));
      const held = await tx.execute<{ operation_id: string }>(sql`select operation_id from ofapi_media_token_custody where account_id=${input.accountId} and token=${token} for update`);
      if (held.rows[0]?.operation_id !== operationId) throw new OfapiProviderOperationRefused("media_token_already_used");
    }
    await tx.execute(sql`insert into ofapi_command_provider_operations
      (command_id,operation_id,provider_key,team_slug,account_id,endpoint,body_hash,first_attempt_at)
      values (${input.commandId},${operationId},${providerKey},${input.teamSlug},${input.accountId},${input.endpoint},${input.bodyHash},${firstAttemptAt})`);
    return { operationId, providerKey, firstAttemptAt: firstAttemptAt.toISOString() };
  });
}

/** Legacy media sends have no provider replay identity. Reserve only after the
 * command is claimed and its payload validated, before its sole physical send. */
export async function reserveOfapiLegacyMediaTokens(db: Database, input: {
  commandId: string; accountId: string; tokens: string[];
}): Promise<void> {
  if (!input.tokens.length) return;
  await db.transaction(async tx => {
    for (const token of [...new Set(input.tokens)].sort()) {
      if (!await claimOfapiMediaTokenFence(tx as unknown as Database, {
        accountId: input.accountId, token, operationId: input.commandId,
      })) throw new OfapiProviderOperationRefused("media_token_already_used");
      await tx.execute(custodyClaimSql({ accountId: input.accountId, token, operationId: input.commandId, commandId: input.commandId, actionIntentId: null }));
      const held = (await tx.execute<{ operation_id: string; command_id: string | null }>(sql`
        select operation_id,command_id from ofapi_media_token_custody
        where account_id=${input.accountId} and token=${token} for update
      `)).rows[0];
      if (held?.operation_id !== input.commandId || held.command_id !== input.commandId) {
        throw new OfapiProviderOperationRefused("media_token_already_used");
      }
    }
  });
}

/** Owner actions share the same custody row shape; the caller keeps its own
 * post-claim ownership check. Runs inside the caller's transaction. */
export async function claimOfapiActionMediaCustody(db: Database, input: {
  accountId: string; token: string; operationId: string; actionIntentId: string;
}): Promise<void> {
  await db.execute(custodyClaimSql({ ...input, commandId: null }));
}

/**
 * Release custody a command reserved for material the vendor DEFINITELY never
 * spent: a definite pre-delivery rejection, or a command that never dispatched.
 * Never called for indeterminate, 5xx, 429 or confirmed outcomes. Rows are
 * marked, never deleted. Only rows whose `command_id` is this command are
 * touched, so a reuse child (which inherits its parent's live reservation)
 * never frees material its parent's unknown attempt may have spent.
 * Lock order per token: fence, then custody — the order every claim takes.
 */
export async function releaseOfapiMediaTokenCustody(db: Database, input: {
  commandId: string; reason: string; now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();
  return db.transaction(async tx => {
    const held = (await tx.execute<{ account_id: string; token: string; operation_id: string }>(sql`
      select account_id, token, operation_id from ofapi_media_token_custody
      where command_id=${input.commandId}::uuid and released_at is null
    `)).rows;
    // JS code-unit order, exactly like every reservation's `[...tokens].sort()`,
    // so a multi-token release and a multi-token claim never lock in opposite orders.
    held.sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
    let released = 0;
    for (const row of held) {
      const hash = ofapiMediaTokenHash(row.account_id, row.token);
      const fence = (await tx.execute<{ operation_id: string; released_at: Date | null }>(sql`
        select operation_id, released_at from ofapi_media_token_fences where token_hash=${hash} for update
      `)).rows[0];
      // The fence is the authority; custody that disagrees with it stays held (fail closed).
      if (!fence || fence.released_at !== null || fence.operation_id !== row.operation_id) continue;
      const custody = await tx.execute<{ token: string }>(sql`
        update ofapi_media_token_custody set released_at=${now}, released_reason=${input.reason}
        where account_id=${row.account_id} and token=${row.token} and command_id=${input.commandId}::uuid
          and operation_id=${row.operation_id}::uuid and released_at is null
        returning token
      `);
      if (custody.rows.length !== 1) continue;
      await tx.execute(sql`update ofapi_media_token_fences set released_at=${now}, released_reason=${input.reason}
        where token_hash=${hash}`);
      released += 1;
    }
    return released;
  });
}
