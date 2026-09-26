// H3: batched serve-time context for v2 domain frames — which source
// observations were provider webhook REDELIVERIES, and the fan labels of DM
// threads named by money facts. One statement per replay batch, never one per
// frame; both are reads of rows the ledger already references.

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

/**
 * Of `observationIds`, the ones journaled from an OFAPI webhook receipt whose
 * capture headers carry the provider's `x-ofapi-redelivery-of` (stored as
 * `redeliveryOf` at receipt). The accepted receipt and its observation share
 * the provider idempotency key; a redelivery reuses the original key, so this
 * is the first and only local receipt of that business fact.
 */
export async function listRedeliveredWebhookObservationIds(
  db: Database,
  observationIds: readonly number[],
): Promise<Set<number>> {
  const ids = [...new Set(observationIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length === 0) {
    return new Set();
  }
  const result = await db.execute<{ observation_id: string }>(sql`
    select o.id::text as observation_id
    from observations o
    join ofapi_webhook_events receipt on receipt.idempotency_key = o.idempotency_key
    where o.id = any(${sql.param(ids)}::bigint[])
      and o.source = 'webhook'
      and o.producer = 'ofapi:webhook'
      and receipt.capture_headers ->> 'redeliveryOf' is not null
  `);
  return new Set(result.rows.map((row) => Number(row.observation_id)));
}

export interface DmThreadLabel {
  fanName: string | null;
  username: string | null;
}

export function dmThreadLabelKey(accountId: number, conversationRef: string): string {
  return `${accountId}:${conversationRef}`;
}

/**
 * Fan labels of the DM threads `(accountId, conversationRef)` names, keyed by
 * dmThreadLabelKey. Pairs without a thread row are absent. Probes the
 * (platform_account_id, platform_conversation_id) unique index once per pair.
 */
export async function listDmThreadLabels(
  db: Database,
  keys: ReadonlyArray<{ accountId: number; conversationRef: string }>,
): Promise<Map<string, DmThreadLabel>> {
  const unique = new Map<string, { accountId: number; conversationRef: string }>();
  for (const key of keys) {
    unique.set(dmThreadLabelKey(key.accountId, key.conversationRef), key);
  }
  if (unique.size === 0) {
    return new Map();
  }
  const pairs = [...unique.values()];
  const result = await db.execute<{
    account_id: string;
    conversation_ref: string;
    fan_name: string | null;
    username: string | null;
  }>(sql`
    select t.platform_account_id::text as account_id,
           t.platform_conversation_id as conversation_ref,
           t.partner_display_name as fan_name,
           t.partner_username as username
    from unnest(
      ${sql.param(pairs.map((pair) => pair.accountId))}::bigint[],
      ${sql.param(pairs.map((pair) => pair.conversationRef))}::text[]
    ) as requested(account_id, conversation_ref)
    join page_dm_threads t
      on t.platform_account_id = requested.account_id
     and t.platform_conversation_id = requested.conversation_ref
  `);
  return new Map(result.rows.map((row) => [
    dmThreadLabelKey(Number(row.account_id), row.conversation_ref),
    { fanName: row.fan_name ?? null, username: row.username ?? null },
  ]));
}
