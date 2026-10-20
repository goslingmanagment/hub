import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyOfapiCollectionPolicy,
  createModel,
  createOnlyFansPage,
  insertOfapiWebhookEvent,
  setPageOfapiAccountId,
  upsertOfapiMediaLocators,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount, type HumanAuthPrincipal } from "../apps/runtime/src/services/auth.ts";
import { ofapiCollectionPolicyHooks } from "../apps/runtime/src/services/ofapi-collection-policy.ts";
import { createOfapiCreditSpendSink } from "../apps/runtime/src/services/ofapi-credits.ts";
import { processOfapiWebhookEvent } from "../apps/runtime/src/services/ofapi-events.ts";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import {
  configureOfapiMediaCdnHeadForTests,
  configureOfapiMediaTransportForTests,
  reportOfapiMediaFetches,
  resolveOfapiMedia,
  type OfapiMediaResolveRequest,
} from "../apps/runtime/src/services/ofapi-media-resolve.ts";
import { configureReadGatewayCaptureForTests } from "../apps/runtime/src/services/ofapi-read-gateway-capture.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import {
  expiresSignedUrl,
  lockedMedia,
  MEDIA_ACCOUNT,
  MEDIA_FAN_ID,
  photoMedia,
  policySignedUrl,
  syntheticChatMediaPage,
  syntheticMessagesReceived,
  videoMedia,
} from "./helpers/ofapi-media-fixtures.ts";
import { listenOnLoopback } from "./helpers/network.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Desktop media images: the resolve decision table, the agency budget, the
// category ceiling, the ledger link, report idempotency and locator capture on
// both gateway paths. OFAPI is a local scripted server; the dl.fansapi.com HEAD
// is a test double. No real signed URL, id or content appears here.

interface UpstreamRequest { method: string; url: string; authorization: string | undefined }
type MediaBehaviour = (method: string, cdnPath: string) => { status: number; location?: string; headers?: Record<string, string> };

const DL_LOCATION = (tag: string) => `https://dl.fansapi.com/d/synthetic-${tag}/300x300_${tag}.jpg`;
const CDN_LOCATION = (tag: string, method: string) => `https://cdn.fansapi.com/of/cdn2/files/a/aa/${tag}/300x300_${tag}.jpg`
  + `?X-Amz-Date=${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}&X-Amz-Expires=3600&X-Amz-Signature=synthetic-${method.toLowerCase()}`;

let testDb: StartedTestDatabase | null = null;
let upstream: HttpServer | null = null;
let upstreamBaseUrl: string | null = null;
const upstreamRequests: UpstreamRequest[] = [];
let mediaBehaviour: MediaBehaviour = () => ({ status: 500 });
let onMediaRequest: ((method: string) => void) | null = null;
let readBody: unknown = null;
let cdnHeads: string[] = [];
let cdnLength: number | null = 21_821;

let app: AppContext;
let principal: HumanAuthPrincipal;
let pageId = 0;
let chatterUserId = 0;
let chatterKey = "";

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  upstream = createServer((request, response) => {
    const url = request.url ?? "";
    upstreamRequests.push({ method: request.method ?? "", url, authorization: request.headers.authorization });
    const marker = "/media/download/";
    const index = url.indexOf(marker);
    if (index >= 0) {
      onMediaRequest?.(request.method ?? "");
      const behaviour = mediaBehaviour(request.method ?? "", url.slice(index + marker.length));
      response.writeHead(behaviour.status, {
        ...(behaviour.location ? { location: behaviour.location } : {}),
        ...behaviour.headers,
      });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(readBody));
  });
  const address = await listenOnLoopback(upstream, "OFAPI media resolve tests");
  if (address) upstreamBaseUrl = `http://${address.host}:${address.port}`;
}, 120_000);

afterAll(async () => {
  configureOfapiMediaCdnHeadForTests(null);
  upstream?.close();
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb || !upstreamBaseUrl) {
    context.skip();
    return;
  }
  // Physical: a case asserts which index the update plan uses.
  await resetIntegrationDatabase(testDb.pool, { physical: true });
  upstreamRequests.length = 0;
  cdnHeads = [];
  cdnLength = 21_821;
  readBody = null;
  mediaBehaviour = () => ({ status: 500 });
  onMediaRequest = null;
  configureOfapiMediaTransportForTests({ spacingMs: 0 });
  configureReadGatewayCaptureForTests();
  configureOfapiMediaCdnHeadForTests(async (url) => {
    cdnHeads.push(url.toString());
    return { status: 200, contentLength: cdnLength };
  });

  app = createTestAppContext(testDb, {
    ofapiCreditLedgerEnabled: true,
    ofapiDesktopReadGatewayEnabled: true,
  });
  const model = await createModel(app.db, { slug: "media", name: "Media" });
  const page = await createOnlyFansPage(app.db, { modelId: model!.id, label: "media-of" });
  pageId = page!.id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: MEDIA_ACCOUNT });
  const chatter = await createUserAccount(app, { username: "media-chatter", role: "chatter" }, { source: "cli" });
  chatterUserId = chatter.id;
  chatterKey = (await issueChatterDeviceToken(app, { username: "media-chatter", pageLabel: "media-of" }, { source: "cli" })).key;
  principal = {
    authMethod: "device_token",
    user: { id: chatterUserId, username: "media-chatter", role: "chatter" } as HumanAuthPrincipal["user"],
    assignedPageIds: [pageId],
  };
  app.ofapi = createOfapiClient({
    baseUrl: upstreamBaseUrl!,
    apiKey: "core-vendor-key",
    restDelayMs: 0,
    onCreditSpend: createOfapiCreditSpendSink(app),
    ...ofapiCollectionPolicyHooks(app.db),
  });
});

afterEach(() => {
  vi.useRealTimers();
  configureOfapiMediaCdnHeadForTests(null);
  configureOfapiMediaTransportForTests(null);
});

function request(mediaId: string, overrides: Partial<OfapiMediaResolveRequest> = {}): OfapiMediaResolveRequest {
  return {
    requestId: randomUUID(), accountId: MEDIA_ACCOUNT, mediaId, variant: "thumb",
    surface: "gallery", trigger: "auto", ...overrides,
  };
}

async function enableMediaPolicy(dailyCreditLimit = 300) {
  const state = await testDb!.pool.query<{ revision: number }>("select revision from ofapi_collection_state where id = 1");
  await applyOfapiCollectionPolicy(app.db, {
    expectedRevision: Number(state.rows[0]!.revision),
    changes: [{ pageId, category: "media_previews", mode: "on_demand", intervalMinutes: 1440, dailyCreditLimit, maxCallsPerRun: 10, includeDetails: false }],
  }, chatterUserId);
}

/** Gateway-shaped locators: custom policy bound to the proxy address. */
async function seedGatewayLocators(ids: number[], expiresAt = new Date(Date.now() + 6 * 3_600_000)) {
  const { ofapiMediaLocatorsFromGatewayBody } = await import("../apps/runtime/src/services/ofapi-media-locators.ts");
  await upsertOfapiMediaLocators(app.db, ofapiMediaLocatorsFromGatewayBody({
    operation: "ofapi_gateway_chat_media", ofapiAccountId: MEDIA_ACCOUNT, pageId,
    pathname: `/${MEDIA_ACCOUNT}/chats/${MEDIA_FAN_ID}/media`,
    body: syntheticChatMediaPage(ids.map((id) => photoMedia(id, policySignedUrl, expiresAt))),
    observedAt: new Date(),
  }));
}

async function setBudgetUsed(credits: number) {
  await testDb!.pool.query(
    `insert into ofapi_media_daily_budget (day, credits_used) values ((now() at time zone 'utc')::date, $1)
     on conflict (day) do update set credits_used = excluded.credits_used`, [credits]);
}

async function budgetUsed() {
  const result = await testDb!.pool.query<{ credits_used: number }>(
    "select credits_used from ofapi_media_daily_budget where day = (now() at time zone 'utc')::date");
  return Number(result.rows[0]?.credits_used ?? 0);
}

const paidEverywhere: MediaBehaviour = (method, cdnPath) =>
  ({ status: 302, location: DL_LOCATION(`${method.toLowerCase()}-${cdnPath.slice(-12, -4).replace(/\W/g, "")}`) });

describe("media resolve decision table", () => {
  it("serves a webhook's free Expires URL without any OFAPI call, even with the category off", async () => {
    const envelope = syntheticMessagesReceived({
      media: [photoMedia(3000001, expiresSignedUrl, new Date(Date.now() + 23 * 3_600_000)), lockedMedia(3000003),
        videoMedia(3000002, expiresSignedUrl, new Date(Date.now() + 23 * 3_600_000))],
    });
    const created = await insertOfapiWebhookEvent(app.db, {
      idempotencyKey: `evt_${"a".repeat(40)}`, eventType: "messages.received", ofapiAccountId: MEDIA_ACCOUNT,
      payload: envelope as unknown as Record<string, unknown>,
    });
    await processOfapiWebhookEvent(app, created!.id);

    const thumb = await resolveOfapiMedia(app, principal, request("3000001", { surface: "thread" }));
    expect(thumb).toMatchObject({ outcome: "free_url", credits: 0, overCap: false, mediaType: "photo", replayed: false });
    expect(thumb.url).toContain("cdn2.onlyfans.com/files/a/aa/syn3000001/300x300_syn3000001.jpg");
    const full = await resolveOfapiMedia(app, principal, request("3000001", { variant: "full", surface: "lightbox", trigger: "click" }));
    expect(full.outcome).toBe("free_url");
    expect(full.url).toContain("960x1280_syn3000001.jpg");
    // The full file is click-only, server-side: even a free URL is not handed to an automatic request.
    await expect(resolveOfapiMedia(app, principal, request("3000001", { variant: "full", surface: "lightbox" })))
      .resolves.toMatchObject({ outcome: "cap_blocked", reason: "click_only", url: null, credits: 0, retryAt: null });
    expect(upstreamRequests).toHaveLength(0);

    await expect(resolveOfapiMedia(app, principal, request("3000003"))).resolves.toMatchObject({ outcome: "refused", reason: "locked", url: null });
    await expect(resolveOfapiMedia(app, principal, request("3000002", { variant: "full", trigger: "click" })))
      .resolves.toMatchObject({ outcome: "refused", reason: "variant_not_allowed" });

    const log = await testDb!.pool.query<{ outcome: string; surface: string; credits_estimated: number; certainty: string }>(
      "select outcome, surface, credits_estimated, certainty from ofapi_media_fetch_log order by id");
    expect(log.rows.map((row) => row.outcome)).toEqual(["free_url", "free_url", "cap_blocked", "refused", "refused"]);
    // No URL, signature or path ever lands in the decision log.
    const logText = (await testDb!.pool.query<{ row: string }>("select to_jsonb(l)::text as row from ofapi_media_fetch_log l"))
      .rows.map((row) => row.row).join("\n");
    expect(logText).not.toContain("onlyfans.com");
    expect(logText).not.toContain("Signature");
  });

  it("refuses OFAPI-backed files while media_previews is off, without contacting OFAPI", async () => {
    await seedGatewayLocators([3000010]);
    const result = await resolveOfapiMedia(app, principal, request("3000010"));
    expect(result).toMatchObject({ outcome: "refused", reason: "collection_off", url: null, credits: 0 });
    expect(upstreamRequests).toHaveLength(0);
  });

  it("hands out OFAPI's cache for free: HEAD then GET, both manual, Authorization only to OFAPI", async () => {
    await enableMediaPolicy();
    await seedGatewayLocators([3000011]);
    mediaBehaviour = (method) => ({ status: 302, location: CDN_LOCATION("syn3000011", method) });
    const result = await resolveOfapiMedia(app, principal, request("3000011"));
    expect(result).toMatchObject({ outcome: "ofapi_cache", credits: 0, overCap: false });
    expect(result.url).toContain("https://cdn.fansapi.com/");
    expect(result.url).toContain("synthetic-get");
    expect(upstreamRequests.map((entry) => entry.method)).toEqual(["HEAD", "GET"]);
    for (const entry of upstreamRequests) {
      expect(entry.authorization).toBe("Bearer core-vendor-key");
      // The CDN URL is passed verbatim, its own query included.
      expect(entry.url).toMatch(new RegExp(`^/${MEDIA_ACCOUNT}/media/download/https://cdn2\\.onlyfans\\.com/files/.+\\?Tag=2&u=9000001&Policy=`));
    }
    expect(cdnHeads).toHaveLength(0);
    expect(await budgetUsed()).toBe(0);
    const ledger = await testDb!.pool.query("select 1 from ofapi_credit_ledger where operation like 'ofapi_media_%'");
    expect(ledger.rows).toHaveLength(0);
    // AI media describer (0216): the free hand-out is kept as a locator the
    // describer can reuse without ever calling OFAPI itself.
    const persisted = await testDb!.pool.query(
      "select source, sig_kind, variant from ofapi_media_locators where media_id = '3000011' and source = 'resolve'",
    );
    expect(persisted.rows).toEqual([{ source: "resolve", sig_kind: "fansapi", variant: "thumb" }]);
  });

  it("prices a dl.fansapi.com hand-out by Content-Length, charges the budget and links the ledger row", async () => {
    await enableMediaPolicy();
    await seedGatewayLocators([3000012]);
    mediaBehaviour = paidEverywhere;
    const result = await resolveOfapiMedia(app, principal, request("3000012"));
    expect(result).toMatchObject({ outcome: "paid", credits: 1, overCap: false, contentLength: 21_821, maxBytes: 21_821 });
    expect(result.url).toContain("https://dl.fansapi.com/d/synthetic-get");
    // HEAD to classify, HEAD on the dl Location for the size, GET for a fresh token.
    expect(upstreamRequests.map((entry) => entry.method)).toEqual(["HEAD", "GET"]);
    expect(cdnHeads).toEqual([expect.stringContaining("https://dl.fansapi.com/d/synthetic-head")]);
    expect(await budgetUsed()).toBe(1);

    const rows = await testDb!.pool.query<{ ledger_entry_id: string; certainty: string; credits_estimated: number; content_length: string }>(
      "select ledger_entry_id::text, certainty, credits_estimated, content_length::text from ofapi_media_fetch_log where resolve_id = $1", [result.resolveId]);
    expect(rows.rows[0]).toMatchObject({ certainty: "estimated", credits_estimated: 1, content_length: "21821" });
    const ledger = await testDb!.pool.query<{ id: string; operation: string; credits: number; estimated: boolean; actor_user_id: string; page_id: string }>(
      "select id::text, operation, credits, estimated, actor_user_id::text, page_id::text from ofapi_credit_ledger where operation = 'ofapi_media_download'");
    expect(ledger.rows).toEqual([{ id: rows.rows[0]!.ledger_entry_id, operation: "ofapi_media_download", credits: 1, estimated: true,
      actor_user_id: String(chatterUserId), page_id: String(pageId) }]);
  });

  it("admits exactly one of two concurrent automatic downloads at 99 of 100", async () => {
    await enableMediaPolicy();
    await seedGatewayLocators([3000013, 3000014]);
    mediaBehaviour = paidEverywhere;
    await setBudgetUsed(99);
    const results = await Promise.all([
      resolveOfapiMedia(app, principal, request("3000013")),
      resolveOfapiMedia(app, principal, request("3000014")),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["cap_blocked", "paid"]);
    const blocked = results.find((result) => result.outcome === "cap_blocked")!;
    expect(blocked).toMatchObject({ reason: "daily_cap", url: null, credits: 0 });
    expect(blocked.retryAt).toMatch(/T00:00:00\.000Z$/);
    expect(await budgetUsed()).toBe(100);
  });

  it("lets an explicit click through over the cap and flags it over_cap", async () => {
    await enableMediaPolicy();
    await seedGatewayLocators([3000015]);
    mediaBehaviour = paidEverywhere;
    await setBudgetUsed(100);
    const auto = await resolveOfapiMedia(app, principal, request("3000015"));
    expect(auto).toMatchObject({ outcome: "cap_blocked", reason: "daily_cap" });
    const click = await resolveOfapiMedia(app, principal, request("3000015", { trigger: "click", surface: "lightbox" }));
    expect(click).toMatchObject({ outcome: "paid", credits: 1, overCap: true });
    expect(await budgetUsed()).toBe(101);
    const log = await testDb!.pool.query<{ over_cap: boolean; trigger: string }>(
      "select over_cap, trigger from ofapi_media_fetch_log where resolve_id = $1", [click.resolveId]);
    expect(log.rows[0]).toEqual({ over_cap: true, trigger: "click" });
  });

  it("never pays automatically for an unknown size; a click reserves the guard's price and settles on its report", async () => {
    await enableMediaPolicy();
    await seedGatewayLocators([3000016]);
    mediaBehaviour = paidEverywhere;
    cdnLength = null;
    const auto = await resolveOfapiMedia(app, principal, request("3000016"));
    expect(auto).toMatchObject({ outcome: "cap_blocked", reason: "size_unknown", credits: 0 });
    expect(upstreamRequests.map((entry) => entry.method)).toEqual(["HEAD"]);
    const click = await resolveOfapiMedia(app, principal, request("3000016", { trigger: "click" }));
    // Never under-counted: the budget, the category and the ledger hold what the 5 MB guard can cost.
    expect(click).toMatchObject({ outcome: "paid", credits: 15, contentLength: null, maxBytes: 5_000_000 });
    expect(await budgetUsed()).toBe(15);
    const reserved = await testDb!.pool.query<{ reserved: number; actual: number | null; state: string }>(
      `select reserved_credits::int as reserved, actual_credits::int as actual, state from ofapi_collection_requests
       where operation = 'ofapi_media_download'`);
    expect(reserved.rows).toEqual([{ reserved: 15, actual: 15, state: "captured" }]);

    // 1.2 MB arrived: settled to ceil(3.6) = 4 credits everywhere, once.
    const report = { resolveId: click.resolveId, result: "ok" as const, bytesReceived: 1_200_000, httpStatus: 200 };
    expect(await reportOfapiMediaFetches(app, principal, [report])).toEqual({ accepted: 1, duplicate: 0, unknown: 0, rejected: 0 });
    expect(await reportOfapiMediaFetches(app, principal, [report])).toEqual({ accepted: 0, duplicate: 1, unknown: 0, rejected: 0 });
    expect(await budgetUsed()).toBe(4);
    const settled = await testDb!.pool.query<{ reserved: number; actual: number }>(
      `select reserved_credits::int as reserved, actual_credits::int as actual from ofapi_collection_requests
       where operation = 'ofapi_media_download'`);
    expect(settled.rows).toEqual([{ reserved: 4, actual: 4 }]);
    const log = await testDb!.pool.query<{ credits_estimated: number; certainty: string }>(
      "select credits_estimated, certainty from ofapi_media_fetch_log where resolve_id = $1", [click.resolveId]);
    expect(log.rows[0]).toEqual({ credits_estimated: 4, certainty: "confirmed" });
    // The ledger keeps its convention: the estimated rest row stays, a signed adjustment carries the difference.
    const ledger = await testDb!.pool.query<{ source: string; credits: number; estimated: boolean; request_id: string; details: Record<string, unknown> }>(
      `select source, credits, estimated, request_id, details from ofapi_credit_ledger
       where operation = 'ofapi_media_download' order by id`);
    expect(ledger.rows.map(({ source, credits, estimated }) => ({ source, credits, estimated }))).toEqual([
      { source: "rest", credits: 15, estimated: true },
      { source: "adjustment", credits: -11, estimated: true },
    ]);
    expect(ledger.rows[0]!.details).toMatchObject({ sizeUnknown: true, guardBytes: 5_000_000 });
    expect(ledger.rows[1]!.details).toMatchObject({ certainty: "client_report", reservedCredits: 15, settledCredits: 4, bytesReceived: 1_200_000 });
    const days = await testDb!.pool.query<{ same: boolean }>(
      "select count(distinct occurred_at) = 1 as same from ofapi_credit_ledger where operation = 'ofapi_media_download'");
    expect(days.rows[0]?.same).toBe(true);
  });

  it("does not let the free HEAD probe consume the page ceiling; the paid GET does", async () => {
    await enableMediaPolicy(1);
    await seedGatewayLocators([3000017, 3000018]);
    mediaBehaviour = paidEverywhere;
    const first = await resolveOfapiMedia(app, principal, request("3000017"));
    expect(first).toMatchObject({ outcome: "paid", credits: 1 });
    const second = await resolveOfapiMedia(app, principal, request("3000018"));
    // The free probe still passed at the full ceiling; the download was refused before the CDN hop.
    expect(second).toMatchObject({ outcome: "refused", reason: "daily_limit", credits: 0 });
    expect(cdnHeads).toHaveLength(1);
    const reservations = await testDb!.pool.query<{ operation: string; reserved: number }>(
      `select operation, reserved_credits::int as reserved from ofapi_collection_requests
       where category = 'media_previews' order by created_at, operation`);
    expect(reservations.rows.filter((row) => row.operation === "ofapi_media_probe").map((row) => row.reserved)).toEqual([0, 0]);
    expect(reservations.rows.filter((row) => row.operation === "ofapi_media_download").map((row) => row.reserved)).toEqual([1]);
    // The refused download handed nothing out: its budget admission was returned.
    expect(await budgetUsed()).toBe(1);
  });

  it("returns the recorded answer for a repeated requestId without a second charge", async () => {
    await enableMediaPolicy();
    await seedGatewayLocators([3000019]);
    mediaBehaviour = paidEverywhere;
    const input = request("3000019");
    const first = await resolveOfapiMedia(app, principal, input);
    const calls = upstreamRequests.length;
    const again = await resolveOfapiMedia(app, principal, input);
    expect(again).toMatchObject({ resolveId: first.resolveId, outcome: "paid", credits: 1, url: first.url, replayed: true });
    expect(upstreamRequests).toHaveLength(calls);
    expect(await budgetUsed()).toBe(1);
    const ledger = await testDb!.pool.query("select 1 from ofapi_credit_ledger where operation = 'ofapi_media_download'");
    expect(ledger.rows).toHaveLength(1);
  });

  it("holds a paid file in single flight until its report", async () => {
    await enableMediaPolicy();
    await seedGatewayLocators([3000020]);
    mediaBehaviour = paidEverywhere;
    const first = await resolveOfapiMedia(app, principal, request("3000020"));
    expect(first.outcome).toBe("paid");
    const second = await resolveOfapiMedia(app, principal, request("3000020"));
    expect(second).toMatchObject({ outcome: "pending", reason: "in_flight", url: null });
    expect(second.retryAfterMs).toBeGreaterThanOrEqual(1_000);
    expect(second.retryAfterMs).toBeLessThanOrEqual(120_000);

    await reportOfapiMediaFetches(app, principal, [{ resolveId: first.resolveId, result: "ok", bytesReceived: 21_821, httpStatus: 200 }]);
    mediaBehaviour = (method) => ({ status: 302, location: CDN_LOCATION("syn3000020", method) });
    await expect(resolveOfapiMedia(app, principal, request("3000020"))).resolves.toMatchObject({ outcome: "ofapi_cache", credits: 0 });
  });

  it("applies reports once per resolveId and never zeroes an unconfirmed paid charge", async () => {
    await enableMediaPolicy();
    await seedGatewayLocators([3000021, 3000022]);
    mediaBehaviour = paidEverywhere;
    const ok = await resolveOfapiMedia(app, principal, request("3000021"));
    const failed = await resolveOfapiMedia(app, principal, request("3000022"));
    const reports = [
      { resolveId: ok.resolveId, result: "ok" as const, bytesReceived: 21_821, httpStatus: 200 },
      { resolveId: failed.resolveId, result: "timeout" as const, bytesReceived: 4_096, httpStatus: null },
    ];
    expect(await reportOfapiMediaFetches(app, principal, reports)).toEqual({ accepted: 2, duplicate: 0, unknown: 0, rejected: 0 });
    expect(await reportOfapiMediaFetches(app, principal, reports)).toEqual({ accepted: 0, duplicate: 2, unknown: 0, rejected: 0 });
    expect(await reportOfapiMediaFetches(app, principal, [{ resolveId: randomUUID(), result: "ok", bytesReceived: 1, httpStatus: 200 }]))
      .toEqual({ accepted: 0, duplicate: 0, unknown: 1, rejected: 0 });
    const rows = await testDb!.pool.query<{ resolve_id: string; certainty: string; client_result: string; credits_estimated: number }>(
      "select resolve_id::text, certainty, client_result, credits_estimated from ofapi_media_fetch_log order by id");
    expect(rows.rows).toEqual([
      { resolve_id: ok.resolveId, certainty: "confirmed", client_result: "ok", credits_estimated: 1 },
      { resolve_id: failed.resolveId, certainty: "unknown", client_result: "timeout", credits_estimated: 1 },
    ]);
  });

  it("refuses a hand-out when OFAPI redirects to an unexpected host, and returns the admission", async () => {
    await enableMediaPolicy();
    await seedGatewayLocators([3000023]);
    mediaBehaviour = (method) => method === "HEAD"
      ? { status: 302, location: DL_LOCATION("head") }
      : { status: 302, location: "https://evil.example.com/x.jpg" };
    const result = await resolveOfapiMedia(app, principal, request("3000023"));
    expect(result).toMatchObject({ outcome: "error", reason: "unexpected_redirect", url: null, credits: 0 });
    expect(await budgetUsed()).toBe(0);
    const ledger = await testDb!.pool.query("select 1 from ofapi_credit_ledger where operation = 'ofapi_media_download'");
    expect(ledger.rows).toHaveLength(0);
  });

  it("refuses an account that is not granted to the chatter", async () => {
    await expect(resolveOfapiMedia(app, { ...principal, assignedPageIds: [] }, request("3000001"))).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("media locators from the read gateway and the journal", () => {
  it("serves the resolve and reports routes to a chatter device token only", async () => {
    await seedGatewayLocators([3000034]);
    const server = await buildApiServer(app);
    try {
      const resolved = await server.inject({
        method: "POST", url: "/api/v1/ofapi/media/resolve",
        headers: { authorization: `Bearer ${chatterKey}` },
        payload: request("3000034"),
      });
      expect(resolved.statusCode, resolved.body).toBe(200);
      expect(resolved.json()).toMatchObject({ outcome: "refused", reason: "collection_off" });
      const invalid = await server.inject({
        method: "POST", url: "/api/v1/ofapi/media/resolve",
        headers: { authorization: `Bearer ${chatterKey}` },
        payload: { ...request("3000034"), url: "https://cdn2.onlyfans.com/files/x.jpg" },
      });
      expect(invalid.statusCode).toBe(400);
      const anonymous = await server.inject({ method: "POST", url: "/api/v1/ofapi/media/resolve", payload: request("3000034") });
      expect(anonymous.statusCode).toBe(401);
      const reports = await server.inject({
        method: "POST", url: "/api/v1/ofapi/media/reports",
        headers: { authorization: `Bearer ${chatterKey}` },
        payload: { reports: [{ resolveId: resolved.json().resolveId, result: "failed", bytesReceived: null, httpStatus: null }] },
      });
      expect(reports.statusCode, reports.body).toBe(200);
      expect(reports.json()).toEqual({ accepted: 1, duplicate: 0, unknown: 0, rejected: 0 });
    } finally {
      await server.close();
    }
  });
});

describe("media resolve — review round 1", () => {
  async function receive(envelope: ReturnType<typeof syntheticMessagesReceived>, key: string) {
    const created = await insertOfapiWebhookEvent(app.db, {
      idempotencyKey: `evt_${key.padEnd(40, "0")}`, eventType: "messages.received", ofapiAccountId: MEDIA_ACCOUNT,
      payload: envelope as unknown as Record<string, unknown>,
    });
    await processOfapiWebhookEvent(app, created!.id);
  }

  it("sends nothing to OFAPI for an automatic request once the day's budget is spent", async () => {
    await enableMediaPolicy();
    await seedGatewayLocators([3000060]);
    mediaBehaviour = paidEverywhere;
    await setBudgetUsed(100);
    await expect(resolveOfapiMedia(app, principal, request("3000060"))).resolves.toMatchObject({
      outcome: "cap_blocked", reason: "daily_cap", credits: 0,
    });
    expect(upstreamRequests).toHaveLength(0);
    expect(cdnHeads).toHaveLength(0);
  });

  it("releases the download's category reservation when the paid GET lands on OFAPI's cache", async () => {
    await enableMediaPolicy(1);
    await seedGatewayLocators([3000050, 3000051]);
    mediaBehaviour = (method) => method === "HEAD"
      ? { status: 302, location: DL_LOCATION("head") }
      : { status: 302, location: CDN_LOCATION("syn3000050", method) };
    await expect(resolveOfapiMedia(app, principal, request("3000050"))).resolves.toMatchObject({ outcome: "ofapi_cache", credits: 0 });
    const states = await testDb!.pool.query<{ state: string }>(
      "select state from ofapi_collection_requests where operation = 'ofapi_media_download'");
    expect(states.rows).toEqual([{ state: "released" }]);
    expect(await budgetUsed()).toBe(0);
    // The ceiling of 1 is still free for a real download: no false daily_limit.
    mediaBehaviour = paidEverywhere;
    await expect(resolveOfapiMedia(app, principal, request("3000051"))).resolves.toMatchObject({ outcome: "paid", credits: 1 });
  });

  it("joins a concurrent twin with the same requestId: one decision, one charge", async () => {
    await enableMediaPolicy();
    await seedGatewayLocators([3000070]);
    mediaBehaviour = paidEverywhere;
    const input = request("3000070");
    const [a, b] = await Promise.all([resolveOfapiMedia(app, principal, input), resolveOfapiMedia(app, principal, input)]);
    expect(a.resolveId).toBe(b.resolveId);
    expect(a.url).toBe(b.url);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(upstreamRequests.map((entry) => entry.method)).toEqual(["HEAD", "GET"]);
    expect(await budgetUsed()).toBe(1);
    const ledger = await testDb!.pool.query("select 1 from ofapi_credit_ledger where operation = 'ofapi_media_download'");
    expect(ledger.rows).toHaveLength(1);
  });

  it("refuses a requestId reused for another file", async () => {
    await seedGatewayLocators([3000071, 3000072]);
    const input = request("3000071");
    await resolveOfapiMedia(app, principal, input);
    await expect(resolveOfapiMedia(app, principal, { ...input, mediaId: "3000072" }))
      .rejects.toMatchObject({ statusCode: 409, reason: "request_id_reused" });
    await expect(resolveOfapiMedia(app, principal, { ...input, variant: "full", trigger: "click" }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("erases a fan's locators and links, and only theirs", async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    await receive(syntheticMessagesReceived({ media: [photoMedia(3000100, expiresSignedUrl, expiresAt)] }), "e1");
    const { ofapiMediaLocatorsFromItem } = await import("../apps/runtime/src/services/ofapi-media-locators.ts");
    await upsertOfapiMediaLocators(app.db, ofapiMediaLocatorsFromItem(photoMedia(3000101, expiresSignedUrl, expiresAt), {
      ofapiAccountId: MEDIA_ACCOUNT, pageId, source: "webhook", observedAt: new Date(), chatId: "1000777",
      messageId: "2000777", vaultMedia: false,
    }));
    const owner = await testDb!.pool.query<{ id: string }>(
      "insert into users(username, role) values('media-erasure-owner', 'owner') returning id::text");
    app.config.lakeDir = await mkdtemp(path.join(tmpdir(), "ofapi-media-erasure-"));
    const scope = { scopeType: "fan", platform: "onlyfans", fanRef: String(MEDIA_FAN_ID) } as const;
    const plan = await planErasure(app, scope);
    expect(plan.targets.find((target) => target.target === "ofapi_media_locators")).toMatchObject({ plane: "hot", action: "delete", rows: 3 });
    expect(plan.targets.find((target) => target.target === "ofapi_media_links")).toMatchObject({ plane: "hot", action: "delete", rows: 1 });
    await executeErasure(app, scope, { initiatedBy: Number(owner.rows[0]!.id) });
    const left = await testDb!.pool.query<{ media_id: string }>(
      "select distinct media_id from ofapi_media_locators union select distinct media_id from ofapi_media_links order by 1");
    expect(left.rows).toEqual([{ media_id: "3000101" }]);
  });
});

describe("media resolve — review round 2", () => {
  it("never buys a file larger than the desktop may take", async () => {
    await enableMediaPolicy();
    await seedGatewayLocators([3000203]);
    mediaBehaviour = paidEverywhere;
    cdnLength = 30_000_001;
    await expect(resolveOfapiMedia(app, principal, request("3000203", { trigger: "click" }))).resolves.toMatchObject({
      outcome: "refused", reason: "too_large", url: null, credits: 0,
    });
    expect(upstreamRequests.map((entry) => entry.method)).toEqual(["HEAD"]);
    expect(await budgetUsed()).toBe(0);
  });

  it("releases the category reservation of a failed paid GET, so the next download is not refused", async () => {
    await enableMediaPolicy(1);
    await seedGatewayLocators([3000204, 3000205]);
    mediaBehaviour = (method) => method === "HEAD" ? { status: 302, location: DL_LOCATION("head") } : { status: 500 };
    await expect(resolveOfapiMedia(app, principal, request("3000204"))).resolves.toMatchObject({ outcome: "error", reason: "upstream_error" });
    const states = await testDb!.pool.query<{ state: string }>(
      "select state from ofapi_collection_requests where operation = 'ofapi_media_download'");
    expect(states.rows).toEqual([{ state: "released" }]);
    expect(await budgetUsed()).toBe(0);
    mediaBehaviour = paidEverywhere;
    await expect(resolveOfapiMedia(app, principal, request("3000205"))).resolves.toMatchObject({ outcome: "paid", credits: 1 });
  });

  it("marks a deleted message's link through the message index", async () => {
    const created = await insertOfapiWebhookEvent(app.db, {
      idempotencyKey: `evt_${"r3".padEnd(40, "0")}`, eventType: "messages.received", ofapiAccountId: MEDIA_ACCOUNT,
      payload: syntheticMessagesReceived({ messageId: 2000301, media: [photoMedia(3000206, expiresSignedUrl, new Date(Date.now() + 3_600_000))] }) as unknown as Record<string, unknown>,
    });
    await processOfapiWebhookEvent(app, created!.id);
    const client = await testDb!.pool.connect();
    try {
      await client.query("begin");
      // A tiny table would be scanned anyway: prove the statement CAN use the index.
      await client.query("set local enable_seqscan = off");
      const plan = await client.query(
        `explain update ofapi_media_links set deleted = true, updated_at = now()
         where ofapi_account_id = $1 and message_id = $2 and not deleted`, [MEDIA_ACCOUNT, "2000301"]);
      expect(plan.rows.map((row: Record<string, unknown>) => String(Object.values(row)[0])).join("\n"))
        .toContain("ofapi_media_links_message_idx");
      await client.query("rollback");
    } finally {
      client.release();
    }
  });
});

describe("media locators — recovery and routes", () => {
  it("rate-limits resolve per authenticated device, never before authentication", async () => {
    await seedGatewayLocators([3000120]);
    await createUserAccount(app, { username: "media-chatter-two", role: "chatter" }, { source: "cli" });
    const otherKey = (await issueChatterDeviceToken(app, { username: "media-chatter-two", pageLabel: "media-of" }, { source: "cli" })).key;
    const server = await buildApiServer(app);
    try {
      const call = (key: string | null) => server.inject({
        method: "POST", url: "/api/v1/ofapi/media/resolve",
        headers: key ? { authorization: `Bearer ${key}` } : {},
        payload: request("3000120"),
      });
      const first = await call(chatterKey);
      const second = await call(chatterKey);
      const other = await call(otherKey);
      const anonymous = await call(null);
      expect([first.statusCode, second.statusCode, other.statusCode], first.body).toEqual([200, 200, 200]);
      expect(first.headers["x-ratelimit-limit"]).toBe("300");
      expect([first.headers["x-ratelimit-remaining"], second.headers["x-ratelimit-remaining"], other.headers["x-ratelimit-remaining"]])
        .toEqual(["299", "298", "299"]);
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.headers["x-ratelimit-remaining"]).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
