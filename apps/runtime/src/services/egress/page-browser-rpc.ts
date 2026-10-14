import { createHash, randomUUID } from "node:crypto";

import { Agent, WebSocket, type MessageEvent } from "undici";

import {
  BODY_PART_BYTES,
  decodeBodyFrame,
  DEFAULT_PARAMS,
  parseOperatorMessage,
  PROTOCOL,
  SUPPORTED_MAJORS,
  type Alarm,
  type BodyRef,
  type BufferEvent,
  type Check,
  type CheckResult,
  type Command,
  type CommandKind,
  type CommandResult,
  type EngineToOperator,
  type EventsRefused,
  type Hello,
  type Mode,
  type OperatorParams,
  type OperatorToEngine,
  type Quiesced,
  type Recover,
  type RecoverResult,
  type Refusal,
  type Result,
  type Send,
  type Sent,
  type SiteAdmitResult,
  type SiteDone,
  type State,
  type WsAdmitResult,
  type WsDone,
} from "./page-browser-protocol.ts";

// The engine's RPC client to a page's operator (Project Browser, plan §4.13;
// spec §6): one WebSocket from `sync` to ws://page-browser-<page>:7700/rpc on
// pb-control, JSON messages, bodies as binary frames before the JSON that
// names them. The network of the engine lives in services/egress (the
// repository's ESLint wall); the protocol's types are the engine's mirror of
// the operator's (`page-browser-protocol.ts`).
//
// - The link. `hello` first, with the page's token, the owner generation and
//   the page's settings (read anew at every connect: a changed proxy goes in
//   the next hello, `reconnect`); `helloResult` brings the operator's buffer
//   id and state. Refused for its token or protocol major: the link stays
//   down and is tried again rarely (`link_error`, spec §6.3 rule 6); refused
//   as `generation_stale`: a newer owner holds the page — this client is
//   done for good. Every message of the engine carries the generation.
// - ping/pong both ways every second; nothing heard for 5 s and the link is
//   lost: the socket closes and a new hello follows after a short backoff.
// - A Hub request (`send`): the operator's `check` is answered at once by the
//   attempt's handler — a check the client cannot route to a live handler is
//   refused (`lease_inactive`): nothing is ever admitted by default. `sent`
//   and `result` go to the same handler; the result's body is reassembled
//   from its binary frames and checked (size, sha256) before the handler
//   sees it. `resultAck` only when the engine's commit says so.
// - Bodies: frames of one body come in order from part 0; part 0 starts the
//   body anew (a body is sent again with every delivery), the flag 2
//   abandons it (the parts before are void), the last flag completes it.
//   Bounded: a body larger than the API's limit, or more bodies in the air
//   than a delivery ever has, breaks the protocol — the connection closes.
//   A result whose body did not arrive whole is asked for again once
//   (`recover`), then handed over without it.
// - `recover`: the operator resends the outcomes it holds of the attempts
//   named, then answers with the state of each; the results — and the site
//   path's ends, `siteDone` and `wsDone` — resent on the way are collected
//   for the caller.
// - The event stream (plan §4.4, PR 13): `events.subscribe` and `ack` with
//   the buffer's id; each `events` batch goes to the intake's listener with
//   the bodies its site responses name (their frames come before the batch,
//   reassembled and checked as a result's), `events.refused` to its own.
// - `state`, `alarm`, `quiesced`: kept and told to listeners. Messages of the
//   site path (siteAdmit, wsAdmit) go to a listener when one is registered
//   (`onOtherMessage`), and are dropped otherwise: the operator's own waits
//   refuse what nobody admits. Their answers (`answerSiteAdmit`,
//   `answerWsAdmit`) go only on the connection they were asked on. A
//   `siteDone`/`wsDone` goes to the site path's claim (`onEnd`, PR 14); one
//   it does not claim is an outcome nobody waits for (`onUnclaimedOutcome`).
// - `command` (PR 14): one id each, its `commandResult` awaited; a link that
//   goes before the result answers null (whether it ran is not known).

/** What one hello of a page carries besides the generation (spec §6.1). */
export interface PageBrowserLinkSettings {
  /** The page's RPC token for the engine (`page_browsers`, decrypted). */
  token: string;
  pageId: number;
  expectedAccountId: string;
  pinnedExitIp: string;
  socks5: { ip: string; port: number; username: string; password: string };
  env: Hello["env"];
  params?: OperatorParams;
}

export interface RpcLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

const silentLogger: RpcLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined };

export interface PageBrowserRpcTiming {
  pingMs: number;
  linkLossMs: number;
  helloTimeoutMs: number;
  /** The waits before a new connect, by consecutive failures (the last one
   *  repeats). */
  reconnectMs: readonly number[];
  /** The wait after a refusal of the token or the protocol major. */
  refusedRetryMs: number;
}

export const DEFAULT_RPC_TIMING: PageBrowserRpcTiming = {
  pingMs: 1_000,
  linkLossMs: 5_000,
  helloTimeoutMs: 5_000,
  reconnectMs: [250, 1_000, 2_000, 5_000],
  refusedRetryMs: 60_000,
};

/** The largest body the engine takes (the API's 32 MiB, plan §4.14) plus a
 *  frame's slack. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024 + BODY_PART_BYTES;
/** Bodies in the air at once (in parts, or whole and waiting for their
 *  JSON): the operator sends one outcome at a time beside one event batch of
 *  at most 500 events, each naming at most one body (plan §4.14). */
export const MAX_PENDING_BODIES = 512;
/** Their bytes together: two of the largest bodies. */
export const MAX_PENDING_BODY_BYTES = 2 * MAX_BODY_BYTES;

export type LinkStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "up"; bufferId: string; protocol: { major: number; minor: number } }
  | { kind: "down"; reason: string }
  /** The operator refused the hello for its token or protocol major: tried
   *  again only after `refusedRetryMs` (spec §6.3 rule 6). */
  | { kind: "refused"; reason: "token" | "protocol_major"; supportedMajors: number[] }
  /** A newer owner of the page holds the operator: this client is done. */
  | { kind: "superseded" }
  | { kind: "closed" };

/** The answer to an operator's check: the admission, or why not. */
export type CheckReply = { admit: true; deadlineMono: number } | { admit: false; reason: Refusal };

/** A result as the client hands it over: its body checked, or why it is
 *  missing. */
export interface DeliveredResult {
  result: Result;
  /** The body named by a `response` outcome, whole and checked; null when
   *  the outcome names none. */
  body: Buffer | null;
  /** Why the named body is not here (it did not arrive whole); null: fine. */
  bodyProblem: string | null;
}

export interface AttemptHandlers {
  /** The operator holds the request paused until the answer (it waits a
   *  few seconds, then fails the request): an asynchronous answer is written
   *  when it settles, on the connection the check came on only. */
  onCheck(check: Check): CheckReply | Promise<CheckReply>;
  onSent(sent: Sent): void;
  onResult(delivered: DeliveredResult): void;
}

export interface RecoverAnswer {
  states: Map<number, RecoverResult["attempts"][number]["state"]>;
  /** The outcomes resent for the attempts asked about, on the way. */
  results: Map<number, DeliveredResult>;
  /** The site path's ends resent on the way (a site request's `siteDone`, a
   *  site socket's `wsDone`). */
  ends: Map<number, SiteDone | WsDone>;
}

/** A body an event names, as it arrived: whole and checked, or why not. */
export interface DeliveredBody {
  body: Buffer | null;
  problem: string | null;
}

/** One batch of the operator's event stream (plan §4.4), with the bodies its
 *  site responses name. */
export interface DeliveredEvents {
  bufferId: string;
  events: BufferEvent[];
  /** By body id. */
  bodies: Map<string, DeliveredBody>;
  /** The connection it came on (`epoch`). */
  epoch: number;
}

/** The link went down (or the client closed) before an answer. */
export class PageBrowserLinkError extends Error {
  constructor(reason: string) {
    super(`The page browser link is down: ${reason}`);
    this.name = "PageBrowserLinkError";
  }
}

/** The engine's monotonic clock (`performance.now()`) against the kernel's
 *  CLOCK_MONOTONIC the operator speaks (plan §4.2, step 5): one constant shift
 *  — both read libuv's hrtime — taken once. */
export interface MonoBridge {
  toKernel(engineMono: number): number;
  fromKernel(kernelMono: number): number;
}

export function systemMonoBridge(): MonoBridge {
  // The tightest of a few back-to-back readings of both clocks.
  let offset = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 5; i++) {
    const before = performance.now();
    const kernel = Number(process.hrtime.bigint()) / 1e6;
    const after = performance.now();
    const candidate = kernel - (before + after) / 2;
    if (Math.abs(candidate) < Math.abs(offset) || offset === Number.POSITIVE_INFINITY) offset = candidate;
  }
  return { toKernel: (mono) => mono + offset, fromKernel: (kernel) => kernel - offset };
}

/** The digest of what a hello said of the page's egress and environment: a
 *  change of it needs a new hello (`PageBrowserRpcClient.helloDigest`). */
export function linkSettingsDigest(settings: PageBrowserLinkSettings): string {
  return createHash("sha256").update(JSON.stringify({
    pageId: settings.pageId,
    expectedAccountId: settings.expectedAccountId,
    pinnedExitIp: settings.pinnedExitIp,
    socks5: settings.socks5,
    env: settings.env,
  })).digest("hex");
}

export interface PageBrowserRpcOptions {
  /** `ws://page-browser-<page>:7700/rpc`. */
  url: string;
  ownerGeneration: bigint;
  /** Read at every connect. A throw is a failed connect (tried again). */
  settings: () => Promise<PageBrowserLinkSettings>;
  /** A cheap digest of what `settings` is made of (the stored rows, no DNS,
   *  no decryption): read before each hello and by `settingsDigestNow`.
   *  Default: `linkSettingsDigest` of the settings themselves. */
  revision?: () => Promise<string>;
  logger?: RpcLogger;
  timing?: Partial<PageBrowserRpcTiming>;
  /** The link's own clock (default `performance.now()`). */
  monoNow?: () => number;
}

type OtherMessage = Exclude<OperatorToEngine, { type: "helloResult" | "quiesced" | "state" | "ping" | "pong" | "check" | "sent" | "result" | "recoverResult" | "alarm" | "events" | "events.refused" | "commandResult" }>;

/** `Omit` over each member of a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface Assembly {
  parts: Buffer[];
  next: number;
  bytes: number;
  done: boolean;
}

interface PendingRecover {
  ids: Set<number>;
  results: Map<number, DeliveredResult>;
  ends: Map<number, SiteDone | WsDone>;
  resolve: (answer: RecoverAnswer) => void;
  reject: (error: Error) => void;
}

export class PageBrowserRpcClient {
  readonly #o: PageBrowserRpcOptions;
  readonly #timing: PageBrowserRpcTiming;
  readonly #log: RpcLogger;
  readonly #now: () => number;
  readonly #generation: number;
  #status: LinkStatus = { kind: "idle" };
  #socket: WebSocket | null = null;
  #agent: Agent | null = null;
  #epoch = 0;
  #greeted = false;
  #lastHeard = 0;
  #lastPingAt = 0;
  #pingN = 0;
  #failures = 0;
  #timer: NodeJS.Timeout | null = null;
  #retryTimer: NodeJS.Timeout | null = null;
  #helloTimer: NodeJS.Timeout | null = null;
  #closed = false;
  #state: State | null = null;
  #quiesced: Quiesced | null = null;
  #helloDigest: string | null = null;
  readonly #attempts = new Map<number, AttemptHandlers>();
  readonly #bodies = new Map<string, Assembly>();
  /** The bytes of `#bodies` together. */
  #bodyBytes = 0;
  /** Results whose body was asked for again (`recover`), by attempt. */
  readonly #reasked = new Set<number>();
  #recover: PendingRecover | null = null;
  readonly #recoverQueue: PendingRecover[] = [];
  /** Bytes of outcomes received over every connection: body frames, results
   *  and the site path's ends — what a delivery moves. Never falls. */
  #outcomeBytes = 0;
  /** When the recover asked now was written, or a byte of an outcome last
   *  came (`#now`). */
  #deliveryMovedAt = 0;
  readonly #stateListeners = new Set<(state: State) => void>();
  readonly #alarmListeners = new Set<(alarm: Alarm) => void>();
  readonly #linkListeners = new Set<(status: LinkStatus) => void>();
  #unclaimed: ((delivered: DeliveredResult) => void) | null = null;
  #unclaimedEnd: ((end: SiteDone | WsDone) => void) | null = null;
  #events: ((delivered: DeliveredEvents) => void) | null = null;
  #eventsRefused: ((refused: EventsRefused) => void) | null = null;
  #other: ((message: OtherMessage) => void) | null = null;
  #endClaim: ((end: SiteDone | WsDone) => boolean) | null = null;
  readonly #quiescedListeners = new Set<(quiesced: Quiesced) => void>();
  /** Commands awaiting their result, by id. */
  readonly #commands = new Map<string, (result: CommandResult | null) => void>();

  constructor(options: PageBrowserRpcOptions) {
    const url = new URL(options.url);
    if (url.protocol !== "ws:" || url.pathname !== "/rpc" || url.username !== "" || url.password !== "") {
      throw new Error(`not an operator RPC address: ${url.protocol}//${url.host}${url.pathname}`);
    }
    this.#o = options;
    this.#timing = { ...DEFAULT_RPC_TIMING, ...options.timing };
    this.#log = options.logger ?? silentLogger;
    this.#now = options.monoNow ?? (() => performance.now());
    this.#generation = Number(options.ownerGeneration);
    if (!Number.isSafeInteger(this.#generation) || this.#generation < 0) throw new Error("an owner generation the protocol cannot carry");
  }

  // ── the link ─────────────────────────────────────────────────────────────

  get status(): LinkStatus {
    return this.#status;
  }

  /** The link is up: a hello was answered and the operator was heard within
   *  the link-loss time. */
  get up(): boolean {
    return this.#status.kind === "up" && this.#greeted && this.#now() - this.#lastHeard <= this.#timing.linkLossMs;
  }

  /** The operator's last `state` (from its helloResult or a state message);
   *  null before the first, and after the link went down. */
  get state(): State | null {
    return this.up ? this.#state : null;
  }

  /** The operator's `quiesced` after this owner's hello (plan §4.7), if any. */
  get quiesced(): Quiesced | null {
    return this.#quiesced;
  }

  /** The revision of the settings the current link's hello carried (null: no
   *  link). */
  get helloDigest(): string | null {
    return this.up ? this.#helloDigest : null;
  }

  /** The owner generation every message of this client carries. */
  get ownerGeneration(): number {
    return this.#generation;
  }

  /** Changes whenever the link does (a new connection, a loss). */
  get epoch(): number {
    return this.#epoch;
  }

  /** The revision of the page's settings now (read anew): unlike
   *  `helloDigest`, the hello needs saying again. */
  async settingsDigestNow(): Promise<string> {
    return this.#o.revision !== undefined ? this.#o.revision() : linkSettingsDigest(await this.#o.settings());
  }

  onState(listener: (state: State) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  onAlarm(listener: (alarm: Alarm) => void): () => void {
    this.#alarmListeners.add(listener);
    return () => this.#alarmListeners.delete(listener);
  }

  onLink(listener: (status: LinkStatus) => void): () => void {
    this.#linkListeners.add(listener);
    return () => this.#linkListeners.delete(listener);
  }

  /** Results of attempts no handler waits for (outcomes replayed to a new
   *  connection: the transport's held outcomes, PR 13). Without one they are
   *  dropped, never acked. */
  onUnclaimedResult(listener: ((delivered: DeliveredResult) => void) | null): void {
    this.#unclaimed = listener;
  }

  /** A site request's or a site socket's end (`siteDone`, `wsDone`) when no
   *  site path listens (`onOtherMessage`): an outcome the operator holds that
   *  nothing waits for (PR 13). Without one it is dropped, never acked. */
  onUnclaimedOutcome(listener: ((end: SiteDone | WsDone) => void) | null): void {
    this.#unclaimedEnd = listener;
  }

  /** The event stream's batches, with their bodies (PR 13). Without a
   *  listener a batch is dropped, never acked: it comes again. */
  onEvents(listener: ((delivered: DeliveredEvents) => void) | null): void {
    this.#events = listener;
  }

  /** The operator refused a subscription or an ack (`events.refused`). */
  onEventsRefused(listener: ((refused: EventsRefused) => void) | null): void {
    this.#eventsRefused = listener;
  }

  /** The site path's messages: `siteAdmit`, `wsAdmit` (PR 14). */
  onOtherMessage(listener: ((message: OtherMessage) => void) | null): void {
    this.#other = listener;
  }

  /** A site request's or a site socket's end, offered to the site path
   *  first (PR 14): true — it is the site path's (an admission it waits
   *  for); false — an outcome nobody waits for (`onUnclaimedOutcome`). */
  onEnd(claim: ((end: SiteDone | WsDone) => boolean) | null): void {
    this.#endClaim = claim;
  }

  /** The operator's `quiesced` for this owner (plan §4.7): told once it
   *  comes; `quiesced` keeps it. */
  onQuiesced(listener: (quiesced: Quiesced) => void): () => void {
    this.#quiescedListeners.add(listener);
    return () => this.#quiescedListeners.delete(listener);
  }

  /** A command of this owner (spec §6.1 `command`): its result, or null when
   *  it could not be sent, the link went before the result, or none came
   *  within `waitMs` — whether it ran is then not known. `notAfterMono` is
   *  the operator's clock (CLOCK_MONOTONIC): later, it is not executed. */
  command(kind: CommandKind | { kind: "setMode"; mode: Mode }, notAfterMono: number, waitMs: number): Promise<CommandResult | null> {
    const commandId = randomUUID();
    const command: Command["command"] = typeof kind === "string" ? { kind } : kind;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(null), waitMs);
      timer.unref?.();
      const settle = (result: CommandResult | null) => {
        if (!this.#commands.has(commandId)) return;
        this.#commands.delete(commandId);
        clearTimeout(timer);
        resolve(result);
      };
      this.#commands.set(commandId, settle);
      if (!this.#write({ type: "command", ownerGeneration: this.#generation, commandId, notAfterMono, command })) settle(null);
    });
  }

  /** The answer to a `siteAdmit` asked on the connection of `epoch` (PR 14).
   *  False: that connection is gone — the operator refuses every admission
   *  asked on it — or nothing could be written. */
  answerSiteAdmit(epoch: number, answer: DistributiveOmit<SiteAdmitResult, "type" | "ownerGeneration">): boolean {
    if (epoch !== this.#epoch) return false;
    return this.#write({ ...answer, type: "siteAdmitResult", ownerGeneration: this.#generation } as SiteAdmitResult);
  }

  /** The answer to a `wsAdmit` asked on the connection of `epoch` (PR 14). */
  answerWsAdmit(epoch: number, answer: DistributiveOmit<WsAdmitResult, "type" | "ownerGeneration">): boolean {
    if (epoch !== this.#epoch) return false;
    return this.#write({ ...answer, type: "wsAdmitResult", ownerGeneration: this.#generation } as WsAdmitResult);
  }

  start(): void {
    if (this.#closed || this.#socket !== null || this.#retryTimer !== null) return;
    this.#timer ??= setInterval(() => this.#tick(), Math.max(50, Math.min(250, this.#timing.pingMs / 4)));
    this.#timer.unref?.();
    void this.#connect();
  }

  /** A new hello now (the page's settings changed: a proxy, its account). */
  reconnect(reason: string): void {
    if (this.#closed || this.#status.kind === "superseded") return;
    this.#log.info({ url: this.#o.url, reason }, "page browser link: reconnecting");
    this.#drop(`reconnect: ${reason}`, 0);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#teardown("the client closed");
    this.#setStatus({ kind: "closed" });
    for (const pending of [this.#recover, ...this.#recoverQueue.splice(0)]) pending?.reject(new PageBrowserLinkError("the client closed"));
    this.#recover = null;
    this.#attempts.clear();
  }

  // ── a Hub request ────────────────────────────────────────────────────────

  /** Route the operator's check, sent and result of `attemptId` to
   *  `handlers` until the returned function is called. */
  register(attemptId: number, handlers: AttemptHandlers): () => void {
    this.#attempts.set(attemptId, handlers);
    return () => {
      if (this.#attempts.get(attemptId) === handlers) this.#attempts.delete(attemptId);
    };
  }

  /** The engine's `send` (its generation is the client's). False: no link. */
  send(message: Omit<Send, "type" | "ownerGeneration">): boolean {
    return this.#write({ type: "send", ownerGeneration: this.#generation, ...message });
  }

  /** The outcome of `attemptId` is committed: the operator may drop it. */
  resultAck(attemptId: number): boolean {
    return this.#write({ type: "resultAck", ownerGeneration: this.#generation, attemptId });
  }

  /** The event stream from the event after `afterSeq` of `bufferId` — the
   *  engine's word that it has every event up to it (plan §4.4). False: no
   *  link. */
  subscribe(bufferId: string, afterSeq: number): boolean {
    return this.#write({ type: "events.subscribe", ownerGeneration: this.#generation, bufferId, afterSeq });
  }

  /** Every event of `bufferId` up to `uptoSeq` is committed. False: no link. */
  ack(bufferId: string, uptoSeq: number): boolean {
    return this.#write({ type: "ack", ownerGeneration: this.#generation, bufferId, uptoSeq });
  }

  /** The outcomes the operator holds of `attemptIds`, resent, and the state
   *  of each. Rejects when the link goes before the answer. */
  /** Bytes of outcomes received over every connection (body frames, results,
   *  the site path's ends): a delivery under way moves it. Never falls. */
  get outcomeBytes(): number {
    return this.#outcomeBytes;
  }

  /** A recover is asked and not answered yet, or waits its turn. */
  get recoverPending(): boolean {
    return this.#recover !== null || this.#recoverQueue.length > 0;
  }

  /** How long the operator's answer to the recover asked on this connection
   *  has been coming without a byte of an outcome (since it was written, or
   *  the last byte); null: none is asked. The operator answers a recover
   *  after the deliveries ahead of it (buffer/replay.ts), so a recover asked
   *  and not answered is a delivery under way — or a stalled one, once this
   *  grows long. */
  deliveryIdleMs(): number | null {
    return this.#recover === null ? null : this.#now() - this.#deliveryMovedAt;
  }

  recover(attemptIds: readonly number[]): Promise<RecoverAnswer> {
    return new Promise((resolve, reject) => {
      const pending: PendingRecover = { ids: new Set(attemptIds), results: new Map(), ends: new Map(), resolve, reject };
      this.#recoverQueue.push(pending);
      this.#nextRecover();
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  #setStatus(status: LinkStatus): void {
    this.#status = status;
    for (const listener of this.#linkListeners) {
      try {
        listener(status);
      } catch {
        // a listener's failure is its own
      }
    }
  }

  async #connect(): Promise<void> {
    if (this.#closed) return;
    this.#setStatus({ kind: "connecting" });
    let settings: PageBrowserLinkSettings;
    let digest: string;
    try {
      // The revision first: a change between the two reads makes the next
      // comparison see it (one more hello), never miss it.
      const revision = this.#o.revision === undefined ? null : await this.#o.revision();
      settings = await this.#o.settings();
      digest = revision ?? linkSettingsDigest(settings);
    } catch (error) {
      this.#log.warn({ url: this.#o.url, err: errorName(error) }, "page browser link: the page's settings could not be read");
      this.#scheduleRetry("settings unreadable", this.#backoff());
      return;
    }
    if (this.#closed) return;
    const agent = new Agent({ connect: { timeout: this.#timing.helloTimeoutMs } });
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.#o.url, { dispatcher: agent });
    } catch (error) {
      void agent.close().catch(() => undefined);
      this.#scheduleRetry(`connect failed: ${errorName(error)}`, this.#backoff());
      return;
    }
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    this.#agent = agent;
    this.#epoch += 1;
    this.#greeted = false;
    const epoch = this.#epoch;
    this.#helloTimer = setTimeout(() => {
      if (this.#epoch === epoch && !this.#greeted) this.#drop("no helloResult in time", this.#backoff());
    }, this.#timing.helloTimeoutMs);
    socket.addEventListener("open", () => {
      if (this.#epoch !== epoch) return;
      const hello: Hello = {
        type: "hello",
        ownerGeneration: this.#generation,
        protocol: { majors: [...SUPPORTED_MAJORS], minor: PROTOCOL.minor },
        token: settings.token,
        pageId: settings.pageId,
        expectedAccountId: settings.expectedAccountId,
        pinnedExitIp: settings.pinnedExitIp,
        params: settings.params ?? DEFAULT_PARAMS,
        socks5: settings.socks5,
        env: settings.env,
      };
      this.#lastHeard = this.#now();
      socket.send(JSON.stringify(hello));
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (this.#epoch !== epoch) return;
      this.#lastHeard = this.#now();
      const data: unknown = event.data;
      if (typeof data === "string") this.#onText(data, digest);
      else if (data instanceof ArrayBuffer) this.#onBinary(Buffer.from(data));
      else this.#protocolError("a frame of an unknown kind");
    });
    socket.addEventListener("close", (event) => {
      if (this.#epoch !== epoch) return;
      this.#onClosed(event.code === 4002 ? "superseded by another connection" : `closed (${event.code})`);
    });
    socket.addEventListener("error", () => {
      // The close event follows.
    });
  }

  #onClosed(reason: string): void {
    this.#teardown(reason);
    if (this.#closed || this.#status.kind === "superseded" || this.#status.kind === "refused") return;
    this.#setStatus({ kind: "down", reason });
    this.#scheduleRetry(reason, this.#backoff());
  }

  #backoff(): number {
    const ladder = this.#timing.reconnectMs;
    const wait = ladder[Math.min(this.#failures, ladder.length - 1)] ?? 1_000;
    this.#failures += 1;
    return wait;
  }

  #scheduleRetry(reason: string, waitMs: number): void {
    if (this.#closed || this.#retryTimer !== null || this.#status.kind === "superseded") return;
    if (this.#status.kind !== "refused") this.#setStatus({ kind: "down", reason });
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void this.#connect();
    }, waitMs);
    this.#retryTimer.unref?.();
  }

  /** Close the current socket; everything of its connection ends. */
  #teardown(reason: string): void {
    const socket = this.#socket;
    const agent = this.#agent;
    this.#socket = null;
    this.#agent = null;
    if (this.#helloTimer !== null) clearTimeout(this.#helloTimer);
    this.#helloTimer = null;
    const wasUp = this.#greeted;
    this.#greeted = false;
    this.#epoch += 1;
    this.#bodies.clear();
    this.#bodyBytes = 0;
    this.#reasked.clear();
    this.#state = null;
    this.#helloDigest = null;
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        // closing a socket that never opened
      }
    }
    if (agent !== null) void agent.destroy().catch(() => undefined);
    // The recover asked on this connection is never answered; those waiting
    // their turn go on the next one.
    const asked = this.#recover;
    this.#recover = null;
    asked?.reject(new PageBrowserLinkError(reason));
    // A command's result never comes on another connection.
    for (const settle of [...this.#commands.values()]) settle(null);
    if (wasUp) this.#log.info({ url: this.#o.url, reason }, "page browser link: down");
  }

  /** Drop the connection and connect again after `waitMs`. */
  #drop(reason: string, waitMs: number): void {
    this.#teardown(reason);
    if (this.#closed || this.#status.kind === "superseded") return;
    this.#setStatus({ kind: "down", reason });
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#scheduleRetry(reason, waitMs);
  }

  #protocolError(error: string): void {
    this.#log.warn({ url: this.#o.url, error }, "page browser link: protocol error; the connection closes");
    this.#drop(`protocol error: ${error}`, this.#backoff());
  }

  #tick(): void {
    if (!this.#greeted || this.#socket === null) return;
    const now = this.#now();
    if (now - this.#lastHeard > this.#timing.linkLossMs) {
      this.#drop(`nothing from the operator for ${Math.round(now - this.#lastHeard)} ms`, this.#backoff());
      return;
    }
    if (now - this.#lastPingAt >= this.#timing.pingMs) {
      this.#lastPingAt = now;
      this.#write({ type: "ping", n: ++this.#pingN, ownerGeneration: this.#generation });
    }
  }

  #write(message: EngineToOperator): boolean {
    const socket = this.#socket;
    if (socket === null || !this.#greeted || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  #onText(text: string, digest: string): void {
    const parsed = parseOperatorMessage(text);
    if (!parsed.ok) return this.#protocolError(parsed.error);
    const message = parsed.message;
    if (!this.#greeted) {
      if (message.type !== "helloResult") return this.#protocolError(`${message.type} before the helloResult`);
      return this.#onHelloResult(message, digest);
    }
    switch (message.type) {
      case "helloResult":
        return this.#protocolError("a second helloResult");
      case "ping":
        this.#write({ type: "pong", n: message.n, ownerGeneration: this.#generation });
        return;
      case "pong":
        return;
      case "quiesced": {
        // The operator says it again on every connection of this owner (a
        // connection may go before it is delivered): taken once.
        const first = this.#quiesced === null;
        this.#quiesced = message;
        if (!first) return;
        this.#log.info({ url: this.#o.url, previousGeneration: message.previousGeneration }, "page browser link: the previous owner's work is over");
        for (const listener of this.#quiescedListeners) safely(() => listener(message));
        return;
      }
      case "commandResult": {
        const settle = this.#commands.get(message.commandId);
        if (settle !== undefined) settle(message);
        else this.#log.debug({ url: this.#o.url, commandId: message.commandId }, "page browser link: a command result nobody waits for");
        return;
      }
      case "state":
        this.#state = message;
        for (const listener of this.#stateListeners) safely(() => listener(message));
        return;
      case "alarm":
        this.#log.warn({ url: this.#o.url, kind: message.kind, detail: message.detail }, "page browser: alarm");
        for (const listener of this.#alarmListeners) safely(() => listener(message));
        return;
      case "check":
        return this.#onCheck(message);
      case "sent": {
        const handlers = this.#attempts.get(message.attemptId);
        if (handlers !== undefined) safely(() => handlers.onSent(message));
        return;
      }
      case "result":
        return this.#onResult(message);
      case "recoverResult":
        return this.#onRecoverResult(message);
      case "events":
        return this.#onEvents(message);
      case "events.refused":
        if (this.#eventsRefused !== null) {
          const listener = this.#eventsRefused;
          safely(() => listener(message));
        }
        return;
      case "siteDone":
      case "wsDone":
        return this.#onEnd(message);
      default:
        return this.#toOther(message);
    }
  }

  /** A site request's or a site socket's end: kept for a recover that asked
   *  about it, then the site path's — or, with none listening, an outcome
   *  nothing waits for. */
  #onEnd(message: SiteDone | WsDone): void {
    this.#outcomeMoved(1);
    const recovering = this.#recover;
    if (recovering !== null && recovering.ids.has(message.attemptId)) recovering.ends.set(message.attemptId, message);
    if (this.#endClaim !== null) {
      const claim = this.#endClaim;
      let claimed = false;
      safely(() => {
        claimed = claim(message);
      });
      if (claimed) return;
      if (this.#unclaimedEnd !== null) {
        const listener = this.#unclaimedEnd;
        safely(() => listener(message));
        return;
      }
    }
    if (this.#other === null && this.#unclaimedEnd !== null) {
      const listener = this.#unclaimedEnd;
      safely(() => listener(message));
      return;
    }
    this.#toOther(message);
  }

  #toOther(message: OtherMessage): void {
    if (this.#other !== null) {
      const other = this.#other;
      safely(() => other(message));
    } else {
      this.#log.debug({ url: this.#o.url, type: message.type }, "page browser link: a message nobody takes yet");
    }
  }

  #onHelloResult(message: Extract<OperatorToEngine, { type: "helloResult" }>, digest: string): void {
    if (this.#helloTimer !== null) clearTimeout(this.#helloTimer);
    this.#helloTimer = null;
    if (!message.ok) {
      const reason = message.reason;
      this.#log.warn({ url: this.#o.url, reason, supportedMajors: message.supportedMajors }, "page browser link: the operator refused the hello");
      this.#teardown(`hello refused: ${reason}`);
      if (reason === "generation_stale") {
        this.#setStatus({ kind: "superseded" });
        if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
        this.#retryTimer = null;
        return;
      }
      this.#setStatus({ kind: "refused", reason, supportedMajors: message.supportedMajors });
      if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
      this.#scheduleRetry(`hello refused: ${reason}`, this.#timing.refusedRetryMs);
      return;
    }
    if (!SUPPORTED_MAJORS.includes(message.protocol.major)) return this.#protocolError(`the operator chose major ${message.protocol.major}`);
    this.#greeted = true;
    this.#failures = 0;
    this.#lastPingAt = 0;
    this.#state = message.state;
    this.#helloDigest = digest;
    this.#setStatus({ kind: "up", bufferId: message.bufferId, protocol: message.protocol });
    this.#log.info({ url: this.#o.url, generation: this.#generation, step: message.state.step }, "page browser link: up");
    for (const listener of this.#stateListeners) safely(() => listener(message.state));
    this.#nextRecover();
  }

  #onCheck(check: Check): void {
    const handlers = this.#attempts.get(check.attemptId);
    const refused: CheckReply = { admit: false, reason: "lease_inactive" };
    const failed = (error: unknown): CheckReply => {
      this.#log.warn({ attemptId: check.attemptId, err: errorName(error) }, "page browser link: a check's handler failed; refused");
      return refused;
    };
    // Nothing waits for this attempt here: it is never admitted.
    if (handlers === undefined) return this.#answerCheck(check, refused);
    let reply: CheckReply | Promise<CheckReply>;
    try {
      reply = handlers.onCheck(check);
    } catch (error) {
      return this.#answerCheck(check, failed(error));
    }
    if (!(reply instanceof Promise)) return this.#answerCheck(check, reply);
    const epoch = this.#epoch;
    void reply.then((settled) => settled, failed).then((settled) => {
      // On another connection the operator failed the paused request already.
      if (this.#epoch === epoch) this.#answerCheck(check, settled);
    });
  }

  #answerCheck(check: Check, reply: CheckReply): void {
    const answer: CheckResult = reply.admit
      ? { type: "checkResult", ownerGeneration: this.#generation, attemptId: check.attemptId, admit: true, deadlineMono: reply.deadlineMono }
      : { type: "checkResult", ownerGeneration: this.#generation, attemptId: check.attemptId, admit: false, reason: reply.reason };
    this.#write(answer);
  }

  #onBinary(frame: Buffer): void {
    let decoded: ReturnType<typeof decodeBodyFrame>;
    try {
      decoded = decodeBodyFrame(frame);
    } catch (error) {
      return this.#protocolError(errorName(error));
    }
    const { bodyId, part, last, abandoned, data } = decoded;
    this.#outcomeMoved(frame.length);
    if (abandoned) {
      // The parts sent of it are void; its outcome comes on a later delivery.
      this.#bodies.delete(bodyId);
      return;
    }
    let assembly = this.#bodies.get(bodyId);
    if (part === 0) {
      if (assembly !== undefined) this.#bodyBytes -= assembly.bytes;
      assembly = { parts: [], next: 0, bytes: 0, done: false };
      this.#bodies.delete(bodyId);
      this.#bodies.set(bodyId, assembly);
      if (this.#bodies.size > MAX_PENDING_BODIES) return this.#protocolError(`more than ${MAX_PENDING_BODIES} bodies in the air`);
    }
    if (assembly === undefined || assembly.done || part !== assembly.next) {
      return this.#protocolError(`part ${part} of body ${bodyId} out of order`);
    }
    assembly.parts.push(data);
    assembly.next += 1;
    assembly.bytes += data.length;
    this.#bodyBytes += data.length;
    if (assembly.bytes > MAX_BODY_BYTES) return this.#protocolError(`body ${bodyId} over ${MAX_BODY_BYTES} bytes`);
    if (this.#bodyBytes > MAX_PENDING_BODY_BYTES) return this.#protocolError(`more than ${MAX_PENDING_BODY_BYTES} bytes of bodies in the air`);
    if (last) assembly.done = true;
  }

  /** The body a result names, whole and checked, or why not. Taken out of
   *  the assemblies either way. */
  #takeBody(result: Result): { body: Buffer | null; problem: string | null } {
    if (result.outcome.kind !== "response") return { body: null, problem: null };
    return this.#takeBodyRef(result.outcome.body);
  }

  /** The body `ref` names, whole and checked, or why not. Taken out of the
   *  assemblies either way. */
  #takeBodyRef(ref: BodyRef): { body: Buffer | null; problem: string | null } {
    const assembly = this.#bodies.get(ref.bodyId);
    this.#bodies.delete(ref.bodyId);
    if (assembly !== undefined) this.#bodyBytes -= assembly.bytes;
    if (assembly === undefined) return { body: null, problem: "its body did not arrive" };
    if (!assembly.done) return { body: null, problem: "its body did not arrive whole" };
    const body = Buffer.concat(assembly.parts, assembly.bytes);
    if (body.length !== ref.decodedBytes) return { body: null, problem: `its body has ${body.length} bytes, not ${ref.decodedBytes}` };
    if (createHash("sha256").update(body).digest("hex") !== ref.sha256) return { body: null, problem: "its body's sha256 differs" };
    return { body, problem: null };
  }

  /** A delivery moved: `bytes` of an outcome came. */
  #outcomeMoved(bytes: number): void {
    this.#outcomeBytes += Math.max(1, bytes);
    this.#deliveryMovedAt = this.#now();
  }

  #onResult(result: Result): void {
    this.#outcomeMoved(1);
    const { body, problem } = this.#takeBody(result);
    const delivered: DeliveredResult = { result, body, bodyProblem: problem };
    const id = result.attemptId;
    const recovering = this.#recover;
    if (recovering !== null && recovering.ids.has(id)) recovering.results.set(id, delivered);
    // Asked for again: the recover's answer hands it over.
    if (this.#reasked.has(id)) return;
    if (problem !== null && this.#attempts.has(id)) {
      // Asked for once more: the operator keeps the outcome until its ack.
      this.#reasked.add(id);
      this.#log.warn({ attemptId: id, problem }, "page browser link: a result's body did not arrive whole; asked again");
      void this.recover([id]).then(
        (answer) => {
          this.#reasked.delete(id);
          this.#deliver(answer.results.get(id) ?? delivered);
        },
        () => {
          // The link went: the operator delivers its outcomes again to the
          // next connection.
          this.#reasked.delete(id);
        },
      );
      return;
    }
    this.#deliver(delivered);
  }

  /** A batch of the event stream: the bodies its site responses name taken
   *  out of the assemblies (their frames came first), then the batch to the
   *  intake. */
  #onEvents(message: Extract<OperatorToEngine, { type: "events" }>): void {
    const bodies = new Map<string, DeliveredBody>();
    for (const event of message.events) {
      if (event.kind !== "site.response" || bodies.has(event.body.bodyId)) continue;
      bodies.set(event.body.bodyId, this.#takeBodyRef(event.body));
    }
    const listener = this.#events;
    if (listener === null) {
      this.#log.debug({ url: this.#o.url, events: message.events.length }, "page browser link: an event batch nobody takes; left with the operator");
      return;
    }
    const delivered: DeliveredEvents = { bufferId: message.bufferId, events: message.events, bodies, epoch: this.#epoch };
    safely(() => listener(delivered));
  }

  #deliver(delivered: DeliveredResult): void {
    const handlers = this.#attempts.get(delivered.result.attemptId);
    if (handlers !== undefined) {
      safely(() => handlers.onResult(delivered));
      return;
    }
    if (this.#unclaimed !== null) {
      const unclaimed = this.#unclaimed;
      safely(() => unclaimed(delivered));
      return;
    }
    this.#log.debug({ attemptId: delivered.result.attemptId }, "page browser link: a result no attempt waits for; left with the operator");
  }

  #nextRecover(): void {
    if (this.#recover !== null || !this.#greeted) return;
    const next = this.#recoverQueue.shift();
    if (next === undefined) return;
    const message: Recover = { type: "recover", ownerGeneration: this.#generation, attemptIds: [...next.ids] };
    this.#recover = next;
    this.#deliveryMovedAt = this.#now();
    if (!this.#write(message)) {
      this.#recover = null;
      next.reject(new PageBrowserLinkError("no link to ask"));
      this.#nextRecover();
    }
  }

  #onRecoverResult(message: RecoverResult): void {
    const pending = this.#recover;
    this.#recover = null;
    if (pending === null) return this.#protocolError("a recoverResult nobody asked for");
    const states = new Map<number, RecoverResult["attempts"][number]["state"]>();
    for (const attempt of message.attempts) states.set(attempt.attemptId, attempt.state);
    pending.resolve({ states, results: pending.results, ends: pending.ends });
    this.#nextRecover();
  }
}

function safely(run: () => void): void {
  try {
    run();
  } catch {
    // a listener's failure is its own
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
