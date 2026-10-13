// The watchdog's process (s6 service `watchdog`, as pb-operator: s6 lets
// that user kill the operator through its service). See watchdog.ts.

import { execFile } from "node:child_process";
import { statSync } from "node:fs";

import { parseStatus, shouldKill } from "./watchdog.ts";
import { envInt, envStr, errorMessage, makeLog } from "../shared/util.ts";

const log = makeLog("watchdog");
const SERVICE = envStr("PB_OPERATOR_SERVICE", "/run/service/operator");
const HEARTBEAT = envStr("PB_HEARTBEAT", "/run/pb/operator/alive");
const THRESHOLD_MS = envInt("PB_WATCHDOG_MS", 5000);

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 3000, encoding: "utf8" }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

function heartbeatAgeMs(): number | null {
  try {
    return Date.now() - statSync(HEARTBEAT).mtimeMs;
  } catch {
    return null;
  }
}

/** The pid last killed: one kill per hung process. */
let killed: number | null = null;
let checking = false;

async function check(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const status = parseStatus(await run("/command/s6-svstat", ["-o", "up,pid,updownfor", SERVICE]));
    const age = heartbeatAgeMs();
    if (status.pid === killed || !shouldKill({ status, heartbeatAgeMs: age, thresholdMs: THRESHOLD_MS })) return;
    killed = status.pid;
    log("kill", { pid: status.pid, heartbeatAgeMs: age === null ? null : Math.round(age), upForS: status.upForS });
    await run("/command/s6-svc", ["-k", SERVICE]);
  } catch (error) {
    log("check.failed", { error: errorMessage(error) });
  } finally {
    checking = false;
  }
}

setInterval(() => void check(), 500);
log("started", { service: SERVICE, heartbeat: HEARTBEAT, thresholdMs: THRESHOLD_MS });
