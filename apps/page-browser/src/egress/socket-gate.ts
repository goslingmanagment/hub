// The socket gate — spec §2.6's allow-list of outgoing socket messages held
// outside the page's JavaScript (mandatory condition №3; Astra's review of
// PR 10, P1). The guard in the page (inpage/ws-guard.js) is the first layer;
// it can fail to go into a context (a frame created at the bottom of an
// exhausted stack), and then that context's native send would send anything.
// So the proxy decides on every TLS record Chrome writes into a socket's
// tunnel after its handshake request, at the record's 5-byte header — as the
// send gate does for the API (gate.ts) — and lets up only what a message of
// spec §2.6 or Chrome's own control frame can be. Anything else is held, the
// tunnel is cut and the page stops (`unknown_ws_message`): fail closed.
//
// The sizes. Chrome writes each WebSocket frame — or a batch of them — with
// one write, and BoringSSL makes a TLS record of it (WebSocketBasicStream::
// WriteFrames concatenates what it is given; WebSocketChannel batches the
// frames that wait behind a write in flight; Chrome 155). A message of up to
// 64 KiB is one frame (network::WebSocket, kSmallMessageThreshold). A
// client's frame (RFC 6455 §5.2) is 2 bytes, 2 more when the payload is over
// 125 bytes (8 over 65 535), the 4-byte mask, the payload; no extension
// (permessage-deflate would change the sizes: then every message is held).
// The record adds its 5-byte header and the cipher's expansion: TLS 1.3 —
// the inner content type and a 16-byte tag (22 in all); TLS 1.2 AES-GCM —
// an 8-byte explicit nonce and the tag (29); TLS 1.2 ChaCha20-Poly1305 — the
// tag (21). Anything else (a CBC suite: a MAC and padding) cannot be
// measured: such a tunnel is cut before its handshake request goes.
//
// What goes up:
// - a record of any type but application data that cannot carry it: an
//   alert (close_notify), a ChangeCipherSpec; and an application-data
//   record too small for any frame (a TLS 1.3 alert or KeyUpdate inside);
// - the ping "p" — exactly its frame's size (7 bytes), any number of times;
// - an empty control frame (6) — Chrome's pong to an empty ping, the close
//   of `close()` without a code — and a close with its code only (8) —
//   Chrome's 1001 when the page goes (network::WebSocket::~WebSocket);
// - the authorization, once a connection: exactly the size of
//   {"t":1,"d":"{\"token\":\"<the live token>\",\"v\":3}"} with the token the
//   site's own API requests carry (hub-requests/session.ts). No live session
//   — no authorization goes (a socket is not even admitted without one,
//   ws/sockets.ts).
// Everything else is held: a message of another size, a second
// authorization, a coalesced record (two frames in one write), a pong that
// echoes a non-empty ping, a close with a reason (the page's own, or Chrome's
// echo of the server's — RespondToClosingHandshake sends the reason back),
// a fragmented or compressed message.
//
// What stays open (the residual): a forbidden message of exactly one of
// those sizes passes this gate — a payload of 0, 1 or 2 bytes (no Fansly
// command is that short: the shortest is `{"t":N}`), or, once a connection,
// one of exactly the authorization's size. It is still a message the guard
// in the page did not stop, and CDP's word on what left
// (Network.webSocketFrameSent) stops the page after it. The other cost is
// availability: if Fansly's server pings with a payload, closes with a
// reason, or negotiates compression, the page stops on it — the test account
// shows which (the stand cannot).

/** The bytes of a client's (masked) WebSocket frame of this payload. */
export function clientFrameBytes(payloadBytes: number): number {
  const extended = payloadBytes <= 125 ? 0 : payloadBytes <= 0xffff ? 2 : 8;
  return 2 + extended + 4 + payloadBytes;
}

const TLS13_SUITES = new Set([0x1301, 0x1302, 0x1303]);
const TLS12_GCM_SUITES = new Set([0x009c, 0x009d, 0x009e, 0x009f, 0xc02b, 0xc02c, 0xc02f, 0xc030]);
const TLS12_CHACHA_SUITES = new Set([0xcca8, 0xcca9, 0xccaa]);

/** What a TLS record adds to what it carries, by the version and cipher
 *  suite the server chose; null: a suite the gate cannot measure. */
export function recordOverhead(tls13: boolean, cipherSuite: number): number | null {
  if (tls13) return TLS13_SUITES.has(cipherSuite) ? 5 + 1 + 16 : null;
  if (TLS12_GCM_SUITES.has(cipherSuite)) return 5 + 8 + 16;
  if (TLS12_CHACHA_SUITES.has(cipherSuite)) return 5 + 16;
  return null;
}

/** The authorization's payload for a token: as the site and Hub's own
 *  socket build it (apps/runtime/src/services/fansly-ws/connection.ts). */
export function authorizationBytes(token: string): number {
  return Buffer.byteLength(JSON.stringify({ t: 1, d: JSON.stringify({ token, v: 3 }) }));
}

/** What the socket's path knows when a record is decided. */
export interface SocketRules {
  /** The authorization's payload bytes for the live session; null: none. */
  authorizationBytes: number | null;
}

export type SocketRecord = "tls" | "ping" | "empty_control" | "close_code" | "authorization";

export type SocketVerdict = { up: true; record: SocketRecord } | { up: false; why: string };

export class SocketRecordGate {
  /** The record's overhead on this tunnel (recordOverhead). */
  readonly overhead: number;
  #authorized = false;

  constructor(overhead: number) {
    this.overhead = overhead;
  }

  /** One record Chrome writes after its handshake request, by its header:
   *  its content type and its whole size. */
  decide(type: number, size: number, rules: SocketRules): SocketVerdict {
    if (type === 20 || type === 21) return { up: true, record: "tls" };
    if (type !== 23) return { up: false, why: `a TLS record of type ${type} after the handshake` };
    const frame = size - this.overhead;
    if (frame < clientFrameBytes(0)) return { up: true, record: "tls" };
    if (frame === clientFrameBytes(1)) return { up: true, record: "ping" };
    if (frame === clientFrameBytes(0)) return { up: true, record: "empty_control" };
    if (frame === clientFrameBytes(2)) return { up: true, record: "close_code" };
    if (rules.authorizationBytes !== null && frame === clientFrameBytes(rules.authorizationBytes)) {
      if (this.#authorized) return { up: false, why: "a second authorization-sized message on the connection" };
      this.#authorized = true;
      return { up: true, record: "authorization" };
    }
    return { up: false, why: rules.authorizationBytes === null ? "a message that is not the ping, and no live session to authorize" : "a message of no allowed size" };
  }
}
