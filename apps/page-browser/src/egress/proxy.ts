// The operator's local proxy — Chrome's only way out (plan §4.5). HTTP
// CONNECT on 127.0.0.1:3128: the kernel lets Chrome's user reach this port
// and nothing else, and every tunnel goes on through the page's SOCKS5 with
// its password (Chrome cannot do that itself).
//
// - The exit closed: every CONNECT is refused (403, journaled), and closing
//   the exit cuts every open tunnel at once.
// - Local and private destinations are refused even with the exit open.
// - Tunnels to the API host pass through the send gate (gate.ts): a new one
//   only for the request just released, and every TLS record Chrome writes
//   into one is decided on its own.
// - Tunnels to the socket host carry the site's socket, as any browser's
//   would (variant Б, plan-b §4.1.9): a CONNECT opens at once, nothing waits
//   for the engine. The socket's path (ws/sockets.ts) hears of each tunnel:
//   its handshake request — the first big application-data record after the
//   TLS handshake (the second in TLS 1.3, whose client Finished is
//   application data too; the first if it rides early data) — and its end.
//   After the request, until the server answers, Chrome's records are the
//   request's; then every record Chrome writes is decided by the socket gate
//   (socket-gate.ts): only what a message of spec §2.6 or Chrome's own
//   control frame can be goes up. A record before the connection's
//   authorization that may be it under a token not observed yet is held
//   with what follows, decided again as the site's session is observed, and
//   at most `authHoldMs`: then that tunnel alone is cut. Anything else the
//   gate does not let up never goes: the tunnel is cut and the page stops.
//   A tunnel that is not TLS, or whose TLS the gate cannot measure, is cut
//   before its request goes.
// - Every other host the site loads goes through as a plain tunnel: Fansly's
//   page, static files and media, and third-party hosts as any browser's
//   would (owner decision №2); the hosts the map of operations closes are
//   refused (policy/operations.ts, spec §2.1). A third-party name is
//   resolved by the page's SOCKS5, not here: the refusal of local and
//   private destinations holds for the address in the request.
// - Each tunnel is one line of the connection journal: host, port, opened,
//   closed, bytes both ways, what was held, the result.
// - A tunnel the page's SOCKS5 failed is told to the operator with how, at
//   which step, its reply and the host's class (`onSocksFailure`): the
//   operator counts each and decides whether the page stops (a refusal of one
//   destination is that tunnel's alone; Chrome sees a failed tunnel).
//
// On this port the operator also serves the rules extension's package to
// Chrome's policy (extension-files.ts, PR 6): a direct request for one of
// its two files. Any other plain HTTP request — Chrome's proxied http:// —
// is refused: the page leaves only over TLS. Chrome's policy upgrades every
// http:// navigation to https (HttpsOnlyMode), and a plain subresource of
// an https page is Chrome's own mixed-content block (spec §2.1).

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { ApiGate, controlRecordLimit, readServerHello } from "./gate.ts";
import { refusedClass, type HostClass, type HostClassifier } from "./hosts.ts";
import { recordOverhead, SocketRecordGate, type SocketRules } from "./socket-gate.ts";
import { SocksError, socksConnect, type SocksConfig, type SocksFailure, type SocksStep } from "./socks5.ts";
import { isLocalAddress } from "../policy/operations.ts";
import { errorMessage, makeLog, monoMs, urlForLogLine, wallMs, type Logger } from "../shared/util.ts";

export interface TunnelRecord {
  id: number;
  host: string;
  port: number;
  cls: HostClass;
  openedMono: number;
  openedWall: number;
  closedMono: number | null;
  closedWall: number | null;
  /** Bytes Chrome → server that went up, server → Chrome that came down,
   *  and Chrome's bytes the gate held (never sent). */
  up: number;
  down: number;
  held: number;
  refused: boolean;
  result: string;
}

/** A tunnel the page's SOCKS5 failed: how, at which step of its exchange,
 *  its reply to the CONNECT (null: none), and the tunnel's host. */
export interface TunnelSocksFailure {
  kind: SocksFailure;
  step: SocksStep;
  rep: number | null;
  host: string;
  port: number;
  cls: HostClass;
}

/** What became of a socket's tunnel (ws/sockets.ts hears it). */
export type SocketTunnelEvent =
  | { kind: "open" }
  | { kind: "handshake_sent"; mono: number; wall: number }
  /** The socket gate holds a record that may be the authorization under a
   *  token not observed yet: the site's session is to be read again. */
  | { kind: "holding"; recordBytes: number; why: string }
  /** The socket gate did not let a record up (it never went); the tunnel is
   *  cut. `late`: one held for the authorization's size that did not come in
   *  time — not proven to be a forbidden message. */
  | { kind: "refused"; recordBytes: number; why: string; late: boolean }
  | { kind: "ended"; result: string; handshakeSent: boolean };

/** A tunnel of the site's socket, as its path takes it. */
export interface SocketTicket {
  /** The tunnel's id for the socket's path (cutSocket). */
  id: string;
  event: (event: SocketTunnelEvent) => void;
  /** What the socket gate needs to know when it decides a record. */
  rules: () => SocketRules;
}

export interface EgressOptions {
  classify: HostClassifier;
  /** A CONNECT to the socket host: its ticket, or why it is refused.
   *  Without it every such CONNECT is refused. */
  openSocket?: (host: string, port: number) => SocketTicket | string;
  /** A closed host the operator opens for a moment: Hub's own write to the
   *  upload API while it holds the page's slot (wall posts PR 7) — a plain
   *  tunnel then, journaled; refused at any other moment. Without it every
   *  closed host is refused. */
  admitsClosed?: (host: string) => boolean;
  /** How long the socket gate holds a record for the authorization's size
   *  (default SOCKET_AUTH_HOLD_MS). */
  authHoldMs?: number;
  gate?: ApiGate;
  /** Every refusal and every closed tunnel (the connection journal). */
  onRecord?: (record: TunnelRecord) => void;
  /** The page's SOCKS5 failed a tunnel (any way: the operator decides). */
  onSocksFailure?: (failure: TunnelSocksFailure, message: string) => void;
  /** Answers a plain request the proxy serves itself (the rules
   *  extension's package); false — it is refused. */
  serve?: (req: IncomingMessage, res: ServerResponse) => boolean;
  /** A tunnel holding more of Chrome's bytes than this is cut. */
  heldLimitBytes?: number;
  socksTimeoutMs?: number;
  log?: Logger;
}

const EMPTY = Buffer.alloc(0);
const RECENT_RECORDS = 1000;
/** A record that may be the socket's authorization waits this long at most
 *  for the site's session to be observed (plan-b §4.1.9: a few seconds). */
export const SOCKET_AUTH_HOLD_MS = 5_000;

interface SocketHold {
  /** The held record and everything Chrome wrote after it, in order. */
  data: Buffer[];
  bytes: number;
  recordBytes: number;
  why: string;
  timer: NodeJS.Timeout;
}

interface SocketTunnel {
  ticket: SocketTicket;
  /** Chrome's first record was a TLS handshake record. */
  tls: boolean;
  /** Big application-data records Chrome wrote before its request. */
  appRecords: number;
  handshakeSent: boolean;
  /** Before the request; the request's records (until the server answers);
   *  frames — every record through the gate. */
  phase: "handshake" | "request" | "frames";
  /** Measured from the server's hello. */
  gate: SocketRecordGate | null;
  /** A record held for the authorization's size, with what follows. */
  hold: SocketHold | null;
}

class Tunnel {
  readonly record: TunnelRecord;
  readonly client: Socket;
  upstream: Socket | null = null;
  /** Chrome's bytes before the tunnel was up. */
  early: Buffer[] = [];
  /** Chrome's bytes the gate holds: they never go up. */
  heldBytes = 0;
  /** What is left of the record in progress from Chrome (API tunnels). */
  recordLeft = 0;
  /** An incomplete record header (API tunnels). */
  partial: Buffer = EMPTY;
  /** The server chose TLS 1.3 (from its ServerHello); null = not seen yet. */
  tls13: boolean | null = null;
  /** The server's first bytes until its ServerHello is read; null after. */
  serverFirst: Buffer | null = EMPTY;
  /** A socket's tunnel: its admission and its handshake request. */
  socket: SocketTunnel | null = null;

  constructor(record: TunnelRecord, client: Socket) {
    this.record = record;
    this.client = client;
  }
}

export class Egress {
  readonly gate: ApiGate;
  readonly #options: EgressOptions;
  readonly #log: Logger;
  #server: Server | null = null;
  #socks: SocksConfig | null = null;
  #exitOpen = false;
  readonly #tunnels = new Set<Tunnel>();
  #nextId = 1;
  readonly #recent: TunnelRecord[] = [];

  constructor(options: EgressOptions) {
    this.#options = options;
    this.#log = options.log ?? makeLog("egress");
    this.gate = options.gate ?? new ApiGate();
    this.gate.cut = (reason) => this.cutClass("api", reason);
    this.gate.cutHeld = (reason) => this.#cutWhere((tunnel) => tunnel.record.cls === "api" && tunnel.heldBytes > 0, reason);
    this.gate.cutTunnel = (id, reason) => this.#cutWhere((tunnel) => tunnel.record.cls === "api" && tunnel.record.id === id, reason) > 0;
  }

  get exitOpen(): boolean {
    return this.#exitOpen;
  }

  get openTunnels(): number {
    return this.#tunnels.size;
  }

  /** The page's SOCKS5, from the engine's hello. Kept in memory only. */
  setSocks(socks: SocksConfig | null): void {
    this.#socks = socks;
  }

  get socks(): SocksConfig | null {
    return this.#socks;
  }

  openExit(): void {
    if (this.#socks === null) throw new Error("no SOCKS5 of the page yet");
    if (this.#exitOpen) return;
    this.#exitOpen = true;
    this.#log("exit.open");
  }

  /** Close the exit: refuse new tunnels and cut every open one at once. */
  closeExit(reason: string): number {
    const wasOpen = this.#exitOpen;
    this.#exitOpen = false;
    this.gate.reset();
    const cut = this.#cutWhere(() => true, `cut: exit closed (${reason})`);
    if (wasOpen || cut > 0) this.#log("exit.closed", { reason, cut });
    return cut;
  }

  /** Cut every tunnel of one host class. */
  cutClass(cls: HostClass, reason: string): number {
    return this.#cutWhere((tunnel) => tunnel.record.cls === cls, reason);
  }

  /** Cut the tunnel of one socket; returns whether it was there. */
  cutSocket(id: string, reason: string): boolean {
    return this.#cutWhere((tunnel) => tunnel.socket?.ticket.id === id, reason) > 0;
  }

  /** What the socket gate knows changed (the site's session was observed):
   *  every record held for the authorization's size is decided again. */
  socketRulesChanged(): void {
    for (const tunnel of [...this.#tunnels]) {
      const socket = tunnel.socket;
      const hold = socket?.hold ?? null;
      if (socket == null || hold === null) continue;
      // Its deadline stands: kept if it is held again, cleared once it goes.
      socket.hold = null;
      this.#onSocketData(tunnel, socket, Buffer.concat(hold.data), hold);
    }
  }

  /** Records held for the authorization's size now (tests, diagnostics). */
  get socketHolds(): number {
    let held = 0;
    for (const tunnel of this.#tunnels) if (tunnel.socket?.hold) held += 1;
    return held;
  }

  /** Refusals of CONNECTs to `host:port` since `sinceMono` (the self-test
   *  finds its probe's refusal here). */
  refusalsSince(host: string, port: number, sinceMono: number): TunnelRecord[] {
    return this.#recent.filter((record) => record.refused && record.host === host && record.port === port && record.openedMono >= sinceMono);
  }

  listen(port: number, host = "127.0.0.1"): Promise<number> {
    const server = createHttpServer((req, res) => {
      try {
        if (this.#options.serve?.(req, res)) return;
      } catch (error) {
        this.#log("plain.serve_failed", { error: errorMessage(error) });
      }
      this.#log("plain.refused", { method: req.method ?? "", url: (req.url ?? "").startsWith("/") ? (req.url ?? "").split(/[?#]/)[0] : urlForLogLine(req.url ?? "") });
      res.writeHead(403, { "content-length": "0", connection: "close" }).end();
    });
    server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => this.#onConnect(req, client, head));
    server.on("clientError", (_error, socket) => socket.destroy());
    this.#server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
    });
  }

  async close(): Promise<void> {
    this.closeExit("the operator stops");
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  #cutWhere(predicate: (tunnel: Tunnel) => boolean, reason: string): number {
    let cut = 0;
    for (const tunnel of [...this.#tunnels]) {
      if (!predicate(tunnel)) continue;
      cut += 1;
      this.#finish(tunnel, reason);
    }
    return cut;
  }

  #remember(record: TunnelRecord): void {
    this.#recent.push(record);
    if (this.#recent.length > RECENT_RECORDS) this.#recent.splice(0, this.#recent.length - RECENT_RECORDS);
    try {
      this.#options.onRecord?.(record);
    } catch (error) {
      this.#log("journal.failed", { error: errorMessage(error) });
    }
  }

  /** `endClient`: Chrome's side was already answered and ends by itself. */
  #finish(tunnel: Tunnel, result: string, endClient = false): void {
    if (!this.#tunnels.delete(tunnel)) return;
    const record = tunnel.record;
    record.closedMono = monoMs();
    record.closedWall = wallMs();
    record.held += tunnel.heldBytes + (tunnel.socket?.hold?.bytes ?? 0);
    record.result = result;
    if (!endClient) tunnel.client.destroy();
    tunnel.upstream?.destroy();
    this.#log("tunnel.closed", { id: record.id, host: record.host, port: record.port, cls: record.cls, up: record.up, down: record.down, held: record.held, result });
    this.#remember(record);
    this.#socketEnded(tunnel, result);
  }

  #socketEnded(tunnel: Tunnel, result: string): void {
    const socket = tunnel.socket;
    if (socket === null) return;
    if (socket.hold !== null) clearTimeout(socket.hold.timer);
    this.#tell(socket, { kind: "ended", result, handshakeSent: socket.handshakeSent });
  }

  /** The socket's path hears what became of its tunnel; whatever it does
   *  with it, the proxy goes on. */
  #tell(socket: SocketTunnel, event: SocketTunnelEvent): void {
    try {
      socket.ticket.event(event);
    } catch (error) {
      this.#log("socket.event_failed", { kind: event.kind, error: errorMessage(error) });
    }
  }

  #refuse(record: TunnelRecord, client: Socket, result: string): void {
    record.closedMono = monoMs();
    record.closedWall = wallMs();
    record.refused = true;
    record.result = result;
    this.#log("tunnel.refused", { id: record.id, host: record.host, port: record.port, cls: record.cls, result });
    this.#remember(record);
    client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  }

  // ── Chrome's bytes ────────────────────────────────────────────────────

  #hold(tunnel: Tunnel, bytes: Buffer): void {
    if (bytes.length === 0) return;
    tunnel.heldBytes += bytes.length;
    if (tunnel.heldBytes > (this.#options.heldLimitBytes ?? 4 * 1024 * 1024)) this.#finish(tunnel, "cut: held bytes over the limit");
  }

  #up(tunnel: Tunnel, bytes: Buffer): void {
    const upstream = tunnel.upstream;
    if (bytes.length === 0 || !upstream) return;
    tunnel.record.up += bytes.length;
    if (!upstream.write(bytes)) tunnel.client.pause();
    const socket = tunnel.socket;
    if (socket !== null && socket.phase === "request" && !socket.handshakeSent) {
      // Its request's bytes went up, not just its header through the gate.
      socket.handshakeSent = true;
      this.#tell(socket, { kind: "handshake_sent", mono: monoMs(), wall: wallMs() });
    }
  }

  #onClientData(tunnel: Tunnel, chunk: Buffer): void {
    if (!this.#tunnels.has(tunnel)) return;
    if (!tunnel.upstream) {
      tunnel.early.push(chunk);
      return;
    }
    if (tunnel.record.cls === "api") this.#onApiData(tunnel, chunk);
    else if (tunnel.socket !== null) this.#onSocketData(tunnel, tunnel.socket, chunk);
    else this.#up(tunnel, chunk);
  }

  /** Chrome's bytes on a socket's tunnel, decided record by record at
   *  their headers: before the request, the request itself; after it, the
   *  socket gate. A record held for the authorization's size keeps what
   *  follows behind it (`held`: the hold it is decided again for, its
   *  deadline kept). A record that is not let up never goes, nor anything
   *  after it: the tunnel is cut. */
  #onSocketData(tunnel: Tunnel, socket: SocketTunnel, chunk: Buffer, held: SocketHold | null = null): void {
    if (socket.hold !== null) {
      socket.hold.data.push(chunk);
      socket.hold.bytes += chunk.length;
      if (socket.hold.bytes > (this.#options.heldLimitBytes ?? 4 * 1024 * 1024)) this.#refuseHeld(tunnel, socket, "held bytes over the limit");
      return;
    }
    const data = tunnel.partial.length > 0 ? Buffer.concat([tunnel.partial, chunk]) : chunk;
    tunnel.partial = EMPTY;
    let offset = 0;
    while (offset < data.length) {
      if (tunnel.recordLeft > 0) {
        const take = Math.min(tunnel.recordLeft, data.length - offset);
        tunnel.recordLeft -= take;
        offset += take;
        continue;
      }
      if (data.length - offset < 5) {
        // The next record's header is not complete: decided with the next chunk.
        tunnel.partial = Buffer.from(data.subarray(offset));
        break;
      }
      const total = 5 + data.readUInt16BE(offset + 3);
      const stop = this.#socketRecord(tunnel, socket, data[offset]!, total);
      if (stop !== null && "hold" in stop) {
        // What was let up before it goes; it and what follows wait.
        this.#up(tunnel, data.subarray(0, offset));
        const rest = Buffer.from(data.subarray(offset));
        const first = held === null;
        const timer = held?.timer ?? setTimeout(() => this.#refuseHeld(tunnel, socket, `no session of the site it could be the authorization of within ${this.#options.authHoldMs ?? SOCKET_AUTH_HOLD_MS} ms`), this.#options.authHoldMs ?? SOCKET_AUTH_HOLD_MS);
        timer.unref();
        socket.hold = { data: [rest], bytes: rest.length, recordBytes: total, why: stop.hold, timer };
        if (first) {
          this.#log("socket.record_held", { id: tunnel.record.id, recordBytes: total, why: stop.hold });
          this.#tell(socket, { kind: "holding", recordBytes: total, why: stop.hold });
        }
        return;
      }
      if (held !== null) {
        // The held record goes on: its deadline is over.
        clearTimeout(held.timer);
        held = null;
      }
      if (stop !== null) {
        // What was let up before it goes; it and what follows never do.
        this.#up(tunnel, data.subarray(0, offset));
        this.#finish(tunnel, stop.cut);
        if (stop.refused) this.#tell(socket, { kind: "refused", ...stop.refused, late: false });
        return;
      }
      tunnel.recordLeft = total;
    }
    if (held !== null) clearTimeout(held.timer);
    this.#up(tunnel, data.subarray(0, offset));
  }

  /** A record held for the authorization's size that did not come in time:
   *  it and what follows never go, the tunnel is cut — this one alone. */
  #refuseHeld(tunnel: Tunnel, socket: SocketTunnel, why: string): void {
    const hold = socket.hold;
    if (hold === null || !this.#tunnels.has(tunnel)) return;
    clearTimeout(hold.timer);
    this.#finish(tunnel, `cut: the socket gate held a record of ${hold.recordBytes} bytes (${hold.why}): ${why}`);
    this.#tell(socket, { kind: "refused", recordBytes: hold.recordBytes, why: `${hold.why}: ${why}`, late: true });
  }

  /** One record of a socket's tunnel: null — it goes up; `hold` — it waits
   *  for the authorization's size (why); else why the tunnel is cut (and,
   *  for the socket gate, what it did not let up). */
  #socketRecord(tunnel: Tunnel, socket: SocketTunnel, type: number, total: number): { hold: string } | { cut: string; refused?: { recordBytes: number; why: string } } | null {
    if (!socket.tls) {
      if (type !== 22) return { cut: "cut: a socket's tunnel that is not TLS" };
      socket.tls = true;
    }
    switch (socket.phase) {
      case "handshake": {
        if (type !== 23 || total <= controlRecordLimit(tunnel.tls13)) return null;
        socket.appRecords += 1;
        // TLS 1.3: the client's Finished is application data too — unless
        // the request rides early data, before the server's hello.
        if (tunnel.tls13 === true && socket.appRecords < 2) return null;
        socket.phase = "request";
        return null;
      }
      case "request":
        // Chrome writes nothing of the socket before the server's answer.
        return null;
      case "frames": {
        let rules: SocketRules;
        try {
          rules = socket.ticket.rules();
        } catch {
          rules = { authorizationBytes: null };
        }
        const verdict = socket.gate === null ? { up: false as const, hold: false, why: "the tunnel's records cannot be measured" } : socket.gate.decide(type, total, rules);
        if (verdict.up) return null;
        if (verdict.hold) return { hold: verdict.why };
        // Cut first (the journal says why); the socket's path then decides
        // what else follows (ws/sockets.ts: an alarm, the page's stop once
        // the gate keeps refusing its records).
        return { cut: `cut: the socket gate held a record of ${total} bytes (${verdict.why})`, refused: { recordBytes: total, why: verdict.why } };
      }
    }
  }

  /** Chrome's bytes on an API tunnel: the gate decides record by record.
   *  Once a record is held, everything after it on the tunnel is held too,
   *  until the tunnel is cut; held bytes never go up. */
  #onApiData(tunnel: Tunnel, chunk: Buffer): void {
    if (tunnel.heldBytes > 0) {
      this.#hold(tunnel, chunk);
      return;
    }
    const id = tunnel.record.id;
    const data = tunnel.partial.length > 0 ? Buffer.concat([tunnel.partial, chunk]) : chunk;
    tunnel.partial = EMPTY;
    let offset = 0;
    let holdFrom = -1;
    while (offset < data.length) {
      if (tunnel.recordLeft > 0) {
        const take = Math.min(tunnel.recordLeft, data.length - offset);
        tunnel.recordLeft -= take;
        offset += take;
        if (tunnel.recordLeft === 0) this.gate.recordDone(id);
        continue;
      }
      if (data.length - offset < 5) {
        // The next record's header is not complete: decided with the next chunk.
        tunnel.partial = Buffer.from(data.subarray(offset));
        break;
      }
      const total = 5 + data.readUInt16BE(offset + 3);
      const big = total > controlRecordLimit(tunnel.tls13);
      const verdict = this.gate.record(id, big, data[offset] === 23, tunnel.tls13);
      if (verdict === "hold") {
        if (big) this.gate.noteHeld(id, total);
        holdFrom = offset;
        break;
      }
      tunnel.recordLeft = total;
    }
    this.#up(tunnel, data.subarray(0, holdFrom >= 0 ? holdFrom : offset));
    if (holdFrom >= 0) this.#hold(tunnel, data.subarray(holdFrom));
  }

  /** The TLS version of an API or socket tunnel decides the size of a
   *  control record, and on a socket's tunnel the cipher suite measures the
   *  records the socket gate decides; a handshake the proxy cannot read, or
   *  a socket's TLS the gate cannot measure, is not carried at all. */
  #serverHello(tunnel: Tunnel, chunk: Buffer): void {
    const seen = Buffer.concat([tunnel.serverFirst ?? EMPTY, chunk]);
    const hello = readServerHello(seen);
    if (hello === undefined) {
      tunnel.serverFirst = seen;
      return;
    }
    tunnel.serverFirst = null;
    if (hello === null) {
      this.#finish(tunnel, "cut: TLS handshake not understood");
      return;
    }
    tunnel.tls13 = hello.tls13;
    const socket = tunnel.socket;
    if (socket === null) return;
    const overhead = recordOverhead(hello.tls13, hello.cipherSuite);
    if (overhead === null) {
      this.#finish(tunnel, `cut: a TLS the socket gate cannot measure (${hello.tls13 ? "1.3" : "1.2"}, suite 0x${hello.cipherSuite.toString(16).padStart(4, "0")})`);
      return;
    }
    socket.gate = new SocketRecordGate(overhead);
  }

  // ── the proxy ───────────────────────────────────────────────────────────

  #onConnect(req: IncomingMessage, client: Socket, head: Buffer): void {
    client.on("error", () => undefined);
    const target = req.url ?? "";
    const colon = target.lastIndexOf(":");
    const host = (colon > 0 ? target.slice(0, colon) : target).replace(/^\[|\]$/g, "").toLowerCase();
    const port = Number(colon > 0 ? target.slice(colon + 1) : NaN);
    const local = localOrPrivate(host, port);
    const cls: HostClass = local ? "denied" : this.#options.classify(host);
    const record: TunnelRecord = {
      id: this.#nextId++,
      host,
      port: Number.isFinite(port) ? port : 0,
      cls,
      openedMono: monoMs(),
      openedWall: wallMs(),
      closedMono: null,
      closedWall: null,
      up: 0,
      down: 0,
      held: 0,
      refused: false,
      result: "",
    };
    const socks = this.#socks;
    if (!this.#exitOpen || socks === null) return this.#refuse(record, client, "refused: exit closed");
    // Local and private addresses are refused as the request names them — a
    // name or a literal (policy/operations.ts `LOCAL`). A name goes to the
    // page's SOCKS5 as it is and is resolved there (plan §4.5): what it
    // resolves to is not seen here, and need not be — a private address
    // behind the page's proxy is its provider's network, not Hub's, and this
    // container reaches nothing but that proxy (init-net; spec §2.1).
    if (local) return this.#refuse(record, client, "refused: local or private address");
    if (refusedClass(cls) && !(cls === "closed" && record.port === 443 && this.#options.admitsClosed?.(host) === true)) {
      return this.#refuse(record, client, cls === "closed" ? "refused: host closed by the map" : "refused: special-use name");
    }
    // Each tunnel of the socket host is the site's socket's: its records
    // are decided by the socket gate.
    let ticket: SocketTicket | null = null;
    if (cls === "ws") {
      let opened: SocketTicket | string;
      try {
        opened = this.#options.openSocket?.(host, record.port) ?? "no socket path";
      } catch (error) {
        opened = `the socket's path failed: ${errorMessage(error)}`;
      }
      if (typeof opened === "string") return this.#refuse(record, client, `refused: socket (${opened})`);
      ticket = opened;
    }
    if (cls === "api") {
      // A new connection to the API serves only the request just released.
      // Any other moment it is Chrome repeating a request on a new
      // connection, retrying one whose admission expired, or sending one it
      // released without us (a CDP detach).
      if (!this.gate.admitsTunnel()) return this.#refuse(record, client, `refused: gate ${this.gate.state.phase}`);
      this.gate.noteTunnel(record.id);
    }
    const tunnel = new Tunnel(record, client);
    if (ticket !== null) tunnel.socket = { ticket, tls: false, appRecords: 0, handshakeSent: false, phase: "handshake", gate: null, hold: null };
    this.#tunnels.add(tunnel);
    client.on("close", () => this.#finish(tunnel, tunnel.record.result || "closed by Chrome"));
    client.on("data", (chunk: Buffer) => this.#onClientData(tunnel, chunk));
    if (head.length > 0) this.#onClientData(tunnel, head);
    this.#connect(tunnel, socks);
  }

  #connect(tunnel: Tunnel, socks: SocksConfig): void {
    const record = tunnel.record;
    const { host, cls } = record;
    const client = tunnel.client;
    socksConnect(socks, host, record.port, this.#options.socksTimeoutMs)
      .then((upstream) => {
        if (!this.#tunnels.has(tunnel) || !this.#exitOpen) {
          upstream.destroy();
          return;
        }
        tunnel.upstream = upstream;
        upstream.on("data", (chunk: Buffer) => {
          tunnel.record.down += chunk.length;
          if (cls === "api" || cls === "ws") {
            if (tunnel.serverFirst !== null) this.#serverHello(tunnel, chunk);
            if (!this.#tunnels.has(tunnel)) return;
          }
          // What Chrome writes after the server speaks goes through the
          // frame gate. These bytes prove no answer to the request: TLS 1.3
          // may send a NewSessionTicket first; CDP tells the socket's status.
          if (tunnel.socket?.phase === "request") {
            tunnel.socket.phase = "frames";
          }
          // Before Chrome can react to them (a refusal it would repeat on).
          if (cls === "api") this.gate.noteServerBytes(tunnel.record.id);
          if (!client.write(chunk)) upstream.pause();
        });
        client.on("drain", () => upstream.resume());
        upstream.on("drain", () => client.resume());
        upstream.on("close", () => this.#finish(tunnel, tunnel.record.result || "closed by the server"));
        upstream.on("error", () => undefined);
        upstream.resume();
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        this.#log("tunnel.open", { id: record.id, host, port: record.port, cls });
        if (tunnel.socket !== null) this.#tell(tunnel.socket, { kind: "open" });
        for (const chunk of tunnel.early.splice(0)) this.#onClientData(tunnel, chunk);
      })
      .catch((error: unknown) => {
        if (!this.#tunnels.has(tunnel)) return;
        const failure: TunnelSocksFailure = error instanceof SocksError
          ? { kind: error.kind, step: error.step, rep: error.rep, host, port: record.port, cls }
          : { kind: "unavailable", step: "greeting", rep: null, host, port: record.port, cls };
        try {
          this.#options.onSocksFailure?.(failure, errorMessage(error));
        } catch (thrown) {
          this.#log("socks.failure_unheard", { error: errorMessage(thrown) });
        }
        // Chrome sees a failed tunnel; the tunnel's line says why.
        tunnel.client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        this.#finish(tunnel, `failed: ${errorMessage(error)}`, true);
      });
  }
}

/** Local and private destinations (plan §4.5): refused even with the exit
 *  open, and anything that is not a valid port. The addresses are the map's
 *  (policy/operations.ts `LOCAL`), the ones the rules extension blocks;
 *  special-use names are refused by their class ("denied"). */
export function localOrPrivate(host: string, port: number): boolean {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return true;
  return isLocalAddress(host);
}
