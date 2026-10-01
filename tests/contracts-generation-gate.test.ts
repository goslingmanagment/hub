import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

type Step = { name: string; run?: string };
type Workflow = { jobs: Record<string, { steps: Step[] }> };

// The installed YAML parser, through its declaring dependency (as in
// tests/deploy-ci-policy.test.ts).
const swaggerRequire = createRequire(createRequire(import.meta.url).resolve("@fastify/swagger"));
const yaml = swaggerRequire("yaml") as { parse: (text: string) => Workflow };
const workflow = yaml.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const contractsStep = workflow.jobs.static?.steps.find(step => step.name === "Contracts are regenerated (routes.ts ↔ committed artifacts)");

const GENERATED = [
  "reference/agency-hub.openapi.json",
  "packages/contracts/src/contract-hash.ts",
  "packages/sdk/src/index.ts",
  "docs/generated/authorization-policy.md",
];

/**
 * Runs the CI step in a scratch repository holding committed generated files.
 * A fake `pnpm` stands in for the generator and runs `generate` in the repo.
 */
function runContractsStep(generate: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-contracts-gate-"));
  try {
    const repo = path.join(dir, "repo");
    for (const file of [...GENERATED, "README.md"]) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), `${file}\n`);
    }
    writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: dir,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-qm", "generated"]]) {
      const git = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
      expect(git.status, git.stderr).toBe(0);
    }
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh\n[ "$1" = contracts:generate ] || exit 97\n${generate}\n`);
    chmodSync(path.join(bin, "pnpm"), 0o755);
    // GitHub's default shell for `run`: bash -e.
    return spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", contractsStep?.run ?? "exit 99"], {
      cwd: repo,
      env: { ...env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("generated contract artifact gate", () => {
  it("regenerates every generated artifact in the static job", () => {
    expect(contractsStep?.run).toMatch(/^pnpm contracts:generate\n/);
    for (const file of ["reference/agency-hub.openapi.json", "packages/contracts/src/contract-hash.ts", "packages/sdk", "docs/generated/authorization-policy.md"]) {
      expect(contractsStep?.run).toContain(file);
    }
  });

  it("passes when the generator reproduces the committed files", () => {
    const result = runContractsStep("true");
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("fails CI when the runtime health contract hash is stale", () => {
    const result = runContractsStep("echo stale >> packages/contracts/src/contract-hash.ts");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(" M packages/contracts/src/contract-hash.ts");
    expect(result.stdout).toContain("+stale");
    expect(result.stdout).toContain("::error::Generated contracts are stale");
  });

  // `git diff --exit-code` passed this: a new file is untracked.
  it("fails CI when the generator adds a file that was never committed", () => {
    const result = runContractsStep("echo new > packages/sdk/src/new-module.ts");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("?? packages/sdk/src/new-module.ts");
  });

  it("ignores changes outside the generated paths and ignored files inside them", () => {
    const result = runContractsStep("echo x >> README.md && echo x > notes.txt && mkdir -p packages/sdk/node_modules && echo x > packages/sdk/node_modules/x.js");
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
