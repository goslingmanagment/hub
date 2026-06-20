import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  mapOfapiWebhookToSpendProjectionEvent,
  OFAPI_TIPS_RECEIVED_BLOCKED_REASON,
  type OfapiSpendProjectionContext,
} from "../apps/runtime/src/services/ofapi-spend-projection-contract.ts";

const FIXTURES_DIR = path.resolve("tests/fixtures/ofapi-webhooks");

async function loadFixture(name: string): Promise<{
  _meta?: Record<string, unknown>;
  event: string;
  account_id: string;
  payload: Record<string, unknown>;
}> {
  return JSON.parse(await readFile(path.join(FIXTURES_DIR, name), "utf8"));
}

function projectionContext(ofapiAccountId: string): OfapiSpendProjectionContext {
  return {
    sourceIdempotencyKey: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    journalId: 42,
    fanoutSeq: null,
    ofapiAccountId,
    pageId: 77,
  };
}

describe("OFAPI spend projection contract mapper", () => {
  it("maps live transactions.new as pending settled-spend input in integer mills", async () => {
    const fixture = await loadFixture("transactions_new.json");

    const result = mapOfapiWebhookToSpendProjectionEvent({
      context: projectionContext(fixture.account_id),
      eventType: fixture.event,
      payload: fixture.payload,
    });

    expect(fixture._meta?.source).toContain("live capture");
    expect(result.status).toBe("projectable");
    if (result.status !== "projectable") {
      return;
    }

    expect(result.event).toMatchObject({
      source: "ofapi_webhook",
      sourceEventType: "transactions.new",
      sourceIdempotencyKey: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      journalId: 42,
      fanoutSeq: null,
      platform: "onlyfans",
      ofapiAccountId: fixture.account_id,
      pageId: 77,
      fanPlatformUserId: "1000003",
      transactionId: "e940b5fb905ba0815d5842a7bde1118c",
      messageId: null,
      occurredAt: "2026-06-10T20:59:47.000Z",
      category: "message",
      currency: "USD",
      grossAmountMills: 17_000,
      creatorNetAmountMills: 13_600,
      status: "pending",
    });
  });

  it("maps documented new_subscription transaction type as subscription spend", async () => {
    const fixture = await loadFixture("transactions_new.json");

    const result = mapOfapiWebhookToSpendProjectionEvent({
      context: projectionContext(fixture.account_id),
      eventType: fixture.event,
      payload: {
        ...fixture.payload,
        type: "new_subscription",
        status: "done",
      },
    });

    expect(result.status).toBe("projectable");
    if (result.status !== "projectable") {
      return;
    }

    expect(result.event).toMatchObject({
      category: "subscription",
      status: "settled",
    });
  });

  it("maps live messages.ppv.unlocked only as an estimated purchase signal", async () => {
    const fixture = await loadFixture("messages_ppv_unlocked.json");

    const result = mapOfapiWebhookToSpendProjectionEvent({
      context: projectionContext(fixture.account_id),
      eventType: fixture.event,
      payload: fixture.payload,
    });

    expect(fixture._meta?.source).toContain("live capture");
    expect(result.status).toBe("projectable");
    if (result.status !== "projectable") {
      return;
    }

    expect(result.event).toMatchObject({
      sourceEventType: "messages.ppv.unlocked",
      fanPlatformUserId: "1000003",
      transactionId: null,
      messageId: null,
      category: "message",
      currency: "USD",
      grossAmountMills: 12_000,
      creatorNetAmountMills: null,
      status: "estimated",
    });
  });

  it("blocks tips.received money mapping until a live verified fixture exists", async () => {
    const fixture = await loadFixture("unverified_tips_received.json");

    const result = mapOfapiWebhookToSpendProjectionEvent({
      context: projectionContext(fixture.account_id),
      eventType: fixture.event,
      payload: fixture.payload,
    });

    expect(fixture._meta?.verified).toBe(false);
    expect(result).toEqual({
      status: "blocked",
      reason: OFAPI_TIPS_RECEIVED_BLOCKED_REASON,
    });
  });

  it("does not parse tip money from documented text or replacePairs examples", async () => {
    const fixture = await loadFixture("unverified_tips_received.json");

    const result = mapOfapiWebhookToSpendProjectionEvent({
      context: projectionContext(fixture.account_id),
      eventType: fixture.event,
      payload: {
        ...fixture.payload,
        amountGross: 999,
        amountNet: 888,
        text: "paid you a tip of $999.00",
        replacePairs: {
          "{AMOUNT}": "$999.00",
        },
      },
    });

    expect(result).toEqual({
      status: "blocked",
      reason: OFAPI_TIPS_RECEIVED_BLOCKED_REASON,
    });
  });
});
