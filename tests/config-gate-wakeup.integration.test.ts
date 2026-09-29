// Lifting a Stage 16 ramp gate used to change nothing until the stream's next
// slot, and fan_earnings ticks once a day. On 2026-07-17 the allowlist was
// narrowed to "lilly-1,lilly-2"; when it was restored on 2026-07-31 the frozen
// lora pages would have waited up to another 24 h before fetching anything.
// The config PATCH/DELETE now queues the gated streams with source `recovery`.
//
// Two invariants carry most of these cases. It is a TRANSITION detector: only a
// (page, stream) pair that went non-ramped -> ramped is queued, because a gated
// fan_earnings walk costs two Fansly calls per fan and restarts from cursor 0, so
// waking a page whose gate did not just open would spend ~1400 unscheduled
// requests against a platform whose failure mode is a model ban. And it is
// fail-soft: the override is written and audited before the wake-up runs, so a
// wake-up failure must never turn a successful config write into an error.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  getConfigOverrides,
  listConfigAudit,
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

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

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

  it("narrowing the allowlist wakes nothing, including the pages that stay ramped", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Both Fansly pages start ramped under the open baseline.
    const { cookie, gated, other } = await startServer({
      fanslyFanEarningsSyncEnabled: true,
      fanslyPurchaseHistorySyncEnabled: true,
      fanslyNewStreamPageAllowlist: "",
    });

    // Narrowing to a list that STILL contains gate-other. Nothing opened for
    // anybody: gate-fansly lost the gate, gate-other was already through it. A
    // wake-up here would put ~1400 unscheduled Fansly calls on gate-other for a
    // config edit that closed a gate, which is the opposite of the fix.
    const narrowed = await patchConfig(cookie, "fanslyNewStreamPageAllowlist", "gate-other");
    expect(narrowed.statusCode, narrowed.body).toBe(200);

    for (const page of [gated, other]) {
      const states = await syncStates(page.id);
      for (const [stream, row] of states) {
        expect(row.request_seq, `page ${page.id} stream ${stream} must be untouched`).toBe(
          row.applied_seq,
        );
      }
    }
    expect(await listRunnablePageSync(testDb.db)).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("re-writing the same allowlist value wakes nothing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie, gated } = await startServer({
      fanslyFanEarningsSyncEnabled: true,
      fanslyPurchaseHistorySyncEnabled: true,
      fanslyNewStreamPageAllowlist: "gate-fansly",
    });

    // The override writer does not compare old and new, so this PATCH "changes"
    // the key while the gate state stays exactly where it was.
    const rewritten = await patchConfig(cookie, "fanslyNewStreamPageAllowlist", "gate-fansly");
    expect(rewritten.statusCode, rewritten.body).toBe(200);

    const after = await syncStates(gated.id);
    for (const [stream, row] of after) {
      expect(row.request_seq, `stream ${stream} must be untouched`).toBe(row.applied_seq);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("turning a stream flag OFF wakes nothing, including the other gated stream", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie, gated } = await startServer({
      fanslyFanEarningsSyncEnabled: true,
      fanslyPurchaseHistorySyncEnabled: true,
      fanslyNewStreamPageAllowlist: "",
    });

    const disabled = await patchConfig(cookie, "fanslyPurchaseHistorySyncEnabled", false);
    expect(disabled.statusCode, disabled.body).toBe(200);

    const after = await syncStates(gated.id);
    for (const [stream, row] of after) {
      expect(row.request_seq, `stream ${stream} must be untouched`).toBe(row.applied_seq);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("wakes only the page that REGAINS the gate when the narrowing override is DELETEd", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Env baseline is the fully open allowlist; the override is what narrows it,
    // so clearing the override is the "restore every page" path. It is also the
    // only path back to "every page": the string validator refuses an empty
    // override value, so PATCH cannot write it.
    const { cookie, gated, other } = await startServer({
      fanslyFanEarningsSyncEnabled: true,
      fanslyPurchaseHistorySyncEnabled: true,
      fanslyNewStreamPageAllowlist: "",
    });

    const narrowed = await patchConfig(cookie, "fanslyNewStreamPageAllowlist", "gate-other");
    expect(narrowed.statusCode, narrowed.body).toBe(200);

    const cleared = await server!.inject({
      method: "DELETE",
      url: "/api/v1/admin/config/fanslyNewStreamPageAllowlist",
      headers: { cookie },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);

    // gate-fansly went not_allowlisted -> ramped: woken.
    const after = await syncStates(gated.id);
    for (const stream of ["fan_earnings", "purchase_history"] as const) {
      const row = after.get(stream)!;
      expect(row.request_seq).toBeGreaterThan(row.applied_seq);
      expect(row.request_source).toBe("recovery");
    }
    // gate-other was ramped throughout: no transition, no traffic.
    const untouched = await syncStates(other.id);
    for (const [stream, row] of untouched) {
      expect(row.request_seq, `gate-other stream ${stream} must be untouched`).toBe(
        row.applied_seq,
      );
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a failing wake-up still returns 200 and leaves the override durable", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { cookie } = await startServer({
      fanslyFanEarningsSyncEnabled: true,
      fanslyPurchaseHistorySyncEnabled: true,
      fanslyNewStreamPageAllowlist: "some-other-page",
    });
    const warn = vi.spyOn(appContext.logger, "warn");

    // Make every write to page_sync_states raise, so the wake-up fails for a real
    // database reason on a patch that DOES open the gate. The config write itself
    // touches config_overrides / config_audit only, so it is unaffected.
    await testDb.pool.query(`
      create function test_block_page_sync_writes() returns trigger
        language plpgsql as $$
      begin
        raise exception 'induced page_sync_states write failure';
      end;
      $$;
      create trigger test_block_page_sync_writes
        before insert or update on page_sync_states
        for each row execute function test_block_page_sync_writes();
    `);

    try {
      const patched = await patchConfig(cookie, "fanslyNewStreamPageAllowlist", "gate-fansly");
      expect(patched.statusCode, patched.body).toBe(200);

      // The override is written and readable — the failure did not roll it back.
      const overrides = await getConfigOverrides(testDb.db);
      expect(overrides.get("fanslyNewStreamPageAllowlist")?.value).toBe("gate-fansly");
      // ...and it was audited, not silently applied.
      const audit = await listConfigAudit(testDb.db, { key: "fanslyNewStreamPageAllowlist" });
      expect(audit[0]!.newValue).toBe("gate-fansly");
      // Swallowed, but never silent.
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await testDb.pool.query(`
        drop trigger if exists test_block_page_sync_writes on page_sync_states;
        drop function if exists test_block_page_sync_writes();
      `);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
