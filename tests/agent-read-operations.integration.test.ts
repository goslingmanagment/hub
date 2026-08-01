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
 * The Agent Read Plane against REAL rows.
 *
 * The isolation suite proves the refusals; this one proves the reads: every
 * statement the plane issues actually runs, the transcript union dedups and
 * dominates tombstones, search hits the FTS expression, the dataset registry
 * resolves to real columns, and the money a fan spent comes back as INTEGER
 * mills from BIGINT columns without a BigInt ever reaching `JSON.stringify`.
 *
 * The fixture is the shape of the original failure: a Fansly thread whose stored
 * messages begin in FEBRUARY, and a January transaction that proves the fan was
 * there. Asking about January must return nothing from the message plane, the
 * payment from the money plane, and blockers explaining the difference.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN = `${AGENT_KEY_TOKEN_PREFIX}operations-suite-token`;

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let pageId = 0;

const FAN_PLATFORM_USER_ID = "438766025723355136";
const FAN_USERNAME = "user438765948262952961";
const CONVERSATION_REF = "810272281019305984";

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
  await insertAgentKey(testDb.db, {
    name: "operations",
    keyPrefix: TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(TOKEN),
    capabilities: [
      "read:messages",
      "read:money",
      "read:datasets",
      "read:observations_envelope",
    ],
    pageIds: [pageId],
    dailyRequestBudget: 5000,
    dailyRowBudget: 500_000,
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: owner?.id ?? null,
  });
  await setConfigOverride(testDb.db, {
    key: "agentReadPlaneMode",
    value: "full",
    userId: owner?.id ?? null,
    groupId: randomUUID(),
  });

  await seedFixture();

  await server?.close();
  server = await buildApiServer(appContext);
  await server.ready();
});

afterEach(async () => {
  await server?.close();
  server = null;
});

async function seedFixture() {
  const pool = testDb!.pool;
  const { rows: fanRows } = await pool.query<{ id: string }>(
    `insert into fans (platform, platform_user_id, username, display_name, first_seen_at)
     values ('fansly', $1, $2, 'Rick', '2026-01-05T00:00:00Z') returning id`,
    [FAN_PLATFORM_USER_ID, FAN_USERNAME],
  );
  const fanId = Number(fanRows[0]!.id);

  // The historical username: the slug in the profile URL is THIS, not the id.
  await pool.query(
    `insert into fan_username_aliases (fan_id, username, first_seen_at, last_seen_at)
     values ($1, $2, '2026-01-05T00:00:00Z', '2026-02-01T00:00:00Z')`,
    [fanId, "rick_old_handle"],
  );
  await pool.query(
    `insert into page_fans (fan_id, platform_account_id, total_creator_net_mills, is_subscriber,
       subscriber_since, last_transaction_at, last_seen_at)
     values ($1, $2, 100000, true, '2026-01-10T00:00:00Z', '2026-01-23T00:00:00Z',
       '2026-03-01T00:00:00Z')`,
    [fanId, pageId],
  );
  await pool.query(
    `insert into fan_spend_lifetime (platform_account_id, fan_id, gross_amount_mills,
       creator_net_amount_mills, last_transaction_at)
     values ($1, $2, 100000, 80000, '2026-01-23T00:00:00Z')`,
    [pageId, fanId],
  );

  // The payment that answers the question the message plane cannot.
  await pool.query(
    `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type,
       canonical_type, transaction_state, raw_status, gross_amount_mills,
       source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills,
       occurred_at, source, currency)
     values ($1, $2, 'tx-jan-100', 'tip', 'tip', 'posted', 'ok', 100000, 100000, 80000, 20000,
       '2026-01-23T12:00:00Z', 'fansly:rest', 'USD')`,
    [pageId, fanId],
  );
  await pool.query(
    `insert into fan_spend_daily (platform_account_id, fan_id, business_date, canonical_type,
       transaction_state, transaction_count, gross_amount_mills, creator_net_amount_mills,
       last_transaction_at)
     values ($1, $2, '2026-01-23', 'tip', 'posted', 1, 100000, 80000, '2026-01-23T12:00:00Z')`,
    [pageId, fanId],
  );

  const { rows: threadRows } = await pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id,
       partner_platform_user_id, stored_message_count, message_coverage_status, last_message_at,
       oldest_stored_message_id, newest_stored_message_id)
     values ($1, $2, $3, $4, 2, 'complete', '2026-03-02T00:00:00Z', 'm-1', 'm-3') returning id`,
    [pageId, fanId, CONVERSATION_REF, FAN_PLATFORM_USER_ID],
  );
  const threadId = Number(threadRows[0]!.id);

  // The archive begins in MARCH: January is simply not there, and the whole
  // point is that the answer says so rather than returning a bare empty list.
  await pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref,
       fan_native_id, sender_role, is_sent_by_me, occurred_at, text_plain, price_mills,
       tip_amount_mills, media_metadata)
     values
       ($1, 'fansly', $2, 'm-1', $3, 'fan', false, '2026-03-01T10:00:00Z',
        'did you send the custom video yet', null, 0, '[]'::jsonb),
       ($1, 'fansly', $2, 'm-2', $3, 'model', true, '2026-03-01T11:00:00Z',
        'yes baby, sending the custom now', null, 0,
        '[{"id":"med-1","mimetype":"video/mp4","width":1920,"height":1080}]'::jsonb),
       ($1, 'fansly', $2, 'm-3', $3, 'fan', false, '2026-03-02T09:00:00Z',
        'deleted later', null, 0, '[]'::jsonb)`,
    [pageId, CONVERSATION_REF, FAN_PLATFORM_USER_ID],
  );
  // A tombstone in the hot table must dominate the archive copy.
  await pool.query(
    `insert into page_dm_messages (conversation_id, platform_account_id, platform_message_id,
       sender_platform_user_id, sender_role, created_at, content, deleted_at)
     values ($1, $2, 'm-3', $3, 'fan', '2026-03-02T09:00:00Z', 'deleted later',
       '2026-03-03T00:00:00Z')`,
    [threadId, pageId, FAN_PLATFORM_USER_ID],
  );
  // ... and the SAME ref in the archive must dedup to one row, not two.
  await pool.query(
    `insert into page_dm_messages (conversation_id, platform_account_id, platform_message_id,
       sender_platform_user_id, sender_role, created_at, content)
     values ($1, $2, 'm-1', $3, 'fan', '2026-03-01T10:00:00Z',
       'did you send the custom video yet')`,
    [threadId, pageId, FAN_PLATFORM_USER_ID],
  );

  await pool.query(
    `insert into page_sync_states (page_id, stream, status, cadence_seconds, slot_offset_seconds,
       succeeded_at)
     values ($1, 'dm_messages', 'idle', 86400, 0, '2026-03-05T00:00:00Z')`,
    [pageId],
  );

  // Operator-written free text about this fan: the same disclosure class as a
  // transcript, and the material #3 and #10 must not serve without a trail.
  await pool.query(
    `insert into fan_notes (fan_id, platform_account_id, body, created_at)
     values ($1, $2, 'paid for the january custom, chase the delivery',
       '2026-02-01T00:00:00Z')`,
    [fanId, pageId],
  );

  // Creator posts are a current-head projection over captured observations.
  // Two publication dates make the default ordering and the page-wide capture
  // floor independently visible: an exact-ref filter must not move the floor.
  await pool.query(
    `insert into creator_posts (account_id, platform, platform_post_id, text_plain,
       published_at, first_observed_at, last_observed_at, content_hash,
       attachment_count, source_event_id, source_observation_id, source_account_seq)
     values
       ($1, 'fansly', 'post-old', 'first captured creator post',
        '2026-02-10T09:00:00Z', '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z',
        repeat('a', 64), 1, 9101, $2, 101),
       ($1, 'fansly', 'post-new', 'newer creator post with two attachments',
        '2026-03-05T12:30:00Z', '2026-03-06T00:00:00Z', '2026-03-07T00:00:00Z',
        repeat('b', 64), 2, 9102, $3, 102)`,
    [pageId, 9001, 9002],
  );
}

function agentGet(url: string) {
  return server!.inject({ method: "GET", url, headers: { authorization: `Bearer ${TOKEN}` } });
}

function agentPost(url: string, payload: Record<string, unknown>) {
  return server!.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${TOKEN}` },
    payload,
  }) as ReturnType<typeof agentGet>;
}

const JANUARY = "from=2026-01-08T00:00:00Z&to=2026-01-20T00:00:00Z";
const MARCH = "from=2026-03-01T00:00:00Z&to=2026-03-10T00:00:00Z";

describe("[sync-critical] agent read plane operations", () => {
  it("#2 resolves a profile SLUG that is really a username", async () => {
    // The lesson the production gate paid for: the slug looks like an id and is
    // not one; the fan's platform_user_id is a different number entirely.
    const response = await agentPost("/api/v1/agent/resolve", {
      inputs: [{ raw: `https://fansly.com/${FAN_USERNAME}/posts`, hint: "auto" }],
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items[0].normalized).toContain(FAN_USERNAME);
    const candidate = body.items[0].candidates[0];
    expect(candidate.platformUserId).toBe(FAN_PLATFORM_USER_ID);
    expect(candidate.matchKind).toBe("username");
    // The `user` prefix is NEVER stripped: stripping it is what produced the
    // false "no such fan". Every tried form is reported, and none of them is the
    // slug with its prefix removed.
    expect(body.items[0].normalized).not.toContain(FAN_USERNAME.replace(/^user/, ""));
  });

  it("#2 also resolves the historical alias", async () => {
    const response = await agentPost("/api/v1/agent/resolve", {
      inputs: [{ raw: "rick_old_handle", hint: "auto" }],
    });
    const candidate = response.json().items[0].candidates[0];
    expect(candidate.platformUserId).toBe(FAN_PLATFORM_USER_ID);
    expect(candidate.matchKind).toBe("alias");
  });

  it("#3 answers the money question the message plane cannot", async () => {
    const response = await agentGet(`/api/v1/agent/people/fansly/${FAN_PLATFORM_USER_ID}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.identity.username).toBe(FAN_USERNAME);
    // INTEGER mills out of BIGINT columns, no BigInt anywhere near the wire.
    expect(body.money.lifetime.grossMills).toBe(100_000);
    expect(body.money.lifetime.netMills).toBe(80_000);
    expect(body.money.byType).toEqual([expect.objectContaining({
      transactionType: "tip",
      transactionState: "posted",
      grossMills: 100_000,
    })]);
    expect(body.memberships[0].lifetimeSpendMills).toBe(100_000);
    expect(body.identity.aliases.map((alias: { value: string }) => alias.value))
      .toContain("rick_old_handle");
  });

  it("#4 puts the January payment on the timeline", async () => {
    // The payment landed on the 23rd, so the window is the whole month: the
    // point of the operation is that the money lane answers when the message
    // lane cannot.
    const response = await agentGet(
      `/api/v1/agent/people/fansly/${FAN_PLATFORM_USER_ID}/timeline`
      + "?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z",
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const money = body.items.filter((item: { lane: string }) => item.lane === "money");
    expect(money).toHaveLength(1);
    expect(money[0].kind).toBe("tip.received");
    expect(money[0].grossMills).toBe(100_000);
    // The message lane is empty for January, and the conclusion says why.
    expect(body.items.filter((item: { lane: string }) => item.lane === "messages")).toEqual([]);
    expect(body.conclusion.blockers.length).toBeGreaterThan(0);
  });

  it("#5 lists the thread with its raw coverage status and retention limit", async () => {
    const response = await agentGet("/api/v1/agent/threads");
    expect(response.statusCode).toBe(200);
    const item = response.json().items[0];
    expect(item.conversationRef).toBe(CONVERSATION_REF);
    // `complete` is the RAW column and does NOT mean complete; the suffix is the
    // whole point of the field's name.
    expect(item.messageCoverageStatusRaw).toBe("complete");
    // A lifetime spender gets the deeper Fansly retention limit.
    expect(item.retentionLimit).toBe(1000);
    // The inventory does not pay for a per-thread floor scan; #6 and #8 establish
    // the real floor for a named thread.
    expect(item.captureFloor).toEqual({ at: null, kind: "unknown" });
    expect(response.json().delivery.matchedInScope).toEqual({
      value: 1,
      exact: true,
      countBasis: "post_dedup",
    });
  });

  it("#6 dedups, dominates tombstones and serves integer mills", async () => {
    const response = await agentGet(
      `/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/messages?${MARCH}`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const refs = body.items.map((item: { messageRef: string }) => item.messageRef);
    // m-1 exists in TWO stores and appears once; m-3 is tombstoned in the hot
    // table and is still returned, marked deleted, because a deletion is a fact.
    expect(refs).toEqual(["m-1", "m-2", "m-3"]);
    const deleted = body.items.find((item: { messageRef: string }) => item.messageRef === "m-3");
    expect(deleted.state).toBe("deleted");
    expect(deleted.deletedAt).not.toBeNull();
    const withMedia = body.items.find((item: { messageRef: string }) => item.messageRef === "m-2");
    expect(withMedia.mediaMetadata[0]).toMatchObject({ mediaRef: "med-1", width: 1920 });
    expect(withMedia.tipAmountMills).toBe(0);
    expect(body.delivery.caveats).toContain("mutable_sort_key");
  });

  it("#6 excludes tombstones when the caller opts out", async () => {
    const response = await agentGet(
      `/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/messages?${MARCH}&includeDeleted=false`,
    );
    const refs = response.json().items.map((item: { messageRef: string }) => item.messageRef);
    expect(refs).toEqual(["m-1", "m-2"]);
  });

  it("#6 writes an audit row on every transcript read", async () => {
    await agentGet(`/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/messages?${MARCH}`);
    const { rows } = await testDb!.pool.query<{
      operation: string;
      verbatim_text: boolean;
      request_summary: Record<string, unknown>;
    }>("select operation, verbatim_text, request_summary from agent_read_audit");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operation).toBe("agentThreadMessages");
    expect(rows[0]!.verbatim_text).toBe(true);
    // Structured facts only: no free-form user text ever reaches this table.
    expect(Object.keys(rows[0]!.request_summary).sort()).toEqual([
      "cursorConsumed",
      "limit",
      "planeMode",
      "platform",
      "returned",
      "windowFrom",
      "windowTo",
    ]);
  });

  it("#6 answers January with an empty list AND a reason", async () => {
    // The regression fixture. Never a bare [].
    const response = await agentGet(
      `/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/messages?${JANUARY}`
      + "&claimFields=textPlain&claimTargets=all_in_scope",
    );
    const body = response.json();
    expect(body.items).toEqual([]);
    // The floor is MARCH (the archive begins there), the window is January, and
    // the answer says exactly that instead of returning a bare [].
    expect(body.capture.planes.find((plane: { plane: string }) =>
      plane.plane === "message_archive").captureFloor).toEqual({
      at: "2026-03-01T10:00:00.000Z",
      kind: "oldest_stored_row",
    });
    expect(body.conclusion.blockers).toContain("window_before_capture_floor");
    expect(body.capture.gaps[0].kind).toBe("before_capture_floor");
    expect(body.capture.gaps[0].remedy.kind).toBe("hydration_request");
  });

  it("#7 finds a message through the FTS index and can withhold the snippet", async () => {
    const without = await agentPost("/api/v1/agent/search/messages", {
      q: "custom",
      from: "2026-03-01T00:00:00Z",
      to: "2026-03-10T00:00:00Z",
      claim: { fields: ["textPlain"], targets: "all_in_scope" },
    });
    expect(without.statusCode).toBe(200);
    const body = without.json();
    expect(body.backend).toBe("fts");
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0].snippet).toBeNull();
    expect(body.delivery.nextCursor).toBeNull();
    // Two caveats are ALWAYS true, so the array is never empty.
    expect(body.caveats).toContain("text_search_misses_media_only_messages");
    expect(body.caveats).toContain("text_search_is_exact_form_only");
    // Two of its planes have no text index at all, and the answer says so rather
    // than letting a miss read as an absence.
    expect(body.conclusion.blockers).toContain("plane_not_indexed");

    const withSnippet = await agentPost("/api/v1/agent/search/messages", {
      q: "custom",
      from: "2026-03-01T00:00:00Z",
      to: "2026-03-10T00:00:00Z",
      includeSnippet: true,
    });
    expect(withSnippet.json().items[0].snippet).toContain("custom");
    const { rows } = await testDb!.pool.query<{ operation: string; request_summary: Record<string, unknown> }>(
      "select operation, request_summary from agent_read_audit where operation = 'agentSearchMessages'",
    );
    expect(rows).toHaveLength(1);
    // The query text enters as a DIGEST and a length, never verbatim.
    expect(rows[0]!.request_summary.qSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.request_summary.qLength).toBe(6);
  });

  it("#8 probes coverage per scope, with the journal floor", async () => {
    const response = await agentGet(`/api/v1/agent/coverage?${JANUARY}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].conversationRef).toBe(CONVERSATION_REF);
    // `windowCovered` used to sit on the item: "no known blockers" dressed up as
    // a coverage verdict. The verdict IS `blockers`, so the field is gone.
    expect("windowCovered" in body.items[0]).toBe(false);
    expect(body.items[0].blockers).toContain("window_before_capture_floor");
    expect(body.items[0].planes.length).toBeGreaterThan(0);
    expect(body.journalFloor.observationsFirstReceivedAt).toBeNull();
  });

  it("#10 queries several datasets through the registry", async () => {
    const window = { from: "2026-01-01T00:00:00Z", to: "2026-04-01T00:00:00Z" };
    const transactions = await agentPost(
      "/api/v1/agent/pages/lora-2/datasets/transactions/query",
      { ...window, filters: [{ field: "transactionType", op: "eq", value: "tip" }] },
    );
    expect(transactions.statusCode).toBe(200);
    const txBody = transactions.json();
    expect(txBody.items).toHaveLength(1);
    // Integer mills on the wire, out of a BIGINT column, via the safe guard.
    expect(txBody.items[0].fields.grossMills).toBe(100_000);
    expect(txBody.items[0].fanPlatformUserId).toBe(FAN_PLATFORM_USER_ID);

    for (const dataset of [
      "fan_memberships",
      "dm_threads",
      "fan_spend_daily",
      "fan_aliases",
      "sync_streams",
      "subscriptions",
      "follows",
      "followers_daily",
      "fan_notes",
    ]) {
      const response = await agentPost(
        `/api/v1/agent/pages/lora-2/datasets/${dataset}/query`,
        window,
      );
      expect(response.statusCode, dataset).toBe(200);
      expect(response.json().datasetRef, dataset).toBe(dataset);
    }
  });

  it("#10 serves creator posts with honest capture and lineage", async () => {
    const { rows: postObservationRows } = await testDb!.pool.query<{ id: string }>(
      `insert into observations (source, producer, platform, account_id, kind, payload,
         payload_hash, idempotency_key, observed_at, received_at, parse_version)
       values
         ('pull', 'fansly:rest', 'fansly', $1, 'posts',
          '{"id":"post-old"}'::jsonb, sha256(convert_to('post-old', 'UTF8')),
          'agent-post-old', '2026-03-01T00:00:00Z', '2026-03-01T00:00:01Z', 1),
         ('pull', 'fansly:rest', 'fansly', $1, 'posts',
          '{"id":"post-new"}'::jsonb, sha256(convert_to('post-new', 'UTF8')),
          'agent-post-new', '2026-03-06T00:00:00Z', '2026-03-06T00:00:01Z', 1)
       returning id::text`,
      [pageId],
    );
    await testDb!.pool.query(
      `update creator_posts
       set source_observation_id = case platform_post_id
         when 'post-old' then $2::bigint else $3::bigint end
       where account_id = $1`,
      [pageId, postObservationRows[0]!.id, postObservationRows[1]!.id],
    );

    const request = {
      from: "2026-02-01T00:00:00Z",
      to: "2026-04-01T00:00:00Z",
      claim: {
        fields: [
          "postRef",
          "postText",
          "publishedAt",
          "firstObservedAt",
          "lastObservedAt",
          "attachmentCount",
        ],
        targets: "all_in_scope",
      },
    };
    const response = await agentPost(
      "/api/v1/agent/pages/lora-2/datasets/posts/query",
      request,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();

    // Default order is publication time descending; post copy is served
    // verbatim through the existing generic dataset operation.
    expect(body.items.map((item: { fields: { postRef: string } }) => item.fields.postRef))
      .toEqual(["post-new", "post-old"]);
    expect(Object.keys(body.items[0].fields).sort()).toEqual([
      "attachmentCount",
      "firstObservedAt",
      "lastObservedAt",
      "platform",
      "postRef",
      "postText",
      "publishedAt",
    ]);
    expect(body.items[0].fields).toMatchObject({
      platform: "fansly",
      postRef: "post-new",
      postText: "newer creator post with two attachments",
      publishedAt: "2026-03-05T12:30:00.000Z",
      firstObservedAt: "2026-03-06T00:00:00.000Z",
      lastObservedAt: "2026-03-07T00:00:00.000Z",
      attachmentCount: 2,
    });
    expect(body.items[0].fieldStates.postText.state).toBe("present");
    expect(body.items[0].provenance).toMatchObject({
      ingestPaths: ["fansly_pull"],
      convergence: "converging",
    });
    expect(body.items[0].provenance.observationRef).toEqual(expect.any(Number));

    const postsPlane = body.capture.planes.find(
      (plane: { plane: string }) => plane.plane === "creator_posts",
    );
    expect(postsPlane).toMatchObject({
      state: "read",
      captureFloor: {
        at: "2026-02-10T09:00:00.000Z",
        kind: "oldest_stored_row",
      },
    });
    expect(body.capture.gaps).toContainEqual(expect.objectContaining({
      kind: "before_capture_floor",
      plane: "creator_posts",
      to: "2026-02-10T09:00:00.000Z",
      remedy: {
        kind: "none",
        reason: "journal_before_capture_start",
      },
    }));
    expect(body.conclusion.blockers).toContain("window_before_capture_floor");

    // Filtering to one exact ref changes the result set, never the evidence
    // about when this page's post capture begins. Selecting the oldest row keeps
    // observedRowFloor equal too, so the full capture envelope is byte-identical.
    const exact = await agentPost(
      "/api/v1/agent/pages/lora-2/datasets/posts/query",
      {
        ...request,
        filters: [{ field: "postRef", op: "eq", value: "post-old" }],
      },
    );
    expect(exact.statusCode).toBe(200);
    const exactBody = exact.json();
    expect(exactBody.items.map((item: { fields: { postRef: string } }) => item.fields.postRef))
      .toEqual(["post-old"]);
    expect(JSON.stringify(exactBody.capture)).toBe(JSON.stringify(body.capture));

    const catalog = (await agentGet("/api/v1/agent/capabilities")).json();
    expect(catalog.datasets.find((entry: { dataset: string }) => entry.dataset === "posts"))
      .toMatchObject({
        availability: "available",
        platforms: ["fansly", "onlyfans"],
        moneyBearing: false,
        requiredCapabilities: ["read:datasets", "read:messages"],
        captureState: "unknown",
        defaultSort: "publishedAt",
      });
    expect(catalog.planes.find((plane: { plane: string }) => plane.plane === "creator_posts"))
      .toMatchObject({ enabled: true, textSearchIndexed: false });

    const audits = await testDb!.pool.query<{
      verbatim_text: boolean;
      request_summary: Record<string, unknown>;
    }>(
      `select verbatim_text, request_summary from agent_read_audit
       where operation = 'agentDatasetQuery' order by id`,
    );
    expect(audits.rows).toHaveLength(2);
    expect(audits.rows.every((row) => row.verbatim_text)).toBe(true);
    expect(audits.rows.every((row) => row.request_summary.datasetRef === "posts")).toBe(true);
  });

  it("#10 summarizes matching Hub transactions in one exhausted read", async () => {
    // A different type outside the requested window proves the capture floor is
    // page-wide and filter-independent, not the oldest row the summary matched.
    await testDb!.pool.query(
      `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type,
         canonical_type, transaction_state, raw_status, gross_amount_mills,
         source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills,
         occurred_at, source, currency)
       select $1, f.id, 'tx-jan-sub', 'subscription', 'subscription', 'posted', 'ok',
         5000, 5000, 4000, 1000, '2026-01-10T00:00:00Z', 'fansly:rest', 'USD'
       from fans f where f.platform_user_id = $2`,
      [pageId, FAN_PLATFORM_USER_ID],
    );
    const response = await agentPost(
      "/api/v1/agent/pages/lora-2/datasets/transactions/query",
      {
        from: "2026-01-23T12:00:00Z",
        to: "2026-02-01T00:00:00Z",
        summary: true,
        filters: [{ field: "transactionType", op: "eq", value: "tip" }],
      },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toEqual([]);
    expect(body.summary).toEqual({
      basis: "matching_rows_in_hub",
      matchedRows: 1,
      groups: [{
        currency: "USD",
        transactionCount: 1,
        grossMills: 100_000,
        netMills: 80_000,
        feeMills: 20_000,
      }],
    });
    expect(body.delivery).toMatchObject({
      returned: 1,
      nextCursor: null,
      snapshotExhausted: true,
    });
    expect(body.capture.planes.find((plane: { plane: string }) =>
      plane.plane === "transactions").captureFloor).toEqual({
      at: "2026-01-10T00:00:00.000Z",
      kind: "oldest_stored_row",
    });
    expect(body.conclusion.blockers).toEqual([]);
  });

  it("#10 refuses a field outside the dataset's allowlist, before any SQL", async () => {
    const response = await agentPost(
      "/api/v1/agent/pages/lora-2/datasets/transactions/query",
      {
        from: "2026-01-01T00:00:00Z",
        to: "2026-04-01T00:00:00Z",
        filters: [{ field: "secretColumn", op: "eq", value: "x" }],
      },
    );
    expect(response.statusCode).toBe(400);
  });

  it("#10 refuses a PLANNED dataset at the boundary", async () => {
    const response = await agentPost(
      "/api/v1/agent/pages/lora-2/datasets/purchase_history/query",
      { from: "2026-01-01T00:00:00Z", to: "2026-04-01T00:00:00Z" },
    );
    expect(response.statusCode).toBe(400);
  });

  it("reads make ZERO outgoing HTTP calls", async () => {
    // Structural, not aspirational: a read must never cost a vendor credit or
    // mutate anything on the platform. `globalThis.fetch` is replaced for the
    // duration and a single call fails the test.
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = ((input: unknown) => {
      calls.push(String(input));
      return Promise.reject(new Error("the agent read plane must not egress"));
    }) as typeof globalThis.fetch;
    try {
      const window = { from: "2026-01-01T00:00:00Z", to: "2026-04-01T00:00:00Z" };
      expect((await agentGet("/api/v1/agent/capabilities")).statusCode).toBe(200);
      expect((await agentGet("/api/v1/agent/threads")).statusCode).toBe(200);
      expect((await agentGet(`/api/v1/agent/coverage?${JANUARY}`)).statusCode).toBe(200);
      expect((await agentGet(
        `/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/messages?${MARCH}`,
      )).statusCode).toBe(200);
      expect((await agentGet(
        `/api/v1/agent/people/fansly/${FAN_PLATFORM_USER_ID}`,
      )).statusCode).toBe(200);
      expect((await agentPost("/api/v1/agent/search/messages", {
        q: "custom",
        ...window,
      })).statusCode).toBe(200);
      expect((await agentPost(
        "/api/v1/agent/pages/lora-2/datasets/transactions/query",
        window,
      )).statusCode).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toEqual([]);
  });

  it("#3 and #10 agree about a subscription that ENDED", async () => {
    await testDb!.pool.query(
      `insert into page_subscriptions (platform_subscription_id, platform_account_id, fan_id,
         raw_status, canonical_status, price_mills, renew_price_mills, source_created_at, ends_at,
         is_current)
       select 'sub-ended', $1, f.id, 3, 'ended', 5000, 5000, '2026-01-01T00:00:00Z',
         '2026-02-01T00:00:00Z', false
       from fans f where f.platform_user_id = $2`,
      [pageId, FAN_PLATFORM_USER_ID],
    );

    const person = (await agentGet(`/api/v1/agent/people/fansly/${FAN_PLATFORM_USER_ID}`)).json();
    // `ended` used to fall through to `unknown` here while the dataset projection
    // called it `expired`: one subscription, two states, depending on which
    // operation was asked.
    expect(person.subscriptions[0].subscriptionState).toBe("expired");

    const dataset = await agentPost(
      "/api/v1/agent/pages/lora-2/datasets/subscriptions/query",
      { from: "2026-01-01T00:00:00Z", to: "2026-04-01T00:00:00Z" },
    );
    expect(dataset.json().items[0].fields.subscriptionState).toBe("expired");
  });

  it("a cursor round-trips a real traversal", async () => {
    const first = await agentGet(
      `/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/messages?${MARCH}&limit=1`,
    );
    const body = first.json();
    expect(body.items).toHaveLength(1);
    expect(body.delivery.nextCursor).not.toBeNull();
    expect(body.delivery.cappedBy).toBe("limit");

    const second = await agentGet(
      `/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/messages`
      + `?cursor=${encodeURIComponent(body.delivery.nextCursor)}`,
    );
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.items[0].messageRef).not.toBe(body.items[0].messageRef);
    // A consumed cursor drops the caveat and takes the traversal BLOCKER.
    expect(secondBody.delivery.caveats).not.toContain("mutable_sort_key");
    expect(secondBody.conclusion.blockers).toContain("mutable_sort_key_traversal");
  });
});

/**
 * Review round 3: the two FALSE-ABSENCE defects and their neighbours.
 *
 * Every test here fails when its fix is reverted, and the two false-absence ones
 * assert the ENVELOPE and the BODY agree: never an empty result next to a
 * predicate the response says it did not apply, and never a window reaching back
 * past the capture floor without a gap that names it.
 */
describe("[sync-critical] agent read plane: review round 3", () => {
  it("P1-1 an unsupported filter is DROPPED from the query, not applied behind the report", async () => {
    // Fansly journals `attachments` unparsed, so `hasMedia` has nothing to filter
    // on. It used to reach the WHERE clause anyway: two of the three messages have
    // no media row, so `hasMedia=true` returned ONE message next to an envelope
    // saying the filter had not been applied — an answer an agent reads as "there
    // is no other media here".
    const response = await agentGet(
      `/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/messages?${MARCH}&hasMedia=true`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const predicate = body.predicates.find((entry: { name: string }) => entry.name === "hasMedia");
    expect(predicate).toMatchObject({
      requested: true,
      applied: false,
      reason: "unsupported_for_plane",
    });
    // THE AGREEMENT: the SQL genuinely did not narrow, so every message comes
    // back. A shorter list than the unfiltered read would mean the filter ran.
    expect(body.items.map((item: { messageRef: string }) => item.messageRef))
      .toEqual(["m-1", "m-2", "m-3"]);
    expect(body.delivery.matchedInScope.value).toBe(3);

    // `hasPrice` is the same story on this platform: not captured at all.
    const priced = await agentGet(
      `/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/messages?${MARCH}&hasPrice=true`,
    );
    const pricedBody = priced.json();
    expect(pricedBody.predicates.find((entry: { name: string }) => entry.name === "hasPrice"))
      .toMatchObject({ requested: true, applied: false, reason: "unsupported_for_plane" });
    expect(pricedBody.items).toHaveLength(3);
  });

  it("P1-2 #3 leaves an audit row when it serves CRM free text", async () => {
    const response = await agentGet(`/api/v1/agent/people/fansly/${FAN_PLATFORM_USER_ID}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().crm.notes[0].noteText).toContain("january custom");

    const { rows } = await testDb!.pool.query<{
      verbatim_text: boolean;
      request_summary: Record<string, unknown>;
      page_ids: number[];
    }>(
      `select verbatim_text, request_summary, page_ids from agent_read_audit
       where operation = 'agentPerson'`,
    );
    // Notes and summaries are operator-written prose: the same class as a
    // transcript, and #6 has always left a row for it.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verbatim_text).toBe(true);
    expect(rows[0]!.request_summary.returned).toBe(1);
    expect(Object.keys(rows[0]!.request_summary).sort())
      .toEqual(["planeMode", "platform", "returned"]);
  });

  it("P1-3 a verbatim DATASET is audited, and a non-verbatim one is not", async () => {
    const window = { from: "2026-01-01T00:00:00Z", to: "2026-04-01T00:00:00Z" };
    await agentPost("/api/v1/agent/pages/lora-2/datasets/transactions/query", window);
    const afterTransactions = await testDb!.pool.query<{ count: string }>(
      "select count(*)::text as count from agent_read_audit where operation = 'agentDatasetQuery'",
    );
    // Money is not prose: the dataset route audits verbatim TEXT, not every read.
    expect(afterTransactions.rows[0]!.count).toBe("0");

    const notes = await agentPost("/api/v1/agent/pages/lora-2/datasets/fan_notes/query", window);
    expect(notes.statusCode).toBe(200);
    expect(notes.json().items[0].fields.noteText).toContain("january custom");

    const { rows } = await testDb!.pool.query<{
      verbatim_text: boolean;
      request_summary: Record<string, unknown>;
    }>(
      `select verbatim_text, request_summary from agent_read_audit
       where operation = 'agentDatasetQuery'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verbatim_text).toBe(true);
    // Driven by the registry's `verbatimText` flag, so the dataset that earned the
    // row names itself.
    expect(rows[0]!.request_summary.datasetRef).toBe("fan_notes");
  });

  it("P1-4/P1-5 the journal floor is the GRANTED scope's, and a pre-floor window gaps", async () => {
    // A page OUTSIDE the key's grant, journaled since January. The key's own page
    // is journaled from March.
    const { rows: modelRows } = await testDb!.pool.query<{ model_id: string }>(
      "select model_id from pages where id = $1",
      [pageId],
    );
    const ungranted = await createFanslyPage(testDb!.db, {
      modelId: Number(modelRows[0]!.model_id),
      label: "lora-9",
    });
    const ungrantedPageId = ungranted!.id;
    await insertObservation(ungrantedPageId, "2026-01-05T00:00:00Z", "ungranted-january");
    await insertObservation(pageId, "2026-03-04T00:00:00Z", "granted-march");
    await setConfigOverride(testDb!.db, {
      key: "agentObservationsEnabled",
      value: "true",
      userId: null,
      groupId: randomUUID(),
    });

    // A window that STARTS before the granted floor and reaches past it.
    const spanning = await agentGet(
      "/api/v1/agent/observations?from=2026-02-01T00:00:00Z&to=2026-04-01T00:00:00Z",
    );
    expect(spanning.statusCode).toBe(200);
    const body = spanning.json();
    // The floor is MARCH — this key's own. January belongs to a page it cannot see
    // and used to supply the minimum, which hid the pre-capture condition.
    expect(body.capture.planes.find((plane: { plane: string }) =>
      plane.plane === "observations").captureFloor).toEqual({
      at: "2026-03-04T00:00:00.000Z",
      kind: "oldest_stored_row",
    });
    // THE AGREEMENT: the window reaches back before that floor, so the answer
    // carries the gap and the blocker instead of leaving February to read as empty.
    expect(body.capture.gaps.some((gap: { kind: string; to: string | null }) =>
      gap.kind === "before_capture_floor" && gap.to === "2026-03-04T00:00:00.000Z")).toBe(true);
    expect(body.conclusion.blockers).toContain("window_before_capture_floor");
    expect(body.items).toHaveLength(1);

    // A window entirely before the floor is empty BY CONSTRUCTION, and says so.
    const before = await agentGet(
      "/api/v1/agent/observations?from=2026-02-01T00:00:00Z&to=2026-02-28T00:00:00Z",
    );
    const beforeBody = before.json();
    expect(beforeBody.items).toEqual([]);
    expect(beforeBody.capture.planes.find((plane: { plane: string }) =>
      plane.plane === "observations")).toMatchObject({
      state: "not_read",
      reason: "journal_starts_after_window",
    });
    expect(beforeBody.capture.gaps.some((gap: { kind: string }) =>
      gap.kind === "before_capture_floor")).toBe(true);
  });

  it("P1-6 #8 names a conversation's floor even when the window starts AFTER it", async () => {
    // The archive for this thread starts at 10:00 on 1 March; the window starts an
    // hour later, so there is no gap to carry the date. The floor is still a known
    // fact and must still be in the answer.
    const response = await agentGet(
      "/api/v1/agent/coverage?from=2026-03-01T11:00:00Z&to=2026-03-10T00:00:00Z",
    );
    expect(response.statusCode).toBe(200);
    const item = response.json().items[0];
    expect(item.gaps).toEqual([]);
    expect(item.planes.find((plane: { plane: string }) => plane.plane === "message_archive"))
      .toMatchObject({
        state: "read",
        captureFloor: { at: "2026-03-01T10:00:00.000Z", kind: "oldest_stored_row" },
      });
  });

  it("P1-7 a spent row budget is refused, never served one row at a time", async () => {
    const owner = await createUser(testDb!.db, {
      username: "owner-round3",
      role: "owner",
      passwordHash: null,
    });
    const token = `${AGENT_KEY_TOKEN_PREFIX}round3-two-row-budget`;
    await insertAgentKey(testDb!.db, {
      name: "two-rows",
      keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(token),
      capabilities: ["read:messages"],
      pageIds: [pageId],
      dailyRequestBudget: 100,
      dailyRowBudget: 2,
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      createdBy: owner?.id ?? null,
    });
    const tinyGet = (url: string) =>
      server!.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

    const first = await tinyGet(
      `/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/messages?${MARCH}&limit=200`,
    );
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(2);
    expect(first.json().delivery.cappedBy).toBe("budget");

    // Zero allowance USED to be raised back to one row, so a spent key kept being
    // served forever, one row per request.
    const second = await tinyGet(
      `/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/messages?${MARCH}&limit=200`,
    );
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toBe("agent_budget_exhausted");

    const { rows } = await testDb!.pool.query<{ rows_returned: string }>(
      "select rows_returned::text as rows_returned from agent_key_usage_daily",
    );
    // The DB-backed ceiling is a BOUND: nothing above it, ever.
    expect(rows.every((row) => Number(row.rows_returned) <= 2)).toBe(true);
  });

  it("P1-7b a bundle is charged in full or refused, never served on a partial grant", async () => {
    // #3 cannot be clamped the way a page can: its size is a property of the fan,
    // not of a limit the caller chose. A key with three rows left used to receive
    // the whole card — identity, memberships, aliases, money, notes, threads —
    // while its counter rose by three.
    const owner = await createUser(testDb!.db, {
      username: "owner-bundle",
      role: "owner",
      passwordHash: null,
    });
    const token = `${AGENT_KEY_TOKEN_PREFIX}round3-bundle-budget`;
    await insertAgentKey(testDb!.db, {
      name: "bundle",
      keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(token),
      capabilities: ["read:messages", "read:money", "read:datasets"],
      pageIds: [pageId],
      dailyRequestBudget: 100,
      dailyRowBudget: 3,
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      createdBy: owner?.id ?? null,
    });

    const refused = await server!.inject({
      method: "GET",
      url: `/api/v1/agent/people/fansly/${FAN_PLATFORM_USER_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toBe("agent_budget_exhausted");
    // A request that served nothing costs nothing: the partial grant is handed
    // back rather than left on the counter.
    const spentByBundleKey = await testDb!.pool.query<{ rows_returned: string }>(
      `select u.rows_returned::text as rows_returned
       from agent_key_usage_daily u join agent_keys k on k.id = u.agent_key_id
       where k.name = 'bundle'`,
    );
    expect(spentByBundleKey.rows[0]?.rows_returned ?? "0").toBe("0");

    // With allowance to spare, the counter equals what the card ACTUALLY carried.
    const served = (await agentGet(`/api/v1/agent/people/fansly/${FAN_PLATFORM_USER_ID}`)).json();
    const carried = 1
      + served.identity.aliases.length
      + served.identity.flags.length
      + served.memberships.length
      + served.money.byType.length
      + served.subscriptions.length
      + served.crm.notes.length
      + served.crm.summaries.length
      + served.threads.length;
    const spent = await testDb!.pool.query<{ rows_returned: string }>(
      `select u.rows_returned::text as rows_returned
       from agent_key_usage_daily u join agent_keys k on k.id = u.agent_key_id
       where k.name = 'operations'`,
    );
    expect(Number(spent.rows[0]!.rows_returned)).toBe(carried);
  });

  it("P2g an inadmissible remedy names the REAL reason", async () => {
    // Hydration is OPEN and this key simply may not file a request. Telling the
    // operator to open a mode that is already open sends them to fix the wrong
    // thing, which is worse than naming no remedy at all.
    await setConfigOverride(testDb!.db, {
      key: "agentHydrationMode",
      value: "request_only",
      userId: null,
      groupId: randomUUID(),
    });
    const response = await agentGet(
      `/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/messages?${JANUARY}`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().capture.gaps[0].remedy).toMatchObject({
      kind: "hydration_request",
      admissible: false,
      reason: "capability_not_granted",
    });
  });

  it("P2a page 2 of a traversal keeps page 1's page SIZE", async () => {
    const first = (await agentGet(
      `/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/messages?${MARCH}&limit=1`,
    )).json();
    const second = await agentGet(
      `/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/messages`
      + `?cursor=${encodeURIComponent(first.delivery.nextCursor)}`,
    );
    // A cursor request may not re-send `limit`, so the schema default (50) used to
    // take over and the traversal changed shape after page 1.
    expect(second.json().items).toHaveLength(1);
    expect(second.json().delivery.nextCursor).not.toBeNull();
  });

  it("P2b observedRowFloor is the EARLIEST row returned, not the first one", async () => {
    const response = await agentPost("/api/v1/agent/search/messages", {
      q: "custom",
      from: "2026-03-01T00:00:00Z",
      to: "2026-03-10T00:00:00Z",
    });
    expect(response.statusCode).toBe(200);
    // Hits are dated; a hardcoded null threw the diagnostic away.
    expect(response.json().capture.observedRowFloor).toBe("2026-03-01T10:00:00.000Z");
  });

  it("P2d the reported search backend is the one that RAN", async () => {
    await testDb!.pool.query("create extension if not exists pg_trgm");
    await setConfigOverride(testDb!.db, {
      key: "agentSearchBackend",
      value: "fts_trgm",
      userId: null,
      groupId: randomUUID(),
    });
    const search = await agentPost("/api/v1/agent/search/messages", {
      q: "custom",
      from: "2026-03-01T00:00:00Z",
      to: "2026-03-10T00:00:00Z",
    });
    // The extension is present and the flag asks for trigram, but no statement on
    // this path uses one: the label follows the SQL, not the configuration.
    expect(search.json().backend).toBe("fts");
    expect((await agentGet("/api/v1/agent/capabilities")).json().contract.searchBackend)
      .toBe("fts");
  });
});

async function insertObservation(accountId: number, receivedAt: string, key: string) {
  await testDb!.pool.query(
    `insert into observations (source, producer, platform, account_id, kind, payload,
       payload_hash, idempotency_key, received_at, parse_version)
     values ('pull', 'fansly:rest', 'fansly', $1, 'dm_conversations', '{"items":[]}'::jsonb,
       sha256(convert_to($2, 'UTF8')), $2, $3, 1)`,
    [accountId, key, receivedAt],
  );
}
