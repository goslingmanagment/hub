import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The harness of scripts/page-browser-update.sh's behaviour tests (Project
// Browser PR 18): the script runs for real, in bash, against a fake server
// (page-browser-update-fake.mjs) that plays docker, page.sh, the Hub's CLI
// and read-only SQL, curl, gpgv and the rest from one JSON state.

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const UPDATE_SCRIPT = path.join(REPO_ROOT, "scripts/page-browser-update.sh");
const FAKE = fileURLToPath(new URL("./page-browser-update-fake.mjs", import.meta.url));

export const PAGE = "lilly-1";
export const PROFILE = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
export const FROM = "hub-page-browser:155.0.8059.39-1-aaaaaaaaaaaa";
export const TO = "hub-page-browser:155.0.8059.79-1-bbbbbbbbbbbb";
export const FROM_CHROME = "155.0.8059.39";
export const TO_CHROME = "155.0.8059.79";
export const FINGERPRINT = "f".repeat(64);
export const PINNED_IP = "203.0.113.7";

export interface FakePage {
  transport: "node" | "browser";
  leave: string | null;
  leftBy: string | null;
  leftGen: string | null;
  gen: number;
  credentials: boolean;
  profile: string | null;
  pb: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FakeState {
  pbBase: string;
  images: Record<string, { chrome: string; revision?: string; created?: string; label?: boolean }>;
  containers: Record<string, { image: string; running: boolean; health?: string; chrome?: string; profile?: string }>;
  profiles: Record<string, { version: string; marker?: string; bytes?: number; restores?: number }>;
  hub: { pages: Record<string, FakePage> };
  behaviour: Record<string, unknown>;
  urls?: Record<string, string>;
  builds?: Array<{ tag: string; labels: Record<string, string>; vendorSha256: string }>;
  composeUps?: string[];
  networks?: string[];
  crashSeen?: number;
}

export interface Call {
  tool: string;
  args: string[];
  stdin?: string;
}

export interface Run extends Pick<SpawnSyncReturns<string>, "status" | "signal" | "stdout" | "stderr"> {
  calls: Call[];
  ops: string[];
}

export interface Host {
  root: string;
  statePath: string;
  logPath: string;
  pbBase: string;
  bin: string;
  run(args: string[], options?: { env?: Record<string, string>; crashOn?: string }): Run;
  state(): FakeState;
  edit(change: (state: FakeState) => void): void;
  update(): Record<string, string>;
  journal(): Array<{ event: string; detail: string; run: string; page: string }>;
  snapshots(): string[];
  pageEnv(): string;
  cleanup(): void;
}

const TOOLS = ["docker", "flock", "logger", "curl", "gpgv", "df", "systemd-run"];

/** A server with one page, `lilly-1`, on its browser on FROM (Chrome .39),
 *  the image TO (Chrome .79) built, the Hub's engine reporting the page
 *  ready, and its profile last opened by Chrome .39. */
export function makeHost(change?: (state: FakeState) => void, options: { tools?: string[]; without?: string[] } = {}): Host {
  const root = mkdtempSync(path.join(tmpdir(), "pb update "));
  const pbBase = path.join(root, "page-browser");
  const bin = path.join(root, "bin");
  const hubDir = path.join(root, "hub");
  for (const dir of [bin, hubDir, path.join(pbBase, "pages", PAGE)]) mkdirSync(dir, { recursive: true });
  for (const tool of [...TOOLS, ...(options.tools ?? [])].filter((name) => !(options.without ?? []).includes(name))) {
    writeFileSync(path.join(bin, tool), `#!/usr/bin/env bash\nexec node -- "$FAKE_SCRIPT" ${tool} "$@"\n`, { mode: 0o755 });
  }
  writeFileSync(path.join(bin, "page.sh"), `#!/usr/bin/env bash\nexec node -- "$FAKE_SCRIPT" page.sh "$@"\n`, { mode: 0o755 });
  writeFileSync(path.join(root, "profile-check.mjs"), "// the profile check, as copied into the container\n");
  writeFileSync(
    path.join(pbBase, "pages", PAGE, "page.env"),
    [
      `PB_PAGE=${PAGE}`,
      `PB_IMAGE=${FROM}`,
      "PB_PREVIOUS_IMAGE=",
      `PB_PROFILE_ID=${PROFILE}`,
      "PB_CONTROL_IP=10.230.0.10",
      "PB_EGRESS_IP=10.230.1.10",
      "PB_SOCKS_IP=192.0.2.10",
      "PB_SOCKS_PORT=1080",
      "PB_SYNC_IP=10.230.0.2",
      "PB_API_IP=10.230.0.3",
      "PB_TZ=UTC",
      "PB_LANG=en-US",
      "",
    ].join("\n"),
  );
  const now = Date.now();
  const state: FakeState = {
    pbBase,
    images: {
      [FROM]: { chrome: "155.0.8059.39-1", revision: "aaaaaaaaaaaa", created: "2026-10-01T00:00:00Z" },
      [TO]: { chrome: "155.0.8059.79-1", revision: "bbbbbbbbbbbb", created: "2026-10-14T00:00:00Z" },
    },
    containers: { [`page-browser-${PAGE}`]: { image: FROM, running: true, health: "healthy", chrome: "up", profile: PROFILE } },
    profiles: { [PROFILE]: { version: FROM_CHROME, marker: "before", bytes: 400_000_000 } },
    hub: {
      pages: {
        [PAGE]: {
          transport: "browser",
          leave: null,
          leftBy: null,
          leftGen: null,
          gen: 7,
          credentials: true,
          profile: PROFILE,
          pb: {
            step: "ready",
            stop: "",
            exitOpen: true,
            fp: FINGERPRINT,
            account: "111",
            exitIp: PINNED_IP,
            pinned: PINNED_IP,
            chrome: `Chrome/${FROM_CHROME}`,
            operator: "aaaaaaaaaaaa",
            stOk: true,
            stAt: now - 60_000,
            stFailed: "",
            stateAt: now - 1000,
          },
        },
      },
    },
    behaviour: {},
  };
  change?.(state);
  const statePath = path.join(root, "state.json");
  const logPath = path.join(root, "calls.jsonl");
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  writeFileSync(logPath, "");
  const read = (): FakeState => JSON.parse(readFileSync(statePath, "utf8")) as FakeState;
  let seen = 0;

  return {
    root,
    statePath,
    logPath,
    pbBase,
    bin,
    run(args, runOptions = {}) {
      const pidFile = path.join(root, "script.pid");
      if (runOptions.crashOn !== undefined) {
        const current = read();
        current.behaviour.crashOn = runOptions.crashOn;
        current.crashSeen = 0;
        writeFileSync(statePath, JSON.stringify(current, null, 2));
      }
      // The script in a process group of its own (job control), so that a
      // crash kills all of it — its subshells too — as an OOM kill of the
      // unit or a power cut would; its exit status 137 then.
      const result = spawnSync("bash", ["-c", 'set -m; pidfile="$1"; shift; bash "$@" & echo $! > "$pidfile"; wait $!', "run", pidFile, UPDATE_SCRIPT, ...args], {
        encoding: "utf8",
        timeout: 90_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          PB_BASE: pbBase,
          PB_HUB_DIR: hubDir,
          PB_PAGE_SH: path.join(bin, "page.sh"),
          PB_PROFILE_CHECK: path.join(root, "profile-check.mjs"),
          PB_UPDATE_POLL_S: "0",
          PB_UPDATE_LEAVE_WAIT_S: "2",
          PB_UPDATE_READY_WAIT_S: "2",
          PB_UPDATE_WINDOW_POLL_S: "1",
          PB_ARCH: "amd64",
          FAKE_SCRIPT: FAKE,
          FAKE_STATE: statePath,
          FAKE_LOG: logPath,
          FAKE_PIDFILE: pidFile,
          ...runOptions.env,
        },
      });
      const all = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call);
      const calls = all.slice(seen);
      seen = all.length;
      if (runOptions.crashOn !== undefined) {
        const current = read();
        delete current.behaviour.crashOn;
        writeFileSync(statePath, JSON.stringify(current, null, 2));
      }
      return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, calls, ops: calls.map(op).filter((entry): entry is string => entry !== null) };
    },
    state: read,
    edit(edit) {
      const current = read();
      edit(current);
      writeFileSync(statePath, JSON.stringify(current, null, 2));
    },
    update() {
      const file = path.join(pbBase, "update", "pages", PAGE, "state");
      if (!existsSync(file)) return {};
      return Object.fromEntries(readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    },
    journal() {
      const file = path.join(pbBase, "update", "journal.jsonl");
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: string; detail: string; run: string; page: string });
    },
    snapshots() {
      const dir = path.join(pbBase, "snapshots", PROFILE);
      return existsSync(dir) ? readdirSync(dir).sort() : [];
    },
    pageEnv() {
      return readFileSync(path.join(pbBase, "pages", PAGE, "page.env"), "utf8");
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** What a call did, in a word or three (null: a look, not a deed). */
export function op(call: Call): string | null {
  const a = call.args;
  if (call.tool === "page.sh") return `page.sh ${a[0]}${a.includes("--image") ? ` ${a[a.indexOf("--image") + 1]}` : ""}`;
  if (call.tool !== "docker") return null;
  if (a[0] === "compose" && a.includes("api")) {
    const cli = a.slice(a.indexOf("apps/runtime/dist/cli.js") + 1);
    if (cli[2] === "transport") return `hub transport ${cli[4]}${cli.includes("--browser-stopped") ? " --browser-stopped" : ""}`;
    return `hub ${cli.slice(0, 3).join(" ")}`;
  }
  if (a[0] === "run" && a.includes("pb-helper")) {
    const helperOp = a[a.indexOf("pb-helper") + 1];
    return helperOp === "version" ? null : `profile ${helperOp}`;
  }
  if (a[0] === "stop" || a[0] === "start") return `docker ${a[0]}`;
  if (a[0] === "exec" && a.includes("node") && a.some((arg) => arg.endsWith("pb-profile-check.mjs"))) return "profile-check";
  if (a[0] === "build") return `docker build ${a[a.indexOf("-t") + 1]}`;
  if (a[0] === "image" && a[1] === "rm") return `image rm ${a[a.length - 1]}`;
  return null;
}

export function writeExecutable(file: string, text: string): void {
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}
