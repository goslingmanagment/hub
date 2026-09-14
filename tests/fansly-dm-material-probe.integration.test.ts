import { randomUUID } from "node:crypto";

import { createFanslyPage, createModel } from "@agency_hub_core/db";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetIntegrationDatabase, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

type MaterialReport = {
  page: string;
  scope: string;
  status: "measured" | "no_sample";
  sampledHeads: Array<{ conversationId: string; messageId: string; lastMessageAt: string | null }>;
  materialPlan: Array<{ Plan: { "Actual Rows": number }; "Execution Time": number }> | null;
};

let db: StartedTestDatabase;
let pageId: number;
let probeKind: "material" | "reader" = "material";
const reader = `material_probe_${randomUUID().replaceAll("-", "")}`;
beforeAll(async () => {
  db = await startTestDatabase();
  await db.pool.query(`create role ${reader};
    grant execute on function public.fansly_dm_shadow_material_probe(text, integer) to ${reader};
    grant execute on function public.fansly_dm_shadow_reader_probe(text, integer) to ${reader}`);
}, 120_000);
afterAll(async () => {
  if (db) {
    await db.pool.query(`drop owned by ${reader}; drop role ${reader}`);
    await db.stop();
  }
});
beforeEach(async () => {
  await resetIntegrationDatabase(db.pool);
  const model = await createModel(db.db, { slug: "material-cost", name: "Material cost" });
  if (!model) throw new Error("Missing model fixture");
  const page = await createFanslyPage(db.db, { modelId: model.id, label: "material-cost" });
  if (!page) throw new Error("Missing page fixture");
  pageId = page.id;
});

async function withReader<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await db.pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    await client.query(`set local role ${reader}`);
    await client.query("set local statement_timeout = '5s'");
    await client.query("set local lock_timeout = '100ms'");
    return await run(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

async function probe(client: PoolClient, limit: number | null = 100, page = "material-cost") {
  const result = await client.query<{ report: MaterialReport }>(
    `select public.fansly_dm_shadow_${probeKind}_probe($1, $2) as report`, [page, limit],
  );
  const report = result.rows[0]!.report as MaterialReport & { readerPlan?: MaterialReport["materialPlan"] };
  return { ...report, materialPlan: probeKind === "reader" ? report.readerPlan ?? null : report.materialPlan };
}

async function seedHeads(count: number) {
  await db.pool.query(`insert into page_dm_threads (
    platform_account_id, platform_conversation_id, last_message_id, last_message_at,
    last_message_preview, partner_username
  ) select $1, 'group-' || s.n, 'message-' || s.n, '2026-09-01'::timestamptz,
      'private-preview', 'private-username'
    from generate_series(1, $2::integer) s(n)`, [pageId, count]);
}

describe.each(["material", "reader"] as const)("bounded A0 %s cost read plane", kind => {
  beforeEach(() => { probeKind = kind; });
  it("executes the fixed plan without exposing bodies or changing stored state", async () => {
    await seedHeads(3);
    await db.pool.query(`insert into page_dm_messages (
      conversation_id, platform_account_id, platform_message_id, created_at, content, deleted_at
    ) select c.id, c.platform_account_id, c.last_message_id, now(), 'private-body',
        case when c.platform_conversation_id = 'group-2' then now() end
      from page_dm_threads c where c.platform_account_id = $1
        and c.platform_conversation_id <> 'group-3'`, [pageId]);
    await db.pool.query(`insert into fansly_dm_head_debt (conversation_id, message_id)
      select c.id, c.last_message_id from page_dm_threads c where c.platform_account_id = $1`, [pageId]);
    const before = await db.pool.query("select to_jsonb(d) as debt from fansly_dm_head_debt d order by d.conversation_id");
    const report = await withReader(client => probe(client));
    expect(report).toMatchObject({ page: "material-cost", status: "measured",
      scope: kind === "reader" ? "current_stored_heads_agent_reader_state_query" : "current_stored_heads_hot_material_query" });
    expect(report.sampledHeads).toHaveLength(3);
    expect(report.materialPlan?.[0]?.Plan["Actual Rows"]).toBe(3);
    expect(report.materialPlan?.[0]?.["Execution Time"]).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(report)).not.toContain("private-");
    expect((await db.pool.query("select to_jsonb(d) as debt from fansly_dm_head_debt d order by d.conversation_id")).rows)
      .toEqual(before.rows);
  });

  it("keeps table access and PUBLIC execution closed", async () => {
    for (const table of ["page_dm_threads", "page_dm_messages", "fansly_dm_head_debt",
      "message_archive", "dm_message_archive"]) {
      await withReader(async client => {
        await expect(client.query(`select * from public.${table}`)).rejects.toMatchObject({ code: "42501" });
      });
    }
    const acl = await db.pool.query(`select count(*)::integer as grants
      from pg_proc p cross join lateral aclexplode(p.proacl) a
      where p.oid = 'public.fansly_dm_shadow_${kind}_probe(text,integer)'::regprocedure
        and a.grantee = 0 and a.privilege_type = 'EXECUTE'`);
    expect(acl.rows[0].grants).toBe(0);
  });

  it("caps one page's newest visible nonempty heads with deterministic ordering", async () => {
    await seedHeads(105);
    await db.pool.query(`update page_dm_threads set is_visible = false
      where platform_conversation_id = 'group-105'`);
    await db.pool.query(`update page_dm_threads set last_message_id = ''
      where platform_conversation_id = 'group-104'`);
    await db.pool.query(`update page_dm_threads set last_message_id = null
      where platform_conversation_id = 'group-103'`);
    const model = await createModel(db.db, { slug: "other", name: "Other" });
    const other = await createFanslyPage(db.db, { modelId: model!.id, label: "other" });
    await db.pool.query(`insert into page_dm_threads (
      platform_account_id, platform_conversation_id, last_message_id, last_message_at
    ) values ($1, 'other-group', 'other-page-head', now())`, [other!.id]);
    const report = await withReader(client => probe(client));
    expect(report.sampledHeads.map(head => head.messageId))
      .toEqual(Array.from({ length: 100 }, (_, index) => `message-${102 - index}`));
    expect((await withReader(client => probe(client, 1))).sampledHeads[0]?.messageId).toBe("message-102");
  });

  it.each([null, 0, -1, 101])("refuses an invalid sample limit %s", async limit => {
    await expect(withReader(client => probe(client, limit))).rejects.toThrow(`invalid_${kind}_probe_sample_limit`);
  });

  it("refuses unknown and non-Fansly pages and keeps an empty sample unmeasured", async () => {
    expect(await withReader(client => probe(client))).toMatchObject({
      status: "no_sample", sampledHeads: [], materialPlan: null,
    });
    await expect(withReader(client => probe(client, 1, "unknown"))).rejects.toThrow("unknown_fansly_page");
    await db.pool.query("update pages set platform = 'onlyfans' where id = $1", [pageId]);
    await expect(withReader(client => probe(client))).rejects.toThrow("unknown_fansly_page");
  });

  it.each([
    "set transaction read write", "set transaction isolation level read committed",
  ])("refuses an unsafe transaction: %s", async statement => {
    await expect(withReader(async client => {
      await client.query(statement);
      return probe(client);
    })).rejects.toThrow(`${kind}_probe_requires_repeatable_read_only`);
  });

  it.each([
    "set local statement_timeout = '0'", "set local statement_timeout = '6s'",
    "set local lock_timeout = '0'", "set local lock_timeout = '101ms'",
  ])("refuses an unbounded caller: %s", async statement => {
    await expect(withReader(async client => {
      await client.query(statement);
      return probe(client);
    })).rejects.toThrow(`${kind}_probe_requires_bounded_timeouts`);
  });

  it("quotes stored head IDs as data, even when they contain SQL syntax", async () => {
    await seedHeads(1);
    const messageId = "head'); select pg_sleep(30); --";
    await db.pool.query("update page_dm_threads set last_message_id = $1, platform_conversation_id = $1", [messageId]);
    const report = await withReader(client => probe(client));
    expect(report.sampledHeads[0]?.messageId).toBe(messageId);
    expect(report.status).toBe("measured");
  });

  it("keeps the selected head snapshot across a concurrent writer", async () => {
    await seedHeads(1);
    await withReader(async client => {
      const before = await probe(client);
      await db.pool.query("update page_dm_threads set last_message_id = 'new-head'");
      expect((await probe(client)).sampledHeads).toEqual(before.sampledHeads);
    });
    expect((await withReader(client => probe(client))).sampledHeads[0]?.messageId).toBe("new-head");
  });

  it("obeys the caller's statement deadline while the sample table is locked", async () => {
    const blocker = await db.pool.connect();
    try {
      await blocker.query("begin; lock table page_dm_threads in access exclusive mode");
      await expect(withReader(async client => {
        await client.query("set local statement_timeout = '50ms'");
        return probe(client);
      })).rejects.toMatchObject({ code: "57014" });
    } finally {
      await blocker.query("rollback");
      blocker.release();
    }
  });
});
