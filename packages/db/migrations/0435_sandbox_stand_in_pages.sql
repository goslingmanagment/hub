-- agency-hub:rollback-compatible — a nullable column with a partial unique index and a trigger that refuses only rows naming it; the previous image never names the column, so every row it writes keeps it null.
-- 0435_sandbox_stand_in_pages.sql
--
-- A stand-in page (the test realm, 0414): a test page that stands in for one live page, so a test login can work that
-- live page's real site account in the released chat extension. The client bootstrap (apps/runtime/src/services/
-- client-bootstrap.ts) names the live page's platform account id on the stand-in while the live page is active, and its
-- Fansly proxy is the live page's; the stand-in's own `external_page_id` stays NULL (UNIQUE(platform,
-- external_page_id), and every sync keys on it), so nothing syncs it and the OnlyFans feed's account check
-- (`requireBoundAccount`) still refuses it. A stand-in stores only the pulse and the board's own writes: what the
-- extension reports of the real account (wallet sightings, send and note attributions, captures) is accepted and
-- dropped, and a test login reads nothing of a real fan.
--
-- pages.stands_in_for_page_id   the live page this test page stands in for; one stand-in per live page.
--
-- What the database holds to: only a test page stands in; what it stands in for is a live page of the same platform,
-- never itself. A live page that goes away leaves its stand-in an ordinary unbound test page (deleted in the catalog: the
-- bootstrap stops naming its account; deleted as a row: on delete set null): the test realm never holds a live row in
-- place. `sandbox:remove` takes the stand-ins with the test model's pages.

set local lock_timeout = '5s';

alter table pages add column if not exists stands_in_for_page_id bigint references pages(id) on delete set null;

create unique index if not exists pages_stands_in_for_uniq on pages (stands_in_for_page_id) where stands_in_for_page_id is not null;

comment on column pages.stands_in_for_page_id is
  'A test page standing in for this live page (0435): the client bootstrap names the live page''s platform account id on it; its own external_page_id stays null.';

create or replace function hub_realm_stand_in() returns trigger
language plpgsql as $$
declare
  target_platform text;
  target_test boolean;
begin
  if new.stands_in_for_page_id is null then
    return new;
  end if;
  if new.stands_in_for_page_id = new.id then
    raise exception 'page % cannot stand in for itself (0435)', new.id
      using errcode = 'check_violation';
  end if;
  if not coalesce((select is_test from models where id = new.model_id), false) then
    raise exception 'page % is live: only a test page stands in for a live one (0435)', new.id
      using errcode = 'check_violation';
  end if;
  select p.platform, m.is_test into target_platform, target_test
    from pages p join models m on m.id = p.model_id where p.id = new.stands_in_for_page_id;
  if not found then
    -- The foreign key refuses a missing page.
    return new;
  end if;
  if target_test then
    raise exception 'page % cannot stand in for the test page % (0435)', new.id, new.stands_in_for_page_id
      using errcode = 'check_violation';
  end if;
  if target_platform is distinct from new.platform then
    raise exception 'page % (%) cannot stand in for page % of another platform (%) (0435)', new.id, new.platform,
      new.stands_in_for_page_id, target_platform
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists pages_stand_in on pages;
create trigger pages_stand_in before insert or update of stands_in_for_page_id, model_id, platform on pages
  for each row execute function hub_realm_stand_in();
