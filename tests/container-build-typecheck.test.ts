import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("Docker build typecheck boundary", () => {
  it.each([
    [undefined, "build:production", 0], ["false", "build:production", 0],
    ["true", "build:artifacts", 0], ["invalid", "", 1],
  ] as const)("CI_TYPECHECK_ALREADY_PASSED=%s selects %s", (passed, expected, exit) => {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-build-contract-"));
    try {
      const pnpm = path.join(dir, "pnpm");
      writeFileSync(pnpm, '#!/bin/sh\nprintf "%s" "$1"\n');
      chmodSync(pnpm, 0o755);
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
      delete env.CI_TYPECHECK_ALREADY_PASSED;
      if (passed !== undefined) env.CI_TYPECHECK_ALREADY_PASSED = passed;
      const result = spawnSync("bash", ["scripts/build-container.sh"], { env, encoding: "utf8" });
      expect(result.status).toBe(exit);
      expect(result.stdout).toBe(expected);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("propagates a failed default production build", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-build-failure-"));
    try {
      writeFileSync(path.join(dir, "pnpm"), "#!/bin/sh\nexit 42\n");
      chmodSync(path.join(dir, "pnpm"), 0o755);
      const result = spawnSync("bash", ["scripts/build-container.sh"], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CI_TYPECHECK_ALREADY_PASSED: "false" },
      });
      expect(result.status).toBe(42);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps direct Docker builds checked by default", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(dockerfile).toContain("ARG CI_TYPECHECK_ALREADY_PASSED=false");
    expect(dockerfile).toContain("bash scripts/build-container.sh");
    const deploy = readFileSync("scripts/deploy-production.sh", "utf8");
    expect(deploy).not.toContain("CI_TYPECHECK_ALREADY_PASSED");
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["build:production"]).toBe("pnpm typecheck && pnpm build:artifacts");
  });
});
