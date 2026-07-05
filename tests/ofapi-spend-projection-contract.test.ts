import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  mapOfapiWebhookToSpendProjectionEvent,
  ofapiSpendProjectionTransactionDomainKey,
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
      // Stage 14 fee capture: dollars-float fee_amount/vat_amount/tax_amount
      // from the same live payload, in integer mills (gross − fee = net).
      platformFeeMills: 3_400,
      vatAmountMills: 2_210,
      taxAmountMills: 0,
      status: "pending",
    });
  });

  it("keeps fee columns null when the payload omits the fee fields", async () => {
    const fixture = await loadFixture("transactions_new.json");
    const { fee_amount: _fee, vat_amount: _vat, tax_amount: _tax, ...payload } = fixture.payload;

    const result = mapOfapiWebhookToSpendProjectionEvent({
      context: projectionContext(fixture.account_id),
      eventType: fixture.event,
      payload,
    });

    expect(result.status).toBe("projectable");
    if (result.status !== "projectable") {
      return;
    }
    expect(result.event).toMatchObject({
      platformFeeMills: null,
      vatAmountMills: null,
      taxAmountMills: null,
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

  it.each(["undo", "pending_return", "pending return"])(
    "maps %s transaction status as a separate reversed adjustment",
    async (status) => {
      const fixture = await loadFixture("transactions_new.json");

      const result = mapOfapiWebhookToSpendProjectionEvent({
        context: projectionContext(fixture.account_id),
        eventType: fixture.event,
        payload: {
          ...fixture.payload,
          status,
        },
      });

      expect(result.status).toBe("projectable");
      if (result.status !== "projectable") {
        return;
      }

      expect(result.event).toMatchObject({
        transactionId: "e940b5fb905ba0815d5842a7bde1118c:reversal",
        status: "reversed",
      });
      expect(ofapiSpendProjectionTransactionDomainKey({
        ofapiAccountId: fixture.account_id,
        transactionId: "e940b5fb905ba0815d5842a7bde1118c",
        status: "reversed",
      })).toBe(
        "ofapi:acct_02000000000000000000000000000000:tx-reversal:e940b5fb905ba0815d5842a7bde1118c:reversal",
      );
    },
  );

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

  it("maps live tips.received as an estimated tip signal in integer mills", async () => {
    const fixture = await loadFixture("tips_received.json");

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
      sourceEventType: "tips.received",
      // The tipper is payload.user.id — NOT the top-level user_id, which the
      // prod probe showed is the CREATOR (constant across tippers on a page).
      fanPlatformUserId: "310112051",
      transactionId: null,
      occurredAt: "2026-06-30T14:42:00.000Z",
      category: "tip",
      currency: "USD",
      grossAmountMills: 8_000,
      creatorNetAmountMills: 6_400,
      platformFeeMills: null,
      // Signal, not truth: the money itself arrives via transactions.new
      // (type "tip") through the ingest — projecting this as truth would
      // double-count.
      status: "estimated",
    });
  });

  it("skips a tip without the tipper object instead of falling back to the creator user_id", async () => {
    const fixture = await loadFixture("tips_received.json");
    const { user: _user, ...payload } = fixture.payload;

    const result = mapOfapiWebhookToSpendProjectionEvent({
      context: projectionContext(fixture.account_id),
      eventType: fixture.event,
      payload,
    });

    expect(result).toEqual({
      status: "skipped",
      reason: "tips_received_missing_fan_id",
    });
  });
});
