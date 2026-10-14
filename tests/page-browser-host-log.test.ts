import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The page browser's journals read on the server (Project Browser plan §4.11;
// PR 17): `page.sh log` — run by `scripts/deploy-page-browser.sh log` — reads
// the operator's JSON Lines from the page's buffer volume (Hub's containers
// cannot), one kind, from --since on, of a path that starts with --path, of
// --method: e.g. that POST /api/v1/message/ack never left. page.sh runs for
// real against a `docker` that names a volume in a temporary directory.

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const pageSh = path.join(repoRoot, "apps/page-browser/host/page.sh");
const deployScript = path.join(repoRoot, "scripts/deploy-page-browser.sh");
const PROFILE = "11111111-2222-4333-8444-555555555555";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "hub page browser log "));
  mkdirSync(path.join(root, "bin"));
  mkdirSync(path.join(root, "pages/lilly-1"), { recursive: true });
  mkdirSync(path.join(root, "volume/logs"), { recursive: true });
  writeFileSync(path.join(root, "pages/lilly-1/page.env"), `PB_PAGE=lilly-1\nPB_PROFILE_ID=${PROFILE}\n`);
  // `docker volume inspect -f {{.Mountpoint}} pb-buffer-<profile>`: the volume, and only that one.
  writeFileSync(path.join(root, "bin/docker"), [
    "#!/usr/bin/env bash",
    `[[ "$1 $2" == "volume inspect" && "\${@: -1}" == "pb-buffer-${PROFILE}" ]] || { echo "unexpected docker $*" >&2; exit 3; }`,
    `printf '%s\\n' ${JSON.stringify(path.join(root, "volume"))}`,
    "",
  ].join("\n"), { mode: 0o755 });
  const line = (at: string, method: string, apiPath: string, decision: string) =>
    JSON.stringify({ at, method, host: "apiv3.fansly.com", path: apiPath, resourceType: "XHR", admission: null, decision, result: "x" });
  writeFileSync(path.join(root, "volume/logs/requests-2026-10-12.jsonl.gz"), gzipSync(`${line("2026-10-12T08:00:00.000Z", "POST", "/api/v1/message/ack", "failed")}\n`));
  writeFileSync(path.join(root, "volume/logs/requests-2026-10-13.jsonl.gz"), gzipSync(`${line("2026-10-13T08:00:00.000Z", "GET", "/api/v1/account/me", "continued")}\n`));
  writeFileSync(path.join(root, "volume/logs/requests-2026-10-14.jsonl"), [
    line("2026-10-14T09:00:00.000Z", "POST", "/api/v1/message/ack", "failed"),
    line("2026-10-14T11:00:00.000Z", "GET", "/api/v1/messaging/groups", "continued"),
    "",
  ].join("\n"));
  writeFileSync(path.join(root, "volume/logs/states-2026-10-14.jsonl"), `${JSON.stringify({ at: "2026-10-14T09:30:00.000Z", from: "exit_open", to: "ready" })}\n`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function log(args: string[]) {
  const result = spawnSync("bash", [pageSh, "log", "--page", "lilly-1", ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, PB_BASE: root },
  });
  return { ...result, lines: result.stdout.split("\n").filter((entry) => entry.length > 0).map((entry) => JSON.parse(entry) as Record<string, string>) };
}

describe("page.sh log", () => {
  it("reads one kind over every day, compressed or not, oldest first; filters by path, method and instant", () => {
    const all = log([]);
    expect(all.status, all.stderr).toBe(0);
    expect(all.lines.map((entry) => entry.at)).toEqual([
      "2026-10-12T08:00:00.000Z", "2026-10-13T08:00:00.000Z", "2026-10-14T09:00:00.000Z", "2026-10-14T11:00:00.000Z",
    ]);
    const acks = log(["--path", "/api/v1/message/ack", "--method", "POST"]);
    expect(acks.lines.map((entry) => entry.at)).toEqual(["2026-10-12T08:00:00.000Z", "2026-10-14T09:00:00.000Z"]);
    expect(log(["--path", "/api/v1/message/ack", "--since", "2026-10-13"]).lines.map((entry) => entry.at)).toEqual(["2026-10-14T09:00:00.000Z"]);
    expect(log(["--since", "2026-10-14T10:00:00Z"]).lines.map((entry) => entry.path)).toEqual(["/api/v1/messaging/groups"]);
    expect(log(["--kind", "states"]).lines).toEqual([{ at: "2026-10-14T09:30:00.000Z", from: "exit_open", to: "ready" }]);
  });

  it("refuses what it cannot read safely: an unknown kind, a malformed instant or method, a page it does not know", () => {
    expect(log(["--kind", "secrets"]).status).toBe(1);
    expect(log(["--since", "yesterday; rm -rf /"]).status).toBe(1);
    expect(log(["--method", "post"]).status).toBe(1);
    const unknown = spawnSync("bash", [pageSh, "log", "--page", "lora-1"], {
      encoding: "utf8", env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, PB_BASE: root },
    });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("no page lora-1");
  });

  it("scripts/deploy-page-browser.sh log passes the filters to page.sh on the server", () => {
    writeFileSync(path.join(root, "bin/ssh"), [
      "#!/usr/bin/env bash",
      "remote=\"${@: -1}\"",
      "eval \"set -- $remote\"",
      "printf '%s\\n' \"$3\" >> \"$TEST_SSH_LOG\"",
      "",
    ].join("\n"), { mode: 0o755 });
    const sshLog = path.join(root, "ssh.log");
    writeFileSync(sshLog, "");
    const run = spawnSync("bash", [deployScript, "log", "root@agency-de", "--page", "lilly-1", "--path", "/api/v1/message/ack", "--method", "POST", "--since", "2026-10-14"], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, TEST_SSH_LOG: sshLog },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(sshLog, "utf8")).toContain("/opt/agency-hub/page-browser/page.sh log --page lilly-1 --path /api/v1/message/ack --method POST --since 2026-10-14");
  });
});
