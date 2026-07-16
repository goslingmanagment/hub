import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { MESSAGE_ARCHIVE_PROJECTION } from "./message-archive.ts";

export const OFAPI_MESSAGE_COVERAGE_PROJECTION = "ofapi_message_coverage_v1";

export interface OfapiMessageCoverageProjectionEvent {
  pageId: number;
  chatId: string;
  classification: "continuous_history" | "verified_unavailable" | "explicit_open_debt";
  source: "pagination_exhausted" | "export_artifact" | "harvest_import";
  frozenHeadId: string;
  oldestMessageId: string | null;
  target: Record<string, unknown>;
  targetHash: string;
  pageChainHash: string;
  rawCount: number;
  acceptedCount: number;
  boundaryDuplicateCount: number;
  explicitlyIrrelevantCount: number;
  rejectedCount: number;
  parseDebt: number;
  requiredServingHighWater: number;
  proofObservationId: number;
  proofObservationReceivedAt: Date;
  proofPolicyVersion: string;
  sourceContractVersion: string;
  parserVersion: string;
  sourceAccountSeq: number;
}

function assertContinuousProof(event: OfapiMessageCoverageProjectionEvent) {
  if (event.classification !== "continuous_history") return;
  if (
    event.parseDebt !== 0 ||
    event.rejectedCount !== 0 ||
    event.rawCount !== event.acceptedCount +
      event.boundaryDuplicateCount + event.explicitlyIrrelevantCount
  ) {
    throw new Error("Continuous OFAPI coverage proof has unresolved parse debt");
  }
}

export async function applyOfapiMessageCoverageEvents(
  db: Database,
  events: readonly OfapiMessageCoverageProjectionEvent[],
) {
  let projected = 0;
  for (const event of events) {
    assertContinuousProof(event);
    const result = await db.execute<{ page_id: unknown }>(sql`
      insert into ofapi_message_coverage (
        page_id, chat_id, classification, source, frozen_head_id,
        oldest_message_id, target, target_hash, page_chain_hash,
        raw_count, accepted_count, boundary_duplicate_count,
        explicitly_irrelevant_count, rejected_count, parse_debt,
        required_serving_high_water,
        proof_observation_id, proof_observation_received_at,
        proof_policy_version, source_contract_version, parser_version,
        source_account_seq, revoked_at, updated_at
      ) values (
        ${event.pageId}, ${event.chatId}, ${event.classification}, ${event.source},
        ${event.frozenHeadId}, ${event.oldestMessageId},
        ${JSON.stringify(event.target)}::jsonb, ${event.targetHash}, ${event.pageChainHash},
        ${event.rawCount}, ${event.acceptedCount}, ${event.boundaryDuplicateCount},
        ${event.explicitlyIrrelevantCount}, ${event.rejectedCount}, ${event.parseDebt},
        ${event.requiredServingHighWater},
        ${event.proofObservationId}, ${event.proofObservationReceivedAt},
        ${event.proofPolicyVersion}, ${event.sourceContractVersion}, ${event.parserVersion},
        ${event.sourceAccountSeq}, null, now()
      )
      on conflict (page_id, chat_id) do update set
        classification = excluded.classification,
        source = excluded.source,
        frozen_head_id = excluded.frozen_head_id,
        oldest_message_id = excluded.oldest_message_id,
        target = excluded.target,
        target_hash = excluded.target_hash,
        page_chain_hash = excluded.page_chain_hash,
        raw_count = excluded.raw_count,
        accepted_count = excluded.accepted_count,
        boundary_duplicate_count = excluded.boundary_duplicate_count,
        explicitly_irrelevant_count = excluded.explicitly_irrelevant_count,
        rejected_count = excluded.rejected_count,
        parse_debt = excluded.parse_debt,
        required_serving_high_water = excluded.required_serving_high_water,
        proof_observation_id = excluded.proof_observation_id,
        proof_observation_received_at = excluded.proof_observation_received_at,
        proof_policy_version = excluded.proof_policy_version,
        source_contract_version = excluded.source_contract_version,
        parser_version = excluded.parser_version,
        source_account_seq = excluded.source_account_seq,
        revoked_at = null,
        updated_at = now()
      where ofapi_message_coverage.source_account_seq < excluded.source_account_seq
      returning page_id
    `);
    projected += result.rows.length;
  }
  return { projected };
}

export interface OfapiMessageCoverageServingState {
  pageId: number;
  chatId: string;
  classification: string;
  frozenHeadId: string;
  oldestMessageId: string | null;
  requiredServingHighWater: number;
  proofPolicyVersion: string;
  sourceContractVersion: string;
  parserVersion: string;
  revokedAt: Date | null;
  messageArchiveHighWater: number;
}

export async function getOfapiMessageCoverageServingState(
  db: Database,
  input: { pageId: number; chatId: string },
): Promise<OfapiMessageCoverageServingState | null> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select coverage.page_id,
           coverage.chat_id,
           coverage.classification,
           coverage.frozen_head_id,
           coverage.oldest_message_id,
           coverage.required_serving_high_water,
           coverage.proof_policy_version,
           coverage.source_contract_version,
           coverage.parser_version,
           coverage.revoked_at,
           coalesce(watermark.high_seq, 0)::text as message_archive_high_water
    from ofapi_message_coverage coverage
    left join projection_seq_watermarks watermark
      on watermark.projection = ${MESSAGE_ARCHIVE_PROJECTION}
     and watermark.account_id = coverage.page_id
    where coverage.page_id = ${input.pageId}
      and coverage.chat_id = ${input.chatId}
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    pageId: Number(row.page_id),
    chatId: String(row.chat_id),
    classification: String(row.classification),
    frozenHeadId: String(row.frozen_head_id),
    oldestMessageId: row.oldest_message_id === null ? null : String(row.oldest_message_id),
    requiredServingHighWater: Number(row.required_serving_high_water),
    proofPolicyVersion: String(row.proof_policy_version),
    sourceContractVersion: String(row.source_contract_version),
    parserVersion: String(row.parser_version),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at as string | Date),
    messageArchiveHighWater: Number(row.message_archive_high_water),
  };
}

export type OfapiHistoryCoverageDecision =
  | { eligible: true; coverage: OfapiMessageCoverageServingState }
  | {
    eligible: false;
    reason:
      | "no_certificate"
      | "projection_lag"
      | "proof_policy_rejected"
      | "stale_head"
      | "range_unproven"
      | "gap";
  };

function nativeMessageId(value: string) {
  return /^\d+$/.test(value) ? BigInt(value) : null;
}

export async function evaluateOfapiHistoryCoverage(
  db: Database,
  input: {
    pageId: number;
    chatId: string;
    expectedCurrentHeadId: string;
    requestedFirstId: string;
    acceptedProofPolicyVersions: readonly string[];
  },
): Promise<OfapiHistoryCoverageDecision> {
  const coverage = await getOfapiMessageCoverageServingState(db, input);
  if (!coverage || coverage.revokedAt !== null) {
    return { eligible: false, reason: "no_certificate" };
  }
  if (coverage.classification !== "continuous_history") {
    return { eligible: false, reason: "gap" };
  }
  if (!input.acceptedProofPolicyVersions.includes(coverage.proofPolicyVersion)) {
    return { eligible: false, reason: "proof_policy_rejected" };
  }
  if (coverage.frozenHeadId !== input.expectedCurrentHeadId) {
    return { eligible: false, reason: "stale_head" };
  }
  const oldest = coverage.oldestMessageId === null
    ? null
    : nativeMessageId(coverage.oldestMessageId);
  const newest = nativeMessageId(coverage.frozenHeadId);
  const requested = nativeMessageId(input.requestedFirstId);
  if (
    oldest === null ||
    newest === null ||
    requested === null ||
    requested < oldest ||
    requested > newest
  ) {
    return { eligible: false, reason: "range_unproven" };
  }
  if (coverage.messageArchiveHighWater < coverage.requiredServingHighWater) {
    return { eligible: false, reason: "projection_lag" };
  }
  return { eligible: true, coverage };
}

export async function resetOfapiMessageCoverageProjection(
  db: Database,
  accountId?: number | null,
) {
  if (accountId == null) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`delete from ofapi_message_coverage`);
      await tx.execute(sql`
        delete from projection_seq_watermarks
        where projection = ${OFAPI_MESSAGE_COVERAGE_PROJECTION}
      `);
    });
    return;
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from ofapi_message_coverage where page_id = ${accountId}`);
    await tx.execute(sql`
      delete from projection_seq_watermarks
      where projection = ${OFAPI_MESSAGE_COVERAGE_PROJECTION}
        and account_id = ${accountId}
    `);
  });
}
