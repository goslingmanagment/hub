ALTER TABLE ofapi_commands DROP CONSTRAINT ofapi_commands_kind_check;
ALTER TABLE ofapi_commands ADD CONSTRAINT ofapi_commands_kind_check CHECK (kind IN (
 'send_text_message_v1','send_media_message_v1','typing_active_v1','unsend_message_v1','mark_chat_read_v1',
 'send_message_v2','set_fan_custom_name_v1','like_message_v1','unlike_message_v1','pin_message_v1','unpin_message_v1',
 'mark_chat_unread_v1','mute_chat_v1','unmute_chat_v1','hide_chat_v1'
));
CREATE TABLE ofapi_command_provider_operations (
 command_id uuid PRIMARY KEY REFERENCES ofapi_commands(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 provider_key uuid NOT NULL,
 team_slug text NOT NULL,
 account_id text NOT NULL,
 endpoint text NOT NULL,
 body_hash text NOT NULL,
 first_attempt_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE ofapi_media_token_custody (
 account_id text NOT NULL,
 token text NOT NULL,
 operation_id uuid NOT NULL,
 command_id uuid NOT NULL REFERENCES ofapi_commands(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id, token)
);
-- Banned-word dictionaries are versioned provider evidence, never executable regular expressions.
CREATE TABLE ofapi_banned_word_dictionaries (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 version_hash text NOT NULL,
 observation_id bigint NOT NULL,
 entries jsonb NOT NULL,
 observed_at timestamptz NOT NULL,
 complete boolean NOT NULL,
 pages integer NOT NULL,
 observation_ids jsonb NOT NULL
);
