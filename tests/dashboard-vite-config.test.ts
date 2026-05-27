import { afterEach, describe, expect, it, vi } from "vitest";

const originalApiProxyTarget = process.env.VITE_API_PROXY_TARGET;

async function loadDashboardViteConfig() {
  vi.resetModules();
  const mod = await import("../apps/dashboard/vite.config.ts");
  return mod.default;
}

describe("dashboard vite config", () => {
  afterEach(() => {
    if (originalApiProxyTarget === undefined) {
      delete process.env.VITE_API_PROXY_TARGET;
    } else {
      process.env.VITE_API_PROXY_TARGET = originalApiProxyTarget;
    }
  });

  it("uses VITE_API_PROXY_TARGET for backend proxy routes", async () => {
    process.env.VITE_API_PROXY_TARGET = "http://127.0.0.1:3100";

    const config = await loadDashboardViteConfig();

    expect(config.server?.proxy).toMatchObject({
      "/api": "http://127.0.0.1:3100",
      "/documentation": "http://127.0.0.1:3100",
    });
  });

  it("defaults backend proxy routes to IPv4 localhost", async () => {
    delete process.env.VITE_API_PROXY_TARGET;

    const config = await loadDashboardViteConfig();

    expect(config.server?.proxy).toMatchObject({
      "/api": "http://127.0.0.1:3000",
      "/documentation": "http://127.0.0.1:3000",
    });
  });
});
