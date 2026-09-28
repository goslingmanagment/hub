import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_SHARD_TOTAL, MAX_PC_SHARD_TOTAL, planShards, shardOutputs } from "../scripts/ci-shards.mjs";

const script = new URL("../scripts/ci-shards.mjs", import.meta.url).pathname;

describe("CI integration shard plan", () => {
  it("keeps three shards by default and caps the PC at eight", () => {
    expect(DEFAULT_SHARD_TOTAL).toBe(3);
    expect(MAX_PC_SHARD_TOTAL).toBe(8);
  });

  it.each([
    // CI_POOL, run attempt, CI_PC_SHARDS, shard total
    ["pc", "1", "6", 6],
    ["pc", "1", "1", 1],
    ["pc", "1", "8", 8],
    ["pc", "1", " 4 ", 4],
    // Unset on the PC: the default.
    ["pc", "1", undefined, 3],
    ["pc", "1", "", 3],
    // Any re-run of everything goes hosted, and so does its shard count.
    ["pc", "2", "6", 3],
    ["pc", "3", "6", 3],
    // Hosted pools never read the PC count.
    ["", "1", "6", 3],
    ["hosted", "1", "6", 3],
    ["PC", "1", "6", 3],
    [undefined, undefined, "6", 3],
  ] as const)("CI_POOL=%s attempt %s CI_PC_SHARDS=%j plans %i shards", (pool, attempt, requested, total) => {
    const plan = planShards({ CI_POOL: pool, RUN_ATTEMPT: attempt, CI_PC_SHARDS: requested });
    expect(plan).toEqual({ total, shards: Array.from({ length: total }, (_, index) => index + 1), warning: "" });
  });

  it.each(["0", "9", "10", "-2", "3.5", "1e1", "06", "0x4", "six", "[1,2]", "4 shards"])(
    "falls back to three shards and warns on CI_PC_SHARDS=%j",
    requested => {
      const plan = planShards({ CI_POOL: "pc", RUN_ATTEMPT: "1", CI_PC_SHARDS: requested });
      expect(plan.total).toBe(3);
      expect(plan.shards).toEqual([1, 2, 3]);
      expect(plan.warning).toBe(`CI_PC_SHARDS=${JSON.stringify(requested)} is not a whole number from 1 to 8; using 3 shards.`);
    },
  );

  it("ignores an invalid PC count off the PC without a warning", () => {
    expect(planShards({ CI_POOL: "", RUN_ATTEMPT: "1", CI_PC_SHARDS: "nine" }).warning).toBe("");
    expect(planShards({ CI_POOL: "pc", RUN_ATTEMPT: "2", CI_PC_SHARDS: "nine" }).warning).toBe("");
  });

  it("writes a JSON shard list and its total as step outputs", () => {
    expect(shardOutputs(planShards({ CI_POOL: "pc", RUN_ATTEMPT: "1", CI_PC_SHARDS: "6" })))
      .toBe("shards=[1,2,3,4,5,6]\nshard_total=6\n");
    expect(shardOutputs(planShards({}))).toBe("shards=[1,2,3]\nshard_total=3\n");
  });

  it.each([
    [{ CI_POOL: "pc", RUN_ATTEMPT: "1", CI_PC_SHARDS: "5" }, "shards=[1,2,3,4,5]\nshard_total=5\n", ""],
    [{ CI_POOL: "pc", RUN_ATTEMPT: "1", CI_PC_SHARDS: "12" }, "shards=[1,2,3]\nshard_total=3\n",
      "::warning title=Invalid CI_PC_SHARDS::CI_PC_SHARDS=\"12\" is not a whole number from 1 to 8; using 3 shards.\n"],
    [{ CI_POOL: "", RUN_ATTEMPT: "1", CI_PC_SHARDS: "" }, "shards=[1,2,3]\nshard_total=3\n", ""],
  ])("appends the plan to GITHUB_OUTPUT from the command line (%j)", (env, outputs, warning) => {
    const directory = mkdtempSync(path.join(tmpdir(), "ci-shards-"));
    try {
      const output = path.join(directory, "output");
      writeFileSync(output, "earlier=kept\n");
      const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...env },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(`earlier=kept\n${outputs}`);
      const total = /shard_total=(\d)/.exec(outputs)?.[1];
      expect(result.stdout).toBe(`${warning}Integration shards: ${total}\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails without GITHUB_OUTPUT instead of leaving the matrix empty", () => {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: { PATH: process.env.PATH, CI_POOL: "pc", RUN_ATTEMPT: "1" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("GITHUB_OUTPUT is not set\n");
  });
});
