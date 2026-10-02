-- 0234_sync_media_handoff.sql
--
-- Fansly Sync Engine, step 3 (design S3-04; owner decision №17, 2026-10-02):
-- the transient handoff buffer of chat media for the AI describer. On a page
-- the engine owns, the CDN download of a chat file is a request of the page's
-- actor in the `sync` process (`media-download.fetch`), while the describer
-- runs in the worker. The bytes cross between the two processes here: the
-- engine's apply writes one row per downloaded file, the describer reads it
-- and deletes it in the same statement as soon as it has the bytes, and a row
-- nobody consumed is deleted once it expires (24 h; the nightly retention job
-- and every new download of the page sweep expired rows).
--
-- This is a transient handoff buffer, NOT a captured fact: the captured facts
-- stay the description (`ai_media_descriptions`) and the media metadata
-- observation it came from. No archive of chat images accumulates (none is
-- kept today either: the legacy download held the bytes in memory only).
--
--   page_id         the page (page-owned for erasure; cascades with the page)
--   description_id  the describer's row the bytes were downloaded for (fan
--                   erasure deletes that row, and the bytes with it)
--   work_id         the `media-download.fetch` work that downloaded them (no
--                   FK: work retention is independent)
--   content_type    the CDN's `content-type`, as served
--   byte_count      octet_length(bytes), at most the 5 MiB download cap
--   bytes           the file as served (content codings undone)
--   expires_at      deleted after this instant if nobody consumed it
--
-- The read_only role is deliberately NOT granted: the bytes are chat media,
-- read by the describer alone. Purely additive, IF NOT EXISTS; the previous
-- image never names the table.
create table if not exists sync_media_handoff (
  id bigserial primary key,
  page_id bigint not null references pages(id) on delete cascade,
  description_id bigint not null references ai_media_descriptions(id) on delete cascade,
  work_id bigint not null,
  content_type text,
  byte_count integer not null,
  bytes bytea not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp() + interval '24 hours',
  constraint sync_media_handoff_byte_count_check check (
    byte_count = octet_length(bytes) and byte_count between 0 and 5242880
  ),
  constraint sync_media_handoff_expiry_check check (expires_at > created_at)
);

-- The consuming read (the describer, by the work's result) and fan erasure.
create index if not exists sync_media_handoff_description on sync_media_handoff (description_id);
-- The expiry sweep.
create index if not exists sync_media_handoff_expires on sync_media_handoff (expires_at);

comment on table sync_media_handoff is
  'Fansly Sync Engine (owner decision №17): transient handoff of chat media bytes from the sync process to the AI describer; deleted when consumed, or after expires_at. Not a captured fact.';
comment on column sync_media_handoff.page_id is 'The page whose actor downloaded the file.';
comment on column sync_media_handoff.description_id is 'The ai_media_descriptions row the bytes were downloaded for.';
comment on column sync_media_handoff.work_id is 'The media-download.fetch work that downloaded them (no FK).';
comment on column sync_media_handoff.content_type is 'The CDN content-type, as served.';
comment on column sync_media_handoff.byte_count is 'octet_length(bytes); at most the 5 MiB download cap.';
comment on column sync_media_handoff.bytes is 'The file as served (content codings undone). Chat media: never granted to read_only.';
comment on column sync_media_handoff.created_at is 'When the engine stored the bytes.';
comment on column sync_media_handoff.expires_at is 'An unconsumed row is deleted after this instant (24 h).';
