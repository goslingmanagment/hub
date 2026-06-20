alter table ofapi_commands
  drop constraint if exists ofapi_commands_kind_check;

alter table ofapi_commands
  add constraint ofapi_commands_kind_check
  check (kind in (
    'send_text_message_v1',
    'send_media_message_v1',
    'typing_active_v1',
    'unsend_message_v1',
    'mark_chat_read_v1'
  ));
