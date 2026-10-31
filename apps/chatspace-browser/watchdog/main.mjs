// The always-on tab's watchdog (README «Сторож»). Every 30 s it looks at what
// only this container sees and restarts Firefox (`s6-svc -r`; Firefox comes
// back on ChatSpace's Accounts Overview, user.js) when:
//
// - the extension in the profile is not the version this Firefox started
//   with — the first install by the policy, or an update from the feed: the
//   open ChatSpace tab keeps the old scripts (or none), and its socket tap
//   starts only with the page (firefox/run writes the start version);
// - a content process crashed (a new dump in the profile's minidumps/): the
//   tab shows Firefox's «tab crashed» page and its socket is gone;
// - the container's memory stayed above 90 % of its limit for two looks.
//
// At most one restart per 10 min and six a day; past that it only logs, and
// the hub's watch of the tab's reports pages the owner. It never touches the
// page: no click, no key, no login. Its state for `deploy-chatspace-browser.sh
// status`: /run/csb/watchdog.json.
//
// `main.mjs --extension-version` prints the extension's version in the
// profile (nothing when it has none) and exits: firefox/run, before a start.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { setInterval } from "node:timers";

const PROFILE = "/data/profile";
const EXTENSION_ID = "chat-extension@gosling.agency";
const STATE = "/run/csb/watchdog.json";
const START_VERSION = "/run/csb/firefox-start-version";
const EVERY_MS = 30_000;
/** Firefox younger than this is starting: its profile is still settling. */
const SETTLE_S = 90;
const RESTART_GAP_MS = 10 * 60_000;
const RESTARTS_PER_DAY = 6;
const MEMORY_SHARE = 0.9;
/** extensions.json is a few hundred KB at most; a larger one is not read. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;

const state = {
  startedAt: new Date().toISOString(),
  extension: null,
  restarts: [],
  memory: null,
  lastLookAt: null,
  lastProblem: null,
};
let newestDumpMs;
let highMemoryLooks = 0;

function log(message) {
  process.stderr.write(`watchdog: ${message}\n`);
}

function extensionOf() {
  try {
    const path = `${PROFILE}/extensions.json`;
    if (statSync(path).size > MAX_JSON_BYTES) return null;
    const addons = JSON.parse(readFileSync(path, "utf8"))?.addons;
    if (!Array.isArray(addons)) return null;
    const ours = addons.find((addon) => addon?.id === EXTENSION_ID);
    if (ours === undefined) return { version: null, active: false };
    return { version: typeof ours.version === "string" ? ours.version.slice(0, 32) : null, active: ours.active === true };
  } catch {
    return null;
  }
}

function newestDump() {
  try {
    let newest = 0;
    for (const name of readdirSync(`${PROFILE}/minidumps`)) {
      if (!name.endsWith(".dmp")) continue;
      newest = Math.max(newest, statSync(`${PROFILE}/minidumps/${name}`).mtimeMs);
    }
    return newest;
  } catch {
    return 0;
  }
}

/** The container's memory as Docker counts it (usage less inactive file pages), and its limit; null — unknown. */
function memoryOf() {
  try {
    const current = Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim());
    const max = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    if (max === "max") return null;
    const inactive = /^inactive_file (\d+)$/m.exec(readFileSync("/sys/fs/cgroup/memory.stat", "utf8"));
    const used = current - (inactive === null ? 0 : Number(inactive[1]));
    return { usedBytes: used, limitBytes: Number(max) };
  } catch {
    return null;
  }
}

/** How long Firefox's service has been up, in seconds; null — down. */
function firefoxUpFor() {
  try {
    const [up, seconds] = execFileSync("/command/s6-svstat", ["-o", "up,updownfor", "/run/service/firefox"], { encoding: "utf8" }).trim().split(/\s+/);
    return up === "true" ? Number(seconds) : null;
  } catch {
    return null;
  }
}

function restart(why) {
  const now = Date.now();
  const day = state.restarts.filter((restart) => now - Date.parse(restart.at) < 24 * 3600_000);
  const last = day.at(-1);
  if (last !== undefined && now - Date.parse(last.at) < RESTART_GAP_MS) {
    state.lastProblem = `${why} — no restart: the last one was less than 10 min ago`;
    log(state.lastProblem);
    return false;
  }
  if (day.length >= RESTARTS_PER_DAY) {
    state.lastProblem = `${why} — no restart: ${RESTARTS_PER_DAY} in the last 24 h`;
    log(state.lastProblem);
    return false;
  }
  try {
    execFileSync("/command/s6-svc", ["-r", "/run/service/firefox"]);
  } catch {
    state.lastProblem = `${why} — the restart could not be asked of s6`;
    log(state.lastProblem);
    return false;
  }
  state.restarts = [...day, { at: new Date(now).toISOString(), why }];
  log(`Firefox restarted: ${why}`);
  return true;
}

/** The extension's version when this Firefox started ("" — none); undefined — not written. */
function startVersion() {
  try {
    return readFileSync(START_VERSION, "utf8").trim().slice(0, 32);
  } catch {
    return undefined;
  }
}

function look() {
  state.lastLookAt = new Date().toISOString();
  const upFor = firefoxUpFor();
  const extension = extensionOf();
  if (extension !== null) state.extension = extension;
  const memory = memoryOf();
  state.memory = memory;
  // Firefox down or still starting: its files say nothing new yet.
  if (upFor === null || upFor < SETTLE_S) return;

  const dump = newestDump();
  if (newestDumpMs === undefined) newestDumpMs = dump;
  const started = startVersion();

  if (extension !== null && extension.version !== null && started !== undefined && extension.version !== started) {
    const why = started === "" ? `the extension ${extension.version} installed under the open tab` : `the extension updated ${started} → ${extension.version}`;
    if (restart(why)) {
      newestDumpMs = dump;
      return;
    }
  }
  if (dump > newestDumpMs) {
    if (restart("a content process crashed (a new dump in minidumps/)")) {
      newestDumpMs = dump;
      return;
    }
  }
  if (memory !== null && memory.usedBytes > memory.limitBytes * MEMORY_SHARE) {
    highMemoryLooks += 1;
    if (highMemoryLooks >= 2 && restart(`memory ${Math.round(memory.usedBytes / 1048576)} MiB of ${Math.round(memory.limitBytes / 1048576)} MiB`)) {
      highMemoryLooks = 0;
    }
  } else {
    highMemoryLooks = 0;
  }
}

function save() {
  try {
    writeFileSync(`${STATE}.tmp`, `${JSON.stringify(state)}\n`, { mode: 0o644 });
    renameSync(`${STATE}.tmp`, STATE);
  } catch {
    // the next look writes it again
  }
}

function tick() {
  try {
    look();
  } catch (error) {
    state.lastProblem = `a look failed: ${error instanceof Error ? error.message : "error"}`;
    log(state.lastProblem);
  }
  save();
}

if (process.argv.includes("--extension-version")) {
  process.stdout.write(`${extensionOf()?.version ?? ""}\n`);
  process.exit(0);
}

log("started");
tick();
setInterval(tick, EVERY_MS);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
