import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { syncEventSchema } from "@agency_hub_core/contracts";
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
    const payload = envelope.payload as { fromUser: { id: number }; id: number };

    expect(mapOfapiEventToSyncEvent(envelope)).toEqual({
      type: "messageReceived",
      accountId: envelope.account_id,
      chatId: String(payload.fromUser.id),
      messageId: String(payload.id),
    });
  });

  it("maps messages.sent to messageSent keyed by the recipient fan", async () => {
    const envelope = await loadFixture("messages_sent.json");
    const payload = envelope.payload as { toUser: { id: number }; id: number };

    expect(mapOfapiEventToSyncEvent(envelope)).toEqual({
      type: "messageSent",
      accountId: envelope.account_id,
      chatId: String(payload.toUser.id),
      messageId: String(payload.id),
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
