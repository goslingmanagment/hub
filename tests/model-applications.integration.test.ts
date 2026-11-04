import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { runModelApplicationAbandonSweep } from "../apps/runtime/src/services/model-application-sessions.ts";
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

const SESSION = "3f2b6c1e-8a4d-4c2b-9e7f-1a2b3c4d5e6f";

async function sessionRow(db: StartedTestDatabase, session: string) {
  const result = await db.pool.query<{
    filled: number;
    total: number;
    section: string | null;
    name: string | null;
    start_notified_at: Date | null;
    abandon_notified_at: Date | null;
    submitted_at: Date | null;
    application_id: string | number | bigint | null;
    answers: unknown;
  }>("select * from model_application_sessions where session = $1", [session]);
  return result.rows[0] ?? null;
}

describe("POST /api/v1/model-applications/progress", () => {
  const progress = (remoteAddress: string, payload: unknown, contentType = "application/json") =>
    server!.inject({
      method: "POST",
      url: "/api/v1/model-applications/progress",
      remoteAddress,
      headers: { "content-type": contentType },
      payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
  const body = (overrides: Record<string, unknown> = {}) => ({
    session: SESSION,
    form: "model-full",
    filled: 34,
    total: 90,
    section: "Хобби",
    name: "Карина",
    ...overrides,
  });

  it("upserts the filling from JSON or text/plain, claiming its start once", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const first = await progress("203.0.113.60", body({ filled: 0, name: "" }));
    expect(first.statusCode).toBe(204);
    expect(first.body).toBe("");
    expect((await sessionRow(setup.testDb, SESSION))?.start_notified_at).toBeNull();

    expect((await progress("203.0.113.60", body({ filled: 3 }), "text/plain;charset=UTF-8")).statusCode).toBe(204);
    const started = await sessionRow(setup.testDb, SESSION);
    expect(started).toMatchObject({ filled: 3, total: 90, section: "Хобби", name: "Карина" });
    expect(started?.start_notified_at).not.toBeNull();

    // Absent name and section keep the stored ones; the start stays claimed once.
    expect((await progress("203.0.113.60", { session: SESSION, form: "model-full", filled: 34, total: 90 })).statusCode).toBe(204);
    const later = await sessionRow(setup.testDb, SESSION);
    expect(later).toMatchObject({ filled: 34, section: "Хобби", name: "Карина" });
    expect(later?.start_notified_at).toEqual(started?.start_notified_at);
  });

  it("keeps the latest answers snapshot, and keeps it when a post sends none", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const snapshot = (value: string) => [{ section: "1. Основное", key: "name", label: "Имя", value }];
    expect((await progress("203.0.113.65", body({ answers: snapshot("Ка") }))).statusCode).toBe(204);
    expect((await progress("203.0.113.65", body({ answers: snapshot("Карина") }))).statusCode).toBe(204);
    expect((await progress("203.0.113.65", body({ filled: 35 }))).statusCode).toBe(204);
    expect((await sessionRow(setup.testDb, SESSION))?.answers).toEqual(snapshot("Карина"));
  });

  it("refuses malformed posts and ignores a filled honeypot", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    for (const payload of [
      body({ filled: 91 }),
      body({ session: "not-a-uuid" }),
      body({ session: "3f2b6c1e-8a4d-1c2b-9e7f-1a2b3c4d5e6f" }),
      body({ total: 501 }),
      body({ section: "x".repeat(121) }),
    ]) {
      expect((await progress("203.0.113.70", payload)).statusCode).toBe(400);
    }
    expect((await progress("203.0.113.70", "{not json", "text/plain")).statusCode).toBe(400);
    const oversized = Array.from({ length: 30 }, (_, index) => ({ section: "s", key: `k${index}`, label: "l", value: "x".repeat(5000) }));
    expect((await progress("203.0.113.70", body({ answers: oversized }))).statusCode).toBe(413);
    expect((await progress("203.0.113.70", body({ answers: [{ section: "s", key: "Bad-Key", label: "l", value: "v" }] }))).statusCode).toBe(400);

    expect((await progress("203.0.113.70", body({ website: "bot" }))).statusCode).toBe(204);
    expect(await sessionRow(setup.testDb, SESSION)).toBeNull();
  });

  it("starts at most 50 fillings an address a day, and still takes the ones it started", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const sessionNumber = (index: number) => `3f2b6c1e-8a4d-4c2b-9e7f-${String(index).padStart(12, "0")}`;
    for (let index = 0; index < 50; index += 1) {
      expect((await progress("203.0.113.80", body({ session: sessionNumber(index), filled: 0 }))).statusCode).toBe(204);
    }
    expect((await progress("203.0.113.80", body({ session: sessionNumber(50) }))).statusCode).toBe(429);
    expect((await progress("203.0.113.80", body({ session: sessionNumber(7) }))).statusCode).toBe(204);
    expect((await progress("203.0.113.81", body({ session: sessionNumber(50) }))).statusCode).toBe(204);
  });

  it("tells a left filling once, and again only after it moves and stops again", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    expect((await progress("203.0.113.90", body())).statusCode).toBe(204);
    const age = async () => setup.testDb.pool.query(
      "update model_application_sessions set updated_at = now() - interval '31 minutes' where session = $1",
      [SESSION],
    );

    expect(await runModelApplicationAbandonSweep(setup.app)).toEqual({ notified: 0 });
    await age();
    expect(await runModelApplicationAbandonSweep(setup.app)).toEqual({ notified: 1 });
    expect((await sessionRow(setup.testDb, SESSION))?.abandon_notified_at).not.toBeNull();
    expect(await runModelApplicationAbandonSweep(setup.app)).toEqual({ notified: 0 });

    expect((await progress("203.0.113.90", body({ filled: 40 }))).statusCode).toBe(204);
    expect((await sessionRow(setup.testDb, SESSION))?.abandon_notified_at).toBeNull();
    await age();
    expect(await runModelApplicationAbandonSweep(setup.app)).toEqual({ notified: 1 });
  });

  it("marks the filling sent by the questionnaire that names it, creating it if never reported", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    expect((await progress("203.0.113.95", body())).statusCode).toBe(204);
    const sent = await setup.server.inject({
      method: "POST",
      url: "/api/v1/model-applications",
      remoteAddress: "203.0.113.95",
      payload: { ...VALID_BODY, session: SESSION },
    });
    expect(sent.statusCode).toBe(201);
    const marked = await sessionRow(setup.testDb, SESSION);
    expect(marked?.submitted_at).not.toBeNull();
    expect(String(marked?.application_id)).toBe(String(sent.json<{ id: number }>().id));

    // A sent filling is never reported as left.
    await setup.testDb.pool.query("update model_application_sessions set updated_at = now() - interval '2 hours'");
    expect(await runModelApplicationAbandonSweep(setup.app)).toEqual({ notified: 0 });

    const unreported = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    const second = await setup.server.inject({
      method: "POST",
      url: "/api/v1/model-applications",
      remoteAddress: "203.0.113.96",
      payload: { ...VALID_BODY, session: unreported },
    });
    expect(second.statusCode).toBe(201);
    expect(await sessionRow(setup.testDb, unreported)).toMatchObject({ name: "Карина", filled: 0 });
  });
});
