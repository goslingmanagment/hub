import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Execute the real host functions with only Docker/compatibility replaced.
// No page CLI, Docker daemon, server or platform request runs in this test.
const source = readFileSync(new URL("../apps/page-browser/host/page.sh", import.meta.url), "utf8");
function hostFunction(name: string): string {
  const at = source.indexOf(`${name}() {`);
  if (at < 0) throw new Error(`Missing host function ${name}`);
  return source.slice(at, source.indexOf("\n}\n", at) + 3);
}
let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; });
function run(command: "start" | "down", options: { state?: string; archive?: number; compatible?: number } = {}) {
  root = mkdtempSync(join(tmpdir(), "pb archive host "));
  const trace = join(root, "trace");
  writeFileSync(trace, ""); writeFileSync(join(root, "page.env"), "test env\n");
  mkdirSync(join(root, "container-logs"));
  writeFileSync(join(root, "archive-container-logs.sh"), '#!/bin/bash\nprintf "archive %s\\n" "$*" >> "$PB_TRACE"\nexit "$PB_ARCHIVE_RC"\n', { mode: 0o755 });
  const script = [
    "set -eu", 'PAGE=lilly-1',
    'container_status() { echo "$PB_CONTAINER_STATE"; }',
    'compatible() { echo compatible >> "$PB_TRACE"; return "$PB_COMPATIBLE"; }',
    'compose_with() { printf "compose %s\\n" "$*" >> "$PB_TRACE"; }',
    'env_file() { echo "$PB_BASE/page.env"; }',
    'value() { echo test-value; }',
    'fail() { echo "$*" >&2; exit 1; }',
    ...["archive_browser", "start_state", "down"].map(hostFunction),
    command === "start" ? 'start_state "$PB_BASE/page.env"' : "down",
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000, env: {
    ...process.env, PB_BASE: root, PB_TRACE: trace, PB_CONTAINER_STATE: options.state ?? "running",
    PB_ARCHIVE_RC: String(options.archive ?? 0), PB_COMPATIBLE: String(options.compatible ?? 0),
  } });
  return { ...result, trace: readFileSync(trace, "utf8").trim().split("\n") };
}

describe("page-browser log preservation at replacement", () => {
  it("archives only this page before force-recreate, after the Chrome/profile compatibility guard", () => {
    const result = run("start");
    expect(result.status, result.stderr).toBe(0);
    expect(result.trace).toHaveLength(3);
    expect(result.trace[0]).toBe("compatible");
    expect(result.trace[1]).toContain(`archive --dir ${root}/container-logs/lilly-1`);
    expect(result.trace[1]).toContain(`--project-dir ${root} --project-name page-browser-lilly-1 --reason recreate lilly-1 browser`);
    expect(result.trace[2]).toContain("up -d --force-recreate --no-build");
  });
  it("archives before down removes the container and its local stdout/stderr log", () => {
    const result = run("down");
    expect(result.status, result.stderr).toBe(0);
    expect(result.trace[0]).toContain("--reason down lilly-1 browser");
    expect(result.trace[1]).toContain(" down");
  });
  it("reports a partial archive explicitly while allowing recovery to proceed", () => {
    const result = run("start", { archive: 3 });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("log archive incomplete before recreate (status 3); partial files kept");
    expect(result.trace[2]).toContain("--force-recreate");
  });
  it("does not claim a missing old container had a log to preserve", () => {
    const result = run("start", { state: "absent" });
    expect(result.status).toBe(0);
    expect(result.trace.some((line) => line.startsWith("archive "))).toBe(false);
    expect(result.trace.at(-1)).toContain("--force-recreate");
  });
  it("a compatibility refusal archives and replaces nothing", () => {
    const result = run("start", { compatible: 1 });
    expect(result.status).toBe(2);
    expect(result.trace).toEqual(["compatible"]);
  });
});
