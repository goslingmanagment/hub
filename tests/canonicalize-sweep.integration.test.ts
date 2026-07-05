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
  // (tips.received graduated to declared in family v2 — Stage 14; users.typing
  // is the remaining unmapped-by-design representative.)
  await insertObservation(db, {
    source: "webhook",
    producer: "ofapi:webhook",
    platform: "onlyfans",
    accountId: 4,
    kind: "users.typing",
    payload: { event: "users.typing", payload: { user: { id: 778 } } },
    payloadHash: sha256("typing-1"),
    idempotencyKey: "evt-sweep-typing-1",
  });
  // 4b. tips.received — declared as of v2, parses from the verified shape.
  await insertObservation(db, {
    source: "webhook",
    producer: "ofapi:webhook",
    platform: "onlyfans",
    accountId: 4,
    kind: "tips.received",
    payload: {
      event: "tips.received",
      payload: { id: "n1", user: { id: 310112051 }, amountGross: 8, amountNet: 6.4, createdAt: "2026-06-30T14:42:00+00:00" },
    },
    payloadHash: sha256("tip-1"),
    idempotencyKey: "evt-sweep-tip-1",
  });
  // 4c. Client-capture (Stage 11): registration-only family — the sweep
  // stamps parse_version with ZERO events (desktop facts wait for Stage 29).
  await insertObservation(db, {
    source: "client_capture",
    producer: "desktop@0.1.29",
    platform: null,
    accountId: 4,
    kind: "desktop.ai_acceptance",
    payload: { suggestionId: "s1", outcome: "inserted" },
    payloadHash: sha256("cc-1"),
    idempotencyKey: "cc-sweep-1",
  });
  // 4d. desktop.unknown:* stays OUTSIDE the family — pending at 0.
  await insertObservation(db, {
    source: "client_capture",
    producer: "desktop@0.1.29",
    platform: null,
    accountId: 4,
    kind: "desktop.unknown:mystery_metric",
    payload: { n: 1 },
    payloadHash: sha256("cc-2"),
    idempotencyKey: "cc-sweep-2",
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
      appended: 4,       // message + transaction + command.settled + tip.received
      deduped: 0,
      stamped: 5,        // + the client-capture row (zero events by design)
      skippedUnmapped: 1,
    });

    const account4 = await listEventsSince(testDb.db, { accountId: 4, afterSeq: 0 });
    expect(account4.map((event) => event.type).sort())
      .toEqual(["command.settled", "message.received", "tip.received"]);
    expect(account4.find((event) => event.type === "tip.received")).toMatchObject({
      dedupKey: "tip:n1",
      fanIdentityRef: "310112051",
    });
    const account3 = await listEventsSince(testDb.db, { accountId: 3, afterSeq: 0 });
    expect(account3[0]).toMatchObject({ type: "transaction.posted", dedupKey: "txn:ftx-9" });

    // The undeclared kind stays at parse_version 0 (capture now, parse later).
    const typingRow = await testDb.pool.query<{ parse_version: number }>(
      "select parse_version from observations where kind = 'users.typing'",
    );
    expect(typingRow.rows[0]?.parse_version).toBe(0);

    // Stage 11 family: declared desktop kind stamped (zero events), unknown
    // desktop kind pending.
    const captureRows = await testDb.pool.query<{ kind: string; parse_version: number }>(
      "select kind, parse_version from observations where source = 'client_capture' order by kind",
    );
    expect(captureRows.rows).toEqual([
      // v2 since Stage 12 (harvest kinds joined the family).
      { kind: "desktop.ai_acceptance", parse_version: 2 },
      { kind: "desktop.unknown:mystery_metric", parse_version: 0 },
    ]);

    // Second sweep: stamped rows are gone from the listing; only the unmapped
    // row is rescanned (and skipped again).
    const second = await runCanonicalization(appStub());
    expect(second).toMatchObject({ appended: 0, stamped: 0, skippedUnmapped: 1 });

    // Version bump (replay): rescans consumed rows, appends nothing new.
    // Floor must exceed EVERY family's current version (sync-pull is v3
    // since Stage 16's parse slice) so all stamped rows rescan.
    const replay = await runCanonicalization(appStub(), { belowParseVersion: 99 });
    expect(replay.appended).toBe(0);
    expect(replay.deduped).toBe(4);
    expect(await listEventsSince(testDb.db, { accountId: 4, afterSeq: 0 })).toHaveLength(3);

    // Dry-run never writes: only the unmapped row remains below the current
    // family versions; narrow to its kind and confirm counts only.
    const dry = await runCanonicalization(appStub(), { kinds: ["messages.received"], dryRun: true });
    expect(dry.stamped).toBe(0);
    expect(dry.appended).toBeGreaterThan(0); // the unmapped row's draft, counted not written
  });

  it("isolates a poison row: one throwing observation never wedges the sweep", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const db = testDb.db;
    await insertObservation(db, {
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      accountId: 4,
      kind: "poison.test",
      payload: { poison: true },
      payloadHash: sha256("poison-1"),
      idempotencyKey: "iso-poison-1",
    });
    await insertObservation(db, {
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      accountId: 4,
      kind: "poison.test",
      payload: { poison: false },
      payloadHash: sha256("healthy-1"),
      idempotencyKey: "iso-healthy-1",
    });

    const throwingFamily = {
      source: "webhook" as const,
      kinds: ["poison.test"],
      version: 1,
      canonicalize: (observation: { payload: unknown }) => {
        if ((observation.payload as { poison?: boolean }).poison === true) {
          throw new Error("boom");
        }
        return [{
          type: "message.received",
          occurredAt: new Date("2026-06-01T00:00:00.000Z"),
          fanIdentityRef: "555",
          messageRef: "iso-1",
          data: {},
          schemaVersion: 1,
          dedupKey: "msg:received:iso-1",
        }];
      },
    };

    // The healthy row lands and stamps; the poison row errors, stays
    // unstamped, and the run STILL RETURNS (no wedge).
    const first = await runCanonicalization(appStub(), { families: [throwingFamily] });
    expect(first).toMatchObject({ errored: 1, stamped: 1, appended: 1 });

    const pending = await testDb.pool.query<{ parse_version: number }>(
      "select parse_version from observations where idempotency_key = 'iso-poison-1'",
    );
    expect(pending.rows[0]?.parse_version).toBe(0);

    // Next sweep retries ONLY the poison row and errors again — bounded,
    // never spreading to already-stamped work.
    const second = await runCanonicalization(appStub(), { families: [throwingFamily] });
    expect(second).toMatchObject({ scanned: 1, errored: 1, stamped: 0, appended: 0 });
  });
});
