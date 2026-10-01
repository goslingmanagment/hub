import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { BaseSequencer } from "vitest/node";
import type { TestSpecification, Vitest } from "vitest/node";

import {
  SHARD_WEIGHTS_PATH,
  defaultShardWeight,
  orderShardFiles,
  parseShardWeights,
  planWeightedShards,
  validateShardWeights,
} from "../scripts/ci-shard-plan.mjs";
import type { ShardWeights } from "../scripts/ci-shard-plan.mjs";
import { buildShardWeights, formatShardWeights, parseJobLog } from "../scripts/ci-shard-weights.mjs";
import { syncCriticalDbFiles } from "./helpers/sync-critical-files.ts";
import { WeightedShardSequencer, shardKey } from "./helpers/weighted-shard-sequencer.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const committed = parseShardWeights(readFileSync(path.join(repoRoot, SHARD_WEIGHTS_PATH), "utf8"));
const suite = syncCriticalDbFiles();
const SHARD_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8];

function weights(files: Record<string, number>, firstShardExtraSeconds = 20): ShardWeights {
  return validateShardWeights({ version: 1, firstShardExtraSeconds, files });
}

/** Every input file exactly once across the shards, and nothing else. */
function expectPartition(shards: readonly (readonly string[])[], files: readonly string[]) {
  const placed = shards.flat();
  expect(placed).toHaveLength(new Set(placed).size);
  expect([...placed].sort()).toEqual([...new Set(files)].sort());
}

// No results cache, as in CI: BaseSequencer.sort runs the largest file first.
const cache = {
  getFileTestResults: () => undefined,
  getFileStats: (key: string) => ({ size: statSync(path.join(repoRoot, key.slice(key.indexOf(":") + 1))).size }),
};

function context(shard: { index: number; count: number } | undefined, log = vi.fn()) {
  return { config: { root: repoRoot, shard }, logger: { log }, cache } as unknown as Vitest;
}

function sequencer(shard: { index: number; count: number } | undefined, log = vi.fn()) {
  return new WeightedShardSequencer(context(shard, log));
}

const project = { name: "", config: { sequence: { groupOrder: 0 }, isolate: true } };
const specs = (files: readonly string[]) =>
  files.map(file => ({ moduleId: path.join(repoRoot, file), project }) as unknown as TestSpecification);

describe("weighted shard plan", () => {
  it.each(SHARD_COUNTS)("puts every file in exactly one of %i shards with unweighted and repeated files", count => {
    const files = ["tests/new-a.integration.test.ts", ...Object.keys(committed.files).slice(0, 20), "tests/new-b.integration.test.ts", "tests/new-a.integration.test.ts"];
    const plan = planWeightedShards(files, committed, count);
    expectPartition(plan.shards, files);
    expect(plan.unweighted).toEqual(["tests/new-a.integration.test.ts", "tests/new-b.integration.test.ts"]);
  });

  it("gives a file without a recorded weight the median weight", () => {
    expect(defaultShardWeight(weights({ "tests/a.test.ts": 1, "tests/b.test.ts": 3, "tests/c.test.ts": 10 }))).toBe(3);
    expect(defaultShardWeight(weights({ "tests/a.test.ts": 1, "tests/b.test.ts": 4 }))).toBe(2.5);
    // The newcomer weighs 3, like b: a, b and it together stay under c.
    const plan = planWeightedShards(
      ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/new.test.ts"],
      weights({ "tests/a.test.ts": 1, "tests/b.test.ts": 3, "tests/c.test.ts": 10 }, 0.1),
      2,
    );
    expect(plan.shards).toEqual([["tests/a.test.ts", "tests/b.test.ts", "tests/new.test.ts"], ["tests/c.test.ts"]]);
    expect(plan.seconds).toEqual([7.1, 10]);
    expect(plan.unweighted).toEqual(["tests/new.test.ts"]);
  });

  it("is deterministic whatever order the files resolve in", () => {
    const reversed = [...suite].reverse();
    const shuffled = [...suite].sort((a, b) => (a.length % 7) - (b.length % 7) || (a < b ? 1 : -1));
    for (const count of SHARD_COUNTS) {
      const plan = planWeightedShards(suite, committed, count);
      expect(planWeightedShards(reversed, committed, count)).toEqual(plan);
      expect(planWeightedShards(shuffled, committed, count)).toEqual(plan);
    }
    // Equal weights fall back to path order, never to input order.
    const equal = weights({ "tests/a.test.ts": 1, "tests/b.test.ts": 1, "tests/c.test.ts": 1 }, 0.5);
    expect(planWeightedShards(["tests/c.test.ts", "tests/b.test.ts", "tests/a.test.ts"], equal, 2).shards)
      .toEqual([["tests/b.test.ts"], ["tests/a.test.ts", "tests/c.test.ts"]]);
  });

  it("starts shard 1 with the API run it executes afterwards", () => {
    const files = { "tests/a.test.ts": 10, "tests/b.test.ts": 10, "tests/c.test.ts": 10, "tests/d.test.ts": 10 };
    const light = planWeightedShards(Object.keys(files), weights(files, 0.1), 2);
    expect(light.shards.map(shard => shard.length)).toEqual([2, 2]);
    const heavy = planWeightedShards(Object.keys(files), weights(files, 15), 2);
    expect(heavy.shards.map(shard => shard.length)).toEqual([1, 3]);
    expect(heavy.seconds).toEqual([25, 30]);
  });

  it.each(SHARD_COUNTS)("keeps %i shards within one file's weight of each other on the recorded weights", count => {
    const plan = planWeightedShards(Object.keys(committed.files), committed, count);
    const heaviest = Math.max(committed.firstShardExtraSeconds, ...Object.values(committed.files));
    expect(Math.max(...plan.seconds) - Math.min(...plan.seconds)).toBeLessThanOrEqual(heaviest);
    const total = Object.values(committed.files).reduce((sum, value) => sum + value, committed.firstShardExtraSeconds);
    expect(plan.seconds.reduce((sum, value) => sum + value, 0)).toBeCloseTo(total, 6);
  });

  it.each(SHARD_COUNTS)("never leaves one of %i shards without files while there are enough files", count => {
    // Shard 1's extra work alone outweighs every file here.
    for (let extra = 0; extra <= 2; extra += 1) {
      const files = Array.from({ length: count + extra }, (_, index) => `tests/f${index}.test.ts`);
      const plan = planWeightedShards(files, weights(Object.fromEntries(files.map(file => [file, 1])), 1000), count);
      expectPartition(plan.shards, files);
      for (const shard of plan.shards) expect(shard.length).toBeGreaterThan(0);
    }
  });

  it("rejects a shard count below one", () => {
    expect(() => planWeightedShards(suite, committed, 0)).toThrow("Shard count");
    expect(() => planWeightedShards(suite, committed, 1.5)).toThrow("Shard count");
  });

  it("orders a shard's files heaviest first, equal weights in path order, a new file at the median", () => {
    // The median of 1, 3, 3 and 10 is 3: the newcomer sorts with b and d, by path.
    const recorded = weights({ "tests/a.test.ts": 1, "tests/b.test.ts": 3, "tests/c.test.ts": 10, "tests/d.test.ts": 3 });
    const expected = ["tests/c.test.ts", "tests/b.test.ts", "tests/d.test.ts", "tests/new.test.ts", "tests/a.test.ts"];
    expect(orderShardFiles(["tests/a.test.ts", "tests/new.test.ts", "tests/d.test.ts", "tests/b.test.ts", "tests/c.test.ts"], recorded)).toEqual(expected);
    expect(orderShardFiles([...expected].reverse(), recorded)).toEqual(expected);
    // Any item type, keyed by its path; the items themselves come back.
    const items = expected.map(file => ({ file }));
    const ordered = orderShardFiles([...items].reverse(), recorded, item => item.file);
    expect(ordered).toEqual(items);
    ordered.forEach((item, index) => expect(item).toBe(items[index]));
  });
});

describe("shard weights file", () => {
  it("is valid, sorted and formatted as the generator writes it", () => {
    const text = readFileSync(path.join(repoRoot, SHARD_WEIGHTS_PATH), "utf8");
    expect(formatShardWeights(committed)).toBe(text);
    const keys = Object.keys(committed.files);
    expect(keys).toEqual([...keys].sort());
    expect(committed.firstShardExtraSeconds).toBeGreaterThan(0);
  });

  it.each([
    [null, "JSON object"],
    [[], "JSON object"],
    [{ version: 2, firstShardExtraSeconds: 1, files: { "tests/a.test.ts": 1 } }, "version"],
    [{ version: 1, files: { "tests/a.test.ts": 1 } }, "firstShardExtraSeconds"],
    [{ version: 1, firstShardExtraSeconds: 0, files: { "tests/a.test.ts": 1 } }, "firstShardExtraSeconds"],
    [{ version: 1, firstShardExtraSeconds: 1, files: [] }, "files"],
    [{ version: 1, firstShardExtraSeconds: 1, files: {} }, "no files"],
    [{ version: 1, firstShardExtraSeconds: 1, files: { "tests/a.test.ts": -1 } }, "tests/a.test.ts"],
    [{ version: 1, firstShardExtraSeconds: 1, files: { "tests/a.test.ts": "3" } }, "tests/a.test.ts"],
    [{ version: 1, firstShardExtraSeconds: 1, files: { "tests/a.test.ts": Number.NaN } }, "tests/a.test.ts"],
    [{ version: 1, firstShardExtraSeconds: 1, files: { "/abs/tests/a.test.ts": 1 } }, "repo-relative"],
    [{ version: 1, firstShardExtraSeconds: 1, files: { "tests\\a.test.ts": 1 } }, "repo-relative"],
  ])("rejects %j", (document, message) => {
    expect(() => validateShardWeights(document)).toThrow(message);
  });
});

describe("WeightedShardSequencer", () => {
  it.each(SHARD_COUNTS)("hands each sync-critical DB file to exactly one of %i vitest shards", async count => {
    const input = specs(suite);
    const selected: string[][] = [];
    for (let index = 1; index <= count; index += 1) {
      const chosen = await sequencer({ index, count }).shard(input);
      for (const spec of chosen) expect(input).toContain(spec);
      selected.push(chosen.map(spec => shardKey(repoRoot, spec.moduleId)));
    }
    expectPartition(selected, suite);
    expect(suite.length).toBeGreaterThan(8);
    for (const shard of selected) expect(shard.length).toBeGreaterThan(0);
    expect(selected).toEqual(planWeightedShards(suite, committed, count).shards);
  });

  it("reports what it chose, including files that took the median", async () => {
    const log = vi.fn();
    const files = [...suite.slice(0, 5), "tests/brand-new.integration.test.ts"];
    const chosen = await sequencer({ index: 2, count: 2 }, log).shard(specs(files));
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toMatch(new RegExp(`^Weighted shard 2/2: ${chosen.length} of 6 files, ~\\d+s of file work predicted; 1 without a recorded weight \\(median used\\) \\(tests/ci/shard-weights\\.json\\)$`));
  });

  it.each(SHARD_COUNTS)("starts the files of each of %i shards heaviest first, equal weights in path order", async count => {
    const input = specs(suite);
    for (let index = 1; index <= count; index += 1) {
      const chosen = await sequencer({ index, count }).shard(input);
      const sorted = await sequencer({ index, count }).sort(chosen);
      // Only the order changes: the same specs shard() chose, each once.
      expect(sorted).toHaveLength(chosen.length);
      expect(new Set(sorted)).toEqual(new Set(chosen));
      const keys = sorted.map(spec => shardKey(repoRoot, spec.moduleId));
      const weight = (key: string) => committed.files[key] ?? defaultShardWeight(committed);
      for (let at = 1; at < keys.length; at += 1) {
        const [before, after] = [keys[at - 1] ?? "", keys[at] ?? ""];
        expect(weight(after)).toBeLessThanOrEqual(weight(before));
        if (weight(after) === weight(before)) expect(before < after).toBe(true);
      }
      expect(keys).toEqual(orderShardFiles([...keys].sort(), committed));
    }
  });

  it("leaves an unsharded run alone: no shard() filtering and BaseSequencer's order", async () => {
    const input = specs(suite);
    const log = vi.fn();
    expect(await sequencer(undefined, log).shard(input)).toBe(input);
    expect(log).not.toHaveBeenCalled();
    const base = await new BaseSequencer(context(undefined)).sort(input);
    expect(await sequencer(undefined).sort(input)).toEqual(base);
    // That order is BaseSequencer's own: the largest file first.
    const sizes = base.map(spec => statSync(spec.moduleId).size);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

});

// A trimmed PC job log: GitHub timestamps every line; vitest colours its output.
const PC_PARALLELISM = "  SYNC_CRITICAL_DB_PARALLELISM: --fileParallelism --maxWorkers=2";
const SECOND_DONE = "2026-09-28T23:03:14.0000000Z  ✓ tests/second";
const esc = "\u001b";
const jobLog = [
  "\uFEFF2026-09-28T23:02:35.0000000Z ##[group]Run actions/checkout@v6",
  "2026-09-28T23:02:57.0000000Z ##[group]Run pnpm test:sync-critical:db --shard=1/6",
  "2026-09-28T23:02:57.0010000Z env:",
  `2026-09-28T23:02:57.0020000Z ${PC_PARALLELISM}`,
  "2026-09-28T23:02:57.0030000Z ##[endgroup]",
  "2026-09-28T23:02:57.1000000Z > vitest run ${SYNC_CRITICAL_DB_PARALLELISM:---no-file-parallelism} tests/*.integration.test.ts --shard=1/6",
  "2026-09-28T23:02:58.0000000Z  RUN  v4.1.10 /home/runner/work/hub/hub",
  `2026-09-28T23:03:10.0000000Z  ${esc}[32m✓${esc}[39m tests/first.integration.test.ts ${esc}[2m(${esc}[22m${esc}[2m3 tests${esc}[22m${esc}[2m)${esc}[22m${esc}[33m 2000${esc}[2mms${esc}[22m${esc}[39m`,
  "2026-09-28T23:03:11.0000000Z stderr | tests/second.integration.test.ts > noisy",
  `${SECOND_DONE}.integration.test.ts (4 tests) 3000ms`,
  "2026-09-28T23:03:14.1000000Z      ✓ a slow test inside it  2900ms",
  "2026-09-28T23:03:20.5000000Z  ❯ tests/third.integration.test.ts (2 tests | 1 failed) 6000ms",
  "2026-09-28T23:03:20.6000000Z  Test Files  1 failed | 2 passed (3)",
  `2026-09-28T23:03:20.7000000Z ${esc}[2m   Duration ${esc}[22m 22.70s${esc}[2m (transform 1.20s, setup 0ms, import 2.50s, tests 11.00s, environment 500ms)${esc}[22m`,
  "2026-09-28T23:03:21.0000000Z ##[group]Run pnpm test:sync-critical:api",
  "2026-09-28T23:03:30.0000000Z  ✓ tests/api.integration.test.ts (103 tests | 76 skipped) 5000ms",
  "2026-09-28T23:03:41.5000000Z Post job cleanup.",
].join("\r\n");

describe("shard weight regeneration", () => {
  it("measures each file's own time as seconds of shard wall time, and the API step", () => {
    // Own time: the reported duration plus the job's (setup + import +
    // environment) / files = 3 s / 3 = 1 s; the PC ran two files at once.
    expect(parseJobLog(jobLog)).toEqual({
      files: [
        { file: "tests/first.integration.test.ts", seconds: 1.5 },
        { file: "tests/second.integration.test.ts", seconds: 2 },
        { file: "tests/third.integration.test.ts", seconds: 3.5 },
      ],
      apiSeconds: 20.5,
    });
  });

  it("does not depend on when the files finished", () => {
    // The slow third file now finishes 0.1 s after the second: the time
    // between completions would have weighed it at 0.1 s.
    const late = jobLog.replace(SECOND_DONE, "2026-09-28T23:03:20.4000000Z  ✓ tests/second");
    expect(late).not.toBe(jobLog);
    expect(parseJobLog(late)).toEqual(parseJobLog(jobLog));
  });

  it("counts one file at a time when the DB step ran without file parallelism", () => {
    const hosted = jobLog.replace(PC_PARALLELISM, "  SYNC_CRITICAL_DB_PARALLELISM: ");
    expect(parseJobLog(hosted).files.map(entry => entry.seconds)).toEqual([3, 4, 7]);
  });

  it("refuses a log without sync-critical DB results", () => {
    expect(() => parseJobLog("2026-09-28T23:02:35.0000000Z ##[group]Run pnpm lint\n")).toThrow("No sync-critical DB file results");
  });

  it("refuses a DB step that does not say how many files ran at once or how long they imported", () => {
    const without = (text: string) => jobLog.split("\r\n").filter(line => !line.includes(text)).join("\r\n");
    expect(() => parseJobLog(without("SYNC_CRITICAL_DB_PARALLELISM:"))).toThrow("SYNC_CRITICAL_DB_PARALLELISM");
    expect(() => parseJobLog(without("Duration"))).toThrow("Duration");
    expect(() => parseJobLog(jobLog.replace(PC_PARALLELISM, "  SYNC_CRITICAL_DB_PARALLELISM: --fileParallelism"))).toThrow("how many files ran at once");
  });

  it("takes the median across runs, keeps unmeasured files that still exist and drops deleted ones", () => {
    const previous = weights({ "tests/kept.test.ts": 7, "tests/deleted.test.ts": 9, "tests/a.test.ts": 1 }, 30);
    const built = buildShardWeights(
      [
        { files: [{ file: "tests/a.test.ts", seconds: 2 }, { file: "tests/b.test.ts", seconds: 0.01 }], apiSeconds: 21.04 },
        { files: [{ file: "tests/a.test.ts", seconds: 4 }], apiSeconds: null },
        { files: [{ file: "tests/a.test.ts", seconds: 3.33 }], apiSeconds: 19 },
      ],
      previous,
      file => file !== "tests/deleted.test.ts",
    );
    expect(built).toEqual({
      version: 1,
      firstShardExtraSeconds: 20,
      files: { "tests/a.test.ts": 3.3, "tests/b.test.ts": 0.1, "tests/kept.test.ts": 7 },
    });
    expect(Object.keys(built.files)).toEqual(["tests/a.test.ts", "tests/b.test.ts", "tests/kept.test.ts"]);
    // No API step measured: the earlier extra stays.
    expect(buildShardWeights([{ files: [{ file: "tests/a.test.ts", seconds: 1 }], apiSeconds: null }], previous, () => true).firstShardExtraSeconds).toBe(30);
    expect(() => buildShardWeights([{ files: [{ file: "tests/a.test.ts", seconds: 1 }], apiSeconds: null }], undefined, () => true)).toThrow("API");
  });
});
