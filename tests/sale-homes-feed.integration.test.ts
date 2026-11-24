import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  assignUserToPage,
  createFanslyPage,
  createModel,
  enqueueSaleHomeRefreshDays,
  insertAgentKey,
  insertSaleDecision,
  listSaleHomeRefreshDue,
  upsertSaleHomes,
  type SaleHomeRow,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { refreshSaleHomesForDay, runSaleHomesDueTick } from "../apps/runtime/src/services/sale-homes.ts";
import { readSaleHomesFeed } from "../apps/runtime/src/services/sale-homes-feed.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The sale homes feed (0441, Contract K1):
// - initial consistent snapshot (including rows with empty `shares`);
// - change -> new `seq` (and unchanged write emits nothing);
// - late commit ordering (slow transaction committing after a later one is served after cursor);
// - `held` -> re-placed at end when granted, `limit` counts held places and `more` signals continuation;
// - `retract` of a test page NEVER leaks into live feed, live `held`, or live `next`;
// - old decision outside the 2-week window reaches the feed via `sale_home_refresh_due`;
// - stale generation does not clear a newer queued generation.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let pageOne = 0;
let pageTwo = 0;
let testPage = 0;
let anna = 0;
let keyId = 0;
let refs = 0;

const KEY = `${AGENT_KEY_TOKEN_PREFIX}homes-feed-key`;
const msk = (at: string) => new Date(`${at.replace(" ", "T")}:00+03:00`);
const asAgent = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${KEY}` }, ...(payload ? { payload } : {}) });

async function insertSale(input: { pageId: number; occurredAt: Date; netMills: number; canonicalType?: string }): Promise<number> {
  refs += 1;
  const canonical = input.canonicalType ?? "tip";
  const inserted = await testDb!.pool.query(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, $3::text, $3::transaction_type, 'posted', 'ok', $4, $4, $4, 0, $5, 'fansly:rest', 'USD') returning id`,
    [input.pageId, `tx-homes-feed-${refs}`, canonical, input.netMills, input.occurredAt],
  );
  return Number(inserted.rows[0].id);
}

async function feedHttp(query = "") {
  const response = await asAgent("GET", `/api/v1/agent/sale-homes/feed${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as {
    homes: Array<{
      seq: number;
      at: string;
      op: "upsert" | "retract";
      transactionId: number;
      pageLabel: string | null;
      occurredAt: string | null;
      netMills: number | null;
      saleKind: string | null;
      home: string | null;
      reason: string | null;
      pot: string | null;
      waitsUntil: string | null;
      ruleVersion: string | null;
      shares: Array<{
        personCode: string | null;
        userId: number;
        shiftId: number | null;
        workRef: string | null;
        reportDate: string | null;
        daySource: string;
        percent: number;
        mills: number;
      }>;
    }>;
    held: Array<{ seq: number; transactionId: number; reason: "page_outside_key" }>;
    next: string;
    more: boolean;
    serverNow: string;
  };
}

describe("the sale homes feed", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    await createUserAccount(app, { username: "anna", role: "chatter" }, { source: "cli" });
    await setUserPassword(app, { userId: await fixtureUserId(app, "anna"), password: "anna-password-for-tests" }, { source: "cli" });
    anna = await fixtureUserId(app, "anna");

    const mia = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageOne = (await createFanslyPage(app.db, { modelId: mia!.id, label: "mia-1" }))!.id;
    const nova = await createModel(app.db, { slug: "nova", name: "Nova" });
    pageTwo = (await createFanslyPage(app.db, { modelId: nova!.id, label: "nova-1" }))!.id;
    const sandboxModel = (await testDb.pool.query(
      "insert into models (slug, name, is_test) values ('sandbox-m', 'Sandbox M', true) returning id",
    )).rows[0];
    testPage = (await createFanslyPage(app.db, { modelId: Number(sandboxModel.id), label: "test-mia-1" }))!.id;

    await assignUserToPage(app.db, anna, pageOne);
    await insertAgentKey(testDb.db, {
      name: "homes-feed",
      keyPrefix: KEY.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(KEY),
      capabilities: ["read:team", "read:money"] as never,
      pageIds: [pageOne],
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      createdBy: await fixtureUserId(app, "boss"),
    });
    keyId = Number((await testDb.pool.query("select id from agent_keys where name = 'homes-feed'")).rows[0].id);

    server = await buildApiServer(app);
    await server.ready();
    const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "boss", password: "boss-password-for-tests" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/admin/people",
      headers: { cookie },
      payload: { code: "anna", displayName: "Anna", role: "chatter", state: "working", logins: { add: [anna] } },
    });
    expect(created.statusCode, created.body).toBe(200);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("emits initial snapshot (including rows with empty shares) and emits a new seq only when a home changes", async (context) => {
    if (!testDb) return context.skip();
    const emptySharesTx = await insertSale({ pageId: pageOne, occurredAt: msk("2026-11-11 10:00"), netMills: 5_000, canonicalType: "tip" });
    const creditedTx = await insertSale({ pageId: pageOne, occurredAt: msk("2026-11-11 11:00"), netMills: 12_000, canonicalType: "message_purchase" });

    const nobodyRow: SaleHomeRow = {
      transactionId: emptySharesTx,
      pageId: pageOne,
      occurredAt: msk("2026-11-11 10:00"),
      netMills: 5_000,
      home: "nobody",
      reason: "no_holder",
      pot: null,
      waitsUntil: null,
      shares: [],
      ruleVersion: "2026-11-12.1",
    };
    const shiftRow: SaleHomeRow = {
      transactionId: creditedTx,
      pageId: pageOne,
      occurredAt: msk("2026-11-11 11:00"),
      netMills: 12_000,
      home: "shift",
      reason: "owner_claim",
      pot: null,
      waitsUntil: null,
      shares: [{
        personCode: "anna",
        userId: anna,
        shiftId: null,
        workRef: null,
        reportDate: "2026-11-11",
        daySource: "sale_day",
        percent: 100,
        mills: 12_000,
      }],
      ruleVersion: "2026-11-12.1",
    };
    await upsertSaleHomes(app.db, [nobodyRow, shiftRow], msk("2026-11-11 12:00"));

    // Simulate migration 0441's initial consistent snapshot backfill from existing `sale_homes`.
    await testDb.pool.query("delete from sale_home_changes");
    await testDb.pool.query(`
      insert into sale_home_changes (transaction_id, page_id, is_test, op, at)
      select h.transaction_id, h.page_id, hub_page_is_test(h.page_id), 'upsert', h.computed_at
      from sale_homes h
      order by h.occurred_at, h.transaction_id
    `);
    await testDb.pool.query(`
      update sale_home_changes c set seq = placed.seq
      from (select id, row_number() over (order by id) as seq from sale_home_changes where seq is null) placed
      where c.id = placed.id
    `);

    const initial = await feedHttp("?limit=500");
    expect(initial.more).toBe(false);
    expect(initial.held).toEqual([]);
    expect(initial.homes.map((one) => [one.transactionId, one.op, one.home, one.saleKind, one.shares.length])).toEqual([
      [emptySharesTx, "upsert", "nobody", "tip", 0],
      [creditedTx, "upsert", "shift", "ppv", 1],
    ]);
    expect(initial.homes[1]!.shares[0]).toEqual({
      personCode: "anna",
      userId: anna,
      shiftId: null,
      workRef: null,
      reportDate: "2026-11-11",
      daySource: "sale_day",
      percent: 100,
      mills: 12_000,
    });

    // Unchanged upsert emits no new change.
    expect(await upsertSaleHomes(app.db, [nobodyRow], msk("2026-11-11 13:00"))).toBe(0);
    const idle = await feedHttp(`?since=${initial.next}&limit=500`);
    expect(idle.homes).toEqual([]);
    expect(idle.next).toBe(initial.next);
    expect(idle.more).toBe(false);

    // Changing the home emits a new seq.
    const movedToPot: SaleHomeRow = { ...nobodyRow, home: "pot", reason: "owner_pot", pot: "fixture-pot" };
    expect(await upsertSaleHomes(app.db, [movedToPot], msk("2026-11-11 14:00"))).toBe(1);
    const changed = await feedHttp(`?since=${initial.next}&limit=500`);
    expect(changed.homes).toHaveLength(1);
    expect(changed.homes[0]).toMatchObject({
      op: "upsert",
      transactionId: emptySharesTx,
      pageLabel: "mia-1",
      home: "pot",
      reason: "owner_pot",
      pot: "fixture-pot",
      shares: [],
    });
    expect(changed.homes[0]!.seq).toBeGreaterThan(Number(initial.next));
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("serves a change committed after a later one was served, after the cursor", async (context) => {
    if (!testDb) return context.skip();
    const start = (await feedHttp("?limit=500")).next;
    const lateTx = await insertSale({ pageId: pageOne, occurredAt: msk("2026-11-12 10:00"), netMills: 4_000 });
    const earlyTx = await insertSale({ pageId: pageOne, occurredAt: msk("2026-11-12 11:00"), netMills: 6_000 });

    const slow = await testDb.pool.connect();
    try {
      await slow.query("begin");
      await slow.query(
        `insert into sale_homes (transaction_id, page_id, occurred_at, net_mills, home, reason, shares, rule_version, computed_at)
         values ($1, $2, $3, 4000, 'nobody', 'no_holder', '[]'::jsonb, '2026-11-12.1', now())`,
        [lateTx, pageOne, msk("2026-11-12 10:00")],
      );
      await upsertSaleHomes(app.db, [{
        transactionId: earlyTx,
        pageId: pageOne,
        occurredAt: msk("2026-11-12 11:00"),
        netMills: 6_000,
        home: "nobody",
        reason: "no_holder",
        pot: null,
        waitsUntil: null,
        shares: [],
        ruleVersion: "2026-11-12.1",
      }], msk("2026-11-12 12:00"));

      const first = await feedHttp(`?since=${start}&limit=500`);
      expect(first.homes.map((one) => one.transactionId)).toEqual([earlyTx]);

      await slow.query("commit");
      const second = await feedHttp(`?since=${first.next}&limit=500`);
      expect(second.homes.map((one) => one.transactionId)).toEqual([lateTx]);
      expect(second.homes[0]!.seq).toBeGreaterThan(Number(first.next));
    } finally {
      await slow.query("rollback").catch(() => undefined);
      slow.release();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("holds pages outside the key, counts held places in limit/more, and re-places them at the end once granted", async (context) => {
    if (!testDb) return context.skip();
    const start = (await readSaleHomesFeed(app, { pageIds: [pageOne, pageTwo], limit: 500, agentKeyId: keyId })).next;

    const txA = await insertSale({ pageId: pageOne, occurredAt: msk("2026-11-13 10:00"), netMills: 3_000 });
    const txHeld = await insertSale({ pageId: pageTwo, occurredAt: msk("2026-11-13 11:00"), netMills: 7_000 });
    const txB = await insertSale({ pageId: pageOne, occurredAt: msk("2026-11-13 12:00"), netMills: 8_000 });
    for (const [txId, pageId, at, net] of [
      [txA, pageOne, msk("2026-11-13 10:00"), 3_000],
      [txHeld, pageTwo, msk("2026-11-13 11:00"), 7_000],
      [txB, pageOne, msk("2026-11-13 12:00"), 8_000],
    ] as const) {
      await upsertSaleHomes(app.db, [{
        transactionId: txId,
        pageId,
        occurredAt: at,
        netMills: net,
        home: "nobody",
        reason: "no_holder",
        pot: null,
        waitsUntil: null,
        shares: [],
        ruleVersion: "2026-11-12.1",
      }], at);
    }

    // Read one place at a time with only pageOne granted: held place counts against `limit` and sets `more: true`.
    const seen: Array<{ homes: number[]; held: number[]; more: boolean; moved: boolean }> = [];
    let since = start;
    let heldSeq = 0;
    for (let step = 0; step < 4; step += 1) {
      const page = await readSaleHomesFeed(app, { pageIds: [pageOne], since, limit: 1, agentKeyId: keyId });
      if (step === 1) heldSeq = page.held[0]!.seq;
      seen.push({
        homes: page.homes.map((one) => one.transactionId),
        held: page.held.map((one) => one.transactionId),
        more: page.more,
        moved: page.next !== since,
      });
      since = page.next;
    }
    expect(seen).toEqual([
      { homes: [txA], held: [], more: true, moved: true },
      { homes: [], held: [txHeld], more: true, moved: true },
      { homes: [txB], held: [txHeld], more: false, moved: true },
      { homes: [], held: [txHeld], more: false, moved: false },
    ]);

    // Grant pageTwo: the held change leaves `held`, gets a NEW seq at the end, and replays safely from `since`.
    const released = await readSaleHomesFeed(app, { pageIds: [pageOne, pageTwo], since, limit: 500, agentKeyId: keyId });
    expect(released.held).toEqual([]);
    expect(released.homes.map((one) => [one.transactionId, one.pageLabel, one.op])).toEqual([[txHeld, "nova-1", "upsert"]]);
    const movedSeq = released.homes[0]!.seq;
    expect(movedSeq).toBeGreaterThan(Number(since));
    expect(movedSeq).toBeGreaterThan(heldSeq);

    const replay = await readSaleHomesFeed(app, { pageIds: [pageOne, pageTwo], since, limit: 500, agentKeyId: keyId });
    expect(replay.homes.map((one) => [one.transactionId, one.seq])).toEqual([[txHeld, movedSeq]]);
    expect(replay.next).toBe(String(movedSeq));
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("never leaks test-page upserts or retracts into live feed, live held, or live next", async (context) => {
    if (!testDb) return context.skip();
    const liveBefore = await readSaleHomesFeed(app, { pageIds: [pageOne, pageTwo], limit: 500, agentKeyId: keyId, realm: "live" });
    const liveStart = liveBefore.next;
    const testStart = (await readSaleHomesFeed(app, { pageIds: [testPage], limit: 500, realm: "test" })).next;

    const testTx = await insertSale({ pageId: testPage, occurredAt: msk("2026-11-14 10:00"), netMills: 9_000 });
    await upsertSaleHomes(app.db, [{
      transactionId: testTx,
      pageId: testPage,
      occurredAt: msk("2026-11-14 10:00"),
      netMills: 9_000,
      home: "nobody",
      reason: "no_holder",
      pot: null,
      waitsUntil: null,
      shares: [],
      ruleVersion: "2026-11-12.1",
    }], msk("2026-11-14 11:00"));
    // Delete the test page's `sale_homes` row (trigger emits `retract` with `is_test = true`).
    await testDb.pool.query("delete from sale_homes where transaction_id = $1", [testTx]);

    // Live reader sees nothing in homes, nothing in held, and `next` does NOT move.
    const liveAfter = await readSaleHomesFeed(app, { pageIds: [pageOne, pageTwo], since: liveStart, limit: 500, agentKeyId: keyId, realm: "live" });
    expect(liveAfter.homes).toEqual([]);
    expect(liveAfter.held).toEqual([]);
    expect(liveAfter.next).toBe(liveStart);
    expect(liveAfter.more).toBe(false);

    // Test reader sees the test page's retract cleanly.
    const testAfter = await readSaleHomesFeed(app, { pageIds: [testPage], since: testStart, limit: 500, realm: "test" });
    expect(testAfter.homes.map((one) => [one.transactionId, one.op, one.pageLabel])).toEqual([
      [testTx, "retract", "test-mia-1"],
      [testTx, "retract", "test-mia-1"],
    ]);
    expect(testAfter.homes[1]).toMatchObject({
      op: "retract",
      occurredAt: null,
      netMills: null,
      saleKind: null,
      home: null,
      reason: null,
      pot: null,
      waitsUntil: null,
      ruleVersion: null,
      shares: [],
    });

    // Live page retract DOES reach the live feed with `op: "retract"` and `pageLabel`.
    const liveRetractTx = await insertSale({ pageId: pageOne, occurredAt: msk("2026-11-14 12:00"), netMills: 2_000 });
    await upsertSaleHomes(app.db, [{
      transactionId: liveRetractTx,
      pageId: pageOne,
      occurredAt: msk("2026-11-14 12:00"),
      netMills: 2_000,
      home: "nobody",
      reason: "no_holder",
      pot: null,
      waitsUntil: null,
      shares: [],
      ruleVersion: "2026-11-12.1",
    }], msk("2026-11-14 12:30"));
    const afterUpsert = await feedHttp(`?since=${liveStart}&limit=500`);
    expect(afterUpsert.homes.map((one) => [one.transactionId, one.op])).toEqual([[liveRetractTx, "upsert"]]);
    await testDb.pool.query("delete from sale_homes where transaction_id = $1", [liveRetractTx]);
    const afterDelete = await feedHttp(`?since=${afterUpsert.next}&limit=500`);
    expect(afterDelete.homes).toEqual([{
      seq: expect.any(Number),
      at: expect.any(String),
      op: "retract",
      transactionId: liveRetractTx,
      pageLabel: "mia-1",
      occurredAt: null,
      netMills: null,
      saleKind: null,
      home: null,
      reason: null,
      pot: null,
      waitsUntil: null,
      ruleVersion: null,
      shares: [],
    }]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("routes an old decision through sale_home_refresh_due to the feed and never lets a stale generation clear a newer one", async (context) => {
    if (!testDb) return context.skip();
    // Clear any prior queued days from earlier tests.
    await testDb.pool.query("delete from sale_home_refresh_due");
    const start = (await feedHttp("?limit=500")).next;

    // An old sale from 2026-11-03 (well before a 2-week rolling window on 2026-11-24).
    const oldDay = "2026-11-03";
    const oldAt = msk("2026-11-03 15:00");
    const oldTx = await insertSale({ pageId: pageOne, occurredAt: oldAt, netMills: 15_000, canonicalType: "tip" });
    const now = msk("2026-11-24 12:00");

    // Recording a decision on that old sale enqueues `2026-11-03` into `sale_home_refresh_due` inside the writer's tx.
    await insertSaleDecision(app.db, {
      transactionId: oldTx,
      pageId: pageOne,
      kind: "split",
      shares: [{ userId: anna, percent: 100 }],
      pot: null,
      outcome: "said",
      ruleHome: "nobody",
      note: "old sale resolved",
      decidedByUserId: null,
      decidedAt: now,
      saidBy: "owner",
      source: "agent",
      ledgerDecisionId: null,
      ledgerRef: null,
    }, now);

    const queuedBefore = await listSaleHomeRefreshDue(app.db);
    expect(queuedBefore.map((row) => ({ day: row.day, generation: row.generation }))).toEqual([{ day: oldDay, generation: 1 }]);

    // Simulate a concurrent writer bumping `generation` from 1 to 2 AFTER the refresh pass read generation=1.
    await refreshSaleHomesForDay(app.db, oldDay, now, {
      afterRead: async () => {
        await enqueueSaleHomeRefreshDays(app.db, [oldDay]);
      },
    });

    // Stale generation (1) MUST NOT delete generation (2)!
    const queuedAfterStale = await listSaleHomeRefreshDue(app.db);
    expect(queuedAfterStale.map((row) => ({ day: row.day, generation: row.generation }))).toEqual([{ day: oldDay, generation: 2 }]);

    // Running the 5-min due pass picks up generation 2, finishes, and clears `sale_home_refresh_due`.
    await runSaleHomesDueTick(app, now);
    expect(await listSaleHomeRefreshDue(app.db)).toEqual([]);

    // The old sale's computed home reached the feed with enriched personCode, reportDate, and daySource.
    const read = await feedHttp(`?since=${start}&limit=500`);
    const found = read.homes.find((one) => one.transactionId === oldTx);
    expect(found).toMatchObject({
      op: "upsert",
      transactionId: oldTx,
      pageLabel: "mia-1",
      netMills: 15_000,
      saleKind: "tip",
      home: "shift",
      reason: "owner_claim",
      shares: [{
        personCode: "anna",
        userId: anna,
        shiftId: null,
        workRef: null,
        reportDate: oldDay,
        daySource: "sale_day",
        percent: 100,
        mills: 15_000,
      }],
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("never falsely retracts historical homes of an inactive page while still retracting vanished sales on active pages", async (context) => {
    if (!testDb) return context.skip();
    const day = "2026-11-15";
    const at = msk("2026-11-15 14:00");
    const now = msk("2026-11-16 12:00");
    const pausedPage = (await createFanslyPage(app.db, {
      modelId: Number((await testDb.pool.query("select model_id from pages where id = $1", [pageOne])).rows[0].model_id),
      label: "mia-paused",
    }))!.id;
    const pausedTx = await insertSale({ pageId: pausedPage, occurredAt: at, netMills: 10_000, canonicalType: "tip" });
    const activeVanishedTx = await insertSale({ pageId: pageOne, occurredAt: msk("2026-11-15 15:00"), netMills: 6_000, canonicalType: "tip" });

    // Initial refresh writes both homes while both pages are active.
    await refreshSaleHomesForDay(app.db, day, now);
    const before = await testDb.pool.query<{ transaction_id: string }>(
      "select transaction_id from sale_homes where transaction_id = any($1::bigint[]) order by transaction_id",
      [[pausedTx, activeVanishedTx]],
    );
    expect(before.rows.map((r) => Number(r.transaction_id))).toEqual([pausedTx, activeVanishedTx]);

    // Soft-delete `pausedPage` (not erased!) and delete `activeVanishedTx` from `transactions` on active `pageOne`.
    await testDb.pool.query("update pages set status = 'deleted' where id = $1", [pausedPage]);
    await testDb.pool.query("delete from transactions where id = $1", [activeVanishedTx]);

    const after = await refreshSaleHomesForDay(app.db, day, now);
    expect(after.retracted).toBeGreaterThanOrEqual(1);

    // Paused page's home MUST survive; active page's vanished sale MUST be retracted.
    const surviving = await testDb.pool.query<{ transaction_id: string }>(
      "select transaction_id from sale_homes where transaction_id = any($1::bigint[])",
      [[pausedTx, activeVanishedTx]],
    );
    expect(surviving.rows.map((r) => Number(r.transaction_id))).toEqual([pausedTx]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("never lets a released held retract erase a sale whose home has since been restored", async (context) => {
    if (!testDb) return context.skip();
    const start = (await readSaleHomesFeed(app, { pageIds: [pageOne, pageTwo], limit: 500, agentKeyId: keyId })).next;
    const at = msk("2026-11-16 14:00");
    const restoredTx = await insertSale({ pageId: pageTwo, occurredAt: at, netMills: 11_000, canonicalType: "tip" });
    const row: SaleHomeRow = {
      transactionId: restoredTx,
      pageId: pageTwo,
      occurredAt: at,
      netMills: 11_000,
      home: "shift",
      reason: "owner_claim",
      pot: null,
      waitsUntil: null,
      shares: [{
        personCode: "anna",
        userId: anna,
        shiftId: null,
        workRef: null,
        reportDate: "2026-11-16",
        daySource: "sale_day",
        percent: 100,
        mills: 11_000,
      }],
      ruleVersion: "2026-11-12.1",
    };

    // 1. Insert home, then delete it (retract). Key with only pageOne holds both changes.
    await upsertSaleHomes(app.db, [row], at);
    await testDb.pool.query("delete from sale_homes where transaction_id = $1", [restoredTx]);
    const heldStep = await readSaleHomesFeed(app, { pageIds: [pageOne], since: start, limit: 500, agentKeyId: keyId });
    expect(heldStep.held.some((h) => h.transactionId === restoredTx)).toBe(true);

    // 2. Restore the home (newer upsert), then grant pageTwo so the older held retract is re-placed at the end.
    await upsertSaleHomes(app.db, [row], msk("2026-11-16 15:00"));
    const released = await readSaleHomesFeed(app, { pageIds: [pageOne, pageTwo], since: heldStep.next, limit: 500, agentKeyId: keyId });
    const entries = released.homes.filter((h) => h.transactionId === restoredTx);
    expect(entries.length).toBeGreaterThan(0);
    // Every emitted entry for the restored sale reflects the current live home (`upsert`), NEVER `retract`.
    expect(entries.every((e) => e.op === "upsert" && e.home === "shift")).toBe(true);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("places the next change beyond a deleted high-water row", async (context) => {
    if (!testDb) return context.skip();
    const change = () => testDb!.pool.query(`insert into sale_home_changes (transaction_id, page_id, is_test, op)
      values (1, $1, false, 'retract')`, [pageOne]);
    await change();
    const top = (await readSaleHomesFeed(app, { pageIds: [pageOne], limit: 500 })).next;
    await testDb.pool.query("delete from sale_home_changes where seq = $1", [top]);
    await change();
    const next = await readSaleHomesFeed(app, { pageIds: [pageOne], since: top, limit: 1 });
    expect(next.homes[0]!.seq).toBeGreaterThan(Number(top));
  });

});
