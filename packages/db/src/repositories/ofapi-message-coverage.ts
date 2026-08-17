import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { appendProjectionOnlyDomainEventsInTransaction } from "./domain-events.ts";
import { MESSAGE_ARCHIVE_PROJECTION } from "./message-archive.ts";
import { insertObservation } from "./observations.ts";

export const OFAPI_MESSAGE_COVERAGE_PROJECTION = "ofapi_message_coverage_v1";

export interface OfapiMessageCoverageProofEvent {
  kind: "proof";
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
  supersedes: OfapiMessageCoverageProofReference | null;
}

export interface OfapiMessageCoverageRevocationEvent {
  kind: "revocation";
  pageId: number;
  chatId: string;
  revokedAt: Date;
  sourceAccountSeq: number;
}

export type OfapiMessageCoverageProjectionEvent =
  | OfapiMessageCoverageProofEvent
  | OfapiMessageCoverageRevocationEvent;

export interface OfapiMessageCoverageProofReference {
  proofObservationId: number;
  proofObservationReceivedAt: Date;
  sourceAccountSeq: number;
  frozenHeadId: string;
  oldestMessageId: string | null;
  targetHash: string;
  pageChainHash: string;
  rawCount: number;
  acceptedCount: number;
  boundaryDuplicateCount: number;
  explicitlyIrrelevantCount: number;
  rejectedCount: number;
  parseDebt: number;
  requiredServingHighWater: number;
  proofPolicyVersion: string;
  sourceContractVersion: string;
  parserVersion: string;
}

function assertContinuousProof(event: OfapiMessageCoverageProjectionEvent) {
  if (event.kind !== "proof") return;
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
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    let projected = 0;
    for (const event of events) {
      if (event.kind === "revocation") {
        const result = await database.execute<{ page_id: unknown }>(sql`
          update ofapi_message_coverage
          set revoked_at = ${event.revokedAt},
              source_account_seq = ${event.sourceAccountSeq},
              updated_at = now()
          where page_id = ${event.pageId}
            and chat_id = ${event.chatId}
            and source_account_seq <= ${event.sourceAccountSeq}
          returning page_id
        `);
        projected += result.rows.length;
        continue;
      }
      assertContinuousProof(event);
      if (event.supersedes !== null) {
        const current = await database.execute<Record<string, unknown>>(sql`
          select *
          from ofapi_message_coverage
          where page_id = ${event.pageId}
            and chat_id = ${event.chatId}
          for update
        `);
        const row = current.rows[0];
        const alreadyApplied = row !== undefined &&
          Number(row.source_account_seq) >= event.sourceAccountSeq;
        const monotoneLaterProof = row !== undefined &&
          row.classification === "continuous_history" &&
          row.revoked_at === null &&
          Number(row.source_account_seq) > event.supersedes.sourceAccountSeq &&
          Number(row.source_account_seq) < event.sourceAccountSeq;
        if (
          !alreadyApplied &&
          !monotoneLaterProof &&
          !matchesOfapiMessageCoverageProofReference(row, event.supersedes)
        ) {
          throw new Error("Anchor-chain coverage does not supersede the current proof");
        }
      }
      const result = await database.execute<{ page_id: unknown }>(sql`
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
  });
}

export function matchesOfapiMessageCoverageProofReference(
  row: Record<string, unknown> | undefined,
  proof: OfapiMessageCoverageProofReference,
) {
  return row !== undefined &&
    row.classification === "continuous_history" &&
    row.revoked_at === null &&
    Number(row.proof_observation_id) === proof.proofObservationId &&
    new Date(row.proof_observation_received_at as string | Date).getTime() ===
      proof.proofObservationReceivedAt.getTime() &&
    Number(row.source_account_seq) === proof.sourceAccountSeq &&
    row.frozen_head_id === proof.frozenHeadId &&
    (row.oldest_message_id === null ? null : String(row.oldest_message_id)) ===
      proof.oldestMessageId &&
    row.target_hash === proof.targetHash &&
    row.page_chain_hash === proof.pageChainHash &&
    Number(row.raw_count) === proof.rawCount &&
    Number(row.accepted_count) === proof.acceptedCount &&
    Number(row.boundary_duplicate_count) === proof.boundaryDuplicateCount &&
    Number(row.explicitly_irrelevant_count) === proof.explicitlyIrrelevantCount &&
    Number(row.rejected_count) === proof.rejectedCount &&
    Number(row.parse_debt) === proof.parseDebt &&
    Number(row.required_serving_high_water) === proof.requiredServingHighWater &&
    row.proof_policy_version === proof.proofPolicyVersion &&
    row.source_contract_version === proof.sourceContractVersion &&
    row.parser_version === proof.parserVersion;
}

/**
 * Returns the exact latest proof that can close a newly captured page chain.
 * The projection reducer re-checks this same identity before superseding it.
 */
export async function getComposableOfapiMessageCoverageProof(
  db: Database,
  input: {
    pageId: number;
    chatId: string;
    expectedFrozenHeadId: string;
    proofPolicyVersion: string;
  },
): Promise<OfapiMessageCoverageProofReference | null> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select coverage.*
    from ofapi_message_coverage coverage
    join observations proof
      on proof.id = coverage.proof_observation_id
     and proof.received_at = coverage.proof_observation_received_at
     and proof.account_id = coverage.page_id
     and proof.source = 'ofapi_capture'
     and proof.kind = 'ofapi.capture_completed.v1'
    where coverage.page_id = ${input.pageId}
      and coverage.chat_id = ${input.chatId}
      and coverage.classification = 'continuous_history'
      and coverage.frozen_head_id = ${input.expectedFrozenHeadId}
      and coverage.proof_policy_version = ${input.proofPolicyVersion}
      and coverage.revoked_at is null
      and coverage.parse_debt = 0
      and coverage.rejected_count = 0
      and coverage.raw_count = coverage.accepted_count
        + coverage.boundary_duplicate_count
        + coverage.explicitly_irrelevant_count
  `);
  const row = result.rows[0];
  if (!row) return null;
  return mapProofReference(row);
}

function mapProofReference(row: Record<string, unknown>): OfapiMessageCoverageProofReference {
  return {
    proofObservationId: Number(row.proof_observation_id),
    proofObservationReceivedAt: new Date(row.proof_observation_received_at as string | Date),
    sourceAccountSeq: Number(row.source_account_seq),
    frozenHeadId: String(row.frozen_head_id),
    oldestMessageId: row.oldest_message_id === null ? null : String(row.oldest_message_id),
    targetHash: String(row.target_hash),
    pageChainHash: String(row.page_chain_hash),
    rawCount: Number(row.raw_count),
    acceptedCount: Number(row.accepted_count),
    boundaryDuplicateCount: Number(row.boundary_duplicate_count),
    explicitlyIrrelevantCount: Number(row.explicitly_irrelevant_count),
    rejectedCount: Number(row.rejected_count),
    parseDebt: Number(row.parse_debt),
    requiredServingHighWater: Number(row.required_serving_high_water),
    proofPolicyVersion: String(row.proof_policy_version),
    sourceContractVersion: String(row.source_contract_version),
    parserVersion: String(row.parser_version),
  };
}

export class OfapiMessageCoverageOperatorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfapiMessageCoverageOperatorConflictError";
  }
}

export async function revokeOfapiMessageCoverage(
  db: Database,
  input: {
    actionId: string;
    pageId: number;
    chatId: string;
    expectedSourceAccountSeq: number;
    actorUserId: number;
    reason: string;
    execute?: boolean;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const idempotencyKey = `ofapi-coverage-revoke:${input.actionId}`;
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const currentResult = await database.execute<Record<string, unknown>>(sql`
      select *
      from ofapi_message_coverage
      where page_id = ${input.pageId} and chat_id = ${input.chatId}
      for update
    `);
    const current = currentResult.rows[0];
    if (!current) return null;

    // CAS-READ-BACKLOG(§6.4): an idempotency proof — the prior operator
    // observation's body is read to compare two scalars (pageId, chatId) and
    // never leaves this function. It runs inside packages/db, inside this
    // write transaction, with no logger and no reach to the runtime read seam;
    // routing it would mean lifting the whole revoke into apps/runtime.
    const existing = await database.execute<{
      payload: unknown;
    }>(sql`
      select payload
      from observations
      where source = 'operator'
        and producer = 'ofapi-coverage-operator'
        and kind = 'ofapi.coverage_revoked.v1'
        and idempotency_key = ${idempotencyKey}
      order by received_at desc
      limit 1
    `);
    if (existing.rows[0]) {
      const payload = existing.rows[0].payload as Record<string, unknown>;
      if (payload.pageId !== input.pageId || payload.chatId !== input.chatId) {
        throw new OfapiMessageCoverageOperatorConflictError(
          `Coverage revocation action ${input.actionId} belongs to another proof`,
        );
      }
      return {
        status: "already_reconciled" as const,
        pageId: input.pageId,
        chatId: input.chatId,
        sourceAccountSeq: Number(current.source_account_seq),
        revokedAt: current.revoked_at === null
          ? null
          : new Date(current.revoked_at as string | Date),
      };
    }

    const currentSeq = Number(current.source_account_seq);
    if (!Number.isSafeInteger(currentSeq) || currentSeq !== input.expectedSourceAccountSeq) {
      throw new OfapiMessageCoverageOperatorConflictError(
        `Coverage source sequence ${String(current.source_account_seq)} does not match `
          + `${input.expectedSourceAccountSeq}`,
      );
    }
    if (current.revoked_at !== null) {
      throw new OfapiMessageCoverageOperatorConflictError(
        `Coverage proof was already revoked at ${new Date(
          current.revoked_at as string | Date,
        ).toISOString()}`,
      );
    }

    const previous = {
      sourceAccountSeq: currentSeq,
      proofObservationId: Number(current.proof_observation_id),
      proofObservationReceivedAt: new Date(
        current.proof_observation_received_at as string | Date,
      ).toISOString(),
      frozenHeadId: String(current.frozen_head_id),
      proofPolicyVersion: String(current.proof_policy_version),
    };
    if (input.execute !== true) {
      await database.execute(sql`
        insert into ofapi_capture_operator_actions (
          action, target_type, target_ref, expected_state,
          previous_state, resulting_state, dry_run,
          actor_user_id, reason, occurred_at
        ) values (
          'revoke_coverage',
          'coverage',
          ${`page:${input.pageId}:chat:${input.chatId}`},
          ${String(input.expectedSourceAccountSeq)},
          ${JSON.stringify(previous)}::jsonb,
          ${JSON.stringify({ revokedAt: now.toISOString() })}::jsonb,
          true,
          ${input.actorUserId},
          ${input.reason},
          ${now}
        )
      `);
      return {
        status: "would_revoke" as const,
        pageId: input.pageId,
        chatId: input.chatId,
        sourceAccountSeq: currentSeq,
        revokedAt: now,
      };
    }

    const payload = {
      actionId: input.actionId,
      pageId: input.pageId,
      chatId: input.chatId,
      reason: input.reason,
      actorUserId: input.actorUserId,
      revokes: previous,
    };
    const observation = await insertObservation(database, {
      source: "operator",
      producer: "ofapi-coverage-operator",
      platform: "onlyfans",
      accountId: input.pageId,
      kind: "ofapi.coverage_revoked.v1",
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
      idempotencyKey,
      observedAt: now,
      actorPrincipalId: input.actorUserId,
      receivedAt: now,
    });
    const appended = await appendProjectionOnlyDomainEventsInTransaction(
      database,
      input.pageId,
      [{
        type: "capture.coverage_revoked",
        occurredAt: now,
        conversationRef: input.chatId,
        data: payload,
        schemaVersion: 1,
        observationId: observation.observationId,
        dedupKey: `coverage-revoke:${input.actionId}`,
      }],
      {
        occurredAt: now,
        observationId: observation.observationId,
        dedupKey: `projection-checkpoint:coverage-revoke:${input.actionId}`,
        data: { profile: OFAPI_MESSAGE_COVERAGE_PROJECTION },
      },
    );
    const eventId = appended.events[0]?.eventId;
    if (!eventId) {
      throw new Error("Coverage revocation event identity is missing");
    }
    const sequence = await database.execute<{ account_seq: unknown }>(sql`
      select account_seq
      from domain_events
      where id = ${eventId}
    `);
    const sourceAccountSeq = Number(sequence.rows[0]?.account_seq);
    if (!Number.isSafeInteger(sourceAccountSeq)) {
      throw new Error("Coverage revocation account sequence is missing");
    }
    const updated = await database.execute<{ page_id: unknown }>(sql`
      update ofapi_message_coverage
      set revoked_at = ${now},
          source_account_seq = ${sourceAccountSeq},
          updated_at = ${now}
      where page_id = ${input.pageId}
        and chat_id = ${input.chatId}
        and source_account_seq = ${currentSeq}
        and revoked_at is null
      returning page_id
    `);
    if (updated.rows.length !== 1) {
      throw new OfapiMessageCoverageOperatorConflictError(
        "Coverage proof changed during revocation",
      );
    }
    await database.execute(sql`
      insert into ofapi_capture_operator_actions (
        action, target_type, target_ref, expected_state,
        previous_state, resulting_state, dry_run,
        actor_user_id, reason, occurred_at
      ) values (
        'revoke_coverage',
        'coverage',
        ${`page:${input.pageId}:chat:${input.chatId}`},
        ${String(input.expectedSourceAccountSeq)},
        ${JSON.stringify(previous)}::jsonb,
        ${JSON.stringify({ revokedAt: now.toISOString(), sourceAccountSeq })}::jsonb,
        false,
        ${input.actorUserId},
        ${input.reason},
        ${now}
      )
    `);
    return {
      status: "revoked" as const,
      pageId: input.pageId,
      chatId: input.chatId,
      sourceAccountSeq,
      revokedAt: now,
    };
  });
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
