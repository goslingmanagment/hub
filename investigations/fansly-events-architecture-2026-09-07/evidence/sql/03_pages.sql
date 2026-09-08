SET statement_timeout = '180s';
select id, label, platform, status, username, external_page_id, transactions_writer,
       last_light_sync_at, deleted_at
from pages order by platform, id;
