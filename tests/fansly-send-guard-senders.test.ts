import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

// Plan §2.4/§2.5 for the senders outside the adapter: the AI describer's CDN
// download rides the page's egress through the page's send guard. The real
// path: Node's global fetch (production's), the shared proxy dispatcher, a
// CONNECT proxy and a TLS origin standing in for cdn*.fansly.com. A fresh child
// process trusts the test CA (Node reads NODE_EXTRA_CA_CERTS at start only);
// its global dispatcher refuses everything, so a routing mistake cannot reach
// the real Fansly.
//
// Asserted on what the origin saw: one origin request per capture, a redirect
// hop is a capture of its own, undici's hidden re-send is refused before a
// byte is written, and concurrent downloads of one page arrive ≥ S apart.

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const ca = fileURLToPath(new URL("./fixtures/fansly-cdn.cert.pem", import.meta.url));

const child = `
import { createRequire } from "node:module";
import { createProxyRequestDispatcher } from "./packages/shared/src/http-client.ts";
import { downloadMediaForDescribe } from "./apps/runtime/src/services/egress/media-download.ts";
import { createTestFanslySendGuards } from "./tests/helpers/fansly-send-guard.ts";
const require = createRequire(new URL("./apps/runtime/src/bootstrap.ts", import.meta.url));
const { Dispatcher, setGlobalDispatcher } = require("undici");
let fallbackCalls = 0;
setGlobalDispatcher(new class extends Dispatcher {
  dispatch(options, handler) { fallbackCalls++; handler.onError(new Error("global_dispatch_refused")); return false; }
}());
const deadline = setTimeout(() => process.exit(3), 15_000);
const { registry, store } = createTestFanslySendGuards({ settingMs: Number(process.env.SENDERS_SETTING_MS) });
const guard = registry.forPage(7, "media_download");
const dispatcher = createProxyRequestDispatcher({ url: process.env.SENDERS_PROXY });
try {
  const urls = JSON.parse(process.env.SENDERS_URLS);
  const results = await Promise.all(urls.map((url) => downloadMediaForDescribe({ url, dispatcher, fanslySendGuard: guard })));
  await registry.drain();
  process.stdout.write(JSON.stringify({
    fallbackCalls,
    results: results.map((result) => result.ok
      ? { ok: true, bytes: result.bytes.toString("utf8") }
      : { ok: false, reason: result.reason, httpStatus: result.httpStatus }),
    journal: store.journal.map((row) => ({
      source: row.source, outcome: row.outcome, outcomeDetail: row.outcomeDetail,
      httpStatus: row.httpStatus, sent: row.sentAt !== null,
    })),
  }));
} finally { clearTimeout(deadline); await dispatcher.destroy(); }
`;

interface Arrival {
  path: string;
  host: string | undefined;
  atMs: number;
}

interface CdnNetwork {
  proxyUrl: string;
  arrivals: Arrival[];
  authorities: string[];
  stop(): Promise<void>;
}

/** A TLS origin answering for cdn3/cdn5.fansly.com behind a CONNECT proxy
 *  that tunnels every authority to it. */
async function startCdnNetwork(): Promise<CdnNetwork> {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const arrivals: Arrival[] = [];
  const authorities: string[] = [];
  const origin = createHttpsServer({
    key: await readFile(new URL("./fixtures/fansly-cdn.key.pem", import.meta.url)),
    cert: await readFile(new URL("./fixtures/fansly-cdn.cert.pem", import.meta.url)),
  }, (request, response) => {
    arrivals.push({ path: request.url ?? "", host: request.headers.host, atMs: performance.now() });
    const path = (request.url ?? "").split("?")[0];
    if (path === "/redirect") {
      response.writeHead(302, { location: "https://cdn5.fansly.com/b.jpeg" });
      response.end();
      return;
    }
    if (path === "/misdirected") {
      response.writeHead(421, { "content-type": "text/plain" });
      response.end("misdirected");
      return;
    }
    // A little latency, so the next capture's pause runs from a completion
    // that is visibly after the arrival.
    setTimeout(() => {
      response.writeHead(200, { "content-type": "image/jpeg" });
      response.end(`bytes:${path}`);
    }, 20);
  });
  origin.on("connection", track);
  origin.on("tlsClientError", () => {});
  const proxy = createServer((client) => {
    track(client);
    let buffer = Buffer.alloc(0);
    const receive = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.removeListener("data", receive);
      authorities.push(buffer.subarray(0, end).toString().split("\r\n")[0]?.split(" ")[1] ?? "");
      const upstream = track(connect((origin.address() as AddressInfo).port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = buffer.subarray(end + 4);
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream).pipe(client);
      }));
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => client.destroy());
    };
    client.on("data", receive);
  });
  await Promise.all([
    new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve())),
    new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve())),
  ]);
  return {
    proxyUrl: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    arrivals,
    authorities,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([origin, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    },
  };
}

interface ChildOutput {
  fallbackCalls: number;
  results: Array<{ ok: true; bytes: string } | { ok: false; reason: string; httpStatus: number | null }>;
  journal: Array<{
    source: string; outcome: string | null; outcomeDetail: string | null; httpStatus: number | null; sent: boolean;
  }>;
}

async function download(network: CdnNetwork, urls: string[], settingMs = 0): Promise<ChildOutput> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SENDERS_PROXY: network.proxyUrl,
    SENDERS_URLS: JSON.stringify(urls),
    SENDERS_SETTING_MS: String(settingMs),
    NODE_EXTRA_CA_CERTS: ca,
  };
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  // Hang guards, not speed checks (a cold tsx import can take seconds on CI).
  const { stdout } = await exec(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", child], {
    cwd: root, env, timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
  });
  return JSON.parse(stdout) as ChildOutput;
}

let network: CdnNetwork | null = null;
afterEach(async () => {
  await network?.stop();
  network = null;
});

describe("the AI describer's Fansly CDN download under the page's send guard", () => {
  it("sends one origin request per capture and completes it with its status", async () => {
    network = await startCdnNetwork();
    const output = await download(network, ["https://cdn3.fansly.com/a.jpeg?Signature=s"]);
    expect(output).toEqual({
      fallbackCalls: 0,
      results: [{ ok: true, bytes: "bytes:/a.jpeg" }],
      journal: [{ source: "media_download", outcome: "response", outcomeDetail: null, httpStatus: 200, sent: true }],
    });
    expect(network.arrivals.map((arrival) => [arrival.host, arrival.path]))
      .toEqual([["cdn3.fansly.com", "/a.jpeg?Signature=s"]]);
    expect(network.authorities).toEqual(["cdn3.fansly.com:443"]);
  }, 30_000);

  it("takes a capture of its own for each redirect hop", async () => {
    network = await startCdnNetwork();
    const output = await download(network, ["https://cdn3.fansly.com/redirect"]);
    expect(output.results).toEqual([{ ok: true, bytes: "bytes:/b.jpeg" }]);
    expect(output.journal.map((row) => [row.outcome, row.httpStatus, row.sent]))
      .toEqual([["response", 302, true], ["response", 200, true]]);
    expect(network.arrivals.map((arrival) => [arrival.host, arrival.path]))
      .toEqual([["cdn3.fansly.com", "/redirect"], ["cdn5.fansly.com", "/b.jpeg"]]);
  }, 30_000);

  it("refuses the transport's own re-send of a request: one capture, one origin request", async () => {
    network = await startCdnNetwork();
    const output = await download(network, ["https://cdn3.fansly.com/misdirected"]);
    // Without the guard fetch sends a 421'd request again on a new connection.
    expect(network.arrivals.map((arrival) => arrival.path)).toEqual(["/misdirected"]);
    expect(output.journal).toHaveLength(1);
    expect(output.journal[0]).toMatchObject({ source: "media_download", sent: true, outcomeDetail: "lease_used" });
    expect(output.results[0]).toMatchObject({ ok: false });
  }, 30_000);

  it("spaces concurrent downloads of one page at least S apart at the origin", async () => {
    network = await startCdnNetwork();
    const settingMs = 300;
    const output = await download(network, [
      "https://cdn3.fansly.com/1.jpeg",
      "https://cdn3.fansly.com/2.jpeg",
      "https://cdn3.fansly.com/3.jpeg",
    ], settingMs);
    expect(output.results.every((result) => result.ok)).toBe(true);
    expect(output.journal).toHaveLength(3);
    expect(network.arrivals).toHaveLength(3);
    const times = network.arrivals.map((arrival) => arrival.atMs).sort((a, b) => a - b);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(settingMs);
    }
  }, 30_000);
});
