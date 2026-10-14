// The stand's SOCKS5 — the page's exit, and the only "internet" the stand
// has. The operator hands it names (RFC 1928, address type "domain"), with
// the page's login and password (RFC 1929); it knows Fansly's names and the
// exit-IP service's, and connects them to the stand's own front
// (front.ts) on loopback. It has no other destination: every other name or
// address is refused and journaled — together with the stand's networks,
// which have no route out, that is why nothing of a run can reach the real
// Fansly, or anything else.
//
// Faults, by the runner's command (control.ts):
//   down        — the listener closes and every connection is cut: the
//                 proxy is gone;
//   refuseAuth  — every login is refused (connections already open stay);
//   connectDelayMs — the answer to every CONNECT waits;
//   hold        — the answer to a CONNECT of one name waits `ms`, then goes:
//                 journaled when it began and when it was let go
//                 (`socks.hold`, `socks.release`), so a run can show that a
//                 connection was held past an admission's deadline.

import { connect as tcpConnect, createServer, type Server, type Socket } from "node:net";

import type { Journal } from "./journal.ts";

export interface SocksMeta {
  socksId: number;
  host: string;
  port: number;
  /** The client's address: which page of the stand it is. */
  from: string;
}

export interface SocksOptions {
  listenHost: string;
  port: number;
  username: string;
  password: string;
  journal: Journal;
  /** The front's loopback port for this name and port, or null: refused. */
  route: (host: string, port: number) => number | null;
}

const REPLY_OK = 0;
const REPLY_NOT_ALLOWED = 2;
const REPLY_HOST_UNREACHABLE = 4;
const REPLY_ATYP = 8;

export class StandSocks {
  readonly #options: SocksOptions;
  #server: Server | null = null;
  readonly #sockets = new Set<Socket>();
  /** The loopback connections to the front, by their local port. */
  readonly #upstreams = new Map<number, SocksMeta>();
  #nextId = 1;
  #down = false;
  refuseAuth = false;
  connectDelayMs = 0;
  #hold: { host: string; ms: number } | null = null;
  /** The CONNECTs held now, by SOCKS id: each one's release. */
  readonly #held = new Map<number, { host: string; release: () => void }>();
  /** A second login, taken while a control runs (control.ts): a one-time
   *  one, so the page's own never leaves the runner and the operator. */
  extraLogin: { username: string; password: string } | null = null;

  constructor(options: SocksOptions) {
    this.#options = options;
  }

  get down(): boolean {
    return this.#down;
  }

  /** A CONNECT of this name is answered only after `ms`. Lifted (null, or
   *  another name), the CONNECTs it holds are let go at once — not at the
   *  end of their own `ms`: after a fault the stand's network is open, and
   *  only the page's own reaction may stop a send. */
  get hold(): { host: string; ms: number } | null {
    return this.#hold;
  }

  set hold(value: { host: string; ms: number } | null) {
    this.#hold = value;
    for (const [, held] of [...this.#held]) if (value === null || value.host !== held.host) held.release();
  }

  get open(): number {
    return this.#sockets.size;
  }

  /** The SOCKS connection behind a connection the front accepted. */
  metaOf(remotePort: number | undefined): SocksMeta | null {
    return remotePort === undefined ? null : (this.#upstreams.get(remotePort) ?? null);
  }

  listen(): Promise<void> {
    const server = createServer((socket) => this.#serve(socket));
    this.#server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#options.port, this.#options.listenHost, () => resolve());
    });
  }

  /** The proxy goes (every connection with it), or comes back. */
  async setDown(down: boolean): Promise<number> {
    if (down === this.#down) return 0;
    this.#down = down;
    if (!down) {
      await this.listen();
      return 0;
    }
    const cut = this.#sockets.size;
    for (const socket of this.#sockets) socket.destroy();
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    return cut;
  }

  #serve(socket: Socket): void {
    const journal = this.#options.journal;
    const socksId = this.#nextId++;
    this.#sockets.add(socket);
    socket.setNoDelay(true);
    socket.on("error", () => undefined);
    let buffered: Buffer = Buffer.alloc(0);
    let step: "greeting" | "auth" | "connect" | "relay" = "greeting";
    let target = "";
    let up = 0;
    let down = 0;
    socket.on("close", () => {
      this.#sockets.delete(socket);
      journal.log("socks.closed", { socksId, step, target, up, down });
    });
    const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (step === "greeting") {
        if (buffered.length < 2 || buffered.length < 2 + buffered[1]!) return;
        if (buffered[0] !== 5) {
          journal.log("socks.garbage", { socksId, from: socket.remoteAddress ?? "" });
          socket.destroy();
          return;
        }
        const methods = [...buffered.subarray(2, 2 + buffered[1]!)];
        buffered = buffered.subarray(2 + buffered[1]!);
        if (!methods.includes(2)) {
          journal.log("socks.login", { socksId, ok: false, why: "no password method offered" });
          socket.end(Buffer.from([5, 0xff]));
          return;
        }
        socket.write(Buffer.from([5, 2]));
        step = "auth";
      }
      if (step === "auth") {
        if (buffered.length < 2) return;
        const userLength = buffered[1]!;
        if (buffered.length < 3 + userLength) return;
        const passLength = buffered[2 + userLength]!;
        if (buffered.length < 3 + userLength + passLength) return;
        const username = buffered.subarray(2, 2 + userLength).toString("utf8");
        const password = buffered.subarray(3 + userLength, 3 + userLength + passLength).toString("utf8");
        buffered = buffered.subarray(3 + userLength + passLength);
        const extra = this.extraLogin !== null && username === this.extraLogin.username && password === this.extraLogin.password;
        const known = extra || (username === this.#options.username && password === this.#options.password);
        const ok = known && !this.refuseAuth;
        // Never the login or the password themselves.
        // `extra`: a control's own login (its planted connections are told
        // apart by it, runner/criteria.ts `Planted`).
        journal.log("socks.login", { socksId, ok, known, ...(extra ? { extra: true } : {}), from: socket.remoteAddress ?? "", ...(ok ? {} : { why: known ? "the stand refuses every login now" : "a wrong login or password" }) });
        if (!ok) {
          socket.end(Buffer.from([1, 1]));
          return;
        }
        socket.write(Buffer.from([1, 0]));
        step = "connect";
      }
      if (step === "connect") {
        if (buffered.length < 5) return;
        if (buffered[0] !== 5 || buffered[1] !== 1) {
          journal.log("socks.refused", { socksId, why: "not a CONNECT" });
          socket.end(reply(7));
          return;
        }
        const atyp = buffered[3]!;
        if (atyp !== 3) {
          // An address, not a name: the operator never sends one, and the
          // stand has nowhere to connect it.
          journal.log("socks.refused", { socksId, why: `address type ${atyp}`, target: atyp === 1 && buffered.length >= 8 ? [...buffered.subarray(4, 8)].join(".") : "" });
          socket.end(reply(REPLY_ATYP));
          return;
        }
        const nameLength = buffered[4]!;
        if (buffered.length < 5 + nameLength + 2) return;
        const host = buffered.subarray(5, 5 + nameLength).toString("utf8").toLowerCase().replace(/\.$/, "");
        const port = buffered.readUInt16BE(5 + nameLength);
        const rest = buffered.subarray(7 + nameLength);
        buffered = Buffer.alloc(0);
        target = `${host}:${port}`;
        const local = this.#options.route(host, port);
        if (local === null) {
          journal.log("socks.refused", { socksId, host, port, from: socket.remoteAddress ?? "", why: "not a name of the stand: the stand connects nowhere else" });
          socket.end(reply(REPLY_NOT_ALLOWED));
          return;
        }
        step = "relay";
        socket.off("data", onData);
        socket.pause();
        const from = socket.remoteAddress ?? "";
        const go = () => {
          if (socket.destroyed) return;
          const upstream = tcpConnect({ host: "127.0.0.1", port: local });
          upstream.setNoDelay(true);
          upstream.once("connect", () => {
            const meta: SocksMeta = { socksId, host, port, from };
            const localPort = upstream.localPort;
            if (localPort !== undefined) this.#upstreams.set(localPort, meta);
            journal.log("socks.connect", { socksId, host, port, from });
            socket.write(reply(REPLY_OK));
            if (rest.length > 0) {
              up += rest.length;
              upstream.write(rest);
            }
            socket.on("data", (data: Buffer) => {
              up += data.length;
              if (!upstream.write(data)) socket.pause();
            });
            upstream.on("drain", () => socket.resume());
            upstream.on("data", (data: Buffer) => {
              down += data.length;
              if (!socket.write(data)) upstream.pause();
            });
            socket.on("drain", () => upstream.resume());
            socket.on("end", () => upstream.end());
            upstream.on("end", () => socket.end());
            upstream.on("close", () => {
              if (localPort !== undefined) this.#upstreams.delete(localPort);
              socket.destroy();
            });
            socket.resume();
          });
          upstream.on("error", () => {
            if (!socket.destroyed && step === "relay" && up === 0 && down === 0) socket.end(reply(REPLY_HOST_UNREACHABLE));
            else socket.destroy();
          });
          socket.on("close", () => upstream.destroy());
        };
        const hold = this.#hold !== null && this.#hold.host === host ? this.#hold.ms : 0;
        if (hold > 0) {
          journal.log("socks.hold", { socksId, host, port, from, ms: hold });
          let timer: NodeJS.Timeout | null = null;
          const release = (early: boolean) => {
            if (!this.#held.delete(socksId)) return;
            if (timer) clearTimeout(timer);
            journal.log("socks.release", { socksId, host, port, from, gone: socket.destroyed, ...(early ? { early: true } : {}) });
            go();
          };
          this.#held.set(socksId, { host, release: () => release(true) });
          timer = setTimeout(() => release(false), hold);
        } else if (this.connectDelayMs > 0) setTimeout(go, this.connectDelayMs);
        else go();
      }
    };
    socket.on("data", onData);
  }
}
