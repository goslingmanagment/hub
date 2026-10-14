// The engine ↔ operator protocol as the engine speaks it (Project Browser,
// plan §4.13; spec §6.1, §6.3). The operator's side is
// `apps/page-browser/src/rpc/protocol.ts`; this is its mirror, not an import:
// the engine never loads the page-browser app at runtime (it is built and
// shipped apart, its image with Chrome). The two are kept the same by
// `tests/page-browser-protocol-drift.test.ts` — every message type both ways
// equal as types, the version, the refusals, the body frames. A change of the
// protocol is made in both files at once, or that test fails.
//
// The engine reads every operator message of major 1 (an unknown type or
// value is a protocol error: the connection closes, spec §6.3 rule 3), and
// sends only what this operator takes: hello, ping/pong, send, checkResult,
// resultAck, recover (PR 12), `events.subscribe` and `ack` (the buffer's
// intake, PR 13); `siteAdmitResult`, `wsAdmitResult` and `command` come with
// the site path's and the transport switch's wiring.

// Minor 1 (Project Browser PR 17): the operator holds its halt for the
// owner's decision on its volume — `state.halt` says it, `clearHalt` clears
// it by its id (sent only to an operator whose state says `halt`).
export const PROTOCOL = { major: 1, minor: 1 } as const;
export const SUPPORTED_MAJORS: readonly number[] = [1];

export type MonoMs = number;
export type WallMs = number;
export type Sha256Hex = string;
export type AttemptId = number;
export type SiteRequestId = string;
export type ConnectionId = string;
export type CommandId = string;
export type BufferId = string;
export type BodyId = string;

export const STEPS = [
  "exit_closed",
  "env_applied",
  "chrome_started",
  "control_attached",
  "selftest_passed",
  "exit_ip_verified",
  "exit_open",
  "site_loaded",
  "session_confirmed",
  "ready",
] as const;
export type Step = (typeof STEPS)[number];

export const STOP_REASONS = [
  "selftest_failed",
  "env_mismatch",
  "exit_ip_changed",
  "proxy_unavailable",
  "proxy_auth",
  "cdp_lost",
  "holder_overflow",
  "buffer_full",
  "disk_full",
  "buffer_unavailable",
  "request_unended",
  "chrome_crashed",
  "unknown_ws_message",
  "ws_guard_failed",
  "ws_unaccounted",
  "header_mismatch",
  "login_required",
  "owner_stop",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export interface BodyRef {
  bodyId: BodyId;
  decodedBytes: number;
  sha256: Sha256Hex;
}
export type Mode = "automation" | "manual_login";
export type ResponseSource = "network" | "revalidated_304" | "service_worker" | "cache_unconfirmed";
export const REFUSALS = ["lease_inactive", "lease_used", "send_deadline_passed", "pace", "takeover_floor", "generation_stale", "session_mismatch"] as const;
export type Refusal = (typeof REFUSALS)[number];
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

/** Spec §8.2 — the parameters the engine hands the operator in its hello. */
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
  selfTest: { ok: boolean; atWall: WallMs; failed: SelfTestMechanism | null; notInstalled?: SelfTestMechanism[] } | null;
  /** (Minor 1, PR 17.) The halt the operator holds for the owner's decision,
   *  on its volume: it refuses every start and the exit's opening until the
   *  halt is cleared (`clearHalt` with its id). `null`: none. Absent: an
   *  operator from before — it holds nothing and takes no `clearHalt`. */
  halt?: { id: string; reason: StopReason; atWall: WallMs } | null;
}
export interface PingPong {
  type: "ping" | "pong";
  n: number;
}
// ── a Hub request ──
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
// ── the site's requests ──
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
// ── the site's socket ──
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
  fate?: "unknown";
}
// ── the event stream ──
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
export interface EventsRefused {
  type: "events.refused";
  of: "events.subscribe" | "ack";
  reason: "foreign_buffer" | "ahead" | "not_subscribed" | "beyond_sent" | "unavailable";
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
  notAfterMono: MonoMs;
  command: { kind: CommandKind } | { kind: "setMode"; mode: Mode } | { kind: "clearHalt"; haltId: string };
}
export interface CommandResult {
  type: "commandResult";
  commandId: CommandId;
  ok: boolean;
  detail: string | null;
}
export type AlarmKind = "unknown_ws_message" | "header_mismatch" | "selftest_failed" | "overflow" | "cdp_lost" | "fallback_release" | "late_send" | "buffer";
export interface Alarm {
  type: "alarm";
  atWall: WallMs;
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

// ── reading the operator's messages ─────────────────────────────────────────

export type ParsedOperatorMessage = { ok: true; message: OperatorToEngine } | { ok: false; error: string };

class Invalid extends Error {}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STEP_SET: ReadonlySet<string> = new Set(STEPS);
const STOP_SET: ReadonlySet<string> = new Set(STOP_REASONS);
const REFUSAL_SET: ReadonlySet<string> = new Set(REFUSALS);
const SOURCES: ReadonlySet<string> = new Set(["network", "revalidated_304", "service_worker", "cache_unconfirmed"]);
const MECHANISMS: ReadonlySet<string> = new Set(["dnr_never", "dnr_write", "proxy_closed", "os_rules", "policies"]);
const ALARMS: ReadonlySet<string> = new Set(["unknown_ws_message", "header_mismatch", "selftest_failed", "overflow", "cdp_lost", "fallback_release", "late_send", "buffer"]);
const GAP_REASONS: ReadonlySet<string> = new Set(["ws_reconnect", "operator_start", "chrome_restart", "buffer_full", "disk_full"]);
const EVENTS_REFUSED_REASONS: ReadonlySet<string> = new Set(["foreign_buffer", "ahead", "not_subscribed", "beyond_sent", "unavailable"]);

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
function numOrNull(value: unknown, what: string): number | null {
  return value === null ? null : num(value, what);
}
function str(value: unknown, what: string, maxLength = 4096): string {
  if (typeof value !== "string" || value.length > maxLength) throw new Invalid(`${what} is not a string`);
  return value;
}
function strOrNull(value: unknown, what: string, maxLength = 4096): string | null {
  return value === null ? null : str(value, what, maxLength);
}
function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new Invalid(`${what} is not a boolean`);
  return value;
}
function oneOf<T extends string>(value: unknown, set: ReadonlySet<string>, what: string): T {
  const text = str(value, what, 64);
  if (!set.has(text)) throw new Invalid(`an unknown ${what} ${JSON.stringify(text.slice(0, 40))}`);
  return text as T;
}
function sha256(value: unknown, what: string): string {
  const text = str(value, what, 64);
  if (!SHA256_HEX.test(text)) throw new Invalid(`${what} is not a sha256 in hex`);
  return text;
}
function sha256OrNull(value: unknown, what: string): string | null {
  return value === null ? null : sha256(value, what);
}
function uuid(value: unknown, what: string): string {
  const text = str(value, what, 64);
  if (!UUID_TEXT.test(text)) throw new Invalid(`${what} is not a UUID`);
  return text;
}
function headersOf(value: unknown, what: string): Record<string, string> {
  const raw = record(value, what);
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(raw)) out[name] = str(text, `${what}.${name}`, 64 * 1024);
  return out;
}
function bodyRef(value: unknown, what: string): BodyRef {
  const m = record(value, what);
  return { bodyId: uuid(m.bodyId, `${what}.bodyId`), decodedBytes: int(m.decodedBytes, `${what}.decodedBytes`), sha256: sha256(m.sha256, `${what}.sha256`) };
}

/** `state.buffer.open`: what the open buffer holds, or null (it cannot be
 *  opened). */
function parseBufferOpen(value: unknown): NonNullable<State["buffer"]["open"]> | null {
  if (value === null) return null;
  const open = record(value, "buffer.open");
  return {
    id: str(open.id, "buffer.open.id", 64),
    lastSeq: int(open.lastSeq, "buffer.open.lastSeq"),
    outcomes: int(open.outcomes, "buffer.open.outcomes"),
    pending: int(open.pending, "buffer.open.pending"),
  };
}

function parseState(m: Record<string, unknown>): State {
  const buffer = record(m.buffer, "buffer");
  let selfTest: State["selfTest"] = null;
  if (m.selfTest !== null) {
    const t = record(m.selfTest, "selfTest");
    selfTest = {
      ok: bool(t.ok, "selfTest.ok"),
      atWall: num(t.atWall, "selfTest.atWall"),
      failed: t.failed === null ? null : oneOf<SelfTestMechanism>(t.failed, MECHANISMS, "selfTest.failed"),
      ...(t.notInstalled === undefined
        ? {}
        : { notInstalled: (Array.isArray(t.notInstalled) ? t.notInstalled : []).map((item, i) => oneOf<SelfTestMechanism>(item, MECHANISMS, `selfTest.notInstalled[${i}]`)) }),
    };
  }
  const mode = str(m.mode, "mode", 32);
  if (mode !== "automation" && mode !== "manual_login") throw new Invalid(`an unknown mode ${mode}`);
  return {
    type: "state",
    step: oneOf<Step>(m.step, STEP_SET, "step"),
    stopReason: m.stopReason === null ? null : oneOf<StopReason>(m.stopReason, STOP_SET, "stopReason"),
    retryAtWall: numOrNull(m.retryAtWall, "retryAtWall"),
    exitOpen: bool(m.exitOpen, "exitOpen"),
    mode,
    sessionFingerprint: sha256OrNull(m.sessionFingerprint, "sessionFingerprint"),
    accountId: strOrNull(m.accountId, "accountId", 128),
    exitIp: strOrNull(m.exitIp, "exitIp", 64),
    chromeVersion: str(m.chromeVersion, "chromeVersion", 128),
    operatorVersion: str(m.operatorVersion, "operatorVersion", 128),
    buffer: {
      bytes: num(buffer.bytes, "buffer.bytes"),
      oldestAgeMs: num(buffer.oldestAgeMs, "buffer.oldestAgeMs"),
      ...(buffer.open === undefined ? {} : { open: parseBufferOpen(buffer.open) }),
    },
    selfTest,
    ...(m.halt === undefined ? {} : { halt: m.halt === null ? null : parseHalt(m.halt) }),
  };
}

function parseHalt(value: unknown): NonNullable<State["halt"]> {
  const halt = record(value, "halt");
  return { id: str(halt.id, "halt.id", 64), reason: oneOf<StopReason>(halt.reason, STOP_SET, "halt.reason"), atWall: num(halt.atWall, "halt.atWall") };
}

function parseHelloResult(m: Record<string, unknown>): HelloResult {
  if (m.ok === true) {
    const protocol = record(m.protocol, "protocol");
    return {
      type: "helloResult",
      ok: true,
      protocol: { major: int(protocol.major, "protocol.major"), minor: int(protocol.minor, "protocol.minor") },
      bufferId: str(m.bufferId, "bufferId", 64),
      state: parseState(record(m.state, "state")),
    };
  }
  if (m.ok !== false) throw new Invalid("ok is not a boolean");
  const reason = str(m.reason, "reason", 32);
  if (reason !== "token" && reason !== "protocol_major" && reason !== "generation_stale") throw new Invalid(`an unknown hello refusal ${reason}`);
  const majors = Array.isArray(m.supportedMajors) ? m.supportedMajors.map((major, i) => int(major, `supportedMajors[${i}]`)) : [];
  return { type: "helloResult", ok: false, reason, supportedMajors: majors };
}

function parseResult(m: Record<string, unknown>): Result {
  const o = record(m.outcome, "outcome");
  const kind = str(o.kind, "outcome.kind", 32);
  let outcome: Result["outcome"];
  switch (kind) {
    case "response": {
      const sendMark = str(o.sendMark, "outcome.sendMark", 32);
      if (sendMark !== "transport_reported" && sendMark !== "completion_fallback") throw new Invalid(`an unknown sendMark ${sendMark}`);
      outcome = {
        kind,
        status: int(o.status, "outcome.status", 100, 999),
        headers: headersOf(o.headers, "outcome.headers"),
        body: bodyRef(o.body, "outcome.body"),
        encodedBytes: int(o.encodedBytes, "outcome.encodedBytes"),
        source: oneOf<ResponseSource>(o.source, SOURCES, "outcome.source"),
        sentMono: numOrNull(o.sentMono, "outcome.sentMono"),
        sendMark,
        ...(o.bodyOverflow === undefined ? {} : { bodyOverflow: bool(o.bodyOverflow, "outcome.bodyOverflow") }),
        ...(o.preflight === undefined ? {} : { preflight: bool(o.preflight, "outcome.preflight") }),
      };
      break;
    }
    case "transport_error":
    case "timeout":
      outcome = { kind, sent: bool(o.sent, "outcome.sent"), message: str(o.message, "outcome.message", 8192) };
      break;
    case "aborted_before_send":
      outcome = { kind, refusal: oneOf<Refusal>(o.refusal, REFUSAL_SET, "outcome.refusal") };
      break;
    default:
      throw new Invalid(`an unknown outcome ${JSON.stringify(kind.slice(0, 40))}`);
  }
  return { type: "result", attemptId: int(m.attemptId, "attemptId", 1), sessionFingerprint: sha256(m.sessionFingerprint, "sessionFingerprint"), outcome };
}

function parseRecoverResult(m: Record<string, unknown>): RecoverResult {
  if (!Array.isArray(m.attempts)) throw new Invalid("attempts is not a list");
  return {
    type: "recoverResult",
    attempts: m.attempts.map((item, i) => {
      const a = record(item, `attempts[${i}]`);
      const state = str(a.state, `attempts[${i}].state`, 32);
      if (state !== "outcome_resent" && state !== "not_sent" && state !== "unknown") throw new Invalid(`an unknown recover state ${state}`);
      return { attemptId: int(a.attemptId, `attempts[${i}].attemptId`), state };
    }),
  };
}

function parseEvent(value: unknown, i: number): BufferEvent {
  const e = record(value, `events[${i}]`);
  const base = { seq: int(e.seq, `events[${i}].seq`), atMono: num(e.atMono, `events[${i}].atMono`), atWall: num(e.atWall, `events[${i}].atWall`) };
  const kind = str(e.kind, `events[${i}].kind`, 32);
  switch (kind) {
    case "ws.open":
      return { ...base, kind, connectionId: uuid(e.connectionId, "connectionId"), attemptId: int(e.attemptId, "attemptId"), sessionFingerprint: sha256(e.sessionFingerprint, "sessionFingerprint") };
    case "ws.in":
      return { ...base, kind, connectionId: uuid(e.connectionId, "connectionId"), frame: str(e.frame, "frame", 16 * 1024 * 1024) };
    case "ws.close":
      return { ...base, kind, connectionId: uuid(e.connectionId, "connectionId"), code: e.code === null ? null : int(e.code, "code"), reason: strOrNull(e.reason, "reason") };
    case "gap":
      return {
        ...base,
        kind,
        fromSeq: e.fromSeq === null ? null : int(e.fromSeq, "fromSeq"),
        fromWall: numOrNull(e.fromWall, "fromWall"),
        reason: oneOf<"ws_reconnect" | "operator_start" | "chrome_restart" | "buffer_full" | "disk_full">(e.reason, GAP_REASONS, "gap reason"),
      };
    case "site.response":
      return {
        ...base,
        kind,
        siteRequestId: str(e.siteRequestId, "siteRequestId", 64),
        attemptId: int(e.attemptId, "attemptId"),
        route: str(e.route, "route", 128),
        method: str(e.method, "method", 16),
        path: str(e.path, "path", 16_384),
        query: str(e.query, "query", 16_384),
        status: int(e.status, "status", 100, 999),
        headers: headersOf(e.headers, "headers"),
        body: bodyRef(e.body, "body"),
        complete: bool(e.complete, "complete"),
        source: oneOf<ResponseSource>(e.source, SOURCES, "source"),
        sessionFingerprint: sha256(e.sessionFingerprint, "sessionFingerprint"),
      };
    default:
      throw new Invalid(`an unknown event ${JSON.stringify(kind.slice(0, 40))}`);
  }
}

function parseValue(m: Record<string, unknown>): OperatorToEngine {
  const type = typeof m.type === "string" ? m.type : "";
  switch (type) {
    case "helloResult":
      return parseHelloResult(m);
    case "quiesced":
      return { type, previousGeneration: int(m.previousGeneration, "previousGeneration"), lastSendMono: numOrNull(m.lastSendMono, "lastSendMono"), lastSendWall: numOrNull(m.lastSendWall, "lastSendWall") };
    case "state":
      return parseState(m);
    case "ping":
    case "pong":
      return { type, n: int(m.n, "n") };
    case "check":
      return { type, attemptId: int(m.attemptId, "attemptId", 1), pausedMono: num(m.pausedMono, "pausedMono"), liveSessionFingerprint: sha256(m.liveSessionFingerprint, "liveSessionFingerprint") };
    case "sent":
      return { type, attemptId: int(m.attemptId, "attemptId", 1), sentMono: num(m.sentMono, "sentMono"), sentWall: num(m.sentWall, "sentWall"), connectionReused: bool(m.connectionReused, "connectionReused") };
    case "result":
      return parseResult(m);
    case "recoverResult":
      return parseRecoverResult(m);
    case "siteAdmit": {
      const operation = str(m.operation, "operation", 16);
      if (operation !== "read" && operation !== "login") throw new Invalid(`an unknown operation ${operation}`);
      return {
        type,
        siteRequestId: str(m.siteRequestId, "siteRequestId", 64),
        method: str(m.method, "method", 16),
        host: str(m.host, "host", 255),
        path: str(m.path, "path", 16_384),
        query: str(m.query, "query", 16_384),
        resourceType: str(m.resourceType, "resourceType", 64),
        route: str(m.route, "route", 128),
        operation,
        sessionFingerprint: sha256OrNull(m.sessionFingerprint, "sessionFingerprint"),
        pausedMono: num(m.pausedMono, "pausedMono"),
        waitDeadlineMono: num(m.waitDeadlineMono, "waitDeadlineMono"),
      };
    }
    case "siteDone": {
      const body = str(m.body, "body", 32);
      if (body !== "buffered" && body !== "not_platform_data" && body !== "incomplete") throw new Invalid(`an unknown body ${body}`);
      const error = m.error === null ? null : record(m.error, "error");
      return {
        type,
        siteRequestId: str(m.siteRequestId, "siteRequestId", 64),
        attemptId: int(m.attemptId, "attemptId"),
        sent: bool(m.sent, "sent"),
        sentMono: numOrNull(m.sentMono, "sentMono"),
        sentWall: numOrNull(m.sentWall, "sentWall"),
        connectionReused: m.connectionReused === null ? null : bool(m.connectionReused, "connectionReused"),
        status: m.status === null ? null : int(m.status, "status", 100, 999),
        retryAfter: strOrNull(m.retryAfter, "retryAfter", 256),
        error: error === null ? null : { afterSendStart: bool(error.afterSendStart, "error.afterSendStart"), message: str(error.message, "error.message", 8192) },
        body,
      };
    }
    case "wsAdmit": {
      const context = str(m.context, "context", 16);
      if (context !== "page" && context !== "frame" && context !== "worker") throw new Invalid(`an unknown context ${context}`);
      return {
        type,
        connectionId: uuid(m.connectionId, "connectionId"),
        url: str(m.url, "url", 16_384),
        context,
        sessionFingerprint: sha256OrNull(m.sessionFingerprint, "sessionFingerprint"),
        requestedMono: num(m.requestedMono, "requestedMono"),
        waitDeadlineMono: num(m.waitDeadlineMono, "waitDeadlineMono"),
      };
    }
    case "wsDone":
      if (m.fate !== undefined && m.fate !== "unknown") throw new Invalid("an unknown fate");
      return {
        type,
        connectionId: uuid(m.connectionId, "connectionId"),
        attemptId: int(m.attemptId, "attemptId"),
        sent: bool(m.sent, "sent"),
        sentMono: numOrNull(m.sentMono, "sentMono"),
        status: m.status === null ? null : int(m.status, "status", 100, 999),
        error: strOrNull(m.error, "error", 8192),
        ...(m.fate === "unknown" ? { fate: "unknown" as const } : {}),
      };
    case "events": {
      if (!Array.isArray(m.events)) throw new Invalid("events is not a list");
      return { type, bufferId: str(m.bufferId, "bufferId", 64), events: m.events.map(parseEvent) };
    }
    case "events.refused": {
      const of = str(m.of, "of", 32);
      if (of !== "events.subscribe" && of !== "ack") throw new Invalid(`an unknown refused message ${of}`);
      return {
        type,
        of,
        reason: oneOf<EventsRefused["reason"]>(m.reason, EVENTS_REFUSED_REASONS, "events.refused reason"),
        bufferId: str(m.bufferId, "bufferId", 64),
        givenBufferId: str(m.givenBufferId, "givenBufferId", 64),
        givenSeq: int(m.givenSeq, "givenSeq"),
      };
    }
    case "commandResult":
      return { type, commandId: str(m.commandId, "commandId", 128), ok: bool(m.ok, "ok"), detail: strOrNull(m.detail, "detail", 8192) };
    case "alarm": {
      const raw = record(m.detail, "detail");
      const detail: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Invalid(`alarm.detail.${key} is not a scalar`);
        detail[key] = value;
      }
      return { type, atWall: num(m.atWall, "atWall"), detail, kind: oneOf<AlarmKind>(m.kind, ALARMS, "alarm kind") };
    }
    default:
      throw new Invalid(`an unknown message type ${JSON.stringify(type.slice(0, 40))}`);
  }
}

/** An operator message as the engine reads it. Anything malformed or unknown
 *  within the major is a protocol error (spec §6.3 rule 3). */
export function parseOperatorMessage(text: string): ParsedOperatorMessage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  try {
    return { ok: true, message: parseValue(record(value, "the message")) };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message };
    throw error;
  }
}

// ── the login form's answers (PR 15): the API reads them ─────────────────────

const LOGIN_SCREENS: ReadonlySet<string> = new Set(["login", "code", "error", "success", "unknown"]);
const LOGIN_FIELDS: ReadonlySet<string> = new Set(["login", "password", "code"]);
const LOGIN_REFUSALS: ReadonlySet<string> = new Set(["token", "not_manual_login", "screen_changed", "busy"]);

export type ParsedLoginReply = { ok: true; reply: LoginReply } | { ok: false; error: string };

/** An answer of the operator to a call of the login form, read strictly. */
export function parseLoginReply(text: string): ParsedLoginReply {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  try {
    const m = record(value, "the answer");
    const callId = str(m.callId, "callId", 64);
    switch (m.type) {
      case "login.stateResult": {
        if (!Array.isArray(m.fields) || m.fields.length > 3) throw new Invalid("fields is not a list of fields");
        const fields = m.fields.map((field, i) => oneOf<"login" | "password" | "code">(field, LOGIN_FIELDS, `fields[${i}]`));
        return { ok: true, reply: { type: "login.stateResult", callId, screen: oneOf<LoginScreen>(m.screen, LOGIN_SCREENS, "screen"), screenVersion: str(m.screenVersion, "screenVersion", 64), fields, siteError: strOrNull(m.siteError, "siteError", 300) } };
      }
      case "login.screenshotResult":
        return { ok: true, reply: { type: "login.screenshotResult", callId, jpeg: bodyRef(m.jpeg, "jpeg") } };
      case "login.refused":
        return { ok: true, reply: { type: "login.refused", callId, reason: oneOf<Extract<LoginReply, { type: "login.refused" }>["reason"]>(m.reason, LOGIN_REFUSALS, "reason") } };
      default:
        throw new Invalid("an unknown answer of the login form");
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

export interface BodyFrame {
  bodyId: BodyId;
  part: number;
  last: boolean;
  /** Flag 2: the parts of this body sent before are void (spec §6.1, PR 9). */
  abandoned: boolean;
  data: Buffer;
}

/** One binary frame of a body: 16 bytes of the body id (a UUID), 4 bytes of
 *  the part's number (big-endian, from 0), 1 byte of flag — 0 more to come,
 *  1 the last part, 2 abandoned (no data) — then up to 1 MiB of the body. */
export function decodeBodyFrame(frame: Buffer): BodyFrame {
  if (frame.length < BODY_FRAME_HEAD) throw new Error("a body frame shorter than its head");
  const flag = frame[20]!;
  if (flag > 2) throw new Error(`a body frame with the flag ${flag}`);
  const data = frame.subarray(BODY_FRAME_HEAD);
  if (data.length > BODY_PART_BYTES) throw new Error(`a body part of ${data.length} bytes`);
  if (flag === 2 && data.length > 0) throw new Error("an abandoning body frame with data");
  const hex = frame.subarray(0, 16).toString("hex");
  const bodyId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { bodyId, part: frame.readUInt32BE(16), last: flag === 1, abandoned: flag === 2, data };
}
