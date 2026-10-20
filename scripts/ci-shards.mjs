import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SHARD_WEIGHTS_PATH, parseShardWeights } from "./ci-shard-plan.mjs";

// The CI run's layout, planned once by the fingerprint job: how many
// integration shards split the sync-critical suite, and which parts the
// static checks run as.
//
// The pool is decided as runs-on decides it (.github/workflows/ci.yml): the
// owner's PC (CI_POOL=pc) takes a first attempt of a push, a manual run or a
// PR from this repository; everything else — any other CI_POOL, a re-run, a
// PR from a fork — runs on GitHub-hosted runners.
//
// PC: the shard count is the repository variable CI_PC_SHARDS (default 3),
// and the static checks stay ONE job that runs lint and the unit tests in the
// background beside typecheck (the PC's runners share 24 threads).
// GitHub-hosted (4 vCPUs a runner): the shard count is CI_HOSTED_SHARDS
// (default 6), and the static checks split into parallel jobs — typecheck,
// lint, unit tests, the image — each on a runner of its own.
//
// "Re-run failed jobs" reuses this plan from the first attempt (the
// fingerprint job passed and is not re-run), so a re-run leg keeps its shard
// total and its static part; "Re-run all jobs" plans again, for GitHub.
export const DEFAULT_PC_SHARD_TOTAL = 3;
export const DEFAULT_HOSTED_SHARD_TOTAL = 6;
export const MAX_SHARD_TOTAL = 8;
// Every shard pays a fixed cost (runner, install, Postgres and its migrated
// template), so a small suite runs on fewer shards: no more than its measured
// file work needs at this many seconds a shard. The weights are measured on
// the PC; a hosted runner is slower and starts in parallel for free, so it
// takes less of that work a shard. The count only ever drops.
export const TARGET_SHARD_SECONDS = { pc: 150, hosted: 60 };
export const STATIC_PARTS = { pc: ["all"], hosted: ["typecheck", "lint", "unit", "image"] };

/** "pc" or "hosted", as runs-on routes this run's first-attempt jobs. */
export function poolOf(env) {
  return env.CI_POOL === "pc" && env.RUN_ATTEMPT === "1" && env.PR_FROM_FORK !== "true" ? "pc" : "hosted";
}

/** Shards the measured weights need at the pool's target seconds each. */
export function neededShards(weights, pool = "pc") {
  const seconds = Object.values(weights.files).reduce((sum, value) => sum + value, weights.firstShardExtraSeconds);
  return Math.max(1, Math.ceil(seconds / TARGET_SHARD_SECONDS[pool]));
}

export function planShards(env, weights = null) {
  const pool = poolOf(env);
  const variable = pool === "pc" ? "CI_PC_SHARDS" : "CI_HOSTED_SHARDS";
  const fallback = pool === "pc" ? DEFAULT_PC_SHARD_TOTAL : DEFAULT_HOSTED_SHARD_TOTAL;
  const requested = (env[variable] ?? "").trim();
  let total = fallback;
  let warning = "";
  if (requested !== "") {
    const value = /^[1-9]\d*$/.test(requested) ? Number(requested) : Number.NaN;
    if (value >= 1 && value <= MAX_SHARD_TOTAL) {
      total = value;
    } else {
      // An unusable value never stops the gate: fall back and say so.
      warning = `${variable}=${JSON.stringify(requested)} is not a whole number from 1 to ${MAX_SHARD_TOTAL}; using ${fallback} shards.`;
    }
  }
  if (weights) total = Math.min(total, neededShards(weights, pool));
  return {
    pool,
    total,
    shards: Array.from({ length: total }, (_, index) => index + 1),
    staticParts: STATIC_PARTS[pool],
    warning,
  };
}

/** The step outputs the static and integration matrices read. */
export function shardOutputs(plan) {
  return `shards=${JSON.stringify(plan.shards)}\nshard_total=${plan.total}\nstatic_parts=${JSON.stringify(plan.staticParts)}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    console.error("GITHUB_OUTPUT is not set");
    process.exit(1);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const plan = planShards(process.env, parseShardWeights(readFileSync(path.join(root, SHARD_WEIGHTS_PATH), "utf8")));
  if (plan.warning) console.log(`::warning title=Invalid shard count::${plan.warning}`);
  appendFileSync(output, shardOutputs(plan));
  console.log(`Pool: ${plan.pool}; integration shards: ${plan.total}; static parts: ${plan.staticParts.join(", ")}`);
}
