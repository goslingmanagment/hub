import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  agentFanWatchResponseSchema,
  agentKeyIntrospectResponseSchema,
  agentSaleContextResponseSchema,
  agentShiftReviewResponseSchema,
} from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  findAgentKeyByDigest,
  insertAgentKey,
  insertPersonAgentKey,
  insertPersonLogin,
  insertPersonRow,
  revokeAgentKey,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Agents as participants (ecosystem plan §3.3, M1): who may ask Hub who an
// agent's key is, and who reads the agents' ready doors — «Разбор смены», the
// fan watch, the report check — and what each key sees there. The page grant,
// the capabilities and the key's agent decide; a session never gets in.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const MIN = 60_000;
const KEYS = {
  service: { caps: ["introspect:agent_keys"], agent: null },
  full: { caps: ["read:team", "read:money", "read:messages"], agent: "helper" },
  plain: { caps: ["read:team", "read:money"], agent: "helper" },
  team: { caps: ["read:team"], agent: "helper" },
  watch: { caps: ["read:messages"], agent: "helper" },
  content: { caps: ["read:content"], agent: "helper" },
  revoked: { caps: ["read:team"], agent: "helper" },
  unlinked: { caps: ["read:team"], agent: null },
  gone: { caps: ["read:team"], agent: "gone-bot" },
} as const;
type KeyName = keyof typeof KEYS;
const token = (name: KeyName) => `${AGENT_KEY_TOKEN_PREFIX}doors-${name}-0123456789abcdef`;
const SECRET_B = "only-on-page-b-words";

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ownerCookie = "";
let chatterId = 0;
let shiftAt = "";
const saleRefs: { a: string; b: string; ppv: string } = { a: "", b: "", ppv: "" };
let pricedAt = "";

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const asKey = (name: KeyName, method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${token(name)}` }, ...(payload ? { payload } : {}) });

describe("agent doors: who reads, and what", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    await createUserAccount(app, { username: "chat", role: "chatter" }, { source: "cli" });
    chatterId = await fixtureUserId(app, "chat");
    await setUserPassword(app, { userId: chatterId, password: "chat-password-for-tests" }, { source: "cli" });
    const owner = await fixtureUserId(app, "boss");
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    const pageA = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    const pageB = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-2" }))!.id;

    const person = (code: string, kind: "agent" | "human", state: "working" | "left") => insertPersonRow(app.db, {
      code, displayName: code, kind, role: kind === "agent" ? "agent" : "chatter", state, leftOn: null, telegramUserId: null,
      telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: owner,
    });
    const people = { helper: await person("helper", "agent", "working"), "gone-bot": await person("gone-bot", "agent", "left") };
    const chatPerson = await person("chat", "human", "working");
    await insertPersonLogin(app.db, { personId: chatPerson.id, userId: chatterId, linkedByUserId: owner });
    for (const [name, spec] of Object.entries(KEYS) as Array<[KeyName, (typeof KEYS)[KeyName]]>) {
      const key = await insertAgentKey(testDb.db, {
        name: `doors-${name}`,
        keyPrefix: token(name).slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
        keyDigest: sha256Hex(token(name)),
        capabilities: [...spec.caps],
        pageIds: [pageA],
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * MIN),
        createdBy: owner,
      });
      if (spec.agent !== null) await insertPersonAgentKey(app.db, { personId: people[spec.agent].id, agentKeyId: key.id, linkedByUserId: owner });
      if (name === "revoked") await revokeAgentKey(app.db, { id: key.id });
    }

    // A shift of «chat»: three hours on page A, an hour on page B, messages on both.
    const start = new Date(Math.floor((Date.now() - 6 * 60 * MIN) / MIN) * MIN);
    const at = (offset: number) => new Date(start.getTime() + offset * MIN);
    shiftAt = at(30).toISOString();
    const minutes = (page: number, from: number, to: number) => q(
      `insert into chatter_activity_minutes (user_id, page_id, minute, input)
       select $1, $2, minute, true from generate_series($3::timestamptz, $4::timestamptz, interval '1 minute') minute`,
      [chatterId, page, at(from), at(to)]);
    await minutes(pageA, 0, 179);
    await minutes(pageB, 180, 239);
    const fan = async (page: number, ref: string, username: string, conv: string) => {
      const fanId = Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', $1, $2) returning id", [ref, username])).rows[0].id);
      await q(`insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id, partner_username, last_message_at)
               values ($1, $2, $3, $4, $5, now())`, [page, fanId, conv, ref, username]);
      return fanId;
    };
    const fanA = await fan(pageA, "7410000001", "watched", "conv-a");
    const fanB = await fan(pageB, "7410000002", "other", "conv-b");
    const message = (page: number, conv: string, ref: string, fromFan: boolean, offset: number, text: string, tip = 0) => q(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain,
         media_metadata, message_type, is_tip, tip_amount_mills)
       values ($1, 'fansly', $2, $3, $4, $5, $6, $7, '[]'::jsonb, 1, $8, $9)`,
      [page, conv, ref, fromFan ? "fan" : "model", !fromFan, at(offset), text, tip > 0, tip]);
    const send = (page: number, ref: string, fanRef: string, offset: number) => q(
      `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
       values ('fansly', $1, $2, $3, $4, 'fansly-extension', false, false, $5, 'hand')`, [page, ref, fanRef, chatterId, at(offset)]);
    await message(pageA, "conv-a", "9500000999", true, 10, "hello page a", 5_000);
    for (let n = 0; n < 30; n += 1) {
      await message(pageA, "conv-a", String(9_500_000_000 + n), false, 11 + n, `reply ${n} to a`);
      await send(pageA, String(9_500_000_000 + n), "7410000001", 11 + n);
    }
    await message(pageB, "conv-b", "9600000999", true, 185, SECRET_B);
    for (let n = 0; n < 30; n += 1) {
      await message(pageB, "conv-b", String(9_600_000_000 + n), false, 186 + n, `${SECRET_B} ${n}`);
      await send(pageB, String(9_600_000_000 + n), "7410000002", 186 + n);
    }
    const sale = async (page: number, fanId: number, ref: string, offset: number) => Number((await q(
      `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
         gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, currency)
       values ($1, $2, $3, 'tip', 'tip', 'posted', 'ok', 10000, 10000, 8000, $4, 'fansly:rest', 'USD') returning id`,
      [page, fanId, ref, at(offset)])).rows[0].id);
    saleRefs.a = String(await sale(pageA, fanA, "tx-a", 60));
    saleRefs.b = String(await sale(pageB, fanB, "tx-b", 200));
    // Before the shift, on page A: a PPV sent without an author, a plain message without one, and a deleted one; then
    // the fan buys the PPV in the shift. The report check's reading of the archive counts the first two, never the third.
    const page = (ref: string, offset: number, text: string, price: number | null, deleted: boolean) => q(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain,
         media_metadata, message_type, is_tip, tip_amount_mills, price_mills, deleted_at)
       values ($1, 'fansly', 'conv-a', $2, 'model', true, $3, $4, '[]'::jsonb, 1, false, 0, $5, $6)`,
      [pageA, ref, at(offset), text, price, deleted ? at(offset + 1) : null]);
    await page("9500001001", -60, "priced   for\nyou", 20_000, false);
    await page("9500001002", -50, "no author here", null, false);
    await page("9500001003", -40, "deleted one", 20_000, true);
    pricedAt = at(-60).toISOString();
    saleRefs.ppv = String(Number((await q(
      `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
         gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, currency)
       values ($1, $2, 'tx-ppv', 'message_purchase', 'message_purchase', 'posted', 'ok', 20000, 20000, 16000, $3, 'fansly:rest', 'USD') returning id`,
      [pageA, fanA, at(100)])).rows[0].id));

    server = await buildApiServer(app);
    await server.ready();
    const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "boss", password: "boss-password-for-tests" } });
    expect(login.statusCode, login.body).toBe(200);
    const header = login.headers["set-cookie"];
    ownerCookie = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
  }, INTEGRATION_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  describe("«кто этот ключ»", () => {
    const introspect = (as: KeyName, keyDigest: string) => asKey(as, "POST", "/api/v1/agent/keys/introspect", { keyDigest });

    it("tells a service's own key the agent, the expiry and the cache, and nothing a key could be made of", async (context) => {
      if (!testDb) return context.skip();
      const before = await findAgentKeyByDigest(testDb.db, sha256Hex(token("full")));
      const response = await introspect("service", sha256Hex(token("full")));
      expect(response.statusCode, response.body).toBe(200);
      const body = agentKeyIntrospectResponseSchema.parse(response.json());
      expect(body).toMatchObject({ active: true, agent: { code: "helper" }, cacheSeconds: 60, staleSeconds: 3600 });
      expect(response.headers["cache-control"]).toBe("private, max-age=60, stale-if-error=3600");
      for (const leak of [token("full"), sha256Hex(token("full")), before!.keyPrefix, "read:team", "mia-1"]) {
        expect(response.body).not.toContain(leak);
      }
      // Reads only: the presented key was not used at Hub.
      const after = await findAgentKeyByDigest(testDb.db, sha256Hex(token("full")));
      expect(after!.lastUsedAt?.getTime() ?? null).toBe(before!.lastUsedAt?.getTime() ?? null);
      expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    });

    it("answers one bare «inactive» for a revoked, unknown, agentless or gone agent's key", async (context) => {
      if (!testDb) return context.skip();
      const bodies = [];
      for (const digest of [sha256Hex(token("revoked")), sha256Hex("agency_hub_agent_nobody"), sha256Hex(token("unlinked")),
        sha256Hex(token("gone")), sha256Hex(token("service"))]) {
        const response = await introspect("service", digest);
        expect(response.statusCode, response.body).toBe(200);
        bodies.push(response.body);
      }
      expect(new Set(bodies)).toEqual(new Set([JSON.stringify({ active: false, cacheSeconds: 60, staleSeconds: 3600 })]));
    });

    it("refuses an agent's own key, a session, no key, and a raw key in place of its digest", async (context) => {
      if (!testDb) return context.skip();
      expect((await introspect("full", sha256Hex(token("plain")))).statusCode).toBe(403);
      expect((await introspect("content", sha256Hex(token("plain")))).statusCode).toBe(403);
      const session = await server!.inject({ method: "POST", url: "/api/v1/agent/keys/introspect", headers: { cookie: ownerCookie },
        payload: { keyDigest: sha256Hex(token("full")) } });
      expect(session.statusCode).toBe(403);
      const anonymous = await server!.inject({ method: "POST", url: "/api/v1/agent/keys/introspect", payload: { keyDigest: sha256Hex(token("full")) } });
      expect(anonymous.statusCode).toBe(401);
      const raw = await introspect("service", token("full"));
      expect(raw.statusCode).toBe(400);
      expect(raw.body).not.toContain("helper");
    });

    it("tells an agent its own identity in its capabilities", async (context) => {
      if (!testDb) return context.skip();
      const mine = await asKey("full", "GET", "/api/v1/agent/capabilities");
      expect(mine.statusCode, mine.body).toBe(200);
      expect(mine.json().key.agent).toEqual({ code: "helper", displayName: "helper" });
      expect((await asKey("unlinked", "GET", "/api/v1/agent/capabilities")).json().key.agent).toBeNull();
    });
  });

  describe("«Разбор смены»", () => {
    const review = (as: KeyName, query: string) => asKey(as, "GET", `/api/v1/agent/team/shift-review?${query}`);

    it("serves the shift on the key's pages only, with the audit's numbers, and never the AI's own texts", async (context) => {
      if (!testDb) return context.skip();
      const response = await review("full", `userId=${chatterId}&at=${encodeURIComponent(shiftAt)}`);
      expect(response.statusCode, response.body).toBe(200);
      const body = agentShiftReviewResponseSchema.parse(response.json());
      expect(body.review.shift.pages.map((page) => page.pageLabel)).toEqual(["mia-1"]);
      expect(body.pagesLeftOut).toEqual(["mia-2"]);
      expect(response.body).not.toContain(SECRET_B);
      expect(body.texts).toBe(true);
      expect(body.review.chats.flatMap((chat) => chat.messages).some((message) => message.text === "hello page a")).toBe(true);
      for (const message of body.review.chats.flatMap((chat) => chat.messages)) {
        if (message.mine) expect([message.mine.aiText, message.mine.draft]).toEqual([null, null]);
      }
      expect(body.numbers.total.messages).toBe(30);
      expect(body.numbers.pages.map((page) => page.pageLabel)).toEqual(["mia-1"]);
    });

    it("finds the shift by the person's code, and keeps the texts from a key without read:messages", async (context) => {
      if (!testDb) return context.skip();
      const response = await review("plain", `person=chat&at=${encodeURIComponent(shiftAt)}`);
      expect(response.statusCode, response.body).toBe(200);
      const body = agentShiftReviewResponseSchema.parse(response.json());
      expect(body.texts).toBe(false);
      expect(body.review.chats.flatMap((chat) => chat.messages).every((message) => message.text === "")).toBe(true);
      expect(response.body).not.toContain("hello page a");
      expect((await review("plain", `person=helper&at=${encodeURIComponent(shiftAt)}`)).statusCode).toBe(404);
    });

    it("refuses a key without read:team and read:money, a revoked key and a session", async (context) => {
      if (!testDb) return context.skip();
      const query = `userId=${chatterId}&at=${encodeURIComponent(shiftAt)}`;
      expect((await review("team", query)).statusCode).toBe(403);
      expect((await review("content", query)).statusCode).toBe(403);
      expect((await review("watch", query)).statusCode).toBe(403);
      expect((await review("revoked", query)).statusCode).toBe(401);
      const session = await server!.inject({ method: "GET", url: `/api/v1/agent/team/shift-review?${query}`, headers: { cookie: ownerCookie } });
      expect(session.statusCode).toBe(403);
    });
  });

  describe("the fan watch", () => {
    const body = (pageLabel: string) => ({ watches: [{ pageLabel, username: "WATCHED", since: new Date(Date.now() - 24 * 60 * MIN).toISOString() }] });

    it("gives the watched fan's messages on the key's page, tips only with read:money", async (context) => {
      if (!testDb) return context.skip();
      const full = await asKey("full", "POST", "/api/v1/agent/team/fan-watch", body("mia-1"));
      expect(full.statusCode, full.body).toBe(200);
      const [watch] = agentFanWatchResponseSchema.parse(full.json()).watches;
      expect(watch!.chats).toBe(1);
      expect(watch!.fanMessages.map((message) => [message.text, message.tipMills])).toEqual([["hello page a", 5_000]]);
      expect(watch!.pageLastAt).not.toBeNull();
      const noMoney = agentFanWatchResponseSchema.parse((await asKey("watch", "POST", "/api/v1/agent/team/fan-watch", body("mia-1"))).json());
      expect(noMoney.watches[0]!.fanMessages[0]!.tipMills).toBeNull();
    });

    it("never gives back the message that set the mark: the archive's time goes to the microsecond", async (context) => {
      if (!testDb) return context.skip();
      const first = agentFanWatchResponseSchema.parse((await asKey("full", "POST", "/api/v1/agent/team/fan-watch", body("mia-1"))).json());
      const mark = first.watches[0]!.fanMessages.at(-1)!.archivedAt;
      const [watch] = body("mia-1").watches;
      const again = await asKey("full", "POST", "/api/v1/agent/team/fan-watch", { watches: [{ ...watch!, archivedAfter: mark }] });
      expect(again.statusCode, again.body).toBe(200);
      expect(agentFanWatchResponseSchema.parse(again.json()).watches[0]!.fanMessages).toEqual([]);
      const before = new Date(Date.parse(mark) - 1).toISOString();
      const earlier = await asKey("full", "POST", "/api/v1/agent/team/fan-watch", { watches: [{ ...watch!, archivedAfter: before }] });
      expect(agentFanWatchResponseSchema.parse(earlier.json()).watches[0]!.fanMessages.map((message) => message.archivedAt)).toEqual([mark]);
    });

    it("answers the plane's 404 for a page outside the grant and 403 without read:messages", async (context) => {
      if (!testDb) return context.skip();
      const outside = await asKey("full", "POST", "/api/v1/agent/team/fan-watch", body("mia-2"));
      expect(outside.statusCode).toBe(404);
      expect(outside.body).not.toContain(SECRET_B);
      expect((await asKey("plain", "POST", "/api/v1/agent/team/fan-watch", body("mia-1"))).statusCode).toBe(403);
      const session = await server!.inject({ method: "POST", url: "/api/v1/agent/team/fan-watch", headers: { cookie: ownerCookie }, payload: body("mia-1") });
      expect(session.statusCode).toBe(403);
    });
  });

  describe("the report check", () => {
    it("gives a sale of the key's pages its facts and lists one elsewhere as not found", async (context) => {
      if (!testDb) return context.skip();
      const response = await asKey("plain", "POST", "/api/v1/agent/team/sale-context", {
        sales: [{ saleRef: saleRefs.a }, { saleRef: saleRefs.b }, { pageLabel: "mia-1", transactionRef: "tx-a" }, { pageLabel: "mia-2", transactionRef: "tx-b" }],
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = agentSaleContextResponseSchema.parse(response.json());
      expect(body.sales.map((sale) => [sale.saleRef, sale.pageLabel, sale.fanUsername, sale.netMills])).toEqual([[saleRefs.a, "mia-1", "watched", 8_000]]);
      expect(body.sales[0]!.lastWriter?.name).toBe("chat");
      expect(body.notFound).toEqual(expect.arrayContaining([{ saleRef: saleRefs.b }, { pageLabel: "mia-2", transactionRef: "tx-b" }]));
      expect(response.body).not.toContain("tx-b\",\"kind");
    });

    it("gives the fan's chat as the report check reads the archive: the priced message, the authors of 7 days, the last author", async (context) => {
      if (!testDb) return context.skip();
      const ask = (as: KeyName) => asKey(as, "POST", "/api/v1/agent/team/sale-context", { sales: [{ saleRef: saleRefs.ppv }, { saleRef: saleRefs.a }] });
      const response = await ask("full");
      expect(response.statusCode, response.body).toBe(200);
      const body = agentSaleContextResponseSchema.parse(response.json());
      const ppv = body.sales.find((sale) => sale.saleRef === saleRefs.ppv)!;
      expect(ppv.archive).toEqual({
        conversationRef: "conv-a", partnerUsername: "watched", fanRecordUsername: "watched", partnerUsernames: ["watched"],
        pricedMessage: { sentAt: pricedAt, sender: null, text: "priced   for\nyou" },
        pageMessages7d: [{ name: "chat", messages: 30 }, { name: null, messages: 2 }],
        lastAuthored60d: { name: "chat", at: expect.any(String), within48h: true },
      });
      const tip = body.sales.find((sale) => sale.saleRef === saleRefs.a)!;
      expect(tip.archive.pricedMessage).toBeNull();
      expect(tip.archive.pageMessages7d).toEqual([{ name: "chat", messages: 30 }, { name: null, messages: 2 }]);
      const plain = agentSaleContextResponseSchema.parse((await ask("plain")).json());
      expect(plain.sales.find((sale) => sale.saleRef === saleRefs.ppv)!.archive.pricedMessage).toMatchObject({ sender: null, text: null });
    });

    it("refuses a key without read:money or read:team", async (context) => {
      if (!testDb) return context.skip();
      for (const name of ["team", "watch", "content"] as const) {
        expect((await asKey(name, "POST", "/api/v1/agent/team/sale-context", { sales: [{ saleRef: saleRefs.a }] })).statusCode).toBe(403);
      }
    });
  });
});
