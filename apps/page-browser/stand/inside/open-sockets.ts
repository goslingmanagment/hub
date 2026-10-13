// A control's lever inside the page container (control-double-open): opens
// the site's socket through the page's SOCKS5 several times in a row, past
// the operator's proxy — as the operator's own user, the only one the page's
// rules let reach the SOCKS5. The stand admits one socket; the criteria must
// see the second one as a repeat under that admission.
//
//   node --no-warnings /opt/page-browser/stand/inside/open-sockets.ts '<json>'
//   { socks: { ip, port, username, password }, host, path, opens, ca }
//
// Started as root by the runner (docker exec), it drops to pb-operator
// first. The login it gets is a one-time one the stand's SOCKS5 takes only
// while the control runs; the page's own is never passed here. It uses the
// image's own SOCKS5 and WebSocket code (src/egress, src/shared).

import { readFileSync } from "node:fs";
import { connect as tlsConnect } from "node:tls";

import { socksConnect, type SocksConfig } from "../../src/egress/socks5.ts";
import { clientHandshake } from "../../src/shared/ws.ts";

interface Request {
  socks: SocksConfig;
  host: string;
  path: string;
  opens: number;
  ca: string;
}

const request = JSON.parse(process.argv[2] ?? "{}") as Request;
if (process.getuid?.() === 0) {
  process.setgid?.("pb-operator");
  process.setuid?.("pb-operator");
}
const ca = readFileSync(request.ca);
const results: string[] = [];
for (let n = 0; n < request.opens; n++) {
  try {
    const raw = await socksConnect(request.socks, request.host, 443, 10_000);
    raw.resume();
    const socket = await new Promise<ReturnType<typeof tlsConnect>>((resolve, reject) => {
      const tls = tlsConnect({ socket: raw, servername: request.host, ca, ALPNProtocols: ["http/1.1"] }, () => resolve(tls));
      tls.once("error", reject);
    });
    const ws = await clientHandshake(socket, request.host, request.path, 1024 * 1024);
    ws.sendText("p");
    await new Promise((resolve) => setTimeout(resolve, 300));
    ws.close(1000);
    results.push("opened");
  } catch (error) {
    results.push(`failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(JSON.stringify(results));
process.exit(0);
