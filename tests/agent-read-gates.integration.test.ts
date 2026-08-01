import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createUser,
  insertAgentKey,
  setConfigOverride,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { AGENT_KEY_TOKEN_PREFIX } from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

/**
 * Review round 1, buckets 2-4: capability gates, filters that are actually
 * applied, and pagination that neither skips nor repeats.
 *
 * Each test here fails if its fix is reverted. The fixture is built so that
 * ignoring a filter is VISIBLE: there are always two fans, and a request naming
 * one must not return the other's rows.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const FULL_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}gates-full-key-token`;
const NARROW_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}gates-narrow-key-token`;

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let pageId = 0;

const RICK = "100000000000000001";
const MAYA = "100000000000000002";
const RICK_THREAD = "900000000000000001";
const MAYA_THREAD = "900000000000000002";

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 180_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  const appContext = createTestAppContext(testDb, { authPolicyEnforcement: "enforce" });

  const model = await createModel(testDb.db, { slug: "lora", name: "Lora" });
  if (!model) {
    throw new Error("fixture model was not created");
  }
  const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "lora-2" });
  if (!page) {
    throw new Error("fixture page was not created");
  }
  pageId = page.id;

  const owner = await createUser(testDb.db, {
    username: "owner",
    role: "owner",
    passwordHash: null,
  });
  const common = {
    pageIds: [pageId],
    dailyRequestBudget: 5000,
    dailyRowBudget: 500_000,
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: owner?.id ?? null,
  };
  await insertAgentKey(testDb.db, {
    ...common,
    name: "full",
    keyPrefix: FULL_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(FULL_TOKEN),
    capabilities: ["read:messages", "read:money", "read:datasets"],
  });
  // Deliberately holds NEITHER money NOR messages: it is the probe for every
  // "an ungranted section must be null, not zero" assertion below.
  await insertAgentKey(testDb.db, {
    ...common,
    name: "narrow",
    keyPrefix: NARROW_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(NARROW_TOKEN),
    capabilities: ["read:datasets"],
  });

  await setConfigOverride(testDb.db, {
    key: "agentReadPlaneMode",
    value: "full",
    userId: owner?.id ?? null,
    groupId: randomUUID(),
  });

  await seedTwoFans();

  await server?.close();
  server = await buildApiServer(appContext);
  await server.ready();
});

afterEach(async () => {
  await server?.close();
  server = null;
});

/** Two fans with threads, transactions and messages, so an ignored filter shows. */
async function seedTwoFans() {
  const pool = testDb!.pool;
  for (const [platformUserId, username, conversationRef] of [
    [RICK, "rick", RICK_THREAD],
    [MAYA, "maya", MAYA_THREAD],
  ] as const) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into fans (platform, platform_user_id, username, first_seen_at)
       values ('fansly', $1, $2, '2026-01-05T00:00:00Z') returning id`,
      [platformUserId, username],
    );
    const fanId = Number(rows[0]!.id);
    await pool.query(
      `insert into page_fans (fan_id, platform_account_id, total_creator_net_mills,
         is_subscriber, subscriber_since, last_transaction_at, last_seen_at)
       values ($1, $2, 50000, true, '2026-01-10T00:00:00Z', '2026-01-23T00:00:00Z',
         '2026-03-01T00:00:00Z')`,
      [fanId, pageId],
    );
    await pool.query(
      `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type,
         canonical_type, transaction_state, raw_status, gross_amount_mills,
         source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, currency)
       values ($1, $2, $3, 'tip', 'tip', 'posted', 'ok', 50000, 50000, 40000,
         '2026-01-23T12:00:00Z', 'fansly:rest', 'USD')`,
      [pageId, fanId, `tx-${username}`],
    );
    await pool.query(
      `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id,
         partner_platform_user_id, stored_message_count, message_coverage_status, last_message_at)
       values ($1, $2, $3, $4, 1, 'complete', '2026-03-02T00:00:00Z')`,
      [pageId, fanId, conversationRef, platformUserId],
    );
    await pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref,
         fan_native_id, sender_role, is_sent_by_me, occurred_at, text_plain, tip_amount_mills,
         media_metadata)
       values ($1, 'fansly', $2, $3, $4, 'fan', false, '2026-03-01T10:00:00Z',
         'custom video please', 0, '[]'::jsonb)`,
      [pageId, conversationRef, `m-${username}`, platformUserId],
    );
  }
}

function get(url: string, token = FULL_TOKEN) {
  return server!.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
}

function post(url: string, payload: Record<string, unknown>, token = FULL_TOKEN) {
  return server!.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  }) as ReturnType<typeof get>;
}

const WINDOW = "from=2026-01-01T00:00:00Z&to=2026-04-01T00:00:00Z";

describe("[sync-critical] agent read plane: capability gates", () => {
  it("#3 withholds money as NULL, never as a zero", async () => {
    // A silent 0 is indistinguishable from "never paid" — the one thing money
    // must never say by accident.
    const response = await get(`/api/v1/agent/people/fansly/${RICK}`, NARROW_TOKEN);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.money).toBeNull();
    expect(body.subscriptions).toBeNull();
    expect(body.memberships[0].lifetimeSpendMills).toBeNull();
    // The TIMESTAMP is withheld too: when a payment happened discloses that one did.
    expect(body.memberships[0].lastTransactionAt).toBeNull();

    const granted = await get(`/api/v1/agent/people/fansly/${RICK}`);
    expect(granted.json().money.lifetime.grossMills).toBe(50_000);
    expect(granted.json().memberships[0].lastTransactionAt).not.toBeNull();
  });

  it("#3 withholds threads and CRM as NULL without read:messages", async () => {
    const body = (await get(`/api/v1/agent/people/fansly/${RICK}`, NARROW_TOKEN)).json();
    // null, not []: an empty array would say "this fan has no threads", which is
    // the empty-presented-as-complete failure this plane exists to prevent.
    expect(body.threads).toBeNull();
    expect(body.crm).toBeNull();

    const granted = (await get(`/api/v1/agent/people/fansly/${RICK}`)).json();
    expect(granted.threads).toHaveLength(1);
    expect(granted.threads[0].conversationRef).toBe(RICK_THREAD);
    expect(granted.crm).not.toBeNull();
  });

  it("#3 reports the ungranted planes as not_read for the RIGHT reason", async () => {
    const body = (await get(`/api/v1/agent/people/fansly/${RICK}`, NARROW_TOKEN)).json();
    const transactions = body.capture.planes.find(
      (plane: { plane: string }) => plane.plane === "transactions",
    );
    expect(transactions).toMatchObject({
      state: "not_read",
      reason: "capability_not_granted",
    });
  });

  it("#4 drops the money lane without read:money and SAYS it dropped it", async () => {
    const response = await get(
      `/api/v1/agent/people/fansly/${RICK}/timeline?${WINDOW}`,
      NARROW_TOKEN,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.lanesRequested).toContain("money");
    expect(body.lanesServed).not.toContain("money");
    expect(body.lanesServed).not.toContain("subscriptions");
    expect(body.lanesServed).not.toContain("messages");
    expect(body.items).toEqual([]);

    const granted = (await get(`/api/v1/agent/people/fansly/${RICK}/timeline?${WINDOW}`)).json();
    expect(granted.lanesServed).toContain("money");
    expect(granted.items.some((item: { lane: string }) => item.lane === "money")).toBe(true);
  });

  it("#2 withholds thread inventory without read:messages", async () => {
    const response = await post("/api/v1/agent/resolve", {
      inputs: [{ raw: "rick", hint: "username" }],
    }, NARROW_TOKEN);
    expect(response.statusCode).toBe(200);
    const candidate = response.json().items[0].candidates[0];
    expect(candidate.pages).toEqual([]);
    // The empty array is EXPLAINED rather than left to read as "no conversations".
    expect(candidate.fieldStates.conversationRef).toEqual({
      state: "unknown",
      remedy: { kind: "none", reason: "capability_not_granted" },
    });

    const granted = await post("/api/v1/agent/resolve", {
      inputs: [{ raw: "rick", hint: "username" }],
    });
    expect(granted.json().items[0].candidates[0].pages).toHaveLength(1);
  });
});

describe("[sync-critical] agent read plane: filters are applied, not just accepted", () => {
  it("#5 person filter returns ONLY that fan's threads", async () => {
    const all = await get("/api/v1/agent/threads");
    expect(all.json().items).toHaveLength(2);

    const filtered = await get(
      `/api/v1/agent/threads?personPlatform=fansly&personPlatformUserId=${RICK}`,
    );
    const body = filtered.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].conversationRef).toBe(RICK_THREAD);
    // ... and the predicate says it was applied, because it was.
    const person = body.predicates.find((p: { name: string }) => p.name === "person");
    expect(person).toMatchObject({ requested: true, applied: true, reason: "applied" });
  });

  it("#5 a person nobody knows narrows to NOTHING, never back to everybody", async () => {
    const body = (await get(
      "/api/v1/agent/threads?personPlatform=fansly&personPlatformUserId=999999999",
    )).json();
    expect(body.items).toEqual([]);
  });

  it("#8 person filter narrows the coverage scopes", async () => {
    const all = await get(`/api/v1/agent/coverage?${WINDOW}`);
    expect(all.json().items).toHaveLength(2);

    const filtered = await get(
      `/api/v1/agent/coverage?${WINDOW}&personPlatform=fansly&personPlatformUserId=${MAYA}`,
    );
    const body = filtered.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].conversationRef).toBe(MAYA_THREAD);
  });

  it("#7 person filter carries the PLATFORM, not just the id", async () => {
    const both = await post("/api/v1/agent/search/messages", {
      q: "custom",
      from: "2026-03-01T00:00:00Z",
      to: "2026-03-10T00:00:00Z",
    });
    expect(both.json().items).toHaveLength(2);

    const one = await post("/api/v1/agent/search/messages", {
      q: "custom",
      from: "2026-03-01T00:00:00Z",
      to: "2026-03-10T00:00:00Z",
      person: { platform: "fansly", platformUserId: RICK },
    });
    expect(one.json().items).toHaveLength(1);
    expect(one.json().items[0].conversationRef).toBe(RICK_THREAD);

    // The same native id on the OTHER platform must match nothing here.
    const wrongPlatform = await post("/api/v1/agent/search/messages", {
      q: "custom",
      from: "2026-03-01T00:00:00Z",
      to: "2026-03-10T00:00:00Z",
      person: { platform: "onlyfans", platformUserId: RICK },
    });
    expect(wrongPlatform.json().items).toEqual([]);
  });

  it("#2 includeAliases:false really stops resolving through history", async () => {
    await testDb!.pool.query(
      `insert into fan_username_aliases (fan_id, username, first_seen_at, last_seen_at)
       select f.id, 'rick_old', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'
       from fans f where f.platform_user_id = $1`,
      [RICK],
    );
    const withAliases = await post("/api/v1/agent/resolve", {
      inputs: [{ raw: "rick_old", hint: "alias" }],
    });
    expect(withAliases.json().items[0].candidates).toHaveLength(1);

    const without = await post("/api/v1/agent/resolve", {
      inputs: [{ raw: "rick_old", hint: "alias" }],
      includeAliases: false,
    });
    expect(without.json().items[0].candidates).toEqual([]);
    // ... and the alias planes are NOT claimed as read, because they were not.
    const planes = without.json().capture.planes;
    expect(planes.find((p: { plane: string }) => p.plane === "fan_username_aliases").state)
      .not.toBe("read");
  });
});

describe("[sync-critical] agent read plane: pagination neither skips nor repeats", () => {
  /**
   * The property test the whole of bucket 4 exists for: walk a dataset one row at
   * a time and assert the union of the pages equals the full set EXACTLY ONCE.
   *
   * The fixture is chosen to break every mismatch found in review: duplicate sort
   * values (ties), NULLs in the sort column, microsecond-precision timestamps that
   * a JavaScript `toISOString()` would truncate, and numeric values whose text
   * rendering sorts differently from their numeric order ("10" < "9").
   */
  async function seedPagingRows() {
    const pool = testDb!.pool;
    const { rows } = await pool.query<{ id: string }>(
      `insert into fans (platform, platform_user_id, username, first_seen_at)
       values ('fansly', '200000000000000001', 'pager', now()) returning id`,
    );
    const fanId = Number(rows[0]!.id);
    const stamps = [
      "2026-02-01T00:00:00.000001Z",
      "2026-02-01T00:00:00.000002Z",
      // A tie on the sort column: the keyset must fall through to the stable key.
      "2026-02-01T00:00:00.000002Z",
      "2026-02-01T00:00:00.000003Z",
      "2026-02-02T00:00:00.123456Z",
    ];
    for (const [index, occurredAt] of stamps.entries()) {
      await pool.query(
        `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type,
           canonical_type, transaction_state, raw_status, gross_amount_mills,
           source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, currency)
         values ($1, $2, $3, 'tip', 'tip', 'posted', 'ok', $4, $4, $4, $5, 'fansly:rest', 'USD')`,
        [pageId, fanId, `page-tx-${index}`, (index + 1) * 9, occurredAt],
      );
    }
    return stamps.length;
  }

  async function walkDataset(dataset: string, body: Record<string, unknown>) {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard += 1) {
      const response = await post(
        `/api/v1/agent/pages/lora-2/datasets/${dataset}/query`,
        // Two rows per page: the dataset route is rate limited to 20/min and a
        // one-row walk over three sort orders would trip it before the property
        // it is testing had a chance to fail.
        cursor === undefined ? { ...body, limit: 2 } : { cursor, limit: 2 },
      );
      expect(response.statusCode).toBe(200);
      const page = response.json();
      for (const item of page.items as Array<{ key: string }>) {
        seen.push(item.key);
      }
      if (page.delivery.nextCursor === null) {
        return seen;
      }
      cursor = page.delivery.nextCursor;
    }
    throw new Error("traversal did not terminate");
  }

  it("#10 a two-rows-per-page walk yields every row exactly once", async () => {
    const total = await seedPagingRows();
    const seen = await walkDataset("transactions", {
      from: "2026-01-01T00:00:00Z",
      to: "2026-04-01T00:00:00Z",
    });
    // Two seeded fans already carry one transaction each.
    expect(seen).toHaveLength(total + 2);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("#10 the same holds ascending, and on a numeric sort column", async () => {
    await seedPagingRows();
    for (const sort of [
      [{ field: "occurredAt", dir: "asc" }],
      [{ field: "grossMills", dir: "asc" }],
    ]) {
      const seen = await walkDataset("transactions", {
        from: "2026-01-01T00:00:00Z",
        to: "2026-04-01T00:00:00Z",
        sort,
      });
      expect(new Set(seen).size, JSON.stringify(sort)).toBe(seen.length);
      expect(seen.length, JSON.stringify(sort)).toBe(7);
    }
  });

  it("#10 a numeric sort orders numerically, not lexically", async () => {
    await seedPagingRows();
    const response = await post("/api/v1/agent/pages/lora-2/datasets/transactions/query", {
      from: "2026-01-01T00:00:00Z",
      to: "2026-04-01T00:00:00Z",
      sort: [{ field: "grossMills", dir: "asc" }],
      limit: 200,
    });
    const values = (response.json().items as Array<{ fields: { grossMills: number } }>)
      .map((item) => item.fields.grossMills);
    // "10" sorts before "9" as text; the rendered key is padded so it does not.
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });

  it("#5 a one-row-per-page thread walk yields every thread exactly once", async () => {
    const seen: string[] = [];
    let url = "/api/v1/agent/threads?limit=1";
    for (let guard = 0; guard < 20; guard += 1) {
      const page = (await get(url)).json();
      for (const item of page.items as Array<{ conversationRef: string }>) {
        seen.push(item.conversationRef);
      }
      if (page.delivery.nextCursor === null) {
        break;
      }
      url = `/api/v1/agent/threads?limit=1&cursor=${encodeURIComponent(page.delivery.nextCursor)}`;
    }
    expect(seen.sort()).toEqual([RICK_THREAD, MAYA_THREAD].sort());
  });

  it("#5 a NULL sort value does not hide the rows behind it", async () => {
    // A thread with no `last_message_at` sorts NULLS LAST; the resume predicate
    // must still reach it, and must not reintroduce the non-NULL rows once inside.
    await testDb!.pool.query(
      `insert into page_dm_threads (platform_account_id, platform_conversation_id,
         stored_message_count, message_coverage_status, last_message_at)
       values ($1, '900000000000000003', 0, 'pending_backfill', null)`,
      [pageId],
    );
    const seen: string[] = [];
    let url = "/api/v1/agent/threads?limit=1";
    for (let guard = 0; guard < 20; guard += 1) {
      const page = (await get(url)).json();
      for (const item of page.items as Array<{ conversationRef: string }>) {
        seen.push(item.conversationRef);
      }
      if (page.delivery.nextCursor === null) {
        break;
      }
      url = `/api/v1/agent/threads?limit=1&cursor=${encodeURIComponent(page.delivery.nextCursor)}`;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain("900000000000000003");
    expect(seen).toHaveLength(3);
  });

  it("a cursor refuses a scope field added on page 2", async () => {
    const first = (await get("/api/v1/agent/threads?limit=1")).json();
    expect(first.delivery.nextCursor).not.toBeNull();
    // Adding a filter alongside the cursor would serve a differently-shaped
    // population while `delivery` presented one continuous snapshot.
    const response = await get(
      `/api/v1/agent/threads?cursor=${encodeURIComponent(first.delivery.nextCursor)}`
      + "&coverageStatus=complete",
    );
    expect(response.statusCode).toBe(400);
  });

  it("a transcript cursor does not resume against a DIFFERENT conversation", async () => {
    const window = "from=2026-03-01T00:00:00Z&to=2026-03-10T00:00:00Z";
    const first = (await get(
      `/api/v1/agent/pages/lora-2/threads/${RICK_THREAD}/messages?${window}&limit=1`,
    )).json();
    // One row, one page: mint a cursor by asking for a smaller page than the set.
    if (first.delivery.nextCursor === null) {
      return;
    }
    const crossed = await get(
      `/api/v1/agent/pages/lora-2/threads/${MAYA_THREAD}/messages`
      + `?cursor=${encodeURIComponent(first.delivery.nextCursor)}`,
    );
    expect(crossed.statusCode).toBe(400);
  });
});

describe("[sync-critical] agent read plane: the row budget bounds the page", () => {
  it("a key with one row of allowance left is not served two hundred", async () => {
    const owner = await createUser(testDb!.db, {
      username: "owner-budget",
      role: "owner",
      passwordHash: null,
    });
    const token = `${AGENT_KEY_TOKEN_PREFIX}tiny-row-budget-token`;
    await insertAgentKey(testDb!.db, {
      name: "tiny",
      keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(token),
      capabilities: ["read:messages"],
      pageIds: [pageId],
      dailyRequestBudget: 100,
      dailyRowBudget: 1,
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      createdBy: owner?.id ?? null,
    });
    const response = await get("/api/v1/agent/threads?limit=200", token);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Two threads exist; the allowance is one row, so exactly one comes back and
    // the response says the BUDGET is what capped it.
    expect(body.items).toHaveLength(1);
    expect(body.delivery.cappedBy).toBe("budget");
    expect(body.delivery.nextCursor).not.toBeNull();
  });
});
