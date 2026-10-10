import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { containerId, createFakeDockerHost, HELPER_BASH, type FakeHostOptions } from "./helpers/fake-docker-host.ts";

// М1: a deploy recreate deletes a container together with its log (the
// production `local` driver keeps it in the container's directory). The
// helper archives the logs of the containers about to be replaced; it only
// reads Docker. It runs here against a fake Docker host (tests/helpers/
// fake-docker-host.ts) under macOS's bash 3.2 where there is one, and
// scripts/check-compose-recreate-order.sh runs it once against a real one.

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const helperPath = path.join(repoRoot, "scripts/archive-container-logs.sh");
const apiId = containerId("a1");
const workerId = containerId("b2");
const syncId = containerId("c3");

describe("archive-container-logs.sh", () => {
  let root: string;
  let projectDir: string;
  let archiveDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "hub-archive-logs-"));
    projectDir = path.join(root, "project");
    archiveDir = path.join(root, "container-logs");
    mkdirSync(projectDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function host(options: Partial<FakeHostOptions> = {}) {
    return createFakeDockerHost(root, {
      containers: [
        { id: apiId, service: "api", workingDir: projectDir, log: "2026-10-09T18:22:32Z api line 1\n2026-10-09T18:22:33Z api line 2\n" },
        { id: workerId, service: "worker", workingDir: projectDir, running: false, exitCode: 0 },
      ],
      ...options,
    });
  }

  function run(fake: ReturnType<typeof host>, services: string[], extra: string[] = [], projectArgument = projectDir) {
    return spawnSync(HELPER_BASH, [
      helperPath, "--dir", archiveDir, "--project-dir", projectArgument, "--reason", "deploy run-1 0123456789ab forward",
      ...extra, ...services,
    ], { encoding: "utf8", env: fake.env, timeout: 15_000 });
  }

  function archives(service: string) {
    try {
      return readdirSync(path.join(archiveDir, service)).sort();
    } catch {
      return [];
    }
  }

  function read(service: string, name: string) {
    const text = gunzipSync(readFileSync(path.join(archiveDir, service, name))).toString("utf8");
    const [first, ...rest] = text.split("\n");
    expect(first).toMatch(/^# hub-container-log \{/);
    return { header: JSON.parse(first!.slice("# hub-container-log ".length)) as Record<string, unknown>, body: rest.join("\n") };
  }

  function dockerCalls(fake: ReturnType<typeof host>) {
    return readFileSync(fake.dockerLog, "utf8").trim().split("\n").filter(Boolean);
  }

  it("archives the whole log of every container of the named services, header first, gzip, mode 0600, dir 0700", () => {
    const fake = host();
    const result = run(fake, ["api", "worker"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("service=api found=1\n");
    expect(result.stdout).toContain("service=worker found=1\n");

    const [api] = archives("api");
    const [worker] = archives("worker");
    expect(archives("api")).toHaveLength(1);
    expect(archives("worker")).toHaveLength(1);
    const apiArchive = read("api", api!);
    expect(apiArchive.body).toBe("2026-10-09T18:22:32Z api line 1\n2026-10-09T18:22:33Z api line 2\n");
    expect(apiArchive.header).toMatchObject({
      service: "api", name: "/agency-hub-api-1", id: apiId, revision: "0123456789ab",
      created: "2026-10-09T18:22:31.123456789Z", state: "running", exit_code: 0, oom_killed: false, restart_count: 0,
      reason: "deploy run-1 0123456789ab forward", snapshot: true,
    });
    expect(apiArchive.header.archived_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(read("worker", worker!).header).toMatchObject({ service: "worker", id: workerId, state: "exited" });

    expect(statSync(archiveDir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(archiveDir, "api")).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(archiveDir, "api", api!)).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(archiveDir, "worker", worker!)).mode & 0o777).toBe(0o600);
    expect(result.stdout).toMatch(new RegExp(`^archived service=api id=${apiId.slice(0, 12)} file=api/${api!.replace(/\./g, "\\.")} bytes=\\d+ snapshot=true read_limit=none$`, "m"));
    expect(result.stdout).toMatch(/^pruned files=0 bytes=0 total=\d+$/m);
  });

  it("names the file created_archived_id12_revision and never overwrites", () => {
    const fake = host({
      fixedDate: { compact: "20261010T120000Z", iso: "2026-10-10T12:00:00Z" },
      containers: [
        { id: apiId, service: "api", workingDir: projectDir },
        { id: syncId, service: "sync", workingDir: projectDir, revision: null, created: "2026-10-10T08:00:05.5Z" },
      ],
    });
    expect(run(fake, ["api", "sync"]).status).toBe(0);
    const again = run(fake, ["api"]);
    expect(again.status, again.stdout + again.stderr).toBe(0);

    expect(archives("api")).toEqual([
      `20261009T182231Z_20261010T120000Z_${apiId.slice(0, 12)}_0123456789ab-1.log.gz`,
      `20261009T182231Z_20261010T120000Z_${apiId.slice(0, 12)}_0123456789ab.log.gz`,
    ]);
    expect(archives("sync")).toEqual([`20261010T080005Z_20261010T120000Z_${syncId.slice(0, 12)}_none.log.gz`]);
    expect(read("sync", archives("sync")[0]!).header).toMatchObject({ revision: null, archived_at: "2026-10-10T12:00:00Z" });
  });

  it("selects by project-dir and service labels and oneoff=False", () => {
    const fake = host({
      containers: [
        { id: apiId, service: "api", workingDir: projectDir },
        { id: containerId("d4"), service: "api", workingDir: path.join(root, "taskindex") },
        { id: containerId("e5"), service: "api", workingDir: projectDir, oneoff: true },
      ],
    });
    const result = run(fake, ["api"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(dockerCalls(fake)[0]).toBe(
      `ps -a -q --no-trunc --filter label=com.docker.compose.project.working_dir=${projectDir} `
        + "--filter label=com.docker.compose.service=api --filter label=com.docker.compose.oneoff=False",
    );
    expect(result.stdout).toContain("service=api found=1\n");
    expect(archives("api")).toHaveLength(1);
    expect(archives("api")[0]).toContain(apiId.slice(0, 12));
  });

  it.each(["/", "/./", "//"])("a project dir with a trailing %j selects the same containers", (tail) => {
    const fake = host();
    const result = run(fake, ["api"], [], `${projectDir}${tail}`);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(dockerCalls(fake)[0]).toContain(`--filter label=com.docker.compose.project.working_dir=${projectDir} `);
    expect(result.stdout).toContain("service=api found=1\n");
  });

  it("a named service with no container is partial", () => {
    const fake = host();
    const result = run(fake, ["api", "sync"]);
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("service=sync found=0\n");
    expect(archives("api")).toHaveLength(1);
    expect(archives("sync")).toEqual([]);
  });

  it("is partial when docker cannot list containers", () => {
    const fake = host({ psFails: true });
    const result = run(fake, ["api"]);
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("service=api found=0 error=docker_ps_failed\n");
  });

  it("never stops, kills or removes a container and never calls compose", () => {
    const fake = host();
    expect(run(fake, ["api", "worker"]).status).toBe(0);
    const calls = dockerCalls(fake);
    expect(calls.map((call) => call.split(" ")[0])).toEqual(["ps", "inspect", "logs", "ps", "inspect", "logs"]);
    expect(calls[2]).toBe(`logs --timestamps ${apiId}`);
    const script = readFileSync(helperPath, "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    expect(script).not.toMatch(/docker\s+(?:stop|kill|rm|restart|compose|start|pause|update|volume)\b/);
    expect(script).not.toMatch(/docker\s+(?:container|network)\b/);
  });

  it("header snapshot=true only for a running container", () => {
    const fake = host();
    expect(run(fake, ["api", "worker"]).status).toBe(0);
    expect(read("api", archives("api")[0]!).header.snapshot).toBe(true);
    expect(read("worker", archives("worker")[0]!).header.snapshot).toBe(false);
  });

  it("a timed-out log read is kept as ….truncated.log.gz", () => {
    const fake = host({ timeout: "expire" });
    const result = run(fake, ["api"]);
    expect(result.status).toBe(3);
    const [name] = archives("api");
    expect(name).toMatch(/_0123456789ab\.truncated\.log\.gz$/);
    expect(read("api", name!).body).toContain("api line 2");
    expect(readFileSync(fake.timeoutLog, "utf8")).toBe(`60 docker logs --timestamps ${apiId}\n`);
    expect(result.stdout).toMatch(/^truncated service=api .* read_limit=60s logs_exit=124 gzip_exit=0$/m);
  });

  it.each([
    ["a failed docker logs", (): Partial<FakeHostOptions> => ({
      containers: [{ id: apiId, service: "api", workingDir: projectDir, logsExit: 1 }],
    }), "logs_exit=1 gzip_exit=0"],
    ["a failed gzip", (): Partial<FakeHostOptions> => ({ gzipFails: true }), "logs_exit=0 gzip_exit=1"],
  ] as const)("keeps %s as ….truncated.log.gz and is partial", (_label, options, codes) => {
    const fake = host(options());
    const result = run(fake, ["api"]);
    expect(result.status).toBe(3);
    expect(archives("api")).toEqual([expect.stringMatching(/\.truncated\.log\.gz$/)]);
    expect(result.stdout).toContain(codes);
    expect(result.stdout).not.toMatch(/^archived /m);
  });

  it("reads without a limit when timeout is absent", () => {
    const result = run(host(), ["api"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^archived service=api .* read_limit=none$/m);
  });

  it("reads under --logs-timeout when timeout is there", () => {
    const fake = host({ timeout: "pass" });
    const result = run(fake, ["api"], ["--logs-timeout", "7"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^archived service=api .* read_limit=7s$/m);
    expect(readFileSync(fake.timeoutLog, "utf8")).toBe(`7 docker logs --timestamps ${apiId}\n`);
  });

  it.each(['bad"quote', "back\\slash", "semi;colon", "$(id)", "new\nline", "brace}", ""])(
    "rejects a reason %j outside the allowed characters with exit 2 and writes nothing", (reason) => {
      const fake = host();
      const result = spawnSync(HELPER_BASH, [helperPath, "--dir", archiveDir, "--project-dir", projectDir, "--reason", reason, "api"], {
        encoding: "utf8", env: fake.env, timeout: 15_000,
      });
      expect(result.status).toBe(2);
      expect(dockerCalls(fake)).toEqual([]);
      expect(() => statSync(archiveDir)).toThrow();
    },
  );

  it.each([
    ["no service", ["--dir", "D", "--project-dir", ".", "--reason", "r"]],
    ["no --dir", ["--project-dir", ".", "--reason", "r", "api"]],
    ["a missing project dir", ["--dir", "D", "--project-dir", "/nonexistent/hub", "--reason", "r", "api"]],
    ["a service name with a slash", ["--dir", "D", "--project-dir", ".", "--reason", "r", "../api"]],
    ["a non-numeric limit", ["--dir", "D", "--project-dir", ".", "--reason", "r", "--max-bytes", "1e9", "api"]],
    ["an unknown option", ["--dir", "D", "--project-dir", ".", "--reason", "r", "--stop", "api"]],
  ])("refuses %s with exit 2", (_label, args) => {
    const fake = host();
    const result = spawnSync(HELPER_BASH, [helperPath, ...args], { encoding: "utf8", env: fake.env, cwd: root, timeout: 15_000 });
    expect(result.status).toBe(2);
    expect(dockerCalls(fake)).toEqual([]);
  });

  it.each([90, 97])("writes nothing at %i%% disk (threshold 90), exits 4 and still prunes", (percent) => {
    const fake = host({ diskPercent: percent });
    const stale = path.join(archiveDir, "api", "20260801T000000Z_20260901T000000Z_aaaaaaaaaaaa_none.log.gz");
    mkdirSync(path.dirname(stale), { recursive: true });
    writeFileSync(stale, "old");
    const old = Date.now() / 1000 - 31 * 86_400;
    utimesSync(stale, old, old);

    const result = run(fake, ["api"]);
    expect(result.status).toBe(4);
    expect(result.stdout).toContain(`skipped disk_percent=${percent} max_disk_percent=90\n`);
    expect(result.stdout).toContain("pruned files=1 bytes=3 total=0\n");
    expect(archives("api")).toEqual([]);
    expect(dockerCalls(fake)).toEqual([]);
  });

  it("writes below the disk threshold", () => {
    const fake = host({ diskPercent: 89 });
    expect(run(fake, ["api"]).status).toBe(0);
    expect(archives("api")).toHaveLength(1);
  });

  it("exits 4 without touching Docker when the archive directory is unusable", () => {
    const fake = host();
    writeFileSync(archiveDir, "a file, not a directory");
    const result = run(fake, ["api"]);
    expect(result.status).toBe(4);
    expect(result.stdout).toContain("skipped error=directory_unavailable");
    expect(dockerCalls(fake)).toEqual([]);
  });

  it("prunes by age, then oldest-first to the byte cap, never this run's files; removes stale partials", () => {
    const fake = host();
    const now = Date.now() / 1000;
    const file = (service: string, name: string, bytes: number, ageSeconds: number) => {
      const target = path.join(archiveDir, service, name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "x".repeat(bytes));
      utimesSync(target, now - ageSeconds, now - ageSeconds);
    };
    file("api", "expired.log.gz", 10, 31 * 86_400);
    file("worker", "expired.truncated.log.gz", 10, 40 * 86_400);
    file("api", "stale.partial", 50, 2 * 3_600);
    file("api", "fresh.partial", 50, 600);
    file("api", "oldest.log.gz", 4_000, 3 * 86_400);
    file("worker", "older.log.gz", 4_000, 2 * 86_400);
    file("api", "newer.log.gz", 1_900, 86_400);

    // After the age pass 9,950 bytes remain, under the cap of 10,000; the
    // run's archive pushes the directory over it, and the pass after writing
    // removes the oldest archive, not the run's newest one.
    const result = run(fake, ["api"], ["--max-bytes", "10000"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const runFile = archives("api").find((name) => name.includes(apiId.slice(0, 12)))!;
    expect(runFile).toBeDefined();
    expect(archives("api")).toEqual(["fresh.partial", "newer.log.gz", runFile].sort());
    expect(archives("worker")).toEqual(["older.log.gz"]);
    const runBytes = statSync(path.join(archiveDir, "api", runFile)).size;
    expect(result.stdout).toContain(`pruned files=4 bytes=4070 total=${50 + 1_900 + 4_000 + runBytes}\n`);
    expect(result.stdout).not.toContain("over_cap");
  });

  it("prunes before writing, counts partials, and reports a run above the cap", () => {
    const old1 = path.join(archiveDir, "api", "old1.log.gz");
    const old2 = path.join(archiveDir, "worker", "old2.log.gz");
    const partial = path.join(archiveDir, "worker", "inflight.partial");
    const fake = host({
      watch: old2,
      containers: [{
        id: apiId, service: "api", workingDir: projectDir,
        // Incompressible enough that the run's archive alone is above the cap.
        log: Array.from({ length: 64 }, (_, index) => `2026-10-09T18:22:${String(index % 60).padStart(2, "0")}Z ${(index * 2654435761 % 4294967296).toString(16)} ${Math.sin(index).toString(36)}\n`).join(""),
      }],
    });
    const now = Date.now() / 1000;
    for (const [target, age] of [[old1, 2 * 86_400], [old2, 86_400], [partial, 60]] as const) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "x".repeat(100));
      utimesSync(target, now - age, now - age);
    }

    // 300 bytes before writing, cap 150: without the partial old2 would stay.
    const result = run(fake, ["api"], ["--max-bytes", "150"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(fake.watchLog, "utf8")).toBe("absent\n");
    expect(archives("api")).toEqual([expect.stringContaining(apiId.slice(0, 12))]);
    expect(archives("worker")).toEqual(["inflight.partial"]);
    const runBytes = statSync(path.join(archiveDir, "api", archives("api")[0]!)).size;
    expect(runBytes).toBeGreaterThan(150);
    expect(result.stdout).toContain("pruned files=2 bytes=200 total=");
    expect(result.stdout).toContain(`over_cap bytes=${runBytes + 100} max_bytes=150\n`);
  });

  it("prints metadata only", () => {
    const fake = host({
      containers: [{ id: apiId, service: "api", workingDir: projectDir, log: "2026-10-09T18:22:32Z {\"token\":\"SECRET-never-printed\"}\n" }],
    });
    const result = run(fake, ["api"]);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("SECRET");
    expect(read("api", archives("api")[0]!).body).toContain("SECRET-never-printed");
    for (const line of result.stdout.trim().split("\n")) {
      expect(line).toMatch(/^(?:service=|archived |pruned )/);
    }
  });
});
