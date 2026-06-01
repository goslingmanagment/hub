// Read-only: dump real classified dialogs + their L2 verdict for one page, so we can
// eyeball classification quality on production data. NO writes.
//   DATABASE_URL=... node --import tsx/esm scripts/workboard-v2-inspect-dialogs.ts <pageLabel> [stateFilter]
import { createPool } from "@agency_hub_core/db";

type Ctx = { r: string; t: string };
interface Row {
  username: string;
  ltv_mills: string | null;
  tab: string | null;
  last_role: string;
  state: string | null;
  needs_reply: boolean | null;
  reason: string | null;
  age_days: number | null;
  ctx: Ctx[] | null;
}

const ROLE = (r: string) => (r === "fan" ? "FAN  " : r === "model" ? "MODEL" : r.toUpperCase().padEnd(5));

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  const label = process.argv[2] ?? "Lora-1";
  const stateFilter = process.argv[3] ?? null;
  if (!url) throw new Error("DATABASE_URL is required");

  const pool = createPool(url);
  try {
    const { rows } = await pool.query<Row>(
      `select
         f.username,
         pf.total_creator_net_mills::text as ltv_mills,
         ws.tab::text as tab,
         t.last_message_sender_role::text as last_role,
         cc.state, cc.needs_reply, cc.reason,
         extract(epoch from (now() - t.last_fan_message_at))/86400 as age_days,
         (select json_agg(json_build_object('r', x.sender_role::text, 't', left(coalesce(x.content,''),160)) order by x.created_at asc)
            from (select sender_role, content, created_at from page_dm_messages
                  where conversation_id = t.id order by created_at desc, id desc limit 6) x) as ctx
       from wb_closing_cache cc
       join pages p on p.id = cc.platform_account_id and p.label = $1
       join page_dm_threads t on t.platform_account_id = cc.platform_account_id and t.last_message_id = cc.platform_message_id
       join fans f on f.id = t.fan_id
       left join page_fans pf on pf.fan_id = t.fan_id and pf.platform_account_id = cc.platform_account_id
       left join workboard_state ws on ws.platform_account_id = cc.platform_account_id and ws.fan_id = t.fan_id
       where cc.platform_account_id = (select id from pages where label = $1)
         and cc.layer = 'l2'
         and ($2::text is null or cc.state = $2)
       order by cc.state nulls last, age_days asc nulls last`,
      [label, stateFilter],
    );

    const byState = new Map<string, Row[]>();
    for (const r of rows) {
      const k = r.state ?? "(none)";
      (byState.get(k) ?? byState.set(k, []).get(k)!).push(r);
    }

    console.log(`\n=== ${label}: ${rows.length} L2 verdicts ===`);
    for (const [state, list] of byState) {
      console.log(`\n######## ${state.toUpperCase()} — ${list.length} ########`);
      for (const r of list) {
        const ltv = r.ltv_mills ? `$${(Number(r.ltv_mills) / 1000).toFixed(2)}` : "$?";
        const age = r.age_days != null ? `${Math.round(r.age_days)}d` : "?";
        console.log(
          `\n@${r.username}  [${r.tab ?? "?"} · ${ltv} · waited ${age} · last=${r.last_role} · reply=${r.needs_reply}]`,
        );
        console.log(`   reason: ${r.reason ?? "—"}`);
        for (const m of r.ctx ?? []) {
          console.log(`   ${ROLE(m.r)} | ${m.t.replace(/\s+/g, " ")}`);
        }
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
