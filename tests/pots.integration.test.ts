import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  assignUserToPage,
  createFanslyPage,
  createModel,
  insertAgentKey,
  listOpenMattersOfKinds,
  listSaleHomeRefreshDue,
  setAgentKeyPages,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import {
  POT_NO_PARTICIPANTS_KIND,
  POT_SALE_LEFT_KIND,
  POT_UNROUTED_KIND,
  setPotsFromSwitch,
} from "../apps/runtime/src/services/pots.ts";
import { recordSaleDecision } from "../apps/runtime/src/services/sale-decisions-door.ts";
import { refreshSaleHomesForDay } from "../apps/runtime/src/services/sale-homes.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Workboard pots (0443, H11) Postgres integration proofs:
// 1. Owner-only endpoints, create-page-pots idempotency, pots:from switch & --off guard;
// 2. Auto-post equal page pot on refreshSaleHomesForDay, K2 feed wire contract (matching ledger L8),
//    zero-participants owner matter, single aggregate pot.unrouted:open health matter;
// 3. Auto-reverse when a sale leaves an auto_post pot -> K2 `reversed` event;
// 4. Manual event pot: pure preview (zero DB writes), concurrent postPotDistribution race (strictly one succeeds),
//    cross-pot remaining-base invariant (moving sale from pot A to pot B refuses double distribution until A is reversed),
//    manual pot sale-left matter + explicit reversal + close pot preserving historical distributions;
// 5. K2 `held` with `pageLabels` and re-placement at end on page grant + test-realm isolation (never in live feed/held/next);
// 6. Cutover validation: day < pots_from validates coverage via ledger HTTP (no Hub distribution written);
//    day >= pots_from validates open Hub pot coverage;
// 7. DB immutability triggers forbid UPDATE of base_mills and DELETE of live pot_distributions / pot_distribution_parts.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let fakeLedger: Server | null = null;
let fakeLedgerUrl = "";

let ownerUserId = 0;
let ownerCookie = "";
let chatterCookie = "";
let alexUserId = 0;
let kateUserId = 0;
let miaModelId = 0;
let novaModelId = 0;
let testModelId = 0;
let pageMia1 = 0;
let pageNova1 = 0;
let pageEmpty = 0;
let pageTest1 = 0;
let agentKeyId = 0;
let txSeq = 0;

const AGENT_KEY = `${AGENT_KEY_TOKEN_PREFIX}pots-k2-feed-key`;
const msk = (at: string) => new Date(`${at.replace(" ", "T")}:00+03:00`);

const asOwner = (method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: ownerCookie }, ...(payload ? { payload } : {}) });

const asAgent = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${AGENT_KEY}` }, ...(payload ? { payload } : {}) });

async function insertSale(input: {
  pageId: number;
  occurredAt: Date;
  netMills: number;
  canonicalType?: string;
  postTip?: boolean;
}): Promise<number> {
  txSeq += 1;
  const canonical = input.canonicalType ?? "tip";
  const correlationId = input.postTip ? `post-tip-ref-${txSeq}` : null;
  const res = await testDb!.pool.query(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at,
       source, currency, correlation_id)
     values ($1, $2, $3::text, $3::transaction_type, 'posted', 'ok', $4, $4, $4, 0, $5, 'fansly:rest', 'USD', $6)
     returning id`,
    [input.pageId, `tx-pots-${txSeq}`, canonical, input.netMills, input.occurredAt, correlationId],
  );
  if (input.postTip && correlationId !== null) {
    await testDb!.pool.query(
      `insert into creator_post_tips (account_id, platform, platform_post_id, platform_tip_id, tip_sender_platform_user_id,
         post_tip_amount_mills, occurred_at, first_observed_at, last_observed_at, content_hash, source_event_id,
         source_observation_id, source_account_seq)
       values ($1, 'fansly', $2, $3, 'fan-synth-1', $4, $5, $5, $5, $6, 1, 1, $7)`,
      [input.pageId, `post-${txSeq}`, correlationId, input.netMills, input.occurredAt, sha256Hex(correlationId), txSeq],
    );
  }
  return Number(res.rows[0].id);
}

interface K2FeedAnswer {
  changes: Array<{
    seq: number;
    change: "posted" | "reversed";
    at: string;
    distribution: {
      id: number;
      pot: { code: string; name: string; modelSlug: string };
      day: string;
      formula: { kind: "equal" | "weights" | "manual"; params: Record<string, unknown> };
      inflows: Array<{ transactionId: number; pageLabel: string; baseMills: number }>;
      baseMills: number;
      lines: Array<{ personCode: string; baseMills: number; basis: string }>;
    };
  }>;
  held: Array<{
    seq: number;
    distributionId: number;
    pageLabels: string[];
    reason: "page_outside_key";
  }>;
  next: string;
  more: boolean;
  serverNow: string;
}

async function readK2Feed(query = ""): Promise<K2FeedAnswer> {
  const res = await asAgent("GET", `/api/v1/agent/pot-distributions/feed${query}`);
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as K2FeedAnswer;
  // Exact ledger L8 wire invariants (internal/hub/pot_distributions.go:110)
  expect(Array.isArray(body.changes)).toBe(true);
  expect(Array.isArray(body.held)).toBe(true);
  expect(typeof body.more).toBe("boolean");
  expect(/^\d+$/.test(body.next)).toBe(true);
  expect(Number.isNaN(Date.parse(body.serverNow))).toBe(false);
  for (const item of body.changes) {
    expect(item.seq).toBeGreaterThan(0);
    expect(BigInt(item.seq) <= BigInt(body.next)).toBe(true);
    expect(["posted", "reversed"]).toContain(item.change);
    expect(Number.isNaN(Date.parse(item.at))).toBe(false);
    const d = item.distribution;
    expect(d.id).toBeGreaterThan(0);
    expect(d.pot.code.length).toBeGreaterThan(0);
    expect(d.pot.name.length).toBeGreaterThan(0);
    expect(d.pot.modelSlug.length).toBeGreaterThan(0);
    expect(/^\d{4}-\d{2}-\d{2}$/.test(d.day)).toBe(true);
    expect(["equal", "weights", "manual"]).toContain(d.formula.kind);
    expect(typeof d.formula.params === "object" && d.formula.params !== null && !Array.isArray(d.formula.params)).toBe(true);
    expect(d.inflows.length).toBeGreaterThan(0);
    expect(d.lines.length).toBeGreaterThan(0);
    expect(d.lines.reduce((s, l) => s + l.baseMills, 0)).toBe(d.baseMills);
    expect(new Set(d.lines.map((l) => l.personCode)).size).toBe(d.lines.length);
  }
  for (const h of body.held) {
    expect(h.seq).toBeGreaterThan(0);
    expect(h.distributionId).toBeGreaterThan(0);
    expect(h.pageLabels.length).toBeGreaterThan(0);
    expect(h.reason).toBe("page_outside_key");
  }
  return body;
}

describe("Workboard pots (0443, H11)", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;

    // Tiny local fake ledger server for legacy archive & pre-cutover coverage validation.
    fakeLedger = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/v1/pots") {
        res.writeHead(200);
        res.end(JSON.stringify({
          pots: [{
            slug: "legacy-nov",
            name: "Legacy November Pot",
            model: "mia",
            pages: ["mia-1"],
            starts_at: "2026-11-01",
            ends_at: "2026-11-17",
            status: "open",
            sales: 3,
            net_micros: 150_000_000,
            participants: [{ person: "alex", from: "2026-11-01", to: "2026-11-17" }],
          }],
        }));
        return;
      }
      if (url.pathname === "/v1/pots/legacy-nov") {
        res.writeHead(200);
        res.end(JSON.stringify({
          pot: {
            slug: "legacy-nov",
            name: "Legacy November Pot",
            model: "mia",
            pages: ["mia-1"],
            starts_at: "2026-11-01",
            ends_at: "2026-11-17",
            status: "open",
            sales: 3,
            net_micros: 150_000_000,
            participants: [{ person: "alex", from: "2026-11-01", to: "2026-11-17" }],
          },
          sales: [],
          totals: [],
          removed: [],
        }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve) => fakeLedger!.listen(0, "127.0.0.1", () => resolve()));
    const addr = fakeLedger.address() as AddressInfo;
    fakeLedgerUrl = `http://127.0.0.1:${addr.port}`;

    app = createTestAppContext(testDb);
    (app.config as { ledgerUrl: string | null; ledgerPayoutsKey: string | null }).ledgerUrl = fakeLedgerUrl;
    (app.config as { ledgerUrl: string | null; ledgerPayoutsKey: string | null }).ledgerPayoutsKey = "synthetic-ledger-test-key";

    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    await createUserAccount(app, { username: "alex", role: "chatter" }, { source: "cli" });
    await createUserAccount(app, { username: "kate", role: "chatter" }, { source: "cli" });
    ownerUserId = await fixtureUserId(app, "boss");
    alexUserId = await fixtureUserId(app, "alex");
    kateUserId = await fixtureUserId(app, "kate");
    await setUserPassword(app, { userId: alexUserId, password: "alex-password-for-tests" }, { source: "cli" });
    await setUserPassword(app, { userId: kateUserId, password: "kate-password-for-tests" }, { source: "cli" });

    const mia = await createModel(app.db, { slug: "mia", name: "Mia" });
    miaModelId = mia!.id;
    pageMia1 = (await createFanslyPage(app.db, { modelId: miaModelId, label: "mia-1" }))!.id;
    pageEmpty = (await createFanslyPage(app.db, { modelId: miaModelId, label: "mia-empty" }))!.id;

    const nova = await createModel(app.db, { slug: "nova", name: "Nova" });
    novaModelId = nova!.id;
    pageNova1 = (await createFanslyPage(app.db, { modelId: novaModelId, label: "nova-1" }))!.id;

    const testModelRow = (await testDb.pool.query(
      "insert into models (slug, name, is_test) values ('sandbox-pot-m', 'Sandbox Pot M', true) returning id",
    )).rows[0];
    testModelId = Number(testModelRow.id);
    pageTest1 = (await createFanslyPage(app.db, { modelId: testModelId, label: "test-mia-1" }))!.id;

    await assignUserToPage(app.db, alexUserId, pageMia1);
    await assignUserToPage(app.db, kateUserId, pageMia1);
    await assignUserToPage(app.db, alexUserId, pageNova1);

    await insertAgentKey(testDb.db, {
      name: "pots-k2-key",
      keyPrefix: AGENT_KEY.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(AGENT_KEY),
      capabilities: ["read:team", "read:money", "write:shift_reports"] as never,
      pageIds: [pageMia1, pageEmpty],
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      createdBy: ownerUserId,
    });
    agentKeyId = Number((await testDb.pool.query("select id from agent_keys where name = 'pots-k2-key'")).rows[0].id);

    server = await buildApiServer(app);
    await server.ready();

    const bossLogin = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "boss", password: "boss-password-for-tests" } });
    ownerCookie = String(bossLogin.headers["set-cookie"]).split(";")[0]!;
    const alexLogin = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "alex", password: "alex-password-for-tests" } });
    chatterCookie = String(alexLogin.headers["set-cookie"]).split(";")[0]!;

    // Register Alex & Kate in the people registry with working pages (mia-1, nova-1; nobody works mia-empty).
    const r1 = await asOwner("POST", "/api/v1/admin/people", {
      code: "alex", displayName: "Alex", role: "chatter", state: "working",
      logins: { add: [alexUserId] }, workingPageLabels: ["mia-1", "nova-1"],
    });
    expect(r1.statusCode, r1.body).toBe(200);
    const r2 = await asOwner("POST", "/api/v1/admin/people", {
      code: "kate", displayName: "Kate", role: "chatter", state: "working",
      logins: { add: [kateUserId] }, workingPageLabels: ["mia-1"],
    });
    expect(r2.statusCode, r2.body).toBe(200);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await new Promise<void>((resolve) => (fakeLedger ? fakeLedger.close(() => resolve()) : resolve()));
    await testDb?.stop();
  });

  it("enforces owner-only access, reads legacy archive, and handles pots:from switch lifecycle", async (context) => {
    if (!testDb) return context.skip();

    // Chatter refused (403)
    const denied = await server!.inject({ method: "GET", url: "/api/v1/pots", headers: { cookie: chatterCookie } });
    expect(denied.statusCode).toBe(403);

    // Owner gets initial list with potsFrom = null and legacy ledger archive
    const initial = await asOwner("GET", "/api/v1/pots");
    expect(initial.statusCode, initial.body).toBe(200);
    const body = initial.json() as { potsFrom: string | null; legacyArchive: { available: boolean; pots: Array<{ slug: string }> } };
    expect(body.potsFrom).toBeNull();
    expect(body.legacyArchive.available).toBe(true);
    expect(body.legacyArchive.pots.map((p) => p.slug)).toEqual(["legacy-nov"]);

    // Insert a sale on 2026-11-19 (<= wall clock), turn switch ON then OFF before any distributions exist -> succeeds and queues refresh
    await insertSale({ pageId: pageMia1, occurredAt: msk("2026-11-19 10:00"), netMills: 25_000, postTip: true });
    const turnedOn = await setPotsFromSwitch(app.db, { potsFrom: "2026-11-18", setBy: "test", at: msk("2026-11-19 11:00") });
    expect(turnedOn.potsFrom).toBe("2026-11-18");
    const dueDays = await listSaleHomeRefreshDue(app.db);
    expect(dueDays.map((row) => row.day)).toContain("2026-11-19");

    // Can turn OFF cleanly while zero active distributions exist
    const turnedOff = await setPotsFromSwitch(app.db, { potsFrom: null, setBy: "test", at: msk("2026-11-19 11:05") });
    expect(turnedOff.potsFrom).toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("validates pre-cutover (< pots_from) pot decisions against ledger HTTP without creating Hub distributions", async (context) => {
    if (!testDb) return context.skip();
    await setPotsFromSwitch(app.db, { potsFrom: "2026-11-18", setBy: "test", at: msk("2026-11-18 00:00") });

    const novMiaSale = await insertSale({ pageId: pageMia1, occurredAt: msk("2026-11-15 12:00"), netMills: 30_000 });
    const novNovaSale = await insertSale({ pageId: pageNova1, occurredAt: msk("2026-11-15 13:00"), netMills: 30_000 });
    const actor = { agentKeyId, pageIds: [pageMia1, pageNova1], telegramUserId: 1, sourceRef: "tg:pre-cutover" };

    // Page covered + date covered in fake ledger -> accepted
    const ok = await recordSaleDecision(app, actor, {
      transactionId: novMiaSale,
      kind: "pot",
      shares: [],
      pot: "legacy-nov",
      saidBy: "boss",
      saidAt: msk("2026-11-15 14:00").toISOString(),
    }, msk("2026-11-15 14:00"));
    expect(ok.decision.pot).toBe("legacy-nov");

    // Refreshing 2026-11-15 creates ZERO Hub distributions (before pots_from)
    await refreshSaleHomesForDay(app.db, "2026-11-15", msk("2026-11-15 18:00"));
    const distCount = Number((await testDb.pool.query("select count(*) as n from pot_distributions")).rows[0].n);
    expect(distCount).toBe(0);

    // Page NOT covered by legacy-nov -> 409 pot_not_covered
    await expect(recordSaleDecision(app, actor, {
      transactionId: novNovaSale,
      kind: "pot",
      shares: [],
      pot: "legacy-nov",
      saidBy: "boss",
      saidAt: msk("2026-11-15 14:05").toISOString(),
    }, msk("2026-11-15 14:05"))).rejects.toMatchObject({ statusCode: 409, reason: "pot_not_covered" });

    // Unknown slug on ledger -> 409 pot_not_covered
    await expect(recordSaleDecision(app, actor, {
      transactionId: novNovaSale,
      kind: "pot",
      shares: [],
      pot: "missing-slug",
      saidBy: "boss",
      saidAt: msk("2026-11-15 14:10").toISOString(),
    }, msk("2026-11-15 14:10"))).rejects.toMatchObject({ statusCode: 409, reason: "pot_not_covered" });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("auto-posts equal page pot, opens unrouted & no-participants matters, auto-reverses on leave, and blocks pots:from --off", async (context) => {
    if (!testDb) return context.skip();
    await setPotsFromSwitch(app.db, { potsFrom: "2026-11-18", setBy: "test", at: msk("2026-11-18 00:00") });

    // Sale on 2026-11-20 before any page pots exist -> opens single aggregate pot.unrouted:open matter
    const unroutedTx = await insertSale({ pageId: pageMia1, occurredAt: msk("2026-11-20 10:00"), netMills: 40_001, postTip: true });
    await refreshSaleHomesForDay(app.db, "2026-11-20", msk("2026-11-20 18:00"));

    const unroutedMatters = await listOpenMattersOfKinds(app.db, [POT_UNROUTED_KIND]);
    expect(unroutedMatters.map((m) => m.key)).toEqual([`${POT_UNROUTED_KIND}:open`]);

    // Create page pots in one click (covers mia-1, mia-empty, nova-1), then second call skips all 3
    const createRes = await asOwner("POST", "/api/v1/pots/create-page-pots", { opensOn: "2026-11-18" });
    expect(createRes.statusCode, createRes.body).toBe(200);
    const createdPayload = createRes.json() as { created: Array<{ code: string; autoPost: boolean }>; skippedPageLabels: string[] };
    expect(createdPayload.created.map((p) => p.code).sort()).toEqual(["page-mia-1", "page-mia-empty", "page-nova-1"]);
    expect(createdPayload.created.every((p) => p.autoPost)).toBe(true);

    const repeatRes = await asOwner("POST", "/api/v1/pots/create-page-pots", { opensOn: "2026-11-18" });
    expect(repeatRes.statusCode).toBe(200);
    expect((repeatRes.json() as { created: unknown[]; skippedPageLabels: string[] }).created).toHaveLength(0);

    // Refresh 2026-11-20 -> auto-posts page-mia-1 (equal split 40_001 -> alex 20_001, kate 20_000) & closes pot.unrouted:open
    await refreshSaleHomesForDay(app.db, "2026-11-20", msk("2026-11-20 18:05"));
    expect(await listOpenMattersOfKinds(app.db, [POT_UNROUTED_KIND])).toHaveLength(0);

    const feed1 = await readK2Feed();
    const postedItem = feed1.changes.find((c) => c.change === "posted" && c.distribution.inflows.some((i) => i.transactionId === unroutedTx));
    expect(postedItem).toBeDefined();
    expect(postedItem!.distribution.pot.code).toBe("page-mia-1");
    expect(postedItem!.distribution.baseMills).toBe(40_001);
    expect(postedItem!.distribution.lines).toEqual([
      { personCode: "alex", baseMills: 20_001, basis: "поровну на 2" },
      { personCode: "kate", baseMills: 20_000, basis: "поровну на 2" },
    ]);

    // Turning pots_from OFF is now REFUSED (409 distributions_exist)
    await expect(setPotsFromSwitch(app.db, { potsFrom: null, setBy: "test", at: msk("2026-11-20 18:10") }))
      .rejects.toMatchObject({ statusCode: 409, reason: "distributions_exist" });

    // Sale on mia-empty (0 participants) -> opens pot.no_participants:page-mia-empty:2026-11-20 instead of empty distribution
    await insertSale({ pageId: pageEmpty, occurredAt: msk("2026-11-20 12:00"), netMills: 15_000, postTip: true });
    await refreshSaleHomesForDay(app.db, "2026-11-20", msk("2026-11-20 18:15"));
    const noPartMatters = await listOpenMattersOfKinds(app.db, [POT_NO_PARTICIPANTS_KIND]);
    expect(noPartMatters.map((m) => m.key)).toContain(`${POT_NO_PARTICIPANTS_KIND}:page-mia-empty:2026-11-20`);

    // Move unroutedTx out of page-mia-1 to alex via sale decision -> auto-reverses distribution & emits K2 `reversed`!
    const actor = { agentKeyId, pageIds: [pageMia1, pageEmpty], telegramUserId: 1, sourceRef: "tg:leave-auto-pot" };
    await recordSaleDecision(app, actor, {
      transactionId: unroutedTx,
      kind: "owner",
      shares: [{ person: "alex", percent: 100 }],
      saidBy: "boss",
      saidAt: msk("2026-11-20 18:20").toISOString(),
    }, msk("2026-11-20 18:20"));
    await refreshSaleHomesForDay(app.db, "2026-11-20", msk("2026-11-20 18:25"));

    const feed2 = await readK2Feed(`?since=${feed1.next}`);
    const reversedItem = feed2.changes.find((c) => c.change === "reversed" && c.distribution.id === postedItem!.distribution.id);
    expect(reversedItem).toBeDefined();
    expect(reversedItem!.distribution.baseMills).toBe(40_001);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("enforces global remaining-base invariant across concurrent posts and pot moves, pure preview, reversal, and close safety", async (context) => {
    if (!testDb) return context.skip();

    // Create two manual event pots A (weights) and B (equal) on mia-1
    const potARes = await asOwner("POST", "/api/v1/pots", {
      code: "event-alpha",
      name: "Event Alpha",
      modelId: miaModelId,
      pageIds: [pageMia1],
      intakeReasons: [],
      opensOn: "2026-11-18",
      closesOn: "2026-11-30",
      participantsMode: "listed",
      participants: [
        { personCode: "alex", fromDay: "2026-11-18", toDay: null },
        { personCode: "kate", fromDay: "2026-11-18", toDay: null },
      ],
      formula: { kind: "weights", params: { weights: { alex: 3, kate: 1 } } },
      autoPost: false,
    });
    expect(potARes.statusCode, potARes.body).toBe(200);
    const potAId = (potARes.json() as { pot: { id: number } }).pot.id;

    const potBRes = await asOwner("POST", "/api/v1/pots", {
      code: "event-beta",
      name: "Event Beta",
      modelId: miaModelId,
      pageIds: [pageMia1],
      intakeReasons: [],
      opensOn: "2026-11-18",
      closesOn: "2026-11-30",
      participantsMode: "listed",
      participants: [
        { personCode: "alex", fromDay: "2026-11-18", toDay: null },
        { personCode: "kate", fromDay: "2026-11-18", toDay: null },
      ],
      formula: { kind: "equal", params: {} },
      autoPost: false,
    });
    expect(potBRes.statusCode, potBRes.body).toBe(200);
    const potBId = (potBRes.json() as { pot: { id: number } }).pot.id;

    // Post-cutover unknown pot code is rejected (409 pot_not_covered)
    const saleId = await insertSale({ pageId: pageMia1, occurredAt: msk("2026-11-21 14:00"), netMills: 100_000 });
    const actor = { agentKeyId, pageIds: [pageMia1], telegramUserId: 1, sourceRef: "tg:event-pot" };
    await expect(recordSaleDecision(app, actor, {
      transactionId: saleId,
      kind: "pot",
      shares: [],
      pot: "nonexistent-hub-pot",
      saidBy: "boss",
      saidAt: msk("2026-11-21 14:05").toISOString(),
    }, msk("2026-11-21 14:05"))).rejects.toMatchObject({ statusCode: 409, reason: "pot_not_covered" });

    // Decide sale into event-alpha -> succeeds
    const dec1 = await recordSaleDecision(app, actor, {
      transactionId: saleId,
      kind: "pot",
      shares: [],
      pot: "event-alpha",
      saidBy: "boss",
      saidAt: msk("2026-11-21 14:10").toISOString(),
    }, msk("2026-11-21 14:10"));
    await refreshSaleHomesForDay(app.db, "2026-11-21", msk("2026-11-21 18:00"));

    // Pure preview writes ZERO rows
    const beforeCount = Number((await testDb.pool.query("select count(*) as n from pot_distributions")).rows[0].n);
    const prevRes = await asOwner("POST", `/api/v1/pots/${potAId}/preview`, {
      day: "2026-11-21",
      parts: [{ transactionId: saleId, baseMills: 100_000 }],
    });
    expect(prevRes.statusCode, prevRes.body).toBe(200);
    const prev = prevRes.json() as { error: unknown; baseMills: number; lines: Array<{ personCode: string; baseMills: number }> };
    expect(prev.error).toBeNull();
    expect(prev.baseMills).toBe(100_000);
    expect(prev.lines).toEqual([
      { personCode: "alex", baseMills: 75_000, basis: "по весам (3/4)" },
      { personCode: "kate", baseMills: 25_000, basis: "по весам (1/4)" },
    ]);
    const afterPreviewCount = Number((await testDb.pool.query("select count(*) as n from pot_distributions")).rows[0].n);
    expect(afterPreviewCount).toBe(beforeCount);

    // Concurrency race: TWO concurrent HTTP POST /api/v1/pots/:id/distributions on the SAME sale -> strictly ONE succeeds!
    const [race1, race2] = await Promise.all([
      asOwner("POST", `/api/v1/pots/${potAId}/distributions`, { day: "2026-11-21", parts: [{ transactionId: saleId, baseMills: 100_000 }] }),
      asOwner("POST", `/api/v1/pots/${potAId}/distributions`, { day: "2026-11-21", parts: [{ transactionId: saleId, baseMills: 100_000 }] }),
    ]);
    const okResponses = [race1, race2].filter((r) => r.statusCode === 200);
    const conflictResponses = [race1, race2].filter((r) => r.statusCode === 409);
    expect(okResponses).toHaveLength(1);
    expect(conflictResponses).toHaveLength(1);
    const distAId = (okResponses[0]!.json() as { distribution: { id: number } }).distribution.id;

    // Move sale from event-alpha to event-beta (superseding decision)
    await recordSaleDecision(app, actor, {
      transactionId: saleId,
      kind: "pot",
      shares: [],
      pot: "event-beta",
      supersedes: dec1.decision.id,
      saidBy: "boss",
      saidAt: msk("2026-11-21 18:10").toISOString(),
    }, msk("2026-11-21 18:10"));
    await refreshSaleHomesForDay(app.db, "2026-11-21", msk("2026-11-21 18:15"));

    // Manual pot A is NOT auto-reversed; owner matter pot.sale_left:<distAId> opens!
    const leftMatters = await listOpenMattersOfKinds(app.db, [POT_SALE_LEFT_KIND]);
    expect(leftMatters.map((m) => m.key)).toContain(`${POT_SALE_LEFT_KIND}:${distAId}`);

    // Global remaining-base invariant: pot B CANNOT double-distribute while pot A's distribution is active!
    const doublePost = await asOwner("POST", `/api/v1/pots/${potBId}/distributions`, {
      day: "2026-11-21",
      parts: [{ transactionId: saleId, baseMills: 100_000 }],
    });
    expect(doublePost.statusCode).toBe(409);

    // Owner reverses pot A's distribution -> closes matter, emits K2 reversed, restores remaining base!
    const cursorBeforeRev = (await readK2Feed()).next;
    const revRes = await asOwner("POST", `/api/v1/pots/distributions/${distAId}/reverse`, {
      reason: "Перенесли продажу в другой общак",
    });
    expect(revRes.statusCode, revRes.body).toBe(200);
    const leftAfter = await listOpenMattersOfKinds(app.db, [POT_SALE_LEFT_KIND]);
    expect(leftAfter.map((m) => m.key)).not.toContain(`${POT_SALE_LEFT_KIND}:${distAId}`);

    const revFeed = await readK2Feed(`?since=${cursorBeforeRev}`);
    expect(revFeed.changes.some((c) => c.change === "reversed" && c.distribution.id === distAId)).toBe(true);

    // Now pot B CAN distribute the freed 100_000 mills!
    const postB = await asOwner("POST", `/api/v1/pots/${potBId}/distributions`, {
      day: "2026-11-21",
      parts: [{ transactionId: saleId, baseMills: 100_000 }],
    });
    expect(postB.statusCode, postB.body).toBe(200);
    const distBId = (postB.json() as { distribution: { id: number } }).distribution.id;

    // Closing pot B does NOT reverse or flag its already-posted historical distribution
    const closeB = await asOwner("POST", `/api/v1/pots/${potBId}/close`);
    expect(closeB.statusCode, closeB.body).toBe(200);
    await refreshSaleHomesForDay(app.db, "2026-11-21", msk("2026-11-21 18:30"));
    const distBRow = (await testDb.pool.query("select reversed_at from pot_distributions where id = $1", [distBId])).rows[0];
    expect(distBRow.reversed_at).toBeNull();
    const leftAfterClose = await listOpenMattersOfKinds(app.db, [POT_SALE_LEFT_KIND]);
    expect(leftAfterClose.map((m) => m.key)).not.toContain(`${POT_SALE_LEFT_KIND}:${distBId}`);

    // DB immutability triggers refuse UPDATE of base_mills and DELETE of live distributions/parts
    await expect(testDb.pool.query("update pot_distributions set base_mills = 1 where id = $1", [distBId])).rejects.toThrow();
    await expect(testDb.pool.query("delete from pot_distributions where id = $1", [distBId])).rejects.toThrow();
    await expect(testDb.pool.query("delete from pot_distribution_parts where distribution_id = $1", [distBId])).rejects.toThrow();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("holds out-of-grant distributions in K2 with pageLabels, releases on grant, and isolates test realm completely", async (context) => {
    if (!testDb) return context.skip();

    const startFeed = await readK2Feed();
    const startCursor = startFeed.next;

    // 1. Test-realm pot & auto-posted distribution on test-mia-1
    await testDb.pool.query(
      `insert into pots (code, name, model_id, page_ids, intake_reasons, opens_on, participants_mode, participants, formula, auto_post, state)
       values ('test-pot-1', 'Test Pot 1', $1, array[$2]::bigint[], array['post_tip','campaign']::text[], '2026-11-18',
         'listed', '[{"personCode":"t-chatter","fromDay":"2026-11-18","toDay":null}]'::jsonb, '{"kind":"equal","params":{}}'::jsonb, true, 'open')`,
      [testModelId, pageTest1],
    );
    await insertSale({ pageId: pageTest1, occurredAt: msk("2026-11-22 10:00"), netMills: 20_000, postTip: true });
    await refreshSaleHomesForDay(app.db, "2026-11-22", msk("2026-11-22 18:00"));

    // Confirm test distribution exists in DB, yet live K2 feed does NOT see it in changes, held, or next!
    const testDistCount = Number((await testDb.pool.query(
      "select count(*) as n from pot_distributions d join pots p on p.id = d.pot_id where p.code = 'test-pot-1'",
    )).rows[0].n);
    expect(testDistCount).toBe(1);

    const afterTestFeed = await readK2Feed(`?since=${startCursor}`);
    expect(afterTestFeed.changes).toHaveLength(0);
    expect(afterTestFeed.held).toHaveLength(0);
    expect(afterTestFeed.next).toBe(startCursor);

    // 2. Live distribution on nova-1 (NOT yet granted to pots-k2-key) -> appears in held with pageLabels: ['nova-1']
    const novaSale = await insertSale({ pageId: pageNova1, occurredAt: msk("2026-11-22 11:00"), netMills: 50_000, postTip: true });
    await refreshSaleHomesForDay(app.db, "2026-11-22", msk("2026-11-22 18:05"));

    const heldFeed = await readK2Feed(`?since=${startCursor}`);
    expect(heldFeed.changes).toHaveLength(0);
    expect(heldFeed.held).toHaveLength(1);
    expect(heldFeed.held[0]!.pageLabels).toEqual(["nova-1"]);
    expect(heldFeed.held[0]!.reason).toBe("page_outside_key");
    const heldDistId = heldFeed.held[0]!.distributionId;
    const heldSeq = heldFeed.held[0]!.seq;
    const cursorAfterHeld = heldFeed.next;

    // 3. Grant nova-1 to the key -> released from held and re-placed at a NEW seq > heldSeq!
    await setAgentKeyPages(app.db, { id: agentKeyId, pageIds: [pageMia1, pageEmpty, pageNova1] });
    const releasedFeed = await readK2Feed(`?since=${cursorAfterHeld}`);
    expect(releasedFeed.held).toHaveLength(0);
    expect(releasedFeed.changes).toHaveLength(1);
    expect(releasedFeed.changes[0]!.distribution.id).toBe(heldDistId);
    expect(releasedFeed.changes[0]!.distribution.inflows[0]!.transactionId).toBe(novaSale);
    expect(releasedFeed.changes[0]!.seq).toBeGreaterThan(heldSeq);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
