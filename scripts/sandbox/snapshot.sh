#!/usr/bin/env bash
# The test team's proof on PRODUCTION (apps/runtime/src/services/sandbox/realm.ts): run it before the seed and after it
# (and after the test team worked), then diff the two outputs. Every line must be the same. Read-only: SQL in a
# read-only transaction, the agent API with a live key's GETs, the ledger's own health. Prints one comparable text.
#
#   scripts/sandbox/snapshot.sh > before.txt   # before `sandbox:seed`
#   scripts/sandbox/snapshot.sh > after.txt    # after it, and after the team worked
#   diff before.txt after.txt
#
# Environment: HUB_SSH (default root@152.53.191.242), HUB_BASE_URL + HUB_AGENT_KEY (a live key with read:team, e.g.
# from ~/.config/agency/secrets.env; skipped when unset), LEDGER_BIN (default `ledger`; skipped when not found),
# SNAPSHOT_DAYS (default 35), SNAPSHOT_PSQL_URL (a local database instead of production, to check this script).
set -euo pipefail

HUB_SSH="${HUB_SSH:-root@152.53.191.242}"
DAYS="${SNAPSHOT_DAYS:-35}"

sql() {
  if [[ -n "${SNAPSHOT_PSQL_URL:-}" ]]; then # a local database instead of production (checking this script)
    PGOPTIONS='-c default_transaction_read_only=on' psql "$SNAPSHOT_PSQL_URL" -At -F '|' -v ON_ERROR_STOP=1 <<<"$1"
    return
  fi
  ssh -o ConnectTimeout=15 "$HUB_SSH" "docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60s' agency-hub-postgres-1 psql -U postgres -d agency_hub_core -At -F '|' -v ON_ERROR_STOP=1" <<<"$1"
}

# The live agency: every page whose model is not a test model, every login whose person is not a test person.
LIVE_PAGE="not exists (select 1 from pages rp join models rm on rm.id = rp.model_id where rp.id = %s and rm.is_test)"
live_page() { printf "$LIVE_PAGE" "$1"; }
LIVE_USER="not exists (select 1 from person_logins rl join people re on re.id = rl.person_id where rl.user_id = %s and re.is_test)"
live_user() { printf "$LIVE_USER" "$1"; }

echo "== Home: revenue by Moscow day, last $DAYS days (live pages)"
sql "select to_char(occurred_at at time zone 'Europe/Moscow', 'YYYY-MM-DD'), count(*), sum(creator_net_amount_mills)
     from transactions t where t.is_active and t.occurred_at > now() - interval '$DAYS days' and $(live_page t.platform_account_id)
     group by 1 order by 1;"

echo "== Home: models, pages, fans of live pages"
sql "select (select count(*) from models where not is_test), (select count(*) from pages p where $(live_page p.id)),
       (select count(distinct pf.fan_id) from page_fans pf where $(live_page pf.platform_account_id));"

echo "== Shifts: rows by report day and state, last $DAYS days (live logins)"
sql "select report_date, state, count(*), sum(worked_minutes), sum(messages) from shifts s
     where s.report_date > current_date - $DAYS and $(live_user s.user_id) group by 1, 2 order by 1, 2;"

echo "== Whose a sale is: homes by day and home, last $DAYS days (live pages)"
sql "select to_char(occurred_at at time zone 'Europe/Moscow', 'YYYY-MM-DD'), home, count(*), sum(net_mills) from sale_homes h
     where h.occurred_at > now() - interval '$DAYS days' and $(live_page h.page_id) group by 1, 2 order by 1, 2;"

echo "== Ledger feeds: rows and sums (live)"
sql "select 'handin_versions', count(*), coalesce(sum(v.version), 0) from shift_handin_versions v join shift_handins h on h.id = v.handin_id where $(live_user h.user_id)
     union all select 'sale_decisions', count(*), 0 from sale_owner_decisions
     union all select 'erasures', count(*), 0 from erasure_log
     union all select 'people', count(*), 0 from people where not is_test
     union all select 'pay_terms', count(*), coalesce(sum(share_basis_points), 0) from person_pay_terms;"

echo "== Held back for agent keys (must stay empty of test rows)"
sql "select 'handin_feed_held', count(*) from shift_handin_feed_held k join shift_handin_versions v on v.id = k.version_id
       join shift_handins h on h.id = v.handin_id where not ($(live_user h.user_id));" || true

echo "== Open matters by owner (live), and how many wait for the test team"
sql "select coalesce(m.owner_role, u.username), m.kind, count(*) from matters m left join users u on u.id = m.owner_user_id
     where m.state = 'open' and (m.owner_user_id is null or $(live_user m.owner_user_id)) group by 1, 2 order by 1, 2;"
sql "select 'test team matters', count(*) from matters m where m.owner_user_id is not null and not ($(live_user m.owner_user_id));"

echo "== People the agents get (live registry)"
sql "select code, role, state, kind from people where not is_test order by code;"

echo "== Logins (live)"
sql "select u.id, u.username, u.role, (u.disabled_at is null) from users u where u.deleted_at is null and $(live_user u.id) order by u.id;"

echo "== Agent keys: pages granted (no test page may be in any)"
sql "select a.name, cardinality(a.page_ids), exists (select 1 from unnest(a.page_ids) x where not ($(live_page x)))
     from agent_keys a where a.revoked_at is null order by a.name;"

echo "== System state: routines and copies by level"
sql "select reporter, count(*) from system_routines where retired_at is null group by 1 order by 1;" || true

echo "== People messages: by kind and state, last 7 days"
sql "select kind, state, count(*) from people_messages where created_at > now() - interval '7 days' group by 1, 2 order by 1, 2;"

if [[ -n "${HUB_AGENT_KEY:-}" && -n "${HUB_BASE_URL:-}" ]]; then
  echo "== Agent API: the people door and the feeds (a live key)"
  for path in "/api/v1/agent/people" "/api/v1/agent/shift-reports/feed?limit=200" "/api/v1/agent/sale-decisions/feed?limit=200"; do
    echo "-- GET $path"
    curl -fsS -H "authorization: Bearer $HUB_AGENT_KEY" "$HUB_BASE_URL$path" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const drop=k=>["serverNow","generatedAt","budgets","next","cursor"].includes(k);
          console.log(JSON.stringify(j,(k,v)=>drop(k)?undefined:v));})' || echo "(no answer)"
  done
else
  echo "== Agent API: skipped (HUB_BASE_URL / HUB_AGENT_KEY not set)"
fi

LEDGER_BIN="${LEDGER_BIN:-ledger}"
if command -v "$LEDGER_BIN" >/dev/null 2>&1; then
  echo "== ledger hub status"
  "$LEDGER_BIN" hub status 2>&1 | grep -v -E '^(as of|now|checked at)' || true
  echo "== ledger health"
  "$LEDGER_BIN" health 2>&1 | grep -v -E '^(as of|now|checked at)' || true
else
  echo "== ledger: skipped ($LEDGER_BIN not found; set LEDGER_BIN)"
fi
