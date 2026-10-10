// The operator's local proxy — Chrome's only way out (plan §4.5). HTTP
// CONNECT on 127.0.0.1:3128; every tunnel goes through the page's SOCKS5 with
// its password (Chrome cannot do that itself). Closed exit = every CONNECT is
// refused and every open tunnel is cut at once.
//
// PROTOTYPE CANDIDATE — the API send gate (plan §4.1 "рубеж отправки", §4.2
// step 4, owner decisions №10 and №16). The proxy cannot see requests inside
// TLS, but on the API host only one admitted request is ever in flight and
// every other request waits in Chrome's Fetch interception. So the bytes
// Chrome writes into API tunnels are forwarded only inside the window of the
// admission that is in flight:
//   closed      — no admission: bytes are held (not forwarded);
//   open        — an admitted request was released: forward until its
//                 deadline (CLOCK_MONOTONIC); after it, bytes are held and the
//                 tunnels that hold them are cut (the request never leaves);
//   sent        — Chrome reported the request's headers as sent: hold again.
//                 Chrome's network stack repeats a request on its own after
//                 REFUSED_STREAM, GOAWAY, a reset or a 408, and CDP does not
//                 report the repeat (stand finding): its bytes are held here,
//                 a new API tunnel is refused (a repeat on a new connection),
//                 and without response headers in 20 s the tunnels are cut;
//   responding  — its response headers arrived (no retry can follow): forward
//                 the held bytes (flow control, acks) and what follows;
//   closed      — the request finished.
// Bytes held while closed are the TLS/HTTP2 housekeeping of idle connections,
// or requests Chrome released without us (a CDP detach) — on a CDP loss the
// operator cuts every tunnel, so those never leave. The stand measures what
// this gate does and does not cover.

import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { connect as tcpConnect, isIP, type Socket } from "node:net";

import { makeLog, monoMs } from "../shared/util.ts";

const log = makeLog("egress");

export type HostClass = "site" | "api" | "ws" | "cdn" | "denied";

export interface SocksConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export type GateState = "closed" | "open" | "sent" | "responding";

export interface TunnelRecord {
  id: number;
  host: string;
  port: number;
  cls: HostClass;
  openedMono: number;
  closedMono: number | null;
  up: number;
  down: number;
  held: number;
  result: string;
}

const HELD_LIMIT = 4 * 1024 * 1024;
/** Plan §4.14: a Hub request's limit (REQUEST_TIMEOUT_MS of the engine). */
const SENT_TIMEOUT_MS = 20_000;

class Tunnel {
  readonly rec: TunnelRecord;
  readonly client: Socket;
  upstream: Socket | null = null;
  held: Buffer[] = [];
  heldBytes = 0;
  /** Bytes forwarded up while the current admission's window was open. */
  forwardedInWindow = 0;
  constructor(rec: TunnelRecord, client: Socket) {
    this.rec = rec;
    this.client = client;
  }
}

export class Egress {
  readonly socks: SocksConfig;
  readonly classify: (host: string) => HostClass;
  /** Admission of a new socket connection (ws host): resolves true to let
   *  the CONNECT through. */
  admitWsTunnel: (host: string) => Promise<boolean> = async () => false;
  /** Called when the gate cut tunnels on its own (expiry, retry). */
  onGateEvent: (event: { kind: string; admissionId: string | null; tunnels: number; forwardedInWindow: number }) => void = () => undefined;

  /** The API send gate (prototype candidate); off = plain forwarding, to
   *  measure what the gate changes. */
  gateEnabled = process.env.PB_GATE !== "0";
  #exitOpen = false;
  #tunnels = new Set<Tunnel>();
  #nextId = 1;
  #journal: TunnelRecord[] = [];
  #gate: GateState = "closed";
  #gateAdmission: string | null = null;
  #gateDeadline = 0;
  #deadlineTimer: NodeJS.Timeout | null = null;
  #sentTimer: NodeJS.Timeout | null = null;

  constructor(socks: SocksConfig, classify: (host: string) => HostClass) {
    this.socks = socks;
    this.classify = classify;
  }

  get exitOpen(): boolean {
    return this.#exitOpen;
  }

  get gateState(): { state: GateState; admissionId: string | null; deadline: number } {
    return { state: this.#gate, admissionId: this.#gateAdmission, deadline: this.#gateDeadline };
  }

  journal(): TunnelRecord[] {
    return this.#journal;
  }

  openExit(): void {
    this.#exitOpen = true;
    log("exit.open");
  }

  /** Close the exit: refuse new tunnels and cut every open one at once. */
  closeExit(reason: string): void {
    const wasOpen = this.#exitOpen;
    this.#exitOpen = false;
    const cut = this.#cutWhere(() => true, `exit closed: ${reason}`);
    this.#setGate("closed", null, 0);
    log("exit.closed", { reason, wasOpen, cut });
  }

  // ── the API send gate ──────────────────────────────────────────────────

  gateOpen(admissionId: string, deadlineMono: number): void {
    this.#setGate("open", admissionId, deadlineMono);
    for (const tunnel of this.#apiTunnels()) {
      tunnel.forwardedInWindow = 0;
      this.#flush(tunnel);
    }
    const ms = deadlineMono - monoMs();
    this.#deadlineTimer = setTimeout(() => this.#onDeadline(admissionId), Math.max(0, ms));
  }

  /** Chrome reported the admitted request's headers as sent. Returns false
   *  when this was a second send of the same request (a retry): every API
   *  tunnel is cut before the retry's bytes leave. */
  gateSent(admissionId: string): boolean {
    if (this.#gateAdmission !== admissionId) return true;
    if (this.#gate === "open") {
      this.#setGate("sent", admissionId, this.#gateDeadline);
      if (this.gateEnabled) {
        this.#sentTimer = setTimeout(() => {
          this.#sentTimer = null;
          if (this.#gate !== "sent" || this.#gateAdmission !== admissionId) return;
          const cut = this.#cutWhere((tunnel) => tunnel.rec.cls === "api", "gate: no response 20 s after the send");
          this.onGateEvent({ kind: "sent_timeout", admissionId, tunnels: cut, forwardedInWindow: 0 });
        }, SENT_TIMEOUT_MS);
      }
      return true;
    }
    if (this.gateEnabled && (this.#gate === "sent" || this.#gate === "responding")) {
      const cut = this.#cutWhere((tunnel) => tunnel.rec.cls === "api", "gate: second send of one admission (retry)");
      this.onGateEvent({ kind: "retry_cut", admissionId, tunnels: cut, forwardedInWindow: 0 });
      return false;
    }
    return true;
  }

  gateResponding(admissionId: string): void {
    if (this.#gateAdmission !== admissionId) return;
    if (this.#gate === "sent" || this.#gate === "open") {
      this.#setGate("responding", admissionId, this.#gateDeadline);
      for (const tunnel of this.#apiTunnels()) this.#flush(tunnel);
    }
  }

  gateClose(admissionId: string): void {
    if (this.#gateAdmission !== admissionId) return;
    this.#setGate("closed", null, 0);
  }

  /** Cut every API tunnel (stand: force the next request onto a new one). */
  cutApi(reason: string): number {
    return this.#cutWhere((tunnel) => tunnel.rec.cls === "api", reason);
  }

  #setGate(state: GateState, admissionId: string | null, deadline: number): void {
    if (this.#deadlineTimer && state !== "open") {
      clearTimeout(this.#deadlineTimer);
      this.#deadlineTimer = null;
    }
    if (this.#sentTimer && state !== "sent") {
      clearTimeout(this.#sentTimer);
      this.#sentTimer = null;
    }
    this.#gate = state;
    this.#gateAdmission = admissionId;
    this.#gateDeadline = deadline;
  }

  #onDeadline(admissionId: string): void {
    this.#deadlineTimer = null;
    if (!this.gateEnabled) return;
    if (this.#gate !== "open" || this.#gateAdmission !== admissionId) return;
    // The deadline passed and Chrome has not reported the request as sent.
    // From now on nothing of it may leave: hold, and cut the API tunnels that
    // are holding bytes or still connecting.
    let forwarded = 0;
    for (const tunnel of this.#apiTunnels()) forwarded += tunnel.forwardedInWindow;
    // Every API tunnel goes: one may still be finishing a handshake the
    // request would follow on.
    const cut = this.#cutWhere((tunnel) => tunnel.rec.cls === "api", "gate: admission expired before send");
    this.#setGate("closed", null, 0);
    this.onGateEvent({ kind: "expired", admissionId, tunnels: cut, forwardedInWindow: forwarded });
  }

  #gateForwards(): boolean {
    if (!this.gateEnabled) return true;
    if (this.#gate === "responding") return true;
    return this.#gate === "open" && monoMs() < this.#gateDeadline;
  }

  #apiTunnels(): Tunnel[] {
    return [...this.#tunnels].filter((tunnel) => tunnel.rec.cls === "api");
  }

  #flush(tunnel: Tunnel): void {
    if (!tunnel.upstream || tunnel.held.length === 0) return;
    const bytes = Buffer.concat(tunnel.held);
    tunnel.held = [];
    tunnel.heldBytes = 0;
    tunnel.rec.up += bytes.length;
    tunnel.forwardedInWindow += bytes.length;
    tunnel.upstream.write(bytes);
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

  #finish(tunnel: Tunnel, result: string): void {
    if (!this.#tunnels.delete(tunnel)) return;
    tunnel.rec.closedMono = monoMs();
    tunnel.rec.held += tunnel.heldBytes;
    tunnel.rec.result = result;
    tunnel.client.destroy();
    tunnel.upstream?.destroy();
    this.#journal.push(tunnel.rec);
    if (this.#journal.length > 5000) this.#journal.splice(0, 1000);
    log("tunnel.closed", { ...tunnel.rec });
  }

  // ── the proxy ──────────────────────────────────────────────────────────

  listen(port: number): Promise<void> {
    const server = createHttpServer((req, res) => {
      // Plain-HTTP proxying is never needed: the site is HTTPS-only.
      log("plain.refused", { url: req.url });
      res.writeHead(403).end();
    });
    server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => this.#onConnect(req, client, head));
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  }

  #onConnect(req: IncomingMessage, client: Socket, head: Buffer): void {
    const target = req.url ?? "";
    const colon = target.lastIndexOf(":");
    const host = target.slice(0, colon).replace(/^\[|\]$/g, "").toLowerCase();
    const port = Number(target.slice(colon + 1));
    const cls = this.#refusal(host, port) ? "denied" : this.classify(host);
    const rec: TunnelRecord = { id: this.#nextId++, host, port, cls, openedMono: monoMs(), closedMono: null, up: 0, down: 0, held: 0, result: "" };
    const tunnel = new Tunnel(rec, client);
    client.on("error", () => undefined);
    if (cls === "api" && this.gateEnabled && this.#exitOpen && !(this.#gate === "open" && monoMs() < this.#gateDeadline)) {
      // A new connection to the API serves only the admitted request just
      // released. Any other moment it is Chrome repeating a request on a new
      // connection, retrying one whose admission expired, or sending one it
      // released without us (a CDP detach).
      rec.closedMono = rec.openedMono;
      rec.result = `refused: gate ${this.#gate}`;
      this.#journal.push(rec);
      log("tunnel.refused", { ...rec });
      this.onGateEvent({ kind: "repeat_tunnel_refused", admissionId: this.#gateAdmission, tunnels: 1, forwardedInWindow: 0 });
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (!this.#exitOpen || cls === "denied") {
      rec.closedMono = rec.openedMono;
      rec.result = this.#exitOpen ? "refused: host" : "refused: exit closed";
      this.#journal.push(rec);
      log("tunnel.refused", { ...rec });
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    this.#tunnels.add(tunnel);
    client.on("close", () => this.#finish(tunnel, tunnel.rec.result || "client closed"));
    // Bytes from Chrome: the gate decides for API tunnels.
    const onClientData = (chunk: Buffer) => {
      if (!this.#tunnels.has(tunnel)) return;
      if (tunnel.rec.cls === "api" && (!this.#gateForwards() || !tunnel.upstream)) {
        tunnel.held.push(chunk);
        tunnel.heldBytes += chunk.length;
        if (tunnel.heldBytes > HELD_LIMIT) this.#finish(tunnel, "gate: held bytes over the limit");
        return;
      }
      if (!tunnel.upstream) {
        tunnel.held.push(chunk);
        tunnel.heldBytes += chunk.length;
        return;
      }
      tunnel.rec.up += chunk.length;
      if (tunnel.rec.cls === "api") tunnel.forwardedInWindow += chunk.length;
      tunnel.upstream.write(chunk);
    };
    client.on("data", onClientData);
    if (head.length > 0) onClientData(head);

    const proceed = cls === "ws" ? this.admitWsTunnel(host) : Promise.resolve(true);
    proceed
      .then((admitted) => {
        if (!this.#tunnels.has(tunnel)) return;
        if (!admitted || !this.#exitOpen) {
          this.#tunnels.delete(tunnel);
          rec.closedMono = monoMs();
          rec.result = admitted ? "refused: exit closed" : "refused: socket not admitted";
          this.#journal.push(rec);
          log("tunnel.refused", { ...rec });
          client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        return socksConnect(this.socks, host, port).then((upstream) => {
          if (!this.#tunnels.has(tunnel) || !this.#exitOpen) {
            upstream.destroy();
            return;
          }
          tunnel.upstream = upstream;
          upstream.on("data", (chunk: Buffer) => {
            tunnel.rec.down += chunk.length;
            client.write(chunk);
          });
          upstream.on("close", () => this.#finish(tunnel, tunnel.rec.result || "upstream closed"));
          upstream.on("error", () => undefined);
          upstream.resume();
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          // Bytes Chrome sent before the tunnel was up (none, normally).
          if (tunnel.rec.cls !== "api" || this.#gateForwards()) this.#flush(tunnel);
          log("tunnel.open", { id: rec.id, host, port, cls });
        });
      })
      .catch((error: Error) => {
        rec.result = `socks: ${error.message}`;
        this.#finish(tunnel, rec.result);
      });
  }

  /** Local and private destinations are refused even with an open exit. */
  #refusal(host: string, port: number): boolean {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return true;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
    const kind = isIP(host);
    if (kind === 4) return /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host);
    if (kind === 6) return /^(::1?$|fc|fd|fe80|::ffff:)/i.test(host);
    return false;
  }
}

/** RFC 1928 CONNECT with RFC 1929 username/password; the host goes to the
 *  SOCKS5 server as a domain name (it resolves DNS on its side). */
export function socksConnect(socks: SocksConfig, host: string, port: number, timeoutMs = 15_000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: socks.host, port: socks.port });
    socket.setNoDelay(true);
    let buffered = Buffer.alloc(0);
    let step: "greeting" | "auth" | "connect" = "greeting";
    const timer = setTimeout(() => fail(new Error("timeout")), timeoutMs);
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once("error", fail);
    socket.on("connect", () => socket.write(Buffer.from([5, 1, 2])));
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (step === "greeting") {
        if (buffered.length < 2) return;
        if (buffered[0] !== 5 || buffered[1] !== 2) return fail(new Error("socks: password auth not offered"));
        buffered = buffered.subarray(2);
        const user = Buffer.from(socks.user);
        const pass = Buffer.from(socks.pass);
        socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
        step = "auth";
      }
      if (step === "auth") {
        if (buffered.length < 2) return;
        if (buffered[1] !== 0) return fail(new Error("socks: auth refused"));
        buffered = buffered.subarray(2);
        const name = Buffer.from(host);
        const portBytes = Buffer.alloc(2);
        portBytes.writeUInt16BE(port, 0);
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, portBytes]));
        step = "connect";
      }
      if (step === "connect") {
        if (buffered.length < 5) return;
        if (buffered[1] !== 0) return fail(new Error(`socks: connect refused (${buffered[1]})`));
        const atyp = buffered[3];
        const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buffered[4]!;
        const total = 4 + addrLen + 2;
        if (buffered.length < total) return;
        socket.off("data", onData);
        socket.off("error", fail);
        clearTimeout(timer);
        const rest = buffered.subarray(total);
        // Paused until the caller attaches its own 'data' handler (resume()).
        socket.pause();
        if (rest.length > 0) socket.unshift(rest);
        resolve(socket);
      }
    };
    socket.on("data", onData);
  });
}
