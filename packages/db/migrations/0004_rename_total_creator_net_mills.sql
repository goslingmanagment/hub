do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'fan_pages'
      and column_name = 'total_spent_mills'
  ) then
    alter table fan_pages rename column total_spent_mills to total_creator_net_mills;
  end if;
end $$;
