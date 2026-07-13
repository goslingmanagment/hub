import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  listEventsSince,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  assignPageToUser,
  createUserAccount,
  issueChatterApiKey,
  issueDeviceToken,
} from "../apps/runtime/src/services/auth.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const MACHINE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_MACHINE_ID = "22222222-2222-4222-8222-222222222222";

let testDb: StartedTestDatabase | null = null;
let app: AppContext | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

async function loginOwnerCookie() {
  const response = await server!.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "dima", password: "owner-secret" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") {
    throw new Error("Expected owner session cookie");
  }
  return value.split(";")[0]!;
}

function harvestEvent(input?: {
  clientEventId?: string;
  machineId?: string;
  accountId?: string;
}) {
  return {
    clientEventId: input?.clientEventId ?? "33333333-3333-4333-8333-333333333333",
    kind: "harvest.messages",
    observedAt: "2026-07-13T10:00:00.000Z",
    payload: {
      table: "messages",
      machineId: input?.machineId ?? MACHINE_ID,
      ofapiAccountId: input?.accountId ?? "acct_harvest",
      row: {
        message_id: "message-1",
        chat_id: "fan-1",
        created_at: "2026-07-13T10:00:00.000Z",
        is_sent_by_me: 0,
        deleted: 0,
      },
    },
  };
}

async function bindHarvestCapability(input: {
  ownerCookie: string;
  username: string;
  tokenId: number;
  machineId: string | null;
}) {
  return server!.inject({
    method: "PATCH",
    url: `/api/v1/admin/users/${input.username}/device-tokens/${input.tokenId}/harvest-capability`,
    headers: { cookie: input.ownerCookie },
    payload: { machineId: input.machineId },
  });
}

async function postHarvest(token: string, event: ReturnType<typeof harvestEvent>) {
  return server!.inject({
    method: "POST",
    url: "/api/v1/ingest/observations",
    headers: {
      authorization: `Bearer ${token}`,
      "x-client-version": "harvest-0.1.41",
    },
    payload: { events: [event] },
  });
}

async function seedIdentity() {
  await createUserAccount(app!, {
    username: "dima",
    role: "owner",
    password: "owner-secret",
  }, { source: "test" });
  await createUserAccount(app!, { username: "alice", role: "chatter" }, { source: "test" });
  await createUserAccount(app!, { username: "bob", role: "chatter" }, { source: "test" });

  const model = await createModel(testDb!.db, { slug: "harvest", name: "Harvest" });
  if (!model) throw new Error("Failed to create harvest model");
  const page = await createOnlyFansPage(testDb!.db, { modelId: model.id, label: "harvest-of" });
  if (!page) throw new Error("Failed to create harvest page");
  await setPageOfapiAccountId(testDb!.db, {
    pageId: page.id,
    ofapiAccountId: "acct_harvest",
  });

  const aliceKey = await issueChatterApiKey(app!, {
    username: "alice",
    pageLabel: "harvest-of",
  }, { source: "test" });
  await assignPageToUser(app!, {
    username: "bob",
    pageLabel: "harvest-of",
  }, { source: "test" });

  const alice = await testDb!.pool.query<{ id: string }>(
    "select id::text from users where username = 'alice'",
  );
  const bob = await testDb!.pool.query<{ id: string }>(
    "select id::text from users where username = 'bob'",
  );
  const aliceToken = await issueDeviceToken(app!, {
    userId: Number(alice.rows[0]!.id),
    label: "alice-desktop",
  }, { source: "test" });
  const bobToken = await issueDeviceToken(app!, {
    userId: Number(bob.rows[0]!.id),
    label: "bob-desktop",
  }, { source: "test" });

  return { aliceKey, aliceToken, bobToken, page };
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb);
  server = await buildApiServer(app);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb || !server) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
});

describe("desktop harvest capability", () => {
  it("rejects harvest-version spoofing by ordinary API keys and device tokens", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const { aliceKey, aliceToken } = await seedIdentity();
    const event = harvestEvent();

    const viaApiKey = await postHarvest(aliceKey.key, event);
    expect(viaApiKey.statusCode).toBe(403);

    const viaOrdinaryDevice = await postHarvest(aliceToken.token, event);
    expect(viaOrdinaryDevice.statusCode).toBe(403);

    const stored = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observations where kind like 'harvest.%'",
    );
    expect(stored.rows).toEqual([{ n: "0" }]);

    // The capability is narrow: an ordinary device token keeps the normal
    // client-capture lane instead of losing all ingest access.
    const ordinary = await server.inject({
      method: "POST",
      url: "/api/v1/ingest/observations",
      headers: {
        authorization: `Bearer ${aliceToken.token}`,
        "x-client-version": "0.1.41",
      },
      payload: {
        events: [{
          clientEventId: "44444444-4444-4444-8444-444444444444",
          kind: "guard_audit",
          observedAt: "2026-07-13T10:01:00.000Z",
          payload: { decision: "allow" },
        }],
      },
    });
    expect(ordinary.statusCode).toBe(200);
    expect(ordinary.json()).toEqual({ accepted: 1, duplicates: 0 });
  });

  it("accepts only the owner-bound token and its exact machine identity", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const { aliceToken, page } = await seedIdentity();
    const ownerCookie = await loginOwnerCookie();

    // A chatter cannot mint its own capability through the owner route.
    const unprivilegedGrant = await server.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/alice/device-tokens/${aliceToken.id}/harvest-capability`,
      headers: { authorization: `Bearer ${aliceToken.token}` },
      payload: { machineId: MACHINE_ID },
    });
    expect(unprivilegedGrant.statusCode).toBe(403);

    const granted = await bindHarvestCapability({
      ownerCookie,
      username: "alice",
      tokenId: aliceToken.id,
      machineId: MACHINE_ID,
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toMatchObject({
      id: aliceToken.id,
      harvestMachineId: MACHINE_ID,
    });

    const accepted = await postHarvest(aliceToken.token, harvestEvent());
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ accepted: 1, duplicates: 0 });

    await runCanonicalization(app!);
    const events = await listEventsSince(testDb.db, { accountId: page.id, afterSeq: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.received",
      messageRef: "message-1",
    });

    const wrongMachine = await postHarvest(aliceToken.token, harvestEvent({
      clientEventId: "55555555-5555-4555-8555-555555555555",
      machineId: OTHER_MACHINE_ID,
    }));
    expect(wrongMachine.statusCode).toBe(400);
    expect(wrongMachine.json()).toMatchObject({ error: "invalid_ingest_event" });

    const stored = await testDb.pool.query<{
      actor: string;
      account: string | null;
      idempotency: string;
    }>(`
      select actor_principal_id::text as actor,
             account_id::text as account,
             idempotency_key as idempotency
      from observations where kind = 'harvest.messages'
    `);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.account).not.toBeNull();
    expect(stored.rows[0]!.idempotency).toBe(
      `${MACHINE_ID}:33333333-3333-4333-8333-333333333333`,
    );
  });

  it("deduplicates a crash-window retry after the machine capability moves principals", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const { aliceToken, bobToken } = await seedIdentity();
    const ownerCookie = await loginOwnerCookie();
    const event = harvestEvent();

    expect((await bindHarvestCapability({
      ownerCookie,
      username: "alice",
      tokenId: aliceToken.id,
      machineId: MACHINE_ID,
    })).statusCode).toBe(200);
    expect((await postHarvest(aliceToken.token, event)).json()).toEqual({
      accepted: 1,
      duplicates: 0,
    });

    // Emulate a row accepted by the pre-fix server: its immutable fact and key
    // were named by principal rather than machine. Rollout compatibility must
    // still recognize it after this release changes the key strategy.
    const alice = await testDb.pool.query<{ id: string }>(
      "select id::text from users where username = 'alice'",
    );
    const legacyKey = `${alice.rows[0]!.id}:${event.clientEventId}`;
    const newKey = `${MACHINE_ID}:${event.clientEventId}`;
    await testDb.pool.query(
      "update observation_keys set idempotency_key = $1 where source = 'client_capture' and idempotency_key = $2",
      [legacyKey, newKey],
    );
    await testDb.pool.query(
      "update observations set idempotency_key = $1 where source = 'client_capture' and idempotency_key = $2",
      [legacyKey, newKey],
    );

    // Simulate a new chatter signing into the same preserved Desktop DB. The
    // owner transfers that machine capability to the new token; the retry is
    // the identical deterministic event left after Core 2xx/local crash.
    expect((await bindHarvestCapability({
      ownerCookie,
      username: "bob",
      tokenId: bobToken.id,
      machineId: MACHINE_ID,
    })).statusCode).toBe(200);
    expect((await postHarvest(aliceToken.token, harvestEvent({
      clientEventId: "66666666-6666-4666-8666-666666666666",
    }))).statusCode).toBe(403);
    const retried = await postHarvest(bobToken.token, event);
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ accepted: 0, duplicates: 1 });

    const stored = await testDb.pool.query<{ n: string; actors: string }>(`
      select count(*)::text as n,
             count(distinct actor_principal_id)::text as actors
      from observations
      where kind = 'harvest.messages'
        and payload->>'machineId' = $1
    `, [MACHINE_ID]);
    expect(stored.rows).toEqual([{ n: "1", actors: "1" }]);
  });

  it("lets only the current device-token bearer revoke exactly itself", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const { aliceKey, aliceToken, bobToken } = await seedIdentity();
    const ownerCookie = await loginOwnerCookie();

    const viaApiKey = await server.inject({
      method: "DELETE",
      url: "/api/v1/auth/device-tokens/current",
      headers: { authorization: `Bearer ${aliceKey.key}` },
    });
    expect(viaApiKey.statusCode).toBe(403);

    const viaSession = await server.inject({
      method: "DELETE",
      url: "/api/v1/auth/device-tokens/current",
      headers: { cookie: ownerCookie },
    });
    expect(viaSession.statusCode).toBe(403);

    const revoked = await server.inject({
      method: "DELETE",
      url: "/api/v1/auth/device-tokens/current",
      headers: { authorization: `Bearer ${aliceToken.token}` },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ revoked: true });

    // The caller's credential is dead immediately; the sibling credential is
    // untouched, and the audit row commits with the revocation.
    expect((await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${aliceToken.token}` },
    })).statusCode).toBe(401);
    expect((await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${bobToken.token}` },
    })).statusCode).toBe(200);

    const rows = await testDb.pool.query<{
      id: string;
      revoked: boolean;
      reason: string | null;
    }>(`
      select id::text,
             revoked_at is not null as revoked,
             revoked_reason as reason
      from device_tokens
      order by id
    `);
    expect(rows.rows).toEqual([
      { id: String(aliceToken.id), revoked: true, reason: "self_revoked" },
      { id: String(bobToken.id), revoked: false, reason: null },
    ]);
    const audit = await testDb.pool.query<{ n: string }>(`
      select count(*)::text as n
      from audit_events
      where event_type = 'device_token.self_revoked'
        and target_user_id = (select id from users where username = 'alice')
    `);
    expect(audit.rows).toEqual([{ n: "1" }]);
  });
});
