// The container's root process for the PROTOTYPE (stands in for s6-overlay
// and the watchdog of plan §3.1/§4.9): starts the X server and Chrome as
// `pb-chrome`, the holder and the operator as `pb-operator`, restarts the
// holder and the operator when they exit, kills an operator whose heartbeat
// file is older than 5 s, and starts/stops Chrome on the operator's command
// (the operator cannot start a process of another user itself).
//
// Control socket /run/pb/ctl.sock (root:pb-operator 0660), length-prefixed
// JSON: {cmd:"chrome.start", env?} {cmd:"chrome.stop"} {cmd:"chrome.kill"}
// {cmd:"chrome.status"} → {ok, pid?, running}. The current pids are in
// /run/pb/pids.json for the stand's fault injection (docker exec … kill).

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

import { encodeMessage, readMessages } from "../shared/frames.ts";
import { envInt, envStr, makeLog, sleep } from "../shared/util.ts";

const log = makeLog("supervisor");
const CHROME_UID = envInt("PB_CHROME_UID", 1001);
const OPERATOR_UID = envInt("PB_OPERATOR_UID", 1002);
const RUN = "/run/pb";
const CTL_SOCK = `${RUN}/ctl.sock`;
const HEARTBEAT = `${RUN}/operator.alive`;
const DISPLAY = envStr("PB_DISPLAY", ":99");
const SRC = "/opt/page-browser/src";
const NODE = process.execPath;
const WATCHDOG_MS = envInt("PB_WATCHDOG_MS", 5000);

const pids: Record<string, number | null> = { xvfb: null, holder: null, operator: null, chrome: null };
let chrome: ChildProcess | null = null;

function writePids(): void {
  writeFileSync(`${RUN}/pids.json`, JSON.stringify(pids));
}

function pipeLogs(name: string, child: ChildProcess): void {
  const forward = (stream: NodeJS.ReadableStream | null, target: NodeJS.WriteStream) => {
    stream?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() !== "") target.write(line.startsWith("{") ? `${line}\n` : `${JSON.stringify({ c: name, raw: line })}\n`);
      }
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
}

function baseEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    LANG: "C.UTF-8",
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("PB_") || key === "NODE_EXTRA_CA_CERTS")),
  };
}

/** Keep a node service of the operator user running. */
function keep(name: "holder" | "operator", script: string, restartMs: number): void {
  const start = () => {
    const child = spawn(NODE, ["--no-warnings", script], {
      uid: OPERATOR_UID,
      gid: OPERATOR_UID,
      env: baseEnv("/home/pb-operator"),
      stdio: ["ignore", "pipe", "pipe"],
    });
    pids[name] = child.pid ?? null;
    writePids();
    log("started", { name, pid: child.pid });
    pipeLogs(name, child);
    child.on("exit", (code, signal) => {
      log("exited", { name, code, signal });
      pids[name] = null;
      writePids();
      setTimeout(start, restartMs);
    });
  };
  start();
}

/** The X server of the page: KasmVNC's Xkasmvnc when present (the owner's
 *  screen, plan §4.8: web client on :6901 with basic auth, the password
 *  from PB_VNC_PASSWORD), else Xvfb. */
function startXServer(): void {
  // No password, no screen: KasmVNC without its password would give anyone
  // who reaches the port the page's screen and input (Astra review of the
  // prototype, finding 12). The stand runs Xvfb then.
  const password = process.env.PB_VNC_PASSWORD ?? "";
  if (process.env.PB_VNC !== "0" && existsSync("/usr/bin/Xkasmvnc") && password === "") log("x.no_vnc", { why: "PB_VNC_PASSWORD is not set" });
  const kasm = existsSync("/usr/bin/Xkasmvnc") && process.env.PB_VNC !== "0" && password !== "";
  let child: ChildProcess;
  if (kasm) {
    const passwordFile = "/home/pb-chrome/.kasmpasswd";
    // kasmvncpasswd reads the password twice from stdin; -w: write access.
    execFileSync("kasmvncpasswd", ["-u", "owner", "-w", passwordFile], { input: `${password}\n${password}\n`, uid: CHROME_UID, gid: CHROME_UID, env: baseEnv("/home/pb-chrome") });
    const args = [
      DISPLAY,
      "-geometry", "1920x1080", "-depth", "24",
      "-websocketPort", String(envInt("PB_VNC_PORT", 6901)),
      "-interface", "0.0.0.0",
      "-httpd", "/usr/share/kasmvnc/www",
      "-KasmPasswordFile", passwordFile,
      "-sslOnly", "0",
      "-disableBasicAuth", "0",
      // The web client authenticates at HTTP (basic auth against the
      // password file); no second VNC-level password.
      "-SecurityTypes", "None",
      "-FrameRate", "30",
      "-AlwaysShared",
      "-nolisten", "tcp",
      // No STUN lookups (UDP is closed anyway; without an address set,
      // Xkasmvnc exits when its STUN queries fail).
      "-publicIP", "127.0.0.1",
    ];
    child = spawn("Xkasmvnc", args, { uid: CHROME_UID, gid: CHROME_UID, env: baseEnv("/home/pb-chrome"), stdio: ["ignore", "pipe", "pipe"] });
    log("x.started", { server: "Xkasmvnc", port: envInt("PB_VNC_PORT", 6901), auth: true });
  } else {
    child = spawn("Xvfb", [DISPLAY, "-screen", "0", "1920x1080x24", "-nolisten", "tcp", "-ac"], {
      uid: CHROME_UID,
      gid: CHROME_UID,
      env: baseEnv("/home/pb-chrome"),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  pids.xvfb = child.pid ?? null;
  writePids();
  pipeLogs(kasm ? "kasmvnc" : "xvfb", child);
  child.on("exit", (code, signal) => {
    log("x.exited", { code, signal });
    pids.xvfb = null;
    setTimeout(startXServer, 1000);
  });
}

function startChrome(env: Record<string, string>): number {
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) return chrome.pid!;
  const args = [
    "--user-data-dir=/data/profile",
    `--remote-debugging-port=${envInt("PB_CDP_PORT", 9222)}`,
    "--window-size=1920,1080",
    `--lang=${env.LANG_TAG ?? "en-US"}`,
    "--no-first-run",
    // Extra flags of the image (e.g. --ignore-gpu-blocklist: WebGL on Mesa's
    // llvmpipe, which Chrome's blocklist turns off on a server without GPU).
    ...envStr("PB_CHROME_ARGS", "").split(" ").filter(Boolean),
    "about:blank",
  ];
  const child = spawn("/usr/bin/google-chrome-stable", args, {
    uid: CHROME_UID,
    gid: CHROME_UID,
    // On Linux Chrome takes its UI language (and navigator.language) from
    // the environment, not from --lang.
    env: { ...baseEnv("/home/pb-chrome"), DISPLAY, TZ: env.TZ ?? "UTC", LANGUAGE: env.LANG_TAG ?? "en-US", LANG: `${(env.LANG_TAG ?? "en-US").replace("-", "_")}.UTF-8` },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  chrome = child;
  pids.chrome = child.pid ?? null;
  writePids();
  log("chrome.started", { pid: child.pid, args });
  pipeLogs("chrome", child);
  child.on("exit", (code, signal) => {
    log("chrome.exited", { pid: child.pid, code, signal });
    if (chrome === child) {
      chrome = null;
      pids.chrome = null;
      writePids();
    }
  });
  return child.pid!;
}

function killChromeGroup(signal: NodeJS.Signals): void {
  if (!chrome?.pid) return;
  try {
    process.kill(-chrome.pid, signal);
  } catch {
    // already gone
  }
}

async function stopChrome(): Promise<void> {
  const current = chrome;
  if (!current) return;
  killChromeGroup("SIGTERM");
  for (let i = 0; i < 50 && current.exitCode === null && current.signalCode === null; i++) await sleep(100);
  if (current.exitCode === null && current.signalCode === null) killChromeGroup("SIGKILL");
}

/** Plan §4.1 step 5, the kernel part: as pb-chrome, every destination but
 *  the operator's proxy must be refused by the kernel's rules. */
function netSelftest(): Promise<Record<string, unknown>> {
  const socksIp = readFileSync("/run/socks-ip", "utf8").trim();
  const probe = `
    const net = require("node:net");
    const targets = JSON.parse(process.argv[1]);
    Promise.all(targets.map(([host, port]) => new Promise((resolve) => {
      const s = net.connect({ host, port });
      const done = (r) => { s.destroy(); resolve([host + ":" + port, r]); };
      s.setTimeout(2000, () => done("timeout"));
      s.on("connect", () => done("connected"));
      s.on("error", (e) => done(e.code || e.message));
    }))).then((r) => { process.stdout.write(JSON.stringify(Object.fromEntries(r))); });`;
  const targets = [[socksIp, envInt("PB_SOCKS_PORT", 1080)], ["1.1.1.1", 443], ["127.0.0.1", envInt("PB_CDP_PORT", 9222)], ["127.0.0.1", envInt("PB_RPC_PORT", 7700)], ["127.0.0.1", 3128]];
  return new Promise((resolve) => {
    const child = spawn(NODE, ["-e", probe, JSON.stringify(targets)], { uid: CHROME_UID, gid: CHROME_UID, env: baseEnv("/home/pb-chrome"), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("exit", () => {
      let results: Record<string, string> = {};
      try {
        results = JSON.parse(out) as Record<string, string>;
      } catch {
        resolve({ ok: false, error: "probe failed", out });
        return;
      }
      const proxy = results["127.0.0.1:3128"];
      const others = Object.entries(results).filter(([key]) => key !== "127.0.0.1:3128");
      const ok = proxy === "connected" && others.every(([, result]) => result !== "connected");
      resolve({ ok, results });
    });
  });
}

/** The pid of Chrome's network service process (the operator watches it:
 *  Chrome restarts a crashed one by itself and says nothing over CDP). */
function networkServicePid(): number | null {
  try {
    const out = execFileSync("pgrep", ["-u", String(CHROME_UID), "-f", "utility-sub-type=network.mojom.NetworkService"], { encoding: "utf8" });
    const pid = Number(out.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function listenControl(): void {
  if (existsSync(CTL_SOCK)) unlinkSync(CTL_SOCK);
  const server = createServer((socket) => {
    readMessages(socket, (value) => {
      const command = value as { cmd: string; env?: Record<string, string>; reason?: string };
      const reply = (body: Record<string, unknown>) => socket.end(encodeMessage(JSON.stringify(body)));
      log("ctl", { cmd: command.cmd, reason: command.reason });
      switch (command.cmd) {
        case "chrome.start":
          reply({ ok: true, pid: startChrome(command.env ?? {}) });
          break;
        case "chrome.stop":
          stopChrome().then(() => reply({ ok: true }));
          break;
        case "chrome.kill":
          killChromeGroup("SIGKILL");
          reply({ ok: true });
          break;
        case "netselftest":
          netSelftest().then((result) => reply(result));
          break;
        case "chrome.status":
          reply({ ok: true, running: chrome !== null, pid: chrome?.pid ?? null });
          break;
        case "chrome.netpid":
          reply({ ok: true, pid: networkServicePid() });
          break;
        default:
          reply({ ok: false, error: "unknown command" });
      }
    });
    socket.on("error", () => undefined);
  });
  server.listen(CTL_SOCK, () => {
    chownSync(CTL_SOCK, 0, OPERATOR_UID);
    chmodSync(CTL_SOCK, 0o660);
  });
}

/** The operator touches its heartbeat file every second; one that stops for
 *  5 s is hung and gets SIGKILL (plan §4.9) — its proxy dies with it, so the
 *  exit closes. */
function watchdog(): void {
  setInterval(() => {
    const pid = pids.operator;
    if (pid === null || pid === undefined || !existsSync(HEARTBEAT)) return;
    const age = Date.now() - statSync(HEARTBEAT).mtimeMs;
    if (age > WATCHDOG_MS) {
      log("watchdog.kill", { pid, ageMs: Math.round(age) });
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
      unlinkSync(HEARTBEAT);
    }
  }, 500);
}

mkdirSync(RUN, { recursive: true });
chownSync(RUN, 0, OPERATOR_UID);
chmodSync(RUN, 0o770);
writePids();
listenControl();
startXServer();
await sleep(500);
keep("holder", `${SRC}/holder/main.ts`, 300);
keep("operator", `${SRC}/operator/main.ts`, 1000);
watchdog();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    killChromeGroup("SIGKILL");
    process.exit(0);
  });
}
