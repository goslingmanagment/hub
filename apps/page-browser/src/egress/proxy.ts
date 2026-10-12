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
// - Each tunnel is one line of the connection journal: host, port, opened,
//   closed, bytes both ways, what was held, the result.
//
// The rules extension's files (PR 6) will be served on this port too;
// until then a plain HTTP request is refused.

import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { isIP, type Socket } from "node:net";

import { ApiGate, controlRecordLimit, serverHelloIsTls13 } from "./gate.ts";
import type { HostClass, HostClassifier } from "./hosts.ts";
import { SocksError, socksConnect, type SocksConfig, type SocksFailure } from "./socks5.ts";
import { errorMessage, makeLog, monoMs, wallMs, type Logger } from "../shared/util.ts";

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

export interface EgressOptions {
  classify: HostClassifier;
  gate?: ApiGate;
  /** Every refusal and every closed tunnel (the connection journal). */
  onRecord?: (record: TunnelRecord) => void;
  /** The page's SOCKS5 failed us (not the destination). */
  onSocksFailure?: (kind: Exclude<SocksFailure, "refused">, message: string) => void;
  /** A tunnel holding more of Chrome's bytes than this is cut. */
  heldLimitBytes?: number;
  socksTimeoutMs?: number;
  log?: Logger;
}

const EMPTY = Buffer.alloc(0);
const RECENT_RECORDS = 1000;

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

  /** Refusals of CONNECTs to `host:port` since `sinceMono` (the self-test
   *  finds its probe's refusal here). */
  refusalsSince(host: string, port: number, sinceMono: number): TunnelRecord[] {
    return this.#recent.filter((record) => record.refused && record.host === host && record.port === port && record.openedMono >= sinceMono);
  }

  listen(port: number, host = "127.0.0.1"): Promise<number> {
    const server = createHttpServer((req, res) => {
      this.#log("plain.refused", { method: req.method ?? "", path: (req.url ?? "").split("?")[0] ?? "" });
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
    else this.#up(tunnel, chunk);
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

  /** The TLS version of an API tunnel decides the size of a control record;
   *  a handshake the proxy cannot read is not carried at all. */
  #serverHello(tunnel: Tunnel, chunk: Buffer): void {
    const seen = Buffer.concat([tunnel.serverFirst ?? EMPTY, chunk]);
    const tls13 = serverHelloIsTls13(seen);
    if (tls13 === undefined) {
      tunnel.serverFirst = seen;
      return;
    }
    tunnel.serverFirst = null;
    if (tls13 === null) {
      this.#finish(tunnel, "cut: TLS handshake not understood");
      return;
    }
    tunnel.tls13 = tls13;
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
    if (cls === "denied") return this.#refuse(record, client, "refused: host not allowed");
    // Each socket of the site will be its own tunnel, admitted by the engine
    // (PR 10); until that path exists no socket is admitted.
    if (cls === "ws") return this.#refuse(record, client, "refused: socket not admitted");
    if (cls === "api") {
      // A new connection to the API serves only the request just released.
      // Any other moment it is Chrome repeating a request on a new
      // connection, retrying one whose admission expired, or sending one it
      // released without us (a CDP detach).
      if (!this.gate.admitsTunnel()) return this.#refuse(record, client, `refused: gate ${this.gate.state.phase}`);
      this.gate.noteTunnel(record.id);
    }
    const tunnel = new Tunnel(record, client);
    this.#tunnels.add(tunnel);
    client.on("close", () => this.#finish(tunnel, tunnel.record.result || "closed by Chrome"));
    client.on("data", (chunk: Buffer) => this.#onClientData(tunnel, chunk));
    if (head.length > 0) this.#onClientData(tunnel, head);
    socksConnect(socks, host, record.port, this.#options.socksTimeoutMs)
      .then((upstream) => {
        if (!this.#tunnels.has(tunnel) || !this.#exitOpen) {
          upstream.destroy();
          return;
        }
        tunnel.upstream = upstream;
        upstream.on("data", (chunk: Buffer) => {
          tunnel.record.down += chunk.length;
          if (cls === "api") {
            if (tunnel.serverFirst !== null) this.#serverHello(tunnel, chunk);
            if (!this.#tunnels.has(tunnel)) return;
            // Before Chrome can react to them (a refusal it would repeat on).
            this.gate.noteServerBytes(tunnel.record.id);
          }
          if (!client.write(chunk)) upstream.pause();
        });
        client.on("drain", () => upstream.resume());
        upstream.on("drain", () => client.resume());
        upstream.on("close", () => this.#finish(tunnel, tunnel.record.result || "closed by the server"));
        upstream.on("error", () => undefined);
        upstream.resume();
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        this.#log("tunnel.open", { id: record.id, host, port: record.port, cls });
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
 *  open, and anything that is not a valid port. */
export function localOrPrivate(host: string, port: number): boolean {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return true;
  if (host === "" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const kind = isIP(host);
  if (kind === 4) return /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|2[3-5]\d\.)/.test(host);
  if (kind === 6) return /^(::1?$|::ffff:|fc|fd|fe[89ab]|ff)/i.test(host);
  // A bare name without a dot is a local one.
  return !host.includes(".");
}
