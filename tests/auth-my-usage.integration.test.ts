import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createModel, createOnlyFansPage, insertAiUsageEvents } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Decision 347: the cabinet's "my AI spend". Its own repository query, with no
// role filter — listChatterUsageSummary hard-filters `role = 'chatter'`, which
// would leave a team_lead's or an owner's cabinet empty. Costs stay micro-USD
// integers end to end; nothing here does money arithmetic by hand.

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

function sessionCookieFrom(response: {
  headers: Record<string, string | string[] | number | undefined>;
}) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || typeof value !== "string") throw new Error("Expected a session cookie");
  return value.split(";")[0]!;
}

async function login(
  activeServer: NonNullable<typeof server>,
  username: string,
  password: string,
) {
  const response = await activeServer.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookieFrom(response);
}

interface UsageReport {
  range: { from: string; to: string; timeZone: string };
  row: {
    username: string;
    totalGenerations: number;
    cost: { microUsd: number; approximate: boolean };
    topFeature: { feature: string; requestCount: number } | null;
    featureBreakdown: Array<{ feature: string; requestCount: number; costMicroUsd: number }>;
    regenerateRatePct: number;
  };
  daily: Array<{ date: string; requestCount: number; costMicroUsd: number }>;
}

async function seedUsage(
  db: StartedTestDatabase,
  userId: number,
  pageId: number,
  events: Array<{
    id: string;
    feature: "fast-reply" | "hi-greeting";
    completedAt: string;
    costMicroUsd: number;
    isRegeneration?: boolean;
  }>,
) {
  await insertAiUsageEvents(db.db, {
    userId,
    events: events.map((event) => ({
      clientEventId: event.id,
      feature: event.feature,
      model: "claude-test",
      pageId,
      provider: "anthropic" as const,
      inputTokens: 100,
      outputTokens: 20,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      costMicroUsd: event.costMicroUsd,
      costApproximate: false,
      quotaAccepted: true,
      gatewayOutcome: "completed" as const,
      isCacheHit: false,
      isRegeneration: event.isRegeneration ?? false,
      completedAt: new Date(event.completedAt),
    })),
  });
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb, { authPolicyEnforcement: "enforce" });
  server = await buildApiServer(app);
}, 120_000);

beforeEach(async () => {
  if (!testDb || !app) return;
  await resetIntegrationDatabase(testDb.pool);
  await createUserAccount(app, {
    username: "grisha",
    role: "team_lead",
    password: "chatter-secret-1",
  }, { source: "cli" });
  await createUserAccount(app, {
    username: "nikita",
    role: "team_lead",
    password: "chatter-secret-2",
  }, { source: "cli" });
});

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("my AI usage", () => {
  it("reports the caller's own events only — never anyone else's", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const model = await createModel(setup.testDb.db, { slug: "lora", name: "Lora" });
    const page = await createOnlyFansPage(setup.testDb.db, {
      modelId: model!.id,
      label: "lora-of",
    });

    await seedUsage(setup.testDb, 1, page!.id, [
      { id: "mine-1", feature: "fast-reply", completedAt: "2026-06-19T10:00:00.000Z", costMicroUsd: 1_500 },
      { id: "mine-2", feature: "fast-reply", completedAt: "2026-06-19T12:00:00.000Z", costMicroUsd: 2_500, isRegeneration: true },
      { id: "mine-3", feature: "hi-greeting", completedAt: "2026-06-20T09:00:00.000Z", costMicroUsd: 4_000 },
    ]);
    await seedUsage(setup.testDb, 2, page!.id, [
      { id: "theirs-1", feature: "fast-reply", completedAt: "2026-06-19T11:00:00.000Z", costMicroUsd: 90_000 },
    ]);

    const cookie = await login(setup.server, "grisha", "chatter-secret-1");
    const response = await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/usage?from=2026-06-19&to=2026-06-20",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const report = response.json<UsageReport>();
    expect(report.range).toEqual({ from: "2026-06-19", to: "2026-06-20", timeZone: "Europe/Moscow" });
    expect(report.row.username).toBe("grisha");
    expect(report.row.totalGenerations).toBe(3);
    expect(report.row.cost.microUsd).toBe(8_000);
    expect(report.row.topFeature?.feature).toBe("fast-reply");
    expect(report.row.featureBreakdown.map((entry) => entry.feature).sort())
      .toEqual(["fast-reply", "hi-greeting"]);
    expect(report.row.regenerateRatePct).toBeCloseTo(33.3, 0);
    expect(report.daily).toEqual([
      { date: "2026-06-19", requestCount: 2, costMicroUsd: 4_000 },
      { date: "2026-06-20", requestCount: 1, costMicroUsd: 4_000 },
    ]);
    // The other person's row is not in this report at any cost.
    expect(JSON.stringify(report)).not.toContain("90000");
    expect(JSON.stringify(report)).not.toContain("nikita");
  });

  it("answers an empty report for someone who has generated nothing", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const cookie = await login(setup.server, "nikita", "chatter-secret-2");

    const response = await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/usage?from=2026-06-19&to=2026-06-20",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const report = response.json<UsageReport>();
    expect(report.row.username).toBe("nikita");
    expect(report.row.totalGenerations).toBe(0);
    expect(report.row.cost.microUsd).toBe(0);
    expect(report.row.topFeature).toBeNull();
    expect(report.daily).toEqual([]);
  });

  it("keeps events outside the requested range out of it, and defaults to the last seven days", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const model = await createModel(setup.testDb.db, { slug: "lora", name: "Lora" });
    const page = await createOnlyFansPage(setup.testDb.db, {
      modelId: model!.id,
      label: "lora-of",
    });
    const today = new Date();
    await seedUsage(setup.testDb, 1, page!.id, [
      { id: "old-1", feature: "fast-reply", completedAt: "2026-06-19T10:00:00.000Z", costMicroUsd: 1_000 },
      { id: "now-1", feature: "fast-reply", completedAt: today.toISOString(), costMicroUsd: 7_000 },
    ]);
    const cookie = await login(setup.server, "grisha", "chatter-secret-1");

    const narrow = (await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/usage?from=2026-06-19&to=2026-06-19",
      headers: { cookie },
    })).json<UsageReport>();
    expect(narrow.row.totalGenerations).toBe(1);
    expect(narrow.row.cost.microUsd).toBe(1_000);

    const byDefault = (await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/usage",
      headers: { cookie },
    })).json<UsageReport>();
    expect(byDefault.row.totalGenerations).toBe(1);
    expect(byDefault.row.cost.microUsd).toBe(7_000);
  });

  it("refuses half a range, exactly as the owner's report does", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const cookie = await login(setup.server, "grisha", "chatter-secret-1");

    const response = await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/usage?from=2026-06-19",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });
});
