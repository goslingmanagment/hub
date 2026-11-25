import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  countAgentThreads,
  countAgentTranscript,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  listAgentFanThreads,
  listAgentTimeline,
  listAgentTranscript,
  resolveAgentFanCandidates,
  searchAgentArchive,
  upsertFans,
} from "@agency_hub_core/db";

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

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
});

describe("Agent Read Plane Wave 4A regressions (BL-A1..A8, BL-A-1..A-9)", () => {
  it("BL-A1, BL-A-3, BL-A8: outbound sender_hint is null, direction predicates partition all rows, count probe honors probeMax", async () => {
    const db = testDb!.db;
    const pool = testDb!.pool;
    const model = await createModel(db, { slug: "w4a-m1", name: "W4A Model 1" });
    const page = await createFanslyPage(db, { modelId: model!.id, label: "w4a-f1" });

    // Insert 4 messages covering every (is_sent_by_me, sender_role) combination.
    await pool.query(
      `insert into message_archive
         (account_id, platform, conversation_ref, message_ref, occurred_at, text_plain,
          sender_role, fan_native_id, is_sent_by_me)
       values
         ($1, 'fansly', 'conv-1', 'm-out', '2026-10-10T10:00:00Z', 'outbound reply', 'model', 'fan-99', true),
         ($1, 'fansly', 'conv-1', 'm-in',  '2026-10-10T10:01:00Z', 'inbound hello',  'fan',   'fan-99', false),
         ($1, 'fansly', 'conv-1', 'm-sys', '2026-10-10T10:02:00Z', 'system notice',  'system','fan-99', false),
         ($1, 'fansly', 'conv-1', 'm-unk', '2026-10-10T10:03:00Z', 'unknown author', 'unknown','fan-99', false)`,
      [page!.id],
    );

    const base = {
      pageId: page!.id,
      platform: "fansly",
      conversationRef: "conv-1",
      from: new Date("2026-10-10T00:00:00Z"),
      to: new Date("2026-10-11T00:00:00Z"),
      sortDir: "asc" as const,
      limit: 50,
      filters: {},
    };

    const all = await listAgentTranscript(db, base);
    const byRef = new Map(all.rows.map((r) => [r.messageRef, r]));
    // BL-A1: outbound row never attributes fan_native_id as senderPlatformUserId.
    expect(byRef.get("m-out")?.senderPlatformUserId).toBeNull();
    expect(byRef.get("m-in")?.senderPlatformUserId).toBe("fan-99");

    // BL-A-3: outbound + inbound + unknown are strictly disjoint and exhaustive.
    const outbound = await listAgentTranscript(db, { ...base, filters: { direction: "outbound" } });
    const inbound = await listAgentTranscript(db, { ...base, filters: { direction: "inbound" } });
    const unknown = await listAgentTranscript(db, { ...base, filters: { direction: "unknown" } });
    expect(outbound.rows.map((r) => r.messageRef)).toEqual(["m-out"]);
    expect(inbound.rows.map((r) => r.messageRef)).toEqual(["m-in"]);
    expect(unknown.rows.map((r) => r.messageRef)).toEqual(["m-sys", "m-unk"]);
    expect(outbound.rows.length + inbound.rows.length + unknown.rows.length).toBe(all.rows.length);

    // BL-A8: probeMax = 4 hits lower bound { value: 4, exact: false }; probeMax = 5 is exact { value: 4, exact: true }.
    expect(await countAgentTranscript(db, base, 4)).toEqual({ value: 4, exact: false });
    expect(await countAgentTranscript(db, base, 5)).toEqual({ value: 4, exact: true });
  });

  it("BL-A6 & BL-A-7: preserves distinct page-scoped alias rows and caps candidates per input value", async () => {
    const db = testDb!.db;
    const pool = testDb!.pool;
    const model = await createModel(db, { slug: "w4a-m2", name: "W4A Model 2" });
    const page1 = await createOnlyFansPage(db, { modelId: model!.id, label: "w4a-of1" });
    const page2 = await createOnlyFansPage(db, { modelId: model!.id, label: "w4a-of2" });

    // 1 fan aliased identically ("vip_star") on two granted pages + 25 noisy fans named "common_name" + 1 fan named "target_two".
    const fanInputs = [
      { platform: "onlyfans" as const, platformUserId: "u-alias", username: "alias_fan", displayName: "Alias Fan" },
      { platform: "onlyfans" as const, platformUserId: "u-target", username: "target_two", displayName: "Target Two" },
      ...Array.from({ length: 25 }, (_, i) => ({
        platform: "onlyfans" as const,
        platformUserId: `u-noise-${i}`,
        username: `noise_user_${i}`,
        displayName: "common_name",
      })),
    ];
    const fans = await upsertFans(db, fanInputs);
    const byUid = new Map(fans.map((f) => [f.platformUserId, f.id]));
    for (const f of fans) {
      await pool.query(
        `insert into page_fans (platform_account_id, fan_id) values ($1, $2) on conflict do nothing`,
        [page1!.id, f.id],
      );
    }
    const aliasFanId = byUid.get("u-alias")!;
    await pool.query(
      `insert into page_fans (platform_account_id, fan_id) values ($1, $2) on conflict do nothing`,
      [page2!.id, aliasFanId],
    );
    await pool.query(
      `insert into page_fan_aliases (platform_account_id, fan_id, alias, first_seen_at, last_seen_at)
       values ($1, $3, 'vip_star', now(), now()), ($2, $3, 'vip_star', now(), now())`,
      [page1!.id, page2!.id, aliasFanId],
    );

    // BL-A6: same fan + same alias on two granted pages returns two distinct page-scoped matches.
    const aliasRes = await resolveAgentFanCandidates(db, {
      pageIds: [page1!.id, page2!.id],
      platform: "onlyfans",
      values: ["vip_star"],
      includeAliases: true,
      limit: 50,
      perValueLimit: 21,
    });
    expect(aliasRes.matches.map((m) => m.pageId).sort()).toEqual([page1!.id, page2!.id].sort());

    // BL-A-7: perValueLimit caps "common_name" at 5 without starving "target_two".
    const batchRes = await resolveAgentFanCandidates(db, {
      pageIds: [page1!.id, page2!.id],
      platform: "onlyfans",
      values: ["common_name", "target_two"],
      includeAliases: true,
      limit: 100,
      perValueLimit: 5,
    });
    const commonMatches = batchRes.matches.filter((m) => m.matchedValue.toLowerCase() === "common_name");
    const targetMatches = batchRes.matches.filter((m) => m.matchedValue.toLowerCase() === "target_two");
    expect(commonMatches).toHaveLength(5);
    expect([...new Set(targetMatches.map((m) => m.platformUserId))]).toEqual(["u-target"]);
  });

  it("BL-A7 & BL-A-2: timeline dates subscription.ended at ends_at and follow.ended at last_seen_at", async () => {
    const db = testDb!.db;
    const pool = testDb!.pool;
    const model = await createModel(db, { slug: "w4a-m3", name: "W4A Model 3" });
    const page = await createFanslyPage(db, { modelId: model!.id, label: "w4a-f3" });
    const [fan] = await upsertFans(db, [{ platform: "fansly", platformUserId: "f-tl-1", username: "tl_fan" }]);

    await pool.query(
      `insert into page_subscriptions
         (platform_account_id, fan_id, platform_subscription_id, is_current, raw_status, canonical_status,
          price_mills, renew_price_mills, source_created_at, ends_at, last_seen_at)
       values
         ($1, $2, 'sub-1', false, 0, 'expired', 9990, 9990,
          '2026-09-01T10:00:00Z', '2026-10-05T15:30:00Z', '2026-10-06T00:00:00Z')`,
      [page!.id, fan!.id],
    );
    await pool.query(
      `insert into page_follows
         (platform_account_id, fan_id, platform_follow_id, followed_at, first_seen_at, last_seen_at, is_active)
       values
         ($1, $2, 'fol-1', '2026-08-01T08:00:00Z', '2026-08-01T08:00:00Z', '2026-10-07T18:45:00Z', false)`,
      [page!.id, fan!.id],
    );

    const tl = await listAgentTimeline(db, {
      pageIds: [page!.id],
      fanId: fan!.id,
      fanPlatform: "fansly",
      fanPlatformUserId: "f-tl-1",
      lanes: ["subscriptions", "follows"],
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-10-10T00:00:00Z"),
      sortDir: "asc",
      limit: 20,
    });
    expect(tl.rows.map((r) => ({ kind: r.kind, at: r.occurredAt.toISOString() }))).toEqual([
      { kind: "subscription.ended", at: "2026-10-05T15:30:00.000Z" },
      { kind: "follow.ended", at: "2026-10-07T18:45:00.000Z" },
    ]);
  });

  it("BL-A-1, BL-A8 & BL-A-8: listAgentFanThreads reads real fields, countAgentThreads honors probeMax, and search centers snippet on matched token", async () => {
    const db = testDb!.db;
    const pool = testDb!.pool;
    const model = await createModel(db, { slug: "w4a-m4", name: "W4A Model 4" });
    const page = await createFanslyPage(db, { modelId: model!.id, label: "w4a-f4" });
    const [fan] = await upsertFans(db, [{ platform: "fansly", platformUserId: "f-thr-1", username: "thr_fan" }]);

    const thr = await pool.query(
      `insert into page_dm_threads
         (platform_account_id, fan_id, platform_conversation_id, is_visible, unread_count,
          last_message_at, stored_message_count, oldest_stored_message_id, newest_stored_message_id,
          last_message_sync_at)
       values
         ($1, $2, 'c-hidden', false, 7, '2026-10-12T12:00:00Z', 42, 'msg-1', 'msg-42', '2026-10-12T12:05:00Z')
       returning id`,
      [page!.id, fan!.id],
    );
    await pool.query(
      `insert into page_dm_message_sync_health (conversation_id, platform_account_id, quarantine_until)
       values ($1, $2, '2099-01-01T00:00:00Z')`,
      [thr.rows[0].id, page!.id],
    );
    await pool.query(
      `insert into fan_spend_lifetime (platform_account_id, fan_id, creator_net_amount_mills)
       values ($1, $2, 50000)`,
      [page!.id, fan!.id],
    );

    const threads = await listAgentFanThreads(db, {
      pageIds: [page!.id],
      fanIds: [fan!.id],
      includeLifetimeSpend: true,
    });
    expect(threads.rows).toHaveLength(1);
    expect(threads.rows[0]).toMatchObject({
      isVisible: false,
      unreadCount: 7,
      storedMessageCount: 42,
      oldestStoredMessageRef: "msg-1",
      newestStoredMessageRef: "msg-42",
      lifetimeSpendMills: 50000n,
    });
    expect(threads.rows[0]?.quarantineUntil?.toISOString()).toBe("2099-01-01T00:00:00.000Z");

    // BL-A8 on countAgentThreads: probeMax = 1 returns { value: 1, exact: false }; probeMax = 2 returns { value: 1, exact: true }.
    const threadQuery = {
      pageIds: [page!.id],
      orderBy: "lastMessageAt" as const,
      sortDir: "desc" as const,
      limit: 10,
      includeLifetimeSpend: false,
    };
    expect(await countAgentThreads(db, threadQuery, 1)).toEqual({ value: 1, exact: false });
    expect(await countAgentThreads(db, threadQuery, 2)).toEqual({ value: 1, exact: true });

    // BL-A-8: multi-word query whose words are separated centers snippet around the matched word instead of offset 1.
    const longPrefix = "filler ".repeat(80);
    await pool.query(
      `insert into message_archive
         (account_id, platform, conversation_ref, message_ref, occurred_at, text_plain, sender_role, is_sent_by_me)
       values
         ($1, 'fansly', 'c-hidden', 'm-long', '2026-10-12T12:00:00Z', $2, 'fan', false)`,
      [page!.id, `${longPrefix}velvet jacket and emerald necklace at the end`],
    );
    const search = await searchAgentArchive(db, {
      pageIds: [page!.id],
      query: "velvet necklace",
      from: new Date("2026-10-12T00:00:00Z"),
      to: new Date("2026-10-13T00:00:00Z"),
      includeSnippet: true,
      limit: 10,
    });
    expect(search.rows).toHaveLength(1);
    expect(search.rows[0]?.snippet).toContain("velvet jacket");
    expect(search.rows[0]?.snippet).toContain("emerald necklace");
  });
});
