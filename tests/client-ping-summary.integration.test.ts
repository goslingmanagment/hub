import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createModel, createOnlyFansPage, setPageOfapiAccountId } from "@agency_hub_core/db";

import { computePingSummary, loadTranscriptContext } from "../apps/runtime/src/modules/ai/index.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// H-9a: generation and the chat-extension readers both compute the Ping
// summary as computePingSummary(loadTranscriptContext(...).messages, now).
// ai-ping-summary.test.ts pins the helper on hand-built rows; this file pins
// the loader half against the database: a stored message whose sender role is
// `system` or `unknown` (is_sent_by_me false) reaches the helper as the fan's,
// through the archive read and through the union read, so it counts toward
// the segment and the silence exactly as it does in a Ping generation.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
const CONV = "555201";
const OFAPI_ACCT = "acct_ping_summary";

type SenderRole = "fan" | "model" | "system" | "unknown";

async function seedPage() {
  const model = await createModel(testDb!.db, { slug: "ping-of", name: "ping-of" });
  if (!model) {
    throw new Error("model seed failed");
  }
  const page = await createOnlyFansPage(testDb!.db, { modelId: model.id, label: "ping-of" });
  if (!page) {
    throw new Error("page seed failed");
  }
  await setPageOfapiAccountId(testDb!.db, { pageId: page.id, ofapiAccountId: OFAPI_ACCT });
  return page;
}

async function insertArchiveRow(pageId: number, ref: string, role: SenderRole, daysAgo: number, text: string) {
  await testDb!.pool.query(
    `insert into message_archive (
       account_id, platform, conversation_ref, message_ref, sender_role,
       is_sent_by_me, occurred_at, text_plain, backfill_source
     ) values ($1, 'onlyfans', $2, $3, $4, $5, $6, $7, 'seed')`,
    [pageId, CONV, ref, role, role === "model", new Date(NOW_MS - daysAgo * DAY_MS), text],
  );
}

async function insertDmRow(pageId: number, ref: string, role: SenderRole, daysAgo: number, text: string) {
  await testDb!.pool.query(
    `insert into dm_message_archive (
       platform, platform_account_id, ofapi_account_id, platform_conversation_id,
       fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me,
       message_created_at, text_plain, is_tip, tip_amount_mills,
       source, source_event_type, source_idempotency_key,
       source_journal_id, source_received_at, retain_until
     ) values (
       'onlyfans', $1, $2, $3, $3, $4, $5, $6, $7, $8, false, 0,
       'webhook', 'messages.received', $9, 1, now(), now() + interval '100 years'
     )`,
    [pageId, OFAPI_ACCT, CONV, ref, role, role === "model", new Date(NOW_MS - daysAgo * DAY_MS), text, `ping-summary-${ref}`],
  );
}

async function loadAsGeneration(pageId: number, unionMode: "off" | "serve") {
  const transcript = await loadTranscriptContext({ db: testDb!.db }, { pageId, conversationRef: CONV, unionMode });
  return {
    source: transcript.contextManifest.source,
    senders: transcript.messages.map((message) => [String(message.id), message.sender]),
    summary: computePingSummary(transcript.messages, NOW_MS),
  };
}

describe("Ping summary over the real transcript loaders (H-9a)", () => {
  it("reads system and unknown sender roles in the archive as the fan, in the archive and the union read", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await insertArchiveRow(page.id, "7001", "fan", 14, "hi");
    await insertArchiveRow(page.id, "7002", "unknown", 13, "unknown sender");
    await insertArchiveRow(page.id, "7003", "system", 12, "subscription renewed");
    await insertArchiveRow(page.id, "7004", "model", 2, "miss you");
    await insertArchiveRow(page.id, "7005", "model", 1, "you there?");

    const expectedSenders = [["7001", "Fan"], ["7002", "Fan"], ["7003", "Fan"], ["7004", "Model"], ["7005", "Model"]];
    // Three fan texts, the newest 12 days old. Were system or unknown read as
    // the model's, this would be segment-b with 14 days of silence.
    for (const [mode, source] of [["off", "archive"], ["serve", "union"]] as const) {
      expect(await loadAsGeneration(page.id, mode)).toEqual({
        source,
        senders: expectedSenders,
        summary: { segment: "segment-a", fanSilenceDays: 12 },
      });
    }
  });

  it("reads system and unknown sender roles held only in dm_message_archive as the fan through the union", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await insertArchiveRow(page.id, "7101", "fan", 14, "hi");
    await insertDmRow(page.id, "7102", "unknown", 13, "unknown sender");
    await insertDmRow(page.id, "7103", "system", 12, "subscription renewed");
    await insertDmRow(page.id, "7104", "model", 1, "miss you");

    expect(await loadAsGeneration(page.id, "serve")).toEqual({
      source: "union",
      senders: [["7101", "Fan"], ["7102", "Fan"], ["7103", "Fan"], ["7104", "Model"]],
      summary: { segment: "segment-a", fanSilenceDays: 12 },
    });
    // The archive read alone holds one fan text: the dm rows are what move it.
    expect(await loadAsGeneration(page.id, "off")).toEqual({
      source: "archive",
      senders: [["7101", "Fan"]],
      summary: { segment: "segment-b", fanSilenceDays: 14 },
    });
  });
});
