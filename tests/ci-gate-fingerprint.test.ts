import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/ci-gate-fingerprint.sh decides whether CI may SKIP its test jobs:
 * ci.yml reuses an earlier passing Quality Gate whenever the fingerprint of the
 * current tree matches. That makes the script's exclusion list a safety
 * boundary — a path that a check reads but the fingerprint ignores would let a
 * breaking change ride a stale proof. These pins hold the two sides together:
 * the fingerprint ignores exactly the prose it claims to, reacts to everything
 * else, and no test reads an ignored path.
 */

const SCRIPT = path.resolve("scripts/ci-gate-fingerprint.sh");
const REPO_ROOT = process.cwd();

// A hermetic git: no user config (signing, hooks, templates), fixed identity.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "ci",
  GIT_AUTHOR_EMAIL: "ci@example.invalid",
  GIT_COMMITTER_NAME: "ci",
  GIT_COMMITTER_EMAIL: "ci@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const BASE_TREE: Record<string, string> = {
  ".github/workflows/ci.yml": "name: CI\n",
  ".claude/settings.json": "{}\n",
  "AGENTS.md": "# agents\n",
  "CLAUDE.md": "# claude\n",
  "Dockerfile": "FROM scratch\n",
  "README.md": "# readme\n",
  "apps/runtime/src/index.ts": "export const version = 1;\n",
  "docs/agent-read-skill.md": "# skill\n",
  "docs/decisions.md": "# decisions\n",
  "docs/generated/authorization-policy.md": "# generated\n",
  "docs/plans/plan.md": "# plan\n",
  "docs/runbooks/agent-read-plane-enablement.md": "# runbook\n",
  "investigations/topic/README.md": "# investigation\n",
  "package.json": '{"name":"fixture"}\n',
  "packages/db/migrations/0001_init.sql": "select 1;\n",
  "reference/agency-hub.openapi.json": "{}\n",
  "scripts/tool.sh": "#!/bin/sh\n",
};

/** Paths the gate never reads: editing or adding them must not change the fingerprint. */
const PROSE_PATHS = [
  "docs/decisions.md",
  "docs/plans/plan.md",
  "docs/plans/new-plan.md",
  "docs/audits/audit.md",
  "docs/reports/report.md",
  "docs/migration-history/stage.md",
  "investigations/topic/README.md",
  "investigations/new-topic/evidence.md",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "SESSIONS.md",
  "backlog.md",
  ".claude/instructions.md",
  ".agentic/notes.md",
];

/** Paths some check does read: any change must change the fingerprint. */
const OBSERVED_PATHS = [
  ".github/workflows/ci.yml",
  // The body-edit mirror decides whether a PR description edit may report the
  // required "Quality Gate"; it must never ride an earlier tree's proof.
  "scripts/ci-mirror-gate.mjs",
  "Dockerfile",
  "apps/runtime/src/index.ts",
  "docs/agent-read-skill.md",
  "docs/error-handling.md",
  "docs/generated/authorization-policy.md",
  "docs/runbooks/agent-read-plane-enablement.md",
  "package.json",
  "packages/db/migrations/0002_next.sql",
  "reference/agency-hub.openapi.json",
  "scripts/tool.sh",
  "investigations/new-topic/evidence.txt",
  "investigations/new-topic/repro.mjs",
  "investigations/new-topic/check.ts",
  ".claude/settings.json",
  ".agentic/state.json",
  "docs/plans/check.mjs",
];

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
}

function fingerprint(repo: string, revision = "HEAD", scope = "gate"): string {
  return execFileSync("bash", [SCRIPT, revision, scope], { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
}

function commit(repo: string, files: Record<string, string>, message: string): string {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(repo, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "--allow-empty", "--message", message);
  return git(repo, "rev-parse", "HEAD");
}

describe("CI gate fingerprint", () => {
  let repo: string;
  let base: string;
  let baseFingerprint: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "ci-gate-fingerprint-"));
    git(repo, "init", "--quiet", "--initial-branch=main");
    base = commit(repo, BASE_TREE, "base");
    baseFingerprint = fingerprint(repo);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** Start a throwaway commit from the base tree and return its fingerprint. */
  function variant(files: Record<string, string>, message: string): string {
    git(repo, "checkout", "--quiet", "--detach", base);
    commit(repo, files, message);
    return fingerprint(repo);
  }

  it("is a 64-hex sha256 of the tree, independent of commit metadata", () => {
    expect(baseFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Same tree, different commit (message, date, parent chain).
    expect(variant({}, "empty commit on the same tree")).toBe(baseFingerprint);
    expect(fingerprint(repo, base)).toBe(baseFingerprint);
  });

  it.each(PROSE_PATHS)("ignores %s", relative => {
    expect(variant({ [relative]: `changed ${relative}\n` }, `prose ${relative}`)).toBe(baseFingerprint);
  });

  it.each(OBSERVED_PATHS)("changes when %s changes", relative => {
    expect(variant({ [relative]: `changed ${relative}\n` }, `code ${relative}`)).not.toBe(baseFingerprint);
  });

  it("changes when a file's mode changes, not only its bytes", () => {
    git(repo, "checkout", "--quiet", "--detach", base);
    chmodSync(path.join(repo, "scripts/tool.sh"), 0o755);
    git(repo, "add", "--all");
    git(repo, "commit", "--quiet", "--message", "mode");
    expect(fingerprint(repo)).not.toBe(baseFingerprint);
  });

  it("fails loudly on an unknown revision instead of printing a hash", () => {
    expect(() => fingerprint(repo, "no-such-revision")).toThrow();
  });

  it("does not hide an evidence file that ESLint rejects", () => {
    const source = "const unusedEvidence = 1;\n";
    const result = spawnSync(process.execPath, [
      path.resolve("node_modules/eslint/bin/eslint.js"),
      "--stdin", "--stdin-filename", "investigations/ci-regression.mjs",
    ], { cwd: REPO_ROOT, encoding: "utf8", input: source });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("@typescript-eslint/no-unused-vars");
    expect(variant({ "investigations/ci-regression.mjs": source }, "lint regression")).not.toBe(baseFingerprint);
  });

  it("observes symlinks even when their names look like prose", () => {
    git(repo, "checkout", "--quiet", "--detach", base);
    symlinkSync("../../package.json", path.join(repo, "docs/plans/link.md"));
    git(repo, "add", "--all");
    git(repo, "commit", "--quiet", "--message", "symlink");
    expect(fingerprint(repo)).not.toBe(baseFingerprint);
  });

  it.each(["apps/dashboard/src/Example.tsx", "apps/dashboard/src/style.css", "apps/dashboard/public/logo.svg"])(
    "reuses only integration proof for dashboard source %s", relative => {
      git(repo, "checkout", "--quiet", "--detach", base);
      const before = fingerprint(repo, base, "integration");
      expect(variant({ [relative]: "changed" }, "dashboard")).not.toBe(baseFingerprint);
      expect(fingerprint(repo, "HEAD", "integration")).toBe(before);
    },
  );

  it.each([...OBSERVED_PATHS, "apps/dashboard/package.json", "apps/dashboard/vite.config.ts",
    "pnpm-lock.yaml", "tests/dashboard-example.test.ts", "tests/helpers/context.ts",
    "apps/runtime/src/server.ts", "packages/shared/src/index.ts", "unknown/new-file"])(
    "invalidates the integration proof for %s", relative => {
      const before = fingerprint(repo, base, "integration");
      variant({ [relative]: "changed" }, "integration input");
      expect(fingerprint(repo, "HEAD", "integration")).not.toBe(before);
    },
  );

  it("fails on an unknown scope", () => {
    expect(() => fingerprint(repo, base, "typo")).toThrow();
  });

  // The exclusion list is only safe while nothing under tests/ reads those
  // paths. This scans for the direct read forms; a test that needs one of
  // these files should read a path the fingerprint observes instead (or the
  // path must be removed from the script's exclusions).
  it("no test reads a path the fingerprint ignores", () => {
    const ignored = String.raw`(investigations/|docs/(plans|audits|reports|migration-history)/|docs/decisions\.md|\.claude/|\.agentic/|(AGENTS|CLAUDE|README|SESSIONS|backlog)\.md)`;
    const reads = new RegExp(
      String.raw`(readFileSync|readFile|existsSync|statSync|readdirSync|createReadStream|new URL)\(\s*["'\x60](\.\./)*${ignored}`,
      "g",
    );
    const testsDir = path.join(REPO_ROOT, "tests");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && reads.test(readFileSync(full, "utf8"))) offenders.push(path.relative(REPO_ROOT, full));
        reads.lastIndex = 0;
      }
    };
    walk(testsDir);
    expect(offenders).toEqual([]);
  });
});
