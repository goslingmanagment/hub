// Regenerates tests/ci/shard-weights.json from finished CI runs. Read-only
// against GitHub: it downloads the integration shard logs with `gh`.
//
//   node scripts/ci-shard-weights.mjs <run-id>...           # print the new file
//   node scripts/ci-shard-weights.mjs <run-id>... --write   # replace it
//   node scripts/ci-shard-weights.mjs --log <job.log>...    # saved job logs
//
// Pick recent green runs on the PC pool (`workflow_dispatch` with full=true
// runs every shard). A file's weight is its wall time inside the shard: the
// time between vitest reporting the previous file and reporting this one, so
// module import and database acquisition count, not only the tests. The first
// file of a run also waits for global setup; it gets its own reported
// duration plus the median per-file overhead instead. Several runs give the
// median per file. firstShardExtraSeconds is the wall time of the
// "Sync-critical API tests" step shard 1 runs afterwards.
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
const ANSI = new RegExp(String.raw`\u001b\[[0-9;]*[A-Za-z]`, "g");

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const seconds = value => Math.max(0.1, Math.round(value * 10) / 10);

/**
 * One integration job's log: the wall seconds of every file the DB step
 * reported, and the API step's wall seconds (null when the job has none).
 */
export function parseJobLog(text) {
  const reported = [];
  let section = null;
  let apiStart = null;
  let apiEnd = null;
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
    const result = FILE_RESULT.exec(body);
    if (result) reported.push({ file: result[1], at, ms: result[2] === undefined ? 0 : Number(result[2]) });
  }
  if (reported.length === 0) throw new Error("No sync-critical DB file results in this log");
  const walls = reported.map((entry, index) => (index === 0 ? null : (entry.at - reported[index - 1].at) / 1000));
  const overheads = reported.slice(1).map((entry, index) => Math.max(0, (walls[index + 1] ?? 0) - entry.ms / 1000));
  const firstOverhead = overheads.length === 0 ? 0 : median(overheads);
  return {
    files: reported.map((entry, index) => ({ file: entry.file, seconds: walls[index] ?? entry.ms / 1000 + firstOverhead })),
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
