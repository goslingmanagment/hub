-- agency-hub:rollback-compatible — three nullable columns the previous image never names.
-- 0395_system_state_awaiting.sql
--
-- «Состояние» (ecosystem plan, package P), the ledger's jobs: Hub reads the
-- ledger's own scheduler (GET /v1/health/jobs) as the reporter `ledger`.
--
-- system_routines.awaiting_since — the routine's runner restarted then and the
--   routine has not run since: its runs before do not count. It reads «ещё не
--   запускалась» until twice its period (and ten minutes) after this, then it is
--   silent. Null — not awaiting. Its last run and last success stay as facts.
-- system_reporters.unchecked_since / unchecked_reason — the reporter's source
--   answered without its facts (no answer, the ledger's scheduler off): its
--   routines read «не проверено» from then until the next full answer.

set local lock_timeout = '5s';

alter table system_routines add column if not exists awaiting_since timestamptz;

alter table system_reporters add column if not exists unchecked_since timestamptz;
alter table system_reporters add column if not exists unchecked_reason text;
alter table system_reporters drop constraint if exists system_reporters_unchecked_reason_check;
alter table system_reporters add constraint system_reporters_unchecked_reason_check
  check (unchecked_reason is null or length(unchecked_reason) <= 300);
