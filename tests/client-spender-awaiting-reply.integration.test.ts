import { createHmac, randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  clientBootstrapResponseSchema,
  clientSpenderAwaitingReplyResponseSchema,
  clientSpenderStatsResponseSchema,
  errorResponseSchema,
  type ClientSpenderAwaitingReplyResponse,
} from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  deletePageByLabel,
  insertAgentKey,
  listPageSpenderAwaitingReply,
} from "@agency_hub_core/db";
import { encryptJson, sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  AGENT_KEY_TOKEN_PREFIX,
  assignPageToUser,
  createUserAccount,
  setUserPassword,
  unassignPageFromUser,
} from "../apps/runtime/src/services/auth.ts";
import {
  encodeSignedCursor,
  signedCursorKeyRing,
  type SignedCursorKeyRing,
  type SignedCursorScope,
} from "../apps/runtime/src/services/signed-cursor.ts";
import {
  CLIENT_SPENDER_AWAITING_REPLY_CURSOR_DOMAIN,
  CLIENT_SPENDER_AWAITING_REPLY_CURSOR_SEAL_PURPOSE,
  CLIENT_SPENDER_AWAITING_REPLY_CURSOR_TTL_MS,
} from "../apps/runtime/src/services/spender-awaiting-reply.ts";
import { frozenClientSpenderAwaitingReplySchema } from "./helpers/client-frozen-spender-awaiting-reply.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { armNoOutboundTrap, type NoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { SPENDER_STATS_FIXTURE_AS_OF, spenderStatsFixture } from "./helpers/spender-stats-fixture.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// chat-extension H-8c: GET /api/v1/client/pages/:pageLabel/spenders/awaiting-reply,
// the payers of one page whose fan waits for a reply. Who waits and in what
// order is proven on the repository (tests/client-spender-stats.integration.test.ts,
// the same seeded page) and the wire shape in
// tests/client-spender-awaiting-reply-contract.test.ts; this file is the route:
// who may ask, what it answers, how a walk goes on while the chats change, which
// cursors it takes, and that it never reaches a platform. Every test runs under
// the no-outbound trap, and every 200 is parsed by the installed client's shape.

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/** The instant the seeded page is of: 2026-10-03 12:00Z. */
const NOW = SPENDER_STATS_FIXTURE_AS_OF;
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const PAGE = "stats-of";
const PASSWORDS = { owner: "owner-secret", lead: "lead-secret", grisha: "grisha-secret" } as const;
const AUDIT = { source: "cli" } as const;
const EXTENSION_VERSION = "chat-extension/1.4.2";
/** A live Agent Read Plane key granted the page: refused by its kind, not by the page. */
const AGENT_KEY_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}clientawaitingreply0`;
const CURSOR_REFUSAL_MESSAGE = "cursor is not valid for this request";

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
/** authPolicyEnforcement "log" (the test default): the handler's own guards answer. */
let server: ApiServer | null = null;
/** authPolicyEnforcement "enforce": the declared policy answers before the handler. */
let enforceServer: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
let ownerCookie = "";
let ownerToken = "";
/** A team lead granted the page: another person on the same page. */
let leadToken = "";
/** Grisha's narrow chat-extension token, issued by the real password sign-in. */
let narrowToken = "";
/** Grisha's full device token. */
let fullToken = "";
/** A chatter of stats-other-of only. */
let nikitaToken = "";
let grishaId = 0;
const pageIds: Record<string, number> = {};

function db() {
  if (!testDb) throw new Error("test database missing");
  return testDb;
}

const fixture = spenderStatsFixture(db);

function queueUrl(pageLabel: string, query: string) {
  return `/api/v1/client/pages/${pageLabel}/spenders/awaiting-reply${query === "" ? "" : `?${query}`}`;
}

async function queue(
  token: string,
  pageLabel: string,
  query = "",
  options: { via?: ApiServer; clientVersion?: string | null } = {},
): Promise<InjectResponse> {
  const clientVersion = options.clientVersion === undefined ? EXTENSION_VERSION : options.clientVersion;
  return (options.via ?? server!).inject({
    method: "GET",
    url: queueUrl(pageLabel, query),
    headers: {
      authorization: `Bearer ${token}`,
      ...(clientVersion === null ? {} : { "x-client-version": clientVersion }),
    },
  });
}

/** A 200 answer, checked against the installed client's own shape first, then the hub's (what the SDK parses with). */
async function page(token: string, pageLabel: string, query = ""): Promise<ClientSpenderAwaitingReplyResponse> {
  const response = await queue(token, pageLabel, query);
  expect(response.statusCode, response.body).toBe(200);
  frozenClientSpenderAwaitingReplySchema.parse(response.json());
  return clientSpenderAwaitingReplyResponseSchema.parse(response.json());
}

const cursorQuery = (cursor: string, limit?: number) =>
  `${limit === undefined ? "" : `limit=${limit}&`}cursor=${encodeURIComponent(cursor)}`;

const refs = (body: ClientSpenderAwaitingReplyResponse) => body.items.map((item) => item.fanRef);

function expectRefused(response: InjectResponse, statusCode: number, error: string, reason?: string) {
  expect(response.statusCode, response.body).toBe(statusCode);
  const body = errorResponseSchema.parse(response.json());
  expect(body).toMatchObject({ error, statusCode, ...(reason === undefined ? {} : { reason }) });
  if (reason === undefined) {
    expect(body.reason, response.body).toBeUndefined();
  }
}

/** Every refused cursor is refused the same way: one status, one reason, one message. */
function expectCursorRefused(response: InjectResponse, label: string) {
  expect(response.statusCode, `${label}: ${response.body}`).toBe(400);
  expect(errorResponseSchema.parse(response.json()), label).toEqual({
    error: "bad_request",
    message: CURSOR_REFUSAL_MESSAGE,
    statusCode: 400,
    reason: "cursor_invalid",
  });
}

/** A cookie session, by the real password sign-in. */
async function loginCookie(username: keyof typeof PASSWORDS): Promise<string> {
  const login = await server!.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password: PASSWORDS[username] },
  });
  expect(login.statusCode, login.body).toBe(200);
  const header = login.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}

async function patchConfig(patches: Array<{ key: string; value: unknown }>) {
  const response = await server!.inject({
    method: "PATCH",
    url: "/api/v1/admin/config",
    headers: { cookie: ownerCookie },
    payload: { patches },
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** The owner's master switch and the `stats` flag, for every page. */
async function switchStatsOn() {
  await patchConfig([
    { key: "chatExtensionEnabled", value: true },
    { key: "chatExtensionFeatures", value: JSON.stringify({ "*": { stats: true } }) },
  ]);
}

async function bootstrapOf(token: string) {
  const response = await server!.inject({
    method: "GET",
    url: "/api/v1/client/bootstrap",
    headers: { authorization: `Bearer ${token}`, "x-client-version": EXTENSION_VERSION },
  });
  expect(response.statusCode, response.body).toBe(200);
  return clientBootstrapResponseSchema.parse(response.json());
}

/**
 * Arms the trap again after a test seeded its own chats: the trap compares the
 * chats' unread counts row by row, so a chat seeded after it was armed would
 * read as a change. What a test changes DURING a walk never touches a count.
 */
async function rearmTrap() {
  await trap?.restore();
  trap = await armNoOutboundTrap(db());
}

/** An OnlyFans page the extension can bind, granted to grisha. */
async function seedGrantedPage(label: string, externalPageId: string) {
  const seeded = await fixture.seedPage(label);
  await db().pool.query("update pages set external_page_id = $1 where id = $2", [externalPageId, seeded.id]);
  await assignPageToUser(app, { userId: grishaId, pageLabel: label }, AUDIT);
  pageIds[label] = seeded.id;
  return seeded;
}

/** We answer these chats: their fans no longer wait. */
async function reply(pageId: number, conversationRefs: string[], when: Date) {
  await db().pool.query(
    `update page_dm_threads
     set last_model_message_at = $1, last_message_at = $1, last_message_sender_role = 'model'
     where platform_account_id = $2 and platform_conversation_id = any($3::text[])`,
    [when.toISOString(), pageId, conversationRefs],
  );
}

/** The fans of these chats write: they wait (again), from `when`. */
async function fanWrites(pageId: number, conversationRefs: string[], when: Date) {
  await db().pool.query(
    `update page_dm_threads
     set last_fan_message_at = $1, last_message_at = $1, last_message_sender_role = 'fan'
     where platform_account_id = $2 and platform_conversation_id = any($3::text[])`,
    [when.toISOString(), pageId, conversationRefs],
  );
}

/** A key for one purpose, derived from one key of the encryption ring, as the routes derive theirs. */
const subkeyOf = (rootKey: Buffer, purpose: string) => createHmac("sha256", rootKey).update(purpose, "utf8").digest();

/** The route's own seal of a walk's state. */
const sealOf = (state: unknown, ring: SignedCursorKeyRing) =>
  encryptJson(state, subkeyOf(ring.key, CLIENT_SPENDER_AWAITING_REPLY_CURSOR_SEAL_PURPOSE), ring.keyVersion);

/**
 * A cursor a test builds itself (the route's own spec is private to it). By
 * default it is what the route issues: its domain, its seal, the hub's keys,
 * and a state of its shape that stands between F (700 000 in all) and C
 * (197 000) on the seeded page. `signed` puts something else where the sealed
 * state goes.
 */
function mintCursor(input: {
  scope: SignedCursorScope;
  state?: unknown;
  signed?: (state: unknown, ring: SignedCursorKeyRing) => unknown;
  domain?: string;
  ring?: SignedCursorKeyRing;
  now?: Date;
}): string {
  const ring = input.ring ?? signedCursorKeyRing(app.config);
  const state = input.state ?? { after: { gross: "200000", at: "0", fan: 1 }, loaded: 0 };
  return encodeSignedCursor(
    {
      domain: input.domain ?? CLIENT_SPENDER_AWAITING_REPLY_CURSOR_DOMAIN,
      state: z.unknown(),
      ttlMs: CLIENT_SPENDER_AWAITING_REPLY_CURSOR_TTL_MS,
    },
    { scope: input.scope, state: (input.signed ?? sealOf)(state, ring), now: input.now ?? new Date() },
    ring,
  );
}

/** What a cursor's holder can read of it: the envelope its base64url text decodes to. */
function readCursor(cursor: string) {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const envelope = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
  const payload = z.record(z.string(), z.unknown()).parse(envelope.payload);
  const state = z.record(z.string(), z.unknown()).parse(payload.st);
  return { text, envelope, payload, state };
}

describe("GET /api/v1/client/pages/:pageLabel/spenders/awaiting-reply", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await resetIntegrationDatabase(testDb.pool);
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "owner", role: "owner", password: PASSWORDS.owner }, AUDIT);
    await createUserAccount(app, { username: "lead", role: "team_lead", password: PASSWORDS.lead }, AUDIT);
    await createUserAccount(app, { username: "grisha", role: "chatter" }, AUDIT);
    await createUserAccount(app, { username: "nikita", role: "chatter" }, AUDIT);
    const ownerId = await fixtureUserId(app, "owner");
    const leadId = await fixtureUserId(app, "lead");
    grishaId = await fixtureUserId(app, "grisha");
    const nikitaId = await fixtureUserId(app, "nikita");
    // Setting a password ends every sign-in, so it comes before the tokens.
    await setUserPassword(app, { userId: grishaId, password: PASSWORDS.grisha }, AUDIT);

    // The seeded page of the repository tests, and another page beside it.
    const { page: main, other } = await fixture.seedMainPage();
    pageIds[PAGE] = main.id;
    pageIds["stats-other-of"] = other.id;
    await fixture.rebuildAll(main.id);
    await fixture.rebuildAll(other.id);
    await testDb.pool.query("update pages set external_page_id = '100000001' where id = $1", [main.id]);
    await testDb.pool.query("update pages set external_page_id = '100000002' where id = $1", [other.id]);

    const aux = await createModel(app.db, { slug: "aux", name: "Aux" });
    for (const [label, create] of [
      ["stats-fansly", createFanslyPage],
      // An OnlyFans page the extension could not bind: no platform account id.
      ["nova-of", createOnlyFansPage],
      ["stats-old-of", createOnlyFansPage],
    ] as const) {
      const created = await create(app.db, { modelId: aux!.id, label });
      pageIds[label] = created!.id;
    }
    for (const label of [PAGE, "stats-fansly", "nova-of", "stats-old-of"]) {
      await assignPageToUser(app, { userId: grishaId, pageLabel: label }, AUDIT);
    }
    await assignPageToUser(app, { userId: leadId, pageLabel: PAGE }, AUDIT);
    await assignPageToUser(app, { userId: nikitaId, pageLabel: "stats-other-of" }, AUDIT);
    await deletePageByLabel(app.db, "stats-old-of");

    ownerToken = (await issueDeviceTokenForUserId(app, { userId: ownerId, label: "owner client" })).token;
    leadToken = (await issueDeviceTokenForUserId(app, { userId: leadId, label: "lead client" })).token;
    fullToken = (await issueDeviceTokenForUserId(app, { userId: grishaId, label: "grisha full" })).token;
    nikitaToken = (await issueDeviceTokenForUserId(app, { userId: nikitaId, label: "nikita client" })).token;
    await insertAgentKey(app.db, {
      name: "client-awaiting-reply-probe",
      keyPrefix: AGENT_KEY_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(AGENT_KEY_TOKEN),
      capabilities: ["read:money"],
      pageIds: [main.id],
      dailyRequestBudget: 5000,
      dailyRowBudget: 500_000,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdBy: null,
    });

    server = await buildApiServer(app);
    await server.ready();
    enforceServer = await buildApiServer(createTestAppContext(testDb, { authPolicyEnforcement: "enforce" }));
    await enforceServer.ready();

    const narrow = await server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      headers: { "x-client-version": EXTENSION_VERSION },
      payload: {
        username: "grisha",
        password: PASSWORDS.grisha,
        label: "Firefox · macOS · ChatSpace",
        mode: "active",
        client: "chat-extension",
      },
    });
    expect(narrow.statusCode, narrow.body).toBe(200);
    expect(narrow.json()).toMatchObject({ client: "chat-extension" });
    narrowToken = narrow.json<{ token: string }>().token;

    ownerCookie = await loginCookie("owner");
    trap = await armNoOutboundTrap(testDb);
  }, 120_000);

  afterEach(async () => {
    await trap?.restore();
    trap = null;
    await server?.close();
    server = null;
    await enforceServer?.close();
    enforceServer = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("is inert as merged: every caller is refused until the owner switches Statistics on", async (context) => {
    if (!server) return context.skip();

    // At rest (what a merge leaves): every caller is refused, whatever the query.
    for (const token of [narrowToken, fullToken, ownerToken]) {
      expectRefused(await queue(token, PAGE), 409, "client_feature_disabled", "disabled");
    }
    expectRefused(await queue(narrowToken, PAGE, "limit=1&cursor=not-a-cursor"), 409, "client_feature_disabled", "disabled");
    const atRest = await bootstrapOf(narrowToken);
    // The hub serves the queue from now on, and with it all of the `stats`
    // feature; serving a capability switches nothing on.
    expect(atRest.capabilities).toEqual(expect.arrayContaining(["spenders-stats-v1", "awaiting-reply-v1"]));
    expect(atRest.flags.stats).toBe(false);
    for (const listed of atRest.pages) {
      expect(listed.features.stats?.available, listed.pageLabel).toBe(false);
    }

    // The owner switches Statistics on: the feature is available and the route answers.
    await switchStatsOn();
    expect((await bootstrapOf(narrowToken)).pages.find((listed) => listed.pageLabel === PAGE)?.features.stats)
      .toEqual({ available: true });
    expect((await page(narrowToken, PAGE)).total).toBe(3);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("answers the payers who wait, biggest spender first, the same to everyone granted the page", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();
    // C's chat row knows a name the fan's own record does not.
    await db().pool.query(
      "update page_dm_threads set partner_display_name = 'Carl' where platform_account_id = $1 and platform_conversation_id = '1003'",
      [pageIds[PAGE]],
    );

    const body = await page(narrowToken, PAGE);

    expect(body).toEqual({
      items: [
        // F: 700 000 in all; the fan wrote after our last message, nothing is
        // unread and the chat's head is the fan's message: read, not answered.
        {
          fanRef: "1006",
          username: "fan1006",
          displayName: null,
          lifetimeGrossMills: 700_000,
          lastFanMessageAt: "2026-09-30T10:00:00.000Z",
          lastModelMessageAt: "2026-09-29T10:00:00.000Z",
          unreadCount: 0,
          readState: "read",
        },
        // C: we never wrote, and the chat row's head is unknown: whether the
        // message was read is not known. Its own category, with no count.
        {
          fanRef: "1003",
          username: "fan1003",
          displayName: "Carl",
          lifetimeGrossMills: 197_000,
          lastFanMessageAt: "2026-08-01T12:00:00.000Z",
          lastModelMessageAt: null,
          unreadCount: null,
          readState: "unknown",
        },
        // A: two unread messages.
        {
          fanRef: "1001",
          username: "fan1001",
          displayName: null,
          lifetimeGrossMills: 37_000,
          lastFanMessageAt: "2026-10-03T08:00:00.000Z",
          lastModelMessageAt: "2026-10-02T08:00:00.000Z",
          unreadCount: 2,
          readState: "unread",
        },
      ],
      total: 3,
      loaded: 3,
      unknown: 1,
      nextCursor: null,
      asOf: NOW.toISOString(),
    });
    // Not in the queue: B (we answered in the fan's newest chat; an older chat
    // of B's that waits does not count), D (no chat), E (waits, never paid in
    // all), G (a deleted account).
    for (const absent of ["1002", "1004", "1005", "1007"]) {
      expect(refs(body), absent).not.toContain(absent);
    }

    // The route adds nothing to the repository's read and drops nothing from it.
    const counted = await listPageSpenderAwaitingReply(app.db, { pageId: pageIds[PAGE]!, limit: 50 });
    expect(refs(body)).toEqual(counted.items.map((item) => item.fanRef));
    expect({ total: body.total, unknown: body.unknown }).toEqual({ total: counted.total, unknown: counted.unknown });
    // The statistics of the same page count the same queue.
    const stats = await server.inject({
      method: "GET",
      url: `/api/v1/client/pages/${PAGE}/spenders/stats?windowDays=30&timeZone=UTC`,
      headers: { authorization: `Bearer ${narrowToken}`, "x-client-version": EXTENSION_VERSION },
    });
    expect(stats.statusCode, stats.body).toBe(200);
    expect(clientSpenderStatsResponseSchema.parse(stats.json()).queueSummary)
      .toEqual({ total: body.total, unknown: body.unknown });

    // The page's queue is the page's: an owner, a team lead, a chatter's narrow
    // and full tokens all read the same body.
    for (const [who, token] of [["owner", ownerToken], ["team lead", leadToken], ["full token", fullToken]] as const) {
      expect(await page(token, PAGE), who).toEqual(body);
    }
    // The default page is 50 rows.
    expect(await page(narrowToken, PAGE, "limit=50")).toEqual(body);

    // Another page is another queue: its one payer has no chat, so nobody waits.
    expect(await page(ownerToken, "stats-other-of")).toEqual({
      items: [], total: 0, loaded: 0, unknown: 0, nextCursor: null, asOf: NOW.toISOString(),
    });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("walks the queue a page at a time: loaded grows, the counts are of each page's instant, the last page has no cursor", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();

    const first = await page(narrowToken, PAGE, "limit=1");
    expect(refs(first)).toEqual(["1006"]);
    expect(first).toMatchObject({ total: 3, loaded: 1, unknown: 1, asOf: NOW.toISOString() });
    expect(first.nextCursor).not.toBeNull();

    // Every page says when it was read.
    vi.setSystemTime(at(5));
    const second = await page(narrowToken, PAGE, cursorQuery(first.nextCursor!, 1));
    expect(refs(second)).toEqual(["1003"]);
    expect(second).toMatchObject({ total: 3, loaded: 2, unknown: 1, asOf: at(5).toISOString() });

    const third = await page(narrowToken, PAGE, cursorQuery(second.nextCursor!, 1));
    expect(refs(third)).toEqual(["1001"]);
    expect(third).toMatchObject({ total: 3, loaded: 3, unknown: 1, nextCursor: null });

    // The page size may change during a walk, and a cursor is not used up: a
    // request that is repeated reads from the same place.
    const rest = await page(narrowToken, PAGE, cursorQuery(first.nextCursor!, 100));
    expect(refs(rest)).toEqual(["1003", "1001"]);
    expect(rest).toMatchObject({ loaded: 3, nextCursor: null });
    expect(refs(await page(narrowToken, PAGE, cursorQuery(first.nextCursor!)))).toEqual(["1003", "1001"]);

    // A page that ends where the queue ends carries no cursor: no empty page follows.
    const two = await page(narrowToken, PAGE, "limit=2");
    expect(refs(two)).toEqual(["1006", "1003"]);
    expect(two).toMatchObject({ loaded: 2 });
    expect(two.nextCursor).not.toBeNull();
    expect(await page(narrowToken, PAGE, cursorQuery(two.nextCursor!, 2)))
      .toMatchObject({ items: [{ fanRef: "1001" }], loaded: 3, nextCursor: null });
    expect(await page(narrowToken, PAGE, "limit=3")).toMatchObject({ loaded: 3, nextCursor: null });

    // The cursor is the person's, not the token's: the same chatter's other
    // token goes on with the walk.
    expect(refs(await page(fullToken, PAGE, cursorQuery(first.nextCursor!)))).toEqual(["1003", "1001"]);

    // Nothing is kept between requests. We answer C: the next page of the same
    // walk does not serve C, and its counts are the queue's as it is now.
    await reply(pageIds[PAGE]!, ["1003"], at(6));
    vi.setSystemTime(at(10));
    const moved = await page(narrowToken, PAGE, cursorQuery(first.nextCursor!, 1));
    expect(refs(moved)).toEqual(["1001"]);
    expect(moved).toMatchObject({ total: 2, loaded: 2, unknown: 0, nextCursor: null, asOf: at(10).toISOString() });
    expect(refs(await page(narrowToken, PAGE))).toEqual(["1006", "1001"]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("serves 1200 payers whole, and a walk holds while the conversations change under it", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();

    // 1200 payers, numbered g = 1..1200, of 7 spend levels; within a level many
    // share the minute of their fan's last message and some the microsecond.
    // Every twentieth (g % 20 = 7) was answered, so 1140 wait; of those, the
    // ones with nothing unread under a chat row whose head is unknown
    // (g % 15 = 0, 80 of them) have an unknown read state.
    const BULK = 1200;
    const bulkRef = (g: number) => String(500_000 + g);
    const baseMicros = BigInt(Date.parse("2026-10-01T00:00:00Z")) * 1000n;
    const grossOf = (g: number) => 20_000 + (g % 7) * 5_000;
    const seededMicros = (g: number) => baseMicros + BigInt((g % 50) * 60_000_000 + (g % 3));
    const wroteAt = new Map<number, bigint>();
    const waiting = new Set<number>();
    for (let g = 1; g <= BULK; g += 1) {
      wroteAt.set(g, seededMicros(g));
      if (g % 20 !== 7) waiting.add(g);
    }
    /** The queue as the definitions order it: spend, then waiting time, then the fan's id (which grows with g). */
    const queueNow = () => [...waiting].sort((left, right) =>
      grossOf(right) - grossOf(left) || Number(wroteAt.get(left)! - wroteAt.get(right)!) || left - right);
    const unknownNow = () => [...waiting].filter((g) => g % 15 === 0).length;

    const big = await seedGrantedPage("stats-big-of", "100000003");
    await db().pool.query(
      `with new_fans as (
         insert into fans (platform, platform_user_id, username)
         select 'onlyfans', (500000 + g)::text, 'bulk' || g from generate_series(1, ${BULK}) g order by g
         returning id, platform_user_id
       ), numbered as (
         select id, platform_user_id, platform_user_id::int - 500000 as g from new_fans
       ), memberships as (
         insert into page_fans (fan_id, platform_account_id) select id, $1 from numbered
       ), chats as (
         insert into page_dm_threads (
           platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id,
           unread_count, last_message_sender_role, last_message_at,
           last_fan_message_at, last_model_message_at, is_visible
         )
         select $1, n.id, n.platform_user_id, n.platform_user_id,
                case when n.g % 20 = 7 then 0 else n.g % 3 end,
                (case when n.g % 20 = 7 then 'model' when n.g % 5 = 0 then 'unknown' else 'fan' end)::dm_sender_role,
                greatest(w.fan_at, w.model_at), w.fan_at, w.model_at, true
         from numbered n
         cross join lateral (
           select timestamptz '2026-10-01T00:00:00Z' + make_interval(mins => n.g % 50)
                    + (n.g % 3) * interval '1 microsecond' as fan_at,
                  case when n.g % 20 = 7 then timestamptz '2026-10-02T00:00:00Z'
                       when n.g % 4 = 0 then null
                       else timestamptz '2026-09-20T00:00:00Z'
                  end as model_at
         ) w
       )
       insert into transactions (
         platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
         gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, is_active, source
       )
       select $1, n.id, 'bulk-' || n.platform_user_id, 'tip', 'tip', 'posted', 'ok',
              20000 + (n.g % 7) * 5000, 20000 + (n.g % 7) * 5000, (20000 + (n.g % 7) * 5000) * 8 / 10,
              timestamptz '2026-08-15T10:00:00Z', true, 'ofapi:rest'
       from numbered n`,
      [big.id],
    );
    await fixture.rebuildAll(big.id);
    await rearmTrap();

    const walk = async (between?: (step: number) => Promise<void>) => {
      const pages: ClientSpenderAwaitingReplyResponse[] = [];
      let cursor: string | null = null;
      for (let step = 0; step < 40; step += 1) {
        const body = await page(narrowToken, "stats-big-of", cursor === null ? "limit=100" : cursorQuery(cursor, 100));
        pages.push(body);
        cursor = body.nextCursor;
        if (cursor === null) break;
        await between?.(step);
      }
      return pages;
    };

    const initial = queueNow();
    expect(initial).toHaveLength(1140);
    // Served on the first page; two the walk has not reached yet.
    const [earlyA, earlyB, lateA, lateB] = [initial[10]!, initial[60]!, initial[450]!, initial[900]!];
    // Two fans we had answered: one of the lowest spend level, one of the highest.
    const [joinsBehind, joinsAhead] = [7, 27];
    expect([grossOf(joinsBehind), grossOf(joinsAhead)]).toEqual([20_000, 50_000]);
    const expectedTotals: number[] = [];
    const expectedUnknown: number[] = [];

    const pages = await walk(async (step) => {
      if (step === 0) {
        // After the first page: we answer two fans already served and two the
        // walk has not reached, and a fan of the lowest level writes again, so
        // waits from now at the very end of the queue.
        await reply(big.id, [earlyA, earlyB, lateA, lateB].map(bulkRef), at(1));
        for (const g of [earlyA, earlyB, lateA, lateB]) waiting.delete(g);
        await fanWrites(big.id, [bulkRef(joinsBehind)], at(-60));
        wroteAt.set(joinsBehind, BigInt(at(-60).getTime()) * 1000n);
        waiting.add(joinsBehind);
      }
      if (step === 2) {
        // After the third page the walk is past the highest level; a fan of it
        // writes again and takes a place the walk has already left.
        await fanWrites(big.id, [bulkRef(joinsAhead)], at(-30));
        wroteAt.set(joinsAhead, BigInt(at(-30).getTime()) * 1000n);
        waiting.add(joinsAhead);
      }
      expectedTotals.push(waiting.size);
      expectedUnknown.push(unknownNow());
    });

    const served = pages.flatMap(refs);
    // Nobody twice.
    expect(new Set(served).size).toBe(served.length);
    // Every fan whose place did not change is served exactly once, in the
    // queue's order, with no hole: the fans we answered before the walk reached
    // them are gone, the two answered after they were served stay served, and
    // the fan who started waiting behind the walk's position closes it.
    expect(served).toEqual([
      ...initial.filter((g) => g !== lateA && g !== lateB).map(bulkRef),
      bulkRef(joinsBehind),
    ]);
    // The fan who took a place the walk had left is not in this walk.
    expect(served).not.toContain(bulkRef(joinsAhead));

    // 1139 rows: eleven full pages and one of 39.
    expect(pages.map((body) => body.items.length)).toEqual([...Array.from({ length: 11 }, () => 100), 39]);
    expect(pages.map((body) => body.loaded)).toEqual(pages.map((_, index) => Math.min((index + 1) * 100, 1139)));
    expect(pages.slice(0, -1).every((body) => body.nextCursor !== null)).toBe(true);
    // The counts are the queue's at each page's own instant.
    expect(pages[0]).toMatchObject({ total: 1140, unknown: 80 });
    expect(pages.slice(1).map((body) => body.total)).toEqual(expectedTotals);
    expect(pages.slice(1).map((body) => body.unknown)).toEqual(expectedUnknown);
    expect(expectedTotals.at(-1)).toBe(1138);
    // So a walk's `loaded` is what it served, not the queue's size when it ended.
    expect(pages.at(-1)).toMatchObject({ loaded: 1139, total: 1138, nextCursor: null });

    // Spend never grows along the walk, and within one spend the fan waiting longest comes first.
    const rows = pages.flatMap((body) => body.items);
    for (let index = 1; index < rows.length; index += 1) {
      const [before, after] = [rows[index - 1]!, rows[index]!];
      expect(after.lifetimeGrossMills, after.fanRef).toBeLessThanOrEqual(before.lifetimeGrossMills);
      if (after.lifetimeGrossMills === before.lifetimeGrossMills) {
        expect(Date.parse(after.lastFanMessageAt), after.fanRef).toBeGreaterThanOrEqual(Date.parse(before.lastFanMessageAt));
      }
    }
    expect(rows.filter((row) => row.readState === "unknown").every((row) => row.unreadCount === null)).toBe(true);
    expect(rows.filter((row) => row.readState !== "unknown").every((row) => row.unreadCount !== null)).toBe(true);

    // The next walk has the queue as it is now: everyone who waits, once, the late arrival included.
    const again = (await walk()).flatMap(refs);
    expect(again).toEqual(queueNow().map(bulkRef));
    expect(again).toHaveLength(1138);
    expect(again).toContain(bulkRef(joinsAhead));

    await trap!.assertNoOutbound();
  }, 120_000);

  it("can meet a fan a second time when the fan writes again during a walk; the next walk has everyone once", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();

    const first = await page(narrowToken, PAGE, "limit=1");
    expect(refs(first)).toEqual(["1006"]);

    // F writes again: the same spend and a later message, so F's place moves
    // behind the walk's position. A walk is not a snapshot.
    await fanWrites(pageIds[PAGE]!, ["1006"], at(30));
    vi.setSystemTime(at(60));
    const second = await page(narrowToken, PAGE, cursorQuery(first.nextCursor!, 1));
    expect(second.items[0]).toMatchObject({ fanRef: "1006", lastFanMessageAt: at(30).toISOString() });
    expect(second).toMatchObject({ total: 3, loaded: 2 });

    const rest = await page(narrowToken, PAGE, cursorQuery(second.nextCursor!));
    expect(refs(rest)).toEqual(["1003", "1001"]);
    // Four rows served of a queue of three: `loaded` counts rows, and a client keeps a fan's first row.
    expect(rest).toMatchObject({ total: 3, loaded: 4, nextCursor: null });

    expect(refs(await page(narrowToken, PAGE))).toEqual(["1006", "1003", "1001"]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses a cursor this hub did not issue for this page and person, always the same way", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();
    await seedGrantedPage("stats-second-of", "100000007");
    await rearmTrap();

    const first = await page(narrowToken, PAGE, "limit=1");
    const cursor = first.nextCursor!;
    const refused = async (token: string, pageLabel: string, value: string, label: string) => {
      expectCursorRefused(await queue(token, pageLabel, cursorQuery(value, 1)), label);
    };

    // Cut, extended, or changed by one character.
    const middle = Math.floor(cursor.length / 2);
    const swapped = `${cursor.slice(0, middle)}${cursor[middle] === "A" ? "B" : "A"}${cursor.slice(middle + 1)}`;
    for (const [label, value] of [
      ["without its last character", cursor.slice(0, -1)],
      ["without its first character", cursor.slice(1)],
      ["with a character added", `${cursor}A`],
      ["with one character changed", swapped],
      ["twice", `${cursor}${cursor}`],
    ] as const) {
      await refused(narrowToken, PAGE, value, label);
    }

    // Not a cursor at all: free text, another encoding, an envelope with no signature of ours.
    const unsigned = Buffer.from(JSON.stringify({
      format: 1, keyVersion: 1, mac: "A".repeat(43), payload: { iat: NOW.getTime(), st: { after: { at: "0", fan: 1, gross: "0" }, loaded: 0 }, v: 1 },
    }), "utf8").toString("base64url");
    for (const value of ["abc", "cur-queue-2", "e30", "%%%", "a b", "=", "A".repeat(2048), unsigned, "1", "null"]) {
      await refused(narrowToken, PAGE, value, `not a cursor: ${value.slice(0, 24)}`);
    }

    // Issued to somebody else: another person granted the same page, and the owner.
    await refused(leadToken, PAGE, cursor, "another person's cursor");
    await refused(ownerToken, PAGE, cursor, "another person's cursor, presented by the owner");
    // Issued for another page of the same person.
    await refused(narrowToken, "stats-second-of", cursor, "another page's cursor");
    expect((await page(narrowToken, "stats-second-of")).total).toBe(0);

    // Minted by a test with the hub's own keys: the same binding, domain, seal
    // and state the route uses is taken, so each refusal below is for what it names.
    const scope = { pageId: pageIds[PAGE]!, userId: grishaId };
    const own = await page(narrowToken, PAGE, cursorQuery(mintCursor({ scope }), 1));
    expect(own).toMatchObject({ items: [{ fanRef: "1003" }], loaded: 1 });
    const minted: Array<[string, string]> = [
      ["signed with another key", mintCursor({ scope, ring: { ...signedCursorKeyRing(app.config), key: randomBytes(32) } })],
      ["another route's cursor", mintCursor({ scope, domain: "agency-hub:client-feed-cursor:v1" })],
      ["a later version's cursor", mintCursor({ scope, domain: "agency-hub:client-awaiting-reply-cursor:v2" })],
      ["bound to the page alone", mintCursor({ scope: { pageId: scope.pageId } })],
      ["bound to the person alone", mintCursor({ scope: { userId: scope.userId } })],
      ["bound to more than the route binds", mintCursor({ scope: { ...scope, fanRef: "1006" } })],
      ["bound to another page", mintCursor({ scope: { ...scope, pageId: pageIds["stats-second-of"]! } })],
      ["issued ten minutes from now", mintCursor({ scope, now: at(600) })],
      // Signed by this hub for this caller, with a state the route never wrote.
      ["a state with a key too many", mintCursor({ scope, state: { after: { gross: "1", at: "1", fan: 1 }, loaded: 0, offset: 5 } })],
      ["a state without a position", mintCursor({ scope, state: { loaded: 0 } })],
      ["a position that is not a number", mintCursor({ scope, state: { after: { gross: "abc", at: "1", fan: 1 }, loaded: 0 } })],
      ["a position written as a JSON number", mintCursor({ scope, state: { after: { gross: 1, at: 1, fan: 1 }, loaded: 0 } })],
      ["a fan id that is not one", mintCursor({ scope, state: { after: { gross: "1", at: "1", fan: 0 }, loaded: 0 } })],
      ["a negative count", mintCursor({ scope, state: { after: { gross: "1", at: "1", fan: 1 }, loaded: -1 } })],
      ["another state altogether", mintCursor({ scope, state: "next" })],
      // Signed by this hub for this caller, with a state that is not sealed as the route seals it.
      ["a state in the clear", mintCursor({ scope, signed: (state) => state })],
      ["sealed with the ring's own key", mintCursor({ scope, signed: (state, ring) => encryptJson(state, ring.key, ring.keyVersion) })],
      ["sealed as another route seals", mintCursor({
        scope,
        signed: (state, ring) => encryptJson(state, subkeyOf(ring.key, "agency-hub:client-feed-cursor-seal:v1"), ring.keyVersion),
      })],
      ["sealed under a key version the ring does not hold", mintCursor({
        scope,
        signed: (state, ring) =>
          encryptJson(state, subkeyOf(ring.key, CLIENT_SPENDER_AWAITING_REPLY_CURSOR_SEAL_PURPOSE), ring.keyVersion + 98),
      })],
      ["a seal whose ciphertext was changed", mintCursor({
        scope,
        signed: (state, ring) => {
          const sealed = sealOf(state, ring);
          return { ...sealed, ciphertext: `${sealed.ciphertext[0] === "A" ? "B" : "A"}${sealed.ciphertext.slice(1)}` };
        },
      })],
      ["a seal with a key too many", mintCursor({ scope, signed: (state, ring) => ({ ...sealOf(state, ring), note: "x" }) })],
    ];
    for (const [label, value] of minted) {
      await refused(narrowToken, PAGE, value, label);
    }

    // None of it used the route's cursor up.
    expect(refs(await page(narrowToken, PAGE, cursorQuery(cursor, 1)))).toEqual(["1003"]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps a cursor good for an hour after its page: the hour bounds the gap between two pages, not the walk", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();
    const hour = CLIENT_SPENDER_AWAITING_REPLY_CURSOR_TTL_MS;
    const later = (ms: number) => new Date(NOW.getTime() + ms);

    const first = await page(narrowToken, PAGE, "limit=1");
    expect(refs(first)).toEqual(["1006"]);

    // To the millisecond.
    vi.setSystemTime(later(hour));
    const second = await page(narrowToken, PAGE, cursorQuery(first.nextCursor!, 1));
    expect(refs(second)).toEqual(["1003"]);
    vi.setSystemTime(later(hour + 1));
    expectCursorRefused(await queue(narrowToken, PAGE, cursorQuery(first.nextCursor!, 1)), "issued more than an hour ago");

    // Every page carries a newly issued cursor. Two hours after the walk began,
    // the cursor the second page carried is an hour old, and the walk goes on.
    vi.setSystemTime(later(2 * hour));
    const third = await page(narrowToken, PAGE, cursorQuery(second.nextCursor!, 1));
    expect(refs(third)).toEqual(["1001"]);
    expect(third).toMatchObject({ loaded: 3, nextCursor: null, asOf: later(2 * hour).toISOString() });
    vi.setSystemTime(later(2 * hour + 1));
    expectCursorRefused(await queue(narrowToken, PAGE, cursorQuery(second.nextCursor!, 1)), "the second page's cursor, an hour and a millisecond old");

    // After a refusal the client reads the first page again, and that walk's cursor is good.
    const restarted = await page(narrowToken, PAGE, "limit=1");
    expect(refs(restarted)).toEqual(["1006"]);
    expect(refs(await page(narrowToken, PAGE, cursorQuery(restarted.nextCursor!, 1)))).toEqual(["1003"]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("hands out a cursor its holder cannot read: no position, no count, no id of the hub's", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();

    // The cursor after F stands at F's place in the order: F's lifetime gross,
    // the microsecond of F's last message, and the hub's own id of F.
    const top = (await listPageSpenderAwaitingReply(app.db, { pageId: pageIds[PAGE]!, limit: 1 })).items[0]!;
    expect(top.fanRef).toBe("1006");
    const first = await page(narrowToken, PAGE, "limit=1");
    expect(refs(first)).toEqual(["1006"]);
    const held = readCursor(first.nextCursor!);

    // The token is the signed envelope, and what it signs is a seal: an
    // AES-256-GCM envelope and nothing beside it.
    expect(Object.keys(held.envelope).sort()).toEqual(["format", "keyVersion", "mac", "payload"]);
    expect(Object.keys(held.payload).sort()).toEqual(["iat", "st", "v"]);
    expect(Object.keys(held.state).sort()).toEqual(["alg", "ciphertext", "iv", "keyVersion", "tag"]);
    expect(held.state.alg).toBe("aes-256-gcm");
    // Nothing of the walk's state can be read off it: no field of the state
    // (as JSON spells one), no value of the position, and nothing of what the
    // cursor is bound to. Not in the token's text, and not in the bytes its
    // ciphertext decodes to.
    const sealedBytes = Buffer.from(String(held.state.ciphertext), "base64").toString("latin1");
    for (const secret of [
      ...["after", "gross", "at", "fan", "loaded", "pageId", "userId", "scope"].map((name) => JSON.stringify(name)),
      top.position.lifetimeGrossMills.toString(),
      top.position.lastFanMessageAtMicros.toString(),
    ]) {
      expect(held.text, secret).not.toContain(secret);
      expect(sealedBytes, secret).not.toContain(secret);
    }

    // The same place sealed twice is two different tokens, and both read the same page.
    const again = await page(narrowToken, PAGE, "limit=1");
    expect(again.nextCursor).not.toBe(first.nextCursor);
    expect(readCursor(again.nextCursor!).state.ciphertext).not.toBe(held.state.ciphertext);
    for (const cursor of [first.nextCursor!, again.nextCursor!]) {
      expect(refs(await page(narrowToken, PAGE, cursorQuery(cursor, 1)))).toEqual(["1003"]);
    }

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("checks the caller on every page of a walk, before it looks at the cursor", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();

    const first = await page(narrowToken, PAGE, "limit=1");
    const good = cursorQuery(first.nextCursor!, 1);
    const bad = cursorQuery("not-a-cursor", 1);

    // A chatter of another page: refused for the page, with a good cursor and
    // with a bad one alike, so a cursor tells a stranger nothing.
    for (const query of [good, bad]) {
      expectRefused(await queue(nikitaToken, PAGE, query), 409, "client_feature_disabled", "not_granted");
      expectRefused(
        await queue(narrowToken, PAGE, query, { clientVersion: "chatgoose-extension/2.7.1" }),
        409, "client_feature_disabled", "client_outdated",
      );
      expectRefused(await queue(narrowToken, "stats-fansly", query), 409, "client_feature_disabled", "platform_unsupported");
    }

    // The chatter loses the page in the middle of a walk: the cursor adds no right.
    await unassignPageFromUser(app, { userId: grishaId, pageLabel: PAGE }, AUDIT);
    for (const token of [narrowToken, fullToken]) {
      expectRefused(await queue(token, PAGE, good), 409, "client_feature_disabled", "not_granted");
    }
    await assignPageToUser(app, { userId: grishaId, pageLabel: PAGE }, AUDIT);
    expect(refs(await page(narrowToken, PAGE, good))).toEqual(["1003"]);

    // The owner switches Statistics off for this page only: it holds from the next page of the walk.
    await patchConfig([{
      key: "chatExtensionFeatures",
      value: JSON.stringify({ "*": { stats: true }, [PAGE]: { stats: false } }),
    }]);
    for (const query of [good, bad, ""]) {
      expectRefused(await queue(narrowToken, PAGE, query), 409, "client_feature_disabled", "flag_off");
    }
    expect((await page(ownerToken, "stats-other-of")).total).toBe(0);
    // And the master switch.
    await patchConfig([{ key: "chatExtensionEnabled", value: false }]);
    expectRefused(await queue(narrowToken, PAGE, good), 409, "client_feature_disabled", "disabled");
    expectRefused(await queue(ownerToken, "stats-other-of"), 409, "client_feature_disabled", "disabled");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("is refused where the feature is not available, with the reason", async (context) => {
    if (!server) return context.skip();

    // The extension is on, the `stats` flag is not.
    await patchConfig([{ key: "chatExtensionEnabled", value: true }]);
    expectRefused(await queue(narrowToken, PAGE), 409, "client_feature_disabled", "flag_off");

    await patchConfig([
      { key: "chatExtensionFeatures", value: JSON.stringify({ "*": { stats: true } }) },
      { key: "chatExtensionMinVersion", value: "1.2.0" },
    ]);
    expect((await queue(narrowToken, PAGE, "", { clientVersion: "chat-extension/1.2.0" })).statusCode).toBe(200);
    // The feature exists on OnlyFans only; a page the extension cannot bind has no use for it.
    expectRefused(await queue(narrowToken, "stats-fansly"), 409, "client_feature_disabled", "platform_unsupported");
    expectRefused(await queue(narrowToken, "nova-of"), 409, "client_feature_disabled", "binding_missing");
    for (const clientVersion of ["chat-extension/1.1.9", "chatgoose-extension/2.7.1", "0.1.64", "chat-extension/1.2", null]) {
      expectRefused(await queue(narrowToken, PAGE, "", { clientVersion }), 409, "client_feature_disabled", "client_outdated");
    }

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses a query that is not the client's: the validation envelope, no reason", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();

    for (const query of [
      "limit=0",
      "limit=101",
      "limit=-1",
      "limit=1.5",
      "limit=ten",
      "limit=",
      "cursor=",
      `cursor=${"A".repeat(2049)}`,
      // The page is the path's; a page, an instant or an offset in the query is refused, not ignored.
      "pageLabel=stats-other-of",
      "asOf=2026-01-01T00:00:00Z",
      "offset=50",
      "timeZone=UTC",
    ]) {
      const response = await queue(narrowToken, PAGE, query);
      expect(response.statusCode, `${query}: ${response.body}`).toBe(400);
      const error = errorResponseSchema.parse(response.json());
      expect(error.reason, query).toBeUndefined();
    }
    // The bounds themselves are taken.
    expect((await page(narrowToken, PAGE, "limit=1")).items).toHaveLength(1);
    expect((await page(narrowToken, PAGE, "limit=100")).items).toHaveLength(3);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("does not serve a row an installed client would refuse, counts it, and walks past it", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();
    const warn = vi.spyOn(app.logger, "warn");

    // The biggest spender of the page has a stored fan id that is not a platform
    // number. The client's schema would refuse it, and the whole page with it.
    const odd = await seedGrantedPage("stats-odd-of", "100000008");
    const fans: Record<string, number> = {};
    for (const [ref, gross] of [["of-user-x", 50_000n], ["9101", 40_000n], ["9102", 30_000n]] as const) {
      const fanId = await fixture.seedFan(odd.id, ref);
      fans[ref] = fanId;
      await fixture.addTransaction(odd.id, { fanId, type: "tip", gross, at: "2026-08-01T10:00:00Z" });
      await fixture.addThread(odd.id, { fanId, conversationRef: ref, unreadCount: 1, lastFanMessageAt: "2026-10-01T10:00:00Z" });
    }
    await fixture.rebuildAll(odd.id);
    await rearmTrap();

    // The queue counts the payer (the statistics count it too); the rows are the two a client can open.
    const whole = await page(narrowToken, "stats-odd-of");
    expect(refs(whole)).toEqual(["9101", "9102"]);
    expect(whole).toMatchObject({ total: 3, loaded: 2, unknown: 0, nextCursor: null });
    // Said in the log, by the hub's own ids only.
    expect(warn).toHaveBeenCalledWith(
      { pageId: odd.id, fanId: fans["of-user-x"] },
      "awaiting-reply queue: a row the client cannot take was not served",
    );

    // A page of one row that is that row is empty and still goes on: the walk passes it.
    const first = await page(narrowToken, "stats-odd-of", "limit=1");
    expect(first).toMatchObject({ items: [], total: 3, loaded: 0 });
    expect(first.nextCursor).not.toBeNull();
    const second = await page(narrowToken, "stats-odd-of", cursorQuery(first.nextCursor!, 1));
    expect(second).toMatchObject({ items: [{ fanRef: "9101" }], loaded: 1 });
    expect(await page(narrowToken, "stats-odd-of", cursorQuery(second.nextCursor!, 1)))
      .toMatchObject({ items: [{ fanRef: "9102" }], loaded: 2, nextCursor: null });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("holds its rights-matrix row in both auth-policy modes: device tokens on a granted page only", async (context) => {
    if (!server || !enforceServer) return context.skip();
    await switchStatsOn();

    const leadCookie = await loginCookie("lead");
    const chatterCookie = await loginCookie("grisha");

    interface Refusal { status: number; error: string; reason?: string }
    const notGranted = (enforce: Refusal) => ({
      log: { status: 409, error: "client_feature_disabled", reason: "not_granted" },
      enforce,
    });
    const cases: Array<{
      who: string;
      page: string;
      headers: Record<string, string>;
      /** 200, or the refusal; where the two layers answer differently, one per mode. */
      expected: 200 | Refusal | { log: Refusal; enforce: Refusal };
    }> = [
      { who: "anonymous", page: PAGE, headers: {}, expected: { status: 401, error: "unauthorized" } },
      {
        who: "unknown bearer", page: PAGE,
        headers: { authorization: "Bearer agency_hub_device_not-a-real-token" },
        expected: { status: 401, error: "unauthorized" },
      },
      { who: "owner cookie", page: PAGE, headers: { cookie: ownerCookie }, expected: { status: 403, error: "forbidden" } },
      { who: "team_lead cookie", page: PAGE, headers: { cookie: leadCookie }, expected: { status: 403, error: "forbidden" } },
      { who: "chatter cookie", page: PAGE, headers: { cookie: chatterCookie }, expected: { status: 403, error: "forbidden" } },
      // Live and granted the page: refused by kind, before any page is looked at.
      {
        who: "agent key", page: PAGE,
        headers: { authorization: `Bearer ${AGENT_KEY_TOKEN}` },
        expected: { status: 403, error: "forbidden" },
      },
      { who: "owner device token", page: "stats-other-of", headers: { authorization: `Bearer ${ownerToken}` }, expected: 200 },
      { who: "team_lead device token", page: PAGE, headers: { authorization: `Bearer ${leadToken}` }, expected: 200 },
      { who: "chatter narrow token", page: PAGE, headers: { authorization: `Bearer ${narrowToken}` }, expected: 200 },
      { who: "chatter full token", page: PAGE, headers: { authorization: `Bearer ${fullToken}` }, expected: 200 },
      // A page of someone else, a tombstone and a page that never existed: the
      // handler's own guard answers all three alike and reveals nothing; the
      // declared policy answers 403 / 404 before the handler runs.
      {
        who: "chatter, a page not granted", page: "stats-other-of",
        headers: { authorization: `Bearer ${narrowToken}` },
        expected: notGranted({ status: 403, error: "forbidden" }),
      },
      {
        who: "team_lead, a page not granted", page: "stats-other-of",
        headers: { authorization: `Bearer ${leadToken}` },
        expected: notGranted({ status: 403, error: "forbidden" }),
      },
      {
        who: "chatter, a tombstoned page", page: "stats-old-of",
        headers: { authorization: `Bearer ${narrowToken}` },
        expected: notGranted({ status: 404, error: "not_found" }),
      },
      {
        who: "chatter, a page that does not exist", page: "ghost-of",
        headers: { authorization: `Bearer ${narrowToken}` },
        expected: notGranted({ status: 404, error: "not_found" }),
      },
    ];

    for (const [mode, via] of [["log", server], ["enforce", enforceServer]] as const) {
      for (const testCase of cases) {
        const label = `${mode} mode, ${testCase.who}`;
        const response = await via.inject({
          method: "GET",
          url: queueUrl(testCase.page, "limit=1"),
          headers: { "x-client-version": EXTENSION_VERSION, ...testCase.headers },
        });
        if (testCase.expected === 200) {
          expect(response.statusCode, `${label}: ${response.body}`).toBe(200);
          frozenClientSpenderAwaitingReplySchema.parse(response.json());
          continue;
        }
        const expected = "log" in testCase.expected ? testCase.expected[mode] : testCase.expected;
        expect(response.statusCode, `${label}: ${response.body}`).toBe(expected.status);
        // Every refusal is the declared error body, so the SDK raises a typed error.
        const error = errorResponseSchema.parse(response.json());
        expect(error, label).toMatchObject({ error: expected.error, statusCode: expected.status });
        expect(error.reason, label).toBe(expected.reason);
      }
    }

    // A walk begun on one instance goes on on another: both hold the same keys,
    // and a cursor names no instance.
    const first = await page(narrowToken, PAGE, "limit=1");
    const next = await queue(narrowToken, PAGE, cursorQuery(first.nextCursor!, 1), { via: enforceServer });
    expect(next.statusCode, next.body).toBe(200);
    expect(refs(frozenClientSpenderAwaitingReplySchema.parse(next.json()) as ClientSpenderAwaitingReplyResponse))
      .toEqual(["1003"]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
