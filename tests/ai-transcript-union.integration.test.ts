import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  explainAiTranscriptUnionQuery,
  listAiTranscriptUnionMessages,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// Fast-reply freshness PR3: the AI transcript union read — correctness
// (tombstone dominance across all three stores, source preference, PPV
// upgrade, stub exclusion, deterministic ordering, dedupe-before-cap) and
// the perf gate the spec requires before serve mode.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) {
    // Physical: the perf gate asserts index plans after ANALYZE.
    await resetIntegrationDatabase(testDb.pool, { physical: true });
  }
});

const CONV = "555001";
const OFAPI_ACCT = "acct_union";

async function seedPage(label = "union-of", ofapiAccountId = OFAPI_ACCT) {
  const model = await createModel(testDb!.db, { slug: label, name: label });
  if (!model) {
    throw new Error("model seed failed");
  }
  const page = await createOnlyFansPage(testDb!.db, { modelId: model.id, label });
  if (!page) {
    throw new Error("page seed failed");
  }
  await setPageOfapiAccountId(testDb!.db, { pageId: page.id, ofapiAccountId });
  return page;
}

async function insertArchiveRow(input: {
  pageId: number;
  ref: string;
  conv?: string;
  text?: string;
  occurredAt?: string | null;
  deletedAt?: string | null;
  contentPending?: boolean;
}) {
  await testDb!.pool.query(
    `insert into message_archive (
       account_id, platform, conversation_ref, message_ref, sender_role,
       is_sent_by_me, occurred_at, text_plain, deleted_at, content_pending, backfill_source
     ) values ($1, 'onlyfans', $2, $3, 'fan', false, $4, $5, $6, $7, 'seed')`,
    [
      input.pageId,
      input.conv ?? CONV,
      input.ref,
      input.occurredAt === null ? null : input.occurredAt ?? "2026-07-01T10:00:00Z",
      input.text ?? `archive ${input.ref}`,
      input.deletedAt ?? null,
      input.contentPending ?? false,
    ],
  );
}

async function insertDmRow(input: {
  pageId: number;
  ref: string;
  conv?: string | null;
  text?: string;
  createdAt?: string | null;
  deletedAt?: string | null;
  isOpened?: boolean | null;
  ofapiAccountId?: string;
}) {
  await testDb!.pool.query(
    `insert into dm_message_archive (
       platform, platform_account_id, ofapi_account_id, platform_conversation_id,
       fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me,
       message_created_at, text_plain, is_opened, is_tip, tip_amount_mills,
       deleted_at, source, source_event_type, source_idempotency_key,
       source_journal_id, source_received_at, retain_until
     ) values (
       'onlyfans', $1, $2, $3, $4, $5, 'fan', false, $6, $7, $8, false, 0, $9,
       'webhook', $10, $11, 1, now(), now() + interval '100 years'
     )`,
    [
      input.pageId,
      input.ofapiAccountId ?? OFAPI_ACCT,
      input.conv === null ? null : input.conv ?? CONV,
      input.conv === null ? null : "555001",
      input.ref,
      input.createdAt === null ? null : input.createdAt ?? "2026-07-01T10:00:00Z",
      input.text ?? `dm ${input.ref}`,
      input.isOpened ?? null,
      input.deletedAt ?? null,
      input.deletedAt != null && input.createdAt === null ? "messages.deleted" : "messages.received",
      `union-test-${input.ref}-${input.deletedAt != null ? "tomb" : "msg"}`,
    ],
  );
}

async function insertHotRow(input: {
  pageId: number;
  ref: string;
  conv?: string;
  purchasedAt?: string | null;
  deletedAt?: string | null;
}) {
  const conv = input.conv ?? CONV;
  const thread = await testDb!.pool.query<{ id: number }>(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id)
     values ($1, $2)
     on conflict (platform_account_id, platform_conversation_id) do update
       set last_seen_at = now()
     returning id`,
    [input.pageId, conv],
  );
  await testDb!.pool.query(
    `insert into page_dm_messages (
       conversation_id, platform_account_id, platform_message_id, sender_role,
       created_at, content, purchased_at, deleted_at
     ) values ($1, $2, $3, 'fan', now(), '', $4, $5)`,
    [thread.rows[0]!.id, input.pageId, input.ref, input.purchasedAt ?? null, input.deletedAt ?? null],
  );
}

describe("AI transcript union read (fastreply-freshness PR3)", () => {
  it("unions both stores, prefers the dm row, and excludes stubs", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // Archive-only row, dm-only row, and a ref in both with diverging text.
    await insertArchiveRow({ pageId: page.id, ref: "100", occurredAt: "2026-07-01T10:00:00Z" });
    await insertDmRow({ pageId: page.id, ref: "101", createdAt: "2026-07-01T10:01:00Z" });
    await insertArchiveRow({ pageId: page.id, ref: "102", text: "stale copy", occurredAt: "2026-07-01T10:02:00Z" });
    await insertDmRow({ pageId: page.id, ref: "102", text: "fresh copy", createdAt: "2026-07-01T10:02:00Z" });
    // Stubs never serve as content: archive content_pending + dm null-created.
    await insertArchiveRow({ pageId: page.id, ref: "103", contentPending: true, occurredAt: null });

    const rows = await listAiTranscriptUnionMessages(testDb.db, {
      pageId: page.id,
      conversationRef: CONV,
    });
    const byRef = new Map(rows.map((row) => [row.messageRef, row]));
    expect([...byRef.keys()].sort()).toEqual(["100", "101", "102"]);
    expect(byRef.get("102")!.textPlain).toBe("fresh copy");
    // Newest-first ordering.
    expect(rows.map((row) => row.messageRef)).toEqual(["102", "101", "100"]);
  });

  it("tombstone in EITHER store or the hot table kills the ref everywhere — including null-conversation stubs via the cross-source arm", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // 200: content in archive, tombstoned by a dm stub with NO conversation id
    // (the delete webhook carries no chat scope) — only reachable through the
    // (platform, ofapi_account_id, platform_message_id) lookup.
    await insertArchiveRow({ pageId: page.id, ref: "200" });
    await insertDmRow({ pageId: page.id, ref: "200", conv: null, createdAt: null, deletedAt: "2026-07-02T00:00:00Z" });
    // 201: content in dm, tombstoned in message_archive.
    await insertDmRow({ pageId: page.id, ref: "201", createdAt: "2026-07-01T11:00:00Z" });
    await insertArchiveRow({ pageId: page.id, ref: "201", deletedAt: "2026-07-02T00:00:00Z" });
    // 202: content in both, deleted in the hot table only.
    await insertArchiveRow({ pageId: page.id, ref: "202" });
    await insertDmRow({ pageId: page.id, ref: "202" });
    await insertHotRow({ pageId: page.id, ref: "202", deletedAt: "2026-07-02T00:00:00Z" });
    // 203 survives.
    await insertDmRow({ pageId: page.id, ref: "203", createdAt: "2026-07-01T12:00:00Z" });

    const rows = await listAiTranscriptUnionMessages(testDb.db, {
      pageId: page.id,
      conversationRef: CONV,
    });
    expect(rows.map((row) => row.messageRef)).toEqual(["203"]);
  });

  it("upgrades isOpened from hot purchased_at (true only, never a downgrade)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // 300: dm says not opened; the hot table has a purchase → upgraded true.
    await insertDmRow({ pageId: page.id, ref: "300", isOpened: false, createdAt: "2026-07-01T10:00:00Z" });
    await insertHotRow({ pageId: page.id, ref: "300", purchasedAt: "2026-07-01T10:05:00Z" });
    // 301: dm says opened; hot has no purchase → NOT downgraded.
    await insertDmRow({ pageId: page.id, ref: "301", isOpened: true, createdAt: "2026-07-01T10:01:00Z" });
    await insertHotRow({ pageId: page.id, ref: "301" });
    // 302: archive-only (no purchase state anywhere) → stays null.
    await insertArchiveRow({ pageId: page.id, ref: "302" });

    const rows = await listAiTranscriptUnionMessages(testDb.db, {
      pageId: page.id,
      conversationRef: CONV,
    });
    const byRef = new Map(rows.map((row) => [row.messageRef, row]));
    expect(byRef.get("300")!.isOpened).toBe(true);
    expect(byRef.get("301")!.isOpened).toBe(true);
    expect(byRef.get("302")!.isOpened).toBeNull();
  });

  it("orders deterministically (nulls last, guarded-numeric id, lexical fallback) and dedupes/tombstones BEFORE the tail cap", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // Same timestamp → numeric id tiebreak ('9' < '10' numerically).
    await insertDmRow({ pageId: page.id, ref: "9", createdAt: "2026-07-01T10:00:00Z" });
    await insertDmRow({ pageId: page.id, ref: "10", createdAt: "2026-07-01T10:00:00Z" });
    // Non-numeric ref must not throw the cast — lexical fallback.
    await insertDmRow({ pageId: page.id, ref: "zz-legacy", createdAt: "2026-07-01T09:00:00Z" });
    // Null event time sorts LAST (treated as oldest for the tail).
    await insertArchiveRow({ pageId: page.id, ref: "77", occurredAt: null });

    const all = await listAiTranscriptUnionMessages(testDb.db, {
      pageId: page.id,
      conversationRef: CONV,
    });
    expect(all.map((row) => row.messageRef)).toEqual(["10", "9", "zz-legacy", "77"]);

    // Dedupe/tombstones happen BEFORE the cap: with a tombstoned newest row
    // and a duplicated ref, limit 2 still returns 2 live distinct messages.
    await insertArchiveRow({ pageId: page.id, ref: "10", text: "dup of 10" });
    await insertDmRow({ pageId: page.id, ref: "11", createdAt: "2026-07-01T10:30:00Z", deletedAt: "2026-07-01T11:00:00Z" });
    const capped = await listAiTranscriptUnionMessages(testDb.db, {
      pageId: page.id,
      conversationRef: CONV,
      limit: 2,
    });
    expect(capped.map((row) => row.messageRef)).toEqual(["10", "9"]);
  });

  it("perf gate: hot conversation + spread, ANALYZE, index plans, limit 1500, latency well under provider latency", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const otherPage = await seedPage("union-of-2", "acct_union2");

    // Concentrated worst case: ~10k archive rows in ONE conversation…
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, backfill_source)
       select $1, 'onlyfans', $2, (1000000 + g)::text, 'fan', false, now() - (g || ' seconds')::interval, 'archive ' || g, 'seed'
       from generate_series(1, 10000) g`,
      [page.id, CONV],
    );
    // …~3k duplicate cold rows over the newest refs…
    await testDb.pool.query(
      `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_conversation_id, fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain, is_tip, tip_amount_mills, source, source_event_type, source_idempotency_key, source_journal_id, source_received_at, retain_until)
       select 'onlyfans', $1, $2, $3, '555001', (1000000 + g)::text, 'fan', false, now() - (g || ' seconds')::interval, 'dm ' || g, false, 0, 'webhook', 'messages.received', 'perf-' || g, 1, now(), now() + interval '100 years'
       from generate_series(1, 3000) g`,
      [page.id, OFAPI_ACCT, CONV],
    );
    // …~500 null-conversation tombstone stubs over archive-only refs (the
    // cross-source arm at volume; refs 1005001+ have no dm content row, so
    // the stub insert does not collide with the unique key)…
    await testDb.pool.query(
      `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_message_id, sender_role, is_sent_by_me, text_plain, is_tip, tip_amount_mills, deleted_at, source, source_event_type, source_idempotency_key, source_journal_id, source_received_at, retain_until)
       select 'onlyfans', $1, $2, (1000000 + g)::text, 'unknown', false, '', false, 0, now(), 'webhook', 'messages.deleted', 'perf-tomb-' || g, 1, now(), now() + interval '100 years'
       from generate_series(5001, 5500) g`,
      [page.id, OFAPI_ACCT],
    );
    // …and tombstone the 50 NEWEST dm rows in place, so dominance provably
    // interacts with the tail cap (dedupe/tombstones run BEFORE the limit).
    await testDb.pool.query(
      `update dm_message_archive set deleted_at = now()
       where platform_account_id = $1 and platform_conversation_id = $2
         and platform_message_id::bigint between 1000001 and 1000050`,
      [page.id, CONV],
    );
    // Spread: other conversations on the same account + a second account
    // (spread-only misses the conversation-tail sort; concentrated-only
    // misses account-wide scans — the gate needs BOTH shapes). The spread
    // must DOMINATE the tables (prod shape: one conversation is a small
    // fraction) or the planner correctly prefers a seq scan and the index
    // assertions below test nothing real.
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, backfill_source)
       select $1, 'onlyfans', 'conv-' || (g % 40), (2000000 + g)::text, 'fan', false, now() - (g || ' seconds')::interval, 'spread ' || g, 'seed'
       from generate_series(1, 40000) g`,
      [page.id],
    );
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, backfill_source)
       select $1, 'onlyfans', 'conv2-' || (g % 40), (4000000 + g)::text, 'fan', false, now() - (g || ' seconds')::interval, 'spread2 ' || g, 'seed'
       from generate_series(1, 40000) g`,
      [otherPage.id],
    );
    await testDb.pool.query(
      `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_conversation_id, fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain, is_tip, tip_amount_mills, source, source_event_type, source_idempotency_key, source_journal_id, source_received_at, retain_until)
       select 'onlyfans', $1, $2, 'conv-' || (g % 40), 'f', (6000000 + g)::text, 'fan', false, now() - (g || ' seconds')::interval, 'spread dm ' || g, false, 0, 'webhook', 'messages.received', 'perf-spread-a-' || g, 1, now(), now() + interval '100 years'
       from generate_series(1, 20000) g`,
      [page.id, OFAPI_ACCT],
    );
    await testDb.pool.query(
      `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_conversation_id, fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain, is_tip, tip_amount_mills, source, source_event_type, source_idempotency_key, source_journal_id, source_received_at, retain_until)
       select 'onlyfans', $1, $2, 'conv2-' || (g % 40), 'f', (3000000 + g)::text, 'fan', false, now() - (g || ' seconds')::interval, 'spread dm2 ' || g, false, 0, 'webhook', 'messages.received', 'perf-spread-b-' || g, 1, now(), now() + interval '100 years'
       from generate_series(1, 20000) g`,
      [otherPage.id, "acct_union2"],
    );
    await testDb.pool.query("analyze message_archive, dm_message_archive, page_dm_messages, page_dm_threads, pages");

    // EXPLAIN over the EXACT statement: both conversation indexes drive the
    // arms; neither archive store is scanned account-wide.
    const plan = await explainAiTranscriptUnionQuery(testDb.db, {
      pageId: page.id,
      conversationRef: CONV,
      limit: 1500,
    });
    expect(plan).toContain("message_archive_account_conv_idx");
    expect(plan).toContain("dm_message_archive_page_conversation_idx");
    expect(plan).not.toMatch(/Seq Scan on message_archive/);
    expect(plan).not.toMatch(/Seq Scan on dm_message_archive/);

    // limit-1500 exercised; tombstoned refs (5001..5500 in the hot
    // conversation) never appear.
    const durations: number[] = [];
    let rows: Awaited<ReturnType<typeof listAiTranscriptUnionMessages>> = [];
    for (let run = 0; run < 5; run += 1) {
      const startedAt = performance.now();
      rows = await listAiTranscriptUnionMessages(testDb.db, {
        pageId: page.id,
        conversationRef: CONV,
        limit: 1500,
      });
      durations.push(performance.now() - startedAt);
    }
    expect(rows).toHaveLength(1500);
    // The 50 newest refs are tombstoned (in BOTH arms — the dm row carries
    // the deletion, the archive copy dies by dominance) and the stub range
    // never surfaces: the tail starts at the newest LIVE ref.
    expect(rows[0]!.messageRef).toBe("1000051");
    expect(rows.some((row) => Number(row.messageRef) <= 1000050)).toBe(false);
    expect(rows.some((row) => Number(row.messageRef) >= 1005001 && Number(row.messageRef) <= 1005500)).toBe(false);
    // "Well under provider latency" (providers stream in seconds): the median
    // of 5 runs must stay under 1.5 s on the seeded worst case. Not the
    // slowest run: one stalled behind an overloaded CI host (5.3 s on the PC)
    // says nothing about the query, and the EXPLAIN checks above catch a plan
    // that stopped using the conversation indexes.
    const median = [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)]!;
    expect(median, `runs: ${durations.map((ms) => ms.toFixed(0)).join(", ")} ms`).toBeLessThan(1500);
  });
});
