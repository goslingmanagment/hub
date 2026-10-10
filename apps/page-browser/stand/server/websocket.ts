// Server side of the stand's WebSockets (ws.stand.test), the same for an
// HTTP/1.1 Upgrade (bytes on the TCP/TLS socket) and an HTTP/2 extended
// CONNECT (bytes in DATA frames of one stream): both arrive here as a Duplex.
//
// Behaviour: text messages are echoed back prefixed with "echo:", binary
// messages are echoed unchanged, pings are answered with pongs; the control
// API can push text frames and start a close. Every frame in either direction
// is journaled (`ws.frame` from the client, `ws.send` from the server).

import { isUtf8 } from "node:buffer";
import type { Duplex } from "node:stream";
import type { Journal } from "./journal.ts";
import {
  FrameParser,
  MessageAssembler,
  OPCODE,
  WsProtocolError,
  decodeClosePayload,
  encodeClosePayload,
  encodeFrame,
} from "./ws-codec.ts";
import type { WsFrame } from "./ws-codec.ts";

/** Journaled payloads are cut to this many characters. */
const LOG_CHARS = 2000;
const MAX_MESSAGE = 16 * 1024 * 1024;
/** How long to wait for the peer's close frame / end of stream before dropping the transport. */
const CLOSE_TIMEOUT_MS = 2000;

export interface WsInfo {
  wsId: string;
  connId: number;
  proto: "h1" | "h2";
  streamId: number | null;
  path: string;
  rid: string | null;
  /** Negotiated Sec-WebSocket-Protocol, if any. */
  protocol: string | null;
}

export class WsSession {
  readonly info: WsInfo;
  readonly openedMono: number;
  #duplex: Duplex;
  #journal: Journal;
  #onGone: () => void;
  #parser = new FrameParser({ maxPayload: MAX_MESSAGE });
  #assembler = new MessageAssembler(MAX_MESSAGE);
  /** Who sent the first close frame, and its code. */
  #closeBy: "client" | "server" | null = null;
  #closeCode: number | null = null;
  #closeSent = false;
  #closeReceived = false;
  #gone = false;
  #timer: NodeJS.Timeout | null = null;
  framesIn = 0;
  framesOut = 0;

  constructor(duplex: Duplex, head: Buffer, info: WsInfo, journal: Journal, openedMono: number, onGone: () => void) {
    this.#duplex = duplex;
    this.info = info;
    this.#journal = journal;
    this.openedMono = openedMono;
    this.#onGone = onGone;

    this.#parser.on("frame", (frame: WsFrame) => this.#onFrame(frame));
    this.#parser.on("error", (err: Error) => this.#fail(err));
    duplex.on("data", (chunk: Buffer) => this.#parser.push(chunk));
    // A peer that ends its side without a close frame: finish ours as well.
    duplex.on("end", () => {
      if (!this.#gone) duplex.end();
    });
    duplex.on("error", () => {});
    duplex.on("close", () => this.#onTransportClosed());
    if (head.length > 0) this.#parser.push(head);
  }

  get open(): boolean {
    return !this.#gone && !this.#closeSent && !this.#closeReceived;
  }

  /** Send a text frame (control API push). Returns false when the session is closing. */
  pushText(text: string): boolean {
    return this.#send(OPCODE.TEXT, Buffer.from(text, "utf8"));
  }

  /** Start a server-initiated close (control API). */
  close(code = 1000, reason = ""): boolean {
    if (!this.open) return false;
    this.#closeBy = "server";
    this.#closeCode = code;
    this.#sendClose(code, reason);
    this.#armTimer();
    return true;
  }

  #onFrame(frame: WsFrame): void {
    this.framesIn += 1;
    const opcode = frame.opcode;
    const dataOpcode = opcode === OPCODE.CONTINUATION ? this.#assembler.pendingOpcode : opcode;
    const event: Record<string, unknown> = {
      wsId: this.info.wsId,
      opcode,
      fin: frame.fin,
      len: frame.payload.length,
      ...describePayload(frame.payload, dataOpcode === OPCODE.TEXT),
    };
    let close: { code: number | null; reason: string } | null = null;
    if (opcode === OPCODE.CLOSE) {
      try {
        close = decodeClosePayload(frame.payload);
        event.code = close.code;
        event.reason = close.reason;
      } catch {
        // Logged below as a protocol error.
      }
    }
    this.#journal.log("ws.frame", event);

    if (this.#closeReceived) return; // nothing is valid after a close frame
    if (!frame.masked) return this.#fail(new WsProtocolError("unmasked client frame"));
    if (frame.rsv !== 0) return this.#fail(new WsProtocolError("RSV bits set without an extension"));

    switch (opcode) {
      case OPCODE.PING:
        this.#send(OPCODE.PONG, frame.payload);
        return;
      case OPCODE.PONG:
        return;
      case OPCODE.CLOSE: {
        if (close === null) return this.#fail(new WsProtocolError("malformed close frame"));
        this.#closeReceived = true;
        if (!this.#closeSent) {
          // Client-initiated: answer with the same code, then end our side.
          this.#closeBy = "client";
          this.#closeCode = close.code ?? 1005;
          this.#sendClose(close.code ?? undefined, "");
        }
        // The close handshake is complete in both cases: the server ends the transport.
        this.#duplex.end();
        this.#armTimer();
        return;
      }
      default: {
        if (this.#closeSent) return; // closing: data is ignored
        let message;
        try {
          message = this.#assembler.push(frame);
        } catch (err) {
          return this.#fail(err as Error);
        }
        if (message === null) return;
        if (message.opcode === OPCODE.TEXT) {
          if (!isUtf8(message.payload)) return this.#fail(new WsProtocolError("invalid UTF-8 in a text message", 1007));
          this.#send(OPCODE.TEXT, Buffer.concat([Buffer.from("echo:"), message.payload]));
        } else {
          this.#send(OPCODE.BINARY, message.payload);
        }
      }
    }
  }

  #send(opcode: number, payload: Buffer): boolean {
    if (this.#gone || this.#closeSent || this.#duplex.writableEnded || this.#duplex.destroyed) return false;
    this.framesOut += 1;
    this.#journal.log("ws.send", {
      wsId: this.info.wsId,
      opcode,
      len: payload.length,
      ...describePayload(payload, opcode === OPCODE.TEXT),
    });
    this.#duplex.write(encodeFrame(opcode, payload, { mask: false }));
    return true;
  }

  #sendClose(code: number | undefined, reason: string): void {
    const payload = encodeClosePayload(code, reason);
    this.#send(OPCODE.CLOSE, payload);
    this.#closeSent = true;
  }

  /** Protocol error: close with its code, then drop the transport. */
  #fail(err: Error): void {
    const code = err instanceof WsProtocolError ? err.closeCode : 1011;
    this.#journal.log("ws.error", { wsId: this.info.wsId, error: err.message, code });
    if (!this.#closeSent) {
      this.#closeBy = "server";
      this.#closeCode = code;
      this.#sendClose(code, err.message.slice(0, 100));
    }
    this.#closeReceived = true;
    this.#duplex.end();
    this.#armTimer();
  }

  /** Drop the transport if the peer does not finish the close in time. */
  #armTimer(): void {
    if (this.#timer || this.#gone) return;
    this.#timer = setTimeout(() => this.#duplex.destroy(), CLOSE_TIMEOUT_MS);
    this.#timer.unref();
  }

  #onTransportClosed(): void {
    if (this.#gone) return;
    this.#gone = true;
    if (this.#timer) clearTimeout(this.#timer);
    // No close frame either way → "reset" with the local code 1006 (abnormal closure).
    this.#journal.log("ws.close", {
      wsId: this.info.wsId,
      code: this.#closeBy === null ? 1006 : this.#closeCode,
      by: this.#closeBy ?? "reset",
      framesIn: this.framesIn,
      framesOut: this.framesOut,
    });
    this.#onGone();
  }
}

/** Open WebSockets by wsId, for the control API. */
export class WsRegistry {
  #sessions = new Map<string, WsSession>();
  #nextId = 1;
  #journal: Journal;

  constructor(journal: Journal) {
    this.#journal = journal;
  }

  nextId(): string {
    return `ws${this.#nextId++}`;
  }

  /** Start serving a WebSocket over `duplex`; journals `ws.open`. */
  open(duplex: Duplex, head: Buffer, info: WsInfo): WsSession {
    const event = this.#journal.log("ws.open", { ...info });
    const session = new WsSession(duplex, head, info, this.#journal, event.mono, () => this.#sessions.delete(info.wsId));
    this.#sessions.set(info.wsId, session);
    return session;
  }

  /** Sessions addressed by `wsId` (all open ones when omitted). */
  select(wsId: string | undefined): WsSession[] {
    if (wsId === undefined) return [...this.#sessions.values()];
    const one = this.#sessions.get(wsId);
    return one ? [one] : [];
  }

  list(): Array<WsInfo & { open: boolean; framesIn: number; framesOut: number; openedMono: number }> {
    return [...this.#sessions.values()].map((s) => ({
      ...s.info,
      open: s.open,
      framesIn: s.framesIn,
      framesOut: s.framesOut,
      openedMono: s.openedMono,
    }));
  }
}

/** Journal form of a payload: UTF-8 text for text frames, base64 otherwise. */
function describePayload(payload: Buffer, isText: boolean): { enc: "utf8" | "base64"; text: string; truncated: boolean } {
  if (isText) {
    const text = payload.toString("utf8");
    return { enc: "utf8", text: text.slice(0, LOG_CHARS), truncated: text.length > LOG_CHARS };
  }
  const b64 = payload.toString("base64");
  return { enc: "base64", text: b64.slice(0, LOG_CHARS), truncated: b64.length > LOG_CHARS };
}
