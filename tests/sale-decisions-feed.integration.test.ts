import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { assignUserToPage, createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { readSaleDecisionsFeed } from "../apps/runtime/src/services/sale-decisions-feed.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The decisions feed (review R2b-B): every change of a decision about whose a sale is, after a cursor, in the order
// the changes were made — what the ledger follows instead of keeping a second writer (pots, a nobody's sale given to a
// person, a report line's agreement). No fan's name in its structured fields (a note is free text). A change committed
// late is served after the cursor, never passed; one held back for the key's pages gets a new place when it may be read.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let pageOne = 0;
let anna = 0;
let refs = 0;
const KEY = `${AGENT_KEY_TOKEN_PREFIX}decisions-feed-key`;
const SAID = { telegramUserId: 700_000_601, sourceRef: "https://t.me/c/1/9" };
const asAgent = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${KEY}` }, ...(payload ? { payload } : {}) });

async function nobodysSale(net: number): Promise<number> {
  refs += 1;
  const inserted = await testDb!.pool.query(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, 'tip', 'tip', 'posted', 'ok', $3, $3, $4, 0, now() - interval '2 hours', 'fansly:rest', 'USD') returning id, occurred_at`,
    [pageOne, `tx-feed-${refs}`, net, net],
  );
  const id = Number(inserted.rows[0].id);
  await testDb!.pool.query(
    `insert into sale_homes (transaction_id, page_id, occurred_at, net_mills, home, reason, shares, rule_version, computed_at)
     values ($1, $2, $3, $4, 'nobody', 'no_holder', '[]'::jsonb, 'test', now())`,
    [id, pageOne, inserted.rows[0].occurred_at, net],
  );
  return id;
}

async function feed(since: string) {
  const answer = await asAgent("GET", `/api/v1/agent/sale-decisions/feed?since=${since}&limit=500`);
  expect(answer.statusCode, answer.body).toBe(200);
  return answer.json() as { changes: Array<{ seq: number; change: string; decision: Record<string, unknown> }>; next: string };
}

describe("the decisions feed", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    await createUserAccount(app, { username: "anna", role: "chatter" }, { source: "cli" });
    await setUserPassword(app, { userId: await fixtureUserId(app, "anna"), password: "anna-password-for-tests" }, { source: "cli" });
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageOne = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    anna = await fixtureUserId(app, "anna");
    await assignUserToPage(app.db, anna, pageOne);
    await insertAgentKey(testDb.db, {
      name: "decisions-feed", keyPrefix: KEY.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(KEY),
      capabilities: ["write:shift_reports", "read:team", "read:money"] as never, pageIds: [pageOne],
      expiresAt: new Date(Date.now() + 30 * 86_400_000), createdBy: await fixtureUserId(app, "boss"),
    });
    server = await buildApiServer(app);
    await server.ready();
    const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "boss", password: "boss-password-for-tests" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const created = await server.inject({
      method: "POST", url: "/api/v1/admin/people", headers: { cookie },
      payload: { code: "anna", displayName: "anna", role: "chatter", state: "working", rights: ["submits_shift"], logins: { add: [anna] } },
    });
    expect(created.statusCode, created.body).toBe(200);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("serves every change of a decision in order, with what the ledger needs and no fan's name", async (context) => {
    if (!testDb) return context.skip();
    const start = (await feed("0")).next;
    const given = await nobodysSale(9_000);
    const pot = await nobodysSale(1_600);
    const decide = async (body: Record<string, unknown>) => {
      const said = await asAgent("POST", "/api/v1/agent/sale-decisions", { saidBy: "владелец", saidAt: "2026-11-12", ...SAID, ...body });
      expect(said.statusCode, said.body).toBe(200);
      return said.json().decision.id as number;
    };
    const first = await decide({ transactionId: given, kind: "owner", shares: [{ person: "anna", percent: 100 }], note: "договорились" });
    const toPot = await decide({ transactionId: pot, kind: "pot", pot: "dragon" });
    const second = await decide({ transactionId: given, kind: "exclude", supersedes: first });
    expect((await asAgent("POST", "/api/v1/agent/sale-decisions/cancel", { decisionId: toPot, note: "ошибка", ...SAID })).statusCode).toBe(200);

    const read = await feed(start);
    expect(read.changes.map((one) => [one.change, one.decision.id])).toEqual([
      ["made", first], ["made", toPot], ["superseded", first], ["made", second], ["cancelled", toPot],
    ]);
    const made = read.changes[0]!.decision;
    expect(made).toMatchObject({
      id: first, transactionId: given, pageLabel: "mia-1", kind: "owner", shares: [{ person: "anna", userId: anna, percent: 100 }],
      pot: null, state: "superseded", saidBy: "владелец", note: "договорились",
    });
    expect(read.changes[1]!.decision).toMatchObject({ kind: "pot", pot: "dragon", state: "cancelled" });
    expect(JSON.stringify(read)).not.toMatch(/fanName|fan_name/u);
    expect(read.changes.map((one) => one.seq)).toEqual([...read.changes.map((one) => one.seq)].sort((a, b) => a - b));
    expect((await feed(read.next)).changes).toEqual([]);
  });

  it("gives a change held back for the key's pages a new place once the key may read it: a lost answer does not lose it", async (context) => {
    if (!testDb) return context.skip();
    const key = Number((await testDb.pool.query("select id from agent_keys where name = 'decisions-feed'")).rows[0].id);
    const model = await createModel(app.db, { slug: "nova", name: "Nova" });
    const pageTwo = (await createFanslyPage(app.db, { modelId: model!.id, label: "nova-1" }))!.id;
    const read = (pageIds: number[], since?: string) => readSaleDecisionsFeed(app, { pageIds, limit: 500, agentKeyId: key, ...(since === undefined ? {} : { since }) });
    const start = (await read([pageOne])).next;
    // A decision of nova-1, a page the key does not hold: money outside the platform, it names no sale.
    const decision = Number((await testDb.pool.query(
      `insert into sale_owner_decisions (transaction_id, page_id, kind, shares, outcome, decided_at, said_by, source, needs_link)
       values (null, $1, 'off_platform', $2::jsonb, 'said', now(), 'владелец', 'agent', false) returning id`,
      [pageTwo, JSON.stringify([{ userId: anna, percent: 100 }])],
    )).rows[0].id);
    const first = await read([pageOne], start);
    expect(first.changes).toEqual([]);
    expect(first.held).toEqual([{ seq: expect.any(Number), decisionId: decision, pageLabel: "nova-1", reason: "page_outside_key" }]);
    const place = first.held[0]!.seq;
    // The cursor passed it: it is still listed.
    const second = await read([pageOne], first.next);
    expect(second.held.map((one) => one.decisionId)).toEqual([decision]);
    // The key may read nova-1 now: the change leaves the held list and comes through the cursor.
    const third = await read([pageOne, pageTwo], second.next);
    expect(third.changes.map((one) => [one.change, one.decision.id])).toEqual([["made", decision]]);
    expect(third.held).toEqual([]);
    // That answer never arrived: asked again from the same place, the change comes again.
    const again = await read([pageOne, pageTwo], second.next);
    expect(again.changes.map((one) => [one.change, one.decision.id])).toEqual([["made", decision]]);
    // It has a new place at the end of the feed; `next` is that place.
    const moved = third.changes[0]!.seq;
    expect(moved).toBeGreaterThan(Number(second.next));
    expect(moved).toBeGreaterThan(place);
    expect(again.changes[0]!.seq).toBe(moved);
    expect([third.next, again.next]).toEqual([String(moved), String(moved)]);
    const last = await read([pageOne, pageTwo], third.next);
    expect([last.changes, last.held]).toEqual([[], []]);
  });

  it("counts held places in the limit and says when more follow: a page with no changes is not the end", async (context) => {
    if (!testDb) return context.skip();
    const key = Number((await testDb.pool.query("select id from agent_keys where name = 'decisions-feed'")).rows[0].id);
    const model = await createModel(app.db, { slug: "luna", name: "Luna" });
    const other = (await createFanslyPage(app.db, { modelId: model!.id, label: "luna-1" }))!.id;
    const everyPage = (await testDb.pool.query("select id from pages")).rows.map((row) => Number(row.id));
    const start = (await readSaleDecisionsFeed(app, { pageIds: everyPage, limit: 500, agentKeyId: key })).next;
    // Three decisions in a row: of mia-1, of luna-1 (outside the key's pages), of mia-1; read one place at a time.
    const made: number[] = [];
    for (const page of [pageOne, other, pageOne]) {
      made.push(Number((await testDb.pool.query(
        `insert into sale_owner_decisions (transaction_id, page_id, kind, shares, outcome, decided_at, said_by, source, needs_link)
         values (null, $1, 'off_platform', $2::jsonb, 'said', now(), 'владелец', 'agent', false) returning id`,
        [page, JSON.stringify([{ userId: anna, percent: 100 }])],
      )).rows[0].id));
    }
    const pages: Array<{ changes: unknown[]; held: number[]; more: boolean; moved: boolean }> = [];
    let since = start;
    for (let at = 0; at < 4; at += 1) {
      const page = await readSaleDecisionsFeed(app, { pageIds: [pageOne], since, limit: 1, agentKeyId: key });
      pages.push({ changes: page.changes.map((one) => one.decision.id), held: page.held.map((one) => one.decisionId), more: page.more, moved: page.next !== since });
      since = page.next;
    }
    expect(pages).toEqual([
      { changes: [made[0]], held: [], more: true, moved: true },
      { changes: [], held: [made[1]], more: true, moved: true },
      { changes: [made[2]], held: [made[1]], more: false, moved: true },
      { changes: [], held: [made[1]], more: false, moved: false },
    ]);
  });

  it("serves a change committed after a later one was served, after the cursor", async (context) => {
    if (!testDb) return context.skip();
    const start = (await feed("0")).next;
    const late = await nobodysSale(4_000);
    const early = await nobodysSale(5_000);
    const slow = await testDb.pool.connect();
    try {
      // A decision written in a transaction that commits late (its other work, a slow call).
      await slow.query("begin");
      await slow.query(
        `insert into sale_owner_decisions (transaction_id, page_id, kind, shares, outcome, decided_at, source, needs_link)
         values ($1, $2, 'nobody', '[]'::jsonb, 'nobody', now(), 'dispute', false)`,
        [late, pageOne],
      );
      const said = await asAgent("POST", "/api/v1/agent/sale-decisions", { transactionId: early, kind: "exclude", saidBy: "владелец", saidAt: "2026-11-12", ...SAID });
      expect(said.statusCode, said.body).toBe(200);
      const first = await feed(start);
      expect(first.changes.map((one) => one.decision.transactionId)).toEqual([early]);
      await slow.query("commit");
      const second = await feed(first.next);
      expect(second.changes.map((one) => one.decision.transactionId)).toEqual([late]);
    } finally {
      await slow.query("rollback").catch(() => undefined);
      slow.release();
    }
  });
});
