import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { findOfapiReadDefinition, OFAPI_COLLECTION_REGISTRY, OFAPI_COLLECTION_LEGACY_OPERATIONS, OFAPI_READ_CATALOG, OFAPI_SCHEDULED_READ_COLLECTION_CATEGORIES, classifyOfapiCollectionOperation, type OfapiCollectionCategory, type OfapiCollectionContext, type OfapiCollectionJobStateFilter, type OfapiCollectionMode, type OfapiCollectionSettings } from "@agency_hub_core/shared";
import type { Database } from "../client.ts";
import { insertAuditEvent } from "./auth.ts";
import { findOfapiCollectionCaptureJob, hashOfapiCaptureValue } from "./ofapi-capture.ts";

/**
 * A local refusal at the collection boundary — never a vendor or transport
 * failure. `reason` is the machine reason; `code` is the stable error code the
 * sync journal keeps (`sanitizeError` reads `.code`); `retryAt` is set only for
 * time-bound caps (the UTC day rollover, the interval window reopening) and is
 * the earliest instant a retry can be admitted. The runtime maps this to HTTP
 * and to sync scheduling; this package stays free of those concerns.
 */
export class OfapiCollectionPolicyError extends Error {
  readonly code: string;
  readonly retryAt: Date | null;
  constructor(readonly reason: string, options?: { retryAt?: Date | null }) {
    super(`OFAPI collection policy: ${reason}`);
    this.name = "OfapiCollectionPolicyError";
    this.code = `ofapi_collection_${reason}`;
    this.retryAt = options?.retryAt ?? null;
  }
}
interface State extends Record<string, unknown> { revision: number; background_paused: boolean }
interface PolicyRow extends Record<string, unknown> { page_id: string | number | null; category: OfapiCollectionCategory; settings: OfapiCollectionSettings; revision: number }
export interface OfapiCollectionChange { expectedRevision: number; changes: OfapiCollectionSettings[]; backgroundPaused?: boolean | undefined }
export interface OfapiCollectionJobInput {
  expectedRevision: number; pageId: number; category: OfapiCollectionCategory; maxCredits: number; maxCalls: number; maxBytes: number;
  from: string | null; to: string | null; selection: string[];
}
const baselineSettings = (category: OfapiCollectionCategory, pageId: number | null): OfapiCollectionSettings => ({
  pageId, category, mode: OFAPI_COLLECTION_REGISTRY.find(row => row.id === category)!.baseline ? "scheduled" : "off",
  intervalMinutes: 1440, dailyCreditLimit: 200, maxCallsPerRun: 10, includeDetails: false,
});
async function state(db: Database, lock = false): Promise<State> {
  const result = await db.execute<State>(sql`select revision,background_paused from ofapi_collection_state where id=1 ${lock ? sql`for update` : sql``}`);
  if (!result.rows[0]) throw new OfapiCollectionPolicyError("state_unavailable");
  return result.rows[0];
}
async function pageExists(db: Database, pageId: number) {
  const result = await db.execute(sql`select id from pages where id=${pageId} and platform='onlyfans' and deleted_at is null`);
  if (!result.rows[0]) throw new OfapiCollectionPolicyError("page_unavailable");
}
async function effective(db: Database, category: OfapiCollectionCategory, pageId: number, current: State) {
  const rows = await db.execute<PolicyRow>(sql`select page_id,category,settings,revision from ofapi_collection_policies
    where category=${category} and scope_key in ('default',${`page:${pageId}`}) order by page_id nulls last limit 1`);
  const row = rows.rows[0];
  const settings = row?.settings ?? baselineSettings(category, pageId);
  if (!OFAPI_COLLECTION_REGISTRY.find(item => item.id === category)?.modes.some(mode => mode === settings.mode)) throw new OfapiCollectionPolicyError("invalid_policy");
  if (!Number.isSafeInteger(settings.dailyCreditLimit) || settings.dailyCreditLimit < 1 || !Number.isSafeInteger(settings.maxCallsPerRun) || settings.maxCallsPerRun < 1 || !Number.isSafeInteger(settings.intervalMinutes) || settings.intervalMinutes < 15 || typeof settings.includeDetails !== "boolean") throw new OfapiCollectionPolicyError("invalid_policy");
  return { ...settings, pageId, revision: current.revision, source: row ? row.page_id === null ? "default" as const : "page" as const
    : settings.mode === "off" ? "default_off" as const : "legacy_baseline" as const,
    state: row ? "applied" as const : "baseline" as const, backgroundPaused: current.background_paused };
}
export async function getEffectiveOfapiCollectionPolicy(db: Database, category: OfapiCollectionCategory, pageId: number) {
  return effective(db, category, pageId, await state(db));
}
export async function assertOfapiCollectionAllowed(db: Database, input: Omit<OfapiCollectionAdmissionInput, "requestId">) {
  const classification = classifyOfapiCollectionOperation(input.operation);
  if (classification === "command" || (classification === "diagnostic" && input.context?.purpose !== "one_off")) return;
  const category = input.context?.category ?? (classification === "diagnostic" ? null : classification);
  if (!category) throw new OfapiCollectionPolicyError("unregistered_operation");
  const policy = await getEffectiveOfapiCollectionPolicy(db, category, input.pageId);
  const purpose = input.context?.purpose ?? input.purpose ?? "background";
  if (purpose !== "interactive" && policy.backgroundPaused) throw new OfapiCollectionPolicyError("background_paused");
  if (purpose === "one_off") {
    const jobId = input.context?.jobId;
    const job = jobId ? await getOfapiCollectionJob(db, jobId) : null;
    if (!job || Number(job.page_id) !== input.pageId || job.category !== category || !["queued", "running"].includes(job.state)) {
      throw new OfapiCollectionPolicyError("job_unavailable");
    }
    return; // Physical reservation repeats this check and atomically enforces the allowance.
  }
  const legacy = !input.context && ["legacy_baseline", "default_off"].includes(policy.source) && OFAPI_COLLECTION_LEGACY_OPERATIONS.some(operation => operation === input.operation);
  if (policy.mode === "off" && !legacy) throw new OfapiCollectionPolicyError("collection_off");
  if (purpose === "background" && policy.mode !== "scheduled" && !legacy) throw new OfapiCollectionPolicyError("on_demand_only");
}
async function validateChanges(db: Database, input: OfapiCollectionChange, current: State) {
  if (input.expectedRevision !== current.revision) throw new OfapiCollectionPolicyError("revision_conflict");
  const keys = new Set<string>();
  const enabled = new Set<string>();
  for (const change of input.changes) {
    const key = `${change.pageId ?? "default"}:${change.category}`;
    if (keys.has(key)) throw new OfapiCollectionPolicyError("duplicate_change");
    keys.add(key);
    const descriptor = OFAPI_COLLECTION_REGISTRY.find(row => row.id === change.category);
    if (!descriptor?.modes.some(mode => mode === change.mode)) throw new OfapiCollectionPolicyError("unsupported_mode");
    if (change.pageId !== null) await pageExists(db, change.pageId);
    if (!Number.isSafeInteger(change.dailyCreditLimit) || change.dailyCreditLimit < 1 || !Number.isSafeInteger(change.maxCallsPerRun) || change.maxCallsPerRun < 1 || change.intervalMinutes < 15) throw new OfapiCollectionPolicyError("invalid_limits");
    if (change.mode !== "off") enabled.add(change.category);
  }
  if (enabled.size > 1) throw new OfapiCollectionPolicyError("enable_one_category_at_a_time");
}
export async function previewOfapiCollectionPolicy(db: Database, input: OfapiCollectionChange) {
  const current = await state(db);
  await validateChanges(db, input, current);
  const pending = await db.execute<{ count: string }>(sql`select count(*)::text count from ofapi_collection_requests where state='reserved'`);
  return { revision: current.revision, changes: input.changes, backgroundPaused: input.backgroundPaused ?? current.background_paused,
    cost: { source: "unknown" as const, estimatedCredits: null, maximumNewCreditsPerDay: input.changes.filter(row => row.mode === "scheduled").reduce((sum, row) => sum + row.dailyCreditLimit, 0) },
    consequences: ["Already received facts and checkpoints are retained.", "Accepted exports/uploads and incoming webhooks may still charge after a pause.", "Limits bound new managed requests; vendor price and external spend remain separate.", ...input.changes.filter(row => row.mode === "off").map(row => `${row.category}: saved data remains readable; new refreshes stop.`)], inFlight: Number(pending.rows[0]?.count ?? 0) };
}
export async function applyOfapiCollectionPolicy(db: Database, input: OfapiCollectionChange, actorUserId: number) {
  return db.transaction(async tx => {
    const database = tx as unknown as Database;
    const current = await state(database, true);
    await validateChanges(database, input, current);
    const revision = current.revision + 1;
    for (const change of input.changes.filter(row => row.mode === "off")) {
      await database.execute(sql`update ofapi_collection_jobs set state='paused',reason='category_disabled',updated_at=now()
        where category=${change.category} and state in ('queued','running') ${change.pageId === null ? sql`` : sql`and page_id=${change.pageId}`}`);
    }
    for (const change of input.changes) await database.execute(sql`insert into ofapi_collection_policies(scope_key,category,page_id,settings,revision,actor_user_id)
      values(${change.pageId === null ? "default" : `page:${change.pageId}`},${change.category},${change.pageId},${JSON.stringify(change)}::jsonb,${revision},${actorUserId})
      on conflict(scope_key,category) do update set settings=excluded.settings,revision=excluded.revision,actor_user_id=excluded.actor_user_id,updated_at=now()`);
    await database.execute(sql`update ofapi_collection_state set revision=${revision},background_paused=${input.backgroundPaused ?? current.background_paused},updated_at=now() where id=1`);
    await database.execute(sql`insert into ofapi_collection_audit(revision,actor_user_id,changes) values(${revision},${actorUserId},${JSON.stringify(input)}::jsonb)`);
    // Decision 43: every owner-console mutation also lands in the append-only
    // audit_events trail, in the same transaction, as scalars only — the full
    // change body stays in ofapi_collection_audit under the same revision.
    for (const change of input.changes) {
      await insertAuditEvent(database, { actorUserId, source: "api", eventType: "admin.ofapi_collection_policy_applied", platformAccountId: change.pageId,
        metadata: { revision, pageId: change.pageId, category: change.category, mode: change.mode, action: "apply" } });
    }
    if (input.backgroundPaused !== undefined && input.backgroundPaused !== current.background_paused) {
      await insertAuditEvent(database, { actorUserId, source: "api", eventType: input.backgroundPaused ? "admin.ofapi_collection_background_paused" : "admin.ofapi_collection_background_resumed",
        metadata: { revision, action: input.backgroundPaused ? "background_pause" : "background_resume" } });
    } else if (input.changes.length === 0) {
      await insertAuditEvent(database, { actorUserId, source: "api", eventType: "admin.ofapi_collection_policy_applied", metadata: { revision, action: "apply" } });
    }
    // A revision may have lifted the cause of a sync stream this policy parked
    // (blocker ofapi_collection_<reason>) or put to sleep until a cap resets
    // (retry class ofapi_collection_policy): wake them so the change takes
    // effect on the next scheduler pass, not at midnight or after an
    // operator's unblock. A cause that persists re-parks the stream on its
    // next run — the refusal is local and costs no vendor call.
    await database.execute(sql`update page_sync_states set status=case when request_seq>applied_seq then 'pending'::page_sync_status else 'idle'::page_sync_status end,
      retry_kind=null,retry_at=null,blocker_kind=null,blocker_code=null,blocker_message=null,blocked_at=null,updated_at=now()
      where status='blocked' and blocker_kind='manual_action_required' and blocker_code like 'ofapi\\_collection\\_%'`);
    await database.execute(sql`update page_sync_states set retry_at=now(),updated_at=now() where status='retrying' and retry_kind='ofapi_collection_policy'`);
    return { revision, state: "applied" as const };
  });
}
export async function createOfapiCollectionJob(db: Database, input: OfapiCollectionJobInput, actorUserId: number) {
  return db.transaction(async tx => {
    const database = tx as unknown as Database;
    const current = await state(database, true);
    if (current.revision !== input.expectedRevision) throw new OfapiCollectionPolicyError("revision_conflict");
    await pageExists(database, input.pageId);
    if (!OFAPI_COLLECTION_REGISTRY.some(row => row.id === input.category) || [input.maxCredits, input.maxCalls, input.maxBytes].some(value => !Number.isSafeInteger(value) || value < 1)) throw new OfapiCollectionPolicyError("invalid_job_limits");
    if (input.from && input.to && new Date(input.from) >= new Date(input.to)) throw new OfapiCollectionPolicyError("invalid_window");
    if (input.category === "vault_files" && input.selection.length === 0) throw new OfapiCollectionPolicyError("file_selection_required");
    const id = randomUUID();
    await database.execute(sql`insert into ofapi_collection_jobs(id,page_id,category,policy_revision,actor_user_id,max_credits,max_calls,max_bytes,target)
      values(${id}::uuid,${input.pageId},${input.category},${current.revision},${actorUserId},${input.maxCredits},${input.maxCalls},${input.maxBytes},${JSON.stringify({ from: input.from, to: input.to, selection: input.selection })}::jsonb)`);
    return { id, state: "queued" as const };
  });
}
export async function resumeOfapiCollectionJob(db: Database, id: string, expectedRevision: number, actorUserId: number) {
  return db.transaction(async tx => {
    const database = tx as unknown as Database;
    const current = await state(database, true);
    if (current.revision !== expectedRevision) throw new OfapiCollectionPolicyError("revision_conflict");
    if (current.background_paused) throw new OfapiCollectionPolicyError("background_paused");
    const candidate = await getOfapiCollectionJob(database, id);
    if (!candidate || candidate.state !== "paused") throw new OfapiCollectionPolicyError("job_not_resumable");
    const hasAllowance = Number(candidate.used_credits) < Number(candidate.max_credits)
      && candidate.used_calls < candidate.max_calls && Number(candidate.used_bytes) < Number(candidate.max_bytes);
    if (!hasAllowance && !await hasCapturedCollectionCheckpoint(database, candidate)) {
      throw new OfapiCollectionPolicyError("job_not_resumable");
    }
    const resumed = await database.execute<{ id: string; page_id: string | number; category: OfapiCollectionCategory }>(sql`update ofapi_collection_jobs set state='queued',reason=null,policy_revision=${current.revision + 1},updated_at=now()
      where id=${id}::uuid and state='paused' returning id,page_id,category`);
    const job = resumed.rows[0];
    if (!job) throw new OfapiCollectionPolicyError("job_not_resumable");
    await database.execute(sql`update ofapi_collection_state set revision=revision+1,updated_at=now() where id=1`);
    await database.execute(sql`insert into ofapi_collection_audit(revision,actor_user_id,changes) values(${current.revision + 1},${actorUserId},${JSON.stringify({ jobId: id, action: "resume_checkpoint" })}::jsonb)`);
    await insertAuditEvent(database, { actorUserId, source: "api", eventType: "admin.ofapi_collection_job_resumed", platformAccountId: Number(job.page_id),
      metadata: { revision: current.revision + 1, jobId: id, pageId: Number(job.page_id), category: job.category, action: "resume_checkpoint" } });
    return { id, state: "queued" as const, revision: current.revision + 1 };
  });
}

/** Uses the outer row alias `job`; a policy pause may still have an in-flight worker. */
function finishableReadJob() {
  return sql`job.state='paused' and job.purpose='background'
    and job.category in (${sql.join(OFAPI_SCHEDULED_READ_COLLECTION_CATEGORIES.map(category => sql`${category}`), sql`,`)})
    and coalesce(job.target->>'executor','read')='read'
    and (job.lease_until is null or job.lease_until<=now())
    and not exists(select 1 from ofapi_capture_jobs capture join ofapi_request_attempts attempt on attempt.capture_job_id=capture.id
      where capture.kind='collection_read' and capture.page_id=job.page_id
        and capture.target->>'collectionJobId'=job.id::text and attempt.state in ('reserved','dispatching'))`;
}

/** Owner closes incomplete periodic work locally; all captured facts and uncertain charges remain authoritative. */
export async function finishIncompleteOfapiCollectionJob(db: Database, input: {
  id: string; pageId: number; expectedRevision: number; expectedState: "paused"; reason: string;
}, actorUserId: number) {
  return db.transaction(async tx => {
    const database = tx as unknown as Database;
    const current = await state(database, true);
    if (current.revision !== input.expectedRevision) throw new OfapiCollectionPolicyError("revision_conflict");
    if (input.expectedState !== "paused" || !input.reason.trim() || input.reason.length > 500)
      throw new OfapiCollectionPolicyError("invalid_finish_request");
    await pageExists(database, input.pageId);
    const candidate = await database.execute<{ id: string; category: OfapiCollectionCategory; reason: string | null }>(sql`
      select job.id,job.category,job.reason from ofapi_collection_jobs job
      where job.id=${input.id}::uuid and job.page_id=${input.pageId} and ${finishableReadJob()} for update of job`);
    const job = candidate.rows[0];
    if (!job) throw new OfapiCollectionPolicyError("job_not_finishable");
    const revision = current.revision + 1;
    await database.execute(sql`update ofapi_collection_jobs set state='failed',reason='owner_finished_incomplete',
      lease_token=null,lease_until=null,updated_at=now() where id=${input.id}::uuid and state=${input.expectedState}`);
    await database.execute(sql`update ofapi_collection_state set revision=${revision},updated_at=now() where id=1`);
    await database.execute(sql`insert into ofapi_collection_audit(revision,actor_user_id,changes)
      values(${revision},${actorUserId},${JSON.stringify({ jobId: input.id, pageId: input.pageId, action: "finish_incomplete", previousReason: job.reason, reason: input.reason.trim() })}::jsonb)`);
    await insertAuditEvent(database, { actorUserId, source: "api", eventType: "admin.ofapi_collection_job_finished_incomplete", platformAccountId: input.pageId,
      metadata: { revision, jobId: input.id, pageId: input.pageId, category: job.category, action: "finish_incomplete" } });
    return { id: input.id, state: "failed" as const, revision };
  });
}

/** Exhausted work can finish an already paid current step; this grants no new allowance. */
async function hasCapturedCollectionCheckpoint(db: Database, job: NonNullable<Awaited<ReturnType<typeof getOfapiCollectionJob>>>) {
  const checkpoint = job.checkpoint;
  const index = Number(checkpoint.index ?? 0);
  const step = Array.isArray(checkpoint.plan) && Number.isSafeInteger(index) && index >= 0 ? checkpoint.plan[index] : null;
  if (!step || typeof step !== "object" || Array.isArray(step)) return false;
  const query = checkpoint.nextQuery ?? step.query;
  if (!query || typeof query !== "object" || Array.isArray(query)) return false;
  const binding = await db.execute<{ ofapi_account_id: string | null }>(sql`select ofapi_account_id from pages where id=${Number(job.page_id)} and deleted_at is null`);
  const accountId = binding.rows[0]?.ofapi_account_id;
  if (!accountId) return false;
  const retained = await findOfapiCollectionCaptureJob(db, {
    pageId: Number(job.page_id), ofapiAccountId: accountId, collectionJobId: job.id,
    targetHash: hashOfapiCaptureValue({ ...step, query, collectionJobId: job.id }),
  });
  return Boolean(retained && (retained.pendingObservationId || retained.state === "complete"));
}

export interface OfapiCollectionAdmissionInput {
  operation: string; pageId: number; requestId: string; context?: OfapiCollectionContext; purpose?: "background" | "interactive";
  reservedCredits?: number; now?: Date;
}
/** Atomic at physical dispatch: separate background budget cannot consume interactive allowance. */
export async function reserveOfapiCollectionRequest(db: Database, input: OfapiCollectionAdmissionInput) {
  const classification = classifyOfapiCollectionOperation(input.operation);
  if (classification === "command" || (classification === "diagnostic" && input.context?.purpose !== "one_off")) return;
  const category = input.context?.category ?? (classification === "diagnostic" ? null : classification);
  if (!category) throw new OfapiCollectionPolicyError("unregistered_operation");
  const purpose = input.context?.purpose ?? input.purpose ?? "background";
  const now = input.now ?? new Date();
  const freeExportOperation = ["ofapi_export_quote_create", "ofapi_export_quote_status", "ofapi_upload_status"].includes(input.operation);
  const registeredFreeRead = findOfapiReadDefinition(input.operation)?.reservedCredits === 0;
  const estimate = Math.max(freeExportOperation || registeredFreeRead ? 0 : 1, Math.trunc(input.reservedCredits ?? 1));
  return db.transaction(async tx => {
    const database = tx as unknown as Database;
    const current = await state(database, true);
    const existing = await database.execute(sql`select request_id from ofapi_collection_requests where request_id=${input.requestId}`);
    if (existing.rows[0]) throw new OfapiCollectionPolicyError("request_already_reserved");
    const policy = await effective(database, category, input.pageId, current);
    if (purpose !== "interactive" && current.background_paused) throw new OfapiCollectionPolicyError("background_paused");
    const legacy = !input.context && (policy.source === "legacy_baseline" || policy.source === "default_off") && OFAPI_COLLECTION_LEGACY_OPERATIONS.some(operation => operation === input.operation);
    if (input.context?.detail && !policy.includeDetails && purpose !== "one_off") throw new OfapiCollectionPolicyError("detail_disabled");
    if (purpose === "one_off" || input.context?.jobId) {
      if (!input.context?.jobId) throw new OfapiCollectionPolicyError("bounded_job_required");
      const job = await database.execute<{ page_id: number | string; category: string; state: string; max_credits: string; used_credits: string; max_calls: number; used_calls: number; max_bytes: string; used_bytes: string }>(sql`select * from ofapi_collection_jobs where id=${input.context.jobId}::uuid for update`);
      const row = job.rows[0];
      if (!row || Number(row.page_id) !== input.pageId || row.category !== category || !["queued", "running"].includes(row.state)) throw new OfapiCollectionPolicyError("job_unavailable");
      if (Number(row.used_credits) + estimate > Number(row.max_credits) || row.used_calls + 1 > row.max_calls || Number(row.used_bytes) >= Number(row.max_bytes)) throw new OfapiCollectionPolicyError("job_limit");
      await database.execute(sql`update ofapi_collection_jobs set state='running',used_credits=used_credits+${estimate},used_calls=used_calls+1,updated_at=${now} where id=${input.context.jobId}::uuid`);
    }
    if (purpose !== "one_off") {
      if (policy.mode === "off" && !legacy) throw new OfapiCollectionPolicyError("collection_off");
      if (purpose === "background" && policy.mode !== "scheduled" && !legacy) throw new OfapiCollectionPolicyError("on_demand_only");
    }
    const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
    const usage = await database.execute<{ credits: string; calls: string; latest: Date | null }>(sql`select coalesce(sum(greatest(reserved_credits,coalesce(actual_credits,0))),0)::text credits,count(*)::text calls,max(created_at) latest
      from ofapi_collection_requests where state<>'released' and page_id=${input.pageId} and category=${category} and purpose=${purpose} and created_at>=${dayStart}`);
    const consumed = usage.rows[0]!;
    // The existing working baseline keeps its existing budget authority until explicitly migrated.
    if (purpose !== "one_off" && policy.source !== "legacy_baseline" && !legacy && Number(consumed.credits) + estimate > policy.dailyCreditLimit) {
      // The daily budget is counted per UTC day: it clears at the next rollover.
      const nextDay = new Date(dayStart); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      throw new OfapiCollectionPolicyError("daily_limit", { retryAt: nextDay });
    }
    if (purpose === "background" && policy.source !== "legacy_baseline" && !legacy) {
      const windowStart = new Date(now.getTime() - policy.intervalMinutes * 60_000);
      const recent = await database.execute<{ count: string; oldest: Date | string | null }>(sql`select count(*)::text count,min(created_at) oldest from ofapi_collection_requests where state<>'released' and page_id=${input.pageId} and category=${category} and purpose='background' and created_at>${windowStart}`);
      if (Number(recent.rows[0]?.count ?? 0) >= policy.maxCallsPerRun) {
        // The sliding window reopens when its oldest counted request ages out.
        const oldest = recent.rows[0]?.oldest ? new Date(recent.rows[0].oldest) : now;
        throw new OfapiCollectionPolicyError("interval_limit", { retryAt: new Date(oldest.getTime() + policy.intervalMinutes * 60_000 + 1_000) });
      }
    }
    await database.execute(sql`insert into ofapi_collection_requests(request_id,page_id,category,purpose,operation,policy_revision,job_id,reserved_credits,created_at)
      values(${input.requestId},${input.pageId},${category},${purpose},${input.operation},${current.revision},${input.context?.jobId ?? null}::uuid,${estimate},${now})`);
  });
}
export async function settleOfapiCollectionRequest(db: Database, requestId: string, actualCredits: number | null) {
  if (actualCredits !== null && (!Number.isSafeInteger(actualCredits) || actualCredits < 0)) throw new OfapiCollectionPolicyError("invalid_credits");
  await db.transaction(async tx => {
    const database = tx as unknown as Database;
    // Async exports replace start estimates with terminal vendor billing. Replays
    // must not double charge, and an unknown response cannot erase actual evidence.
    const result = await database.execute<{ job_id: string | null; reserved_credits: string; actual_credits: string | null }>(sql`select job_id,reserved_credits,actual_credits from ofapi_collection_requests
      where request_id=${requestId} and state<>'released' for update`);
    const row = result.rows[0]; if (!row) return;
    const actual = actualCredits ?? (row.actual_credits === null ? null : Number(row.actual_credits));
    await database.execute(sql`update ofapi_collection_requests set actual_credits=${actual},state='captured',captured_at=coalesce(captured_at,now()) where request_id=${requestId}`);
    const delta = Math.max(Number(row.reserved_credits), actual ?? 0) - Math.max(Number(row.reserved_credits), Number(row.actual_credits ?? 0));
    if (row.job_id && delta !== 0) await database.execute(sql`update ofapi_collection_jobs set used_credits=used_credits+${delta},updated_at=now() where id=${row.job_id}::uuid`);
  });
}
/**
 * Re-settles one interactive request to an exact figure: a desktop media click
 * of unknown size is reserved at its guard price and settled to what its
 * transfer report shows. Lowers the reservation to the figure and records it
 * as actual, so the day's usage (greatest of the two) counts exactly it.
 */
export async function resettleOfapiCollectionRequest(db: Database, requestId: string, credits: number) {
  if (!Number.isSafeInteger(credits) || credits < 0) throw new OfapiCollectionPolicyError("invalid_credits");
  await db.execute(sql`update ofapi_collection_requests set reserved_credits=least(reserved_credits,${credits}),
    actual_credits=${credits},state='captured',captured_at=coalesce(captured_at,now())
    where request_id=${requestId} and state<>'released' and job_id is null`);
}
/**
 * The admission check of one interactive request, without reserving: throws
 * the refusal `reserveOfapiCollectionRequest` would give (category off, daily
 * credit limit), so a caller can stop before any network call.
 */
export async function assertOfapiCollectionHeadroom(db: Database, input: {
  pageId: number; category: OfapiCollectionCategory; credits: number; now?: Date;
}) {
  const now = input.now ?? new Date();
  const policy = await effective(db, input.category, input.pageId, await state(db));
  if (policy.mode === "off") throw new OfapiCollectionPolicyError("collection_off");
  if (policy.source === "legacy_baseline") return;
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const usage = await db.execute<{ credits: string }>(sql`select coalesce(sum(greatest(reserved_credits,coalesce(actual_credits,0))),0)::text credits
    from ofapi_collection_requests where state<>'released' and page_id=${input.pageId} and category=${input.category} and purpose='interactive' and created_at>=${dayStart}`);
  if (Number(usage.rows[0]?.credits ?? 0) + Math.max(0, Math.trunc(input.credits)) > policy.dailyCreditLimit) {
    const nextDay = new Date(dayStart); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    throw new OfapiCollectionPolicyError("daily_limit", { retryAt: nextDay });
  }
}
export async function releaseOfapiCollectionRequest(db: Database, requestId: string) {
  await db.transaction(async tx => {
    const database = tx as unknown as Database;
    const result = await database.execute<{ job_id: string | null; reserved_credits: string }>(sql`update ofapi_collection_requests set state='released'
      where request_id=${requestId} and state='reserved' returning job_id,reserved_credits`);
    const row = result.rows[0];
    if (row?.job_id) await database.execute(sql`update ofapi_collection_jobs set used_credits=used_credits-${Number(row.reserved_credits)},used_calls=used_calls-1,updated_at=now() where id=${row.job_id}::uuid`);
  });
}
export async function updateOfapiCollectionJob(db: Database, id: string, input: { state: "running" | "paused" | "completed" | "failed"; checkpoint?: Record<string, unknown>; bytesAdded?: number; reason?: string | null }) {
  const bytes = input.bytesAdded ?? 0;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new OfapiCollectionPolicyError("invalid_bytes");
  // Paid, captured results survive limits. Their measured overage is visible; the next dispatch refuses.
  await db.execute(sql`update ofapi_collection_jobs set state=${input.state},checkpoint=coalesce(${input.checkpoint ? JSON.stringify(input.checkpoint) : null}::jsonb,checkpoint),used_bytes=used_bytes+${bytes},reason=${input.reason ?? null},updated_at=now() where id=${id}::uuid`);
}
export async function getOfapiCollectionJob(db: Database, id: string) {
  const row = await db.execute<{ id: string; page_id: string; category: OfapiCollectionCategory; state: string; purpose: "one_off" | "background"; actor_user_id: string; max_credits: string; max_calls: number; max_bytes: string; used_credits: string; used_calls: number; used_bytes: string; target: { from: string | null; to: string | null; selection: string[] }; checkpoint: Record<string, unknown> }>(sql`select * from ofapi_collection_jobs where id=${id}::uuid`);
  return row.rows[0] ?? null;
}
export async function listPendingOfapiCollectionJobs(db: Database) {
  const rows = await db.execute<{ id: string }>(sql`select id from ofapi_collection_jobs where state in ('queued','running') and coalesce(target->>'executor','read')='read' order by created_at limit 20`);
  return rows.rows;
}

/** The runner's reason when a cap ends a scheduled run (`scheduled_run_exhausted:job_limit`, …). */
const SCHEDULED_RUN_EXHAUSTED_PREFIX = "scheduled_run_exhausted:";
/** A background run as the collection screen and the stale check describe it. */
export interface OfapiCollectionRunSummary {
  id: string;
  state: string;
  reason: string | null;
  /** The cap that ended a scheduled run: `job_limit` (calls per run), `daily_limit`, `interval_limit`. */
  exhaustedLimit: string | null;
  usedCalls: number;
  maxCalls: number;
  usedCredits: number;
  maxCredits: number;
  /** Steps of the frozen plan read to the end, and the plan's length; null before a plan was frozen. */
  stepsDone: number | null;
  stepsTotal: number | null;
  createdAt: string;
  updatedAt: string;
}
export interface OfapiCollectionScheduleHealth {
  /** The policy promises completed runs: a scheduled read category with planned reads, background not paused. */
  expected: boolean;
  /** No scheduled run completed for more than two intervals (traffic plan §2.8 п. 3). */
  stale: boolean;
  /** When the category is, or will be, stale unless a scheduled run completes first. */
  staleAt: string | null;
  lastCompletedAt: string | null;
  lastRun: OfapiCollectionRunSummary | null;
}

/**
 * A category is expected to complete on schedule only where the read scheduler
 * creates its runs: a non-baseline scheduled read category whose run has
 * something to read. Visitors plan their own daily window; every other read
 * category plans the catalog reads marked for scheduled collection, so a
 * category whose catalog has none (Smart Links after their freeze, §2.9) is
 * never called stale.
 */
function hasScheduledReads(category: OfapiCollectionCategory) {
  return category === "visitors" || OFAPI_READ_CATALOG.some(row => row.category === category && row.defaultCollect);
}
export function isOfapiCollectionScheduleExpected(input: { category: OfapiCollectionCategory; mode: OfapiCollectionMode; backgroundPaused: boolean }) {
  return input.mode === "scheduled" && !input.backgroundPaused
    && OFAPI_SCHEDULED_READ_COLLECTION_CATEGORIES.includes(input.category)
    && !OFAPI_COLLECTION_REGISTRY.find(row => row.id === input.category)?.baseline
    && hasScheduledReads(input.category);
}
/**
 * Stale: no scheduled run of the page and category completed for more than two
 * intervals, counted from the later of its last completed run and the owner's
 * last change of its policy (a changed cap or a re-enabled schedule gets two
 * fresh intervals). Pure; the snapshot and the minutely stale check share it.
 */
export function judgeOfapiCollectionSchedule(input: {
  category: OfapiCollectionCategory; mode: OfapiCollectionMode; intervalMinutes: number; backgroundPaused: boolean;
  lastCompletedAt: Date | null; policyChangedAt: Date | null; lastRun: OfapiCollectionRunSummary | null; now: Date;
}): OfapiCollectionScheduleHealth {
  const expected = isOfapiCollectionScheduleExpected(input);
  const reference = Math.max(input.lastCompletedAt?.getTime() ?? 0, input.policyChangedAt?.getTime() ?? 0);
  const staleAt = expected && reference > 0 ? new Date(reference + 2 * input.intervalMinutes * 60_000) : null;
  return {
    expected,
    stale: staleAt !== null && input.now.getTime() > staleAt.getTime(),
    staleAt: staleAt?.toISOString() ?? null,
    lastCompletedAt: input.lastCompletedAt?.toISOString() ?? null,
    lastRun: input.lastRun,
  };
}
interface RunRow extends Record<string, unknown> {
  id: string; page_id: string; category: OfapiCollectionCategory; state: string; reason: string | null;
  used_calls: number; max_calls: number; used_credits: string; max_credits: string;
  steps_done: number | null; steps_total: number | null; created_at: Date; updated_at: Date;
}
/** The frozen plan's progress, read from the checkpoint the runner keeps (`plan`, `index`). */
const RUN_PROGRESS_COLUMNS = sql`case when jsonb_typeof(job.checkpoint->'plan')='array' then jsonb_array_length(job.checkpoint->'plan') end as steps_total,
  case when jsonb_typeof(job.checkpoint->'plan')='array' then case when jsonb_typeof(job.checkpoint->'index')='number' then (job.checkpoint->>'index')::numeric::int else 0 end end as steps_done`;
function runSummary(row: RunRow): OfapiCollectionRunSummary {
  return {
    id: row.id, state: row.state, reason: row.reason,
    exhaustedLimit: row.reason?.startsWith(SCHEDULED_RUN_EXHAUSTED_PREFIX) ? row.reason.slice(SCHEDULED_RUN_EXHAUSTED_PREFIX.length) : null,
    usedCalls: row.used_calls, maxCalls: row.max_calls, usedCredits: Number(row.used_credits), maxCredits: Number(row.max_credits),
    stepsDone: row.steps_done === null ? null : Number(row.steps_done), stepsTotal: row.steps_total === null ? null : Number(row.steps_total),
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  };
}
/** Per page and category: the last completed scheduled run, the newest settled
 * scheduled run (completed, failed or paused; an in-progress one only when
 * there is none, so the cause stays put while the next run is under way) and
 * the policy's last change. */
async function loadScheduleFacts(db: Database, pageIds: number[]) {
  const key = (pageId: number | string, category: string) => `${Number(pageId)}:${category}`;
  const lastCompleted = new Map<string, Date>(), lastRun = new Map<string, OfapiCollectionRunSummary>(), policyChanged = new Map<string, Date>();
  if (pageIds.length === 0) return { key, lastCompleted, lastRun, policyChanged };
  const ids = sql.join(pageIds.map(id => sql`${id}`), sql`,`);
  const completed = await db.execute<{ page_id: string; category: string; last_completed_at: Date }>(sql`
    select page_id,category,max(updated_at) last_completed_at from ofapi_collection_jobs
    where purpose='background' and state='completed' and page_id in (${ids}) group by page_id,category`);
  for (const row of completed.rows) lastCompleted.set(key(row.page_id, row.category), new Date(row.last_completed_at));
  const runs = await db.execute<RunRow>(sql`
    select distinct on (job.page_id,job.category) job.id,job.page_id,job.category,job.state,job.reason,job.used_calls,job.max_calls,
      job.used_credits::text used_credits,job.max_credits::text max_credits,job.created_at,job.updated_at,${RUN_PROGRESS_COLUMNS}
    from ofapi_collection_jobs job where job.purpose='background' and job.page_id in (${ids})
    order by job.page_id,job.category,(job.state in ('queued','running')),job.created_at desc,job.id`);
  for (const row of runs.rows) lastRun.set(key(row.page_id, row.category), runSummary(row));
  const policies = await db.execute<{ page_id: string | null; category: string; updated_at: Date }>(sql`
    select page_id,category,updated_at from ofapi_collection_policies where page_id is null or page_id in (${ids})`);
  const defaults = new Map(policies.rows.filter(row => row.page_id === null).map(row => [row.category, new Date(row.updated_at)]));
  for (const pageId of pageIds) for (const [category, at] of defaults) policyChanged.set(key(pageId, category), at);
  for (const row of policies.rows) if (row.page_id !== null) policyChanged.set(key(row.page_id, row.category), new Date(row.updated_at));
  return { key, lastCompleted, lastRun, policyChanged };
}
/**
 * The minutely stale check's input: every expected (page, category) of the
 * OnlyFans pages, judged by `judgeOfapiCollectionSchedule`.
 */
export async function listOfapiCollectionScheduleHealth(db: Database, now = new Date()) {
  const current = await state(db);
  const pages = (await db.execute<{ id: string; label: string }>(sql`select id,label from pages where platform='onlyfans' and deleted_at is null order by label`)).rows
    .map(row => ({ id: Number(row.id), label: row.label }));
  const facts = await loadScheduleFacts(db, pages.map(page => page.id));
  const result: Array<{ pageId: number; pageLabel: string; category: OfapiCollectionCategory; health: OfapiCollectionScheduleHealth }> = [];
  for (const page of pages) for (const category of OFAPI_SCHEDULED_READ_COLLECTION_CATEGORIES) {
    const policy = await effective(db, category, page.id, current);
    const k = facts.key(page.id, category);
    const health = judgeOfapiCollectionSchedule({ ...policy, category, now,
      lastCompletedAt: facts.lastCompleted.get(k) ?? null, policyChangedAt: facts.policyChanged.get(k) ?? null, lastRun: facts.lastRun.get(k) ?? null });
    if (health.expected) result.push({ pageId: page.id, pageLabel: page.label, category, health });
  }
  return result;
}

/** Read all diagnostics from retained local rows. Page filtering is mandatory for team leads.
 * Paused jobs come first so a parked run never falls past the hundred-row list;
 * `jobState` narrows the list so any unfinished job stays reachable. */
export async function getOfapiCollectionSnapshot(db: Database, allowedPageIds: number[] | null, selectedPageId?: number, options: { jobState?: OfapiCollectionJobStateFilter; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const current = await state(db);
  const pageRows = await db.execute<{ id: string; label: string; ofapi_account_id: string | null }>(sql`select id,label,ofapi_account_id from pages
    where platform='onlyfans' and deleted_at is null
      ${allowedPageIds === null ? sql`` : allowedPageIds.length ? sql`and id in (${sql.join(allowedPageIds.map(id => sql`${id}`), sql`,`)})` : sql`and false`}
      ${selectedPageId === undefined ? sql`` : sql`and id=${selectedPageId}`} order by label`);
  const pages = pageRows.rows.map(row => ({ id: Number(row.id), label: row.label, accountId: row.ofapi_account_id }));
  const policies = [];
  const facts = await loadScheduleFacts(db, pages.map(page => page.id));
  for (const page of pages) for (const category of OFAPI_COLLECTION_REGISTRY) {
    const policy = await effective(db, category.id, page.id, current);
    const k = facts.key(page.id, category.id);
    const scheduleHealth = judgeOfapiCollectionSchedule({ ...policy, category: category.id, now,
      lastCompletedAt: facts.lastCompleted.get(k) ?? null, policyChangedAt: facts.policyChanged.get(k) ?? null, lastRun: facts.lastRun.get(k) ?? null });
    const usage = await db.execute<{ calls: string; reserved: string; actual: string | null; month_credits: string; captured: Date | null; inflight: string }>(sql`
      select count(*) filter(where created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')::text calls,
      coalesce(sum(reserved_credits) filter(where created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),0)::text reserved,
      sum(actual_credits) filter(where created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')::text actual,
      coalesce(sum(greatest(reserved_credits,coalesce(actual_credits,0))),0)::text month_credits,max(captured_at) captured,
      count(*) filter(where state='reserved')::text inflight
      from ofapi_collection_requests where state<>'released' and page_id=${page.id} and category=${category.id} and created_at>now()-interval '30 days'`);
    const row = usage.rows[0]!;
    policies.push({ ...policy, usage: { callsToday: Number(row.calls), reservedCreditsToday: Number(row.reserved), actualCreditsToday: row.actual === null ? null : Number(row.actual), credits30d: Number(row.month_credits) }, lastCapturedAt: row.captured ? new Date(row.captured).toISOString() : null, inFlight: Number(row.inflight), scheduleHealth });
  }
  const ids = pages.map(page => page.id);
  const jobState = options.jobState === undefined ? sql``
    : options.jobState === "unfinished" ? sql`and job.state in ('queued','running','paused')` : sql`and job.state=${options.jobState}`;
  const jobs = await db.execute<{ id: string; page_id: string; category: OfapiCollectionCategory; state: string; max_credits: string; max_calls: number; max_bytes: string; used_credits: string; used_calls: number; used_bytes: string; created_at: Date; reason: string | null; can_finish_incomplete: boolean; steps_done: number | null; steps_total: number | null }>(sql`
    select job.*,(${allowedPageIds === null} and ${finishableReadJob()}) as can_finish_incomplete,${RUN_PROGRESS_COLUMNS} from ofapi_collection_jobs job
    where ${ids.length ? sql`job.page_id in (${sql.join(ids.map(id => sql`${id}`), sql`,`)})` : sql`false`} ${jobState}
    order by (job.state='paused') desc,job.created_at desc,job.id limit 100`);
  // Global mutation history reveals page names/IDs; only the owner sees it.
  const audit = allowedPageIds === null ? await db.execute<{ revision: number; actor_user_id: string; changes: unknown; created_at: Date }>(sql`select * from ofapi_collection_audit order by revision desc limit 50`) : { rows: [] };
  return { revision: current.revision, backgroundPaused: current.background_paused, catalog: OFAPI_COLLECTION_REGISTRY.map(row => ({ ...row, modes: [...row.modes] })), pages, policies,
    jobs: jobs.rows.map(row => ({ id: row.id, pageId: Number(row.page_id), category: row.category, state: row.state, maxCredits: Number(row.max_credits), maxCalls: row.max_calls, maxBytes: Number(row.max_bytes), usedCredits: Number(row.used_credits), usedCalls: row.used_calls, usedBytes: Number(row.used_bytes), createdAt: new Date(row.created_at).toISOString(), reason: row.reason, canFinishIncomplete: row.can_finish_incomplete,
      stepsDone: row.steps_done === null ? null : Number(row.steps_done), stepsTotal: row.steps_total === null ? null : Number(row.steps_total) })),
    audit: audit.rows.map(row => ({ revision: row.revision, actorUserId: Number(row.actor_user_id), createdAt: new Date(row.created_at).toISOString(), changes: row.changes })),
    limitDescription: "Limits apply to new managed physical requests. Vendor events, external clients, accepted operations and variable prices can charge separately. Legacy operations retain existing configuration until a category policy is applied." };
}
