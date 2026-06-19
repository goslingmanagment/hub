import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { syncEventSchema, type SyncEvent } from "@agency_hub_core/contracts";
import { describe, expect, it } from "vitest";

import {
  mapOfapiEventToSyncEvent,
  ofapiWebhookEnvelopeSchema,
  type OfapiWebhookEnvelope,
} from "../apps/runtime/src/services/ofapi-events.ts";

const FIXTURES_DIR = path.resolve("tests/fixtures/ofapi-webhooks");

async function loadFixture(name: string): Promise<OfapiWebhookEnvelope> {
  const raw = JSON.parse(await readFile(path.join(FIXTURES_DIR, name), "utf8")) as Record<string, unknown>;
  delete raw._meta;
  return ofapiWebhookEnvelopeSchema.parse(raw);
}

type MessageSyncEvent = Extract<SyncEvent, { type: "messageReceived" | "messageSent" }>;

function asMessageFrame(frame: SyncEvent | null): MessageSyncEvent {
  expect(frame).not.toBeNull();
  expect(frame?.type === "messageReceived" || frame?.type === "messageSent").toBe(true);
  return frame as MessageSyncEvent;
}

function hasNestedKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasNestedKey(item, key));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.entries(value).some(([entryKey, entryValue]) =>
    entryKey === key || hasNestedKey(entryValue, key)
  );
}

describe("mapOfapiEventToSyncEvent", () => {
  it("maps every captured fixture to a schema-valid frame or a documented journal-only skip", async () => {
    const files = (await readdir(FIXTURES_DIR)).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(11);

    for (const file of files) {
      const envelope = await loadFixture(file);
      const frame = mapOfapiEventToSyncEvent(envelope);
      if (envelope.event === "transactions.new") {
        expect(frame, file).toBeNull();
        continue;
      }

      expect(frame, file).not.toBeNull();
      expect(syncEventSchema.safeParse(frame).success, file).toBe(true);
    }
  });

  it("maps messages.received to messageReceived with fan chat id and message id", async () => {
    const envelope = await loadFixture("messages_received.json");
    const payload = envelope.payload as {
      fromUser: { id: number };
      id: number;
      text: string;
      createdAt: string;
      price: number;
      isOpened: boolean;
      isNew: boolean;
      isTip: boolean;
      mediaCount: number;
    };

    const frame = asMessageFrame(mapOfapiEventToSyncEvent(envelope));
    expect(frame).toMatchObject({
      type: "messageReceived",
      accountId: envelope.account_id,
      chatId: String(payload.fromUser.id),
      messageId: String(payload.id),
    });
    expect(frame.message).toMatchObject({
      id: String(payload.id),
      text: payload.text,
      createdAt: payload.createdAt,
      isSentByMe: false,
      price: payload.price,
      isOpened: payload.isOpened,
      isNew: payload.isNew,
      isTip: payload.isTip,
      mediaCount: payload.mediaCount,
    });
    expect(frame.message?.replyTo).toMatchObject({
      sender: "model",
      textPreview: expect.any(String),
    });
  });

  it("maps messages.sent to messageSent keyed by the recipient fan", async () => {
    const envelope = await loadFixture("messages_sent.json");
    const payload = envelope.payload as {
      toUser: { id: number };
      id: number;
      text: string;
      createdAt: string;
      price: number;
    };

    const frame = asMessageFrame(mapOfapiEventToSyncEvent(envelope));
    expect(frame).toMatchObject({
      type: "messageSent",
      accountId: envelope.account_id,
      chatId: String(payload.toUser.id),
      messageId: String(payload.id),
    });
    expect(frame.message).toMatchObject({
      id: String(payload.id),
      text: payload.text,
      createdAt: payload.createdAt,
      isSentByMe: true,
      price: payload.price,
    });
    expect(frame.message?.media?.length).toBeGreaterThan(0);
  });

  it("normalizes message media metadata without URL-bearing OFAPI fields", () => {
    const frame = asMessageFrame(mapOfapiEventToSyncEvent({
      event: "messages.sent",
      account_id: "acct_test",
      payload: {
        id: "m_media",
        text: "",
        createdAt: "2026-06-10T18:35:30+00:00",
        toUser: { id: "fan_1" },
        mediaCount: 1,
        media: [{
          id: "media_1",
          type: "sticker",
          canView: false,
          isReady: false,
          duration: 12,
          files: { full: { url: "https://example.invalid/full.jpg" } },
          videoSources: { 720: "https://example.invalid/video.mp4" },
        }],
      },
    }));

    expect(frame.message?.media).toEqual([{
      id: "media_1",
      type: "other",
      isReady: false,
      locked: true,
      durationSeconds: 12,
    }]);
    expect(hasNestedKey(frame.message, "files")).toBe(false);
    expect(hasNestedKey(frame.message, "videoSources")).toBe(false);
    expect(hasNestedKey(frame.message, "url")).toBe(false);
  });

  it("derives reply sender from the reply author id instead of nonexistent isSentByMe", () => {
    const frame = asMessageFrame(mapOfapiEventToSyncEvent({
      event: "messages.received",
      account_id: "acct_test",
      payload: {
        id: "m_reply",
        text: "<p>new</p>",
        createdAt: "2026-06-10T18:35:30+00:00",
        fromUser: { id: "fan_1" },
        replyToMessage: {
          id: "old_1",
          text: "<p>older model text</p>",
          fromUser: { id: "model_1" },
        },
      },
    }));

    expect(frame.message?.replyTo).toEqual({
      messageId: "old_1",
      sender: "model",
      textPreview: "older model text",
    });
  });

  it("maps messages.deleted to the core messageDeleted extension (no chat id upstream)", async () => {
    const envelope = await loadFixture("messages_deleted.json");
    const payload = envelope.payload as { id: string };

    expect(mapOfapiEventToSyncEvent(envelope)).toEqual({
      type: "messageDeleted",
      accountId: envelope.account_id,
      messageId: payload.id,
    });
  });

  it("maps notification-shaped ppv unlock to the fan id without fabricating a message id", async () => {
    const envelope = await loadFixture("messages_ppv_unlocked.json");
    const payload = envelope.payload as { user: { id: number } };

    expect(mapOfapiEventToSyncEvent(envelope)).toEqual({
      type: "ppvUnlocked",
      accountId: envelope.account_id,
      chatId: String(payload.user.id),
    });
    expect(mapOfapiEventToSyncEvent(envelope)).not.toHaveProperty("message");
  });

  it("recovers the chat and message ids from the notification chat link when present", () => {
    // No payload.user here: both ids come from the chat link. payload.user_id is
    // deliberately ignored — live captures show it holds the creator's id.
    const frame = mapOfapiEventToSyncEvent({
      event: "messages.ppv.unlocked",
      account_id: "acct_test",
      payload: {
        id: "n-1",
        user_id: "514788334",
        text: "has purchased your <a href='https://onlyfans.com/my/chats/chat/777?firstId=123456'>message</a> for $5.00!",
      },
    });

    expect(frame).toEqual({
      type: "ppvUnlocked",
      accountId: "acct_test",
      chatId: "777",
      messageId: "123456",
    });
  });

  it("skips notification events whose fan id is unrecoverable instead of using user_id", () => {
    expect(mapOfapiEventToSyncEvent({
      event: "tips.received",
      account_id: "acct_test",
      payload: {
        id: "n-2",
        user_id: "514788334",
        amountGross: 5,
        text: "paid you a tip of $5.00",
      },
    })).toBeNull();
  });

  it("maps tips.received with the gross dollar amount", async () => {
    const envelope = await loadFixture("unverified_tips_received.json");
    const payload = envelope.payload as { user: { id: number }; amountGross: number };

    expect(mapOfapiEventToSyncEvent(envelope)).toEqual({
      type: "tipReceived",
      accountId: envelope.account_id,
      chatId: String(payload.user.id),
      amountUsd: payload.amountGross,
    });
    expect(mapOfapiEventToSyncEvent(envelope)).not.toHaveProperty("message");
  });

  it("falls back to the id-only frame when the message body is incomplete", () => {
    expect(mapOfapiEventToSyncEvent({
      event: "messages.received",
      account_id: "acct_test",
      payload: {
        id: "m_incomplete",
        fromUser: { id: "fan_1" },
        createdAt: "not-a-date",
        text: "<p>ignored body</p>",
      },
    })).toEqual({
      type: "messageReceived",
      accountId: "acct_test",
      chatId: "fan_1",
      messageId: "m_incomplete",
    });
  });

  it("maps subscription events to a chatListUpdated hint", async () => {
    for (const file of ["subscriptions_new.json", "unverified_subscriptions_renewed.json"]) {
      const envelope = await loadFixture(file);
      expect(mapOfapiEventToSyncEvent(envelope), file).toEqual({
        type: "chatListUpdated",
        accountId: envelope.account_id,
      });
    }
  });

  it("maps presence events with epoch-ms lastSeenAt", async () => {
    const online = await loadFixture("users_online.json");
    const onlinePayload = online.payload as { fan: { id: string }; last_seen_online_at: string };
    expect(mapOfapiEventToSyncEvent(online)).toEqual({
      type: "presence",
      accountId: online.account_id,
      chatId: onlinePayload.fan.id,
      online: true,
      lastSeenAt: Date.parse(onlinePayload.last_seen_online_at),
    });

    const offline = await loadFixture("users_offline.json");
    expect(mapOfapiEventToSyncEvent(offline)).toMatchObject({
      type: "presence",
      online: false,
    });
  });

  it("maps users.typing to a typing frame", async () => {
    const envelope = await loadFixture("users_typing.json");
    const payload = envelope.payload as { id: number };

    expect(mapOfapiEventToSyncEvent(envelope)).toEqual({
      type: "typing",
      accountId: envelope.account_id,
      chatId: String(payload.id),
    });
  });

  it("maps account lifecycle events to accountAuthChanged", () => {
    const cases: Array<[string, boolean]> = [
      ["accounts.connected", true],
      ["accounts.reconnected", true],
      ["accounts.session_expired", true],
      ["accounts.authentication_failed", false],
      ["accounts.otp_code_required", false],
      ["accounts.face_otp_required", false],
    ];

    for (const [event, authenticated] of cases) {
      expect(mapOfapiEventToSyncEvent({ event, account_id: "acct_test", payload: {} }), event).toEqual({
        type: "accountAuthChanged",
        accountId: "acct_test",
        authenticated,
      });
    }
  });

  it("returns null for unknown events, missing account ids, and malformed payloads", () => {
    expect(mapOfapiEventToSyncEvent({
      event: "posts.liked",
      account_id: "acct_test",
      payload: {},
    })).toBeNull();
    expect(mapOfapiEventToSyncEvent({
      event: "messages.received",
      account_id: null,
      payload: { id: 1, fromUser: { id: 2 } },
    })).toBeNull();
    expect(mapOfapiEventToSyncEvent({
      event: "messages.received",
      account_id: "acct_test",
      payload: { id: 1 },
    })).toBeNull();
    expect(mapOfapiEventToSyncEvent({
      event: "users.typing",
      account_id: "acct_test",
      payload: "not-an-object",
    })).toBeNull();
  });
});
