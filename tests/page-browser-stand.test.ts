import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import { roleOf, sitePage, STAND_SESSION } from "../apps/page-browser/stand/fansly/front.ts";
import type { JournalEvent } from "../apps/page-browser/stand/fansly/journal.ts";
import { parsePacket, pastTheProxy, type CaptureRules } from "../apps/page-browser/stand/runner/capture.ts";
import { closedWrites, contiguous, directArrivals, exactlyOnce, exitClosedWithin, forbiddenSocketMessages, sentAfterRecovery, stoodBetween, stoppedFor, unadmittedArrivals, upWithin, type SeenTransition } from "../apps/page-browser/stand/runner/criteria.ts";
import type { Grant } from "../apps/page-browser/stand/runner/engine.ts";
import { rng, runSeed, type RunRecord, type ScenarioRecord, type SeriesRecord } from "../apps/page-browser/stand/runner/series.ts";
import { standFrameOf } from "../apps/page-browser/stand/runner/store.ts";
import { verifySeries } from "../apps/page-browser/stand/runner/verify.ts";
import { SCENARIOS } from "../apps/page-browser/stand/runner/scenarios.ts";
import { authorizationBytes } from "../apps/page-browser/src/egress/socket-gate.ts";

// The stand's criteria (Project Browser plan §5, stage 2; PR 19) are pure
// functions over a run's evidence: each must hold on clean evidence and
// fail on the violation it exists for — the unit-level twin of the stand's
// control scenarios.

let seq = 0;
const event = (type: string, mono: number, fields: Record<string, unknown> = {}): JournalEvent => ({ seq: ++seq, mono, wall: 1_000_000 + mono, type, ...fields });
const apiRequest = (mono: number, method: string, pathWithQuery: string): JournalEvent => event("req", mono, { role: "api", host: "apiv3.fansly.com", method, path: pathWithQuery, pathname: pathWithQuery.split("?")[0] });
const grant = (kind: Grant["kind"], target: string | null, grantedMono: number, method: string | null = "GET"): Grant => ({ kind, attemptId: 1, ref: "r", method, target, grantedMono, deadlineMono: grantedMono + 15_000, generation: 1 });
const state = (atMono: number, exitOpen: boolean, step: SeenTransition["step"], stopReason: string | null = null, retryAtWall: number | null = null): SeenTransition => ({ atMono, exitOpen, step, stopReason, retryAtWall });

describe("no request or socket without an admission in force", () => {
  const target = "apiv3.fansly.com/api/v1/account/me?rid=a";

  it("holds for a request inside its admission's window, a preflight and the request under one admission", () => {
    const grants = [grant("site", target, 100)];
    expect(unadmittedArrivals([apiRequest(150, "OPTIONS", "/api/v1/account/me?rid=a"), apiRequest(160, "GET", "/api/v1/account/me?rid=a")], grants)).toEqual([]);
  });

  it("fails on a request with no admission, one after its deadline, a repeat, and a socket opened without one", () => {
    const grants = [grant("site", target, 100)];
    const violations = unadmittedArrivals(
      [apiRequest(50, "GET", "/api/v1/other?rid=b"), apiRequest(16_000, "GET", "/api/v1/account/me?rid=a"), apiRequest(200, "GET", "/api/v1/account/me?rid=a"), apiRequest(300, "GET", "/api/v1/account/me?rid=a"), event("ws.open", 400, { wsId: "ws-1" })],
      grants,
    );
    expect(violations).toEqual([
      expect.stringContaining("arrived without any admission"),
      expect.stringContaining("arrived outside its admission window"),
      expect.stringContaining("arrived again under one admission"),
      expect.stringContaining("a socket opened (ws-1) without an admission in force"),
    ]);
  });

  it("takes a socket inside a socket admission", () => {
    expect(unadmittedArrivals([event("ws.open", 500, { wsId: "ws-2" })], [grant("ws", "wss://wsv3.fansly.com/?v=3", 400, null)])).toEqual([]);
  });
});

describe("the other criteria of every run", () => {
  it("no closed write: only the login's writes may reach Fansly", () => {
    expect(closedWrites([apiRequest(1, "POST", "/api/v1/login"), apiRequest(2, "GET", "/api/v1/account/me")])).toEqual([]);
    expect(closedWrites([apiRequest(3, "POST", "/api/v1/message/ack?rid=x")])).toEqual([expect.stringContaining("POST apiv3.fansly.com/api/v1/message/ack")]);
  });

  it("no forbidden socket message: the authorization and the ping only", () => {
    const authorization = JSON.stringify({ t: 1, d: JSON.stringify({ token: STAND_SESSION.token, v: 3 }) });
    expect(forbiddenSocketMessages([event("ws.in", 1, { text: authorization }), event("ws.in", 2, { text: "p" })])).toEqual([]);
    expect(forbiddenSocketMessages([event("ws.in", 3, { text: JSON.stringify({ t: 46001, d: "{}" }) }), event("ws.in", 4, { text: JSON.stringify({ t: 1, d: JSON.stringify({ token: "x", v: 3, extra: 1 }) }) })])).toHaveLength(2);
  });

  it("nothing past the proxy: the direct listener and the capture", () => {
    expect(directArrivals([event("direct.connect", 1, { from: "10.0.1.101" })])).toEqual([expect.stringContaining("10.0.1.101")]);
    const rules: CaptureRules = { pageIps: ["10.0.0.101", "10.0.1.101"], socks: { ip: "10.0.1.10", port: 1080 }, engineIp: "10.0.0.20", rpcPort: 7700 };
    const lines = [
      "1791922006.6 eth1  Out IP 10.0.1.101.40000 > 10.0.1.10.1080: Flags [S], seq 1, length 0",
      "1791922006.7 eth0  Out IP 10.0.0.101.7700 > 10.0.0.20.53922: Flags [P.], length 20",
      "1791922006.8 eth0  Out ARP, Reply 10.0.0.101 is-at 96:95:f3:48:4c:24, length 28",
      "1791922006.9 lo    Out IP 10.0.1.101 > 10.0.1.101: ICMP host 1.1.1.1 unreachable - admin prohibited filter, length 68",
    ];
    expect(pastTheProxy(lines.map((line) => parsePacket(line)!), rules)).toEqual([]);
    const leak = parsePacket("1791922007.0 eth1  Out IP 10.0.1.101.55030 > 10.0.1.10.443: Flags [S], seq 2, length 0")!;
    expect(leak).toMatchObject({ iface: "eth1", direction: "Out", src: "10.0.1.101", dst: "10.0.1.10", dstPort: 443 });
    expect(pastTheProxy([leak], rules)).toEqual([expect.stringContaining("traffic past the proxy")]);
  });

  it("exactly once: one outcome, or a recover's answer; never 'not sent' of a request that arrived", () => {
    const row = (attemptId: number, sent: boolean | null) => ({ attemptId, run: "r", type: "result", kind: "transport_error", sent, committedMono: 1 });
    expect(exactlyOnce([{ attemptId: 1, outcomes: [row(1, false)], recovered: null, arrived: false }, { attemptId: 2, outcomes: [], recovered: "unknown", arrived: false }])).toEqual([]);
    expect(
      exactlyOnce([
        { attemptId: 3, outcomes: [row(3, false), row(3, false)], recovered: null, arrived: false },
        { attemptId: 4, outcomes: [], recovered: null, arrived: false },
        { attemptId: 5, outcomes: [], recovered: "not_sent", arrived: true },
        { attemptId: 6, outcomes: [], recovered: "outcome_resent", arrived: false },
      ]),
    ).toEqual([expect.stringContaining("attempt 3: committed 2 times"), expect.stringContaining("attempt 4: no outcome"), expect.stringContaining("attempt 5: said not sent"), expect.stringContaining("attempt 6: recover said")]);
  });

  it("contiguous: a hole in a buffer's numbers is an event deleted before its commit", () => {
    expect(contiguous(new Map([["b", [3, 4, 5]]]))).toEqual([]);
    expect(contiguous(new Map([["b", [1, 2, 5]]]))).toEqual([expect.stringContaining("events 3…4 were never committed")]);
  });

  it("no request admitted before the proxy failed goes after it came back", () => {
    const grants = [grant("site", "apiv3.fansly.com/api/v1/a?rid=1", 100)];
    expect(sentAfterRecovery([apiRequest(5000, "GET", "/api/v1/a?rid=1")], grants, 200, 4000)).toEqual([expect.stringContaining("went after it came back")]);
    expect(sentAfterRecovery([apiRequest(150, "GET", "/api/v1/a?rid=1")], grants, 200, 4000)).toEqual([]);
  });
});

describe("the page's reactions", () => {
  const states = [state(0, true, "exit_open"), state(1200, false, "exit_closed", "cdp_lost", 99), state(5000, true, "exit_open")];

  it("the exit closed within its bound: a state, or the operator's connection gone", () => {
    expect(exitClosedWithin(states, [], 1000, 500)).toEqual([]);
    expect(exitClosedWithin(states, [], 500, 500)).toEqual([expect.stringContaining("700 ms after the fault")]);
    expect(exitClosedWithin([state(0, true, "exit_open")], [1300], 1000, 500)).toEqual([]);
    expect(exitClosedWithin([state(0, true, "exit_open")], [], 1000, 500)).toEqual([expect.stringContaining("never seen closed")]);
  });

  it("up again within its bound; stood while it should; stopped for the expected reason, as a failure or a halt", () => {
    expect(upWithin(states, 1200, 4000, "x")).toEqual([]);
    expect(upWithin(states, 1200, 3000, "x")).toEqual([expect.stringContaining("3800 ms later")]);
    expect(stoodBetween(states, 1200, 4500, "x")).toEqual([]);
    expect(stoodBetween(states, 1200, 6000, "x")).toEqual([expect.stringContaining("opened its exit by itself")]);
    expect(stoppedFor(states, 1000, ["cdp_lost"], false)).toEqual([]);
    expect(stoppedFor(states, 1000, ["cdp_lost"], true)).toEqual([expect.stringContaining("expected a halt")]);
    expect(stoppedFor(states, 1000, ["disk_full"], null)).toEqual([expect.stringContaining("stopped for cdp_lost")]);
  });
});

describe("the series", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(record: Partial<ScenarioRecord> & { scenario: string }, runs: Array<Partial<RunRecord>>, seriesRuns = 2): void {
    const full: ScenarioRecord = { proves: "", asked: seriesRuns, valid: 0, passed: 0, failed: 0, invalid: 0, skipped: null, control: null, page: "p1", runs: [], ...record };
    full.runs = runs.map((run, index) => ({ run: index + 1, seed: 7 + index, momentMs: 100 * index, ok: true, invalid: false, violations: [], ...run }));
    mkdirSync(path.join(dir, record.scenario), { recursive: true });
    writeFileSync(path.join(dir, `${record.scenario}.json`), JSON.stringify(full));
    for (const run of full.runs) writeFileSync(path.join(dir, record.scenario, `run-${run.run}.json`), JSON.stringify({ scenario: record.scenario, ...run }));
  }

  function series(scenarios: string[], runs = 2): void {
    const record: SeriesRecord = { name: "t", seed: 1, runs, revision: "r", image: "i", startedWall: 1, finishedWall: 2, scenarios };
    writeFileSync(path.join(dir, "series.json"), JSON.stringify(record));
  }

  it("passes a full series: every run valid and passed, controls with their violation, skips listed apart", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pb-suite-"));
    series(["a", "control", "later"]);
    write({ scenario: "a" }, [{}, {}]);
    write({ scenario: "control", control: ["arrived without any admission"] }, [{ ok: true, violations: ["C1: GET x arrived without any admission"] }, { ok: true, violations: ["C1: POST y arrived without any admission"] }]);
    write({ scenario: "later", skipped: "PR 7" }, []);
    const verdict = verifySeries(dir);
    expect(verdict.problems).toEqual([]);
    expect(verdict.skipped).toEqual([{ scenario: "later", why: "PR 7" }]);
    expect(verdict.validRuns).toBe(4);
  });

  it("does not pass a failed run, a short scenario, a control without its violation, a missing record or an unfinished series", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pb-suite-"));
    series(["a", "b", "control", "gone"]);
    write({ scenario: "a" }, [{}, { ok: false, violations: ["exitClosed: never"] }]);
    write({ scenario: "b" }, [{}, { invalid: true }]);
    write({ scenario: "control", control: ["arrived without any admission"] }, [{ violations: ["C1: arrived without any admission"] }, { violations: [] }]);
    writeFileSync(path.join(dir, "series.json"), JSON.stringify({ name: "t", seed: 1, runs: 2, revision: "r", image: "i", startedWall: 1, finishedWall: null, scenarios: ["a", "b", "control", "gone"] }));
    const problems = verifySeries(dir).problems;
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("did not finish"),
        expect.stringContaining("a: failed runs: 2"),
        expect.stringContaining("b: 1 valid runs of 2"),
        expect.stringContaining("control: control runs without the violation they exist for: 2"),
        expect.stringContaining("gone: no record"),
      ]),
    );
  });

  it("draws each run's moment from a seed: the same seed, the same moments", () => {
    const one = rng(runSeed(42, "loss-cdp-break", 3));
    const two = rng(runSeed(42, "loss-cdp-break", 3));
    const other = rng(runSeed(42, "loss-cdp-break", 4));
    const a = [one(), one()];
    expect([two(), two()]).toEqual(a);
    expect(other()).not.toBe(a[0]);
    for (const value of a) expect(value >= 0 && value < 1).toBe(true);
  });

  it("names every scenario once, says what it proves, and declares what it waits for", () => {
    const names = SCENARIOS.map((scenario) => scenario.name);
    expect(new Set(names).size).toBe(names.length);
    for (const scenario of SCENARIOS) {
      expect(scenario.proves.length).toBeGreaterThan(20);
      expect(scenario.moment[0]).toBeLessThanOrEqual(scenario.moment[1]);
      if (scenario.site) expect(scenario.needs).toContain("PR7");
    }
    expect(SCENARIOS.filter((scenario) => scenario.control).map((scenario) => scenario.name)).toEqual(["control-leak", "control-bypass", "control-duplicate"]);
  });
});

describe("the stand's Fansly", () => {
  it("answers to Fansly's own names and the exit-IP service only", () => {
    expect(["fansly.com", "apiv3.fansly.com", "wsv3.fansly.com", "cdn3.fansly.com", "api.ipify.org", "example.com"].map(roleOf)).toEqual(["site", "api", "ws", "cdn", "ipify", null]);
  });

  it("serves a site page whose script parses, and whose socket authorization has the size the socket gate expects", () => {
    const html = sitePage({ readEveryMs: 700, writeEveryMs: 0, socket: true, forbiddenWs: false });
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    expect(() => new vm.Script(script)).not.toThrow();
    expect(sitePage(null)).not.toContain("<script>");
    expect(Buffer.byteLength(JSON.stringify({ t: 1, d: JSON.stringify({ token: STAND_SESSION.token, v: 3 }) }))).toBe(authorizationBytes(STAND_SESSION.token));
  });

  it("finds the stand's frame number in a socket frame as the browser received it", () => {
    const frame = JSON.stringify({ t: 0, d: JSON.stringify({ standFrame: 12, wsId: "ws-1", pad: "" }) });
    expect(standFrameOf(frame)).toBe(12);
    expect(standFrameOf("p")).toBeNull();
  });
});
