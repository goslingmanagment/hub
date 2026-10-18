import { describe, expect, it } from "vitest";

import { BlockedRequests } from "../apps/page-browser/src/intercept/blocked.ts";
import { EgressFailureCounts } from "../apps/page-browser/src/state/egress-failures.ts";
import { EGRESS_FAILURE_ENTRIES_MAX } from "../apps/page-browser/src/rpc/protocol.ts";
import { BrowserRecorder, stateTelemetry } from "../apps/runtime/src/sync/fansly/browser-record.ts";
import type { State } from "../apps/runtime/src/services/egress/page-browser-protocol.ts";
import type { PageBrowserRpcClient } from "../apps/runtime/src/services/egress/page-browser-rpc.ts";
import { FakeCdpPort } from "./helpers/page-browser-fakes.ts";

// The exit's refusals, counted (2026-10-18): the operator's counts in its
// state (state/egress-failures.ts), the rules extension's blocks as Chrome
// reports them (intercept/blocked.ts), and what the engine keeps of them —
// the row's snapshot and what grew into its counters (fansly/browser-record.ts).

describe("the operator's counts", () => {
  it("count the SOCKS5's failures by kind, step, reply and class, and the extension's blocks by class with the probes apart", () => {
    let now = 1_000;
    const counts = new EgressFailureCounts({ now: () => now });
    counts.socks({ kind: "refused", step: "connect", rep: 2, cls: "api", host: "apiv3.fansly.com" });
    now = 2_000;
    counts.socks({ kind: "refused", step: "connect", rep: 2, cls: "api", host: "apiv3.fansly.com" });
    counts.socks({ kind: "unavailable", step: "connect", rep: null, cls: "third_party", host: "tracker.adnet-cdn.com" });
    // A reply out of the byte's range is kept as none.
    counts.socks({ kind: "refused", step: "connect", rep: 0, cls: "site", host: "fansly.com" });
    counts.dnr({ cls: "api", probe: true, host: "apiv3.fansly.com" });
    counts.dnr({ cls: "site", probe: false, host: "metrics.fansly.com" });
    counts.dnr({ cls: "site", probe: false, host: "metrics.fansly.com" });
    expect(counts.snapshot()).toEqual({
      sinceWall: 1_000,
      socks: [
        { kind: "refused", step: "connect", rep: 2, cls: "api", count: 2, lastAtWall: 2_000, lastHost: "apiv3.fansly.com" },
        { kind: "unavailable", step: "connect", rep: null, cls: "third_party", count: 1, lastAtWall: 2_000, lastHost: "tracker.adnet-cdn.com" },
        { kind: "refused", step: "connect", rep: null, cls: "site", count: 1, lastAtWall: 2_000, lastHost: "fansly.com" },
      ],
      dnr: [
        { cls: "api", probe: true, count: 1, lastAtWall: 2_000, lastHost: "apiv3.fansly.com" },
        { cls: "site", probe: false, count: 2, lastAtWall: 2_000, lastHost: "metrics.fansly.com" },
      ],
    });
  });

  it("keep at most the protocol's entries a list, and a host cut to 255", () => {
    const counts = new EgressFailureCounts();
    for (let rep = 1; rep <= EGRESS_FAILURE_ENTRIES_MAX + 10; rep += 1) counts.socks({ kind: "refused", step: "connect", rep, cls: "third_party", host: "x".repeat(300) });
    const { socks } = counts.snapshot();
    expect(socks).toHaveLength(EGRESS_FAILURE_ENTRIES_MAX);
    expect(socks[0]!.lastHost).toHaveLength(255);
  });
});

describe("the rules extension's blocks", () => {
  it("are told by their host once Chrome fails them net::ERR_BLOCKED_BY_CLIENT; another failure, a finished load, one failed in Fetch here are not", () => {
    const cdp = new FakeCdpPort();
    const blocked: Array<{ networkId: string; host: string }> = [];
    const requests = new BlockedRequests(cdp, (block) => blocked.push(block));
    const willBeSent = (id: string, url: string) => cdp.emit("Network.requestWillBeSent", { requestId: id, request: { url } });
    willBeSent("R1", "https://metrics.fansly.com/v1/signals");
    willBeSent("R2", "https://fansly.com/");
    willBeSent("R3", "https://apiv3.fansly.com/api/v1/x");
    willBeSent("R4", "https://cdn3.fansly.com/a.jpg");
    requests.failedHere("R4");
    cdp.emit("Network.loadingFailed", { requestId: "R1", errorText: "net::ERR_BLOCKED_BY_CLIENT" });
    cdp.emit("Network.loadingFinished", { requestId: "R2" });
    cdp.emit("Network.loadingFailed", { requestId: "R3", errorText: "net::ERR_FAILED" });
    cdp.emit("Network.loadingFailed", { requestId: "R4", errorText: "net::ERR_BLOCKED_BY_CLIENT" });
    // One whose start was never seen: no host to tell.
    cdp.emit("Network.loadingFailed", { requestId: "R9", errorText: "net::ERR_BLOCKED_BY_CLIENT" });
    expect(blocked).toEqual([{ networkId: "R1", host: "metrics.fansly.com" }]);
  });
});

const STATE: State = {
  type: "state",
  step: "ready",
  stopReason: null,
  retryAtWall: null,
  exitOpen: true,
  mode: "automation",
  sessionFingerprint: null,
  accountId: null,
  exitIp: null,
  chromeVersion: "155.0.8059.84",
  operatorVersion: "test",
  buffer: { bytes: 0, oldestAgeMs: 0 },
  selfTest: null,
};

function failures(sinceWall: number, refused: number, blocked: number): NonNullable<State["egressFailures"]> {
  return {
    sinceWall,
    socks: [{ kind: "refused", step: "connect", rep: 2, cls: "api", count: refused, lastAtWall: 1_700_000_100_000, lastHost: "apiv3.fansly.com" }],
    dnr: [{ cls: "site", probe: false, count: blocked, lastAtWall: 1_700_000_200_000, lastHost: "metrics.fansly.com" }],
  };
}

describe("what the engine keeps of them", () => {
  it("the row's snapshot: since when, each entry with its instant", () => {
    expect(stateTelemetry({ ...STATE, egressFailures: failures(1_700_000_000_000, 3, 9) }).egressFailures).toEqual({
      since: new Date(1_700_000_000_000),
      socks: [{ kind: "refused", step: "connect", rep: 2, cls: "api", count: 3, lastAt: "2023-11-14T22:15:00.000Z", lastHost: "apiv3.fansly.com" }],
      dnr: [{ cls: "site", probe: false, count: 9, lastAt: "2023-11-14T22:16:40.000Z", lastHost: "metrics.fansly.com" }],
    });
    expect(stateTelemetry(STATE).egressFailures).toBeNull();
  });

  it("the counters: what grew since the state before — the first state heard is a baseline; an operator started anew counts from zero", async () => {
    const listeners: Array<(state: State) => void> = [];
    const client = {
      state: null,
      onState: (listener: (state: State) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
      onAlarm: () => () => undefined,
      onLink: () => () => undefined,
    } as unknown as PageBrowserRpcClient;
    const counted: Array<{ name: string; labels: Record<string, unknown>; by: number }> = [];
    const recorder = new BrowserRecorder({
      db: { execute: async () => ({ rows: [{ profile_id: "p" }] }) } as never,
      pageId: 7,
      profileId: "11111111-2222-4333-8444-555555555555",
      client,
      clock: { monoNow: () => 0, wallNow: () => new Date(0) } as never,
      logger: { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined } as never,
      metrics: { increment: (name, labels = {}, by = 1) => counted.push({ name, labels, by }) },
    });
    recorder.start();
    const say = (state: State) => {
      for (const listener of listeners) listener(state);
    };
    const egress = () => counted.filter((entry) => entry.name !== "sync_browser_alarm");
    say({ ...STATE, egressFailures: failures(1_000, 3, 9) });
    expect(egress()).toEqual([]);
    say({ ...STATE, egressFailures: failures(1_000, 5, 9) });
    expect(egress()).toEqual([{ name: "sync_browser_socks_failures", labels: { pageId: 7, kind: "refused", how: "connect", status: "2", of: "api" }, by: 2 }]);
    say({ ...STATE, egressFailures: failures(2_000, 1, 4) });
    expect(egress().slice(1)).toEqual([
      { name: "sync_browser_socks_failures", labels: { pageId: 7, kind: "refused", how: "connect", status: "2", of: "api" }, by: 1 },
      { name: "sync_browser_dnr_blocks", labels: { pageId: 7, of: "site", as: "page" }, by: 4 },
    ]);
    await recorder.stop();
  });
});
