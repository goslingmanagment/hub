import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";

export class OfapiProviderOperationRefused extends Error {
  constructor(readonly reason: "replay_unavailable" | "media_token_already_used") { super(reason); }
}

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

/** Owner actions share the same custody row shape; the caller keeps its own
 * post-claim ownership check. Runs inside the caller's transaction. */
export async function claimOfapiActionMediaCustody(db: Database, input: {
  accountId: string; token: string; operationId: string; actionIntentId: string;
}): Promise<void> {
  await db.execute(custodyClaimSql({ ...input, commandId: null }));
}

