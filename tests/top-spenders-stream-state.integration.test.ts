// W8.1 (A12/A20, decision #133): the pageTopSpenders `source` block. A
// non-ramped page's `builtAt: null / entries: []` used to be
// indistinguishable from "no spenders" — the response now says WHY, computed
// from the SAME gate helper the executor uses (effective config + allowlist)
// plus the page's fan_earnings sync state.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  upsertFans,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

function sessionCookieFrom(response: { headers: Record<string, unknown> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") {
    throw new Error("Expected a session cookie");
  }
  return value.split(";")[0]!;
}

async function startServer(configOverrides?: {
  fanslyFanEarningsSyncEnabled?: boolean;
  fanslyNewStreamPageAllowlist?: string;
}) {
  appContext = createTestAppContext(testDb!, configOverrides);
  const model = await createModel(appContext.db, { slug: "tss-model", name: "TSS" });
  if (!model) throw new Error("model seed failed");
  const fansly = await createFanslyPage(appContext.db, { modelId: model.id, label: "tss-fansly" });
  if (!fansly) throw new Error("fansly page seed failed");
  await ensurePageSyncStates(appContext.db, { pageId: fansly.id });
  const onlyfans = await createOnlyFansPage(appContext.db, { modelId: model.id, label: "tss-of" });
  await createUserAccount(
    appContext,
    { username: "dima", role: "owner", password: "owner-secret" },
    { source: "cli" },
  );
  server = await buildApiServer(appContext);
  await server.ready();
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "dima", password: "owner-secret" },
  });
  expect(login.statusCode).toBe(200);
  return { cookie: sessionCookieFrom(login), fansly, onlyfans };
}

async function fetchTopSpenders(cookie: string, pageLabel: string) {
  if (!server) throw new Error("server not started");
  const response = await server.inject({
    method: "GET",
    url: `/api/v1/pages/${pageLabel}/top-spenders`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    builtAt: string | null;
    entries: unknown[];
    source: {
      streamState: string;
      lastSyncedAt: string | null;
      consecutiveFailures: number | null;
    };
  };
}

describe("pageTopSpenders source.streamState (W8.1)", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
  });

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("reports flag_off with the honest empty projection (the old ambiguous shape)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie, fansly } = await startServer({ fanslyFanEarningsSyncEnabled: false });
    void fansly;
    const body = await fetchTopSpenders(cookie, "tss-fansly");
    expect(body.builtAt).toBeNull();
    expect(body.entries).toEqual([]);
    expect(body.source).toEqual({
      streamState: "flag_off",
      lastSyncedAt: null,
      consecutiveFailures: 0,
    });
  });

  it("reports not_allowlisted for a page outside a NON-empty allowlist", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie } = await startServer({
      fanslyFanEarningsSyncEnabled: true,
      fanslyNewStreamPageAllowlist: "some-other-page",
    });
    const body = await fetchTopSpenders(cookie, "tss-fansly");
    expect(body.source.streamState).toBe("not_allowlisted");
    expect(body.entries).toEqual([]);
  });

  it("reports ramped under the EMPTY allowlist (empty CSV = all pages) and surfaces sync state", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie, fansly } = await startServer({
      fanslyFanEarningsSyncEnabled: true,
      fanslyNewStreamPageAllowlist: "",
    });
    // Give the fan_earnings cursor a real data success plus state failures.
    const succeededAt = new Date("2026-07-10T06:00:00Z");
    await testDb.pool.query(
      `update page_sync_states
         set consecutive_failures = 3
       where page_id = $1 and stream = 'fan_earnings'`,
      [fansly.id],
    );
    await testDb.pool.query(
      `insert into page_sync_cursors (
         page_id, stream, state, updated_at, last_succeeded_at
       ) values ($1, 'fan_earnings', '{}'::jsonb, $2, $2)`,
      [fansly.id, succeededAt],
    );

    const body = await fetchTopSpenders(cookie, "tss-fansly");
    expect(body.source).toEqual({
      streamState: "ramped",
      lastSyncedAt: succeededAt.toISOString(),
      consecutiveFailures: 3,
    });
  });

  it("reports ramped for a page INSIDE the allowlist", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie } = await startServer({
      fanslyFanEarningsSyncEnabled: true,
      fanslyNewStreamPageAllowlist: "tss-fansly, some-other-page",
    });
    const body = await fetchTopSpenders(cookie, "tss-fansly");
    expect(body.source.streamState).toBe("ramped");
  });

  it("reports unsupported_platform for an OnlyFans page regardless of flags", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie } = await startServer({ fanslyFanEarningsSyncEnabled: true });
    const body = await fetchTopSpenders(cookie, "tss-of");
    expect(body.source.streamState).toBe("unsupported_platform");
  });

  // 209 of lora-1's 697 projection rows have neither username nor displayName
  // and ALL of them carry deleted_detected_at: the accounts are gone from the
  // platform. Without this field the board printed a bare numeric id and kept
  // asking Fansly for names it can never get. The row must still appear — a
  // deleted fan spent real money and dropping it would break the totals.
  it("marks a deleted fan with deletedAt and keeps a live fan null", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie, fansly } = await startServer({
      fanslyFanEarningsSyncEnabled: true,
      fanslyNewStreamPageAllowlist: "",
    });
    const deletedDetectedAt = new Date("2026-07-14T09:30:00.000Z");
    const [gone, alive] = await upsertFans(appContext.db, [
      {
        platform: "fansly" as const,
        platformUserId: "gone-fan",
        username: null,
        displayName: null,
        deletedDetectedAt,
      },
      {
        platform: "fansly" as const,
        platformUserId: "alive-fan",
        username: "alive",
        displayName: "Alive",
      },
    ]);
    await testDb.pool.query(
      `insert into fan_earnings_stats (
         account_id, fan_id, "window", gross_mills, net_mills,
         currency, observed_at, source_event_id
       )
       values ($1, $2, 'lifetime', 9000, 7000, 'USD', $4::timestamptz, 1),
              ($1, $3, 'lifetime', 4000, 3000, 'USD', $4::timestamptz, 2)`,
      [fansly.id, gone!.id, alive!.id, "2026-07-20T00:00:00.000Z"],
    );

    const body = await fetchTopSpenders(cookie, "tss-fansly");
    const entries = body.entries as Array<{
      platformUserId: string;
      deletedAt: string | null;
    }>;
    expect(entries.map((entry) => entry.platformUserId)).toEqual(["gone-fan", "alive-fan"]);
    expect(entries[0]!.deletedAt).toBe(deletedDetectedAt.toISOString());
    expect(entries[1]!.deletedAt).toBeNull();
  });

  it("returns the bounded top 1000 while keeping the full fanCount", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie, fansly } = await startServer({
      fanslyFanEarningsSyncEnabled: true,
      fanslyNewStreamPageAllowlist: "",
    });
    const fanRows = await upsertFans(appContext.db, Array.from({ length: 1001 }, (_, index) => ({
      platform: "fansly" as const,
      platformUserId: `cap-fan-${String(index).padStart(4, "0")}`,
      username: null,
      displayName: null,
    })));
    await testDb.pool.query(
      `insert into fan_earnings_stats (
         account_id, fan_id, "window", gross_mills, net_mills,
         currency, observed_at, source_event_id
       )
       select $1, seeded.fan_id, 'lifetime', 1000, 800,
              'USD', $3::timestamptz, seeded.ordinality
         from unnest($2::bigint[]) with ordinality as seeded(fan_id, ordinality)`,
      [fansly.id, fanRows.map((fan) => fan.id), "2026-07-12T00:00:00.000Z"],
    );

    const response = await server!.inject({
      method: "GET",
      url: "/api/v1/pages/tss-fansly/top-spenders?window=lifetime&limit=1000",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      fanCount: number;
      entries: Array<{ platformUserId: string }>;
    };
    expect(body.fanCount).toBe(1001);
    expect(body.entries).toHaveLength(1000);
    expect(new Set(body.entries.map((entry) => entry.platformUserId)).size).toBe(1000);
    expect(body.entries[0]!.platformUserId).toBe("cap-fan-0000");
    expect(body.entries[999]!.platformUserId).toBe("cap-fan-0999");
    expect(body.entries.some((entry) => entry.platformUserId === "cap-fan-1000")).toBe(false);

    const legacyLimit = await server!.inject({
      method: "GET",
      url: "/api/v1/pages/tss-fansly/top-spenders?window=lifetime&limit=500",
      headers: { cookie },
    });
    expect(legacyLimit.statusCode).toBe(200);
    const legacyBody = legacyLimit.json() as {
      fanCount: number;
      entries: Array<{ platformUserId: string }>;
    };
    expect(legacyBody.fanCount).toBe(1001);
    expect(legacyBody.entries).toHaveLength(500);
    expect(legacyBody.entries[499]!.platformUserId).toBe("cap-fan-0499");

    const overLimit = await server!.inject({
      method: "GET",
      url: "/api/v1/pages/tss-fansly/top-spenders?window=lifetime&limit=1001",
      headers: { cookie },
    });
    expect(overLimit.statusCode).toBe(400);
    expect(overLimit.json()).toEqual({
      error: "Bad Request",
      message: "querystring/limit Too big: expected number to be <=1000",
      statusCode: 400,
    });
  });
});
