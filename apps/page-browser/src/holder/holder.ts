// The CDP connection holder (plan §3.1, §4.1; stage 1, §3.2). One DevTools
// connection to Chrome's browser target that outlives the operator: a crashed
// or hung operator does not detach the Fetch interception, and a detach is
// what makes Chrome release every held request unchanged
// (InterceptionJob::Detach).
//
// It knows next to nothing of CDP. It reads Chrome continuously — Chrome
// silently drops DevTools messages once its 256 MB send buffer is full —
// numbers every message and keeps it until the operator acknowledges that
// number. A restarted operator gets every unacknowledged message again: CDP
// has no list of paused requests, so this replay is how it learns about
// them. Operator commands go to Chrome unchanged. One message is kept other
// than Chrome sent it: a paused request whose body is large keeps only the
// body's length (`trimPausedPostData`).
//
// Over its store limit (128 MB, plan §4.14) the holder kills Chrome — the
// held requests die with the browser, none is released — and exits only once
// Chrome's side of the connection is gone. A planned stop asks the operator
// to close the exit first; an operator that does not confirm in time gets
// the same treatment: Chrome goes before CDP does. A timeout never lets go
// of a live CDP connection. It exits as well when Chrome
// closes the connection: the session and its interception are gone, and s6
// starts a fresh holder for the next Chrome.
//
// The link to the operator: a unix socket, length-prefixed JSON
// (shared/frames.ts).
//   holder → operator: {t:"hello", cdp:"up"|"down", stored, lastSeq}
//                      {t:"m", seq, d:<a CDP message as Chrome sent it>}
//                      {t:"replay.end"} — every message kept from before
//                      this operator connected has been written
//                      {t:"cdp.up"} {t:"cdp.down", reason} {t:"overflow"}
//                      {t:"stopping"} — asks the operator to close the exit
//                      before the holder lets go of CDP
//   operator → holder: {t:"send", d:<a CDP command>} {t:"ack", seqs:[…]}
//                      {t:"exit.closed"} — the answer to "stopping"
//                      stand only (allowFaults): {t:"test.breakCdp"} (an
//                      unmasked frame: Chrome closes the connection),
//                      {t:"test.dropCdp"} (the holder drops the TCP socket)

import { get as httpGet } from "node:http";
import { connect as tcpConnect, createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";

import { encodeMessage, encodeParts, readMessages } from "../shared/frames.ts";
import { clientHandshake, encodeFrame, OP_TEXT, type WsConnection } from "../shared/ws.ts";
import { errorMessage, makeLog, sleep, type Logger } from "../shared/util.ts";

/** Chrome's single messages can be large (a big response body read over
 *  CDP); the store limit is what bounds memory. */
export const CDP_MAX_MESSAGE = 512 * 1024 * 1024;
const REPLAY_END = -1;

/** A message over this may be a paused request with a large body. */
export const PAUSED_BODY_KEPT_MAX = 1024 * 1024;
const PAUSED_HEAD = Buffer.from('{"method":"Fetch.requestPaused",');

/** A paused request's body over 1 MiB, kept as its length only. An upload's
 *  part, handed to Chrome at its release (hub-requests/hub.ts), comes back
 *  whole in the pause of its response: as text and again as base64, 2.3
 *  times the part (stand/part-upload-check.ts). Kept, a 20 MiB part took
 *  45 MB of the store and a few of them killed Chrome (ari-1, 2026-10-27).
 *  Nothing reads a body that large: the writes checked by their body are
 *  small JSON (intercept/checked.ts). The request gets
 *  `pbPostDataBytes`: the bytes of its body, null when Chrome did not
 *  attach them whole (cdp/paused.ts reads it). Every other message, and
 *  every message of 1 MiB or less, stays as Chrome sent it. */
export function trimPausedPostData(payload: Buffer): Buffer {
  if (payload.length <= PAUSED_BODY_KEPT_MAX || !payload.subarray(0, PAUSED_HEAD.length).equals(PAUSED_HEAD)) return payload;
  let message: { params?: { request?: Record<string, unknown> } };
  try {
    message = JSON.parse(payload.toString("utf8")) as typeof message;
  } catch {
    return payload;
  }
  const request = message.params?.request;
  if (request === undefined || (request.postData === undefined && request.postDataEntries === undefined)) return payload;
  let bytes: number | null = null;
  const entries = request.postDataEntries;
  if (Array.isArray(entries) && entries.length > 0) {
    bytes = 0;
    for (const entry of entries as Array<{ bytes?: unknown }>) {
      if (typeof entry?.bytes !== "string") {
        bytes = null;
        break;
      }
      bytes += Buffer.byteLength(entry.bytes, "base64");
    }
  }
  delete request.postData;
  delete request.postDataEntries;
  request.pbPostDataBytes = bytes;
  return Buffer.from(JSON.stringify(message));
}

export interface HolderOptions {
  cdpHost: string;
  cdpPort: number;
  /** The unix socket the operator connects to. */
  socketPath: string;
  /** Unacknowledged bytes kept at most (plan §4.14: 128 MB). */
  maxBytes: number;
  /** Kill Chrome at once (s6-svc -K -d): held requests die with it. */
  killChrome: () => Promise<void>;
  /** How long the holder waits for Chrome's side to close after the kill. */
  overflowGraceMs?: number;
  /** How long a planned stop waits for the operator to close the exit. */
  stopGraceMs?: number;
  /** Between attempts to reach Chrome's DevTools endpoint. */
  pollMs?: number;
  /** The stand's fault injection (test.breakCdp, test.dropCdp). */
  allowFaults?: boolean;
  /** The holder is done: the process exits with this code. */
  onExit: (code: number) => void;
  log?: Logger;
}

export class Holder {
  readonly #options: HolderOptions;
  readonly #log: Logger;
  #server: Server | null = null;
  #cdp: WsConnection | null = null;
  #seq = 0;
  /** Unacknowledged Chrome messages, in arrival order. */
  readonly #store = new Map<number, Buffer>();
  #storeBytes = 0;
  #operator: Socket | null = null;
  /** Seqs not yet written to the current operator; REPLAY_END marks where
   *  the replay of what was kept before it connected ends. */
  #queue: number[] = [];
  #overflowed = false;
  #exiting = false;
  #stopping: { resolve: () => void } | null = null;
  /** A planned stop runs: it ends with its own exit code. */
  #stopRequested = false;
  #cdpClosed: Promise<void> | null = null;

  constructor(options: HolderOptions) {
    this.#options = options;
    this.#log = options.log ?? makeLog("holder");
  }

  get stats(): { stored: number; storeBytes: number; lastSeq: number; cdpUp: boolean } {
    return { stored: this.#store.size, storeBytes: this.#storeBytes, lastSeq: this.#seq, cdpUp: this.#cdpUp() };
  }

  async start(): Promise<void> {
    await this.#listen();
    void this.#connectChrome().catch((error: unknown) => {
      if (this.#exiting) return; // stopped while it waited for Chrome
      this.#log("cdp.connect_failed", { error: errorMessage(error) });
      this.#exit(1);
    });
  }

  /** A planned stop (SIGTERM): the operator closes the exit first, then the
   *  holder lets go of CDP (plan §4.1). */
  async stop(): Promise<void> {
    if (this.#exiting || this.#stopRequested) return;
    this.#stopRequested = true;
    let confirmed = false;
    if (this.#cdpUp() && this.#operatorLinked()) {
      const answered = new Promise<void>((resolve) => (this.#stopping = { resolve }));
      this.#toOperator(JSON.stringify({ t: "stopping" }));
      confirmed = await Promise.race([answered.then(() => true), sleep(this.#options.stopGraceMs ?? 1000).then(() => false)]);
      this.#log("stopping", { exitClosedByOperator: confirmed });
    }
    // Without the operator's word — no answer, or no operator linked — the
    // exit is not known to be closed.
    if (this.#cdpUp() && !confirmed) await this.#killChromeUntilGone(this.#operatorLinked() ? "a stop the operator did not confirm" : "a stop with no operator linked");
    this.#exit(0);
  }

  /** Tests: release the sockets without exiting the process. */
  async close(): Promise<void> {
    this.#exiting = true;
    this.#cdp?.destroy("holder closed");
    this.#operator?.destroy();
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  #cdpUp(): boolean {
    return this.#cdp !== null && !this.#cdp.closed;
  }

  #operatorLinked(): boolean {
    return this.#operator !== null && !this.#operator.destroyed;
  }

  #toOperator(message: string | Buffer): void {
    if (!this.#operatorLinked()) return;
    this.#operator!.write(typeof message === "string" ? encodeMessage(message) : message);
  }

  #pump(): void {
    const operator = this.#operator;
    while (operator && !operator.destroyed && !operator.writableNeedDrain && this.#queue.length > 0) {
      const next = this.#queue.shift()!;
      if (next === REPLAY_END) {
        operator.write(encodeMessage(JSON.stringify({ t: "replay.end" })));
        continue;
      }
      const raw = this.#store.get(next);
      if (raw === undefined) continue; // acknowledged meanwhile
      operator.write(encodeParts([Buffer.from(`{"t":"m","seq":${next},"d":`), raw, Buffer.from("}")]));
    }
  }

  #onChromeMessage(payload: Buffer): void {
    if (this.#overflowed) return; // Chrome is being killed: nothing more is kept
    this.#seq += 1;
    const kept = trimPausedPostData(payload);
    this.#store.set(this.#seq, kept);
    this.#storeBytes += kept.length;
    if (this.#storeBytes > this.#options.maxBytes) {
      void this.#overflow();
      return;
    }
    this.#queue.push(this.#seq);
    this.#pump();
  }

  /** The operator stopped acknowledging (hung, or far behind): the browser
   *  goes, never the connection first. */
  async #overflow(): Promise<void> {
    this.#overflowed = true;
    this.#log("overflow", { storeBytes: this.#storeBytes, stored: this.#store.size });
    this.#toOperator(JSON.stringify({ t: "overflow" }));
    await this.#killChromeUntilGone("overflow");
    this.#exit(3);
  }

  /** Kill Chrome, and again, until its side of the connection is gone: the
   *  held requests die with the browser. Only then may the holder let go. */
  async #killChromeUntilGone(why: string): Promise<void> {
    const graceMs = this.#options.overflowGraceMs ?? 5000;
    for (let attempt = 1; this.#cdpUp(); attempt += 1) {
      try {
        await this.#options.killChrome();
      } catch (error) {
        this.#log("chrome.kill_failed", { why, attempt, error: errorMessage(error) });
      }
      const closed = await Promise.race([
        (this.#cdpClosed ?? Promise.resolve()).then(() => true),
        sleep(graceMs).then(() => false),
      ]);
      if (closed) return;
      this.#log("chrome.still_connected", { why, attempt, graceMs });
    }
  }

  #exit(code: number): void {
    if (this.#exiting) return;
    this.#exiting = true;
    // Let the last notice reach the operator.
    setTimeout(() => this.#options.onExit(code), 100);
  }

  async #browserPath(): Promise<string> {
    const { cdpHost, cdpPort } = this.#options;
    for (;;) {
      if (this.#exiting) throw new Error("the holder is exiting");
      try {
        return await new Promise<string>((resolve, reject) => {
          const req = httpGet({ host: cdpHost, port: cdpPort, path: "/json/version", timeout: 1000 }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (body += chunk));
            res.on("end", () => {
              try {
                const url = new URL((JSON.parse(body) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
                resolve(url.pathname);
              } catch (error) {
                reject(error as Error);
              }
            });
          });
          req.on("error", reject);
          req.on("timeout", () => req.destroy(new Error("timeout")));
        });
      } catch {
        await sleep(this.#options.pollMs ?? 100);
      }
    }
  }

  async #connectChrome(): Promise<void> {
    const path = await this.#browserPath();
    const { cdpHost, cdpPort } = this.#options;
    const socket = tcpConnect({ host: cdpHost, port: cdpPort });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.setNoDelay(true);
    const ws = await clientHandshake(socket, `${cdpHost}:${cdpPort}`, path, CDP_MAX_MESSAGE);
    if (this.#exiting) {
      ws.destroy("the holder is exiting");
      return;
    }
    this.#cdp = ws;
    this.#cdpClosed = new Promise<void>((resolve) => {
      ws.onClose = (reason) => {
        this.#log("cdp.down", { reason, stored: this.#store.size });
        this.#toOperator(JSON.stringify({ t: "cdp.down", reason }));
        resolve();
        // The session and every interception of it are gone in Chrome. The
        // operator closes the exit and restarts Chrome (plan §4.1); s6
        // starts a fresh holder for it.
        if (!this.#overflowed && !this.#stopRequested) this.#exit(2);
      };
    });
    ws.onText = (payload) => this.#onChromeMessage(payload);
    this.#log("cdp.up", { path });
    this.#toOperator(JSON.stringify({ t: "cdp.up" }));
  }

  #onOperatorMessage(value: unknown): void {
    const message = (value ?? {}) as { t?: unknown; d?: unknown; seqs?: unknown };
    switch (message.t) {
      case "send":
        if (this.#cdpUp() && !this.#overflowed) this.#cdp!.sendText(JSON.stringify(message.d));
        return;
      case "ack":
        if (!Array.isArray(message.seqs)) return;
        for (const acked of message.seqs) {
          const raw = typeof acked === "number" ? this.#store.get(acked) : undefined;
          if (raw === undefined) continue;
          this.#store.delete(acked as number);
          this.#storeBytes -= raw.length;
        }
        return;
      case "exit.closed":
        this.#stopping?.resolve();
        this.#stopping = null;
        return;
      case "test.breakCdp":
        if (!this.#options.allowFaults) break;
        // An unmasked client frame is a protocol error: Chrome's DevTools
        // server closes the connection on its side.
        this.#log("test.breakCdp");
        this.#cdp?.writeRaw(encodeFrame(OP_TEXT, Buffer.from("{}"), false));
        return;
      case "test.dropCdp":
        if (!this.#options.allowFaults) break;
        this.#log("test.dropCdp");
        this.#cdp?.destroy("test.dropCdp");
        return;
    }
    this.#log("operator.unknown_message", { t: typeof message.t === "string" ? message.t : null });
  }

  #listen(): Promise<void> {
    const { socketPath } = this.#options;
    if (existsSync(socketPath)) unlinkSync(socketPath);
    const server = createServer((socket) => this.#adopt(socket));
    this.#server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        chmodSync(socketPath, 0o600);
        this.#log("listening", { socket: socketPath });
        resolve();
      });
    });
  }

  #adopt(socket: Socket): void {
    if (this.#operatorLinked()) {
      this.#log("operator.replaced");
      this.#operator!.destroy();
    }
    this.#operator = socket;
    const keys = [...this.#store.keys()];
    this.#log("operator.connected", { stored: keys.length, lastSeq: this.#seq });
    this.#toOperator(JSON.stringify({ t: "hello", cdp: this.#cdpUp() ? "up" : "down", stored: keys.length, lastSeq: this.#seq }));
    if (this.#overflowed) this.#toOperator(JSON.stringify({ t: "overflow" }));
    this.#queue = [...keys, REPLAY_END];
    this.#pump();
    socket.on("drain", () => this.#pump());
    readMessages(
      socket,
      (value) => this.#onOperatorMessage(value),
      (error) => this.#log("operator.bad_message", { error: error.message }),
    );
    socket.on("close", () => {
      if (this.#operator !== socket) return;
      this.#operator = null;
      this.#log("operator.gone", { stored: this.#store.size });
    });
    socket.on("error", () => undefined);
  }
}
