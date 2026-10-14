import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { FINGERPRINT, FROM, FROM_CHROME, makeHost, PAGE, PROFILE, TO, TO_CHROME, type Host } from "./helpers/page-browser-update.ts";

// scripts/page-browser-update.sh — one page onto a new Chrome (Project
// Browser PR 18; plan §4.10, spec §10). The page is taken out by the
// engine's own hand-over, its profile snapshotted before the new Chrome
// first opens it, checked on the host and by the engine, watched; any
// failure leaves it on its previous image WITH its profile from before. The
// script runs for real in bash against a fake server
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
const OUT_TO_IN = ["hub transport node", "docker stop", "profile snapshot", `page.sh up ${TO}`, "profile-check", "hub transport browser"];

describe("page-browser-update.sh update: one page onto a new Chrome", () => {
  it("a page on its browser: out through the engine's hand-over, its snapshot, the new image, host checks, back, engine checks, the window — in that order", () => {
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
    // Back on its browser, ready on the new Chrome; the update done.
    expect(hubPage(host)).toMatchObject({ transport: "browser", leave: null });
    expect(host.update()).toMatchObject({ STEP: "done", ENGINE_CHECKS: "passed", WINDOW: "passed", FROM_CHROME, TO_CHROME, TRANSPORT_BEFORE: "browser", FINGERPRINT_BEFORE: FINGERPRINT });
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
      expect(call.stdin).toMatch(/^-- pb-update:page lilly-1\nBEGIN READ ONLY;\nSELECT /);
      expect(call.stdin!.split("\n").slice(1).join("\n")).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
    }
    const levers = run.calls.filter((call) => call.tool === "docker" && call.args.includes("api"));
    expect(levers).toHaveLength(2);
    for (const call of levers) {
      expect(call.args.slice(0, 5)).toEqual(["compose", "--env-file", ".env.production", "-f", "docker-compose.production.yml"]);
      const note = call.args[call.args.indexOf("--note") + 1];
      expect(note).toContain(`page-browser-update ${runId}: Chrome ${FROM_CHROME} -> ${TO_CHROME}`);
    }
  });

  it("a page on Node: no lever of the Hub, Chrome must stand; the engine has nothing of it to check", () => {
    host = makeHost((state) => {
      state.hub.pages[PAGE]!.transport = "node";
      state.containers[`page-browser-${PAGE}`]!.chrome = "down";
    });
    const run = host.run(UPDATE);
    expect(run.status, run.stderr).toBe(0);
    expect(run.ops).toEqual(["docker stop", "profile snapshot", `page.sh up ${TO}`, "profile-check"]);
    expect(host.update()).toMatchObject({ STEP: "done", ENGINE_CHECKS: "skipped", WINDOW: "none", TRANSPORT_BEFORE: "node" });
    expect(hubPage(host).transport).toBe("node");
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

  it("a page with no Node session stored: its browser cannot leave without PR 17's stop", () => {
    host = makeHost((state) => {
      state.hub.pages[PAGE]!.credentials = false;
    });
    refused(host, UPDATE, /no Node session stored: .*sync browser stop.*PR 17/);
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

  it("the operator does not confirm the leave in time: the page goes back to its browser, its container untouched", () => {
    host = makeHost((state) => {
      state.behaviour.leaveNever = true;
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub transport node", "hub transport browser"]);
    expect(host.update().REASON).toContain("the leave was not confirmed within 2 s");
    asItWas(host);
    expect(containerOf(host)!.chrome).toBe("up");
  });

  it("Chrome still runs after the confirmed leave: never stopped by the update", () => {
    host = makeHost((state) => {
      state.behaviour.chromeUpAfterLeave = true;
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub transport node", "hub transport browser"]);
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

  it("the snapshot fails: the old container back, the page back to its browser, nothing restored", () => {
    host = makeHost((state) => {
      state.behaviour.snapshotFails = true;
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub transport node", "docker stop", "profile snapshot", `page.sh up ${FROM}`, "hub transport browser"]);
    expect(host.snapshots()).toEqual([]);
    asItWas(host);
  });

  it("the Hub refuses the take-out: nothing else happens", () => {
    host = makeHost((state) => {
      state.behaviour.cliFails = ["node"];
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub transport node"]);
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

