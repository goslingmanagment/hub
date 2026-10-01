// One observation per canonicalizer family (OnlyFans included), plus the
// edge rows every family shares: a shape-gate rejection, a terminal
// quarantine and an out-of-window occurred_at. The shared fixture of the
// canonicalization seam: `tests/canonicalize-drafts-parity.test.ts` runs them
// through the minutely driver, `tests/canonicalize-in-transaction.integration.test.ts`
// through the Fansly Sync Engine's in-transaction helper.

import { readFileSync } from "node:fs";
import path from "node:path";

import { FANSLY_WS_CAPTURE_KIND } from "@agency_hub_core/shared";

export const FIXTURE_RECEIVED_AT = new Date("2026-08-22T09:00:00.000Z");
/** The run instant: the clamp window's upper edge is two months after it. */
export const FIXTURE_NOW = new Date("2026-08-22T10:00:00.000Z");
/** The Fansly page's own native ref: DM direction resolves against it. */
export const FIXTURE_FANSLY_OWN_REF = "fansly-own-1";
export const FIXTURE_FANSLY_PAGE_ID = 11;
export const FIXTURE_ONLYFANS_PAGE_ID = 4;
/** The OnlyFans post ids the governed capture accepted (OF post replay). */
export const FIXTURE_ACCEPTED_OF_POST_REFS = ["103", "102"] as const;

export interface CanonicalFamilyFixture {
  /** Unique within the list; also the family `source:lane` it targets. */
  name: string;
  lane: string;
  /** What the seam must decide for it. */
  expect: "drafts" | "empty" | "rejected" | "quarantined";
  observation: {
    id: number;
    source: string;
    producer: string;
    platform: string | null;
    accountId: number | null;
    nativeAccountRef: string | null;
    kind: string;
    payload: unknown;
    observedAt: Date | null;
    receivedAt: Date;
  };
}

function json(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.resolve("tests/fixtures", file), "utf8")) as Record<string, unknown>;
}

function webhookEnvelope(name: string): Record<string, unknown> {
  const raw = json(`ofapi-webhooks/${name}.json`);
  delete raw._meta;
  return raw;
}

/** A captured OFAPI response envelope (ofapi-capture-contract.ts). */
function ofapiCapture(request: Record<string, unknown> | null, body: unknown) {
  return {
    ...(request === null ? {} : { request }),
    response: { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body), bodyEncoding: "utf8" },
  };
}

let nextId = 9_000;

function fansly(
  name: string,
  lane: string,
  kind: string,
  payload: unknown,
  expect: CanonicalFamilyFixture["expect"] = "drafts",
): CanonicalFamilyFixture {
  nextId += 1;
  return {
    name,
    lane,
    expect,
    observation: {
      id: nextId,
      source: "pull",
      producer: `sync:fansly:${kind}`,
      platform: "fansly",
      accountId: FIXTURE_FANSLY_PAGE_ID,
      nativeAccountRef: null,
      kind,
      payload,
      observedAt: null,
      receivedAt: FIXTURE_RECEIVED_AT,
    },
  };
}

function onlyfans(
  name: string,
  lane: string,
  source: string,
  kind: string,
  payload: unknown,
  expect: CanonicalFamilyFixture["expect"] = "drafts",
): CanonicalFamilyFixture {
  nextId += 1;
  return {
    name,
    lane,
    expect,
    observation: {
      id: nextId,
      source,
      producer: source === "webhook" ? "ofapi:webhook" : `${source}:onlyfans`,
      platform: "onlyfans",
      accountId: FIXTURE_ONLYFANS_PAGE_ID,
      nativeAccountRef: null,
      kind,
      payload,
      observedAt: null,
      receivedAt: FIXTURE_RECEIVED_AT,
    },
  };
}

/** Only the harvest uploader's rows may become message events. */
function withProducer(fixture: CanonicalFamilyFixture, producer: string): CanonicalFamilyFixture {
  return { ...fixture, observation: { ...fixture.observation, producer } };
}

const fanslyDmPage = {
  messages: [
    {
      id: "310000000000000001",
      groupId: "group-alpha",
      senderId: "fansly-fan-7",
      content: "hi!",
      createdAt: Date.parse("2026-08-21T09:00:00Z"),
      attachments: [],
      totalTipAmount: 0,
    },
    {
      id: "310000000000000002",
      groupId: "group-alpha",
      senderId: FIXTURE_FANSLY_OWN_REF,
      inReplyTo: "310000000000000001",
      content: "hello back",
      createdAt: Date.parse("2026-08-21T09:01:00Z"),
      attachments: [],
      totalTipAmount: 0,
    },
  ],
};

export function canonicalFamilyFixtures(): CanonicalFamilyFixture[] {
  nextId = 9_000;
  const ppvWithoutChat = webhookEnvelope("messages_ppv_unlocked");
  delete (ppvWithoutChat.payload as Record<string, unknown>).user;
  return [
    {
      name: "fansly_ws:signals",
      lane: "signals",
      expect: "drafts",
      observation: {
        id: 9_500,
        source: "fansly_ws",
        producer: "fansly:b0",
        platform: "fansly",
        accountId: FIXTURE_FANSLY_PAGE_ID,
        nativeAccountRef: null,
        kind: FANSLY_WS_CAPTURE_KIND,
        payload: {
          codec: FANSLY_WS_CAPTURE_KIND,
          generation: "a".repeat(64),
          frame: JSON.stringify({ t: 10000, d: { serviceId: 5, event: { type: 1, message: { id: "200", groupId: "100" } } } }),
        },
        observedAt: null,
        receivedAt: FIXTURE_RECEIVED_AT,
      },
    },
    onlyfans("ofapi_capture:read_collections", "read_collections", "ofapi_capture", "ofapi.collection_read_response.v1",
      ofapiCapture(
        { pathname: "/acct_test/fans/expired", query: { limit: "20", offset: "0" } },
        { data: { list: [{ id: 501, username: "expired-fan" }], hasMore: false } },
      )),
    onlyfans("ofapi_capture:ofapi-posts", "ofapi-posts", "ofapi_capture", "ofapi.posts_page.v1",
      ofapiCapture(null, json("ofapi-posts-page.json"))),
    onlyfans("webhook:ofapi", "ofapi", "webhook", "messages.received", webhookEnvelope("messages_received")),
    onlyfans("webhook:ofapi quarantine", "ofapi", "webhook", "messages.ppv.unlocked", ppvWithoutChat, "quarantined"),
    fansly("pull:posts", "posts", "posts", {
      posts: [{
        id: "post-42",
        accountId: FIXTURE_FANSLY_OWN_REF,
        content: "verbatim body",
        createdAt: 1_786_000_000,
        attachments: [{ contentType: 1, contentId: "media-1" }],
      }],
    }),
    fansly("pull:earnings", "earnings", "fan_earnings_stats", [
      { correlationAccountId: "fan-a", type: 2110, totalGross: 1000, totalNet: 800 },
    ]),
    fansly("pull:sync dm", "sync", "dm_messages", fanslyDmPage),
    fansly("pull:sync transactions", "sync", "earnings_transactions", {
      total: 1,
      data: [{
        transactionId: "ftx-1",
        walletId: "w-1",
        accountId: FIXTURE_FANSLY_OWN_REF,
        correlationAccountId: "fan-acct-9",
        senderId: "fan-acct-9",
        type: 2110,
        amount: 1000,
        destinationAmount: 800,
        destinationTax: 200,
        status: 2,
        createdAt: Date.parse("2026-08-01T10:00:00Z"),
      }],
    }),
    // A provider timestamp from 1970 (epoch zero): the clamp re-dates it to
    // the receipt and keeps the raw value.
    fansly("pull:sync clamp", "sync", "dm_messages", {
      messages: [{ ...fanslyDmPage.messages[0], id: "310000000000000009", createdAt: 1 }],
    }),
    fansly("pull:sync rejected", "sync", "dm_messages", { messages: {} }, "rejected"),
    fansly("pull:stats", "stats", "account_stats", json("fansly-stats/stats-account-daily.json")),
    fansly("pull:engagement", "engagement", "notifications", json("fansly-engagement/notifications-edge-cases.json")),
    fansly("pull:catalog", "catalog", "vault_albums", json("fansly-catalog/vault-albums.json")),
    // Already the `{walk, response}` observation envelope.
    fansly("pull:comments", "comments", "post_replies", json("fansly-comments/replies-four-with-accounts.json")),
    fansly("pull:payouts", "payouts", "payout_requests", json("fansly-payouts/payout-requests-page.json").page),
    onlyfans("command_result:result", "result", "command_result", "command.confirmed", {
      commandId: "cmd-77",
      commandKind: "send_text",
      pageId: FIXTURE_ONLYFANS_PAGE_ID,
      conversationId: "1000005",
      state: "confirmed",
      platformMessageId: "1000027",
    }),
    withProducer(onlyfans("client_capture:desktop", "desktop", "client_capture", "harvest.messages", {
      row: { message_id: "1000031", chat_id: "1000005", is_sent_by_me: 0, created_at: "2026-08-21T10:00:00Z", text_plain: "hey" },
    }), "desktop-harvest@test"),
  ];
}
