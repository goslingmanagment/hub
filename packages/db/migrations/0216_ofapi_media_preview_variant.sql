-- 0216_ofapi_media_preview_variant.sql
--
-- AI media describer, OnlyFans source (docs/runbooks/ai-media-describe.md).
-- Forward-only; 0210 is not rewritten.
--
-- 1. A third locator variant, `preview`: OnlyFans serves every media with a
--    `full` also a `preview` (~960-1700 px long edge, vs 300 px for `thumb`),
--    and a video's poster only as `preview`/`thumb`. The describer prefers it.
-- 2. A third locator source, `resolve`: the cdn.fansapi.com URLs the desktop
--    image resolve hands out (OFAPI cache hits, 0 credits) were kept in
--    process memory only; persisted, they let the describer reuse them — the
--    AI path itself never calls OFAPI.
-- The fetch log accepts `preview` too so both tables speak one vocabulary.
-- The previous image never writes either value; reading them is harmless.

alter table ofapi_media_locators drop constraint if exists ofapi_media_locators_variant_check;
alter table ofapi_media_locators add constraint ofapi_media_locators_variant_check
  check (variant in ('thumb', 'full', 'preview'));

alter table ofapi_media_locators drop constraint if exists ofapi_media_locators_source_check;
alter table ofapi_media_locators add constraint ofapi_media_locators_source_check
  check (source in ('webhook', 'gateway', 'resolve'));

alter table ofapi_media_fetch_log drop constraint if exists ofapi_media_fetch_log_variant_check;
alter table ofapi_media_fetch_log add constraint ofapi_media_fetch_log_variant_check
  check (variant in ('thumb', 'full', 'preview'));
