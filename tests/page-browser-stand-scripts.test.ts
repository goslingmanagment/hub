import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// The stand's safety on the production server (Project Browser PR 19, owner's
// decision №14): stand.sh and guard.sh run here against stubs of docker,
// systemctl, curl and timeout that only record what they were asked — no
// Docker is touched. What must hold: the builds' BuildKit container never
// stays running without the guard (stopped on any exit of a build, by
// guard-stop, and by the guard's trip), and both networks are isolated.

const stand = path.resolve(__dirname, "../apps/page-browser/stand");
let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_DIR/calls"
case "$1 \${2:-}" in
  "info "*) echo "Ubuntu 26.04 LTS" ;;
  "ps "*)
    if [[ "$*" == *"buildx_buildkit_pb-suite-builder0"* ]]; then [[ -f "$STUB_DIR/builder-running" ]] && echo b1
    elif [[ "$*" == *"label=agency.stand=pb-suite"* ]]; then [[ -f "$STUB_DIR/stand-running" ]] && echo c1
    fi ;;
  "stop "*)
    [[ "$*" == *buildx_buildkit_pb-suite-builder0* ]] && rm -f "$STUB_DIR/builder-running"
    [[ "$*" == *" c1"* ]] && rm -f "$STUB_DIR/stand-running" ;;
  "buildx inspect") [[ "$*" == *--bootstrap* ]] && touch "$STUB_DIR/builder-running" ;;
  "buildx build") exit "\${STUB_BUILD_EXIT:-0}" ;;
esac
exit 0
`;

function sandbox(): { env: NodeJS.ProcessEnv; calls: () => string[]; file: (name: string) => string } {
  dir = mkdtempSync(path.join(tmpdir(), "pb-suite-sh-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(dir, "home", "guard"), { recursive: true });
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  };
  stub("docker", DOCKER);
  stub("systemctl", `#!/usr/bin/env bash\necho "systemctl $*" >> "$STUB_DIR/calls"\nexit 0\n`);
  stub("timeout", `#!/usr/bin/env bash\nshift\nexec "$@"\n`);
  stub("curl", `#!/usr/bin/env bash\nprintf '%s' "\${STUB_CURL:-200 0.002}"\n`);
  writeFileSync(path.join(dir, "home", "guard", "last"), "fresh\n");
  writeFileSync(path.join(dir, "meminfo"), "MemTotal:       16000000 kB\nMemAvailable:   12000000 kB\n");
  writeFileSync(path.join(dir, "loadavg"), "0.30 0.20 0.10 1/200 1234\n");
  return {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      STUB_DIR: dir,
      PB_SUITE_HOME: path.join(dir, "home"),
      PB_GUARD_DIR: path.join(dir, "home", "guard"),
      PB_GUARD_MEMINFO: path.join(dir, "meminfo"),
      PB_GUARD_LOADAVG: path.join(dir, "loadavg"),
      PB_GUARD_ONCE: "1",
    },
    calls: () => (existsSync(path.join(dir, "calls")) ? readFileSync(path.join(dir, "calls"), "utf8").split("\n").filter(Boolean) : []),
    file: (name) => path.join(dir, name),
  };
}

const BUILDER_STOP = "docker stop -t 2 buildx_buildkit_pb-suite-builder0";

describe("the builds' BuildKit container (the server)", () => {
  it("is stopped when a build fails: no exit of a build leaves it running", () => {
    const box = sandbox();
    const result = spawnSync("bash", [path.join(stand, "stand.sh"), "build"], { env: { ...box.env, STUB_BUILD_EXIT: "1" }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    const calls = box.calls();
    const built = calls.findIndex((call) => call.startsWith("docker buildx build"));
    expect(built).toBeGreaterThan(-1);
    expect(calls.findIndex((call) => call === BUILDER_STOP)).toBeGreaterThan(built);
    expect(existsSync(box.file("builder-running"))).toBe(false);
  });

  it("is stopped after a build that succeeded", () => {
    const box = sandbox();
    const result = spawnSync("bash", [path.join(stand, "stand.sh"), "build"], { env: box.env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(box.calls().filter((call) => call.startsWith("docker buildx build"))).toHaveLength(2);
    expect(box.calls()).toContain(BUILDER_STOP);
    expect(existsSync(box.file("builder-running"))).toBe(false);
  });

  it("is stopped by guard-stop, with the stand's containers, before the guard goes", () => {
    const box = sandbox();
    writeFileSync(box.file("builder-running"), "");
    writeFileSync(box.file("stand-running"), "");
    const result = spawnSync("bash", [path.join(stand, "stand.sh"), "guard-stop"], { env: box.env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const calls = box.calls();
    const guardGone = calls.findIndex((call) => call === "systemctl stop pb-suite-guard");
    expect(guardGone).toBeGreaterThan(-1);
    expect(calls.findIndex((call) => call === BUILDER_STOP)).toBeLessThan(guardGone);
    expect(calls.findIndex((call) => call.startsWith("docker stop -t 5 c1"))).toBeLessThan(guardGone);
    expect(existsSync(box.file("builder-running"))).toBe(false);
  });

  it("is stopped by the guard when it trips, with every stand container; a healthy Hub stops nothing", () => {
    const box = sandbox();
    writeFileSync(box.file("builder-running"), "");
    writeFileSync(box.file("stand-running"), "");
    const healthy = spawnSync("bash", [path.join(stand, "guard.sh")], { env: box.env, encoding: "utf8" });
    expect(healthy.status, healthy.stderr).toBe(0);
    expect(box.calls().filter((call) => call.startsWith("docker stop"))).toEqual([]);
    expect(readFileSync(path.join(dir, "home", "guard", "last"), "utf8")).toContain("tripped=no");

    const slow = spawnSync("bash", [path.join(stand, "guard.sh")], { env: { ...box.env, STUB_CURL: "200 0.900" }, encoding: "utf8" });
    expect(slow.status, slow.stderr).toBe(0);
    expect(readFileSync(path.join(dir, "home", "guard", "TRIPPED"), "utf8")).toContain("Hub health took 900 ms");
    expect(box.calls()).toContain("docker stop -t 3 c1");
    expect(box.calls()).toContain(BUILDER_STOP);
    expect(existsSync(box.file("builder-running"))).toBe(false);
    expect(existsSync(box.file("stand-running"))).toBe(false);
  });

  it("nothing is built, started or run while the guard does not measure or has tripped", () => {
    const box = sandbox();
    writeFileSync(path.join(dir, "home", "guard", "TRIPPED"), "2026-10-14T00:00:00Z load 9\n");
    const tripped = spawnSync("bash", [path.join(stand, "stand.sh"), "build"], { env: box.env, encoding: "utf8" });
    expect(tripped.status).not.toBe(0);
    expect(tripped.stderr).toContain("the guard tripped");
    expect(box.calls().some((call) => call.startsWith("docker buildx"))).toBe(false);
  });
});

describe("the stand's networks", () => {
  const compose = readFileSync(path.join(stand, "docker-compose.yml"), "utf8");

  it("are internal and isolated, both: the host is not reachable through their bridges", () => {
    const anchor = /x-isolated: &isolated\n((?: {2}.*\n)+)/.exec(compose)?.[1] ?? "";
    expect(anchor).toContain("internal: true");
    expect(anchor).toContain("com.docker.network.bridge.gateway_mode_ipv4: isolated");
    expect(anchor).toContain("com.docker.network.bridge.gateway_mode_ipv6: isolated");
    const networks = /\nnetworks:\n([\s\S]*?)\nvolumes:\n/.exec(compose)?.[1] ?? "";
    expect(networks.match(/^ {2}[a-z]+:$/gm)).toEqual(["  control:", "  egress:"]);
    expect(networks.match(/<<: \*isolated/g)).toHaveLength(2);
  });

  it("are checked on every up: the options as created, and no answer of the host from inside", () => {
    const script = readFileSync(path.join(stand, "stand.sh"), "utf8");
    expect(script).toContain('[[ "$made" == "true isolated "* && "$made" != *Gateway* ]] || fail');
    expect(script).toContain("/pb/stand/runner/isolation.ts");
    expect(readFileSync(path.join(stand, "runner/isolation.ts"), "utf8")).toContain("no way to the host through the stand's bridges");
  });
});
