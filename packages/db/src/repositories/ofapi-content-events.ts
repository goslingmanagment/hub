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
