// The control "leak": requests that reach the stand's Fansly with no
// admission at all — sent by the runner itself through the page's SOCKS5,
// as a browser that slipped past the operator would. A run that does this
// must fail the criteria; if it passes, the criteria cannot see a leak.

import { readFileSync } from "node:fs";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

import { socksConnect, type SocksConfig } from "../../src/egress/socks5.ts";
import { clientHandshake } from "../../src/shared/ws.ts";
import { sleep } from "../shared.ts";

async function tls(socks: SocksConfig, host: string, ca: Buffer): Promise<TLSSocket> {
  const raw = await socksConnect(socks, host, 443, 10_000);
  raw.resume();
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ socket: raw, servername: host, ca, ALPNProtocols: ["http/1.1"] }, () => resolve(socket));
    socket.once("error", reject);
  });
}

async function http(socks: SocksConfig, ca: Buffer, method: string, host: string, path: string): Promise<string> {
  const socket = await tls(socks, host, ca);
  return new Promise((resolve) => {
    let answer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (answer += chunk));
    socket.on("end", () => resolve(answer.split("\r\n")[0] ?? ""));
    socket.on("error", () => resolve(answer.split("\r\n")[0] ?? ""));
    socket.write(`${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  });
}

/** One read, one closed write, and a socket with a forbidden message — none
 *  of them admitted. */
export async function leak(socks: SocksConfig, caFile: string, rid: string): Promise<string[]> {
  const ca = readFileSync(caFile);
  const seen: string[] = [];
  seen.push(`GET: ${await http(socks, ca, "GET", "apiv3.fansly.com", `/api/v1/account/me?rid=${rid}`)}`);
  seen.push(`POST: ${await http(socks, ca, "POST", "apiv3.fansly.com", `/api/v1/message/ack?rid=${rid}`)}`);
  const socket = await tls(socks, "wsv3.fansly.com", ca);
  const ws = await clientHandshake(socket, "wsv3.fansly.com", "/?v=3", 1024 * 1024);
  ws.sendText(JSON.stringify({ t: 46001, d: JSON.stringify({ chatRoomId: rid }) }));
  await sleep(300);
  ws.close(1000);
  seen.push("socket: opened, a forbidden message sent");
  return seen;
}
