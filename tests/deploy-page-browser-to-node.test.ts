import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// `scripts/deploy-page-browser.sh to-node` (Project Browser PR 14, Astra's
// review): a page whose operator cannot confirm its leave is taken off its
// browser by the owner's word — its container removed and gone first, then
// the Hub told (`sync page transport <page> node --browser-stopped`).
// Never the other way round. The script runs for real against an `ssh`
// that records the remote commands.

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const script = path.join(repoRoot, "scripts/deploy-page-browser.sh");

const fakeSsh = [
  "#!/usr/bin/env bash",
  "remote=\"${@: -1}\"",
  "eval \"set -- $remote\"",
  "command=\"$3\"",
  "printf '%s\\n--\\n' \"$command\" >> \"$TEST_SSH_LOG\"",
  "if [[ \"$command\" == *'docker inspect'* && \"$TEST_CONTAINER_LEFT\" == \"1\" ]]; then exit 1; fi",
  "if [[ \"$command\" == *'docker inspect'* && \"$TEST_CONTAINER_LEFT\" == \"unknown\" ]]; then exit 2; fi",
  "exit 0",
  "",
].join("\n");

let root: string;
let sshLog: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "hub page browser to-node "));
  mkdirSync(path.join(root, "bin"));
  writeFileSync(path.join(root, "bin/ssh"), fakeSsh, { mode: 0o755 });
  sshLog = path.join(root, "ssh.log");
  writeFileSync(sshLog, "");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function toNode(args: string[], options: { containerLeft?: boolean | "unknown" } = {}) {
  const result = spawnSync("bash", [script, "to-node", "root@agency-de", ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, TEST_SSH_LOG: sshLog, TEST_CONTAINER_LEFT: options.containerLeft === "unknown" ? "unknown" : options.containerLeft === true ? "1" : "0" },
  });
  const commands = readFileSync(sshLog, "utf8").split("\n--\n").filter((command) => command.trim().length > 0);
  return { ...result, commands };
}

describe("deploy-page-browser.sh to-node", () => {
  it("removes the container, checks it is gone, then tells the Hub the browser is stopped", () => {
    const run = toNode(["--page", "lilly-1", "--prepare"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.commands).toHaveLength(3);
    expect(run.commands[0]).toContain("/opt/agency-hub/page-browser/page.sh down --page lilly-1");
    expect(run.commands[1]).toContain("out=$(docker inspect page-browser-lilly-1 2>&1) && exit 1; grep -qiE 'no such (object|container)'");
    expect(run.commands[2]).toContain("cd /opt/agency-hub;");
    expect(run.commands[2]).toContain("docker compose --env-file .env.production -f docker-compose.production.yml exec -T api node apps/runtime/dist/cli.js sync page transport lilly-1 node --browser-stopped --prepare --note");
  });

  it("a container that is still there: the Hub is not told", () => {
    const run = toNode(["--page", "lilly-1"], { containerLeft: true });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("page-browser-lilly-1 still exists: the Hub is not told it stopped");
    expect(run.commands.some((command) => command.includes("sync page transport"))).toBe(false);
  });

  it("a container Docker cannot say anything of (its daemon down): not taken for gone, the Hub is not told (PR 18, Astra's review)", () => {
    const run = toNode(["--page", "lilly-1"], { containerLeft: "unknown" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("page-browser-lilly-1 cannot be read on the server: the Hub is not told it stopped");
    expect(run.commands.some((command) => command.includes("sync page transport"))).toBe(false);
  });

  it("needs a page; another Hub directory is honoured", () => {
    expect(toNode([]).status).toBe(1);
    const run = toNode(["--page", "lora-1", "--hub-dir", "/srv/hub"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.commands[2]).toContain("cd /srv/hub;");
    expect(run.commands[2]).not.toContain("--prepare");
  });
});
