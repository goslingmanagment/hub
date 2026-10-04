import { describe, expect, it } from "vitest";

import {
  aiTranscriptUnionCtes,
  CONVERSATION_FEED_MAX_ROWS,
  conversationFeedSummaryWindow,
  listAiTranscriptUnionMessages,
  listConversationFeedPage,
  type ConversationFeedPageInput,
} from "@agency_hub_core/db";

import { PgDialect } from "../packages/db/node_modules/drizzle-orm/pg-core/index.js";

// H-9b: the archive feed shares the AI union's CTE chain, and sharing it must
// not move a byte of the statement a generation runs. AI_UNION_SQL is that
// statement as captured BEFORE the chain was exported; a change to it changes
// every OnlyFans generation in serve mode and belongs in its own PR.

const DIALECT = new PgDialect();
type Rendered = { sql: string; params: unknown[] };

function capturingDb() {
  const queries: Rendered[] = [];
  const db = {
    execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      queries.push(DIALECT.sqlToQuery(query));
      return { rows: [] };
    },
  };
  return { db: db as never, queries };
}

/** Parameters written into the text, so two renderings compare by meaning, not by $n. */
function inlined(query: Rendered): string {
  return query.sql.replace(/\$(\d+)/g, (_match, index: string) => JSON.stringify(query.params[Number(index) - 1]));
}

const AI_UNION_SQL = `
    with page as (
      select p.id as page_id, p.ofapi_account_id
      from pages p
      where p.id = $1
    ),
    archive_arm as (
      select ma.message_ref,
             ma.occurred_at as event_time,
             ma.text_plain,
             ma.sender_role::text as sender_role,
             ma.is_sent_by_me,
             ma.price_mills,
             ma.is_tip,
             ma.tip_amount_mills,
             ma.media_metadata,
             ma.deleted_at,
             ma.is_opened,
             ma.material_observed_at,
             ma.vendor_changed_at,
             ma.content_pending as is_stub,
             0 as source_rank
      from message_archive ma
      where ma.account_id = $2
        and ma.platform = 'onlyfans'
        and ma.conversation_ref = $3
    ),
    dm_arm as (
      select d.platform_message_id as message_ref,
             d.message_created_at as event_time,
             d.text_plain,
             d.sender_role::text as sender_role,
             d.is_sent_by_me,
             d.price_mills,
             d.is_tip,
             d.tip_amount_mills,
             d.media_metadata,
             d.deleted_at,
             d.is_opened,
             d.rest_material_observed_at as material_observed_at,
             d.rest_platform_changed_at as vendor_changed_at,
             (d.message_created_at is null) as is_stub,
             1 as source_rank
      from dm_message_archive d
      where d.platform = 'onlyfans'
        and d.platform_account_id = $4
        and d.platform_conversation_id = $5
    ),
    candidates as (
      select * from archive_arm
      union all
      select * from dm_arm
    ),
    candidate_refs as (
      select distinct c.message_ref from candidates c
    ),
    hot as (
      select m.platform_message_id as message_ref, m.deleted_at, m.purchased_at
      from page_dm_messages m
      join page_dm_threads t on t.id = m.conversation_id
      where t.platform_account_id = $6
        and t.platform_conversation_id = $7
    ),
    cross_tombstones as (
      select r.message_ref
      from candidate_refs r
      cross join page
      join dm_message_archive d
        on d.platform = 'onlyfans'
       and d.ofapi_account_id = page.ofapi_account_id
       and d.platform_message_id = r.message_ref
      where d.deleted_at is not null
    ),
    tombstoned as (
      select c.message_ref from candidates c where c.deleted_at is not null
      union
      select ct.message_ref from cross_tombstones ct
      union
      select h.message_ref from hot h where h.deleted_at is not null
    ),
    best as (
      select distinct on (c.message_ref)
             c.message_ref, c.event_time, c.text_plain, c.sender_role,
             c.is_sent_by_me, c.price_mills, c.is_tip, c.tip_amount_mills,
             c.media_metadata,
             bool_or(c.is_opened) over (partition by c.message_ref) as is_opened
      from candidates c
      where not c.is_stub
        and not exists (select 1 from tombstoned x where x.message_ref = c.message_ref)
      order by c.message_ref,
               (c.material_observed_at is not null) desc,
               c.vendor_changed_at desc nulls last,
               c.material_observed_at desc nulls last,
               c.source_rank desc
    ),
    upgraded as (
      select b.message_ref, b.event_time, b.text_plain, b.sender_role,
             b.is_sent_by_me, b.price_mills, b.is_tip, b.tip_amount_mills,
             b.media_metadata,
             case when h.purchased_at is not null then true else b.is_opened end as is_opened
      from best b
      left join hot h on h.message_ref = b.message_ref
    )
    select u.message_ref,
           u.event_time,
           u.text_plain,
           u.sender_role,
           u.is_sent_by_me,
           u.price_mills::text as price_mills,
           u.is_tip,
           u.tip_amount_mills::text as tip_amount_mills,
           u.media_metadata,
           u.is_opened
    from upgraded u
    order by u.event_time desc nulls last,
             (case when u.message_ref ~ '^[0-9]{1,18}$' then u.message_ref::bigint end) desc nulls last,
             u.message_ref desc
    limit $8
  `;
const AI_UNION_PARAMS = [7, 7, "555001", 7, "555001", 7, "555001", 1500];

const TOMBSTONE_EXCLUSION = "\n        and not exists (select 1 from tombstoned x where x.message_ref = c.message_ref)";
const DELETED_IN_BEST = ",\n             exists (select 1 from tombstoned x where x.message_ref = c.message_ref) as deleted";
const DELETED_IN_UPGRADED = ",\n             b.deleted";

describe("AI transcript union statement (pinned)", () => {
  it("renders byte for byte as before the CTE chain was shared", async () => {
    const { db, queries } = capturingDb();
    await listAiTranscriptUnionMessages(db, { pageId: 7, conversationRef: "555001", limit: 1500 });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toBe(AI_UNION_SQL);
    expect(queries[0]!.params).toEqual(AI_UNION_PARAMS);
  });

  it("the exported chain without options is exactly the statement's CTEs", () => {
    const chain = DIALECT.sqlToQuery(aiTranscriptUnionCtes({ pageId: 7, conversationRef: "555001" }));
    expect(`\n    with ${chain.sql}\n    select u.message_ref,`).toBe(
      AI_UNION_SQL.slice(0, AI_UNION_SQL.indexOf("\n    select u.message_ref,") + "\n    select u.message_ref,".length),
    );
    expect(chain.params).toEqual(AI_UNION_PARAMS.slice(0, -1));
  });

  it("the feed's options add the two bounds and the tombstone flag and change nothing else", () => {
    const input = { pageId: 7, conversationRef: "555001" };
    const plain = inlined(DIALECT.sqlToQuery(aiTranscriptUnionCtes(input)));
    const feed = inlined(DIALECT.sqlToQuery(aiTranscriptUnionCtes(input, {
      bounds: { archiveMaxId: 900, dmMaxId: 400 },
      tombstones: "flag",
    })));
    expect(feed).toContain("and ma.conversation_ref = \"555001\"\n        and ma.id <= 900\n    ),");
    expect(feed).toContain("and d.platform_conversation_id = \"555001\"\n        and d.id <= 400\n    ),");
    expect(feed).toContain(DELETED_IN_BEST);
    expect(feed).toContain(DELETED_IN_UPGRADED);
    expect(feed).not.toContain(TOMBSTONE_EXCLUSION);
    expect(feed
      .replace("\n        and ma.id <= 900", "")
      .replace("\n        and d.id <= 400", "")
      .replace(DELETED_IN_BEST, "")
      .replace(DELETED_IN_UPGRADED, ""))
      .toBe(plain.replace(TOMBSTONE_EXCLUSION, ""));
  });
});

const base: ConversationFeedPageInput = {
  source: "union",
  pageId: 7,
  conversationRef: "555001",
  snapshot: { archiveMaxId: 900, dmMaxId: 400 },
  limit: 50,
};
const CHAIN_PARAMS = [7, 7, "555001", 900, 7, "555001", 400, 7, "555001"];
const ORDER = "order by u.event_time desc nulls last, (case when u.message_ref ~ '^[0-9]{1,18}$' then u.message_ref::bigint end) desc nulls last, u.message_ref desc";

async function feedStatement(input: ConversationFeedPageInput): Promise<Rendered> {
  const { db, queries } = capturingDb();
  await listConversationFeedPage(db, input);
  return queries[0]!;
}

describe("conversation feed statements", () => {
  it("the union head page: the shared chain, the union's own order, one extra row", async () => {
    const statement = await feedStatement(base);
    expect(statement.sql).toContain("from upgraded u\n    order by");
    expect(statement.sql).toContain(ORDER);
    expect(statement.params).toEqual([...CHAIN_PARAMS, 51]);
  });

  it("the archive page hides stubs, flags deletions and stays inside the snapshot", async () => {
    const statement = await feedStatement({ ...base, source: "archive" });
    const text = inlined(statement);
    expect(text).toContain("and ma.content_pending = false");
    expect(text).toContain("(ma.deleted_at is not null) as deleted");
    expect(text).not.toContain("ma.deleted_at is null");
    expect(text).toContain("and ma.id <= 900");
    expect(text).not.toContain("dm_message_archive");
    expect(text).toContain("order by ma.occurred_at desc nulls last, (case when ma.message_ref ~ '^[0-9]{1,18}$' then ma.message_ref::bigint end) desc nulls last, ma.message_ref desc");
    expect(statement.params).toEqual([7, "555001", 900, 51]);
  });

  it("expands the keyset by hand: a dated numeric position", async () => {
    const at = "2026-07-01T10:00:00.123456Z";
    const statement = await feedStatement({ ...base, before: { at, ref: "1001" } });
    expect(statement.sql).toMatch(/where \(u\.event_time is null\s+or u\.event_time < \$10::timestamptz\s+or \(u\.event_time = \$11::timestamptz and/);
    expect(statement.sql).toMatch(/is null\s+or \(case [^)]+\) < \$12::bigint\s+or \(\(case [^)]+\) = \$13::bigint and u\.message_ref < \$14\)/);
    expect(statement.params).toEqual([...CHAIN_PARAMS, at, at, "1001", "1001", "1001", 51]);
  });

  it("expands the keyset by hand: an undated, non-numeric position", async () => {
    const statement = await feedStatement({ ...base, before: { at: null, ref: "zz-legacy" } });
    expect(statement.sql).toMatch(/where \(u\.event_time is null and \(\(case [^)]+\) is null and u\.message_ref < \$10\)\)/);
    expect(statement.sql).not.toContain("::timestamptz");
    expect(statement.params).toEqual([...CHAIN_PARAMS, "zz-legacy", 51]);
  });

  it("refuses a malformed position before reaching the database", async () => {
    const { db, queries } = capturingDb();
    await expect(listConversationFeedPage(db, { ...base, before: { at: "2026-07-01T10:00:00Z", ref: "1" } }))
      .rejects.toThrow(/malformed position/);
    await expect(listConversationFeedPage(db, { ...base, before: { at: null, ref: "" } }))
      .rejects.toThrow(/malformed position/);
    await expect(listConversationFeedPage(db, { ...base, before: { at: null, ref: "9".repeat(201) } }))
      .rejects.toThrow(/malformed position/);
    await expect(listConversationFeedPage(db, { ...base, limit: Number.NaN })).rejects.toThrow(/limit/);
    expect(queries).toEqual([]);
  });

  it("clamps a page to the AI readers' window", async () => {
    expect(CONVERSATION_FEED_MAX_ROWS).toBe(1500);
    expect((await feedStatement({ ...base, limit: 5000 })).params.at(-1)).toBe(1501);
    expect((await feedStatement({ ...base, limit: 0 })).params.at(-1)).toBe(2);
  });
});

describe("feed summary window (critic item 15)", () => {
  it("defaults to the Ping window and never exceeds the AI readers' 1500", () => {
    expect(conversationFeedSummaryWindow()).toBe(100);
    expect(conversationFeedSummaryWindow(5)).toBe(5);
    expect(conversationFeedSummaryWindow(1500)).toBe(1500);
    expect(conversationFeedSummaryWindow(3000)).toBe(1500);
    expect(conversationFeedSummaryWindow(0)).toBe(1);
  });
});
