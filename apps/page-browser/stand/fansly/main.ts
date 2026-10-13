// The stand's Fansly (plan §5, stage 2: "источник нагрузки — сервер стенда в
// роли Fansly"): the page container's only internet.
//
//   <egress>:1080   SOCKS5 with the page's login and password — the page's
//                   exit. It connects Fansly's names and api.ipify.org to
//                   the front below, and nothing else to anything.
//   127.0.0.1:*     the TLS front behind it (front.ts): the API, the site,
//                   the socket, media, the exit-IP service
//   <egress>:443    the direct listener: what comes here came past the proxy
//   <control>:8080  the runner's control (control.ts): the journal, the
//                   faults, the answers' settings
//
// Run in the stand's tools image:
//   node --no-warnings /pb/stand/fansly/main.ts
// STAND_SOCKS_PASSWORD_FILE holds the page's SOCKS5 password (made by
// stand.sh for this stand; the runner hands the same to the operator in its
// hello).

import { readFileSync } from "node:fs";

import { STAND_ACCOUNT_ID, STAND_EXIT_IP, STAND_SOCKS_USER } from "../shared.ts";
import { ensureCerts } from "./certs.ts";
import { startControl } from "./control.ts";
import { Front, roleOf, type FrontConfig } from "./front.ts";
import { Journal } from "./journal.ts";
import { StandSocks } from "./socks.ts";

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback === undefined) throw new Error(`${name} is not set`);
  return fallback;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));

const journal = new Journal(Number(env("STAND_JOURNAL_MAX", "500000")));
const certs = ensureCerts(env("STAND_PRIVATE_DIR", "/stand/private"), env("STAND_CA_DIR", "/stand/ca"));
const config: FrontConfig = { exitIp: env("STAND_EXIT_IP", STAND_EXIT_IP), accountId: env("STAND_ACCOUNT_ID", STAND_ACCOUNT_ID), corsMaxAge: 0, wsPush: { perMinute: 0, bytes: 256 }, site: null };
const defaults: FrontConfig = structuredClone(config);

let frontPort = 0;
const socks = new StandSocks({
  listenHost: env("STAND_EGRESS_IP"),
  port: Number(env("STAND_SOCKS_PORT", "1080")),
  username: env("STAND_SOCKS_USER", STAND_SOCKS_USER),
  password: readFileSync(env("STAND_SOCKS_PASSWORD_FILE", "/run/secrets/stand_socks_password"), "utf8").trim(),
  journal,
  // TLS on 443 to a name of the stand; nothing else has a route.
  route: (host, port) => (port === 443 && roleOf(host) !== null ? frontPort : null),
});
const front = new Front({ key: certs.key, cert: certs.cert, journal, config, metaOf: (port) => socks.metaOf(port) });

frontPort = await front.listenLoopback();
await front.listenDirect(env("STAND_EGRESS_IP"), 443);
await socks.listen();
await startControl({ host: env("STAND_CONTROL_IP"), port: Number(env("STAND_CONTROL_PORT", "8080")), journal, config, defaults, socks, front });

// From here on the instrument keeps running: a crash would lose the journal.
process.on("uncaughtException", (error) => {
  console.error("stand fansly: uncaught", error);
  journal.log("server.error", { where: "uncaughtException", error: error.stack ?? String(error) });
});
process.on("unhandledRejection", (reason) => {
  console.error("stand fansly: unhandled", reason);
  journal.log("server.error", { where: "unhandledRejection", error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason) });
});

journal.log("server.start", { caCreated: certs.created });
console.log(`stand fansly: SOCKS5 ${env("STAND_EGRESS_IP")}:${env("STAND_SOCKS_PORT", "1080")}, control ${env("STAND_CONTROL_IP")}:${env("STAND_CONTROL_PORT", "8080")}, CA ${certs.caCertPath}${certs.created ? " (new)" : ""}`);
