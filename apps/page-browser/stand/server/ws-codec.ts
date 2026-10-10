// Minimal RFC 6455 WebSocket codec on Node built-ins, usable on either side of
// a connection:
//   - FrameParser: feed it Buffers, it emits one "frame" event per complete
//     frame ({fin, rsv, opcode, masked, payload}, payload already unmasked) and
//     one "error" event (a WsProtocolError) on malformed input, after which it
//     ignores further input;
//   - MessageAssembler: joins fragmented data frames into messages;
//   - encodeFrame(): builds a frame, masked (client → server) or not.
// No extensions: RSV bits are reported, never interpreted.

import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

const KNOWN_OPCODES = new Set<number>(Object.values(OPCODE));

/** RFC 6455 §1.3: the GUID appended to Sec-WebSocket-Key. */
export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface WsFrame {
  fin: boolean;
  /** RSV1..RSV3 as a 3-bit number; non-zero only with negotiated extensions. */
  rsv: number;
  opcode: number;
  /** Whether the frame was masked on the wire (client frames must be). */
  masked: boolean;
  /** Unmasked payload. */
  payload: Buffer;
}

/** Malformed input; `closeCode` is the close status the peer deserves. */
export class WsProtocolError extends Error {
  closeCode: number;

  constructor(message: string, closeCode = 1002) {
    super(message);
    this.name = "WsProtocolError";
    this.closeCode = closeCode;
  }
}

export interface FrameParserOptions {
  /** Largest accepted frame payload in bytes (default 64 MiB); larger → error 1009. */
  maxPayload?: number;
}

/**
 * Incremental frame parser. Chunks are kept in a list and joined only when a
 * frame is complete, so a large frame arriving in many small chunks costs one
 * copy, not one per chunk.
 */
export class FrameParser extends EventEmitter {
  #chunks: Buffer[] = [];
  #buffered = 0;
  #failed = false;
  readonly maxPayload: number;

  constructor(options: FrameParserOptions = {}) {
    super();
    this.maxPayload = options.maxPayload ?? 64 * 1024 * 1024;
  }

  /** Feed received bytes; emits "frame" for each complete frame, in order. */
  push(chunk: Buffer): void {
    if (this.#failed || chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    for (;;) {
      let frame: WsFrame | null;
      try {
        frame = this.#next();
      } catch (err) {
        this.#failed = true;
        this.#chunks = [];
        this.#buffered = 0;
        this.emit("error", err);
        return;
      }
      if (frame === null) return;
      this.emit("frame", frame);
      if (this.#failed) return;
    }
  }

  /** Bytes received but not yet part of a complete frame. */
  get buffered(): number {
    return this.#buffered;
  }

  /** Parse one frame from the buffered bytes, or return null if incomplete. */
  #next(): WsFrame | null {
    if (this.#buffered < 2) return null;
    const head = this.#peek(Math.min(this.#buffered, 14));
    const b0 = head[0]!;
    const b1 = head[1]!;
    const fin = (b0 & 0x80) !== 0;
    const rsv = (b0 >> 4) & 0x7;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (head.length < 4) return null;
      length = head.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (head.length < 10) return null;
      const big = head.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new WsProtocolError("frame length overflow", 1009);
      length = Number(big);
      offset = 10;
    }
    if (!KNOWN_OPCODES.has(opcode)) throw new WsProtocolError(`reserved opcode 0x${opcode.toString(16)}`);
    if (opcode >= 0x8) {
      // RFC 6455 §5.5: control frames are never fragmented and carry ≤ 125 bytes.
      if (!fin) throw new WsProtocolError("fragmented control frame");
      if (length > 125) throw new WsProtocolError("control frame payload > 125 bytes");
    }
    if (length > this.maxPayload) throw new WsProtocolError(`frame payload ${length} > ${this.maxPayload}`, 1009);
    const maskBytes = masked ? 4 : 0;
    if (this.#buffered < offset + maskBytes + length) return null;

    const header = this.#take(offset + maskBytes);
    // #take returns a fresh copy when it has to join chunks; when it returns a
    // view into a received chunk we copy before unmasking in place.
    let payload = this.#take(length);
    if (masked) {
      payload = Buffer.from(payload);
      const key = header.subarray(offset, offset + 4);
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ key[i & 3]!;
    }
    return { fin, rsv, opcode, masked, payload };
  }

  /** The first `n` buffered bytes without consuming them. */
  #peek(n: number): Buffer {
    const first = this.#chunks[0]!;
    if (first.length >= n) return first.subarray(0, n);
    return Buffer.concat(this.#chunks, Math.min(this.#buffered, Math.max(n, 0))).subarray(0, n);
  }

  /** Consume and return the first `n` buffered bytes. */
  #take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    this.#buffered -= n;
    const first = this.#chunks[0]!;
    if (first.length > n) {
      this.#chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    if (first.length === n) {
      this.#chunks.shift();
      return first;
    }
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.#chunks[0]!;
      const want = n - filled;
      if (chunk.length <= want) {
        chunk.copy(out, filled);
        filled += chunk.length;
        this.#chunks.shift();
      } else {
        chunk.copy(out, filled, 0, want);
        this.#chunks[0] = chunk.subarray(want);
        filled += want;
      }
    }
    return out;
  }
}

/** A complete data message (text or binary), reassembled from its fragments. */
export interface WsMessage {
  opcode: typeof OPCODE.TEXT | typeof OPCODE.BINARY;
  payload: Buffer;
  /** Number of frames the message arrived in (1 = unfragmented). */
  frames: number;
}

/**
 * Joins data frames into messages (RFC 6455 §5.4). Feed it data frames only
 * (opcodes 0, 1, 2); control frames may arrive between fragments and are the
 * caller's business. Returns the message when `frame` completes one, else null.
 */
export class MessageAssembler {
  #opcode: number | null = null;
  #parts: Buffer[] = [];
  #size = 0;
  readonly maxMessage: number;

  constructor(maxMessage = 64 * 1024 * 1024) {
    this.maxMessage = maxMessage;
  }

  /** Opcode of the message being assembled (TEXT/BINARY), or null between messages. */
  get pendingOpcode(): number | null {
    return this.#opcode;
  }

  push(frame: WsFrame): WsMessage | null {
    if (frame.opcode === OPCODE.CONTINUATION) {
      if (this.#opcode === null) throw new WsProtocolError("continuation frame without a message");
    } else if (frame.opcode === OPCODE.TEXT || frame.opcode === OPCODE.BINARY) {
      if (this.#opcode !== null) throw new WsProtocolError("new data frame inside a fragmented message");
      this.#opcode = frame.opcode;
    } else {
      throw new Error(`MessageAssembler got control opcode ${frame.opcode}`);
    }
    this.#parts.push(frame.payload);
    this.#size += frame.payload.length;
    if (this.#size > this.maxMessage) throw new WsProtocolError(`message larger than ${this.maxMessage}`, 1009);
    if (!frame.fin) return null;
    const message: WsMessage = {
      opcode: this.#opcode as WsMessage["opcode"],
      payload: this.#parts.length === 1 ? this.#parts[0]! : Buffer.concat(this.#parts, this.#size),
      frames: this.#parts.length,
    };
    this.#opcode = null;
    this.#parts = [];
    this.#size = 0;
    return message;
  }
}

export interface EncodeOptions {
  /** true for client → server frames (RFC 6455 §5.3 requires masking there). */
  mask: boolean;
  /** false for all but the last fragment of a message (default true). */
  fin?: boolean;
  /** RSV bits (default 0); only meaningful with a negotiated extension. */
  rsv?: number;
}

/** Serialize one frame. Strings are sent as UTF-8. */
export function encodeFrame(opcode: number, payload: Buffer | string, options: EncodeOptions): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const length = data.length;
  const extended = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const maskBytes = options.mask ? 4 : 0;
  const out = Buffer.allocUnsafe(2 + extended + maskBytes + length);
  out[0] = ((options.fin ?? true) ? 0x80 : 0) | (((options.rsv ?? 0) & 0x7) << 4) | (opcode & 0x0f);
  const maskBit = options.mask ? 0x80 : 0;
  let offset = 2;
  if (extended === 0) {
    out[1] = maskBit | length;
  } else if (extended === 2) {
    out[1] = maskBit | 126;
    out.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    out[1] = maskBit | 127;
    out.writeBigUInt64BE(BigInt(length), 2);
    offset = 10;
  }
  if (options.mask) {
    const key = randomBytes(4);
    key.copy(out, offset);
    offset += 4;
    for (let i = 0; i < length; i++) out[offset + i] = data[i]! ^ key[i & 3]!;
  } else {
    data.copy(out, offset);
  }
  return out;
}

/** Sec-WebSocket-Accept for a Sec-WebSocket-Key (RFC 6455 §4.2.2). */
export function acceptKey(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/** A fresh Sec-WebSocket-Key for a client handshake. */
export function generateKey(): string {
  return randomBytes(16).toString("base64");
}

/** A Sec-WebSocket-Key is valid when it is base64 of exactly 16 bytes. */
export function isValidKey(key: string | undefined): boolean {
  if (key === undefined || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return false;
  return Buffer.from(key, "base64").length === 16;
}

/** Payload of a close frame: 2-byte status code plus an optional UTF-8 reason. */
export function encodeClosePayload(code?: number, reason = ""): Buffer {
  if (code === undefined) return Buffer.alloc(0);
  const text = Buffer.from(reason, "utf8").subarray(0, 123);
  const out = Buffer.allocUnsafe(2 + text.length);
  out.writeUInt16BE(code, 0);
  text.copy(out, 2);
  return out;
}

export interface ClosePayload {
  /** null when the frame carried no status code (reported as 1005 by browsers). */
  code: number | null;
  reason: string;
}

/** Parse a close frame payload; throws WsProtocolError on a malformed one. */
export function decodeClosePayload(payload: Buffer): ClosePayload {
  if (payload.length === 0) return { code: null, reason: "" };
  if (payload.length === 1) throw new WsProtocolError("close payload of 1 byte");
  const code = payload.readUInt16BE(0);
  if (!isValidCloseCode(code)) throw new WsProtocolError(`invalid close code ${code}`);
  return { code, reason: payload.subarray(2).toString("utf8") };
}

/** Close codes allowed on the wire (RFC 6455 §7.4). */
export function isValidCloseCode(code: number): boolean {
  if (code >= 3000 && code <= 4999) return true;
  return code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006;
}
