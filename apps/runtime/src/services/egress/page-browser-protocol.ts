// The engine ↔ operator protocol as the engine speaks it (Project Browser,
// plan §4.13; spec §6.1, §6.3). The protocol's types are the operator's:
// `apps/page-browser/src/rpc/protocol.ts`, imported here as types only
// (`import type`, erased at build — the engine never loads the page-browser
// app at runtime; it is built and shipped apart, its image with Chrome). The
// values (the version, the minors, the sizes, the lists the parser checks
// against) and the parser stay the engine's own; the compile-time checks
// below fail `pnpm typecheck` when a value or a list differs from the
// operator's. A protocol change is made in the operator's file and in this
// file's parser.
//
// The engine reads every operator message of major 1 (an unknown type or
// value is a protocol error: the connection closes, spec §6.3 rule 3), and
// sends only what this operator takes: hello, ping/pong, send, checkResult,
// resultAck, recover (PR 12), `events.subscribe` and `ack` (the buffer's
// intake, PR 13); `siteAdmitResult`, `wsAdmitResult` and `command` come with
// the site path's and the transport switch's wiring. A write's `send` and the
// command `setPublishing` (minor 8) go only to an operator that said at hello
// that it takes writes.

import type * as Operator from "../../../../page-browser/src/rpc/protocol.ts";
import type {
  MonoMs, WallMs, Sha256Hex, AttemptId, SiteRequestId, ConnectionId, CommandId, BufferId, BodyId, Step,
  StopReason, BodyRef, Mode, ResponseSource, Refusal, Admit, FromEngine, OperatorParams, Hello, HelloResult,
  Publishing, PublishingStopReason, PublishingStop, Quiesced, SelfTestMechanism, HubSendBlock, CrashDumpCount,
  EgressHostClass, SocksFailureKind, SocksStep, EgressFailures, State, PingPong, Send, Check, HubAdmit,
  CheckResult, Sent, Result, ResultAck, Recover, RecoverResult, AdmissionCancel, SiteAdmit, SiteAdmitResult,
  SiteDone, WsAdmit, WsAdmitResult, WsDone, SiteObservedDelivery, SiteSent, SiteEnded, SiteIdentity,
  SiteObservedAck, EventsSubscribe, Events, Ack, EventsRefused, BufferEvent, CommandKind, Command,
  CommandResult, AlarmKind, Alarm, LoginScreen, LoginRequest, LoginReply, EngineToOperator, OperatorToEngine,
} from "../../../../page-browser/src/rpc/protocol.ts";

export type {
  MonoMs, WallMs, Sha256Hex, AttemptId, SiteRequestId, ConnectionId, CommandId, BufferId, BodyId, Step,
  StopReason, BodyRef, Mode, ResponseSource, Refusal, Admit, FromEngine, OperatorParams, Hello, HelloResult,
  Publishing, PublishingStopReason, PublishingStop, Quiesced, SelfTestMechanism, HubSendBlock, CrashDumpCount,
  EgressHostClass, SocksFailureKind, SocksStep, EgressFailures, State, PingPong, Send, Check, HubAdmit,
  CheckResult, Sent, Result, ResultAck, Recover, RecoverResult, AdmissionCancel, SiteAdmit, SiteAdmitResult,
  SiteDone, WsAdmit, WsAdmitResult, WsDone, SiteObservedDelivery, SiteSent, SiteEnded, SiteIdentity,
  SiteObservedAck, EventsSubscribe, Events, Ack, EventsRefused, BufferEvent, CommandKind, Command,
  CommandResult, AlarmKind, Alarm, LoginScreen, LoginRequest, LoginReply, EngineToOperator, OperatorToEngine,
};

// Minor 1 (Project Browser PR 17): the operator holds its halt for the
// owner's decision on its volume — `state.halt` says it, `clearHalt` clears
// it by its id (sent only to an operator whose state says `halt`).
// Minor 2: withdrawal of pending HTTP/WS admissions (`admissionCancel`).
// Minor 3 distinguishes credentials refusals; engines send held to older operators.
// Minor 4 (variant Б): the site observed, not admitted (`siteSent`,
// `siteEnded`, `siteIdentity`); such an operator sends no `siteAdmit`/`wsAdmit`.
// Minor 5 (telemetry for audits): `state.hubSend` (may a Hub request go now;
// else why and since when), `state.crashDumps` (Chrome's crash dumps on the
// profile, counted) and the buffer event `browser.transition` (every change of
// the page's step), which the operator writes only for an engine of minor 5.
// Minor 6 (the site's observations delivered for sure): `siteSent`,
// `siteEnded` and `siteIdentity` carry the request's key, its hop and a
// delivery number; the engine answers `siteObservedAck` once committed (only
// to an operator of minor 6), the operator keeps them until then and sends
// them again. `site.response` names the key and hop; `state.siteObserved`
// says what waits for the engine's word.
// Additions without a minor of their own (2026-10-18; optional
// fields a reader older than them skips): `checkResult.pauseMs` (the
// admission's pause, which the operator keeps by its own sight before the
// release, plan-b Б12), `sent.releasedMono` (when it released the request) and
// `state.egressFailures` (the exit's refusals counted).
// Minor 7 (the page's own faults that no longer stop it, 2026-10-22): the
// alarms `exit_ip_unknown` (a check of the exit IP while the page is up got
// no answer it can judge: the operator holds Hub's requests — `hubSend`
// blocked by `exit_ip_unknown` — until a check names the pinned IP; Chrome
// and the site go on), `journal` (a diagnostic journal fell behind or failed
// to write: lines dropped and counted, the page goes on) and `env_mismatch`
// (Chrome's screen is not the image's: the page goes on). The operator says
// them only to an engine of minor 7.
// Minor 8 (Hub's writes on the open publishing paths, wall posts PR 7): the
// operator says at hello that it takes writes (`helloResult.writes`, the
// version of the write fingerprint it computes); only then does the engine
// send a `POST` (`send.body`, `send.writeFingerprint` — the command's
// `fanslyWriteFingerprint`), answer its check with the same
// `writeFingerprint` (the command and its approval still stand), and set the
// two permissions of the page's publishing (`setPublishing`: create and
// upload; withdraw and reconcile), which `state.publishing` says. A write the
// operator would not let go ends `aborted_before_send` / `write_refused`. The
// operator says `writes` and `publishing` only to an engine of minor 8.
// An addition to minor 8 (spec §8.3): the operator's own stop of Hub's writes
// (`state.publishing.stop`: the login lost, a Fansly check, a 401/403/429 to
// a write), held with both permissions off until `setPublishing.clearStop`
// names it — the engine sends that once the stop is the page's autostop.
// Minor 9 (an upload's bytes, wall posts PR 8): the operator says at hello
// that it takes an upload's parts and its status read (`helloResult.uploads`:
// the version of the part fingerprint it computes — the engine's
// `FANSLY_PART_FINGERPRINT_VERSION` — and the most bytes a part may have).
// Only then does the engine send a part: the part's bytes as body frames
// (the same frames as the operator's bodies, engine → operator, only from
// minor 9) right before a `send` of kind `part`, method `PUT`, to the storage
// URL the upload's create named, naming them in `bodyRef`, with the part's
// `writeFingerprint` (`fanslyPartFingerprint`: the storage host, the path,
// the part's sha256 — never the URL's query); and the upload's status read,
// a `GET` of kind `api` on the upload API (route `publish.upload_status`).
// Both under the `create` permission. A new Hub with an older operator
// uploads nothing; an older Hub with a newer operator never sends either.
// Minor 10 (vault packs, owner 2026-11-03): `helloResult.uploads.parallelParts`
// — how many parts the operator takes at once beside the page's one managed
// request: a part goes to the storage (S3), not Fansly, so it waits for no
// pause and holds no slot of the page's; the engine then sends up to that
// many outside its pacer (its storage lane), each with no `pauseMs`. Said only
// to an engine of minor 10; without it (an older operator) the engine sends a
// part in its turn as before. An older Hub ignores the field.
export const PROTOCOL = { major: 1, minor: 10 } as const;
/** The operator takes writes from this minor (it says so at hello). */
export const WRITES_MINOR = 8;
/** The operator takes an upload's parts and its status read from this minor
 *  (it says `uploads` at hello). */
export const UPLOADS_MINOR = 9;
/** The operator takes a few parts at once beside the page's managed request
 *  from this minor (it says `uploads.parallelParts` at hello). */
export const PARALLEL_PARTS_MINOR = 10;
export const SUPPORTED_MAJORS: readonly number[] = [1];

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
] as const satisfies readonly Step[];

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
  "halt_unreadable",
  "owner_stop",
] as const satisfies readonly StopReason[];

/** `write_refused` (minor 8): a write the operator would not let go, or one
 *  the engine no longer admits at its check. Only of a write. */
export const REFUSALS = ["lease_inactive", "lease_used", "send_deadline_passed", "pace", "takeover_floor", "generation_stale", "session_mismatch", "write_refused"] as const satisfies readonly Refusal[];

/** Spec §8.2 — the parameters the engine hands the operator in its hello. */
export const DEFAULT_PARAMS: OperatorParams = {
  pingMs: 1000,
  linkLossMs: 5000,
  cancelMarginMs: 1000,
  siteAdmitWaitMs: 60_000,
  siteRequestLimitMs: 20_000,
  bufferBatchMs: 20,
  eventBatch: { maxEvents: 500, maxBytes: 1024 * 1024 },
  exitIpCheckMs: 60 * 60_000,
  bufferCap: { bytes: 2 * 1024 * 1024 * 1024, ageMs: 72 * 3600_000, alarmPercents: [50, 80] },
  selfTestMaxMs: 10_000,
  screenshotMs: 1000,
  chromeBodyBuffer: { totalBytes: 100 * 1024 * 1024, perResponseBytes: 20 * 1024 * 1024 },
  restartBackoffMs: [10_000, 30_000, 120_000, 300_000],
};

/** Why the operator stopped Hub's writes by itself (an addition to minor 8,
 *  wall posts PR 7 part 2; spec §8.3): `login_lost` — Fansly signed the
 *  browser out; `challenge` — a Fansly check (a Cloudflare challenge)
 *  answered a request of the page; `http_401`, `http_403`, `http_429` —
 *  Fansly's answer to one of Hub's writes. */
export const PUBLISHING_STOP_REASONS = ["login_lost", "challenge", "http_401", "http_403", "http_429"] as const satisfies readonly PublishingStopReason[];
/** Why a Hub request cannot go now (minor 5), the operator's first: the
 *  transport's own (`client_check` while the site's last fansly-client-check
 *  or fansly-client-ts differed from the operator's; `header_parity` until
 *  Chrome starts anew, from an operator before 2026-10-22 only — a page may
 *  be `ready` and so),
 *  the manual login, the page not up, its exit IP unknown since a check got
 *  no answer (minor 7), a buffer that takes no writes, the site not in the
 *  work tab, no live session, its new document's template unseen. */
export const HUB_SEND_BLOCKS = ["client_check", "header_parity", "manual_login", "page_not_up", "exit_ip_unknown", "buffer", "site_not_loaded", "no_session", "no_template"] as const satisfies readonly HubSendBlock[];
/** The classes of the operator's map of hosts. */
export const EGRESS_HOST_CLASSES = ["site", "api", "ws", "cdn", "closed", "third_party", "denied"] as const satisfies readonly EgressHostClass[];
/** How the page's SOCKS5 failed a tunnel, and at which step of its exchange. */
export const SOCKS_FAILURE_KINDS = ["unavailable", "auth", "refused"] as const satisfies readonly SocksFailureKind[];
export const SOCKS_STEPS = ["greeting", "auth", "connect"] as const satisfies readonly SocksStep[];
/** Entries of each list at most. */
export const EGRESS_FAILURE_ENTRIES_MAX = 64;
/** A `siteObservedAck` names at most this many. */
export const SITE_OBSERVED_ACK_MAX = 1_000;
/** A transition's note, at most (minor 5). */
export const TRANSITION_NOTE_MAX = 1024;

/** True only when A and B are the same type (no assignability slack). */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
// The engine's values are the operator's: a difference is a type error here.
// (`DEFAULT_PARAMS` is the engine's own — it hands them in its hello.)
const SAME_AS_OPERATOR: [
  Same<typeof PROTOCOL, typeof Operator.PROTOCOL>,
  Same<typeof WRITES_MINOR, typeof Operator.WRITES_MINOR>,
  Same<typeof UPLOADS_MINOR, typeof Operator.UPLOADS_MINOR>,
  Same<typeof PARALLEL_PARTS_MINOR, typeof Operator.PARALLEL_PARTS_MINOR>,
  Same<typeof BODY_PART_BYTES, typeof Operator.BODY_PART_BYTES>,
  Same<typeof SITE_OBSERVED_ACK_MAX, typeof Operator.SITE_OBSERVED_ACK_MAX>,
  Same<typeof TRANSITION_NOTE_MAX, typeof Operator.TRANSITION_NOTE_MAX>,
  Same<typeof EGRESS_FAILURE_ENTRIES_MAX, typeof Operator.EGRESS_FAILURE_ENTRIES_MAX>,
  // Each list names every member of its type (`satisfies` alone lets one miss).
  Same<(typeof STEPS)[number], Step>,
  Same<(typeof STOP_REASONS)[number], StopReason>,
  Same<(typeof REFUSALS)[number], Refusal>,
  Same<(typeof PUBLISHING_STOP_REASONS)[number], PublishingStopReason>,
  Same<(typeof HUB_SEND_BLOCKS)[number], HubSendBlock>,
  Same<(typeof EGRESS_HOST_CLASSES)[number], EgressHostClass>,
  Same<(typeof SOCKS_FAILURE_KINDS)[number], SocksFailureKind>,
  Same<(typeof SOCKS_STEPS)[number], SocksStep>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
void SAME_AS_OPERATOR;

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
const ALARMS: ReadonlySet<string> = new Set<AlarmKind>(["unknown_ws_message", "header_mismatch", "selftest_failed", "overflow", "cdp_lost", "fallback_release", "late_send", "buffer", "exit_ip_unknown", "journal", "env_mismatch"]);
const GAP_REASONS: ReadonlySet<string> = new Set(["ws_reconnect", "operator_start", "chrome_restart", "buffer_full", "disk_full"]);
const EVENTS_REFUSED_REASONS: ReadonlySet<string> = new Set(["foreign_buffer", "ahead", "not_subscribed", "beyond_sent", "unavailable"]);
const HUB_SEND_BLOCK_SET: ReadonlySet<string> = new Set(HUB_SEND_BLOCKS);

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
    ...(m.lastClearedHaltId === undefined ? {} : { lastClearedHaltId: m.lastClearedHaltId === null ? null : str(m.lastClearedHaltId, "lastClearedHaltId", 64) }),
    ...(m.hubSend === undefined ? {} : { hubSend: parseHubSend(m.hubSend) }),
    ...(m.crashDumps === undefined ? {} : { crashDumps: parseCrashDumps(m.crashDumps) }),
    ...(m.siteObserved === undefined ? {} : { siteObserved: parseSiteObservedState(m.siteObserved) }),
    ...(m.egressFailures === undefined ? {} : { egressFailures: parseEgressFailures(m.egressFailures) }),
    ...(m.publishing === undefined ? {} : { publishing: parsePublishing(m.publishing) }),
  };
}

const PUBLISHING_STOP_SET: ReadonlySet<string> = new Set(PUBLISHING_STOP_REASONS);

/** `state.publishing` (minor 8), its `stop` an addition. */
function parsePublishing(value: unknown): NonNullable<State["publishing"]> {
  const publishing = record(value, "publishing");
  const base = { create: bool(publishing.create, "publishing.create"), withdraw: bool(publishing.withdraw, "publishing.withdraw") };
  if (publishing.stop === undefined) return base;
  if (publishing.stop === null) return { ...base, stop: null };
  const stop = record(publishing.stop, "publishing.stop");
  return {
    ...base,
    stop: {
      id: str(stop.id, "publishing.stop.id", 64),
      reason: oneOf<PublishingStopReason>(stop.reason, PUBLISHING_STOP_SET, "publishing.stop.reason"),
      atWall: num(stop.atWall, "publishing.stop.atWall"),
    },
  };
}

const EGRESS_HOST_CLASS_SET: ReadonlySet<string> = new Set(EGRESS_HOST_CLASSES);
const SOCKS_FAILURE_KIND_SET: ReadonlySet<string> = new Set(SOCKS_FAILURE_KINDS);
const SOCKS_STEP_SET: ReadonlySet<string> = new Set(SOCKS_STEPS);

function entries(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value) || value.length > EGRESS_FAILURE_ENTRIES_MAX) throw new Invalid(`${what} is not a list of at most ${EGRESS_FAILURE_ENTRIES_MAX}`);
  return value;
}

/** `state.egressFailures` (an addition, 2026-10-18). */
function parseEgressFailures(value: unknown): EgressFailures {
  const failures = record(value, "egressFailures");
  return {
    sinceWall: num(failures.sinceWall, "egressFailures.sinceWall"),
    socks: entries(failures.socks, "egressFailures.socks").map((item, i) => {
      const what = `egressFailures.socks[${i}]`;
      const e = record(item, what);
      return {
        kind: oneOf<SocksFailureKind>(e.kind, SOCKS_FAILURE_KIND_SET, `${what}.kind`),
        step: oneOf<SocksStep>(e.step, SOCKS_STEP_SET, `${what}.step`),
        rep: e.rep === null ? null : int(e.rep, `${what}.rep`, 1, 255),
        cls: oneOf<EgressHostClass>(e.cls, EGRESS_HOST_CLASS_SET, `${what}.cls`),
        count: int(e.count, `${what}.count`, 1),
        lastAtWall: num(e.lastAtWall, `${what}.lastAtWall`),
        lastHost: str(e.lastHost, `${what}.lastHost`, 255),
      };
    }),
    dnr: entries(failures.dnr, "egressFailures.dnr").map((item, i) => {
      const what = `egressFailures.dnr[${i}]`;
      const e = record(item, what);
      return {
        cls: oneOf<EgressHostClass>(e.cls, EGRESS_HOST_CLASS_SET, `${what}.cls`),
        probe: bool(e.probe, `${what}.probe`),
        count: int(e.count, `${what}.count`, 1),
        lastAtWall: num(e.lastAtWall, `${what}.lastAtWall`),
        lastHost: str(e.lastHost, `${what}.lastHost`, 255),
      };
    }),
  };
}

/** `state.siteObserved` (minor 6). */
function parseSiteObservedState(value: unknown): NonNullable<State["siteObserved"]> {
  const kept = record(value, "siteObserved");
  return {
    unconfirmed: int(kept.unconfirmed, "siteObserved.unconfirmed"),
    oldestAtWall: numOrNull(kept.oldestAtWall, "siteObserved.oldestAtWall"),
    dropped: int(kept.dropped, "siteObserved.dropped"),
  };
}

/** A redirect chain is far shorter (Chrome follows at most 20). */
const HOP_MAX = 1_000;

/** The request's key and hop (minor 6), both or neither. */
function observedKeyOf(m: Record<string, unknown>): { requestKey?: string; hop?: number } {
  if (m.requestKey === undefined && m.hop === undefined) return {};
  return { requestKey: uuid(m.requestKey, "requestKey"), hop: int(m.hop, "hop", 0, HOP_MAX) };
}

/** An observation's key, hop and delivery number (minor 6): all or none. */
function observedDeliveryOf(m: Record<string, unknown>): SiteObservedDelivery {
  if (m.deliverySeq === undefined && m.requestKey === undefined && m.hop === undefined) return {};
  return { requestKey: uuid(m.requestKey, "requestKey"), hop: int(m.hop, "hop", 0, HOP_MAX), deliverySeq: int(m.deliverySeq, "deliverySeq") };
}

/** `state.hubSend` (minor 5): allowed with nothing else, or blocked with a
 *  reason and its instant. */
function parseHubSend(value: unknown): NonNullable<State["hubSend"]> {
  const hub = record(value, "hubSend");
  if (bool(hub.allowed, "hubSend.allowed")) {
    if (hub.reason !== null || hub.sinceWall !== null) throw new Invalid("hubSend allowed with a reason");
    return { allowed: true, reason: null, sinceWall: null };
  }
  return { allowed: false, reason: oneOf<HubSendBlock>(hub.reason, HUB_SEND_BLOCK_SET, "hubSend.reason"), sinceWall: num(hub.sinceWall, "hubSend.sinceWall") };
}

function parseCrashDumpCount(value: unknown, what: string): CrashDumpCount {
  const dumps = record(value, what);
  return { count: int(dumps.count, `${what}.count`), newestAtWall: numOrNull(dumps.newestAtWall, `${what}.newestAtWall`) };
}

/** `state.crashDumps` (minor 5), or null: not counted. */
function parseCrashDumps(value: unknown): NonNullable<State["crashDumps"]> | null {
  if (value === null) return null;
  const dumps = record(value, "crashDumps");
  return {
    completed: parseCrashDumpCount(dumps.completed, "crashDumps.completed"),
    pending: parseCrashDumpCount(dumps.pending, "crashDumps.pending"),
    countedAtWall: num(dumps.countedAtWall, "crashDumps.countedAtWall"),
  };
}

function parseHalt(value: unknown): NonNullable<State["halt"]> {
  const halt = record(value, "halt");
  return { id: str(halt.id, "halt.id", 64), reason: oneOf<StopReason>(halt.reason, STOP_SET, "halt.reason"), atWall: num(halt.atWall, "halt.atWall") };
}

function parseUploads(uploads: Record<string, unknown>): NonNullable<Extract<HelloResult, { ok: true }>["uploads"]> {
  return {
    fingerprint: str(uploads.fingerprint, "uploads.fingerprint", 64),
    maxPartBytes: int(uploads.maxPartBytes, "uploads.maxPartBytes", 1),
    // Minor 10: how many parts at once (absent: one at a time, in the turn).
    ...(uploads.parallelParts === undefined ? {} : { parallelParts: int(uploads.parallelParts, "uploads.parallelParts", 1) }),
  };
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
      ...(m.writes === undefined ? {} : { writes: { fingerprint: str(record(m.writes, "writes").fingerprint, "writes.fingerprint", 64) } }),
      ...(m.uploads === undefined ? {} : { uploads: parseUploads(record(m.uploads, "uploads")) }),
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
        ...observedKeyOf(e),
      };
    case "browser.transition":
      return {
        ...base,
        kind,
        from: oneOf<Step>(e.from, STEP_SET, "from"),
        to: oneOf<Step>(e.to, STEP_SET, "to"),
        stopReason: e.stopReason === null ? null : oneOf<StopReason>(e.stopReason, STOP_SET, "stopReason"),
        halted: bool(e.halted, "halted"),
        retryAtWall: numOrNull(e.retryAtWall, "retryAtWall"),
        note: str(e.note, "note", TRANSITION_NOTE_MAX),
        chromeVersion: str(e.chromeVersion, "chromeVersion", 128),
        operatorVersion: str(e.operatorVersion, "operatorVersion", 128),
        crashDumps: e.crashDumps === null ? null : int(e.crashDumps, "crashDumps"),
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
      return {
        type,
        attemptId: int(m.attemptId, "attemptId", 1),
        sentMono: num(m.sentMono, "sentMono"),
        sentWall: num(m.sentWall, "sentWall"),
        connectionReused: bool(m.connectionReused, "connectionReused"),
        ...(m.releasedMono === undefined ? {} : { releasedMono: num(m.releasedMono, "releasedMono") }),
      };
    case "result":
      return parseResult(m);
    case "recoverResult":
      return parseRecoverResult(m);
    case "admissionCancel": {
      const kind = str(m.kind, "kind", 16);
      if (kind !== "site" && kind !== "ws") throw new Invalid("an unknown admission kind");
      const reason = str(m.reason, "reason", 32);
      if (reason !== "request_ended" && reason !== "document_replaced" && reason !== "wait_expired" && reason !== "page_stopped") throw new Invalid("an unknown cancellation reason");
      return { type, kind, id: kind === "ws" ? uuid(m.id, "id") : str(m.id, "id", 64), reason };
    }
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
    case "siteSent":
      return {
        type,
        siteRequestId: str(m.siteRequestId, "siteRequestId", 64),
        method: str(m.method, "method", 16),
        host: str(m.host, "host", 255),
        path: str(m.path, "path", 16_384),
        route: str(m.route, "route", 128),
        sessionFingerprint: sha256OrNull(m.sessionFingerprint, "sessionFingerprint"),
        sentMono: num(m.sentMono, "sentMono"),
        ...observedDeliveryOf(m),
      };
    case "siteEnded":
      return {
        type,
        siteRequestId: str(m.siteRequestId, "siteRequestId", 64),
        endedMono: num(m.endedMono, "endedMono"),
        status: m.status === null ? null : int(m.status, "status", 100, 999),
        retryAfter: strOrNull(m.retryAfter, "retryAfter", 256),
        error: strOrNull(m.error, "error", 8192),
        ...observedDeliveryOf(m),
      };
    case "siteIdentity": {
      const accountId = str(m.accountId, "accountId", 32);
      if (!/^[0-9]+$/.test(accountId)) throw new Invalid("an account id that is not a Fansly id");
      return {
        type,
        siteRequestId: str(m.siteRequestId, "siteRequestId", 64),
        accountId,
        sessionFingerprint: sha256(m.sessionFingerprint, "sessionFingerprint"),
        sentNotBeforeMono: num(m.sentNotBeforeMono, "sentNotBeforeMono"),
        ...observedDeliveryOf(m),
      };
    }
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

const LOGIN_SCREENS: ReadonlySet<string> = new Set(["landing", "login", "code", "error", "success", "unknown"]);
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
        // Absent from an operator older than the e-mail code (an addition).
        if (m.codeFrom !== undefined && m.codeFrom !== "email") throw new Invalid("codeFrom is not where a code comes from");
        const codeFrom = m.codeFrom === "email" ? { codeFrom: "email" as const } : {};
        return { ok: true, reply: { type: "login.stateResult", callId, screen: oneOf<LoginScreen>(m.screen, LOGIN_SCREENS, "screen"), screenVersion: str(m.screenVersion, "screenVersion", 64), fields, siteError: strOrNull(m.siteError, "siteError", 300), ...codeFrom } };
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

/** The frames of a body the engine sends (minor 9: an upload's part), in
 *  order: up to 1 MiB each, the last one flagged. */
export function encodeBodyFrames(bodyId: BodyId, body: Buffer): Buffer[] {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bodyId)) throw new Error("a body id that is not a UUID");
  const frames: Buffer[] = [];
  const count = Math.max(1, Math.ceil(body.length / BODY_PART_BYTES));
  for (let part = 0; part < count; part += 1) {
    const data = body.subarray(part * BODY_PART_BYTES, Math.min(body.length, (part + 1) * BODY_PART_BYTES));
    const frame = Buffer.allocUnsafe(BODY_FRAME_HEAD + data.length);
    Buffer.from(bodyId.replaceAll("-", ""), "hex").copy(frame, 0);
    frame.writeUInt32BE(part, 16);
    frame[20] = part === count - 1 ? 1 : 0;
    data.copy(frame, BODY_FRAME_HEAD);
    frames.push(frame);
  }
  return frames;
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
