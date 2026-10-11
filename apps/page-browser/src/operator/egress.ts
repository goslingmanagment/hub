// The operator's local proxy — Chrome's only way out (plan §4.5). HTTP
// CONNECT on 127.0.0.1:3128; every tunnel goes through the page's SOCKS5 with
// its password (Chrome cannot do that itself). Closed exit = every CONNECT is
// refused and every open tunnel is cut at once.
//
// Tunnels to the API host pass through the send gate (gate.ts): their bytes
// go up only inside the window of the request that was just released.
// Tunnels to the socket host are admitted one by one by the engine (each
// socket of the site is its own tunnel). The same port serves the rules
// extension to Chrome's policy installer (plan §4.6).

import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { connect as tcpConnect, isIP, type Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";

import { ApiGate, RecordTracker } from "./gate.ts";
import { makeLog, monoMs } from "../shared/util.ts";

const log = makeLog("egress");

export type HostClass = "site" | "api" | "ws" | "cdn" | "denied";

export interface SocksConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

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

const EXTENSION_DIST = process.env.PB_EXTENSION_DIST ?? "/opt/page-browser/extension-dist";
const HELD_LIMIT = 4 * 1024 * 1024;

class Tunnel {
  readonly rec: TunnelRecord;
  readonly client: Socket;
  upstream: Socket | null = null;
  held: Buffer[] = [];
  heldBytes = 0;
  /** TLS records of what went up (API tunnels). */
  readonly records = new RecordTracker();
  constructor(rec: TunnelRecord, client: Socket) {
    this.rec = rec;
    this.client = client;
  }
}

export class Egress {
  readonly socks: SocksConfig;
  readonly classify: (host: string) => HostClass;
  readonly gate = new ApiGate();
  /** Admission of a new socket connection (socket host): resolves true to
   *  let the CONNECT through. */
  admitWsTunnel: (host: string) => Promise<boolean> = async () => false;

  #exitOpen = false;
  #tunnels = new Set<Tunnel>();
  #nextId = 1;
  #journal: TunnelRecord[] = [];

  constructor(socks: SocksConfig, classify: (host: string) => HostClass) {
    this.socks = socks;
    this.classify = classify;
    this.gate.cut = (reason) => this.cutClass("api", reason);
    this.gate.flush = () => {
      for (const tunnel of this.#tunnels) if (tunnel.rec.cls === "api") this.#flush(tunnel);
    };
  }

  get exitOpen(): boolean {
    return this.#exitOpen;
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
    this.gate.reset();
    const cut = this.#cutWhere(() => true, `exit closed: ${reason}`);
    log("exit.closed", { reason, wasOpen, cut });
  }

  /** Cut every tunnel of one host class. */
  cutClass(cls: HostClass, reason: string): number {
    return this.#cutWhere((tunnel) => tunnel.rec.cls === cls, reason);
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

  #refuse(rec: TunnelRecord, client: Socket, result: string): void {
    rec.closedMono = monoMs();
    rec.result = result;
    this.#journal.push(rec);
    log("tunnel.refused", { ...rec });
    client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  }

  // ── bytes from Chrome ──────────────────────────────────────────────────

  #hold(tunnel: Tunnel, bytes: Buffer): void {
    if (bytes.length === 0) return;
    tunnel.held.push(bytes);
    tunnel.heldBytes += bytes.length;
    if (tunnel.heldBytes > HELD_LIMIT) this.#finish(tunnel, "held bytes over the limit");
  }

  #up(tunnel: Tunnel, bytes: Buffer): void {
    if (bytes.length === 0 || !tunnel.upstream) return;
    tunnel.rec.up += bytes.length;
    if (tunnel.rec.cls === "api") tunnel.records.advance(bytes);
    tunnel.upstream.write(bytes);
  }

  /** Forward what a tunnel holds (its order is never changed). */
  #flush(tunnel: Tunnel): void {
    if (!tunnel.upstream || tunnel.held.length === 0) return;
    const bytes = Buffer.concat(tunnel.held);
    tunnel.held = [];
    tunnel.heldBytes = 0;
    this.#up(tunnel, bytes);
  }

  #onClientData(tunnel: Tunnel, chunk: Buffer): void {
    if (!this.#tunnels.has(tunnel)) return;
    if (!tunnel.upstream) {
      this.#hold(tunnel, chunk);
      return;
    }
    if (tunnel.rec.cls !== "api") {
      this.#up(tunnel, chunk);
      return;
    }
    if (this.gate.forwards()) {
      this.#flush(tunnel);
      if (this.gate.wantsOneRecord) {
        // Exactly one record of this window goes up; what follows waits.
        const end = tunnel.records.oneRecord(chunk);
        if (end >= 0) {
          this.#up(tunnel, chunk.subarray(0, end));
          this.gate.noteChunk(end);
          this.gate.recordDone();
          this.#hold(tunnel, chunk.subarray(end));
          return;
        }
      }
      this.#up(tunnel, chunk);
      this.gate.noteChunk(chunk.length);
      return;
    }
    // Not forwarding. A record already half through is finished first; what
    // follows is held from a record boundary on.
    let rest = chunk;
    if (tunnel.held.length === 0 && tunnel.records.midRecord) {
      const prefix = tunnel.records.prefixToBoundary(chunk);
      this.#up(tunnel, chunk.subarray(0, prefix));
      rest = chunk.subarray(prefix);
    }
    this.#hold(tunnel, rest);
  }

  // ── the proxy ──────────────────────────────────────────────────────────

  listen(port: number): Promise<void> {
    const server = createHttpServer((req, res) => {
      // The one thing served here: the rules extension, to Chrome's policy
      // installer (Chrome fetches it from no other place).
      const files: Record<string, [string, string]> = {
        "/pb-extension/update.xml": [`${EXTENSION_DIST}/update.xml`, "application/xml"],
        "/pb-extension/hub.crx": [`${EXTENSION_DIST}/hub.crx`, "application/x-chrome-extension"],
      };
      const file = req.method === "GET" && req.url ? files[req.url.split("?")[0]!] : undefined;
      if (file && existsSync(file[0])) {
        const body = readFileSync(file[0]);
        log("extension.served", { url: req.url, bytes: body.length });
        res.writeHead(200, { "content-type": file[1], "content-length": body.length }).end(body);
        return;
      }
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
    const cls = this.#localOrPrivate(host, port) ? "denied" : this.classify(host);
    const rec: TunnelRecord = { id: this.#nextId++, host, port, cls, openedMono: monoMs(), closedMono: null, up: 0, down: 0, held: 0, result: "" };
    client.on("error", () => undefined);
    if (!this.#exitOpen) return this.#refuse(rec, client, "refused: exit closed");
    if (cls === "denied") return this.#refuse(rec, client, "refused: host");
    if (cls === "api") {
      // A new connection to the API serves only the request just released.
      // Any other moment it is Chrome repeating a request on a new
      // connection, retrying one whose admission expired, or sending one it
      // released without us (a CDP detach).
      if (!this.gate.admitsTunnel()) return this.#refuse(rec, client, `refused: gate ${this.gate.state.phase}`);
      this.gate.noteTunnel();
    }
    const tunnel = new Tunnel(rec, client);
    this.#tunnels.add(tunnel);
    client.on("close", () => this.#finish(tunnel, tunnel.rec.result || "client closed"));
    client.on("data", (chunk: Buffer) => this.#onClientData(tunnel, chunk));
    if (head.length > 0) this.#onClientData(tunnel, head);

    const proceed = cls === "ws" ? this.admitWsTunnel(host) : Promise.resolve(true);
    proceed
      .then((admitted) => {
        if (!this.#tunnels.has(tunnel)) return;
        if (!admitted || !this.#exitOpen) {
          this.#tunnels.delete(tunnel);
          this.#refuse(rec, client, admitted ? "refused: exit closed" : "refused: socket not admitted");
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
          log("tunnel.open", { id: rec.id, host, port, cls });
        });
      })
      .catch((error: Error) => this.#finish(tunnel, `socks: ${error.message}`));
  }

  /** Local and private destinations are refused even with an open exit. */
  #localOrPrivate(host: string, port: number): boolean {
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
