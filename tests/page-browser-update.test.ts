import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FINGERPRINT, FROM, FROM_CHROME, makeHost, PAGE, PROFILE, TO, TO_CHROME, type Host } from "./helpers/page-browser-update.ts";

// Each test runs the script in bash against a fake server that starts a
// process per call: slower than a unit test, more so under a full parallel run.
vi.setConfig({ testTimeout: 180_000 });

// scripts/page-browser-update.sh — one page onto a new Chrome (Project
// Browser PR 18; plan §4.10, spec §10). The page's browser is stopped by the
// owner's lever (PR 17's `sync browser snapshot`, confirmed by the operator
// once Chrome is down; the page stays on its browser transport), its
// profile snapshotted before the new Chrome first opens it, checked on the
// host, started again (`sync browser start --if-no-halt`), checked by the
// engine, watched; any failure leaves it on its previous image WITH its
// profile from before, and a halt held for the owner's decision is never
// the update's. The script runs for real in bash against a fake server
// (tests/helpers/page-browser-update-fake.mjs).

let host: Host | undefined;
afterEach(() => {
  host?.cleanup();
  host = undefined;
});

const UPDATE = ["update", "--page", PAGE, "--image", TO, "--any-hour"];
const containerOf = (h: Host) => h.state().containers[`page-browser-${PAGE}`];
const profile = (h: Host) => h.state().profiles[PROFILE]!;
const hubPage = (h: Host) => h.state().hub.pages[PAGE]!;
const events = (h: Host) => h.journal().map((line) => line.event);

/** Every write the update made, after its plan: nothing but its own. */
const OUT_TO_IN = ["hub sync browser snapshot", "docker stop", "profile snapshot", `page.sh up ${TO}`, "profile-check", "hub sync browser start"];

describe("page-browser-update.sh update: one page onto a new Chrome", () => {
  it("a page on its browser: its browser stopped by the owner's lever, its snapshot, the new image, host checks, started again, engine checks, the window — in that order", () => {
    host = makeHost();
    const run = host.run([...UPDATE, "--window", "2s"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.ops).toEqual([...OUT_TO_IN, "hub sync check live-hour"]);
    // The page on the new image, its previous image kept for page.sh.
    expect(containerOf(host)).toMatchObject({ image: TO, running: true });
    expect(host.pageEnv()).toContain(`PB_IMAGE=${TO}\n`);
    expect(host.pageEnv()).toContain(`PB_PREVIOUS_IMAGE=${FROM}\n`);
    // The new Chrome opened the profile; the snapshot holds it as it was.
    expect(profile(host)).toMatchObject({ version: TO_CHROME, marker: "before" });
    const [snapshot, meta] = host.snapshots();
    expect(snapshot).toMatch(new RegExp(`^\\d{8}T\\d{6}Z-chrome-${FROM_CHROME}-.+\\.tar\\.gz$`));
    expect(meta).toBe(`${snapshot}.meta`);
    const dir = path.join(host.pbBase, "snapshots", PROFILE);
    const metaText = readFileSync(path.join(dir, meta!), "utf8");
    expect(metaText).toContain(`chrome=${FROM_CHROME}\n`);
    expect(metaText).toContain(`image=${FROM}\n`);
    const sha = spawnSync("shasum", ["-a", "256", path.join(dir, snapshot!)], { encoding: "utf8" }).stdout.split(" ")[0];
    expect(metaText).toContain(`sha256=${sha}\n`);
    expect(spawnSync("tar", ["-xzOf", path.join(dir, snapshot!), "./Last Version"], { encoding: "utf8" }).stdout).toBe(FROM_CHROME);
    // Never off its browser: stopped, then started again; the stop's pause gone.
    expect(hubPage(host)).toMatchObject({ transport: "browser", leave: null, ownerStop: false, paused: false });
    expect(host.update()).toMatchObject({ STEP: "done", ENGINE_CHECKS: "passed", WINDOW: "passed", FROM_CHROME, TO_CHROME, TRANSPORT_BEFORE: "browser", HANDOVER: "1", FINGERPRINT_BEFORE: FINGERPRINT });
    expect(events(host)).toEqual(expect.arrayContaining(["planned", "taken_out", "snapshot", "host_checks", "engine_checks", "window", "updated"]));
  });

  it("asks the Hub only through its audited levers and read-only SQL, each lever noted with the run", () => {
    host = makeHost();
    const run = host.run(UPDATE.concat("--window", "0"));
    expect(run.status, run.stderr).toBe(0);
    const runId = host.update().RUN!;
    const sql = run.calls.filter((call) => call.tool === "docker" && call.args.includes("postgres"));
    expect(sql.length).toBeGreaterThan(2);
    for (const call of sql) {
      expect(call.stdin).toMatch(/^-- pb-update:(page lilly-1|command lilly-1 \w+|stop lilly-1|guard lilly-1)\nBEGIN READ ONLY;\nSELECT /);
      // No write, outside its quoted literals (the run's note names the script).
      expect(call.stdin!.split("\n").slice(1).join("\n").replace(/'[^']*'/g, "''")).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
    }
    const levers = run.calls.filter((call) => call.tool === "docker" && call.args.includes("api"));
    expect(levers.map((call) => call.args.slice(call.args.indexOf("apps/runtime/dist/cli.js") + 1, call.args.indexOf("apps/runtime/dist/cli.js") + 4))).toEqual([
      ["sync", "browser", "snapshot"],
      ["sync", "browser", "start"],
    ]);
    for (const call of levers) {
      expect(call.args.slice(0, 5)).toEqual(["compose", "--env-file", ".env.production", "-f", "docker-compose.production.yml"]);
      const note = call.args[call.args.indexOf("--note") + 1];
      expect(note).toMatch(new RegExp(`^page-browser-update ${runId} (out|back): Chrome ${FROM_CHROME} -> ${TO_CHROME} \\(`));
    }
    // The update's stop is never asked over another's (refused in its own
    // transaction); its start never names a halt, and lifts only its own stop.
    expect(levers[0]!.args[levers[0]!.args.indexOf("--if-no-owner-stop") + 1]).toBe("--note");
    expect(levers[1]!.args).toContain("--if-no-halt");
    const stopId = String(host.state().commands!.find((row) => row.kind === "stopPage")!.id);
    expect(levers[1]!.args.slice(levers[1]!.args.indexOf("--if-stop"), levers[1]!.args.indexOf("--if-stop") + 2)).toEqual(["--if-stop", stopId]);
  });

  it("a page on Node: no lever of the Hub, Chrome must stand; the engine has nothing of it to check", () => {
    host = makeHost((state) => {
      state.hub.pages[PAGE]!.transport = "node";
      state.containers[`page-browser-${PAGE}`]!.chrome = "down";
    });
    const run = host.run(UPDATE);
    expect(run.status, run.stderr).toBe(0);
    expect(run.ops).toEqual(["docker stop", "profile snapshot", `page.sh up ${TO}`, "profile-check"]);
    expect(host.update()).toMatchObject({ STEP: "done", ENGINE_CHECKS: "skipped", WINDOW: "none", TRANSPORT_BEFORE: "node", HANDOVER: "0" });
    expect(hubPage(host).transport).toBe("node");
  });

  it("a page whose browser its owner stopped: updated stopped, no lever — it stays stopped until his start", () => {
    host = makeHost((state) => {
      Object.assign(state.hub.pages[PAGE]!, { ownerStop: true, paused: true, stopPaused: true });
      state.commands = [{ id: 1, page: PAGE, kind: "stopPage", note: "the owner's", outcome: "ok", expired: false, detail: "", haltId: null }];
      state.containers[`page-browser-${PAGE}`]!.chrome = "down";
    });
    const run = host.run(UPDATE);
    expect(run.status, run.stderr).toBe(0);
    expect(run.ops).toEqual(["docker stop", "profile snapshot", `page.sh up ${TO}`, "profile-check"]);
    expect(host.update().OUT_STOP).toBe("1");
    expect(host.update()).toMatchObject({ STEP: "done", ENGINE_CHECKS: "skipped", HANDOVER: "0" });
    expect(host.update().HANDOVER_WHY).toContain("the owner's stop holds the page's browser");
    expect(hubPage(host)).toMatchObject({ ownerStop: true, paused: true });
  });

  it("a page with no Node session stored is updated: it never leaves its browser", () => {
    host = makeHost((state) => {
      state.hub.pages[PAGE]!.credentials = false;
    });
    const run = host.run([...UPDATE, "--window", "0"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.ops).toEqual(OUT_TO_IN);
    expect(host.update().STEP).toBe("done");
  });

  it("--engine none (the stand, a page the Hub does not know): never asks the Hub", () => {
    host = makeHost((state) => {
      state.hub.pages = {};
      state.containers[`page-browser-${PAGE}`]!.chrome = "down";
    });
    const run = host.run([...UPDATE, "--engine", "none"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.calls.some((call) => call.args.includes("compose"))).toBe(false);
    expect(run.ops).toEqual(["docker stop", "profile snapshot", `page.sh up ${TO}`, "profile-check"]);
    expect(host.update()).toMatchObject({ STEP: "done", ENGINE: "none", TRANSPORT_BEFORE: "none" });
  });
});

describe("refusals: nothing changes", () => {
  const refused = (h: Host, args: string[], message: string | RegExp) => {
    const run = h.run(args);
    expect(run.status, run.stderr).toBe(2);
    expect(run.stderr).toMatch(message);
    expect(run.ops).toEqual([]);
    expect(containerOf(h)).toMatchObject({ image: FROM, running: true });
    expect(hubPage(h).transport).toBe("browser");
    return run;
  };

  it("a halt Hub mirrors for the owner's decision: not updated, the owner told", () => {
    host = makeHost((state) => {
      Object.assign(state.hub.pages[PAGE]!.pb, { haltReason: "exit_ip_changed", haltId: "77777777-7777-4777-8777-777777777777" });
    });
    refused(host, UPDATE, /stands for the owner's decision \(exit_ip_changed, halt 77777777-7777-4777-8777-777777777777\): not updated/);
    expect(host.journal().map((line) => line.event)).toContain("update_refused");
  });

  it("a halt the operator holds on its volume (not mirrored yet): not updated", () => {
    host = makeHost((state) => {
      state.operatorHalts = { [PROFILE]: "header_mismatch 88888888-8888-4888-8888-888888888888" };
    });
    refused(host, UPDATE, /its operator holds a halt for the owner's decision \(header_mismatch 88888888/);
  });

  it("the operator's halt cannot be read: not updated blind", () => {
    host = makeHost((state) => {
      state.behaviour.haltUnreadable = true;
    });
    refused(host, UPDATE, /the halt lilly-1's operator may hold on its volume cannot be read/);
  });

  it("a page its owner paused: not updated (its checks need it running)", () => {
    host = makeHost((state) => {
      state.hub.pages[PAGE]!.paused = true;
    });
    refused(host, UPDATE, /is paused by its owner/);
  });

  it("an image whose operator the engine refuses (protocol before 1.1): not updated to — nor from", () => {
    host = makeHost((state) => {
      state.images[TO]!.protocolMinor = 0;
    });
    refused(host, UPDATE, new RegExp(`${TO.replace(/[.]/g, "\\.")}'s operator speaks protocol 1\\.0`));
    host.cleanup();
    host = makeHost((state) => {
      state.images[FROM]!.protocolLabel = "1.0";
    });
    refused(host, UPDATE, /operator speaks protocol 1\.0: the engine works with 1\.1 or later of major 1: the update's way back would be an image the engine refuses/);
  });

  it("a page leaving its browser already", () => {
    host = makeHost((state) => {
      Object.assign(state.hub.pages[PAGE]!, { transport: "node", leave: "7" });
      state.behaviour.leaveNever = true;
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("leaving its browser already");
    expect(run.ops).toEqual([]);
  });

  it("an image with an older Chrome, or the same image", () => {
    host = makeHost((state) => {
      state.images["hub-page-browser:155.0.8059.20-1-cccccccccccc"] = { chrome: "155.0.8059.20-1", revision: "cccccccccccc" };
    });
    refused(host, ["update", "--page", PAGE, "--image", "hub-page-browser:155.0.8059.20-1-cccccccccccc", "--any-hour"], /older than 155\.0\.8059\.39: Chrome never goes back/);
    refused(host, ["update", "--page", PAGE, "--image", FROM, "--any-hour"], /is on .* already/);
  });

  it("a profile a newer Chrome than the image's opened", () => {
    host = makeHost((state) => {
      state.profiles[PROFILE]!.version = "156.0.8078.12";
    });
    refused(host, UPDATE, /last opened by Chrome 156\.0\.8078\.12, newer than 155\.0\.8059\.79/);
  });

  it("outside 06:00–20:00 UTC without --any-hour; inside, it goes", () => {
    host = makeHost((state) => {
      state.behaviour.hour = "21";
    });
    writeFileSync(path.join(host.bin, "date"), `#!/usr/bin/env bash\nexec node -- "$FAKE_SCRIPT" date "$@"\n`, { mode: 0o755 });
    refused(host, ["update", "--page", PAGE, "--image", TO], /between 6:00 and 20:00 UTC/);
    host.edit((state) => {
      state.behaviour.hour = "06";
    });
    const run = host.run(["update", "--page", PAGE, "--image", TO, "--window", "0"]);
    expect(run.status, run.stderr).toBe(0);
  });

  it("another update holds the lock", () => {
    host = makeHost((state) => {
      state.behaviour.lockHeld = true;
    });
    refused(host, UPDATE, /another update, rollback or build holds/);
  });

  it("no room for the profile's snapshot", () => {
    host = makeHost((state) => {
      state.behaviour.dfAvailKb = 900_000;
    });
    refused(host, UPDATE, /not enough room for the profile's snapshot/);
  });

  it("a container that is not running healthy on the page's image", () => {
    host = makeHost((state) => {
      state.containers[`page-browser-${PAGE}`]!.health = "unhealthy";
    });
    refused(host, UPDATE, /is not running healthy/);
  });

  it("a page the Hub does not know, under the Hub's engine", () => {
    host = makeHost((state) => {
      state.hub.pages = {};
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("--engine none");
    expect(run.ops).toEqual([]);
  });
});

describe("failures before the new image ran: the page as it was", () => {
  const asItWas = (h: Host) => {
    expect(containerOf(h)).toMatchObject({ image: FROM, running: true });
    expect(h.pageEnv()).toContain(`PB_IMAGE=${FROM}\n`);
    expect(profile(h)).toMatchObject({ version: FROM_CHROME, marker: "before" });
    expect(profile(h).restores ?? 0).toBe(0);
    expect(hubPage(h)).toMatchObject({ transport: "browser", leave: null });
    expect(h.update().STEP).toBe("aborted");
    expect(events(h)).toContain("aborted");
  };

  for (const outcome of ["expired", "unknown", "pending"] as const) {
    it(`the browser's stop ends ${outcome === "pending" ? "not at all in time" : outcome}: held for the owner — nothing stopped blind, nothing started blind`, () => {
      host = makeHost((state) => {
        state.behaviour.stopOutcome = outcome;
      });
      const run = host.run(UPDATE);
      expect(run.status).toBe(1);
      expect(run.ops).toEqual(["hub sync browser snapshot"]);
      expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "planned" });
      expect(host.update().HELD_WHY).toContain("the browser's stop is not confirmed");
      expect(containerOf(host)).toMatchObject({ image: FROM, running: true });
      expect(profile(host).restores ?? 0).toBe(0);
    });
  }

  it("a stop held for the owner, then confirmed: resume takes the page on from it", () => {
    host = makeHost((state) => {
      state.behaviour.stopOutcome = "pending";
    });
    expect(host.run([...UPDATE, "--window", "0"]).status).toBe(1);
    host.edit((state) => {
      state.commands!.at(-1)!.outcome = "ok";
      state.containers[`page-browser-${PAGE}`]!.chrome = "down";
      delete state.behaviour.stopOutcome;
    });
    const run = host.run(["resume", "--page", PAGE]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.ops).toEqual(OUT_TO_IN.slice(1));
  });

  it("the operator refuses the stop: the browser started again, the page as it was", () => {
    host = makeHost((state) => {
      state.behaviour.stopOutcome = "failed";
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub sync browser snapshot", "hub sync browser start"]);
    asItWas(host);
    expect(hubPage(host)).toMatchObject({ ownerStop: false, paused: false });
  });

  it("Chrome still runs after the confirmed stop: never stopped by the update, the browser started again", () => {
    host = makeHost((state) => {
      state.behaviour.chromeUpAfterStop = true;
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub sync browser snapshot", "hub sync browser start"]);
    expect(host.update().REASON).toContain("the update never stops a working page");
    asItWas(host);
  });

  it("Chrome runs on a page no engine hands over (--engine none): nothing is touched", () => {
    host = makeHost((state) => {
      state.hub.pages = {};
    });
    const run = host.run([...UPDATE, "--engine", "none"]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual([]);
    expect(containerOf(host)).toMatchObject({ image: FROM, running: true, chrome: "up" });
    expect(host.update().STEP).toBe("aborted");
  });

  it("the snapshot fails: the old container back, the browser started again, nothing restored", () => {
    host = makeHost((state) => {
      state.behaviour.snapshotFails = true;
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub sync browser snapshot", "docker stop", "profile snapshot", `page.sh up ${FROM}`, "hub sync browser start"]);
    expect(host.snapshots()).toEqual([]);
    asItWas(host);
  });

  it("the Hub refuses the stop, nothing recorded: nothing else happens — no start of a browser nobody stopped", () => {
    host = makeHost((state) => {
      state.behaviour.cliFails = ["snapshot"];
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub sync browser snapshot"]);
    expect(containerOf(host)).toMatchObject({ image: FROM, running: true });
    expect(host.update().STEP).toBe("aborted");
  });
});

describe("--detach: a transient unit of its own", () => {
  it("the same command without --detach, with this run's PB_* settings; nothing done here", () => {
    host = makeHost();
    const run = host.run([...UPDATE, "--detach"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.ops).toEqual([]);
    const [call] = run.calls.filter((entry) => entry.tool === "systemd-run");
    expect(call!.args.slice(0, 5)).toEqual(["--unit", call!.args[1], "--collect", "--quiet", "--property=TimeoutStartSec=infinity"]);
    expect(call!.args[1]).toMatch(/^page-browser-update-lilly-1-\d{8}T\d{6}$/);
    expect(call!.args).toContain(`--setenv=PB_BASE=${host.pbBase}`);
    expect(call!.args.slice(-6)).toEqual(["update", "--page", PAGE, "--image", TO, "--any-hour"]);
    expect(run.stderr).toContain(`follow it with journalctl -fu ${call!.args[1]}`);
    expect(host.update()).toEqual({});
  });
});

