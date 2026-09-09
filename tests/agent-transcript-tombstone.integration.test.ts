import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  countAgentTranscript,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  listAgentTranscript,
  type AgentTranscriptInput,
} from "@agency_hub_core/db";
import { startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let testDb: StartedTestDatabase;
beforeAll(async () => { testDb = await startTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });

function input(pageId: number, platform: string): AgentTranscriptInput {
  return { pageId, platform, conversationRef: "thread", sortDir: "asc", limit: 20,
    from: new Date("2026-09-07T00:00:00Z"), to: new Date("2026-09-08T00:00:00Z"),
    filters: {} };
}

async function archive(pageId: number, platform: string, ref: string) {
  await testDb.pool.query(`
    insert into message_archive(account_id,platform,conversation_ref,message_ref,
      occurred_at,text_plain,sender_role,in_reply_to_ref,reply_metadata)
    values ($1,$2,'thread',$3,'2026-09-07T12:00:00Z','retained text','fan',
      'parent','{"rootMessageId":"root"}')`, [pageId, platform, ref]);
}

async function tombstone(pageId: number, account: string, platform: string, ref: string) {
  await testDb.pool.query(`
    insert into dm_message_archive(platform,platform_account_id,ofapi_account_id,
      platform_message_id,deleted_at,source,source_event_type,source_idempotency_key,
      source_journal_id,source_received_at,retain_until)
    values ($1,$2,$3,$4,'2026-09-08T00:00:00Z','webhook','messages.deleted',$4,
      1,now(),now()+interval '100 years')`, [platform, pageId, account, ref]);
}

interface PlanNode {
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  Plans?: PlanNode[];
}

function coldRowsVisited(node: PlanNode): number {
  const own = node["Relation Name"] === "dm_message_archive"
    ? ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0))
      * (node["Actual Loops"] ?? 0)
    : 0;
  return own + (node.Plans ?? []).reduce((total, child) => total + coldRowsVisited(child), 0);
}

it("does not read unrelated cold rows for a Fansly page without an OFAPI binding", async () => {
  const model = await createModel(testDb.db, { slug: "unbound-tombstones", name: "Unbound" });
  const fansly = await createFanslyPage(testDb.db, { modelId: model!.id, label: "fansly" });
  const other = await createOnlyFansPage(testDb.db, { modelId: model!.id, label: "unbound-other" });
  await testDb.pool.query("update pages set ofapi_account_id='unrelated' where id=$1", [other!.id]);
  await archive(fansly!.id, "fansly", "target");
  await tombstone(other!.id, "unrelated", "onlyfans", "target");
  await testDb.pool.query(`
    insert into dm_message_archive(platform,platform_account_id,ofapi_account_id,
      platform_message_id,deleted_at,source,source_event_type,source_idempotency_key,
      source_journal_id,source_received_at,retain_until)
    select 'onlyfans',$1,'unrelated',n::text,now(),'webhook','messages.deleted',n::text,
      n,now(),now()+interval '100 years' from generate_series(1,10000) n`, [other!.id]);
  await testDb.pool.query("analyze dm_message_archive");
  await testDb.pool.query("analyze pages");
  const request = input(fansly!.id, "fansly");
  const spy = vi.spyOn(testDb.pool, "query");
  let call: readonly unknown[];
  try {
    const result = await listAgentTranscript(testDb.db, request);
    call = spy.mock.calls[0]!;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ messageRef: "target", deletedAt: null,
      textPlain: "retained text", inReplyToRef: "parent", replyMetadata: { rootMessageId: "root" } });
  } finally {
    spy.mockRestore();
  }
  const query = call[0] as { text: string };
  const parameters = call[1] as unknown[];
  const plan = await testDb.pool.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
    `explain (analyze, format json) ${query.text}`, parameters,
  );
  // Assert executed work, not a timing threshold or a particular planner node.
  expect(coldRowsVisited(plan.rows[0]!["QUERY PLAN"][0]!.Plan)).toBe(0);
  expect(await countAgentTranscript(testDb.db, request, 5000)).toEqual({ value: 1, exact: true });
});

it("uses the current platform and account binding for chatless tombstones", async () => {
  const model = await createModel(testDb.db, { slug: "scoped-tombstones", name: "Scoped" });
  const page = await createOnlyFansPage(testDb.db, { modelId: model!.id, label: "owner" });
  const other = await createOnlyFansPage(testDb.db, { modelId: model!.id, label: "scoped-other" });
  await testDb.pool.query("update pages set ofapi_account_id='owner-binding' where id=$1", [page!.id]);
  await testDb.pool.query("update pages set ofapi_account_id='other-binding' where id=$1", [other!.id]);
  for (const ref of ["deleted", "other-account", "other-platform"]) await archive(page!.id, "onlyfans", ref);
  await tombstone(page!.id, "owner-binding", "onlyfans", "deleted");
  await tombstone(other!.id, "other-binding", "onlyfans", "other-account");
  await tombstone(page!.id, "owner-binding", "fansly", "other-platform");
  const request = input(page!.id, "onlyfans");
  const all = await listAgentTranscript(testDb.db, request);
  expect(all.rows.filter(row => row.deletedAt !== null).map(row => row.messageRef)).toEqual(["deleted"]);
  const visible = { ...request, filters: { includeDeleted: false } };
  expect((await listAgentTranscript(testDb.db, visible)).rows.map(row => row.messageRef))
    .toEqual(["other-account", "other-platform"]);
  expect(await countAgentTranscript(testDb.db, visible, 5000)).toEqual({ value: 2, exact: true });

  await testDb.pool.query("update pages set ofapi_account_id=null where id=$1", [page!.id]);
  const unbound = await listAgentTranscript(testDb.db, visible);
  expect(unbound.rows.map(row => row.messageRef)).toEqual(["deleted", "other-account", "other-platform"]);
  expect(await countAgentTranscript(testDb.db, visible, 5000)).toEqual({ value: 3, exact: true });
});
