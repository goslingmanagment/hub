// The operator's RPC endpoint for the engine (plan §4.13): one WebSocket,
// JSON messages, the first one is `hello` with the page token. A newer
// owner generation replaces the older connection; messages of an older
// generation are refused. PROTOTYPE: the subset the stand needs.

import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { acceptWebSocket, type WsConnection } from "../shared/ws.ts";
import { makeLog, monoMs } from "../shared/util.ts";

const log = makeLog("rpc");

export type EngineMessage = { type: string; ownerGeneration?: number; [key: string]: unknown };

export class RpcServer {
  readonly token: string;
  #conn: WsConnection | null = null;
  #generation = 0;
  #lastPing = 0;
  onMessage: (message: EngineMessage) => void = () => undefined;
  onConnected: (hello: EngineMessage) => Record<string, unknown> = () => ({});
  onLost: (reason: string) => void = () => undefined;

  constructor(token: string) {
    this.token = token;
  }

  get generation(): number {
    return this.#generation;
  }

  /** The engine link counts as up while it pinged within 5 s (plan §4.14). */
  get up(): boolean {
    return this.#conn !== null && !this.#conn.closed && monoMs() - this.#lastPing < 5000;
  }

  send(message: Record<string, unknown>): boolean {
    if (!this.#conn || this.#conn.closed) return false;
    return this.#conn.sendText(JSON.stringify(message));
  }

  listen(port: number, host = "0.0.0.0"): Promise<void> {
    const server = createServer((_req, res) => res.writeHead(404).end());
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (req.url !== "/rpc") {
        socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
        return;
      }
      const conn = acceptWebSocket(req, socket, head);
      if (conn) this.#adopt(conn);
    });
    setInterval(() => {
      if (this.#conn && !this.#conn.closed && monoMs() - this.#lastPing > 5000) {
        log("engine.silent", { sinceMs: Math.round(monoMs() - this.#lastPing) });
        const conn = this.#conn;
        this.#conn = null;
        conn.destroy("no ping for 5 s");
        this.onLost("no ping for 5 s");
      }
    }, 500);
    return new Promise((resolve) => server.listen(port, host, () => resolve()));
  }

  #adopt(conn: WsConnection): void {
    let hello = false;
    conn.onText = (text) => {
      let message: EngineMessage;
      try {
        message = JSON.parse(text) as EngineMessage;
      } catch {
        conn.destroy("bad json");
        return;
      }
      if (!hello) {
        if (message.type !== "hello" || message.token !== this.token || typeof message.ownerGeneration !== "number") {
          log("hello.refused", { type: message.type });
          conn.sendText(JSON.stringify({ type: "helloRefused", reason: "token or generation" }));
          conn.close(4001);
          return;
        }
        if (message.ownerGeneration < this.#generation) {
          conn.sendText(JSON.stringify({ type: "helloRefused", reason: "stale owner generation", current: this.#generation }));
          conn.close(4002);
          return;
        }
        hello = true;
        if (this.#conn && this.#conn !== conn) {
          log("engine.replaced", { from: this.#generation, to: message.ownerGeneration });
          this.#conn.destroy("replaced by a newer owner generation");
        }
        this.#conn = conn;
        this.#generation = message.ownerGeneration;
        this.#lastPing = monoMs();
        log("engine.connected", { ownerGeneration: this.#generation });
        conn.sendText(JSON.stringify({ type: "helloResult", ...this.onConnected(message) }));
        return;
      }
      if (this.#conn !== conn) return;
      if (typeof message.ownerGeneration === "number" && message.ownerGeneration < this.#generation) {
        log("message.stale", { type: message.type, ownerGeneration: message.ownerGeneration });
        return;
      }
      if (message.type === "ping") {
        this.#lastPing = monoMs();
        conn.sendText(JSON.stringify({ type: "pong", n: message.n }));
        return;
      }
      this.onMessage(message);
    };
    conn.onClose = (reason) => {
      if (this.#conn === conn) {
        this.#conn = null;
        log("engine.lost", { reason });
        this.onLost(reason);
      }
    };
  }
}
