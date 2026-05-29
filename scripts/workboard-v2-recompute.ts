// One-off / cron-friendly Workboard v2 recompute.
//   DATABASE_URL=... node --import tsx/esm scripts/workboard-v2-recompute.ts <pageLabel|all>
import {
  createDb,
  createPool,
  findPageSummaryByLabel,
  getWorkboardV2Counts,
} from "@agency_hub_core/db";

import {
  recomputeAllWorkboardPages,
  recomputeWorkboardPage,
} from "../apps/runtime/src/services/workboard-v2/recompute.ts";

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }
  const target = process.argv[2] ?? "all";
  const pool = createPool(url);
  const db = createDb(pool);

  try {
    if (target === "all") {
      const result = await recomputeAllWorkboardPages(db, {});
      console.log(`Recomputed ${result.pages} page(s), evaluated ${result.evaluated} fan(s).`);
      return;
    }

    const page = await findPageSummaryByLabel(db, target);
    if (!page) {
      console.error(`Page "${target}" not found.`);
      process.exitCode = 1;
      return;
    }
    if (page.platform !== "fansly") {
      console.warn("Workboard v2 is Fansly-only (matching v1 scope).");
    }

    const result = await recomputeWorkboardPage(db, { platformAccountId: page.id });
    console.log(`Page "${target}" (id=${page.id}) — evaluated ${result.evaluated} fan(s) from page_fans.`);

    const counts = await getWorkboardV2Counts(db, page.id);
    const byTab = new Map<string, number>();
    for (const c of counts) {
      byTab.set(c.tab, (byTab.get(c.tab) ?? 0) + c.count);
    }
    console.log("workboard_state by tab:", Object.fromEntries(byTab));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
