// Show recent L2 classifier verdicts (real tail messages → decision) for one page.
//   (envs from .env)  node --import tsx/esm scripts/workboard-v2-show-verdicts.ts <pageLabel>
import { createPool } from "@agency_hub_core/db";

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required");
  const label = process.argv[2] ?? "Lora-1";
  const pool = createPool(url);
  try {
    const { rows } = await pool.query(
      `select left(coalesce(t.last_message_preview, ''), 60) as tail_message,
              c.needs_reply,
              c.layer
       from wb_closing_cache c
       join pages p on p.id = c.platform_account_id and p.label = $1
       left join page_dm_threads t
         on t.platform_account_id = c.platform_account_id and t.last_message_id = c.platform_message_id
       order by c.classified_at desc
       limit 15`,
      [label],
    );
    console.table(rows.map((r) => ({
      "tail message": r.tail_message,
      "needs reply?": r.needs_reply,
      layer: r.layer,
    })));
    const totals = await pool.query(
      `select c.needs_reply, count(*)::int as n
       from wb_closing_cache c join pages p on p.id = c.platform_account_id and p.label = $1
       group by c.needs_reply order by c.needs_reply`,
      [label],
    );
    console.log("totals by needs_reply:", totals.rows);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
