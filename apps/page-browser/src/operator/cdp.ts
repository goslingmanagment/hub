// CDP client of the operator, through the holder (holder/main.ts): commands
// with ids, events by method, flatten sessions. Every Chrome message arrives
// numbered; the operator acknowledges a number once it has handled it, so a
// restarted operator gets the unhandled ones again. `Fetch.requestPaused` is
// acknowledged only when its request is continued or failed (`holdAck`), so a
// restarted operator learns about every request that is still paused.

import { createConnection, type Socket } from "node:net";

import { encodeMessage, readMessages } from "../shared/frames.ts";
import { makeLog, sleep } from "../shared/util.ts";

const log = makeLog("cdp");

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
  /** The holder's number of this message. */
  seq: number;
}

type EventHandler = (event: CdpEvent) => void;

export class CdpError extends Error {
  readonly code: number;
  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message} (${code})`);
    this.name = "CdpError";
    this.code = code;
  }
}

export class Cdp {
  #socket: Socket | null = null;
  // Ids of this operator instance start at a random base so a response to a
  // command of a previous instance (replayed by the holder) never matches.
  #nextId = 1 + Math.floor(Math.random() * 1_000_000_000);
  #pending = new Map<number, { method: string; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  #handlers = new Map<string, EventHandler[]>();
  #anyHandlers: EventHandler[] = [];
  #ackBatch: number[] = [];
  #ackTimer: NodeJS.Timeout | null = null;
  /** Holder link state, reported by the holder. */
  cdpUp = false;
  /** Stand: handle every Chrome message this much later, in order (a slow
   *  operator — the holder and Chrome keep buffering meanwhile). */
  testDelayMs = 0;
  #delayed: Array<{ seq: number; message: Record<string, unknown>; at: number }> = [];
  #delayTimer: NodeJS.Timeout | null = null;
  onHolderEvent: (event: { t: string; reason?: string }) => void = () => undefined;
  onHolderGone: () => void = () => undefined;

  async connect(path: string): Promise<{ replayed: number; cdp: string; lastSeq: number }> {
    for (;;) {
      try {
        return await this.#open(path);
      } catch {
        await sleep(100);
      }
    }
  }

  #open(path: string): Promise<{ replayed: number; cdp: string; lastSeq: number }> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      let greeted = false;
      socket.once("error", (error) => {
        if (!greeted) reject(error);
      });
      socket.on("close", () => {
        if (this.#socket === socket) {
          this.#socket = null;
          this.cdpUp = false;
          for (const [, pending] of this.#pending) pending.reject(new Error("holder link closed"));
          this.#pending.clear();
          if (greeted) this.onHolderGone();
        }
      });
      readMessages(socket, (value) => {
        const message = value as { t: string; seq?: number; d?: Record<string, unknown>; cdp?: string; stored?: number; lastSeq?: number; reason?: string };
        if (message.t === "hello") {
          greeted = true;
          this.#socket = socket;
          this.cdpUp = message.cdp === "up";
          resolve({ replayed: message.stored ?? 0, cdp: message.cdp ?? "down", lastSeq: message.lastSeq ?? 0 });
          return;
        }
        if (message.t === "m") {
          if (this.testDelayMs > 0 || this.#delayed.length > 0) this.#delay(message.seq!, message.d!);
          else this.#onChrome(message.seq!, message.d!);
          return;
        }
        if (message.t === "cdp.up") this.cdpUp = true;
        if (message.t === "cdp.down") this.cdpUp = false;
        this.onHolderEvent(message);
      });
    });
  }

  #delay(seq: number, message: Record<string, unknown>): void {
    this.#delayed.push({ seq, message, at: Date.now() + this.testDelayMs });
    if (!this.#delayTimer) this.#drainDelayed();
  }

  #drainDelayed(): void {
    this.#delayTimer = null;
    while (this.#delayed.length > 0 && this.#delayed[0]!.at <= Date.now()) {
      const next = this.#delayed.shift()!;
      this.#onChrome(next.seq, next.message);
    }
    if (this.#delayed.length > 0) this.#delayTimer = setTimeout(() => this.#drainDelayed(), Math.max(1, this.#delayed[0]!.at - Date.now()));
  }

  get linked(): boolean {
    return this.#socket !== null && !this.#socket.destroyed;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const socket = this.#socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error(`${method}: holder link down`));
    const id = this.#nextId++;
    if (this.#nextId > 2_000_000_000) this.#nextId = 1;
    if (process.env.PB_DEBUG_CDP === "1" && !method.startsWith("Fetch.")) log("send", { method, sessionId: sessionId ?? null, params: JSON.stringify(params).slice(0, 200) });
    const command: Record<string, unknown> = { id, method, params };
    if (sessionId) command.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { method, resolve: resolve as (value: Record<string, unknown>) => void, reject });
      socket.write(encodeMessage(JSON.stringify({ t: "send", d: command })));
    });
  }

  /** Fire and forget (errors only logged). */
  post(method: string, params: Record<string, unknown> = {}, sessionId?: string): void {
    this.send(method, params, sessionId).catch((error: Error) => log("post.failed", { method, error: error.message }));
  }

  on(method: string, handler: EventHandler): void {
    const list = this.#handlers.get(method) ?? [];
    list.push(handler);
    this.#handlers.set(method, list);
  }

  onAny(handler: EventHandler): void {
    this.#anyHandlers.push(handler);
  }

  /** Acknowledge a message to the holder (batched, ≤ 20 ms). */
  ack(seq: number): void {
    this.#ackBatch.push(seq);
    if (this.#ackTimer) return;
    this.#ackTimer = setTimeout(() => {
      this.#ackTimer = null;
      const seqs = this.#ackBatch;
      this.#ackBatch = [];
      this.#socket?.write(encodeMessage(JSON.stringify({ t: "ack", seqs })));
    }, 20);
  }

  holderCommand(t: string): void {
    this.#socket?.write(encodeMessage(JSON.stringify({ t })));
  }

  #onChrome(seq: number, message: Record<string, unknown>): void {
    if (typeof message.id === "number") {
      this.ack(seq);
      const pending = this.#pending.get(message.id);
      if (!pending) return; // a response to a previous operator instance
      this.#pending.delete(message.id);
      const error = message.error as { code: number; message: string } | undefined;
      if (error) pending.reject(new CdpError(pending.method, error.code, error.message));
      else pending.resolve((message.result as Record<string, unknown>) ?? {});
      return;
    }
    const event: CdpEvent = {
      method: message.method as string,
      params: (message.params as Record<string, unknown>) ?? {},
      seq,
    };
    if (process.env.PB_DEBUG_CDP === "1") {
      const p = event.params as Record<string, any>;
      log("event", { m: event.method, id: p.requestId ?? p.targetInfo?.targetId ?? null, extra: p.errorText ?? p.dataLength ?? p.type ?? p.reason ?? null, canceled: p.canceled ?? null });
    }
    if (typeof message.sessionId === "string") event.sessionId = message.sessionId;
    // Paused requests stay unacknowledged until they are resolved (see the
    // header); every other message is done once its handlers ran.
    const holdAck = event.method === "Fetch.requestPaused";
    try {
      for (const handler of this.#anyHandlers) handler(event);
      for (const handler of this.#handlers.get(event.method) ?? []) handler(event);
    } catch (error) {
      log("handler.failed", { method: event.method, error: (error as Error).stack });
    }
    if (!holdAck) this.ack(seq);
  }
}
