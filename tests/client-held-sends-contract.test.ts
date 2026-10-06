import { describe, expect, it } from "vitest";

import {
  CLIENT_SEND_CUSTODY_LIST_STATES,
  CLIENT_SEND_CUSTODY_RESOLVE_OUTCOMES,
  CLIENT_TOKEN_PROFILES,
  clientSendCustodyItemSchema,
  clientSendCustodyListItemSchema,
  clientSendCustodyListQuerySchema,
  clientSendCustodyListResponseSchema,
  clientSendCustodyResolveBodySchema,
  clientTokenProfileAllows,
  operationsOutsideClientTokenProfile,
  routeSchemas,
} from "@agency_hub_core/contracts";

import * as sdk from "../packages/sdk/src/index.ts";

// chat-extension H-7e: the cabinet's list of held sends (`clientSendCustodyList`),
// its shapes. What it answers over real rows, and to whom, is
// tests/client-held-sends.integration.test.ts.

const ITEM = {
  attemptId: "9f1b2c3d-4e5f-4a6b-8c7d-0123456789ab",
  pageLabel: "lora-of",
  fanRef: "777000777",
  userId: 7,
  username: "grisha",
  instanceId: "5d3c1c0a-7a7e-4c0b-9a55-0c8f6e1b2d33",
  purpose: "greeting",
  state: "uncertain-held",
  generationRef: "3c2b1a09-8f7e-4d6c-b5a4-fedcba987654",
  variant: 1,
  partIndex: 0,
  partCount: 3,
  createdAt: "2026-10-04T12:00:00.000Z",
  updatedAt: "2026-10-04T12:00:00.000Z",
  ticketExpiresAt: "2026-10-04T12:00:10.000Z",
  greeting: { state: "none", at: null, source: null, firstPartIsThisAttempt: false },
  resolution: null,
};

describe("held-sends list contract", () => {
  it("declares a cabinet route: a dashboard session, no page scope in the path, every status it answers", () => {
    const route = (routeSchemas as unknown as Record<string, {
      auth: { kind: string; scope?: string; roles?: unknown };
      tags: readonly string[];
      params?: unknown;
      querystring?: unknown;
      body?: unknown;
      response: Record<number, unknown>;
    }>).clientSendCustodyList!;
    // `session`: the owner and team leads, by cookie. The page is a filter in
    // the query, so no page scope is declared: the handler checks the page.
    expect(route.auth).toEqual({ kind: "session" });
    expect(route.tags).toEqual(["client"]);
    expect(route.params).toBeUndefined();
    // A read: no body.
    expect(route.body).toBeUndefined();
    expect(route.querystring).toBe(clientSendCustodyListQuerySchema);
    expect(route.response[200]).toBe(clientSendCustodyListResponseSchema);
    expect(Object.keys(route.response).sort()).toEqual(["200", "400", "401", "403", "404"]);
    expect(sdk.kernelOperations.clientSendCustodyList).toEqual({ method: "GET", path: "/api/v1/client-send-custody" });
  });

  it("is on no narrow-token list: the chat extension's token cannot reach it", () => {
    const operations: readonly string[] = CLIENT_TOKEN_PROFILES["chat-extension"].operations;
    expect(operations).not.toContain("clientSendCustodyList");
    expect(operations).not.toContain("clientSendCustodyResolve");
    expect(clientTokenProfileAllows("chat-extension", "clientSendCustodyList")).toBe(false);
    // A client SDK that called it would be refused: the frozen-SDK registry reports the gap.
    expect(operationsOutsideClientTokenProfile("chat-extension", ["clientFanClaim", "clientSendCustodyList"]))
      .toEqual(["clientSendCustodyList"]);
  });

  it("takes a strict query: held by default, one optional page, a bounded page of the list", () => {
    expect(clientSendCustodyListQuerySchema.parse({})).toEqual({ state: "held", limit: 50, offset: 0 });
    // A query string arrives as text.
    expect(clientSendCustodyListQuerySchema.parse({ state: "resolved", pageLabel: "lora-of", limit: "100", offset: "200" }))
      .toEqual({ state: "resolved", pageLabel: "lora-of", limit: 100, offset: 200 });
    expect(CLIENT_SEND_CUSTODY_LIST_STATES).toEqual(["held", "resolved"]);
    for (const query of [
      { state: "all" }, { state: "dispatching" }, { limit: "0" }, { limit: "101" }, { limit: "1.5" }, { offset: "-1" },
      { offset: "100001" }, { pageLabel: "" }, { pageLabel: "x".repeat(121) },
      // A key the route does not declare: no filter by person, by fan or by attempt.
      { userId: "7" }, { fanRef: "777000777" }, { attemptId: ITEM.attemptId }, { cursor: "abc" },
    ]) {
      expect(clientSendCustodyListQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it("answers ids, states and times: an item is the resolve route's item and what the resolver needs on top", () => {
    expect(clientSendCustodyListItemSchema.parse(ITEM)).toEqual(ITEM);
    // The resolve route's answer is the same attempt, with fewer fields.
    expect(Object.keys(clientSendCustodyItemSchema.parse(ITEM)).sort()).toEqual([
      "attemptId", "createdAt", "fanRef", "generationRef", "partCount", "partIndex", "purpose", "state", "ticketExpiresAt", "userId",
    ]);
    const resolved = {
      ...ITEM,
      state: "resolved-sent",
      updatedAt: "2026-10-04T13:00:00.000Z",
      greeting: { state: "confirmed", at: "2026-10-04T13:00:00.000Z", source: "resolve", firstPartIsThisAttempt: true },
      resolution: {
        outcome: "sent", at: "2026-10-04T13:00:00.000Z", userId: 2, username: "lead", note: "the message is in the chat",
        platformMessageId: "7001",
      },
    };
    expect(clientSendCustodyListItemSchema.parse(resolved)).toEqual(resolved);
    expect(CLIENT_SEND_CUSTODY_RESOLVE_OUTCOMES).toEqual(["sent", "not_sent"]);
    // The outcomes a resolve records are the ones its body takes.
    for (const outcome of CLIENT_SEND_CUSTODY_RESOLVE_OUTCOMES) {
      expect(clientSendCustodyResolveBodySchema.safeParse({ outcome, note: "seen" }).success, outcome).toBe(true);
    }
    // A vocabulary that grows is an open token: an older dashboard build reads a newer hub.
    expect(clientSendCustodyListItemSchema.safeParse({
      ...resolved, state: "resolved-later", purpose: "story-reply",
      greeting: { ...resolved.greeting, source: "import" }, resolution: { ...resolved.resolution, outcome: "withdrawn" },
    }).success).toBe(true);
    // Not strict, like every response: a key this build does not know is dropped, not refused.
    expect(clientSendCustodyListItemSchema.parse({ ...ITEM, text: "hey", futureField: 1 })).toEqual(ITEM);
    for (const broken of [
      { ...ITEM, pageLabel: undefined }, { ...ITEM, username: undefined }, { ...ITEM, instanceId: undefined },
      { ...ITEM, variant: -1 }, { ...ITEM, greeting: undefined }, { ...ITEM, resolution: undefined },
      { ...ITEM, greeting: { ...ITEM.greeting, firstPartIsThisAttempt: undefined } },
      { ...resolved, resolution: { ...resolved.resolution, note: undefined } },
    ]) {
      expect(clientSendCustodyListItemSchema.safeParse(broken).success, JSON.stringify(broken)).toBe(false);
    }

    const response = { items: [ITEM, resolved], limit: 50, offset: 0, total: 2, serverNow: "2026-10-04T14:00:00.000Z" };
    expect(clientSendCustodyListResponseSchema.parse(response)).toEqual(response);
    expect(clientSendCustodyListResponseSchema.safeParse({ ...response, total: undefined }).success).toBe(false);
    expect(clientSendCustodyListResponseSchema.safeParse({ ...response, serverNow: undefined }).success).toBe(false);
  });
});
