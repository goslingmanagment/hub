import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  setPageOfapiAccountId,
  upsertFanPages,
  upsertFans,
  upsertOfapiWebhookConfig,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { processOfapiWebhookEvent } from "../apps/runtime/src/services/ofapi-events.ts";
import { parseOfapiPresencePayload } from "../apps/runtime/src/services/ofapi-presence-projection.ts";
import { OFAPI_WEBHOOK_EVENTS } from "../apps/runtime/src/services/ofapi-webhooks.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

const OFAPI_ACCOUNT = "acct_presence_test";
const SIGNING_SECRET = "test-signing-secret";
const ENCRYPTION_KEY = Buffer.alloc(32, 7);
const FIXTURES_DIR = path.resolve("tests/fixtures/ofapi-webhooks");

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let idempotencyCounter = 0;

function nextIdempotencyKey() {
  idempotencyCounter += 1;
  return `evt_${String(idempotencyCounter).padStart(40, "0")}`;
}

function loadFixtureEnvelope(name: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf8")) as Record<string, unknown>;
  delete raw._meta;
  return raw;
}

function presenceEnvelope(input: {
  event: "users.online" | "users.offline";
  fanId: string;
  lastSeenOnlineAt: string;
  observedAt?: string;
}): Record<string, unknown> {
  return {
    event: input.event,
    account_id: OFAPI_ACCOUNT,
    payload: {
      fan: {
        id: input.fanId,
        username: `fan${input.fanId}`,
        name: `Fan ${input.fanId}`,
        display_name: "",
        spending: { messages: 0, subscribes: 0, posts: 0, tips: 0, streams: 0, total: 0 },
      },
      observed_at: input.observedAt ?? input.lastSeenOnlineAt,
      status_changed_at: input.observedAt ?? input.lastSeenOnlineAt,
      last_seen_online_at: input.lastSeenOnlineAt,
    },
  };
}

async function startServer() {
  await upsertOfapiWebhookConfig(appContext.db, {
    externalWebhookId: "wh_test",
    endpointUrl: "https://hub.example.com/api/v1/ofapi/webhook",
    accountScope: "global",
    events: [...OFAPI_WEBHOOK_EVENTS],
    encryptedSigningSecret: JSON.stringify(encryptJson(SIGNING_SECRET, ENCRYPTION_KEY, 1)),
  });
  server = await buildApiServer(appContext);
  await server.ready();
}

async function deliverAndProcess(envelope: Record<string, unknown>) {
  if (!server) {
    throw new Error("server not started");
  }

  const body = JSON.stringify(envelope);
  const response = await server.inject({
    method: "POST",
    url: "/api/v1/ofapi/webhook",
    payload: body,
    headers: {
      "content-type": "application/json",
      signature: createHmac("sha256", SIGNING_SECRET).update(body).digest("hex"),
      "x-ofapi-idempotency-key": nextIdempotencyKey(),
    },
  });
  expect(response.statusCode).toBe(200);

  const { rows } = await testDb!.pool.query<{ id: number }>(
    "select max(id)::int as id from ofapi_webhook_events",
  );
  const eventId = rows[0]!.id;
  await processOfapiWebhookEvent(appContext, eventId);
  return eventId;
}

async function seedMappedPage(label = "lora-of-presence") {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label });
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId: OFAPI_ACCOUNT });
  return page;
}

async function seedKnownFan(pageId: number, platformUserId: string) {
  const [fan] = await upsertFans(appContext.db, [{
    platform: "onlyfans",
    platformUserId,
    username: `fan${platformUserId}`,
  }]);
  await upsertFanPages(appContext.db, [{ fanId: fan!.id, platformAccountId: pageId }]);
  return fan!;
}

async function getPresence(pageId: number, platformUserId: string) {
  const { rows } = await testDb!.pool.query<{
    external_presence_at: string | null;
    external_presence_source: string | null;
  }>(
    `select pf.external_presence_at::text, pf.external_presence_source
     from page_fans pf join fans f on f.id = pf.fan_id
     where pf.platform_account_id = $1 and f.platform_user_id = $2`,
    [pageId, platformUserId],
  );
  return rows[0] ?? null;
}

async function getProjectionStatus(eventId: number) {
  const { rows } = await testDb!.pool.query<{ projection_status: string; projection_error: string | null }>(
    "select projection_status, projection_error from ofapi_webhook_events where id = $1",
    [eventId],
  );
  return rows[0]!;
}

async function ownerCookie() {
  if (!server) {
    throw new Error("server not started");
  }
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "dima", password: "owner-secret" },
  });
  expect(login.statusCode).toBe(200);
  const header = login.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  return String(value).split(";")[0]!;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }

  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, { ofapiPresenceProjectionEnabled: true });
  await createUserAccount(appContext, {
    username: "dima",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
});

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("parseOfapiPresencePayload (live fixtures)", () => {
  it("maps users.online and users.offline payloads", () => {
    const online = loadFixtureEnvelope("users_online.json");
    const parsedOnline = parseOfapiPresencePayload(online.payload as Record<string, unknown>);
    expect(parsedOnline).toEqual({
      fanId: "1000033",
      lastSeenAt: new Date("2026-06-10T20:01:06.000000Z"),
      observedAt: new Date("2026-06-10T20:01:06.000000Z"),
    });

    const offline = loadFixtureEnvelope("users_offline.json");
    const parsedOffline = parseOfapiPresencePayload(offline.payload as Record<string, unknown>);
    // Offline carries the historical lastSeen, earlier than the status change.
    expect(parsedOffline?.lastSeenAt).toEqual(new Date("2026-06-10T20:35:03.000000Z"));
    expect(parsedOffline?.observedAt).toEqual(new Date("2026-06-10T21:10:08.000000Z"));
  });

  it("returns null without a fan id", () => {
    expect(parseOfapiPresencePayload({ observed_at: "2026-06-10T20:01:06Z" })).toBeNull();
  });
});

describe("OFAPI presence projection", () => {
  it("projects users.online for a known fan into the presence store and the workboard panel", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();
    await seedKnownFan(page.id, "777001");
    await startServer();

    const nowIso = new Date().toISOString();
    const eventId = await deliverAndProcess(presenceEnvelope({
      event: "users.online",
      fanId: "777001",
      lastSeenOnlineAt: nowIso,
    }));

    expect((await getProjectionStatus(eventId)).projection_status).toBe("projected");
    const presence = await getPresence(page.id, "777001");
    expect(presence?.external_presence_at).not.toBeNull();
    expect(presence?.external_presence_source).toBe("ofapi_last_seen");

    // The workboard presence panel serves the OnlyFans page read-only (D9).
    const cookie = await ownerCookie();
    const response = await server!.inject({
      method: "GET",
      url: `/api/v1/pages/${page.label}/workboard/presence`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.activeNow.total).toBe(1);
    expect(body.activeNow.items[0].fan.platformUserId).toBe("777001");
    expect(body.activeNow.items[0].presence.source).toBe("ofapi_last_seen");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("skips unknown fans without creating rows (D9: no REST lookups)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await seedMappedPage();
    await startServer();

    const eventId = await deliverAndProcess(presenceEnvelope({
      event: "users.online",
      fanId: "999999",
      lastSeenOnlineAt: new Date().toISOString(),
    }));

    const status = await getProjectionStatus(eventId);
    expect(status.projection_status).toBe("skipped");
    expect(status.projection_error).toContain("not known");

    const { rows } = await testDb.pool.query<{ count: number }>(
      "select count(*)::int as count from fans where platform_user_id = '999999'",
    );
    expect(rows[0]!.count).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps presence forward-only across out-of-order online/offline events", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();
    await seedKnownFan(page.id, "777002");
    await startServer();

    const newer = new Date();
    const older = new Date(newer.getTime() - 60 * 60 * 1000);

    await deliverAndProcess(presenceEnvelope({
      event: "users.online",
      fanId: "777002",
      lastSeenOnlineAt: newer.toISOString(),
    }));
    // A stale offline event (older lastSeen) must not regress the store.
    await deliverAndProcess(presenceEnvelope({
      event: "users.offline",
      fanId: "777002",
      lastSeenOnlineAt: older.toISOString(),
    }));

    const presence = await getPresence(page.id, "777002");
    expect(new Date(presence!.external_presence_at!).getTime())
      .toBe(new Date(newer.toISOString()).getTime());
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("folds message-payload lastSeen into presence inside the DM projection", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    appContext = createTestAppContext(testDb, {
      ofapiPresenceProjectionEnabled: true,
      ofapiDmProjectionEnabled: true,
    });
    await createUserAccount(appContext, {
      username: "dima2",
      role: "owner",
      password: "owner-secret",
    }, { source: "cli" });
    const page = await seedMappedPage();
    await startServer();

    const lastSeen = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await deliverAndProcess({
      event: "messages.received",
      account_id: OFAPI_ACCOUNT,
      payload: {
        id: 5_001_001,
        text: "<p>hello</p>",
        createdAt: new Date().toISOString(),
        isTip: false,
        price: 0,
        fromUser: {
          id: 777003,
          username: "fan777003",
          name: "Fan 777003",
          lastSeen,
        },
      },
    });

    const presence = await getPresence(page.id, "777003");
    expect(presence?.external_presence_at).not.toBeNull();
    expect(presence?.external_presence_source).toBe("ofapi_last_seen");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("stays inert with the flag off and keeps the Fansly-only rejection", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    appContext = createTestAppContext(testDb, { ofapiPresenceProjectionEnabled: false });
    await createUserAccount(appContext, {
      username: "dima3",
      role: "owner",
      password: "owner-secret",
    }, { source: "cli" });
    const page = await seedMappedPage();
    await seedKnownFan(page.id, "777004");
    await startServer();

    const eventId = await deliverAndProcess(presenceEnvelope({
      event: "users.online",
      fanId: "777004",
      lastSeenOnlineAt: new Date().toISOString(),
    }));

    // Stamped pending regardless of the flag (enables back-projection later).
    expect((await getProjectionStatus(eventId)).projection_status).toBe("pending");
    expect((await getPresence(page.id, "777004"))?.external_presence_at).toBeNull();

    const login = await server!.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima3", password: "owner-secret" },
    });
    const cookie = String(
      Array.isArray(login.headers["set-cookie"])
        ? login.headers["set-cookie"][0]
        : login.headers["set-cookie"],
    ).split(";")[0]!;
    const response = await server!.inject({
      method: "GET",
      url: `/api/v1/pages/${page.label}/workboard/presence`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("only supported for Fansly pages");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("staged-rollout cross-stamping (audit B4)", () => {
  it("keeps presence rows out of the DM runner's hands when both flags are on", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // The audit's live repro config: DM projection AND presence projection on.
    appContext = createTestAppContext(testDb, {
      ofapiDmProjectionEnabled: true,
      ofapiPresenceProjectionEnabled: true,
    });
    const page = await seedMappedPage();
    await seedKnownFan(page.id, "777005");
    await startServer();

    const eventId = await deliverAndProcess(presenceEnvelope({
      event: "users.online",
      fanId: "777005",
      lastSeenOnlineAt: new Date().toISOString(),
    }));

    // Pre-fix the DM runner stamped this row "skipped" before the presence
    // projection ran, so the journal lied even though presence applied.
    const status = await getProjectionStatus(eventId);
    expect(status.projection_status).toBe("projected");
    expect((await getPresence(page.id, "777005"))?.external_presence_at).not.toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("leaves presence rows pending under the staged rollout (DM flag first)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    appContext = createTestAppContext(testDb, {
      ofapiDmProjectionEnabled: true,
      ofapiPresenceProjectionEnabled: false,
    });
    const page = await seedMappedPage();
    await seedKnownFan(page.id, "777006");
    await startServer();

    const eventId = await deliverAndProcess(presenceEnvelope({
      event: "users.online",
      fanId: "777006",
      lastSeenOnlineAt: new Date().toISOString(),
    }));

    // Pending, not skipped: enabling the presence flag later must let the
    // sweep back-project this row (decision #48/#50 enable-later contract).
    expect((await getProjectionStatus(eventId)).projection_status).toBe("pending");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("requeues rows the DM runner mis-stamped (migration 0032)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const insertEvent = async (input: {
      key: string;
      eventType: string;
      status: string;
      error: string | null;
    }) => {
      const { rows } = await testDb!.pool.query<{ id: number }>(
        `insert into ofapi_webhook_events
           (idempotency_key, event_type, ofapi_account_id, payload, status,
            projection_status, projection_error, projection_attempts)
         values ($1, $2, $3, '{}', 'processed', $4, $5, 1)
         returning id`,
        [input.key, input.eventType, OFAPI_ACCOUNT, input.status, input.error],
      );
      return rows[0]!.id;
    };

    const misStamped = await insertEvent({
      key: nextIdempotencyKey(),
      eventType: "users.online",
      status: "skipped",
      error: 'Event type "users.online" is not projected',
    });
    const legitimateDmSkip = await insertEvent({
      key: nextIdempotencyKey(),
      eventType: "messages.received",
      status: "skipped",
      error: 'No page mapped to OFAPI account "acct_other"',
    });

    const migrationSql = readFileSync(
      path.resolve("packages/db/migrations/0032_requeue_cross_stamped_ofapi_projections.sql"),
      "utf8",
    );
    await testDb.pool.query(migrationSql);

    const requeued = await getProjectionStatus(misStamped);
    expect(requeued.projection_status).toBe("pending");
    expect(requeued.projection_error).toBeNull();

    expect((await getProjectionStatus(legitimateDmSkip)).projection_status).toBe("skipped");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
