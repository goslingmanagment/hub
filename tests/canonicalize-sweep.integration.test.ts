import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { insertObservation, listEventsSince } from "@agency_hub_core/db";

import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

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

function sha256(payload: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(payload)).digest();
}

function appStub() {
  return {
    db: testDb!.db,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

async function seedCorpus() {
  const db = testDb!.db;
  // 1. Webhook DM for account 4.
  await insertObservation(db, {
    source: "webhook",
    producer: "ofapi:webhook",
    platform: "onlyfans",
    accountId: 4,
    kind: "messages.received",
    payload: {
      event: "messages.received",
      account_id: "acct_x",
      payload: { id: 9001, createdAt: "2026-06-20T10:00:00+00:00", fromUser: { id: 777 }, text: "hey", price: 0, isTip: false, isFree: true, mediaCount: 0 },
    },
    payloadHash: sha256("wh-1"),
    idempotencyKey: "evt-sweep-1",
  });
  // 2. Pull transactions page for account 3 (fansly).
  await insertObservation(db, {
    source: "pull",
    producer: "sync:fansly:transactions",
    platform: "fansly",
    accountId: 3,
    kind: "earnings_transactions",
    payload: { total: 1, data: [{ transactionId: "ftx-9", correlationAccountId: "fan-2", type: 2110, amount: 100, destinationAmount: 80, status: 2, createdAt: Date.parse("2026-06-19T09:00:00Z") }] },
    payloadHash: sha256("pull-1"),
    idempotencyKey: "3:transactions:1:1",
  });
  // 3. Command result for account 4.
  await insertObservation(db, {
    source: "command_result",
    producer: "ofapi:command-executor",
    platform: "onlyfans",
    accountId: 4,
    kind: "command.confirmed",
    payload: { commandId: "cmd-1", commandKind: "send_text", pageId: 4, conversationId: "777", state: "confirmed" },
    payloadHash: sha256("cmd-1"),
    idempotencyKey: "cmd:cmd-1:confirmed",
  });
  // 4. Undeclared kind — must remain untouched at parse_version 0.
  await insertObservation(db, {
    source: "webhook",
    producer: "ofapi:webhook",
    platform: "onlyfans",
    accountId: 4,
    kind: "tips.received",
    payload: { event: "tips.received", payload: { id: "n1" } },
    payloadHash: sha256("tip-1"),
    idempotencyKey: "evt-sweep-tip-1",
  });
  // 5. Unmapped account (NULL) with a canonicalizable kind — retried, never lost.
  await insertObservation(db, {
    source: "webhook",
    producer: "ofapi:webhook",
    platform: "onlyfans",
    accountId: null,
    kind: "messages.received",
    payload: {
      event: "messages.received",
      account_id: "acct_unmapped",
      payload: { id: 9002, createdAt: "2026-06-20T11:00:00+00:00", fromUser: { id: 778 }, text: "yo", price: 0, isFree: true, mediaCount: 0 },
    },
    payloadHash: sha256("wh-2"),
    idempotencyKey: "evt-sweep-2",
  });
}

describe("canonicalization sweep (Stage 8)", () => {
  it("settles the corpus, leaves undeclared/unmapped pending, and replays idempotently", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedCorpus();

    const first = await runCanonicalization(appStub());
    expect(first).toMatchObject({
      appended: 3,       // message + transaction + command.settled
      deduped: 0,
      stamped: 3,
      skippedUnmapped: 1,
    });

    const account4 = await listEventsSince(testDb.db, { accountId: 4, afterSeq: 0 });
    expect(account4.map((event) => event.type).sort()).toEqual(["command.settled", "message.received"]);
    const account3 = await listEventsSince(testDb.db, { accountId: 3, afterSeq: 0 });
    expect(account3[0]).toMatchObject({ type: "transaction.posted", dedupKey: "txn:ftx-9" });

    // The undeclared tip stays at parse_version 0 (capture now, parse later).
    const tipRow = await testDb.pool.query<{ parse_version: number }>(
      "select parse_version from observations where kind = 'tips.received'",
    );
    expect(tipRow.rows[0]?.parse_version).toBe(0);

    // Second sweep: stamped rows are gone from the listing; only the unmapped
    // row is rescanned (and skipped again).
    const second = await runCanonicalization(appStub());
    expect(second).toMatchObject({ appended: 0, stamped: 0, skippedUnmapped: 1 });

    // Version bump (replay): rescans consumed rows, appends nothing new.
    // (floor 3 > every family's current version, so ALL stamped rows rescan —
    // sync-pull is already at v2 since Stage 17's fansly-DM declaration.)
    const replay = await runCanonicalization(appStub(), { belowParseVersion: 3 });
    expect(replay.appended).toBe(0);
    expect(replay.deduped).toBe(3);
    expect(await listEventsSince(testDb.db, { accountId: 4, afterSeq: 0 })).toHaveLength(2);

    // Dry-run never writes: only the unmapped row remains below the current
    // family versions; narrow to its kind and confirm counts only.
    const dry = await runCanonicalization(appStub(), { kinds: ["messages.received"], dryRun: true });
    expect(dry.stamped).toBe(0);
    expect(dry.appended).toBeGreaterThan(0); // the unmapped row's draft, counted not written
  });
});
