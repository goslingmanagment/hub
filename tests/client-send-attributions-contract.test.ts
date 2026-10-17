import { describe, expect, it } from "vitest";

import {
  CLIENT_HUB_CAPABILITY_NAMES,
  CLIENT_SEND_ATTRIBUTION_MAX_FACTS,
  CLIENT_SEND_ATTRIBUTION_OUTCOMES,
  CLIENT_SEND_ATTRIBUTION_SOURCES,
  CLIENT_TOKEN_PROFILES,
  clientSendAttributionFactSchema,
  clientSendAttributionsBodySchema,
  clientSendAttributionsResponseSchema,
  clientTokenProfileAllows,
  routeSchemas,
} from "@agency_hub_core/contracts";
import { CLIENT_SEND_ATTRIBUTION_STORED_SOURCES } from "@agency_hub_core/db";

import {
  CLIENT_SEND_ATTRIBUTION_ADMISSIONS,
  admitClientSendAttributionSource,
  clientVersionOf,
  sendAttributionObservedInRange,
} from "../apps/runtime/src/services/client-send-attributions.ts";
import { SERVED_CLIENT_CAPABILITIES } from "../apps/runtime/src/services/client-capabilities.ts";
import * as sdk from "../packages/sdk/src/index.ts";

// send-attribution-v1: who sent each outgoing message (`clientSendAttributions`),
// its shapes and its pure rules. What it records over real rows, and for whom,
// is tests/client-send-attributions.integration.test.ts.

const FACT = {
  platformMessageId: "7001000001",
  fanRef: "518588958",
  observedAt: "2026-10-17T12:00:00.000Z",
  priced: true,
  withMedia: true,
};

describe("send attribution contract", () => {
  it("declares a client page route on the narrow token, served under its own capability", () => {
    const route = (routeSchemas as unknown as Record<string, {
      auth: { kind: string; scope?: string };
      tags: readonly string[];
      body?: unknown;
      response: Record<number, unknown>;
    }>).clientSendAttributions!;
    expect(route.auth).toEqual({ kind: "apiKey", scope: "page" });
    expect(route.tags).toEqual(["client"]);
    expect(route.body).toBe(clientSendAttributionsBodySchema);
    expect(route.response[200]).toBe(clientSendAttributionsResponseSchema);
    expect(Object.keys(route.response).sort()).toEqual(["200", "400", "401", "403", "404", "409"]);
    expect(sdk.kernelOperations.clientSendAttributions)
      .toEqual({ method: "POST", path: "/api/v1/client/pages/:pageLabel/send-attributions" });

    const operations: readonly string[] = CLIENT_TOKEN_PROFILES["chat-extension"].operations;
    expect(operations).toContain("clientSendAttributions");
    expect(clientTokenProfileAllows("chat-extension", "clientSendAttributions")).toBe(true);

    expect(CLIENT_HUB_CAPABILITY_NAMES).toContain("send-attribution-v1");
    expect(SERVED_CLIENT_CAPABILITIES).toContain("send-attribution-v1");
  });

  it("takes a strict body: ids, a time and two marks per fact, never a text or a person", () => {
    expect(clientSendAttributionsBodySchema.parse({ source: "chatspace-extension", facts: [FACT] }))
      .toEqual({ source: "chatspace-extension", facts: [FACT] });
    // The person is the token's: a body that names one is refused, and so is any text.
    for (const extra of [{ userId: 7 }, { text: "hey" }, { textDigest: "ab".repeat(32) }, { chatterUserId: 7 }]) {
      expect(clientSendAttributionFactSchema.safeParse({ ...FACT, ...extra }).success, JSON.stringify(extra)).toBe(false);
      expect(clientSendAttributionsBodySchema.safeParse({ source: "chatspace-extension", facts: [FACT], ...extra }).success)
        .toBe(false);
    }
    for (const bad of [
      { platformMessageId: "0123" }, { platformMessageId: "7e3" }, { platformMessageId: "" },
      { fanRef: "fan" }, { observedAt: "2026-10-17" }, { observedAt: "yesterday" }, { observedAt: "2026-10-17T12:00:00" },
      { priced: "yes" }, { withMedia: 1 },
    ]) {
      expect(clientSendAttributionFactSchema.safeParse({ ...FACT, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    // A zone other than Z is a time too.
    expect(clientSendAttributionFactSchema.safeParse({ ...FACT, observedAt: "2026-10-17T15:00:00+03:00" }).success).toBe(true);
    // One to fifty facts.
    expect(clientSendAttributionsBodySchema.safeParse({ source: "chatspace-extension", facts: [] }).success).toBe(false);
    const many = Array.from({ length: CLIENT_SEND_ATTRIBUTION_MAX_FACTS + 1 }, (_, index) => ({ ...FACT, platformMessageId: String(7_001_000_100 + index) }));
    expect(clientSendAttributionsBodySchema.safeParse({ source: "chatspace-extension", facts: many.slice(0, 50) }).success).toBe(true);
    expect(clientSendAttributionsBodySchema.safeParse({ source: "chatspace-extension", facts: many }).success).toBe(false);
    // The source is an open token on the wire: the hub's admission refuses an unknown one (409), not the parse.
    expect(clientSendAttributionsBodySchema.safeParse({ source: "fansly-extension", facts: [FACT] }).success).toBe(true);
  });

  it("answers open tokens, one per fact; a newer hub's outcome or field never breaks an older client", () => {
    const answer = {
      pageLabel: "lora-of",
      results: [{ platformMessageId: FACT.platformMessageId, outcome: "recorded" }],
      serverNow: "2026-10-17T12:00:01.000Z",
    };
    expect(clientSendAttributionsResponseSchema.parse(answer)).toEqual(answer);
    expect(clientSendAttributionsResponseSchema.safeParse({
      ...answer, results: [{ platformMessageId: FACT.platformMessageId, outcome: "superseded", by: 3 }], later: true,
    }).success).toBe(true);
    expect(CLIENT_SEND_ATTRIBUTION_OUTCOMES).toEqual(["recorded", "duplicate", "conflict", "out_of_range"]);
  });

  it("takes on a platform only the clients its table admits, and the table's CHECK knows each of them", () => {
    expect(CLIENT_SEND_ATTRIBUTION_SOURCES).toEqual(["chatspace-extension"]);
    expect(admitClientSendAttributionSource("onlyfans", "chatspace-extension")).toBe("chatspace-extension");
    // Fansly takes nothing yet: its client adds itself to the admissions and to the table's CHECK.
    expect(admitClientSendAttributionSource("fansly", "chatspace-extension")).toBeNull();
    expect(admitClientSendAttributionSource("onlyfans", "fansly-extension")).toBeNull();
    expect(admitClientSendAttributionSource("onlyfans", "")).toBeNull();
    const admitted = new Set(Object.values(CLIENT_SEND_ATTRIBUTION_ADMISSIONS).flat());
    for (const source of admitted) {
      expect(CLIENT_SEND_ATTRIBUTION_SOURCES as readonly string[]).toContain(source);
      expect(CLIENT_SEND_ATTRIBUTION_STORED_SOURCES as readonly string[]).toContain(source);
    }
  });

  it("keeps a readable client version beside the row and nothing else", () => {
    expect(clientVersionOf("chat-extension/0.2.6")).toBe("chat-extension/0.2.6");
    expect(clientVersionOf(["chat-extension/0.2.6", "x"])).toBe("chat-extension/0.2.6");
    expect(clientVersionOf(undefined)).toBeNull();
    expect(clientVersionOf("")).toBeNull();
    expect(clientVersionOf("x".repeat(65))).toBeNull();
    expect(clientVersionOf("chat extension; drop table")).toBeNull();
  });

  it("takes an observedAt up to five minutes ahead of the hub's clock and thirty days back", () => {
    const now = new Date("2026-10-17T12:00:00.000Z");
    expect(sendAttributionObservedInRange(now, now)).toBe(true);
    expect(sendAttributionObservedInRange(new Date("2026-10-17T12:05:00.000Z"), now)).toBe(true);
    expect(sendAttributionObservedInRange(new Date("2026-10-17T12:05:00.001Z"), now)).toBe(false);
    expect(sendAttributionObservedInRange(new Date("2026-09-17T12:00:00.000Z"), now)).toBe(true);
    expect(sendAttributionObservedInRange(new Date("2026-09-17T11:59:59.999Z"), now)).toBe(false);
  });
});
