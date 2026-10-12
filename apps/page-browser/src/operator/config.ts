// Where the operator finds things in the page's container. Everything the
// page itself is configured with — its SOCKS5, pinned exit IP, environment,
// parameters — comes from the engine's hello (plan §4.13), not from here.

import { readFileSync } from "node:fs";

import { envInt, envStr } from "../shared/util.ts";

export interface OperatorConfig {
  /** The CDP holder's unix socket. */
  holderSock: string;
  proxyHost: string;
  proxyPort: number;
  rpcHost: string;
  rpcPort: number;
  /** The page's RPC token: the engine's hello must carry it. */
  rpcToken: string;
  /** The kernel check's result (s6 service net-selftest). */
  netSelftestPath: string;
  /** The journals (plan §4.11), on the buffer volume. */
  logDir: string;
  /** The operator's small state on the buffer volume: the buffer's id, the
   *  highest owner generation accepted. */
  stateDir: string;
  /** Touched every second; the watchdog kills an operator that stops. */
  heartbeatPath: string | null;
  operatorVersion: string;
}

const MIN_TOKEN_LENGTH = 32;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OperatorConfig {
  const tokenFile = env.PB_RPC_TOKEN_FILE || "/run/pb/operator/rpc_token";
  let rpcToken: string;
  try {
    rpcToken = readFileSync(tokenFile, "utf8").trim();
  } catch {
    throw new Error(`no RPC token in ${tokenFile}`);
  }
  if (rpcToken.length < MIN_TOKEN_LENGTH) throw new Error(`the RPC token in ${tokenFile} is shorter than ${MIN_TOKEN_LENGTH} characters`);
  return {
    holderSock: envStr("PB_HOLDER_SOCK", "/run/pb/operator/holder.sock"),
    proxyHost: "127.0.0.1",
    proxyPort: envInt("PB_PROXY_PORT", 3128),
    // The container's address in pb-control (plan §3.1): not on pb-egress.
    rpcHost: envStr("PB_RPC_HOST", "0.0.0.0"),
    rpcPort: envInt("PB_RPC_PORT", 7700),
    rpcToken,
    netSelftestPath: envStr("PB_NET_SELFTEST", "/run/pb/net-selftest.json"),
    logDir: envStr("PB_LOG_DIR", "/data/buffer/logs"),
    stateDir: envStr("PB_STATE_DIR", "/data/buffer/operator"),
    heartbeatPath: envStr("PB_HEARTBEAT", "/run/pb/operator/alive"),
    operatorVersion: envStr("PB_OPERATOR_VERSION", "dev"),
  };
}
