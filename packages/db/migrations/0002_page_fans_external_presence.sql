alter table "page_fans"
  add column "external_presence_at" timestamp with time zone,
  add column "external_presence_observed_at" timestamp with time zone,
  add column "external_presence_source" text;

create index "page_fans_external_presence_idx"
  on "page_fans" using btree ("platform_account_id", "external_presence_at");
