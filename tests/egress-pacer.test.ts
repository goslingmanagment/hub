import { describe, expect, it, vi } from "vitest";

import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import type { EgressPacer } from "../apps/runtime/src/services/egress/pacer.ts";
import {
  egressVendorCapSpacingMs,
  egressVendorProvider,
} from "../apps/runtime/src/services/egress/pacer.ts";

// Kernel Stage 26: the OFAPI client's pacer hook. Shadow mode must never add
// latency or change enforcement; enforce mode must delegate pacing entirely.

function okJsonResponse() {
  return new Response(JSON.stringify({ data: { success: true } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakePacer(mode: EgressPacer["mode"]) {
  return {
    mode,
    plan: vi.fn(async () => ({ scheduledAt: new Date(), waitMs: 123 })),
    pace: vi.fn(async () => 0),
  } satisfies EgressPacer;
}

describe("egress pacer wiring (Stage 26)", () => {
  it("maps vendors to platform providers and refuses unknowns", () => {
    expect(egressVendorProvider("ofapi")).toBe("onlyfans");
    expect(egressVendorProvider("fansly")).toBe("fansly");
    expect(() => egressVendorProvider("myspace")).toThrow(/Unknown egress vendor/);
  });

  it("preserves today's effective vendor rates in the cap seeds", () => {
    const app = { config: { ofapiRestDelayMs: 500 } } as never;
    expect(egressVendorCapSpacingMs(app, "ofapi")).toBe(500);
    // There is NO cross-proxy Fansly cap today; the knob exists at 0 so
    // seeding it cannot newly serialize proxies.
    expect(egressVendorCapSpacingMs(app, "fansly")).toBe(0);
  });

  it("shadow mode enforces the legacy slot while diffing the pacer decision off-path", async () => {
    const fetchMock = vi.fn(async () => okJsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    try {
      const pacer = fakePacer("shadow");
      const diffs: unknown[] = [];
      const client = createOfapiClient({
        apiKey: "test-key",
        restDelayMs: 0,
        pacer,
        onShadowDiff: (diff) => diffs.push(diff),
      });

      await client.proxyRead!({ requestObserver: null }, {
        operation: "ofapi_read_test",
        pathname: "/acct/chats",
        query: {},
        fallbackCredits: 0,
        fallbackEstimated: false,
      });

      // The request went out via the legacy slot (pace() never called)…
      expect(pacer.pace).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // …while the shadow decision was computed for the read's class.
      await vi.waitFor(() => {
        expect(pacer.plan).toHaveBeenCalledWith("interactive");
        expect(diffs).toEqual([{
          priorityClass: "interactive",
          oldWaitMs: 0,
          newWaitMs: 123,
        }]);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("enforce mode delegates pacing to the class-aware pacer per lane", async () => {
    const fetchMock = vi.fn(async () => okJsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    try {
      const pacer = fakePacer("enforce");
      const client = createOfapiClient({
        apiKey: "test-key",
        restDelayMs: 0,
        pacer,
      });

      await client.proxyRead!({ requestObserver: null }, {
        operation: "ofapi_read_test",
        pathname: "/acct/chats",
        query: {},
        fallbackCredits: 0,
        fallbackEstimated: false,
      });
      await client.markChatRead!({ pageId: 1 }, "acct", "conv");

      expect(pacer.pace).toHaveBeenNthCalledWith(1, "interactive");
      expect(pacer.pace).toHaveBeenNthCalledWith(2, "commands");
      expect(pacer.plan).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a shadow plan failure never fails or delays the request", async () => {
    const fetchMock = vi.fn(async () => okJsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    try {
      const pacer = {
        mode: "shadow" as const,
        plan: vi.fn(async () => {
          throw new Error("pacer rows missing");
        }),
        pace: vi.fn(async () => 0),
      };
      const client = createOfapiClient({
        apiKey: "test-key",
        restDelayMs: 0,
        pacer,
      });

      const result = await client.proxyRead!({ requestObserver: null }, {
        operation: "ofapi_read_test",
        pathname: "/acct/chats",
        query: {},
        fallbackCredits: 0,
        fallbackEstimated: false,
      });
      expect(result.status).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
