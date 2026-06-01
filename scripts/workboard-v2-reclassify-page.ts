// One-off: reclassify ONE page with the CURRENT code (strict buy_signal prompt +
// temperature:0), mirroring the dashboard "Переклассифицировать всё" button:
//   clear cache  →  classify backlog  →  recompute  →  (print buy_signal before/after)
//
//   DATABASE_URL=... ANTHROPIC_API_KEY=... \
//     node --import tsx/esm scripts/workboard-v2-reclassify-page.ts <pageLabel>
import { clearClosingCacheForPage, createDb, createPool, findPageSummaryByLabel } from "@agency_hub_core/db";
import type { Pool } from "pg";

import { resolveClosingSettings } from "../apps/runtime/src/services/workboard-v2/ai-settings.ts";
import { runClosingClassificationForPage } from "../apps/runtime/src/services/workboard-v2/classify-closing.ts";
import { createAnthropicClosingClassifier } from "../apps/runtime/src/services/workboard-v2/closing-classifier.ts";
import { recomputeWorkboardPage } from "../apps/runtime/src/services/workboard-v2/recompute.ts";

async function stateHistogram(pool: Pool, pageId: number): Promise<Record<string, number>> {
  try {
    const { rows } = await pool.query<{ state: string; n: number }>(
      `select coalesce(state, '(none)') as state, count(*)::int as n
       from wb_closing_cache where platform_account_id = $1 group by state`,
      [pageId],
    );
    return Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
  } catch {
    return { "(histogram unavailable)": -1 };
  }
}

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const model = process.env.WB_CLOSING_LLM_MODEL?.trim() || "claude-haiku-4-5";
  const label = process.argv[2] ?? "Lora-1";
  if (!url) throw new Error("DATABASE_URL is required");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");

  const eff = resolveClosingSettings(
    { anthropicApiKey: apiKey, wbClosingLlmEnabled: true, wbClosingLlmModel: model },
    null,
  );

  const pool = createPool(url);
  const db = createDb(pool);
  try {
    const page = await findPageSummaryByLabel(db, label);
    if (!page) {
      console.error(`Page "${label}" not found.`);
      process.exitCode = 1;
      return;
    }

    const before = await stateHistogram(pool, page.id);
    console.log(`BEFORE  buy_signal=${before.buy_signal ?? 0} ·`, before);

    const cleared = await clearClosingCacheForPage(db, page.id);
    console.log(`Cleared ${cleared} cached verdict(s). Reclassifying "${label}" with ${model} (temp 0)…`);

    const classifier = createAnthropicClosingClassifier({ apiKey, model });
    const result = await runClosingClassificationForPage(db, classifier, {
      platformAccountId: page.id,
      capMin: eff.capMin,
      capMax: eff.capMax,
    });
    console.log("classify:", result);

    const recompute = await recomputeWorkboardPage(db, { platformAccountId: page.id });
    console.log(`recompute: evaluated ${recompute.evaluated} fan(s).`);

    const after = await stateHistogram(pool, page.id);
    console.log(`AFTER   buy_signal=${after.buy_signal ?? 0} ·`, after);
    console.log(
      `\nΔ buy_signal: ${before.buy_signal ?? 0} → ${after.buy_signal ?? 0}` +
        `  (smalltalk ${before.smalltalk ?? 0} → ${after.smalltalk ?? 0})`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
