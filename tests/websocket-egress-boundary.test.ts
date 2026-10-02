import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const eslint = new ESLint({ cwd: root });
const runtimeFile = "apps/runtime/src/services/socket-boundary-fixture.ts";
const egressFile = "apps/runtime/src/services/egress/fansly-probe-socket.ts";
const httpImporters = ["packages/shared/src/http-client.ts", "packages/fansly/src/adapter.ts"];

async function lint(code: string, filePath = runtimeFile) {
  const [result] = await eslint.lintText(code, { filePath });
  if (!result) throw new Error(`No lint result for ${filePath}`);
  expect(result.fatalErrorCount).toBe(0);
  return result.messages.filter((message) => message.severity === 2);
}

describe.each([runtimeFile, "packages/shared/src/socket-boundary-fixture.ts", ...httpImporters])(
  "WebSocket egress boundary: %s",
  (filePath) => {
    it.each([
      ["global constructor", 'new WebSocket("wss://example.test");', "no-restricted-globals"],
      ["global alias", 'const Socket = WebSocket; new Socket("wss://example.test");', "no-restricted-globals"],
      ["globalThis", 'new globalThis.WebSocket("wss://example.test");', "no-restricted-properties"],
      ["computed global", 'new global["WebSocket"]("wss://example.test");', "no-restricted-properties"],
      ["destructured global",
        'const { WebSocket: Socket } = globalThis; new Socket("wss://example.test");', "no-restricted-properties"],
      ["undici alias",
        'import { WebSocket as Socket } from "undici"; new Socket("wss://example.test");',
        "@typescript-eslint/no-restricted-imports"],
      ["undici namespace",
        'import * as transport from "undici"; new transport.WebSocket("wss://example.test");',
        "@typescript-eslint/no-restricted-imports"],
      ["undici default",
        'import transport from "undici"; new transport.WebSocket("wss://example.test");',
        "@typescript-eslint/no-restricted-imports"],
      ["undici dynamic alias",
        'const { WebSocket: Socket } = await import("undici"); new Socket("wss://example.test");',
        "no-restricted-syntax"],
      ["ws default", 'import Socket from "ws"; new Socket("wss://example.test");',
        "@typescript-eslint/no-restricted-imports"],
      ["ws subpath", 'import Socket from "ws/wrapper.mjs"; new Socket("wss://example.test");',
        "@typescript-eslint/no-restricted-imports"],
      ["ws dynamic", 'const { default: Socket } = await import("ws"); new Socket("wss://example.test");',
        "no-restricted-syntax"],
      ["ws subpath dynamic", 'void import("ws/wrapper.mjs");', "no-restricted-syntax"],
      ["re-export", 'export { WebSocket as Socket } from "undici";',
        "@typescript-eslint/no-restricted-imports"],
    ])("rejects %s", async (_label, code, ruleId) => {
      expect(await lint(code, filePath)).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId }),
      ]));
    });

    it("permits type-only imports and unrelated local symbols", async () => {
      expect(await lint(`
        import type { WebSocket as Socket } from "undici";
        export type Connection = Socket;
        class WebSocket {}
        function connect() { return new WebSocket(); }
        export const local = connect();
        export const explanation = "new WebSocket and connect are code examples";
      `, filePath)).toEqual([]);
    });
  },
);

describe("WebSocket boundary preserves the existing architecture walls", () => {
  it("permits the actual approved egress constructor", async () => {
    expect(await lint(readFileSync(resolve(root, egressFile), "utf8"), egressFile)).toEqual([]);
  });

  it("permits a local folder named ws (the Sync Engine's socket decoder opens no socket)", async () => {
    expect(await lint(`
      import { decodeFanslyWsFrame } from "../sync/fansly/ws/decode.ts";
      import { routeWsItems } from "./ws/router.ts";
      export const route = { decodeFanslyWsFrame, routeWsItems };
    `)).toEqual([]);
  });

  it("permits callers to use the egress constructor", async () => {
    expect(await lint(`
      import { openFanslyProbeSocket } from "./egress/fansly-probe-socket.ts";
      export const open = openFanslyProbeSocket;
    `)).toEqual([]);
  });

  it.each(httpImporters)("preserves named HTTP imports in %s", async (filePath) => {
    expect(await lint(`
      import { request, fetch, Agent } from "undici";
      export const http = { request, fetch, Agent };
    `, filePath)).toEqual([]);
  });

  it.each([runtimeFile, egressFile, ...httpImporters])("still rejects toMills in %s", async (filePath) => {
    expect(await lint("toMills(1);", filePath)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "no-restricted-syntax", message: expect.stringContaining("toMills") }),
    ]));
  });

  it.each([runtimeFile, egressFile, ...httpImporters])("still rejects vendor AI imports in %s", async (filePath) => {
    expect(await lint('import Anthropic from "@anthropic-ai/sdk"; export { Anthropic };', filePath))
      .toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "no-restricted-imports" })]));
  });

  it("preserves the AI gateway exception without exempting its sockets", async () => {
    const filePath = "apps/runtime/src/services/ai-gateway-anthropic-provider.ts";
    expect(await lint('import Anthropic from "@anthropic-ai/sdk"; export { Anthropic };', filePath)).toEqual([]);
    expect(await lint('import { WebSocket } from "undici"; export { WebSocket };', filePath))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "@typescript-eslint/no-restricted-imports" }),
      ]));
  });

  it("still rejects deep and sibling module imports", async () => {
    expect(await lint('import { secret } from "../modules/billing/private.ts"; export { secret };'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "no-restricted-imports" })]));
    const filePath = "apps/runtime/src/modules/catalog/index.ts";
    expect(await lint('import { secret } from "../billing/private.ts"; export { secret };', filePath))
      .toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "no-restricted-imports" })]));
    expect(await lint('import { api } from "../billing/index.ts"; export { api };', filePath)).toEqual([]);
  });

  it("keeps the existing undici wall for ordinary HTTP aliases and dynamic imports", async () => {
    for (const code of [
      'import { fetch as request } from "undici"; export { request };',
      'void import("undici");',
    ]) {
      expect(await lint(code)).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "no-restricted-syntax" }),
      ]));
    }
  });

  it("keeps the dashboard outside this server-only policy", async () => {
    expect(await eslint.isPathIgnored(resolve(root, "apps/dashboard/src/socket-fixture.ts"))).toBe(true);
  });
});
