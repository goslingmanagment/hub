-- Opt-in custody for a first personal greeting, scoped across chatter devices.
-- Existing commands keep NULL and exactly their old dispatch/idempotency path.
alter table ofapi_commands add column outreach_purpose text;
alter table ofapi_commands add constraint ofapi_commands_outreach_purpose_check
  check (outreach_purpose is null or (
    outreach_purpose = 'new-follower' and conversation_id ~ '^[1-9][0-9]{0,29}$'
    and kind in ('send_text_message_v1', 'send_message_v2')
  ));

-- Fail closed for unknown evidence, HTTP failures and indeterminate outcomes.
-- Only cancellation before claim or an executor-proven local refusal releases.
-- CASE avoids SQL NULL excluding a failed command with missing verifier data.
create unique index ofapi_commands_follower_outreach_uniq
  on ofapi_commands (page_id, conversation_id)
  where outreach_purpose = 'new-follower' and case
    when state = 'cancelled' and attempt_count = 0 then false
    when state in ('failed_retryable', 'failed_terminal')
      and coalesce(verifier_result->>'source', '') in ('local_precondition', 'auth_gate') then false
    else true
  end;
