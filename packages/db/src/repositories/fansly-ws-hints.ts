import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FanslyWsHintNode, FanslyWsHintPolicy } from "@agency_hub_core/shared";
import type { Database } from "../client.ts";
import { tryAcquireDmArchiveWriterFenceLock } from "./erasure-fence.ts";
import { capturePayloadRefFromColumns } from "./capture-payloads.ts";

export const FANSLY_WS_DM_PLANE = "fansly_ws_dm";

/** Bounded staged REST envelopes, authorized by page, endpoint and native
 * group binding. Missing/detached material is debt, never an empty response. */
export async function listFanslyWsHintRawPages(db: Database, pageId: number, groupRef: string, ids: number[]) {
  if (!ids.length || ids.length > 5 || new Set(ids).size !== ids.length) throw new Error("fansly_ws_hint_page_chain_invalid");
  const result = await db.execute<{
    id: string; payload: unknown; bucket: string | null; object_id: string | null;
  }>(sql`select id::text, response_payload as payload,
      to_char(payload_bucket_month, 'YYYY-MM-DD') as bucket, payload_object_id::text as object_id
    from sync_raw_payloads where page_id = ${pageId} and endpoint = 'dm_messages'
      and request_params->>'groupId' = ${groupRef} and id in ${ids} order by id desc`);
  if (result.rows.length !== ids.length) throw new Error("fansly_ws_hint_page_chain_unavailable");
  return result.rows.map(row => ({ id: Number(row.id), payload: row.payload,
    payloadRef: capturePayloadRefFromColumns(row.bucket, row.object_id) }));
}

export type FanslyWsHintEvent = {
  id: number; pageId: number; observationId: number; receivedAt: Date;
  generation: string | null; node: FanslyWsHintNode;
};

/** Caller holds the page erasure/generation fence and commits the routing
 * receipt with the dirty mark. Receipts survive projection replay. */
export async function routeFanslyWsHintEvent(db: Database, event: FanslyWsHintEvent, policy: FanslyWsHintPolicy | null) {
  const { node } = event;
  let outcome: string = node.outcome;
  if (node.outcome === "hint") {
    outcome = !event.generation ? "generation_unknown"
      : !policy || policy.generation !== event.generation || !node.hint || !policy.enabledTypes.has(node.hint.type) ? "disabled"
      : event.receivedAt < new Date(policy.activationAt) ? "before_activation" : "routed";
  } else if (node.outcome === "not_enabled") outcome = "disabled";
  const groupRef = node.hint?.groupRef ?? node.mutation?.groupRef ?? null;
  const receipt = await db.execute(sql`
    insert into fansly_ws_hint_receipts (event_id, page_id, observation_id, received_at,
      generation, group_ref, message_ref, hint_type, mutation, outcome)
    values (${event.id}, ${event.pageId}, ${event.observationId}, ${event.receivedAt},
      ${event.generation}, ${groupRef}, ${node.hint?.messageRef ?? node.mutation?.messageRef ?? null}, ${node.hint?.type ?? null},
      ${node.mutation ? JSON.stringify(node.mutation) : null}::jsonb, ${outcome})
    on conflict (event_id) do nothing returning event_id
  `);
  if (!receipt.rows.length || outcome !== "routed" || !node.hint) return false;
  const result = await db.execute<{ requested_revision: string }>(sql`
    insert into subject_refresh_state (page_id, plane, subject_ref, refresh_class,
      dirty_reason, next_due_at, requested_revision, backfill_cursor)
    values (${event.pageId}, ${FANSLY_WS_DM_PLANE}, ${node.hint.groupRef}, 'dirty',
      'ws_hint', ${event.receivedAt}, 1, jsonb_build_object('generation', ${event.generation}::text))
    on conflict (page_id, plane, subject_ref) do update set
      requested_revision = subject_refresh_state.requested_revision + 1,
      refresh_class = 'dirty', dirty_reason = 'ws_hint',
      next_due_at = least(subject_refresh_state.next_due_at, excluded.next_due_at),
      -- A new credential/route generation cannot inherit an old in-flight
      -- walk. Same-generation R+1 leaves R's cursor and claim untouched.
      backfill_cursor = case when subject_refresh_state.backfill_cursor->>'generation' = ${event.generation}
        then subject_refresh_state.backfill_cursor else excluded.backfill_cursor end,
      claim_token = case when subject_refresh_state.backfill_cursor->>'generation' = ${event.generation}
        then subject_refresh_state.claim_token else null end,
      claimed_revision = case when subject_refresh_state.backfill_cursor->>'generation' = ${event.generation}
        then subject_refresh_state.claimed_revision else null end,
      claim_expires_at = case when subject_refresh_state.backfill_cursor->>'generation' = ${event.generation}
        then subject_refresh_state.claim_expires_at else null end,
      updated_at = now()
    returning requested_revision
  `);
  await db.execute(sql`update fansly_ws_hint_receipts set routed_revision = ${result.rows[0]!.requested_revision}::bigint
    where event_id = ${event.id}`);
  return true;
}

export type FanslyWsHintWalk = {
  generation: string;
  revision?: number;
  conversationId?: number;
  boundaryMessageRef?: string | null;
  before?: string | null;
  pagesRead?: number;
  groupDetailCaptured?: boolean;
  rawPageIds?: number[];
  /** ISO dispatch time of the walk's head page (before = null); finalize
   * stamps it as the thread's last_message_sync_at. */
  headReadAt?: string;
};

export type FanslyWsHintClaim = {
  pageId: number; groupRef: string; token: string; revision: number;
  consecutiveFailures: number;
  walk: FanslyWsHintWalk;
};

export async function saveFanslyWsHintWalk(db: Database, claim: FanslyWsHintClaim, walk: FanslyWsHintWalk) {
  const result = await db.execute(sql`update subject_refresh_state
    set backfill_cursor = ${JSON.stringify({ ...walk, revision: claim.revision })}::jsonb,
      claim_expires_at = clock_timestamp() + interval '5 minutes', updated_at = now()
    where page_id = ${claim.pageId} and plane = ${FANSLY_WS_DM_PLANE} and subject_ref = ${claim.groupRef}
      and claim_token = ${claim.token}::uuid and claimed_revision = ${claim.revision}
      and backfill_cursor->>'generation' = ${claim.walk.generation}
    returning page_id`);
  if (!result.rows.length) throw new Error("fansly_ws_hint_claim_fenced");
}

/** Reuses subject_refresh_state's claim/CAS protocol. The caller owns the
 * page sync lease; this token protects the cursor across expiry and erasure. */
export async function claimFanslyWsHint(db: Database, pageId: number, policy: FanslyWsHintPolicy, now: Date): Promise<FanslyWsHintClaim | null> {
  if (!policy.enabledTypes.size) return null;
  if (!await tryAcquireDmArchiveWriterFenceLock(db, pageId)) throw new Error("fansly_ws_hint_erasure_busy");
  const token = randomUUID();
  const result = await db.execute<{
    subject_ref: string; claimed_revision: string; backfill_cursor: FanslyWsHintWalk; consecutive_failures: number;
  }>(sql`
    with candidate as (
      select page_id, plane, subject_ref,
        exists (select 1 from fansly_ws_hint_receipts r where r.page_id = subject_refresh_state.page_id
          and r.group_ref = subject_refresh_state.subject_ref and r.outcome = 'routed'
          and r.routed_revision > subject_refresh_state.applied_revision
          and r.routed_revision <= coalesce((subject_refresh_state.backfill_cursor->>'revision')::bigint, subject_refresh_state.requested_revision)
          and r.received_at >= ${new Date(policy.activationAt)} and r.generation = ${policy.generation}
          and r.hint_type in ${[...policy.enabledTypes]}) as frozen_revision_enabled
      from subject_refresh_state
      where page_id = ${pageId} and plane = ${FANSLY_WS_DM_PLANE}
        and requested_revision > applied_revision and next_due_at <= ${now}
        and (retry_after_at is null or retry_after_at <= ${now})
        and (claim_token is null or claim_expires_at <= ${now})
        and backfill_cursor->>'generation' = ${policy.generation}
        and exists (select 1 from fansly_ws_hint_receipts r where r.page_id = subject_refresh_state.page_id
          and r.group_ref = subject_refresh_state.subject_ref and r.outcome = 'routed'
          and r.routed_revision > subject_refresh_state.applied_revision
          and r.routed_revision <= subject_refresh_state.requested_revision
          and r.received_at >= ${new Date(policy.activationAt)} and r.generation = ${policy.generation}
          and r.hint_type in ${[...policy.enabledTypes]})
      order by next_due_at, subject_ref limit 1 for update skip locked
    )
    update subject_refresh_state s set claim_token = ${token}::uuid,
      claimed_revision = case when c.frozen_revision_enabled
        then coalesce((s.backfill_cursor->>'revision')::bigint, s.requested_revision) else s.requested_revision end,
      backfill_cursor = case when c.frozen_revision_enabled then s.backfill_cursor
        else jsonb_build_object('generation', s.backfill_cursor->>'generation') end,
      claim_expires_at = ${new Date(now.getTime() + 300_000)},
      refresh_visits = s.refresh_visits + 1, last_visited_at = ${now}, updated_at = now()
    from candidate c where s.page_id = c.page_id and s.plane = c.plane and s.subject_ref = c.subject_ref
    returning s.subject_ref, s.claimed_revision, s.backfill_cursor, s.consecutive_failures
  `);
  const row = result.rows[0];
  return row ? { pageId, groupRef: row.subject_ref, token, revision: Number(row.claimed_revision),
    walk: row.backfill_cursor, consecutiveFailures: row.consecutive_failures } : null;
}

export async function isFanslyWsHintClaimEnabled(db: Database, claim: FanslyWsHintClaim, policy: FanslyWsHintPolicy) {
  if (!policy.enabledTypes.size) return false;
  const result = await db.execute(sql`select 1 from fansly_ws_hint_receipts r join subject_refresh_state s
    on s.page_id = r.page_id and s.subject_ref = r.group_ref and s.plane = ${FANSLY_WS_DM_PLANE}
    where s.page_id = ${claim.pageId} and s.subject_ref = ${claim.groupRef}
      and s.claim_token = ${claim.token}::uuid and s.claimed_revision = ${claim.revision}
      and r.outcome = 'routed' and r.routed_revision > s.applied_revision and r.routed_revision <= ${claim.revision}
      and r.received_at >= ${new Date(policy.activationAt)} and r.generation = ${policy.generation}
      and r.hint_type in ${[...policy.enabledTypes]} limit 1`);
  return result.rows.length > 0;
}

// Both the completion gate and the receipt writer use these exact predicates.
// A correlation/bulk marker does not negate an exact native message address.
// Missing group or a different credential generation is not deletion evidence.
function deletedTargetObservation() {
  return sql`(select d.observation_id from fansly_ws_hint_receipts d
    where d.page_id = r.page_id and d.group_ref = r.group_ref
      and d.message_ref = r.message_ref and d.generation = r.generation
      and d.outcome = 'mutation_debt' and d.received_at >= r.received_at
    order by d.received_at, d.event_id limit 1)`;
}

function liveTarget(conversationId: number) {
  return sql`exists (select 1 from page_dm_messages m join page_dm_threads t on t.id = m.conversation_id
    where m.platform_account_id = r.page_id and t.platform_account_id = r.page_id
      and t.platform_conversation_id = r.group_ref and m.conversation_id = ${conversationId}
      and m.platform_message_id = r.message_ref and m.deleted_at is null)`;
}

/** A stale REST head reaching the old boundary does not prove that the
 * message named by WS has arrived. Check the exact IDs in the REST-backed
 * hot table, inside the same transaction as the contiguous apply. */
export async function hasUnconfirmedFanslyWsHintTargets(
  db: Database, claim: FanslyWsHintClaim, conversationId: number, policy: FanslyWsHintPolicy,
) {
  if (!policy.enabledTypes.has("message_created")) return false;
  const result = await db.execute(sql`select 1 from fansly_ws_hint_receipts r
    join subject_refresh_state s on s.page_id = r.page_id
      and s.plane = ${FANSLY_WS_DM_PLANE} and s.subject_ref = r.group_ref
    where r.page_id = ${claim.pageId} and r.group_ref = ${claim.groupRef}
      and r.generation = ${claim.walk.generation} and r.outcome = 'routed'
      and r.hint_type = 'message_created' and r.received_at >= ${new Date(policy.activationAt)}
      and r.routed_revision > s.applied_revision and r.routed_revision <= ${claim.revision}
      and not ${liveTarget(conversationId)} and ${deletedTargetObservation()} is null
    limit 1`);
  return result.rows.length > 0;
}

/** Called in the SAME owned transaction as the REST-derived message writes.
 * Progress keeps the original boundary; success settles only claimed R.
 * A newer R+1 immediately becomes due, with a fresh head walk. */
export async function advanceFanslyWsHint(db: Database, claim: FanslyWsHintClaim, input: {
  walk: FanslyWsHintWalk; complete: boolean; outcome: string; now: Date; retryAt?: Date;
  rawPageIds?: number[]; failed?: boolean;
  settlement?: { conversationId: number; policy: FanslyWsHintPolicy };
}) {
  const nextCursor = input.complete ? { generation: claim.walk.generation }
    : { ...input.walk, generation: claim.walk.generation, revision: claim.revision };
  const result = await db.execute(sql`
    update subject_refresh_state set
      applied_revision = case when ${input.complete} then greatest(applied_revision, ${claim.revision}) else applied_revision end,
      backfill_cursor = ${JSON.stringify(nextCursor)}::jsonb,
      claim_token = null, claimed_revision = null, claim_expires_at = null,
      next_due_at = case when ${input.complete} and requested_revision <= ${claim.revision}
        then null else ${input.retryAt ?? input.now}::timestamptz end,
      retry_after_at = ${input.retryAt ?? null},
      refresh_class = case when ${input.complete} and requested_revision <= ${claim.revision} then null else 'dirty' end,
      dirty_reason = case when ${input.complete} and requested_revision <= ${claim.revision} then null else 'ws_hint' end,
      last_refresh_outcome = ${input.outcome},
      consecutive_failures = case when ${input.complete} then 0
        when ${input.failed === true} then least(consecutive_failures, 30) + 1 else consecutive_failures end,
      last_checked_at = case when ${Boolean(input.rawPageIds?.length)} then ${input.now}::timestamptz else last_checked_at end,
      refresh_checks = refresh_checks + ${input.rawPageIds?.length ? 1 : 0}, updated_at = now()
    where page_id = ${claim.pageId} and plane = ${FANSLY_WS_DM_PLANE} and subject_ref = ${claim.groupRef}
      and claim_token = ${claim.token}::uuid and claimed_revision = ${claim.revision}
      and backfill_cursor->>'generation' = ${claim.walk.generation}
    returning page_id
  `);
  if (!result.rows.length) throw new Error("fansly_ws_hint_claim_fenced");
  if (input.complete && input.settlement) {
    const { conversationId, policy } = input.settlement;
    if (!policy.enabledTypes.size || policy.generation !== claim.walk.generation) throw new Error("fansly_ws_hint_settlement_policy_invalid");
    await db.execute(sql`with evidence as (
      select r.event_id, r.hint_type,
        (r.hot_applied_at is not null or ${liveTarget(conversationId)}) as materialized,
        ${deletedTargetObservation()} as delete_observation_id
      from fansly_ws_hint_receipts r
      where r.page_id = ${claim.pageId} and r.group_ref = ${claim.groupRef}
        and r.generation = ${policy.generation} and r.outcome = 'routed'
        and r.routed_revision <= ${claim.revision} and r.settled_at is null
        and r.received_at >= ${new Date(policy.activationAt)} and r.hint_type in ${[...policy.enabledTypes]}
    ) update fansly_ws_hint_receipts r set settled_at = clock_timestamp(),
      settlement_kind = case when e.hint_type = 'group_created' then 'group_checked'
        when e.materialized then 'rest_materialized' else 'source_deleted' end,
      settlement_observation_id = case when not e.materialized and e.hint_type = 'message_created'
        then e.delete_observation_id else null end,
      hot_applied_at = case when e.materialized or e.hint_type = 'group_created'
        then coalesce(r.hot_applied_at, clock_timestamp()) else r.hot_applied_at end,
      rest_raw_page_ids = coalesce(r.rest_raw_page_ids, ${JSON.stringify(input.rawPageIds ?? [])}::jsonb)
      from evidence e where r.event_id = e.event_id
        and (e.materialized or e.hint_type = 'group_created' or e.delete_observation_id is not null)`);
  }
}

/** Admission is serialized by the caller's owned page-sync transaction.
 * Counts all generations so changing a flag/policy cannot reset the budget. */
export async function admitFanslyWsHintAttempt(db: Database, input: {
  pageId: number; generation: string; requestId: string; attemptNumber: number;
  maxAttempts24h: number; now: Date;
  syncRunId?: number;
}) {
  const usage = await db.execute<{ n: string }>(sql`select count(*)::text n from fansly_ws_hint_attempts
    where page_id = ${input.pageId} and admitted_at > ${new Date(input.now.getTime() - 86_400_000)}`);
  if (Number(usage.rows[0]!.n) >= input.maxAttempts24h) throw new Error("fansly_ws_hint_budget_exhausted");
  await db.execute(sql`insert into fansly_ws_hint_attempts(page_id, generation, request_id, attempt_number, admitted_at, sync_run_id)
    values (${input.pageId}, ${input.generation}, ${input.requestId}, ${input.attemptNumber}, ${input.now}, ${input.syncRunId ?? null})`);
}

/** The same rolling count as admitFanslyWsHintAttempt, read before any
 * request is prepared: null while the window has room, otherwise when enough
 * counted attempts have aged out for admission to succeed. Admission at
 * dispatch stays the authoritative check. */
export async function nextFanslyWsHintBudgetAt(db: Database, input: {
  pageId: number; maxAttempts24h: number; now: Date;
}) {
  const windowStart = new Date(input.now.getTime() - 86_400_000);
  const usage = await db.execute<{ n: string }>(sql`select count(*)::text n from fansly_ws_hint_attempts
    where page_id = ${input.pageId} and admitted_at > ${windowStart}`);
  const used = Number(usage.rows[0]!.n);
  if (used < input.maxAttempts24h) return null;
  const expiring = await db.execute<{ admitted_at: Date | string }>(sql`select admitted_at from fansly_ws_hint_attempts
    where page_id = ${input.pageId} and admitted_at > ${windowStart}
    order by admitted_at offset ${Math.max(0, used - input.maxAttempts24h)} limit 1`);
  const admittedAt = expiring.rows[0]?.admitted_at;
  // A zero cap never reopens; look again after a full window.
  return new Date((admittedAt === undefined ? input.now.getTime() : new Date(admittedAt).getTime()) + 86_400_000);
}
