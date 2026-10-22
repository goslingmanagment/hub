// The page's exit IP, through its SOCKS5 (plan §4.5): before the exit opens
// and hourly while it is open (operator.ts says what a failed check does).
// The same service Hub uses today (`pnpm cli page proxy-ip`):
// https://api.ipify.org answers the caller's address as plain text. The IP
// must equal the one the owner pinned (`hello.pinnedExitIp`).

import { request as httpRequest } from "node:http";
import { isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";

import { SocksError, socksConnect, type SocksConfig } from "./socks5.ts";

export interface ExitIpTarget {
  host: string;
  port: number;
  path: string;
  /** The stream the request goes over: TLS to `host` by default (tests
   *  talk plain HTTP to a local server behind a fake SOCKS5). */
  wrap?: (socket: Socket, host: string) => Duplex;
}

export const IPIFY: ExitIpTarget = { host: "api.ipify.org", port: 443, path: "/" };

export class ExitIpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExitIpError";
  }
}

function tlsWrap(socket: Socket, host: string): Duplex {
  return tlsConnect({ socket, servername: host });
}

/** The exit IP as the outside sees it. Rejects with SocksError (the SOCKS5
 *  failed) or ExitIpError (an answer that is not an address). */
export async function checkExitIp(socks: SocksConfig, target: ExitIpTarget = IPIFY, timeoutMs = 15_000): Promise<string> {
  const raw = await socksConnect(socks, target.host, target.port, timeoutMs);
  const stream = (target.wrap ?? tlsWrap)(raw, target.host);
  raw.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy();
        reject(new SocksError("unavailable", `the exit IP check: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      const req = httpRequest(
        {
          host: target.host,
          port: target.port,
          path: target.path,
          method: "GET",
          headers: { host: target.host, accept: "text/plain", connection: "close" },
          createConnection: () => stream,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > 256) req.destroy(new Error("the answer is too long for an address"));
          });
          res.on("end", () => {
            clearTimeout(timer);
            const ip = body.trim();
            if (res.statusCode !== 200) reject(new ExitIpError(`the exit IP check answered ${res.statusCode ?? "?"}`));
            else if (isIP(ip) === 0) reject(new ExitIpError("the exit IP check did not answer an address"));
            else resolve(normalizeIp(ip));
          });
        },
      );
      req.on("error", (error) => {
        clearTimeout(timer);
        reject(error instanceof SocksError || error instanceof ExitIpError ? error : new SocksError("unavailable", `the exit IP check: ${error.message}`));
      });
      req.end();
    });
  } finally {
    stream.destroy();
    raw.destroy();
  }
}

/** One spelling per address: IPv6 in lower case. */
export function normalizeIp(ip: string): string {
  return isIP(ip) === 6 ? ip.toLowerCase() : ip;
}
