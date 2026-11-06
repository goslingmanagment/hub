import { afterEach, describe, expect, it, vi } from "vitest";

import { containerOf, FROM, makeHost, updateWithWindow, type Host } from "./helpers/page-browser-update.ts";

// Each test runs the script in bash against a fake server that starts a
// process per call: slower than a unit test, more so under a full parallel run.
vi.setConfig({ testTimeout: 180_000 });

// scripts/page-browser-update.sh — the window after an update (its contract:
// updateWithWindow in tests/helpers/page-browser-update.ts): the browser
// itself fails it — a stop, an alarm, another session or account — and the
// page is rolled back. Hub's requests through it:
// page-browser-update-window-rollback-requests.test.ts.

let host: Host | undefined;
afterEach(() => {
  host?.cleanup();
  host = undefined;
});

describe("the window judges the browser", () => {
  it.each<[string, Record<string, unknown>, Record<string, string>?]>([
    ["a stop of the browser in it, back ready between two looks (Chrome .39: cdp_lost)", { crashBetweenLooks: { reason: "cdp_lost" } }],
    ["a stop it stays in (Chrome crashed)", { failAfterReadyReads: 1, failStop: "chrome_crashed" }],
    ["an alarm of the browser's the operator's journal did not keep", { crashBetweenLooks: { reason: "cdp_lost", journal: false, selftest: false } }],
    ["another session: a new login", { sessionChangesAfterReadyReads: { fp: "e".repeat(64) } }],
    ["another account answers", { sessionChangesAfterReadyReads: { account: "222" } }],
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
