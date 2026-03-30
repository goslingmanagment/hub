update page_dm_messages pdm
set total_tip_amount_cents = pdm.total_tip_amount_cents / 10
from platform_accounts pa
where pa.id = pdm.platform_account_id
  and pa.platform = 'fansly'
  and pdm.total_tip_amount_cents > 0;
