// The controls' lever inside the page container: traffic from the page's
// own address through its SOCKS5, past the operator's proxy — as the
// operator's own user, the only one the page's rules let reach the SOCKS5.
// It is what an operator that broke a rule would look like to the stand.
//
//   node --no-warnings /opt/page-browser/stand/inside/lever.ts '<json>'
//
//   { socks, ca, sockets: { host, path, opens, keepMs } }
//       the site's socket, `opens` times in a row, each kept open `keepMs`:
//       control-double-open (one admission, two sockets) and
//       control-lost-frames (frames the stand sends into a socket the
//       engine never hears of)
//   { socks, ca, request: { host, path, timeoutMs } }
//       one GET, sent as soon as the SOCKS5 answers the CONNECT — however
//       long it held it (up to `timeoutMs`): control-held-late, a request
//       that goes after its admission ran out; control-lost-frames, a site
//       answer whose event never reaches the engine
//   Both may be given: the sockets first, then the request.
//
// Started as root by the runner (docker exec), it drops to pb-operator
// first. The login it gets is a one-time one the stand's SOCKS5 takes only
// while the control runs; the page's own is never passed here. It uses the
// image's own SOCKS5 and WebSocket code (src/egress, src/shared).

import { readFileSync } from "node:fs";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

import { socksConnect, type SocksConfig } from "../../src/egress/socks5.ts";
import { clientHandshake } from "../../src/shared/ws.ts";

interface Lever {
  socks: SocksConfig;
  ca: string;
  sockets?: { host: string; path: string; opens: number; keepMs: number };
  request?: { host: string; path: string; timeoutMs: number };
}

const lever = JSON.parse(process.argv[2] ?? "{}") as Lever;
if (process.getuid?.() === 0) {
  process.setgid?.("pb-operator");
  process.setuid?.("pb-operator");
}
const ca = readFileSync(lever.ca);

async function tls(host: string, timeoutMs: number): Promise<TLSSocket> {
  const raw = await socksConnect(lever.socks, host, 443, timeoutMs);
  raw.resume();
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ socket: raw, servername: host, ca, ALPNProtocols: ["http/1.1"] }, () => resolve(socket));
    socket.once("error", reject);
  });
}

const failed = (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`;
const results: string[] = [];

if (lever.sockets) {
  const { host, path, opens, keepMs } = lever.sockets;
  for (let n = 0; n < opens; n++) {
    try {
      const ws = await clientHandshake(await tls(host, 10_000), host, path, 1024 * 1024);
      ws.sendText("p");
      await new Promise((resolve) => setTimeout(resolve, keepMs));
      ws.close(1000);
      results.push("opened");
    } catch (error) {
      results.push(failed(error));
    }
  }
}

if (lever.request) {
  const { host, path, timeoutMs } = lever.request;
  try {
    const socket = await tls(host, timeoutMs);
    results.push(
      await new Promise<string>((resolve) => {
        let answer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => (answer += chunk));
        socket.on("end", () => resolve(answer.split("\r\n")[0] ?? ""));
        socket.on("error", () => resolve(answer.split("\r\n")[0] ?? ""));
        socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAccept: application/json\r\nConnection: close\r\n\r\n`);
      }),
    );
  } catch (error) {
    results.push(failed(error));
  }
}

console.log(JSON.stringify(results));
process.exit(0);
