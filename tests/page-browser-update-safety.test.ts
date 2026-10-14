import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FROM, FROM_CHROME, makeHost, PAGE, PROFILE, TO, TO_CHROME, type Host } from "./helpers/page-browser-update.ts";

// scripts/page-browser-update.sh — Astra's review of PR 18, each scenario
// reproduced: what cannot be read is unknown and never "stopped" or
// "nobody"; a snapshot is restored only into the profile that is still the
// page's, under page.sh's lock; the page's way back (its last update's
// snapshot) outlives ordinary snapshots; a standalone snapshot is an
// operation with a record written before the container stops; what the
// Hub cannot tell holds the update for the owner instead of judging blind.

let host: Host | undefined;
afterEach(() => {
  host?.cleanup();
  host = undefined;
});

const UPDATE = ["update", "--page", PAGE, "--image", TO, "--any-hour"];
const OTHER = "ari-1";
const OTHER_PROFILE = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const containerOf = (h: Host, page = PAGE) => h.state().containers[`page-browser-${page}`];
const profile = (h: Host, id = PROFILE) => h.state().profiles[id]!;
const events = (h: Host) => h.journal().map((line) => line.event);
const snapshotState = (h: Host) => {
  const file = path.join(h.pbBase, "update/pages", PAGE, "snapshot");
  return Object.fromEntries(readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
};
/** A page on Node: its Chrome stands, nothing of the Hub's is in the way. */
const onNode = (state: Parameters<NonNullable<Parameters<typeof makeHost>[0]>>[0]) => {
  state.hub.pages[PAGE]!.transport = "node";
  state.containers[`page-browser-${PAGE}`]!.chrome = "down";
};

describe("2 · what Docker cannot say is unknown, never stopped", () => {
  it("a snapshot when the container cannot be read once: refused — no Chrome check skipped, nothing packed under a running Chrome", () => {
    host = makeHost((state) => {
      state.behaviour.inspectFails = 1;
    });
    const run = host.run(["snapshot", "--page", PAGE]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`page-browser-${PAGE} cannot be read`);
    expect(run.ops).toEqual([]);
    expect(host.snapshots()).toEqual([]);
    expect(containerOf(host)).toMatchObject({ running: true, chrome: "up" });
  });

  it("an update whose plan cannot read the container: refused, nothing changed", () => {
    host = makeHost((state) => {
      state.behaviour.inspectFails = 1;
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(2);
    expect(run.ops).toEqual([]);
  });

  it("an update whose image's commit cannot be read: refused — the operator's check is never dropped unseen", () => {
    host = makeHost((state) => {
      state.behaviour.revisionUnreadableOn = [TO];
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`${TO} cannot be read`);
    expect(run.ops).toEqual([]);
  });

  it("an update whose snapshot cannot see who mounts the profile: no snapshot, the page as it was", () => {
    host = makeHost((state) => {
      onNode(state);
      state.behaviour.psFails = true;
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["docker stop", `page.sh up ${FROM}`]);
    expect(host.update()).toMatchObject({ STEP: "aborted" });
    expect(host.update().REASON).toContain(`the containers of pb-profile-${PROFILE} cannot be listed`);
    expect(host.snapshots()).toEqual([]);
  });

  it("a rollback that cannot read the container after the stop: no restore under a container it cannot see", () => {
    host = makeHost((state) => {
      state.behaviour.profileCheckFails = [TO];
    });
    host.run(UPDATE, { crashOn: "profile-check" });
    host.edit((state) => {
      state.behaviour.inspectFails = 1000;
    });
    const run = host.run(["resume", "--page", PAGE]);
    expect(run.status).toBe(1);
    expect(run.ops).not.toContain("profile restore");
    expect(host.update()).toMatchObject({ STEP: "rollback_failed", RB_STEP: "taken_out" });
    expect(host.update().RB_FAILED).toContain(`page-browser-${PAGE} cannot be read`);
    expect(profile(host).restores ?? 0).toBe(0);
    expect(containerOf(host)).toMatchObject({ image: TO, running: true });
  });
});

describe("3 · a snapshot is restored only into the profile that is still the page's", () => {
  /** After the update, the page got a new profile, and its old one went to another page that runs. */
  const reassign = (h: Host) => {
    h.edit((state) => {
      state.profiles[OTHER_PROFILE] = { version: TO_CHROME, marker: "lilly's new one" };
      state.containers[`page-browser-${OTHER}`] = { image: TO, running: true, health: "healthy", chrome: "up", profile: PROFILE };
      state.containers[`page-browser-${PAGE}`]!.profile = OTHER_PROFILE;
      state.profiles[PROFILE]!.marker = "ari's now";
    });
    writeFileSync(path.join(h.pbBase, "pages", PAGE, "page.env"), h.pageEnv().replace(`PB_PROFILE_ID=${PROFILE}`, `PB_PROFILE_ID=${OTHER_PROFILE}`));
    mkdirSync(path.join(h.pbBase, "pages", OTHER), { recursive: true });
    writeFileSync(path.join(h.pbBase, "pages", OTHER, "page.env"), `PB_PAGE=${OTHER}\nPB_IMAGE=${TO}\nPB_PROFILE_ID=${PROFILE}\n`);
  };

  it("the old profile now another running page's: the rollback is refused before anything changes", () => {
    host = makeHost();
    expect(host.run([...UPDATE, "--window", "0"]).status).toBe(0);
    reassign(host);
    const run = host.run(["rollback", "--page", PAGE]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`${PAGE}'s profile is now '${OTHER_PROFILE}', not ${PROFILE}`);
    expect(run.ops).toEqual([]);
    expect(profile(host)).toMatchObject({ marker: "ari's now" });
    expect(profile(host).restores ?? 0).toBe(0);
    expect(containerOf(host, OTHER)).toMatchObject({ running: true });
  });

  it("the page's profile mounted by a container that is not the page's: refused", () => {
    host = makeHost();
    expect(host.run([...UPDATE, "--window", "0"]).status).toBe(0);
    host.edit((state) => {
      state.containers["pb-copy-of-lilly"] = { image: TO, running: false, profile: PROFILE };
    });
    const run = host.run(["rollback", "--page", PAGE]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`pb-profile-${PROFILE} is mounted by pb-copy-of-lilly exited`);
    expect(run.ops).toEqual([]);
  });

  it("the profile changed hands while an update was cut off: resume's rollback stops before any step, the other page's profile untouched", () => {
    host = makeHost((state) => {
      state.behaviour.profileCheckFails = [TO];
    });
    host.run(UPDATE, { crashOn: "profile-check" });
    reassign(host);
    const run = host.run(["resume", "--page", PAGE]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["profile-check"]);
    expect(host.update().STEP).toBe("rollback_failed");
    expect(host.update().RB_FAILED).toContain(`profile is now '${OTHER_PROFILE}'`);
    expect(profile(host)).toMatchObject({ marker: "ari's now" });
    expect(profile(host).restores ?? 0).toBe(0);
  });
});

describe("3 · … checked again at the restore itself, under page.sh's lock", () => {
  it("a rollback cut off after its stop, the profile given to another page meanwhile: resume restores nothing into it", () => {
    host = makeHost((state) => {
      state.behaviour.profileCheckFails = [TO];
    });
    const crashed = host.run(UPDATE, { crashOn: "docker stop#2" });
    expect(crashed.status).toBe(137);
    expect(host.update()).toMatchObject({ STEP: "rolling_back", RB_STEP: "taken_out" });
    host.edit((state) => {
      state.containers[`page-browser-${OTHER}`] = { image: TO, running: false, profile: PROFILE };
      state.profiles[PROFILE]!.marker = "ari's now";
    });
    const run = host.run(["resume", "--page", PAGE]);
    expect(run.status).toBe(1);
    expect(run.ops).not.toContain("profile restore");
    expect(host.update()).toMatchObject({ STEP: "rollback_failed", RB_STEP: "stopped" });
    expect(host.update().RB_FAILED).toContain(`no restore: pb-profile-${PROFILE} is mounted by page-browser-${OTHER} exited`);
    expect(profile(host)).toMatchObject({ marker: "ari's now" });
  });
});

describe("4 · the page's way back outlives ordinary snapshots", () => {
  it("three snapshots after the update: the update's snapshot is kept, and the rollback restores it", () => {
    host = makeHost(onNode);
    expect(host.run([...UPDATE, "--window", "0"]).status).toBe(0);
    const [wayBack] = host.snapshots();
    for (let i = 0; i < 3; i++) {
      const run = host.run(["snapshot", "--page", PAGE]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.ops).toEqual(["docker stop", "profile snapshot", `page.sh up ${TO}`]);
    }
    expect(host.snapshots()).toContain(wayBack);
    expect(host.snapshots().filter((name) => name.endsWith(".meta"))).toHaveLength(4);
    const run = host.run(["rollback", "--page", PAGE]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["docker stop", "profile restore", `page.sh up ${FROM}`, "profile-check"]);
    expect(host.update().STEP).toBe("rolled_back");
    expect(profile(host)).toMatchObject({ version: FROM_CHROME, marker: "before" });
  });
});

describe("6 · a standalone snapshot is an operation with its record", () => {
  it("killed after the container stopped: the record says so, the timer reports it, resume finishes it and starts the container again", () => {
    host = makeHost(onNode);
    const crashed = host.run(["snapshot", "--page", PAGE], { crashOn: "docker stop" });
    expect(crashed.status).toBe(137);
    expect(containerOf(host)).toMatchObject({ running: false });
    expect(snapshotState(host)).toMatchObject({ STEP: "planned", WAS_RUNNING: "1", IMAGE: FROM });
    expect(host.run(["status", "--page", PAGE]).stdout).toContain("snapshot:\n  RUN=manual-");
    // The update and the rollback wait for it.
    expect(host.run(UPDATE).stderr).toContain(`a snapshot of ${PAGE} is unfinished`);
    host.run(["check", "--no-build"], { env: { PB_CHROME_REPO: "https://nowhere.example.test" } });
    expect(host.journal().find((line) => line.event === "update_stuck")?.detail).toContain(`its snapshot stopped at step planned, its container perhaps stopped: page-browser-update.sh resume --page ${PAGE}`);
    const resumed = host.run(["resume", "--page", PAGE]);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.ops).toEqual(["profile snapshot", `page.sh up ${FROM}`]);
    expect(snapshotState(host)).toMatchObject({ STEP: "done" });
    expect(containerOf(host)).toMatchObject({ image: FROM, running: true });
    expect(host.snapshots().filter((name) => name.endsWith(".meta"))).toHaveLength(1);
  });

  it("Astra's round 2: killed after the stop, then Docker cannot answer once during resume — the operation stays resumable, reported every pass, and ends only with the container back", () => {
    host = makeHost(onNode);
    expect(host.run(["snapshot", "--page", PAGE], { crashOn: "docker stop" }).status).toBe(137);
    host.edit((state) => {
      state.behaviour.inspectFails = 1;
    });
    const blind = host.run(["resume", "--page", PAGE]);
    expect(blind.status).toBe(1);
    expect(blind.ops).toEqual([]);
    expect(snapshotState(host).STEP).toBe("planned");
    expect(containerOf(host)).toMatchObject({ running: false });
    // Reported by the timer, pass after pass.
    for (let pass = 0; pass < 2; pass++) {
      host.run(["check", "--no-build"], { env: { PB_CHROME_REPO: "https://nowhere.example.test" } });
    }
    expect(host.journal().filter((line) => line.event === "update_stuck" && line.detail.includes("its snapshot stopped at step planned"))).toHaveLength(2);
    // Docker answers again: resume ends it with the container back.
    const resumed = host.run(["resume", "--page", PAGE]);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.ops).toEqual(["profile snapshot", `page.sh up ${FROM}`]);
    expect(snapshotState(host).STEP).toBe("done");
    expect(containerOf(host)).toMatchObject({ image: FROM, running: true });
  });

  it("Chrome's state cannot be read before the stop: nothing stopped, nothing ended", () => {
    host = makeHost((state) => {
      onNode(state);
      state.containers[`page-browser-${PAGE}`]!.chrome = "unknown";
    });
    const run = host.run(["snapshot", "--page", PAGE]);
    expect(run.status).toBe(2);
    expect(run.ops).toEqual([]);
  });

  it("refused while Chrome runs: nothing stopped, the record says why", () => {
    host = makeHost();
    const run = host.run(["snapshot", "--page", PAGE]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Chrome is not down");
    expect(run.ops).toEqual([]);
  });
});

describe("what the Hub cannot tell holds the update for the owner", () => {
  it("a rollback whose old image's start the Hub cannot tell: held at that step, not ended — resumed, it ends on the engine's word", () => {
    host = makeHost((state) => {
      state.behaviour.profileCheckFails = [TO];
    });
    expect(host.run(UPDATE, { crashOn: "hub transport browser" }).status).toBe(137);
    expect(host.update()).toMatchObject({ STEP: "rolling_back", RB_STEP: "host_checked" });
    // The Hub down: the page is not given back blind.
    host.edit((state) => {
      state.behaviour.hubDown = true;
    });
    expect(host.run(["resume", "--page", PAGE]).status).toBe(1);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "rolling_back", RB_STEP: "host_checked" });
    expect(host.update().HELD_WHY).toContain("rollback: the Hub cannot be read: the page is not given back blind");
    // Given back, then the Hub stops answering: the old image's start unknown.
    host.edit((state) => {
      state.behaviour.hubDown = false;
      state.behaviour.sqlFailAfter = 1;
      (state as { sqlReads?: number }).sqlReads = 0;
    });
    const blind = host.run(["resume", "--page", PAGE]);
    expect(blind.status).toBe(1);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "rolling_back", RB_STEP: "given_back" });
    expect(host.update().HELD_WHY).toContain("rollback: the Hub cannot be read");
    expect(host.update().RB_CHECKS).toBeUndefined();
    host.edit((state) => {
      delete state.behaviour.sqlFailAfter;
    });
    const resumed = host.run(["resume", "--page", PAGE]);
    expect(resumed.status).toBe(1);
    expect(resumed.ops).toEqual([]);
    expect(host.update()).toMatchObject({ STEP: "rolled_back", RB_CHECKS: "passed" });
  });

  it("the Hub stops answering during the engine checks: held, not rolled back blind", () => {
    host = makeHost((state) => {
      state.behaviour.engine = { [TO_CHROME]: "never" };
      state.behaviour.sqlFailAfter = 4;
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub transport node", "docker stop", "profile snapshot", `page.sh up ${TO}`, "profile-check", "hub transport browser"]);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "given_back" });
    expect(host.update().HELD_WHY).toContain("the Hub cannot be read");
    expect(events(host)).not.toContain("rolled_back");
  });

  it("the Hub stops answering during the take-out: held, the container untouched", () => {
    host = makeHost((state) => {
      state.behaviour.leaveNever = true;
      state.behaviour.sqlFailAfter = 2;
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub transport node"]);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "planned" });
    expect(containerOf(host)).toMatchObject({ image: FROM, running: true });
  });
});
