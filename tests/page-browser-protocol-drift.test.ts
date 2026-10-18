import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import * as Operator from "../apps/page-browser/src/rpc/protocol.ts";
import { STEPS as OPERATOR_STEPS, STOP_REASONS as OPERATOR_STOP_REASONS } from "../apps/page-browser/src/state/steps.ts";
import * as Engine from "../apps/runtime/src/services/egress/page-browser-protocol.ts";

// The engine speaks the operator's protocol from a mirror of its types
// (`services/egress/page-browser-protocol.ts`): the engine never loads the
// page-browser app, which is built and shipped apart with Chrome. This test is
// what keeps the mirror the same as `apps/page-browser/src/rpc/protocol.ts`:
// every message type both ways equal as types (checked by `pnpm typecheck` —
// a difference fails it), the same version, enumerations and parameters, the
// same body frames, and each side's parser taking what the other sends.

/** True only when A and B are the same type (no assignability slack). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

interface Pairs {
  monoMs: [Engine.MonoMs, Operator.MonoMs];
  bodyRef: [Engine.BodyRef, Operator.BodyRef];
  mode: [Engine.Mode, Operator.Mode];
  responseSource: [Engine.ResponseSource, Operator.ResponseSource];
  refusal: [Engine.Refusal, Operator.Refusal];
  admit: [Engine.Admit, Operator.Admit];
  fromEngine: [Engine.FromEngine, Operator.FromEngine];
  operatorParams: [Engine.OperatorParams, Operator.OperatorParams];
  step: [Engine.Step, Operator.Step];
  stopReason: [Engine.StopReason, Operator.StopReason];
  hello: [Engine.Hello, Operator.Hello];
  helloResult: [Engine.HelloResult, Operator.HelloResult];
  quiesced: [Engine.Quiesced, Operator.Quiesced];
  selfTestMechanism: [Engine.SelfTestMechanism, Operator.SelfTestMechanism];
  hubSendBlock: [Engine.HubSendBlock, Operator.HubSendBlock];
  crashDumpCount: [Engine.CrashDumpCount, Operator.CrashDumpCount];
  state: [Engine.State, Operator.State];
  pingPong: [Engine.PingPong, Operator.PingPong];
  send: [Engine.Send, Operator.Send];
  check: [Engine.Check, Operator.Check];
  checkResult: [Engine.CheckResult, Operator.CheckResult];
  sent: [Engine.Sent, Operator.Sent];
  result: [Engine.Result, Operator.Result];
  resultAck: [Engine.ResultAck, Operator.ResultAck];
  recover: [Engine.Recover, Operator.Recover];
  recoverResult: [Engine.RecoverResult, Operator.RecoverResult];
  admissionCancel: [Engine.AdmissionCancel, Operator.AdmissionCancel];
  siteAdmit: [Engine.SiteAdmit, Operator.SiteAdmit];
  siteAdmitResult: [Engine.SiteAdmitResult, Operator.SiteAdmitResult];
  siteDone: [Engine.SiteDone, Operator.SiteDone];
  wsAdmit: [Engine.WsAdmit, Operator.WsAdmit];
  wsAdmitResult: [Engine.WsAdmitResult, Operator.WsAdmitResult];
  wsDone: [Engine.WsDone, Operator.WsDone];
  siteSent: [Engine.SiteSent, Operator.SiteSent];
  siteEnded: [Engine.SiteEnded, Operator.SiteEnded];
  siteIdentity: [Engine.SiteIdentity, Operator.SiteIdentity];
  eventsSubscribe: [Engine.EventsSubscribe, Operator.EventsSubscribe];
  events: [Engine.Events, Operator.Events];
  ack: [Engine.Ack, Operator.Ack];
  eventsRefused: [Engine.EventsRefused, Operator.EventsRefused];
  bufferEvent: [Engine.BufferEvent, Operator.BufferEvent];
  commandKind: [Engine.CommandKind, Operator.CommandKind];
  command: [Engine.Command, Operator.Command];
  commandResult: [Engine.CommandResult, Operator.CommandResult];
  alarmKind: [Engine.AlarmKind, Operator.AlarmKind];
  alarm: [Engine.Alarm, Operator.Alarm];
  engineToOperator: [Engine.EngineToOperator, Operator.EngineToOperator];
  operatorToEngine: [Engine.OperatorToEngine, Operator.OperatorToEngine];
  loginScreen: [Engine.LoginScreen, Operator.LoginScreen];
  loginRequest: [Engine.LoginRequest, Operator.LoginRequest];
  loginReply: [Engine.LoginReply, Operator.LoginReply];
}

// A type that drifted makes its `true` here a type error (`pnpm typecheck`).
const SAME_TYPES: { [K in keyof Pairs]: Equal<Pairs[K][0], Pairs[K][1]> } = {
  monoMs: true,
  bodyRef: true,
  mode: true,
  responseSource: true,
  refusal: true,
  admit: true,
  fromEngine: true,
  operatorParams: true,
  step: true,
  stopReason: true,
  hello: true,
  helloResult: true,
  quiesced: true,
  selfTestMechanism: true,
  hubSendBlock: true,
  crashDumpCount: true,
  state: true,
  pingPong: true,
  send: true,
  check: true,
  checkResult: true,
  sent: true,
  result: true,
  resultAck: true,
  recover: true,
  recoverResult: true,
  admissionCancel: true,
  siteAdmit: true,
  siteAdmitResult: true,
  siteDone: true,
  wsAdmit: true,
  wsAdmitResult: true,
  wsDone: true,
  siteSent: true,
  siteEnded: true,
  siteIdentity: true,
  eventsSubscribe: true,
  events: true,
  ack: true,
  eventsRefused: true,
  bufferEvent: true,
  commandKind: true,
  command: true,
  commandResult: true,
  alarmKind: true,
  alarm: true,
  engineToOperator: true,
  operatorToEngine: true,
  loginScreen: true,
  loginRequest: true,
  loginReply: true,
};

const FP = "a".repeat(64);
const UUID = "0b8d3f0e-6a1c-4c2e-9f3a-7d5e1b2c4a6f";

const STATE: Operator.State = {
  type: "state",
  step: "exit_open",
  stopReason: null,
  retryAtWall: null,
  exitOpen: true,
  mode: "automation",
  sessionFingerprint: FP,
  accountId: "1",
  exitIp: "203.0.113.7",
  chromeVersion: "155.0",
  operatorVersion: "1",
  buffer: { bytes: 10, oldestAgeMs: 5 },
  selfTest: { ok: true, atWall: 1, failed: null, notInstalled: ["policies"] },
};

/** One of every message the operator sends, as its types build them. */
const FROM_OPERATOR: Operator.OperatorToEngine[] = [
  { type: "helloResult", ok: true, protocol: { major: 1, minor: 0 }, bufferId: UUID, state: STATE },
  { type: "helloResult", ok: false, reason: "protocol_major", supportedMajors: [1] },
  { type: "quiesced", previousGeneration: 3, lastSendMono: 12.5, lastSendWall: null },
  { ...STATE, stopReason: "request_unended", sessionFingerprint: null, selfTest: null },
  // What the open buffer holds (PR 14) — and a buffer that cannot be opened,
  // which a `stopPage` shows with another stop reason and 0 bytes.
  { ...STATE, buffer: { bytes: 10, oldestAgeMs: 5, open: { id: UUID, lastSeq: 41, outcomes: 2, pending: 1 } } },
  { ...STATE, stopReason: "owner_stop", exitOpen: false, buffer: { bytes: 0, oldestAgeMs: 0, open: null } },
  // Minor 5: whether a Hub request can go now, and Chrome's crash dumps counted.
  { ...STATE, hubSend: { allowed: true, reason: null, sinceWall: null }, crashDumps: null },
  {
    ...STATE,
    step: "ready",
    hubSend: { allowed: false, reason: "header_parity", sinceWall: 1_700_000_000_000 },
    crashDumps: { completed: { count: 25, newestAtWall: 1_699_999_000_000 }, pending: { count: 0, newestAtWall: null }, countedAtWall: 1_700_000_000_500 },
  },
  { type: "ping", n: 1 },
  { type: "pong", n: 2 },
  { type: "check", attemptId: 9, pausedMono: 100.25, liveSessionFingerprint: FP },
  { type: "sent", attemptId: 9, sentMono: 101.5, sentWall: 1_700_000_000_000, connectionReused: false },
  {
    type: "result",
    attemptId: 9,
    sessionFingerprint: FP,
    outcome: { kind: "response", status: 429, headers: { "retry-after": "5" }, body: { bodyId: UUID, decodedBytes: 0, sha256: FP }, encodedBytes: 0, source: "network", sentMono: null, sendMark: "completion_fallback", preflight: true },
  },
  { type: "result", attemptId: 9, sessionFingerprint: FP, outcome: { kind: "timeout", sent: true, message: "x" } },
  { type: "result", attemptId: 9, sessionFingerprint: FP, outcome: { kind: "aborted_before_send", refusal: "session_mismatch" } },
  { type: "recoverResult", attempts: [{ attemptId: 9, state: "not_sent" }] },
  { type: "admissionCancel", kind: "site", id: UUID, reason: "document_replaced" },
  { type: "admissionCancel", kind: "ws", id: UUID, reason: "wait_expired" },
  { type: "siteAdmit", siteRequestId: UUID, method: "GET", host: "apiv3.fansly.com", path: "/api/v1/account/me", query: "", resourceType: "XHR", route: "account.me", operation: "read", sessionFingerprint: null, pausedMono: 1, waitDeadlineMono: 2 },
  { type: "siteDone", siteRequestId: UUID, attemptId: 10, sent: true, sentMono: 1, sentWall: 2, connectionReused: null, status: 200, retryAfter: null, error: null, body: "buffered" },
  { type: "wsAdmit", connectionId: UUID, url: "wss://wsv3.fansly.com/", context: "worker", sessionFingerprint: FP, requestedMono: 1, waitDeadlineMono: 2 },
  { type: "wsDone", connectionId: UUID, attemptId: 11, sent: false, sentMono: null, status: null, error: null, fate: "unknown" },
  { type: "siteSent", siteRequestId: "425.17", method: "GET", host: "apiv3.fansly.com", path: "/api/v1/account/me", route: "account.me", sessionFingerprint: "a".repeat(64), sentMono: 1234.5 },
  { type: "siteSent", siteRequestId: "ws:425.18", method: "GET", host: "wsv3.fansly.com", path: "/", route: "ws.upgrade", sessionFingerprint: null, sentMono: 1240 },
  { type: "siteEnded", siteRequestId: "425.17", endedMono: 1300, status: 429, retryAfter: "30", error: null },
  { type: "siteEnded", siteRequestId: "425.19", endedMono: 1301, status: null, retryAfter: null, error: "net::ERR_FAILED" },
  { type: "siteIdentity", siteRequestId: "425.17", accountId: "643579795946348544", sessionFingerprint: "a".repeat(64), sentNotBeforeMono: 1234 },
  {
    type: "events",
    bufferId: UUID,
    events: [
      { seq: 1, atMono: 1, atWall: 2, kind: "ws.open", connectionId: UUID, attemptId: 11, sessionFingerprint: FP },
      { seq: 2, atMono: 1, atWall: 2, kind: "ws.in", connectionId: UUID, frame: "{}" },
      { seq: 3, atMono: 1, atWall: 2, kind: "ws.close", connectionId: UUID, code: 1006, reason: null },
      { seq: 4, atMono: 1, atWall: 2, kind: "gap", fromSeq: null, fromWall: null, reason: "operator_start" },
      { seq: 5, atMono: 1, atWall: 2, kind: "site.response", siteRequestId: UUID, attemptId: 10, route: "site.other", method: "GET", path: "/api/v1/x", query: "", status: 200, headers: {}, body: { bodyId: UUID, decodedBytes: 1, sha256: FP }, complete: true, source: "revalidated_304", sessionFingerprint: FP },
      // Minor 5: a change of the page's step.
      { seq: 6, atMono: 1, atWall: 2, kind: "browser.transition", from: "ready", to: "exit_closed", stopReason: "cdp_lost", halted: false, retryAtWall: 3, note: "control lost: <ip>", chromeVersion: "155.0.8059.84", operatorVersion: "73c9667ba89c", crashDumps: 25 },
      { seq: 7, atMono: 1, atWall: 2, kind: "browser.transition", from: "exit_closed", to: "env_applied", stopReason: null, halted: false, retryAtWall: null, note: "", chromeVersion: "", operatorVersion: "1", crashDumps: null },
    ],
  },
  { type: "events.refused", of: "ack", reason: "beyond_sent", bufferId: UUID, givenBufferId: UUID, givenSeq: 7 },
  { type: "commandResult", commandId: "c-1", ok: true, detail: null },
  { type: "alarm", atWall: 1, kind: "buffer", detail: { percent: 80, full: false, what: "bytes" } },
];

/** One of every message the engine sends now (PR 12; the site path's
 *  answers and the commands, PR 14), as its types build them. */
const FROM_ENGINE: Engine.EngineToOperator[] = [
  {
    type: "hello",
    ownerGeneration: 2,
    protocol: { majors: [...Engine.SUPPORTED_MAJORS], minor: Engine.PROTOCOL.minor },
    token: "t",
    pageId: 7,
    expectedAccountId: "1",
    pinnedExitIp: "203.0.113.7",
    params: Engine.DEFAULT_PARAMS,
    socks5: { ip: "127.0.0.1", port: 1080, username: "u", password: "p" },
    env: { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } },
  },
  { type: "ping", n: 1, ownerGeneration: 2 },
  { type: "pong", n: 1, ownerGeneration: 2 },
  { type: "send", ownerGeneration: 2, attemptId: 9, route: "account.me", credentialsGeneration: FP, sessionFingerprint: FP, method: "GET", url: "https://apiv3.fansly.com/api/v1/account/me", headers: {}, kind: "api", maxBodyBytes: 1024, sendDeadlineMono: 10, requestDeadlineMono: 20 },
  { type: "checkResult", ownerGeneration: 2, attemptId: 9, admit: true, deadlineMono: 10 },
  { type: "checkResult", ownerGeneration: 2, attemptId: 9, admit: false, reason: "pace" },
  { type: "resultAck", ownerGeneration: 2, attemptId: 9 },
  { type: "recover", ownerGeneration: 2, attemptIds: [9, 10] },
  { type: "siteAdmitResult", ownerGeneration: 2, siteRequestId: UUID, admit: true, deadlineMono: 10, attemptId: 12 },
  { type: "siteAdmitResult", ownerGeneration: 2, siteRequestId: UUID, admit: false, reason: "site_hour_cap" },
  { type: "siteAdmitResult", ownerGeneration: 2, siteRequestId: UUID, admit: false, reason: "credentials" },
  { type: "wsAdmitResult", ownerGeneration: 2, connectionId: UUID, admit: true, deadlineMono: 10, attemptId: 13 },
  { type: "wsAdmitResult", ownerGeneration: 2, connectionId: UUID, admit: false, reason: "mode", retryNotBeforeWall: null },
  { type: "command", ownerGeneration: 2, commandId: UUID, notAfterMono: 10, command: { kind: "stopPage" } },
  // The owner's login (PR 15).
  { type: "command", ownerGeneration: 2, commandId: UUID, notAfterMono: 10, command: { kind: "setMode", mode: "manual_login" } },
  { type: "command", ownerGeneration: 2, commandId: UUID, notAfterMono: 10, command: { kind: "restartBrowser" } },
];

/** The login form's calls (API → operator) and answers (PR 15). */
const LOGIN_CALLS: Engine.LoginRequest[] = [
  { type: "login.state", callId: "c-1", token: "t" },
  { type: "login.open", callId: "c-open", token: "t" },
  { type: "login.screenshot", callId: "c-2", token: "t" },
  { type: "login.submit", callId: "c-3", token: "t", login: "someone", password: "pw" },
  { type: "login.code", callId: "c-4", token: "t", code: "123456" },
];
const LOGIN_REPLIES: Operator.LoginReply[] = [
  { type: "login.stateResult", callId: "c-1", screen: "error", screenVersion: "fansly-login/1", fields: ["login", "password"], siteError: "Invalid" },
  { type: "login.stateResult", callId: "c-1", screen: "unknown", screenVersion: "fansly-login/1", fields: [], siteError: null },
  // The e-mail code of a login from a new device (owner decision 2026-10-15).
  { type: "login.stateResult", callId: "c-1", screen: "code", screenVersion: "fansly-login/2", fields: ["code"], siteError: null, codeFrom: "email" },
  { type: "login.screenshotResult", callId: "c-2", jpeg: { bodyId: UUID, decodedBytes: 10, sha256: FP } },
  { type: "login.refused", callId: "c-3", reason: "not_manual_login" },
  { type: "login.stateResult", callId: "c-open", screen: "landing", screenVersion: "fansly-login/3", fields: [], siteError: null },
];

describe("the engine's mirror of the operator protocol", () => {
  it("has every message type both ways the same as the operator's (the type check)", () => {
    expect(Object.values(SAME_TYPES).every((same) => same)).toBe(true);
  });

  it("speaks the same version, enumerations and parameters", () => {
    expect(Engine.PROTOCOL).toEqual(Operator.PROTOCOL);
    expect(Engine.SUPPORTED_MAJORS).toEqual(Operator.SUPPORTED_MAJORS);
    expect(Engine.DEFAULT_PARAMS).toEqual(Operator.DEFAULT_PARAMS);
    expect(Engine.BODY_PART_BYTES).toBe(Operator.BODY_PART_BYTES);
    expect([...Engine.STEPS]).toEqual([...OPERATOR_STEPS]);
    expect([...Engine.STOP_REASONS]).toEqual([...OPERATOR_STOP_REASONS]);
    expect([...Engine.HUB_SEND_BLOCKS]).toEqual([...Operator.HUB_SEND_BLOCKS]);
    expect(Engine.TRANSITION_NOTE_MAX).toBe(Operator.TRANSITION_NOTE_MAX);
  });

  it("reads what the buffer holds only as the operator says it: absent stays unknown, a malformed word is a protocol error", () => {
    const parse = (buffer: unknown) => Engine.parseOperatorMessage(JSON.stringify({ ...STATE, buffer }));
    // An operator from before the addition: nothing is made up for it.
    const before = parse({ bytes: 0, oldestAgeMs: 0 });
    expect(before).toMatchObject({ ok: true });
    expect(before.ok && before.message.type === "state" && "open" in before.message.buffer).toBe(false);
    for (const open of [{}, { id: UUID, lastSeq: -1, outcomes: 0, pending: 0 }, { id: UUID, lastSeq: 1, outcomes: 0.5, pending: 0 }, { id: 7, lastSeq: 1, outcomes: 0, pending: 0 }, true, 0]) {
      expect(parse({ bytes: 0, oldestAgeMs: 0, open }), JSON.stringify(open)).toMatchObject({ ok: false });
    }
  });

  it("reads every message the operator sends", () => {
    for (const message of FROM_OPERATOR) {
      const parsed = Engine.parseOperatorMessage(JSON.stringify(message));
      expect(parsed, message.type).toEqual({ ok: true, message });
    }
  });

  it("sends only what the operator reads", () => {
    for (const message of FROM_ENGINE) {
      const parsed = Operator.parseEngineMessage(JSON.stringify(message));
      expect(parsed.ok, `${message.type}: ${parsed.ok ? "" : parsed.error}`).toBe(true);
    }
  });

  it("the login form: the operator reads every call the API makes, the API every answer the operator gives", () => {
    for (const call of LOGIN_CALLS) expect(Operator.parseLoginRequest(JSON.parse(JSON.stringify(call))), call.type).toEqual({ ok: true, request: call });
    for (const reply of LOGIN_REPLIES) expect(Engine.parseLoginReply(JSON.stringify(reply)), reply.type).toEqual({ ok: true, reply });
    expect(Engine.parseLoginReply(JSON.stringify({ ...LOGIN_REPLIES[0], screen: "captcha" })).ok).toBe(false);
    expect(Engine.parseLoginReply(JSON.stringify({ ...LOGIN_REPLIES[4], reason: "because" })).ok).toBe(false);
    // Where a code comes from: the e-mail, or nothing said (an operator older than it).
    expect(Engine.parseLoginReply(JSON.stringify({ ...LOGIN_REPLIES[2], codeFrom: "sms" })).ok).toBe(false);
    expect(Engine.parseLoginReply(JSON.stringify({ ...LOGIN_REPLIES[2], codeFrom: null })).ok).toBe(false);
    const { codeFrom: _omitted, ...older } = LOGIN_REPLIES[2] as Extract<Operator.LoginReply, { type: "login.stateResult" }>;
    expect(Engine.parseLoginReply(JSON.stringify(older))).toEqual({ ok: true, reply: older });
  });

  it("refuses what is not the protocol: an unknown type or value is an error (spec §6.3 rule 3)", () => {
    expect(Engine.parseOperatorMessage("{}").ok).toBe(false);
    expect(Engine.parseOperatorMessage(JSON.stringify({ type: "teleport" })).ok).toBe(false);
    expect(Engine.parseOperatorMessage(JSON.stringify({ ...STATE, step: "flying" })).ok).toBe(false);
    expect(Engine.parseOperatorMessage(JSON.stringify({ type: "result", attemptId: 1, sessionFingerprint: FP, outcome: { kind: "aborted_before_send", refusal: "because" } })).ok).toBe(false);
    expect(Engine.parseOperatorMessage(JSON.stringify({ type: "check", attemptId: 1, pausedMono: 1, liveSessionFingerprint: "not-hex" })).ok).toBe(false);
    expect(Engine.parseOperatorMessage("not json").ok).toBe(false);
    // Minor 5's words, strictly.
    expect(Engine.parseOperatorMessage(JSON.stringify({ ...STATE, hubSend: { allowed: false, reason: "because", sinceWall: 1 } })).ok).toBe(false);
    expect(Engine.parseOperatorMessage(JSON.stringify({ ...STATE, hubSend: { allowed: true, reason: "header_parity", sinceWall: 1 } })).ok).toBe(false);
    expect(Engine.parseOperatorMessage(JSON.stringify({ ...STATE, crashDumps: { completed: { count: -1, newestAtWall: null }, pending: { count: 0, newestAtWall: null }, countedAtWall: 1 } })).ok).toBe(false);
    const transition = { seq: 1, atMono: 1, atWall: 2, kind: "browser.transition", from: "ready", to: "exit_closed", stopReason: null, halted: false, retryAtWall: null, note: "", chromeVersion: "", operatorVersion: "", crashDumps: null };
    expect(Engine.parseOperatorMessage(JSON.stringify({ type: "events", bufferId: UUID, events: [transition] })).ok).toBe(true);
    expect(Engine.parseOperatorMessage(JSON.stringify({ type: "events", bufferId: UUID, events: [{ ...transition, to: "flying" }] })).ok).toBe(false);
    expect(Engine.parseOperatorMessage(JSON.stringify({ type: "events", bufferId: UUID, events: [{ ...transition, note: "x".repeat(Operator.TRANSITION_NOTE_MAX + 1) }] })).ok).toBe(false);
  });

  it("decodes the operator's body frames: parts, the last flag, the abandon frame", () => {
    const bodyId = randomUUID();
    const part = Engine.decodeBodyFrame(Operator.encodeBodyFrame(bodyId, 3, true, Buffer.from("data")));
    expect(part).toEqual({ bodyId, part: 3, last: true, abandoned: false, data: Buffer.from("data") });
    const first = Engine.decodeBodyFrame(Operator.encodeBodyFrame(bodyId, 0, false, Buffer.alloc(0)));
    expect(first).toMatchObject({ part: 0, last: false, abandoned: false });
    const abandon = Engine.decodeBodyFrame(Operator.encodeBodyAbandon(bodyId, 2));
    expect(abandon).toMatchObject({ bodyId, part: 2, last: false, abandoned: true });
    expect(abandon.data.length).toBe(0);
    // The operator's own decoder reads the same frame the same way.
    expect(Operator.decodeBodyFrame(Operator.encodeBodyAbandon(bodyId, 2))).toMatchObject({ bodyId, part: 2, abandoned: true });
    expect(() => Engine.decodeBodyFrame(Buffer.alloc(10))).toThrow();
  });
});
