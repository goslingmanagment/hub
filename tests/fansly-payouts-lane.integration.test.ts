// WP-F7 — payout form, paging, coverage and physical-attempt invariants.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getCheckpoint,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";

import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { fanslyPayoutsChunk } from "../apps/runtime/src/services/sync/fansly-payouts.ts";
import { parseFanslyPayoutsCursorState, payoutRequestRows } from "../apps/runtime/src/sync/fansly/lib/payouts-rules.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  LIVE_TOTAL,
  NOW,
  OLDEST_MS,
  PAGE_SIZE,
  ref,
  requestPage,
  stableRequestPage,
} from "./helpers/fansly-payouts-fixtures.ts";
import {
  fanslyLaneAppStub,
  fanslyLaneInput,
  fanslyLaneTelemetryStub as telemetryStub,
  observeFanslyLaneAttempts,
  seedFanslyLanePage,
} from "./helpers/fansly-lane-harness.ts";

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

const NEXT_DAY = new Date("2026-08-23T09:00:00.000Z");

/** The two live payout methods, `metadata` JSON-ENCODED exactly as served. */
function payoutMethods() {
  return [
    {
      id: ref(9001),
      accountId: "acct-payouts",
      providerId: "2",
      type: 1,
      flags: 0,
      status: 3,
      // THE CREDENTIAL. Fabricated on the reserved domain, and present because
      // the journal must be proven to keep it while the projection never sees it.
      metadata: JSON.stringify({ email: "fixture.creator@example.invalid" }),
      version: 0,
    },
    {
      id: ref(9002),
      accountId: "acct-payouts",
      providerId: "30",
      type: 1,
      flags: 0,
      status: 3,
      metadata: JSON.stringify({ field0: "USDT", field1: `${"X".repeat(38)}1a2b` }),
      version: 0,
    },
  ];
}

interface AdapterCall {
  route: string;
  params: Record<string, unknown>;
}

/**
 * An adapter stub that reports ATTEMPTS through the observer, exactly as the
 * real one does: `attemptsPerCall` above 1 is what a retried request looks like
 * to everything downstream of `executeObservedRequest`.
 */
function adapterStub(options: {
  attemptsPerCall?: number;
  page?: (params: { offset: number }, index: number) => unknown;
  methods?: unknown;
  fail?: (route: string) => Error | null;
} = {}) {
  const attemptsPerCall = options.attemptsPerCall ?? 1;
  const calls: AdapterCall[] = [];
  let pageIndex = 0;

  async function observe(
    context: { requestObserver?: { onRequestEvent: (event: unknown) => Promise<void> } | null },
    route: string,
    params: Record<string, unknown>,
  ) {
    const index = calls.length;
    calls.push({ route, params });
    await observeFanslyLaneAttempts(context, {
      attempts: attemptsPerCall,
      requestId: `${route}:${index}`,
      operation: route,
      endpointTemplate: route,
    });
    const failure = options.fail?.(route) ?? null;
    if (failure !== null) {
      throw failure;
    }
  }

  const wrap = (body: unknown) => ({ items: body, raw: body });

  return {
    calls,
    getPayoutMethods: vi.fn(async (context: never) => {
      await observe(context, "payout_methods", {});
      return wrap(options.methods ?? payoutMethods());
    }),
    getPayoutRequestsPage: vi.fn(
      async (context: never, params: { offset: number; limit: number }) => {
        await observe(context, "payout_requests", params as unknown as Record<string, unknown>);
        const index = pageIndex;
        pageIndex += 1;
        return wrap(options.page?.(params, index) ?? requestPage(params.offset));
      },
    ),
  };
}

function appStub(
  adapter: ReturnType<typeof adapterStub>,
  configOverrides: Record<string, unknown> = {},
) {
  return fanslyLaneAppStub({
    database: testDb!,
    adapter,
    config: {
      fanslyPayoutsSyncEnabled: true,
      fanslyPayoutsPageAllowlist: "payouts-lane",
      fanslyPayoutsDailyCallBudget: 20,
      fanslyBackfillContinuationDelayMs: 20_000,
      ...configOverrides,
    },
  });
}

let syncRunId = 0;

async function seedPage() {
  const seeded = await seedFanslyLanePage(testDb!, {
    slug: "payouts",
    name: "Payouts",
    label: "payouts-lane",
    accountRef: "acct-payouts",
    stream: "payouts",
  });
  syncRunId = seeded.syncRunId;
  return seeded.page;
}

function input(
  pageId: number,
  telemetry: ReturnType<typeof telemetryStub>,
  budget = new SyncChunkBudget(),
  now = NOW,
) {
  return fanslyLaneInput({
    pageId,
    label: "payouts-lane",
    accountRef: "acct-payouts",
    egressKey: "fansly:payouts",
    telemetry,
    syncRunId,
    now,
    budget,
  }) as never;
}

async function cursor(pageId: number) {
  const checkpoint = await getCheckpoint(testDb!.db, pageId, "payouts");
  return parseFanslyPayoutsCursorState(checkpoint?.state);
}

async function observations(pageId: number) {
  const result = await testDb!.pool.query(
    `select kind, payload from observations where account_id = $1 order by id`,
    [pageId],
  );
  return result.rows as Array<{ kind: string; payload: unknown }>;
}

/** The request shape the lane recorded for a journaled call — it lives on
 *  `sync_raw_payloads`, beside the body, not on `observations`. */
async function requestParams(pageId: number, endpoint: string) {
  const result = await testDb!.pool.query(
    `select request_params from sync_raw_payloads
      where page_id = $1 and endpoint = $2 order by id`,
    [pageId, endpoint],
  );
  return result.rows.map((row) => (row as { request_params: Record<string, unknown> })
    .request_params);
}

async function coverageRows(pageId: number) {
  const result = await testDb!.pool.query(
    `select plane, scope_ref, status, proof, reason_code, expected_count,
            oldest_captured_at, cursor, proof_observation_id
       from capture_coverage where page_id = $1 order by plane, scope_ref`,
    [pageId],
  );
  return result.rows as Array<Record<string, unknown>>;
}

/** Run chunks until the lane says the slot is satisfied, or the guard trips. */
async function drainAll(
  pageId: number,
  adapter: ReturnType<typeof adapterStub>,
  telemetry: ReturnType<typeof telemetryStub>,
  now = NOW,
  maxChunks = 30,
) {
  const results: Array<Awaited<ReturnType<typeof fanslyPayoutsChunk>>> = [];
  for (let chunk = 0; chunk < maxChunks; chunk += 1) {
    const result = await fanslyPayoutsChunk(
      appStub(adapter),
      input(pageId, telemetry, new SyncChunkBudget(), now),
    );
    results.push(result);
    if (result.satisfied) {
      break;
    }
  }
  return results;
}

async function drain(
  pageId: number,
  adapter: ReturnType<typeof adapterStub>,
  telemetry: ReturnType<typeof telemetryStub>,
  now = NOW,
  maxChunks = 30,
) {
  const results = await drainAll(pageId, adapter, telemetry, now, maxChunks);
  return results[results.length - 1] ?? null;
}

describe("[sync-critical] WP-F7 payouts lane", () => {
  it("is INERT until both gates open", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const adapter = adapterStub();
    const telemetry = telemetryStub();

    const flagOff = await fanslyPayoutsChunk(
      appStub(adapter, { fanslyPayoutsSyncEnabled: false }),
      input(page.id, telemetry),
    );
    expect(flagOff.gatedSkip).toBe("flag_off");

    // FAIL-CLOSED: an EMPTY allowlist is NO pages, not every page. On a lane
    // that reads payout credentials, the `empty = all` semantic would have
    // opened the fleet on the deploy that shipped it.
    const notAllowlisted = await fanslyPayoutsChunk(
      appStub(adapter, { fanslyPayoutsPageAllowlist: "" }),
      input(page.id, telemetry),
    );
    expect(notAllowlisted.gatedSkip).toBe("not_allowlisted");

    const otherPage = await fanslyPayoutsChunk(
      appStub(adapter, { fanslyPayoutsPageAllowlist: "someone-else" }),
      input(page.id, telemetry),
    );
    expect(otherPage.gatedSkip).toBe("not_allowlisted");

    expect(adapter.calls).toHaveLength(0);
    expect(await observations(page.id)).toHaveLength(0);
  });

  it("walks the whole history in NINE request calls and records the floor", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const adapter = adapterStub();
    const telemetry = telemetryStub();

    const result = await drain(page.id, adapter, telemetry);
    expect(result?.satisfied).toBe(true);

    // ONE method listing plus NINE request pages: 83 rows at a page size of 10.
    // The daily head read at offset 0 IS page one of the walk, which is what
    // makes it nine rather than ten.
    const methodCalls = adapter.calls.filter((call) => call.route === "payout_methods");
    const requestCalls = adapter.calls.filter((call) => call.route === "payout_requests");
    expect(methodCalls).toHaveLength(1);
    expect(requestCalls).toHaveLength(9);
    expect(requestCalls.map((call) => call.params.offset))
      .toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80]);

    // THE QUERY FORM, on every page: `before`/`after` present and EMPTY.
    for (const call of requestCalls) {
      expect(call.params.before).toBe("");
      expect(call.params.after).toBe("");
      expect(call.params.limit).toBe(10);
    }

    const state = await cursor(page.id);
    expect(state?.walkDone).toBe(true);
    expect(state?.walkPages).toBe(9);
    expect(state?.walkTotal).toBe(LIVE_TOTAL);
    // THE FLOOR: the oldest `createdAt` anywhere in the walk.
    expect(state?.floorMs).toBe(OLDEST_MS);
    expect(state?.callsToday).toBe(10);

    // Every fetched page is journaled, under its own kind.
    const journaled = await observations(page.id);
    expect(journaled.filter((row) => row.kind === "payout_methods")).toHaveLength(1);
    expect(journaled.filter((row) => row.kind === "payout_requests")).toHaveLength(9);

    // And the REQUEST SHAPE is journaled beside the body, so a replay can tell
    // which offset a page came from.
    expect(await requestParams(page.id, "payout_requests")).toEqual(
      [0, 10, 20, 30, 40, 50, 60, 70, 80].map((offset) => ({
        before: "",
        after: "",
        limit: 10,
        offset,
      })),
    );

    const coverage = await coverageRows(page.id);
    expect(coverage.map((row) => [row.plane, row.scope_ref, row.status])).toEqual([
      ["payouts", "payout_methods", "provider_exhausted"],
      ["payouts", "payout_requests", "provider_exhausted"],
    ]);
    const requests = coverage.find((row) => row.scope_ref === "payout_requests")!;
    expect(requests.proof).toBe("terminal_response");
    expect(requests.reason_code).toBe("walk_exhausted");
    // `expected_count` is a bigint column, so the driver hands it back as one.
    expect(Number(requests.expected_count)).toBe(LIVE_TOTAL);
    // The floor, PROVED by a journaled response.
    expect(new Date(requests.oldest_captured_at as string).getTime()).toBe(OLDEST_MS);
  });

  it("JOURNALS THE CREDENTIAL VERBATIM — the mask is a projection rule", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const adapter = adapterStub();
    await drain(page.id, adapter, telemetryStub());

    const journaled = await observations(page.id);
    const methods = journaled.find((row) => row.kind === "payout_methods")!;
    // CAPTURE FIRST (DP 7). An over-eager scrubber here would destroy the only
    // copy of the fact, and the fact is what a rebuild replays from. The mask
    // belongs one layer down, where it can be replayed and corrected; the
    // journal's job is to be true.
    expect(JSON.stringify(methods.payload)).toContain("fixture.creator@example.invalid");
    // Nothing was trimmed on the way in: no `accounts[]` sidecar exists on
    // either payout body, so [A20] has nothing to narrow and the row is the
    // response.
    expect(methods.payload).toEqual(payoutMethods());
  });

  it("settles into TWO calls a day once the floor has been reached", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const adapter = adapterStub();
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);
    const firstDayCalls = adapter.calls.length;
    expect(firstDayCalls).toBe(10);

    // The SAME UTC day: the sweep is done and the walk is done, so a re-dispatch
    // spends nothing at all.
    const sameDay = await fanslyPayoutsChunk(appStub(adapter), input(page.id, telemetry));
    expect(sameDay.satisfied).toBe(true);
    expect(adapter.calls).toHaveLength(firstDayCalls);

    // The NEXT UTC day: one method listing, one head page. That is the steady
    // state, and it is the number §6.1 books this lane at.
    const nextDay = await drain(page.id, adapter, telemetry, NEXT_DAY);
    expect(nextDay?.satisfied).toBe(true);
    expect(adapter.calls.length - firstDayCalls).toBe(2);
    expect(adapter.calls.slice(firstDayCalls).map((call) => call.route))
      .toEqual(["payout_methods", "payout_requests"]);
    // The head read, and ONLY the head read — the walk is not re-opened.
    expect(adapter.calls[firstDayCalls + 1]!.params.offset).toBe(0);

    const state = await cursor(page.id);
    // A new UTC day resets the attempt counter; the walk's cursor does not move.
    expect(state?.callsToday).toBe(2);
    expect(state?.walkDone).toBe(true);
    expect(state?.walkPages).toBe(9);
  });

  it("stops on a SHORT page even when `total` says otherwise", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // A provider whose `total` is stale or wrong. The SHORT page is the stop
    // condition that is always true; `total` is the hint beside it.
    const adapter = adapterStub({
      page: (params) => ({
        total: 900,
        data: requestPage(params.offset, 14).data,
      }),
    });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    const requestCalls = adapter.calls.filter((call) => call.route === "payout_requests");
    expect(requestCalls.map((call) => call.params.offset)).toEqual([0, 10]);
    const state = await cursor(page.id);
    expect(state?.walkDone).toBe(true);
    // The lane did not invent a floor beyond what it actually read.
    expect(state?.walkTotal).toBe(900);
    expect(state?.walkStop).toBe("short_before_total");

    // ...and it does not CLAIM one either. The page's own `total` counts rows
    // past the 14 it served, so the history is partial, and says why — once.
    const shortStops = telemetry.anomalies
      .filter((a) => a.code === "fansly_payouts_short_before_total");
    expect(shortStops).toHaveLength(1);
    expect(shortStops[0]!.details).toMatchObject({ offset: 10, rows: 4, total: 900 });
    const requests = async () => (await coverageRows(page.id))
      .find((row) => row.scope_ref === "payout_requests")!;
    expect((await requests()).status).toBe("partial_provider_surface");
    expect((await requests()).reason_code).toBe("short_before_total");
    expect((await requests()).proof).toBe("terminal_response");
    expect(Number((await requests()).expected_count)).toBe(900);
    // The proof is the SHORT page that stopped the walk, not the head before it.
    const requestObservationIds = async () => (await testDb!.pool.query(
      `select id from observations where account_id = $1 and kind = 'payout_requests'
        order by id`,
      [page.id],
    )).rows.map((row) => String((row as { id: unknown }).id));
    const [headObservationId, shortObservationId] = await requestObservationIds();
    const stopProof = String((await requests()).proof_observation_id);
    expect(stopProof).toBe(shortObservationId);
    expect(stopProof).not.toBe(headObservationId);

    // The NEXT day's head read restates the stop rather than upgrading it, and
    // the stop alone never re-opens the walk: two calls, as on any steady day.
    const firstDayCalls = adapter.calls.length;
    await drain(page.id, adapter, telemetry, NEXT_DAY);
    expect(adapter.calls.slice(firstDayCalls).map((call) => [call.route, call.params.offset]))
      .toEqual([["payout_methods", undefined], ["payout_requests", 0]]);
    expect((await requests()).status).toBe("partial_provider_surface");
    expect((await requests()).reason_code).toBe("short_before_total");
    // A head read proves nothing about where the walk stopped: it restates the
    // claim with proof 'none', and the stored proof still names the short page.
    expect((await requests()).proof).toBe("none");
    expect(String((await requests()).proof_observation_id)).toBe(stopProof);
    expect((await cursor(page.id))?.walkDone).toBe(true);
    expect(telemetry.anomalies
      .filter((a) => a.code === "fansly_payouts_short_before_total")).toHaveLength(1);
  });

  it("claims a partial history when the HEAD page is short of its own `total`", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const adapter = adapterStub({
      page: (params) => ({ total: 900, data: requestPage(params.offset, 4).data }),
    });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    expect(adapter.calls.filter((call) => call.route === "payout_requests")
      .map((call) => call.params.offset)).toEqual([0]);
    expect((await cursor(page.id))?.walkStop).toBe("short_before_total");
    expect(telemetry.anomalies.map((a) => a.code))
      .toEqual(["fansly_payouts_short_before_total"]);
    const requests = (await coverageRows(page.id))
      .find((row) => row.scope_ref === "payout_requests")!;
    expect(requests.status).toBe("partial_provider_surface");
    expect(requests.reason_code).toBe("short_before_total");
  });

  it("STOPS on a repeated offset with one anomaly, and never loops", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // A provider that IGNORES `offset` and serves page one forever — the shape a
    // walk can spend a whole day's cap proving. `total` never lets it stop and
    // every page is full, so only the guard ends it. And note WHICH trigger has
    // to fire: the offset itself advances 0, 10, 20 by construction, so a guard
    // that only compared offsets would never notice.
    const adapter = adapterStub({ page: () => requestPage(0, 900) });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    const state = await cursor(page.id);
    expect(state?.walkDone).toBe(true);
    // It did NOT spend the day's cap. Two request pages — the head, then the
    // one that proved the server was not advancing.
    expect(state?.callsToday).toBe(3);
    expect(adapter.calls.filter((call) => call.route === "payout_requests")).toHaveLength(2);

    const repeats = telemetry.anomalies.filter((a) => a.code === "fansly_payouts_offset_repeat");
    expect(repeats).toHaveLength(1);
    expect((repeats[0]!.details as { offset: number }).offset).toBe(10);

    const coverage = await coverageRows(page.id);
    const requests = coverage.find((row) => row.scope_ref === "payout_requests")!;
    expect(requests.status).toBe("partial_provider_surface");
    expect(requests.reason_code).toBe("repeat_request");
    // The page that proved it is STILL JOURNALED — it is evidence about the
    // provider, and a guard that dropped it would leave nothing to diagnose.
    expect((await observations(page.id)).filter((row) => row.kind === "payout_requests"))
      .toHaveLength(2);

    // And the claim OUTLIVES the day: the next head read restates the partial
    // stop instead of calling the history exhausted.
    await drain(page.id, adapter, telemetry, NEXT_DAY);
    const nextDay = (await coverageRows(page.id))
      .find((row) => row.scope_ref === "payout_requests")!;
    expect(nextDay.status).toBe("partial_provider_surface");
    expect(nextDay.reason_code).toBe("repeat_request");
    expect(adapter.calls.filter((call) => call.route === "payout_requests")).toHaveLength(3);
  });

  it("CATCHES UP when more payouts landed than the head holds, and stops at the overlap", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    let total = LIVE_TOTAL;
    const adapter = adapterStub({ page: (params) => stableRequestPage(params.offset, total) });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);
    const firstDayCalls = adapter.calls.length;
    expect(firstDayCalls).toBe(10);

    // 25 payouts land while the lane is down: the head holds ten of them, and
    // the other fifteen now sit at offsets 10-24, where no head read reaches.
    total = LIVE_TOTAL + 25;
    const result = await drain(page.id, adapter, telemetry, NEXT_DAY);
    expect(result?.satisfied).toBe(true);
    // The head, then offset 10, then offset 20 — whose rows reach the ones the
    // previous head held — and nothing past it.
    expect(adapter.calls.slice(firstDayCalls).filter((call) => call.route === "payout_requests")
      .map((call) => call.params.offset)).toEqual([0, 10, 20]);
    expect(telemetry.anomalies.map((a) => a.code)).toEqual(["fansly_payouts_head_gap"]);

    // Every new payout is journaled...
    const journaledRefs = new Set(
      (await observations(page.id))
        .filter((row) => row.kind === "payout_requests")
        .flatMap((row) => payoutRequestRows(row.payload).map((payout) => payout.id)),
    );
    for (let n = LIVE_TOTAL; n < total; n += 1) {
      expect(journaledRefs.has(ref(20000 + n))).toBe(true);
    }
    // ...and the history is exactly as exhausted as it was before.
    const state = await cursor(page.id);
    expect(state?.walkDone).toBe(true);
    expect(state?.walkStop).toBe("exhausted");
    expect(state?.catchUp).toBeNull();
    const requests = (await coverageRows(page.id))
      .find((row) => row.scope_ref === "payout_requests")!;
    expect(requests.status).toBe("provider_exhausted");
    expect(requests.reason_code).toBe("walk_exhausted");
    expect(Number(requests.expected_count)).toBe(total);
  });

  it("does not catch up while the head still overlaps the previous one", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    let total = LIVE_TOTAL;
    const adapter = adapterStub({ page: (params) => stableRequestPage(params.offset, total) });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);
    const firstDayCalls = adapter.calls.length;

    // Three new payouts: the head still carries seven it held yesterday.
    total = LIVE_TOTAL + 3;
    await drain(page.id, adapter, telemetry, NEXT_DAY);
    expect(adapter.calls.length - firstDayCalls).toBe(2);

    // Exactly a head page of new payouts shares nothing with yesterday's head,
    // so ONE page past it is read, and it is yesterday's head.
    const secondDayCalls = adapter.calls.length;
    total += 10;
    await drain(page.id, adapter, telemetry, new Date("2026-08-24T09:00:00.000Z"));
    expect(adapter.calls.slice(secondDayCalls).filter((call) => call.route === "payout_requests")
      .map((call) => call.params.offset)).toEqual([0, 10]);
    expect((await cursor(page.id))?.walkDone).toBe(true);
  });

  it("never upgrades a PARTIAL history when a catch-up reaches the overlap", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // Day one: a server ignoring `offset`, so the walk stops partial on its
    // second page.
    let total = 30;
    let honoursOffset = false;
    const adapter = adapterStub({
      page: (params) => stableRequestPage(honoursOffset ? params.offset : 0, total),
    });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);
    expect((await cursor(page.id))?.walkStop).toBe("repeat_request");

    // Day two: 15 new payouts, and a server that pages properly again.
    const firstDayCalls = adapter.calls.length;
    total += 15;
    honoursOffset = true;
    await drain(page.id, adapter, telemetry, NEXT_DAY);
    // Offsets 10-14 are new, 15-24 are yesterday's head: one page past the head.
    expect(adapter.calls.slice(firstDayCalls).filter((call) => call.route === "payout_requests")
      .map((call) => call.params.offset)).toEqual([0, 10]);
    expect(telemetry.anomalies.filter((a) => a.code === "fansly_payouts_head_gap")).toHaveLength(1);

    // The catch-up reached new rows at the head, not the rows the first walk
    // never read: the claim stays what it was.
    const state = await cursor(page.id);
    expect(state?.walkDone).toBe(true);
    expect(state?.walkStop).toBe("repeat_request");
    const requests = (await coverageRows(page.id))
      .find((row) => row.scope_ref === "payout_requests")!;
    expect(requests.status).toBe("partial_provider_surface");
    expect(requests.reason_code).toBe("repeat_request");
  });

  it("catches up by `total` from a cursor saved before head refs were kept", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    let total = LIVE_TOTAL;
    const adapter = adapterStub({ page: (params) => stableRequestPage(params.offset, total) });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);
    // The cursor as the lane wrote it before this change.
    await testDb!.pool.query(
      `update page_sync_cursors set state = state - 'headRefs' - 'walkStop' - 'catchUp'
        where page_id = $1 and stream = 'payouts'`,
      [page.id],
    );
    const legacy = await cursor(page.id);
    expect(legacy?.headRefs).toEqual([]);
    expect(legacy?.walkStop).toBe("exhausted");

    // `total` grew by 25: the walk reads exactly past offset 24 and stops.
    const firstDayCalls = adapter.calls.length;
    total = LIVE_TOTAL + 25;
    await drain(page.id, adapter, telemetry, NEXT_DAY);
    expect(adapter.calls.slice(firstDayCalls).filter((call) => call.route === "payout_requests")
      .map((call) => call.params.offset)).toEqual([0, 10, 20]);
    const state = await cursor(page.id);
    expect(state?.walkDone).toBe(true);
    expect(state?.walkStop).toBe("exhausted");
    expect(state?.headRefs).toHaveLength(PAGE_SIZE);
  });

  it("DEFERS at the cap in ATTEMPTS, keeping the page it already fetched", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // Every call retries twice, so four logical calls spend eight ATTEMPTS —
    // the unit the cap is enforced in, because a retried request costs the
    // platform exactly as much as a first one.
    const adapter = adapterStub({ attemptsPerCall: 2 });
    const telemetry = telemetryStub();

    const results: Array<Awaited<ReturnType<typeof fanslyPayoutsChunk>>> = [];
    for (let chunk = 0; chunk < 6; chunk += 1) {
      const result = await fanslyPayoutsChunk(
        appStub(adapter, { fanslyPayoutsDailyCallBudget: 6 }),
        input(page.id, telemetry, new SyncChunkBudget()),
      );
      results.push(result);
      if (result.satisfied) {
        break;
      }
    }

    const last = results[results.length - 1]!;
    expect(last.satisfied).toBe(false);
    expect((last.stats as Record<string, unknown>).deferred).toBe("daily_call_budget");
    // The deferral is to the next UTC day, not to a retry a minute later.
    expect((last.continuationRetryAt as Date).toISOString()).toBe("2026-08-23T00:05:00.000Z");

    const state = await cursor(page.id);
    expect(state?.callsToday).toBeGreaterThanOrEqual(6);
    // NEVER DROPS. Every response fetched before the cap bit is in the journal,
    // and the walk cursor points at the page it did not reach.
    const journaled = await observations(page.id);
    expect(journaled.length).toBe(adapter.calls.length);
    expect(state?.walkDone).toBe(false);
    expect(state?.walkOffset).toBeGreaterThan(0);

    // And the next UTC day resumes at exactly that offset rather than the head.
    const beforeResume = adapter.calls.length;
    await drain(page.id, adapter, telemetry, NEXT_DAY);
    const resumed = adapter.calls.slice(beforeResume)
      .filter((call) => call.route === "payout_requests")
      .map((call) => call.params.offset);
    expect(resumed[0]).toBe(0);
    expect(resumed).toContain(state!.walkOffset);
  });

  it("raises ONE anomaly per unknown status code, and stays quiet on 8", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // Two rows carrying code 4 and one carrying 6, spread across pages so the
    // "once per code" claim is about the CODE and not about the page.
    const adapter = adapterStub({
      page: (params) => {
        const base = requestPage(params.offset, 25);
        const rows = base.data.map((row, index) => (
          index === 0 ? { ...row, status: 4 } : index === 1 ? { ...row, status: 6 } : row
        ));
        return { total: 25, data: rows };
      },
    });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    const unknown = telemetry.anomalies.filter((a) => a.code === "fansly_payout_status_unknown");
    // Three pages, six unknown-status rows, TWO anomalies — one per code.
    expect(unknown).toHaveLength(2);
    expect(unknown.map((a) => (a.details as { statusCode: number }).statusCode).sort())
      .toEqual([4, 6]);
    expect((await cursor(page.id))?.unknownStatusCodes).toEqual([4, 6]);

    // And the memory is DURABLE: the next day's sweep sees the same codes and
    // says nothing.
    await drain(page.id, adapter, telemetry, NEXT_DAY);
    expect(telemetry.anomalies.filter((a) => a.code === "fansly_payout_status_unknown"))
      .toHaveLength(2);
  });

  it("says nothing at all when every row carries the one mapped code", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const telemetry = telemetryStub();
    await drain(page.id, adapterStub(), telemetry);
    // All 83 live rows were status 8. A lane that warned about the normal case
    // would train its reader to ignore it.
    expect(telemetry.anomalies).toHaveLength(0);
  });

  it("re-raises 401/403 untouched, with the steps already taken journaled", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const adapter = adapterStub({
      fail: (route) =>
        route === "payout_requests"
          ? new FanslyApiError("forbidden", 403, undefined, undefined)
          : null,
    });
    const telemetry = telemetryStub();

    await expect(
      fanslyPayoutsChunk(appStub(adapter), input(page.id, telemetry)),
    ).rejects.toMatchObject({ status: 403 });

    // The method listing landed BEFORE the failure and stays. A dead session is
    // the executor's problem to pause on; it is never a reason to lose bytes
    // that are already ours.
    const journaled = await observations(page.id);
    expect(journaled.map((row) => row.kind)).toEqual(["payout_methods"]);
    // The step index is durable, so the retry after the session is repaired
    // resumes at the request page rather than re-reading the methods.
    expect((await cursor(page.id))?.fixedStepIndex).toBe(1);
  });

  it("reports the money-out census in its progress block", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const results = await drainAll(page.id, adapterStub(), telemetryStub());
    // `journaled` is PER DISPATCH — it says what this chunk captured, not what
    // the lane has. Summed across the drain it is the whole first-enable cost.
    const journaledTotal = results.reduce(
      (sum, chunk) => sum + Number((chunk.stats as Record<string, unknown>).journaled ?? 0),
      0,
    );
    expect(journaledTotal).toBe(10);

    const stats = results[results.length - 1]!.stats as Record<string, unknown>;
    expect(stats.phase).toBe("steady");
    // ...and `callsToday` is DURABLE, which is why the cap reads it and not the
    // per-dispatch counter.
    expect(stats.callsToday).toBe(10);
    expect(stats.dailyCap).toBe(20);
    expect(stats.walkDone).toBe(true);
    expect(stats.walkPages).toBe(9);
    expect(stats.walkTotal).toBe(LIVE_TOTAL);
    // The counts come from the PROJECTION, which has not run in this test — so
    // they are honestly zero rather than a number the capture plane invented.
    expect(stats.methodCount).toBe(0);
    expect(stats.payoutCount).toBe(0);
    expect(stats.oldestPayoutAt).toBeNull();
  });
});
