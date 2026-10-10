// A minimal RFC 6455 WebSocket codec on Node built-ins: frames both ways
// (masked client frames, unmasked server frames), the client handshake the
// holder uses to reach Chrome's DevTools endpoint, and the server handshake of
// the operator's RPC endpoint. No extensions (no permessage-deflate).

import { createHash, randomBytes } from "node:crypto";
import { connect as tcpConnect, type Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export const OP_CONTINUATION = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptKey(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/** One frame; `mask` = a client frame (RFC 6455 §5.3). */
export function encodeFrame(opcode: number, payload: Buffer, mask: boolean, fin = true): Buffer {
  const len = payload.length;
  const extra = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const out = Buffer.allocUnsafe(2 + extra + (mask ? 4 : 0) + len);
  out[0] = (fin ? 0x80 : 0) | opcode;
  let off = 2;
  if (len < 126) {
    out[1] = (mask ? 0x80 : 0) | len;
  } else if (len < 65536) {
    out[1] = (mask ? 0x80 : 0) | 126;
    out.writeUInt16BE(len, 2);
    off = 4;
  } else {
    out[1] = (mask ? 0x80 : 0) | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
    off = 10;
  }
  if (mask) {
    const key = randomBytes(4);
    key.copy(out, off);
    off += 4;
    for (let i = 0; i < len; i++) out[off + i] = payload[i]! ^ key[i & 3]!;
  } else {
    payload.copy(out, off);
  }
  return out;
}

export interface WsMessage {
  opcode: number;
  payload: Buffer;
}

/** Incremental frame parser: feed it chunks, it calls back per complete
 *  message (data frames reassembled) and per control frame. Keeps the
 *  received chunks in a list so a multi-megabyte frame costs one copy. */
export class FrameParser {
  #chunks: Buffer[] = [];
  #len = 0;
  #fragOpcode = -1;
  #fragParts: Buffer[] = [];
  #fragLen = 0;
  readonly maxMessage: number;

  constructor(maxMessage = 1024 * 1024 * 1024) {
    this.maxMessage = maxMessage;
  }

  push(chunk: Buffer, onMessage: (message: WsMessage) => void): void {
    this.#chunks.push(chunk);
    this.#len += chunk.length;
    for (;;) {
      if (this.#len < 2) return;
      const head = this.#peek(Math.min(this.#len, 14));
      const b0 = head[0]!;
      const b1 = head[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (head.length < 4) return;
        len = head.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (head.length < 10) return;
        const big = head.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessage)) throw new Error(`websocket frame of ${big} bytes is over the limit`);
        len = Number(big);
        off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (this.#len < off + len) return;
      const frame = this.#take(off + len);
      let payload = frame.subarray(off);
      if (masked) {
        const key = frame.subarray(maskOff, maskOff + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ key[i & 3]!;
      }
      if (opcode >= 0x8) {
        onMessage({ opcode, payload });
        continue;
      }
      if (opcode !== OP_CONTINUATION) {
        if (fin) {
          onMessage({ opcode, payload });
          continue;
        }
        this.#fragOpcode = opcode;
        this.#fragParts = [payload];
        this.#fragLen = payload.length;
        continue;
      }
      if (this.#fragOpcode < 0) throw new Error("websocket continuation frame without a start");
      this.#fragParts.push(payload);
      this.#fragLen += payload.length;
      if (this.#fragLen > this.maxMessage) throw new Error("websocket message is over the limit");
      if (fin) {
        const whole = Buffer.concat(this.#fragParts, this.#fragLen);
        const op = this.#fragOpcode;
        this.#fragOpcode = -1;
        this.#fragParts = [];
        this.#fragLen = 0;
        onMessage({ opcode: op, payload: whole });
      }
    }
  }

  #peek(n: number): Buffer {
    if (this.#chunks[0]!.length >= n) return this.#chunks[0]!.subarray(0, n);
    const merged = Buffer.concat(this.#chunks, this.#len);
    this.#chunks = [merged];
    return merged.subarray(0, n);
  }

  #take(n: number): Buffer {
    const first = this.#chunks[0]!;
    if (first.length === n) {
      this.#chunks.shift();
      this.#len -= n;
      return first;
    }
    if (first.length > n) {
      this.#chunks[0] = first.subarray(n);
      this.#len -= n;
      return first.subarray(0, n);
    }
    const merged = Buffer.concat(this.#chunks, this.#len);
    this.#chunks = merged.length > n ? [merged.subarray(n)] : [];
    this.#len -= n;
    return merged.subarray(0, n);
  }
}

/** A WebSocket over an established socket: text in, text out, pings
 *  answered, close handled. `client` = this side masks its frames. */
export class WsConnection {
  readonly socket: Duplex;
  readonly client: boolean;
  #parser = new FrameParser();
  #closed = false;
  onText: (text: string) => void = () => undefined;
  onBinary: (data: Buffer) => void = () => undefined;
  onClose: (reason: string) => void = () => undefined;

  constructor(socket: Duplex, client: boolean, head?: Buffer) {
    this.socket = socket;
    this.client = client;
    socket.on("data", (chunk: Buffer) => this.#feed(chunk));
    socket.on("close", () => this.#finish("socket closed"));
    socket.on("error", (error: Error) => this.#finish(`socket error: ${error.message}`));
    if (head && head.length > 0) queueMicrotask(() => this.#feed(head));
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** False when the socket's write buffer is over its high-water mark. */
  sendText(text: string): boolean {
    if (this.#closed) return false;
    return this.socket.write(encodeFrame(OP_TEXT, Buffer.from(text, "utf8"), this.client));
  }

  sendBinary(data: Buffer): boolean {
    if (this.#closed) return false;
    return this.socket.write(encodeFrame(OP_BINARY, data, this.client));
  }

  /** Raw bytes, for tests that must break the protocol on purpose. */
  writeRaw(bytes: Buffer): void {
    this.socket.write(bytes);
  }

  close(code = 1000): void {
    if (this.#closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    try {
      this.socket.write(encodeFrame(OP_CLOSE, payload, this.client));
    } catch {
      // the socket is already gone
    }
    this.socket.end();
    this.#finish(`closed by us (${code})`);
  }

  destroy(reason = "destroyed"): void {
    this.socket.destroy();
    this.#finish(reason);
  }

  #feed(chunk: Buffer): void {
    try {
      this.#parser.push(chunk, (message) => {
        switch (message.opcode) {
          case OP_TEXT:
            this.onText(message.payload.toString("utf8"));
            break;
          case OP_BINARY:
            this.onBinary(message.payload);
            break;
          case OP_PING:
            if (!this.#closed) this.socket.write(encodeFrame(OP_PONG, message.payload, this.client));
            break;
          case OP_PONG:
            break;
          case OP_CLOSE: {
            const code = message.payload.length >= 2 ? message.payload.readUInt16BE(0) : 1005;
            if (!this.#closed) {
              try {
                this.socket.write(encodeFrame(OP_CLOSE, message.payload.subarray(0, 2), this.client));
              } catch {
                // ignore
              }
              this.socket.end();
            }
            this.#finish(`peer closed (${code})`);
            break;
          }
          default:
            throw new Error(`websocket opcode ${message.opcode} is not supported`);
        }
      });
    } catch (error) {
      this.socket.destroy();
      this.#finish(`protocol error: ${(error as Error).message}`);
    }
  }

  #finish(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onClose(reason);
  }
}

/** Client handshake over a fresh TCP connection (no Origin header: Chrome's
 *  DevTools endpoint rejects any WebSocket that sends one). */
export function connectWebSocket(host: string, port: number, path: string, timeoutMs = 5000): Promise<WsConnection> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const socket: Socket = tcpConnect({ host, port });
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`websocket handshake to ${host}:${port}${path} timed out`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      clearTimeout(timer);
      const head = buffered.subarray(0, end).toString("latin1");
      const rest = buffered.subarray(end + 4);
      const lines = head.split("\r\n");
      if (!/^HTTP\/1\.1 101 /.test(lines[0] ?? "")) {
        socket.destroy();
        reject(new Error(`websocket handshake refused: ${lines[0]}`));
        return;
      }
      const acceptLine = lines.find((line) => line.toLowerCase().startsWith("sec-websocket-accept:"));
      if (!acceptLine || acceptLine.slice(acceptLine.indexOf(":") + 1).trim() !== acceptKey(key)) {
        socket.destroy();
        reject(new Error("websocket handshake: bad Sec-WebSocket-Accept"));
        return;
      }
      socket.setNoDelay(true);
      resolve(new WsConnection(socket, true, rest));
    };
    socket.on("data", onData);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
  });
}

/** Server side of an HTTP Upgrade (node:http `upgrade` event). */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): WsConnection | null {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  return new WsConnection(socket, false, head);
}
