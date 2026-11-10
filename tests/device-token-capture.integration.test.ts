import { createHash } from "node:crypto";

import { fixtureUserId } from "./helpers/user-identity.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  insertObservation,
  listEventsSince,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
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

function guardAuditEvent(input: { clientEventId: string; pageLabel?: string; observedAt?: string }) {
  return {
    clientEventId: input.clientEventId,
    kind: "guard_audit",
    observedAt: input.observedAt ?? "2026-07-13T10:01:00.000Z",
    payload: { decision: "allow" },
    ...(input.pageLabel ? { pageLabel: input.pageLabel } : {}),
  };
}

async function postCapture(token: string, events: ReturnType<typeof guardAuditEvent>[]) {
  return server!.inject({
    method: "POST",
    url: "/api/v1/ingest/observations",
    headers: {
      authorization: `Bearer ${token}`,
      "x-client-version": "0.1.41",
    },
    payload: { events },
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

  it("answers an unreadable event with 400 invalid_ingest_event", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const { aliceToken } = await seedIdentity();

    // The status is the contract: chat-extension drops a batch on 400 and
    // resends it on any other status, so a 500 here would loop forever.
    const response = await postCapture(aliceToken.token, [guardAuditEvent({
      clientEventId: "77777777-7777-4777-8777-777777777777",
      observedAt: "not-a-timestamp",
    })]);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_ingest_event" });
  });

  it("maps a capture to a page only inside the token's page scope", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const { aliceToken, page } = await seedIdentity();
    const otherModel = await createModel(testDb.db, { slug: "other", name: "Other" });
    if (!otherModel) throw new Error("Failed to create other model");
    const otherPage = await createOnlyFansPage(testDb.db, { modelId: otherModel.id, label: "other-of" });
    if (!otherPage) throw new Error("Failed to create other page");

    // Alice is assigned harvest-of only. A label outside her scope is not
    // refused: the fact journals with no account, so it never canonicalizes.
    const response = await postCapture(aliceToken.token, [
      guardAuditEvent({ clientEventId: "88888888-8888-4888-8888-888888888881", pageLabel: "harvest-of" }),
      guardAuditEvent({ clientEventId: "88888888-8888-4888-8888-888888888882", pageLabel: "other-of" }),
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 2, duplicates: 0 });

    const stored = await testDb.pool.query<{ event: string; account: string | null }>(`
      select split_part(idempotency_key, ':', 2) as event, account_id::text as account
      from observations where source = 'client_capture'
      order by event
    `);
    expect(stored.rows).toEqual([
      { event: "88888888-8888-4888-8888-888888888881", account: String(page.id) },
      { event: "88888888-8888-4888-8888-888888888882", account: null },
    ]);
  });

  it("journals each capture under the user of the token that sent it", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const { aliceToken, bobToken } = await seedIdentity();

    // actor_principal_id is the user_id the acceptance projection reads.
    expect((await postCapture(aliceToken.token, [guardAuditEvent({
      clientEventId: "99999999-9999-4999-8999-999999999991",
    })])).statusCode).toBe(200);
    expect((await postCapture(bobToken.token, [guardAuditEvent({
      clientEventId: "99999999-9999-4999-8999-999999999992",
    })])).statusCode).toBe(200);

    const stored = await testDb.pool.query<{ event: string; actor: string | null }>(`
      select split_part(idempotency_key, ':', 2) as event, actor_principal_id::text as actor
      from observations where source = 'client_capture'
      order by event
    `);
    expect(stored.rows).toEqual([
      { event: "99999999-9999-4999-8999-999999999991", actor: String(await fixtureUserId(app!, "alice")) },
      { event: "99999999-9999-4999-8999-999999999992", actor: String(await fixtureUserId(app!, "bob")) },
    ]);
  });

  it("still canonicalizes a stored harvest message row into a received or sent message", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const model = await createModel(testDb.db, { slug: "harvest", name: "Harvest" });
    if (!model) throw new Error("Failed to create harvest model");
    const page = await createOnlyFansPage(testDb.db, { modelId: model.id, label: "harvest-of" });
    if (!page) throw new Error("Failed to create harvest page");

    // The harvest lane no longer accepts uploads, but rows it stored before
    // stay in the journal and replay through the canonicalizer.
    for (const [index, sentByMe] of [0, 1].entries()) {
      const payload = {
        table: "messages",
        machineId: MACHINE_ID,
        ofapiAccountId: "acct_harvest",
        row: {
          message_id: `message-${index + 1}`,
          chat_id: "fan-1",
          created_at: "2026-07-13T10:00:00.000Z",
          is_sent_by_me: sentByMe,
          deleted: 0,
        },
      };
      await insertObservation(testDb.db, {
        source: "client_capture",
        producer: "desktop-harvest@0.1.41",
        platform: page.platform,
        accountId: page.id,
        kind: "harvest.messages",
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
        idempotencyKey: `${MACHINE_ID}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index + 1}`,
      });
    }

    await runCanonicalization(app!);
    const events = await listEventsSince(testDb.db, { accountId: page.id, afterSeq: 0 });
    expect(events.map(({ type, messageRef }) => ({ type, messageRef }))
      .sort((a, b) => String(a.messageRef).localeCompare(String(b.messageRef)))).toEqual([
      { type: "message.received", messageRef: "message-1" },
      { type: "message.sent", messageRef: "message-2" },
    ]);
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
