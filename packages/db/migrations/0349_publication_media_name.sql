-- agency-hub:rollback-compatible — a nullable column the previous image neither reads nor writes.
-- 0349_publication_media_name.sql
--
-- A vault album's card is named by the pack's own file (audit, 2026-11-03).
-- Hub keeps one file per model and bytes, under the name it first came with:
-- a pack photo Hub had before as IMG_0191.jpg named its card IMG_0191.jpg,
-- whatever the pack called it. A draft now names each of its files as the
-- pack has it; null — the file's own name in Hub, as before.

set local lock_timeout = '5s';

alter table publication_media add column name text
  check (name is null or length(name) between 1 and 200);
