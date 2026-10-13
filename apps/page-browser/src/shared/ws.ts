// A minimal RFC 6455 WebSocket on Node built-ins: frames both ways (masked
// client frames, unmasked server frames), the client handshake the holder
// uses on Chrome's DevTools endpoint and the server handshake of the
// operator's RPC endpoint. No extensions (no permessage-deflate). The codec
// opens no connection itself: the callers that may (holder/, rpc/) hand it
// their sockets.

import { createHash, randomBytes } from "node:crypto";
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
  const length = payload.length;
  const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const out = Buffer.allocUnsafe(2 + extra + (mask ? 4 : 0) + length);
  out[0] = (fin ? 0x80 : 0) | opcode;
  let offset = 2;
  if (length < 126) {
    out[1] = (mask ? 0x80 : 0) | length;
  } else if (length < 65536) {
    out[1] = (mask ? 0x80 : 0) | 126;
    out.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    out[1] = (mask ? 0x80 : 0) | 127;
    out.writeBigUInt64BE(BigInt(length), 2);
    offset = 10;
  }
  if (mask) {
    const key = randomBytes(4);
    key.copy(out, offset);
    offset += 4;
    for (let i = 0; i < length; i++) out[offset + i] = payload[i]! ^ key[i & 3]!;
  } else {
    payload.copy(out, offset);
  }
  return out;
}

export interface WsMessage {
  opcode: number;
  payload: Buffer;
}

/** Incremental frame parser: fed chunks, it calls back per complete message
 *  (data frames reassembled) and per control frame. */
export class FrameParser {
  #chunks: Buffer[] = [];
  #length = 0;
  #fragOpcode = -1;
  #fragParts: Buffer[] = [];
  #fragLength = 0;
  readonly maxMessage: number;

  constructor(maxMessage: number) {
    this.maxMessage = maxMessage;
  }

  push(chunk: Buffer, onMessage: (message: WsMessage) => void): void {
    this.#chunks.push(chunk);
    this.#length += chunk.length;
    for (;;) {
      if (this.#length < 2) return;
      const head = this.#peek(Math.min(this.#length, 14));
      const fin = (head[0]! & 0x80) !== 0;
      const opcode = head[0]! & 0x0f;
      const masked = (head[1]! & 0x80) !== 0;
      let length = head[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (head.length < 4) return;
        length = head.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (head.length < 10) return;
        const big = head.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessage)) throw new Error(`a frame of ${big} bytes is over the limit`);
        length = Number(big);
        offset = 10;
      }
      if (length > this.maxMessage) throw new Error(`a frame of ${length} bytes is over the limit`);
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.#length < offset + length) return;
      const frame = this.#take(offset + length);
      let payload = frame.subarray(offset);
      if (masked) {
        const key = frame.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ key[i & 3]!;
      }
      if (opcode >= 0x8) {
        if (!fin || payload.length > 125) throw new Error("a malformed control frame");
        onMessage({ opcode, payload });
        continue;
      }
      if (opcode !== OP_CONTINUATION) {
        if (this.#fragOpcode >= 0) throw new Error("a new message inside a fragmented one");
        if (fin) {
          onMessage({ opcode, payload });
          continue;
        }
        this.#fragOpcode = opcode;
        this.#fragParts = [payload];
        this.#fragLength = payload.length;
        continue;
      }
      if (this.#fragOpcode < 0) throw new Error("a continuation frame without a start");
      this.#fragParts.push(payload);
      this.#fragLength += payload.length;
      if (this.#fragLength > this.maxMessage) throw new Error("a message over the limit");
      if (fin) {
        const whole = Buffer.concat(this.#fragParts, this.#fragLength);
        const first = this.#fragOpcode;
        this.#fragOpcode = -1;
        this.#fragParts = [];
        this.#fragLength = 0;
        onMessage({ opcode: first, payload: whole });
      }
    }
  }

  #peek(n: number): Buffer {
    const first = this.#chunks[0]!;
    if (first.length >= n) return first.subarray(0, n);
    const merged = Buffer.concat(this.#chunks, this.#length);
    this.#chunks = [merged];
    return merged.subarray(0, n);
  }

  #take(n: number): Buffer {
    const first = this.#chunks[0]!;
    if (first.length === n) {
      this.#chunks.shift();
      this.#length -= n;
      return first;
    }
    if (first.length > n) {
      this.#chunks[0] = first.subarray(n);
      this.#length -= n;
      return first.subarray(0, n);
    }
    const merged = Buffer.concat(this.#chunks, this.#length);
    this.#chunks = merged.length > n ? [merged.subarray(n)] : [];
    this.#length -= n;
    return merged.subarray(0, n);
  }
}

/** A WebSocket over an established stream: text and binary in and out,
 *  pings answered, close handled. `client` = this side masks its frames. */
export class WsConnection {
  readonly socket: Duplex;
  readonly client: boolean;
  #parser: FrameParser;
  #closed = false;
  /** A text message, as its UTF-8 payload (callers decode when they need to). */
  onText: (payload: Buffer) => void = () => undefined;
  onBinary: (payload: Buffer) => void = () => undefined;
  onClose: (reason: string) => void = () => undefined;

  constructor(socket: Duplex, client: boolean, maxMessage: number, head?: Buffer) {
    this.socket = socket;
    this.client = client;
    this.#parser = new FrameParser(maxMessage);
    socket.on("data", (chunk: Buffer) => this.#feed(chunk));
    socket.on("close", () => this.#finish("socket closed"));
    socket.on("error", (error: Error) => this.#finish(`socket error: ${error.message}`));
    if (head && head.length > 0) queueMicrotask(() => this.#feed(head));
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** False when the stream's buffer is over its high-water mark. */
  sendText(text: string | Buffer): boolean {
    if (this.#closed) return false;
    return this.socket.write(encodeFrame(OP_TEXT, typeof text === "string" ? Buffer.from(text, "utf8") : text, this.client));
  }

  sendBinary(data: Buffer): boolean {
    if (this.#closed) return false;
    return this.socket.write(encodeFrame(OP_BINARY, data, this.client));
  }

  /** Raw bytes: the stand's fault injection breaks the protocol on purpose. */
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
      // the stream is gone already
    }
    this.socket.end();
    this.#finish(`closed by this side (${code})`);
  }

  destroy(reason = "destroyed"): void {
    this.socket.destroy();
    this.#finish(reason);
  }

  #feed(chunk: Buffer): void {
    if (this.#closed) return;
    try {
      this.#parser.push(chunk, (message) => this.#dispatch(message));
    } catch (error) {
      this.socket.destroy();
      this.#finish(`protocol error: ${(error as Error).message}`);
    }
  }

  #dispatch(message: WsMessage): void {
    switch (message.opcode) {
      case OP_TEXT:
        this.onText(message.payload);
        return;
      case OP_BINARY:
        this.onBinary(message.payload);
        return;
      case OP_PING:
        if (!this.#closed) this.socket.write(encodeFrame(OP_PONG, message.payload, this.client));
        return;
      case OP_PONG:
        return;
      case OP_CLOSE: {
        const code = message.payload.length >= 2 ? message.payload.readUInt16BE(0) : 1005;
        if (!this.#closed) {
          try {
            this.socket.write(encodeFrame(OP_CLOSE, message.payload.subarray(0, 2), this.client));
          } catch {
            // the stream is gone already
          }
          this.socket.end();
        }
        this.#finish(`peer closed (${code})`);
        return;
      }
      default:
        throw new Error(`opcode ${message.opcode} is not supported`);
    }
  }

  #finish(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onClose(reason);
  }
}

/** The client handshake on a stream that is already connected. No Origin
 *  header: Chrome's DevTools endpoint rejects a WebSocket that sends one. */
export function clientHandshake(socket: Duplex, hostHeader: string, path: string, maxMessage: number, timeoutMs = 5000): Promise<WsConnection> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    let buffered = Buffer.alloc(0);
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`the WebSocket handshake on ${path} timed out`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > 16 * 1024) fail(new Error("the WebSocket handshake answer is too long"));
        return;
      }
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      const lines = buffered.subarray(0, end).toString("latin1").split("\r\n");
      if (!/^HTTP\/1\.1 101 /.test(lines[0] ?? "")) return fail(new Error(`the WebSocket handshake was refused: ${lines[0] ?? ""}`));
      const accept = lines.find((line) => line.toLowerCase().startsWith("sec-websocket-accept:"));
      if (!accept || accept.slice(accept.indexOf(":") + 1).trim() !== acceptKey(key)) return fail(new Error("the WebSocket handshake had a wrong Sec-WebSocket-Accept"));
      resolve(new WsConnection(socket, true, maxMessage, buffered.subarray(end + 4)));
    };
    const onError = (error: Error) => fail(error);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  });
}

/** The server side of an HTTP Upgrade (node:http's `upgrade` event); null
 *  (the stream answered and ended) when the request is not a WebSocket one. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, maxMessage: number): WsConnection | null {
  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  if (typeof key !== "string" || upgrade !== "websocket" || req.headers["sec-websocket-version"] !== "13") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return null;
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  return new WsConnection(socket, false, maxMessage, head);
}
