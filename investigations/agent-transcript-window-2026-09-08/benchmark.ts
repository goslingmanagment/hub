// Local reproduction only; the durable copy lives under investigations/.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createFanslyPage, createModel, listAgentTranscript, countAgentTranscript } from "@agency_hub_core/db";
import { startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let testDb: StartedTestDatabase;
beforeAll(async () => { testDb = await startTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });

it("measures a narrow transcript read with retained conversation history", async () => {
  const model = await createModel(testDb.db, { slug: "transcript-benchmark", name: "Benchmark" });
  const page = await createFanslyPage(testDb.db, { modelId: model!.id, label: "benchmark" });
  const thread = await testDb.pool.query<{ id: string }>(`
    insert into page_dm_threads(platform_account_id, platform_conversation_id)
    values ($1, 'thread') returning id`, [page!.id]);
  await testDb.pool.query(`
    insert into message_archive(account_id, platform, conversation_ref, message_ref,
      occurred_at, text_plain, text_html, in_reply_to_ref, reply_metadata, sender_role)
    select $1, 'fansly', 'thread', n::text, '2026-01-01'::timestamptz + n * interval '1 minute',
      repeat(md5(n::text), 64), repeat(md5(n::text), 64), 'parent', '{"rootMessageId":"root"}', 'fan'
    from generate_series(1,10298) n`, [page!.id]);
  await testDb.pool.query(`
    insert into page_dm_messages(platform_account_id, conversation_id, platform_message_id, created_at, content)
    select $1, $2, n::text, '2026-01-01'::timestamptz + n * interval '1 minute', repeat(md5(n::text),64)
    from generate_series(1,10298) n`, [page!.id, thread.rows[0]!.id]);
  await testDb.pool.query("analyze");
  const input = { pageId: page!.id, platform: "fansly", conversationRef: "thread",
    from: new Date("2026-01-08T00:00:59.999Z"), to: new Date("2026-01-08T00:01:00.001Z"),
    sortDir: "desc" as const, limit: 200, filters: {} };
  const querySpy = vi.spyOn(testDb.pool, "query");
  const start = performance.now();
  const result = await listAgentTranscript(testDb.db, input);
  const elapsedMs = performance.now() - start;
  const call = querySpy.mock.calls[0]!;
  querySpy.mockRestore();
  const query = call[0] as unknown as { text: string };
  const params = call[1] as unknown as unknown[];
  const countStart = performance.now();
  const count = await countAgentTranscript(testDb.db, input, 5000);
  const countMs = performance.now() - countStart;
  const plan = await testDb.pool.query(`explain (analyze, buffers, format json) ${query.text}`, params);
  const directory = "investigations/agent-transcript-window-2026-09-08";
  await mkdir(directory, { recursive: true });
  const tag = process.env.BENCHMARK_TAG ?? "baseline";
  const normalized = JSON.parse(JSON.stringify({ result, count }, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value));
  await writeFile(`${directory}/${tag}.json`, JSON.stringify({
    fixture: { conversations: 1, archiveRows: 10298, hotRows: 10298, textBytesPerField: 2048, windowMs: 2 },
    elapsedMs, countMs, normalized, sql: query.text, params, plan: plan.rows[0]["QUERY PLAN"],
  }, null, 2));
  console.log(JSON.stringify({ tag, elapsedMs, countMs, executionMs: plan.rows[0]["QUERY PLAN"][0]["Execution Time"] }));
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]!.messageRef).toBe("10081");
  expect(count).toEqual({ value: 1, exact: true });
  if (process.env.BENCHMARK_COMPARE) {
    const baseline = JSON.parse(await readFile(process.env.BENCHMARK_COMPARE, "utf8"));
    expect(normalized).toEqual(baseline.normalized);
    const wideFrom = "2025-01-01T00:00:00.000Z";
    const wideTo = "2027-01-01T00:00:00.000Z";
    const oldParams = baseline.params.map((value: unknown) =>
      value === input.from.toISOString() ? wideFrom : value === input.to.toISOString() ? wideTo : value);
    const oldStart = performance.now();
    const oldWide = await testDb.pool.query(baseline.sql, oldParams);
    const oldWideMs = performance.now() - oldStart;
    const wideSpy = vi.spyOn(testDb.pool, "query");
    await listAgentTranscript(testDb.db, { ...input, from: new Date(wideFrom), to: new Date(wideTo) });
    const wideCall = wideSpy.mock.calls[0]!;
    wideSpy.mockRestore();
    const wideQuery = wideCall[0] as unknown as { text: string };
    const wideParams = wideCall[1] as unknown as unknown[];
    const newStart = performance.now();
    const newWide = await testDb.pool.query(wideQuery.text, wideParams);
    const newWideMs = performance.now() - newStart;
    expect(newWide.rows).toEqual(oldWide.rows);
    await writeFile(`${directory}/wide.json`, JSON.stringify({
      window: [wideFrom, wideTo], rows: newWide.rows.length, allRowsEqual: true,
      oldWideMs, newWideMs,
    }, null, 2));
  }
}, 180_000);
