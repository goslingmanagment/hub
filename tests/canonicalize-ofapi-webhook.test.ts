import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  canonicalizeOfapiWebhookObservation,
  OFAPI_WEBHOOK_CANONICALIZED_KINDS,
} from "../apps/runtime/src/services/canonicalize/ofapi-webhook.ts";
import type { CanonicalizableObservation } from "../apps/runtime/src/services/canonicalize/types.ts";

const RECEIVED_AT = new Date("2026-07-01T00:00:00Z");

function fixture(name: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(`tests/fixtures/ofapi-webhooks/${name}.json`, "utf8")) as Record<string, unknown>;
  delete raw._meta;
  return raw;
}

function observation(name: string, overrides?: Partial<CanonicalizableObservation>): CanonicalizableObservation {
  const envelope = fixture(name);
  return {
    id: 101,
    source: "webhook",
    producer: "ofapi:webhook",
    platform: "onlyfans",
    accountId: 4,
    kind: String(envelope.event),
    payload: envelope,
    observedAt: null,
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

describe("ofapi-webhook canonicalizer (Stage 8)", () => {
  it("canonicalizes messages.received with the binding dedup key", () => {
    const events = canonicalizeOfapiWebhookObservation(observation("messages_received"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.received",
      occurredAt: new Date("2026-06-10T18:35:30+00:00"),
      fanIdentityRef: "1000005",
      conversationRef: "1000005",
      messageRef: "1000006",
      schemaVersion: 1,
      dedupKey: "msg:received:1000006",
    });
    expect(events[0]!.data).toMatchObject({ isFree: true, price: 0, isTip: false });
  });

  it("canonicalizes messages.sent against the toUser counterpart", () => {
    const events = canonicalizeOfapiWebhookObservation(observation("messages_sent"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.sent",
      fanIdentityRef: "1000003",
      messageRef: "1000027",
      dedupKey: "msg:sent:1000027",
    });
    expect(events[0]!.data).toMatchObject({ price: 25 });
  });

  it("canonicalizes messages.deleted from the bare-id payload", () => {
    const events = canonicalizeOfapiWebhookObservation(observation("messages_deleted"));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("message.deleted");
    expect(events[0]!.occurredAt).toEqual(RECEIVED_AT);
    expect(events[0]!.dedupKey).toMatch(/^msg:deleted:/);
  });

  it("canonicalizes messages.ppv.unlocked keyed on the notification id", () => {
    const events = canonicalizeOfapiWebhookObservation(observation("messages_ppv_unlocked"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.ppv_unlocked",
      fanIdentityRef: "514788334",
      dedupKey: "ppv:1000002",
    });
  });

  it("canonicalizes transactions.new into transaction.posted", () => {
    const events = canonicalizeOfapiWebhookObservation(observation("transactions_new"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "transaction.posted",
      fanIdentityRef: "1000003",
      transactionRef: "e940b5fb905ba0815d5842a7bde1118c",
      dedupKey: "txn:e940b5fb905ba0815d5842a7bde1118c",
    });
    expect(events[0]!.data).toMatchObject({ amount: 17, currency: "USD" });
  });

  it("canonicalizes subscriptions.new into subscription.started", () => {
    const events = canonicalizeOfapiWebhookObservation(observation("subscriptions_new"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "subscription.started",
      fanIdentityRef: "518588958",
      dedupKey: `sub:started:518588958:${new Date("2026-06-10T18:40:00+00:00").toISOString()}`,
    });
  });

  it("canonicalizes presence as a never-collapsing time series", () => {
    const online = canonicalizeOfapiWebhookObservation(observation("users_online"));
    const offline = canonicalizeOfapiWebhookObservation(observation("users_offline"));
    expect(online[0]).toMatchObject({
      type: "presence.online",
      fanIdentityRef: "1000033",
      dedupKey: `presence:online:1000033:${new Date("2026-06-10T20:01:06.000000Z").toISOString()}`,
    });
    expect(offline[0]!.type).toBe("presence.offline");
    // Same fan, different observed_at → different keys (time series).
    expect(online[0]!.dedupKey).not.toBe(offline[0]!.dedupKey);
  });

  it("canonicalizes accounts.* into account.auth_changed", () => {
    const observedAt = new Date("2026-07-01T10:00:00Z");
    const events = canonicalizeOfapiWebhookObservation({
      ...observation("messages_deleted"),
      kind: "accounts.session_expired",
      payload: { event: "accounts.session_expired", account_id: "acct_x", payload: {} },
      observedAt,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "account.auth_changed",
      occurredAt: observedAt,
      dedupKey: `auth:session_expired:${observedAt.toISOString()}`,
    });
  });

  it("declares no canonicalizer for unverified or unmapped kinds", () => {
    // tips.received: fixture exists but is UNVERIFIED — the observation waits
    // at its current parse_version as the first replay customer (spec §7.5).
    expect(OFAPI_WEBHOOK_CANONICALIZED_KINDS.has("tips.received")).toBe(false);
    expect(canonicalizeOfapiWebhookObservation(observation("unverified_tips_received"))).toEqual([]);
    // users.typing: ephemeral, unmapped by design.
    expect(OFAPI_WEBHOOK_CANONICALIZED_KINDS.has("users.typing")).toBe(false);
    expect(canonicalizeOfapiWebhookObservation(observation("users_typing"))).toEqual([]);
  });

  it("yields zero events on malformed payloads instead of throwing", () => {
    for (const payload of [null, 42, "x", {}, { payload: null }, { payload: { id: null } }]) {
      const events = canonicalizeOfapiWebhookObservation({
        ...observation("messages_received"),
        payload,
      });
      expect(events).toEqual([]);
    }
  });
});
