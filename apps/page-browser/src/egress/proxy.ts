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
// - Tunnels to the socket host carry one socket each, and each is admitted
//   by the engine (PR 10; ws/sockets.ts): the CONNECT waits for the
//   admission and is refused without one (stage 1, amendment 8). Admitted,
//   its handshake request — the first big application-data record after the
//   TLS handshake (the second in TLS 1.3, whose client Finished is
//   application data too; the first if it rides early data) — goes up only
//   before the admission's deadline; at the deadline, with the request not
//   sent, the tunnel is cut (spec §9). After the request, until the server
//   answers, Chrome's records are the request's; then every record Chrome
//   writes is decided by the socket gate (socket-gate.ts): only what a
//   message of spec §2.6 or Chrome's own control frame can be goes up —
//   anything else is held, the tunnel is cut and the page stops. A tunnel
//   that is not TLS, or whose TLS the gate cannot measure, is cut before its
//   request goes.
// - Every other host the site loads goes through as a plain tunnel: Fansly's
//   page, static files and media, and third-party hosts as any browser's
//   would (owner decision №2); the hosts the map of operations closes are
//   refused (policy/operations.ts, spec §2.1).
// - Each tunnel is one line of the connection journal: host, port, opened,
//   closed, bytes both ways, what was held, the result.
//
// On this port the operator also serves the rules extension's package to
// Chrome's policy (extension-files.ts, PR 6): a direct request for one of
// its two files. Any other plain HTTP request — Chrome's proxied http:// —
// is refused.

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { ApiGate, controlRecordLimit, readServerHello } from "./gate.ts";
import { refusedClass, type HostClass, type HostClassifier } from "./hosts.ts";
import { recordOverhead, SocketRecordGate, type SocketRules } from "./socket-gate.ts";
import { SocksError, socksConnect, type SocksConfig, type SocksFailure } from "./socks5.ts";
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

/** What became of a socket's tunnel (ws/sockets.ts hears it). */
export type SocketTunnelEvent =
  | { kind: "open" }
  | { kind: "handshake_sent"; mono: number; wall: number }
  /** The socket gate held a record (it never went up); the tunnel is cut. */
  | { kind: "refused"; recordBytes: number; why: string }
  | { kind: "ended"; result: string; handshakeSent: boolean };

/** A socket's CONNECT waiting for the engine's admission. */
export interface SocketTicket {
  /** The admission's connection id. */
  id: string;
  /** The admission's deadline (CLOCK_MONOTONIC ms) to let the CONNECT
   *  through, or null to refuse it. */
  granted: Promise<number | null>;
  event: (event: SocketTunnelEvent) => void;
  /** What the socket gate needs to know when it decides a record. */
  rules: () => SocketRules;
}

export interface EgressOptions {
  classify: HostClassifier;
  /** A CONNECT to the socket host: its admission (a ticket), or why it is
   *  refused now. Without it every such CONNECT is refused. */
  admitSocket?: (host: string, port: number) => SocketTicket | string;
  gate?: ApiGate;
  /** Every refusal and every closed tunnel (the connection journal). */
  onRecord?: (record: TunnelRecord) => void;
  /** The page's SOCKS5 failed us (not the destination). */
  onSocksFailure?: (kind: Exclude<SocksFailure, "refused">, message: string) => void;
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

interface SocketTunnel {
  ticket: SocketTicket;
  /** The admission's deadline; 0 while it waits for it. */
  deadline: number;
  timer: NodeJS.Timeout | null;
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

  /** Cut the tunnel of one socket's admission; returns whether it was there. */
  cutSocket(id: string, reason: string): boolean {
    return this.#cutWhere((tunnel) => tunnel.socket?.ticket.id === id, reason) > 0;
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
    record.held += tunnel.heldBytes;
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
    if (socket.timer) clearTimeout(socket.timer);
    socket.timer = null;
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

  /** A socket's CONNECT that waited, refused after all. */
  #refuseWaiting(tunnel: Tunnel, result: string): void {
    if (!this.#tunnels.delete(tunnel)) return;
    this.#refuse(tunnel.record, tunnel.client, result);
    this.#socketEnded(tunnel, result);
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
   *  their headers: before the request, the request itself only before the
   *  admission's deadline (Astra's review of the prototype, finding 6); after
   *  it, the socket gate. A record that is not let up never goes, nor
   *  anything after it: the tunnel is cut. */
  #onSocketData(tunnel: Tunnel, socket: SocketTunnel, chunk: Buffer): void {
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
      if (stop !== null) {
        // What was let up before it goes; it and what follows never do.
        this.#up(tunnel, data.subarray(0, offset));
        this.#finish(tunnel, stop.cut);
        if (stop.refused) this.#tell(socket, { kind: "refused", ...stop.refused });
        return;
      }
      tunnel.recordLeft = total;
    }
    this.#up(tunnel, data.subarray(0, offset));
  }

  /** One record of a socket's tunnel: null — it goes up; else why the
   *  tunnel is cut (and, for the socket gate, what it held). */
  #socketRecord(tunnel: Tunnel, socket: SocketTunnel, type: number, total: number): { cut: string; refused?: { recordBytes: number; why: string } } | null {
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
        if (!(monoMs() < socket.deadline)) return { cut: "cut: the socket's admission expired before its handshake request" };
        socket.handshakeSent = true;
        socket.phase = "request";
        if (socket.timer) clearTimeout(socket.timer);
        socket.timer = null;
        this.#tell(socket, { kind: "handshake_sent", mono: monoMs(), wall: wallMs() });
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
        const verdict = socket.gate === null ? { up: false as const, why: "the tunnel's records cannot be measured" } : socket.gate.decide(type, total, rules);
        if (verdict.up) return null;
        // Cut first (the journal says why), then the page stops.
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
    if (local) return this.#refuse(record, client, "refused: local or private address");
    if (refusedClass(cls)) return this.#refuse(record, client, cls === "closed" ? "refused: host closed by the map" : "refused: special-use name");
    // Each socket of the site is its own tunnel, admitted by the engine.
    let ticket: SocketTicket | null = null;
    if (cls === "ws") {
      let admission: SocketTicket | string;
      try {
        admission = this.#options.admitSocket?.(host, record.port) ?? "no admitting path";
      } catch (error) {
        admission = `the admission failed: ${errorMessage(error)}`;
      }
      if (typeof admission === "string") return this.#refuse(record, client, `refused: socket not admitted (${admission})`);
      ticket = admission;
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
    if (ticket !== null) tunnel.socket = { ticket, deadline: 0, timer: null, tls: false, appRecords: 0, handshakeSent: false, phase: "handshake", gate: null };
    this.#tunnels.add(tunnel);
    client.on("close", () => this.#finish(tunnel, tunnel.record.result || "closed by Chrome"));
    client.on("data", (chunk: Buffer) => this.#onClientData(tunnel, chunk));
    if (head.length > 0) this.#onClientData(tunnel, head);
    if (ticket === null) {
      this.#connect(tunnel, socks);
      return;
    }
    // The socket's CONNECT waits for the engine; closing the exit, or Chrome
    // dropping it, ends the wait (its end is reported in #finish).
    const socketTunnel = tunnel.socket!;
    ticket.granted.then(
      (deadline) => {
        if (!this.#tunnels.has(tunnel)) return;
        if (deadline === null) return this.#refuseWaiting(tunnel, "refused: socket not admitted");
        if (!(monoMs() < deadline)) return this.#refuseWaiting(tunnel, "refused: the socket's admission came expired");
        const now = this.#socks;
        if (!this.#exitOpen || now === null) return this.#refuseWaiting(tunnel, "refused: exit closed");
        socketTunnel.deadline = deadline;
        socketTunnel.timer = setTimeout(() => {
          if (!socketTunnel.handshakeSent) this.#finish(tunnel, "cut: the socket's admission expired before its handshake request");
        }, Math.max(0, deadline - monoMs()));
        socketTunnel.timer.unref();
        this.#connect(tunnel, now);
      },
      (error: unknown) => this.#refuseWaiting(tunnel, `refused: the socket's admission failed (${errorMessage(error)})`),
    );
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
        if (tunnel.socket !== null && !(monoMs() < tunnel.socket.deadline)) {
          upstream.destroy();
          this.#finish(tunnel, "cut: the socket's admission expired before its connection");
          return;
        }
        tunnel.upstream = upstream;
        upstream.on("data", (chunk: Buffer) => {
          tunnel.record.down += chunk.length;
          if (cls === "api" || cls === "ws") {
            if (tunnel.serverFirst !== null) this.#serverHello(tunnel, chunk);
            if (!this.#tunnels.has(tunnel)) return;
          }
          // The server answers the socket's request: what Chrome writes from
          // now on is frames.
          if (tunnel.socket?.phase === "request") tunnel.socket.phase = "frames";
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
        const failure = error instanceof SocksError ? error.kind : "unavailable";
        if (failure !== "refused") this.#options.onSocksFailure?.(failure, errorMessage(error));
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
