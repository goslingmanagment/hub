// WP-F3 — catalog form, paging, coverage and physical-attempt invariants.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getCheckpoint,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";

import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import {
  fanslyCatalogChunk,
  nextVaultCursor,
  parseFanslyCatalogCursorState,
  vaultMediaRows,
  walkContinuationAt,
} from "../apps/runtime/src/services/sync/fansly-catalog.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
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

const NOW = new Date("2026-08-22T09:00:00.000Z");

function ref(n: number): string {
  return `0009${String(10000000000000 + n).padStart(14, "0")}`;
}

/** The [A20] hazard, in the shape the envelope family serves it. */
function fullAccountSidecar() {
  return [{
    id: ref(9001),
    username: "fixture_fan",
    displayName: "Fixture Fan",
    createdAt: 1690000000,
    followsYou: true,
    notes: "fixture note",
    // The eight [A20]-rejected fields; `lastSeenAt` is the one that moves every
    // minute and destroys the dedup collapse.
    lastSeenAt: 1787000123,
    followCount: 41,
    subscriberCount: 7,
    postLikes: 19,
    accountMediaLikes: 4,
    timelineStats: { imageCount: 12 },
    streaming: { lastFetchedAt: 0 },
    version: 3,
  }];
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
  vaultPage?: (params: Record<string, unknown>, index: number) => unknown;
  fail?: (route: string) => Error | null;
  albums?: unknown;
} = {}) {
  const attemptsPerCall = options.attemptsPerCall ?? 1;
  const calls: AdapterCall[] = [];
  let vaultIndex = 0;

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
    getVaultAlbums: vi.fn(async (context: never) => {
      await observe(context, "vault_albums", {});
      return wrap(options.albums ?? { albums: [], aggregationData: { media: [] } });
    }),
    getUserVaultAlbums: vi.fn(async (context: never, params: { accountId: string }) => {
      await observe(context, "uservault_albums", params);
      // The sidecar rides HERE in the live shape, which is where the [A20]
      // allowlist has to bite.
      return wrap({ albums: [], aggregationData: { media: [] }, accounts: fullAccountSidecar() });
    }),
    getSubscriptionTiers: vi.fn(async (context: never) => {
      await observe(context, "subscription_tiers", {});
      return wrap([]);
    }),
    getGiftCodes: vi.fn(async (context: never) => {
      await observe(context, "gift_codes", {});
      return wrap([]);
    }),
    getAutomatedMessages: vi.fn(async (context: never) => {
      await observe(context, "automated_messages", {});
      return wrap([]);
    }),
    getAccountWalls: vi.fn(async (context: never, params: Record<string, unknown>) => {
      await observe(context, "account_walls", params);
      return wrap([]);
    }),
    getVaultMediaPage: vi.fn(async (context: never, params: Record<string, unknown>) => {
      await observe(context, "vault_media", params);
      const index = vaultIndex;
      vaultIndex += 1;
      return wrap(options.vaultPage?.(params, index) ?? { albumMedia: [], media: [] });
    }),
    getAccountMediaByIds: vi.fn(async (context: never, params: Record<string, unknown>) => {
      await observe(context, "account_media_batch", params);
      return wrap([]);
    }),
    getAccountMediaBundlesByIds: vi.fn(async (context: never, params: Record<string, unknown>) => {
      await observe(context, "account_media_bundle_batch", params);
      return wrap([]);
    }),
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
      fanslyCatalogSyncEnabled: true,
      fanslyCatalogPageAllowlist: "catalog-lane",
      fanslyCatalogDailyCallBudget: 60,
      fanslyBackfillContinuationDelayMs: 20_000,
      ...configOverrides,
    },
  });
}

let syncRunId = 0;

async function seedPage() {
  const seeded = await seedFanslyLanePage(testDb!, {
    slug: "catalog",
    name: "Catalog",
    label: "catalog-lane",
    accountRef: "acct-catalog",
    stream: "catalog",
  });
  syncRunId = seeded.syncRunId;
  return seeded.page;
}

/** The walk reads albums from the PROJECTION, so a walk test seeds it there. */
async function seedAlbum(
  pageId: number,
  albumRef: string,
  itemCount: number | null,
  lastItemRef: string | null,
) {
  await testDb!.pool.query(
    `insert into creator_vault_albums (
       page_id, platform, vault_kind, album_ref, item_count, last_item_ref, pos,
       first_observed_at, last_observed_at, content_hash, source_event_id,
       source_observation_id, source_account_seq
     ) values ($1, 'fansly', 'creator', $2, $3, $4, 0, now(), now(), repeat('a', 64), 1, 1, 1)`,
    [pageId, albumRef, itemCount, lastItemRef],
  );
}

function input(
  pageId: number,
  telemetry: ReturnType<typeof telemetryStub>,
  budget = new SyncChunkBudget(),
  now = NOW,
) {
  return fanslyLaneInput({
    pageId,
    label: "catalog-lane",
    accountRef: "acct-catalog",
    egressKey: "fansly:catalog",
    telemetry,
    syncRunId,
    now,
    budget,
  }) as never;
}

async function cursor(pageId: number) {
  const checkpoint = await getCheckpoint(testDb!.db, pageId, "catalog");
  return parseFanslyCatalogCursorState(checkpoint?.state);
}

async function observations(pageId: number) {
  const result = await testDb!.pool.query(
    `select kind, payload from observations where account_id = $1 order by id`,
    [pageId],
  );
  return result.rows as Array<{ kind: string; payload: Record<string, unknown> }>;
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
    `select plane, scope_ref, status, proof, reason_code, expected_count, cursor
       from capture_coverage where page_id = $1 order by plane, scope_ref`,
    [pageId],
  );
  return result.rows as Array<Record<string, unknown>>;
}

/** Run chunks until the lane says the slot is satisfied, or the guard trips. */
async function drain(
  pageId: number,
  adapter: ReturnType<typeof adapterStub>,
  telemetry: ReturnType<typeof telemetryStub>,
  maxChunks = 30,
) {
  let result: Awaited<ReturnType<typeof fanslyCatalogChunk>> | null = null;
  for (let chunk = 0; chunk < maxChunks; chunk += 1) {
    result = await fanslyCatalogChunk(
      appStub(adapter),
      input(pageId, telemetry, new SyncChunkBudget()),
    );
    if (result.satisfied) {
      break;
    }
  }
  return result;
}

describe("[sync-critical] WP-F3 catalog lane", () => {
  it("is INERT until both gates open", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const adapter = adapterStub();
    const telemetry = telemetryStub();

    const flagOff = await fanslyCatalogChunk(
      appStub(adapter, { fanslyCatalogSyncEnabled: false }),
      input(page.id, telemetry),
    );
    expect(flagOff.gatedSkip).toBe("flag_off");

    // FAIL-CLOSED: an empty allowlist is NO pages, never all of them. Reading
    // this lane through the shared new-stream key would open it fleet-wide on
    // the deploy that ships it.
    const notListed = await fanslyCatalogChunk(
      appStub(adapter, { fanslyCatalogPageAllowlist: "" }),
      input(page.id, telemetry),
    );
    expect(notListed.gatedSkip).toBe("not_allowlisted");
    expect(adapter.calls).toHaveLength(0);
  });

  it("takes the six fixed steps once a day, each journaled under its own kind", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const adapter = adapterStub();
    const telemetry = telemetryStub();

    const result = await drain(page.id, adapter, telemetry);
    expect(result?.satisfied).toBe(true);

    const kinds = (await observations(page.id)).map((row) => row.kind);
    expect(kinds).toEqual([
      "vault_albums",
      "uservault_albums",
      "subscription_tiers",
      "gift_codes",
      "automated_messages",
      "account_walls",
    ]);
    // The page's OWN account ref, from `pages.external_page_id` — never guessed.
    expect(adapter.getUserVaultAlbums.mock.calls[0]?.[1]).toEqual({ accountId: "acct-catalog" });

    // A SECOND dispatch on the same UTC day re-takes nothing.
    const before = adapter.calls.length;
    await drain(page.id, adapter, telemetry);
    expect(adapter.calls).toHaveLength(before);

    // A new UTC day re-arms them.
    await fanslyCatalogChunk(
      appStub(adapter),
      input(page.id, telemetry, new SyncChunkBudget(), new Date("2026-08-23T09:00:00.000Z")),
    );
    expect(adapter.calls.length).toBeGreaterThan(before);
  });

  it("skips the user vault LOUDLY when the page has no own account ref", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const adapter = adapterStub();
    const telemetry = telemetryStub();
    // `pages.external_page_id` is null until the `light` sync writes it, and
    // the lane reads it off the resolved page context.
    const request = input(page.id, telemetry) as {
      pageContext: { page: { platformAccountId: string | null } };
    };
    request.pageContext.page.platformAccountId = null;
    for (let chunk = 0; chunk < 5; chunk += 1) {
      const result = await fanslyCatalogChunk(appStub(adapter), request as never);
      if (result.satisfied) break;
    }

    // Guessing an account ref would ask the platform about somebody else's
    // vault, so the step is skipped and the coverage row says which and why.
    expect(adapter.getUserVaultAlbums).not.toHaveBeenCalled();
    const row = (await coverageRows(page.id))
      .find((entry) => entry.scope_ref === "uservault_albums");
    expect(row?.status).toBe("partial_provider_surface");
    expect(row?.reason_code).toBe("own_account_ref_unknown");
  });

  it("[A20] allowlists the embedded accounts[] before the body reaches the journal", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const adapter = adapterStub();
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    const row = (await observations(page.id)).find((entry) => entry.kind === "uservault_albums");
    const accounts = (row?.payload.accounts ?? []) as Record<string, unknown>[];
    expect(accounts).toHaveLength(1);
    // The kept fields survive verbatim…
    expect(accounts[0]?.followsYou).toBe(true);
    expect(accounts[0]?.notes).toBe("fixture note");
    // …and every one of the eight rejected fields is gone. `lastSeenAt` is the
    // one that matters: it moves every minute, so journaling it would make
    // every body unique and destroy the dedup collapse the disk budget rests on.
    for (
      const rejected of [
        "lastSeenAt",
        "followCount",
        "subscriberCount",
        "postLikes",
        "accountMediaLikes",
        "timelineStats",
        "streaming",
        "version",
      ]
    ) {
      expect(Object.hasOwn(accounts[0] ?? {}, rejected), rejected).toBe(false);
    }
    // Every OTHER key of the response is untouched — [A20] narrowed one array,
    // not the response.
    expect(Object.hasOwn(row?.payload ?? {}, "aggregationData")).toBe(true);
  });

  it("walks a vault album in the APP's query form, and pages on the member id", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedAlbum(page.id, ref(101), 2, ref(903));
    const adapter = adapterStub({
      vaultPage: (_params, index) =>
        index === 0
          ? {
            albumMedia: [
              { id: ref(901), mediaId: ref(601), albumId: ref(101), createdAt: 1786556663000 },
              { id: ref(902), mediaId: ref(602), albumId: ref(101), createdAt: 1786556664000 },
            ],
            media: [],
          }
          : { albumMedia: [], media: [] },
    });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    const walkCalls = adapter.calls.filter((call) => call.route === "vault_media");
    expect(walkCalls).toHaveLength(2);
    // The same form is what the JOURNAL records, so a replay can tell which
    // request produced which body.
    expect(await requestParams(page.id, "vault_media")).toEqual([
      { albumId: ref(101), mediaType: "", search: "", before: "0", after: "0" },
      { albumId: ref(101), mediaType: "", search: "", before: ref(902), after: "0" },
    ]);
    // THE FORM. `before`/`after` are the LITERAL "0" on the first page and
    // `mediaType`/`search` are present-and-empty — an empty `before=` is a
    // cursor the server does not honour, and it answers with a page that looks
    // exactly like an exhausted album.
    expect(walkCalls[0]?.params).toEqual({
      albumId: ref(101),
      mediaType: "",
      search: "",
      before: "0",
      after: "0",
    });
    // PAGE TWO carries the last albumMedia row's OWN id — not its mediaId,
    // which is a different value and pages nowhere.
    expect(walkCalls[1]?.params.before).toBe(ref(902));

    const state = await cursor(page.id);
    expect(state?.vaultWalk[ref(101)]?.done).toBe(true);
    // The album's `lastItemId` at completion, so the incremental re-walk knows
    // when the head has moved.
    expect(state?.vaultWalk[ref(101)]?.completedAtLastItemRef).toBe(ref(903));

    const coverage = (await coverageRows(page.id))
      .find((row) => row.plane === "catalog_vault_media");
    expect(coverage?.status).toBe("provider_exhausted");
    expect(coverage?.proof).toBe("empty_window");
    expect(coverage?.reason_code).toBe("walk_exhausted");
  });

  it("does not certify a terminal page whose inventory count is short", async () => {
    const page = await seedPage();
    await seedAlbum(page.id, ref(101), 3, ref(903));
    const adapter = adapterStub({ vaultPage: (_params, index) => index === 0 ? {
      albumMedia: [{ id: ref(901), mediaId: ref(601), albumId: ref(101) },
        { id: ref(902), mediaId: ref(602), albumId: ref(101) }], media: [],
    } : { albumMedia: [], media: [] } });
    await drain(page.id, adapter, telemetryStub());
    expect((await coverageRows(page.id)).find(row => row.plane === "catalog_vault_media"))
      .toMatchObject({ status: "partial_provider_surface", reason_code: "walk_inventory_mismatch" });
    expect(await requestParams(page.id, "vault_album_walk_completed")).toEqual([]);
  });

  it("rechecks an unchanged album after seven days", async () => {
    const page = await seedPage(); await seedAlbum(page.id, ref(101), 0, null);
    const adapter = adapterStub(); const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);
    const before = adapter.calls.filter(call => call.route === "vault_media").length;
    await fanslyCatalogChunk(appStub(adapter), input(page.id, telemetry, new SyncChunkBudget(), new Date("2026-08-30T09:00:00Z")));
    // The fixed steps consume a normal chunk first; use the same day to resume.
    await fanslyCatalogChunk(appStub(adapter), input(page.id, telemetry, new SyncChunkBudget(), new Date("2026-08-30T09:00:00Z")));
    expect(adapter.calls.filter(call => call.route === "vault_media").length).toBeGreaterThan(before);
    expect((await cursor(page.id))?.vaultWalk[ref(101)]?.proof?.seenMediaRefs).toEqual([]);
  });

  it("stops the sublane on an empty FIRST page for a non-empty album, with ONE anomaly", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // The platform says 4 760 items; the walk gets nothing. That is a request
    // the server did not honour, NOT an empty vault — and recording it as an
    // empty vault would size WP-F4 against a zero that does not exist.
    await seedAlbum(page.id, ref(101), 4760, ref(903));
    const adapter = adapterStub({ vaultPage: () => ({ albumMedia: [], media: [] }) });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    const walkCalls = adapter.calls.filter((call) => call.route === "vault_media");
    // ONE call, and no loop. WP-F1 spent a whole day's cap re-asking a question
    // it could not answer, across five chunks, and nothing said a word.
    expect(walkCalls).toHaveLength(1);
    const anomalies = telemetry.anomalies
      .filter((entry) => entry.code === "fansly_catalog_vault_empty_first_page");
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.severity).toBe("warn");

    const coverage = (await coverageRows(page.id))
      .find((row) => row.plane === "catalog_vault_media");
    expect(coverage?.status).toBe("partial_provider_surface");
    expect(coverage?.reason_code).toBe("empty_first_page_on_non_empty_album");
    expect(Number(coverage?.expected_count)).toBe(4760);

    // The empty response IS journaled — the evidence outlives the verdict.
    expect((await observations(page.id)).filter((row) => row.kind === "vault_media"))
      .toHaveLength(1);

    // And the sublane stays BLOCKED: a later dispatch does not retry it, so a
    // provider that refuses one album cannot burn the lane's cap on it.
    expect((await cursor(page.id))?.vaultWalkBlockedAlbumRef).toBe(ref(101));
    await drain(page.id, adapter, telemetry);
    expect(adapter.calls.filter((call) => call.route === "vault_media")).toHaveLength(1);
  });

  it("treats an empty first page on an EMPTY album as the honest answer", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // itemCount 0: the platform itself says the album holds nothing, so the
    // empty page is exhaustion and not a refusal.
    await seedAlbum(page.id, ref(106), 0, null);
    const adapter = adapterStub({ vaultPage: () => ({ albumMedia: [], media: [] }) });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    expect(telemetry.anomalies).toHaveLength(0);
    const coverage = (await coverageRows(page.id))
      .find((row) => row.plane === "catalog_vault_media");
    expect(coverage?.status).toBe("provider_exhausted");
    expect(coverage?.reason_code).toBe("album_empty");
    expect((await cursor(page.id))?.vaultWalkBlockedAlbumRef).toBeNull();
  });

  it("stops a walk whose cursor does not advance, rather than looping", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedAlbum(page.id, ref(101), 100, ref(903));
    // A provider that keeps serving the same last row: the cursor never moves.
    const adapter = adapterStub({
      vaultPage: () => ({
        albumMedia: [{ id: ref(901), mediaId: ref(601), albumId: ref(101) }],
        media: [],
      }),
    });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    const anomalies = telemetry.anomalies
      .filter((entry) => entry.code === "fansly_catalog_vault_cursor_repeat");
    expect(anomalies).toHaveLength(1);
    // Two calls: the first advances the cursor to ref(901), the second asks for
    // the same page, and the guard stops it BEFORE a third.
    expect(adapter.calls.filter((call) => call.route === "vault_media")).toHaveLength(2);
    const coverage = (await coverageRows(page.id))
      .find((row) => row.plane === "catalog_vault_media");
    expect(coverage?.reason_code).toBe("repeat_request");
  });

  it("re-walks an album's head when lastItemId moves, and not before", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedAlbum(page.id, ref(101), 1, ref(903));
    const adapter = adapterStub({
      vaultPage: (params) =>
        params.before === "0"
          ? { albumMedia: [{ id: ref(901), mediaId: ref(601), albumId: ref(101) }], media: [] }
          : { albumMedia: [], media: [] },
    });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);
    const afterFirst = adapter.calls.filter((call) => call.route === "vault_media").length;

    // A NEW day with the album unchanged: the walk is done and stays done.
    await fanslyCatalogChunk(
      appStub(adapter),
      input(page.id, telemetry, new SyncChunkBudget(), new Date("2026-08-23T09:00:00.000Z")),
    );
    expect(adapter.calls.filter((call) => call.route === "vault_media")).toHaveLength(afterFirst);

    // The platform's lastItemId moves ⇒ the album's head holds rows this walk
    // has never seen, so it re-opens from the head.
    await testDb!.pool.query(
      `update creator_vault_albums set last_item_ref = $1 where page_id = $2 and album_ref = $3`,
      [ref(904), page.id, ref(101)],
    );
    await fanslyCatalogChunk(
      appStub(adapter),
      input(page.id, telemetry, new SyncChunkBudget(), new Date("2026-08-24T09:00:00.000Z")),
    );
    expect(adapter.calls.filter((call) => call.route === "vault_media").length)
      .toBeGreaterThan(afterFirst);
  });

  it("defers at the 60-attempt cap, in ATTEMPTS, and journals what it already fetched", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedAlbum(page.id, ref(101), 1000, ref(903));
    // Each logical call costs THREE attempts — the unit the cap is enforced in,
    // because a cap counted in logical calls would let a retry storm multiply
    // real egress.
    const adapter = adapterStub({
      attemptsPerCall: 3,
      vaultPage: (_params, index) => ({
        albumMedia: [{ id: ref(900 + index), mediaId: ref(600 + index), albumId: ref(101) }],
        media: [],
      }),
    });
    const telemetry = telemetryStub();

    let result: Awaited<ReturnType<typeof fanslyCatalogChunk>> | null = null;
    for (let chunk = 0; chunk < 20; chunk += 1) {
      result = await fanslyCatalogChunk(
        appStub(adapter, { fanslyCatalogDailyCallBudget: 12 }),
        input(page.id, telemetry, new SyncChunkBudget()),
      );
      if (result.stats?.deferred === "daily_call_budget") {
        break;
      }
    }
    expect(result?.stats?.deferred).toBe("daily_call_budget");
    expect(result?.satisfied).toBe(false);
    // Deferred, not dropped: the continuation is the next UTC day.
    expect((result?.continuationRetryAt as Date).toISOString())
      .toBe("2026-08-23T00:05:00.000Z");

    const state = await cursor(page.id);
    expect(state?.callsToday).toBeGreaterThanOrEqual(12);
    // 12 attempts at 3 per call = 4 calls, all journaled. The cap crosses AFTER
    // the response is safe, never before.
    expect(await observations(page.id)).toHaveLength(4);
    // The walk's cursor survived the deferral, so tomorrow resumes at the page
    // it stopped on rather than re-crawling the album.
    expect(state?.vaultWalk[ref(101)]?.beforeRef).not.toBe("0");
  });

  it("reports M, the membership union and Σ item_count in the progress block", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // Two albums whose item counts SUM to 300 — and the system album is a view
    // over the same media, which is exactly why Σ is not M.
    await seedAlbum(page.id, ref(101), 100, null);
    await seedAlbum(page.id, ref(103), 200, null);
    await testDb!.pool.query(
      `update creator_vault_albums set item_count = 200, album_type = 38000
        where page_id = $1 and album_ref = $2`,
      [page.id, ref(103)],
    );
    const adapter = adapterStub({
      vaultPage: (params) =>
        params.before === "0"
          ? {
            albumMedia: [{
              id: ref(901),
              mediaId: ref(601),
              albumId: String(params.albumId),
            }],
            media: [],
          }
          : { albumMedia: [], media: [] },
    });
    const telemetry = telemetryStub();
    const result = await drain(page.id, adapter, telemetry);

    const stats = result?.stats as Record<string, unknown>;
    // M — the named output (A16 item 1). Zero here because the CAPTURE lane
    // only journals: `creator_media` fills when the canonicalizer and the media
    // plane run, and a zero that is TRUE is exactly what the empty-first-page
    // guard exists to keep distinguishable from a zero that is a refusal.
    expect(stats.uniqueMediaCount).toBe(0);
    expect(stats.vaultMemberUniqueCount).toBe(0);
    // Σ item_count, reported SEPARATELY and labelled non-unique everywhere.
    expect(stats.albumMembershipSum).toBe(300);
    expect(stats.vaultWalkStatus).toBe("exhausted");
    expect(stats.dailyCap).toBe(60);
  });

  it("hydrates optional offer ids when membership actually names them", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedAlbum(page.id, ref(101), 0, null);
    await testDb!.pool.query(
      `insert into creator_vault_album_members (
         page_id, platform, album_ref, media_offer_ref, media_ref, bundle_ref, vault_kind,
         first_observed_at, last_observed_at, content_hash, source_event_id,
         source_observation_id, source_account_seq
       ) values
         ($1, 'fansly', $2, $3, $6, $5, 'creator', now(), now(), repeat('a', 64), 1, 1, 1),
         ($1, 'fansly', $2, $4, $7, null, 'creator', now(), now(), repeat('b', 64), 1, 1, 1)`,
      [page.id, ref(101), ref(601), ref(602), ref(651), ref(611), ref(612)],
    );
    const adapter = adapterStub();
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    const batch = adapter.calls.find((call) => call.route === "account_media_batch");
    // 100 ids a call — the app's own batch size, read out of its bundle.
    expect(batch?.params.ids).toBe(`${ref(601)},${ref(602)}`);
    const bundleBatch = adapter.calls.find((call) => call.route === "account_media_bundle_batch");
    expect(bundleBatch?.params.ids).toBe(ref(651));

    const kinds = (await observations(page.id)).map((row) => row.kind);
    expect(kinds).toContain("account_media_batch");
    expect(kinds).toContain("account_media_bundle_batch");
  });

  it("re-raises 401/403 untouched — a dead session is the executor's problem", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const adapter = adapterStub({
      fail: (route) =>
        route === "subscription_tiers"
          ? new FanslyApiError("forbidden", 403, undefined, undefined)
          : null,
    });
    const telemetry = telemetryStub();

    await expect(
      fanslyCatalogChunk(appStub(adapter), input(page.id, telemetry)),
    ).rejects.toMatchObject({ status: 403 });

    // The two steps BEFORE it are journaled — capture-first survives the throw.
    expect((await observations(page.id)).map((row) => row.kind))
      .toEqual(["vault_albums", "uservault_albums"]);
  });
});

describe("WP-F3 catalog lane helpers", () => {
  it("reads albumMedia rows and nothing from the raw media sidecar", () => {
    expect(vaultMediaRows({ albumMedia: [{ id: "a" }], media: [{ id: "b" }] }))
      .toEqual([{ id: "a" }]);
    expect(vaultMediaRows({ media: [{ id: "b" }] })).toEqual([]);
    expect(vaultMediaRows(null)).toEqual([]);
  });

  it("takes the next cursor from the LAST row's own id", () => {
    expect(nextVaultCursor([{ id: "1", mediaId: "x" }, { id: "2", mediaId: "y" }]))
      .toBe("2");
    // A page of rows with no usable id cannot advance the walk, and saying so
    // is better than pretending it did.
    expect(nextVaultCursor([{ mediaId: "x" }])).toBeNull();
    expect(nextVaultCursor([])).toBeNull();
  });

  it("jitters the continuation so a deep walk cannot run contiguously", () => {
    const base = new Date("2026-08-22T09:00:00.000Z");
    // Burst SHAPE, not daily volume, is the real ban-risk surface.
    expect(walkContinuationAt(base, 20_000, () => 0).getTime() - base.getTime()).toBe(14_000);
    expect(walkContinuationAt(base, 20_000, () => 1).getTime() - base.getTime()).toBe(26_000);
    expect(walkContinuationAt(base, 20_000, () => 0.5).getTime() - base.getTime()).toBe(20_000);
  });
});
