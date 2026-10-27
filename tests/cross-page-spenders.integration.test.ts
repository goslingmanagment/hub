import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { agentCrossSpendersResponseSchema, type AgentCrossSpendersResponse } from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertAgentKey,
  listAgentGrantPages,
  type AgentGrantPage,
  type Database,
} from "@agency_hub_core/db";
import { millsFromDollars, sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  CrossPageSourceRefusal,
  readCrossPageSpenders,
  resolveCrossPageSources,
  type CrossPageSourceSelection,
} from "../apps/runtime/src/services/cross-page-spenders.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/**
 * Cross-page spenders against a real database: the fans of a target page's
 * audience who paid the model's other pages (the set a mass message of the
 * target leaves out).
 *
 *  - the audience filter (followers, subscribers, any), a fan outside it never;
 *  - the default sources are the target model's other pages on its platform,
 *    `all` every other page of the platform, a list exactly those pages;
 *  - the thresholds: at least the minimum over the sources, at most the cap on
 *    the target (default 0: never paid it), no cap;
 *  - a source on another platform or the target itself is refused;
 *  - the route: the strict contract, read:money, the grant's 404, the 400s,
 *    and a keyset walk that adds up to the one-call set.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MONEY = `${AGENT_KEY_TOKEN_PREFIX}cross-spenders-money-token`;
const NO_MONEY = `${AGENT_KEY_TOKEN_PREFIX}cross-spenders-datasets-token`;

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let pages: AgentGrantPage[] = [];
const page = (label: string) => pages.find((candidate) => candidate.pageLabel === label)!;
const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const dollars = (value: number) => millsFromDollars(value);

async function fan(ref: string, input: {
  platform?: "fansly" | "onlyfans";
  on?: { page: string; follower?: boolean; subscriber?: boolean; missAt?: string };
  paid?: Record<string, number>;
}): Promise<number> {
  const id = Number((await q(
    "insert into fans (platform, platform_user_id, username, display_name, first_seen_at) values ($1, $2, $3, $4, '2026-01-01T00:00:00Z') returning id",
    [input.platform ?? "fansly", ref, `fan${ref}`, `Fan ${ref}`],
  )).rows[0].id);
  if (input.on) {
    const follower = input.on.follower ?? false;
    const subscriber = input.on.subscriber ?? false;
    await q(
      `insert into page_fans (fan_id, platform_account_id, is_follower, follower_since, is_subscriber, subscription_expires_at,
         account_probe_at, account_probe_resolved)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id, page(input.on.page).id,
        follower, follower ? "2026-03-01T00:00:00Z" : null,
        subscriber, subscriber ? "2026-11-30T00:00:00Z" : null,
        input.on.missAt ?? null, input.on.missAt === undefined ? null : false,
      ],
    );
  }
  for (const [label, amount] of Object.entries(input.paid ?? {})) {
    await q(
      `insert into fan_spend_lifetime (platform_account_id, fan_id, gross_amount_mills, creator_net_amount_mills, last_transaction_at)
       values ($1, $2, $3, $3, '2026-10-01T12:00:00Z')`,
      [page(label).id, id, dollars(amount).toString()],
    );
  }
  return id;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  const db = testDb.db as unknown as Database;
  const lora = (await createModel(db, { slug: "lora", name: "Lora" }))!;
  const ari = (await createModel(db, { slug: "ari", name: "Ari" }))!;
  for (const label of ["lora-1", "lora-2", "lora-3"]) await createFanslyPage(db, { modelId: lora.id, label });
  await createFanslyPage(db, { modelId: ari.id, label: "ari-1" });
  for (const label of ["lora-of", "lora-vip-of"]) await createOnlyFansPage(db, { modelId: lora.id, label });
  pages = await listAgentGrantPages(db, (await q("select id from pages")).rows.map((row) => Number(row.id)));

  // The target lora-1's audience.
  const first = await fan("100000000000000001", { on: { page: "lora-1", follower: true }, paid: { "lora-2": 30 } });
  await fan("100000000000000002", { on: { page: "lora-1", follower: true }, paid: { "lora-2": 10, "lora-3": 5 } });
  await fan("100000000000000003", { on: { page: "lora-1", follower: true }, paid: { "lora-2": 50, "lora-1": 10 } });
  await fan("100000000000000004", { on: { page: "lora-1", subscriber: true }, paid: { "lora-2": 40 } });
  // Known to lora-1, in its audience no more.
  await fan("100000000000000005", { on: { page: "lora-1" }, paid: { "lora-2": 100 } });
  // Paid another model's page only.
  await fan("100000000000000006", { on: { page: "lora-1", follower: true }, paid: { "ari-1": 70 } });
  // Never paid anyone.
  await fan("100000000000000007", { on: { page: "lora-1", follower: true } });
  // Blocked lora-1 by its last account answer: kept, the miss exposed.
  await fan("100000000000000008", {
    on: { page: "lora-1", follower: true, missAt: "2026-10-20T08:00:00Z" },
    paid: { "lora-3": 8 },
  });
  // An OnlyFans fan with the same native id: another person, another platform.
  await fan("100000000000000001", {
    platform: "onlyfans",
    on: { page: "lora-of", subscriber: true },
    paid: { "lora-vip-of": 500 },
  });

  // Freshness: lora-1's audience walks, lora-2's ledger (lora-3 stores none).
  await q("update pages set last_follower_sync_at = '2026-10-27T22:18:16Z' where id = $1", [page("lora-1").id]);
  await q(
    `insert into sync_work (page_id, resource, kind, class, state, closed_at, close_reason)
     values ($1, 'followers.reconcile', 'goal', 'planned', 'done', '2026-10-27T10:50:23Z', 'reconcile_certified'),
            ($1, 'followers.reconcile', 'goal', 'planned', 'done', '2026-10-27T12:03:29Z', 'reconcile_withheld')`,
    [page("lora-1").id],
  );
  await q(
    `insert into sync_work (page_id, resource, kind, class, proof)
     values ($1, 'subscribers.poll', 'poll', 'planned',
       '{"mode": "active", "completedAt": "2026-10-27T22:37:39.930Z", "destructiveFinalization": true}'::jsonb)`,
    [page("lora-1").id],
  );
  await q(
    `insert into page_sync_cursors (page_id, stream, state)
     values ($1, 'subscribers', '{"mode": "ofapi_audience", "lastSweepCompletedAt": "2026-10-27T04:06:53.357Z", "lastSweepUnverifiedAt": null}'::jsonb)`,
    [page("lora-of").id],
  );
  await q(
    `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state,
       raw_status, gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills,
       occurred_at, source, currency)
     values ($1, $2, 'tx-floor', 'tip', 'tip', 'posted', 'ok', 1000, 1000, 800, 200, '2025-02-12T21:33:22Z', 'fansly:rest', 'USD')`,
    [page("lora-2").id, first],
  );

  const appContext = createTestAppContext(testDb);
  const owner = await createUserAccount(appContext, { username: "owner", role: "owner", password: "owner-secret" }, { source: "cli" });
  const granted = ["lora-1", "lora-2", "lora-3", "ari-1", "lora-of"].map((label) => page(label).id);
  for (const [token, capabilities] of [[MONEY, ["read:datasets", "read:money"]], [NO_MONEY, ["read:datasets"]]] as const) {
    await insertAgentKey(testDb.db, {
      name: token.slice(AGENT_KEY_TOKEN_PREFIX.length),
      keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(token),
      capabilities: capabilities as never,
      pageIds: granted,
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      createdBy: owner!.id,
    });
  }
  server = await buildApiServer(appContext);
  await server.ready();
}, 180_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

async function set(input: {
  target?: string;
  sources?: CrossPageSourceSelection;
  audience?: "followers" | "subscribers" | "any";
  min?: number;
  max?: number | null;
}) {
  const target = page(input.target ?? "lora-1");
  const sources = resolveCrossPageSources({ target, candidates: pages, sources: input.sources ?? "model" });
  return readCrossPageSpenders(testDb!.db as unknown as Database, {
    target,
    sources,
    audience: input.audience ?? "any",
    minSourceSpendMills: input.min === undefined ? 1n : dollars(input.min),
    maxTargetSpendMills: input.max === undefined ? 0n : input.max === null ? null : dollars(input.max),
  });
}
const refs = (result: Awaited<ReturnType<typeof set>>) => result.fans.map((entry) => entry.platformUserId.slice(-1));

describe("cross-page spenders: the selection rules", () => {
  it("defaults: the audience's fans who paid the model's other pages and never the target, largest first", async (context) => {
    if (!testDb) return context.skip();
    const result = await set({});
    expect(result.input.sources.map((source) => source.pageLabel)).toEqual(["lora-2", "lora-3"]);
    expect(refs(result)).toEqual(["4", "1", "2", "8"]);
    const two = result.fans.find((entry) => entry.platformUserId.endsWith("2"))!;
    expect(two.sourceSpendMills).toBe(15_000n);
    expect(two.targetSpendMills).toBe(0n);
    expect(two.sources.map((source) => [source.page.pageLabel, source.grossMills])).toEqual([["lora-2", 10_000n], ["lora-3", 5_000n]]);
    expect(result.fans.find((entry) => entry.platformUserId.endsWith("8"))!.accountLookupMissAt?.toISOString())
      .toBe("2026-10-20T08:00:00.000Z");
    expect(result.perSource.map((source) => [source.page.pageLabel, source.fans, source.grossMills])).toEqual([
      ["lora-2", 3, 80_000n],
      ["lora-3", 2, 13_000n],
    ]);
  });

  it("the audience filter: followers, subscribers, any", async (context) => {
    if (!testDb) return context.skip();
    expect(refs(await set({ audience: "followers" }))).toEqual(["1", "2", "8"]);
    expect(refs(await set({ audience: "subscribers" }))).toEqual(["4"]);
  });

  it("the thresholds: the minimum over the sources, the cap on the target, no cap", async (context) => {
    if (!testDb) return context.skip();
    expect(refs(await set({ min: 20 }))).toEqual(["4", "1"]);
    expect(refs(await set({ min: 15 }))).toEqual(["4", "1", "2"]);
    expect(refs(await set({ max: null }))).toEqual(["3", "4", "1", "2", "8"]);
    expect(refs(await set({ max: 9.999 }))).toEqual(["4", "1", "2", "8"]);
    expect(refs(await set({ max: 10 }))).toEqual(["3", "4", "1", "2", "8"]);
    expect((await set({ max: null })).fans[0]!.targetSpendMills).toBe(10_000n);
  });

  it("the sources: all of the platform, a list, never the target, never another platform", async (context) => {
    if (!testDb) return context.skip();
    const all = await set({ sources: "all" });
    expect(all.input.sources.map((source) => source.pageLabel)).toEqual(["ari-1", "lora-2", "lora-3"]);
    expect(refs(all)).toEqual(["6", "4", "1", "2", "8"]);
    expect(refs(await set({ sources: ["ari-1"] }))).toEqual(["6"]);
    expect(refs(await set({ sources: ["lora-3", "lora-3"] }))).toEqual(["8", "2"]);
    const refusal = (sources: CrossPageSourceSelection) => {
      try {
        resolveCrossPageSources({ target: page("lora-1"), candidates: pages, sources });
        return null;
      } catch (error) {
        return error instanceof CrossPageSourceRefusal ? error.reason : error;
      }
    };
    expect(refusal(["lora-of"])).toBe("other_platform");
    expect(refusal(["lora-1"])).toBe("target_page");
    expect(refusal(["no-such-page"])).toBe("unknown_page");
  });

  it("one platform: an OnlyFans target reads its own model's OnlyFans pages only", async (context) => {
    if (!testDb) return context.skip();
    const result = await set({ target: "lora-of" });
    expect(result.input.sources.map((source) => source.pageLabel)).toEqual(["lora-vip-of"]);
    expect(result.fans.map((entry) => [entry.platformUserId, entry.sourceSpendMills])).toEqual([["100000000000000001", 500_000n]]);
    expect(result.audience.subscribersWalkedAt?.toISOString()).toBe("2026-10-27T04:06:53.357Z");
    expect(result.audience.newFollowersReadAt).toBeNull();
  });

  it("freshness: the target's audience walks and each source's transactions floor", async (context) => {
    if (!testDb) return context.skip();
    const result = await set({});
    expect(result.audience.newFollowersReadAt?.toISOString()).toBe("2026-10-27T22:18:16.000Z");
    expect(result.audience.followersWalkedAt?.toISOString()).toBe("2026-10-27T10:50:23.000Z");
    expect(result.audience.subscribersWalkedAt?.toISOString()).toBe("2026-10-27T22:37:39.930Z");
    expect(result.perSource.map((source) => [source.page.pageLabel, source.transactionsFloorAt?.toISOString() ?? null])).toEqual([
      ["lora-2", "2025-02-12T21:33:22.000Z"],
      ["lora-3", null],
    ]);
    // lora-3 stores no transaction: the scope's floor is unknown.
    expect(result.transactionsFloorAt).toBeNull();
    expect((await set({ sources: ["lora-2"] })).transactionsFloorAt?.toISOString()).toBe("2025-02-12T21:33:22.000Z");
  });
});

function read(pageLabel: string, query = "", token = MONEY) {
  return server!.inject({
    method: "GET",
    url: `/api/v1/agent/pages/${pageLabel}/cross-spenders${query === "" ? "" : `?${query}`}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function answer(pageLabel: string, query = ""): Promise<AgentCrossSpendersResponse> {
  const response = await read(pageLabel, query);
  expect(response.statusCode, response.body).toBe(200);
  return agentCrossSpendersResponseSchema.parse(response.json());
}

describe("agentCrossSpenders over HTTP", () => {
  it("answers the strict contract: the set, its summary and its freshness", async (context) => {
    if (!testDb) return context.skip();
    const body = await answer("lora-1");
    expect(body.scope).toEqual({
      pageLabel: "lora-1",
      platform: "fansly",
      audience: "any",
      sourceSelection: "model",
      sourcePages: ["lora-2", "lora-3"],
      minSourceSpendMills: 1,
      maxTargetSpendMills: 0,
    });
    expect(body.items.map((item) => [item.platformUserId.slice(-1), item.sourceSpendMills])).toEqual([
      ["4", 40_000], ["1", 30_000], ["2", 15_000], ["8", 8_000],
    ]);
    expect(body.summary.qualifying).toBe(4);
    expect(body.summary.sources).toEqual([
      { pageLabel: "lora-2", fans: 3, grossMills: 80_000, transactionsFloorAt: "2025-02-12T21:33:22.000Z" },
      { pageLabel: "lora-3", fans: 2, grossMills: 13_000, transactionsFloorAt: null },
    ]);
    expect(body.summary.audience.followersWalkedAt).toBe("2026-10-27T10:50:23.000Z");
    expect(body.delivery).toMatchObject({ returned: 4, nextCursor: null, snapshotExhausted: true });
    expect(body.conclusion.blockers).toContain("capture_floor_unknown");
    expect(body.conclusion.blockers).toContain("key_grant_narrowed_scope");
    expect(body.conclusion.blockers).not.toContain("delivery_not_exhausted");
  });

  it("takes the selection on the wire: min, no cap, followers, a listed source", async (context) => {
    if (!testDb) return context.skip();
    expect((await answer("lora-1", "minSourceSpendMills=20000")).summary.qualifying).toBe(2);
    const any = await answer("lora-1", "maxTargetSpendMills=any&audience=followers");
    expect(any.scope.maxTargetSpendMills).toBeNull();
    expect(any.items.map((item) => item.platformUserId.slice(-1))).toEqual(["3", "1", "2", "8"]);
    const listed = await answer("lora-1", "sources=ari-1");
    expect(listed.scope).toMatchObject({ sourceSelection: "listed", sourcePages: ["ari-1"] });
    expect(listed.items.map((item) => item.platformUserId.slice(-1))).toEqual(["6"]);
    expect((await answer("lora-1", "sources=all")).scope.sourcePages).toEqual(["ari-1", "lora-2", "lora-3"]);
  });

  it("a keyset walk adds up to the one-call set, and a cursor pins its scope", async (context) => {
    if (!testDb) return context.skip();
    const whole = await answer("lora-1");
    const first = await answer("lora-1", "limit=3");
    expect(first.items).toHaveLength(3);
    expect(first.delivery.nextCursor).not.toBeNull();
    expect(first.delivery.cappedBy).toBe("limit");
    expect(first.conclusion.blockers).toContain("delivery_not_exhausted");
    const cursor = encodeURIComponent(first.delivery.nextCursor!);
    const second = await answer("lora-1", `cursor=${cursor}`);
    expect([...first.items, ...second.items]).toEqual(whole.items);
    expect(second.delivery.nextCursor).toBeNull();
    expect(second.summary.qualifying).toBe(4);
    expect((await read("lora-1", `cursor=${cursor}&audience=followers`)).statusCode).toBe(400);
  });

  it("refuses: read:money, the grant's 404, another platform's or the target's own page", async (context) => {
    if (!testDb) return context.skip();
    const noMoney = await read("lora-1", "", NO_MONEY);
    expect(noMoney.statusCode).toBe(403);
    expect(noMoney.json()).toMatchObject({ error: "agent_capability_missing" });
    const hidden = await read("lora-vip-of");
    const missing = await read("no-such-page-at-all");
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).toBe(missing.body);
    expect((await read("lora-1", "sources=lora-vip-of")).body).toBe(missing.body);
    expect((await read("lora-1", "sources=lora-of")).statusCode).toBe(400);
    expect((await read("lora-1", "sources=lora-1")).statusCode).toBe(400);
    expect((await read("lora-1", "sources=all&sources=lora-2")).statusCode).toBe(400);
    expect((await read("lora-1", "minSourceSpendMills=0")).statusCode).toBe(400);
  });
});
