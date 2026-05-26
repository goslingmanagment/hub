import { beforeEach, describe, expect, it, vi } from "vitest";

const dnsMocks = vi.hoisted(() => ({
  lookup: vi.fn(),
}));

vi.mock("node:dns/promises", () => dnsMocks);

import { assertAllowedProxyTarget } from "../apps/runtime/src/services/proxy-validation.ts";

describe("proxy validation", () => {
  beforeEach(() => {
    dnsMocks.lookup.mockReset();
  });

  it("rejects hostnames that resolve to private networks", async () => {
    dnsMocks.lookup.mockResolvedValueOnce([
      { address: "10.1.2.3", family: 4 },
    ]);

    await expect(assertAllowedProxyTarget({ url: "socks5://proxy.example:1080" }))
      .rejects.toThrow(/resolves to/);
  });

  it("allows public DNS answers and tolerates DNS lookup failures", async () => {
    dnsMocks.lookup.mockResolvedValueOnce([
      { address: "8.8.8.8", family: 4 },
    ]);
    await expect(assertAllowedProxyTarget({ url: "socks5://proxy.example:1080" })).resolves.toBeUndefined();

    dnsMocks.lookup.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
    await expect(assertAllowedProxyTarget({ url: "socks5://missing.example:1080" })).resolves.toBeUndefined();
  });
});
