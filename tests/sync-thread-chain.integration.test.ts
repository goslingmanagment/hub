import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  countStoredMessagesOlderThan,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  effectiveHistoryStateSql,
  ensureSyncPage,
  listPageThreadChains,
  openThreadSummary,
  readThreadChain,
  readThreadStoredFacts,
  resetThreadChain,
  ThreadChainInvalidError,
  ThreadChainRebuildModeError,
  ThreadSummaryRefusedError,
  upsertPageDmMessages,
  writeRebuiltThreadChain,
  writeThreadChain,
  writeThreadSummary,
  writeThreadSummaryAfterDeletion,
  type Database,
  type SyncPageMode,
  type ThreadChainState,
} from "@agency_hub_core/db";

import { runMigrations } from "../packages/db/src/migrate-runner.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// Fansly Sync Engine design §2.3, §2.10, I9: the chain columns of a DM thread
// and their one writer, the summary columns only an engine-owned page may
// write (from message_archive since step 4, S4-08), the effective history
// state, and 0231's one-time marking.

const CHAIN_COLUMNS = [
  "head_confirmed_id", "head_confirmed_at", "contiguous_oldest_id", "contiguous_oldest_at", "contiguous_count",
  "chain_upward_count", "chain_epoch", "history_state", "history_proof", "history_proven_at",
  "history_proof_observation_id", "history_proof_observation_received_at", "history_proof_raw_payload_id",
  "chain_source", "chain_journal_watermark",
];

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function inTx<T>(body: (tx: Database) => Promise<T>): Promise<T> {
  return testDb!.db.transaction(async (tx) => body(tx as unknown as Database));
}

async function seedPage(label = `chain-${randomUUID().slice(0, 8)}`): Promise<number> {
  const model = await createModel(db(), { slug: `model-${label}`, name: label });
  const page = await createFanslyPage(db(), { modelId: model!.id, label });
  await ensureSyncPage(db(), { pageId: page!.id });
  return page!.id;
}

async function seedThread(pageId: number, groupId: string, legacy: {
  stored?: string[];
  coverage?: "pending_backfill" | "partial_window" | "complete";
  lastSyncAt?: Date | null;
} = {}): Promise<number> {
  const stored = legacy.stored ?? [];
  const result = await testDb!.pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id,
       stored_message_count, newest_stored_message_id, oldest_stored_message_id, message_coverage_status,
       message_backfill_complete, last_message_sync_at, last_fan_message_at)
     values ($1, $2, $3, $4, $5, $6, $7::dm_message_coverage_status, $8, $9, $10) returning id::text as id`,
    [
      pageId, groupId, `partner-${groupId}`, stored.length, stored[0] ?? null, stored[stored.length - 1] ?? null,
      legacy.coverage ?? "pending_backfill", legacy.coverage === "complete", legacy.lastSyncAt ?? null,
      stored.length > 0 ? new Date("2026-09-01T00:00:00Z") : null,
    ],
  );
  const threadId = Number(result.rows[0]!.id);
  if (stored.length > 0) {
    await upsertPageDmMessages(db(), stored.map((id, index) => ({
      conversationId: threadId,
      platformAccountId: pageId,
      platformMessageId: id,
      senderPlatformUserId: index % 2 === 0 ? `partner-${groupId}` : "page",
      senderRole: index % 2 === 0 ? "fan" as const : "model" as const,
      createdAt: new Date(Date.parse("2026-09-01T00:00:00Z") - index * 60_000),
      content: `m${id}`,
      totalTipAmountCents: 0,
      inReplyToMessageId: null,
      inReplyToRootMessageId: null,
    })));
  }
  return threadId;
}

/** Archive rows of a thread's conversation (the DM apply's feed writes them). */
async function archive(pageId: number, groupId: string, rows: Array<{
  ref: string; at: string; role?: "fan" | "model" | "unknown"; deleted?: boolean; pending?: boolean;
}>): Promise<void> {
  for (const row of rows) {
    await testDb!.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me,
         occurred_at, text_plain, deleted_at, content_pending)
       values ($1, 'fansly', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [pageId, groupId, row.ref, row.role ?? "fan", row.role === "model", row.at, `m${row.ref}`,
        row.deleted ? row.at : null, row.pending === true],
    );
  }
}

async function threadRow(threadId: number): Promise<Record<string, unknown>> {
  const result = await testDb!.pool.query<{ row: Record<string, unknown> }>(
    "select to_jsonb(t) as row from page_dm_threads t where id = $1",
    [threadId],
  );
  return result.rows[0]!.row;
}

function withoutChain(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([column]) => !CHAIN_COLUMNS.includes(column)));
}

/** The page's mode, written directly: no lever reaches `handover` or `live` (I17). */
async function moveTo(pageId: number, path: readonly SyncPageMode[]): Promise<void> {
  for (const to of path) {
    await testDb!.pool.query(
      "update sync_pages set mode = $2, mode_changed_at = clock_timestamp(), mode_changed_by = 'test' where page_id = $1",
      [pageId, to],
    );
  }
}

const completeChain: ThreadChainState = {
  epoch: 1,
  state: "complete",
  headId: "1030",
  headAt: new Date("2026-09-20T10:00:00Z"),
  oldestId: "1001",
  oldestCreatedAtMs: Date.parse("2026-08-01T00:00:00Z"),
  count: 30,
  upwardCount: 4,
  proof: "empty_page",
  proofWitness: { kind: "raw", rawPayloadId: 777 },
  provenAt: new Date("2026-09-20T10:00:05Z"),
};

describe("writeThreadChain (I9: chain columns only)", () => {
  it("writes the chain columns and nothing else — not even updated_at", async () => {
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, "900", { stored: ["1003", "1002", "1001"], coverage: "complete" });
    const before = await threadRow(threadId);

    const written = await inTx((tx) => writeThreadChain(tx, threadId, {
      chain: completeChain, source: "journal_rebuild", journalWatermark: 55,
    }));
    expect(written).toEqual({ previousEpoch: 0, epochChanged: true });

    const after = await threadRow(threadId);
    expect(withoutChain(after)).toEqual(withoutChain(before));
    expect(after).toMatchObject({
      head_confirmed_id: "1030",
      contiguous_oldest_id: "1001",
      contiguous_count: 30,
      chain_upward_count: 4,
      chain_epoch: 1,
      history_state: "complete",
      history_proof: "empty_page",
      history_proof_raw_payload_id: 777,
      history_proof_observation_id: null,
      chain_source: "journal_rebuild",
      chain_journal_watermark: 55,
    });
    const read = await readThreadChain(db(), threadId);
    expect(read).toMatchObject({
      threadId, pageId, groupId: "900", source: "journal_rebuild", journalWatermark: 55,
      effectiveHistoryState: "complete", storedMessageCount: 3, messageCoverageStatus: "complete",
    });
    expect(read!.chain).toEqual(completeChain);
  });

  it("stores an engine proof by its observation, and never lowers the journal watermark", async () => {
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, "901");
    await inTx((tx) => writeThreadChain(tx, threadId, { chain: completeChain, source: "journal_rebuild", journalWatermark: 90 }));
    const engineProof: ThreadChainState = {
      ...completeChain,
      proofWitness: { kind: "observation", observationId: 4242, receivedAt: new Date("2026-09-21T00:00:00Z") },
    };
    const written = await inTx((tx) => writeThreadChain(tx, threadId, { chain: engineProof, source: "engine" }));
    expect(written).toEqual({ previousEpoch: 1, epochChanged: false });
    const read = await readThreadChain(db(), threadId);
    expect(read!.chain.proofWitness).toEqual(engineProof.proofWitness);
    expect(read!.source).toBe("engine");
    expect(read!.journalWatermark).toBe(90);
    expect(await threadRow(threadId)).toMatchObject({ history_proof_raw_payload_id: null });
  });

  it("refuses an inconsistent chain (a caller bug) and a missing thread", async () => {
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, "902");
    const bad: ThreadChainState[] = [
      { ...completeChain, proof: null },
      { ...completeChain, state: "partial" },
      { ...completeChain, headId: null },
      { ...completeChain, count: 0 },
      { ...completeChain, state: "unverified", proof: null, proofWitness: null, provenAt: null },
      { ...completeChain, headId: "x1" },
      { ...completeChain, headAt: null },
    ];
    for (const chain of bad) {
      await expect(inTx((tx) => writeThreadChain(tx, threadId, { chain, source: "engine" })))
        .rejects.toBeInstanceOf(ThreadChainInvalidError);
    }
    await expect(inTx((tx) => writeThreadChain(tx, threadId + 999, { chain: completeChain, source: "engine" })))
      .rejects.toThrow(/no such thread/);
    expect((await readThreadChain(db(), threadId))!.chain.state).toBe("none");
  });

  it("resets a chain to a new epoch, unverified while the hub holds messages", async () => {
    const pageId = await seedPage();
    const holding = await seedThread(pageId, "903", { stored: ["2001"] });
    const empty = await seedThread(pageId, "904");
    for (const threadId of [holding, empty]) {
      await inTx((tx) => writeThreadChain(tx, threadId, { chain: completeChain, source: "journal_rebuild", journalWatermark: 5 }));
    }
    expect(await inTx((tx) => resetThreadChain(tx, holding))).toEqual({ epoch: 2 });
    await inTx((tx) => resetThreadChain(tx, empty));
    expect(await readThreadChain(db(), holding)).toMatchObject({
      chain: { state: "unverified", epoch: 2, headId: null, count: 0, proof: null, proofWitness: null },
      source: null,
      journalWatermark: 0,
    });
    expect((await readThreadChain(db(), empty))!.chain.state).toBe("none");
    expect(await inTx((tx) => resetThreadChain(tx, 999_999))).toBeNull();
  });
});

describe("effective history state", () => {
  it("reads 'none' with stored messages as 'unverified'", async () => {
    const pageId = await seedPage();
    const noneEmpty = await seedThread(pageId, "910");
    const noneStored = await seedThread(pageId, "911", { stored: ["3001"] });
    const partial = await seedThread(pageId, "912", { stored: ["3002"] });
    await inTx((tx) => writeThreadChain(tx, partial, {
      chain: { ...completeChain, state: "partial", proof: null, proofWitness: null, provenAt: null },
      source: "journal_rebuild",
    }));
    // listPageThreadChains reads the state through effectiveHistoryStateSql("t").
    expect((await listPageThreadChains(db(), { pageId })).map((row) => [row.threadId, row.chain.state, row.effectiveHistoryState]))
      .toEqual([[noneEmpty, "none", "none"], [noneStored, "none", "unverified"], [partial, "partial", "partial"]]);
    expect(await listPageThreadChains(db(), { pageId, threadId: noneStored })).toHaveLength(1);
    expect(() => effectiveHistoryStateSql("t; drop table x")).toThrow(/alias/);
  });
});

describe("stored facts", () => {
  it("count only non-deleted rows and compare ids as snowflakes", async () => {
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, "920", { stored: ["10000", "9999", "998", "50"] });
    await testDb!.pool.query(
      "update page_dm_messages set deleted_at = now() where conversation_id = $1 and platform_message_id = '50'",
      [threadId],
    );
    expect(await readThreadStoredFacts(db(), threadId)).toEqual({ nonDeletedCount: 3, oldestNonDeletedId: "998" });
    expect(await readThreadStoredFacts(db(), threadId + 1)).toEqual({ nonDeletedCount: 0, oldestNonDeletedId: null });
    expect(await countStoredMessagesOlderThan(db(), [
      { threadId, beforeId: "10000" },
      { threadId, beforeId: "999" },
      { threadId, beforeId: "998" },
      { threadId: threadId + 1, beforeId: "5" },
    ])).toEqual([2, 1, 0, 0]);
    expect(await countStoredMessagesOlderThan(db(), [])).toEqual([]);
  });

  it("read from the archive: stored messages only (no tombstone, no stub), the thread's conversation only", async () => {
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, "921");
    const other = await seedThread(pageId, "922");
    await archive(pageId, "921", [
      { ref: "10000", at: "2026-09-30T10:00:00Z" },
      { ref: "9999", at: "2026-09-30T09:00:00Z", role: "model" },
      { ref: "998", at: "2026-09-30T08:00:00Z" },
      { ref: "50", at: "2026-09-30T07:00:00Z", deleted: true },
      { ref: "40", at: "2026-09-30T06:00:00Z", deleted: true, pending: true },
    ]);
    await archive(pageId, "922", [{ ref: "7", at: "2026-09-30T05:00:00Z" }]);
    const store = { store: "message_archive" as const };
    expect(await readThreadStoredFacts(db(), threadId, store)).toEqual({ nonDeletedCount: 3, oldestNonDeletedId: "998" });
    // The hot table holds nothing of the thread.
    expect(await readThreadStoredFacts(db(), threadId)).toEqual({ nonDeletedCount: 0, oldestNonDeletedId: null });
    expect(await countStoredMessagesOlderThan(db(), [
      { threadId, beforeId: "10000" },
      { threadId, beforeId: "999" },
      { threadId, beforeId: "998" },
      { threadId: other, beforeId: "100" },
    ], store)).toEqual([2, 1, 0, 1]);
  });
});

describe("thread summary (the archive's messages, engine-owned pages only)", () => {
  const feed = [
    { ref: "1005", at: "2026-09-30T10:05:00Z", role: "fan" as const },
    { ref: "1004", at: "2026-09-30T10:04:00Z", role: "model" as const },
    { ref: "998", at: "2026-09-30T09:00:00Z", role: "fan" as const },
  ];

  it("throws on an off or shadow page and changes nothing", async () => {
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, "930", { stored: ["1001"] });
    await archive(pageId, "930", feed);
    const before = await threadRow(threadId);
    const write = (id: number) => inTx(async (tx) => {
      const opening = await openThreadSummary(tx, id, ["1005"]);
      return writeThreadSummary(tx, { ...opening, storedBefore: new Set() }, { headReadAt: new Date() });
    });
    await expect(write(threadId)).rejects.toBeInstanceOf(ThreadSummaryRefusedError);
    await expect(inTx((tx) => writeThreadSummaryAfterDeletion(tx, threadId))).rejects.toBeInstanceOf(ThreadSummaryRefusedError);
    await moveTo(pageId, ["shadow"]);
    await expect(write(threadId)).rejects.toThrow(/handover or live .*'shadow'/);
    expect(await threadRow(threadId)).toEqual(before);
    await expect(write(threadId + 999)).rejects.toThrow(/no such thread/);
  });

  it("adds the archive messages the feed stored, incrementally, and maps the effective history state on a live page", async () => {
    const pageId = await seedPage();
    const lastSync = new Date("2026-09-30T12:00:00Z");
    const threadId = await seedThread(pageId, "931", { stored: ["1003", "1001"], lastSyncAt: lastSync });
    await archive(pageId, "931", [
      { ref: "1003", at: "2026-09-30T08:03:00Z" },
      { ref: "1001", at: "2026-09-30T08:01:00Z" },
    ]);
    await seedThread(pageId, "939");
    await moveTo(pageId, ["shadow", "handover", "live"]);

    // 0231 marked nothing here (the thread was created after it): 'none' with
    // stored messages reads as unverified ⇒ partial_window.
    const first = await inTx(async (tx) => {
      const opening = await openThreadSummary(tx, threadId, ["1005", "1004", "998", "1003", "1006", "1007", "1008", "x"]);
      expect([...opening.storedBefore]).toEqual(["1003"]);
      // The feed: three new messages; a deletion that came first (a stub
      // hydrated, still tombstoned); a stub; another chat's message.
      await archive(pageId, "931", [
        ...feed,
        { ref: "1006", at: "2026-09-30T10:06:00Z", deleted: true },
        { ref: "1007", at: "2026-09-30T10:07:00Z", deleted: true, pending: true },
      ]);
      await archive(pageId, "939", [{ ref: "1008", at: "2026-09-30T10:08:00Z" }]);
      return writeThreadSummary(tx, opening, { headReadAt: new Date("2026-09-30T11:00:00Z") });
    });
    expect(first).toEqual({ storedMessageCount: 5, messageCoverageStatus: "partial_window", added: 3 });
    expect(await threadRow(threadId)).toMatchObject({
      stored_message_count: 5,
      newest_stored_message_id: "1005",
      oldest_stored_message_id: "998",
      message_coverage_status: "partial_window",
      message_backfill_complete: false,
      last_message_sync_at: "2026-09-30T12:00:00+00:00",
      last_fan_message_at: "2026-09-30T10:05:00+00:00",
      last_model_message_at: "2026-09-30T10:04:00+00:00",
    });

    // A re-read of the same page stores nothing new: the count does not move.
    await inTx(async (tx) => {
      const opening = await openThreadSummary(tx, threadId, ["1005", "1004", "998"]);
      await writeThreadChain(tx, threadId, { chain: completeChain, source: "engine" });
      return writeThreadSummary(tx, opening, { headReadAt: new Date("2026-09-30T13:00:00Z") });
    });
    expect(await threadRow(threadId)).toMatchObject({
      stored_message_count: 5,
      newest_stored_message_id: "1005",
      message_coverage_status: "complete",
      message_backfill_complete: true,
      last_message_sync_at: "2026-09-30T13:00:00+00:00",
    });

    await inTx(async (tx) => {
      await writeThreadChain(tx, threadId, {
        chain: { ...completeChain, state: "partial", proof: null, proofWitness: null, provenAt: null }, source: "engine",
      });
      const opening = await openThreadSummary(tx, threadId, ["10000"]);
      await archive(pageId, "931", [{ ref: "10000", at: "2026-10-01T00:00:00Z", role: "unknown" }]);
      return writeThreadSummary(tx, opening, { headReadAt: null });
    });
    expect(await threadRow(threadId)).toMatchObject({
      stored_message_count: 6,
      // Snowflake order: "10000" is newer than "1005" although it sorts lower as text.
      newest_stored_message_id: "10000",
      message_coverage_status: "partial_window",
      last_message_sync_at: "2026-09-30T13:00:00+00:00",
      last_fan_message_at: "2026-09-30T10:05:00+00:00",
    });
  });

  it("maps a thread without messages or chain to pending_backfill on a handover page", async () => {
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, "932", { coverage: "complete" });
    await moveTo(pageId, ["shadow", "handover"]);
    expect(await inTx(async (tx) => writeThreadSummary(tx, await openThreadSummary(tx, threadId, []), { headReadAt: null })))
      .toEqual({ storedMessageCount: 0, messageCoverageStatus: "pending_backfill", added: 0 });
  });

  it("recounts the window from the archive after a deletion; head, coverage and chain stay", async () => {
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, "933", { stored: ["1003", "1002", "1001"], coverage: "complete" });
    await archive(pageId, "933", [
      { ref: "1003", at: "2026-09-30T10:03:00Z", role: "model" },
      { ref: "1002", at: "2026-09-30T10:02:00Z", deleted: true },
      { ref: "1001", at: "2026-09-30T10:01:00Z" },
      { ref: "999", at: "2026-09-30T09:59:00Z", deleted: true, pending: true },
      { ref: "998", at: "2026-09-30T09:58:00Z" },
    ]);
    await moveTo(pageId, ["shadow", "handover", "live"]);
    await inTx((tx) => writeThreadChain(tx, threadId, { chain: completeChain, source: "engine" }));
    const before = await threadRow(threadId);
    expect(await inTx((tx) => writeThreadSummaryAfterDeletion(tx, threadId))).toEqual({ storedMessageCount: 3 });
    const after = await threadRow(threadId);
    expect(after).toMatchObject({
      stored_message_count: 3,
      newest_stored_message_id: "1003",
      oldest_stored_message_id: "998",
      last_fan_message_at: "2026-09-30T10:01:00+00:00",
      last_model_message_at: "2026-09-30T10:03:00+00:00",
      message_coverage_status: "complete",
    });
    const untouched = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([column]) =>
      !["stored_message_count", "newest_stored_message_id", "oldest_stored_message_id", "last_fan_message_at",
        "last_model_message_at", "updated_at"].includes(column)));
    expect(untouched(after)).toEqual(untouched(before));
  });
});

describe("writeRebuiltThreadChain (the rebuild's write)", () => {
  const partialChain: ThreadChainState = { ...completeChain, state: "partial", proof: null, proofWitness: null, provenAt: null };

  it("writes on off and shadow pages, never over an engine chain or a concurrent run", async () => {
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, "940");
    const engine = await seedThread(pageId, "941");
    await inTx((tx) => writeThreadChain(tx, engine, { chain: completeChain, source: "engine" }));

    expect(await writeRebuiltThreadChain(db(), {
      pageId, threadId, chain: partialChain, expectedWatermark: 0, journalWatermark: 40,
    })).toEqual({ kind: "written", epochChanged: true });
    expect(await writeRebuiltThreadChain(db(), {
      pageId, threadId, chain: partialChain, expectedWatermark: 0, journalWatermark: 50,
    })).toEqual({ kind: "skipped", reason: "concurrent_write" });
    expect(await writeRebuiltThreadChain(db(), {
      pageId, threadId: engine, chain: partialChain, expectedWatermark: 0, journalWatermark: 50,
    })).toEqual({ kind: "skipped", reason: "engine_owned" });
    expect((await readThreadChain(db(), engine))!.chain).toEqual(completeChain);

    await moveTo(pageId, ["shadow"]);
    expect(await writeRebuiltThreadChain(db(), {
      pageId, threadId, chain: completeChain, expectedWatermark: 40, journalWatermark: 60,
    })).toEqual({ kind: "written", epochChanged: false });
    expect(await readThreadChain(db(), threadId)).toMatchObject({ source: "journal_rebuild", journalWatermark: 60 });

    const otherPage = await seedPage();
    expect(await writeRebuiltThreadChain(db(), {
      pageId: otherPage, threadId, chain: completeChain, expectedWatermark: 60, journalWatermark: 70,
    })).toEqual({ kind: "skipped", reason: "thread_missing" });
  });

  it("refuses a page in handover or live: the engine is the only chain writer there", async () => {
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, "942");
    await moveTo(pageId, ["shadow", "handover"]);
    await expect(writeRebuiltThreadChain(db(), {
      pageId, threadId, chain: partialChain, expectedWatermark: 0, journalWatermark: 10,
    })).rejects.toBeInstanceOf(ThreadChainRebuildModeError);
    await expect(writeRebuiltThreadChain(db(), {
      pageId, threadId, chain: partialChain, expectedWatermark: 0, journalWatermark: 10,
    })).rejects.toThrow(/'handover'/);

    await moveTo(pageId, ["live"]);
    await expect(writeRebuiltThreadChain(db(), {
      pageId, threadId, chain: partialChain, expectedWatermark: 0, journalWatermark: 10,
    })).rejects.toThrow(/'live'/);
    expect((await readThreadChain(db(), threadId))!.source).toBeNull();
  });
});

describe("0231 one-time marking", () => {
  it("marks Fansly threads with stored messages unverified, nothing else", async () => {
    const partialDb = await startIntegrationTestDatabase({ through: "0230_tip_context_observation_lineage.sql" });
    if (!partialDb) throw new Error("Docker Postgres required");
    try {
      const database = partialDb.db as unknown as Database;
      const model = await createModel(database, { slug: `m-${randomUUID()}`, name: "marking" });
      const fansly = await createFanslyPage(database, { modelId: model!.id, label: `f-${randomUUID().slice(0, 8)}` });
      const onlyFans = await createOnlyFansPage(database, { modelId: model!.id, label: `o-${randomUUID().slice(0, 8)}` });
      const insert = (pageId: number, groupId: string, stored: number) => partialDb.pool.query<{ id: string }>(
        `insert into page_dm_threads (platform_account_id, platform_conversation_id, stored_message_count, updated_at)
         values ($1, $2, $3, '2026-01-01T00:00:00Z') returning id::text as id`,
        [pageId, groupId, stored],
      );
      const holding = Number((await insert(fansly!.id, "1", 4)).rows[0]!.id);
      const empty = Number((await insert(fansly!.id, "2", 0)).rows[0]!.id);
      const other = Number((await insert(onlyFans!.id, "3", 9)).rows[0]!.id);

      const client = await partialDb.pool.connect();
      try {
        await runMigrations({ db: client, through: "0231_dm_thread_history_chain.sql" });
      } finally {
        client.release();
      }
      const rows = await partialDb.pool.query<{ id: string; history_state: string; updated_at: Date; contiguous_count: number }>(
        "select id::text as id, history_state, updated_at, contiguous_count from page_dm_threads order by id",
      );
      expect(rows.rows.map((row) => [Number(row.id), row.history_state, row.contiguous_count])).toEqual([
        [holding, "unverified", 0], [empty, "none", 0], [other, "none", 0],
      ]);
      expect(rows.rows.every((row) => row.updated_at.toISOString() === "2026-01-01T00:00:00.000Z")).toBe(true);
      await expect(partialDb.pool.query("update page_dm_threads set history_state = 'bogus' where id = $1", [holding]))
        .rejects.toThrow(/page_dm_threads_history_state_check/);
      await expect(partialDb.pool.query("update page_dm_threads set history_proof = 'short_page' where id = $1", [holding]))
        .rejects.toThrow(/page_dm_threads_history_proof_check/);
      await expect(partialDb.pool.query("update page_dm_threads set contiguous_count = -1 where id = $1", [holding]))
        .rejects.toThrow(/page_dm_threads_contiguous_count_check/);
      await expect(partialDb.pool.query("update page_dm_threads set history_proof_observation_id = 1 where id = $1", [holding]))
        .rejects.toThrow(/page_dm_threads_history_proof_observation_check/);
    } finally {
      await partialDb.stop();
    }
  }, 120_000);
});
