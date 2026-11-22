-- agency-hub:rollback-compatible — the check only widens: the previous image never writes the new reason, and it serves only open findings (a dismissed one it reads is refused as resolved before its reason is written out).
-- 0437_custom_findings_not_asked.sql
--
-- A custom with no order (0436, customs facts spec §8): one more reason a finding is no order, `not_asked` — «кастом не
-- просил». The owner's decision (2026-11-22): a finding is only a fan who asked for a custom, never one who merely bought
-- a tier that includes one. The checks pass no longer writes tier purchases and renewals as findings, and dismisses the
-- open ones it wrote with this reason (services/custom-orders/findings.ts); a tier holder stays the reader's candidate,
-- and the reader writes a finding of the fan's chat when he asks. The list is written whole.

alter table custom_findings drop constraint if exists custom_findings_dismiss_check;
alter table custom_findings add constraint custom_findings_dismiss_check check (
  (dismiss_reason is null or dismiss_reason in ('not_custom', 'sexting', 'unused', 'duplicate', 'test', 'not_asked'))
  and ((status = 'dismissed') = (dismiss_reason is not null)));
