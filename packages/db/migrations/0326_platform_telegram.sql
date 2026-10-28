-- agency-hub:rollback-compatible — one new row of the platforms reference table, which no page names until Lora's Telegram page is added after the deploy, and one nullable column the previous image never names.
-- 0326_platform_telegram.sql
--
-- Telegram Web as the chat extension's third site (chat-extension spec
-- 2026-10-27-telegram-site, hub §5.1): a page of platform `telegram` is a
-- model persona's own Telegram account, opened in Telegram Web. The hub syncs
-- nothing of it, keeps no transactions and no archive; the extension sends
-- the open chat with each AI request (Reply, Fix and Coach only).
--
-- `pages.platform` is text with a foreign key to this table (0068), so a new
-- platform is this one row. The two closed platform CHECKs
-- (`ai_media_descriptions`, `publication_dispatches`) stay as they are:
-- Telegram never writes there.

INSERT INTO platforms (key, display_name, adapter_version) VALUES
  ('telegram', 'Telegram', '1')
ON CONFLICT (key) DO NOTHING;

-- The persona a page is meant to be worked with (hub §5.5): the bootstrap
-- serves it as the page's `defaultPersonaKey`, the extension assigns it to an
-- unassigned page and warns when someone picks another. Set by the audited
-- `page add telegram --persona`; NULL everywhere else. A key of
-- `ai_personas`, not a foreign key: archiving a persona keeps its row, and a
-- key no active persona has is simply not offered by the extension.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS default_persona_key text;
