// The stand's test engine: the engine side of the RPC (plan §4.13) with an
// admission policy each scenario scripts, and a journal of every admission it
// gave — the scenarios compare it with the stand server's journal of what
// physically arrived.

import { monoMs, sleep } from "../../src/shared/util.ts";

export const SEND_WINDOW_MS = 15_000;

export interface Grant {
  kind: "hub" | "site" | "ws";
  id: string;
  rid: string | null;
  url: string | null;
  grantedMono: number;
  deadlineMono: number;
}

export interface Refusal {
  kind: "hub" | "site" | "ws";
  id: string;
  rid: string | null;
  mono: number;
  reason: string;
}

export interface SiteAsk {
  siteRequestId: string;
  method: string;
  url: string;
  rid: string | null;
  resourceType: string;
  askedMono: number;
}

/** What to do with an admission request: grant (with a window), refuse, or
 *  hold it (no answer yet — the request stays paused in Chrome). */
export type Decision = { grant: true; windowMs?: number } | { grant: false; reason?: string } | "hold";

export function ridOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).searchParams.get("rid");
  } catch {
    return null;
  }
}

type Message = { type: string; [key: string]: unknown };

export class StandEngine {
  readonly url: string;
  readonly token: string;
  ownerGeneration: number;
  ws: WebSocket | null = null;
  grants: Grant[] = [];
  refusals: Refusal[] = [];
  observed: Array<Message & { recvMono: number }> = [];
  states: Array<Message & { recvMono: number }> = [];
  alarms: Message[] = [];
  results = new Map<string, Message>();
  siteDone = new Map<string, Message>();
  heldSite = new Map<string, SiteAsk>();
  heldChecks = new Map<string, { attemptId: string; askedMono: number }>();
  heldWs = new Map<string, { connId: string; askedMono: number }>();
  lastState: Message | null = null;
  #hubUrls = new Map<string, string>();
  #commandWaiters = new Map<string, (message: Message) => void>();
  #resultWaiters = new Map<string, (message: Message) => void>();
  #pingTimer: NodeJS.Timeout | null = null;
  #n = 0;

  decideSite: (ask: SiteAsk) => Decision = () => ({ grant: true });
  decideCheck: (attemptId: string) => Decision = () => ({ grant: true });
  decideWs: (connId: string) => Decision = () => ({ grant: true });

  constructor(url: string, token: string, ownerGeneration = 1) {
    this.url = url;
    this.token = token;
    this.ownerGeneration = ownerGeneration;
  }

  async connect(timeoutMs = 120_000): Promise<void> {
    const until = monoMs() + timeoutMs;
    for (;;) {
      try {
        await this.#open();
        return;
      } catch (error) {
        if (monoMs() > until) throw error;
        await sleep(500);
      }
    }
  }

  #open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      let opened = false;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "hello", token: this.token, ownerGeneration: this.ownerGeneration, page: "stand" }));
      };
      ws.onmessage = (ev) => {
        const message = JSON.parse(String(ev.data)) as Message;
        if (!opened) {
          if (message.type !== "helloResult") {
            reject(new Error(`hello refused: ${JSON.stringify(message)}`));
            return;
          }
          opened = true;
          this.ws = ws;
          this.#pingTimer = setInterval(() => this.#send({ type: "ping", n: ++this.#n }), 1000);
          resolve();
          return;
        }
        this.#onMessage(message);
      };
      ws.onerror = () => {
        if (!opened) reject(new Error("rpc connect failed"));
      };
      ws.onclose = () => {
        if (this.#pingTimer) clearInterval(this.#pingTimer);
        if (this.ws === ws) this.ws = null;
        if (!opened) reject(new Error("rpc closed before hello"));
      };
    });
  }

  close(): void {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  #send(message: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ ownerGeneration: this.ownerGeneration, ...message }));
  }

  #grant(kind: Grant["kind"], id: string, url: string | null, windowMs = SEND_WINDOW_MS): number {
    const now = monoMs();
    const deadline = now + windowMs;
    this.grants.push({ kind, id, rid: ridOf(url), url, grantedMono: now, deadlineMono: deadline });
    return deadline;
  }

  #refuse(kind: Refusal["kind"], id: string, url: string | null, reason: string): void {
    this.refusals.push({ kind, id, rid: ridOf(url), mono: monoMs(), reason });
  }

  #onMessage(message: Message): void {
    const recvMono = monoMs();
    switch (message.type) {
      case "state":
        this.lastState = message;
        this.states.push({ ...message, recvMono });
        break;
      case "observe":
        this.observed.push({ ...message, recvMono });
        break;
      case "alarm":
        this.alarms.push({ ...message, recvMono });
        break;
      case "siteAdmit": {
        const ask: SiteAsk = {
          siteRequestId: String(message.siteRequestId),
          method: String(message.method),
          url: String(message.url),
          rid: ridOf(String(message.url)),
          resourceType: String(message.resourceType),
          askedMono: recvMono,
        };
        this.#decideSite(ask);
        break;
      }
      case "siteDone":
        this.siteDone.set(String(message.siteRequestId), { ...message, recvMono });
        break;
      case "check":
        this.#decideCheck(String(message.attemptId), recvMono);
        break;
      case "sent":
        this.observed.push({ ...message, recvMono });
        break;
      case "result": {
        const id = String(message.attemptId);
        this.results.set(id, { ...message, recvMono });
        this.#send({ type: "resultAck", attemptId: id });
        this.#resultWaiters.get(id)?.(message);
        this.#resultWaiters.delete(id);
        break;
      }
      case "wsAdmit":
        this.#decideWs(String(message.connId), recvMono);
        break;
      case "commandResult": {
        const waiter = this.#commandWaiters.get(String(message.id));
        this.#commandWaiters.delete(String(message.id));
        waiter?.(message);
        break;
      }
      case "pong":
        break;
      default:
        this.observed.push({ ...message, recvMono });
    }
  }

  #decideSite(ask: SiteAsk): void {
    const decision = this.decideSite(ask);
    if (decision === "hold") {
      this.heldSite.set(ask.siteRequestId, ask);
      return;
    }
    this.#answerSite(ask, decision);
  }

  #answerSite(ask: SiteAsk, decision: Exclude<Decision, "hold">): void {
    if (decision.grant) {
      const deadline = this.#grant("site", ask.siteRequestId, ask.url, decision.windowMs);
      this.#send({ type: "siteAdmitResult", siteRequestId: ask.siteRequestId, ok: true, deadlineMono: deadline });
    } else {
      this.#refuse("site", ask.siteRequestId, ask.url, decision.reason ?? "refused");
      this.#send({ type: "siteAdmitResult", siteRequestId: ask.siteRequestId, ok: false, reason: decision.reason ?? "refused" });
    }
  }

  /** Answer a held site request now. */
  releaseSite(siteRequestId: string, decision: Exclude<Decision, "hold">): boolean {
    const ask = this.heldSite.get(siteRequestId);
    if (!ask) return false;
    this.heldSite.delete(siteRequestId);
    this.#answerSite(ask, decision);
    return true;
  }

  #decideCheck(attemptId: string, askedMono: number): void {
    const decision = this.decideCheck(attemptId);
    if (decision === "hold") {
      this.heldChecks.set(attemptId, { attemptId, askedMono });
      return;
    }
    this.#answerCheck(attemptId, decision);
  }

  #answerCheck(attemptId: string, decision: Exclude<Decision, "hold">): void {
    const url = this.#hubUrls.get(attemptId) ?? null;
    if (decision.grant) {
      const deadline = this.#grant("hub", attemptId, url, decision.windowMs);
      this.#send({ type: "checkResult", attemptId, ok: true, deadlineMono: deadline });
    } else {
      this.#refuse("hub", attemptId, url, decision.reason ?? "refused");
      this.#send({ type: "checkResult", attemptId, ok: false, reason: decision.reason ?? "refused" });
    }
  }

  releaseCheck(attemptId: string, decision: Exclude<Decision, "hold">): boolean {
    if (!this.heldChecks.delete(attemptId)) return false;
    this.#answerCheck(attemptId, decision);
    return true;
  }

  #decideWs(connId: string, askedMono: number): void {
    const decision = this.decideWs(connId);
    if (decision === "hold") {
      this.heldWs.set(connId, { connId, askedMono });
      return;
    }
    this.#answerWs(connId, decision);
  }

  #answerWs(connId: string, decision: Exclude<Decision, "hold">): void {
    if (decision.grant) {
      const deadline = this.#grant("ws", connId, null, decision.windowMs);
      this.#send({ type: "wsAdmitResult", connId, ok: true, deadlineMono: deadline });
    } else {
      this.#refuse("ws", connId, null, decision.reason ?? "refused");
      this.#send({ type: "wsAdmitResult", connId, ok: false });
    }
  }

  releaseWs(connId: string, decision: Exclude<Decision, "hold">): boolean {
    if (!this.heldWs.delete(connId)) return false;
    this.#answerWs(connId, decision);
    return true;
  }

  /** A Hub request (plan §4.2). The url carries `rid` for the journals. */
  sendHub(attemptId: string, url: string, headers: Record<string, string> = {}, method = "GET"): Promise<Message> {
    this.#hubUrls.set(attemptId, url);
    const done = new Promise<Message>((resolve) => {
      // The operator closes every attempt within its operation limit; a
      // missing result is the scenario's finding, not a hang of the series.
      const timer = setTimeout(() => {
        this.#resultWaiters.delete(attemptId);
        resolve({ type: "result", attemptId, outcome: "no_result", error: "no result from the operator in 45 s" });
      }, 45_000);
      this.#resultWaiters.set(attemptId, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    this.#send({ type: "send", attemptId, method, url, headers, kind: "api", timeoutMs: 20_000 });
    return done;
  }

  command(name: string, extra: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Message> {
    const id = `c${++this.#n}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#commandWaiters.delete(id);
        resolve({ type: "commandResult", ok: false, error: "timeout" });
      }, timeoutMs);
      this.#commandWaiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.#send({ type: "command", id, name, ...extra });
    });
  }

  async eval<T = unknown>(expression: string, awaitPromise = true): Promise<T> {
    const reply = await this.command("test.eval", { expression, await: awaitPromise });
    if (reply.ok !== true) throw new Error(`eval failed: ${String(reply.error)} — ${expression.slice(0, 120)}`);
    return reply.value as T;
  }

  async waitReady(timeoutMs = 120_000): Promise<void> {
    const until = monoMs() + timeoutMs;
    for (;;) {
      if (!this.connected) {
        try {
          await this.connect(Math.max(1000, until - monoMs()));
        } catch {
          // retry below
        }
      }
      if (this.connected) {
        const status = await this.command("status", {}, 5000);
        if (status.ok === true && status.state === "ready") {
          try {
            if ((await this.eval<string>("typeof site", false)) === "object") return;
          } catch {
            // the page is still loading
          }
        }
      }
      if (monoMs() > until) throw new Error(`operator not ready in ${timeoutMs} ms (last state: ${JSON.stringify(this.lastState)})`);
      await sleep(500);
    }
  }
}
