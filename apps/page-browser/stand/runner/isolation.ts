// Before anything runs: the stand is shut in, and its Fansly is trusted only
// inside it. `stand.sh up` runs this in the runner; a failure stops there.
//
//  1. No route out: a connection to an address on the internet fails at
//     once (the stand's networks are internal).
//  2. The SOCKS5 connects nothing but the stand's names: example.com is
//     refused.
//  3. Fansly's names through the SOCKS5 are the stand's: with the stand's CA
//     the answer is the stand's marker.
//  4. The certificate is the stand's, not a public one: without the stand's
//     CA, TLS to the same name fails.
//  5. The exit-IP service answers the stand's pinned address.

import { readFileSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

import { SocksError, socksConnect, type SocksConfig } from "../../src/egress/socks5.ts";
import { TRUST_MARKER, TRUST_PATH } from "../fansly/front.ts";
import { IPIFY_HOST, STAND_EXIT_IP, STAND_SOCKS_USER } from "../shared.ts";
import { loadTopology } from "./context.ts";

async function get(socks: SocksConfig, host: string, path: string, ca: Buffer | undefined): Promise<string> {
  const raw = await socksConnect(socks, host, 443, 5000);
  raw.resume();
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ socket: raw, servername: host, ALPNProtocols: ["http/1.1"], ...(ca ? { ca } : {}) }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let answer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (answer += chunk));
    socket.on("end", () => resolve(answer));
    socket.on("error", reject);
    setTimeout(() => socket.destroy(new Error("no answer in 5 s")), 5000).unref();
  });
}

function noRoute(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = tcpConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("timeout");
    }, 3000);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(null);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(error.code ?? error.message);
    });
  });
}

const topology = loadTopology();
const socks: SocksConfig = { ip: topology.socksIp, port: topology.socksPort, username: STAND_SOCKS_USER, password: topology.socksPassword };
const ca = readFileSync(topology.caFile);
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: string) => results.push({ check: name, pass, detail });

const out = await noRoute("1.1.1.1", 443);
check("no route out of the stand", out !== null, out ?? "connected to 1.1.1.1:443");

try {
  await socksConnect(socks, "example.com", 443, 5000);
  check("the SOCKS5 connects only the stand's names", false, "example.com was connected");
} catch (error) {
  check("the SOCKS5 connects only the stand's names", error instanceof SocksError && error.kind === "refused", String(error));
}

for (const host of ["fansly.com", "apiv3.fansly.com"]) {
  try {
    const answer = await get(socks, host, host === "fansly.com" ? TRUST_PATH : "/api/v1/account/me", ca);
    const pass = host === "fansly.com" ? answer.includes(TRUST_MARKER) : /"stand":|pb-suite-stand/.test(answer);
    check(`${host} is the stand's, trusted with its CA`, pass, answer.split("\r\n")[0] ?? "");
  } catch (error) {
    check(`${host} is the stand's, trusted with its CA`, false, String(error));
  }
}

try {
  await get(socks, "fansly.com", TRUST_PATH, undefined);
  check("without the stand's CA its certificate is not trusted", false, "TLS passed with the public roots");
} catch (error) {
  check("without the stand's CA its certificate is not trusted", /certificate|self.signed|unable to verify|issuer/i.test(String(error)), String(error));
}

try {
  const answer = await get(socks, IPIFY_HOST, "/", ca);
  check("the exit-IP service answers the pinned address", answer.trim().endsWith(STAND_EXIT_IP), answer.split("\r\n")[0] ?? "");
} catch (error) {
  check("the exit-IP service answers the pinned address", false, String(error));
}

for (const result of results) console.log(`${result.pass ? "ok  " : "FAIL"} ${result.check}: ${result.detail}`);
process.exit(results.every((result) => result.pass) ? 0 : 1);
