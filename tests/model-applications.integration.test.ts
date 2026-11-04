import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// The agency site's model questionnaire (public POST /api/v1/model-applications):
// what is refused, what a bot gets, and the hourly limit per client address.

let testDb: StartedTestDatabase | null = null;
let app: AppContext | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

function requireSetup(context: { skip: () => void }) {
  if (!testDb || !app || !server) {
    context.skip();
    return null;
  }
  return { testDb, app, server };
}

const VALID_BODY = {
  form: "model-full",
  answers: [
    { section: "1. Основное", key: "name", label: "Имя или псевдоним", value: "Карина" },
    { section: "1. Основное", key: "age", label: "Возраст", value: "20" },
    { section: "2. Опыт", key: "platforms", label: "Платформы", value: "" },
  ],
};

async function storedRows(db: StartedTestDatabase) {
  const result = await db.pool.query<{
    id: string;
    form: string;
    answers: unknown;
    google_fields: unknown;
    google_status: string;
    google_error: string | null;
    ip_hash: string;
    user_agent: string | null;
  }>("select * from model_applications order by id");
  return result.rows;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  // No service egress proxy: the Google forward fails before any connection.
  app = createTestAppContext(testDb, {
    serviceEgressProxyUrl: null,
    serviceEgressProxyUsername: null,
    serviceEgressProxyPassword: null,
  });
  server = await buildApiServer(app);
}, 120_000);

beforeEach(async () => {
  if (!testDb) return;
  await resetIntegrationDatabase(testDb.pool);
});

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("POST /api/v1/model-applications", () => {
  it("stores a valid questionnaire and answers 201 with its id", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const response = await setup.server.inject({
      method: "POST",
      url: "/api/v1/model-applications",
      remoteAddress: "203.0.113.10",
      headers: { "user-agent": "test-browser" },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ ok: boolean; id: number }>();
    expect(body.ok).toBe(true);
    const rows = await storedRows(setup.testDb);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.id)).toBe(body.id);
    expect(rows[0]!.answers).toEqual(VALID_BODY.answers);
    expect(rows[0]!.google_status).toBe("skipped");
    expect(rows[0]!.google_fields).toBeNull();
    expect(rows[0]!.user_agent).toBe("test-browser");
    // Only a keyed hash of the address is kept.
    expect(Object.values(rows[0]!).map((value) => String(value)).join(" ")).not.toContain("203.0.113.10");
  });

  it("refuses malformed bodies with 400 and an oversized one with 413, storing nothing", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const post = (payload: string) => setup.server.inject({
      method: "POST",
      url: "/api/v1/model-applications",
      remoteAddress: "203.0.113.20",
      headers: { "content-type": "application/json" },
      payload,
    });

    const refused = [
      "{not json",
      JSON.stringify({ form: "model-full", answers: [] }),
      JSON.stringify({ ...VALID_BODY, answers: [{ ...VALID_BODY.answers[0], key: "Bad-Key" }] }),
      JSON.stringify({ ...VALID_BODY, form: "x".repeat(41) }),
      JSON.stringify({ ...VALID_BODY, google: { "https://evil.example": "x" } }),
      JSON.stringify({ ...VALID_BODY, google: { "entry.1": ["x".repeat(301)] } }),
    ];
    for (const payload of refused) {
      expect((await post(payload)).statusCode).toBe(400);
    }

    const huge = JSON.stringify({
      form: "model-full",
      answers: Array.from({ length: 30 }, (_, index) => ({
        section: "s",
        key: `k${index}`,
        label: "l",
        value: "x".repeat(5000),
      })),
    });
    expect((await post(huge)).statusCode).toBe(413);

    expect(await storedRows(setup.testDb)).toHaveLength(0);
  });

  it("answers a filled honeypot like a success and stores nothing", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const response = await setup.server.inject({
      method: "POST",
      url: "/api/v1/model-applications",
      remoteAddress: "203.0.113.30",
      payload: { ...VALID_BODY, google: { "entry.1": "Карина" }, website: "bot" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ok: true, id: expect.any(Number) });
    expect(await storedRows(setup.testDb)).toHaveLength(0);
  });

  it("stores at most 5 an hour per client address, then answers 429", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const post = (remoteAddress: string) => setup.server.inject({
      method: "POST",
      url: "/api/v1/model-applications",
      remoteAddress,
      payload: VALID_BODY,
    });

    for (let index = 0; index < 5; index += 1) {
      expect((await post("203.0.113.40")).statusCode).toBe(201);
    }
    expect((await post("203.0.113.40")).statusCode).toBe(429);
    expect((await post("203.0.113.41")).statusCode).toBe(201);

    const rows = await storedRows(setup.testDb);
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row) => row.ip_hash)).size).toBe(2);
  });

  it("keeps the questionnaire when the Google forward cannot go out", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    // Without the service egress proxy the forward fails before any
    // connection, and the request still succeeds.
    const response = await setup.server.inject({
      method: "POST",
      url: "/api/v1/model-applications",
      remoteAddress: "203.0.113.50",
      payload: { ...VALID_BODY, google: { "entry.1890436298": "Карина", "entry.1727317785": ["OnlyFans", "Fansly"] } },
    });

    expect(response.statusCode).toBe(201);
    const rows = await storedRows(setup.testDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.google_status).toBe("failed");
    expect(rows[0]!.google_error).toMatch(/^egress: /);
    expect(rows[0]!.google_fields).toEqual({ "entry.1890436298": "Карина", "entry.1727317785": ["OnlyFans", "Fansly"] });
  });
});
