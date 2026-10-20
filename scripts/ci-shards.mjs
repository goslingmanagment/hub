import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SHARD_WEIGHTS_PATH, parseShardWeights } from "./ci-shard-plan.mjs";

// How many integration shards one CI run splits the sync-critical suite into,
// planned once by the fingerprint job. CI runs on GitHub-hosted runners only
// (4 vCPUs each, free on this public repository): the count is the repository
// variable CI_HOSTED_SHARDS (1..8, default 6). "Re-run failed jobs" reuses
// this plan from the first attempt (the fingerprint job passed and is not
// re-run), so a re-run leg keeps its shard total and the file split stays
// whole.
export const DEFAULT_SHARD_TOTAL = 6;
export const MAX_SHARD_TOTAL = 8;
// Every shard pays a fixed cost (runner, install, Postgres and its migrated
// template), so a small suite runs on fewer shards: no more than its measured
// file work needs at this many seconds a shard. The count only ever drops.
// (Measured 20.10 at six shards: 58-81 s of DB tests a shard, ~1.5 min a job.)
export const TARGET_SHARD_SECONDS = 60;

/** Shards the measured weights need at TARGET_SHARD_SECONDS each. */
export function neededShards(weights) {
  const seconds = Object.values(weights.files).reduce((sum, value) => sum + value, weights.firstShardExtraSeconds);
  return Math.max(1, Math.ceil(seconds / TARGET_SHARD_SECONDS));
}

export function planShards(env, weights = null) {
  const requested = (env.CI_HOSTED_SHARDS ?? "").trim();
  let total = DEFAULT_SHARD_TOTAL;
  let warning = "";
  if (requested !== "") {
    const value = /^[1-9]\d*$/.test(requested) ? Number(requested) : Number.NaN;
    if (value >= 1 && value <= MAX_SHARD_TOTAL) {
      total = value;
    } else {
      // An unusable value never stops the gate: fall back and say so.
      warning = `CI_HOSTED_SHARDS=${JSON.stringify(requested)} is not a whole number from 1 to ${MAX_SHARD_TOTAL}; using ${DEFAULT_SHARD_TOTAL} shards.`;
    }
  }
  if (weights) total = Math.min(total, neededShards(weights));
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
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const plan = planShards(process.env, parseShardWeights(readFileSync(path.join(root, SHARD_WEIGHTS_PATH), "utf8")));
  if (plan.warning) console.log(`::warning title=Invalid CI_HOSTED_SHARDS::${plan.warning}`);
  appendFileSync(output, shardOutputs(plan));
  console.log(`Integration shards: ${plan.total}`);
}
