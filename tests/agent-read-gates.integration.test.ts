import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
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
const MESSAGES_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}gates-messages-only-token`;
const MONEY_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}gates-money-only-token`;
const BARE_MESSAGES_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}gates-bare-messages-token`;
const BARE_MONEY_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}gates-bare-money-token`;

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let pageId = 0;
/** A SECOND page on the OTHER platform, so a lost `platform` filter is visible.
 *  Without it a broadened traversal returns the same rows and the regression that
 *  prompted this test would have gone unnoticed a second time. */
let onlyFansPageId = 0;

const RICK = "100000000000000001";
const MAYA = "100000000000000002";
const RICK_THREAD = "900000000000000001";
const MAYA_THREAD = "900000000000000002";
const OF_FAN = "100000000000000003";
const OF_THREAD = "900000000000000004";

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
  const ofPage = await createOnlyFansPage(testDb.db, { modelId: model.id, label: "lora-of" });
  if (!page || !ofPage) {
    throw new Error("fixture pages were not created");
  }
  pageId = page.id;
  onlyFansPageId = ofPage.id;

  const owner = await createUser(testDb.db, {
    username: "owner",
    role: "owner",
    passwordHash: null,
  });
  const common = {
    pageIds: [pageId, onlyFansPageId],
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
  // Messages WITHOUT money: the probe for every field that leaks the existence of
  // a payment through something that is not obviously money.
  await insertAgentKey(testDb.db, {
    ...common,
    name: "messages-only",
    keyPrefix: MESSAGES_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(MESSAGES_TOKEN),
    capabilities: ["read:messages", "read:datasets"],
  });
  // Money WITHOUT messages: distinguishes a genuinely money-only dataset from
  // one whose creator-written goal label also requires the text capability.
  await insertAgentKey(testDb.db, {
    ...common,
    name: "money-only",
    keyPrefix: MONEY_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(MONEY_TOKEN),
    capabilities: ["read:money", "read:datasets"],
  });
  await insertAgentKey(testDb.db, {
    ...common,
    name: "bare-messages",
    keyPrefix: BARE_MESSAGES_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(BARE_MESSAGES_TOKEN),
    capabilities: ["read:messages"],
  });
  await insertAgentKey(testDb.db, {
    ...common,
    name: "bare-money",
    keyPrefix: BARE_MONEY_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(BARE_MONEY_TOKEN),
    capabilities: ["read:money"],
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
      `insert into creator_post_tips (account_id, platform, platform_post_id,
         platform_tip_id, tip_sender_platform_user_id, post_tip_amount_mills,
         occurred_at, receiver_transaction_ref, tip_goal_ref, tip_message_text,
         first_observed_at, last_observed_at, content_hash, source_event_id,
         source_observation_id, source_account_seq)
       values ($1, 'fansly', $2, $3, $4, 25000,
         '2026-03-06T13:00:00Z', $5, $6, 'private fan note must not cross this view',
         '2026-03-06T13:01:00Z', '2026-03-07T00:00:00Z', repeat('e', 64),
         $7, $8, $9)`,
      [
        pageId,
        `post-${username}`,
        `post-tip-${username}`,
        platformUserId,
        `receiver-${username}`,
        username === "rick" ? "goal-rick" : null,
        fanId + 10_000,
        fanId + 20_000,
        fanId + 30_000,
      ],
    );
    // The Fansly retention TIER is derived from lifetime spend, which is what
    // makes it a payment oracle for a key without read:money.
    await pool.query(
      `insert into fan_spend_lifetime (platform_account_id, fan_id, gross_amount_mills,
         creator_net_amount_mills, last_transaction_at)
       values ($1, $2, 50000, 40000, '2026-01-23T12:00:00Z')`,
      [pageId, fanId],
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

  // One thread on the OTHER platform. A traversal filtered to `fansly` must never
  // surface it, on page 1 or on page 5.
  const { rows } = await pool.query<{ id: string }>(
    `insert into fans (platform, platform_user_id, username, first_seen_at)
     values ('onlyfans', $1, 'ofguy', '2026-01-05T00:00:00Z') returning id`,
    [OF_FAN],
  );
  await pool.query(
    `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type,
       canonical_type, transaction_state, raw_status, gross_amount_mills,
       source_destination_amount_mills, creator_net_amount_mills,
       platform_fee_mills, occurred_at, source, currency, correlation_id)
     values ($1, $2, 'of-tip-ledger', 'tip', 'tip', 'posted', 'ok', 7000,
       7000, 5600, 1400, '2026-03-05T12:00:00Z', 'ofapi:rest', 'USD',
       'of-correlation-not-a-message')`,
    [onlyFansPageId, Number(rows[0]!.id)],
  );
  await pool.query(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id,
       partner_platform_user_id, stored_message_count, message_coverage_status, last_message_at)
     values ($1, $2, $3, $4, 1, 'complete', '2026-03-03T00:00:00Z')`,
    [onlyFansPageId, Number(rows[0]!.id), OF_THREAD, OF_FAN],
  );

  // An actual OnlyFans post with null monetization columns pins the distinction
  // between a provider omission and a structurally unsupported capture lane.
  await pool.query(
    `insert into creator_posts (account_id, platform, platform_post_id, text_plain,
       published_at, first_observed_at, last_observed_at, content_hash,
       attachment_count, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'onlyfans', 'of-post-no-monetization', 'ordinary OF post',
       '2026-03-04T12:00:00Z', '2026-03-04T12:01:00Z', '2026-03-05T00:00:00Z',
       repeat('d', 64), 1, 9301, 9302, 201)`,
    [onlyFansPageId],
  );

  // Captured Fansly shape for purchase codes 2007/2008: the buyer is the
  // correlation GROUP, while correlationRef is absent. This identity is why
  // the notifications dataset needs the message-disclosure capability.
  await pool.query(
    `insert into platform_notifications (
       page_id, platform, notification_ref, type_code, correlation_ref,
       correlation_group_ref, metadata, occurred_at, first_observed_at,
       last_observed_at, content_hash, source_event_id, source_observation_id,
       source_account_seq
     ) values (
       $1, 'fansly', 'purchase-2007', 2007, null, $2, '{}'::jsonb,
       '2026-03-06T12:00:00Z', '2026-03-06T12:00:01Z',
       '2026-03-06T12:00:01Z', repeat('a', 64), 91001, 91002, 91003
     )`,
    [pageId, RICK],
  );
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
    expect(body.postTips).toBeNull();
    expect(body.subscriptions).toBeNull();
    expect(body.memberships[0].lifetimeSpendMills).toBeNull();
    // The TIMESTAMP is withheld too: when a payment happened discloses that one did.
    expect(body.memberships[0].lastTransactionAt).toBeNull();

    const granted = await get(`/api/v1/agent/people/fansly/${RICK}`);
    expect(granted.json().money.lifetime.grossMills).toBe(50_000);
    expect(granted.json().postTips.items).toEqual([expect.objectContaining({
      postTipPostRef: "post-rick",
      postTipRef: "post-tip-rick",
      postTipAmountMills: 25_000,
      postTipGoalRef: "goal-rick",
    })]);
    expect(granted.json().postTips.items[0]).not.toHaveProperty("postTipMessageText");
    expect(granted.json().memberships[0].lastTransactionAt).not.toBeNull();
  });

  it("#3 serves attribution to read:money without leaking the fan-written note", async () => {
    const moneyOnly = (await get(
      `/api/v1/agent/people/fansly/${RICK}`,
      MONEY_TOKEN,
    )).json();
    expect(moneyOnly.postTips.items).toEqual([expect.objectContaining({
      postTipPostRef: "post-rick",
      postTipGoalRef: "goal-rick",
      postTipAmountMills: 25_000,
    })]);
    expect(moneyOnly.postTips.items[0]).not.toHaveProperty("postTipMessageText");

    const messagesOnly = (await get(
      `/api/v1/agent/people/fansly/${RICK}`,
      MESSAGES_TOKEN,
    )).json();
    expect(messagesOnly.postTips).toBeNull();
  });

  it("#3/#4 fail closed when a claim asks these non-verbatim views for the tip note", async () => {
    const person = await get(
      `/api/v1/agent/people/fansly/${RICK}`
      + "?claimFields=postTipMessageText&claimTargets=all_in_scope",
    );
    expect(person.statusCode).toBe(400);

    const timeline = await get(
      `/api/v1/agent/people/fansly/${RICK}/timeline?${WINDOW}`
      + "&claimFields=postTipMessageText&claimTargets=all_in_scope",
    );
    expect(timeline.statusCode).toBe(400);
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
    expect(body.capture.planes.find(
      (plane: { plane: string }) => plane.plane === "creator_post_tips",
    )).toMatchObject({
      state: "not_read",
      reason: "capability_not_granted",
    });
  });

  it("#4 drops the money lane without read:money and SAYS it dropped it", async () => {
    const response = await get(
      `/api/v1/agent/people/fansly/${RICK}/timeline?${WINDOW}`
      + "&claimFields=postTipPostRef&claimFields=postTipAmountMills"
      + "&claimFields=postTipGoalRef&claimTargets=all_in_scope",
      NARROW_TOKEN,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.lanesRequested).toContain("money");
    expect(body.lanesRequested).toContain("post_tips");
    expect(body.lanesServed).not.toContain("money");
    expect(body.lanesServed).not.toContain("post_tips");
    expect(body.lanesServed).not.toContain("subscriptions");
    expect(body.lanesServed).not.toContain("messages");
    expect(body.items).toEqual([]);
    expect(body.capture.scopeFieldStates).toMatchObject({
      postTipPostRef: {
        state: "unknown",
        remedy: { reason: "capability_not_granted" },
      },
      postTipAmountMills: {
        state: "unknown",
        remedy: { reason: "capability_not_granted" },
      },
      postTipGoalRef: {
        state: "unknown",
        remedy: { reason: "capability_not_granted" },
      },
    });

    const granted = (await get(`/api/v1/agent/people/fansly/${RICK}/timeline?${WINDOW}`)).json();
    expect(granted.lanesServed).toContain("money");
    expect(granted.lanesServed).toContain("post_tips");
    expect(granted.items.some((item: { lane: string }) => item.lane === "money")).toBe(true);
    expect(granted.items.some((item: { lane: string }) => item.lane === "post_tips")).toBe(true);
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
    // Three threads in the grant: two Fansly fans and one on the OnlyFans page.
    const all = await get("/api/v1/agent/threads");
    expect(all.json().items).toHaveLength(3);

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
    expect(all.json().items).toHaveLength(3);

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
    expect(seen.sort()).toEqual([RICK_THREAD, MAYA_THREAD, OF_THREAD].sort());
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
    expect(seen).toHaveLength(4);
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

describe("[sync-critical] agent read plane: review round 2", () => {
  it("P1-1 page 2 of a FILTERED traversal keeps the filter", async () => {
    // The regression this test exists for: total cursor exclusivity made the
    // cursor the ONLY carrier of the scope, so any field the cursor failed to
    // store silently widened the walk on page 2. It cost #8 its `platform`.
    //
    // The check is generic on purpose — one case per paginated operation, each
    // walking a FILTERED population one row at a time and asserting every page
    // stays inside the filter.
    const cases: Array<{ name: string; first: string; forbidden: string }> = [
      {
        name: "#5 threads / person",
        first: `/api/v1/agent/threads?limit=1&personPlatform=fansly&personPlatformUserId=${RICK}`,
        forbidden: MAYA_THREAD,
      },
      {
        name: "#8 coverage / person",
        first: `/api/v1/agent/coverage?${WINDOW}&limit=1`
          + `&personPlatform=fansly&personPlatformUserId=${RICK}`,
        forbidden: MAYA_THREAD,
      },
      {
        name: "#8 coverage / conversationRef",
        first: `/api/v1/agent/coverage?${WINDOW}&limit=1&pageLabel=lora-2`
          + `&conversationRef=${RICK_THREAD}`,
        forbidden: MAYA_THREAD,
      },
    ];

    for (const testCase of cases) {
      const seen: string[] = [];
      let url = testCase.first;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = (await get(url)).json();
        for (const item of page.items as Array<{ conversationRef: string }>) {
          seen.push(item.conversationRef);
        }
        if (page.delivery.nextCursor === null) {
          break;
        }
        // A cursor request may re-send NOTHING, so the filter must survive inside
        // the cursor or not at all.
        const base = testCase.first.split("?")[0];
        url = `${base}?cursor=${encodeURIComponent(page.delivery.nextCursor)}`;
      }
      expect(seen, testCase.name).not.toContain(testCase.forbidden);
      expect(seen, testCase.name).toContain(RICK_THREAD);
    }
  });

  it("P1-1 #8 keeps its PLATFORM filter across pages", async () => {
    // THE regression. `platform` was accepted, applied on page 1, refused on the
    // wire for page 2 (correctly — a cursor pins the scope), and NOT stored in the
    // cursor, so the traversal quietly broadened to every granted platform.
    //
    // The grant spans both platforms and the OnlyFans page holds a thread, so a
    // widened walk surfaces it and this assertion catches it. That the fixture
    // lacked a second platform is why the first version of this test passed
    // against the bug.
    const unfiltered = (await get(`/api/v1/agent/coverage?${WINDOW}`)).json();
    expect(unfiltered.items).toHaveLength(3);

    const seen: string[] = [];
    let url = `/api/v1/agent/coverage?${WINDOW}&limit=1&platform=fansly`;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = (await get(url)).json();
      for (const item of page.items as Array<{ platform: string; conversationRef: string }>) {
        expect(item.platform).toBe("fansly");
        seen.push(item.conversationRef);
      }
      if (page.delivery.nextCursor === null) {
        break;
      }
      url = `/api/v1/agent/coverage?cursor=${encodeURIComponent(page.delivery.nextCursor)}`;
    }
    expect(seen.sort()).toEqual([RICK_THREAD, MAYA_THREAD].sort());
    expect(seen).not.toContain(OF_THREAD);
  });

  it("P1-2 #8 requires read:messages", async () => {
    const refused = await get(`/api/v1/agent/coverage?${WINDOW}`, NARROW_TOKEN);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("agent_capability_missing");
    expect((await get(`/api/v1/agent/coverage?${WINDOW}`, MESSAGES_TOKEN)).statusCode).toBe(200);
  });

  it("P1-3 the retention tier does not leak the existence of a payment", async () => {
    // 1000 instead of 200 says "this fan has spent" without ever naming money.
    const pick = (body: { items: Array<{ conversationRef: string }> }) =>
      body.items.find((item) => item.conversationRef === RICK_THREAD) as Record<string, unknown>;

    const withMoney = pick((await get("/api/v1/agent/threads")).json());
    expect(withMoney.retentionLimit).toBe(1000);

    const withoutMoneyBody = (await get("/api/v1/agent/threads", MESSAGES_TOKEN)).json();
    const withoutMoney = pick(withoutMoneyBody);
    expect(withoutMoney.retentionLimit).toBeNull();
    // ... and the response says WHICH null this is, rather than leaving it to read
    // as "this platform has no cap" (which is what null means on OnlyFans).
    expect((withoutMoney.fieldStates as Record<string, unknown>).lifetimeSpendMills).toEqual({
      state: "unknown",
      remedy: { kind: "none", reason: "capability_not_granted" },
    });
    // The plane must reflect what was actually read: no join, no witness.
    const plane = withoutMoneyBody.capture.planes.find(
      (entry: { plane: string }) => entry.plane === "fan_spend_lifetime",
    );
    expect(plane).toMatchObject({ state: "not_read", reason: "capability_not_granted" });
    const granted = (await get("/api/v1/agent/threads")).json().capture.planes.find(
      (entry: { plane: string }) => entry.plane === "fan_spend_lifetime",
    );
    expect(granted.state).toBe("read");
  });

  it("P1-4 dataset money/text gates compose without a side door", async () => {
    const window = { from: "2026-01-01T00:00:00Z", to: "2026-04-01T00:00:00Z" };
    // `read:datasets` alone used to read note bodies verbatim through this route,
    // while the very same material sat behind `read:messages` on #3.
    const refused = await post(
      "/api/v1/agent/pages/lora-2/datasets/fan_notes/query",
      window,
      NARROW_TOKEN,
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("agent_capability_missing");

    expect((await post(
      "/api/v1/agent/pages/lora-2/datasets/fan_notes/query",
      window,
      MESSAGES_TOKEN,
    )).statusCode).toBe(200);
    // Creator post copy is the same disclosure class as notes and transcripts.
    // The dataset is allowed to be empty here; the boundary gate must still run
    // before SQL and require both read:datasets and read:messages.
    const postsRefused = await post(
      "/api/v1/agent/pages/lora-2/datasets/posts/query",
      window,
      NARROW_TOKEN,
    );
    expect(postsRefused.statusCode).toBe(403);
    expect(postsRefused.json().error).toBe("agent_capability_missing");
    expect((await post(
      "/api/v1/agent/pages/lora-2/datasets/posts/query",
      window,
      MESSAGES_TOKEN,
    )).statusCode).toBe(200);

    // Post monetization carries both money and creator-written goal copy: a key
    // holding only either one of those capabilities is still refused.
    expect((await post(
      "/api/v1/agent/pages/lora-2/datasets/post_monetization/query",
      window,
      MESSAGES_TOKEN,
    )).statusCode).toBe(403);
    expect((await post(
      "/api/v1/agent/pages/lora-2/datasets/post_monetization/query",
      window,
      MONEY_TOKEN,
    )).statusCode).toBe(403);
    expect((await post(
      "/api/v1/agent/pages/lora-2/datasets/post_monetization/query",
      window,
    )).statusCode).toBe(200);

    // Individual tips carry money plus fan-written tip copy, so either partial
    // grant is insufficient even when a particular row's message is null.
    expect((await post(
      "/api/v1/agent/pages/lora-2/datasets/post_tips/query",
      window,
      MESSAGES_TOKEN,
    )).statusCode).toBe(403);
    expect((await post(
      "/api/v1/agent/pages/lora-2/datasets/post_tips/query",
      window,
      MONEY_TOKEN,
    )).statusCode).toBe(403);
    expect((await post(
      "/api/v1/agent/pages/lora-2/datasets/post_tips/query",
      window,
    )).statusCode).toBe(200);

    // Ledger tips with provider-verbatim context have the same combined gate.
    expect((await post(
      "/api/v1/agent/pages/lora-2/datasets/tip_transactions/query",
      window,
      MESSAGES_TOKEN,
    )).statusCode).toBe(403);
    expect((await post(
      "/api/v1/agent/pages/lora-2/datasets/tip_transactions/query",
      window,
      MONEY_TOKEN,
    )).statusCode).toBe(403);
    expect((await post(
      "/api/v1/agent/pages/lora-2/datasets/tip_transactions/query",
      window,
    )).statusCode).toBe(200);

    // Deduplicated goals carry both their cumulative amounts and creator copy.
    expect((await post(
      "/api/v1/agent/pages/lora-2/datasets/tip_goals/query",
      window,
      MESSAGES_TOKEN,
    )).statusCode).toBe(403);
    expect((await post(
      "/api/v1/agent/pages/lora-2/datasets/tip_goals/query",
      window,
      MONEY_TOKEN,
    )).statusCode).toBe(403);
    expect((await post(
      "/api/v1/agent/pages/lora-2/datasets/tip_goals/query",
      window,
    )).statusCode).toBe(200);

    // A dataset with no text body is unaffected.
    expect((await post(
      "/api/v1/agent/pages/lora-2/datasets/dm_threads/query",
      window,
      NARROW_TOKEN,
    )).statusCode).toBe(200);
  });

  it("purchase notifications require datasets and messages together", async () => {
    const request = { from: "2026-01-01T00:00:00Z", to: "2026-04-01T00:00:00Z" };
    for (const token of [NARROW_TOKEN, BARE_MESSAGES_TOKEN, BARE_MONEY_TOKEN, MONEY_TOKEN]) {
      const refused = await post(
        "/api/v1/agent/pages/lora-2/datasets/notifications/query",
        request,
        token,
      );
      expect(refused.statusCode, token).toBe(403);
      expect(refused.json().error).toBe("agent_capability_missing");
    }

    const granted = await post(
      "/api/v1/agent/pages/lora-2/datasets/notifications/query",
      request,
      MESSAGES_TOKEN,
    );
    expect(granted.statusCode).toBe(200);
    expect(granted.json().items).toContainEqual(expect.objectContaining({
      fields: expect.objectContaining({
        typeCode: 2007,
        correlationRef: null,
        correlationGroupRef: RICK,
      }),
    }));
  });

  it("Fansly-only post money fields stay structurally not_captured on OnlyFans", async () => {
    const monetizationRequest = {
      from: "2026-01-01T00:00:00Z",
      to: "2026-04-01T00:00:00Z",
      claim: {
        fields: ["postRef", "postTargetTipAmountMills", "tipGoalCurrentMills"],
        targets: "all_in_scope",
      },
    };
    const fansly = (await post(
      "/api/v1/agent/pages/lora-2/datasets/post_monetization/query",
      monetizationRequest,
    )).json();
    expect(fansly.capture.scopeFieldStates).toMatchObject({
      postRef: { state: "present" },
      postTargetTipAmountMills: { state: "present" },
      tipGoalCurrentMills: { state: "present" },
    });

    const onlyFans = (await post(
      "/api/v1/agent/pages/lora-of/datasets/post_monetization/query",
      monetizationRequest,
    )).json();
    // The source is explicitly Fansly-only: an ordinary OF creator_posts row
    // cannot leak into this dataset or establish a misleading capture floor.
    expect(onlyFans.items).toEqual([]);
    expect(onlyFans.capture.planes.find(
      (plane: { plane: string }) => plane.plane === "creator_posts",
    )).toMatchObject({
      state: "read",
      captureFloor: { at: null, kind: "unknown" },
    });
    expect(onlyFans.capture.scopeFieldStates).toMatchObject({
      postRef: { state: "not_captured" },
      postTargetTipAmountMills: { state: "not_captured" },
      tipGoalCurrentMills: { state: "not_captured" },
    });

    const tipsRequest = {
      from: "2026-01-01T00:00:00Z",
      to: "2026-04-01T00:00:00Z",
      claim: {
        fields: [
          "postTipPostRef",
          "postTipAmountMills",
          "postTipGoalRef",
          "postTipMessageText",
        ],
        targets: "all_in_scope",
      },
    };
    const fanslyTips = (await post(
      "/api/v1/agent/pages/lora-2/datasets/post_tips/query",
      tipsRequest,
    )).json();
    expect(fanslyTips.capture.scopeFieldStates).toMatchObject({
      postTipPostRef: { state: "present" },
      postTipAmountMills: { state: "present" },
      postTipGoalRef: { state: "present" },
      postTipMessageText: { state: "present" },
    });
    const onlyFansTips = (await post(
      "/api/v1/agent/pages/lora-of/datasets/post_tips/query",
      tipsRequest,
    )).json();
    expect(onlyFansTips.items).toEqual([]);
    expect(onlyFansTips.capture.scopeFieldStates).toMatchObject({
      postTipPostRef: { state: "not_captured" },
      postTipAmountMills: { state: "not_captured" },
      postTipGoalRef: { state: "not_captured" },
      postTipMessageText: { state: "not_captured" },
    });

    const goalsRequest = {
      from: "2026-01-01T00:00:00Z",
      to: "2026-04-01T00:00:00Z",
      claim: {
        fields: ["tipGoalRef", "lastObservedAt", "linkedPostCount"],
        targets: "all_in_scope",
      },
    };
    const fanslyGoals = (await post(
      "/api/v1/agent/pages/lora-2/datasets/tip_goals/query",
      goalsRequest,
    )).json();
    expect(fanslyGoals.capture.scopeFieldStates).toMatchObject({
      tipGoalRef: { state: "present" },
      lastObservedAt: { state: "present" },
      linkedPostCount: { state: "present" },
    });
    const onlyFansGoals = (await post(
      "/api/v1/agent/pages/lora-of/datasets/tip_goals/query",
      goalsRequest,
    )).json();
    expect(onlyFansGoals.items).toEqual([]);
    expect(onlyFansGoals.capture.scopeFieldStates).toMatchObject({
      tipGoalRef: { state: "not_captured" },
      lastObservedAt: { state: "not_captured" },
      linkedPostCount: { state: "not_captured" },
    });
  });

  it("keeps OnlyFans ledger tips visible while context stays not_captured", async () => {
    const body = (await post(
      "/api/v1/agent/pages/lora-of/datasets/tip_transactions/query",
      {
        from: "2026-03-01T00:00:00Z",
        to: "2026-03-10T00:00:00Z",
        claim: {
          fields: [
            "grossMills",
            "correlationRef",
            "contextState",
            "capturedConversationRef",
            "tipMessageText",
          ],
          targets: "all_in_scope",
        },
      },
    )).json();

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      fields: {
        platform: "onlyfans",
        platformUserId: OF_FAN,
        transactionRef: "of-tip-ledger",
        grossMills: 7000,
        correlationRef: "of-correlation-not-a-message",
        contextState: "not_captured",
        capturedConversationRef: null,
        tipMessageText: null,
      },
      fieldStates: {
        grossMills: { state: "present" },
        correlationRef: { state: "present" },
        contextState: { state: "present" },
        capturedConversationRef: {
          state: "not_captured",
          remedy: { kind: "none", reason: "capture_lane_unimplemented" },
        },
        tipMessageText: {
          state: "not_captured",
          remedy: { kind: "none", reason: "capture_lane_unimplemented" },
        },
      },
      provenance: {
        ingestPaths: ["unknown"],
        convergence: "no_material_lane",
      },
    });
    expect(body.capture.gaps).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "internal_capture_gap",
        plane: "transaction_tip_contexts",
      }),
    ]));
  });

  it("P1-5 snapshotExhausted is only claimed where a snapshot was frozen", async () => {
    // #5 and #9a apply a monotonic bound in SQL and may claim it; the rest carry
    // `no_frozen_snapshot` and must stay false even on the LAST page, because
    // "there is nothing more" is a claim about a population that can still grow.
    const threads = (await get("/api/v1/agent/threads")).json();
    expect(threads.delivery.nextCursor).toBeNull();
    expect(threads.delivery.snapshotExhausted).toBe(true);
    expect(threads.delivery.caveats).not.toContain("no_frozen_snapshot");

    for (const url of [
      `/api/v1/agent/coverage?${WINDOW}`,
      `/api/v1/agent/people/fansly/${RICK}/timeline?${WINDOW}`,
    ]) {
      const body = (await get(url)).json();
      expect(body.delivery.nextCursor, url).toBeNull();
      expect(body.delivery.snapshotExhausted, url).toBe(false);
      expect(body.delivery.caveats, url).toContain("no_frozen_snapshot");
      // ... and the blocker says the same thing, so the two never disagree.
      expect(body.conclusion.blockers, url).toContain("delivery_not_exhausted");
    }
  });

  it("P2a fan flags: the envelope and the body agree", async () => {
    await testDb!.pool.query(
      `insert into fan_flags (fan_id, flag) select f.id, 'vip' from fans f
       where f.platform_user_id = $1`,
      [RICK],
    );
    const body = (await get(`/api/v1/agent/people/fansly/${RICK}`, NARROW_TOKEN)).json();
    // A flag is a value from a closed enum, not prose: it is served, so the field
    // state must NOT declare it unavailable.
    expect(body.identity.flags).toHaveLength(1);
    expect(body.capture.scopeFieldStates.fanFlag).toBeUndefined();
  });

  it("P2b #2 and #3 charge the row budget for what they carried", async () => {
    const owner = await createUser(testDb!.db, {
      username: "owner-rows",
      role: "owner",
      passwordHash: null,
    });
    const token = `${AGENT_KEY_TOKEN_PREFIX}row-budget-probe-token`;
    await insertAgentKey(testDb!.db, {
      name: "rows",
      keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(token),
      capabilities: ["read:messages", "read:money", "read:datasets"],
      pageIds: [pageId],
      dailyRequestBudget: 100,
      // Room for exactly ONE card (identity + membership + money row + post-tip
      // attribution + thread) and
      // not two: the second request has allowance left but not enough for a whole
      // bundle, which is the case that used to be served anyway.
      dailyRowBudget: 5,
      expiresAt: new Date(Date.now() + DAY_MS),
      createdBy: owner?.id ?? null,
    });
    // The person card carries memberships, threads, money rows and subscriptions;
    // charging it as ONE row let the two fan-facing operations walk past the daily
    // budget entirely.
    expect((await get(`/api/v1/agent/people/fansly/${RICK}`, token)).statusCode).toBe(200);
    const second = await get(`/api/v1/agent/people/fansly/${MAYA}`, token);
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toBe("agent_budget_exhausted");
    // A bundle is never HALF served: the refused card left the counter where the
    // served one put it.
    const { rows } = await testDb!.pool.query<{ rows_returned: string }>(
      `select u.rows_returned::text as rows_returned
       from agent_key_usage_daily u join agent_keys k on k.id = u.agent_key_id
       where k.name = 'rows'`,
    );
    expect(Number(rows[0]!.rows_returned)).toBe(5);
  });

  it("P2c matchedInScope is inexact on any resumed or truncated read", async () => {
    let page = (await get(`/api/v1/agent/coverage?${WINDOW}&limit=1`)).json();
    expect(page.delivery.matchedInScope.exact).toBe(false);
    const walked: string[] = page.items.map((item: { conversationRef: string }) =>
      item.conversationRef);

    for (let guard = 0; page.delivery.nextCursor !== null && guard < 6; guard += 1) {
      page = (await get(
        `/api/v1/agent/coverage?cursor=${encodeURIComponent(page.delivery.nextCursor)}`,
      )).json();
      // Page 2 and every page after it carry page 1's SIZE, which the cursor
      // holds: reading the schema default (50) instead changed the traversal's
      // shape after page 1 and re-minted every later cursor with the wrong size.
      expect(page.items.length).toBeLessThanOrEqual(1);
      // The LAST page used to report its own length with `exact: true`, which on a
      // multi-page traversal is simply a false number.
      expect(page.delivery.matchedInScope.exact).toBe(false);
      walked.push(...page.items.map((item: { conversationRef: string }) => item.conversationRef));
    }
    // Three scopes, one per page, each exactly once.
    expect(walked).toHaveLength(3);
    expect(new Set(walked).size).toBe(3);

    // A complete, un-resumed read is still exact.
    const whole = (await get(`/api/v1/agent/coverage?${WINDOW}`)).json();
    expect(whole.delivery.matchedInScope).toEqual({
      value: 3,
      exact: true,
      countBasis: "post_dedup",
    });
  });
});
