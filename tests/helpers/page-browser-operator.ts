import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { EventBuffer } from "../../apps/page-browser/src/buffer/buffer.ts";
import { EventStream } from "../../apps/page-browser/src/buffer/stream.ts";
import { GenerationStore } from "../../apps/page-browser/src/rpc/generation.ts";
import {
  BODY_PART_BYTES,
  encodeBodyFrame,
  type Ack,
  type BufferEvent,
  type CheckResult,
  type Command,
  type EventsRefused,
  type EventsSubscribe,
  type Hello,
  type Result,
  type Send,
  type SiteAdmit,
  type SiteAdmitResult,
  type SiteDone,
  type State,
  type WsAdmit,
  type WsAdmitResult,
  type WsDone,
} from "../../apps/page-browser/src/rpc/protocol.ts";
import { RpcServer } from "../../apps/page-browser/src/rpc/server.ts";
import { monoMs } from "../../apps/page-browser/src/shared/util.ts";
import type { PageBrowserLinkSettings } from "../../apps/runtime/src/services/egress/page-browser-rpc.ts";

// A fake operator for the engine's tests (Project Browser, stage 3 PR 12): the
// operator's own RPC server (`apps/page-browser/src/rpc/server.ts` — the
// token, the protocol major, the owner generations, ping/pong and link loss
// as the real one has them) in this process on 127.0.0.1, with a scripted
// browser behind it for a Hub request: the `send` is checked against the
// live session, the request stops at a `check`, and once admitted it "leaves"
// — one physical request, logged here as the origin's arrival log — and its
// result is kept until `resultAck`, delivered to every new connection and
// resent on `recover`, body frames first.
//
// The buffer's event stream (PR 13): the operator's own `EventStream`
// (`apps/page-browser/src/buffer/stream.ts` — the subscription, the batches,
// the acks, its refusals) over a buffer in memory (`MemoryEventBuffer`); a
// test appends events (`append`, `gap`, `siteResponse`), makes the volume
// anew (`recreateBuffer`), makes the buffer unavailable, or loses acks on
// the way (`dropAcks`). A site response's body goes as binary frames before
// the batch that names it. The ends of the site path (`siteDone`,
// `wsDone`) are kept like results (`holdEnd`).
//
// The site path (PR 14): a test asks the engine for a site request
// (`siteAdmit`) or a site socket (`wsAdmit`), reads its answers
// (`siteAnswers`, `wsAnswers`) and reports its end (`siteDone`, `wsDone`,
// kept until `resultAck`). The engine's commands are recorded (`commands`);
// `stopPage` stops the page (the state says so). `quiesced` can be held back
// (`holdQuiesce`) and can name a last send (`lastSendMono`).

/** An event as a test appends it: the buffer numbers and stamps it. */
export type AppendedEvent = BufferEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "atMono" | "atWall"> : never) : never;

/** The operator's buffer of events in memory, for the operator's own
 *  `EventStream`: the subset of `EventBuffer` it reads. */
export class MemoryEventBuffer {
  id: string;
  unavailable: { cause: string } | null = null;
  #events: Array<{ seq: number; json: string; bytes: number; event: BufferEvent }> = [];
  #lastSeq = 0;
  /** The highest number acknowledged (by an ack or a subscription). */
  acknowledged = 0;
  /** The highest number ever handed to a stream (the operator's durable
   *  mark, schema v4): a restored file keeps its own. */
  sentMax = 0;

  constructor(id: string = randomUUID()) {
    this.id = id;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** The events kept (not yet acknowledged), oldest first. */
  get kept(): BufferEvent[] {
    return this.#events.map((entry) => entry.event);
  }

  append(event: AppendedEvent, atWall: number = Date.now()): BufferEvent {
    const seq = ++this.#lastSeq;
    const stamped = { seq, atMono: monoMs(), atWall, ...event } as BufferEvent;
    const json = JSON.stringify(stamped);
    this.#events.push({ seq, json, bytes: Buffer.byteLength(json), event: stamped });
    return stamped;
  }

  raiseSentMax(): boolean {
    this.sentMax = Math.max(this.sentMax, this.#lastSeq);
    return true;
  }

  acknowledge(uptoSeq: number): void {
    this.acknowledged = Math.max(this.acknowledged, uptoSeq);
    this.#events = this.#events.filter((entry) => entry.seq > uptoSeq);
  }

  readEvents(afterSeq: number, maxEvents: number, maxBytes: number): Array<{ seq: number; json: string; bytes: number }> {
    const out: Array<{ seq: number; json: string; bytes: number }> = [];
    let bytes = 0;
    for (const entry of this.#events) {
      if (entry.seq <= afterSeq) continue;
      if (out.length >= maxEvents || (out.length > 0 && bytes + entry.bytes + 1 > maxBytes)) break;
      out.push({ seq: entry.seq, json: entry.json, bytes: entry.bytes });
      bytes += entry.bytes + 1;
    }
    return out;
  }
}

export const OPERATOR_TOKEN = "engine-rpc-token-6d1f0c2b8a7e4935a1c0";

export function fingerprintOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const SESSION_A = fingerprintOf("session-a");
export const SESSION_B = fingerprintOf("session-b");

/** The settings of a hello to the fake operator. */
export function linkSettings(overrides: Partial<PageBrowserLinkSettings> = {}): PageBrowserLinkSettings {
  return {
    token: OPERATOR_TOKEN,
    pageId: 7,
    expectedAccountId: "300000000000000001",
    pinnedExitIp: "203.0.113.7",
    socks5: { ip: "127.0.0.1", port: 1080, username: "pb-user", password: "pb-pass" },
    env: { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } },
    ...overrides,
  };
}

export interface PhysicalRequest {
  attemptId: number;
  url: string;
  kind: Send["kind"];
  /** When the operator asked the engine (CLOCK_MONOTONIC, ms). */
  checkedMono: number;
  /** When it left (CLOCK_MONOTONIC, ms). */
  sentMono: number;
  generation: number;
  session: string;
}

export interface FakeAnswer {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

interface Waiting {
  send: Send;
  checkedMono: number;
}

export interface FakeOperatorOptions {
  token?: string;
  pingMs?: number;
  linkLossMs?: number;
  session?: string | null;
  accountId?: string;
}

export class FakeOperator {
  readonly server: RpcServer;
  readonly hellos: Hello[] = [];
  readonly sends: Send[] = [];
  readonly checkResults: CheckResult[] = [];
  readonly physical: PhysicalRequest[] = [];
  readonly acks: number[] = [];
  readonly recovers: number[][] = [];
  readonly links: boolean[] = [];
  /** Outcomes kept until their resultAck. */
  readonly held = new Map<number, { result: Result; body: Buffer | null }>();
  /** The site path's ends kept until their resultAck. */
  readonly heldEnds = new Map<number, SiteDone | WsDone>();
  /** The event stream: its buffer, its subscriptions, acks and refusals. */
  buffer: MemoryEventBuffer = new MemoryEventBuffer("00000000-0000-4000-8000-000000000001");
  stream: EventStream;
  readonly subscriptions: EventsSubscribe[] = [];
  readonly eventAcks: Ack[] = [];
  readonly refusals: EventsRefused[] = [];
  /** Acks lost on the way: the next this many never reach the stream. */
  dropAcks = 0;
  /** The bodies site responses name, by body id. */
  readonly bodies = new Map<string, Buffer>();
  /** The next body sent goes with another body's bytes (a body broken on
   *  the way: its sha256 does not match). */
  corruptNextBody = false;
  readonly #waiting = new Map<number, Waiting>();
  live: string | null;
  state: State;
  port = 0;
  /** How long after the admission the request leaves. */
  sendDelayMs = 0;
  /** Between the admission and the release (a test changes the session). */
  beforeRelease: ((send: Send) => void | Promise<void>) | null = null;
  /** Report the send instant (`sent`, the result's sentMono). */
  reportSend = true;
  /** Ask the engine a second time for one operation (a misbehaving operator). */
  checkTwice = false;
  /** Runs first on every `send` (a test changes the live session there). */
  onSendHook: ((send: Send) => void) | null = null;
  /** Awaited after a `send` passed, right before its `check` is asked (a
   *  test changes the page's stored proxy there). */
  beforeCheck: ((send: Send) => Promise<void>) | null = null;
  /** Where the answers come from (Chrome's word, plan §4.2 step 8). */
  responseSource: "network" | "revalidated_304" | "service_worker" | "cache_unconfirmed" = "network";
  /** Leave the session to the engine's check: a `send` of another session
   *  than the live one still stops at a `check` (a lagging operator). */
  skipSessionCheckAtSend = false;
  /** Deliver results (false: kept, never sent until a recover or a new link). */
  deliverResults = true;
  /** The session a result reports (null: the one its send named) — another
   *  session's answer. */
  resultSession: string | null = null;
  /** The engine's answers to the site path (PR 14). */
  readonly siteAnswers: SiteAdmitResult[] = [];
  readonly wsAnswers: WsAdmitResult[] = [];
  /** The engine's commands, in order. */
  readonly commands: Command[] = [];
  /** `quiesced` waits for this (null: at once). */
  holdQuiesce: Promise<void> | null = null;
  /** The last send `quiesced` names (null: the last physical one, if any). */
  lastSendMono: number | null = null;
  /** What `recover` says of an attempt it holds no outcome of. */
  recoverState: (attemptId: number) => "not_sent" | "unknown" = () => "unknown";
  respond: (send: Send) => FakeAnswer;

  private constructor(options: FakeOperatorOptions) {
    this.live = options.session === undefined ? SESSION_A : options.session;
    const accountId = options.accountId ?? "300000000000000001";
    this.respond = (send) => (new URL(send.url).pathname.endsWith("/account/me")
      ? { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: true, response: { account: { id: accountId, username: "harness", displayName: null, createdAt: 0, followCount: 0, subscriberCount: 0 } } }) }
      : { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: true, response: [] }) });
    this.state = {
      type: "state",
      step: "exit_open",
      stopReason: null,
      retryAtWall: null,
      exitOpen: true,
      mode: "automation",
      sessionFingerprint: this.live,
      accountId,
      exitIp: "203.0.113.7",
      chromeVersion: "155.0.0.0",
      operatorVersion: "test",
      buffer: { bytes: 0, oldestAgeMs: 0 },
      selfTest: { ok: true, atWall: Date.now(), failed: null },
    };
    this.server = new RpcServer({
      token: options.token ?? OPERATOR_TOKEN,
      generations: new GenerationStore(null, () => undefined),
      pingMs: options.pingMs ?? 100,
      linkLossMs: options.linkLossMs ?? 1_000,
      helloTimeoutMs: 2_000,
      log: () => undefined,
      handlers: {
        onHello: (hello) => {
          this.hellos.push(hello);
          return { bufferId: this.buffer.unavailable === null ? this.buffer.id : "", state: this.state };
        },
        quiesce: async () => {
          if (this.holdQuiesce !== null) await this.holdQuiesce;
          return { lastSendMono: this.lastSendMono ?? this.physical.at(-1)?.sentMono ?? null, lastSendWall: null };
        },
        onCommand: async (command) => {
          this.commands.push(command);
          if (command.command.kind !== "stopPage") return { ok: false, detail: "not in this fake" };
          this.pushState({ step: "exit_closed", stopReason: "owner_stop", exitOpen: false });
          return { ok: true, detail: "the page is stopped" };
        },
        onSite: (message) => {
          this.siteAnswers.push(message);
        },
        onSocket: (message) => {
          this.wsAnswers.push(message);
        },
        onBuffer: (message) => {
          if (message.type === "events.subscribe") {
            this.subscriptions.push(message);
            const refused = this.stream.subscribe(message);
            if (refused !== null) this.#refuse(refused);
          } else if (message.type === "ack") {
            if (this.dropAcks > 0) {
              this.dropAcks -= 1;
              return;
            }
            this.eventAcks.push(message);
            const refused = this.stream.ack(message);
            if (refused !== null) this.#refuse(refused);
          } else if (message.type === "resultAck") {
            this.acks.push(message.attemptId);
            this.held.delete(message.attemptId);
            this.heldEnds.delete(message.attemptId);
          } else if (message.type === "recover") {
            this.recovers.push([...message.attemptIds]);
            void this.#recover(message.attemptIds);
          }
        },
        onHub: (message) => {
          if (message.type === "send") void this.#onSend(message);
          else void this.#onCheckResult(message);
        },
        onLink: (up) => {
          this.links.push(up);
          this.stream.reset();
          if (up) {
            this.pushState();
            for (const [, kept] of this.held) this.#deliver(kept.result, kept.body);
            for (const [, end] of this.heldEnds) this.server.send(end);
          } else {
            // No check is answered any more (hub.ts linkLost).
            for (const [attemptId, waiting] of [...this.#waiting]) {
              this.#waiting.delete(attemptId);
              this.#store(waiting.send, { kind: "transport_error", sent: false, message: "the engine link was lost before the check's answer" });
            }
          }
        },
      },
    });
    this.stream = this.#makeStream();
  }

  #refuse(refused: EventsRefused): void {
    this.refusals.push(refused);
    this.server.send(refused);
  }

  /** The stream over the current buffer; site responses' bodies go first. */
  #makeStream(): EventStream {
    return new EventStream(this.buffer as unknown as EventBuffer, (json) => {
      const batch = JSON.parse(json) as { events: BufferEvent[] };
      for (const event of batch.events) {
        if (event.kind !== "site.response") continue;
        const body = this.bodies.get(event.body.bodyId);
        if (body === undefined) continue;
        const sent = this.corruptNextBody ? Buffer.from(`${body.toString("utf8")}!`) : body;
        this.corruptNextBody = false;
        sendBody(this.server, event.body.bodyId, sent);
      }
      return this.server.sendRaw(json);
    }, { log: () => undefined });
  }

  /** An event of the buffer, durable at once; streamed to a subscriber. */
  append(event: AppendedEvent, atWall?: number): BufferEvent {
    const stamped = this.buffer.append(event, atWall);
    this.stream.pump();
    return stamped;
  }

  /** A gap mark (spec §6.1): from the event `from` (null: unknown). */
  gap(reason: Extract<BufferEvent, { kind: "gap" }>["reason"], from: BufferEvent | null, atWall?: number): BufferEvent {
    return this.append({ kind: "gap", fromSeq: from?.seq ?? null, fromWall: from?.atWall ?? null, reason }, atWall);
  }

  /** A site response with its body (sent before the batch that names it). */
  siteResponse(input: { route: string; path: string; query?: string; status?: number; body: string | Buffer; complete?: boolean; source?: "network" | "revalidated_304" | "service_worker" | "cache_unconfirmed"; headers?: Record<string, string>; method?: string }, atWall?: number): BufferEvent {
    const body = typeof input.body === "string" ? Buffer.from(input.body, "utf8") : input.body;
    const bodyId = randomUUID();
    this.bodies.set(bodyId, body);
    return this.append({
      kind: "site.response",
      siteRequestId: randomUUID(),
      attemptId: 0,
      route: input.route,
      method: input.method ?? "GET",
      path: input.path,
      query: input.query ?? "",
      status: input.status ?? 200,
      headers: input.headers ?? { "content-type": "application/json" },
      body: { bodyId, decodedBytes: body.length, sha256: createHash("sha256").update(body).digest("hex") },
      complete: input.complete ?? true,
      source: input.source ?? "network",
      sessionFingerprint: this.live ?? SESSION_A,
    }, atWall);
  }

  /** The volume made anew: another buffer id, numbers from 1 again, the old
   *  buffer's events gone. */
  recreateBuffer(): MemoryEventBuffer {
    this.buffer = new MemoryEventBuffer();
    this.stream = this.#makeStream();
    return this.buffer;
  }

  /** The site path's end of an attempt, kept until its resultAck and
   *  delivered to every new connection and on `recover`. */
  holdEnd(end: SiteDone | WsDone): void {
    this.heldEnds.set(end.attemptId, end);
  }

  /** A request of the site, held paused, asks the engine (`siteAdmit`). */
  siteAdmit(input: Partial<Omit<SiteAdmit, "type">> & { path: string }): SiteAdmit {
    const now = monoMs();
    const message: SiteAdmit = {
      type: "siteAdmit",
      siteRequestId: input.siteRequestId ?? randomUUID(),
      method: input.method ?? "GET",
      host: input.host ?? "apiv3.fansly.com",
      path: input.path,
      query: input.query ?? "",
      resourceType: input.resourceType ?? "XHR",
      route: input.route ?? "site.other",
      operation: input.operation ?? "read",
      sessionFingerprint: input.sessionFingerprint === undefined ? this.live : input.sessionFingerprint,
      pausedMono: input.pausedMono ?? now,
      waitDeadlineMono: input.waitDeadlineMono ?? now + 60_000,
    };
    this.server.send(message);
    return message;
  }

  /** The site socket's CONNECT asks the engine (`wsAdmit`). */
  wsAdmit(input: Partial<Omit<WsAdmit, "type">> = {}): WsAdmit {
    const now = monoMs();
    const message: WsAdmit = {
      type: "wsAdmit",
      connectionId: input.connectionId ?? randomUUID(),
      url: input.url ?? "wss://wsv3.fansly.com/?v=3",
      context: input.context ?? "page",
      sessionFingerprint: input.sessionFingerprint === undefined ? this.live : input.sessionFingerprint,
      requestedMono: input.requestedMono ?? now,
      waitDeadlineMono: input.waitDeadlineMono ?? now + 60_000,
    };
    this.server.send(message);
    return message;
  }

  /** The end of an admitted site request, kept until its resultAck. */
  siteDone(answer: SiteAdmitResult & { admit: true }, end: Partial<Omit<SiteDone, "type" | "siteRequestId" | "attemptId">> = {}): SiteDone {
    const sentMono = end.sentMono === undefined ? monoMs() : end.sentMono;
    const done: SiteDone = {
      type: "siteDone",
      siteRequestId: answer.siteRequestId,
      attemptId: answer.attemptId,
      sent: end.sent ?? true,
      sentMono,
      sentWall: end.sentWall ?? Date.now(),
      connectionReused: end.connectionReused ?? false,
      status: end.status === undefined ? 200 : end.status,
      retryAfter: end.retryAfter ?? null,
      error: end.error ?? null,
      body: end.body ?? "buffered",
    };
    this.holdEnd(done);
    this.server.send(done);
    return done;
  }

  /** The end of an admitted site socket's handshake, kept until its resultAck. */
  wsDone(answer: WsAdmitResult & { admit: true }, end: Partial<Omit<WsDone, "type" | "connectionId" | "attemptId">> = {}): WsDone {
    const done: WsDone = {
      type: "wsDone",
      connectionId: answer.connectionId,
      attemptId: answer.attemptId,
      sent: end.sent ?? true,
      sentMono: end.sentMono === undefined ? monoMs() : end.sentMono,
      status: end.status === undefined ? 101 : end.status,
      error: end.error ?? null,
      ...(end.fate === undefined ? {} : { fate: end.fate }),
    };
    this.holdEnd(done);
    this.server.send(done);
    return done;
  }

  static async start(options: FakeOperatorOptions = {}): Promise<FakeOperator> {
    const operator = new FakeOperator(options);
    operator.port = await operator.server.listen(0, "127.0.0.1");
    return operator;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/rpc`;
  }

  /** The site's live session changed (a new login): `state` tells it. */
  setSession(fingerprint: string | null): void {
    this.live = fingerprint;
    this.state = { ...this.state, sessionFingerprint: fingerprint };
    this.pushState();
  }

  pushState(patch: Partial<State> = {}): void {
    this.state = { ...this.state, ...patch };
    this.server.send(this.state);
  }

  async close(): Promise<void> {
    await this.server.close();
  }

  async #onSend(send: Send): Promise<void> {
    this.sends.push(send);
    this.onSendHook?.(send);
    if (this.#waiting.has(send.attemptId) || this.held.has(send.attemptId)) return;
    if (send.ownerGeneration < this.server.generation) return this.#store(send, { kind: "aborted_before_send", refusal: "generation_stale" });
    if (this.live === null) return this.#store(send, { kind: "transport_error", sent: false, message: "no live session of the site yet" });
    if (this.live !== send.sessionFingerprint && !this.skipSessionCheckAtSend) return this.#store(send, { kind: "aborted_before_send", refusal: "session_mismatch" });
    if (monoMs() >= send.sendDeadlineMono) return this.#store(send, { kind: "aborted_before_send", refusal: "send_deadline_passed" });
    if (this.beforeCheck !== null) await this.beforeCheck(send);
    const checkedMono = monoMs();
    this.#waiting.set(send.attemptId, { send, checkedMono });
    this.server.send({ type: "check", attemptId: send.attemptId, pausedMono: checkedMono, liveSessionFingerprint: this.live });
    if (this.checkTwice) this.server.send({ type: "check", attemptId: send.attemptId, pausedMono: monoMs(), liveSessionFingerprint: this.live });
  }

  async #onCheckResult(result: CheckResult): Promise<void> {
    this.checkResults.push(result);
    const waiting = this.#waiting.get(result.attemptId);
    if (waiting === undefined) return;
    this.#waiting.delete(result.attemptId);
    const send = waiting.send;
    if (!result.admit) return this.#store(send, { kind: "aborted_before_send", refusal: result.reason });
    if (this.beforeRelease !== null) await this.beforeRelease(send);
    // The release: the same session, before the deadline (the gate's word).
    if (this.live !== send.sessionFingerprint) return this.#store(send, { kind: "aborted_before_send", refusal: "session_mismatch" });
    if (monoMs() >= result.deadlineMono) return this.#store(send, { kind: "aborted_before_send", refusal: "send_deadline_passed" });
    if (this.sendDelayMs > 0) await sleep(this.sendDelayMs);
    const sentMono = monoMs();
    this.physical.push({ attemptId: send.attemptId, url: send.url, kind: send.kind, checkedMono: waiting.checkedMono, sentMono, generation: send.ownerGeneration, session: send.sessionFingerprint });
    if (this.reportSend) this.server.send({ type: "sent", attemptId: send.attemptId, sentMono, sentWall: Date.now(), connectionReused: false });
    const answer = this.respond(send);
    const body = typeof answer.body === "string" ? Buffer.from(answer.body, "utf8") : answer.body;
    const bodyId = randomUUID();
    this.#store(send, {
      kind: "response",
      status: answer.status,
      headers: answer.headers ?? {},
      body: { bodyId, decodedBytes: body.length, sha256: createHash("sha256").update(body).digest("hex") },
      encodedBytes: body.length,
      source: this.responseSource,
      sentMono: this.reportSend ? sentMono : null,
      sendMark: this.reportSend ? "transport_reported" : "completion_fallback",
    }, body);
  }

  #store(send: Send, outcome: Result["outcome"], body: Buffer | null = null): void {
    const result: Result = { type: "result", attemptId: send.attemptId, sessionFingerprint: this.resultSession ?? send.sessionFingerprint, outcome };
    this.held.set(send.attemptId, { result, body });
    if (this.deliverResults) this.#deliver(result, body);
  }

  #deliver(result: Result, body: Buffer | null): void {
    if (body !== null && result.outcome.kind === "response") sendBody(this.server, result.outcome.body.bodyId, body);
    this.server.send(result);
  }

  async #recover(attemptIds: number[]): Promise<void> {
    const attempts: Array<{ attemptId: number; state: "outcome_resent" | "not_sent" | "unknown" }> = [];
    for (const attemptId of attemptIds) {
      const kept = this.held.get(attemptId);
      const end = this.heldEnds.get(attemptId);
      if (kept !== undefined) {
        this.#deliver(kept.result, kept.body);
        attempts.push({ attemptId, state: "outcome_resent" });
      } else if (end !== undefined) {
        this.server.send(end);
        attempts.push({ attemptId, state: "outcome_resent" });
      } else {
        attempts.push({ attemptId, state: this.recoverState(attemptId) });
      }
    }
    this.server.send({ type: "recoverResult", attempts });
  }
}

/** A body as the operator sends it: frames of up to 1 MiB, the last flagged
 *  (an empty body is one empty last frame). */
export function sendBody(server: RpcServer, bodyId: string, body: Buffer): void {
  const parts = Math.max(1, Math.ceil(body.length / BODY_PART_BYTES));
  for (let part = 0; part < parts; part++) {
    server.sendBinary(encodeBodyFrame(bodyId, part, part === parts - 1, body.subarray(part * BODY_PART_BYTES, (part + 1) * BODY_PART_BYTES)));
  }
}
