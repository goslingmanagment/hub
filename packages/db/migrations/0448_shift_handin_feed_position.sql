-- agency-hub:rollback-compatible — both images record positions through the same statement triggers.
set local lock_timeout = '5s';

select pg_advisory_xact_lock(hashtextextended('shift_handin_feed', 0));
insert into feed_positions select 'shift_handin_feed', coalesce(max(seq), 0) from shift_handin_feed;

create trigger record_insert_position after insert on shift_handin_feed
  referencing new table as placed_rows for each statement execute function record_feed_position();
create trigger record_update_position after update on shift_handin_feed
  referencing new table as placed_rows for each statement execute function record_feed_position();
