import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isOfapiDmProjectionEventType,
  OFAPI_DM_PROJECTION_EVENT_TYPES,
  parseOfapiDmMessagePayload,
} from "../apps/runtime/src/services/ofapi-dm-projection.ts";
import {
  extractMessageIdFromNotification,
  notificationChatId,
  ofapiWebhookEnvelopeSchema,
} from "../apps/runtime/src/services/ofapi-payloads.ts";

const FIXTURES_DIR = path.resolve("tests/fixtures/ofapi-webhooks");

async function loadFixturePayload(name: string) {
  const raw = JSON.parse(await readFile(path.join(FIXTURES_DIR, name), "utf8")) as Record<string, unknown>;
  delete raw._meta;
  const envelope = ofapiWebhookEnvelopeSchema.parse(raw);
  return envelope.payload as Record<string, unknown>;
}

describe("isOfapiDmProjectionEventType", () => {
  it("accepts exactly the five projected DM event types", () => {
    for (const eventType of OFAPI_DM_PROJECTION_EVENT_TYPES) {
      expect(isOfapiDmProjectionEventType(eventType)).toBe(true);
    }
    expect(isOfapiDmProjectionEventType("users.typing")).toBe(false);
    expect(isOfapiDmProjectionEventType("transactions.new")).toBe(false);
    expect(isOfapiDmProjectionEventType("subscriptions.new")).toBe(false);
  });
});

describe("parseOfapiDmMessagePayload", () => {
  it("maps the captured messages.received payload to a fan-direction row", async () => {
    const payload = await loadFixturePayload("messages_received.json");
    const parsed = parseOfapiDmMessagePayload("messages.received", payload);

    expect(parsed).not.toBeNull();
    expect(parsed!.direction).toBe("received");
    expect(parsed!.messageId).toBe("1000006");
    expect(parsed!.fanId).toBe("1000005");
    expect(parsed!.fanUsername).toBe("fan005");
    // OnlyFans user objects carry the display name in "name".
    expect(parsed!.fanDisplayName).toBe("Fan 4");
    expect(parsed!.senderPlatformUserId).toBe("1000005");
    // HTML is stripped for storage (D6).
    expect(parsed!.content).toBe("Sample fan message text used in anonymized fixtures.");
    expect(parsed!.preview).toBe("Sample fan message text used in anonymized fixtures.");
    expect(parsed!.createdAt.toISOString()).toBe("2026-06-10T18:35:30.000Z");
    expect(parsed!.tipAmountCents).toBe(0);
    expect(parsed!.inReplyToMessageId).toBe("1000014");
  });

  it("maps the captured messages.sent payload to a model-direction row keyed by toUser", async () => {
    const payload = await loadFixturePayload("messages_sent.json");
    const parsed = parseOfapiDmMessagePayload("messages.sent", payload);

    expect(parsed).not.toBeNull();
    expect(parsed!.direction).toBe("sent");
    expect(parsed!.messageId).toBe("1000027");
    expect(parsed!.fanId).toBe("1000003");
    expect(parsed!.fanUsername).toBe("fan002");
    expect(parsed!.fanDisplayName).toBe("Fan 1");
    // Live-captured sent events carry no fromUser; the role still says "model".
    expect(parsed!.senderPlatformUserId).toBeNull();
    // price on a non-tip message is the PPV unlock price, not revenue we record.
    expect(parsed!.tipAmountCents).toBe(0);
  });

  it("records a tip amount only for isTip messages with a positive price", async () => {
    const payload = await loadFixturePayload("messages_received.json");
    const tipped = parseOfapiDmMessagePayload("messages.received", {
      ...payload,
      isTip: true,
      price: 12.5,
    });
    expect(tipped!.tipAmountCents).toBe(1250);

    const free = parseOfapiDmMessagePayload("messages.received", {
      ...payload,
      isTip: true,
      price: 0,
    });
    expect(free!.tipAmountCents).toBe(0);
  });

  it("returns null when the message id, fan identity, or timestamp is unusable", async () => {
    const payload = await loadFixturePayload("messages_received.json");

    expect(parseOfapiDmMessagePayload("messages.received", { ...payload, id: null })).toBeNull();
    expect(parseOfapiDmMessagePayload("messages.received", { ...payload, fromUser: null })).toBeNull();
    expect(parseOfapiDmMessagePayload(
      "messages.received",
      { ...payload, createdAt: "not-a-date" },
    )).toBeNull();
    // sent events key the conversation off toUser, which this payload lacks.
    expect(parseOfapiDmMessagePayload("messages.sent", payload)).toBeNull();
  });
});

describe("notification payload references", () => {
  it("extracts the fan id and message id from chat links in notification payloads", () => {
    const payload = {
      text: "Fan paid for your message",
      replacePairs: {
        "{MESSAGE_LINK}": "https://onlyfans.com/my/chats/chat/1000005?firstId=1000006",
      },
      user: { id: 1000005 },
    };

    expect(extractMessageIdFromNotification(payload)).toBe("1000006");
    expect(notificationChatId(payload)).toBe("1000005");
  });

  it("returns nothing for the anonymized ppv fixture whose links were scrubbed", async () => {
    const payload = await loadFixturePayload("messages_ppv_unlocked.json");
    expect(extractMessageIdFromNotification(payload)).toBeUndefined();
    // The fan id still resolves from payload.user.
    expect(notificationChatId(payload)).toBe("1000003");
  });
});
