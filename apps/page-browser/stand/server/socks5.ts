// SOCKS5 (RFC 1928) with required username/password auth (RFC 1929), CONNECT
// only. This is the browser's only way out on the stand: the operator's CONNECT
// proxy tunnels through it, and allowed destinations are connected over
// loopback to the stand's own HTTP front.
//
// Journal: socks.accept → socks.auth → socks.connect → socks.close.
// Faults: socksConnectDelay / socksRefuse (match by host), socksAuthFail, and
// the socksDown / socksUp toggles.

import net from "node:net";
import { errorText, plainAddress } from "./conn.ts";
import type { Fault, FaultStore } from "./faults.ts";
import { mono } from "./journal.ts";
import type { Journal } from "./journal.ts";

/** RFC 1928 §6 reply codes. */
export const REP = {
  SUCCEEDED: 0x00,
  GENERAL_FAILURE: 0x01,
  NOT_ALLOWED: 0x02,
  NETWORK_UNREACHABLE: 0x03,
  HOST_UNREACHABLE: 0x04,
  CONNECTION_REFUSED: 0x05,
  TTL_EXPIRED: 0x06,
  COMMAND_NOT_SUPPORTED: 0x07,
  ADDRESS_TYPE_NOT_SUPPORTED: 0x08,
} as const;

const METHOD_USERPASS = 0x02;
const METHOD_NONE_ACCEPTABLE = 0xff;
const CMD_CONNECT = 0x01;
const ATYP_NAMES: Record<number, string> = { 1: "ipv4", 3: "domain", 4: "ipv6" };

export interface SocksRoute {
  host: string;
  port: number;
}

export interface SocksOptions {
  port: number;
  user: string;
  pass: string;
  journal: Journal;
  faults: FaultStore;
  /** Where an allowed destination is connected; null = not allowed by the ruleset (REP 2). */
  route: (host: string, port: number, atyp: number) => SocksRoute | null;
  /** Told the local port of each upstream socket before it can be accepted (tcp.accept ↔ socksId). */
  upstreamPorts: { register(localPort: number, socksId: number): void; unregister(localPort: number): void };
}

interface Tunnel {
  socksId: number;
  client: net.Socket;
  upstream: net.Socket | null;
  host: string | null;
  port: number | null;
  stage: "greeting" | "auth" | "request" | "connecting" | "open" | "done";
  bytesUp: number;
  bytesDown: number;
  openedMono: number;
  error: string | null;
}

export class SocksServer {
  #opts: SocksOptions;
  #server: net.Server | null = null;
  #closing: Promise<void> | null = null;
  #tunnels = new Map<number, Tunnel>();
  #nextId = 1;
  #down = false;

  constructor(opts: SocksOptions) {
    this.#opts = opts;
  }

  get isDown(): boolean {
    return this.#down;
  }

  start(): Promise<void> {
    return this.#listen();
  }

  /** socksDown: stop listening (new connections are refused) and destroy every open connection. */
  setDown(): number {
    this.#down = true;
    const server = this.#server;
    this.#server = null;
    if (server) this.#closing = new Promise<void>((resolve) => server.close(() => resolve()));
    let destroyed = 0;
    for (const tunnel of this.#tunnels.values()) {
      destroyed += 1;
      tunnel.client.destroy();
      tunnel.upstream?.destroy();
    }
    return destroyed;
  }

  /** socksUp: listen again once the old listener is fully closed. */
  async setUp(): Promise<void> {
    if (!this.#down) return;
    if (this.#closing) await this.#closing;
    this.#closing = null;
    if (!this.#server) await this.#listen();
    this.#down = false;
  }

  list(): Array<Record<string, unknown>> {
    return [...this.#tunnels.values()].map((t) => ({
      socksId: t.socksId,
      remote: `${plainAddress(t.client.remoteAddress)}:${t.client.remotePort}`,
      host: t.host,
      port: t.port,
      stage: t.stage,
      upstreamPort: t.upstream?.localPort ?? null,
      bytesUp: t.bytesUp,
      bytesDown: t.bytesDown,
      openedMono: t.openedMono,
    }));
  }

  #listen(): Promise<void> {
    const server = net.createServer({ allowHalfOpen: true }, (client) => this.#onConnection(client));
    this.#server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#opts.port, () => {
        server.off("error", reject);
        server.on("error", (err) => this.#opts.journal.log("server.error", { where: "socks.listen", error: errorText(err) }));
        resolve();
      });
    });
  }

  #onConnection(client: net.Socket): void {
    const { journal } = this.#opts;
    const tunnel: Tunnel = {
      socksId: this.#nextId++,
      client,
      upstream: null,
      host: null,
      port: null,
      stage: "greeting",
      bytesUp: 0,
      bytesDown: 0,
      openedMono: 0,
      error: null,
    };
    this.#tunnels.set(tunnel.socksId, tunnel);
    tunnel.openedMono = journal.log("socks.accept", {
      socksId: tunnel.socksId,
      remote: `${plainAddress(client.remoteAddress)}:${client.remotePort}`,
    }).mono;

    let buffered: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      buffered = this.#negotiate(tunnel, buffered, onData);
    };
    client.on("data", onData);
    client.on("end", () => {
      // Half-close from the client before the tunnel exists: nothing to wait for.
      if (tunnel.stage !== "open") client.end();
    });
    client.on("error", (err) => {
      tunnel.error ??= errorText(err);
      const upstream = tunnel.upstream;
      if (upstream && !upstream.destroyed) {
        if ((err as NodeJS.ErrnoException).code === "ECONNRESET") upstream.resetAndDestroy();
        else upstream.destroy();
      }
    });
    client.on("close", () => {
      if (tunnel.upstream && !tunnel.upstream.destroyed) tunnel.upstream.destroy();
      this.#maybeClosed(tunnel);
    });
  }

  /** Advance the handshake with the bytes received so far; returns the unconsumed rest. */
  #negotiate(tunnel: Tunnel, buf: Buffer, onData: (chunk: Buffer) => void): Buffer {
    const { journal, faults } = this.#opts;
    const client = tunnel.client;
    for (;;) {
      if (tunnel.stage === "greeting") {
        // VER NMETHODS METHODS…
        if (buf.length < 2) return buf;
        if (buf[0] !== 0x05) return this.#protocolError(tunnel, `bad greeting version ${buf[0]}`);
        const n = buf[1]!;
        if (buf.length < 2 + n) return buf;
        const methods = [...buf.subarray(2, 2 + n)];
        buf = buf.subarray(2 + n);
        if (!methods.includes(METHOD_USERPASS)) {
          journal.log("socks.auth", { socksId: tunnel.socksId, user: null, ok: false, reason: "no username/password method", methods });
          tunnel.stage = "done";
          client.end(Buffer.from([0x05, METHOD_NONE_ACCEPTABLE]));
          return Buffer.alloc(0);
        }
        client.write(Buffer.from([0x05, METHOD_USERPASS]));
        tunnel.stage = "auth";
        continue;
      }
      if (tunnel.stage === "auth") {
        // RFC 1929: VER(1) ULEN UNAME PLEN PASSWD
        if (buf.length < 2) return buf;
        if (buf[0] !== 0x01) return this.#protocolError(tunnel, `bad auth version ${buf[0]}`);
        const userLength = buf[1]!;
        if (buf.length < 3 + userLength) return buf;
        const passLength = buf[2 + userLength]!;
        if (buf.length < 3 + userLength + passLength) return buf;
        const user = buf.subarray(2, 2 + userLength).toString("utf8");
        const pass = buf.subarray(3 + userLength, 3 + userLength + passLength).toString("utf8");
        buf = buf.subarray(3 + userLength + passLength);
        let ok = user === this.#opts.user && pass === this.#opts.pass;
        let reason: string | null = ok ? null : "bad credentials";
        const fault = ok ? faults.take("socksAuthFail", {}) : null;
        if (fault) {
          this.#journalFault(fault, tunnel);
          ok = false;
          reason = "fault socksAuthFail";
        }
        journal.log("socks.auth", { socksId: tunnel.socksId, user, ok, ...(reason ? { reason } : {}) });
        if (!ok) {
          tunnel.stage = "done";
          client.end(Buffer.from([0x01, 0x01]));
          return Buffer.alloc(0);
        }
        client.write(Buffer.from([0x01, 0x00]));
        tunnel.stage = "request";
        continue;
      }
      if (tunnel.stage === "request") {
        // VER CMD RSV ATYP DST.ADDR DST.PORT
        if (buf.length < 5) return buf;
        if (buf[0] !== 0x05) return this.#protocolError(tunnel, `bad request version ${buf[0]}`);
        const cmd = buf[1]!;
        const atyp = buf[3]!;
        let host: string;
        let offset: number;
        if (atyp === 1) {
          if (buf.length < 10) return buf;
          host = [...buf.subarray(4, 8)].join(".");
          offset = 8;
        } else if (atyp === 3) {
          const length = buf[4]!;
          if (buf.length < 5 + length + 2) return buf;
          host = buf.subarray(5, 5 + length).toString("latin1");
          offset = 5 + length;
        } else if (atyp === 4) {
          if (buf.length < 22) return buf;
          const groups: string[] = [];
          for (let i = 0; i < 16; i += 2) groups.push(buf.readUInt16BE(4 + i).toString(16));
          host = groups.join(":");
          offset = 20;
        } else {
          journal.log("socks.connect", {
            socksId: tunnel.socksId, host: null, port: null, atyp, result: "badAddressType", rep: REP.ADDRESS_TYPE_NOT_SUPPORTED, delayMs: 0,
          });
          this.#fail(tunnel, REP.ADDRESS_TYPE_NOT_SUPPORTED);
          return Buffer.alloc(0);
        }
        const port = buf.readUInt16BE(offset);
        const rest = buf.subarray(offset + 2);
        tunnel.host = host;
        tunnel.port = port;
        tunnel.stage = "connecting";
        // Hold anything the client sent optimistically until the tunnel is up.
        client.off("data", onData);
        client.pause();
        void this.#connect(tunnel, cmd, atyp, host, port, rest);
        return Buffer.alloc(0);
      }
      return Buffer.alloc(0);
    }
  }

  async #connect(tunnel: Tunnel, cmd: number, atyp: number, host: string, port: number, early: Buffer): Promise<void> {
    const { journal, faults } = this.#opts;
    const client = tunnel.client;
    const base = { socksId: tunnel.socksId, host, port, atyp: ATYP_NAMES[atyp] ?? atyp };
    const started = mono();

    if (cmd !== CMD_CONNECT) {
      journal.log("socks.connect", { ...base, cmd, result: "unsupportedCommand", rep: REP.COMMAND_NOT_SUPPORTED, delayMs: 0 });
      this.#fail(tunnel, REP.COMMAND_NOT_SUPPORTED);
      return;
    }
    const target = this.#opts.route(host, port, atyp);
    if (!target) {
      journal.log("socks.connect", { ...base, result: "notAllowed", rep: REP.NOT_ALLOWED, delayMs: 0 });
      this.#fail(tunnel, REP.NOT_ALLOWED);
      return;
    }

    let delayMs = 0;
    const delay = faults.take("socksConnectDelay", { host });
    if (delay) {
      this.#journalFault(delay, tunnel);
      delayMs = delay.ms ?? 0;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (client.destroyed) {
        journal.log("socks.connect", { ...base, result: "clientGone", rep: null, delayMs });
        return;
      }
    }
    const refuse = faults.take("socksRefuse", { host });
    if (refuse) {
      this.#journalFault(refuse, tunnel);
      const rep = refuse.code ?? REP.CONNECTION_REFUSED;
      journal.log("socks.connect", { ...base, result: "refused", rep, delayMs });
      this.#fail(tunnel, rep);
      return;
    }

    const upstream = net.connect({ host: target.host, port: target.port, allowHalfOpen: true });
    tunnel.upstream = upstream;
    // net.connect() to an IP literal runs the connect() syscall on the next
    // tick, which fixes the local port; this tick runs right after it and
    // still before the front's accept callback (an I/O event) can run.
    let registeredPort: number | null = null;
    process.nextTick(() => {
      if (upstream.localPort) {
        registeredPort = upstream.localPort;
        this.#opts.upstreamPorts.register(registeredPort, tunnel.socksId);
      }
    });
    let connected = false;
    upstream.once("connect", () => {
      connected = true;
      if (client.destroyed) {
        upstream.destroy();
        return;
      }
      this.#reply(tunnel, REP.SUCCEEDED, upstream.localAddress, upstream.localPort);
      journal.log("socks.connect", {
        ...base, result: "ok", rep: REP.SUCCEEDED, delayMs, upstreamPort: upstream.localPort ?? null, ms: round(mono() - started),
      });
      tunnel.stage = "open";
      this.#pipe(tunnel, upstream, early);
    });
    upstream.on("error", (err) => {
      tunnel.error ??= errorText(err);
      if (!connected) {
        const rep = (err as NodeJS.ErrnoException).code === "ECONNREFUSED" ? REP.CONNECTION_REFUSED : REP.GENERAL_FAILURE;
        journal.log("socks.connect", { ...base, result: "upstreamError", rep, delayMs, error: errorText(err) });
        this.#fail(tunnel, rep);
        return;
      }
      // Propagate a reset as a reset, so the operator sees what the front did.
      if (!client.destroyed) {
        if ((err as NodeJS.ErrnoException).code === "ECONNRESET") client.resetAndDestroy();
        else client.destroy();
      }
    });
    upstream.on("close", () => {
      if (registeredPort !== null) this.#opts.upstreamPorts.unregister(registeredPort);
      if (connected && !client.destroyed && !client.writableEnded) client.end();
      this.#maybeClosed(tunnel);
    });
  }

  /** Relay bytes both ways, counting them, with backpressure and half-close. */
  #pipe(tunnel: Tunnel, upstream: net.Socket, early: Buffer): void {
    const client = tunnel.client;
    if (early.length > 0) {
      tunnel.bytesUp += early.length;
      upstream.write(early);
    }
    client.on("data", (chunk: Buffer) => {
      tunnel.bytesUp += chunk.length;
      if (!upstream.write(chunk)) client.pause();
    });
    upstream.on("drain", () => client.resume());
    upstream.on("data", (chunk: Buffer) => {
      tunnel.bytesDown += chunk.length;
      if (!client.write(chunk)) upstream.pause();
    });
    client.on("drain", () => upstream.resume());
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
    client.resume();
  }

  /** CONNECT reply; BND.ADDR is IPv4 (0.0.0.0 when unknown). */
  #reply(tunnel: Tunnel, rep: number, address?: string, port?: number): void {
    const octets = address && net.isIPv4(address) ? address.split(".").map(Number) : [0, 0, 0, 0];
    const bindPort = port ?? 0;
    tunnel.client.write(Buffer.from([0x05, rep, 0x00, 0x01, ...octets, (bindPort >> 8) & 0xff, bindPort & 0xff]));
  }

  #fail(tunnel: Tunnel, rep: number): void {
    tunnel.stage = "done";
    if (tunnel.client.destroyed) return;
    this.#reply(tunnel, rep);
    tunnel.client.end();
  }

  #protocolError(tunnel: Tunnel, message: string): Buffer {
    this.#opts.journal.log("socks.error", { socksId: tunnel.socksId, error: message });
    tunnel.stage = "done";
    tunnel.client.destroy();
    return Buffer.alloc(0);
  }

  /** Journal socks.close once the client and the upstream (if any) are both closed. */
  #maybeClosed(tunnel: Tunnel): void {
    if (!this.#tunnels.has(tunnel.socksId)) return;
    if (!tunnel.client.destroyed) return;
    if (tunnel.upstream && !tunnel.upstream.destroyed) return;
    this.#tunnels.delete(tunnel.socksId);
    this.#opts.journal.log("socks.close", {
      socksId: tunnel.socksId,
      bytesUp: tunnel.bytesUp,
      bytesDown: tunnel.bytesDown,
      ms: round(mono() - tunnel.openedMono),
      error: tunnel.error,
    });
  }

  #journalFault(fault: Fault, tunnel: Tunnel): void {
    this.#opts.journal.log("fault", {
      faultId: fault.id,
      kind: fault.kind,
      socksId: tunnel.socksId,
      host: tunnel.host,
      ...(fault.ms !== null ? { ms: fault.ms } : {}),
      ...(fault.code !== null ? { code: fault.code } : {}),
    });
  }
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
