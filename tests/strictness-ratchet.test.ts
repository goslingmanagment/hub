import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

// `pnpm typecheck` runs scripts/check-strictness-ratchet.mjs, which budgets tsc
// errors per file. A fake `pnpm` on PATH hands it synthetic compiler output in
// place of tsc: the snapshot's own debt, exactly at budget, with and without an
// error that has no file location.

const snapshot = JSON.parse(readFileSync("scripts/strictness-ratchet.json", "utf8")) as Record<string, number>;
const atBudget = Object.entries(snapshot).flatMap(([file, count]) =>
  Array.from({ length: count }, (_, i) => `${file}(${i + 1},1): error TS2322: Type 'string' is not assignable to type 'number'.`),
);

// As tsc 6 prints them with --pretty false; after one it reports no per-file errors.
const GLOBAL_ERRORS: Record<string, string[]> = {
  "missing type library": [
    "error TS2688: Cannot find type definition file for 'node'.",
    "  The file is in the program because:",
    "    Entry point of type library 'node' specified in compilerOptions",
  ],
  "missing global type": ["error TS2318: Cannot find global type 'Array'."],
};

function ratchet(tscOutput: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-strictness-ratchet-"));
  try {
    writeFileSync(path.join(dir, "tsc.out"), tscOutput.map((line) => `${line}\n`).join(""));
    writeFileSync(path.join(dir, "pnpm"), `#!/bin/sh\ncat "$(dirname "$0")/tsc.out"\nexit ${tscOutput.length > 0 ? 2 : 0}\n`);
    chmodSync(path.join(dir, "pnpm"), 0o755);
    return spawnSync(process.execPath, ["scripts/check-strictness-ratchet.mjs"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8",
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("strictness ratchet (Stage 35)", () => {
  it("passes the snapshot's own debt, exactly at budget", () => {
    const result = ratchet(atBudget);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`strictness-ratchet: OK — ${atBudget.length} known error(s) within budget`);
  });

  it.each(Object.entries(GLOBAL_ERRORS))("fails a %s: an error without a file location", (_, lines) => {
    for (const tscOutput of [lines, [...atBudget, ...lines]]) {
      const result = ratchet(tscOutput);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("strictness-ratchet: tsc reported error(s) without a file location");
      expect(result.stderr).toContain(lines[0]);
      expect(result.stderr).not.toContain("debt shrank");
    }
  });
});
