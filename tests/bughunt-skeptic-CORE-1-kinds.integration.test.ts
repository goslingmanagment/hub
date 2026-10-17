import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { insertObservation, type Database } from "@agency_hub_core/db";

import { prepareJournalBody } from "../apps/runtime/src/sync/fansly/capture.ts";
import { replaceJournalLoneSurrogates } from "../apps/runtime/src/sync/fansly/lib/journal-lone-surrogates.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// BUG HUNT 2026-10-09, skeptic CORE-1: which REAL journal kinds carry a
// U+0000 from a Fansly answer into the engine's jsonb capture (and so wedge
// tx 2 deterministically), and which drop it on the way. Each case runs the
// production `prepareJournalBody` and the production `insertObservation`
// (`JSON.stringify(payload)::jsonb`) on a real Postgres.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

function sqlState(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

let seq = 0;
async function journal(kind: string, payload: unknown): Promise<string> {
  seq += 1;
  try {
    await insertObservation(db(), {
      source: "pull",
      producer: "fansly-sync:skeptic",
      platform: "fansly",
      accountId: null,
      kind,
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload ?? null)).digest(),
      idempotencyKey: `skeptic-core-1:${seq}`,
    });
    return "ok";
  } catch (error) {
    return sqlState(error) ?? `error:${error instanceof Error ? error.message : String(error)}`;
  }
}

const NUL = "\u0000";

describe("skeptic CORE-1: U+0000 through the real journal kinds", () => {
  it("maps which captures a NUL wedges", async (context) => {
    if (!testDb) return context.skip();
    const prepared = (kind: string, response: unknown, extra: Record<string, unknown> = {}) =>
      prepareJournalBody({ kind }, { response, contractAccepted: true, ...extra }).payload;

    const results = {
      // A fan's DM text: the /message page is journaled untrimmed.
      dm_messages_content: await journal("dm_messages", prepared("dm_messages", {
        messages: [{ id: "964923390089506816", groupId: "1", senderId: "2", content: `hi${NUL}there`, createdAt: 1 }],
      })),
      // The chat list redacts the last message's text …
      dm_conversations_last_message: await journal("dm_conversations", prepared("dm_conversations", {
        data: [{ groupId: "1", flags: 0, unreadCount: 0 }],
        aggregationData: { groups: [{ id: "1", lastMessage: { id: "3", content: `x${NUL}y` } }], accounts: [] },
      })),
      // … but keeps a fan's displayName.
      dm_conversations_display_name: await journal("dm_conversations", prepared("dm_conversations", {
        data: [{ groupId: "1", flags: 0, unreadCount: 0 }],
        aggregationData: { groups: [], accounts: [{ id: "2", username: "fan", displayName: `F${NUL}an` }] },
      })),
      // A fan profile read (fan-profiles.lookup): verbatim.
      account_lookup_about: await journal("account_lookup", prepared("account_lookup", [{ id: "2", username: "fan", about: `bio${NUL}` }])),
      // Another creator's bio in the discovery feed (the kind of the 2026-09-30 surrogate incident).
      discovery_feed_about: await journal("discovery_feed", prepared("discovery_feed", { accounts: [{ id: "9", about: `a${NUL}b` }] })),
      // A fan's comment under a post.
      post_replies_content: await journal("post_replies", prepared("post_replies", { posts: [{ id: "5", content: `c${NUL}` }] }, {
        walk: { postId: "4", before: null },
      })),
      // The failed-body journal of a non-2xx (same helper as commit.ts failedBody).
      failed_body_text: await journal("dm_messages:failed", replaceJournalLoneSurrogates({
        status: 502, contentType: "text/html", retryAfter: null, bodyText: `<html>${NUL}</html>`, truncated: false,
      }).value),
      // Control: the lone surrogate the codec DOES repair.
      control_lone_surrogate: await journal("dm_messages", prepared("dm_messages", {
        messages: [{ id: "1", content: "broken \uD83D emoji" }],
      })),
      // Control: the same text without NUL.
      control_plain: await journal("dm_messages", prepared("dm_messages", { messages: [{ id: "1", content: "hi there" }] })),
    };
    console.log(JSON.stringify(results, null, 2));
    expect(results).toEqual({
      dm_messages_content: "22P05",
      dm_conversations_last_message: "ok",
      dm_conversations_display_name: "22P05",
      account_lookup_about: "22P05",
      discovery_feed_about: "22P05",
      post_replies_content: "22P05",
      failed_body_text: "22P05",
      control_lone_surrogate: "ok",
      control_plain: "ok",
    });
  }, 120_000);
});
