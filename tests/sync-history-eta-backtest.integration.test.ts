import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, ensureSyncPage, insertRawPayload, type Database } from "@agency_hub_core/db";
import { createLogger } from "@agency_hub_core/shared";

import { ScanGovernor } from "../apps/runtime/src/sync/fansly/lib/chain-rebuild.ts";
import { backtestPageEta } from "../apps/runtime/src/sync/requests/eta-backtest.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// The ETA backtest over the legacy journal (design §7.2.4): a chain the
// journal proves complete is replayed as a request `all` filed when only its
// head page was known, and its estimate is set against the reads the walk
// took. Read-only.

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

const EPOCH_MS = 1561494359900;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-09-20T12:00:00Z");
const snowflake = (ms: number) => (BigInt(ms - EPOCH_MS) << 22n).toString();

async function seedPage(): Promise<number> {
  const label = `eta-${randomUUID().slice(0, 8)}`;
  const model = await createModel(db(), { slug: `model-${label}`, name: label });
  const page = await createFanslyPage(db(), { modelId: model!.id, label });
  await ensureSyncPage(db(), { pageId: page!.id });
  return page!.id;
}

async function seedThread(pageId: number, groupId: string): Promise<void> {
  await testDb!.pool.query(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id)
     values ($1, $2, 'fan')`,
    [pageId, groupId],
  );
}

/** Message i of a chat (0 = newest) was sent i hours before T0. */
const messageAt = (i: number) => T0 - i * HOUR;
const messageId = (i: number) => snowflake(messageAt(i));

async function page(pageId: number, groupId: string, before: string | null, from: number, to: number): Promise<void> {
  const messages = [];
  for (let i = from; i <= to; i += 1) messages.push({ id: messageId(i), createdAt: Math.floor(messageAt(i) / 1000), groupId });
  await insertRawPayload(db(), {
    platformAccountId: pageId,
    endpoint: "dm_messages",
    requestParams: { groupId, limit: 25, before },
    responsePayload: { messages, accountMedia: [] },
    mapperVersion: "test",
    payloadKind: "dm_messages",
    retainUntil: new Date("2126-01-01T00:00:00Z"),
  });
}

describe("sync history eta-backtest", () => {
  it("replays every proven chain as a request filed at its head page and reports fact over forecast", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    // 85 messages an hour apart; the chat began 60 days before T0.
    const proven = snowflake(T0 - 60 * DAY);
    await seedThread(pageId, proven);
    await page(pageId, proven, null, 0, 24);
    await page(pageId, proven, messageId(24), 25, 49);
    await page(pageId, proven, messageId(49), 50, 74);
    await page(pageId, proven, messageId(74), 75, 84);
    await page(pageId, proven, messageId(84), 1, 0);
    // Another chat whose walk never reached its start: not a sample.
    const open = snowflake(T0 - 30 * DAY);
    await seedThread(pageId, open);
    await page(pageId, open, null, 0, 24);
    await page(pageId, open, messageId(24), 25, 49);

    const pacing = { batchRows: 3, sleepMs: 0, maxDurationMs: null, forceWindow: true };
    const report = await backtestPageEta({ db: db(), logger: createLogger("silent") }, {
      ...pacing,
      pageId,
      since: new Date("2026-07-05T00:00:00Z"),
      maxListed: 10,
    }, new ScanGovernor(pacing));

    expect(report.scan).toMatchObject({ rowsScanned: 7, completed: true, stoppedBy: null });
    expect(report.chains).toEqual({ proven: 1, sampled: 1, withoutEstimate: 0, emptyChats: 0 });
    // The head page: 25 messages over 24 h. Unknown: 59 days at 25/day =
    // 59 pages, + the empty page = 60. The walk took 3 pages and the proof.
    expect(report.examples).toEqual([expect.objectContaining({
      groupId: proven, headMessages: 25, fact: 4, readsMin: 1, readsEstimate: 60,
    })]);
    expect(report.factOverEstimate).toEqual({ p10: 0.07, p50: 0.07, p90: 0.07 });
    expect(report.belowLowerBound).toBe(0);
  });
});
