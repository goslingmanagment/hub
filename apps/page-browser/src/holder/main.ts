// The CDP holder's process (s6 service `cdp-holder`, as pb-operator). See
// holder.ts. Over its store limit it kills Chrome through s6: pb-operator may
// control that one service (s6/scripts/chrome-control), and -K kills the
// whole process group at once.

import { execFile } from "node:child_process";

import { Holder } from "./holder.ts";
import { envInt, envStr, errorMessage, makeLog } from "../shared/util.ts";

const log = makeLog("holder");
const CHROME_SERVICE = envStr("PB_CHROME_SERVICE", "/run/service/chrome");

function killChrome(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/command/s6-svc", ["-K", "-d", CHROME_SERVICE], { timeout: 3000 }, (error) => (error ? reject(error) : resolve()));
  });
}

const holder = new Holder({
  cdpHost: "127.0.0.1",
  cdpPort: envInt("PB_CDP_PORT", 9222),
  socketPath: envStr("PB_HOLDER_SOCK", "/run/pb/operator/holder.sock"),
  maxBytes: envInt("PB_HOLDER_MAX_BYTES", 128 * 1024 * 1024),
  killChrome,
  allowFaults: process.env.PB_STAND_FAULTS === "1",
  onExit: (code) => process.exit(code),
  log,
});

process.on("SIGTERM", () => void holder.stop());
process.on("uncaughtException", (error) => {
  log("uncaught", { error: errorMessage(error) });
  process.exit(1);
});
await holder.start();
