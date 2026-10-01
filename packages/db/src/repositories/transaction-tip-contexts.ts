import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { pages, syncRawPayloads } from "../schema.ts";
import {
  isDmArchiveScopeFenced,
  tryAcquireDmArchiveWriterFenceLock,
} from "./erasure-fence.ts";

export const FANSLY_DM_TIP_SIDECAR_PROVENANCE = "fansly_dm_tip_sidecar" as const;

/**
 * Where a materialized tip context came from: the legacy raw journal row
 * (`sync_raw_payloads`), or the observation the Fansly Sync Engine journaled
 * (0230; it writes no raw row). An observation is addressed by its id and its
 * `received_at` partition key together.
 */
export type TransactionTipContextLineage =
  | { kind: "raw"; sourceRawPayloadId: number }
  | { kind: "observation"; sourceObservationId: number; sourceObservationReceivedAt: Date };

/** Either the lineage union, or the pre-0230 top-level raw id, which every
 * legacy caller passes and which means `{ kind: "raw" }`. */
export type TransactionTipContextLineageInput =
  | { lineage: TransactionTipContextLineage; sourceRawPayloadId?: never }
  | { sourceRawPayloadId: number; lineage?: never };

export type UpsertTransactionTipContextInput = {
  accountId: number;
  platform: "fansly";
  platformTipId: string;
  capturedConversationRef: string;
  tipMessageText: string | null;
  tipAmountMills: bigint | null;
  occurredAt: Date;
  senderPlatformUserId: string;
  receiverPlatformUserId: string | null;
  capturedAt: Date;
  provenance: typeof FANSLY_DM_TIP_SIDECAR_PROVENANCE;
} & TransactionTipContextLineageInput;

export function resolveTransactionTipContextLineage(
  input: TransactionTipContextLineageInput,
): TransactionTipContextLineage {
  if (input.lineage !== undefined) {
    return input.lineage;
  }
  return { kind: "raw", sourceRawPayloadId: input.sourceRawPayloadId };
}

export type UpsertTransactionTipContextResult =
  | {
    status: "applied" | "unchanged" | "conversation_conflict";
    applied: boolean;
    id: number;
  }
  | {
    status: "deferred" | "erasure_fenced";
    applied: false;
    id: null;
  };

/**
 * Materializes one exact Fansly tip sidecar row. Sparse re-observations may
 * enrich but never erase captured context. A conflicting conversation ref is
 * deliberately a no-op: one native tip cannot truthfully belong to two DMs,
 * and choosing by arrival order would manufacture certainty.
 */
export async function upsertTransactionTipContext(
  db: Database,
  input: UpsertTransactionTipContextInput,
): Promise<UpsertTransactionTipContextResult> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    // The retained raw backfill and the live DM lane can both recreate this
    // sensitive note projection. Reuse the Stage-28 message-material fence:
    // writers take the shared try-lock and check the executed tombstone in the
    // SAME transaction as the upsert, while erasure takes the exclusive lock
    // before deleting. Old material is skipped; genuinely post-erasure tips may
    // still flow under the repository's material-time-bounded law.
    if (!(await tryAcquireDmArchiveWriterFenceLock(database, input.accountId))) {
      return { status: "deferred", applied: false, id: null } as const;
    }
    const materialAt = input.occurredAt < input.capturedAt
      ? input.occurredAt
      : input.capturedAt;
    if (
      await isDmArchiveScopeFenced(database, {
        pageId: input.accountId,
        platform: "fansly",
        refs: [
          input.capturedConversationRef,
          input.senderPlatformUserId,
          input.receiverPlatformUserId,
        ],
        materialAt,
      })
    ) {
      return { status: "erasure_fenced", applied: false, id: null } as const;
    }
    return upsertTransactionTipContextUnfenced(database, input);
  });
}

async function upsertTransactionTipContextUnfenced(
  db: Database,
  input: UpsertTransactionTipContextInput,
): Promise<UpsertTransactionTipContextResult> {
  // One lineage kind per write; the other kind's columns are written null.
  // Every legacy caller passes raw lineage, so for it the observation columns
  // below are constant nulls and each statement reduces to the pre-0230 one.
  const lineage = resolveTransactionTipContextLineage(input);
  const sourceRawPayloadId = lineage.kind === "raw" ? lineage.sourceRawPayloadId : null;
  const sourceObservationId = lineage.kind === "observation" ? lineage.sourceObservationId : null;
  const sourceObservationReceivedAt = lineage.kind === "observation"
    ? lineage.sourceObservationReceivedAt
    : null;
  const noteLineage = input.tipMessageText !== null;
  const noteApplies = sql`(
    excluded.tip_message_text is not null
    and (
      transaction_tip_contexts.tip_message_text is null
      or (
        transaction_tip_contexts.tip_message_text = ''
        and excluded.tip_message_text <> ''
      )
    )
  )`;
  // A lineage is missing only when NEITHER kind is set: raw lineage the
  // raw-row deletion nulled (ON DELETE SET NULL). Observation lineage has no
  // FK and is never nulled, so a row the engine wrote keeps it against any
  // later identical capture, raw or observation.
  const noteLineageRelinks = sql`(
    transaction_tip_contexts.tip_message_text is not null
    and transaction_tip_contexts.tip_message_source_raw_payload_id is null
    and transaction_tip_contexts.tip_message_source_observation_id is null
    and excluded.tip_message_text = transaction_tip_contexts.tip_message_text
  )`;
  const enrichmentApplies = sql`(
    (
      transaction_tip_contexts.tip_amount_mills is null
      and excluded.tip_amount_mills is not null
    )
    or (
      transaction_tip_contexts.receiver_platform_user_id is null
      and excluded.receiver_platform_user_id is not null
    )
  )`;
  const identityLineageRelinks = sql`(
    transaction_tip_contexts.source_raw_payload_id is null
    and transaction_tip_contexts.source_observation_id is null
  )`;
  const updateApplies = sql`(
    ${noteApplies}
    or ${noteLineageRelinks}
    or ${enrichmentApplies}
    or ${identityLineageRelinks}
  )`;
  const result = await db.execute<{
    id: string;
    status: "applied" | "unchanged" | "conversation_conflict";
  }>(sql`
    with applied as (
      insert into transaction_tip_contexts (
      account_id,
      platform,
      platform_tip_id,
      captured_conversation_ref,
      tip_message_text,
      tip_message_source_raw_payload_id,
      tip_message_captured_at,
      tip_amount_mills,
      occurred_at,
      sender_platform_user_id,
      receiver_platform_user_id,
      source_raw_payload_id,
      captured_at,
      provenance,
      created_at,
      updated_at,
      source_observation_id,
      source_observation_received_at,
      tip_message_source_observation_id,
      tip_message_source_observation_received_at
    ) values (
      ${input.accountId},
      ${input.platform},
      ${input.platformTipId},
      ${input.capturedConversationRef},
      ${input.tipMessageText},
      ${noteLineage ? sourceRawPayloadId : null},
      ${noteLineage ? input.capturedAt : null},
      ${input.tipAmountMills},
      ${input.occurredAt},
      ${input.senderPlatformUserId},
      ${input.receiverPlatformUserId},
      ${sourceRawPayloadId},
      ${input.capturedAt},
      ${input.provenance},
      now(),
      now(),
      ${sourceObservationId},
      ${sourceObservationReceivedAt},
      ${noteLineage ? sourceObservationId : null},
      ${noteLineage ? sourceObservationReceivedAt : null}
      )
      on conflict (account_id, platform_tip_id) do update set
      tip_message_text = case
        when transaction_tip_contexts.tip_message_text is null
          then excluded.tip_message_text
        when transaction_tip_contexts.tip_message_text = ''
          and excluded.tip_message_text <> ''
          then excluded.tip_message_text
        else transaction_tip_contexts.tip_message_text
      end,
      tip_message_source_raw_payload_id = case
        when ${noteApplies} or ${noteLineageRelinks}
          then excluded.tip_message_source_raw_payload_id
        else transaction_tip_contexts.tip_message_source_raw_payload_id
      end,
      tip_message_source_observation_id = case
        when ${noteApplies} or ${noteLineageRelinks}
          then excluded.tip_message_source_observation_id
        else transaction_tip_contexts.tip_message_source_observation_id
      end,
      tip_message_source_observation_received_at = case
        when ${noteApplies} or ${noteLineageRelinks}
          then excluded.tip_message_source_observation_received_at
        else transaction_tip_contexts.tip_message_source_observation_received_at
      end,
      tip_message_captured_at = case
        when ${noteApplies} or ${noteLineageRelinks}
          then excluded.tip_message_captured_at
        else transaction_tip_contexts.tip_message_captured_at
      end,
      tip_amount_mills = coalesce(
        transaction_tip_contexts.tip_amount_mills,
        excluded.tip_amount_mills
      ),
      occurred_at = transaction_tip_contexts.occurred_at,
      sender_platform_user_id = transaction_tip_contexts.sender_platform_user_id,
      receiver_platform_user_id = coalesce(
        transaction_tip_contexts.receiver_platform_user_id,
        excluded.receiver_platform_user_id
      ),
      source_raw_payload_id = case
        when ${identityLineageRelinks} then excluded.source_raw_payload_id
        else transaction_tip_contexts.source_raw_payload_id
      end,
      source_observation_id = case
        when ${identityLineageRelinks} then excluded.source_observation_id
        else transaction_tip_contexts.source_observation_id
      end,
      source_observation_received_at = case
        when ${identityLineageRelinks} then excluded.source_observation_received_at
        else transaction_tip_contexts.source_observation_received_at
      end,
      captured_at = case
        when ${identityLineageRelinks} then excluded.captured_at
        else transaction_tip_contexts.captured_at
      end,
      updated_at = now()
      where excluded.captured_conversation_ref =
          transaction_tip_contexts.captured_conversation_ref
        and ${updateApplies}
      returning id, captured_conversation_ref
    ), existing as (
      select id, captured_conversation_ref
      from transaction_tip_contexts
      where account_id = ${input.accountId}
        and platform_tip_id = ${input.platformTipId}
    )
    select coalesce(applied.id, existing.id)::text as id,
           case
             when applied.id is not null then 'applied'
             when existing.captured_conversation_ref is distinct from
               ${input.capturedConversationRef}
             then 'conversation_conflict'
             else 'unchanged'
           end as status
    from applied
    full join existing on true
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error("Transaction tip context upsert returned no resolution");
  }
  return {
    status: row.status,
    applied: row.status === "applied",
    id: Number(row.id),
  };
}

export interface TransactionTipContextRawPayloadRow {
  id: number;
  accountId: number;
  requestParams: unknown;
  responsePayload: unknown;
  capturedAt: Date;
}

/** Freezes one retained-raw replay generation. Rows captured after this read
 * belong to the next run and cannot extend the current keyset walk forever. */
export async function readTransactionTipContextRawPayloadHighWater(
  db: Database,
  input: { accountId?: number } = {},
): Promise<number> {
  const result = await db.execute<{ high_water_id: string | null }>(sql`
    select max(rp.id)::text as high_water_id
    from ${syncRawPayloads} rp
    join ${pages} p on p.id = rp.page_id
    where rp.endpoint = 'dm_messages'
      and rp.payload_kind = 'dm_messages'
      and p.platform = 'fansly'
      ${input.accountId === undefined ? sql`` : sql`and rp.page_id = ${input.accountId}`}
  `);
  return Number(result.rows[0]?.high_water_id ?? 0);
}

/** Keyset source for deterministic replay over retained Fansly `/message` raw. */
// G5 slice 3a (§6.4): the narrowing this reader used to do per row —
// `jsonb_build_object('tips', rp.response_payload -> 'tips')`, so a keyset walk
// over 500 retained DM pages never drags 500 whole message bodies across the
// wire — is now a typed slice column written at capture time
// (`response_tips`, migration 0125). The seam was never an option here: it
// would fetch the WHOLE catalog body per row and throw most of it away, which
// is the exact cost the narrowing exists to avoid.
export async function listTransactionTipContextRawPayloadsAfterId(
  db: Database,
  input: {
    afterId: number;
    throughId: number;
    limit?: number;
    accountId?: number;
  },
): Promise<TransactionTipContextRawPayloadRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 5_000);
  const result = await db.execute<Record<string, unknown>>(sql`
    select rp.id::text as id,
           rp.page_id::text as "accountId",
           rp.request_params as "requestParams",
           -- CAS-INLINE-FALLBACK: pre-0125 rows have no slice column; drop the
           -- coalesce and its CASE once the historical rewrite has filled them.
           coalesce(
             rp.response_tips,
             case
               when jsonb_typeof(rp.response_payload) = 'object'
               then jsonb_build_object('tips', rp.response_payload -> 'tips')
               else rp.response_payload
             end
           ) as "responsePayload",
           rp.captured_at as "capturedAt"
    from ${syncRawPayloads} rp
    join ${pages} p on p.id = rp.page_id
    where rp.id > ${input.afterId}
      and rp.id <= ${input.throughId}
      and rp.endpoint = 'dm_messages'
      and rp.payload_kind = 'dm_messages'
      and p.platform = 'fansly'
      ${input.accountId === undefined ? sql`` : sql`and rp.page_id = ${input.accountId}`}
    order by rp.id asc
    limit ${limit}
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    accountId: Number(row.accountId),
    requestParams: row.requestParams,
    responsePayload: row.responsePayload,
    capturedAt: row.capturedAt instanceof Date
      ? row.capturedAt
      : new Date(String(row.capturedAt)),
  }));
}
