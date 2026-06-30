-- Track when the Telegram credentials (bot token / chat id) last changed, so the
-- connection status only counts a successful delivery made with the CURRENT
-- credentials as "connected" — a stale success from a previous bot/chat must not
-- keep reading as connected after the credentials are rotated.

ALTER TABLE "telegram_settings"
  ADD COLUMN "credentials_updated_at" timestamp with time zone DEFAULT now() NOT NULL;
