// Duration-weighted integration shards.
//
// `vitest --shard=k/N` on its own splits the resolved files by COUNT, so one
// shard can draw every slow file while another finishes a minute early. The
// sync-critical DB suite instead packs files by their measured wall time
// (tests/ci/shard-weights.json, regenerated with scripts/ci-shard-weights.mjs)
// with greedy longest-processing-time: heaviest file first, each onto the
// shard with the least work so far. Shard 1 starts with the API sync-critical
// run it executes after the DB suite (see .github/workflows/ci.yml).
//
// Every shard computes the whole plan from the same checkout, so the shards
// partition the files: each file lands in exactly one shard. A file without a
// recorded weight (a new test) gets the median weight and still runs.

export const SHARD_WEIGHTS_PATH = "tests/ci/shard-weights.json";
export const SHARD_WEIGHTS_VERSION = 1;

const TEST_FILE = /^tests\/[^\s]+\.test\.ts$/;

function positiveSeconds(value, what) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${what} must be a positive number of seconds`);
  }
  return value;
}

/** Validates a parsed weights document and returns it unchanged. */
export function validateShardWeights(document) {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("Shard weights must be a JSON object");
  }
  if (document.version !== SHARD_WEIGHTS_VERSION) {
    throw new Error(`Shard weights version must be ${SHARD_WEIGHTS_VERSION}`);
  }
  positiveSeconds(document.firstShardExtraSeconds, "firstShardExtraSeconds");
  const { files } = document;
  if (files === null || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("Shard weights files must be an object of test file -> seconds");
  }
  const entries = Object.entries(files);
  if (entries.length === 0) throw new Error("Shard weights list no files");
  for (const [file, seconds] of entries) {
    if (!TEST_FILE.test(file)) throw new Error(`Shard weight key is not a repo-relative test file: ${JSON.stringify(file)}`);
    positiveSeconds(seconds, `Weight of ${file}`);
  }
  return document;
}

export function parseShardWeights(text) {
  return validateShardWeights(JSON.parse(text));
}

// Whole milliseconds keep the packing exact and identical on every machine.
const toMs = seconds => Math.round(seconds * 1000);

function medianMs(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** The weight a file without a recorded duration gets: the median, in seconds. */
export function defaultShardWeight(weights) {
  return medianMs(Object.values(weights.files).map(toMs)) / 1000;
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Packs `files` into `count` shards. Returns every shard's files (sorted) and
 * its predicted seconds, including shard 1's extra work; `unweighted` lists
 * the files that took the default weight. With at least `count` files, no
 * shard is left empty.
 */
export function planWeightedShards(files, weights, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`Shard count must be a whole number of at least 1, got ${count}`);
  const fallbackMs = toMs(defaultShardWeight(weights));
  const unique = [...new Set(files)];
  const unweighted = unique.filter(file => !Object.hasOwn(weights.files, file)).sort(byCodeUnit);
  const items = unique
    .map(file => ({ file, ms: Object.hasOwn(weights.files, file) ? toMs(weights.files[file]) : fallbackMs }))
    // Heaviest first; equal weights in path order, so the plan never depends
    // on the order the files were resolved in.
    .sort((a, b) => b.ms - a.ms || byCodeUnit(a.file, b.file));
  const loads = Array.from({ length: count }, (_, index) => (index === 0 ? toMs(weights.firstShardExtraSeconds) : 0));
  const shards = Array.from({ length: count }, () => []);
  let empty = count;
  items.forEach((item, position) => {
    // Vitest fails a shard that gets no files ("No test files found"), so
    // once the files left are only enough for the empty shards, fill those.
    const fillEmpty = items.length - position <= empty;
    let target = -1;
    for (let index = 0; index < count; index += 1) {
      if (fillEmpty && shards[index].length > 0) continue;
      if (target === -1 || loads[index] < loads[target]) target = index;
    }
    if (shards[target].length === 0) empty -= 1;
    loads[target] += item.ms;
    shards[target].push(item.file);
  });
  return {
    shards: shards.map(list => list.sort(byCodeUnit)),
    seconds: loads.map(ms => ms / 1000),
    unweighted,
  };
}
