import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";
import {
  isDmArchiveScopeFenced,
  tryAcquireDmArchiveWriterFenceLock,
} from "./erasure-fence.ts";
export async function saveOfapiChatQueueState(
  db: Database,
  input: {
    pageId: number;
    queueId: string;
    phase: string;
    queueDate: Date | null;
    state: Record<string, unknown>;
    observedAt: Date;
    eventId: number;
    observationId: number;
  },
) {
  return db.transaction(async (tx) => {
    const writer = tx as unknown as Database;
    if (!(await tryAcquireDmArchiveWriterFenceLock(writer, input.pageId)))
      throw new Error("OFAPI queue projection deferred by erasure");
    const materialAt = new Date(
      Math.min(
        input.observedAt.getTime(),
        input.queueDate?.getTime() ?? Infinity,
      ),
    );
    if (
      await isDmArchiveScopeFenced(writer, {
        pageId: input.pageId,
        refs: [],
        materialAt,
      })
    )
      return false;
    const result = await writer.execute(sql`
      insert into ofapi_chat_queue_state(page_id,queue_id,phase,queue_date,state,observed_at,source_event_id,source_observation_id)
      values(${input.pageId},${input.queueId},${input.phase},${input.queueDate},${JSON.stringify(input.state)}::jsonb,${input.observedAt},${input.eventId},${input.observationId})
      on conflict(page_id,queue_id) do update set phase=excluded.phase,queue_date=excluded.queue_date,state=excluded.state,
        observed_at=excluded.observed_at,source_event_id=excluded.source_event_id,source_observation_id=excluded.source_observation_id
      where (ofapi_chat_queue_state.phase <> 'finished' or excluded.phase = 'finished')
        and (excluded.phase='finished' and ofapi_chat_queue_state.phase<>'finished'
          or (excluded.observed_at,excluded.source_event_id) > (ofapi_chat_queue_state.observed_at,ofapi_chat_queue_state.source_event_id))
      returning page_id`);
    return (result.rowCount ?? 0) > 0;
  });
}
export async function readOfapiContentEvents(
  db: Database,
  input: { pageId: number; limit?: number | undefined },
) {
  const limit = Math.max(1, Math.min(100, input.limit ?? 50));
  const [queueResult, likesResult, unattributedResult] = await Promise.all([
    db.execute<{
      queue_id: string;
      phase: "updated" | "finished";
      queue_date: Date | null;
      state: Record<string, unknown>;
      observed_at: Date;
      source_event_id: string;
      source_observation_id: string;
    }>(sql`
      select q.queue_id,q.phase,q.queue_date,q.state,q.observed_at,q.source_event_id::text,q.source_observation_id::text
      from ofapi_chat_queue_state q where q.page_id=${input.pageId} order by q.observed_at desc,q.queue_id limit ${limit + 1}`),
    db.execute<{
      subject_ref: string;
      liker_platform_user_id: string;
      state: "active" | "undone";
      occurred_at: Date;
      last_observed_at: Date;
      source_event_id: string;
      source_observation_id: string;
    }>(sql`
      select p.subject_ref,p.liker_platform_user_id,p.state,p.occurred_at,p.last_observed_at,p.source_event_id::text,p.source_observation_id::text
      from post_likes p where p.page_id=${input.pageId} and p.platform='onlyfans' and p.discovered_via='ofapi_webhook'
      order by p.occurred_at desc,p.subject_ref,p.liker_platform_user_id limit ${limit + 1}`),
    db.execute<{ n: string }>(
      sql`select count(*)::text as n from domain_events e where e.account_id=${input.pageId} and e.type='ofapi.post_like_observed' and e.post_ref is null`,
    ),
  ]);
  const iso = (value: Date | string) => new Date(value).toISOString();
  return {
    pageId: input.pageId,
    source: "onlyfansapi" as const,
    coverage: "observed_events_only" as const,
    queues: queueResult.rows
      .slice(0, limit)
      .map((row) => ({
        queueId: row.queue_id,
        phase: row.phase,
        queueDate: row.queue_date ? iso(row.queue_date) : null,
        state: row.state,
        observedAt: iso(row.observed_at),
        sourceEventId: row.source_event_id,
        sourceObservationId: row.source_observation_id,
        timeBasis: "receipt" as const,
      })),
    likes: likesResult.rows
      .slice(0, limit)
      .map((row) => ({
        postRef: row.subject_ref,
        fanRef: row.liker_platform_user_id,
        state: row.state,
        sourceAt: iso(row.occurred_at),
        observedAt: iso(row.last_observed_at),
        sourceEventId: row.source_event_id,
        sourceObservationId: row.source_observation_id,
        timeBasis: "provider" as const,
      })),
    unattributedLikes: Number(unattributedResult.rows[0]?.n ?? 0),
    queuesHasMore: queueResult.rows.length > limit,
    likesHasMore: likesResult.rows.length > limit,
  };
}
