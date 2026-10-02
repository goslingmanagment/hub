import { sql } from "drizzle-orm";

import {
  applyMessageEventsToArchive,
  isDmArchiveScopeFenced,
  tryAcquireDmArchiveWriterFenceLock,
  type Database,
  type MessageArchiveEventRow,
} from "@agency_hub_core/db";

import { appendOfapiMessageMaterialPage } from "./ofapi-message-material.ts";

/** The same ledger and archive reducer as the sweep, applied before a captured
 * response can be served. No account watermark moves: this is an exact batch,
 * not evidence that any intervening event has been projected. Retried/deduped
 * batches must project too (the previous owner may have died after append).
 * The journal is already durable outside this transaction. */
export async function serveOfapiMessageMaterialPage(
  db: Database,
  input: Parameters<typeof appendOfapiMessageMaterialPage>[1],
) {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    if (!await tryAcquireDmArchiveWriterFenceLock(database, input.accountId)) {
      return { kind: "deferred" as const };
    }
    const items: Record<string, unknown>[] = [];
    for (const item of input.items) {
      const createdAt = new Date(String(item.createdAt));
      if (!await isDmArchiveScopeFenced(database, {
        pageId: input.accountId,
        refs: [input.chatId],
        materialAt: createdAt < input.observationReceivedAt ? createdAt : input.observationReceivedAt,
      })) items.push(item);
    }
    const appended = await appendOfapiMessageMaterialPage(database, { ...input, items });
    const eventIds = appended.events.filter(event => event.dedupKey.startsWith("msg-material:"))
      .map(event => event.eventId);
    if (eventIds.length > 0) {
      // Both id and provider time pin the immutable events and prune partitions.
      const times = [...new Set(items.map(item => new Date(String(item.createdAt)).toISOString()))];
      const events = await database.execute<{
        id: string; account_seq: string; type: string; occurred_at: Date;
        fan_identity_ref: string | null; conversation_ref: string | null;
        message_ref: string | null; data: unknown;
      }>(sql`
        select e.id::text, e.account_seq::text, e.type, e.occurred_at,
               e.fan_identity_ref, e.conversation_ref, e.message_ref, e.data
        from domain_events e
        where e.account_id = ${input.accountId}
          and e.id in (${sql.join(eventIds.map(id => sql`${id}`), sql`, `)})
          and e.occurred_at in (${sql.join(times.map(time => sql`${time}::timestamptz`), sql`, `)})
        order by e.account_seq
      `);
      if (events.rows.length !== eventIds.length) {
        throw new Error("Captured OFAPI material event is unavailable; cannot certify serving");
      }
      await applyMessageEventsToArchive(database, {
        accountId: input.accountId,
        platform: "onlyfans",
        events: events.rows.map((event): MessageArchiveEventRow => ({
          id: Number(event.id), accountSeq: Number(event.account_seq), type: event.type,
          occurredAt: event.occurred_at, fanIdentityRef: event.fan_identity_ref,
          conversationRef: event.conversation_ref, messageRef: event.message_ref, data: event.data,
        })),
      });
    }
    return { kind: "materialized" as const, appended: appended.appended, deduped: appended.deduped,
      itemCount: input.items.length, dropped: input.items.length - items.length };
  });
}
