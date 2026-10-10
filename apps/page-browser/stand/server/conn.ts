// What the stand knows about one accepted TCP connection of the HTTP front.

import type net from "node:net";
import type tls from "node:tls";

export interface ConnInfo {
  connId: number;
  /** Local listener port: the TLS front (443) or plain HTTP (80). */
  port: number;
  tls: boolean;
  /** Peer "address:port". */
  remote: string;
  /** The SOCKS5 tunnel this connection came through, when it did. */
  socksId: number | null;
  openedMono: number;
  raw: net.Socket;
  tlsSocket: tls.TLSSocket | null;
  /** SNI from the ClientHello. */
  servername: string | null;
  /** Negotiated ALPN protocol ("h2", "http/1.1") or null. */
  alpn: string | null;
  proto: "h1" | "h2" | null;
  /** HTTP/1.1 requests or HTTP/2 streams seen on this connection so far. */
  requests: number;
  /** Highest client stream id seen on the HTTP/2 session. */
  maxStreamId: number;
  /** last-stream-id of the GOAWAY the server sent, if it sent one. */
  goawayLastStreamId: number | null;
  /** First socket/TLS error, reported with tcp.close. */
  error: string | null;
  closed: boolean;
}

/** "1.2.3.4" for "::ffff:1.2.3.4"; Docker hands out IPv4-mapped peers on dual-stack sockets. */
export function plainAddress(address: string | undefined): string {
  if (!address) return "?";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

/** "CODE: message" for socket errors, the message otherwise. */
export function errorText(err: unknown): string {
  const e = err as NodeJS.ErrnoException | undefined;
  return e?.code ? `${e.code}: ${e.message}` : String(e?.message ?? err);
}

export function isLoopback(address: string | undefined): boolean {
  const plain = plainAddress(address);
  return plain.startsWith("127.") || plain === "::1";
}

/** Kill the TCP connection with an RST: no response, no FIN, no TLS close_notify. */
export function resetConnection(conn: ConnInfo): void {
  if (conn.closed) return;
  if (conn.tlsSocket) {
    // The TLS socket owns the TCP handle. Flag the raw socket the way
    // net.Socket#resetAndDestroy() does, then destroy the TLS socket: its close
    // path destroys the raw socket, which resets (SO_LINGER 0) instead of closing.
    (conn.raw as unknown as { resetAndClosing: boolean }).resetAndClosing = true;
    conn.tlsSocket.destroy();
  } else {
    conn.raw.resetAndDestroy();
  }
}
