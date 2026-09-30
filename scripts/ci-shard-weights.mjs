// Regenerates tests/ci/shard-weights.json from finished CI runs. Read-only
// against GitHub: it downloads the integration shard logs with `gh`.
//
//   node scripts/ci-shard-weights.mjs <run-id>...           # print the new file
//   node scripts/ci-shard-weights.mjs <run-id>... --write   # replace it
//   node scripts/ci-shard-weights.mjs --log <job.log>...    # saved job logs
//
// Pick recent green runs on the PC pool (`workflow_dispatch` with full=true
// runs every shard) while nothing else ran on the PC. A file's weight is its
// own time: the duration vitest reports for it, plus the job's setup, import
// and environment time per file (vitest's "Duration (…)" line sums them),
// divided by the files the job ran at once (--maxWorkers of the DB step's
// SYNC_CRITICAL_DB_PARALLELISM, 2 on the PC; 1 without --fileParallelism).
// So weights are seconds of shard wall time, as firstShardExtraSeconds is,
// whatever order the files ran in. Not the time between two completions:
// with two files at a time, a slow file that finishes just after its
// neighbour would measure almost nothing. Several runs give the median per
// file. firstShardExtraSeconds is the wall time of the "Sync-critical API
// tests" step shard 1 runs afterwards.
//
// Files the given runs did not measure keep their earlier weight while they
// still exist; deleted files drop out. The summary on stderr shows the
// predicted per-shard seconds for 3 and 6 shards.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SHARD_WEIGHTS_PATH, SHARD_WEIGHTS_VERSION, parseShardWeights, planWeightedShards, validateShardWeights } from "./ci-shard-plan.mjs";

const DB_STEP = "##[group]Run pnpm test:sync-critical:db";
const API_STEP = "##[group]Run pnpm test:sync-critical:api";
const LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?(.*)$/;
// " ✓ tests/x.integration.test.ts (32 tests) 8718ms"; a failed file is ❯ or ×.
const FILE_RESULT = /^\s*[✓✗×❯↓]\s+(tests\/\S+?\.test\.ts)\s+\([^)]*\)(?:\s+(\d+)\s*ms)?/;
// The step's env block: "--fileParallelism --maxWorkers=2" on the PC, empty on GitHub.
const PARALLELISM = /^\s*SYNC_CRITICAL_DB_PARALLELISM:(.*)$/;
// "   Duration  112.01s (transform 8.95s, setup 0ms, import 67.94s, tests 123.46s, environment 5ms)"
const SUMMARY = /^\s*Duration\s+\S+\s+\((.+)\)\s*$/;
const TIMER = /\b(\w+) (\d+(?:\.\d+)?)(ms|s)\b/g;
const ANSI = new RegExp(String.raw`\u001b\[[0-9;]*[A-Za-z]`, "g");

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const seconds = value => Math.max(0.1, Math.round(value * 10) / 10);

/** Files the DB step ran at once, from its SYNC_CRITICAL_DB_PARALLELISM flags. */
function filesAtOnce(flags) {
  if (!/--fileParallelism\b/.test(flags)) return 1;
  const workers = /--maxWorkers[= ](\d+)(?:\s|$)/.exec(flags);
  if (!workers) throw new Error(`Cannot tell how many files ran at once from SYNC_CRITICAL_DB_PARALLELISM:${flags}`);
  return Number(workers[1]);
}

/**
 * One integration job's log: every file the DB step reported with its share
 * of the shard's wall seconds (see the header), and the API step's wall
 * seconds (null when the job has none).
 */
export function parseJobLog(text) {
  const reported = [];
  let section = null;
  let apiStart = null;
  let apiEnd = null;
  let atOnce = null;
  let timers = null;
  for (const raw of text.split(/\r?\n/)) {
    const match = LINE.exec(raw.replace(ANSI, "").replace(/^\uFEFF/, ""));
    if (!match) continue;
    const at = Date.parse(match[1]);
    const body = match[2];
    if (body.startsWith(DB_STEP)) {
      section = "db";
      continue;
    }
    if (body.startsWith(API_STEP)) {
      section = "api";
      apiStart = at;
      continue;
    }
    if (section !== null && (body.startsWith("##[group]Run ") || body.startsWith("Post job cleanup."))) {
      if (section === "api") apiEnd = at;
      section = null;
      continue;
    }
    if (section === "api") apiEnd = at;
    if (section !== "db") continue;
    const parallelism = PARALLELISM.exec(body);
    if (parallelism) atOnce = filesAtOnce(parallelism[1]);
    const summary = SUMMARY.exec(body);
    if (summary) {
      timers = Object.fromEntries([...summary[1].matchAll(TIMER)].map(([, name, value, unit]) => [name, Number(value) / (unit === "ms" ? 1000 : 1)]));
    }
    const result = FILE_RESULT.exec(body);
    if (result) reported.push({ file: result[1], ms: result[2] === undefined ? 0 : Number(result[2]) });
  }
  if (reported.length === 0) throw new Error("No sync-critical DB file results in this log");
  if (atOnce === null) throw new Error("No SYNC_CRITICAL_DB_PARALLELISM in the DB step: cannot tell how many files ran at once");
  if (timers?.import === undefined) throw new Error("No vitest Duration summary with import time in the DB step");
  const overhead = ((timers.setup ?? 0) + timers.import + (timers.environment ?? 0)) / reported.length;
  return {
    files: reported.map(entry => ({ file: entry.file, seconds: (entry.ms / 1000 + overhead) / atOnce })),
    apiSeconds: apiStart !== null && apiEnd !== null ? (apiEnd - apiStart) / 1000 : null,
  };
}

/**
 * Median weights from parsed job logs. Files not measured keep `previous`
 * weights while `exists(file)` holds; firstShardExtraSeconds likewise.
 */
export function buildShardWeights(jobs, previous, exists) {
  const samples = new Map();
  const api = [];
  for (const job of jobs) {
    for (const { file, seconds: value } of job.files) samples.set(file, [...(samples.get(file) ?? []), value]);
    if (job.apiSeconds !== null) api.push(job.apiSeconds);
  }
  const files = {};
  for (const [file, value] of Object.entries(previous?.files ?? {})) {
    if (!samples.has(file) && exists(file)) files[file] = value;
  }
  for (const [file, values] of samples) files[file] = seconds(median(values));
  const extra = api.length > 0 ? seconds(median(api)) : previous?.firstShardExtraSeconds;
  if (extra === undefined) throw new Error("No Sync-critical API tests step in these logs and no earlier weights to keep");
  const sorted = Object.fromEntries(Object.keys(files).sort().map(file => [file, files[file]]));
  return validateShardWeights({ version: SHARD_WEIGHTS_VERSION, firstShardExtraSeconds: extra, files: sorted });
}

export function formatShardWeights(weights) {
  return `${JSON.stringify(weights, null, 2)}\n`;
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
}

function fetchRunLogs(repo, runId) {
  const { jobs } = JSON.parse(gh(["api", `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`]));
  const integration = jobs.filter(job => /^Integration \d+\/\d+$/.test(job.name));
  // A failed or cancelled shard's timings are not the suite's normal ones.
  for (const job of integration.filter(job => job.conclusion !== "success")) {
    console.error(`run ${runId}: skipping ${job.name} (${job.conclusion ?? job.status})`);
  }
  const shards = integration.filter(job => job.conclusion === "success");
  if (shards.length === 0) throw new Error(`Run ${runId} has no successful integration shards`);
  return shards.map(job => {
    const hosted = /^GitHub Actions/.test(job.runner_name ?? "") ? " (GitHub-hosted: slower than the PC)" : "";
    console.error(`run ${runId}: ${job.name} on ${job.runner_name ?? "?"}${hosted}`);
    // Vitest colours its output; gh refuses to print escape sequences unless told.
    return gh(["api", "--allow-escape-sequences", `repos/${repo}/actions/jobs/${job.id}/logs`]);
  });
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const weightsFile = path.join(root, SHARD_WEIGHTS_PATH);
  let repo = process.env.GH_REPO || "goslingmanagment/hub";
  let write = false;
  const runs = [];
  const logs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") write = true;
    else if (arg === "--repo") repo = argv[++index];
    else if (arg === "--log") logs.push(argv[++index]);
    else if (/^\d+$/.test(arg)) runs.push(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (runs.length === 0 && logs.length === 0) {
    throw new Error("Usage: node scripts/ci-shard-weights.mjs <run-id>... [--repo owner/name] [--write] | --log <job.log>...");
  }
  const texts = [...logs.map(file => readFileSync(file, "utf8")), ...runs.flatMap(run => fetchRunLogs(repo, run))];
  const previous = existsSync(weightsFile) ? parseShardWeights(readFileSync(weightsFile, "utf8")) : undefined;
  const weights = buildShardWeights(texts.map(parseJobLog), previous, file => existsSync(path.join(root, file)));
  const all = Object.keys(weights.files);
  for (const count of [3, 6]) {
    const plan = planWeightedShards(all, weights, count);
    console.error(`${count} shards: ${plan.seconds.map(value => `${Math.round(value)}s`).join(" ")} (shard 1 includes ${weights.firstShardExtraSeconds}s API)`);
  }
  if (write) {
    writeFileSync(weightsFile, formatShardWeights(weights));
    console.error(`Wrote ${all.length} file weights to ${SHARD_WEIGHTS_PATH}`);
  } else {
    process.stdout.write(formatShardWeights(weights));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
