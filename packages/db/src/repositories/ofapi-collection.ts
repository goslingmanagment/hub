import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { OFAPI_COLLECTION_REGISTRY, OFAPI_COLLECTION_LEGACY_OPERATIONS, classifyOfapiCollectionOperation, type OfapiCollectionCategory, type OfapiCollectionContext, type OfapiCollectionSettings } from "@agency_hub_core/shared";
import type { Database } from "../client.ts";

export class OfapiCollectionPolicyError extends Error {
  constructor(readonly reason: string) { super(`OFAPI collection policy: ${reason}`); this.name = "OfapiCollectionPolicyError"; }
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
    const resumed = await database.execute(sql`update ofapi_collection_jobs set state='queued',reason=null,policy_revision=${current.revision + 1},updated_at=now()
      where id=${id}::uuid and state='paused' and used_credits<max_credits and used_calls<max_calls and used_bytes<max_bytes returning id`);
    if (!resumed.rows[0]) throw new OfapiCollectionPolicyError("job_not_resumable");
    await database.execute(sql`update ofapi_collection_state set revision=revision+1,updated_at=now() where id=1`);
    await database.execute(sql`insert into ofapi_collection_audit(revision,actor_user_id,changes) values(${current.revision + 1},${actorUserId},${JSON.stringify({ jobId: id, action: "resume_checkpoint" })}::jsonb)`);
    return { id, state: "queued" as const, revision: current.revision + 1 };
  });
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
  const freeExportOperation = ["ofapi_export_quote_create", "ofapi_export_quote_status"].includes(input.operation);
  const estimate = Math.max(freeExportOperation ? 0 : 1, Math.trunc(input.reservedCredits ?? 1));
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
    if (purpose !== "one_off" && policy.source !== "legacy_baseline" && !legacy && Number(consumed.credits) + estimate > policy.dailyCreditLimit) throw new OfapiCollectionPolicyError("daily_limit");
    if (purpose === "background" && policy.source !== "legacy_baseline" && !legacy) {
      const windowStart = new Date(now.getTime() - policy.intervalMinutes * 60_000);
      const recent = await database.execute<{ count: string }>(sql`select count(*)::text count from ofapi_collection_requests where state<>'released' and page_id=${input.pageId} and category=${category} and purpose='background' and created_at>${windowStart}`);
      if (Number(recent.rows[0]?.count ?? 0) >= policy.maxCallsPerRun) throw new OfapiCollectionPolicyError("interval_limit");
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

/** Read all diagnostics from retained local rows. Page filtering is mandatory for team leads. */
export async function getOfapiCollectionSnapshot(db: Database, allowedPageIds: number[] | null, selectedPageId?: number) {
  const current = await state(db);
  const pageRows = await db.execute<{ id: string; label: string; ofapi_account_id: string | null }>(sql`select id,label,ofapi_account_id from pages
    where platform='onlyfans' and deleted_at is null
      ${allowedPageIds === null ? sql`` : allowedPageIds.length ? sql`and id in (${sql.join(allowedPageIds.map(id => sql`${id}`), sql`,`)})` : sql`and false`}
      ${selectedPageId === undefined ? sql`` : sql`and id=${selectedPageId}`} order by label`);
  const pages = pageRows.rows.map(row => ({ id: Number(row.id), label: row.label, accountId: row.ofapi_account_id }));
  const policies = [];
  for (const page of pages) for (const category of OFAPI_COLLECTION_REGISTRY) {
    const policy = await effective(db, category.id, page.id, current);
    const usage = await db.execute<{ calls: string; reserved: string; actual: string | null; month_credits: string; captured: Date | null; inflight: string }>(sql`
      select count(*) filter(where created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')::text calls,
      coalesce(sum(reserved_credits) filter(where created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),0)::text reserved,
      sum(actual_credits) filter(where created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')::text actual,
      coalesce(sum(greatest(reserved_credits,coalesce(actual_credits,0))),0)::text month_credits,max(captured_at) captured,
      count(*) filter(where state='reserved')::text inflight
      from ofapi_collection_requests where state<>'released' and page_id=${page.id} and category=${category.id} and created_at>now()-interval '30 days'`);
    const row = usage.rows[0]!;
    policies.push({ ...policy, usage: { callsToday: Number(row.calls), reservedCreditsToday: Number(row.reserved), actualCreditsToday: row.actual === null ? null : Number(row.actual), credits30d: Number(row.month_credits) }, lastCapturedAt: row.captured ? new Date(row.captured).toISOString() : null, inFlight: Number(row.inflight) });
  }
  const ids = pages.map(page => page.id);
  const jobs = await db.execute<{ id: string; page_id: string; category: OfapiCollectionCategory; state: string; max_credits: string; max_calls: number; max_bytes: string; used_credits: string; used_calls: number; used_bytes: string; created_at: Date; reason: string | null }>(sql`
    select * from ofapi_collection_jobs where ${ids.length ? sql`page_id in (${sql.join(ids.map(id => sql`${id}`), sql`,`)})` : sql`false`} order by created_at desc limit 100`);
  // Global mutation history reveals page names/IDs; only the owner sees it.
  const audit = allowedPageIds === null ? await db.execute<{ revision: number; actor_user_id: string; changes: unknown; created_at: Date }>(sql`select * from ofapi_collection_audit order by revision desc limit 50`) : { rows: [] };
  return { revision: current.revision, backgroundPaused: current.background_paused, catalog: OFAPI_COLLECTION_REGISTRY.map(row => ({ ...row, modes: [...row.modes] })), pages, policies,
    jobs: jobs.rows.map(row => ({ id: row.id, pageId: Number(row.page_id), category: row.category, state: row.state, maxCredits: Number(row.max_credits), maxCalls: row.max_calls, maxBytes: Number(row.max_bytes), usedCredits: Number(row.used_credits), usedCalls: row.used_calls, usedBytes: Number(row.used_bytes), createdAt: new Date(row.created_at).toISOString(), reason: row.reason })),
    audit: audit.rows.map(row => ({ revision: row.revision, actorUserId: Number(row.actor_user_id), createdAt: new Date(row.created_at).toISOString(), changes: row.changes })),
    limitDescription: "Limits apply to new managed physical requests. Vendor events, external clients, accepted operations and variable prices can charge separately. Legacy operations retain existing configuration until a category policy is applied." };
}
