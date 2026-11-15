-- agency-hub:rollback-compatible — a wider check and two nullable columns; the previous image writes no 'learn' and never reads the columns.
-- 0421_learn_pages.sql
--
-- «Обучение» (products plan 2026-11-13 §2.3): the pages an agent publishes from /OS for the chat team (a chatter's job
-- description, the SOPs) come through the existing agent-reports door with the section `learn`. Workboard shows them
-- to the team only once the owner approved them: `learn_approved_at` (null — not approved; set or cleared by the owner).
-- An approval holds across the agent's republishing of the same page.

set local lock_timeout = '5s';

alter table agent_reports
  drop constraint if exists agent_reports_section_check,
  add constraint agent_reports_section_check check (section in ('traffic', 'team', 'content', 'system', 'learn'));

alter table agent_reports
  add column if not exists learn_approved_at timestamptz,
  add column if not exists learn_approved_by_user_id bigint references users(id) on delete restrict;
