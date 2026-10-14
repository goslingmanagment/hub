// Where the operator finds things in the page's container. Everything the
// page itself is configured with — its SOCKS5, pinned exit IP, environment,
// parameters — comes from the engine's hello (plan §4.13), not from here.

import { readFileSync } from "node:fs";

import { HANDOVER_PATH } from "../env/handover.ts";
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
  /** The API's own token for the login form's calls (plan §4.8, PR 15);
   *  null: the container has none — every call is refused. Never the
   *  engine's. Absent: as null. */
  apiToken?: string | null;
  /** The kernel check's result (s6 service net-selftest). */
  netSelftestPath: string;
  /** The page's environment for Chrome's start (env/handover.ts). */
  chromeEnvPath: string;
  /** The journals (plan §4.11), on the buffer volume. */
  logDir: string;
  /** The operator's small state on the buffer volume: a copy of the
   *  buffer's id, the highest owner generation accepted. */
  stateDir: string;
  /** The buffer's database (plan §4.4; buffer/), on the buffer volume. */
  bufferDir: string;
  /** The rules extension's package (extension/build.ts), served to
   *  Chrome's policy on the proxy's port. */
  extensionDir: string;
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
  const apiTokenFile = env.PB_API_TOKEN_FILE || "/run/pb/operator/api_token";
  let apiToken: string | null;
  try {
    apiToken = readFileSync(apiTokenFile, "utf8").trim();
  } catch {
    // A container made before PR 15: no login form, the rest runs.
    apiToken = null;
  }
  if (apiToken !== null && apiToken.length < MIN_TOKEN_LENGTH) throw new Error(`the API token in ${apiTokenFile} is shorter than ${MIN_TOKEN_LENGTH} characters`);
  if (apiToken !== null && apiToken === rpcToken) throw new Error("the API token is the engine's RPC token: each must be its own");
  return {
    holderSock: envStr("PB_HOLDER_SOCK", "/run/pb/operator/holder.sock"),
    proxyHost: "127.0.0.1",
    proxyPort: envInt("PB_PROXY_PORT", 3128),
    // The container's address in pb-control (plan §3.1): not on pb-egress.
    rpcHost: envStr("PB_RPC_HOST", "0.0.0.0"),
    rpcPort: envInt("PB_RPC_PORT", 7700),
    rpcToken,
    apiToken,
    netSelftestPath: envStr("PB_NET_SELFTEST", "/run/pb/net-selftest.json"),
    chromeEnvPath: envStr("PB_CHROME_ENV", HANDOVER_PATH),
    logDir: envStr("PB_LOG_DIR", "/data/buffer/logs"),
    stateDir: envStr("PB_STATE_DIR", "/data/buffer/operator"),
    bufferDir: envStr("PB_BUFFER_DIR", "/data/buffer/store"),
    extensionDir: envStr("PB_EXTENSION_DIR", "/opt/page-browser/extension/dist"),
    heartbeatPath: envStr("PB_HEARTBEAT", "/run/pb/operator/alive"),
    operatorVersion: envStr("PB_OPERATOR_VERSION", "dev"),
  };
}
