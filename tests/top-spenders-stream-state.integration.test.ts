// W8.1 (A12/A20, decision #133): the pageTopSpenders `source` block. An
// unfed page's `builtAt: null / entries: []` used to be indistinguishable from
// "no spenders" — the response says WHY. The Fansly Sync Engine feeds the
// projection (`fan-earnings.roster`), so the block is that key's live work
// (step 4, S4-18): `ramped` while the engine owns the page and the owner has
// not paused the key, its last applied read and its largest failure count.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  ensureSyncPage,
  upsertDemand,
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
import { setModeDirect } from "./helpers/sync-engine-host.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

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

/** The Fansly page is live on the engine unless `engine` is false. */
async function startServer(options: { engine?: boolean } = {}) {
  appContext = createTestAppContext(testDb!);
  const model = await createModel(appContext.db, { slug: "tss-model", name: "TSS" });
  if (!model) throw new Error("model seed failed");
  const fansly = await createFanslyPage(appContext.db, { modelId: model.id, label: "tss-fansly" });
  if (!fansly) throw new Error("fansly page seed failed");
  if (options.engine !== false) {
    await ensureSyncPage(appContext.db, { pageId: fansly.id });
    await setModeDirect(testDb!.pool, fansly.id, "live");
  }
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

  it("reports flag_off with the honest empty projection on a page the engine does not own", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie } = await startServer({ engine: false });
    const body = await fetchTopSpenders(cookie, "tss-fansly");
    expect(body.builtAt).toBeNull();
    expect(body.entries).toEqual([]);
    expect(body.source).toEqual({
      streamState: "flag_off",
      lastSyncedAt: null,
      consecutiveFailures: null,
    });
  });

  it("reports ramped on a live page before the roster was read, claiming nothing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie } = await startServer();
    const body = await fetchTopSpenders(cookie, "tss-fansly");
    expect(body.source).toEqual({
      streamState: "ramped",
      lastSyncedAt: null,
      consecutiveFailures: 0,
    });
  });

  it("surfaces the roster's last applied read and its failure count", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie, fansly } = await startServer();
    const appliedAt = new Date("2026-09-30T06:00:00.000Z");
    // A finished roster walk with an applied read, then the open one failing.
    const done = await upsertDemand(appContext.db, {
      pageId: fansly.id, shadow: false, resource: "fan-earnings.roster", kind: "goal", class: "planned",
    });
    await testDb.pool.query(
      `insert into sync_attempts (page_id, shadow, work_id, resource, subject, class, owner_generation, setting_ms,
              jitter_u, pause_ms, operation, request, outcome, send_mark, sent_at, completed_at, http_status,
              apply_state, applied_at)
       values ($1, false, $2, 'fan-earnings.roster', '', 'planned', 1, 2000, 0.1, 2200, 'earnings_stats',
               '{}'::jsonb, 'response', 'request_start', $3, $3, 200, 'applied', $3)`,
      [fansly.id, done.id, appliedAt],
    );
    await testDb.pool.query(
      "update sync_work set state = 'done', closed_at = $2, close_reason = 'applied' where id = $1",
      [done.id, appliedAt],
    );
    const open = await upsertDemand(appContext.db, {
      pageId: fansly.id, shadow: false, resource: "fan-earnings.roster", kind: "goal", class: "planned",
    });
    await testDb.pool.query("update sync_work set failure_count = 3 where id = $1", [open.id]);

    const body = await fetchTopSpenders(cookie, "tss-fansly");
    expect(body.source).toEqual({
      streamState: "ramped",
      lastSyncedAt: appliedAt.toISOString(),
      consecutiveFailures: 3,
    });
  });

  it("reports flag_off when the owner paused the roster, or the whole page", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie, fansly } = await startServer();
    await testDb.pool.query(
      "update sync_pages set paused_resources = array['fan-earnings.roster'] where page_id = $1",
      [fansly.id],
    );
    expect((await fetchTopSpenders(cookie, "tss-fansly")).source.streamState).toBe("flag_off");
    await testDb.pool.query(
      "update sync_pages set paused_resources = '{}', paused_all = true where page_id = $1",
      [fansly.id],
    );
    expect((await fetchTopSpenders(cookie, "tss-fansly")).source.streamState).toBe("flag_off");
  });

  it("reports unsupported_platform for an OnlyFans page", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie } = await startServer();
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
    const { cookie, fansly } = await startServer();
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
    const { cookie, fansly } = await startServer();
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
