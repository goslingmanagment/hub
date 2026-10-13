// The runner's engine: Hub's `sync` as the operator meets it, over the real
// protocol (plan §4.13; src/rpc/protocol.ts) — one WebSocket to the page's
// operator, the page's token, its owner generation, its SOCKS5 and
// environment in `hello`; ping and pong; commands; the event stream
// committed to the stand's Postgres and acknowledged only after the commit;
// the outcomes committed and acknowledged (`resultAck`); `recover` after a
// restart; and the admissions — `checkResult` of a Hub request, the site's
// `siteAdmit` and the socket's `wsAdmit` — each journaled here with its
// absolute deadline, which is what the criteria compare the stand's journal
// with.
//
// Admissions follow the engine's rules as far as the stand needs them: one
// operation in flight per page, the next no sooner than `paceMs` after the
// previous one ended (plan §4.3, "Fansly rate ceiling"), the send window of
// 15 s (plan §4.14).

import { createHash, randomUUID } from "node:crypto";

import {
  decodeBodyFrame,
  DEFAULT_PARAMS,
  PROTOCOL,
  type Alarm,
  type BufferEvent,
  type Command,
  type CommandKind,
  type CommandResult,
  type Hello,
  type OperatorParams,
  type OperatorToEngine,
  type Quiesced,
  type RecoverResult,
  type Result,
  type SiteAdmit,
  type SiteDone,
  type State,
  type WsAdmit,
  type WsDone,
} from "../../src/rpc/protocol.ts";
import { atLeast } from "../../src/state/steps.ts";
import { mono, sleep, STAND_ACCOUNT_ID } from "../shared.ts";
import type { Store, StoredEvent } from "./store.ts";

/** Plan §4.14: the send window of an admission. */
export const SEND_WINDOW_MS = 15_000;

export interface Grant {
  kind: "hub" | "site" | "ws";
  attemptId: number;
  /** The site request's or the socket's id; the Hub attempt's own. */
  ref: string;
  method: string | null;
  /** host + path + query, as admitted. */
  target: string | null;
  grantedMono: number;
  deadlineMono: number;
  generation: number;
}

export interface Refusal {
  kind: "site" | "ws";
  ref: string;
  reason: string;
  atMono: number;
}

export interface SeenState {
  atMono: number;
  state: State;
}

export interface EngineOptions {
  page: string;
  pageId: number;
  url: string;
  token: string;
  socks: Hello["socks5"];
  pinnedExitIp: string;
  env: Hello["env"];
  params?: Partial<OperatorParams>;
  store: Store;
  /** Between the end of one admitted operation and the next admission. */
  paceMs?: number;
  /** Commit outcomes without a key and acknowledge them late: the control
   *  that shows the exactly-once check can fail. */
  naive?: boolean;
  /** Acknowledge events before they are committed, and keep the position
   *  in memory: the control that shows the contiguity check can fail. */
  ackEarly?: boolean;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export const STAND_ENV: Hello["env"] = { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.52, longitude: 13.405, accuracyM: 50 } };

/** The stand's parameters: production's (spec §8.2), but the exit IP is
 *  checked every 2 s and a failed start is retried after 1–3 s, so that a
 *  run sees its fault and its recovery in seconds, not minutes. */
export const STAND_PARAMS: Partial<OperatorParams> = { exitIpCheckMs: 2000, restartBackoffMs: [1000, 2000, 3000] };

export class StandEngine {
  readonly options: EngineOptions;
  generation = 0;
  bufferId = "";
  /** The run the engine commits for (a column of every row). */
  run = "idle";
  readonly states: SeenState[] = [];
  readonly grants: Grant[] = [];
  readonly refusals: Refusal[] = [];
  readonly alarms: Array<{ atMono: number; alarm: Alarm }> = [];
  readonly quiesced: Quiesced[] = [];
  readonly recoverResults: RecoverResult[] = [];
  readonly outcomeMessages: Array<{ atMono: number; message: Result | SiteDone | WsDone }> = [];
  readonly eventsRefused: Array<Record<string, unknown>> = [];
  /** Where the engine's position in each buffer stood (diagnostics). */
  readonly committedBatches: Array<{ bufferId: string; first: number; last: number; fresh: number; atMono: number }> = [];
  commitFailures = 0;
  /** Events received on the stream (committed or not). */
  eventsReceived = 0;
  /** ackEarly: events acknowledged whose commit failed. */
  eventsLost = 0;
  /** How long each commit to the stand's Postgres took, ms. */
  readonly commitMs: number[] = [];
  /** When the operator closed (or lost) the connection — not the engine's
   *  own drops. */
  readonly closures: number[] = [];
  protocolErrors: string[] = [];
  #ws: WebSocket | null = null;
  #closedAt: number | null = null;
  #answerPings = true;
  /** A silent engine says nothing at all: not a pong, not a message. */
  #silent = false;
  #commandResults = new Map<string, (result: CommandResult) => void>();
  #bodies = new Map<string, number>();
  #commitChain: Promise<void> = Promise.resolve();
  /** The last number acknowledged (ackEarly: the position, in memory). */
  #acked = new Map<string, number>();
  #subscribed = false;
  #stalled = false;
  #inFlight: { ref: string; kind: "site" | "ws" } | null = null;
  #lastEndMono = 0;
  #siteQueue: SiteAdmit[] = [];
  #helloResolve: ((ok: boolean, reason: string) => void) | null = null;
  #closeWaiters: Array<() => void> = [];

  constructor(options: EngineOptions) {
    this.options = options;
  }

  #log(event: string, fields: Record<string, unknown> = {}): void {
    this.options.log?.(event, { page: this.options.page, ...fields });
  }

  get connected(): boolean {
    return this.#ws !== null && this.#ws.readyState === WebSocket.OPEN;
  }

  get state(): State | null {
    return this.states.at(-1)?.state ?? null;
  }

  /** The owner of the page is new: the next generation, recorded first. */
  async takeOver(): Promise<number> {
    this.generation = await this.options.store.nextGeneration(this.options.page);
    return this.generation;
  }

  /** Connects and says hello; resolves once the operator took it. */
  async connect(timeoutMs = 15_000, passStale = true): Promise<void> {
    if (this.generation === 0) await this.takeOver();
    for (let tries = 0; ; tries++) {
      const outcome = await this.#connectOnce(timeoutMs);
      if (outcome.ok) return;
      // A volume that remembers a higher owner than the stand's database
      // (a stand made anew over old volumes): go past it.
      if (outcome.reason === "generation_stale" && passStale && tries < 50) {
        await this.takeOver();
        continue;
      }
      throw new Error(`hello refused: ${outcome.reason}`);
    }
  }

  #connectOnce(timeoutMs: number): Promise<{ ok: boolean; reason: string }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.options.url);
      ws.binaryType = "arraybuffer";
      this.#ws = ws;
      this.#closedAt = null;
      this.#subscribed = false;
      this.#stalled = false;
      const timer = setTimeout(() => {
        this.#helloResolve = null;
        ws.close();
        resolve({ ok: false, reason: `no helloResult in ${timeoutMs} ms` });
      }, timeoutMs);
      this.#helloResolve = (ok, reason) => {
        clearTimeout(timer);
        this.#helloResolve = null;
        resolve({ ok, reason });
      };
      ws.onopen = () => this.#sendHello();
      ws.onerror = () => undefined;
      ws.onclose = (event) => {
        if (this.#ws === ws) {
          this.#closedAt = mono();
          this.closures.push(this.#closedAt);
        }
        this.#log("engine.closed", { code: event.code });
        this.#helloResolve?.(false, `closed (${event.code})`);
        for (const wake of this.#closeWaiters.splice(0)) wake();
      };
      ws.onmessage = (event) => {
        if (this.#ws !== ws) return;
        if (event.data instanceof ArrayBuffer) this.#onBinary(Buffer.from(event.data));
        else this.#onMessage(JSON.parse(String(event.data)) as OperatorToEngine);
      };
    });
  }

  #sendHello(): void {
    const hello: Hello = {
      type: "hello",
      ownerGeneration: this.generation,
      protocol: { majors: [PROTOCOL.major], minor: PROTOCOL.minor },
      token: this.options.token,
      pageId: this.options.pageId,
      expectedAccountId: STAND_ACCOUNT_ID,
      pinnedExitIp: this.options.pinnedExitIp,
      params: { ...DEFAULT_PARAMS, ...STAND_PARAMS, ...this.options.params },
      socks5: this.options.socks,
      env: this.options.env,
    };
    this.#ws?.send(JSON.stringify(hello));
  }

  #send(message: Record<string, unknown>): boolean {
    if (this.#silent) return false;
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  /** The engine goes. `clean`: the connection is closed; `silent`: the
   *  engine just stops talking (no pong, nothing) — the operator finds the
   *  link lost after its 5 s. */
  async drop(how: "clean" | "silent"): Promise<void> {
    if (how === "silent") {
      this.#answerPings = false;
      this.#silent = true;
      return;
    }
    const ws = this.#ws;
    this.#ws = null;
    this.#subscribed = false;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      const closed = new Promise<void>((resolve) => this.#closeWaiters.push(resolve));
      ws.close();
      await Promise.race([closed, sleep(3000)]);
    }
  }

  /** Back from a silent drop: whatever connection is left is closed and a
   *  new one says hello with the same generation. */
  async reconnect(timeoutMs = 30_000): Promise<void> {
    this.#answerPings = true;
    this.#silent = false;
    await this.drop("clean");
    await this.connectRetrying(timeoutMs);
  }

  /** Connects as soon as the operator answers (it may be starting again). */
  async connectRetrying(timeoutMs: number): Promise<void> {
    const deadline = mono() + timeoutMs;
    for (;;) {
      try {
        await this.connect(Math.max(1000, Math.min(5000, deadline - mono())));
        return;
      } catch (error) {
        if (mono() > deadline) throw error;
        await sleep(250);
      }
    }
  }

  /** When the connection to the operator last closed (null: open). */
  get closedAtMono(): number | null {
    return this.#closedAt;
  }

  /** The operator closed the connection (it found the link lost). */
  async waitClosed(timeoutMs: number): Promise<boolean> {
    const deadline = mono() + timeoutMs;
    while (mono() < deadline) {
      if (this.#closedAt !== null || this.#ws === null || this.#ws.readyState === WebSocket.CLOSED) return true;
      await sleep(50);
    }
    return false;
  }

  // ── what the operator says ─────────────────────────────────────────────

  #onBinary(frame: Buffer): void {
    try {
      const part = decodeBodyFrame(frame);
      this.#bodies.set(part.bodyId, (part.part === 0 ? 0 : (this.#bodies.get(part.bodyId) ?? 0)) + part.data.length);
    } catch (error) {
      this.protocolErrors.push(`a binary frame: ${String(error)}`);
    }
  }

  #onMessage(message: OperatorToEngine): void {
    const at = mono();
    switch (message.type) {
      case "helloResult":
        if (message.ok) {
          this.bufferId = message.bufferId;
          this.states.push({ atMono: at, state: message.state });
          this.#helloResolve?.(true, "");
          this.#subscribe();
        } else {
          this.#helloResolve?.(false, message.reason);
        }
        return;
      case "state":
        this.states.push({ atMono: at, state: message });
        // A buffer that could not be opened is subscribed to again once it
        // can (src/rpc/protocol.ts, PR 11).
        if (!this.#subscribed && message.stopReason !== "buffer_unavailable") this.#subscribe();
        return;
      case "ping":
        if (this.#answerPings) this.#send({ type: "pong", n: message.n, ownerGeneration: this.generation });
        return;
      case "pong":
        return;
      case "quiesced":
        this.quiesced.push(message);
        return;
      case "commandResult":
        this.#commandResults.get(message.commandId)?.(message);
        this.#commandResults.delete(message.commandId);
        return;
      case "alarm":
        this.alarms.push({ atMono: at, alarm: message });
        this.#log("alarm", { kind: message.kind, detail: message.detail });
        return;
      case "events":
        this.#chain(() => this.#onEvents(message.bufferId, message.events));
        return;
      case "events.refused":
        this.eventsRefused.push({ ...message, atMono: at });
        if (message.reason === "foreign_buffer" || message.reason === "ahead") {
          // The volume was made anew (or the engine is ahead of a restored
          // file): start over with the operator's buffer.
          this.bufferId = message.bufferId;
          this.#subscribed = false;
          this.#chain(async () => this.#subscribeFrom(message.bufferId, message.reason === "ahead" ? 0 : await this.options.store.committedUpTo(message.bufferId)));
        } else if (message.reason === "unavailable") {
          this.#subscribed = false;
        }
        return;
      case "result":
      case "siteDone":
      case "wsDone":
        this.outcomeMessages.push({ atMono: at, message });
        if (message.type !== "result" && this.#inFlight?.ref === (message.type === "siteDone" ? message.siteRequestId : message.connectionId)) {
          this.#inFlight = null;
          this.#lastEndMono = mono();
          this.#pump();
        }
        this.#chain(() => this.#onOutcome(message));
        return;
      case "recoverResult":
        this.recoverResults.push(message);
        return;
      case "check":
        this.#onCheck(message.attemptId);
        return;
      case "sent":
        return;
      case "siteAdmit":
        this.#siteQueue.push(message);
        this.#pump();
        return;
      case "wsAdmit":
        this.#onWsAdmit(message);
        return;
      default:
        this.protocolErrors.push(`an unexpected message ${JSON.stringify(message).slice(0, 200)}`);
    }
  }

  /** One commit at a time, in the order the messages came. */
  #chain(work: () => Promise<void>): void {
    this.#commitChain = this.#commitChain.then(work).catch((error: unknown) => this.#log("commit.chain_failed", { error: String(error) }));
  }

  #subscribe(): void {
    if (this.#subscribed || !this.bufferId) return;
    this.#subscribed = true;
    const bufferId = this.bufferId;
    this.#chain(async () => this.#subscribeFrom(bufferId, await this.#position(bufferId)));
  }

  async #position(bufferId: string): Promise<number> {
    if (this.options.ackEarly) {
      // Its position, once known, is kept in memory only.
      const known = this.#acked.get(bufferId) ?? (await this.options.store.committedUpTo(bufferId).catch(() => 0));
      this.#acked.set(bufferId, known);
      return known;
    }
    for (;;) {
      try {
        return await this.options.store.committedUpTo(bufferId);
      } catch {
        // The database is down: the subscription waits for it.
        await sleep(500);
        if (!this.connected) return 0;
      }
    }
  }

  #subscribeFrom(bufferId: string, afterSeq: number): void {
    this.#subscribed = true;
    this.#stalled = false;
    this.#send({ type: "events.subscribe", ownerGeneration: this.generation, bufferId, afterSeq });
    this.#log("events.subscribe", { bufferId, afterSeq });
  }

  async #onEvents(bufferId: string, events: BufferEvent[]): Promise<void> {
    this.eventsReceived += events.length;
    if (this.#stalled || events.length === 0) return;
    if (this.options.ackEarly) {
      const last = events.at(-1)!.seq;
      this.#acked.set(bufferId, last);
      this.#send({ type: "ack", ownerGeneration: this.generation, bufferId, uptoSeq: last });
      await this.options.store.commitEvents(this.options.page, this.run, bufferId, events as unknown as StoredEvent[]).catch((error: unknown) => {
        this.eventsLost += events.length;
        this.#log("events.lost", { error: String(error) });
      });
      return;
    }
    try {
      const began = mono();
      const fresh = await this.options.store.commitEvents(this.options.page, this.run, bufferId, events as unknown as StoredEvent[]);
      this.commitMs.push(mono() - began);
      const last = events.at(-1)!.seq;
      this.committedBatches.push({ bufferId, first: events[0]!.seq, last, fresh, atMono: mono() });
      this.#send({ type: "ack", ownerGeneration: this.generation, bufferId, uptoSeq: last });
    } catch (error) {
      // Not committed, not acknowledged: the stream stalls, and is
      // subscribed again from the last committed number once the database
      // answers — what came meanwhile comes again.
      this.commitFailures += 1;
      this.#stalled = true;
      this.#log("events.commit_failed", { error: String(error) });
      void this.#resubscribeWhenUp(bufferId);
    }
  }

  async #resubscribeWhenUp(bufferId: string): Promise<void> {
    while (this.connected && !(await this.options.store.reachable(1000))) await sleep(200);
    if (!this.connected) return;
    this.#chain(async () => this.#subscribeFrom(bufferId, await this.options.store.committedUpTo(bufferId)));
  }

  async #onOutcome(message: Result | SiteDone | WsDone): Promise<void> {
    const attemptId = message.attemptId;
    let kind: string;
    let sent: boolean | null;
    if (message.type === "result") {
      kind = message.outcome.kind;
      sent = message.outcome.kind === "response" ? true : message.outcome.kind === "aborted_before_send" ? false : message.outcome.sent;
    } else {
      kind = message.type === "siteDone" ? (message.status === null ? "error" : "response") : message.fate === "unknown" ? "unknown" : "done";
      sent = message.sent;
    }
    for (let tries = 0; ; tries++) {
      try {
        const began = mono();
        await this.options.store.commitOutcome(this.options.page, this.run, attemptId, message.type, kind, sent, message, this.options.naive === true);
        this.commitMs.push(mono() - began);
        break;
      } catch (error) {
        this.commitFailures += 1;
        if (!this.connected) return;
        if (tries === 0) this.#log("outcome.commit_failed", { attemptId, error: String(error) });
        await sleep(500);
      }
    }
    // The naive control acknowledges late: a link lost before the ack makes
    // the operator deliver the outcome again.
    if (this.options.naive) await sleep(1500);
    this.#send({ type: "resultAck", ownerGeneration: this.generation, attemptId });
  }

  // ── admissions ─────────────────────────────────────────────────────────

  #grant(kind: Grant["kind"], ref: string, attemptId: number, method: string | null, target: string | null): number {
    const now = mono();
    const deadline = now + SEND_WINDOW_MS;
    this.grants.push({ kind, attemptId, ref, method, target, grantedMono: now, deadlineMono: deadline, generation: this.generation });
    return deadline;
  }

  #onCheck(attemptId: number): void {
    const deadlineMono = this.#grant("hub", String(attemptId), attemptId, "GET", this.#hubTargets.get(attemptId) ?? null);
    this.#send({ type: "checkResult", ownerGeneration: this.generation, attemptId, admit: true, deadlineMono });
  }

  /** The site's requests, one at a time, paced (plan §4.3). */
  #pump(): void {
    while (this.#inFlight === null && this.#siteQueue.length > 0) {
      const next = this.#siteQueue.shift()!;
      const now = mono();
      if (now >= next.waitDeadlineMono) {
        this.refusals.push({ kind: "site", ref: next.siteRequestId, reason: "wait_expired", atMono: now });
        this.#send({ type: "siteAdmitResult", ownerGeneration: this.generation, siteRequestId: next.siteRequestId, admit: false, reason: "wait_expired" });
        continue;
      }
      const wait = this.#lastEndMono + (this.options.paceMs ?? 2500) - now;
      if (wait > 0) {
        this.#siteQueue.unshift(next);
        setTimeout(() => this.#pump(), wait);
        return;
      }
      this.#inFlight = { ref: next.siteRequestId, kind: "site" };
      void this.options.store.issue(this.options.page, this.run, "site", [`${next.method} ${next.path}`]).then(
        ([attemptId]) => {
          const target = `${next.host}${next.path}${next.query ? `?${next.query.replace(/^\?/, "")}` : ""}`;
          const deadlineMono = this.#grant("site", next.siteRequestId, attemptId!, next.method, target);
          this.#send({ type: "siteAdmitResult", ownerGeneration: this.generation, siteRequestId: next.siteRequestId, admit: true, deadlineMono, attemptId });
        },
        () => {
          this.#inFlight = null;
          this.refusals.push({ kind: "site", ref: next.siteRequestId, reason: "buffer_full", atMono: mono() });
          this.#send({ type: "siteAdmitResult", ownerGeneration: this.generation, siteRequestId: next.siteRequestId, admit: false, reason: "buffer_full" });
        },
      );
      return;
    }
  }

  #onWsAdmit(message: WsAdmit): void {
    void this.options.store.issue(this.options.page, this.run, "ws", [message.url]).then(
      ([attemptId]) => {
        const deadlineMono = this.#grant("ws", message.connectionId, attemptId!, null, message.url);
        this.#send({ type: "wsAdmitResult", ownerGeneration: this.generation, connectionId: message.connectionId, admit: true, deadlineMono, attemptId });
      },
      () => {
        this.refusals.push({ kind: "ws", ref: message.connectionId, reason: "store", atMono: mono() });
        this.#send({ type: "wsAdmitResult", ownerGeneration: this.generation, connectionId: message.connectionId, admit: false, reason: "the engine cannot record it", retryNotBeforeWall: null });
      },
    );
  }

  // ── what the engine asks ───────────────────────────────────────────────

  readonly #hubTargets = new Map<number, string>();

  readonly #rids = new Map<number, string>();

  /** Hub requests recorded as issued (the engine's attempts), not sent yet. */
  async issueHub(count: number): Promise<number[]> {
    const rids = Array.from({ length: count }, () => `hub-${randomUUID().slice(0, 8)}`);
    const ids = await this.options.store.issue(this.options.page, this.run, "hub", rids);
    ids.forEach((id, index) => this.#rids.set(id, rids[index]!));
    return ids;
  }

  /** The `send` of attempts issued before. */
  sendIssued(ids: readonly number[], path = "/api/v1/account/me"): void {
    const live = this.state?.sessionFingerprint ?? createHash("sha256").update("pb-suite: no live session").digest("hex");
    for (const attemptId of ids) {
      const target = `apiv3.fansly.com${path}?rid=${this.#rids.get(attemptId) ?? `hub-${attemptId}`}`;
      this.#hubTargets.set(attemptId, target);
      const now = mono();
      this.#send({
        type: "send",
        ownerGeneration: this.generation,
        attemptId,
        route: "account.me",
        credentialsGeneration: live,
        sessionFingerprint: live,
        method: "GET",
        url: `https://${target}`,
        headers: { accept: "application/json, text/plain, */*" },
        kind: "api",
        maxBodyBytes: 1024 * 1024,
        sendDeadlineMono: now + SEND_WINDOW_MS,
        requestDeadlineMono: now + 20_000,
      });
    }
  }

  /** Hub requests (`send`), one per attempt id, recorded as issued first. */
  async sendHub(count: number, path = "/api/v1/account/me"): Promise<number[]> {
    if (!this.connected || this.#silent) return [];
    const ids = await this.issueHub(count);
    this.sendIssued(ids, path);
    return ids;
  }

  recover(attemptIds: number[]): void {
    this.#send({ type: "recover", ownerGeneration: this.generation, attemptIds });
  }

  /** An engine command; resolves with its result (or a timeout's). */
  command(kind: CommandKind, timeoutMs = 20_000): Promise<CommandResult> {
    const commandId = randomUUID();
    const message: Command = { type: "command", ownerGeneration: this.generation, commandId, notAfterMono: mono() + timeoutMs, command: { kind } };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#commandResults.delete(commandId);
        resolve({ type: "commandResult", commandId, ok: false, detail: `no answer in ${timeoutMs} ms` });
      }, timeoutMs);
      this.#commandResults.set(commandId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      if (!this.#send(message as unknown as Record<string, unknown>)) {
        clearTimeout(timer);
        this.#commandResults.delete(commandId);
        resolve({ type: "commandResult", commandId, ok: false, detail: "not connected" });
      }
    });
  }

  /** The outcome message of an attempt, once it came. */
  async waitOutcome(attemptId: number, timeoutMs: number): Promise<{ atMono: number; message: Result | SiteDone | WsDone } | null> {
    const deadline = mono() + timeoutMs;
    for (;;) {
      const found = this.outcomeMessages.find((seen) => seen.message.attemptId === attemptId);
      if (found) return found;
      if (mono() > deadline) return null;
      await sleep(20);
    }
  }

  /** Waits for a state that satisfies `predicate` (the last one counts). */
  async waitState(predicate: (state: State) => boolean, timeoutMs: number, since = 0): Promise<SeenState | null> {
    const deadline = mono() + timeoutMs;
    for (;;) {
      const found = this.states.find((seen) => seen.atMono >= since && predicate(seen.state));
      if (found) return found;
      if (mono() > deadline) return null;
      await sleep(25);
    }
  }

  /** The page up, the exit open: started by the engine if it stands. */
  async ensureUp(timeoutMs = 60_000): Promise<void> {
    if (!this.connected) await this.connect();
    const current = this.state;
    if (current !== null && atLeast(current.step, "exit_open") && current.exitOpen) return;
    const since = mono();
    const started = await this.command("restartBrowser");
    if (!started.ok) throw new Error(`restartBrowser: ${started.detail ?? "?"}`);
    const up = await this.waitState((state) => atLeast(state.step, "exit_open") && state.exitOpen, timeoutMs, since);
    if (!up) throw new Error(`the page did not reach exit_open in ${timeoutMs} ms (last: ${JSON.stringify(this.state)})`);
  }

  /** Every outcome message committed so far has been handled. */
  async settled(): Promise<void> {
    await this.#commitChain;
  }

  /** The bytes of each body received (by id). */
  get bodies(): ReadonlyMap<string, number> {
    return this.#bodies;
  }
}
