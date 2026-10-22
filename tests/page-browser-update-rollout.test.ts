import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FINGERPRINT, FROM, makeHost, PAGE, PINNED_IP, TO, type FakeState, type Host } from "./helpers/page-browser-update.ts";

// Each test runs the script in bash against a fake server that starts a
// process per call: slower than a unit test, more so under a full parallel run.
vi.setConfig({ testTimeout: 180_000 });

// scripts/page-browser-update.sh rollout — once a page passed its window on
// an image, every page whose image is another goes onto it, one by one: an
// older Chrome, and the same Chrome of another revision (an operator's change
// alone — ari-1, 2026-10-22, on .84 already, was skipped and the rollout
// said "every page is on <image>"). Never a Chrome back: a page on a newer
// one is skipped; nor an operator back: a page on the same Chrome whose
// image was built after the rollout's is skipped too. The last line says so.

let host: Host | undefined;
afterEach(() => {
  host?.cleanup();
  host = undefined;
});

/** TO's Chrome (.79), another revision: the operator's change alone. */
const SAME_CHROME = "hub-page-browser:155.0.8059.79-1-cccccccccccc";
/** TO's Chrome too, built after TO: a later operator than TO's. */
const SAME_CHROME_LATER = "hub-page-browser:155.0.8059.79-1-eeeeeeeeeeee";
const NEWER_CHROME = "hub-page-browser:156.0.8078.47-1-dddddddddddd";

/** Another page on its browser, on <image>, its profile last opened by that
 *  image's Chrome. */
function addPage(h: Host, label: string, image: string, profile: string): void {
  const dir = path.join(h.pbBase, "pages", label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "page.env"), `PB_PAGE=${label}\nPB_IMAGE=${image}\nPB_PREVIOUS_IMAGE=\nPB_PROFILE_ID=${profile}\n`);
  h.edit((state: FakeState) => {
    const chrome = /(\d+\.\d+\.\d+\.\d+)/.exec(state.images[image]!.chrome)![1]!;
    state.containers[`page-browser-${label}`] = { image, running: true, health: "healthy", chrome: "up", profile };
    state.profiles[profile] = { version: chrome, marker: "before", bytes: 400_000_000 };
    state.hub.pages[label] = {
      transport: "browser", leave: null, leftBy: null, leftGen: null, gen: 3, credentials: true, profile,
      pb: {
        step: "ready", stop: "", exitOpen: true, fp: FINGERPRINT, account: "333", exitIp: PINNED_IP, pinned: PINNED_IP,
        chrome: `Chrome/${chrome}`, operator: state.images[image]!.revision, stOk: true, stAt: Date.now() - 60_000, stFailed: "", stateAt: Date.now() - 1000,
      },
    };
  });
}

const imageOf = (h: Host, label: string) => /^PB_IMAGE=(.*)$/m.exec(readFileSync(path.join(h.pbBase, "pages", label, "page.env"), "utf8"))![1];

describe("rollout: every page on another image, never a Chrome back", () => {
  it("takes a page on the same Chrome of an earlier revision and one on an older Chrome; skips one on a newer Chrome and one on a later revision, and says which and why", () => {
    host = makeHost((state) => {
      // TO was built 2026-10-14.
      state.images[SAME_CHROME] = { chrome: "155.0.8059.79-1", revision: "cccccccccccc", created: "2026-10-10T00:00:00Z" };
      state.images[SAME_CHROME_LATER] = { chrome: "155.0.8059.79-1", revision: "eeeeeeeeeeee", created: "2026-10-16T00:00:00Z" };
      state.images[NEWER_CHROME] = { chrome: "156.0.8078.47-1", revision: "dddddddddddd", created: "2026-10-21T00:00:00Z" };
    });
    // The pilot: lilly-1 passes its window on TO.
    expect(host.run(["update", "--page", PAGE, "--image", TO, "--any-hour", "--window", "2s"]).status).toBe(0);
    addPage(host, "ari-1", SAME_CHROME, "7a2b3c4d-5e6f-4a70-8b8c-9d0e1f2a3b4c");
    addPage(host, "lora-2", FROM, "8b3c4d5e-6f70-4b81-9c9d-0e1f2a3b4c5d");
    addPage(host, "lora-1", NEWER_CHROME, "9c4d5e6f-7081-4c92-8dae-1f2a3b4c5d6e");
    addPage(host, "lora-3", SAME_CHROME_LATER, "0d5e6f70-8192-4da3-9ebf-2a3b4c5d6e7f");

    const run = host.run(["rollout", "--image", TO, "--any-hour"]);
    expect(run.status).toBe(0);
    expect(imageOf(host, "ari-1")).toBe(TO);
    expect(imageOf(host, "lora-2")).toBe(TO);
    expect(imageOf(host, "lora-1")).toBe(NEWER_CHROME);
    expect(imageOf(host, "lora-3")).toBe(SAME_CHROME_LATER);
    expect(host.state().containers["page-browser-lora-1"]).toMatchObject({ image: NEWER_CHROME, running: true });
    expect(host.state().containers["page-browser-lora-3"]).toMatchObject({ image: SAME_CHROME_LATER, running: true });
    // The last line: the pages it updated, and those it skipped with their images.
    const done = host.journal().find((line) => line.event === "rollout_done")!.detail;
    for (const label of ["ari-1", "lora-2", "lora-1", NEWER_CHROME, "lora-3", SAME_CHROME_LATER]) expect(done).toContain(label);
  });
});
