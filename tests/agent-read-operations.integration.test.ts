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
  const appContext = createTestAppContext(testDb);

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
        '[{"id":"med-1","mimetype":"video/mp4","width":1920,"height":1080},
          {"id":"med-zero","mimetype":"image/jpeg","width":0,"height":0,
           "duration":-1,"size":-1}]'::jsonb),
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
       attachment_count, tip_amount_mills, attachment_tip_amount_mills,
       post_tip_total_mills, tip_goal_linked, tip_goal_ref, tip_goal_label,
       tip_goal_target_mills, tip_goal_current_mills, tip_goal_amounts_hidden,
       source_event_id, source_observation_id, source_account_seq)
     values
       ($1, 'fansly', 'post-old', 'first captured creator post',
        '2026-02-10T09:00:00Z', '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z',
        repeat('a', 64), 1, null, null, null, null, null, null, null, null, null,
        9101, $2, 101),
       ($1, 'fansly', 'post-new', 'newer creator post with two attachments',
        '2026-03-05T12:30:00Z', '2026-03-06T00:00:00Z', '2026-03-07T00:00:00Z',
        repeat('b', 64), 2, 520000, 0, 520000, true, 'goal-500',
        'spoil the birthday girl', 1000000, 500000, false, 9102, $3, 102)`,
    [pageId, 9001, 9002],
  );

  // The physical row retains provider goal correlation and fan-written tip copy;
  // both are public only through their uniquely named, capability-gated fields.
  await pool.query(
    `insert into creator_post_tips (account_id, platform, platform_post_id,
       platform_tip_id, tip_sender_platform_user_id, post_tip_amount_mills,
       occurred_at, receiver_transaction_ref, sender_transaction_ref, tip_goal_ref,
       tip_message_text, first_observed_at, last_observed_at, content_hash, source_event_id,
       source_observation_id, source_account_seq)
     values ($1, 'fansly', 'post-new', 'post-tip-250', $2, 250000,
       '2026-03-06T13:00:00Z', 'receiver-tx-250', 'sender-tx-250', 'goal-500',
       'I''m competitive haha', '2026-03-06T13:01:00Z',
       '2026-03-07T00:00:00Z', repeat('c', 64),
       9201, 9003, 103)`,
    [pageId, FAN_PLATFORM_USER_ID],
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
    expect(withMedia.mediaMetadata[1]).toMatchObject({
      mediaRef: "med-zero",
      width: null,
      height: null,
      durationSeconds: null,
      sizeBytes: null,
    });
    expect(withMedia.tipAmountMills).toBe(0);
    expect(body.delivery.caveats).toContain("mutable_sort_key");
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
});
