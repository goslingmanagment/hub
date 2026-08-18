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
    // Incident 2026-07-15 (decision #155): the fixture's top-level user_id
    // (514788334) is the recipient creator; publishing it as the conversation
    // poisoned every chat-resolving consumer. The fan/chat id is
    // payload.user.id.
    expect(events[0]).toMatchObject({
      type: "message.ppv_unlocked",
      fanIdentityRef: "1000003",
      conversationRef: "1000003",
      dedupKey: "ppv:1000002",
    });
    expect(events[0]!.conversationRef).not.toBe("514788334");
  });

  it("derives ppv refs from the chat link when payload.user is absent (live shape)", () => {
    const envelope = fixture("messages_ppv_unlocked");
    const payload = envelope.payload as Record<string, unknown>;
    delete payload.user;
    payload.replacePairs = {
      "{AMOUNT}": "$45.00",
      "{MESSAGE_LINK}":
        "<a href='https://onlyfans.com/my/chats/chat/490236887?firstId=10408879870963'>message</a>",
    };
    const events = canonicalizeOfapiWebhookObservation(
      observation("messages_ppv_unlocked", { payload: envelope }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fanIdentityRef: "490236887",
      conversationRef: "490236887",
      messageRef: "10408879870963",
    });
  });

  it("publishes no ppv event when neither user id nor chat link resolves", () => {
    const envelope = fixture("messages_ppv_unlocked");
    const payload = envelope.payload as Record<string, unknown>;
    delete payload.user;
    // Anonymized fixture text carries no link; user_id must NOT be a fallback.
    const events = canonicalizeOfapiWebhookObservation(
      observation("messages_ppv_unlocked", { payload: envelope }),
    );
    expect(events).toEqual([]);
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
    // A46 (W8.2): OFAPI amounts are dollars-float; new events say so — the
    // Fansly transaction.posted twin declares "mills" (see the sync-pull suite).
    expect(events[0]!.data).toMatchObject({ amount: 17, currency: "USD", amountUnit: "dollars" });
  });

  it("canonicalizes subscriptions.new into subscription.started", () => {
    const events = canonicalizeOfapiWebhookObservation(observation("subscriptions_new"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "subscription.started",
      fanIdentityRef: "1000032",
      dedupKey: `sub:started:1000032:${new Date("2026-06-10T18:40:00+00:00").toISOString()}`,
    });
  });

  it("does not mistake the creator-level user_id for the subscriber", () => {
    const input = observation("subscriptions_new");
    const envelope = input.payload as Record<string, unknown>;
    const payload = envelope.payload as Record<string, unknown>;
    delete payload.user;

    expect(canonicalizeOfapiWebhookObservation(input)).toEqual([]);
  });

  it("canonicalizes subscriptions.renewed into subscription.renewed (v3 / A48)", () => {
    // Documented-example fixture (docs.onlyfansapi.com; the event never fired
    // in the Phase-0 capture window) — same notification envelope as
    // subscriptions.new, which is exactly the consistency A48 rides on.
    const events = canonicalizeOfapiWebhookObservation(observation("unverified_subscriptions_renewed"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "subscription.renewed",
      fanIdentityRef: "34547118",
      dedupKey: `sub:renewed:34547118:${new Date("2025-05-05T21:27:00+00:00").toISOString()}`,
    });
    expect(events[0]!.data).toMatchObject({
      subType: "returning_subscriber",
      notificationId: "123",
    });
    expect(OFAPI_WEBHOOK_CANONICALIZED_KINDS.has("subscriptions.renewed")).toBe(true);
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

  it("canonicalizes tips.received (v2) keyed to the tipper, not the creator user_id", () => {
    const events = canonicalizeOfapiWebhookObservation(observation("tips_received"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tip.received",
      occurredAt: new Date("2026-06-30T14:42:00+00:00"),
      // payload.user.id — the top-level user_id (518588958) is the CREATOR.
      fanIdentityRef: "310112051",
      conversationRef: "310112051",
      schemaVersion: 1,
      dedupKey: "tip:115273984711",
    });
    expect(events[0]!.data).toMatchObject({
      amountGross: 8,
      amountNet: 6.4,
      subType: "new_tips",
    });
  });

  it("declares no canonicalizer for unmapped kinds", () => {
    // users.typing: ephemeral, unmapped by design.
    expect(OFAPI_WEBHOOK_CANONICALIZED_KINDS.has("users.typing")).toBe(false);
    expect(canonicalizeOfapiWebhookObservation(observation("users_typing"))).toEqual([]);
    for (const kind of ["chat_queue.updated", "chat_queue.finished"]) {
      expect(OFAPI_WEBHOOK_CANONICALIZED_KINDS.has(kind)).toBe(false);
      expect(canonicalizeOfapiWebhookObservation({
        ...observation("users_typing"),
        kind,
        payload: { event: kind, account_id: "acct_test", payload: {} },
      })).toEqual([]);
    }
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
