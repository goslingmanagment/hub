import { fixtureUserId } from "./helpers/user-identity.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import {
  assignPageToUser,
  createUserAccount,
} from "../apps/runtime/src/services/auth.ts";
import { issueChatterDeviceToken, issueDeviceTokenForUsername } from "./helpers/device-credentials.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const MACHINE_ID = "11111111-1111-4111-8111-111111111111";

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

  const aliceKey = await issueChatterDeviceToken(app!, {
    username: "alice",
    pageLabel: "harvest-of",
  }, { source: "test" });
  await assignPageToUser(app!, {
    userId: await fixtureUserId(app!, "bob"),
    pageLabel: "harvest-of",
  }, { source: "test" });

  const aliceToken = await issueDeviceTokenForUsername(app!, {
    username: "alice",
    label: "alice-desktop",
  }, { source: "test" });
  const bobToken = await issueDeviceTokenForUsername(app!, {
    username: "bob",
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

describe("a full device token on the capture lane", () => {
  it("journals a harvest-* header as an unknown client and keeps the normal lane", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const { aliceKey, aliceToken } = await seedIdentity();
    const event = harvestEvent();

    // The harvest lane is retired: the header claims nothing. Two tokens of the
    // same person journal one fact under the person's key, as an unknown kind
    // of the desktop@ producer, unmapped — never a harvest.* kind or a
    // desktop-harvest@ producer the canonicalizer would mint events from.
    const viaFirstDevice = await postHarvest(aliceKey.key, event);
    expect(viaFirstDevice.statusCode).toBe(200);
    expect(viaFirstDevice.json()).toEqual({ accepted: 1, duplicates: 0 });
    const viaSecondDevice = await postHarvest(aliceToken.token, event);
    expect(viaSecondDevice.json()).toEqual({ accepted: 0, duplicates: 1 });

    const stored = await testDb.pool.query(
      `select producer, kind, account_id, idempotency_key, harvest_machine_id
       from observations where source = 'client_capture'`,
    );
    expect(stored.rows).toEqual([{
      producer: "desktop@harvest-0.1.41",
      kind: "desktop.unknown:harvest.messages",
      account_id: null,
      idempotency_key: `${await fixtureUserId(app!, "alice")}:${event.clientEventId}`,
      harvest_machine_id: null,
    }]);

    // An ordinary device token keeps the normal client-capture lane.
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

  it("lets only the current device-token bearer revoke exactly itself", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const { aliceKey, aliceToken, bobToken } = await seedIdentity();
    const ownerCookie = await loginOwnerCookie();

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
    // Exactly itself: alice's OTHER device and bob's are both untouched.
    expect(rows.rows).toEqual([
      { id: String(aliceKey.id), revoked: false, reason: null },
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
