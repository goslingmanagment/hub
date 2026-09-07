alter table ofapi_capture_jobs drop constraint ofapi_capture_jobs_kind_check;
alter table ofapi_capture_jobs add constraint ofapi_capture_jobs_kind_check
 check (kind in ('chat_paginate','campaign_snapshot','head_repair','account_export','export_import','post_paginate','collection_read'));
