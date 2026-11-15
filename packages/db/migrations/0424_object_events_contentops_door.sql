-- agency-hub:rollback-compatible — one check widened: the previous image never writes the new door, and reads an event's door as text.
-- 0424_object_events_contentops_door.sql
--
-- A custom order's step taken in ContentOps «Съёмка» AS THE SIGNED-IN PERSON (products plan §2.4, §4.5, package C3;
-- the person's door, apps/runtime/src/services/person-door.ts): its history names the person and the door it came
-- through, `contentops`, as a step on Workboard's board names `workboard`.

set local lock_timeout = '5s';

alter table object_events drop constraint if exists object_events_door_check;
alter table object_events add constraint object_events_door_check
  check (door in ('extension', 'workboard', 'telegram', 'api', 'system', 'contentops'));
