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
    expect(body.items[0].windowCovered).toBe(false);
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
