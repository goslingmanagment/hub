-- agency-hub:rollback-compatible — the check only widens and the update only dismisses findings: the previous image never writes the new reason, and it serves only open findings (a dismissed one it reads is refused as resolved before its reason is written out).
-- 0437_custom_findings_not_asked.sql
--
-- A custom with no order (0436, customs facts spec §8): one more reason a finding is no order, `not_asked` — «кастом не
-- просил». The owner's decision (2026-11-22): a finding is only a fan who asked for a custom, never one who merely bought
-- a tier that includes one. The checks pass no longer writes tier purchases and renewals as findings; a tier holder stays
-- the reader's candidate, and the reader writes a finding of the fan's chat when he asks. The list is written whole.
--
-- Once, here: the open findings the old tier finder wrote are dismissed with this reason, by nobody (the system). They are
-- known by what that finder wrote — a sale finding of a subscription whose quote is the tier's name, as the tiers table or
-- the subscription names it (trimmed to 300, as it trimmed it). A finding whose quote is anyone's words (the reader's, from
-- the fan's chat) is a request and stays open. Their matters «Кастом без заказа» close on the next pass: the finding is
-- no longer open. Nothing is deleted.

alter table custom_findings drop constraint if exists custom_findings_dismiss_check;
alter table custom_findings add constraint custom_findings_dismiss_check check (
  (dismiss_reason is null or dismiss_reason in ('not_custom', 'sexting', 'unused', 'duplicate', 'test', 'not_asked'))
  and ((status = 'dismissed') = (dismiss_reason is not null)));

update custom_findings f
set status = 'dismissed', dismiss_reason = 'not_asked', resolved_by_user_id = null, resolved_by_agent_key_id = null, resolved_at = now()
from transactions t
where f.status = 'open' and f.source = 'sale'
  and t.id = (case when f.ref ~ '^[1-9][0-9]{0,18}$' then f.ref::bigint end)
  and t.canonical_type = 'subscription'
  and f.quote is not null
  and (exists (select 1 from page_subscription_tiers pt where pt.page_id = f.page_id and nullif(left(btrim(pt.name), 300), '') = f.quote)
    or exists (select 1 from page_subscriptions ps
      where ps.platform_account_id = f.page_id and nullif(left(btrim(ps.subscription_tier_name), 300), '') = f.quote));
