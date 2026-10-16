// A fake server for scripts/page-browser-update.sh (Project Browser PR 18):
// docker (containers, images, the profile volume through the helper
// container, the profile check, the Hub's CLI and read-only SQL through
// `docker compose exec`), page.sh, flock, logger, curl, gpgv, df,
// systemd-run and date — one JSON state (FAKE_STATE), every call logged
// (FAKE_LOG, JSON lines). The engine is played as the Hub would: a leave of
// the browser is confirmed after a few reads, a page given back to its
// browser is started on the Chrome of its container's image.
//
//   node page-browser-update-fake.mjs <tool> <args…>

import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [tool, ...args] = process.argv.slice(2);
const statePath = process.env.FAKE_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const behaviour = state.behaviour ?? {};
const stdinText = () => {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
};
const input = tool === "docker" && args.includes("postgres") ? stdinText() : "";
// "<op>#<n>": killed as the n-th such deed is about to be done — before it,
// not done, not logged.
const [beforeOp, beforeNth] = (behaviour.crashBefore ?? "").split("#");
if (behaviour.crashBefore !== undefined && opOf(tool, args) === beforeOp
  && (state.crashSeen = (state.crashSeen ?? 0) + 1) >= Number(beforeNth ?? 1) && process.env.FAKE_PIDFILE) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  const pid = Number(readFileSync(process.env.FAKE_PIDFILE, "utf8").trim());
  if (pid > 0) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // gone already
    }
  }
  process.exit(137);
}
appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tool, args, ...(input ? { stdin: input } : {}) })}\n`);

let code = 0;
const out = (text) => process.stdout.write(text);
const err = (text) => process.stderr.write(text);
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const chromeOf = (text) => /(\d+\.\d+\.\d+\.\d+)/.exec(text ?? "")?.[1] ?? "";
const newer = (a, b) => {
  const x = chromeOf(a).split(".").map(Number);
  const y = chromeOf(b).split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    if ((x[i] ?? 0) > (y[i] ?? 0)) return true;
    if ((x[i] ?? 0) < (y[i] ?? 0)) return false;
  }
  return false;
};
const pageEnvPath = (page) => path.join(state.pbBase, "pages", page, "page.env");
const envValue = (file, key) => (existsSync(file) ? (readFileSync(file, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"))?.[1] ?? "") : "");
const writeEnv = (file, values) => {
  let text = readFileSync(file, "utf8");
  for (const [key, value] of Object.entries(values)) {
    text = new RegExp(`^${key}=`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`) : `${text}${key}=${value}\n`;
  }
  writeFileSync(file, text);
};
const listed = (list, value) => Array.isArray(list) && list.includes(value);
const now = () => Date.now();

// ── the Hub ──────────────────────────────────────────────────────────────

/** The stops PR 17's operator holds for the owner's decision. */
const HALTS = new Set(["exit_ip_changed", "header_mismatch", "unknown_ws_message", "ws_guard_failed", "login_required", "halt_unreadable"]);

function hubRead(label) {
  const page = state.hub?.pages?.[label];
  if (page === undefined) return "";
  page.reads = (page.reads ?? 0) + 1;
  const container = state.containers[`page-browser-${label}`];
  // The leave: the operator stops Chrome and confirms, unless it cannot.
  if (page.leave !== null) {
    page.leaveReads = (page.leaveReads ?? 0) + 1;
    const stuck = behaviour.leaveNever === true || (container !== undefined && listed(behaviour.leaveNeverOn, container.image));
    if (!stuck && container?.running && page.leaveReads >= (behaviour.leaveConfirmAfterReads ?? 1)) {
      page.leftBy = "operator";
      page.leftGen = page.leave;
      page.leave = null;
      container.chrome = behaviour.chromeUpAfterLeave ? "up" : "down";
      Object.assign(page.pb, { step: "exit_closed", stop: "owner_stop", exitOpen: false, stateAt: now() });
    }
  }
  // The start on the browser, on the Chrome of the container's image.
  if (page.transport === "browser" && page.startPending && container?.running) {
    page.startReads = (page.startReads ?? 0) + 1;
    const chrome = chromeOf(state.images[container.image]?.chrome);
    const outcome = behaviour.engine?.[chrome] ?? behaviour.engineDefault ?? "ready";
    if (outcome !== "never" && page.startReads >= (behaviour.startAfterReads ?? 1)) {
      page.startPending = false;
      page.readyReads = 0;
      // The session the profile holds: the one from before, unless the new
      // Chrome lost it (a new login).
      page.baseFp ??= page.pb.fp;
      const ready = {
        fp: page.baseFp,
        step: "ready",
        stop: "",
        exitOpen: true,
        chrome: `Chrome/${chrome}`,
        operator: state.images[container.image]?.revision ?? "",
        stOk: true,
        stAt: now(),
        stFailed: "",
        stateAt: now(),
        exitIp: page.pb.pinned,
      };
      if (outcome === "ready") Object.assign(page.pb, ready);
      else if (outcome === "fingerprint") Object.assign(page.pb, ready, { fp: "e".repeat(64) });
      else {
        Object.assign(page.pb, { step: "exit_open", stop: outcome, exitOpen: false, stateAt: now() });
        // A stop only the owner decides: the operator holds it, Hub mirrors it.
        if (HALTS.has(outcome)) Object.assign(page.pb, { haltReason: outcome, haltId: "66666666-6666-4666-8666-666666666666" });
      }
    }
  } else if (page.transport === "browser" && page.pb.step === "ready" && container?.running) {
    // A running page says its state every few seconds; one may fail later.
    page.readyReads = (page.readyReads ?? 0) + 1;
    page.pb.stateAt = now();
    if (behaviour.failAfterReadyReads !== undefined && page.readyReads >= behaviour.failAfterReadyReads) {
      Object.assign(page.pb, { step: "exit_closed", stop: behaviour.failStop ?? "chrome_crashed", exitOpen: false });
    }
  }
  const pb = page.pb;
  return [
    page.transport,
    page.leave ?? "",
    String(page.gen),
    page.profile ?? "",
    pb.step ?? "",
    pb.stop ?? "",
    pb.exitOpen === undefined ? "" : String(pb.exitOpen),
    pb.fp ?? "",
    pb.account ?? "",
    pb.exitIp ?? "",
    pb.pinned ?? "",
    pb.chrome ?? "",
    pb.operator ?? "",
    pb.stOk === undefined ? "" : String(pb.stOk),
    pb.stAt === undefined ? "" : String(pb.stAt),
    pb.stFailed ?? "",
    pb.stateAt === undefined ? "" : String(pb.stateAt),
    String(now()),
    String(page.paused === true),
    String(page.stopPaused === true),
    String(page.ownerStop === true),
    pb.haltReason ?? "",
    pb.haltId ?? "",
  ].join("|");
}

function command(page, label, kind, note, outcome, extra = {}) {
  state.commands ??= [];
  const id = state.commands.length + 1;
  state.commands.push({ id, page: label, kind, note, outcome: outcome === "pending" ? "" : outcome, expired: outcome === "expired", detail: extra.detail ?? "", haltId: extra.haltId ?? null });
  return id;
}

/** PR 17's `sync browser snapshot|stop|start`, as the engine carries them out. */
function browserLever(cli) {
  const action = cli[2];
  const label = cli[3];
  const page = state.hub?.pages?.[label];
  const note = cli.includes("--note") ? cli[cli.indexOf("--note") + 1] : "";
  if (page === undefined) {
    err(`${label}: no page\n`);
    return 1;
  }
  if (listed(behaviour.cliFails, action)) {
    err(`sync browser ${action}: ${label} has no browser\n`);
    return 1;
  }
  const container = state.containers[`page-browser-${label}`];
  // The owner's own stop, asked just before this lever reaches the Hub.
  if (behaviour.ownerStopsBefore === action) {
    delete behaviour.ownerStopsBefore;
    page.ownerStop = true;
    if (!page.paused) Object.assign(page, { paused: true, stopPaused: true });
    command(page, label, "stopPage", "the owner's", "ok");
    if (container !== undefined) container.chrome = "down";
  }
  // The owner's move of the page to Node, done just before this lever.
  if (behaviour.ownerMovesToNodeBefore === action) {
    delete behaviour.ownerMovesToNodeBefore;
    Object.assign(page, { transport: "node", leave: null, gen: page.gen + 1 });
  }
  if (action === "snapshot" && cli.includes("--if-no-owner-stop") && (page.transport !== "browser" || page.leave)) {
    err(`${label} is not on its browser (transport ${page.transport}${page.leave ? `, a leave of it pending since generation ${page.leave}` : ""}): the update's stop is asked only of a page on its browser — refused, nothing changed\n`);
    return 1;
  }
  if (action === "snapshot" && cli.includes("--if-no-owner-stop")) {
    // In the transaction that would record the stop: never over another's.
    const next = cli[cli.indexOf("--if-no-owner-stop") + 1];
    const own = next !== undefined && /^[0-9]+$/.test(next) ? Number(next) : null;
    const last = (state.commands ?? []).filter((row) => row.page === label && row.kind === "stopPage").at(-1);
    if (page.ownerStop === true && (last?.id ?? null) !== own) {
      err(`${label}: an owner's stop stands on its browser (the page's latest stop is command ${last?.id ?? "none"}): this stop is never asked over another's — refused, nothing changed\n`);
      return 1;
    }
  }
  if (action === "snapshot" || action === "stop") {
    if (!page.paused) {
      page.paused = true;
      page.stopPaused = true;
    }
    page.ownerStop = true;
    // An operator that is not there takes no command: it expires.
    const outcome = behaviour.stopOutcomeOn?.[container?.image] ?? behaviour.stopOutcome ?? (container?.running ? "ok" : "expired");
    command(page, label, "stopPage", note, outcome);
    if (outcome === "ok") {
      if (container !== undefined) container.chrome = behaviour.chromeUpAfterStop ? "up" : "down";
      Object.assign(page.pb, { step: "exit_closed", stop: "owner_stop", exitOpen: false, stateAt: now() });
    }
    out(`${JSON.stringify({ page: label, operatorConfirmed: outcome === "ok" })}\n`);
    return action === "snapshot" && outcome !== "ok" ? 1 : 0;
  }
  if (action === "start") {
    if (cli.includes("--if-stop")) {
      const wanted = Number(cli[cli.indexOf("--if-stop") + 1]);
      const last = (state.commands ?? []).filter((row) => row.page === label && row.kind === "stopPage").at(-1);
      if (page.ownerStop !== true || last?.id !== wanted) {
        err(`${label}: the stop in force is not command ${wanted}'s: this start lifts only that stop — refused, nothing changed\n`);
        return 1;
      }
    }
    if (cli.includes("--if-no-halt") && page.pb.haltReason) {
      err(`${label}: its browser stands for the owner's decision (${page.pb.haltReason}): a start that clears no halt is refused, nothing changed\n`);
      return 1;
    }
    const haltId = cli.includes("--if-no-halt") ? null : (page.pb.haltId ?? null);
    page.ownerStop = false;
    if (page.stopPaused) {
      page.paused = false;
      page.stopPaused = false;
    }
    const operatorHalt = state.operatorHalts?.[page.profile];
    const outcome = operatorHalt ? "failed" : (behaviour.startOutcome ?? (container?.running ? "ok" : "expired"));
    command(page, label, "restartBrowser", note, outcome, { haltId, detail: operatorHalt ? `the operator holds a halt (${operatorHalt})` : "" });
    if (outcome === "ok") {
      page.startPending = true;
      page.startReads = 0;
    }
    out(`${JSON.stringify({ page: label, result: { outcome } })}\n`);
    return 0;
  }
  return 2;
}

function hubCli(cli) {
  if (cli[0] === "sync" && cli[1] === "browser") return browserLever(cli);
  if (cli[0] === "sync" && cli[1] === "page" && cli[2] === "transport") {
    const label = cli[3];
    const to = cli[4];
    const page = state.hub?.pages?.[label];
    if (page === undefined) {
      err(`sync page transport: no page ${label}\n`);
      return 1;
    }
    if (listed(behaviour.cliFails, to)) {
      err(`sync page transport refused (${to})\n`);
      return 1;
    }
    if (cli.includes("--browser-stopped")) {
      if (page.leave === null) {
        err(`${label}: no leave of its browser is pending: nothing to confirm\n`);
        return 1;
      }
      page.leftBy = "owner";
      page.leftGen = page.leave;
      page.leave = null;
      out(`${JSON.stringify({ page: label, to: "node", browserStopped: true })}\n`);
      return 0;
    }
    if (to === "node") {
      if (!page.credentials) {
        err(`${label} has no Node session stored\n`);
        return 1;
      }
      if (page.transport === "browser") {
        page.gen += 1;
        page.transport = "node";
        page.leave = String(page.gen);
        page.leaveReads = 0;
      }
    } else if (to === "browser") {
      if (page.transport !== "browser") {
        page.gen += 1;
        page.transport = "browser";
        page.leave = null;
        page.startPending = true;
        page.startReads = 0;
      }
    }
    out(`${JSON.stringify({ page: label, to, changed: true })}\n`);
    return 0;
  }
  if (cli[0] === "sync" && cli[1] === "check" && cli[2] === "live-hour") {
    out(`${JSON.stringify({ verdict: behaviour.liveHourExit ?? 0 })}\n`);
    return behaviour.liveHourExit ?? 0;
  }
  err(`unknown hub command ${cli.join(" ")}\n`);
  return 2;
}

// ── the profile volume ───────────────────────────────────────────────────

function helper(op, image, volumes, file) {
  const profileId = volumes.map((v) => /^pb-profile-([0-9a-f-]+):\/profile/.exec(v)?.[1]).find(Boolean);
  const snapDir = volumes.map((v) => /^(.*):\/snap(?::ro)?$/.exec(v)?.[1]).find(Boolean);
  const profile = state.profiles[profileId];
  if (profile === undefined) {
    err(`no profile ${profileId}\n`);
    return 1;
  }
  if (state.images[image] === undefined) {
    err(`no image ${image}\n`);
    return 125;
  }
  if (op === "version") {
    out(`version=${profile.version}\nbytes=${profile.bytes ?? 1000}\n`);
    return 0;
  }
  if (op === "snapshot") {
    if (behaviour.snapshotFails) return 2;
    const work = mkdtempSync(path.join(tmpdir(), "fake-profile-"));
    if (profile.version !== "") writeFileSync(path.join(work, "Last Version"), profile.version);
    writeFileSync(path.join(work, "marker"), profile.marker ?? "");
    const tar = spawnSync("tar", ["-czf", path.join(snapDir, file), "-C", work, "."]);
    rmSync(work, { recursive: true, force: true });
    return tar.status ?? 1;
  }
  if (op === "restore") {
    if (behaviour.restoreFails) return 2;
    const work = mkdtempSync(path.join(tmpdir(), "fake-restore-"));
    const tar = spawnSync("tar", ["-xzf", path.join(snapDir, file), "-C", work]);
    if (tar.status !== 0) return 2;
    profile.version = existsSync(path.join(work, "Last Version")) ? readFileSync(path.join(work, "Last Version"), "utf8") : "";
    profile.marker = existsSync(path.join(work, "marker")) ? readFileSync(path.join(work, "marker"), "utf8") : "";
    profile.restores = (profile.restores ?? 0) + 1;
    rmSync(work, { recursive: true, force: true });
    return 0;
  }
  return 2;
}

// ── docker ───────────────────────────────────────────────────────────────

function docker(argv) {
  const [sub, ...rest] = argv;
  if (sub === "compose" && !rest.includes("exec")) {
    // page.sh's own: compose -p page-browser-<page> -f … --env-file <env> up|down
    const envFile = rest[rest.indexOf("--env-file") + 1];
    const page = envValue(envFile, "PB_PAGE");
    const name = `page-browser-${page}`;
    if (rest.includes("up")) {
      if (behaviour.composeUpFails) return 1;
      const image = envValue(envFile, "PB_IMAGE");
      const profileId = envValue(envFile, "PB_PROFILE_ID");
      state.composeUps = [...(state.composeUps ?? []), image];
      // Its Chrome ran on the profile before the health check failed.
      if (listed(behaviour.opensProfileOn, image) && state.profiles[profileId] !== undefined) state.profiles[profileId].version = chromeOf(state.images[image]?.chrome);
      state.containers[name] = { image, running: true, health: listed(behaviour.unhealthyOn, image) ? "unhealthy" : "healthy", chrome: "down", profile: profileId };
      return 0;
    }
    if (rest.includes("down")) {
      delete state.containers[name];
      return 0;
    }
    return 2;
  }
  if (sub === "ps") {
    if (behaviour.psFails) {
      err("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n");
      return 1;
    }
    const filter = rest[rest.indexOf("--filter") + 1] ?? "";
    const profile = /^volume=pb-profile-(.+)$/.exec(filter)?.[1];
    const format = rest.includes("--format") ? rest[rest.indexOf("--format") + 1] : "";
    for (const [name, container] of Object.entries(state.containers)) {
      if (container.profile === profile) out(format.includes(".State") ? `${name} ${container.running ? "running" : "exited"}\n` : `${name}\n`);
    }
    return 0;
  }
  if (sub === "compose") {
    const exec = rest.indexOf("exec");
    const service = rest[exec + 2];
    if (service === "postgres") {
      if (behaviour.hubDown) return 1;
      if (behaviour.sqlFailAfter !== undefined) {
        state.sqlReads = (state.sqlReads ?? 0) + 1;
        if (state.sqlReads > behaviour.sqlFailAfter) {
          err("could not connect to server\n");
          return 1;
        }
      }
      const stopNow = /-- pb-update:stop (\S+)/.exec(input);
      if (stopNow !== null && /BEGIN READ ONLY;/.test(input)) {
        const page = state.hub?.pages?.[stopNow[1]];
        if (page === undefined) return 0;
        const marker = /note LIKE '([^']*)%'/.exec(input)?.[1] ?? "";
        const last = (state.commands ?? []).filter((row) => row.page === stopNow[1] && row.kind === "stopPage").at(-1);
        out(`${page.ownerStop === true}|${last?.id ?? ""}|${last?.outcome ?? ""}|${last === undefined ? false : last.note.startsWith(marker)}|${page.transport}|${page.leave ?? ""}\n`);
        return 0;
      }
      const guard = /-- pb-update:guard (\S+)/.exec(input);
      if (guard !== null && /BEGIN READ ONLY;/.test(input)) {
        const page = state.hub?.pages?.[guard[1]];
        if (page === undefined) return 0;
        const last = (state.commands ?? []).filter((row) => row.page === guard[1] && row.kind === "stopPage").at(-1);
        out(`${page.transport}|${page.ownerStop === true}|${last?.id ?? ""}|${last?.outcome ?? ""}\n`);
        return 0;
      }
      const asked = /-- pb-update:command (\S+) (\S+)/.exec(input);
      if (asked !== null && /BEGIN READ ONLY;/.test(input)) {
        const marker = /note LIKE '([^']*)%'/.exec(input)?.[1] ?? "";
        const found = (state.commands ?? []).filter((row) => row.page === asked[1] && row.kind === asked[2] && row.note.startsWith(marker)).at(-1);
        if (found !== undefined) out(`${found.id}|${found.outcome}|${String(found.expired)}|${found.detail}\n`);
        return 0;
      }
      const label = /-- pb-update:page (\S+)/.exec(input)?.[1];
      if (label === undefined || !/BEGIN READ ONLY;/.test(input)) {
        err("not a read-only query of the page\n");
        return 3;
      }
      const row = hubRead(label);
      if (row !== "") out(`${row}\n`);
      return 0;
    }
    if (service === "api") {
      const cli = rest.slice(rest.indexOf("apps/runtime/dist/cli.js") + 1);
      return hubCli(cli);
    }
    return 2;
  }
  if (sub === "inspect") {
    const name = rest[rest.length - 1];
    // Docker cannot answer (its daemon restarting, …): an error that says
    // nothing of the container.
    if (behaviour.inspectFails > 0) {
      behaviour.inspectFails -= 1;
      err("Error response from daemon: Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n");
      return 1;
    }
    const container = state.containers[name];
    if (container === undefined) {
      err(`Error: No such object: ${name}\n`);
      return 1;
    }
    const format = rest.includes("-f") ? rest[rest.indexOf("-f") + 1] : "";
    const health = container.running ? (container.health ?? "healthy") : "unhealthy";
    if (format === "{{.State.Running}}") out(`${container.running}\n`);
    else if (format.includes(".State.Running")) out(`${container.running} ${container.image} ${health}\n`);
    else if (format.includes(".State.Health.Status")) out(`${health}\n`);
    else out(`${container.image} ${container.running ? "running" : "exited"} ${health}\n`);
    return 0;
  }
  if (sub === "image") {
    const [action, ...more] = rest;
    if (action === "inspect") {
      const tag = more[more.length - 1];
      const image = state.images[tag];
      if (image === undefined) return 1;
      if (!more.includes("--format") && more.some((name) => state.images[name] === undefined)) return 1;
      const format = more.includes("--format") ? more[more.indexOf("--format") + 1] : "";
      if (format.includes("chrome-version")) out(`${image.label === false ? "<no value>" : image.chrome}\n`);
      else if (format.includes("page-browser.protocol")) out(`${image.protocolLabel ?? "<no value>"}\n`);
      else if (format.includes("revision")) {
        if (listed(behaviour.revisionUnreadableOn, tag)) {
          err("Error response from daemon: context deadline exceeded\n");
          return 1;
        }
        out(`${image.revision ?? "<no value>"}\n`);
      }
      else if (format.includes(".Created")) out(`${image.created ?? "2026-10-01T00:00:00Z"}\n`);
      else out("[]\n");
      return 0;
    }
    if (action === "ls") {
      for (const tag of Object.keys(state.images)) if (tag.startsWith("hub-page-browser:")) out(`${tag}\n`);
      return 0;
    }
    if (action === "rm") {
      const tag = more[more.length - 1];
      if (Object.values(state.containers).some((c) => c.image === tag)) return 1;
      delete state.images[tag];
      return 0;
    }
    return 2;
  }
  if (sub === "builder") {
    const [action] = rest;
    if (action !== "prune") return 2;
    if (behaviour.builderPruneFails) return 1;
    state.builderPrunes = [...(state.builderPrunes ?? []), rest.slice(1).join(" ")];
    return 0;
  }
  if (sub === "network") {
    const [action, ...names] = rest;
    state.networks ??= ["pb-control", "pb-egress"];
    const name = names[names.length - 1];
    if (action === "inspect") return state.networks.includes(name) ? 0 : 1;
    if (action === "create") {
      state.networks.push(name);
      return 0;
    }
    if (action === "rm") {
      state.networks = state.networks.filter((network) => network !== name);
      return 0;
    }
    return 2;
  }
  if (sub === "rm") {
    const name = rest[rest.length - 1];
    if (state.containers[name] === undefined) return 1;
    delete state.containers[name];
    return 0;
  }
  if (sub === "volume" && rest[0] === "rm") {
    for (const name of rest.slice(1)) delete state.profiles[name.replace(/^pb-(profile|buffer)-/, "")];
    return 0;
  }
  if (sub === "volume" && rest[0] === "create") {
    state.profiles[rest[1].replace(/^pb-(profile|buffer)-/, "")] ??= { version: "", marker: "" };
    return 0;
  }
  if (sub === "volume") {
    const names = rest.slice(rest.indexOf("inspect") + 1);
    return names.every((name) => /^pb-(profile|buffer)-/.test(name) && state.profiles[name.replace(/^pb-(profile|buffer)-/, "")] !== undefined) ? 0 : 1;
  }
  if (sub === "run") {
    const volumes = [];
    for (let i = 0; i < rest.length; i++) if (rest[i] === "-v") volumes.push(rest[i + 1]);
    if (rest.includes("pb-halt")) {
      const profileId = volumes.map((v) => /^pb-buffer-([0-9a-f-]+):\/data\/buffer:ro$/.exec(v)?.[1]).find(Boolean);
      if (behaviour.haltUnreadable) return 1;
      out(`halt=${state.operatorHalts?.[profileId] ?? ""}\n`);
      return 0;
    }
    if (rest.includes("pb-protocol")) {
      const image = state.images[rest[rest.indexOf("-c") - 1]];
      if (image === undefined) return 125;
      out(`PROTOCOL = { major: 1, minor: ${image.protocolMinor ?? 1}\n`);
      return 0;
    }
    if (rest.includes("pb-helper")) {
      const at = rest.indexOf("pb-helper");
      const image = rest[rest.indexOf("-c") - 1];
      return helper(rest[at + 1], image, volumes, rest[at + 2] ?? "");
    }
    if (rest.includes("--version")) {
      const image = state.images[rest[rest.indexOf("--version") - 1]];
      if (image === undefined) return 125;
      out(`Google Chrome ${chromeOf(image.chrome)} \n`);
      return 0;
    }
    return 2;
  }
  if (sub === "stop" || sub === "start") {
    const container = state.containers[rest[rest.length - 1]];
    if (container === undefined) return 1;
    if (sub === "stop" && behaviour.stopFails) return 1;
    container.running = sub === "start";
    if (sub === "stop") container.chrome = "down";
    return 0;
  }
  if (sub === "cp") {
    const target = rest[1].split(":")[0];
    return state.containers[target]?.running ? 0 : 1;
  }
  if (sub === "exec") {
    const name = rest[0];
    const container = state.containers[name];
    if (container === undefined || !container.running) return 1;
    if (rest.includes("pb-chrome-state")) {
      out(`${container.chrome ?? "down"}\n`);
      return 0;
    }
    if (rest[1] === "chmod") return 0;
    if (rest.some((arg) => arg.endsWith("pb-profile-check.mjs"))) {
      const image = state.images[container.image];
      const chrome = chromeOf(image?.chrome);
      const profile = state.profiles[container.profile];
      if (container.chrome === "up") {
        out(`${JSON.stringify({ ok: false, error: "Chrome is running" })}\n`);
        return 2;
      }
      // Chrome started on the profile: it names that Chrome from now on.
      if (profile !== undefined) profile.version = chrome;
      if (listed(behaviour.profileCheckFails, container.image)) {
        out(`${JSON.stringify({ ok: false, failed: ["extension_installed_by_policy", "rules_enabled"], chrome: `Chrome/${chrome}`, checks: { extension_installed_by_policy: { pass: false }, rules_enabled: { pass: false } } })}\n`);
        return 1;
      }
      out(`${JSON.stringify({ ok: true, chrome: `Chrome/${chrome}`, extension: { id: "a".repeat(32) }, stopped: "quit" })}\n`);
      return 0;
    }
    return 2;
  }
  if (sub === "build") {
    if (behaviour.buildFails) return 1;
    const tag = rest[rest.indexOf("-t") + 1];
    const labels = {};
    for (let i = 0; i < rest.length; i++) if (rest[i] === "--label") {
      const [key, value] = rest[i + 1].split("=");
      labels[key] = value;
    }
    const context = rest[rest.length - 1];
    state.builds = [...(state.builds ?? []), { tag, labels, vendorSha256: readFileSync(path.join(context, "vendor.sha256"), "utf8") }];
    state.images[tag] = { chrome: labels["agency-hub.page-browser.chrome-version"], revision: labels["agency-hub.page-browser.revision"], created: new Date().toISOString() };
    return 0;
  }
  err(`fake docker: ${argv.join(" ")}\n`);
  return 2;
}

// ── page.sh ──────────────────────────────────────────────────────────────

function pageSh(argv) {
  const [command, ...rest] = argv;
  const page = rest[rest.indexOf("--page") + 1];
  const name = `page-browser-${page}`;
  const env = pageEnvPath(page);
  if (command === "down") {
    if (behaviour.downFails) return 1;
    delete state.containers[name];
    return 0;
  }
  if (command === "up") {
    const image = rest[rest.indexOf("--image") + 1];
    if (state.images[image] === undefined) {
      err(`page: no image ${image} here\n`);
      return 1;
    }
    const profileId = envValue(env, "PB_PROFILE_ID");
    const profile = state.profiles[profileId];
    // page.sh's guard: never an older Chrome on a profile a newer one wrote.
    if (profile !== undefined && profile.version !== "" && newer(profile.version, state.images[image].chrome)) {
      err(`page: ${image} has an older Chrome than the profile's ${profile.version}\n`);
      return 1;
    }
    const old = envValue(env, "PB_IMAGE");
    if (listed(behaviour.upFails, image)) {
      state.containers[name] = { image: old, running: true, health: "healthy", chrome: "down", profile: profileId };
      err(`page: up ${image} failed; page-browser-${page} is back on ${old}\n`);
      return 1;
    }
    state.containers[name] = { image, running: true, health: "healthy", chrome: "down", profile: profileId };
    writeEnv(env, old === image ? { PB_IMAGE: image } : { PB_IMAGE: image, PB_PREVIOUS_IMAGE: old });
    return 0;
  }
  return 2;
}

// ── the rest ─────────────────────────────────────────────────────────────

function curl(argv) {
  const output = argv[argv.indexOf("-o") + 1];
  const url = argv[argv.length - 1];
  const source = state.urls?.[url];
  if (source === undefined) {
    err(`curl: (22) The requested URL returned error: 404 (${url})\n`);
    return 22;
  }
  mkdirSync(path.dirname(output), { recursive: true });
  copyFileSync(source, output);
  return 0;
}

function gpgv(argv) {
  const file = argv[argv.length - 1];
  const text = readFileSync(file, "utf8");
  const status = (line) => writeSync(3, `[GNUPG:] ${line}\n`);
  if (text.includes("BAD-SIGNATURE")) {
    status("NEWSIG");
    status("BADSIG FD533C07C264648F Google Inc. (Linux Packages Signing Authority)");
    err("gpgv: BAD signature\n");
    return 1;
  }
  const lines = text.split("\n");
  const start = lines.indexOf("") + 1;
  const end = lines.indexOf("-----BEGIN PGP SIGNATURE-----");
  out(`${lines.slice(start, end).map((line) => line.replace(/^- /, "")).join("\n")}\n`);
  status("NEWSIG");
  // A signature by an expired or revoked key, which some gpgv versions do
  // not fail on.
  if (behaviour.gpgStatus) status(`${behaviour.gpgStatus} FD533C07C264648F Google Inc. (Linux Packages Signing Authority)`);
  else status("GOODSIG FD533C07C264648F Google Inc. (Linux Packages Signing Authority)");
  status(`VALIDSIG 0E225917414670F4442C250DFD533C07C264648F 2026-10-14 1791968503 0 4 0 1 8 01 ${behaviour.gpgPrimary ?? "EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796"}`);
  return 0;
}

// What a call did (as tests/helpers/page-browser-update.ts names it).
function opOf(name, a) {
  if (name === "page.sh") return `page.sh ${a[0]}${a.includes("--image") ? ` ${a[a.indexOf("--image") + 1]}` : ""}`;
  if (name !== "docker") return null;
  if (a[0] === "compose" && a.includes("api")) {
    const cli = a.slice(a.indexOf("apps/runtime/dist/cli.js") + 1);
    if (cli[2] === "transport") return `hub transport ${cli[4]}${cli.includes("--browser-stopped") ? " --browser-stopped" : ""}`;
    return `hub ${cli.slice(0, 3).join(" ")}`;
  }
  if (a[0] === "run" && a.includes("pb-helper")) return `profile ${a[a.indexOf("pb-helper") + 1]}`;
  if (a[0] === "stop" || a[0] === "start") return `docker ${a[0]}`;
  if (a[0] === "exec" && a.includes("node") && a.some((arg) => arg.endsWith("pb-profile-check.mjs"))) return "profile-check";
  return null;
}

switch (tool) {
  case "docker":
    code = docker(args);
    break;
  case "page.sh":
    code = pageSh(args);
    break;
  case "flock":
    code = behaviour.lockHeld ? 1 : 0;
    break;
  case "logger":
  case "systemd-run":
    break;
  case "curl":
    code = curl(args);
    break;
  case "gpgv":
    code = gpgv(args);
    break;
  case "df":
    out(`Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/fake 999999999 0 ${behaviour.dfAvailKb ?? 999999999} 1% /\n`);
    break;
  case "date":
    if (args.length === 2 && args[0] === "-u" && args[1] === "+%H" && behaviour.hour !== undefined) out(`${behaviour.hour}\n`);
    else {
      const real = spawnSync(existsSync("/bin/date") ? "/bin/date" : "/usr/bin/date", args, { stdio: ["ignore", "inherit", "inherit"] });
      code = real.status ?? 1;
    }
    break;
  default:
    err(`fake: unknown tool ${tool}\n`);
    code = 2;
}
// "<op>#<n>": the n-th time that deed is done.
const [crashOp, crashNth] = (behaviour.crashOn ?? "").split("#");
const crashNow = behaviour.crashOn !== undefined && opOf(tool, args) === crashOp
  && (state.crashSeen = (state.crashSeen ?? 0) + 1) >= Number(crashNth ?? 1);
save();
// A crash of the update right after this call's deed: the script's whole
// process group is killed (SIGKILL: no trap runs, no subshell goes on), as
// a power cut or an OOM kill of its unit would.
if (crashNow && process.env.FAKE_PIDFILE) {
  const pid = Number(readFileSync(process.env.FAKE_PIDFILE, "utf8").trim());
  if (pid > 0) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // gone already
    }
  }
}
process.exit(code);
