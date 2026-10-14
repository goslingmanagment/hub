import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FROM, makeHost, REPO_ROOT, TO, writeExecutable, type Host } from "./helpers/page-browser-update.ts";

// The host's side of a Chrome update (Project Browser PR 18):
// - deploy-page-browser.sh installs the update and its timer (not enabled:
//   the owner's step) and passes `chrome …` to the server's script;
// - the timer only looks, fetches, builds and proposes.

const DEPLOY = path.join(REPO_ROOT, "scripts/deploy-page-browser.sh");
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), "utf8");

describe("deploy-page-browser.sh: the update on the server", () => {
  let root: string;
  let sshLog: string;
  const fakeSsh = [
    "#!/usr/bin/env bash",
    'remote="${@: -1}"',
    'eval "set -- $remote"',
    'printf \'%s\\n--\\n\' "$3" >> "$TEST_SSH_LOG"',
    'if [[ "$3" == *"tar -xf - -C"* ]]; then cat > "$TEST_SSH_STDIN"; fi',
    "exit 0",
    "",
  ].join("\n");

  const deploy = (args: string[]) => {
    root = mkdtempSync(path.join(tmpdir(), "pb deploy chrome "));
    mkdirSync(path.join(root, "bin"));
    writeExecutable(path.join(root, "bin/ssh"), fakeSsh);
    sshLog = path.join(root, "ssh.log");
    writeFileSync(sshLog, "");
    const result = spawnSync("bash", [DEPLOY, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}`, TEST_SSH_LOG: sshLog, TEST_SSH_STDIN: path.join(root, "stdin.tar") },
    });
    const commands = readFileSync(sshLog, "utf8").split("\n--\n").filter((command) => command.trim().length > 0);
    return { ...result, commands };
  };
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("chrome …: the server's page-browser-update.sh with the arguments as given", () => {
    const run = deploy(["chrome", "root@agency-de", "update", "--page", "lilly-1", "--image", TO, "--detach", "--identity", "/k/id"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.commands).toEqual([`set -euo pipefail; /opt/agency-hub/page-browser/page-browser-update.sh update --page lilly-1 --image ${TO} --detach`]);
    expect(deploy(["chrome", "root@agency-de"]).status).toBe(1);
  });

  it("host: installs the update, its profile check, Google's key and the timer's units — the timer not enabled", () => {
    const run = deploy(["host", "root@agency-de"]);
    expect(run.status, run.stderr).toBe(0);
    const listed = spawnSync("tar", ["-tf", path.join(root, "stdin.tar")], { encoding: "utf8" }).stdout.split("\n");
    for (const file of [
      "scripts/page-browser-update.sh",
      "apps/page-browser/host/profile-check.mjs",
      "apps/page-browser/host/google-linux-signing-key.asc",
      "apps/page-browser/host/page-browser-update.service",
      "apps/page-browser/host/page-browser-update.timer",
    ]) expect(listed).toContain(file);
    const [command] = run.commands;
    expect(command).toContain('install -m 755 "$staging/scripts/page-browser-update.sh" /opt/agency-hub/page-browser/page-browser-update.sh');
    expect(command).toContain("/etc/systemd/system/page-browser-update.timer");
    expect(command).toContain("install -d -m 700 /opt/agency-hub/page-browser/update /opt/agency-hub/page-browser/snapshots");
    expect(command).not.toMatch(/^\s*systemctl (enable|start)[^\n]*page-browser-update/m);
    expect(command).toMatch(/^\s*systemctl enable page-browser-egress\.service/m);
    expect(command).toContain("the owner enables it: systemctl enable --now page-browser-update.timer");
  });

  it("build: keeps what the timer builds the next Chrome from, and labels the image with its Chrome", () => {
    const script = read("scripts/deploy-page-browser.sh");
    const build = script.slice(script.indexOf("\nbuild() {"), script.indexOf("\n}\n", script.indexOf("\nbuild() {")));
    expect(build).toContain("--label agency-hub.page-browser.chrome-version=${chrome_version}");
    expect(build).toContain("${REMOTE_BASE}/build/context/${revision}.tar");
    expect(build).toContain("> ${REMOTE_BASE}/build/context/LATEST");
    expect(build).toContain('/vendor/kasmvncserver_* \\"\\$dir\\"/vendor/s6-overlay-* ${REMOTE_BASE}/vendor/');
    expect(build).toContain("${REMOTE_BASE}/chrome/\\$deb.meta");
  });
});

describe("the timer: it looks, fetches, builds and proposes — never updates a page", () => {
  it("once a day at night, persistent; the service runs `check` only", () => {
    const timer = read("apps/page-browser/host/page-browser-update.timer");
    expect(timer).toMatch(/^OnCalendar=\*-\*-\* 03:20:00 UTC$/m);
    expect(timer).toMatch(/^Persistent=true$/m);
    expect(timer).toMatch(/^WantedBy=timers\.target$/m);
    const service = read("apps/page-browser/host/page-browser-update.service");
    expect(service.match(/^ExecStart=.*$/gm)).toEqual(["ExecStart=/opt/agency-hub/page-browser/page-browser-update.sh check"]);
    expect(service).toMatch(/^Type=oneshot$/m);
    expect(service).not.toMatch(/\b(update|rollout|resume|rollback) --/);
  });

  it("check never calls page.sh or a lever of the Hub", () => {
    const script = read("scripts/page-browser-update.sh");
    const check = script.slice(script.indexOf("\ncmd_check() {"), script.indexOf("\n}\n", script.indexOf("\ncmd_check() {")));
    expect(check).not.toMatch(/PAGE_SH|hub_lever|advance|cmd_update|cmd_rollout/);
  });
});

describe("the stand check touches only what its own run made (Astra's review of PR 18, 5)", () => {
  let stand: Host | undefined;
  afterEach(() => {
    stand?.cleanup();
    stand = undefined;
  });

  it("an early failure (a --profile that is not there) removes nothing — not a kept or a parallel stand's container", () => {
    stand = makeHost((state) => {
      state.containers["page-browser-pr18-stand"] = { image: FROM, running: true, profile: "kept" };
      state.containers["page-browser-pr18-abcdef"] = { image: FROM, running: true, profile: "parallel" };
    });
    const result = spawnSync("bash", [path.join(REPO_ROOT, "apps/page-browser/stand/chrome-update.sh"), "--from", FROM, "--to", TO, "--profile", "11111111-2222-4333-8444-555555555555"], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: `${stand.bin}:${process.env.PATH ?? ""}`, FAKE_SCRIPT: path.join(REPO_ROOT, "tests/helpers/page-browser-update-fake.mjs"), FAKE_STATE: stand.statePath, FAKE_LOG: stand.logPath },
    });
    expect(result.status).not.toBe(0);
    const calls = readFileSync(stand.logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { tool: string; args: string[] });
    const removals = calls.filter((call) => call.tool === "docker" && (call.args[0] === "rm" || call.args.includes("rm") || call.args.includes("down")));
    expect(removals).toEqual([]);
    expect(Object.keys(stand.state().containers)).toEqual(expect.arrayContaining(["page-browser-pr18-stand", "page-browser-pr18-abcdef"]));
  });

  it("every name is the run's own, and its cleanup is bound to what it made", () => {
    const script = read("apps/page-browser/stand/chrome-update.sh");
    expect(script).toContain('PAGE="pr18-$RUN_ID"');
    expect(script).toContain('BAD="hub-page-browser:pr18-$RUN_ID-wrong-extension"');
    const cleanup = script.slice(script.indexOf("cleanup() {"), script.indexOf("\n}\n", script.indexOf("cleanup() {")));
    expect(cleanup).toContain('if ((MADE_PAGE == 1)); then docker rm -f "$CONTAINER"');
    expect(cleanup).toContain('if ((MADE_IMAGE == 1)); then docker image rm "$BAD"');
    expect(cleanup).toContain('if ((OWN_PROFILE == 1)); then docker volume rm');
    expect(script.indexOf("MADE_PAGE=1")).toBeLessThan(script.indexOf('bash "$BASE/page.sh" up'));
  });
});

