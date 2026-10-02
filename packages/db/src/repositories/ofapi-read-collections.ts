import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  OFAPI_COLLECTION_REGISTRY,
  type OfapiCollectionCategory,
} from "@agency_hub_core/shared";
import type { Database } from "../client.ts";
import { getEffectiveOfapiCollectionPolicy } from "./ofapi-collection.ts";
import { isDmArchiveScopeFenced, tryAcquireDmArchiveWriterFenceLock } from "./erasure-fence.ts";

export async function claimOfapiCollectionJob(
  db: Database,
  id: string,
  now = new Date(),
) {
  const token = randomUUID();
  const result =
    await db.execute(sql`update ofapi_collection_jobs set state='running',lease_token=${token}::uuid,lease_until=${new Date(now.getTime() + 180000)},updated_at=${now}
  where id=${id}::uuid and state in ('queued','running') and coalesce(target->>'executor','read')='read'
  and (lease_until is null or lease_until<${now}) returning id`);
  return result.rows[0] ? token : null;
}
export async function checkpointOfapiCollectionJob(
  db: Database,
  input: {
    id: string;
    token: string;
    checkpoint: Record<string, unknown>;
    state: "running" | "queued" | "paused" | "failed" | "completed";
    bytesAdded?: number;
    reason?: string;
  },
) {
  const result =
    await db.execute(sql`update ofapi_collection_jobs set checkpoint=${JSON.stringify(input.checkpoint)}::jsonb,state=case when state='paused' then 'paused' else ${input.state} end,used_bytes=used_bytes+${input.bytesAdded ?? 0},
 reason=${input.reason ?? null},lease_until=case when state='paused' then null else ${input.state === "running" ? new Date(Date.now() + 180000) : null}::timestamptz end,lease_token=case when state='paused' then null else ${input.state === "running" ? input.token : null}::uuid end,updated_at=now()
 where id=${input.id}::uuid and lease_token=${input.token}::uuid and lease_until>now() returning state`);
  if (!result.rows[0]) throw new Error("Collection lease lost");
  return String((result.rows[0] as { state: string }).state);
}
export async function checkOfapiCollectionLease(
  db: Database,
  id: string,
  token: string,
) {
  const result = await db.execute(
    sql`select id from ofapi_collection_jobs where id=${id}::uuid and lease_token=${token}::uuid and lease_until>now() and state='running'`,
  );
  return Boolean(result.rows[0]);
}
export async function saveOfapiReadSnapshot(
  db: Database,
  input: {
    pageId: number;
    category: OfapiCollectionCategory;
    operation: string;
    pathname: string;
    query: Record<string, string>;
    observedAt: Date;
    observationId: number;
    observationReceivedAt: Date;
    eventId: number;
    granularity: string;
    coverage: unknown;
    items: unknown[];
  },
) {
  await db.transaction(async tx => {
    const database = tx as unknown as Database;
    if (!await tryAcquireDmArchiveWriterFenceLock(database, input.pageId)) {
      throw new Error("OFAPI read projection deferred during page erasure");
    }
    const refs = new Set<string>();
    const collectRefs = (value: unknown): void => {
      if (Array.isArray(value)) { for (const item of value) collectRefs(item); return; }
      if (!value || typeof value !== "object") return;
      for (const [key, field] of Object.entries(value)) {
        if (["fanId", "fan_id", "authorId", "userId", "user_id", "onlyfans_user_id", "onlyfansUserId"].includes(key) &&
            (typeof field === "string" || typeof field === "number" && Number.isSafeInteger(field))) refs.add(String(field));
        else if (field && typeof field === "object") collectRefs(field);
      }
    };
    collectRefs(input.items);
    if (await isDmArchiveScopeFenced(database, { pageId: input.pageId, refs: [...refs], materialAt: input.observationReceivedAt })) return;
    await database.execute(sql`insert into ofapi_read_snapshots(page_id,category,operation,pathname,query,observed_at,observation_id,observation_received_at,event_id,granularity,coverage,items)
 values(${input.pageId},${input.category},${input.operation},${input.pathname},${JSON.stringify(input.query)}::jsonb,${input.observedAt},${input.observationId},${input.observationReceivedAt},${input.eventId},${input.granularity},${JSON.stringify(input.coverage)}::jsonb,${JSON.stringify(input.items)}::jsonb)
 on conflict(page_id,observation_id) do nothing`);
  });
}
export async function readOfapiStoredSnapshots(
  db: Database,
  input: {
    pageId: number;
    operation?: string | undefined;
    limit?: number | undefined;
  },
) {
  const rows = await db.execute<{
    id: string;
    operation: string;
    category: string;
    pathname: string;
    query: Record<string, string>;
    observed_at: Date;
    observation_id: string;
    granularity: string;
    coverage: unknown;
    items: unknown[];
  }>(
    sql`select * from ofapi_read_snapshots where page_id=${input.pageId} ${input.operation ? sql`and operation=${input.operation}` : sql``} order by observed_at desc,id desc limit ${Math.min(100, Math.max(1, input.limit ?? 25))}`,
  );
  const crm = await db.execute<{
    fan_ref: string;
    last_reply_at: Date | null;
    gross_mills: string | null;
  }>(sql`
  select distinct f.platform_user_id fan_ref,t.last_fan_message_at last_reply_at,s.gross_amount_mills::text gross_mills
  from fans f left join page_dm_threads t on t.partner_platform_user_id=f.platform_user_id and t.platform_account_id=${input.pageId}
  left join fan_spend_lifetime s on s.fan_id=f.id and s.platform_account_id=${input.pageId}
  where f.platform=(select platform from pages where id=${input.pageId})
  and f.platform_user_id in (select distinct item->>'fanId' from ofapi_read_snapshots r cross join lateral jsonb_array_elements(r.items) item where r.page_id=${input.pageId} and r.id in (${
    rows.rows.length
      ? sql.join(
          rows.rows.map((row) => sql`${Number(row.id)}`),
          sql`,`,
        )
      : sql`null`
  }))`);
  const crmByRef = new Map(crm.rows.map((row) => [row.fan_ref, row]));
  return rows.rows.map((row) => ({
    id: String(row.id),
    source: "onlyfansapi" as const,
    operation: row.operation,
    category: row.category,
    pathname: row.pathname,
    query: row.query,
    window: {
      from: row.query.start_date ?? row.query.startDate ?? null,
      to: row.query.end_date ?? row.query.endDate ?? null,
    },
    observedAt: new Date(row.observed_at).toISOString(),
    ageSeconds: Math.max(
      0,
      Math.floor((Date.now() - new Date(row.observed_at).getTime()) / 1000),
    ),
    observationId: String(row.observation_id),
    granularity: row.granularity,
    coverage: row.coverage,
    items: row.items.map((item) => {
      if (
        !["ofapi_read_fans_expired","ofapi_read_user_list_users","ofapi_read_user_list_pinned_users"].includes(row.operation) ||
        !item ||
        typeof item !== "object"
      )
        return item;
      const data = item as Record<string, unknown>,
        known = crmByRef.get(String(data.fanId));
      return {
        ...data,
        lastReplyAt: known?.last_reply_at
          ? new Date(known.last_reply_at).toISOString()
          : (data.lastReplyAt ?? null),
        priorSpendMills: known?.gross_mills ?? data.priorSpendMills ?? null,
        crmSource: known
          ? "local_archive_and_spend_projection"
          : "vendor_snapshot",
      };
    }),
  }));
}
/** The runtime's capture-admission refusal message prefix (ofapi-collection-read-transport.ts). */
const CAPTURE_ADMISSION_PREFIX = "Capture admission: ";
/**
 * Scheduled runs parked as `paused` by a capture-admission refusal, before the
 * runner learned to end them as failed, never dispatched that step. A paused
 * background run blocks its category's schedule, so close these the same way
 * the runner now does. Runs held for an uncertain or captured vendor outcome
 * keep waiting for the owner.
 */
export async function closeAdmissionRefusedOfapiCollectionRuns(db: Database) {
  const closed = await db.execute<{ id: string; page_id: string; category: string; reason: string }>(sql`
    update ofapi_collection_jobs job set state='failed',
      reason='scheduled_run_refused:' || substr(job.reason, ${CAPTURE_ADMISSION_PREFIX.length + 1}),
      lease_token=null,lease_until=null,updated_at=now()
    where job.state='paused' and job.purpose='background'
      and left(job.reason, ${CAPTURE_ADMISSION_PREFIX.length}) = ${CAPTURE_ADMISSION_PREFIX}
      and (job.lease_until is null or job.lease_until<=now())
      and not exists(select 1 from ofapi_capture_jobs capture join ofapi_request_attempts attempt on attempt.capture_job_id=capture.id
        where capture.kind='collection_read' and capture.page_id=job.page_id
          and capture.target->>'collectionJobId'=job.id::text and attempt.state in ('reserved','dispatching'))
    returning job.id,job.page_id,job.category,job.reason`);
  return closed.rows.map(row => ({ id: row.id, pageId: Number(row.page_id), category: row.category, reason: row.reason }));
}
/** Schedule only explicitly configured non-baseline categories; never enables a collector. */
export async function enqueueDueOfapiCollectionSchedules(
  db: Database,
  categories: readonly OfapiCollectionCategory[],
  now = new Date(),
) {
  const pages = await db.execute<{ id: string }>(
    sql`select id from pages where platform='onlyfans' and deleted_at is null and ofapi_account_id is not null`,
  );
  const created: string[] = [];
  for (const page of pages.rows)
    for (const category of categories) {
      if (
        OFAPI_COLLECTION_REGISTRY.find((row) => row.id === category)?.baseline
      )
        continue;
      const policy = await getEffectiveOfapiCollectionPolicy(
        db,
        category,
        Number(page.id),
      );
      if (policy.mode !== "scheduled" || policy.backgroundPaused) continue;
      await db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        await database.execute(
          sql`select id from ofapi_collection_state where id=1 for update`,
        );
        const current = await getEffectiveOfapiCollectionPolicy(
          database,
          category,
          Number(page.id),
        );
        if (current.mode !== "scheduled" || current.backgroundPaused) return;
        const actor = await database.execute<{ actor_user_id: string }>(
          sql`select actor_user_id from ofapi_collection_policies where category=${category} and (page_id=${Number(page.id)} or page_id is null) order by page_id nulls last limit 1`,
        );
        if (!actor.rows[0]) return;
        const pending = await database.execute(
          sql`select id from ofapi_collection_jobs where page_id=${Number(page.id)} and category=${category} and state in ('queued','running','paused') and purpose='background' limit 1`,
        );
        if (pending.rows[0]) return;
        const due =
          await database.execute(sql`insert into ofapi_collection_schedules(page_id,category,last_scheduled_at) values(${Number(page.id)},${category},${now})
    on conflict(page_id,category) do update set last_scheduled_at=excluded.last_scheduled_at where ofapi_collection_schedules.last_scheduled_at<${new Date(now.getTime() - current.intervalMinutes * 60000)} returning page_id`);
        if (!due.rows[0]) return;
        const id = randomUUID(),
          to = new Date(now);
        to.setUTCHours(0, 0, 0, 0);
        const from = new Date(to.getTime() - 86400000);
        await database.execute(sql`insert into ofapi_collection_jobs(id,page_id,category,policy_revision,actor_user_id,max_credits,max_calls,max_bytes,target,purpose)
    values(${id}::uuid,${Number(page.id)},${category},${current.revision},${Number(actor.rows[0].actor_user_id)},${current.dailyCreditLimit},${current.maxCallsPerRun},${16 * 1024 * 1024},${JSON.stringify({ from: from.toISOString(), to: to.toISOString(), selection: [] })}::jsonb,'background')`);
        created.push(id);
      });
    }
  return created;
}
