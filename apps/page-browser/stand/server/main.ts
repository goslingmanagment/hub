// Project Browser stand server: the only "internet" of the stand.
//
//   :443   TLS front (h2 + http/1.1) for site/api/ws/cdn.stand.test and api.ipify.org
//   :80    the same over plain HTTP/1.1
//   :1080  SOCKS5 with username/password; the browser's only way out
//   :8080  control API (journal, faults, WebSocket push, config)
//
// The journal is the ground truth of what physically reached the stand; see
// README.md for the event schema. Run:
//   node --experimental-strip-types --no-warnings main.ts

import tls from "node:tls";
import { ensureCerts } from "./certs.ts";
import { errorText } from "./conn.ts";
import { createControlServer } from "./control.ts";
import { FaultStore } from "./faults.ts";
import { Journal } from "./journal.ts";
import { Router } from "./routes.ts";
import type { StandConfig } from "./routes.ts";
import { SocksServer } from "./socks5.ts";
import { Front } from "./tls-front.ts";
import { WsRegistry } from "./websocket.ts";

const env = process.env;
const ports = {
  tls: intEnv("STAND_TLS_PORT", 443),
  http: intEnv("STAND_HTTP_PORT", 80),
  socks: intEnv("STAND_SOCKS_PORT", 1080),
  control: intEnv("STAND_CONTROL_PORT", 8080),
};
const caDir = env.STAND_CA_DIR ?? "/stand/ca";
const pagesDir = env.STAND_PAGES_DIR ?? "/stand/pages";

const journal = new Journal({
  maxEvents: intEnv("STAND_JOURNAL_MAX", 250_000),
  echo: env.STAND_JOURNAL_STDOUT === "1",
});

// PID 1 in a container: exit on the stop signal instead of waiting for SIGKILL.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));

const certs = ensureCerts(caDir);
const config: StandConfig = { corsMaxAge: 0, exitIp: "203.0.113.7", h1Hosts: [] };
const faults = new FaultStore();
const ws = new WsRegistry(journal);
const router = new Router({ journal, faults, config, pagesDir, ws });
const front = new Front({
  journal,
  faults,
  router,
  // One context for all connections, so TLS session tickets resume across them.
  secureContext: tls.createSecureContext({ key: certs.key, cert: certs.cert }),
  alpnFor: (servername) => (servername && config.h1Hosts.includes(servername) ? ["http/1.1"] : ["h2", "http/1.1"]),
  keepAliveTimeoutMs: intEnv("STAND_H1_KEEPALIVE_MS", 75_000),
});

const STAND_DOMAIN = /^([a-z0-9-]+\.)*stand\.test$/;
const socks = new SocksServer({
  port: ports.socks,
  user: env.STAND_SOCKS_USER ?? "pb",
  pass: env.STAND_SOCKS_PASS ?? "pb-secret",
  journal,
  faults,
  // Names only (ATYP domain): IP literals and other hosts are "not allowed".
  route: (host, port, atyp) => {
    if (atyp !== 3) return null;
    const name = host.toLowerCase().replace(/\.$/, "");
    if (!STAND_DOMAIN.test(name) && name !== "api.ipify.org") return null;
    if (port === 443) return { host: "127.0.0.1", port: ports.tls };
    if (port === 80) return { host: "127.0.0.1", port: ports.http };
    return null;
  },
  upstreamPorts: {
    register: (localPort, socksId) => front.registerSocksUpstream(localPort, socksId),
    unregister: (localPort) => front.unregisterSocksUpstream(localPort),
  },
});

await front.listen(ports.tls, true);
await front.listen(ports.http, false);
await socks.start();
const control = createControlServer({ journal, faults, config, ws, socks, front });
await new Promise<void>((resolve) => control.listen(ports.control, resolve));

// From here on a test instrument keeps running: a crash would lose the
// journal. Errors are journaled so a scenario can assert there were none.
// (Startup errors above still crash the process, as they should.)
process.on("uncaughtException", (err) => {
  console.error("stand: uncaught exception", err);
  journal.log("server.error", { where: "uncaughtException", error: err.stack ?? errorText(err) });
});
process.on("unhandledRejection", (reason) => {
  console.error("stand: unhandled rejection", reason);
  journal.log("server.error", { where: "unhandledRejection", error: errorText(reason) });
});

journal.log("server.start", { ports, caDir, pagesDir, certs: certs.created });
console.log(
  `stand: TLS :${ports.tls}, HTTP :${ports.http}, SOCKS5 :${ports.socks}, control :${ports.control}; ` +
    `CA ${certs.caCertPath}${certs.created.ca ? " (new)" : ""}, leaf${certs.created.leaf ? " (new)" : ""}; pages ${pagesDir}`,
);

function intEnv(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  return value;
}
