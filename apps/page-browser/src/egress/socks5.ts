// The page's SOCKS5 with its password (RFC 1928, RFC 1929): the operator's
// only way out — the kernel lets the operator's user reach that address and
// port and nothing else (s6/scripts/init-net). The destination goes to the
// SOCKS5 server as a domain name: DNS is resolved on its side (plan §4.5).
// The credentials come from the engine in `hello`; they are never logged and
// never put into an error message.

import { connect as tcpConnect, type Socket } from "node:net";

export interface SocksConfig {
  ip: string;
  port: number;
  username: string;
  password: string;
}

/** Why a SOCKS5 connection failed:
 *  - unavailable: the SOCKS5 server is not reached, or answers garbage;
 *  - auth: it refused the login (or offers no password method);
 *  - refused: it is fine, but it could not reach the destination. */
export type SocksFailure = "unavailable" | "auth" | "refused";

export class SocksError extends Error {
  readonly kind: SocksFailure;
  constructor(kind: SocksFailure, message: string) {
    super(message);
    this.name = "SocksError";
    this.kind = kind;
  }
}

const REPLIES: Record<number, string> = {
  1: "general failure",
  2: "not allowed by the ruleset",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

/** A connection to `host:port` through the page's SOCKS5. The socket comes
 *  back paused, with any early bytes unshifted: the caller resumes it once
 *  its own handlers are on. */
export function socksConnect(socks: SocksConfig, host: string, port: number, timeoutMs = 15_000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const user = Buffer.from(socks.username, "utf8");
    const pass = Buffer.from(socks.password, "utf8");
    const name = Buffer.from(host, "utf8");
    if (user.length === 0 || user.length > 255 || pass.length === 0 || pass.length > 255) {
      reject(new SocksError("auth", "the SOCKS5 login or password is empty or too long"));
      return;
    }
    if (name.length === 0 || name.length > 255) {
      reject(new SocksError("refused", "the destination's name is empty or too long"));
      return;
    }
    const socket = tcpConnect({ host: socks.ip, port: socks.port });
    socket.setNoDelay(true);
    let buffered = Buffer.alloc(0);
    let step: "greeting" | "auth" | "connect" = "greeting";
    let settled = false;
    const fail = (error: SocksError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new SocksError(step === "connect" ? "refused" : "unavailable", `SOCKS5 ${step}: no answer in ${timeoutMs} ms`)), timeoutMs);
    socket.once("error", (error: NodeJS.ErrnoException) => fail(new SocksError("unavailable", `SOCKS5: ${error.code ?? error.message}`)));
    socket.once("close", () => fail(new SocksError(step === "auth" ? "auth" : "unavailable", `SOCKS5 closed the connection at ${step}`)));
    socket.on("connect", () => socket.write(Buffer.from([5, 1, 2])));
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (step === "greeting") {
        if (buffered.length < 2) return;
        if (buffered[0] !== 5) return fail(new SocksError("unavailable", "not a SOCKS5 server"));
        if (buffered[1] !== 2) return fail(new SocksError("auth", "the SOCKS5 server offers no password login"));
        buffered = buffered.subarray(2);
        socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
        step = "auth";
      }
      if (step === "auth") {
        if (buffered.length < 2) return;
        if (buffered[1] !== 0) return fail(new SocksError("auth", "the SOCKS5 server refused the login"));
        buffered = buffered.subarray(2);
        const portBytes = Buffer.alloc(2);
        portBytes.writeUInt16BE(port, 0);
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, portBytes]));
        step = "connect";
      }
      if (step === "connect") {
        if (buffered.length < 5) return;
        if (buffered[0] !== 5) return fail(new SocksError("unavailable", "a malformed SOCKS5 reply"));
        if (buffered[1] !== 0) return fail(new SocksError("refused", `SOCKS5: ${REPLIES[buffered[1]!] ?? `reply ${buffered[1]}`}`));
        const atyp = buffered[3];
        const addressLength = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? 1 + buffered[4]! : -1;
        if (addressLength < 0) return fail(new SocksError("unavailable", "a malformed SOCKS5 reply"));
        const total = 4 + addressLength + 2;
        if (buffered.length < total) return;
        settled = true;
        clearTimeout(timer);
        socket.off("data", onData);
        socket.removeAllListeners("error");
        socket.removeAllListeners("close");
        // Until the caller's own handler is on.
        socket.on("error", () => undefined);
        const rest = buffered.subarray(total);
        socket.pause();
        if (rest.length > 0) socket.unshift(rest);
        resolve(socket);
      }
    };
    socket.on("data", onData);
  });
}
