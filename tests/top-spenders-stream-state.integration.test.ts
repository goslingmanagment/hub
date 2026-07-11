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
    // Give the fan_earnings stream a real success + failure history.
    const succeededAt = new Date("2026-07-10T06:00:00Z");
    await testDb.pool.query(
      `update page_sync_states
         set succeeded_at = $2, consecutive_failures = 3
       where page_id = $1 and stream = 'fan_earnings'`,
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
});
