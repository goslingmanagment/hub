import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The deploy gate (owner, 2026-10-18): PR CI runs the integration shards only
// for DB/sync/network changes, so production takes only a clean commit of
// origin/main whose newest "Quality Gate" check run passed. Everything a
// deploy cannot prove — a red, running or missing gate, a commit off main, a
// dirty checkout, an unreadable answer — refuses.

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const gatePath = path.join(repoRoot, "scripts/main-ci-gate.sh");

const gitEnv = {
  GIT_AUTHOR_NAME: "ci", GIT_AUTHOR_EMAIL: "ci@example.invalid",
  GIT_COMMITTER_NAME: "ci", GIT_COMMITTER_EMAIL: "ci@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};

type CheckRun = { id: number; name?: string; status: string; conclusion: string | null; app?: { slug: string }; html_url?: string };
function gate(id: number, status: string, conclusion: string | null): CheckRun {
  return { id, name: "Quality Gate", status, conclusion, app: { slug: "github-actions" }, html_url: `https://github.com/o/r/actions/runs/${id}/job/${id}` };
}

describe("main CI deploy gate", () => {
  let root = "";
  let checkout = "";
  let bin = "";
  let onMain = "";
  let offMain = "";
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...gitEnv }, encoding: "utf8" }).trim();

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "hub-main-ci-gate-"));
    const origin = path.join(root, "origin.git");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    checkout = path.join(root, "checkout");
    git(root, "clone", "-q", origin, checkout);
    writeFileSync(path.join(checkout, "a.txt"), "1\n");
    git(checkout, "add", "a.txt");
    git(checkout, "commit", "-qm", "on main");
    git(checkout, "push", "-q", "origin", "HEAD:main");
    onMain = git(checkout, "rev-parse", "HEAD");
    writeFileSync(path.join(checkout, "a.txt"), "2\n");
    git(checkout, "commit", "-qam", "not pushed");
    offMain = git(checkout, "rev-parse", "HEAD");
    git(checkout, "checkout", "-q", onMain);
    // A fake GitHub CLI: it answers with $TEST_GH_ANSWER (or fails with
    // $TEST_GH_STATUS) and records each call and its directory.
    bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "gh"), [
      "#!/usr/bin/env bash",
      'printf \'%s|%s\\n\' "$PWD" "$*" >> "$TEST_GH_LOG"',
      '[ "${TEST_GH_STATUS:-0}" = 0 ] || exit "$TEST_GH_STATUS"',
      'printf \'%s\' "$TEST_GH_ANSWER"',
      "",
    ].join("\n"));
    chmodSync(path.join(bin, "gh"), 0o755);
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  function runGate(env: Record<string, string>, revision = onMain) {
    git(checkout, "checkout", "-q", revision);
    const log = path.join(root, "gh.log");
    writeFileSync(log, "");
    const { DEPLOY_SKIP_CI_GATE: _inherited, ...inherited } = process.env;
    const result = spawnSync("bash", [gatePath, checkout], {
      encoding: "utf8",
      env: { ...inherited, ...gitEnv, PATH: `${bin}:${process.env.PATH ?? ""}`, TEST_GH_LOG: log, TEST_GH_ANSWER: "", ...env },
    });
    return { ...result, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
  }
  const answer = (...runs: CheckRun[]) => JSON.stringify({ total_count: runs.length, check_runs: runs });

  it("passes a commit of main whose newest Quality Gate passed, asking GitHub from the checkout", () => {
    const result = runGate({ TEST_GH_ANSWER: answer(gate(5, "completed", "failure"), gate(9, "completed", "success")) });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(`Main CI passed for ${onMain.slice(0, 12)}: https://github.com/o/r/actions/runs/9/job/9`);
    expect(result.calls).toEqual([`${checkout}|api repos/{owner}/{repo}/commits/${onMain}/check-runs?check_name=Quality%20Gate&filter=all&per_page=100`]);
  });

  it.each([
    // The newest by id decides, in any order: a later red re-run beats an older green one.
    [[gate(9, "completed", "failure"), gate(5, "completed", "success")], "concluded failure"],
    [[gate(5, "completed", "success"), gate(9, "in_progress", null)], "is still in_progress"],
    [[], "No Quality Gate on GitHub"],
  ] as const)("refuses %j", (runs, message) => {
    const result = runGate({ TEST_GH_ANSWER: answer(...runs) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("refuses when GitHub cannot be read or answers nonsense", () => {
    const failed = runGate({ TEST_GH_STATUS: "4" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("Cannot read main's CI");
    const nonsense = runGate({ TEST_GH_ANSWER: "<html>" });
    expect(nonsense.status).toBe(1);
    expect(nonsense.stderr).toContain("unexpected answer from GitHub");
  });

  it("refuses a commit that is not on origin/main without asking GitHub", () => {
    const result = runGate({ TEST_GH_ANSWER: answer(gate(9, "completed", "success")) }, offMain);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${offMain.slice(0, 12)} is not on origin/main`);
    expect(result.calls).toEqual([]);
  });

  it("refuses a checkout with tracked changes", () => {
    git(checkout, "checkout", "-q", onMain);
    writeFileSync(path.join(checkout, "a.txt"), "dirty\n");
    try {
      const result = runGate({ TEST_GH_ANSWER: answer(gate(9, "completed", "success")) });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("uncommitted changes");
      expect(result.calls).toEqual([]);
    } finally {
      git(checkout, "checkout", "-q", "--", "a.txt");
    }
  });
});
