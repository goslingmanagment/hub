import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  createUser,
  insertAgentKey,
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
const CONTENT_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}gates-content-only-token`;

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
  const appContext = createTestAppContext(testDb);

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
  // The ContentOps key's read right: the page's own material and nothing else.
  await insertAgentKey(testDb.db, {
    ...common,
    name: "content-only",
    keyPrefix: CONTENT_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(CONTENT_TOKEN),
    capabilities: ["read:content"],
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

describe("[sync-critical] agent read plane: review round 2", () => {
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
});

describe("[sync-critical] agent read plane: read:content", () => {
  const window = { from: "2026-01-01T00:00:00Z", to: "2026-04-01T00:00:00Z" };
  const OWN_CONTENT = [
    "posts",
    "post_attachments",
    "raw_media",
    "vault_media",
    "capture_coverage",
    "sync_streams",
    "top_media",
    "creator_stats_media_daily",
    "creator_stats_media_likes",
  ];

  it("reads the page's own posts, files, vault and their statistics with that capability alone", async () => {
    for (const dataset of OWN_CONTENT) {
      const response = await post(`/api/v1/agent/pages/lora-2/datasets/${dataset}/query`, window, CONTENT_TOKEN);
      expect(response.statusCode, `${dataset}: ${response.body}`).toBe(200);
    }
    // Only the key's pages: a page outside the grant is the plane's one 404.
    expect((await post(
      "/api/v1/agent/pages/not-granted/datasets/posts/query",
      window,
      CONTENT_TOKEN,
    )).statusCode).toBe(404);
  });

  it("opens no conversation, fan, purchase or money", async () => {
    for (const dataset of [
      "dm_threads",
      "fan_memberships",
      "fan_notes",
      "subscriptions",
      "transactions",
      "comments",
      "notifications",
      "message_media_sales",
      "media_stats",
    ]) {
      const refused = await post(`/api/v1/agent/pages/lora-2/datasets/${dataset}/query`, window, CONTENT_TOKEN);
      expect(refused.statusCode, dataset).toBe(403);
      expect(refused.json().error, dataset).toBe("agent_capability_missing");
    }
    const search = await post("/api/v1/agent/search/messages", { q: "custom", ...window }, CONTENT_TOKEN);
    expect(search.statusCode).toBe(403);
    const transcript = await get(`/api/v1/agent/pages/lora-2/threads/${RICK_THREAD}/messages?${WINDOW}`, CONTENT_TOKEN);
    expect(transcript.statusCode).toBe(403);
    expect(transcript.json().error).toBe("agent_capability_missing");
  });

  it("leaves the keys without it as they were, and capabilities says which datasets it reads", async () => {
    // read:datasets alone still cannot read post copy; read:messages still can.
    expect((await post("/api/v1/agent/pages/lora-2/datasets/posts/query", window, NARROW_TOKEN)).statusCode).toBe(403);
    expect((await post("/api/v1/agent/pages/lora-2/datasets/vault_media/query", window, MESSAGES_TOKEN)).statusCode)
      .toBe(200);

    const capabilities = (await get("/api/v1/agent/capabilities", CONTENT_TOKEN)).json() as {
      key: { capabilities: Array<{ capability: string; granted: boolean }> };
      datasets: Array<{ dataset: string; ownContent: boolean; requiredCapabilities: string[] }>;
    };
    expect(capabilities.key.capabilities.filter((entry) => entry.granted).map((entry) => entry.capability))
      .toEqual(["read:content"]);
    const own = capabilities.datasets.filter((entry) => entry.ownContent).map((entry) => entry.dataset).sort();
    expect(own).toEqual([...OWN_CONTENT].sort());
    expect(capabilities.datasets.find((entry) => entry.dataset === "posts")?.requiredCapabilities)
      .toEqual(["read:datasets", "read:messages"]);
  });

  it("serves the OnlyFans vault it has read, and only a complete latest walk proves its inventory", async () => {
    const pool = testDb!.pool;
    const actor = (await pool.query<{ id: string }>("select id from users where username = 'owner'")).rows[0]!.id;
    await pool.query(
      `insert into ofapi_media_catalog (account_id, page_id, media_ref, material_kind, provider_type, byte_size,
                                        duration, width, height, metadata, observation_id, observation_received_at)
       values ('acct_of', $1, '4775760717', 'vault', 'video', 73400320, 12.5, 1080, 1920,
               '{"createdAt":"2026-01-20T19:11:52+00:00"}'::jsonb, 1, '2026-02-01T00:00:00Z')`,
      [onlyFansPageId],
    );
    const job = (state: string, query: Record<string, string>, createdAt: string) => pool.query(
      `insert into ofapi_collection_jobs (id, page_id, category, policy_revision, actor_user_id, state,
                                          max_credits, max_calls, max_bytes, target, checkpoint, created_at, updated_at)
       values (gen_random_uuid(), $1, 'vault_catalog', 1, $2, $3, 10, 5, 10, '{}'::jsonb,
               jsonb_build_object('plan', jsonb_build_array(jsonb_build_object(
                 'operation', 'ofapi_read_vault_inventory', 'pathname', '/acct_of/media/vault', 'query', $4::jsonb))),
               $5, $5)`,
      [onlyFansPageId, actor, state, JSON.stringify(query), createdAt],
    );
    const read = async () => {
      const response = await post("/api/v1/agent/pages/lora-of/datasets/vault_media/query", window, CONTENT_TOKEN);
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as {
        items: Array<{ fields: Record<string, unknown> }>;
        conclusion: { blockers: string[] };
      };
    };

    // The daily walk ran out of calls: the rows it read are served, the inventory is not proven.
    await job("failed", { limit: "50", offset: "0" }, "2026-02-01T00:00:00Z");
    const partial = await read();
    expect(partial.items).toHaveLength(1);
    expect(partial.items[0]!.fields).toMatchObject({
      platform: "onlyfans", vaultKind: "creator", albumRef: null, mediaRef: "4775760717",
      providerType: "video", durationMs: 12500, width: 1080, height: 1920, byteSize: 73400320,
      createdAtPlatform: "2026-01-20T19:11:52.000Z", missingSince: null, lastFullWalkAt: null,
    });
    expect(partial.conclusion.blockers).toContain("vault_inventory_unproven");

    // A filtered walk proves nothing; a complete unfiltered latest walk does.
    await job("completed", { limit: "50", offset: "0", type: "video" }, "2026-02-02T00:00:00Z");
    expect((await read()).conclusion.blockers).toContain("vault_inventory_unproven");
    await job("completed", { limit: "50", offset: "0" }, "2026-02-03T00:00:00Z");
    const proven = await read();
    expect(proven.conclusion.blockers).not.toContain("vault_inventory_unproven");
    expect(proven.items[0]!.fields.lastFullWalkAt).toBe("2026-02-03T00:00:00.000Z");
  });
});
