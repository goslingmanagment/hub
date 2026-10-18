import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FROM, FROM_CHROME, makeHost, op as opOfCall, PAGE, PROFILE, TO, TO_CHROME, UPDATE_SCRIPT, type Host } from "./helpers/page-browser-update.ts";

// Each test runs the script in bash against a fake server that starts a
// process per call: slower than a unit test, more so under a full parallel run.
vi.setConfig({ testTimeout: 180_000 });

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
    // Unknown is held, never judged: its take-out is to be done again.
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "rolling_back", RB_STEP: "" });
    expect(host.update().HELD_WHY).toContain(`page-browser-${PAGE} cannot be read`);
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

/** A page whose browser its owner stopped before the update: his stop
 *  command, answered — Chrome down, the page paused by it. */
const ownerStopped = (state: Parameters<NonNullable<Parameters<typeof makeHost>[0]>>[0]) => {
  Object.assign(state.hub.pages[PAGE]!, { ownerStop: true, paused: true, stopPaused: true });
  state.commands = [{ id: 1, page: PAGE, kind: "stopPage", note: "the owner's", outcome: "ok", expired: false, detail: "", haltId: null }];
  state.containers[`page-browser-${PAGE}`]!.chrome = "down";
};
/** The owner's `sync browser stop`, as the engine carries it out: his stop
 *  command, answered once Chrome is down. */
const ownerStops = (h: Host) =>
  h.edit((state) => {
    const page = state.hub.pages[PAGE]!;
    page.ownerStop = true;
    if (!page.paused) Object.assign(page, { paused: true, stopPaused: true });
    state.commands = [...(state.commands ?? [])];
    state.commands.push({ id: state.commands.length + 1, page: PAGE, kind: "stopPage", note: "the owner's", outcome: "ok", expired: false, detail: "", haltId: null });
    state.containers[`page-browser-${PAGE}`]!.chrome = "down";
  });
/** The owner's `sync browser start`: his decision, the browser serving again. */
const ownerStarts = (h: Host) =>
  h.edit((state) => {
    const page = state.hub.pages[PAGE]!;
    Object.assign(page, { ownerStop: false, paused: false, stopPaused: false });
    state.commands = [...(state.commands ?? [])];
    state.commands.push({ id: state.commands.length + 1, page: PAGE, kind: "restartBrowser", note: "the owner's", outcome: "ok", expired: false, detail: "", haltId: null });
    state.containers[`page-browser-${PAGE}`]!.chrome = "up";
    Object.assign(page.pb, { step: "ready", stop: "", exitOpen: true, stateAt: Date.now() });
  });
const ROLLBACK_OUT = ["docker stop", "profile restore", `page.sh up ${FROM}`, "profile-check"];

describe("Astra (hand-over): the rollback reads the page as it is now — never the update's old hand-over", () => {
  it("an update of a page its owner had stopped, the page started by him since: the rollback stops it with its own confirmed stop before touching the container, and starts it again", () => {
    host = makeHost((state) => {
      ownerStopped(state);
    });
    expect(host.run(UPDATE).status).toBe(0);
    expect(host.update().HANDOVER).toBe("0");
    ownerStarts(host);
    const run = host.run(["rollback", "--page", PAGE]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub sync browser snapshot", ...ROLLBACK_OUT, "hub sync browser start"]);
    expect(host.update()).toMatchObject({ STEP: "rolled_back", RB_START: "1", RB_CHECKS: "passed" });
    const stops = host.state().commands!.filter((row) => row.kind === "stopPage");
    const start = run.calls.find((call) => call.tool === "docker" && call.args.includes("start") && call.args.includes("browser"))!;
    expect(start.args[start.args.indexOf("--if-stop") + 1]).toBe(String(stops.at(-1)!.id));
    expect(profile(host)).toMatchObject({ version: FROM_CHROME, marker: "before" });
  });

  it("… and its stop not confirmed: nothing touched — the serving page is never stopped blind", () => {
    host = makeHost((state) => {
      ownerStopped(state);
    });
    expect(host.run(UPDATE).status).toBe(0);
    ownerStarts(host);
    host.edit((state) => {
      state.behaviour.stopOutcome = "unknown";
    });
    const run = host.run(["rollback", "--page", PAGE]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub sync browser snapshot"]);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "rolling_back" });
    expect(containerOf(host)).toMatchObject({ image: TO, running: true, chrome: "up" });
    expect(profile(host).restores ?? 0).toBe(0);
  });

  it("the owner's own stop stands, answered: rolled back under it, no lever — and it stays his (no start)", () => {
    host = makeHost((state) => {
      ownerStopped(state);
    });
    expect(host.run(UPDATE).status).toBe(0);
    ownerStarts(host);
    ownerStops(host);
    const run = host.run(["rollback", "--page", PAGE]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(ROLLBACK_OUT);
    expect(host.update()).toMatchObject({ STEP: "rolled_back", RB_START: "0", RB_CHECKS: "skipped" });
    expect(host.state().hub.pages[PAGE]).toMatchObject({ ownerStop: true, paused: true });
  });

  it("Hub says the browser is stopped, yet Chrome runs in the container: the rollback never stops it", () => {
    host = makeHost();
    expect(host.run([...UPDATE, "--window", "0"]).status).toBe(0);
    ownerStops(host);
    host.edit((state) => {
      state.containers[`page-browser-${PAGE}`]!.chrome = "up";
    });
    const run = host.run(["rollback", "--page", PAGE]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual([]);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "rolling_back", RB_STEP: "" });
    expect(host.update().HELD_WHY).toContain(`rollback: the container is not stopped: Chrome is up in page-browser-${PAGE}`);
    expect(host.update().HELD_WHY).toContain("the rollback touches no page that is not quiet under its stop; nothing touched");
    expect(containerOf(host)).toMatchObject({ image: TO, running: true, chrome: "up" });
  });

  it("a stop of the owner's not answered yet: the rollback asks none over it — it holds for him", () => {
    host = makeHost();
    expect(host.run([...UPDATE, "--window", "0"]).status).toBe(0);
    host.edit((state) => {
      const page = state.hub.pages[PAGE]!;
      Object.assign(page, { ownerStop: true, paused: true, stopPaused: true });
      state.commands!.push({ id: state.commands!.length + 1, page: PAGE, kind: "stopPage", note: "the owner's", outcome: "", expired: false, detail: "", haltId: null });
    });
    const run = host.run(["rollback", "--page", PAGE]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual([]);
    expect(host.update().HELD_WHY).toContain("the owner's stop stands on the page's browser");
  });
});

describe("Astra (hand-over): the update's start lifts only the stop the update made", () => {
  it("cut off after the profile check, the owner stops the page meanwhile: resume starts nothing — his stop and its pause stay, the update holds for him", () => {
    host = makeHost();
    expect(host.run(UPDATE, { crashOn: "profile-check" }).status).toBe(137);
    ownerStops(host);
    const run = host.run(["resume", "--page", PAGE]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["profile-check", "hub sync browser start"]);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "host_checked" });
    expect(host.update().HELD_WHY).toContain("the stop in force is not command");
    expect(host.state().hub.pages[PAGE]).toMatchObject({ ownerStop: true, paused: true });
    expect(host.state().commands!.filter((row) => row.kind === "restartBrowser")).toEqual([]);
  });

  it("held at its take-out, the owner stops the page meanwhile: resume asks no stop over his", () => {
    host = makeHost((state) => {
      state.behaviour.stopOutcome = "pending";
    });
    expect(host.run(UPDATE).status).toBe(1);
    host.edit((state) => {
      delete state.behaviour.stopOutcome;
    });
    ownerStops(host);
    const run = host.run(["resume", "--page", PAGE]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual([]);
    expect(host.update().HELD_WHY).toContain("the owner's stop stands on the page's browser");
    expect(host.state().commands!.filter((row) => row.kind === "stopPage")).toHaveLength(2);
  });
});

describe("Astra (hand-over 2): the update's stop is never asked over the owner's — refused in the stop's own transaction", () => {
  it("the owner stops the page between the update's look and its stop: the lever refuses, nothing changed — the update holds, his stop stays his", () => {
    host = makeHost((state) => {
      state.behaviour.ownerStopsBefore = "snapshot";
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub sync browser snapshot"]);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "planned" });
    expect(host.update().HELD_WHY).toContain("the owner's stop stands on the page's browser (stop command 1, asked meanwhile): the update's stop was refused, nothing changed");
    // Only his stop: none of the update's recorded, none lifted.
    expect(host.state().commands!.map((row) => [row.kind, row.note])).toEqual([["stopPage", "the owner's"]]);
    expect(host.state().hub.pages[PAGE]).toMatchObject({ ownerStop: true, paused: true });
    expect(containerOf(host)).toMatchObject({ image: FROM, running: true });
    // Resumed, it asks nothing over his stop either.
    const resumed = host.run(["resume", "--page", PAGE]);
    expect(resumed.status).toBe(1);
    expect(resumed.ops).toEqual([]);
    expect(host.state().hub.pages[PAGE]).toMatchObject({ ownerStop: true });
  });

  it("… and between the rollback's look and its stop: the rollback holds for him", () => {
    host = makeHost();
    expect(host.run([...UPDATE, "--window", "0"]).status).toBe(0);
    host.edit((state) => {
      state.behaviour.ownerStopsBefore = "snapshot";
    });
    const run = host.run(["rollback", "--page", PAGE]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub sync browser snapshot"]);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "rolling_back" });
    expect(host.update().HELD_WHY).toContain("rollback: the owner's stop stands on the page's browser");
    expect(host.state().commands!.filter((row) => row.kind === "stopPage").map((row) => row.note.startsWith("page-browser-update"))).toEqual([true, false]);
    expect(host.state().hub.pages[PAGE]).toMatchObject({ ownerStop: true });
  });
});

describe("Astra (hand-over 3): the update's stop is asked only of a page on its browser — read as it is now", () => {
  it("cut off before its stop; the owner moves the page to Node: resume asks no stop — never paused by the update, held for him", () => {
    host = makeHost((state) => {
      Object.assign(state.hub.pages[PAGE]!, { paused: false, ownerStop: false });
    });
    expect(host.run(UPDATE, { crashBefore: "hub sync browser snapshot" }).status).toBe(137);
    expect(host.update()).toMatchObject({ STEP: "planned", HANDOVER: "1" });
    host.edit((state) => {
      Object.assign(state.hub.pages[PAGE]!, { transport: "node", leave: null, gen: 8 });
    });
    const resumed = host.run(["resume", "--page", PAGE]);
    expect(resumed.status).toBe(1);
    expect(resumed.ops).toEqual([]);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "planned" });
    expect(host.update().HELD_WHY).toContain("the page is not on its browser now (transport node): its owner moved it — the update asks no stop of it");
    expect(host.state().hub.pages[PAGE]).toMatchObject({ transport: "node", paused: false, ownerStop: false });
    expect(host.state().commands ?? []).toEqual([]);
    expect(containerOf(host)).toMatchObject({ image: FROM, running: true });
  });

  it("… moved between the update's look and its stop: the lever refuses, nothing changed — held", () => {
    host = makeHost((state) => {
      Object.assign(state.hub.pages[PAGE]!, { paused: false, ownerStop: false });
      state.behaviour.ownerMovesToNodeBefore = "snapshot";
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub sync browser snapshot"]);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "planned" });
    expect(host.update().HELD_WHY).toContain("(transport node): its owner moved it — the update asks no stop of it (moved meanwhile): the update's stop was refused, nothing changed");
    expect(host.state().hub.pages[PAGE]).toMatchObject({ transport: "node", paused: false, ownerStop: false });
    expect(host.state().commands ?? []).toEqual([]);
  });
});

describe("Astra (hand-over 2): one guard before every deed on the page's container or profile", () => {
  it("cut off after the take-out, before the container's stop; the owner starts the browser: resume never stops it — held, nothing touched; rollback ends it with the page as he has it", () => {
    host = makeHost();
    expect(host.run(UPDATE, { crashBefore: "docker stop" }).status).toBe(137);
    expect(host.update()).toMatchObject({ STEP: "taken_out", CONTAINER_STOPPED: "1" });
    ownerStarts(host);
    const resumed = host.run(["resume", "--page", PAGE]);
    expect(resumed.status).toBe(1);
    expect(resumed.ops).toEqual([]);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "taken_out" });
    expect(host.update().HELD_WHY).toContain(`the container is not stopped: Chrome is up in page-browser-${PAGE}`);
    expect(containerOf(host)).toMatchObject({ image: FROM, running: true, chrome: "up" });
    // His start stands: the abort lifts nothing, starts nothing.
    const rollback = host.run(["rollback", "--page", PAGE]);
    expect(rollback.status).toBe(1);
    expect(rollback.ops).toEqual([]);
    expect(host.update().STEP).toBe("aborted");
    expect(containerOf(host)).toMatchObject({ image: FROM, running: true, chrome: "up" });
    expect(host.state().commands!.filter((row) => row.kind === "restartBrowser").map((row) => row.note)).toEqual(["the owner's"]);
  });

  it("the stop the update went on under reads unanswered: nothing touched — only the operator's answer says Chrome is down", () => {
    host = makeHost();
    expect(host.run(UPDATE, { crashBefore: "docker stop" }).status).toBe(137);
    host.edit((state) => {
      state.commands!.find((row) => row.kind === "stopPage")!.outcome = "unknown";
    });
    const resumed = host.run(["resume", "--page", PAGE]);
    expect(resumed.status).toBe(1);
    expect(resumed.ops).toEqual([]);
    expect(host.update().HELD_WHY).toContain("stop command 1 is unknown: its operator has not said Chrome is down");
  });

  it("a page its owner stopped, his stop not answered: held before anything — the update goes on only under a stop answered ok", () => {
    host = makeHost((state) => {
      ownerStopped(state);
      state.commands![0]!.outcome = "expired";
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual([]);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "planned", HANDOVER: "0" });
    expect(host.update().HELD_WHY).toContain("the owner's stop does not hold the page's browser now, answered (stop command 1: expired, in force: true)");
    expect(host.update().OUT_STOP).toBeUndefined();
  });

  type Path = "update" | "rollback" | "abort" | "snapshot";
  const SNAPSHOT = ["snapshot", "--page", PAGE];
  const rows: Array<{ path: Path; deed: string; why: string | Record<string, string> }> = [
    { path: "update", deed: "docker stop", why: "the container is not stopped" },
    { path: "update", deed: "profile snapshot", why: "the profile is not packed" },
    { path: "update", deed: `page.sh up ${TO}`, why: `${TO} is not started` },
    { path: "rollback", deed: "docker stop", why: "rollback: the container is not stopped" },
    { path: "rollback", deed: "profile restore", why: "rollback: the snapshot is not restored" },
    { path: "rollback", deed: `page.sh up ${FROM}`, why: `rollback: ${FROM} is not started` },
    { path: "abort", deed: `page.sh up ${FROM}`, why: `abort: ${FROM} is not started again` },
    // (Chrome up: its own check before the guard's — the page as it was.)
    { path: "snapshot", deed: "docker stop", why: { starts: `Chrome is up in page-browser-${PAGE}`, "stops anew": "is not stopped, nothing touched" } },
    { path: "snapshot", deed: "profile snapshot", why: "nothing packed" },
    { path: "snapshot", deed: `page.sh up ${FROM}`, why: "is not started blind" },
  ];
  const owner = {
    // His start: the stop lifted, Chrome up again if its container runs.
    starts: (h: Host) => ownerStarts(h),
    // His start, then a stop of his own: Chrome down, but the stop in
    // force is not the one the operation went on under.
    "stops anew": (h: Host) => {
      ownerStarts(h);
      ownerStops(h);
    },
  };

  for (const row of rows) {
    for (const [how, act] of Object.entries(owner)) {
      it(`${row.path}: right before "${row.deed}", the owner ${how}: resume does nothing — held by the guard`, () => {
        host = makeHost((state) => {
          if (row.path === "abort") state.behaviour.snapshotFails = true;
          if (row.path === "snapshot") ownerStopped(state);
        });
        if (row.path === "rollback") expect(host.run([...UPDATE, "--window", "0"]).status).toBe(0);
        const command = row.path === "rollback" ? ["rollback", "--page", PAGE] : row.path === "snapshot" ? SNAPSHOT : UPDATE;
        expect(host.run(command, { crashBefore: row.deed }).status).toBe(137);
        act(host);
        const before = host.state();
        const resumed = host.run(["resume", "--page", PAGE]);
        expect(resumed.status).not.toBe(0);
        expect(resumed.ops).toEqual([]);
        expect(host.state().containers).toEqual(before.containers);
        expect(host.state().profiles).toEqual(before.profiles);
        const why = typeof row.why === "string" ? row.why : row.why[how]!;
        if (row.path === "snapshot") {
          expect(resumed.stderr).toContain(why);
        } else {
          expect(host.update().STEP).toBe("held");
          expect(host.update().HELD_WHY).toContain(why);
        }
      });
    }
  }

  it("every deed's site in the script is a guarded one, the guard before it", () => {
    const script = readFileSync(UPDATE_SCRIPT, "utf8");
    const DEED = /docker stop -t|"\$PAGE_SH" up|profile_op (snapshot|restore)/;
    const code = script.split("\n").filter((line) => !line.trimStart().startsWith("#"));
    const sites = code.filter((line) => DEED.test(line));
    // One deed a step: the container's stop, the profile's pack or restore, a start.
    const guarded = ["step_stop", "step_snapshot", "step_start_new", "rb_stop", "rb_restore", "rb_start_old", "step_abort", "snap_stop", "snap_take", "snap_start"];
    expect(sites).toHaveLength(guarded.length);
    for (const name of guarded) {
      const body = new RegExp(`\n${name}\\(\\) \\{\n([\\s\\S]*?)\n\\}\n`).exec(script)?.[1] ?? "";
      const deed = body.search(DEED);
      expect(deed, name).toBeGreaterThan(0);
      expect(body.lastIndexOf("guard_quiet", deed), name).toBeGreaterThanOrEqual(0);
    }
  });

  it("in a whole update and its rollback, each deed comes right after a guard's read of the Hub", () => {
    host = makeHost();
    const update = host.run([...UPDATE, "--window", "0"]);
    expect(update.status, update.stderr).toBe(0);
    const rollback = host.run(["rollback", "--page", PAGE]);
    expect(rollback.status).toBe(1);
    expect(host.update().STEP).toBe("rolled_back");
    for (const run of [update, rollback]) {
      let guarded = false;
      const deeds: string[] = [];
      for (const call of run.calls) {
        if (call.stdin?.startsWith(`-- pb-update:guard ${PAGE}\n`)) guarded = true;
        const deed = opOfCall(call);
        if (deed === null || !/^(docker stop|profile (snapshot|restore)|page\.sh up)/.test(deed)) continue;
        expect(guarded, deed).toBe(true);
        guarded = false;
        deeds.push(deed);
      }
      expect(deeds.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("a halt held for the owner's decision is never the update's (PR 17)", () => {
  it("one its new operator holds when the page is to be started again: held — no start asked, nothing cleared", () => {
    host = makeHost();
    expect(host.run(UPDATE, { crashOn: "profile-check" }).status).toBe(137);
    host.edit((state) => {
      state.operatorHalts = { [PROFILE]: "halt_unreadable 99999999-9999-4999-8999-999999999999" };
    });
    const run = host.run(["resume", "--page", PAGE]);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["profile-check"]);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "host_checked" });
    expect(host.update().HELD_WHY).toContain("its operator holds a halt for the owner's decision (halt_unreadable 99999999");
    expect((host.state().commands ?? []).filter((row) => row.kind === "restartBrowser")).toEqual([]);
  });

  it("one Hub mirrors when the page is to be started again: the lever's own refusal holds it too", () => {
    host = makeHost();
    expect(host.run(UPDATE, { crashOn: "profile-check" }).status).toBe(137);
    host.edit((state) => {
      Object.assign(state.hub.pages[PAGE]!.pb, { haltReason: "exit_ip_changed", haltId: "12121212-1212-4121-8121-121212121212" });
    });
    const run = host.run(["resume", "--page", PAGE]);
    expect(run.status).toBe(1);
    expect(host.update().HELD_WHY).toContain("its browser stands for the owner's decision (exit_ip_changed, halt 12121212");
    expect((host.state().commands ?? []).filter((row) => row.kind === "restartBrowser")).toEqual([]);
    expect(host.state().hub.pages[PAGE]!.pb.haltId).toBe("12121212-1212-4121-8121-121212121212");
  });
});

describe("what the Hub cannot tell holds the update for the owner", () => {
  it("a rollback whose old image's start the Hub cannot tell: held at that step, not ended — resumed, it ends on the engine's word", () => {
    host = makeHost((state) => {
      state.behaviour.profileCheckFails = [TO];
    });
    expect(host.run(UPDATE, { crashOn: "hub sync browser start" }).status).toBe(137);
    expect(host.update()).toMatchObject({ STEP: "rolling_back", RB_STEP: "host_checked" });
    // The Hub down: the page is not given back blind.
    host.edit((state) => {
      state.behaviour.hubDown = true;
    });
    expect(host.run(["resume", "--page", PAGE]).status).toBe(1);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "rolling_back", RB_STEP: "host_checked" });
    expect(host.update().HELD_WHY).toContain("rollback: the browser is not started on its previous image: the Hub cannot be read");
    // Given back, then the Hub stops answering: the old image's start unknown.
    host.edit((state) => {
      state.behaviour.hubDown = false;
      // The give-back's reads (the page, its stop, its start's answer): then nothing.
      state.behaviour.sqlFailAfter = 3;
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
      // The plan, the stop (now, its answer), the guard of each deed (3),
      // what stands unfinished before the hand-over, the start (the page, its
      // stop, its answer): then nothing.
      state.behaviour.sqlFailAfter = 10;
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub sync browser snapshot", "docker stop", "profile snapshot", `page.sh up ${TO}`, "profile-check", "hub sync browser start"]);
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "given_back" });
    expect(host.update().HELD_WHY).toContain("the Hub cannot be read");
    expect(events(host)).not.toContain("rolled_back");
  });

  it("the Hub stops answering during the take-out: held, the container untouched", () => {
    host = makeHost((state) => {
      state.behaviour.stopOutcome = "pending";
      state.behaviour.sqlFailAfter = 2;
    });
    const run = host.run(UPDATE);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual(["hub sync browser snapshot"]);
    expect(host.update().HELD_WHY).toContain("the Hub cannot be read");
    expect(host.update()).toMatchObject({ STEP: "held", HELD_FROM: "planned" });
    expect(containerOf(host)).toMatchObject({ image: FROM, running: true });
  });
});
