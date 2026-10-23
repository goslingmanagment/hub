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
// - PR 15 (the login form, plan §4.8): no shape changes. The API's calls
//   (`login.*`) come on /rpc too; a connection whose first message is one is
//   the API's and carries only those, each with the API's own token — a
//   wrong one is answered `login.refused` "token" and the connection closes.
//   `login.submit` and `login.code` answer with `login.stateResult` (the
//   screen the site shows once it changed, or as it is after a wait);
//   `login.screenshotResult`'s JPEG comes as body frames before it. The
//   login, the password and the code have no line break and are at most
//   320, 1024 and 32 characters. `setMode` is carried out (it was parsed
//   since PR 4): `manual_login` holds for the owner generation that set it,
//   a new owner's hello ends it.
//
// - The e-mail code of a new device (owner decision 2026-10-15): the
//   optional `login.stateResult.codeFrom` — "email" on the code form (its
//   screen or its error) of a login from a new device, whose code Fansly
//   e-mailed; absent otherwise. No minor: a new optional field, which a
//   reader older than it skips (spec §6.3, 2) and so asks for the 2FA code.
//
// This operator takes `hello`, `ping`/`pong`, `command` (closeExit,
// openExit, stopPage, restartBrowser, selfTest — PR 4; setMode — PR 15;
// setPublishing — minor 8), the buffer's
// messages (PR 11): `events.subscribe`, `ack`, `resultAck`, `recover`, a
// Hub request's (PR 9): `send`, `checkResult`, the site socket's (PR 10):
// `wsAdmitResult`, and — parsed strictly, handed to the RPC server's
// `onSite` — `siteAdmitResult` (the engine answers a `siteAdmit` with it,
// PR 14; the site path, PR 7, asks them, and an answer it never asked for
// is dropped), and `siteObservedAck` (minor 6, the observer's outbox). The
// other kinds of command are refused as not supported yet.
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

// Minor 1 (Project Browser PR 17): the operator holds its halt for the
// owner's decision on its volume — `state.halt` says it, `clearHalt` clears
// it by its id.
// Minor 2: withdrawal of pending HTTP/WS admissions (`admissionCancel`).
// Minor 3 distinguishes credentials refusals; engines send held to older operators.
// Minor 4 (variant Б): the site observed, not admitted (`siteSent`,
// `siteEnded`, `siteIdentity`); such an operator sends no `siteAdmit`/`wsAdmit`.
// Its socket's handshake is a `siteSent` of route `ws.upgrade` (its
// `siteRequestId` the connection's id), and a `ws.open` of it carries
// attempt 0: no admission is behind it (Б-2d). `wsDone` it sends only for a
// connection an older operator's admission kept (`fate: "unknown"`).
// Minor 5 (telemetry for audits, 2026-10-18): `state.hubSend` — whether a Hub
// request can go now, else why and since when; `state.crashDumps` — Chrome's
// crash dumps on the profile, counted (never the dumps: they hold the
// session's memory); the buffer event `browser.transition` — every change of
// the page's step, with its stop reason, acknowledged with the stream. The
// operator writes `browser.transition` only while its engine speaks minor 5
// (one already in the buffer still goes to an engine rolled back below it,
// which refuses the batch: roll the engine back only with the operator).
// Minor 6 (the site's observations delivered for sure, 2026-10-18): each
// `siteSent`, `siteEnded` and `siteIdentity` names its request by a key the
// operator minted when it first followed it (`requestKey`: the same over its
// redirects and every repeat; a socket's handshake, its connection id) and
// the hop under it (`hop`: 0 as it first left, each redirect the next), and
// carries its delivery number (`deliverySeq`). An engine of minor 6 answers
// `siteObservedAck` once what it names is committed; until then the operator
// keeps it and sends it again (an engine before minor 6 takes it as told at
// its write). The engine takes a key and hop it holds once: a repeat
// journals no second attempt. `site.response` names the same key and hop;
// `state.siteObserved` says what waits for the engine's word.
// Additions without a minor of their own (2026-10-18; optional
// fields, which a reader older than them skips, spec §6.3, 2):
// `checkResult.pauseMs` — the admission's pause, which the operator keeps by
// its own sight before it releases the request (plan-b Б12); `sent.releasedMono`
// — when it released it; `state.egressFailures` — the exit's refusals counted
// (the page's SOCKS5 by kind, step, reply and the host's class; the rules
// extension's blocks by the host's class, the self-test's probes apart).
// Minor 7 (our own faults that no longer stop the page, 2026-10-22): the
// alarms `exit_ip_unknown` — a check of the exit IP while the page is up got
// no answer it can judge (a timeout, ipify not reached or not answering an
// address, the SOCKS5 failing the check's own tunnel): Hub's requests are
// held (`state.hubSend` blocked by `exit_ip_unknown`) until a check names
// the pinned IP, Chrome and the site go on —, `journal` — a diagnostic
// journal fell behind the disk or failed to write: its lines are dropped and
// counted, the page goes on — and `env_mismatch` — Chrome's screen is not
// the one the image sets: the page goes on. The operator says them only to
// an engine of minor 7 (`FAULTS_MINOR`): to an older one the hold is
// `page_not_up` and those alarms go to its log alone.
// Minor 8 (Hub's writes on the open publishing paths, wall posts PR 7): the
// operator says at hello that it takes writes (`helloResult.writes`: the
// version of the write fingerprint it computes). A `send` may then be a
// `POST` with its `body` (JSON text, at most `WRITE_BODY_MAX` bytes) and the
// command's `writeFingerprint` (sha256 of the version, the method, the host's
// class, the path with its query and the body's sha256 — the engine's
// `fanslyWriteFingerprint`, packages/fansly/src/wire/publish.ts); its
// `checkResult` admits it only with the same `writeFingerprint` — the engine's
// word at the check that the command and its approval still stand. The
// operator lets a write go only on an open publishing path of Hub's own
// (policy/operations.ts `HUB_PUBLISH_ROWS`), under the permission of its row,
// when what it would release — the method, the real URL and the bytes Chrome
// holds — has that fingerprint; anything else ends `aborted_before_send` with
// the refusal `write_refused`. The engine sets the two permissions (create
// and upload; withdraw and reconcile) with the command `setPublishing`;
// `state.publishing` says them; both are off at the operator's start and at
// every hello. The operator says `writes` and `publishing` only to an engine
// of minor 8 (`WRITES_MINOR`), and an engine sends a write and `setPublishing`
// only to an operator that said `writes`: a new Hub with an older operator
// reads on and publishes nothing; an older Hub with this operator is as it
// was.
// An addition to minor 8 (wall posts PR 7, part 2; spec §8.3): the
// operator stops Hub's writes by itself — Fansly signed the browser out, a
// Fansly check (a Cloudflare challenge) answered a request of the page, a
// 401, 403 or 429 answered one of Hub's writes — and holds the stop
// (`state.publishing.stop`) with both permissions off until the engine names
// it in `setPublishing.clearStop`, which it does once the stop is the page's
// autostop. A new hello keeps the stop. Optional fields: a reader before
// them skips them.
export const PROTOCOL = { major: 1, minor: 8 } as const;
/** The minor from which an engine knows minor 7's alarms and send block. */
export const FAULTS_MINOR = 7;
/** The minor from which an engine sends writes and `setPublishing`, and is
 *  told `writes` and `state.publishing`. */
export const WRITES_MINOR = 8;
/** What this operator says of its writes at hello (minor 8): the version of
 *  the fingerprint it computes over a write it would release. */
export const WRITES = { fingerprint: "fansly-write.v1" } as const;
/** A write's body, at most (bytes of its UTF-8): one HTTP/2 DATA frame — the
 *  gate's limit for an API request's body (egress/gate.ts `MAX_BODY_BYTES`). */
export const WRITE_BODY_MAX = 16 * 1024 - 9;
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
/** `write_refused` (minor 8): a write the operator would not let go — off
 *  its open paths, without its permission, not the request fingerprinted —
 *  or one the engine no longer admits at its check. Only of a write. */
export type Refusal = "lease_inactive" | "lease_used" | "send_deadline_passed" | "pace" | "takeover_floor" | "generation_stale" | "session_mismatch" | "write_refused";
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
  exitIpCheckMs: 60 * 60_000,
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
/** `writes` (minor 8): this operator takes writes, computing the fingerprint
 *  of this version. Absent: it takes none (an older one, or an engine before
 *  minor 8). */
export type HelloResult = { type: "helloResult" } & (
  | { ok: true; protocol: { major: number; minor: number }; bufferId: BufferId; state: State; writes?: { fingerprint: string } }
  | { ok: false; reason: "token" | "protocol_major" | "generation_stale"; supportedMajors: number[] }
);
/** The two permissions of Hub's writes (minor 8): `create` — upload, make
 *  media, post, story; `withdraw` — take a scheduled post off the schedule. */
export interface Publishing {
  create: boolean;
  withdraw: boolean;
}
/** Why the operator stopped Hub's writes by itself (an addition to minor 8,
 *  wall posts PR 7 part 2; spec §8.3): `login_lost` — Fansly signed the
 *  browser out; `challenge` — a Fansly check (a Cloudflare challenge)
 *  answered a request of the page; `http_401`, `http_403`, `http_429` —
 *  Fansly's answer to one of Hub's writes. */
export const PUBLISHING_STOP_REASONS = ["login_lost", "challenge", "http_401", "http_403", "http_429"] as const;
export type PublishingStopReason = (typeof PUBLISHING_STOP_REASONS)[number];
/** A stop the operator holds until the engine names it in `setPublishing`'s
 *  `clearStop` (it recorded the stop as the page's autostop first): both
 *  permissions stay off meanwhile, whatever the engine sets. */
export interface PublishingStop {
  id: string;
  reason: PublishingStopReason;
  atWall: WallMs;
}
/** After a hello of a newer generation: the previous one is finished or
 *  cancelled; the takeover pause counts from lastSendMono. */
export interface Quiesced {
  type: "quiesced";
  previousGeneration: number;
  lastSendMono: MonoMs | null;
  lastSendWall: WallMs | null;
}
export type SelfTestMechanism = "dnr_never" | "dnr_write" | "proxy_closed" | "os_rules" | "policies";
/** Why a Hub request cannot go now (minor 5), in the order the operator
 *  names them: `client_check` — the site's last request computed
 *  fansly-client-check or fansly-client-ts another way than the operator —
 *  whatever the step (`header_parity`, a Hub request's header names that
 *  differed from the site's until Chrome started anew, only an operator
 *  before 2026-10-22 says: a difference is an alarm now); then the
 *  manual login, the page below its open exit or halted, the exit IP unknown
 *  since a check of it got no answer (minor 7), a buffer that
 *  takes no writes, the site not in the work tab, no live session of it, its
 *  new document's first authorized API request not seen yet. */
export const HUB_SEND_BLOCKS = ["client_check", "header_parity", "manual_login", "page_not_up", "exit_ip_unknown", "buffer", "site_not_loaded", "no_session", "no_template"] as const;
export type HubSendBlock = (typeof HUB_SEND_BLOCKS)[number];
/** Chrome's crash dumps of one of Crashpad's directories: how many, and the
 *  newest one's time (null: none). */
export interface CrashDumpCount {
  count: number;
  newestAtWall: WallMs | null;
}
/** The classes of the operator's map of hosts (policy/operations.ts). */
export const EGRESS_HOST_CLASSES = ["site", "api", "ws", "cdn", "closed", "third_party", "denied"] as const;
export type EgressHostClass = (typeof EGRESS_HOST_CLASSES)[number];
/** How the page's SOCKS5 failed a tunnel (egress/socks5.ts): `unavailable` —
 *  not reached, garbage, or the connection dropped; `auth` — the login
 *  refused; `refused` — it could not reach the destination (its reply `rep`,
 *  null: no reply in time). At which step of the SOCKS5 exchange. */
export const SOCKS_FAILURE_KINDS = ["unavailable", "auth", "refused"] as const;
export type SocksFailureKind = (typeof SOCKS_FAILURE_KINDS)[number];
export const SOCKS_STEPS = ["greeting", "auth", "connect"] as const;
export type SocksStep = (typeof SOCKS_STEPS)[number];
/** Entries of each list at most. */
export const EGRESS_FAILURE_ENTRIES_MAX = 64;
/** The exit's refusals since the operator started (`sinceWall`), counted
 *  apart by what tells them apart; each with its last instant and host. */
export interface EgressFailures {
  sinceWall: WallMs;
  socks: Array<{ kind: SocksFailureKind; step: SocksStep; rep: number | null; cls: EgressHostClass; count: number; lastAtWall: WallMs; lastHost: string }>;
  /** Requests the rules extension blocked (net::ERR_BLOCKED_BY_CLIENT);
   *  `probe`: the self-test's own. */
  dnr: Array<{ cls: EgressHostClass; probe: boolean; count: number; lastAtWall: WallMs; lastHost: string }>;
}
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
  /** (An addition, minor 1, PR 17.) The halt the operator holds for the
   *  owner's decision, kept on its volume across restarts: every start and
   *  the exit's opening are refused until it is cleared (`clearHalt` with
   *  its id; a `login_required` also by the operator, once the expected
   *  account is confirmed after a login). `null`: none. Absent: an operator
   *  from before the addition (it holds nothing, and takes no `clearHalt`). */
  halt?: { id: string; reason: StopReason; atWall: WallMs } | null;
  /** (Minor 1, PR 17.) The id of the last halt cleared — by the owner's
   *  clearHalt, or by the operator once the expected account was confirmed
   *  after his login — kept with the halt across restarts. Hub lets its
   *  mirror of a halt go only on this word. */
  lastClearedHaltId?: string | null;
  /** (Minor 5.) Whether a Hub request can go now — what a `send` would be
   *  answered, its route aside. Blocked: the first reason, and since when it
   *  holds (the operator's wall clock). A page may be `ready` and blocked.
   *  Absent: an operator from before the addition — unknown. */
  hubSend?: { allowed: true; reason: null; sinceWall: null } | { allowed: false; reason: HubSendBlock; sinceWall: WallMs };
  /** (Minor 5.) Chrome's crash dumps on the profile — Crashpad's `completed`
   *  and `pending` — as counted at Chrome's last start or exit (`countedAtWall`).
   *  Null: not counted (no count was written, or it could not be read).
   *  Absent: an operator from before the addition. */
  crashDumps?: { completed: CrashDumpCount; pending: CrashDumpCount; countedAtWall: WallMs } | null;
  /** (An addition, 2026-10-18.) The exit's refusals since the operator
   *  started. Absent: an operator from before — not counted. */
  egressFailures?: EgressFailures;
  /** (Minor 6.) The site's observations kept for the engine's word
   *  (`siteObservedAck`): how many, the oldest one's instant (the operator's
   *  wall clock; null: none), and how many this operator dropped unconfirmed
   *  since its start (more than it keeps). Absent: an operator from before
   *  the addition. */
  siteObserved?: { unconfirmed: number; oldestAtWall: WallMs | null; dropped: number };
  /** (Minor 8.) The permissions of Hub's writes now: what the engine set
   *  (`setPublishing`; both off until it does), both off while the operator
   *  holds a stop of its own (`stop`, an addition: absent from an operator
   *  before it). Said only to an engine of minor 8. */
  publishing?: Publishing & { stop?: PublishingStop | null };
}
/** Every second; no answer for 5 s and the link counts as lost. */
export interface PingPong {
  type: "ping" | "pong";
  n: number;
}
// ── a Hub request (plan §4.2; PR 9) ──
/** `POST` (minor 8): a write of kind `api`, with its `body` and the
 *  command's `writeFingerprint`; both absent from a `GET`. */
export interface Send extends FromEngine {
  type: "send";
  attemptId: AttemptId;
  route: string;
  credentialsGeneration: Sha256Hex;
  sessionFingerprint: Sha256Hex;
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  kind: "api" | "image" | "video";
  maxBodyBytes: number;
  sendDeadlineMono: MonoMs;
  requestDeadlineMono: MonoMs;
  body?: string;
  writeFingerprint?: Sha256Hex;
}
export interface Check {
  type: "check";
  attemptId: AttemptId;
  pausedMono: MonoMs;
  liveSessionFingerprint: Sha256Hex;
}
/** A Hub request admitted. `pauseMs` (an addition, 2026-10-18): the pause
 *  the admission keeps from the page's last send of any origin (S × (1 + u)):
 *  the operator releases the request only once the API has been quiet that
 *  long by its proxy's bytes and by the site's sends it saw, and no request
 *  of the site's own is in flight (plan-b Б2, Б12) — or refuses it `pace` at
 *  the deadline. Absent: an engine from before; the operator releases at once.
 *  `writeFingerprint` (minor 8): a write's admission names its command's
 *  fingerprint — the engine confirmed at the check that the command and its
 *  approval still stand; a write's admission without it, or with another,
 *  lets nothing go. */
export type HubAdmit = Admit & { pauseMs?: number; writeFingerprint?: Sha256Hex };
export type CheckResult = FromEngine & { type: "checkResult"; attemptId: AttemptId } & (HubAdmit | { admit: false; reason: Refusal });
export interface Sent {
  type: "sent";
  attemptId: AttemptId;
  sentMono: MonoMs;
  sentWall: WallMs;
  connectionReused: boolean;
  /** (An addition, 2026-10-18.) When the operator released the operation's
   *  first request (Fetch.continueRequest), after its quiet. Absent: not
   *  known (an operator from before). */
  releasedMono?: MonoMs;
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
/** Withdraw a still-waiting admission on the connection it was asked on.
 *  Once the operator accepted a grant it reports the ordinary end instead:
 *  a cancellation never retracts a possible send. */
export interface AdmissionCancel {
  type: "admissionCancel";
  kind: "site" | "ws";
  id: string;
  reason: "request_ended" | "document_replaced" | "wait_expired" | "page_stopped";
}
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
    | { admit: false; reason: "paused" | "held" | "credentials" | "mode" | "route_hold" | "site_hour_cap" | "buffer_full" | "session_mismatch" | "wait_expired" }
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
// ── the site observed, not admitted (variant Б, minor 4) ──
// An operator of minor 4 lets the site's own requests and socket go as any
// browser does: nothing of the site waits for the engine or is refused by it.
// It tells the engine what left and how it ended, so the engine counts the
// site's sends in the page's pause before its own requests, holds its routes
// on the site's 429, 401 and 403, and journals the site's traffic. It never
// sends `siteAdmit` or `wsAdmit`.
/** (Minor 6.) What names one observation of the site for sure: the request's
 *  key and hop (the engine takes each once) and the delivery number its
 *  `siteObservedAck` names. Absent: an operator from before minor 6. */
export interface SiteObservedDelivery {
  /** Minted by the operator when it first followed the request (a socket's
   *  handshake: its connection id); the same over its redirects. */
  requestKey?: string;
  /** 0: the request as it first left; each redirect under its id the next. */
  hop?: number;
  /** Increasing in the operator's process; acknowledged by the engine. */
  deliverySeq?: number;
}
export interface SiteSent extends SiteObservedDelivery {
  type: "siteSent";
  siteRequestId: SiteRequestId;
  method: string;
  host: string;
  /** The path only: a query may carry what the journal must not keep. */
  path: string;
  /** The operations map's route, or `ws.upgrade` for the socket's handshake. */
  route: string;
  sessionFingerprint: Sha256Hex | null;
  /** When the operator saw it leave (CLOCK_MONOTONIC). */
  sentMono: MonoMs;
}
export interface SiteEnded extends SiteObservedDelivery {
  type: "siteEnded";
  siteRequestId: SiteRequestId;
  endedMono: MonoMs;
  status: number | null;
  retryAfter: string | null;
  error: string | null;
}
/** The site's own `GET /account/me`, answered from the network (not a cache
 *  or a service worker), whole, 200, under the session the operator names:
 *  the account it names. `sentNotBeforeMono` is a lower bound of its send,
 *  on the operator's clock; the engine judges the proof by it. */
export interface SiteIdentity extends SiteObservedDelivery {
  type: "siteIdentity";
  siteRequestId: SiteRequestId;
  accountId: string;
  sessionFingerprint: Sha256Hex;
  sentNotBeforeMono: MonoMs;
}
/** (Minor 6.) The engine committed the observations it names (their
 *  `deliverySeq`), on the connection they came on: the operator lets them
 *  go. A number it does not keep is nothing. Sent only to an operator of
 *  minor 6. */
export interface SiteObservedAck extends FromEngine {
  type: "siteObservedAck";
  deliverySeqs: number[];
}
/** A `siteObservedAck` names at most this many. */
export const SITE_OBSERVED_ACK_MAX = 1_000;
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
  /** `attemptId` 0: an observed socket's (minor 4), no admission behind it. */
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
      /** (Minor 6.) The request's key and hop, as its `siteSent` names them;
       *  absent from an older operator. */
      requestKey?: string;
      hop?: number;
    }
  /** (Minor 5.) The page's step changed (state/page-state.ts): its stop
   *  reason, whether it holds until the engine starts it, the next retry,
   *  why in words (an IP in it masked, at most `TRANSITION_NOTE_MAX`
   *  characters), the versions it ran and Chrome's crash dumps then
   *  (completed and pending; null: not counted). */
  | {
      kind: "browser.transition";
      from: Step;
      to: Step;
      stopReason: StopReason | null;
      halted: boolean;
      retryAtWall: WallMs | null;
      note: string;
      chromeVersion: string;
      operatorVersion: string;
      crashDumps: number | null;
    }
);
/** A transition's note, at most (minor 5). */
export const TRANSITION_NOTE_MAX = 1024;
// ── control ──
export type CommandKind = "closeExit" | "openExit" | "stopPage" | "restartBrowser" | "selfTest" | "profileSnapshot";
/** `setPublishing` (minor 8): the permissions of Hub's writes, as the engine
 *  reads them for the page — sent only to an operator that said `writes`. */
export interface Command extends FromEngine {
  type: "command";
  commandId: CommandId;
  /** A command past this moment is not executed. */
  notAfterMono: MonoMs;
  command: { kind: CommandKind } | { kind: "setMode"; mode: Mode } | { kind: "clearHalt"; haltId: string } | ({ kind: "setPublishing"; clearStop?: string } & Publishing);
}
export interface CommandResult {
  type: "commandResult";
  commandId: CommandId;
  ok: boolean;
  detail: string | null;
}
/** `buffer` is an addition to spec §6.1 (PR 11); `exit_ip_unknown`,
 *  `journal` and `env_mismatch` of minor 7 (`FAULTS_MINOR`). */
export type AlarmKind = "unknown_ws_message" | "header_mismatch" | "selftest_failed" | "overflow" | "cdp_lost" | "fallback_release" | "late_send" | "buffer" | FaultAlarmKind;
/** Minor 7's alarms: what the page goes on with. */
export type FaultAlarmKind = "exit_ip_unknown" | "journal" | "env_mismatch";
export const FAULT_ALARMS: ReadonlySet<AlarmKind> = new Set<FaultAlarmKind>(["exit_ip_unknown", "journal", "env_mismatch"]);
export interface Alarm {
  type: "alarm";
  atWall: WallMs;
  /** Never a secret. */
  detail: Record<string, string | number | boolean>;
  kind: AlarmKind;
}
// ── the login form: API → operator, its own token (plan §4.8; PR 15) ──
export type LoginScreen = "landing" | "login" | "code" | "error" | "success" | "unknown";
export type LoginRequest = { callId: string; token: string } & (
  | { type: "login.state" }
  | { type: "login.open" }
  | { type: "login.screenshot" }
  | { type: "login.submit"; login: string; password: string }
  | { type: "login.code"; code: string }
);
export type LoginReply = { callId: string } & (
  // codeFrom (an addition, owner decision 2026-10-15): "email" — the code
  // asked for is the one Fansly e-mailed for a login from a new device;
  // absent — the 2FA code, or an operator older than this.
  | { type: "login.stateResult"; screen: LoginScreen; screenVersion: string; fields: ("login" | "password" | "code")[]; siteError: string | null; codeFrom?: "email" }
  | { type: "login.screenshotResult"; jpeg: BodyRef }
  | { type: "login.refused"; reason: "token" | "not_manual_login" | "screen_changed" | "busy" }
);
export type EngineToOperator = Hello | (PingPong & FromEngine) | Send | CheckResult | ResultAck | Recover | SiteAdmitResult | WsAdmitResult | EventsSubscribe | Ack | Command | SiteObservedAck;
export type OperatorToEngine =
  | HelloResult
  | Quiesced
  | State
  | PingPong
  | Check
  | Sent
  | Result
  | RecoverResult
  | AdmissionCancel
  | SiteAdmit
  | SiteDone
  | WsAdmit
  | WsDone
  | SiteSent
  | SiteEnded
  | SiteIdentity
  | Events
  | EventsRefused
  | CommandResult
  | Alarm;

// ── what this operator reads from the engine ──

/** The buffer's messages (PR 11). */
export type BufferMessage = EventsSubscribe | Ack | ResultAck | Recover;

/** The engine's messages this operator handles. */
export type HandledMessage = Hello | (PingPong & FromEngine) | Command | BufferMessage | HubMessage | WsAdmitResult | SiteAdmitResult | SiteObservedAck;

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

const COMMAND_KINDS = new Set<string>(["closeExit", "openExit", "stopPage", "restartBrowser", "selfTest", "profileSnapshot", "setMode", "clearHalt", "setPublishing"]);

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
  if (kind === "clearHalt") {
    const haltId = str(command.haltId, "command.haltId", 64);
    if (haltId === "") throw new Invalid("an empty command.haltId");
    return { ...base, command: { kind: "clearHalt", haltId } };
  }
  if (kind === "setPublishing") {
    if (typeof command.create !== "boolean" || typeof command.withdraw !== "boolean") throw new Invalid("setPublishing's create and withdraw are not booleans");
    const clearStop = command.clearStop === undefined ? undefined : str(command.clearStop, "command.clearStop", 64);
    return { ...base, command: { kind: "setPublishing", create: command.create, withdraw: command.withdraw, ...(clearStop === undefined ? {} : { clearStop }) } };
  }
  return { ...base, command: { kind: kind as CommandKind } };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** An HTTP header name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const REFUSALS = new Set<string>(["lease_inactive", "lease_used", "send_deadline_passed", "pace", "takeover_floor", "generation_stale", "session_mismatch", "write_refused"]);
/** A send names at most this many headers of its route. */
const MAX_SEND_HEADERS = 64;

function sha256Hex(value: unknown, what: string): string {
  const text = str(value, what, 64);
  if (!SHA256_HEX.test(text)) throw new Invalid(`${what} is not a sha256 in hex`);
  return text;
}

/** A write's body and fingerprint (minor 8): both with a POST of kind api,
 *  neither with a GET. */
function parseWrite(m: Record<string, unknown>, kind: string): Pick<Send, "method" | "body" | "writeFingerprint"> {
  if (m.method === "GET") {
    if (m.body !== undefined || m.writeFingerprint !== undefined) throw new Invalid("a GET with a body or a write's fingerprint");
    return { method: "GET" };
  }
  if (m.method !== "POST") throw new Invalid("method is not GET or POST");
  if (kind !== "api") throw new Invalid("a POST that is not of kind api");
  const body = str(m.body, "body", WRITE_BODY_MAX);
  if (Buffer.byteLength(body, "utf8") > WRITE_BODY_MAX) throw new Invalid(`a body over ${WRITE_BODY_MAX} bytes`);
  return { method: "POST", body, writeFingerprint: sha256Hex(m.writeFingerprint, "writeFingerprint") };
}

function parseSend(m: Record<string, unknown>): Send {
  const kind = str(m.kind, "kind", 16);
  if (kind !== "api" && kind !== "image" && kind !== "video") throw new Invalid(`an unknown kind ${kind}`);
  const write = parseWrite(m, kind);
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
    url: str(m.url, "url", 16_384),
    headers,
    kind,
    maxBodyBytes: int(m.maxBodyBytes, "maxBodyBytes"),
    sendDeadlineMono: num(m.sendDeadlineMono, "sendDeadlineMono"),
    requestDeadlineMono: num(m.requestDeadlineMono, "requestDeadlineMono"),
    ...write,
  };
}

/** An admission's pause, at most (the owner's setting is seconds). */
const MAX_PAUSE_MS = 10 * 60_000;

function parseCheckResult(m: Record<string, unknown>): CheckResult {
  const base = { type: "checkResult" as const, ownerGeneration: int(m.ownerGeneration, "ownerGeneration"), attemptId: int(m.attemptId, "attemptId", 1) };
  if (m.admit === true) {
    return {
      ...base,
      admit: true as const,
      deadlineMono: num(m.deadlineMono, "deadlineMono"),
      ...(m.pauseMs === undefined ? {} : { pauseMs: int(m.pauseMs, "pauseMs", 0, MAX_PAUSE_MS) }),
      ...(m.writeFingerprint === undefined ? {} : { writeFingerprint: sha256Hex(m.writeFingerprint, "writeFingerprint") }),
    };
  }
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

const SITE_REFUSALS = new Set<string>(["paused", "held", "credentials", "mode", "route_hold", "site_hour_cap", "buffer_full", "session_mismatch", "wait_expired"]);

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
      case "siteObservedAck": {
        const seqs = ints(m.deliverySeqs, "deliverySeqs");
        if (seqs.length > SITE_OBSERVED_ACK_MAX) throw new Invalid(`deliverySeqs names more than ${SITE_OBSERVED_ACK_MAX}`);
        return { ok: true, message: { type, ownerGeneration: int(m.ownerGeneration, "ownerGeneration"), deliverySeqs: seqs } };
      }
      default:
        return { ok: false, error: LATER_TYPES.has(type) ? `${type} is not supported by this operator yet` : `an unknown message type ${JSON.stringify(type.slice(0, 40))}` };
    }
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message };
    throw error;
  }
}

// ── the login form's calls (API → operator; PR 15) ──

/** A login (user name or e-mail) is at most this long. */
export const LOGIN_MAX = 320;
/** A password is at most this long. */
export const PASSWORD_MAX = 1024;
/** A code is at most this long. */
export const CODE_MAX = 32;
const CALL_ID = /^[A-Za-z0-9-]{1,64}$/;
/** No line break or NUL in what is typed into the site's form. */
const TYPED = /^[^\r\n\0]*$/;

export type ParsedLogin = { ok: true; request: LoginRequest } | { ok: false; error: string };

/** A call of the API as this operator reads it, its token checked by the
 *  caller first. An error never repeats what was typed: it names the field. */
export function parseLoginRequest(value: unknown): ParsedLogin {
  try {
    const m = record(value, "the call");
    const callId = str(m.callId, "callId", 64);
    if (!CALL_ID.test(callId)) throw new Invalid("callId is not an id");
    const token = str(m.token, "token");
    const typed = (field: unknown, what: string, max: number): string => {
      const text = str(field, what, max);
      if (text === "" || !TYPED.test(text)) throw new Invalid(`${what} is empty or has a line break`);
      return text;
    };
    switch (m.type) {
      case "login.state":
      case "login.open":
      case "login.screenshot":
        return { ok: true, request: { type: m.type, callId, token } };
      case "login.submit":
        return { ok: true, request: { type: "login.submit", callId, token, login: typed(m.login, "login", LOGIN_MAX), password: typed(m.password, "password", PASSWORD_MAX) } };
      case "login.code":
        return { ok: true, request: { type: "login.code", callId, token, code: typed(m.code, "code", CODE_MAX) } };
      default:
        return { ok: false, error: "an unknown call of the login form" };
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
