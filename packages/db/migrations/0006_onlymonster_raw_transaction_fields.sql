alter table transactions
  alter column raw_type type text using raw_type::text,
  alter column raw_status type text using raw_status::text;
