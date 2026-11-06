import { afterEach, describe, expect, it, vi } from "vitest";

import { containerOf, FROM, makeHost, updateWithWindow, type Host } from "./helpers/page-browser-update.ts";

// Each test runs the script in bash against a fake server that starts a
// process per call: slower than a unit test, more so under a full parallel run.
vi.setConfig({ testTimeout: 180_000 });

// scripts/page-browser-update.sh — the window after an update (its contract:
// updateWithWindow in tests/helpers/page-browser-update.ts): Hub's requests
// through the browser refused or held past their bound fail it while the page
// stays ready, and the page is rolled back. The browser itself:
// page-browser-update-window-rollback-browser.test.ts.

let host: Host | undefined;
afterEach(() => {
  host?.cleanup();
  host = undefined;
});

describe("the window judges the browser", () => {
  it.each<[string, Record<string, unknown>, Record<string, string>?]>([
    ["ready, Hub's requests refused: the site computes fansly-client-ts another way", { hubBlockAfterReadyReads: { reason: "client_check" } }],
    [
      "ready, Hub's requests held past their bound (2 s here): no template",
      { hubBlockAfterReadyReads: { reason: "no_template" } },
      { PB_UPDATE_HUB_SEND_WAIT_S: "2" },
    ],
    [
      "ready, Hub's requests held past their bound (2 s here): no exit IP confirmed",
      { hubBlockAfterReadyReads: { reason: "exit_ip_unknown" } },
      { PB_UPDATE_EXIT_IP_WAIT_S: "2" },
    ],
    [
      "Hub's requests held at its end (no exit IP), then the live session changed and the page went back below ready: never passed",
      {
        hubBlockAfterReadyReads: { reason: "exit_ip_unknown" },
        sessionChangesAfterReadyReads: { afterReadyReads: 3, fp: "e".repeat(64), account: "", step: "site_loaded" },
      },
      { PB_UPDATE_EXIT_IP_WAIT_S: "8" },
    ],
  ])("%s: rolled back, never judged by the hour", (_name, behaviour, env) => {
    host = makeHost((state) => {
      Object.assign(state.behaviour, behaviour);
    });
    const run = updateWithWindow(host, env);
    expect(run.status).toBe(1);
    expect(run.ops).not.toContain("hub sync check live-hour");
    expect(host.update()).toMatchObject({ STEP: "rolled_back" });
    expect(containerOf(host)).toMatchObject({ image: FROM, running: true });
  });
});
