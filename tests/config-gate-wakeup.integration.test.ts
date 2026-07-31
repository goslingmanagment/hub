// Lifting a Stage 16 ramp gate used to change nothing until the stream's next
// slot, and fan_earnings ticks once a day. On 2026-07-17 the allowlist was
// narrowed to "lilly-1,lilly-2"; when it was restored on 2026-07-31 the frozen
// lora pages would have waited up to another 24 h before fetching anything.
// The config PATCH/DELETE now queues the streams the gate NOW reports as
// ramped, with source `recovery`, and the wake-up is a convenience that can
// never fail the config write it follows.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  listRunnablePageSync,
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
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

type SyncStateRow = {
  stream: string;
  request_seq: number;
  applied_seq: number;
  request_source: string | null;
  status: string;
  blocker_kind: string | null;
};

function sessionCookieFrom(response: { headers: Record<string, unknown> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") {
    throw new Error("Expected a session cookie");
  }
  return value.split(";")[0]!;
}

/** Boots the API over two Fansly pages plus an OnlyFans page (the gate must
 *  never touch a non-Fansly page) and returns an owner cookie. */
async function startServer(configOverrides?: {
  fanslyFanEarningsSyncEnabled?: boolean;
  fanslyPurchaseHistorySyncEnabled?: boolean;
  fanslyNewStreamPageAllowlist?: string;
}) {
  appContext = createTestAppContext(testDb!, configOverrides);
  const model = await createModel(appContext.db, { slug: "gate-model", name: "Gate" });
  if (!model) throw new Error("model seed failed");
  const gated = await createFanslyPage(appContext.db, { modelId: model.id, label: "gate-fansly" });
  const other = await createFanslyPage(appContext.db, { modelId: model.id, label: "gate-other" });
  const onlyfans = await createOnlyFansPage(appContext.db, { modelId: model.id, label: "gate-of" });
  if (!gated || !other || !onlyfans) throw new Error("page seed failed");
  for (const page of [gated, other, onlyfans]) {
    await ensurePageSyncStates(appContext.db, { pageId: page.id });
  }
  // A freshly seeded page is ALREADY requested (buildSeedPageSyncState marks
  // untrusted streams request_seq 1 / recovery), which would mask the very
  // effect under test. Settle every row into a quiet, fully-applied state:
  // request_seq == applied_seq, no source, and a succeeded_at old enough to
  // satisfy purchase_history's dependency on `light`.
  await testDb!.pool.query(`
    update page_sync_states
       set request_seq = 3,
           applied_seq = 3,
           request_source = null,
           dispatch_source = 'scheduled',
           status = 'idle',
           succeeded_at = timestamptz '2026-07-17T14:25:00Z',
           blocker_kind = null,
           blocker_code = null,
           blocker_message = null,
           blocked_at = null,
           retry_kind = null,
           retry_at = null
  `);
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
  return { cookie: sessionCookieFrom(login), gated, other, onlyfans };
}

async function syncStates(pageId: number) {
  const rows = await testDb!.pool.query<SyncStateRow>(
    `select stream, request_seq, applied_seq, request_source, status, blocker_kind
       from page_sync_states
      where page_id = $1`,
    [pageId],
  );
  return new Map(rows.rows.map((row) => [row.stream, row] as const));
}

async function patchConfig(cookie: string, key: string, value: unknown) {
  const response = await server!.inject({
    method: "PATCH",
    url: "/api/v1/admin/config",
    headers: { cookie },
    payload: { patches: [{ key, value }] },
  });
  return response;
}

describe("config ramp-gate wake-up", () => {
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

  it("queues the gated streams of a page the widened allowlist now admits", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie, gated, other, onlyfans } = await startServer({
      fanslyFanEarningsSyncEnabled: true,
      fanslyPurchaseHistorySyncEnabled: true,
      // gate-fansly is OUTSIDE this list, exactly like lora-1 was on 2026-07-17.
      fanslyNewStreamPageAllowlist: "some-other-page",
    });

    const before = await syncStates(gated.id);
    expect(before.get("fan_earnings")!.request_seq).toBe(before.get("fan_earnings")!.applied_seq);
    expect(before.get("purchase_history")!.request_seq).toBe(
      before.get("purchase_history")!.applied_seq,
    );
    // Nothing is runnable while the page sits outside the allowlist.
    expect(await listRunnablePageSync(testDb.db)).toEqual([]);

    // Widen the list to name both Fansly pages. (PATCH cannot write the empty
    // "every page" CSV — the string validator rejects it — so the full restore
    // runs through DELETE; that path has its own case at the bottom.)
    const patched = await patchConfig(cookie, "fanslyNewStreamPageAllowlist", "gate-fansly, gate-other");
    expect(patched.statusCode, patched.body).toBe(200);

    const after = await syncStates(gated.id);
    for (const stream of ["fan_earnings", "purchase_history"] as const) {
      const row = after.get(stream)!;
      expect(row.request_seq).toBeGreaterThan(row.applied_seq);
      expect(row.request_source).toBe("recovery");
      expect(row.status).toBe("pending");
      expect(row.blocker_kind).toBeNull();
    }
    // Only the two gated streams move — the wake-up is not a "sync everything".
    for (const [stream, row] of after) {
      if (stream === "fan_earnings" || stream === "purchase_history") continue;
      expect(row.request_seq, `stream ${stream} must be untouched`).toBe(row.applied_seq);
    }

    // Runnable right now, without waiting for fan_earnings' daily slot. Both
    // Fansly pages qualify under the empty allowlist; the OnlyFans page never does.
    const runnable = await listRunnablePageSync(testDb.db);
    expect(new Set(runnable.map((entry) => entry.pageId))).toEqual(new Set([gated.id, other.id]));

    const otherStates = await syncStates(other.id);
    expect(otherStates.get("fan_earnings")!.request_source).toBe("recovery");
    const onlyfansStates = await syncStates(onlyfans.id);
    for (const [stream, row] of onlyfansStates) {
      expect(row.request_seq, `onlyfans stream ${stream} must be untouched`).toBe(row.applied_seq);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("leaves a page the allowlist still excludes asleep", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie, gated, other } = await startServer({
      fanslyFanEarningsSyncEnabled: true,
      fanslyPurchaseHistorySyncEnabled: true,
      fanslyNewStreamPageAllowlist: "some-other-page",
    });

    // Widening to name ONLY gate-fansly must not wake gate-other.
    const patched = await patchConfig(cookie, "fanslyNewStreamPageAllowlist", "gate-fansly");
    expect(patched.statusCode, patched.body).toBe(200);

    const admitted = await syncStates(gated.id);
    expect(admitted.get("fan_earnings")!.request_seq)
      .toBeGreaterThan(admitted.get("fan_earnings")!.applied_seq);

    const excluded = await syncStates(other.id);
    for (const [stream, row] of excluded) {
      expect(row.request_seq, `stream ${stream} must be untouched`).toBe(row.applied_seq);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("wakes only the stream whose own flag was turned on", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie, gated } = await startServer({
      fanslyFanEarningsSyncEnabled: false,
      fanslyPurchaseHistorySyncEnabled: false,
      fanslyNewStreamPageAllowlist: "",
    });

    const patched = await patchConfig(cookie, "fanslyFanEarningsSyncEnabled", true);
    expect(patched.statusCode, patched.body).toBe(200);

    const after = await syncStates(gated.id);
    const earnings = after.get("fan_earnings")!;
    expect(earnings.request_seq).toBeGreaterThan(earnings.applied_seq);
    expect(earnings.request_source).toBe("recovery");
    // purchase_history's own flag is still off, so its gate still reports flag_off.
    const purchases = after.get("purchase_history")!;
    expect(purchases.request_seq).toBe(purchases.applied_seq);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("does not wake anything when an unrelated config key is patched", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie, gated } = await startServer({
      fanslyFanEarningsSyncEnabled: true,
      fanslyPurchaseHistorySyncEnabled: true,
      fanslyNewStreamPageAllowlist: "",
    });

    const patched = await patchConfig(cookie, "transactionLookbackDays", 14);
    expect(patched.statusCode, patched.body).toBe(200);

    const after = await syncStates(gated.id);
    for (const [stream, row] of after) {
      expect(row.request_seq, `stream ${stream} must be untouched`).toBe(row.applied_seq);
    }
    expect(await listRunnablePageSync(testDb.db)).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("wakes the streams when the narrowing allowlist override is DELETEd", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Env baseline is the fully open allowlist; the override is what narrows it,
    // so clearing the override is the "restore every page" path.
    const { cookie, gated } = await startServer({
      fanslyFanEarningsSyncEnabled: true,
      fanslyPurchaseHistorySyncEnabled: true,
      fanslyNewStreamPageAllowlist: "",
    });

    const narrowed = await patchConfig(cookie, "fanslyNewStreamPageAllowlist", "some-other-page");
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    // Narrowing wakes nothing: no page the gate now calls ramped exists.
    const narrowedStates = await syncStates(gated.id);
    for (const [stream, row] of narrowedStates) {
      expect(row.request_seq, `stream ${stream} must be untouched by a narrowing`).toBe(
        row.applied_seq,
      );
    }

    const cleared = await server!.inject({
      method: "DELETE",
      url: "/api/v1/admin/config/fanslyNewStreamPageAllowlist",
      headers: { cookie },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);

    const after = await syncStates(gated.id);
    for (const stream of ["fan_earnings", "purchase_history"] as const) {
      const row = after.get(stream)!;
      expect(row.request_seq).toBeGreaterThan(row.applied_seq);
      expect(row.request_source).toBe("recovery");
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
