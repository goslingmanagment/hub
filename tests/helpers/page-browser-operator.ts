import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { GenerationStore } from "../../apps/page-browser/src/rpc/generation.ts";
import {
  BODY_PART_BYTES,
  encodeBodyFrame,
  type CheckResult,
  type Hello,
  type Result,
  type Send,
  type State,
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
  /** Leave the session to the engine's check: a `send` of another session
   *  than the live one still stops at a `check` (a lagging operator). */
  skipSessionCheckAtSend = false;
  /** Deliver results (false: kept, never sent until a recover or a new link). */
  deliverResults = true;
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
          return { bufferId: "00000000-0000-4000-8000-000000000001", state: this.state };
        },
        quiesce: async () => ({ lastSendMono: this.physical.at(-1)?.sentMono ?? null, lastSendWall: null }),
        onCommand: async () => ({ ok: false, detail: "not in this fake" }),
        onBuffer: (message) => {
          if (message.type === "resultAck") {
            this.acks.push(message.attemptId);
            this.held.delete(message.attemptId);
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
          if (up) {
            this.pushState();
            for (const [, kept] of this.held) this.#deliver(kept.result, kept.body);
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
      source: "network",
      sentMono: this.reportSend ? sentMono : null,
      sendMark: this.reportSend ? "transport_reported" : "completion_fallback",
    }, body);
  }

  #store(send: Send, outcome: Result["outcome"], body: Buffer | null = null): void {
    const result: Result = { type: "result", attemptId: send.attemptId, sessionFingerprint: send.sessionFingerprint, outcome };
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
      if (kept !== undefined) {
        this.#deliver(kept.result, kept.body);
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
