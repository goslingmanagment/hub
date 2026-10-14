import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FROM, FROM_CHROME, makeHost, PAGE, PROFILE, REPO_ROOT, TO, TO_CHROME, writeExecutable, type Host } from "./helpers/page-browser-update.ts";

// page.sh never starts an image whose Chrome is older than the one that last
// opened the page's profile (Project Browser PR 18; plan §4.10, stage 1):
// Chrome upgrades a profile in place and never opens one a newer Chrome
// wrote. `up` and `rollback` refuse it; the way back to an older Chrome is
// the profile's snapshot (page-browser-update.sh rollback). The real page.sh
// runs in bash against the fake docker of tests/helpers/page-browser-update-fake.mjs.

const PAGE_SH = path.join(REPO_ROOT, "apps/page-browser/host/page.sh");

let host: Host | undefined;
afterEach(() => {
  host?.cleanup();
  host = undefined;
});

/** The real page.sh against the fake docker. */
function pageSh(h: Host, args: string[]) {
  writeExecutable(path.join(h.pbBase, "egress-rules.sh"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(path.join(h.pbBase, "docker-compose.page-browser.yml"), "# the compose file\n");
  const before = readFileSync(h.logPath, "utf8").split("\n").filter(Boolean).length;
  const result = spawnSync("bash", [PAGE_SH, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PATH: `${h.bin}:${process.env.PATH ?? ""}`, PB_BASE: h.pbBase, FAKE_SCRIPT: path.join(REPO_ROOT, "tests/helpers/page-browser-update-fake.mjs"), FAKE_STATE: h.statePath, FAKE_LOG: h.logPath },
  });
  const calls = readFileSync(h.logPath, "utf8").split("\n").filter(Boolean).slice(before).map((line) => JSON.parse(line) as { tool: string; args: string[] });
  return { ...result, composeUp: calls.some((call) => call.tool === "docker" && call.args[0] === "compose" && call.args.includes("up")) };
}

describe("page.sh: never an older Chrome on a profile a newer one wrote", () => {
  it("up to an image whose Chrome is older than the profile's: refused, nothing started", () => {
    host = makeHost((state) => {
      state.profiles[PROFILE]!.version = TO_CHROME;
    });
    const run = pageSh(host, ["up", "--page", PAGE, "--image", FROM]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`${FROM} has Chrome ${FROM_CHROME}, but the profile ${PROFILE} was last opened by Chrome ${TO_CHROME}`);
    expect(run.stderr).toContain("page-browser-update.sh rollback restores its snapshot");
    expect(run.composeUp).toBe(false);
  });

  it("rollback to a previous image with an older Chrome: refused while the profile is the newer Chrome's; after its snapshot is back, it goes", () => {
    host = makeHost((state) => {
      state.profiles[PROFILE]!.version = TO_CHROME;
      state.containers[`page-browser-${PAGE}`]!.image = TO;
    });
    writeFileSync(path.join(host.pbBase, "pages", PAGE, "page.env"), host.pageEnv().replace(`PB_IMAGE=${FROM}\nPB_PREVIOUS_IMAGE=\n`, `PB_IMAGE=${TO}\nPB_PREVIOUS_IMAGE=${FROM}\n`));
    const refused = pageSh(host, ["rollback", "--page", PAGE]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Chrome never opens a profile a newer one wrote");
    expect(refused.composeUp).toBe(false);
    host.edit((state) => {
      state.profiles[PROFILE]!.version = FROM_CHROME;
    });
    const back = pageSh(host, ["rollback", "--page", PAGE]);
    expect(back.status, back.stderr).toBe(0);
    expect(back.composeUp).toBe(true);
    expect(host.pageEnv()).toContain(`PB_IMAGE=${FROM}\nPB_PREVIOUS_IMAGE=${TO}\n`);
  });

  it("up to a newer Chrome, the same one, or on a profile no Chrome opened yet: it goes", () => {
    for (const version of [FROM_CHROME, TO_CHROME, ""]) {
      host = makeHost((state) => {
        state.profiles[PROFILE]!.version = version;
      });
      const run = pageSh(host, ["up", "--page", PAGE, "--image", TO]);
      expect(run.status, `${version}: ${run.stderr}`).toBe(0);
      expect(run.composeUp).toBe(true);
      host.cleanup();
    }
    host = undefined;
  });

  it("an image without the Chrome label: its Chrome asked itself", () => {
    host = makeHost((state) => {
      state.profiles[PROFILE]!.version = TO_CHROME;
      state.images[FROM]!.label = false;
    });
    const run = pageSh(host, ["up", "--page", PAGE, "--image", FROM]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`has Chrome ${FROM_CHROME}, but the profile`);
  });
});
