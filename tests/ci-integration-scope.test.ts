import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decide, importsDatabase, integrationScope } from "../scripts/ci-integration-scope.mjs";

/**
 * scripts/ci-integration-scope.mjs decides whether a PR may skip the
 * integration shards. A wrong "not needed" only defers a failure to main's
 * full run (which gates the deploy), but every doubt must still run them.
 */

const SCRIPT = path.resolve("scripts/ci-integration-scope.mjs");
const noSource = () => "";

describe("CI integration scope: which changes need the shards", () => {
  it.each([
    // DB, schema and migrations.
    ["packages/db/src/schema.ts", "DB package"],
    ["packages/db/migrations/0300_x.sql", "DB package"],
    ["packages/db/src/repositories/pages.ts", "DB package"],
    // Sync, the platform wire and the page browser.
    ["apps/runtime/src/sync/engine/actor.ts", "sync engine"],
    ["apps/runtime/src/sync/budgets-calibration.sql", "sync engine"],
    ["packages/fansly/src/wire/x.ts", "Fansly wire"],
    ["apps/page-browser/src/operator/operator.ts", "page browser operator"],
    ["apps/runtime/src/bootstrap.ts", "runtime entry point"],
    ["apps/runtime/src/worker-services.ts", "runtime entry point"],
    // Network.
    ["apps/runtime/src/services/egress/page-browser-link.ts", "egress"],
    ["packages/shared/src/http-client.ts", "network client"],
    ["packages/shared/src/proxy.ts", "network client"],
    // The suite and its harness.
    ["tests/sync-engine-core.integration.test.ts", "integration test"],
    ["tests/nested/x.integration.test.ts", "integration test"],
    ["tests/schema-guard.test.ts", "integration test"],
    ["tests/network.test.ts", "integration test"],
    ["tests/http-client.test.ts", "integration test"],
    ["tests/helpers/global-setup.ts", "integration harness"],
    ["tests/fixtures/fansly/x.json", "integration harness"],
    ["tests/ci/shard-weights.json", "integration harness"],
    ["vitest.config.ts", "integration harness"],
    ["docker-compose.test.yml", "integration harness"],
    // Toolchain.
    ["package.json", "dependencies"],
    ["apps/runtime/package.json", "dependencies"],
    ["pnpm-lock.yaml", "dependencies"],
    ["patches/x.patch", "dependencies"],
    [".github/workflows/ci.yml", "CI"],
    ["scripts/ci-integration-scope.mjs", "CI"],
  ])("%s needs integration (%s)", (file, reason) => {
    expect(integrationScope([file], noSource)).toEqual({ needed: true, reasons: [`${file} (${reason})`], files: 1 });
  });

  it.each([
    "apps/dashboard/src/pages/home.tsx",
    "apps/dashboard/public/logo.svg",
    "apps/page-browser/stand/load.sh",
    "apps/page-browser/host/page.sh",
    "apps/page-browser/Dockerfile",
    "apps/runtime/src/sync/README.md",
    "docs/runbooks/sync.md",
    "AGENTS.md",
    "tests/page-browser-operator.test.ts",
    "tests/deploy-ci-policy.test.ts",
    "scripts/deploy-production.sh",
    "scripts/main-ci-gate.sh",
    "reference/agency-hub.openapi.json",
    ".github/workflows/nightly.yml",
    "Dockerfile",
  ])("%s alone does not", file => {
    expect(integrationScope([file], noSource)).toEqual({ needed: false, reasons: [], files: 1 });
  });

  it.each([
    'import { db } from "@agency_hub_core/db";',
    "import type { Database } from '@agency_hub_core/db';",
    'import { pages } from "@agency_hub_core/db/schema";',
    'export { x } from "@agency_hub_core/db";',
    'const { sql } = await import("drizzle-orm");',
    'import { eq } from "drizzle-orm/pg-core";',
    'import pg from "pg";',
    'import PgBoss from "pg-boss";',
    'import { x } from "../../packages/db/src/client.ts";',
    'const db = require("@agency_hub_core/db");',
  ])("source that imports the database is DB code: %s", source => {
    expect(importsDatabase(source)).toBe(true);
    const file = "apps/runtime/src/services/thing.ts";
    expect(integrationScope([file], () => source)).toEqual({ needed: true, reasons: [`${file} (DB code)`], files: 1 });
  });

  it.each([
    'import { x } from "@agency_hub_core/shared";',
    'import { x } from "@agency_hub_core/dbx";',
    'import { x } from "pgx";',
    '// the reads live in "@agency_hub_core/db" now\nexport const x = 1;',
    'const label = "pg";',
  ])("other source is not: %s", source => {
    expect(importsDatabase(source)).toBe(false);
    expect(integrationScope(["apps/runtime/src/modules/ai/prompts/x.ts"], () => source).needed).toBe(false);
  });

  it("reads source only where it can matter, and an unreadable source needs the shards", () => {
    const read: string[] = [];
    const reader = (file: string) => { read.push(file); return null; };
    const scope = integrationScope([
      "apps/dashboard/src/a.ts", "tests/unit.test.ts", "docs/x.md", "Dockerfile", "apps/runtime/src/modules/ai/x.ts",
    ], reader);
    expect(read).toEqual(["apps/runtime/src/modules/ai/x.ts"]);
    expect(scope).toEqual({ needed: true, reasons: ["apps/runtime/src/modules/ai/x.ts (unreadable)"], files: 5 });
  });

  it("a change of no file at all runs the shards", () => {
    expect(integrationScope([], noSource).needed).toBe(true);
  });
});

describe("CI integration scope: the step's decision", () => {
  const notNeeded = () => ({ needed: false, reasons: [], files: 3 });
  const needed = () => ({ needed: true, reasons: ["packages/db/src/schema.ts (DB package)"], files: 1 });

  it.each([
    [{ SCOPE_EVENT: "push" }, notNeeded, true],
    [{ SCOPE_EVENT: "workflow_dispatch" }, notNeeded, true],
    [{}, notNeeded, true],
    [{ SCOPE_EVENT: "pull_request", SCOPE_FORCE: "true" }, notNeeded, true],
    [{ SCOPE_EVENT: "pull_request", SCOPE_FORCE: "false" }, notNeeded, false],
    [{ SCOPE_EVENT: "pull_request" }, notNeeded, false],
    [{ SCOPE_EVENT: "pull_request" }, needed, true],
    [{ SCOPE_EVENT: "pull_request" }, () => { throw new Error("fatal: bad revision 'HEAD^1'\nmore"); }, true],
  ] as const)("env %j decides needed=%s", (env, scope, expected) => {
    expect(decide(env, scope).needed).toBe(expected);
  });

  it("explains every verdict", () => {
    expect(decide({ SCOPE_EVENT: "pull_request" }, notNeeded).summary).toBe(
      "no DB/sync/network change among 3 changed file(s): integration is left to main.");
    expect(decide({ SCOPE_EVENT: "pull_request" }, needed).summary).toBe(
      "the PR touches DB/sync/network code:\n- packages/db/src/schema.ts (DB package)");
    expect(decide({ SCOPE_EVENT: "pull_request" }, () => { throw new Error("fatal: bad revision 'HEAD^1'\nmore"); }).summary).toBe(
      "the PR's change could not be read (fatal: bad revision 'HEAD^1'): the full suite runs.");
    const many = { needed: true, reasons: Array.from({ length: 12 }, (_, index) => `f${index}`), files: 12 };
    expect(decide({ SCOPE_EVENT: "pull_request" }, () => many).summary.split("\n").at(-1)).toBe("- … and 2 more");
  });
});

// End to end against git: GitHub tests a PR's merge commit, checked out two
// commits deep. The scope is that commit against its first parent, the base
// branch's tip — the PR's own change, not what main gained meanwhile.
describe("CI integration scope: the script on a PR's merge commit", () => {
  let root = "";
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "ci", GIT_AUTHOR_EMAIL: "ci@example.invalid",
    GIT_COMMITTER_NAME: "ci", GIT_COMMITTER_EMAIL: "ci@example.invalid",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
  const write = (cwd: string, file: string, text: string) => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), text);
  };

  /** A repo whose main moved on (a DB change) while the PR changed `prFiles`; returns a depth-2 clone of the merge. */
  function mergedPr(name: string, prFiles: Record<string, string | null>): string {
    const origin = path.join(root, name);
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    write(origin, "apps/dashboard/src/a.ts", "export const a = 1;\n");
    write(origin, "apps/runtime/src/services/reads.ts", 'import { db } from "@agency_hub_core/db";\nexport const r = db;\n');
    write(origin, "packages/db/src/schema.ts", "export const s = 1;\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "base");
    git(origin, "checkout", "-qb", "pr");
    for (const [file, text] of Object.entries(prFiles)) {
      if (text === null) git(origin, "rm", "-q", file);
      else write(origin, file, text);
    }
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "pr");
    git(origin, "checkout", "-q", "main");
    write(origin, "packages/db/src/schema.ts", "export const s = 2;\n");
    git(origin, "commit", "-qam", "main moves on");
    git(origin, "merge", "-q", "--no-ff", "--no-edit", "pr");
    const clone = path.join(root, `${name}-clone`);
    git(root, "clone", "-q", "--depth", "2", `file://${origin}`, clone);
    return clone;
  }

  function run(cwd: string, env: Record<string, string>) {
    const output = path.join(cwd, "..", `${path.basename(cwd)}.output`);
    const summary = path.join(cwd, "..", `${path.basename(cwd)}.summary`);
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd, encoding: "utf8", env: { ...gitEnv, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env },
    });
    expect(result.status, result.stderr).toBe(0);
    return { output: readFileSync(output, "utf8"), summary: readFileSync(summary, "utf8") };
  }

  beforeAll(() => { root = mkdtempSync(path.join(tmpdir(), "hub-ci-scope-")); });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it("skips the shards for a dashboard-only PR although main changed the DB meanwhile", () => {
    const clone = mergedPr("dashboard", { "apps/dashboard/src/a.ts": "export const a = 2;\n" });
    const { output, summary } = run(clone, { SCOPE_EVENT: "pull_request", SCOPE_FORCE: "false" });
    expect(output).toBe("integration_needed=false\n");
    expect(summary).toBe("Integration skipped: no DB/sync/network change among 1 changed file(s): integration is left to main.\n");
    // The same commit pushed to main, or labelled ci:full, runs them.
    expect(run(clone, { SCOPE_EVENT: "push" }).output).toBe("integration_needed=true\n");
    expect(run(clone, { SCOPE_EVENT: "pull_request", SCOPE_FORCE: "true" }).output).toBe("integration_needed=true\n");
  });

  it("runs the shards for a PR that changes or deletes DB code", () => {
    const changed = mergedPr("changed", { "apps/runtime/src/services/reads.ts": 'import { db } from "@agency_hub_core/db";\nexport const r = [db];\n' });
    expect(run(changed, { SCOPE_EVENT: "pull_request" }).output).toBe("integration_needed=true\n");
    const deleted = mergedPr("deleted", { "apps/runtime/src/services/reads.ts": null });
    const { output, summary } = run(deleted, { SCOPE_EVENT: "pull_request" });
    expect(output).toBe("integration_needed=true\n");
    expect(summary).toContain("- apps/runtime/src/services/reads.ts (DB code)");
  });

  it("runs the shards when the merge commit has no parent to compare with", () => {
    const clone = mergedPr("shallow", { "apps/dashboard/src/a.ts": "export const a = 3;\n" });
    const single = path.join(root, "shallow-single");
    git(root, "clone", "-q", "--depth", "1", `file://${clone}`, single);
    const { output, summary } = run(single, { SCOPE_EVENT: "pull_request" });
    expect(output).toBe("integration_needed=true\n");
    expect(summary).toMatch(/^Integration needed: the PR's change could not be read \(/);
  });
});
