import { afterAll, beforeAll, expect, it } from "vitest";
import {
  countAgentTranscript,
  createModel,
  createOnlyFansPage,
  listAgentTranscript,
  readAgentThreadArchiveFloor,
  type AgentTranscriptInput,
} from "@agency_hub_core/db";
import { startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let testDb: StartedTestDatabase;
beforeAll(async () => { testDb = await startTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });

const FROM = "2026-09-07T00:00:00Z";
const INSIDE = "2026-09-07T12:00:00Z";
const TO = "2026-09-08T00:00:00Z";
const OUTSIDE = "2026-01-01T00:00:00Z";

async function fixture(label: string) {
  const model = await createModel(testDb.db, { slug: label, name: label });
  const page = await createOnlyFansPage(testDb.db, { modelId: model!.id, label });
  const account = `acct_${label}`;
  await testDb.pool.query("update pages set ofapi_account_id=$2 where id=$1", [page!.id, account]);
  return { pageId: page!.id, account };
}

function input(pageId: number): AgentTranscriptInput {
  return { pageId, platform: "onlyfans", conversationRef: "thread",
    from: new Date(FROM), to: new Date(TO), sortDir: "desc", limit: 20, filters: {} };
}

async function archive(pageId: number, ref: string, at: string | null = INSIDE) {
  await testDb.pool.query(`
    insert into message_archive(account_id,platform,conversation_ref,message_ref,occurred_at,
      text_plain,sender_role,in_reply_to_ref,reply_metadata,is_opened)
    values ($1,'onlyfans','thread',$2,$3,$2,'fan','parent','{"rootMessageId":"root"}',false)`,
  [pageId, ref, at]);
}

async function cold(
  page: { pageId: number; account: string }, ref: string, at: string | null,
  options: { conversation?: string | null; deleted?: boolean } = {},
) {
  await testDb.pool.query(`
    insert into dm_message_archive(platform,platform_account_id,ofapi_account_id,
      platform_conversation_id,platform_message_id,message_created_at,text_plain,deleted_at,
      source,source_event_type,source_idempotency_key,source_journal_id,source_received_at,retain_until)
    values ('onlyfans',$1,$2,$3,$4,$5,$4,$6,'webhook','messages.received',$4,1,now(),now()+interval '100 years')`,
  [page.pageId, page.account, options.conversation === undefined ? "thread" : options.conversation,
    ref, at, options.deleted ? TO : null]);
}

async function hot(
  pageId: number, ref: string, at: string,
  options: { conversation?: string; deleted?: boolean; purchased?: boolean } = {},
) {
  const thread = await testDb.pool.query<{ id: string }>(`
    insert into page_dm_threads(platform_account_id,platform_conversation_id)
    values ($1,$2) on conflict (platform_account_id,platform_conversation_id)
    do update set last_seen_at=now() returning id`, [pageId, options.conversation ?? "thread"]);
  await testDb.pool.query(`
    insert into page_dm_messages(platform_account_id,conversation_id,platform_message_id,
      created_at,content,sender_role,deleted_at,purchased_at)
    values ($1,$2,$3,$4,$3,'fan',$5,$6)`,
  [pageId, thread.rows[0]!.id, ref, at, options.deleted ? TO : null, options.purchased ? TO : null]);
}

it("chooses the preferred source before applying the window, including null times and boundaries", async () => {
  const page = await fixture("window-priority");
  await archive(page.pageId, "moved-out");
  await cold(page, "moved-out", OUTSIDE);
  await archive(page.pageId, "moved-in", OUTSIDE);
  await cold(page, "moved-in", INSIDE);
  await archive(page.pageId, "unknown-time");
  await cold(page, "unknown-time", null);
  await archive(page.pageId, "archive-only");
  await hot(page.pageId, "hot-only", INSIDE);
  await archive(page.pageId, "start", FROM);
  await archive(page.pageId, "end", TO);
  await archive(page.pageId, "old-only", OUTSIDE);
  const floor = await readAgentThreadArchiveFloor(testDb.db, { pageId: page.pageId, conversationRef: "thread" });
  const request = { ...input(page.pageId), archiveFloor: floor };
  const result = await listAgentTranscript(testDb.db, request);
  expect(result.rows.map(row => row.messageRef).sort()).toEqual(
    ["archive-only", "hot-only", "moved-in", "start", "unknown-time"],
  );
  expect(result.rows.find(row => row.messageRef === "unknown-time")).toMatchObject({
    occurredAt: null, sourcePlane: "dm_message_archive",
  });
  expect(result.rows.find(row => row.messageRef === "archive-only")).toMatchObject({
    inReplyToRef: "parent", replyMetadata: { rootMessageId: "root" },
  });
  expect(floor).toEqual(new Date(OUTSIDE));
  expect(await countAgentTranscript(testDb.db, request, 5000)).toEqual({ value: 5, exact: true });
});

it("preserves tombstones and purchases outside the window without leaking other scopes", async () => {
  const page = await fixture("window-dominance");
  const other = await fixture("window-other-page");
  for (const ref of ["deleted-hot", "deleted-stub", "unlocked", "other-chat", "other-account"]) {
    await archive(page.pageId, ref);
  }
  await hot(page.pageId, "deleted-hot", OUTSIDE, { deleted: true });
  await cold(page, "deleted-stub", null, { conversation: null, deleted: true });
  await hot(page.pageId, "unlocked", OUTSIDE, { purchased: true });
  await hot(page.pageId, "other-chat", OUTSIDE, { conversation: "other-thread", deleted: true });
  await cold(other, "other-account", null, { conversation: null, deleted: true });
  const request = input(page.pageId);
  const all = await listAgentTranscript(testDb.db, request);
  expect(all.rows.filter(row => row.deletedAt !== null).map(row => row.messageRef).sort())
    .toEqual(["deleted-hot", "deleted-stub"]);
  expect(all.rows.find(row => row.messageRef === "unlocked")?.isOpened).toBe(true);
  const visible = { ...request, filters: { includeDeleted: false } };
  expect((await listAgentTranscript(testDb.db, visible)).rows.map(row => row.messageRef).sort())
    .toEqual(["other-account", "other-chat", "unlocked"]);
  expect(await countAgentTranscript(testDb.db, visible, 5000)).toEqual({ value: 3, exact: true });
});

it("keeps both cursor orders stable across tied timestamps, duplicates and null times", async () => {
  const page = await fixture("window-cursors");
  for (const ref of ["10", "2", "word"]) await archive(page.pageId, ref);
  await archive(page.pageId, "unknown", null);
  await hot(page.pageId, "2", INSIDE);
  for (const sortDir of ["asc", "desc"] as const) {
    const request = { ...input(page.pageId), sortDir };
    const full = await listAgentTranscript(testDb.db, request);
    const refs: string[] = [];
    let after: AgentTranscriptInput["after"];
    for (let n = 0; n < 5; n++) {
      const result = await listAgentTranscript(testDb.db, { ...request, limit: 1, after });
      const row = result.rows[0];
      if (!row) break;
      refs.push(row.messageRef);
      after = { sortValue: row.sortValue, key: row.keysetKey };
    }
    expect(refs).toEqual(full.rows.map(row => row.messageRef));
    expect(new Set(refs).size).toBe(4);
    expect(await countAgentTranscript(testDb.db, { ...request, after }, 5000))
      .toEqual({ value: 4, exact: true });
  }
});

it.each([1500, 1501, 5001, 5002, 7000])(
  "counts %i matching messages independently of the delivery ceiling",
  async (population) => {
    const page = await fixture(`count-boundary-${population}`);
    await testDb.pool.query(`
      insert into message_archive(account_id,platform,conversation_ref,message_ref,occurred_at,
        text_plain,sender_role)
      select $1,'onlyfans','thread',g::text,$2,g::text,'fan'
      from generate_series(1,$3::integer) g`, [page.pageId, INSIDE, population]);
    // A second source for the same ID must not consume another count position.
    await hot(page.pageId, "1", INSIDE);
    const request = input(page.pageId);
    expect(await countAgentTranscript(testDb.db, request, 5001)).toEqual({
      value: Math.min(population, 5002), exact: population <= 5001,
    });
    expect(await countAgentTranscript(testDb.db, request, 10))
      .toEqual({ value: 11, exact: false });
    expect(await countAgentTranscript(testDb.db, { ...request, filters: { hasMedia: true } }, 5001))
      .toEqual({ value: 0, exact: true });
    expect((await listAgentTranscript(testDb.db, { ...request, limit: 6000 })).rows)
      .toHaveLength(Math.min(population, 1500));
  },
);
