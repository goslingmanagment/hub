import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createProxyRequestDispatcher } from "../packages/shared/src/http-client.ts";
import { openFanslyProbeSocket } from "../apps/runtime/src/services/egress/fansly-probe-socket.ts";
import type { AppEgressContext } from "../apps/runtime/src/services/egress/resolver.ts";
import { startFanslyProbeNetwork } from "./helpers/fansly-probe-network.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const ca = fileURLToPath(new URL("./fixtures/fansly-probe.cert.pem", import.meta.url));

// A fresh child is necessary: Node reads NODE_EXTRA_CA_CERTS only at startup.
// The global dispatcher refuses all traffic, so a routing regression cannot
// accidentally contact Fansly. Both real proxy transports still verify TLS.
const client = `
import { createRequire } from "node:module";
import { createProxyRequestDispatcher } from "./packages/shared/src/http-client.ts";
import { openFanslyProbeSocket } from "./apps/runtime/src/services/egress/fansly-probe-socket.ts";
import { createProbeTransportDiagnostics } from "./apps/runtime/src/services/egress/fansly-probe-diagnostics.ts";
import { createTestFanslySendGuards } from "./tests/helpers/fansly-send-guard.ts";
const require = createRequire(new URL("./apps/runtime/src/bootstrap.ts", import.meta.url));
const { Dispatcher, setGlobalDispatcher } = require("undici");
let fallbackCalls = 0, paceCalls = 0;
setGlobalDispatcher(new class extends Dispatcher {
  dispatch(options, handler) {
    fallbackCalls++;
    handler.onError(new Error("global_dispatch_refused"));
    return false;
  }
}());
const dispatcher = createProxyRequestDispatcher({
  url: process.env.PROBE_TEST_PROXY,
  username: "fixture-user", password: "fixture-password",
});
const deadline = setTimeout(() => process.exit(3), 15_000);
const result = { opened: false, message: null, closeCode: null, error: false };
const diagnostics = createProbeTransportDiagnostics();
// Plan §2.5: the handshake is one capture of the page's send guard.
const { registry, store } = createTestFanslySendGuards();
const lease = await registry.forPage(7, "ws_probe").acquire({ operation: "ws_probe", requestTimeoutMs: 10_000 });
const socket = openFanslyProbeSocket({
  dispatcher, egressKey: "fixture-page",
  pace: async () => { paceCalls++; throw new Error("REST_pacing_forbidden"); },
  close: () => dispatcher.close(),
}, lease, diagnostics);
socket.addEventListener("open", () => { result.opened = true; });
socket.addEventListener("message", (event) => {
  result.message = event.data;
  socket.close(1000);
});
socket.addEventListener("error", () => { result.error = true; });
await new Promise((resolve) => socket.addEventListener("close", (event) => {
  result.closeCode = event.code;
  resolve();
}, { once: true }));
await dispatcher.destroy();
await lease.complete({ outcome: lease.sent ? "transport_error" : "aborted_before_send" });
await registry.drain();
clearTimeout(deadline);
process.stdout.write(JSON.stringify({ ...result, fallbackCalls, paceCalls, url: socket.url,
  diagnostics: diagnostics.finish(),
  journal: store.journal.map((row) => ({ source: row.source, outcome: row.outcome, httpStatus: row.httpStatus,
    sent: row.sentAt !== null })) }));
`;

async function runClient(proxy: string, trustFixture: boolean) {
  const env: NodeJS.ProcessEnv = { ...process.env, PROBE_TEST_PROXY: proxy };
  // Never inherit a TLS bypass or another test's extra CA configuration.
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete env.NODE_EXTRA_CA_CERTS;
  if (trustFixture) env.NODE_EXTRA_CA_CERTS = ca;
  const { stdout } = await exec(process.execPath, [
    "--import", "tsx/esm", "--input-type=module", "-e", client,
  // Hang guards, not speed checks: a cold `tsx` import alone took over 4 s on a loaded
  // CI machine (run 36611934822), so the child gets 15 s and the parent kills it at 20 s.
  ], { cwd: root, env, timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 4096 });
  return JSON.parse(stdout) as {
    opened: boolean; message: string | null; closeCode: number; error: boolean;
    fallbackCalls: number; paceCalls: number; url: string;
    diagnostics: { httpStatus: number | null; transportErrorCode: string | null };
    journal: Array<{ source: string; outcome: string | null; httpStatus: number | null; sent: boolean }>;
  };
}

/** A lease that is never used: these cases refuse before any dispatch. */
const unusedLease = {
  token: "unused", pageId: 7, sent: false, sendRefused: false,
  bind: () => { throw new Error("bind_unexpected"); },
  complete: async () => undefined,
};

describe("one-page Fansly probe transport", () => {
  it.each(["", "direct", "vendor:ofapi", "service:socks5://fixture", "legacy-page:fixture"])(
    "refuses non-page egress identity %s before opening", async (egressKey) => {
      const dispatcher = createProxyRequestDispatcher({ url: "http://127.0.0.1:1" });
      const egress: AppEgressContext = {
        egressKey, dispatcher, pace: vi.fn(), close: () => dispatcher.close(),
      };
      try {
        expect(() => openFanslyProbeSocket(egress, unusedLease)).toThrow("fansly_probe_page_egress_required");
        expect(egress.pace).not.toHaveBeenCalled();
      } finally { await dispatcher.destroy(); }
    },
  );

  it("refuses a missing dispatcher", () => {
    expect(() => openFanslyProbeSocket({
      egressKey: "fixture-page", dispatcher: null, pace: vi.fn(), close: vi.fn(),
    }, unusedLease)).toThrow("fansly_probe_page_egress_required");
  });

  describe.each(["http", "socks5"] as const)("%s page proxy", (protocol) => {
    it("performs a TLS WebSocket handshake and closes without direct fallback or auth headers", async (t) => {
      const network = await startFanslyProbeNetwork(protocol);
      if (!network) { t.skip(); return; }
      try {
        expect(await runClient(network.url, true)).toEqual({
          opened: true, message: '{"t":2,"d":"{}"}', closeCode: 1000, error: false,
          fallbackCalls: 0, paceCalls: 0, url: "wss://wsv3.fansly.com/?v=3",
          diagnostics: { httpStatus: 101, transportErrorCode: null },
          // One capture, sent once, completed at the 101.
          journal: [{ source: "ws_probe", outcome: "response", httpStatus: 101, sent: true }],
        });
        expect(network.destinations).toEqual(["wsv3.fansly.com:443"]);
        expect(network.upgrades).toHaveLength(1);
        const request = network.upgrades[0]!;
        expect(request.url).toBe("/?v=3");
        expect(request.headers.origin).toBe("https://fansly.com");
        expect(request.headers.host).toBe("wsv3.fansly.com");
        expect(Object.keys(request.headers).filter((key) =>
          /authorization|cookie|^fansly-/i.test(key))).toEqual([]);
        expect(JSON.stringify(request.headers)).not.toContain(network.password);
        expect(network.frames).toEqual([8]); // Only the caller's close control frame.
      } finally { await network.stop(); }
    }, 10_000);

    it.for(["proxy_refused", "untrusted_tls"])("fails closed for %s", async (failure, t) => {
      const network = await startFanslyProbeNetwork(protocol, failure === "proxy_refused");
      if (!network) { t.skip(); return; }
      try {
        const result = await runClient(network.url, failure !== "untrusted_tls");
        expect(result).toMatchObject({
          opened: false, message: null, error: true, fallbackCalls: 0, paceCalls: 0,
          diagnostics: { httpStatus: null, transportErrorCode: failure === "untrusted_tls"
            ? "DEPTH_ZERO_SELF_SIGNED_CERT" : protocol === "http" ? "UND_ERR_ABORTED" : null },
        });
        expect(JSON.stringify(result)).not.toContain(network.password);
        expect(network.destinations).toEqual(["wsv3.fansly.com:443"]);
        expect(network.upgrades).toEqual([]);
        // The capture completes whatever happened; nothing reached the origin.
        expect(result.journal).toEqual([{ source: "ws_probe", outcome: "transport_error", httpStatus: null, sent: false }]);
      } finally { await network.stop(); }
    });

    it("retains an outer HTTP rejection without its headers or a fabricated open", async (t) => {
      const network = await startFanslyProbeNetwork(protocol, false, undefined, 403);
      if (!network) { t.skip(); return; }
      try {
        const result = await runClient(network.url, true);
        expect(result).toMatchObject({ opened: false, message: null, error: true,
          fallbackCalls: 0, paceCalls: 0, diagnostics: { httpStatus: 403 } });
        expect(JSON.stringify(result)).not.toContain("fixture-provider-secret");
        expect(JSON.stringify(result)).not.toContain(network.password);
        expect(network.destinations).toEqual(["wsv3.fansly.com:443"]);
        expect(network.upgrades).toHaveLength(1);
        expect(network.frames).toEqual([]);
        expect(result.journal).toEqual([{ source: "ws_probe", outcome: "response", httpStatus: 403, sent: true }]);
      } finally { await network.stop(); }
    }, 10_000);
  });
});
