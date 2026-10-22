import { afterEach, describe, expect, it, vi } from "vitest";

import { FROM, FROM_CHROME, makeHost, PAGE, PROFILE, type Host } from "./helpers/page-browser-update.ts";

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

const containerOf = (h: Host) => h.state().containers[`page-browser-${PAGE}`];
const profile = (h: Host) => h.state().profiles[PROFILE]!;

describe("failures after the new image ran: a rollback — its previous image WITH its snapshot", () => {
  const RB_STOP = "hub sync browser snapshot";

  describe("an update that changed no Chrome (another revision of the image): its rollback restores no snapshot", () => {
    const SAME = "hub-page-browser:155.0.8059.39-1-cccccccccccc";
    const sameChrome = () => makeHost((state) => {
      state.images[SAME] = { chrome: "155.0.8059.39-1", revision: "cccccccccccc", created: "2026-10-17T00:00:00Z" };
    });
    const OUT_TO_SAME = ["hub sync browser snapshot", "docker stop", "profile snapshot", `page.sh up ${SAME}`, "profile-check", "hub sync browser start"];

    it("the window fails: back on the previous image, the profile as the page left it — an hour of its session kept (lilly-1, 2026-10-17 19:47)", () => {
      host = sameChrome();
      // The window's contract: page-browser-update-window.test.ts.
      host.edit((state) => {
        state.behaviour.crashBetweenLooks = { reason: "cdp_lost" };
      });
      const run = host.run(["update", "--page", PAGE, "--image", SAME, "--any-hour", "--window", "2s"]);
      expect(run.status).toBe(1);
      expect(run.ops).toEqual([...OUT_TO_SAME, RB_STOP, "docker stop", `page.sh up ${FROM}`, "profile-check", "hub sync browser start"]);
      expect(containerOf(host)).toMatchObject({ image: FROM, running: true });
      expect(profile(host).restores ?? 0).toBe(0);
      expect(host.update()).toMatchObject({ STEP: "rolled_back", RB_CHECKS: "passed", RB_RESTORED: "none" });
      expect(host.journal().find((line) => line.event === "restored")?.detail).toContain(`no snapshot restored: Chrome ${FROM_CHROME} on both images`);
      expect(host.journal().find((line) => line.event === "rolled_back")?.detail).toContain("with its profile as the page left it");
    });
  });
});
