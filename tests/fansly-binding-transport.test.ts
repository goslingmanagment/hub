import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { inspectFanslyBinding } from "../apps/runtime/src/services/egress/fansly-binding-preflight.ts";
import { createProxyRequestDispatcher } from "../packages/shared/src/http-client.ts";
import { startFanslyProbeNetwork } from "./helpers/fansly-probe-network.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const ca = fileURLToPath(new URL("./fixtures/fansly-binding.cert.pem", import.meta.url));
const secret = "SYNTHETIC_AUTH_NEVER_EXPORT";
const body = JSON.stringify({ success: true, response: { account: { id: "123", checkToken: secret, email: "private@example.invalid" } } });
const child = `
import { createRequire } from "node:module";
import { inspectFanslyBinding } from "./apps/runtime/src/services/egress/fansly-binding-preflight.ts";
import { createProxyRequestDispatcher } from "./packages/shared/src/http-client.ts";
const require = createRequire(new URL("./apps/runtime/src/bootstrap.ts", import.meta.url));
const { Dispatcher, setGlobalDispatcher } = require("undici");
let fallbackCalls = 0, paceCalls = 0;
setGlobalDispatcher(new class extends Dispatcher {
  dispatch(options, handler) { fallbackCalls++; handler.onError(new Error("direct_refused")); return false; }
}());
const dispatcher = createProxyRequestDispatcher({ url: process.env.BINDING_TEST_PROXY,
  username: "fixture-user", password: "fixture-password" });
const deadline = setTimeout(() => process.exit(3), 18000);
const signal = process.env.BINDING_TEST_STOP === "cancel" ? { signal: AbortSignal.timeout(150) } : {};
// Deadline leg: record the deadline the preflight asks for, then honour it at
// 200ms so the leg does not sleep the real 15s. The parent pins the request.
const timeout = AbortSignal.timeout;
const deadlineRequestedMs = process.env.BINDING_TEST_STOP === "deadline" ? [] : null;
if (deadlineRequestedMs) AbortSignal.timeout = (ms) => { deadlineRequestedMs.push(ms); return timeout.call(AbortSignal, 200); };
try {
  const result = await inspectFanslyBinding({
    session: { authorization: "SYNTHETIC_AUTH_NEVER_EXPORT", fanslyClientId: "fixture-client" },
    expectedAccountId: "123",
    egress: { dispatcher, egressKey: "fixture-page", pace: async () => { paceCalls++; throw new Error("pacing_forbidden"); }, close: () => dispatcher.close() },
    ...signal,
  });
  process.stdout.write(JSON.stringify({ result, fallbackCalls, paceCalls, ...(deadlineRequestedMs ? { deadlineRequestedMs } : {}) }));
} finally { AbortSignal.timeout = timeout; clearTimeout(deadline); await dispatcher.destroy(); }
`;
async function run(proxy: string, stop: "cancel" | "deadline" | null = null, trust = true) {
  const env: NodeJS.ProcessEnv = { ...process.env, BINDING_TEST_PROXY: proxy, BINDING_TEST_STOP: stop ?? "" };
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete env.NODE_EXTRA_CA_CERTS;
  if (trust) env.NODE_EXTRA_CA_CERTS = ca;
  const output = await exec(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", child], {
    cwd: root, env, timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 8192,
  });
  expect(output.stdout + output.stderr).not.toContain(secret);
  expect(output.stdout + output.stderr).not.toContain("private@example.invalid");
  return JSON.parse(output.stdout) as { result: Awaited<ReturnType<typeof inspectFanslyBinding>>;
    fallbackCalls: number; paceCalls: number; deadlineRequestedMs?: number[] };
}

describe("bounded Fansly REST binding transport", () => {
  it.for(["http", "socks5"] as const)("%s uses its exact dedicated proxy for one fixed GET", async (protocol, t) => {
    const network = await startFanslyProbeNetwork(protocol, false, { status: 200, body });
    if (!network) { t.skip(); return; }
    try {
      expect(await run(network.url)).toEqual({ result: { identityMatched: true, observedAccountId: "123",
        httpStatus: 200, restRequests: 1, reason: "matched" }, fallbackCalls: 0, paceCalls: 0 });
      expect(network.destinations).toEqual(["apiv3.fansly.com:443"]);
      expect(network.requests).toHaveLength(1);
      expect(network.requests[0]).toMatchObject({ method: "GET", url: "/api/v1/account/me?ngsw-bypass=true",
        headers: { host: "apiv3.fansly.com", authorization: secret, "fansly-client-id": "fixture-client" } });
      expect(network.upgrades).toEqual([]);
    } finally { await network.stop(); }
  });

  it.for([
    { status: 401, body: secret, reason: "http_rejected" },
    { status: 429, body: secret, reason: "http_rejected" },
    { status: 503, body: secret, reason: "http_rejected" },
    { status: 302, location: "https://example.invalid/leak", reason: "http_rejected" },
    { status: 200, body: JSON.stringify({ success: true, response: { account: { id: "456" } } }), reason: "account_mismatch" },
    { status: 200, body: JSON.stringify({ success: true, response: { account: { checkToken: secret } } }), reason: "invalid_response" },
    { status: 200, body: secret, reason: "invalid_response" },
    { status: 200, body: "x".repeat(1024 * 1024 + 1), reason: "body_limit" },
  ])("refuses $status/$reason without retry, redirect or body export", async ({ reason, ...response }, t) => {
    const network = await startFanslyProbeNetwork("http", false, response);
    if (!network) { t.skip(); return; }
    try {
      expect(await run(network.url)).toMatchObject({ result: { identityMatched: false, restRequests: 1, reason }, fallbackCalls: 0, paceCalls: 0 });
      expect(network.requests).toHaveLength(1);
      expect(network.destinations).toEqual(["apiv3.fansly.com:443"]);
    } finally { await network.stop(); }
  });

  it.for(["cancel", "deadline"] as const)("bounds a hanging response with %s", async (stop, t) => {
    const network = await startFanslyProbeNetwork("socks5", false, { status: 200, hang: true });
    if (!network) { t.skip(); return; }
    try {
      expect(await run(network.url, stop)).toMatchObject({
        result: { identityMatched: false, reason: "request_failed", restRequests: 1 }, fallbackCalls: 0, paceCalls: 0,
        // With no caller signal, the one deadline bounding the hang is the
        // preflight's own 15s: the child shortens only the wait, not the ask.
        ...(stop === "deadline" ? { deadlineRequestedMs: [15_000] } : {}),
      });
      expect(network.requests).toHaveLength(1);
    } finally { await network.stop(); }
  });

  it.for(["proxy", "tls"])("fails closed for %s failure", async (failure, t) => {
    const network = await startFanslyProbeNetwork("http", failure === "proxy", { status: 200, body });
    if (!network) { t.skip(); return; }
    try {
      expect(await run(network.url, null, failure !== "tls")).toMatchObject({
        result: { reason: "request_failed", restRequests: 1 }, fallbackCalls: 0, paceCalls: 0,
      });
      expect(network.requests).toEqual([]);
    } finally { await network.stop(); }
  });

  it("rejects missing binding or non-page egress before dispatch and counts header failures as zero attempts", async () => {
    const dispatcher = createProxyRequestDispatcher({ url: "http://127.0.0.1:1" });
    const egress = { dispatcher, egressKey: "fixture-page", pace: vi.fn(), close: () => dispatcher.close() };
    try {
      expect(await inspectFanslyBinding({ session: { authorization: secret }, expectedAccountId: null, egress }))
        .toMatchObject({ reason: "missing_expected_account", restRequests: 0 });
      expect(await inspectFanslyBinding({ session: { authorization: secret }, expectedAccountId: "123", egress: { ...egress, egressKey: "direct" } }))
        .toMatchObject({ reason: "invalid_page_egress", restRequests: 0 });
      const session = { get authorization(): string { throw new Error(secret); } };
      expect(await inspectFanslyBinding({ session, expectedAccountId: "123", egress }))
        .toMatchObject({ reason: "request_failed", restRequests: 0 });
      expect(egress.pace).not.toHaveBeenCalled();
    } finally { await dispatcher.destroy(); }
  });
});
