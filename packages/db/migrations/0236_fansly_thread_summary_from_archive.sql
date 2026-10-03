-- 0236_fansly_thread_summary_from_archive.sql
--
-- Fansly Sync Engine, step 4 (design S4-08 [E4], owner decision №11): the DM
-- readers of a page the engine runs live read message_archive, and the engine
-- writes the thread summary columns from it (writeThreadSummary after a read,
-- writeThreadSummaryAfterDeletion after a socket deletion). Until now the
-- columns counted page_dm_messages. This recomputes, once, the count and the
-- newest/oldest stored ids of the live pages' threads from their stored archive
-- messages (no tombstone, not a content_pending stub, an instant — as
-- repositories/dm-archive-store.ts defines one; newest/oldest by instant, then
-- message ref, as getPageDmMessageWindowSummary orders them), only where they
-- differ: 40 threads on the six Fansly pages in production on 2026-10-03, the
-- archive-only September sidecar rows the hot table never held (about 3.6 s for
-- the whole recount). last_fan/model_message_at, the coverage verdict and the
-- chain columns are left alone.
--
-- Data only, and rollback-compatible: the previous image increments the same
-- columns from its hot inserts and recounts them from page_dm_messages after a
-- socket deletion, on its next touch of a thread.
with archive as (
  select t.id as thread_id,
         count(ma.id)::int as stored_count,
         (array_agg(ma.message_ref order by ma.occurred_at desc, ma.message_ref desc, ma.id desc)
            filter (where ma.id is not null))[1] as newest_id,
         (array_agg(ma.message_ref order by ma.occurred_at asc, ma.message_ref asc, ma.id asc)
            filter (where ma.id is not null))[1] as oldest_id
    from page_dm_threads t
    join sync_pages sp on sp.page_id = t.platform_account_id and sp.mode = 'live'
    join pages p on p.id = t.platform_account_id
    left join message_archive ma
      on ma.account_id = t.platform_account_id
     and ma.platform = p.platform::text
     and ma.conversation_ref = t.platform_conversation_id
     and ma.deleted_at is null
     and ma.content_pending = false
     and ma.occurred_at is not null
   group by t.id
)
update page_dm_threads t
   set stored_message_count = a.stored_count,
       newest_stored_message_id = a.newest_id,
       oldest_stored_message_id = a.oldest_id,
       updated_at = now()
  from archive a
 where t.id = a.thread_id
   and (t.stored_message_count, t.newest_stored_message_id, t.oldest_stored_message_id)
       is distinct from (a.stored_count, a.newest_id, a.oldest_id);
