-- agency-hub:rollback-compatible — the previous runtime ignores this table.
-- Only newly made decisions schedule delivery. Earlier decisions may already be in external reports.
create table sale_decision_deliveries (
  decision_id bigint not null references sale_owner_decisions(id) on delete cascade,
  recipient_user_id bigint not null references users(id) on delete cascade,
  state text not null default 'pending' check (state in ('pending', 'applied', 'declined')),
  shift_id bigint references shifts(id) on delete cascade,
  report_date date,
  primary key (decision_id, recipient_user_id)
);
create index sale_decision_deliveries_recipient on sale_decision_deliveries (recipient_user_id, decision_id);

create function hub_realm_sale_delivery() returns trigger
language plpgsql as $$
declare
  recipient_test boolean := hub_user_is_test(new.recipient_user_id);
begin
  if recipient_test is distinct from (select hub_page_is_test(d.page_id) from sale_owner_decisions d where d.id = new.decision_id)
     or (new.shift_id is not null and recipient_test is distinct from (select hub_user_is_test(s.user_id) from shifts s where s.id = new.shift_id)) then
    raise exception 'sale delivery recipient, decision and shift must belong to the same realm' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger sale_decision_deliveries_realm before insert or update of decision_id, recipient_user_id, shift_id on sale_decision_deliveries
  for each row execute function hub_realm_sale_delivery();
