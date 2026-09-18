import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  "docs/generated/00-overview.md": "# generated\n",
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
  "investigations/new-topic/evidence.txt",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "SESSIONS.md",
  "backlog.md",
  ".claude/settings.json",
  ".agentic/state.json",
];

/** Paths some check does read: any change must change the fingerprint. */
const OBSERVED_PATHS = [
  ".github/workflows/ci.yml",
  "Dockerfile",
  "apps/runtime/src/index.ts",
  "docs/agent-read-skill.md",
  "docs/error-handling.md",
  "docs/generated/00-overview.md",
  "docs/runbooks/agent-read-plane-enablement.md",
  "package.json",
  "packages/db/migrations/0002_next.sql",
  "reference/agency-hub.openapi.json",
  "scripts/tool.sh",
];

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
}

function fingerprint(repo: string, revision = "HEAD"): string {
  return execFileSync("bash", [SCRIPT, revision], { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
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
