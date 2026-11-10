import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createLogger } from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";

const { buildApiServer } = await import("../apps/runtime/src/api/server.ts");

// The runtime serves the console's and Workboard's builds with an SPA fallback.
// A chunk that is not in this build (asked for around a deploy or rollback) must
// answer 404 no-store, never the app shell: nginx marks 2xx under /assets/
// immutable for a year, and the browser would keep the HTML as that script.

const DASHBOARD_SHELL = "<!doctype html><title>console</title>";
const WORKBOARD_SHELL = "<!doctype html><title>workboard</title>";
const DASHBOARD_CHUNK = "export const dashboard = 1;\n";
const WORKBOARD_CHUNK = "export const workboard = 1;\n";

function createContext(): AppContext {
  const encryptionKey = Buffer.alloc(32, 7);
  return {
    config: {
      databaseUrl: "",
      encryptionKey,
      encryptionKeyVersion: 1,
      encryptionKeysByVersion: new Map([[1, encryptionKey]]),
      logLevel: "silent",
      apiHost: "0.0.0.0",
      apiPort: 3000,
      trustProxy: false,
      sessionTtlDays: 30,
      fanslyBaseUrl: "https://example.invalid",
      syncHttpTraceFile: null,
      fanslyDefaultDelayMs: 2500,
      onlyFansDefaultDelayMs: 1000,
      lakeDir: "lake",
      syncPageExecutorConcurrency: 1,
      syncObservabilityRetentionDays: 30,
      healthSyncLightMaxAgeMinutes: 180,
      healthSyncMonitoringToken: null,
      telegramBotToken: null,
      telegramChatId: null,
      telegramEnabled: false,
      telegramReportHourUtc: 9,
      serviceEgressProxyUrl: null,
      serviceEgressProxyUsername: null,
      serviceEgressProxyPassword: null,
      isProduction: false,
    },
    logger: createLogger("silent"),
    pool: {} as AppContext["pool"],
    db: {} as AppContext["db"],
    async close() {},
  } satisfies AppContext;
}

describe("SPA static serving: missing build assets", () => {
  let root: string;
  let server: Awaited<ReturnType<typeof buildApiServer>>;
  let port: number;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "hub-spa-"));
    for (const [app, shell, chunk] of [
      ["dashboard", DASHBOARD_SHELL, DASHBOARD_CHUNK],
      ["workboard", WORKBOARD_SHELL, WORKBOARD_CHUNK],
    ] as const) {
      mkdirSync(join(root, "apps", app, "dist", "assets"), { recursive: true });
      writeFileSync(join(root, "apps", app, "dist", "index.html"), shell);
      writeFileSync(join(root, "apps", app, "dist", "assets", `index-${app}.js`), chunk);
    }
    // The dist resolver looks up from the cwd first.
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      server = await buildApiServer(createContext());
    } finally {
      cwd.mockRestore();
    }
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("serves existing asset files of both apps", async () => {
    const dashboard = await server.inject({ method: "GET", url: "/assets/index-dashboard.js?v=1" });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toBe(DASHBOARD_CHUNK);
    expect(dashboard.headers["content-type"]).toMatch(/javascript/);

    const workboard = await server.inject({ method: "GET", url: "/workboard/assets/index-workboard.js" });
    expect(workboard.statusCode).toBe(200);
    expect(workboard.body).toBe(WORKBOARD_CHUNK);
  });

  it.each([
    ["GET", "/assets/charts-Bcyb22t9.js"],
    ["GET", "/assets/charts-Bcyb22t9.js?import"],
    ["HEAD", "/assets/vendor-Xyz.js"],
    ["GET", "/workboard/assets/index-gone.js"],
    ["HEAD", "/workboard/assets/index-gone.css"],
  ] as const)("%s %s: a missing asset is a 404 nobody stores", async (method, url) => {
    const response = await server.inject({ method, url });
    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.body).not.toContain("<!doctype html>");
  });

  it.each([
    ["/", DASHBOARD_SHELL],
    ["/account", DASHBOARD_SHELL],
    ["/pages/x/stats?tab=1", DASHBOARD_SHELL],
    ["/assets", DASHBOARD_SHELL],
    ["/workboard", WORKBOARD_SHELL],
    ["/workboard/", WORKBOARD_SHELL],
    ["/workboard/people/5", WORKBOARD_SHELL],
  ])("GET %s: app routes keep the shell", async (url, shell) => {
    const response = await server.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(shell);
  });

  it.each([
    "/assets/../index.html",
    "/assets/%2e%2e/%2e%2e/package.json",
    "/assets/..%2f..%2fpackage.json",
    "/workboard/assets/../../package.json",
  ])("GET %s over a socket: dot segments under assets read no file", async (path) => {
    // inject() resolves dot segments itself; a raw socket request does not.
    const response = await new Promise<{ status: number; cacheControl: string | undefined; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, cacheControl: res.headers["cache-control"], body }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(response).toEqual({ status: 404, cacheControl: "no-store", body: "Not Found\n" });
  });

  it("leaves unknown API routes on their JSON 404", async () => {
    const response = await server.inject({ method: "GET", url: "/api/v1/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not Found", message: "Route not found", statusCode: 404 });
  });
});
