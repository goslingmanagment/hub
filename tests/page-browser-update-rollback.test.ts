import { writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FROM, FROM_CHROME, makeHost, PAGE, PROFILE, TO, TO_CHROME, type Host } from "./helpers/page-browser-update.ts";

// Each test runs the script in bash against a fake server that starts a
// process per call: slower than a unit test, more so under a full parallel run.
vi.setConfig({ testTimeout: 180_000 });

// scripts/page-browser-update.sh — its rollbacks and its resumes (Project
// Browser PR 18; plan §4.10, spec §10): a failure after the new image ran
// puts the page back on its previous image WITH its profile's snapshot —
// never the old Chrome on a profile the new one wrote; a crash at any step
// is resumed from that step. The script runs for real in bash against a
// fake server (tests/helpers/page-browser-update-fake.mjs); the forward
// path and the refusals: page-browser-update.test.ts.

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

/** `sync check live-hour`'s report of an hour with a failed check, as the CLI
 *  prints it (the window's contract: page-browser-update-window.test.ts). */
const FAILED_HOUR = {
  windowComplete: true,
  pages: [{
    page: PAGE,
    verdict: "fail",
    reasons: ["unconfirmed_over_15m"],
    checks: [
      { name: "window_complete", verdict: "pass", detail: {} },
      { name: "unconfirmed_over_15m", verdict: "fail", detail: { messages: 1, withoutThread: 0 } },
    ],
  }],
  accepted: false,
};

describe("failures after the new image ran: a rollback — its previous image WITH its snapshot", () => {
  const rolledBack = (h: Host) => {
    expect(containerOf(h)).toMatchObject({ image: FROM, running: true });
    expect(h.pageEnv()).toContain(`PB_IMAGE=${FROM}\n`);
    // The profile from before: the new Chrome's writes are gone.
    expect(profile(h)).toMatchObject({ version: FROM_CHROME, marker: "before", restores: 1 });
    expect(hubPage(h)).toMatchObject({ transport: "browser", leave: null });
    expect(h.update()).toMatchObject({ STEP: "rolled_back", RB_CHECKS: "passed" });
    expect(events(h)).toEqual(expect.arrayContaining(["restored", "rolled_back"]));
  };
  const ROLLBACK = ["docker stop", "profile restore", `page.sh up ${FROM}`, "profile-check", "hub sync browser start"];
  const RB_STOP = "hub sync browser snapshot";

  it("page.sh cannot bring the new image up", () => {
    host = makeHost((state) => {
      state.behaviour.upFails = [TO];
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    // Still out from the update's own stop: no second one.
    expect(run.ops).toEqual(["hub sync browser snapshot", "docker stop", "profile snapshot", `page.sh up ${TO}`, ...ROLLBACK]);
    rolledBack(host);
  });

  it("the new Chrome fails the profile check (it opened the profile)", () => {
    host = makeHost((state) => {
      state.behaviour.profileCheckFails = [TO];
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub sync browser snapshot", "docker stop", "profile snapshot", `page.sh up ${TO}`, "profile-check", ...ROLLBACK]);
    expect(host.update().REASON).toBe(`host check on ${TO}: profile check failed: extension_installed_by_policy rules_enabled`);
    rolledBack(host);
  });

  // A stop that waiting does not cure fails at once, not at the deadline.
  for (const [why, outcome, reason] of [
    ["a new login: another session fingerprint", "fingerprint", "ready, but: another session (a new login): the session did not survive"],
    ["the engine never reports it ready", "never", "not ready within 2 s (last: no state of the operator since the page was given back)"],
    ["the self-test failed", "selftest_failed", "stopped: selftest_failed"],
  ] as const) {
    it(`engine check: ${why} — the browser stopped again by the lever, then the rollback`, () => {
      host = makeHost((state) => {
        state.behaviour.engine = { [TO_CHROME]: outcome };
      });
      const run = host.run(UPDATE);
      expect(run.status).toBe(1);
      expect(run.ops).toEqual([...OUT_TO_IN, RB_STOP, ...ROLLBACK]);
      expect(host.update().REASON).toBe(`engine checks on Chrome ${TO_CHROME}: ${reason}`);
      expect(events(host)).toContain("update_failed");
      rolledBack(host);
    });
  }

  it("the window: the page stops being ready", () => {
    host = makeHost((state) => {
      state.behaviour.failAfterReadyReads = 2;
    });
    const run = host.run([...UPDATE, "--window", "4s"]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual([...OUT_TO_IN, RB_STOP, ...ROLLBACK]);
    expect(host.update().REASON).toContain("during the window: stopped: chrome_crashed");
    rolledBack(host);
  });

  it("the window: sync check live-hour does not accept it", () => {
    host = makeHost((state) => {
      state.behaviour.liveHourExit = 1;
      state.behaviour.liveHourReport = FAILED_HOUR;
    });
    const run = host.run([...UPDATE, "--window", "2s"]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual([...OUT_TO_IN, "hub sync check live-hour", RB_STOP, ...ROLLBACK]);
    expect(host.update().REASON).toContain(`sync check live-hour over the window: exit 1 (${PAGE} fail: unconfirmed_over_15m)`);
    rolledBack(host);
  });

  it("the new image's operator does not confirm the rollback's stop: nothing forced — the page is never killed, the rollback holds for the owner", () => {
    host = makeHost((state) => {
      state.behaviour.engine = { [TO_CHROME]: "selftest_failed" };
      state.behaviour.stopOutcomeOn = { [TO]: "unknown" };
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual([...OUT_TO_IN, RB_STOP]);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "rolling_back" });
    expect(host.update().HELD_WHY).toContain("a page is never killed");
    expect(containerOf(host)).toMatchObject({ image: TO, running: true });
    expect(profile(host).restores ?? 0).toBe(0);
    // Its operator answers after all: resume rolls it back.
    host.edit((state) => {
      delete state.behaviour.stopOutcomeOn;
    });
    const resumed = host.run(["resume", "--page", PAGE]);
    expect(resumed.ops).toEqual([RB_STOP, ...ROLLBACK]);
    rolledBack(host);
  });

  it("a halt the new browser holds for the owner's decision (Fansly signed it out): the update holds — it neither rolls back on it nor clears it", () => {
    host = makeHost((state) => {
      state.behaviour.engine = { [TO_CHROME]: "login_required" };
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(OUT_TO_IN);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "given_back" });
    expect(host.update().HELD_WHY).toContain("stands for the owner's decision (login_required");
    expect(profile(host).restores ?? 0).toBe(0);
    // The owner rolls back: the previous image with its snapshot — and the
    // start that follows still clears no halt: it holds again for his start.
    const back = host.run(["rollback", "--page", PAGE]);
    expect(back.status).toBe(1);
    expect(back.ops).toEqual([RB_STOP, "docker stop", "profile restore", `page.sh up ${FROM}`, "profile-check"]);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "rolling_back", RB_STEP: "host_checked" });
    expect(host.update().HELD_WHY).toContain("rollback: the browser is not started on its previous image: its browser stands for the owner's decision (login_required");
    expect((host.state().commands ?? []).filter((row) => row.kind === "restartBrowser").map((row) => row.haltId)).toEqual([null]);
    expect(profile(host)).toMatchObject({ version: FROM_CHROME, marker: "before" });
  });

  describe("an update that changed no Chrome (another revision of the image): its rollback restores no snapshot", () => {
    const SAME = "hub-page-browser:155.0.8059.39-1-cccccccccccc";
    const sameChrome = () => makeHost((state) => {
      state.images[SAME] = { chrome: "155.0.8059.39-1", revision: "cccccccccccc", created: "2026-10-17T00:00:00Z" };
    });
    const OUT_TO_SAME = ["hub sync browser snapshot", "docker stop", "profile snapshot", `page.sh up ${SAME}`, "profile-check", "hub sync browser start"];

    it("the window fails: back on the previous image, the profile as the page left it — an hour of its session kept (lilly-1, 2026-10-17 19:47)", () => {
      host = sameChrome();
      host.edit((state) => {
        state.behaviour.liveHourExit = 1;
        state.behaviour.liveHourReport = FAILED_HOUR;
      });
      const run = host.run(["update", "--page", PAGE, "--image", SAME, "--any-hour", "--window", "2s"]);
      expect(run.status).toBe(1);
      expect(run.ops).toEqual([...OUT_TO_SAME, "hub sync check live-hour", RB_STOP, "docker stop", `page.sh up ${FROM}`, "profile-check", "hub sync browser start"]);
      expect(containerOf(host)).toMatchObject({ image: FROM, running: true });
      expect(profile(host).restores ?? 0).toBe(0);
      expect(host.update()).toMatchObject({ STEP: "rolled_back", RB_CHECKS: "passed", RB_RESTORED: "none" });
      expect(host.journal().find((line) => line.event === "restored")?.detail).toContain(`no snapshot restored: Chrome ${FROM_CHROME} on both images`);
      expect(host.journal().find((line) => line.event === "rolled_back")?.detail).toContain("with its profile as the page left it");
    });

    it("the owner's rollback needs no snapshot then: a lost one refuses nothing", () => {
      host = sameChrome();
      expect(host.run(["update", "--page", PAGE, "--image", SAME, "--any-hour", "--window", "0"]).status).toBe(0);
      const dir = path.join(host.pbBase, "snapshots", PROFILE);
      writeFileSync(path.join(dir, host.snapshots()[0]!), "not the snapshot");
      const run = host.run(["rollback", "--page", PAGE]);
      expect(run.status, run.stderr).toBe(1);
      expect(run.ops).toEqual([RB_STOP, "docker stop", `page.sh up ${FROM}`, "profile-check", "hub sync browser start"]);
      expect(host.update()).toMatchObject({ STEP: "rolled_back", RB_CHECKS: "passed", RB_RESTORED: "none" });
      expect(containerOf(host)).toMatchObject({ image: FROM, running: true });
    });
  });

  it("a lost snapshot: the owner's rollback is refused before anything changes — the old Chrome never opens a profile the new one wrote", () => {
    host = makeHost();
    expect(host.run([...UPDATE, "--window", "0"]).status).toBe(0);
    const dir = path.join(host.pbBase, "snapshots", PROFILE);
    writeFileSync(path.join(dir, host.snapshots()[0]!), "not the snapshot");
    const run = host.run(["rollback", "--page", PAGE]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("does not match its SHA-256");
    expect(run.ops).toEqual([]);
    expect(host.update().STEP).toBe("done");
    expect(containerOf(host)).toMatchObject({ image: TO, running: true });
    expect(hubPage(host).transport).toBe("browser");
  });

  it("a snapshot lost during an update: its rollback stops before any step, the page left out for the owner", () => {
    host = makeHost();
    host.run([...UPDATE, "--window", "0"], { crashOn: "profile-check" });
    const dir = path.join(host.pbBase, "snapshots", PROFILE);
    writeFileSync(path.join(dir, host.snapshots()[0]!), "not the snapshot");
    host.edit((state) => {
      state.behaviour.profileCheckFails = [TO];
    });
    const run = host.run(["resume", "--page", PAGE]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["profile-check"]);
    expect(host.update().STEP).toBe("rollback_failed");
    expect(host.update().RB_STEP ?? "").toBe("");
    expect(host.update().RB_FAILED).toContain("does not match its SHA-256");
    expect(profile(host).version).toBe(TO_CHROME);
  });

  it("a rollback target whose operator the engine refuses (protocol 1.0): refused before anything changes", () => {
    host = makeHost();
    expect(host.run([...UPDATE, "--window", "0"]).status).toBe(0);
    host.edit((state) => {
      state.images[FROM]!.protocolLabel = "1.0";
    });
    const run = host.run(["rollback", "--page", PAGE]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`${FROM}'s operator speaks protocol 1.0: the engine works with 1.1 or later of major 1: the engine would refuse the page on it`);
    expect(run.ops).toEqual([]);
    expect(host.update().STEP).toBe("done");
    expect(containerOf(host)).toMatchObject({ image: TO, running: true });
  });

  it("the owner's rollback after a done update: out, snapshot, previous image, back", () => {
    host = makeHost();
    expect(host.run([...UPDATE, "--window", "0"]).status).toBe(0);
    const run = host.run(["rollback", "--page", PAGE, "--reason", "the owner saw 429s"]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual([RB_STOP, ...ROLLBACK]);
    expect(host.update().REASON).toBe("the owner saw 429s");
    rolledBack(host);
  });

  it("the owner stops the browser during the checks: the update holds for him, then rolls back on his word", () => {
    host = makeHost((state) => {
      state.behaviour.engine = { [TO_CHROME]: "owner_stop" };
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(OUT_TO_IN);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "given_back" });
    expect(events(host)).toContain("update_held");
    // Resumed while the owner's stop holds: it holds again.
    const resumed = host.run(["resume", "--page", PAGE]);
    expect(resumed.status).toBe(1);
    expect(resumed.ops).toEqual([]);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "given_back" });
    expect(events(host).filter((event) => event === "update_held")).toHaveLength(2);
    const back = host.run(["rollback", "--page", PAGE]);
    expect(back.ops).toEqual([RB_STOP, ...ROLLBACK]);
    rolledBack(host);
  });
});

describe("a crash at any step: `resume` goes on from there", () => {
  const steps: Array<[string, string[]]> = [
    ["hub sync browser snapshot", ["docker stop", "profile snapshot", `page.sh up ${TO}`, "profile-check", "hub sync browser start"]],
    ["docker stop", ["profile snapshot", `page.sh up ${TO}`, "profile-check", "hub sync browser start"]],
    ["profile snapshot", ["profile snapshot", `page.sh up ${TO}`, "profile-check", "hub sync browser start"]],
    [`page.sh up ${TO}`, [`page.sh up ${TO}`, "profile-check", "hub sync browser start"]],
    ["profile-check", ["profile-check", "hub sync browser start"]],
    ["hub sync browser start", []],
    ["hub sync check live-hour", ["hub sync check live-hour"]],
  ];
  for (const [crashOn, after] of steps) {
    it(`killed right after "${crashOn}"`, () => {
      host = makeHost();
      const crashed = host.run([...UPDATE, "--window", "1s"], { crashOn });
      expect(crashed.status).toBe(137);
      expect(host.update().STEP).not.toBe("done");
      const resumed = host.run(["resume", "--page", PAGE]);
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(resumed.ops.filter((entry) => entry !== "hub sync check live-hour" || crashOn === "hub sync check live-hour")).toEqual(after);
      expect(host.update()).toMatchObject({ STEP: "done", ENGINE_CHECKS: "passed", WINDOW: "passed" });
      expect(containerOf(host)).toMatchObject({ image: TO, running: true });
      expect(hubPage(host)).toMatchObject({ transport: "browser", ownerStop: false });
      // One snapshot, whole: a cut-off one is never kept.
      expect(host.snapshots()).toHaveLength(2);
      expect(host.snapshots().filter((name) => name.endsWith(".part"))).toEqual([]);
      expect(profile(host).restores ?? 0).toBe(0);
    });
  }

  it("killed in the middle of a rollback (right after the restore): resume finishes the rollback", () => {
    host = makeHost((state) => {
      state.behaviour.profileCheckFails = [TO];
    });
    const crashed = host.run(UPDATE, { crashOn: "profile restore" });
    expect(crashed.status).toBe(137);
    expect(host.update()).toMatchObject({ STEP: "rolling_back", RB_STEP: "stopped" });
    const resumed = host.run(["resume", "--page", PAGE]);
    expect(resumed.status).toBe(1);
    expect(resumed.ops).toEqual(["profile restore", `page.sh up ${FROM}`, "profile-check", "hub sync browser start"]);
    expect(host.update()).toMatchObject({ STEP: "rolled_back", RB_CHECKS: "passed" });
    expect(containerOf(host)).toMatchObject({ image: FROM, running: true });
    expect(profile(host)).toMatchObject({ version: FROM_CHROME, marker: "before" });
  });

  it("an unfinished update is resumed by `update` to the same image, refused to another", () => {
    host = makeHost();
    host.run([...UPDATE, "--window", "0"], { crashOn: "docker stop" });
    host.edit((state) => {
      state.images["hub-page-browser:156.0.8078.12-1-cccccccccccc"] = { chrome: "156.0.8078.12-1", revision: "cccccccccccc" };
    });
    const other = host.run(["update", "--page", PAGE, "--image", "hub-page-browser:156.0.8078.12-1-cccccccccccc", "--any-hour"]);
    expect(other.status).toBe(2);
    expect(other.stderr).toContain("is unfinished (step taken_out): resume or rollback it first");
    const same = host.run([...UPDATE, "--window", "0"]);
    expect(same.status, same.stderr).toBe(0);
    // Its container was stopped before the crash: the snapshot is next.
    expect(same.ops[0]).toBe("profile snapshot");
  });
});
