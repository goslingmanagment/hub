// Verify + run the L2 closing classifier for one page (small cap for a safe first run).
//   (envs from .env)  node --import tsx/esm scripts/workboard-v2-classify.ts <pageLabel> [capMax]
import { createDb, createPool, findPageSummaryByLabel } from "@agency_hub_core/db";

import { runClosingClassificationForPage } from "../apps/runtime/src/services/workboard-v2/classify-closing.ts";
import { createAnthropicClosingClassifier } from "../apps/runtime/src/services/workboard-v2/closing-classifier.ts";
import { recomputeWorkboardPage } from "../apps/runtime/src/services/workboard-v2/recompute.ts";

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const model = process.env.WB_CLOSING_LLM_MODEL?.trim() || "claude-haiku-4-5";
  const label = process.argv[2] ?? "Lora-1";
  const capMax = Number(process.argv[3] ?? 10);

  if (!url) throw new Error("DATABASE_URL is required");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");

  const classifier = createAnthropicClosingClassifier({ apiKey, model });

  // 1) Direct probe — proves the key + model + parsing work (surfaces a clear error otherwise).
  console.log(`Probing classifier (model=${model})…`);
  const probe = await classifier.classifyBatch([
    {
      id: "a",
      context: [
        { role: "creator", text: "had so much fun chatting tonight 💕" },
        { role: "fan", text: "thanks babe, goodnight 😘" },
      ],
    },
    {
      id: "b",
      // Context-aware: "yes" alone is ambiguous, but after a paid offer it's a buy_signal.
      context: [
        { role: "creator", text: "want me to send you that custom video? it's $30" },
        { role: "fan", text: "yes!! send it" },
      ],
    },
  ]);
  console.log("  probe verdicts:", probe.verdicts, `(tokens in/out: ${probe.inputTokens}/${probe.outputTokens})`);

  const pool = createPool(url);
  const db = createDb(pool);
  try {
    const page = await findPageSummaryByLabel(db, label);
    if (!page) {
      console.error(`Page "${label}" not found.`);
      process.exitCode = 1;
      return;
    }

    console.log(`Classifying >24h tails for "${label}" (capMax=${capMax})…`);
    const result = await runClosingClassificationForPage(db, classifier, {
      platformAccountId: page.id,
      capMin: 1,
      capMax,
    });
    console.log("  classify:", result);

    const recompute = await recomputeWorkboardPage(db, { platformAccountId: page.id });
    console.log(`  recompute: evaluated ${recompute.evaluated} fan(s).`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
