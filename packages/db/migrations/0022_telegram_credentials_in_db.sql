-- Add bot token (encrypted) and chat ID to telegram_settings so they can be configured from the dashboard
alter table telegram_settings add column if not exists encrypted_bot_token text;
alter table telegram_settings add column if not exists chat_id text;
