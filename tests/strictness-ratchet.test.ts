import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * The script in a scratch root of its own: `files` exist, the snapshot holds
 * `snapshot`, and tsc reports `errors` (file → count). With `tests` false the
 * root has no tests/ directory, as the production Docker build context.
 */
function ratchetIn(input: { files: string[]; snapshot: Record<string, number>; errors: Record<string, number>; tests: boolean }) {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-strictness-root-"));
  try {
    mkdirSync(path.join(dir, "scripts"));
    copyFileSync("scripts/check-strictness-ratchet.mjs", path.join(dir, "scripts/check-strictness-ratchet.mjs"));
    writeFileSync(path.join(dir, "scripts/strictness-ratchet.json"), JSON.stringify(input.snapshot));
    if (input.tests) mkdirSync(path.join(dir, "tests"));
    for (const file of input.files) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), "");
    }
    const tscOutput = Object.entries(input.errors).flatMap(([file, count]) =>
      Array.from({ length: count }, (_, i) => `${file}(${i + 1},1): error TS2322: Type 'string' is not assignable to type 'number'.\n`),
    ).join("");
    writeFileSync(path.join(dir, "tsc.out"), tscOutput);
    writeFileSync(path.join(dir, "pnpm"), `#!/bin/sh\ncat "$(dirname "$0")/tsc.out"\nexit ${tscOutput ? 2 : 0}\n`);
    chmodSync(path.join(dir, "pnpm"), 0o755);
    return spawnSync(process.execPath, [path.join(dir, "scripts/check-strictness-ratchet.mjs")], {
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

  // A snapshot file deleted or renamed without --update once made the script
  // take the full checkout for the Docker context and drop the shrink demand.
  it("fails a full checkout whose snapshot names a file that no longer exists", () => {
    const result = ratchetIn({
      files: ["apps/a.ts", "tests/a.test.ts"],
      snapshot: { "apps/a.ts": 1, "tests/gone.test.ts": 2 },
      errors: { "apps/a.ts": 1 },
      tests: true,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("strictness-ratchet: snapshot files no longer exist");
    expect(result.stderr).toContain("  tests/gone.test.ts");
  });

  it("still demands the shrink in a full checkout", () => {
    const result = ratchetIn({ files: ["apps/a.ts", "tests/a.test.ts"], snapshot: { "apps/a.ts": 2, "tests/a.test.ts": 1 }, errors: { "apps/a.ts": 2 }, tests: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("strictness-ratchet: debt shrank (3 → 2)");
  });

  it("skips only the test files and the shrink demand in the Docker build context", () => {
    const docker = { files: ["apps/a.ts"], snapshot: { "apps/a.ts": 1, "tests/a.test.ts": 2 }, errors: { "apps/a.ts": 1 }, tests: false };
    const passed = ratchetIn(docker);
    expect(passed.status, passed.stderr).toBe(0);
    expect(passed.stdout).toContain("strictness-ratchet: Docker build context (no tests/)");

    const gone = ratchetIn({ ...docker, snapshot: { ...docker.snapshot, "apps/gone.ts": 1 } });
    expect(gone.status).toBe(1);
    expect(gone.stderr).toContain("  apps/gone.ts");

    const over = ratchetIn({ ...docker, errors: { "apps/a.ts": 2 } });
    expect(over.status).toBe(1);
    expect(over.stderr).toContain("apps/a.ts: 2 error(s), budget 1");
  });
});
