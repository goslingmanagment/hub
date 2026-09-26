import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  canonicalizeOfapiWebhookObservation,
  classifyOfapiWebhookQuarantine,
  OFAPI_WEBHOOK_CANONICALIZED_KINDS,
  parseOfapiPpvAmountUsd,
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

  it("H2: carries a strictly parsed numeric amountUsd beside the verbatim amountText", () => {
    const envelope = fixture("messages_ppv_unlocked");
    const events = canonicalizeOfapiWebhookObservation(
      observation("messages_ppv_unlocked", { payload: envelope }),
    );
    expect(events[0]!.data).toMatchObject({ amountText: "$12.00", amountUsd: 12 });

    const payload = envelope.payload as Record<string, unknown>;
    payload.replacePairs = { ...(payload.replacePairs as Record<string, unknown>), "{AMOUNT}": "12 USD" };
    const unparsable = canonicalizeOfapiWebhookObservation(
      observation("messages_ppv_unlocked", { payload: envelope }),
    );
    // Unparsable → null, never a guess; the event itself is still emitted.
    expect(unparsable).toHaveLength(1);
    expect(unparsable[0]!.data).toMatchObject({ amountText: "12 USD", amountUsd: null });
  });

  it("H2: parses {AMOUNT} strictly — dollar sign, whole dollars, optional two-digit cents", () => {
    expect(parseOfapiPpvAmountUsd("$45.00")).toBe(45);
    expect(parseOfapiPpvAmountUsd("$13.99")).toBe(13.99);
    expect(parseOfapiPpvAmountUsd("$150.00")).toBe(150);
    expect(parseOfapiPpvAmountUsd("$3")).toBe(3);
    expect(parseOfapiPpvAmountUsd("$0.50")).toBe(0.5);
    for (const value of [
      "45.00", "$45.5", "$45.000", "$1,234.00", "€45.00", "$ 45.00", " $45.00", "$45.00 ",
      "$045.00", "$-5.00", "$", "", "$1234567.00", "<b>$45.00</b>", null, undefined, 45, {},
    ]) {
      expect(parseOfapiPpvAmountUsd(value), String(value)).toBeNull();
    }
  });

  it("H2: names every zero-event PPV notification a terminal quarantine with a fixed code", () => {
    // A well-formed notification is not quarantined.
    expect(classifyOfapiWebhookQuarantine(observation("messages_ppv_unlocked"))).toBeNull();

    const noChat = fixture("messages_ppv_unlocked");
    delete (noChat.payload as Record<string, unknown>).user;
    expect(classifyOfapiWebhookQuarantine(observation("messages_ppv_unlocked", { payload: noChat })))
      .toEqual({ code: "ppv_unlocked_no_chat_ref" });

    const noId = fixture("messages_ppv_unlocked");
    delete (noId.payload as Record<string, unknown>).id;
    expect(classifyOfapiWebhookQuarantine(observation("messages_ppv_unlocked", { payload: noId })))
      .toEqual({ code: "ppv_unlocked_no_notification_id" });

    expect(classifyOfapiWebhookQuarantine(observation("messages_ppv_unlocked", { payload: { event: "x" } })))
      .toEqual({ code: "ppv_unlocked_no_payload" });

    // Every quarantine is exactly a zero-event outcome — the two never disagree.
    for (const payload of [noChat, noId, { event: "x" }]) {
      expect(canonicalizeOfapiWebhookObservation(observation("messages_ppv_unlocked", { payload })))
        .toEqual([]);
    }
    // Other kinds keep their plain stamp-and-move-on behaviour.
    expect(classifyOfapiWebhookQuarantine({ ...observation("messages_received"), payload: null }))
      .toBeNull();
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

  it("leaves typing transient and declares content queue events without accepting malformed bodies", () => {
    // users.typing: ephemeral, unmapped by design.
    expect(OFAPI_WEBHOOK_CANONICALIZED_KINDS.has("users.typing")).toBe(false);
    expect(canonicalizeOfapiWebhookObservation(observation("users_typing"))).toEqual([]);
    for (const kind of ["chat_queue.updated", "chat_queue.finished"]) {
      expect(OFAPI_WEBHOOK_CANONICALIZED_KINDS.has(kind)).toBe(true);
      expect(canonicalizeOfapiWebhookObservation({
        ...observation("users_typing"),
        kind,
        payload: { event: kind, account_id: "acct_test", payload: {} },
      })).toEqual([]);
    }
  });

  it("uses expiry time and the existing ended vocabulary without inventing a missing period", () => {
    const expired = observation("subscriptions_new", {
      kind: "subscriptions.expired",
      payload: { event: "subscriptions.expired", payload: {
        id: "55:2026-06-01", user: { id: 55 }, expiredAt: "2026-06-01T00:00:00Z",
        createdAt: "2026-06-02T00:00:00Z",
      } },
    });
    expect(canonicalizeOfapiWebhookObservation(expired)[0]).toMatchObject({
      type: "subscription.ended", occurredAt: new Date("2026-06-01T00:00:00Z"),
      fanIdentityRef: "55", data: { periodIdentity: "55:2026-06-01" },
    });
    expect(canonicalizeOfapiWebhookObservation({ ...expired, payload: {
      payload: { user: { id: 55 }, expiredAt: "not-a-date" },
    } })).toEqual([]);
  });

  it("dates disconnected and authentication facts by provider time while preserving old auth dedup keys", () => {
    const disconnected = observation("subscriptions_new", {
      kind: "accounts.disconnected", payload: { payload: { disconnected_at: "2026-06-20T00:00:00Z" } },
    });
    const event = canonicalizeOfapiWebhookObservation(disconnected)[0]!;
    expect(event).toMatchObject({ type: "account.auth_changed", occurredAt: new Date("2026-06-20T00:00:00Z") });
    expect(event.dedupKey).toBe(`auth:disconnected:${RECEIVED_AT.toISOString()}`);
    expect(canonicalizeOfapiWebhookObservation({ ...disconnected, kind: "accounts.reconnected", payload: {
      payload: { latestAuthAttempt: { started_at: "2026-06-20T00:01:00Z", completed_at: "2026-06-20T00:02:00Z" } },
    } })[0]?.occurredAt).toEqual(new Date("2026-06-20T00:02:00Z"));
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
