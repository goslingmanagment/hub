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
// Additions to spec §6.1, to be made there before an engine reads them:
// - PR 5: the stop reason `env_mismatch` (state/steps.ts).
// - PR 11: `events.refused` — the operator's answer to a subscription or an
//   ack it does not take (a foreign buffer id, an ack past what was sent, a
//   buffer that cannot be opened), naming its own buffer id; the alarm kind
//   `buffer` — 50 % and 80 % of a buffer cap, a full buffer or disk, a
//   buffer that cannot be opened (spec §5); and the stop reason
//   `buffer_unavailable` (state/steps.ts). While the buffer cannot be
//   opened, helloResult's `bufferId` is the one it had when it was last open
//   ("" if none is known), and the engine subscribes again once `state` no
//   longer says `buffer_unavailable`.
//
// - PR 14: `state.buffer.open` — what the open buffer holds (its id, its last
//   event number, the outcomes it keeps, what is not committed yet), `null`
//   while it cannot be opened. `bytes` alone never said which: a buffer that
//   cannot be opened counts 0 bytes, and a `stopPage` replaces the stop reason
//   `buffer_unavailable`. An engine takes a buffer for empty only by `open`.
//
// - PR 9: `result.outcome.preflight` (response only, optional): the answer
//   is the CORS preflight's — the request itself never left (a 429 to the
//   preflight is a 429 of its operation, owner decision №1). The stop
//   reason `request_unended` (state/steps.ts). A body of 0 bytes is still
//   one binary frame, the last. Headers of a response leave out
//   `set-cookie`.
//
// - PR 7 (the site's own requests; spec §6.4): no shape changes. `siteAdmit`
//   of an operation with a CORS preflight is asked at the preflight's pause
//   with its request's method; its `sessionFingerprint` is the request's own
//   session, the live one for a preflight, null when there is none. The
//   `sessionFingerprint` of a `site.response` to a request without a
//   session is the empty session's (sha256 of "fansly-session/1\n\n"); one
//   with `complete: false` names an empty body no frames carry.
//   `siteDone.body` is `not_platform_data` also when there is nothing to
//   keep (no answer, a preflight's answer). An operator that starts again
//   sends `siteDone` for what the previous one admitted: `sent` — whether
//   it was released — and no status.
//
// - PR 10: no `wsAdmit` before the site's live session is known (its
//   `sessionFingerprint` is never null from this operator): the socket gate
//   lets the authorization go only at the live token's size. The stop
//   reasons `ws_guard_failed` and `ws_unaccounted` (state/steps.ts).
//   `wsAdmit` goes one socket at a time: a CONNECT that comes while the
//   socket before it is not accounted for waits, and is asked once it is
//   (its `waitDeadlineMono` counts from the CONNECT). `wsAdmit.url` and
//   `context` are CDP's word on the oldest socket of the host still waiting
//   to connect — a label: the CONNECT itself names only the host; the socket
//   is bound to its admission at its handshake (ws/sockets.ts). A
//   `wsAdmitResult` admits only on the connection it was asked on: an engine
//   connection that changes or goes refuses every socket asked on it, and
//   an admission that finds its socket gone gets `wsDone` with `sent:
//   false`. Every connection that opened is closed in the stream exactly
//   once, after its `ws.open`: by CDP's word, when the browser goes under it
//   (after a `chrome_restart` gap, in one commit), or — by an operator that
//   starts again, its Chrome gone — after its `operator_start` gap, in one
//   commit. An admitted connection that never opened in the
//   stream before such a restart gets `wsDone` with `fate: "unknown"` (an
//   addition): whether its handshake went is not known — `sent` is false
//   because nothing proves it went, `status` null; the engine takes it as
//   it takes `recover`'s `unknown`. Frames that were not durable before a
//   crash are not written afterwards (the holder's delivery of them is
//   acknowledged and dropped): the gap covers them. `alarm.detail` of
//   `unknown_ws_message` says where it was caught: `left: false` and `at:
//   "proxy"` for a record the socket gate held, `left: true` for one CDP
//   says left.
//
// This operator takes `hello`, `ping`/`pong`, `command` (closeExit,
// openExit, stopPage, restartBrowser, selfTest — PR 4), the buffer's
// messages (PR 11): `events.subscribe`, `ack`, `resultAck`, `recover`, a
// Hub request's (PR 9): `send`, `checkResult`, the site socket's (PR 10):
// `wsAdmitResult`, and — parsed strictly, handed to the RPC server's
// `onSite` — `siteAdmitResult` (the engine answers a `siteAdmit` with it,
// PR 14; this operator asks none before PR 7, and drops an answer it never
// asked for). The other kinds of command are refused as not supported yet.
//
// Bodies (BodyRef) go as binary frames before the JSON that names them:
// 16 bytes of the body id (a UUID), 4 bytes of the part's number (from 0,
// big-endian), 1 byte of flag — 0 more to come, 1 the last part — then up
// to 1 MiB of the body. Additions to spec §6.1 (PR 9): part 0 starts a
// body anew (a body is sent again on every delivery); the flag 2, with no
// data, abandons the body — the parts of it sent before are void (a part
// that could not be read), and no JSON names it.

import { isIP } from "node:net";

import { EnvError, validateEnv } from "../env/rules.ts";
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
  /** Taken, not used: a Hub request is never cancelled from the page before
   *  its deadline — the gate holds the deadline (spec §8.2, §9; stage 1,
   *  amendment 22). */
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
  /** Checked strictly (env/rules.ts): a value out of its rules makes the
   *  hello malformed. */
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
  /** `open` (an addition, PR 14): what the buffer holds, said only while it
   *  is open — its id, the last event number it gave, the outcomes kept for
   *  their resultAck, and what is written and not yet committed (a batch).
   *  `null`: the buffer cannot be opened — nothing of it is known, and the
   *  zero of `bytes` says nothing. Absent: an operator from before the
   *  addition — unknown. Only `open` with nothing kept is the word that the
   *  buffer is empty. */
  buffer: { bytes: number; oldestAgeMs: number; open?: { id: BufferId; lastSeq: number; outcomes: number; pending: number } | null };
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
        /** An addition (PR 9): the status and headers are the CORS
         *  preflight's; the request itself never left. */
        preflight?: boolean;
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
  /** An addition (PR 10): the operator started again after the admission,
   *  and nothing tells whether the handshake went. */
  fate?: "unknown";
}
// ── the event stream (plan §4.4; PR 11) ──
export interface EventsSubscribe extends FromEngine {
  type: "events.subscribe";
  bufferId: BufferId;
  afterSeq: number;
}
/** ≤ 500 events or 1 MB, in order of `seq` (buffer/stream.ts). An event is
 *  JSON, stored as it is sent (buffer/schema.ts, row format 1); the body a
 *  `site.response` names (BodyRef) will come as binary frames before the
 *  batch — not yet: the PRs that capture bodies add them. */
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
/** An addition to spec §6.1 (PR 11): a subscription or an ack not taken.
 *  `foreign_buffer` — not this buffer's id (the volume was made anew: the
 *  engine starts over with `bufferId`); `ahead` — a subscription past the
 *  last number this buffer gave; `not_subscribed` — an ack before the
 *  subscription on this connection; `beyond_sent` — an ack past what this
 *  subscription sent; `unavailable` — the buffer cannot be opened (state's
 *  stop reason `buffer_unavailable`). Nothing of it is acknowledged. */
export interface EventsRefused {
  type: "events.refused";
  of: "events.subscribe" | "ack";
  reason: "foreign_buffer" | "ahead" | "not_subscribed" | "beyond_sent" | "unavailable";
  /** This operator's buffer. */
  bufferId: BufferId;
  givenBufferId: BufferId;
  givenSeq: number;
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
/** `buffer` is an addition to spec §6.1 (PR 11). */
export type AlarmKind = "unknown_ws_message" | "header_mismatch" | "selftest_failed" | "overflow" | "cdp_lost" | "fallback_release" | "late_send" | "buffer";
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
  | EventsRefused
  | CommandResult
  | Alarm;

// ── what this operator reads from the engine ──

/** The buffer's messages (PR 11). */
export type BufferMessage = EventsSubscribe | Ack | ResultAck | Recover;

/** The engine's messages this operator handles. */
export type HandledMessage = Hello | (PingPong & FromEngine) | Command | BufferMessage | HubMessage | WsAdmitResult | SiteAdmitResult;

/** A Hub request's messages (PR 9). */
export type HubMessage = Send | CheckResult;

/** Types of the protocol that later PRs implement (none left). */
const LATER_TYPES = new Set<string>();

/** A recover names at most this many attempts. */
const MAX_RECOVER = 10_000;

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
  const pinnedExitIp = str(m.pinnedExitIp, "pinnedExitIp", 64);
  if (isIP(pinnedExitIp) === 0) throw new Invalid("pinnedExitIp is not an address");
  const socksIp = str(socks5.ip, "socks5.ip", 64);
  if (isIP(socksIp) === 0) throw new Invalid("socks5.ip is not an address");
  // The page's environment, strictly (env/rules.ts): it reaches Chrome's
  // start and every page target.
  let env: Hello["env"];
  try {
    env = validateEnv(m.env);
  } catch (error) {
    if (error instanceof EnvError) throw new Invalid(error.message);
    throw error;
  }
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
    env,
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

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** An HTTP header name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const REFUSALS = new Set<string>(["lease_inactive", "lease_used", "send_deadline_passed", "pace", "takeover_floor", "generation_stale", "session_mismatch"]);
/** A send names at most this many headers of its route. */
const MAX_SEND_HEADERS = 64;

function sha256Hex(value: unknown, what: string): string {
  const text = str(value, what, 64);
  if (!SHA256_HEX.test(text)) throw new Invalid(`${what} is not a sha256 in hex`);
  return text;
}

function parseSend(m: Record<string, unknown>): Send {
  if (m.method !== "GET") throw new Invalid("method is not GET");
  const kind = str(m.kind, "kind", 16);
  if (kind !== "api" && kind !== "image" && kind !== "video") throw new Invalid(`an unknown kind ${kind}`);
  const rawHeaders = record(m.headers, "headers");
  const entries = Object.entries(rawHeaders);
  if (entries.length > MAX_SEND_HEADERS) throw new Invalid(`headers has more than ${MAX_SEND_HEADERS} names`);
  const headers: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (name.length > 128 || !HEADER_NAME.test(name)) throw new Invalid("a header name that is not a token");
    const text = str(value, "a header value", 8192);
    if (/[\r\n\0]/.test(text)) throw new Invalid("a header value with a line break");
    headers[name] = text;
  }
  const route = str(m.route, "route", 128);
  if (route === "") throw new Invalid("an empty route");
  return {
    type: "send",
    ownerGeneration: int(m.ownerGeneration, "ownerGeneration"),
    attemptId: int(m.attemptId, "attemptId", 1),
    route,
    credentialsGeneration: sha256Hex(m.credentialsGeneration, "credentialsGeneration"),
    sessionFingerprint: sha256Hex(m.sessionFingerprint, "sessionFingerprint"),
    method: "GET",
    url: str(m.url, "url", 16_384),
    headers,
    kind,
    maxBodyBytes: int(m.maxBodyBytes, "maxBodyBytes"),
    sendDeadlineMono: num(m.sendDeadlineMono, "sendDeadlineMono"),
    requestDeadlineMono: num(m.requestDeadlineMono, "requestDeadlineMono"),
  };
}

function parseCheckResult(m: Record<string, unknown>): CheckResult {
  const base = { type: "checkResult" as const, ownerGeneration: int(m.ownerGeneration, "ownerGeneration"), attemptId: int(m.attemptId, "attemptId", 1) };
  if (m.admit === true) return { ...base, admit: true, deadlineMono: num(m.deadlineMono, "deadlineMono") };
  if (m.admit !== false) throw new Invalid("admit is not a boolean");
  const reason = str(m.reason, "reason", 64);
  if (!REFUSALS.has(reason)) throw new Invalid(`an unknown refusal ${reason}`);
  return { ...base, admit: false, reason: reason as Refusal };
}

const CONNECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseWsAdmitResult(m: Record<string, unknown>): WsAdmitResult {
  const connectionId = str(m.connectionId, "connectionId", 64);
  if (!CONNECTION_ID.test(connectionId)) throw new Invalid("connectionId is not a UUID");
  const base = { type: "wsAdmitResult" as const, ownerGeneration: int(m.ownerGeneration, "ownerGeneration"), connectionId };
  if (m.admit === true) return { ...base, admit: true, deadlineMono: num(m.deadlineMono, "deadlineMono"), attemptId: int(m.attemptId, "attemptId", 1) };
  if (m.admit !== false) throw new Invalid("admit is not a boolean");
  const retry = m.retryNotBeforeWall === null ? null : num(m.retryNotBeforeWall, "retryNotBeforeWall");
  return { ...base, admit: false, reason: str(m.reason, "reason", 128), retryNotBeforeWall: retry };
}

const SITE_REFUSALS = new Set<string>(["paused", "held", "mode", "route_hold", "site_hour_cap", "buffer_full", "session_mismatch", "wait_expired"]);

function parseSiteAdmitResult(m: Record<string, unknown>): SiteAdmitResult {
  const siteRequestId = str(m.siteRequestId, "siteRequestId", 64);
  if (!CONNECTION_ID.test(siteRequestId)) throw new Invalid("siteRequestId is not a UUID");
  const base = { type: "siteAdmitResult" as const, ownerGeneration: int(m.ownerGeneration, "ownerGeneration"), siteRequestId };
  if (m.admit === true) return { ...base, admit: true, deadlineMono: num(m.deadlineMono, "deadlineMono"), attemptId: int(m.attemptId, "attemptId", 1) };
  if (m.admit !== false) throw new Invalid("admit is not a boolean");
  const reason = str(m.reason, "reason", 64);
  if (!SITE_REFUSALS.has(reason)) throw new Invalid(`an unknown site refusal ${reason}`);
  return { ...base, admit: false, reason: reason as Extract<SiteAdmitResult, { admit: false }>["reason"] };
}

function parseBufferMessage(type: BufferMessage["type"], m: Record<string, unknown>): BufferMessage {
  const ownerGeneration = int(m.ownerGeneration, "ownerGeneration");
  switch (type) {
    case "events.subscribe":
      return { type, ownerGeneration, bufferId: str(m.bufferId, "bufferId", 64), afterSeq: int(m.afterSeq, "afterSeq") };
    case "ack":
      return { type, ownerGeneration, bufferId: str(m.bufferId, "bufferId", 64), uptoSeq: int(m.uptoSeq, "uptoSeq") };
    case "resultAck":
      return { type, ownerGeneration, attemptId: int(m.attemptId, "attemptId") };
    case "recover": {
      if (Array.isArray(m.attemptIds) && m.attemptIds.length > MAX_RECOVER) throw new Invalid(`attemptIds has more than ${MAX_RECOVER} items`);
      return { type, ownerGeneration, attemptIds: ints(m.attemptIds, "attemptIds") };
    }
  }
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
      case "events.subscribe":
      case "ack":
      case "resultAck":
      case "recover":
        return { ok: true, message: parseBufferMessage(type, m) };
      case "send":
        return { ok: true, message: parseSend(m) };
      case "checkResult":
        return { ok: true, message: parseCheckResult(m) };
      case "wsAdmitResult":
        return { ok: true, message: parseWsAdmitResult(m) };
      case "siteAdmitResult":
        return { ok: true, message: parseSiteAdmitResult(m) };
      default:
        return { ok: false, error: LATER_TYPES.has(type) ? `${type} is not supported by this operator yet` : `an unknown message type ${JSON.stringify(type.slice(0, 40))}` };
    }
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message };
    throw error;
  }
}

// ── bodies (plan §4.13: binary frames with a reference to their id) ──

/** The most of a body one frame carries. */
export const BODY_PART_BYTES = 1024 * 1024;
const BODY_FRAME_HEAD = 16 + 4 + 1;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One frame of a body: its id, the part's number, whether it is the last,
 *  and up to 1 MiB of the body. */
export function encodeBodyFrame(bodyId: BodyId, part: number, last: boolean, data: Buffer): Buffer {
  if (!UUID_TEXT.test(bodyId)) throw new Error("a body id that is not a UUID");
  if (data.length > BODY_PART_BYTES) throw new Error(`a body part of ${data.length} bytes`);
  const frame = Buffer.allocUnsafe(BODY_FRAME_HEAD + data.length);
  Buffer.from(bodyId.replaceAll("-", ""), "hex").copy(frame, 0);
  frame.writeUInt32BE(part, 16);
  frame[20] = last ? 1 : 0;
  data.copy(frame, BODY_FRAME_HEAD);
  return frame;
}

/** The frame that abandons a body whose transmission failed after
 *  `part` parts: those parts are void. */
export function encodeBodyAbandon(bodyId: BodyId, part: number): Buffer {
  const frame = encodeBodyFrame(bodyId, part, false, Buffer.alloc(0));
  frame[20] = 2;
  return frame;
}

/** The engine's side of `encodeBodyFrame` (tests, tools). */
export function decodeBodyFrame(frame: Buffer): { bodyId: BodyId; part: number; last: boolean; abandoned: boolean; data: Buffer } {
  if (frame.length < BODY_FRAME_HEAD) throw new Error("a body frame shorter than its head");
  const hex = frame.subarray(0, 16).toString("hex");
  const bodyId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { bodyId, part: frame.readUInt32BE(16), last: frame[20] === 1, abandoned: frame[20] === 2, data: frame.subarray(BODY_FRAME_HEAD) };
}
