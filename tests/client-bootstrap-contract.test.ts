import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  clientBootstrapResponseSchema,
  clientFanRefSchema,
  routeSchemas,
} from "@agency_hub_core/contracts";

// The bootstrap is parsed by SDKs frozen inside shipped clients. Every growing
// vocabulary on it is an open string (chat-extension hub plan §4.0, critic 14):
// a closed enum would make one new flag, capability, platform or role break the
// parse of the WHOLE bootstrap in every installed client.

function validBootstrap(): Record<string, unknown> {
  return {
    protocol: 1,
    issuedAt: "2026-10-03T12:00:00.000Z",
    ttlSec: 300,
    configRevision: 0,
    minVersion: "0.0.0",
    identity: { userId: 7, username: "chatter", role: "chatter", tokenClient: null },
    pages: [{
      pageId: 8,
      pageLabel: "lora-of",
      title: "Lora",
      platform: "onlyfans",
      platformAccountId: "100000001",
      bindingRevision: 1,
      features: { recap: { available: false, reason: "disabled" } },
    }],
    bindingsByHost: {},
    flags: { recap: false },
    limits: {
      freshTextMaxItems: 60,
      freshTextMaxChars: 5000,
      feedMax: 100,
      deepMax: 1500,
      audienceWindowHours: 720,
      claimLeaseSec: 120,
      claimRenewSec: 40,
      claimActivityWindowSec: 120,
      previewSendPerMinute: 6,
      navInsertTimeoutSec: 20,
      dispatchTicketSec: 10,
      previewSendReceiptProfiles: [],
    },
    capabilities: [],
  };
}

describe("client bootstrap contract", () => {
  it("accepts unknown flags, features, capabilities, reasons, platforms and roles", () => {
    const body = validBootstrap();
    body.flags = { recap: false, someFutureFlag: true };
    body.capabilities = ["context-v1", "some-future-capability-v9"];
    body.identity = { userId: 7, username: "chatter", role: "future_role", tokenClient: "chat-extension" };
    body.pages = [{
      pageId: 9,
      pageLabel: "lora-future",
      title: "Lora",
      platform: "future-platform",
      platformAccountId: null,
      bindingRevision: 0,
      features: {
        recap: { available: false, reason: "some_future_reason" },
        someFutureFlag: { available: true },
      },
    }];
    body.bindingsByHost = { "onlymonster:1001": 9 };

    const parsed = clientBootstrapResponseSchema.parse(body);
    expect(parsed.flags.someFutureFlag).toBe(true);
    expect(parsed.capabilities).toContain("some-future-capability-v9");
    expect(parsed.identity.role).toBe("future_role");
    expect(parsed.pages[0]!.platform).toBe("future-platform");
    expect(parsed.pages[0]!.features.someFutureFlag).toEqual({ available: true });
  });

  it("strips an unknown top-level key instead of refusing the response", () => {
    const parsed = clientBootstrapResponseSchema.parse({ ...validBootstrap(), someFutureField: { x: 1 } });
    expect(parsed).not.toHaveProperty("someFutureField");
  });

  it("refuses a bootstrap without protocol or identity", () => {
    for (const key of ["protocol", "identity"]) {
      const body = validBootstrap();
      delete body[key];
      expect(clientBootstrapResponseSchema.safeParse(body).success, key).toBe(false);
    }
  });

  it("has one numeric id shape: no leading zero, at most 30 digits", () => {
    for (const ok of ["1", "100000001", "9".repeat(30)]) {
      expect(clientFanRefSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["", "0", "0100000001", "9".repeat(31), "10000000a", " 100000001", "-1"]) {
      expect(clientFanRefSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("declares the route as a device-token GET with no page scope, no input, and 200/401/403", () => {
    const route = routeSchemas.clientBootstrap as {
      auth: { kind: string; scope?: string };
      tags: readonly string[];
      body?: unknown;
      querystring?: unknown;
      params?: unknown;
      response: Record<number, unknown>;
    };
    expect(route.auth).toEqual({ kind: "apiKey" });
    expect(route.tags).toEqual(["client"]);
    expect(route.body).toBeUndefined();
    expect(route.querystring).toBeUndefined();
    expect(route.params).toBeUndefined();
    expect(Object.keys(route.response).sort()).toEqual(["200", "401", "403"]);
  });

  it("keeps routes-client.ts free of routes.ts (routes.ts imports it: a cycle)", async () => {
    const source = await readFile("packages/contracts/src/routes-client.ts", "utf8");
    const imports = [...source.matchAll(/from ["']([^"']+)["']/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual(["./primitives.ts", "@agency_hub_core/shared", "zod"]);
  });
});
