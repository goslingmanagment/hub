ALTER TABLE ofapi_capture_jobs DROP CONSTRAINT ofapi_capture_jobs_kind_check;
ALTER TABLE ofapi_capture_jobs ADD CONSTRAINT ofapi_capture_jobs_kind_check CHECK(kind IN
 ('chat_paginate','campaign_snapshot','head_repair','account_export','export_import','post_paginate','collection_read','media_upload'));
CREATE UNIQUE INDEX ofapi_media_upload_request_idx ON ofapi_capture_jobs(page_id,(target->>'requestId')) WHERE kind='media_upload';
CREATE TABLE ofapi_media_sources (
 id uuid PRIMARY KEY,
 page_id bigint NOT NULL REFERENCES pages(id),
 account_id text NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 byte_size bigint NOT NULL CHECK(byte_size BETWEEN 1 AND 100000000),
 filename text NOT NULL,
 mime_type text NOT NULL,
 observation_id bigint NOT NULL,
 observation_received_at timestamptz NOT NULL,
 actor_user_id bigint NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(page_id,account_id,sha256)
);
-- Rebuildable provider metadata; source bytes and durable request authority live elsewhere.
CREATE TABLE ofapi_media_catalog (
 account_id text NOT NULL,
 page_id bigint NOT NULL REFERENCES pages(id),
 media_ref text NOT NULL,
 material_kind text NOT NULL CHECK(material_kind IN ('vault','cdn')),
 upload_job_id uuid,
 source_id uuid,
 upload_status text,
 is_ready boolean,
 provider_type text,
 has_error boolean,
 can_view boolean,
 filename text,
 mime_type text,
 byte_size bigint,
 duration double precision,
 width integer,
 height integer,
 release_forms jsonb NOT NULL DEFAULT '[]',
 metadata jsonb NOT NULL,
 observation_id bigint NOT NULL,
 observation_received_at timestamptz NOT NULL,
 PRIMARY KEY(page_id,account_id,material_kind,media_ref)
);

ALTER TABLE creator_raw_media DROP CONSTRAINT creator_raw_media_source_kind_check;
ALTER TABLE creator_raw_media ADD CONSTRAINT creator_raw_media_source_kind_check CHECK(source_kind IN
 ('vault_albums','uservault_albums','vault_media','account_media_batch','posts','ofapi.posts_page.v1',
  'ofapi.media_upload_response.v1','ofapi.collection_read_response.v1','media_uploads.completed'));
