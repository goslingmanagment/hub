-- agency-hub:rollback-compatible — two new tables nothing of the previous image names.
-- 0371_media_looks.sql
--
-- Media looks (owner 2026-11-11): an agent key with `look:media` sees FRAMES
-- (≤ 512 px) of its page's own media, pulled through the page's session —
-- never the file, never a link. One look is one image request of the page's
-- engine (`media-look.fetch`, one CDN GET plus its redirects, ≤ 5 MiB): a
-- video's thumbnail sheet or cover, or a photo's resize. The engine's apply
-- leaves the bytes here (`source_bytes`, transient); the API process cuts
-- them into frames with sharp, stores the frames and drops the bytes.
--
-- No signed URL is ever stored here: the URL lives only sealed in the work's
-- secret parameters (`sync_work.secret_params`, nulled when the work closes).
--
-- media_looks — one look:
--   page_id                the page (page-owned for erasure)
--   agent_key_id           the key that asked
--   publication_id         the Hub publication asked about, or null (a post placed by hand)
--   post_ref               the platform's post id
--   attachment_index       which of the post's files (0-based, an album's files in order)
--   media_ref              the platform's media id of that file
--   media_type             video | image
--   variant                what was fetched: a video's thumbnail sheet (sprite), its cover, or a photo's resize (image)
--   status                 queued (the engine has it) | fetched (bytes in, not cut yet) | ready | failed | expired (frames gone)
--   failure                a closed code, why there are no frames
--   source_kind            how the signed location was found: schedule_read (the newest read of the page's schedule)
--   source_observation_id  that read's observation (no FK: observations is partitioned)
--   coverage               per_second | sampled | cover_only | whole_image | first_frame
--   duration_ms, frame_interval_ms, frame_count, grid_cols, grid_rows, cell_width, cell_height — the geometry
--   requests_sent          the requests the engine sent for it (its hops); a look counts against the daily cap only when > 0
--   source_content_type, source_bytes, source_expires_at — the fetched bytes, transient: nulled right after cutting,
--                          swept 15 minutes after they came
--   frames_expire_at       its frames are deleted after this instant (7 days)
--   expires_at             the row is deleted after this instant (90 days)
--
-- media_look_frames — the frames, each a JPEG without metadata, never larger than 512 px on either side.
--
-- The read_only role is deliberately NOT granted: the frames are the page's media.

set local lock_timeout = '5s';

create table if not exists media_looks (
  id bigserial primary key,
  page_id bigint not null references pages(id) on delete cascade,
  agent_key_id bigint references agent_keys(id) on delete restrict,
  publication_id bigint references publications(id) on delete set null,
  post_ref text not null,
  attachment_index smallint not null,
  media_ref text not null,
  media_type text not null,
  variant text not null,
  status text not null default 'queued',
  failure text,
  source_kind text not null,
  source_observation_id bigint,
  coverage text,
  duration_ms integer,
  frame_interval_ms integer,
  frame_count smallint,
  grid_cols smallint,
  grid_rows smallint,
  cell_width smallint,
  cell_height smallint,
  requests_sent smallint not null default 0,
  source_content_type text,
  source_bytes bytea,
  source_expires_at timestamptz,
  frames_expire_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  expires_at timestamptz not null default clock_timestamp() + interval '90 days',
  constraint media_looks_post_ref_check check (post_ref ~ '^[0-9]{1,24}$'),
  constraint media_looks_index_check check (attachment_index between 0 and 99),
  constraint media_looks_media_type_check check (media_type in ('video', 'image')),
  constraint media_looks_variant_check check (variant in ('sprite', 'cover', 'image')),
  constraint media_looks_status_check check (status in ('queued', 'fetched', 'ready', 'failed', 'expired')),
  constraint media_looks_failure_check check (failure is null or failure ~ '^[a-z0-9_:]{1,64}$'),
  constraint media_looks_source_kind_check check (source_kind in ('schedule_read')),
  constraint media_looks_coverage_check check (
    coverage is null or coverage in ('per_second', 'sampled', 'cover_only', 'whole_image', 'first_frame')
  ),
  constraint media_looks_geometry_check check (
    (duration_ms is null or duration_ms >= 0)
    and (frame_interval_ms is null or frame_interval_ms > 0)
    and (frame_count is null or frame_count between 0 and 256)
    and (grid_cols is null or grid_cols > 0) and (grid_rows is null or grid_rows > 0)
    and (cell_width is null or cell_width > 0) and (cell_height is null or cell_height > 0)
  ),
  constraint media_looks_requests_check check (requests_sent >= 0),
  constraint media_looks_source_bytes_check check (
    source_bytes is null or (octet_length(source_bytes) <= 5242880 and source_expires_at is not null)
  )
);

-- One look in flight per page: the cap's backstop (the create takes a per-page advisory lock first).
create unique index if not exists media_looks_one_in_flight on media_looks (page_id) where status in ('queued', 'fetched');
-- The daily cap and the page's looks.
create index if not exists media_looks_page_created on media_looks (page_id, created_at);
-- A fresh look of the same file (cached, no request).
create index if not exists media_looks_cache on media_looks (page_id, media_ref, variant, id desc) where status = 'ready';
-- The sweeps.
create index if not exists media_looks_source_expires on media_looks (source_expires_at) where source_bytes is not null;
create index if not exists media_looks_frames_expire on media_looks (frames_expire_at) where status = 'ready';
create index if not exists media_looks_expires on media_looks (expires_at);

create table if not exists media_look_frames (
  look_id bigint not null references media_looks(id) on delete cascade,
  page_id bigint not null references pages(id) on delete cascade,
  frame_index smallint not null,
  at_ms integer,
  width smallint not null,
  height smallint not null,
  jpeg bytea not null,
  primary key (look_id, frame_index),
  constraint media_look_frames_index_check check (frame_index between 0 and 255),
  constraint media_look_frames_at_check check (at_ms is null or at_ms >= 0),
  constraint media_look_frames_size_check check (width between 1 and 512 and height between 1 and 512),
  constraint media_look_frames_bytes_check check (octet_length(jpeg) between 1 and 1048576)
);

-- Page erasure.
create index if not exists media_look_frames_page on media_look_frames (page_id);

comment on table media_looks is
  'Media looks (owner 2026-11-11): one look of an agent key at a file of its page — one image request of the page''s engine, cut into frames. No URL is stored.';
comment on column media_looks.source_bytes is 'The fetched image as served, transient: nulled right after cutting, swept 15 minutes after it came.';
comment on column media_looks.requests_sent is 'The requests the engine sent for the look (its hops); a look counts against the page''s daily cap only when > 0.';
comment on table media_look_frames is
  'The frames of a media look: JPEGs without metadata, ≤ 512 px on both sides; deleted 7 days after the look.';
