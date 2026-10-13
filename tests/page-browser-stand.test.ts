import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import { authorizationBytes } from "../apps/page-browser/src/egress/socket-gate.ts";
import { roleOf, sitePage, siteVariant, STAND_SESSION } from "../apps/page-browser/stand/fansly/front.ts";
import type { JournalEvent } from "../apps/page-browser/stand/fansly/journal.ts";
import { captureCovers, parsePacket, pastTheProxy, sentinelPorts, type CaptureRules } from "../apps/page-browser/stand/runner/capture.ts";
import {
  closedWriteAttempted,
  closedWrites,
  directArrivals,
  eventsComplete,
  exactlyOnce,
  exitClosedWithin,
  forbiddenSocketMessages,
  frameRates,
  heldPastDeadline,
  inFlightAtRestart,
  outageBacklog,
  sentAfterRecovery,
  stoodBetween,
  stoppedFor,
  unadmittedArrivals,
  upWithin,
  variantLoaded,
  type SeenTransition,
} from "../apps/page-browser/stand/runner/criteria.ts";
import type { Grant } from "../apps/page-browser/stand/runner/engine.ts";
import { loadVerdict, type Threshold } from "../apps/page-browser/stand/runner/load.ts";
import { SCENARIOS } from "../apps/page-browser/stand/runner/scenarios.ts";
import { rng, runSeed, type RunRecord, type ScenarioRecord, type SeriesRecord } from "../apps/page-browser/stand/runner/series.ts";
import { standFrameOf } from "../apps/page-browser/stand/runner/store.ts";
import { COMMON_CHECKS, judge, SETUP_FAILURE, violationsOf, type Checks, type Control } from "../apps/page-browser/stand/runner/verdict.ts";
import { verifySeries } from "../apps/page-browser/stand/runner/verify.ts";

// The stand's criteria (Project Browser plan §5, stage 2; PR 19) are pure
// functions over a run's evidence: each must hold on clean evidence and
// fail on the violation it exists for — the unit-level twin of the stand's
// control scenarios. And each check that asks a run for evidence of what it
// is about must fail a run that has none.

const PAGE_IP = "10.0.1.101";
const PAGES = new Map([[PAGE_IP, "p1"], ["10.0.1.102", "p2"]]);
let seq = 0;
const event = (type: string, mono: number, fields: Record<string, unknown> = {}): JournalEvent => ({ seq: ++seq, mono, wall: 1_000_000 + mono, type, from: PAGE_IP, ...fields });
const apiRequest = (mono: number, method: string, pathWithQuery: string, fields: Record<string, unknown> = {}): JournalEvent => event("req", mono, { role: "api", host: "apiv3.fansly.com", method, path: pathWithQuery, pathname: pathWithQuery.split("?")[0], rid: /[?&]rid=([^&]+)/.exec(pathWithQuery)?.[1] ?? null, ...fields });
const siteRequest = (mono: number, pathWithQuery: string, fields: Record<string, unknown> = {}): JournalEvent => event("req", mono, { role: "site", host: "fansly.com", method: "GET", path: pathWithQuery, pathname: pathWithQuery.split("?")[0], ...fields });
const SOCKET = "wss://wsv3.fansly.com/?v=3";
const socketOpen = (mono: number, wsId: string, fields: Record<string, unknown> = {}): JournalEvent => event("ws.open", mono, { wsId, url: SOCKET, ...fields });
const grant = (kind: Grant["kind"], target: string | null, grantedMono: number, fields: Partial<Grant> = {}): Grant => ({ kind, page: "p1", attemptId: 1, ref: "r", method: kind === "ws" ? null : "GET", target, grantedMono, deadlineMono: grantedMono + 15_000, generation: 1, ...fields });
const state = (atMono: number, exitOpen: boolean, step: SeenTransition["step"], stopReason: string | null = null, retryAtWall: number | null = null): SeenTransition => ({ atMono, exitOpen, step, stopReason, retryAtWall });

describe("C1: no request or socket without an admission in force", () => {
  const target = "apiv3.fansly.com/api/v1/account/me?rid=a";

  it("holds for a request inside its admission's window, a preflight and the request under one admission", () => {
    expect(unadmittedArrivals([apiRequest(150, "OPTIONS", "/api/v1/account/me?rid=a"), apiRequest(160, "GET", "/api/v1/account/me?rid=a")], [grant("site", target, 100)], PAGES)).toEqual([]);
  });

  it("fails on a request with no admission, one after its deadline, and a repeat under one admission", () => {
    const violations = unadmittedArrivals([apiRequest(50, "GET", "/api/v1/other?rid=b"), apiRequest(16_000, "GET", "/api/v1/account/me?rid=a"), apiRequest(200, "GET", "/api/v1/account/me?rid=a"), apiRequest(300, "GET", "/api/v1/account/me?rid=a")], [grant("site", target, 100)], PAGES);
    expect(violations).toEqual([expect.stringContaining("arrived without any admission"), expect.stringContaining("arrived outside its admission window"), expect.stringContaining("arrived again under one admission")]);
  });

  it("an admission is its page's: another page's request under it, or one from no page at all, has none", () => {
    const grants = [grant("site", target, 100)];
    expect(unadmittedArrivals([apiRequest(150, "GET", "/api/v1/account/me?rid=a", { from: "10.0.1.102" })], grants, PAGES)).toEqual([expect.stringContaining("without any admission of p2")]);
    expect(unadmittedArrivals([apiRequest(150, "GET", "/api/v1/account/me?rid=a", { from: "10.0.1.20" })], grants, PAGES)).toEqual([expect.stringContaining("which is no page of the stand")]);
  });

  it("an admission used in one run is not there for the next: a series keeps what each was used for", () => {
    const grants = [grant("ws", SOCKET, 400)];
    const used = new Map();
    expect(unadmittedArrivals([socketOpen(500, "ws-1")], grants, PAGES, 50, used)).toEqual([]);
    // The next run, a second later: the admission's 15 s are not over, but it was used.
    expect(unadmittedArrivals([socketOpen(1500, "ws-2")], grants, PAGES, 50, used)).toEqual([expect.stringContaining("arrived again under one admission")]);
    // Judged alone, that run would pass: what the series' shared record is for.
    expect(unadmittedArrivals([socketOpen(1500, "ws-2")], grants, PAGES)).toEqual([]);
  });

  it("one socket per admission, at the admitted address: a second open under it is a repeat, another address has none", () => {
    const grants = [grant("ws", SOCKET, 400)];
    expect(unadmittedArrivals([socketOpen(500, "ws-1")], grants, PAGES)).toEqual([]);
    expect(unadmittedArrivals([socketOpen(500, "ws-1"), socketOpen(600, "ws-2")], grants, PAGES)).toEqual([expect.stringContaining("a socket (ws-2, wss://wsv3.fansly.com/?v=3) arrived again under one admission")]);
    expect(unadmittedArrivals([socketOpen(500, "ws-3", { url: "wss://chatws.fansly.com/?v=3" })], grants, PAGES)).toEqual([expect.stringContaining("arrived without any admission of p1")]);
    expect(unadmittedArrivals([socketOpen(500, "ws-4", { from: "10.0.1.102" })], grants, PAGES)).toEqual([expect.stringContaining("without any admission of p2")]);
    expect(unadmittedArrivals([socketOpen(20_000, "ws-5")], grants, PAGES)).toEqual([expect.stringContaining("outside its admission window")]);
  });
});

describe("the other criteria of every run", () => {
  it("C2: only the login's writes may reach Fansly", () => {
    expect(closedWrites([apiRequest(1, "POST", "/api/v1/login"), apiRequest(2, "GET", "/api/v1/account/me")])).toEqual([]);
    expect(closedWrites([apiRequest(3, "POST", "/api/v1/message/ack?rid=x")])).toEqual([expect.stringContaining("POST apiv3.fansly.com/api/v1/message/ack")]);
  });

  it("C3: the authorization and the ping only", () => {
    const authorization = JSON.stringify({ t: 1, d: JSON.stringify({ token: STAND_SESSION.token, v: 3 }) });
    expect(forbiddenSocketMessages([event("ws.in", 1, { text: authorization }), event("ws.in", 2, { text: "p" })])).toEqual([]);
    expect(forbiddenSocketMessages([event("ws.in", 3, { text: JSON.stringify({ t: 46001, d: "{}" }) }), event("ws.in", 4, { text: JSON.stringify({ t: 1, d: JSON.stringify({ token: "x", v: 3, extra: 1 }) }) })])).toHaveLength(2);
  });

  const rules: CaptureRules = { pageIps: ["10.0.0.101", "10.0.1.101"], socks: { ip: "10.0.1.10", port: 1080 }, engineIp: "10.0.0.20", rpcPort: 7700 };
  const packets = (lines: string[]) => lines.map((line) => parsePacket(line)!);

  it("C4 and C5: nothing past the proxy — the capture's lines and the direct listener", () => {
    expect(directArrivals([event("direct.connect", 1, { from: "10.0.1.101" })])).toEqual([expect.stringContaining("10.0.1.101")]);
    const clean = packets([
      "1791922006.6 eth1  Out IP 10.0.1.101.40000 > 10.0.1.10.1080: Flags [S], seq 1, length 0",
      "1791922006.7 eth0  Out IP 10.0.0.101.7700 > 10.0.0.20.53922: Flags [P.], length 20",
      "1791922006.8 eth0  Out ARP, Reply 10.0.0.101 is-at 96:95:f3:48:4c:24, length 28",
      "1791922006.9 lo    Out IP 10.0.1.101 > 10.0.1.101: ICMP host 1.1.1.1 unreachable - admin prohibited filter, length 68",
    ]);
    expect(pastTheProxy(clean, rules)).toEqual([]);
    const leak = parsePacket("1791922007.0 eth1  Out IP 10.0.1.101.55030 > 10.0.1.10.443: Flags [S], seq 2, length 0")!;
    expect(leak).toMatchObject({ iface: "eth1", direction: "Out", src: "10.0.1.101", dst: "10.0.1.10", dstPort: 443 });
    expect(pastTheProxy([leak], rules)).toEqual([expect.stringContaining("traffic past the proxy")]);
  });

  it("C4: a capture is evidence only with the run's sentinels in it — an old or silent capture is none", () => {
    const ports = sentinelPorts(123_456);
    expect(ports.end).not.toBe(ports.start);
    const sentinel = (port: number) => `1791922010.1 eth0  In  IP 10.0.0.20.40123 > 10.0.0.101.${port}: UDP, length 17`;
    const live = packets([sentinel(ports.start), "1791922011.0 eth1  Out IP 10.0.1.101.40000 > 10.0.1.10.1080: Flags [S], seq 1, length 0", sentinel(ports.end)]);
    expect(captureCovers(live, "10.0.0.101", "10.0.0.20", [ports.start, ports.end])).toEqual([]);
    // The capture stopped before the run ended; one of another run; none at all.
    expect(captureCovers(packets([sentinel(ports.start)]), "10.0.0.101", "10.0.0.20", [ports.start, ports.end])).toEqual([expect.stringContaining("no live capture of the page covers the run: 1 of its 2 sentinel(s)")]);
    expect(captureCovers(packets([sentinel(ports.start + 1), sentinel(ports.end + 1)]), "10.0.0.101", "10.0.0.20", [ports.start, ports.end])).toHaveLength(1);
    expect(captureCovers([], "10.0.0.101", "10.0.0.20", [ports.start, ports.end])).toHaveLength(1);
    // A sentinel seen in another page's namespace is not this page's.
    expect(captureCovers(packets([sentinel(ports.start), sentinel(ports.end)]), "10.0.0.102", "10.0.0.20", [ports.start, ports.end])).toHaveLength(1);
  });

  it("C6: one outcome, or a recover's answer; never 'not sent' of a request that arrived", () => {
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

  it("C7: every number between the run's bounds is stored — the middle, the tail the operator sent last, the start of a new buffer", () => {
    expect(eventsComplete([{ bufferId: "b", start: 10, wireMax: 13, stored: [11, 12, 13] }])).toEqual([]);
    expect(eventsComplete([{ bufferId: "b", start: 10, wireMax: 10, stored: [] }])).toEqual([]);
    expect(eventsComplete([{ bufferId: "b", start: 10, wireMax: 14, stored: [11, 14] }])).toEqual([expect.stringContaining("events 12…13 were never committed")]);
    // The lost tail: the position was 10, the operator sent up to 15, nothing of it is stored.
    expect(eventsComplete([{ bufferId: "b", start: 10, wireMax: 15, stored: [] }])).toEqual([expect.stringContaining("events 11…15 were never committed (the tail the operator sent last)")]);
    expect(eventsComplete([{ bufferId: "b", start: 10, wireMax: 15, stored: [11, 12] }])).toEqual([expect.stringContaining("events 13…15 were never committed (the tail")]);
    // A buffer new to the engine starts at 1.
    expect(eventsComplete([{ bufferId: "new", start: 0, wireMax: 6, stored: [4, 5, 6] }])).toEqual([expect.stringContaining("events 1…3 were never committed (the start of the buffer)")]);
  });

  it("what waited when the proxy failed never goes after it is back — whatever admission it gets then", () => {
    const waiting = [{ page: "p1", method: "GET", target: "apiv3.fansly.com/api/v1/a?rid=1" }];
    // It waited without an admission, got a new one after the recovery, and went.
    const after = [apiRequest(5000, "GET", "/api/v1/a?rid=1")];
    expect(unadmittedArrivals(after, [grant("site", "apiv3.fansly.com/api/v1/a?rid=1", 4500)], PAGES)).toEqual([]);
    expect(sentAfterRecovery(after, waiting, PAGES, 4000)).toEqual([expect.stringContaining("waited when the proxy failed and went after it came back")]);
    expect(sentAfterRecovery([apiRequest(150, "GET", "/api/v1/a?rid=1")], waiting, PAGES, 4000)).toEqual([]);
    expect(sentAfterRecovery([apiRequest(5000, "GET", "/api/v1/a?rid=2")], waiting, PAGES, 4000)).toEqual([]);
    expect(sentAfterRecovery([apiRequest(5000, "GET", "/api/v1/a?rid=1", { from: "10.0.1.102" })], waiting, PAGES, 4000)).toEqual([]);
  });
});

describe("evidence that a run met what it is about", () => {
  it("the browser runs the page variant the run configured, loaded after it was configured", () => {
    const site = { readEveryMs: 700, writeEveryMs: 2000, socket: true, forbiddenWs: false };
    const variant = siteVariant(site);
    expect(variant).not.toBe(siteVariant({ ...site, writeEveryMs: 0 }));
    expect(variantLoaded([siteRequest(100, `/stand/hello?variant=${variant}&t=1`)], PAGE_IP, variant, 0)).toEqual([]);
    // The page of the scenario before is still there: no closed write would ever be tried.
    expect(variantLoaded([siteRequest(100, `/stand/hello?variant=${siteVariant({ ...site, writeEveryMs: 0 })}&t=1`)], PAGE_IP, variant, 0)).toEqual([expect.stringContaining("the run configured")]);
    expect(variantLoaded([siteRequest(100, `/stand/hello?variant=${variant}&t=1`)], PAGE_IP, variant, 200)).toEqual([expect.stringContaining("did not load after it was configured")]);
    expect(variantLoaded([siteRequest(100, `/stand/hello?variant=${variant}&t=1`, { from: "10.0.1.102" })], PAGE_IP, variant, 0)).toHaveLength(1);
  });

  it("a closed-writes run must show a closed write tried and cancelled", () => {
    expect(closedWriteAttempted([siteRequest(1, "/stand/report?what=write-failed&rid=a")], PAGE_IP)).toEqual([]);
    expect(closedWriteAttempted([siteRequest(1, "/stand/hello?variant=x")], PAGE_IP)).toEqual([expect.stringContaining("attempted no closed write")]);
    expect(closedWriteAttempted([siteRequest(1, "/stand/report?what=write-failed&rid=a"), siteRequest(2, "/stand/report?what=write-done&rid=b")], PAGE_IP)).toEqual([expect.stringContaining("got an answer")]);
  });

  it("an expiry run must show an admission that ran out while its CONNECT was held", () => {
    const hold = (mono: number, socksId: number) => event("socks.hold", mono, { socksId, host: "apiv3.fansly.com" });
    const release = (mono: number, socksId: number) => event("socks.release", mono, { socksId, host: "apiv3.fansly.com" });
    const admission = grant("site", "apiv3.fansly.com/api/v1/a?rid=1", 1000, { deadlineMono: 7000 });
    expect(heldPastDeadline([hold(1200, 7), release(11_200, 7)], [admission], "p1", PAGE_IP, "apiv3.fansly.com")).toEqual([]);
    // Let go before the deadline; held with no admission; no hold at all.
    expect(heldPastDeadline([hold(1200, 7), release(5000, 7)], [admission], "p1", PAGE_IP, "apiv3.fansly.com")).toHaveLength(1);
    expect(heldPastDeadline([hold(9000, 7), release(19_000, 7)], [admission], "p1", PAGE_IP, "apiv3.fansly.com")).toHaveLength(1);
    expect(heldPastDeadline([], [admission], "p1", PAGE_IP, "apiv3.fansly.com")).toEqual([expect.stringContaining("the run proves nothing about the deadline")]);
    // The control's late send: the request arrives when the hold goes, after the journaled deadline.
    expect(unadmittedArrivals([apiRequest(11_300, "GET", "/api/v1/a?rid=1")], [admission], PAGES)).toEqual([expect.stringContaining("arrived outside its admission window")]);
  });

  it("an engine-restart run must show a request that had reached Fansly and was not answered yet", () => {
    const arrived = apiRequest(1000, "GET", "/api/v1/account/me?rid=hub-1&delayMs=8000");
    const answer = (mono: number) => event("res", mono, { req: arrived.seq });
    expect(inFlightAtRestart([arrived, answer(9000)], ["hub-1"], 2000)).toEqual([]);
    expect(inFlightAtRestart([arrived], ["hub-1"], 2000)).toEqual([]);
    // Answered before the restart; arrived only after it; never arrived.
    expect(inFlightAtRestart([arrived, answer(1500)], ["hub-1"], 2000)).toEqual([expect.stringContaining("no request was in flight at the engine's restart")]);
    expect(inFlightAtRestart([arrived], ["hub-1"], 500)).toHaveLength(1);
    expect(inFlightAtRestart([], ["hub-1"], 2000)).toHaveLength(1);
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

const clean = (): Checks => Object.fromEntries(COMMON_CHECKS.map((name) => [name, [] as string[]]));

describe("a run's verdict, from its checks", () => {
  it("an ordinary run passes only with every common check there and no violation anywhere", () => {
    expect(judge(clean(), null).ok).toBe(true);
    expect(judge({ ...clean(), exitClosed: ["never"] }, null).ok).toBe(false);
    const { [COMMON_CHECKS[3]]: _capture, ...withoutCapture } = clean();
    expect(judge(withoutCapture, null)).toEqual({ ok: false, why: [expect.stringContaining('no check "C4')] });
  });

  it("a control passes only when each check it exists for shows its violation, and no other check fails", () => {
    const control: Control = { C1: ["arrived without any admission"] };
    const tripped = { ...clean(), [COMMON_CHECKS[0]]: ["GET x arrived without any admission"] };
    expect(judge(tripped, control).ok).toBe(true);
    expect(judge(clean(), control)).toEqual({ ok: false, why: [expect.stringContaining('did not show "arrived without any admission"')] });
    expect(judge({ ...tripped, [COMMON_CHECKS[3]]: ["traffic past the proxy: …"] }, control)).toEqual({ ok: false, why: [expect.stringContaining("a check the control is not about failed")] });
  });
});

describe("the series' verifier", () => {
  let dir = "";
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  const NAME = "loss-holder-kill";
  const CONTROL = "control-leak";
  const controlOf = (name: string) => SCENARIOS.find((scenario) => scenario.name === name)?.control ?? null;
  const leaked = (): Checks => ({ ...clean(), [COMMON_CHECKS[0]]: ["GET x arrived without any admission", "a socket (ws-1, wss://x) arrived without any admission"], [COMMON_CHECKS[1]]: ["a closed write reached Fansly: POST x"], [COMMON_CHECKS[2]]: ["a forbidden socket message reached Fansly: {}"] });

  /** A scenario's record and run files; `runs` are the run files' own
   *  checks (or a whole run file), `summary` may contradict them. */
  function write(scenario: string, runs: Array<{ checks?: Checks; file?: Partial<RunRecord>; summary?: Partial<ScenarioRecord["runs"][number]> }>, record: Partial<ScenarioRecord> = {}): void {
    mkdirSync(path.join(dir, scenario), { recursive: true });
    const control = controlOf(scenario);
    const entries = runs.map((run, index) => {
      const checks = run.checks ?? clean();
      const file: RunRecord = { scenario, run: index + 1, seed: 7 + index, momentMs: 100 * index, ok: judge(checks, control).ok, invalid: false, violations: violationsOf(checks), checks, notes: {}, startedWall: 1, durationMs: 1, ...run.file };
      writeFileSync(path.join(dir, scenario, `run-${file.run}.json`), JSON.stringify(file));
      return { run: file.run, seed: file.seed, momentMs: file.momentMs, ok: file.ok, invalid: file.invalid, violations: file.violations, ...run.summary };
    });
    const counted = entries.filter((entry) => !entry.invalid);
    const full: ScenarioRecord = { scenario, proves: "", asked: 2, valid: counted.length, passed: counted.filter((entry) => entry.ok).length, failed: counted.filter((entry) => !entry.ok).length, invalid: entries.length - counted.length, skipped: null, control, page: "p1", runs: entries, ...record };
    writeFileSync(path.join(dir, `${scenario}.json`), JSON.stringify(full));
  }

  function series(scenarios: string[], finished: number | null = 2): void {
    dir ||= mkdtempSync(path.join(tmpdir(), "pb-suite-"));
    const record: SeriesRecord = { name: "t", seed: 1, runs: 2, revision: "r", image: "i", startedWall: 1, finishedWall: finished, scenarios };
    writeFileSync(path.join(dir, "series.json"), JSON.stringify(record));
  }

  it("passes a full series: every run's own checks hold, controls show their violations, skips listed apart", () => {
    series([NAME, CONTROL, "site-steady"]);
    write(NAME, [{}, {}]);
    write(CONTROL, [{ checks: leaked() }, { checks: leaked() }]);
    write("site-steady", [], { skipped: "PR 7" });
    const verdict = verifySeries(dir);
    expect(verdict.problems).toEqual([]);
    expect(verdict.skipped).toEqual([{ scenario: "site-steady", why: "PR 7" }]);
    expect(verdict.validRuns).toBe(4);
    expect(verdict.notInSeries).toContain("disk-full");
  });

  it("takes the run file's checks, not the summary's word: a failed run under a green summary does not pass", () => {
    series([NAME]);
    // The run's file holds a C1 violation and ok:false; the record says all passed.
    write(NAME, [{}, { checks: { ...clean(), [COMMON_CHECKS[0]]: ["GET x arrived without any admission"] }, summary: { ok: true, violations: [] } }], { passed: 2, failed: 0 });
    const problems = verifySeries(dir).problems;
    expect(problems).toEqual(expect.arrayContaining([expect.stringContaining(`${NAME} run 2: failed — C1`), expect.stringContaining("the record says ok=true, the run's checks say false"), expect.stringContaining("the record's violations are not the run file's"), expect.stringContaining("the record counts 2 valid, 2 passed, 0 failed; its run files give 2, 1, 1")]));
  });

  it("a run file that calls itself ok over its own violation, or lacks a common check, does not pass", () => {
    series([NAME]);
    const { [COMMON_CHECKS[3]]: _capture, ...withoutCapture } = clean();
    write(NAME, [{ checks: { ...clean(), exitClosed: ["never"] }, file: { ok: true, violations: [] }, summary: { ok: true, violations: [] } }, { checks: withoutCapture, file: { ok: true }, summary: { ok: true } }], { passed: 2, failed: 0 });
    const problems = verifySeries(dir).problems;
    expect(problems).toEqual(expect.arrayContaining([expect.stringContaining("run 1: failed — exitClosed: never"), expect.stringContaining("run 1: its file says ok=true, its checks say false"), expect.stringContaining('run 2: failed — the run has no check "C4')]));
  });

  it("refuses a run counted twice, a run file the record does not name, and a run passed off as not set up", () => {
    series([NAME]);
    write(NAME, [{}, {}]);
    const record = JSON.parse(JSON.stringify({ scenario: NAME, proves: "", asked: 2, valid: 2, passed: 2, failed: 0, invalid: 0, skipped: null, control: null, page: "p1", runs: [] })) as ScenarioRecord;
    const one = { run: 1, seed: 7, momentMs: 0, ok: true, invalid: false, violations: [] };
    record.runs = [one, one];
    writeFileSync(path.join(dir, `${NAME}.json`), JSON.stringify(record));
    expect(verifySeries(dir).problems).toEqual(expect.arrayContaining([expect.stringContaining("run 1 counted more than once"), expect.stringContaining("run file(s) 2 the record does not name"), expect.stringContaining("1 counted runs of 2")]));

    // A failed run marked "not set up" in the record only, and one whose file says so with no setup failure.
    write(NAME, [{ checks: { ...clean(), exitClosed: ["never"] }, summary: { invalid: true } }, { file: { invalid: true } }, {}, {}], { valid: 2, passed: 2, failed: 0, invalid: 2 });
    expect(verifySeries(dir).problems).toEqual(expect.arrayContaining([expect.stringContaining("run 1: the record says not set up, its file says counted"), expect.stringContaining("run 2: marked not set up without a setup failure")]));
    // A run the stand could not set up, by its own file's word: replaced, not counted.
    rmSync(path.join(dir, NAME), { recursive: true });
    write(NAME, [{ checks: { [SETUP_FAILURE]: ["the page did not come up"] }, file: { invalid: true, ok: false } }, {}, {}]);
    expect(verifySeries(dir).problems).toEqual([]);
  });

  it("does not pass a control without its violation, a short scenario, an unknown one, a main scenario skipped, or an unfinished series", () => {
    series([NAME, CONTROL, "loss-chrome-kill", "no-such-scenario", "proxy-down"], null);
    write(NAME, [{}]);
    write(CONTROL, [{ checks: leaked() }, { checks: { ...leaked(), [COMMON_CHECKS[2]]: [] } }]);
    write("loss-chrome-kill", [], { skipped: "not today" });
    expect(verifySeries(dir).problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("did not finish"),
        expect.stringContaining(`${NAME}: 1 counted runs of 2`),
        expect.stringContaining(`${CONTROL} run 2: the control did not do what it exists for`),
        expect.stringContaining("loss-chrome-kill: skipped, and it waits for nothing"),
        expect.stringContaining("no-such-scenario: not a scenario of the stand"),
        expect.stringContaining("proxy-down: no record"),
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
      for (const prefix of Object.keys(scenario.control ?? {})) expect(COMMON_CHECKS.some((name) => name.startsWith(prefix))).toBe(true);
    }
    // Every common criterion a control can trip on the stand has one.
    const tripped = new Set(SCENARIOS.filter((scenario) => scenario.control && scenario.needs.length === 0).flatMap((scenario) => Object.keys(scenario.control!)));
    expect([...tripped].sort()).toEqual(["C1", "C2", "C3", "C4", "C5", "C6", "C7"]);
  });
});

describe("the load test's thresholds", () => {
  const phases = [
    { what: "background", fromMono: 0, toMono: 120_000, perMinute: 246 },
    { what: "burst", fromMono: 120_000, toMono: 180_000, perMinute: 492 },
  ];
  const frames = (page: string, fromMono: number, toMono: number, perMinute: number) => Array.from({ length: Math.round(((toMono - fromMono) / 60_000) * perMinute) }, (_, index) => ({ mono: fromMono + (index * 60_000) / perMinute, page }));

  it("3: every page at the asked rate in every phase — one frame somewhere is not a load", () => {
    const full = ["p1", "p2"].flatMap((page) => [...frames(page, 0, 120_000, 246), ...frames(page, 120_000, 180_000, 492)]);
    expect(frameRates(full, ["p1", "p2"], phases).held).toBe(true);
    expect(frameRates([{ mono: 5, page: "p1" }], ["p1", "p2"], phases)).toMatchObject({ held: false, why: expect.stringContaining("p1 background") });
    // One page starved; a burst that never rose.
    expect(frameRates(full.filter((frame) => frame.page === "p1"), ["p1", "p2"], phases)).toMatchObject({ held: false, why: expect.stringContaining("p2 background 0/min of 246") });
    expect(frameRates(["p1", "p2"].flatMap((page) => frames(page, 0, 180_000, 246)), ["p1", "p2"], phases)).toMatchObject({ held: false, why: expect.stringContaining("burst") });
    expect(frameRates([], ["p1"], phases).held).toBeNull();
  });

  it("7: the outage must leave a backlog on every page, and all of it must be stored, once", () => {
    const during = new Map([["p1", [1, 2, 3]], ["p2", [4, 5]]]);
    expect(outageBacklog(during, ["p1", "p2"], new Set([1, 2, 3, 4, 5]), 0)).toMatchObject({ held: true, backlog: { p1: 3, p2: 2 } });
    expect(outageBacklog(during, ["p1", "p2"], new Set([1, 2, 4, 5]), 0)).toMatchObject({ held: false, lost: 1 });
    expect(outageBacklog(during, ["p1", "p2"], new Set([1, 2, 3, 4, 5]), 1).held).toBe(false);
    // Nothing piled up: an empty buffer "offloads" at once, and shows nothing.
    expect(outageBacklog(new Map(), ["p1", "p2"], new Set(), 0)).toMatchObject({ held: null, why: expect.stringContaining("nothing accumulated during the outage on p1, p2") });
    expect(outageBacklog(new Map([["p1", [1]]]), ["p1", "p2"], new Set([1]), 0).held).toBeNull();
  });

  it("the verdict is never a pass over something that was not measured", () => {
    const threshold = (id: string, held: boolean | null, notOnTheStand = false): Threshold => ({ id, what: "", limit: "", value: null, held, ...(notOnTheStand ? { notOnTheStand } : {}) });
    expect(loadVerdict([threshold("1", true), threshold("9", null, true)], 0).verdict).toBe("PASSED");
    expect(loadVerdict([threshold("1", true), threshold("3", null)], 0)).toMatchObject({ verdict: "INCOMPLETE", notMeasured: ["3"] });
    expect(loadVerdict([threshold("1", true), threshold("7", false), threshold("3", null)], 0)).toMatchObject({ verdict: "FAILED", failed: ["7"] });
    expect(loadVerdict([threshold("1", true)], 1).verdict).toBe("FAILED");
  });
});

describe("the stand's Fansly", () => {
  it("answers to Fansly's own names and the exit-IP service only", () => {
    expect(["fansly.com", "apiv3.fansly.com", "wsv3.fansly.com", "cdn3.fansly.com", "api.ipify.org", "example.com"].map(roleOf)).toEqual(["site", "api", "ws", "cdn", "ipify", null]);
  });

  it("serves a site page whose script parses, says its variant and reports its writes, with a socket authorization of the size the socket gate expects", () => {
    const site = { readEveryMs: 700, writeEveryMs: 2000, socket: true, forbiddenWs: false };
    const html = sitePage(site);
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    expect(() => new vm.Script(script)).not.toThrow();
    expect(script).toContain(`"/stand/hello" + "?variant=" + "${siteVariant(site)}"`);
    expect(script).toContain('"write-failed" : "write-done"');
    // The idle page sends nothing but its own hello.
    const idle = /<script>([\s\S]*)<\/script>/.exec(sitePage(null))?.[1] ?? "";
    expect(() => new vm.Script(idle)).not.toThrow();
    expect(idle).toContain(`"?variant=" + "idle"`);
    expect(idle).not.toMatch(/XMLHttpRequest|WebSocket/);
    expect(Buffer.byteLength(JSON.stringify({ t: 1, d: JSON.stringify({ token: STAND_SESSION.token, v: 3 }) }))).toBe(authorizationBytes(STAND_SESSION.token));
  });

  it("finds the stand's frame number in a socket frame as the browser received it", () => {
    const frame = JSON.stringify({ t: 0, d: JSON.stringify({ standFrame: 12, wsId: "ws-1", pad: "" }) });
    expect(standFrameOf(frame)).toBe(12);
    expect(standFrameOf("p")).toBeNull();
  });
});
