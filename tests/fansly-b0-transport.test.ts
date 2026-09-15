import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createFanslyWsFrameBudget } from "../apps/runtime/src/services/egress/fansly-ws-frame-budget.ts";
import { startFanslyProbeNetwork } from "./helpers/fansly-probe-network.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const ca = fileURLToPath(new URL("./fixtures/fansly-probe.cert.pem", import.meta.url));
const client = `
import { createRequire } from "node:module";
import { createProxyRequestDispatcher } from "./packages/shared/src/http-client.ts";
import { openFanslyReceiverSocket } from "./apps/runtime/src/services/egress/fansly-receiver-socket.ts";
const require = createRequire(new URL("./apps/runtime/src/bootstrap.ts", import.meta.url));
const { Dispatcher, setGlobalDispatcher } = require("undici");
let fallback = 0;
setGlobalDispatcher(new class extends Dispatcher {
  dispatch(options,handler) { fallback++; handler.onError(new Error("refused")); return false; }
}());
const dispatcher = createProxyRequestDispatcher({ url: process.env.B0_PROXY,
  username: "fixture-user", password: "fixture-password" });
const receiver = openFanslyReceiverSocket({ dispatcher, egressKey: "page-fixture",
  pace: async () => {}, close: () => dispatcher.close() });
let opened = false;
const deadline = setTimeout(() => process.exit(3), 3000);
receiver.socket.addEventListener("open", () => { opened = true; });
receiver.socket.addEventListener("error", () => {});
receiver.socket.addEventListener("message", () => receiver.stop());
await new Promise(resolve => receiver.socket.addEventListener("close", resolve, {once:true}));
receiver.stop();
clearTimeout(deadline);
process.stdout.write(JSON.stringify({opened,fallback}));
`;

describe("B0 real proxy transport", () => {
  it("rejects unsolicited compression without waiting for the auth timeout", async () => {
    const network = await startFanslyProbeNetwork("http", false, undefined, 101, true, true);
    if (!network) throw new Error("local proxy fixture required");
    const env: NodeJS.ProcessEnv = { ...process.env, B0_PROXY: network.url, NODE_EXTRA_CA_CERTS: ca };
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    try {
      const { stdout } = await exec(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", client],
        { cwd: root, env, timeout: 6000, maxBuffer: 4096 });
      expect(JSON.parse(stdout)).toEqual({ opened: false, fallback: 0 });
    } finally { await network.stop(); }
  }, 10_000);
  it.each(["http", "socks5"] as const)("%s closes upgraded transport even when peer ignores close", async (protocol) => {
    const network = await startFanslyProbeNetwork(protocol, false, undefined, 101, true);
    if (!network) throw new Error("local proxy fixture required");
    const env: NodeJS.ProcessEnv = { ...process.env, B0_PROXY: network.url, NODE_EXTRA_CA_CERTS: ca };
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    try {
      const { stdout } = await exec(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", client],
        { cwd: root, env, timeout: 6000, maxBuffer: 4096 });
      expect(JSON.parse(stdout)).toEqual({ opened: true, fallback: 0 });
      expect(network.destinations).toEqual(["wsv3.fansly.com:443"]);
      expect(network.upgrades[0]?.headers["sec-websocket-extensions"]).toBeUndefined();
    } finally { await network.stop(); }
  }, 10_000);
  it.each(["http", "socks5"] as const)("%s proxy failure has zero direct fallback", async (protocol) => {
    const network = await startFanslyProbeNetwork(protocol, true);
    if (!network) throw new Error("local proxy fixture required");
    const env: NodeJS.ProcessEnv = { ...process.env, B0_PROXY: network.url, NODE_EXTRA_CA_CERTS: ca };
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    try {
      const { stdout } = await exec(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", client],
        { cwd: root, env, timeout: 6000, maxBuffer: 4096 });
      expect(JSON.parse(stdout)).toEqual({ opened: false, fallback: 0 });
      expect(network.upgrades).toHaveLength(0);
    } finally { await network.stop(); }
  }, 10_000);
});

describe("B0 frame assembly budget", () => {
  it("handles split headers, fragmented data and interleaved ping", () => {
    const accept = createFanslyWsFrameBudget();
    for (const byte of [0x01, 3, 1, 2, 3, 0x89, 1, 0, 0x80, 2, 4, 5]) expect(accept(Buffer.from([byte]))).toBe(true);
    expect(accept(Buffer.from([0x81, 1, 0]))).toBe(true);
  });
  it("refuses a huge 64-bit declaration before buffering payload", () => {
    const header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(2n ** 40n, 2);
    const accept = createFanslyWsFrameBudget();
    expect(accept(header.subarray(0, 7))).toBe(true);
    expect(accept(header.subarray(7))).toBe(false);
  });
  it("bounds total fragmented payload and number of empty fragments", () => {
    const accept = createFanslyWsFrameBudget();
    const frame = Buffer.alloc(4 + 65535); frame[0] = 0; frame[1] = 126; frame.writeUInt16BE(65535, 2);
    for (let i = 0; i < 16; i++) expect(accept(frame)).toBe(true);
    expect(accept(frame)).toBe(false);
    const empty = createFanslyWsFrameBudget();
    for (let i = 0; i < 4096; i++) expect(empty(Buffer.from([0,0]))).toBe(true);
    expect(empty(Buffer.from([0,0]))).toBe(false);
  });
  it("rejects compressed RSV bits and masked server frames", () => {
    expect(createFanslyWsFrameBudget()(Buffer.from([0xc1,0]))).toBe(false);
    expect(createFanslyWsFrameBudget()(Buffer.from([0x81,0x80]))).toBe(false);
  });
});
