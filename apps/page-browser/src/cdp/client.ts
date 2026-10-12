// The operator's CDP client, through the holder (holder/holder.ts): commands
// with ids, events by method, flatten sessions. Every Chrome message arrives
// numbered; the operator acknowledges a number once it has handled it, so a
// restarted operator gets the unhandled ones again. `Fetch.requestPaused` is
// acknowledged only once its request is continued or failed
// (cdp/paused.ts), so a restarted operator learns about every request that
// is still paused.
//
// Messages numbered up to the holder's `lastSeq` at hello arrived before
// this operator instance existed: a replay. A command's reply among them is
// another instance's (ids start at a random base) and is dropped.

import { createConnection, type Socket } from "node:net";

import { encodeMessage, readMessages } from "../shared/frames.ts";
import { makeLog, type Logger } from "../shared/util.ts";

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
  /** The holder's number of this message. */
  seq: number;
  /** Arrived before this operator instance linked to the holder. */
  replayed: boolean;
}

export type EventHandler = (event: CdpEvent) => void;

export class CdpError extends Error {
  readonly code: number;
  readonly method: string;
  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message} (${code})`);
    this.name = "CdpError";
    this.code = code;
    this.method = method;
  }
}

/** Not answered: the command may or may not have run in Chrome. */
export class CdpUnanswered extends Error {
  constructor(method: string, why: string) {
    super(`${method}: ${why}`);
    this.name = "CdpUnanswered";
  }
}

export interface HolderLink {
  /** Chrome's DevTools connection was up when the holder greeted us. */
  cdpUp: boolean;
  /** Messages the holder kept from before this instance. */
  stored: number;
  lastSeq: number;
}

export type HolderEvent = { t: "cdp.up" } | { t: "cdp.down"; reason: string } | { t: "overflow" } | { t: "stopping" };

interface Pending {
  method: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CdpOptions {
  socketPath: string;
  /** A command Chrome does not answer within this fails (plan §4.9: a
   *  browser that stops answering is a lost browser). */
  commandTimeoutMs?: number;
  log?: Logger;
}

export class Cdp {
  readonly #options: CdpOptions;
  readonly #log: Logger;
  #socket: Socket | null = null;
  #nextId = 1 + Math.floor(Math.random() * 1_000_000_000);
  readonly #pending = new Map<number, Pending>();
  readonly #handlers = new Map<string, EventHandler[]>();
  #ackBatch: number[] = [];
  #ackTimer: NodeJS.Timeout | null = null;
  #cdpUp = false;
  #lastSeq = 0;
  #replayEnded: Promise<void> = Promise.resolve();
  #endReplay: () => void = () => undefined;
  onHolderEvent: (event: HolderEvent) => void = () => undefined;
  /** The link to the holder closed (the holder exited, or was replaced). */
  onHolderGone: () => void = () => undefined;

  constructor(options: CdpOptions) {
    this.#options = options;
    this.#log = options.log ?? makeLog("cdp");
  }

  get linked(): boolean {
    return this.#socket !== null && !this.#socket.destroyed;
  }

  /** Chrome's DevTools connection is up (as the holder last said). */
  get cdpUp(): boolean {
    return this.linked && this.#cdpUp;
  }

  /** Settles once every message kept from before this instance was handled
   *  (the holder's `replay.end`), or the link went down. */
  get replayEnded(): Promise<void> {
    return this.#replayEnded;
  }

  /** One attempt to link to the holder; resolves at its hello. */
  connect(): Promise<HolderLink> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.#options.socketPath);
      let greeted = false;
      socket.once("error", (error) => {
        if (!greeted) reject(error);
      });
      socket.on("close", () => {
        if (!greeted) {
          reject(new Error("the holder closed the link before its hello"));
          return;
        }
        if (this.#socket !== socket) return;
        this.#socket = null;
        this.#cdpUp = false;
        this.#dropAcks();
        this.#endReplay();
        this.#failPending("the holder link closed");
        this.onHolderGone();
      });
      readMessages(
        socket,
        (value) => {
          const message = (value ?? {}) as { t?: string; seq?: number; d?: Record<string, unknown>; cdp?: string; stored?: number; lastSeq?: number; reason?: string };
          if (message.t === "hello") {
            greeted = true;
            this.#socket?.destroy();
            // Acknowledgements are numbers of one holder's messages: none
            // carries over to another link.
            this.#dropAcks();
            this.#socket = socket;
            this.#cdpUp = message.cdp === "up";
            this.#lastSeq = message.lastSeq ?? 0;
            this.#replayEnded = new Promise<void>((done) => (this.#endReplay = done));
            resolve({ cdpUp: this.#cdpUp, stored: message.stored ?? 0, lastSeq: this.#lastSeq });
            return;
          }
          if (!greeted || this.#socket !== socket) return;
          switch (message.t) {
            case "m":
              if (typeof message.seq === "number" && message.d) this.#onChrome(message.seq, message.d);
              return;
            case "replay.end":
              this.#endReplay();
              return;
            case "cdp.up":
              this.#cdpUp = true;
              this.onHolderEvent({ t: "cdp.up" });
              return;
            case "cdp.down":
              this.#cdpUp = false;
              this.#failPending("Chrome's DevTools connection closed");
              this.onHolderEvent({ t: "cdp.down", reason: String(message.reason ?? "") });
              return;
            case "overflow":
              this.onHolderEvent({ t: "overflow" });
              return;
            case "stopping":
              this.onHolderEvent({ t: "stopping" });
              return;
          }
        },
        (error) => this.#log("holder.bad_message", { error: error.message }),
      );
    });
  }

  /** A command; rejects with CdpError (Chrome's answer), or CdpUnanswered
   *  (no answer: timeout, CDP or the holder link down). Parameters are never
   *  logged here: some carry what the owner typed or a request's content. */
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs?: number): Promise<T> {
    const socket = this.#socket;
    if (!socket || socket.destroyed) return Promise.reject(new CdpUnanswered(method, "the holder link is down"));
    if (!this.#cdpUp) return Promise.reject(new CdpUnanswered(method, "CDP is down"));
    const id = this.#nextId++;
    if (this.#nextId > 2_000_000_000) this.#nextId = 1;
    const command: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) command.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(new CdpUnanswered(method, `no answer in ${timeoutMs ?? this.#options.commandTimeoutMs ?? 10_000} ms`));
      }, timeoutMs ?? this.#options.commandTimeoutMs ?? 10_000);
      this.#pending.set(id, { method, resolve: resolve as (value: Record<string, unknown>) => void, reject, timer });
      socket.write(encodeMessage(JSON.stringify({ t: "send", d: command })));
    });
  }

  on(method: string, handler: EventHandler): void {
    const list = this.#handlers.get(method) ?? [];
    list.push(handler);
    this.#handlers.set(method, list);
  }

  /** Acknowledge a message to the holder (batched, ≤ 20 ms). */
  ack(seq: number): void {
    this.#ackBatch.push(seq);
    if (this.#ackTimer) return;
    this.#ackTimer = setTimeout(() => this.flushAcks(), 20);
  }

  flushAcks(): void {
    if (this.#ackTimer) clearTimeout(this.#ackTimer);
    this.#ackTimer = null;
    if (this.#ackBatch.length === 0) return;
    const seqs = this.#ackBatch;
    this.#ackBatch = [];
    this.#socket?.write(encodeMessage(JSON.stringify({ t: "ack", seqs })));
  }

  /** A message of the holder's own protocol (exit.closed; stand faults). */
  holderCommand(t: string): void {
    this.#socket?.write(encodeMessage(JSON.stringify({ t })));
  }

  #dropAcks(): void {
    if (this.#ackTimer) clearTimeout(this.#ackTimer);
    this.#ackTimer = null;
    this.#ackBatch = [];
  }

  close(): void {
    this.flushAcks();
    const socket = this.#socket;
    this.#socket = null;
    this.#cdpUp = false;
    this.#endReplay();
    this.#failPending("the operator closed the link");
    socket?.destroy();
  }

  #failPending(why: string): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(new CdpUnanswered(pending.method, why));
    }
  }

  #onChrome(seq: number, message: Record<string, unknown>): void {
    if (typeof message.id === "number") {
      this.ack(seq);
      const pending = this.#pending.get(message.id);
      if (!pending) return; // another instance's command, or one that timed out
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      const error = message.error as { code?: number; message?: string } | undefined;
      if (error) pending.reject(new CdpError(pending.method, error.code ?? 0, error.message ?? "error"));
      else pending.resolve((message.result as Record<string, unknown> | undefined) ?? {});
      return;
    }
    const event: CdpEvent = {
      method: String(message.method),
      params: (message.params as Record<string, unknown> | undefined) ?? {},
      seq,
      replayed: seq <= this.#lastSeq,
    };
    if (typeof message.sessionId === "string") event.sessionId = message.sessionId;
    // A paused request stays unacknowledged until it is resolved; every
    // other message is done once its handlers ran.
    const holdAck = event.method === "Fetch.requestPaused";
    for (const handler of this.#handlers.get(event.method) ?? []) {
      try {
        handler(event);
      } catch (error) {
        this.#log("handler.failed", { method: event.method, error: (error as Error).stack ?? String(error) });
      }
    }
    if (!holdAck) this.ack(seq);
  }
}
