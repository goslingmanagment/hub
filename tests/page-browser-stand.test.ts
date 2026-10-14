import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import { authorizationBytes } from "../apps/page-browser/src/egress/socket-gate.ts";
import { roleOf, sitePage, siteVariant, STAND_SESSION } from "../apps/page-browser/stand/fansly/front.ts";
import type { JournalEvent } from "../apps/page-browser/stand/fansly/journal.ts";
import { captureCovers, captureSeen, parsePacket, pastTheProxy, readyPort, sentinelPorts, type CaptureRules } from "../apps/page-browser/stand/runner/capture.ts";
import {
  closedWriteAttempted,
  closedWrites,
  directArrivals,
  eventsComplete,
  exactlyOnce,
  deadlineRefusal,
  DEADLINE_REFUSAL,
  exitClosedWithin,
  expiredArrivals,
  expiredUnderHold,
  fanslyMade,
  forbiddenSocketMessages,
  frameRates,
  heldAcross,
  inFlightAtRestart,
  lateUnderHold,
  madeAndKept,
  outageBacklog,
  plantedBypass,
  plantedDuplicates,
  plantedLate,
  plantedLeak,
  plantedLostFrames,
  plantedNoCapture,
  plantedRepeat,
  plantedTail,
  plantedUnkeptAnswer,
  sentAfterRecovery,
  stoodBetween,
  stoppedFor,
  unadmittedArrivals,
  upWithin,
  variantLoaded,
  type Kept,
  type OperatorRequestLine,
  type SeenTransition,
  type StoredGap,
} from "../apps/page-browser/stand/runner/criteria.ts";
import type { Grant } from "../apps/page-browser/stand/runner/engine.ts";
import { loadVerdict, type Threshold } from "../apps/page-browser/stand/runner/load.ts";
import { Admissions } from "../apps/page-browser/stand/runner/admissions.ts";
import { SCENARIOS } from "../apps/page-browser/stand/runner/scenarios.ts";
import { rng, runSeed, type RunRecord, type ScenarioRecord, type SeriesRecord } from "../apps/page-browser/stand/runner/series.ts";
import { standFrameOf } from "../apps/page-browser/stand/runner/store.ts";
import { COMMON_CHECKS, judge, SETUP_FAILURE, violationsOf, type Checks, type Control } from "../apps/page-browser/stand/runner/verdict.ts";
import { verifySeries } from "../apps/page-browser/stand/runner/verify.ts";
import type { SiteAdmit } from "../apps/page-browser/src/rpc/protocol.ts";

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

  it("a socket's admission is one socket of its host: the address wsAdmit names is a label — the host alone while CDP has said nothing yet", () => {
    // The operator asked before CDP told of the socket (ws/sockets.ts): the
    // admission names the host only, the socket opens at /?v=3.
    const labelled = [grant("ws", "wss://wsv3.fansly.com/", 400)];
    expect(unadmittedArrivals([socketOpen(500, "ws-1")], labelled, PAGES)).toEqual([]);
    expect(unadmittedArrivals([socketOpen(500, "ws-1"), socketOpen(600, "ws-2")], labelled, PAGES)).toEqual([expect.stringContaining("arrived again under one admission")]);
    expect(unadmittedArrivals([socketOpen(500, "ws-3", { url: "wss://chatws.fansly.com/?v=3" })], labelled, PAGES)).toEqual([expect.stringContaining("arrived without any admission of p1")]);
    expect(unadmittedArrivals([socketOpen(20_000, "ws-4")], labelled, PAGES)).toEqual([expect.stringContaining("outside its admission window")]);
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

  it("C4: a run begins only once the page's capture is seen live — a probe on a port of its own, in a file written to since it was sent", () => {
    // Probes never take a run sentinel's port.
    for (const seed of [0, 1, 19_999, 1_586_229_626]) {
      const { start, end } = sentinelPorts(seed);
      for (const attempt of [0, 1, 9]) expect([start, end]).not.toContain(readyPort(seed, attempt));
      expect(readyPort(seed, 0)).toBeGreaterThanOrEqual(10_000);
      expect(readyPort(seed, 0)).toBeLessThan(20_000);
    }
    const dir = mkdtempSync(path.join(tmpdir(), "pb-suite-capture-"));
    try {
      const sentWall = 1_791_946_336_317;
      const probe = (wall: number, port: number) => `${(wall / 1000).toFixed(6)} eth0  In  IP 10.0.0.20.40123 > 10.0.0.101.${port}: UDP, length 17`;
      const write = (name: string, lines: string[], mtimeWall: number) => {
        writeFileSync(path.join(dir, name), `${lines.join("\n")}\n`);
        utimesSync(path.join(dir, name), mtimeWall / 1000, mtimeWall / 1000);
      };
      // The capture that a run stopped: its last line long before the probe.
      write("old.txt", [probe(sentWall - 8000, 10_001)], sentWall - 7000);
      expect(captureSeen(dir, sentWall, "10.0.0.101", "10.0.0.20", 10_001)).toBe(false);
      // The new tcpdump, not listening yet: its file is there, the probe is not.
      write("new.txt", [], sentWall + 200);
      expect(captureSeen(dir, sentWall, "10.0.0.101", "10.0.0.20", 10_001)).toBe(false);
      // Listening: the probe is in it — and only the probe's own port counts.
      write("new.txt", [probe(sentWall + 300, 10_001)], sentWall + 300);
      expect(captureSeen(dir, sentWall, "10.0.0.101", "10.0.0.20", 10_001)).toBe(true);
      expect(captureSeen(dir, sentWall, "10.0.0.101", "10.0.0.20", 10_002)).toBe(false);
      expect(captureSeen(dir, sentWall, "10.0.0.102", "10.0.0.20", 10_001)).toBe(false);
      expect(captureSeen(path.join(dir, "missing"), sentWall, "10.0.0.101", "10.0.0.20", 10_001)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("an admission that runs out while its request waits for its connection", () => {
  const API = "apiv3.fansly.com";
  // Astra's timeline: admitted at 0 for 300 ms; the host's CONNECT held at 3, let go at 606, closed at 607.
  const admission = grant("site", `${API}/api/v1/a?rid=r1`, 0, { attemptId: 41, ref: "s-1", deadlineMono: 300 });
  const socks = (type: string, mono: number, socksId: number, fields: Record<string, unknown> = {}) => event(type, mono, { socksId, host: API, ...fields });
  const held = [socks("socks.hold", 3, 7), socks("socks.release", 606, 7), socks("socks.closed", 607, 7)];
  // `event` puts the wall clock at 1 000 000 + mono; the operator's journal is in wall time.
  const toWall = (mono: number) => 1_000_000 + mono;
  const ended = (wall: number, result: string, admission = "site request s-1 (attempt 41)"): OperatorRequestLine => ({ at: new Date(wall).toISOString(), method: "GET", host: API, path: "/api/v1/a", admission, decision: "ended", result });
  const found = (events: JournalEvent[], lines: OperatorRequestLine[], grants: Grant[] = [admission]) => expiredUnderHold(events, grants, lines, "p1", PAGE_IP, API, toWall);

  it("the operator's journal names a deadline refusal apart from a page's cancel or a failed tunnel", () => {
    expect(deadlineRefusal(ended(1_000_310, DEADLINE_REFUSAL))).toEqual({ siteRequestId: "s-1", attemptId: 41, atWall: 1_000_310 });
    expect(deadlineRefusal(ended(1_000_310, "the page cancelled the request before its answer: the page stops"))).toBeNull();
    expect(deadlineRefusal(ended(1_000_040, "net::ERR_TUNNEL_CONNECTION_FAILED"))).toBeNull();
    expect(deadlineRefusal({ ...ended(1_000_310, DEADLINE_REFUSAL), decision: "failed" })).toBeNull();
    expect(deadlineRefusal(ended(1_000_310, DEADLINE_REFUSAL, "site request s-1, not admitted"))).toBeNull();
  });

  it("Astra's reproduction: the tunnel cancelled at 40 ms, the SOCKS5 let go after the deadline — the SOCKS5 alone proves nothing", () => {
    // The CONNECT was held across the deadline, by the stand's journal...
    expect(heldAcross(held, PAGE_IP, API, 300)).toEqual([{ socksId: 7, heldMono: 3, endedMono: 606 }]);
    // ...but the operator ended the request at 40 ms, with its tunnel.
    const early = found(held, [ended(1_000_040, "net::ERR_TUNNEL_CONNECTION_FAILED")]);
    expect(early.expired).toEqual([]);
    expect(early.violations).toEqual([expect.stringMatching(/no site request of p1 was refused by the operator for its deadline while a CONNECT was held across it \(1 site request\(s\) .* 1 ended otherwise \(1 × "net::ERR_TUNNEL_CONNECTION_FAILED"\).*\): the run proves nothing about the deadline/)]);
    expect(expiredArrivals(held, early.expired)).toEqual([]);
    // The page's cancel; no word of the operator at all.
    expect(found(held, [ended(1_000_040, "the page cancelled the request before its answer: the page stops")]).violations).toEqual([expect.stringContaining("1 ended otherwise")]);
    expect(found(held, []).violations).toEqual([expect.stringContaining("1 with no end in the operator's journal")]);
  });

  it("counts a journaled deadline refusal of that very request with a CONNECT held across its deadline — and then the request never arrives", () => {
    const refused = [ended(1_000_310, DEADLINE_REFUSAL)];
    const { expired, violations } = found(held, refused);
    expect(violations).toEqual([]);
    expect(expired).toEqual([expect.objectContaining({ attemptId: 41, rid: "r1", deadlineMono: 300, refusedWall: 1_000_310, holds: [{ socksId: 7, heldMono: 3, endedMono: 606 }] })]);
    expect(expiredArrivals(held, expired)).toEqual([]);
    // It arrived after all: the safety half says so (and C1 with it).
    const arrived = [...held, apiRequest(620, "GET", "/api/v1/a?rid=r1")];
    expect(expiredArrivals(arrived, found(arrived, refused).expired)).toEqual([expect.stringContaining("the request r1 (attempt 41, GET) arrived 320 ms after its admission ran out")]);
    expect(unadmittedArrivals(arrived, [admission], PAGES)).toEqual([expect.stringContaining("arrived outside its admission window")]);
  });

  it("nor counts a refusal with no CONNECT held across the deadline, one of another request, one written before the deadline, or a Hub request's", () => {
    const refused = [ended(1_000_310, DEADLINE_REFUSAL)];
    // The hold ended before the deadline: let go, or its connection closed.
    expect(found([socks("socks.hold", 3, 7), socks("socks.release", 200, 7)], refused).violations).toEqual([expect.stringContaining("1 refused with no CONNECT held across their deadline")]);
    expect(found([socks("socks.hold", 3, 7), socks("socks.closed", 100, 7), socks("socks.release", 606, 7)], refused).violations).toEqual([expect.stringContaining("1 refused with no CONNECT held across their deadline")]);
    // Another page's CONNECT.
    expect(found([socks("socks.hold", 3, 7, { from: "10.0.1.102" }), socks("socks.release", 606, 7)], refused).violations).toHaveLength(1);
    // The same attempt under another site request id; the refusal before the deadline.
    expect(found(held, [ended(1_000_310, DEADLINE_REFUSAL, "site request s-9 (attempt 41)")]).violations).toEqual([expect.stringContaining("1 ended otherwise")]);
    expect(found(held, [ended(1_000_020, DEADLINE_REFUSAL)]).violations).toEqual([expect.stringContaining("1 refused before their deadline")]);
    // A Hub admission is no site request: the Hub path journals no end (src/hub-requests/hub.ts).
    expect(found(held, refused, [{ ...admission, kind: "hub" }]).violations).toEqual([expect.stringContaining("(0 site request(s) of p1 admitted")]);
  });

  it("the control's late send: the request arrived after its journaled deadline over the very CONNECT held across it, and C1 calls it late", () => {
    const arrived = [...held, apiRequest(620, "GET", "/api/v1/a?rid=r1", { socksId: 7 })];
    expect(lateUnderHold(arrived, [admission], "p1", PAGE_IP, API, PAGES)).toEqual({ late: [{ rid: "r1", attemptId: 41, lateMs: 320, socksId: 7, violation: "GET apiv3.fansly.com/api/v1/a?rid=r1 arrived outside its admission window (ms after the deadline: 320)" }], violations: [] });
    // Nothing late; late with no hold across the deadline; inside the window.
    expect(lateUnderHold(held, [admission], "p1", PAGE_IP, API, PAGES).violations).toEqual([expect.stringContaining("the control showed no late send")]);
    expect(lateUnderHold([apiRequest(620, "GET", "/api/v1/a?rid=r1", { socksId: 7 })], [admission], "p1", PAGE_IP, API, PAGES).violations).toHaveLength(1);
    expect(lateUnderHold([...held, apiRequest(250, "GET", "/api/v1/a?rid=r1", { socksId: 7 })], [admission], "p1", PAGE_IP, API, PAGES).violations).toHaveLength(1);
  });

  it("a late arrival over another connection does not show the control's late send (Astra's counter-example) — it stays a C1 violation", () => {
    // SOCKS #7 held 10…10 010 ms across a 6 s admission; the request arrives at 14 050 ms over SOCKS #9, which was never held.
    const sixSeconds = grant("site", `${API}/api/v1/a?rid=r1`, 0, { attemptId: 41, ref: "s-1", deadlineMono: 6000 });
    const events = [socks("socks.hold", 10, 7), socks("socks.release", 10_010, 7), socks("socks.connect", 14_000, 9), apiRequest(14_050, "GET", "/api/v1/a?rid=r1", { socksId: 9 })];
    expect(lateUnderHold(events, [sixSeconds], "p1", PAGE_IP, API, PAGES)).toEqual({ late: [], violations: [expect.stringContaining("(1 late over another connection): the control showed no late send")] });
    expect(unadmittedArrivals(events, [sixSeconds], PAGES)).toEqual([expect.stringContaining("arrived outside its admission window")]);
    // An arrival with no SOCKS connection known, likewise.
    expect(lateUnderHold([...events.slice(0, 2), apiRequest(14_050, "GET", "/api/v1/a?rid=r1", { socksId: null })], [sixSeconds], "p1", PAGE_IP, API, PAGES).late).toEqual([]);
    // Over #7 itself, once let go: shown.
    expect(lateUnderHold([...events.slice(0, 2), apiRequest(10_050, "GET", "/api/v1/a?rid=r1", { socksId: 7 })], [sixSeconds], "p1", PAGE_IP, API, PAGES).late).toEqual([expect.objectContaining({ rid: "r1", attemptId: 41, lateMs: 4050, socksId: 7 })]);
  });
});

describe("C7's other half: what Fansly made against what the engine keeps", () => {
  const sent = (mono: number, frame: number, fields: Record<string, unknown> = {}) => event("ws.out", mono, { wsId: "ws-1", frame, t: 0, ...fields });
  const answered = (mono: number, pathWithQuery: string, fields: Record<string, unknown> = {}) => event("res", mono, { role: "api", host: "apiv3.fansly.com", method: "GET", path: pathWithQuery, status: 200, ...fields });
  const kept = (frames: number[], outcomes: number[], gaps: StoredGap[] = [], responses: string[] = []): Kept => ({ frames: new Map([["p1", new Set(frames)]]), outcomes: new Map([["p1", new Set(outcomes)]]), responses: new Map([["p1", new Set(responses)]]), gaps });
  // `event` puts the wall clock at 1 000 000 + mono.
  const gap = (fromWall: number | null, atWall: number, page = "p1"): StoredGap => ({ page, reason: "operator_start", fromWall, atWall });

  it("a tail lost before the engine ever received it: the numbers are whole, Fansly's own record is not", () => {
    // The engine stood at 10, the operator sent nothing after it, nothing after it is stored.
    expect(eventsComplete([{ bufferId: "b", start: 10, wireMax: 10, stored: [] }])).toEqual([]);
    // Meanwhile Fansly sent the page two frames.
    const made = fanslyMade([sent(5000, 101), sent(5500, 102), sent(5600, 103, { from: "10.0.1.20" })], [], PAGES);
    expect(made.frames.map((frame) => [frame.page, frame.frame])).toEqual([["p1", 101], ["p1", 102]]);
    expect(madeAndKept(made, kept([], [])).violations).toEqual(["Fansly sent p1 2 frame(s) on ws-1 that are not stored as ws.in events, and no gap mark covers when they were sent: 101, 102"]);
    expect(madeAndKept(made, kept([101], [])).violations).toEqual([expect.stringContaining("1 frame(s) on ws-1 that are not stored as ws.in events, and no gap mark covers when they were sent: 102")]);
    expect(madeAndKept(made, kept([101, 102], []))).toEqual({ violations: [], coveredByGap: { frames: 0, answers: 0 } });
  });

  it("a gap mark excuses only what lies inside it by time — and what it covers is counted, not let go in silence", () => {
    const made = fanslyMade([sent(5000, 101), sent(5500, 102)], [], PAGES);
    expect(madeAndKept(made, kept([], [], [gap(1_004_900, 1_006_000)]))).toEqual({ violations: [], coveredByGap: { frames: 2, answers: 0 } });
    // Nothing was saved before the mark: its start is unknown, everything before it is under it.
    expect(madeAndKept(made, kept([], [], [gap(null, 1_006_000)])).coveredByGap.frames).toBe(2);
    // The stream broke after the first frame was sent; the mark was written before the second; another page's mark.
    expect(madeAndKept(made, kept([], [], [gap(1_005_400, 1_006_000)]))).toEqual({ violations: [expect.stringContaining("1 frame(s) on ws-1 that are not stored as ws.in events, and no gap mark covers when they were sent: 101")], coveredByGap: { frames: 1, answers: 0 } });
    expect(madeAndKept(made, kept([], [], [gap(1_004_900, 1_005_100)])).violations).toEqual([expect.stringContaining(": 102")]);
    expect(madeAndKept(made, kept([], [], [gap(null, 1_006_000, "p2")])).violations).toEqual([expect.stringContaining("2 frame(s)")]);
  });

  it("every request Fansly answered has its stored outcome: a request the engine has nothing of is missed", () => {
    const admitted = [grant("hub", "apiv3.fansly.com/api/v1/account/me?rid=hub-1", 4000, { attemptId: 7 })];
    const events = [
      apiRequest(4100, "GET", "/api/v1/account/me?rid=hub-1"),
      answered(4200, "/api/v1/account/me?rid=hub-1"),
      // A preflight's answer, and an answer to no page of the stand, are no attempt's.
      answered(4150, "/api/v1/account/me?rid=hub-1", { method: "OPTIONS", status: 204 }),
      answered(4300, "/api/v1/account/me?rid=leak-1", { from: "10.0.1.20" }),
    ];
    const made = fanslyMade(events, admitted, PAGES);
    expect(made.answers).toEqual([expect.objectContaining({ page: "p1", attemptId: 7, target: "apiv3.fansly.com/api/v1/account/me?rid=hub-1", status: 200 })]);
    expect(madeAndKept(made, kept([], [7])).violations).toEqual([]);
    expect(madeAndKept(made, kept([], [])).violations).toEqual(["GET apiv3.fansly.com/api/v1/account/me?rid=hub-1 of p1 was answered by Fansly (200) and has no stored outcome (attempt 7), and no gap mark covers when it was answered"]);
    expect(madeAndKept(made, kept([], [], [gap(1_004_000, 1_005_000)]))).toEqual({ violations: [], coveredByGap: { frames: 0, answers: 1 } });
    // Hub's own request: its outcome is all there is to keep.
    expect(made.answers[0]?.kind).toBe("hub");
    // Answered with no admission of the engine's at all (a control's own grant has no attempt).
    const unowned = fanslyMade(events, [grant("site", "apiv3.fansly.com/api/v1/account/me?rid=hub-1", 4000, { attemptId: 0 })], PAGES);
    expect(madeAndKept(unowned, kept([], [7])).violations).toEqual([expect.stringContaining("was answered by Fansly (200) and has no stored outcome (it is no attempt of the engine's)")]);
  });
});

describe("C7: a site answer is kept twice — its outcome and its site.response event", () => {
  const SITE = "apiv3.fansly.com/api/v1/a?rid=r1";
  const admitted = [grant("site", SITE, 4000, { attemptId: 9 })];
  const journal = [apiRequest(4100, "GET", "/api/v1/a?rid=r1"), event("res", 4200, { role: "api", host: "apiv3.fansly.com", method: "GET", path: "/api/v1/a?rid=r1", status: 200 })];
  const kept = (outcomes: number[], responses: string[], gaps: StoredGap[] = []): Kept => ({ frames: new Map(), outcomes: new Map([["p1", new Set(outcomes)]]), responses: new Map([["p1", new Set(responses)]]), gaps });

  it("the outcome stored, the answer's event lost before the engine had it: C6 and the numbers hold, and C7 does not (Astra's counter-example)", () => {
    const made = fanslyMade(journal, admitted, PAGES);
    expect(made.answers).toEqual([expect.objectContaining({ kind: "site", rid: "r1", attemptId: 9 })]);
    // siteDone committed once; the buffer's numbers: the engine stood at 10, nothing came after it.
    expect(exactlyOnce([{ attemptId: 9, outcomes: [{ attemptId: 9, run: "r", type: "siteDone", kind: "response", sent: true, committedMono: 4300 }], recovered: null, arrived: true }])).toEqual([]);
    expect(eventsComplete([{ bufferId: "b", start: 10, wireMax: 10, stored: [] }])).toEqual([]);
    expect(madeAndKept(made, kept([9], [])).violations).toEqual(["GET apiv3.fansly.com/api/v1/a?rid=r1 of p1 was answered by Fansly (200) and has no stored site.response event (rid r1), and no gap mark covers when it was answered"]);
  });

  it("both kept — the event complete or marked incomplete — holds; either one missing does not; a gap over it is counted", () => {
    const made = fanslyMade(journal, admitted, PAGES);
    expect(madeAndKept(made, kept([9], ["r1"])).violations).toEqual([]);
    expect(madeAndKept(made, kept([], ["r1"])).violations).toEqual([expect.stringContaining("has no stored outcome (attempt 9), and no gap mark")]);
    expect(madeAndKept(made, kept([], [])).violations).toEqual([expect.stringContaining("has no stored outcome (attempt 9) and no stored site.response event (rid r1)")]);
    // Another request's event is not this one's.
    expect(madeAndKept(made, kept([9], ["r2"])).violations).toHaveLength(1);
    expect(madeAndKept(made, kept([9], [], [{ page: "p1", reason: "operator_start", fromWall: 1_004_000, atWall: 1_004_500 }]))).toEqual({ violations: [], coveredByGap: { frames: 0, answers: 1 } });
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

  it("a control passes only when each check it exists for shows the violations its run planted — those and no others —, and no other check fails", () => {
    const control: Control = { C1: ["arrived without any admission"] };
    const planted = [{ check: "C1", phrase: "arrived without any admission", subject: ["GET x"], min: 1, max: 1 }];
    const tripped = { ...clean(), [COMMON_CHECKS[0]]: ["GET x arrived without any admission"] };
    expect(judge(tripped, control, planted).ok).toBe(true);
    expect(judge(clean(), control, planted).why).toEqual(expect.arrayContaining([expect.stringContaining('did not show "arrived without any admission"')]));
    expect(judge({ ...tripped, [COMMON_CHECKS[3]]: ["traffic past the proxy: …"] }, control, planted)).toEqual({ ok: false, why: [expect.stringContaining("a check the control is not about failed")] });
    // The same phrase about something it did not plant; the planted one twice; a run that names nothing.
    expect(judge({ ...clean(), [COMMON_CHECKS[0]]: ["GET x arrived without any admission", "GET y arrived without any admission"] }, control, planted)).toEqual({ ok: false, why: [expect.stringContaining("a violation the control did not plant — C1 no request or socket without an admission in force: GET y")] });
    expect(judge({ ...clean(), [COMMON_CHECKS[0]]: ["GET x arrived without any admission", "GET x arrived without any admission"] }, control, planted).why).toEqual([expect.stringContaining("showed 2 time(s) in C1, expected 1")]);
    expect(judge(tripped, control).why).toEqual(expect.arrayContaining([expect.stringContaining("named nothing it planted")]));
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
  const leakJournal = [
    apiRequest(1, "GET", "/api/v1/account/me?rid=leak-1", { from: "10.0.1.20" }),
    apiRequest(2, "POST", "/api/v1/message/ack?rid=leak-1", { from: "10.0.1.20" }),
    socketOpen(3, "ws-1", { from: "10.0.1.20" }),
    event("ws.in", 4, { from: "10.0.1.20", text: JSON.stringify({ t: 46001, d: JSON.stringify({ chatRoomId: "leak-1" }) }) }),
  ];
  const leaked = (): Checks => ({ ...clean(), [COMMON_CHECKS[0]]: unadmittedArrivals(leakJournal, [], PAGES), [COMMON_CHECKS[1]]: closedWrites(leakJournal), [COMMON_CHECKS[2]]: forbiddenSocketMessages(leakJournal) });
  const leakPlanted = plantedLeak("leak-1");

  /** A scenario's record and run files; `runs` are the run files' own
   *  checks (or a whole run file), `summary` may contradict them. */
  function write(scenario: string, runs: Array<{ checks?: Checks; file?: Partial<RunRecord>; summary?: Partial<ScenarioRecord["runs"][number]> }>, record: Partial<ScenarioRecord> = {}): void {
    mkdirSync(path.join(dir, scenario), { recursive: true });
    const control = controlOf(scenario);
    const entries = runs.map((run, index) => {
      const checks = run.checks ?? clean();
      const planted = control ? leakPlanted : undefined;
      const file: RunRecord = { scenario, run: index + 1, seed: 7 + index, momentMs: 100 * index, ok: judge(checks, control, planted ?? null).ok, invalid: false, violations: violationsOf(checks), checks, ...(planted ? { planted } : {}), notes: {}, startedWall: 1, durationMs: 1, ...run.file };
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
    series([NAME, CONTROL, "control-bypass", "loss-chrome-kill", "no-such-scenario", "proxy-down"], null);
    write(NAME, [{}]);
    write(CONTROL, [{ checks: leaked() }, { checks: { ...leaked(), [COMMON_CHECKS[2]]: [] } }]);
    // A control's run file that names nothing it planted does not pass either.
    write("control-bypass", [{ checks: { ...clean(), [COMMON_CHECKS[3]]: ["traffic past the proxy: x"], [COMMON_CHECKS[4]]: ["a connection past the proxy reached the stand directly from x"] }, file: { planted: [] } }]);
    write("loss-chrome-kill", [], { skipped: "not today" });
    expect(verifySeries(dir).problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("did not finish"),
        expect.stringContaining(`${NAME}: 1 counted runs of 2`),
        expect.stringContaining(`${CONTROL} run 2: the control did not do what it exists for`),
        expect.stringContaining("control-bypass run 1: the control did not do what it exists for — the control's run named nothing it planted"),
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

describe("the stand's engine admits as main's engine does: one operation in flight (admissions.ts)", () => {
  // A clock and timers of the test's own: the admissions are driven step by
  // step.
  const harness = (options: { paceMs?: number; endWaitMs?: number } = {}) => {
    let now = 1000;
    const timers: Array<{ at: number; run: () => void } | null> = [];
    const admitted: string[] = [];
    const refused: Array<{ id: string; reason: string }> = [];
    const over: string[] = [];
    let attempts = 0;
    const admissions = new Admissions({
      now: () => now,
      paceMs: options.paceMs ?? 2500,
      endWaitMs: options.endWaitMs ?? 60_000,
      issue: () => Promise.resolve(++attempts),
      admit: (request) => admitted.push(request.siteRequestId),
      refuse: (request, reason) => refused.push({ id: request.siteRequestId, reason }),
      endWaitOver: (what) => over.push(what),
      setTimer: (run, ms) => timers.push({ at: now + ms, run }) - 1,
      clearTimer: (index) => {
        timers[index as number] = null;
      },
    });
    const ask = (id: string, waitMs = 60_000): SiteAdmit => {
      const request: SiteAdmit = { type: "siteAdmit", siteRequestId: id, method: "GET", host: "apiv3.fansly.com", path: "/api/v1/account/me", query: "", resourceType: "XHR", route: "account.me", operation: "read", sessionFingerprint: null, pausedMono: now, waitDeadlineMono: now + waitMs };
      admissions.ask(request);
      return request;
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const advance = async (ms: number) => {
      now += ms;
      for (let index = 0; index < timers.length; index++) {
        const timer = timers[index];
        if (timer && timer.at <= now) {
          timers[index] = null;
          timer.run();
        }
      }
      await settle();
    };
    return { admissions, ask, admitted, refused, over, settle, advance };
  };

  it("one operation in flight, a Hub request or a site request alike: neither goes while the other waits for its end", async () => {
    const { admissions, ask, admitted, settle, advance } = harness();
    const hub = admissions.takeHub();
    expect(hub).not.toBeNull();
    hub!.bind(7);
    ask("site-1");
    await settle();
    // The Hub request is in flight: the site waits, and so does a second Hub.
    expect(admitted).toEqual([]);
    expect(admissions.takeHub()).toBeNull();
    // Its result: sent. The pace, then the site's turn.
    admissions.hubDone(7, true);
    await settle();
    expect(admitted).toEqual([]);
    await advance(2500);
    expect(admitted).toEqual(["site-1"]);
    // The site request in flight: no Hub request goes beside it.
    await advance(5000);
    expect(admissions.takeHub()).toBeNull();
    admissions.done("site-1", true);
    await advance(2500);
    expect(admissions.takeHub()).not.toBeNull();
  });

  it("Hub and site take turns while both wait", async () => {
    const { admissions, ask, admitted, settle, advance } = harness({ paceMs: 0 });
    for (const id of ["s1", "s2", "s3"]) ask(id);
    await settle();
    expect(admitted).toEqual(["s1"]);
    // The Hub request wants its turn: s1 ends, the Hub goes before s2.
    expect(admissions.takeHub()).toBeNull();
    admissions.done("s1", true);
    await settle();
    expect(admitted).toEqual(["s1"]);
    const hub = admissions.takeHub();
    expect(hub).not.toBeNull();
    hub!.bind(1);
    // The Hub's end: the site's turn, not a second Hub request's.
    admissions.hubDone(1, true);
    expect(admissions.takeHub()).toBeNull();
    await advance(0);
    expect(admitted).toEqual(["s1", "s2"]);
  });

  it("a request that never left sets no pace: what a restarted browser left behind is cleared at once, not one pace each", async () => {
    const { admissions, ask, admitted, settle, advance } = harness();
    for (const id of ["old-1", "old-2", "old-3", "new"]) ask(id);
    for (const id of ["old-1", "old-2", "old-3"]) {
      await settle();
      expect(admitted.at(-1)).toBe(id);
      // The operator: "not used: its request had ended" — nothing left.
      admissions.done(id, false);
    }
    await settle();
    expect(admitted).toEqual(["old-1", "old-2", "old-3", "new"]);
    // A request that may have left: the next one waits for the pace.
    admissions.done("new", true);
    ask("next");
    await settle();
    expect(admitted).not.toContain("next");
    await advance(2499);
    expect(admitted).not.toContain("next");
    await advance(1);
    expect(admitted.at(-1)).toBe("next");
  });

  it("an id is admitted once; what a connection that went asked and was not answered is dropped, and taken again when asked again", async () => {
    const { admissions, ask, admitted, settle } = harness();
    ask("a");
    ask("a");
    ask("b");
    await settle();
    expect(admitted).toEqual(["a"]);
    // The connection goes: "b" (asked, not answered) is dropped; "a" is in
    // flight and its end still counts.
    admissions.linkGone();
    admissions.done("a", false);
    await settle();
    expect(admitted).toEqual(["a"]);
    expect(admissions.waiting()).toEqual([]);
    // The operator asks again on the next connection: "a" ended, "b" not.
    ask("a");
    ask("b");
    await settle();
    expect(admitted).toEqual(["a", "b"]);
  });

  it("held between runs, and before the operator's quiesced: nothing is admitted; what waits is taken up after — refused when its wait is over", async () => {
    const { admissions, ask, admitted, refused, settle, advance } = harness();
    admissions.hold(true);
    ask("short", 1000);
    ask("long");
    await settle();
    expect(admitted).toEqual([]);
    expect(admissions.takeHub()).toBeNull();
    await advance(1500);
    expect(admitted).toEqual([]);
    // A new owner: nothing before quiesced either.
    admissions.ready(false);
    admissions.hold(false);
    await settle();
    expect(admitted).toEqual([]);
    admissions.ready(true);
    await settle();
    expect(refused).toEqual([{ id: "short", reason: "wait_expired" }]);
    expect(admitted).toEqual(["long"]);
  });

  it("an operation whose end never comes frees the place after the end wait, as one that may have left", async () => {
    const { admissions, ask, admitted, over, settle, advance } = harness({ endWaitMs: 60_000 });
    ask("lost");
    ask("next", 120_000);
    await settle();
    expect(admitted).toEqual(["lost"]);
    await advance(59_999);
    expect(admitted).toEqual(["lost"]);
    await advance(1);
    expect(over).toEqual(["site request lost"]);
    // It may have left: the pace holds the next one.
    expect(admitted).toEqual(["lost"]);
    await advance(2500);
    expect(admitted).toEqual(["lost", "next"]);
    // An end that comes late changes nothing.
    admissions.done("lost", true);
    expect(admissions.waiting().map((request) => request.siteRequestId)).toEqual(["next"]);
  });
});

describe("each control passes only with the very violations its run planted — a false positive or a real violation never hides in it", () => {
  const controlOf = (name: string): Control => SCENARIOS.find((scenario) => scenario.name === name)!.control!;
  const checksOf = (found: Record<number, string[]>): Checks => {
    const checks = clean();
    for (const [index, violations] of Object.entries(found)) checks[COMMON_CHECKS[Number(index)]!] = violations;
    return checks;
  };
  const C1 = 0;
  const C2 = 1;
  const C3 = 2;
  const C4 = 3;
  const C5 = 4;
  const C6 = 5;
  const C7 = 6;
  const unplanted = (verdict: { ok: boolean; why: string[] }) => {
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toEqual(expect.arrayContaining([expect.stringContaining("a violation the control did not plant")]));
  };
  const API = "apiv3.fansly.com";
  const socks = (type: string, mono: number, socksId: number) => event(type, mono, { socksId, host: API });

  it("control-site-late-send: exactly the late send over the held CONNECT (its request, its deadline) — another late request, or a socket C1 calls late, fails it", () => {
    const hub = grant("hub", `${API}/api/v1/account/me?rid=hub-1`, 0, { attemptId: 41, ref: "41", deadlineMono: 6000 });
    const journal = [socks("socks.hold", 10, 7), socks("socks.release", 10_010, 7), apiRequest(10_040, "OPTIONS", "/api/v1/account/me?rid=hub-1", { socksId: 7 })];
    const shown = lateUnderHold(journal, [hub], "p1", PAGE_IP, API, PAGES);
    const planted = plantedLate(shown.late);
    const control = controlOf("control-site-late-send");
    expect(judge(checksOf({ [C1]: unadmittedArrivals(journal, [hub], PAGES) }), control, planted)).toEqual({ ok: true, why: [] });
    // The false positive of stand t9: a socket admitted under a label C1 once took for late.
    const socketGrant = grant("ws", SOCKET, 0, { attemptId: 42, deadlineMono: 6000 });
    unplanted(judge(checksOf({ [C1]: unadmittedArrivals([...journal, socketOpen(12_000, "ws-9")], [hub, socketGrant], PAGES) }), control, planted));
    // Another request late — the same phrase, not the planted send.
    const other = grant("hub", `${API}/api/v1/account/me?rid=hub-2`, 0, { attemptId: 43, ref: "43", deadlineMono: 6000 });
    unplanted(judge(checksOf({ [C1]: unadmittedArrivals([...journal, apiRequest(10_500, "GET", "/api/v1/account/me?rid=hub-2", { socksId: 8 })], [hub, other], PAGES) }), control, planted));
    // No late send found: nothing planted, the control fails.
    expect(judge(checksOf({ [C1]: unadmittedArrivals(journal, [hub], PAGES) }), control, plantedLate([])).ok).toBe(false);
  });

  it("control-held-late: the lever's late request and its unkept answer — another unkept answer fails it", () => {
    const site = grant("site", `${API}/api/v1/account/me?rid=held-1`, 0, { attemptId: 0, ref: "held-1", deadlineMono: 6000 });
    const journal = [socks("socks.hold", 10, 7), socks("socks.release", 10_010, 7), apiRequest(10_040, "GET", "/api/v1/account/me?rid=held-1", { socksId: 7 }), event("res", 10_060, { role: "api", host: API, method: "GET", path: "/api/v1/account/me?rid=held-1", status: 200, socksId: 7 })];
    const planted = [...plantedLate(lateUnderHold(journal, [site], "p1", PAGE_IP, API, PAGES).late), ...plantedUnkeptAnswer("p1", "held-1")];
    const kept: Kept = { frames: new Map(), outcomes: new Map(), responses: new Map(), gaps: [] };
    const c7 = (events: JournalEvent[], grants: Grant[]) => madeAndKept(fanslyMade(events, grants, PAGES), kept).violations;
    const control = controlOf("control-held-late");
    expect(judge(checksOf({ [C1]: unadmittedArrivals(journal, [site], PAGES), [C7]: c7(journal, [site]) }), control, planted)).toEqual({ ok: true, why: [] });
    const hub = grant("hub", `${API}/api/v1/account/me?rid=hub-5`, 9000, { attemptId: 5 });
    const more = [...journal, apiRequest(9100, "GET", "/api/v1/account/me?rid=hub-5"), event("res", 9200, { role: "api", host: API, method: "GET", path: "/api/v1/account/me?rid=hub-5", status: 200 })];
    unplanted(judge(checksOf({ [C1]: unadmittedArrivals(more, [site, hub], PAGES), [C7]: c7(more, [site, hub]) }), control, planted));
  });

  it("control-leak: its own read, write, socket and message — the page's own unadmitted request, closed write or forbidden message fails it", () => {
    const runner = "10.0.1.20";
    const journal = [
      apiRequest(1, "GET", "/api/v1/account/me?rid=leak-1", { from: runner }),
      apiRequest(2, "POST", "/api/v1/message/ack?rid=leak-1", { from: runner }),
      socketOpen(3, "ws-1", { from: runner }),
      event("ws.in", 4, { from: runner, text: JSON.stringify({ t: 46001, d: JSON.stringify({ chatRoomId: "leak-1" }) }) }),
    ];
    const checks = (events: JournalEvent[]) => checksOf({ [C1]: unadmittedArrivals(events, [], PAGES), [C2]: closedWrites(events), [C3]: forbiddenSocketMessages(events) });
    const control = controlOf("control-leak");
    const planted = plantedLeak("leak-1");
    expect(judge(checks(journal), control, planted)).toEqual({ ok: true, why: [] });
    unplanted(judge(checks([...journal, apiRequest(5, "GET", "/api/v1/account/me?rid=page-1")]), control, planted));
    unplanted(judge(checks([...journal, apiRequest(6, "POST", "/api/v1/message/ack?rid=page-2", { from: runner })]), control, planted));
    unplanted(judge(checks([...journal, event("ws.in", 7, { text: JSON.stringify({ t: 46001, d: JSON.stringify({ chatRoomId: "page" }) }) })]), control, planted));
  });

  it("control-bypass: the one connection to the SOCKS5's address on 443 — any other packet past the proxy, or another direct arrival, fails it", () => {
    const rules: CaptureRules = { pageIps: ["10.0.0.101", PAGE_IP], socks: { ip: "10.0.1.10", port: 1080 }, engineIp: "10.0.0.20", rpcPort: 7700 };
    const lines = ["1791922007.0 eth1  Out IP 10.0.1.101.55030 > 10.0.1.10.443: Flags [S], seq 2, length 0", "1791922007.1 eth1  Out IP 10.0.1.101.55030 > 10.0.1.10.443: Flags [P.], length 15"];
    const c4 = (more: string[] = []) => pastTheProxy([...lines, ...more].map((line) => parsePacket(line)!), rules);
    const control = controlOf("control-bypass");
    const planted = plantedBypass(PAGE_IP, "10.0.1.10");
    const direct = directArrivals([event("direct.connect", 1, { from: PAGE_IP })]);
    expect(judge(checksOf({ [C4]: c4(), [C5]: direct }), control, planted)).toEqual({ ok: true, why: [] });
    unplanted(judge(checksOf({ [C4]: c4(["1791922007.2 eth1  Out IP 10.0.1.101.5555 > 8.8.8.8.53: UDP, length 30"]), [C5]: direct }), control, planted));
    unplanted(judge(checksOf({ [C4]: c4(), [C5]: [...direct, ...directArrivals([event("direct.connect", 2, { from: "10.0.1.102" })])] }), control, planted));
  });

  it("control-no-capture: the page's own capture gone — traffic past the proxy fails it", () => {
    const ports = sentinelPorts(99);
    const sentinel = `1791922010.1 eth0  In  IP 10.0.0.20.40123 > 10.0.0.101.${ports.start}: UDP, length 17`;
    const c4 = captureCovers([parsePacket(sentinel)!], "10.0.0.101", "10.0.0.20", [ports.start, ports.end]);
    const control = controlOf("control-no-capture");
    const planted = plantedNoCapture("10.0.0.101");
    expect(judge(checksOf({ [C4]: c4 }), control, planted)).toEqual({ ok: true, why: [] });
    unplanted(judge(checksOf({ [C4]: [...c4, "traffic past the proxy: 1791922011 eth1  Out IP 10.0.1.101.1 > 10.0.1.10.443"] }), control, planted));
  });

  it("control-double-open: the lever's second socket only — a third socket, or one outside any window, fails it", () => {
    const sockets = [grant("ws", SOCKET, 400)];
    const control = controlOf("control-double-open");
    const planted = plantedRepeat("ws-2");
    const c1 = (events: JournalEvent[]) => checksOf({ [C1]: unadmittedArrivals(events, sockets, PAGES) });
    expect(judge(c1([socketOpen(500, "ws-1"), socketOpen(600, "ws-2")]), control, planted)).toEqual({ ok: true, why: [] });
    unplanted(judge(c1([socketOpen(500, "ws-1"), socketOpen(600, "ws-2"), socketOpen(700, "ws-3")]), control, planted));
    unplanted(judge(c1([socketOpen(500, "ws-1"), socketOpen(600, "ws-2"), socketOpen(30_000, "ws-4")]), control, planted));
  });

  it("control-duplicate: its own attempts committed twice — another attempt's duplicate, or a missing outcome, fails it", () => {
    const row = (attemptId: number) => ({ attemptId, run: "r", type: "result", kind: "transport_error", sent: false, committedMono: 1 });
    const control = controlOf("control-duplicate");
    const planted = plantedDuplicates([3, 4, 5]);
    const c6 = (extra: Array<Parameters<typeof exactlyOnce>[0][number]> = []) => checksOf({ [C6]: exactlyOnce([{ attemptId: 3, outcomes: [row(3), row(3)], recovered: null, arrived: false }, { attemptId: 4, outcomes: [row(4)], recovered: null, arrived: false }, ...extra]) });
    expect(judge(c6(), control, planted)).toEqual({ ok: true, why: [] });
    unplanted(judge(c6([{ attemptId: 9, outcomes: [row(9), row(9)], recovered: null, arrived: false }]), control, planted));
    unplanted(judge(c6([{ attemptId: 5, outcomes: [], recovered: null, arrived: false }]), control, planted));
  });

  it("control-hole: exactly the tail its engine acknowledged and lost — a hole in the middle, or more of the tail lost, fails it", () => {
    const control = controlOf("control-hole");
    const planted = plantedTail("b", [14]);
    expect(judge(checksOf({ [C7]: eventsComplete([{ bufferId: "b", start: 10, wireMax: 14, stored: [11, 12, 13] }]) }), control, planted)).toEqual({ ok: true, why: [] });
    unplanted(judge(checksOf({ [C7]: eventsComplete([{ bufferId: "b", start: 10, wireMax: 14, stored: [11, 13] }]) }), control, planted));
    unplanted(judge(checksOf({ [C7]: eventsComplete([{ bufferId: "b", start: 10, wireMax: 14, stored: [11, 12] }]) }), control, planted));
  });

  it("control-lost-frames: the frames pushed into the lever's socket and the lever's site answer — another socket's lost frames fail it", () => {
    const sent = (mono: number, frame: number, wsId: string) => event("ws.out", mono, { wsId, frame, t: 0 });
    const site = grant("site", `${API}/api/v1/account/me?rid=lost-1`, 4000, { attemptId: 9, ref: "lost-1" });
    const journal = [sent(5000, 101, "ws-5"), sent(5100, 102, "ws-5"), sent(5200, 103, "ws-5"), apiRequest(4100, "GET", "/api/v1/account/me?rid=lost-1"), event("res", 4200, { role: "api", host: API, method: "GET", path: "/api/v1/account/me?rid=lost-1", status: 200 })];
    const kept: Kept = { frames: new Map([["p1", new Set<number>()]]), outcomes: new Map([["p1", new Set([9])]]), responses: new Map([["p1", new Set<string>()]]), gaps: [] };
    const c7 = (events: JournalEvent[]) => checksOf({ [C7]: madeAndKept(fanslyMade(events, [site], PAGES), kept).violations });
    const control = controlOf("control-lost-frames");
    const planted = plantedLostFrames("p1", "ws-5", 3, "lost-1");
    expect(judge(c7(journal), control, planted)).toEqual({ ok: true, why: [] });
    unplanted(judge(c7([...journal, sent(5300, 104, "ws-6")]), control, planted));
    // Fewer frames lost than pushed: not the planted event either.
    expect(judge(c7(journal.slice(1)), control, planted).ok).toBe(false);
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
