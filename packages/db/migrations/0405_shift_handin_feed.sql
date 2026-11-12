-- agency-hub:rollback-compatible — one new table: the previous image never names it (its feed reads versions by id).
-- 0405_shift_handin_feed.sql
--
-- The ledger's feed order (review R2-b). A version's id is taken at its insert and its transaction commits later
-- (a hand-in's sums, the owner's decision over several reports), so ids do not become visible in id order: a feed
-- that served `id > cursor` could serve a larger id and then never a smaller one committed after it.
--
-- shift_handin_feed — the order the feed serves versions in: a version gets its place (`seq`) only when a read of
--   the feed finds it committed, under one lock, after every place given before. A version committed later gets a
--   later place, past any cursor already given, so no cursor ever jumps over it. Places are never changed.
--   Every version written before this table keeps its id as its place: a ledger cursor of an id stays valid.

set local lock_timeout = '5s';

create table if not exists shift_handin_feed (
  seq bigint primary key,
  version_id bigint not null references shift_handin_versions(id) on delete restrict,
  placed_at timestamptz not null default clock_timestamp(),
  constraint shift_handin_feed_version_key unique (version_id),
  constraint shift_handin_feed_seq_check check (seq > 0)
);

insert into shift_handin_feed (seq, version_id)
select id, id from shift_handin_versions
on conflict do nothing;
