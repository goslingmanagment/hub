-- agency-hub:rollback-compatible — wider checks only: the previous image never writes the new source or origin.
-- 0327_client_note_attributions_chatspace.sql
--
-- Who wrote each note, on OnlyFans too (note-attribution-v1). The chat
-- extension on ChatSpace writes OnlyMonster's own fan notes and reports each
-- confirmed write as `chatspace-extension`: `fan_ref` is the fan's OnlyFans
-- numeric id, `note_ref` OnlyMonster's numeric note id. Both fit the numeric
-- checks of 0324 as they are.
--
-- A new origin, `transfer`: the chatter moved the notes of the fan's old
-- account onto this account (the panel's «Вставить сюда»).

set local lock_timeout = '5s';

alter table client_note_attributions drop constraint client_note_attributions_source_check;
alter table client_note_attributions add constraint client_note_attributions_source_check
  check (source in ('fansly-extension', 'chatspace-extension'));

alter table client_note_attributions drop constraint client_note_attributions_origin_check;
alter table client_note_attributions add constraint client_note_attributions_origin_check
  check (origin is null or origin in ('quick', 'editor', 'field', 'fill', 'undo', 'list', 'name', 'transfer'));

comment on table client_note_attributions is
  'Who wrote each fan note (note-attribution-v1; Fansly notes and, on OnlyFans, OnlyMonster''s fan notes): the chatter of the token that reported a confirmed note write of the extension, one row per write event, first report wins. No note title or text.';
