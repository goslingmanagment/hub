import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// How many integration shards one CI run splits the sync-critical suite into.
// GitHub-hosted runs keep three. The owner's PC (CI_POOL=pc) runs several
// runners side by side, so its count is the repository variable
// CI_PC_SHARDS. The PC count applies only to a first attempt, the same rule
// that routes runners: "Re-run all jobs" goes hosted and gets three shards,
// while "Re-run failed jobs" reuses this plan from the first attempt, so a
// re-run leg keeps its shard total and the file split stays whole.
export const DEFAULT_SHARD_TOTAL = 3;
const MAX_PC_SHARD_TOTAL = 8;

export function planShards(env) {
  const onPc = env.CI_POOL === "pc" && env.RUN_ATTEMPT === "1";
  const requested = (env.CI_PC_SHARDS ?? "").trim();
  let total = DEFAULT_SHARD_TOTAL;
  let warning = "";
  if (onPc && requested !== "") {
    const value = /^[1-9]\d*$/.test(requested) ? Number(requested) : Number.NaN;
    if (value >= 1 && value <= MAX_PC_SHARD_TOTAL) {
      total = value;
    } else {
      // An unusable value never stops the gate: fall back and say so.
      warning = `CI_PC_SHARDS=${JSON.stringify(requested)} is not a whole number from 1 to ${MAX_PC_SHARD_TOTAL}; using ${DEFAULT_SHARD_TOTAL} shards.`;
    }
  }
  return { total, shards: Array.from({ length: total }, (_, index) => index + 1), warning };
}

/** The step outputs the integration matrix reads. */
export function shardOutputs(plan) {
  return `shards=${JSON.stringify(plan.shards)}\nshard_total=${plan.total}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    console.error("GITHUB_OUTPUT is not set");
    process.exit(1);
  }
  const plan = planShards(process.env);
  if (plan.warning) console.log(`::warning title=Invalid CI_PC_SHARDS::${plan.warning}`);
  appendFileSync(output, shardOutputs(plan));
  console.log(`Integration shards: ${plan.total}`);
}
