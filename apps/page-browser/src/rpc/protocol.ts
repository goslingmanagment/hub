// The engine ↔ operator protocol (plan §4.13; spec §6.1 — the types are the
// spec's, here in TypeScript). One WebSocket from `sync` to
// ws://page-browser-<page>:7700/rpc, JSON messages. The first message is
// `hello` with the page's token; every message of the engine carries the
// page's owner generation, and the operator refuses a lower one.
//
// Versions (spec §6.3): major.minor, 1.0 first. The engine lists the majors
// it knows; the operator picks the highest common one. Within a major only
// additions; an unknown type or value is a protocol error and the connection
// closes. The refusal of `hello` keeps its shape in every version.
//
// This operator (PR 4) takes `hello`, `ping`/`pong` and `command` (closeExit,
// openExit, stopPage, restartBrowser, selfTest); the other kinds of command
// are refused as not supported yet, and the other messages of the engine
// come with the PRs that implement them (send/check — PR 9, siteAdmit — PR 7,
// wsAdmit — PR 10, events, resultAck, recover — PR 11).

import { isIP } from "node:net";

import type { Step, StopReason } from "../state/steps.ts";

export type { Step, StopReason };

export const PROTOCOL = { major: 1, minor: 0 } as const;
export const SUPPORTED_MAJORS: readonly number[] = [1];

// MonoMs — CLOCK_MONOTONIC of the kernel, ms, shared by the server's
// processes (plan §4.2, step 5); WallMs — Unix epoch, ms. Deadlines are
// absolute moments, never remainders. Ids outlive restarts: a message with
// an id already handled is not handled twice.
export type MonoMs = number;
export type WallMs = number;
export type Sha256Hex = string;
export type AttemptId = number;
export type SiteRequestId = string;
export type ConnectionId = string;
export type CommandId = string;
export type BufferId = string;
export type BodyId = string;

/** Bodies are binary frames: 16 bytes bodyId | 4 bytes part | 1 byte last |
 *  up to 1 MiB of data; the parts come before the JSON that names them. */
export interface BodyRef {
  bodyId: BodyId;
  decodedBytes: number;
  sha256: Sha256Hex;
}
export type Mode = "automation" | "manual_login";
export type ResponseSource = "network" | "revalidated_304" | "service_worker" | "cache_unconfirmed";
export type Refusal = "lease_inactive" | "lease_used" | "send_deadline_passed" | "pace" | "takeover_floor" | "generation_stale" | "session_mismatch";
export interface Admit {
  admit: true;
  deadlineMono: MonoMs;
}
export interface FromEngine {
  ownerGeneration: number;
}

export interface OperatorParams {
  pingMs: number;
  linkLossMs: number;
  cancelMarginMs: number;
  siteAdmitWaitMs: number;
  siteRequestLimitMs: number;
  bufferBatchMs: number;
  eventBatch: { maxEvents: number; maxBytes: number };
  exitIpCheckMs: number;
  bufferCap: { bytes: number; ageMs: number; alarmPercents: number[] };
  selfTestMaxMs: number;
  screenshotMs: number;
  chromeBodyBuffer: { totalBytes: number; perResponseBytes: number };
  restartBackoffMs: number[];
}

/** Spec §8.2 — what the operator runs with until the engine's hello. */
export const DEFAULT_PARAMS: OperatorParams = {
  pingMs: 1000,
  linkLossMs: 5000,
  cancelMarginMs: 1000,
  siteAdmitWaitMs: 60_000,
  siteRequestLimitMs: 20_000,
  bufferBatchMs: 20,
  eventBatch: { maxEvents: 500, maxBytes: 1024 * 1024 },
  exitIpCheckMs: 5 * 60_000,
  bufferCap: { bytes: 2 * 1024 * 1024 * 1024, ageMs: 72 * 3600_000, alarmPercents: [50, 80] },
  selfTestMaxMs: 10_000,
  screenshotMs: 1000,
  chromeBodyBuffer: { totalBytes: 100 * 1024 * 1024, perResponseBytes: 20 * 1024 * 1024 },
  restartBackoffMs: [10_000, 30_000, 120_000, 300_000],
};

// ── the connection ──
export interface Hello extends FromEngine {
  type: "hello";
  protocol: { majors: number[]; minor: number };
  token: string;
  pageId: number;
  expectedAccountId: string;
  pinnedExitIp: string;
  params: OperatorParams;
  socks5: { ip: string; port: number; username: string; password: string };
  env: { timeZone: string; languages: string[]; geolocation: { latitude: number; longitude: number; accuracyM: number } };
}
export type HelloResult = { type: "helloResult" } & (
  | { ok: true; protocol: { major: number; minor: number }; bufferId: BufferId; state: State }
  | { ok: false; reason: "token" | "protocol_major" | "generation_stale"; supportedMajors: number[] }
);
/** After a hello of a newer generation: the previous one is finished or
 *  cancelled; the takeover pause counts from lastSendMono. */
export interface Quiesced {
  type: "quiesced";
  previousGeneration: number;
  lastSendMono: MonoMs | null;
  lastSendWall: WallMs | null;
}
export type SelfTestMechanism = "dnr_never" | "dnr_write" | "proxy_closed" | "os_rules" | "policies";
export interface State {
  type: "state";
  step: Step;
  stopReason: StopReason | null;
  retryAtWall: WallMs | null;
  exitOpen: boolean;
  mode: Mode;
  sessionFingerprint: Sha256Hex | null;
  accountId: string | null;
  exitIp: string | null;
  chromeVersion: string;
  operatorVersion: string;
  buffer: { bytes: number; oldestAgeMs: number };
  /** `notInstalled` (an addition to spec §6.1): mechanisms the image does
   *  not have yet — reported, never counted as passed. */
  selfTest: { ok: boolean; atWall: WallMs; failed: SelfTestMechanism | null; notInstalled?: SelfTestMechanism[] } | null;
}
/** Every second; no answer for 5 s and the link counts as lost. */
export interface PingPong {
  type: "ping" | "pong";
  n: number;
}
// ── a Hub request (plan §4.2; PR 9) ──
export interface Send extends FromEngine {
  type: "send";
  attemptId: AttemptId;
  route: string;
  credentialsGeneration: Sha256Hex;
  sessionFingerprint: Sha256Hex;
  method: "GET";
  url: string;
  headers: Record<string, string>;
  kind: "api" | "image" | "video";
  maxBodyBytes: number;
  sendDeadlineMono: MonoMs;
  requestDeadlineMono: MonoMs;
}
export interface Check {
  type: "check";
  attemptId: AttemptId;
  pausedMono: MonoMs;
  liveSessionFingerprint: Sha256Hex;
}
export type CheckResult = FromEngine & { type: "checkResult"; attemptId: AttemptId } & (Admit | { admit: false; reason: Refusal });
export interface Sent {
  type: "sent";
  attemptId: AttemptId;
  sentMono: MonoMs;
  sentWall: WallMs;
  connectionReused: boolean;
}
export interface Result {
  type: "result";
  attemptId: AttemptId;
  sessionFingerprint: Sha256Hex;
  outcome:
    | {
        kind: "response";
        status: number;
        headers: Record<string, string>;
        body: BodyRef;
        encodedBytes: number;
        source: ResponseSource;
        sentMono: MonoMs | null;
        sendMark: "transport_reported" | "completion_fallback";
        bodyOverflow?: boolean;
      }
    | { kind: "transport_error" | "timeout"; sent: boolean; message: string }
    | { kind: "aborted_before_send"; refusal: Refusal };
}
export interface ResultAck extends FromEngine {
  type: "resultAck";
  attemptId: AttemptId;
}
export interface Recover extends FromEngine {
  type: "recover";
  attemptIds: AttemptId[];
}
export interface RecoverResult {
  type: "recoverResult";
  attempts: { attemptId: AttemptId; state: "outcome_resent" | "not_sent" | "unknown" }[];
}
// ── the site's requests (plan §4.3; PR 7) ──
export interface SiteAdmit {
  type: "siteAdmit";
  siteRequestId: SiteRequestId;
  method: string;
  host: string;
  path: string;
  query: string;
  resourceType: string;
  route: string;
  operation: "read" | "login";
  sessionFingerprint: Sha256Hex | null;
  pausedMono: MonoMs;
  waitDeadlineMono: MonoMs;
}
export type SiteAdmitResult = FromEngine & { type: "siteAdmitResult"; siteRequestId: SiteRequestId } & (
    | (Admit & { attemptId: AttemptId })
    | { admit: false; reason: "paused" | "held" | "mode" | "route_hold" | "site_hour_cap" | "buffer_full" | "session_mismatch" | "wait_expired" }
  );
export interface SiteDone {
  type: "siteDone";
  siteRequestId: SiteRequestId;
  attemptId: AttemptId;
  sent: boolean;
  sentMono: MonoMs | null;
  sentWall: WallMs | null;
  connectionReused: boolean | null;
  status: number | null;
  retryAfter: string | null;
  error: { afterSendStart: boolean; message: string } | null;
  body: "buffered" | "not_platform_data" | "incomplete";
}
// ── the site's socket (PR 10) ──
export interface WsAdmit {
  type: "wsAdmit";
  connectionId: ConnectionId;
  url: string;
  context: "page" | "frame" | "worker";
  sessionFingerprint: Sha256Hex | null;
  requestedMono: MonoMs;
  waitDeadlineMono: MonoMs;
}
export type WsAdmitResult = FromEngine & { type: "wsAdmitResult"; connectionId: ConnectionId } & (
    | (Admit & { attemptId: AttemptId })
    | { admit: false; reason: string; retryNotBeforeWall: WallMs | null }
  );
export interface WsDone {
  type: "wsDone";
  connectionId: ConnectionId;
  attemptId: AttemptId;
  sent: boolean;
  sentMono: MonoMs | null;
  status: number | null;
  error: string | null;
}
// ── the event stream (plan §4.4; PR 11) ──
export interface EventsSubscribe extends FromEngine {
  type: "events.subscribe";
  bufferId: BufferId;
  afterSeq: number;
}
export interface Events {
  type: "events";
  bufferId: BufferId;
  events: BufferEvent[];
}
export interface Ack extends FromEngine {
  type: "ack";
  bufferId: BufferId;
  uptoSeq: number;
}
export type BufferEvent = { seq: number; atMono: MonoMs; atWall: WallMs } & (
  | { kind: "ws.open"; connectionId: ConnectionId; attemptId: AttemptId; sessionFingerprint: Sha256Hex }
  | { kind: "ws.in"; connectionId: ConnectionId; frame: string }
  | { kind: "ws.close"; connectionId: ConnectionId; code: number | null; reason: string | null }
  | { kind: "gap"; fromSeq: number | null; fromWall: WallMs | null; reason: "ws_reconnect" | "operator_start" | "chrome_restart" | "buffer_full" | "disk_full" }
  | {
      kind: "site.response";
      siteRequestId: SiteRequestId;
      attemptId: AttemptId;
      route: string;
      method: string;
      path: string;
      query: string;
      status: number;
      headers: Record<string, string>;
      body: BodyRef;
      complete: boolean;
      source: ResponseSource;
      sessionFingerprint: Sha256Hex;
    }
);
// ── control ──
export type CommandKind = "closeExit" | "openExit" | "stopPage" | "restartBrowser" | "selfTest" | "profileSnapshot";
export interface Command extends FromEngine {
  type: "command";
  commandId: CommandId;
  /** A command past this moment is not executed. */
  notAfterMono: MonoMs;
  command: { kind: CommandKind } | { kind: "setMode"; mode: Mode };
}
export interface CommandResult {
  type: "commandResult";
  commandId: CommandId;
  ok: boolean;
  detail: string | null;
}
export type AlarmKind = "unknown_ws_message" | "header_mismatch" | "selftest_failed" | "overflow" | "cdp_lost" | "fallback_release" | "late_send";
export interface Alarm {
  type: "alarm";
  atWall: WallMs;
  /** Never a secret. */
  detail: Record<string, string | number | boolean>;
  kind: AlarmKind;
}
// ── the login form: API → operator, its own token (plan §4.8; PR 15) ──
export type LoginScreen = "login" | "code" | "error" | "success" | "unknown";
export type LoginRequest = { callId: string; token: string } & (
  | { type: "login.state" }
  | { type: "login.screenshot" }
  | { type: "login.submit"; login: string; password: string }
  | { type: "login.code"; code: string }
);
export type LoginReply = { callId: string } & (
  | { type: "login.stateResult"; screen: LoginScreen; screenVersion: string; fields: ("login" | "password" | "code")[]; siteError: string | null }
  | { type: "login.screenshotResult"; jpeg: BodyRef }
  | { type: "login.refused"; reason: "token" | "not_manual_login" | "screen_changed" | "busy" }
);
export type EngineToOperator = Hello | (PingPong & FromEngine) | Send | CheckResult | ResultAck | Recover | SiteAdmitResult | WsAdmitResult | EventsSubscribe | Ack | Command;
export type OperatorToEngine =
  | HelloResult
  | Quiesced
  | State
  | PingPong
  | Check
  | Sent
  | Result
  | RecoverResult
  | SiteAdmit
  | SiteDone
  | WsAdmit
  | WsDone
  | Events
  | CommandResult
  | Alarm;

// ── what this operator reads from the engine ──

/** The engine's messages this operator handles. */
export type HandledMessage = Hello | (PingPong & FromEngine) | Command;

/** Types of the protocol that later PRs implement. */
const LATER_TYPES = new Set(["send", "checkResult", "resultAck", "recover", "siteAdmitResult", "wsAdmitResult", "events.subscribe", "ack"]);

export type Parsed = { ok: true; message: HandledMessage } | { ok: false; error: string };

class Invalid extends Error {}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Invalid(`${what} is not an object`);
  return value as Record<string, unknown>;
}
function int(value: unknown, what: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Invalid(`${what} is not an integer in [${min}, ${max}]`);
  return value;
}
function num(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Invalid(`${what} is not a number`);
  return value;
}
function str(value: unknown, what: string, maxLength = 4096): string {
  if (typeof value !== "string" || value.length > maxLength) throw new Invalid(`${what} is not a string`);
  return value;
}
function ints(value: unknown, what: string): number[] {
  if (!Array.isArray(value)) throw new Invalid(`${what} is not a list`);
  return value.map((item, index) => int(item, `${what}[${index}]`));
}

function parseParams(value: unknown): OperatorParams {
  const p = record(value, "params");
  const eventBatch = record(p.eventBatch, "params.eventBatch");
  const bufferCap = record(p.bufferCap, "params.bufferCap");
  const chromeBodyBuffer = record(p.chromeBodyBuffer, "params.chromeBodyBuffer");
  return {
    pingMs: int(p.pingMs, "params.pingMs", 1),
    linkLossMs: int(p.linkLossMs, "params.linkLossMs", 1),
    cancelMarginMs: int(p.cancelMarginMs, "params.cancelMarginMs"),
    siteAdmitWaitMs: int(p.siteAdmitWaitMs, "params.siteAdmitWaitMs"),
    siteRequestLimitMs: int(p.siteRequestLimitMs, "params.siteRequestLimitMs"),
    bufferBatchMs: int(p.bufferBatchMs, "params.bufferBatchMs"),
    eventBatch: { maxEvents: int(eventBatch.maxEvents, "params.eventBatch.maxEvents"), maxBytes: int(eventBatch.maxBytes, "params.eventBatch.maxBytes") },
    exitIpCheckMs: int(p.exitIpCheckMs, "params.exitIpCheckMs", 1),
    bufferCap: { bytes: int(bufferCap.bytes, "params.bufferCap.bytes"), ageMs: int(bufferCap.ageMs, "params.bufferCap.ageMs"), alarmPercents: ints(bufferCap.alarmPercents, "params.bufferCap.alarmPercents") },
    selfTestMaxMs: int(p.selfTestMaxMs, "params.selfTestMaxMs", 1),
    screenshotMs: int(p.screenshotMs, "params.screenshotMs"),
    chromeBodyBuffer: { totalBytes: int(chromeBodyBuffer.totalBytes, "params.chromeBodyBuffer.totalBytes"), perResponseBytes: int(chromeBodyBuffer.perResponseBytes, "params.chromeBodyBuffer.perResponseBytes") },
    restartBackoffMs: ints(p.restartBackoffMs, "params.restartBackoffMs"),
  };
}

function parseHello(m: Record<string, unknown>): Hello {
  const protocol = record(m.protocol, "protocol");
  const socks5 = record(m.socks5, "socks5");
  const env = record(m.env, "env");
  const geolocation = record(env.geolocation, "env.geolocation");
  const pinnedExitIp = str(m.pinnedExitIp, "pinnedExitIp", 64);
  if (isIP(pinnedExitIp) === 0) throw new Invalid("pinnedExitIp is not an address");
  const socksIp = str(socks5.ip, "socks5.ip", 64);
  if (isIP(socksIp) === 0) throw new Invalid("socks5.ip is not an address");
  if (!Array.isArray(env.languages)) throw new Invalid("env.languages is not a list");
  return {
    type: "hello",
    ownerGeneration: int(m.ownerGeneration, "ownerGeneration"),
    protocol: { majors: ints(protocol.majors, "protocol.majors"), minor: int(protocol.minor, "protocol.minor") },
    token: str(m.token, "token"),
    pageId: int(m.pageId, "pageId"),
    expectedAccountId: str(m.expectedAccountId, "expectedAccountId", 128),
    pinnedExitIp,
    params: parseParams(m.params),
    socks5: { ip: socksIp, port: int(socks5.port, "socks5.port", 1, 65535), username: str(socks5.username, "socks5.username", 255), password: str(socks5.password, "socks5.password", 255) },
    env: {
      timeZone: str(env.timeZone, "env.timeZone", 64),
      languages: env.languages.map((language, index) => str(language, `env.languages[${index}]`, 32)),
      geolocation: { latitude: num(geolocation.latitude, "env.geolocation.latitude"), longitude: num(geolocation.longitude, "env.geolocation.longitude"), accuracyM: num(geolocation.accuracyM, "env.geolocation.accuracyM") },
    },
  };
}

const COMMAND_KINDS = new Set<string>(["closeExit", "openExit", "stopPage", "restartBrowser", "selfTest", "profileSnapshot", "setMode"]);

function parseCommand(m: Record<string, unknown>): Command {
  const command = record(m.command, "command");
  const kind = str(command.kind, "command.kind", 64);
  if (!COMMAND_KINDS.has(kind)) throw new Invalid(`an unknown command ${kind}`);
  const commandId = str(m.commandId, "commandId", 128);
  if (commandId === "") throw new Invalid("an empty commandId");
  const base = { type: "command" as const, ownerGeneration: int(m.ownerGeneration, "ownerGeneration"), commandId, notAfterMono: num(m.notAfterMono, "notAfterMono") };
  if (kind === "setMode") {
    const mode = str(command.mode, "command.mode", 32);
    if (mode !== "automation" && mode !== "manual_login") throw new Invalid(`an unknown mode ${mode}`);
    return { ...base, command: { kind: "setMode", mode } };
  }
  return { ...base, command: { kind: kind as CommandKind } };
}

/** An engine message as this operator reads it. Anything else — malformed,
 *  unknown, or of a later PR — is an error: the connection closes (spec
 *  §6.3, rule 3). */
export function parseEngineMessage(text: string): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  return parseEngineValue(value);
}

export function parseEngineValue(value: unknown): Parsed {
  try {
    const m = record(value, "the message");
    const type = typeof m.type === "string" ? m.type : "";
    switch (type) {
      case "hello":
        return { ok: true, message: parseHello(m) };
      case "ping":
      case "pong":
        return { ok: true, message: { type, n: int(m.n, "n"), ownerGeneration: int(m.ownerGeneration, "ownerGeneration") } };
      case "command":
        return { ok: true, message: parseCommand(m) };
      default:
        return { ok: false, error: LATER_TYPES.has(type) ? `${type} is not supported by this operator yet` : `an unknown message type ${JSON.stringify(type.slice(0, 40))}` };
    }
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message };
    throw error;
  }
}
