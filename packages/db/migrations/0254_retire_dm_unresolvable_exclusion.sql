-- 0254_retire_dm_unresolvable_exclusion.sql
--
-- A lookup miss no longer excludes a chat (arena "vanished chat", plan §6,
-- M3b). `fan-profiles.probe` excluded a chat from message sync
-- (`page_dm_threads.metadata.messageSyncExcludedReason =
-- 'partner_unresolvable_from_account_lookup'`) when `/account?ids=` resolved
-- no partner for the page, and the conversation list kept the reason until a
-- probe of the day resolved the partner. A lookup miss is the page's own
-- evidence (the fan blocked that page, or a transient miss), not a reason to
-- stop reading the chat; a chat Fansly itself stops serving to the page is the
-- chat-unavailability episode's (`page_dm_thread_unavailability`, 0251). From
-- this release the probe excludes nothing and the conversation list neither
-- assigns the reason nor keeps it on a chat it writes.
--
-- The previous image's `sync` keeps running while the api migrates (its
-- container is recreated only after API health: scripts/deploy-production.sh,
-- recreate_sync_service), and it may run again after a rollback. Its
-- conversation list keeps the reason on a chat that carries it and asks for
-- the account probe, which writes it — each unless the page lifted the reason
-- (owner decision №8, `sync_pages.lifted_dm_exclusions`, 0235): its list keeps
-- no lifted reason on a bound chat, and its probe assigns no lifted reason.
-- So, in this one transaction:
--
-- 0. The erasure execution lock first (`withErasureExecutionLock`, key
--    8154030001; this image and the previous one take it before any row
--    lock of an erasure, which locks a fan's threads `order by t.id for
--    update`): an erasure in flight finishes first, a later one waits for
--    this commit — no deadlock over two threads of one fan.
-- 1. Every Fansly page row is locked, in page order, as the actor's own
--    transactions lock it (each starts with the generation fence on its page
--    row): an apply in flight finishes first, and a later one waits for this
--    commit and then reads what it wrote. No apply can write back a reason it
--    read before the threads below are cleared.
-- 2. Every page lifts the reason: the retired rule then holds for the
--    previous image too — on every page, not only the ones with a chat that
--    carries it today, so that no probe it left open and no chat it might
--    still mark depends on where the reason stood. This release reads the
--    lift for nothing (its list writes only the aggregation-missing reason,
--    its probe excludes nothing); `sync excluded unlift` can take it off a
--    page, which changes nothing in this release.
-- 3. The threads that carry the reason are locked in id order (the order
--    erasure and the actor's chat writers take threads; `no key update`, the
--    update's own strength, so a history intake's `key share` is not
--    blocked), then the reason comes off them, bound or not (the
--    previous list ignores a lift on an unbound chat and would keep the
--    reason there; with none left it has nothing to keep), and nothing
--    else: no other key of their metadata, no other reason
--    (`partner_missing_from_aggregation_accounts` stays), no work row, no
--    demand. The chats are read by ordinary demand only: when the
--    conversation list next lists one whose head is newer than what the
--    message reads reached, one `dm-messages.catchup`; a socket message in it,
--    one `dm-messages.head`; a history request, its own read. A chat whose
--    head was read asks for nothing.
--
-- Lock order: the erasure lock, page rows (page order), threads (id order).
-- Every other locker of these rows takes them in the same order or holds
-- nothing this waits for: an erasure takes its lock before any row; an actor
-- transaction its own page row, then that page's threads; a history intake
-- only `key share` on threads, which neither blocks nor waits for this.
--
-- (Production, 2026-10-09: 17 threads on all six Fansly pages, all live, all
-- bound, 11 visible; 7 of them have a list head newer than what the reads
-- reached, none is a never-read chat that began under the engine; no page has
-- lifted the reason; no `fan-profiles.probe` row is open.)
--
-- Data only, no DDL. Run again, it finds every page lifted and no thread to
-- clear, and changes nothing.
--
-- After the deploy (read-only):
--   select count(*) from page_dm_threads
--    where metadata ->> 'messageSyncExcludedReason' = 'partner_unresolvable_from_account_lookup';   -- 0
--   select count(*) from sync_pages
--    where not ('partner_unresolvable_from_account_lookup' = any(lifted_dm_exclusions));            -- 0
--
-- Rollback-compatible: the previous image keeps no lifted reason on a bound
-- chat and assigns none from its probe, and no chat carries the reason after
-- this; it reads the re-included chats like any other.
select pg_advisory_xact_lock(8154030001::bigint);

select sp.page_id
  from sync_pages sp
 order by sp.page_id
   for no key update;

update sync_pages sp
   set lifted_dm_exclusions = array_append(sp.lifted_dm_exclusions, 'partner_unresolvable_from_account_lookup'),
       updated_at = clock_timestamp()
 where not ('partner_unresolvable_from_account_lookup' = any(sp.lifted_dm_exclusions));

select t.id
  from page_dm_threads t
 where t.metadata ->> 'messageSyncExcludedReason' = 'partner_unresolvable_from_account_lookup'
 order by t.id
   for no key update;

update page_dm_threads t
   set metadata = t.metadata - 'messageSyncExcludedReason',
       updated_at = clock_timestamp()
 where t.metadata ->> 'messageSyncExcludedReason' = 'partner_unresolvable_from_account_lookup';
