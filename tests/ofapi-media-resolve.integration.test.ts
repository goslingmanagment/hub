import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
import { recoverOfapiMediaLocators } from "../apps/runtime/src/services/ofapi-media-locators.ts";
import {
  configureOfapiMediaCdnHeadForTests,
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
  await resetIntegrationDatabase(testDb.pool);
  upstreamRequests.length = 0;
  cdnHeads = [];
  cdnLength = 21_821;
  readBody = null;
  mediaBehaviour = () => ({ status: 500 });
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
  configureOfapiMediaCdnHeadForTests(null);
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
    expect(upstreamRequests).toHaveLength(0);

    await expect(resolveOfapiMedia(app, principal, request("3000003"))).resolves.toMatchObject({ outcome: "refused", reason: "locked", url: null });
    await expect(resolveOfapiMedia(app, principal, request("3000002", { variant: "full", trigger: "click" })))
      .resolves.toMatchObject({ outcome: "refused", reason: "variant_not_allowed" });

    const log = await testDb!.pool.query<{ outcome: string; surface: string; credits_estimated: number; certainty: string }>(
      "select outcome, surface, credits_estimated, certainty from ofapi_media_fetch_log order by id");
    expect(log.rows.map((row) => row.outcome)).toEqual(["free_url", "free_url", "refused", "refused"]);
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

  it("never pays automatically for an unknown size; a click pays with the 5 MB guard", async () => {
    await enableMediaPolicy();
    await seedGatewayLocators([3000016]);
    mediaBehaviour = paidEverywhere;
    cdnLength = null;
    const auto = await resolveOfapiMedia(app, principal, request("3000016"));
    expect(auto).toMatchObject({ outcome: "cap_blocked", reason: "size_unknown", credits: 0 });
    expect(upstreamRequests.map((entry) => entry.method)).toEqual(["HEAD"]);
    const click = await resolveOfapiMedia(app, principal, request("3000016", { trigger: "click" }));
    expect(click).toMatchObject({ outcome: "paid", credits: 1, contentLength: null, maxBytes: 5_000_000 });
  });

  it("does not let the free HEAD probe consume the page ceiling; the paid GET does", async () => {
    await enableMediaPolicy(1);
    await seedGatewayLocators([3000017, 3000018]);
    mediaBehaviour = paidEverywhere;
    const first = await resolveOfapiMedia(app, principal, request("3000017"));
    expect(first).toMatchObject({ outcome: "paid", credits: 1 });
    const second = await resolveOfapiMedia(app, principal, request("3000018"));
    // The probe still passed at the full ceiling; only the download was refused.
    expect(second).toMatchObject({ outcome: "refused", reason: "daily_limit", credits: 0 });
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
    expect(await reportOfapiMediaFetches(app, principal, reports)).toEqual({ accepted: 2, duplicate: 0, unknown: 0 });
    expect(await reportOfapiMediaFetches(app, principal, reports)).toEqual({ accepted: 0, duplicate: 2, unknown: 0 });
    expect(await reportOfapiMediaFetches(app, principal, [{ resolveId: randomUUID(), result: "ok", bytesReceived: 1, httpStatus: 200 }]))
      .toEqual({ accepted: 0, duplicate: 0, unknown: 1 });
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

  it("reports a missing upstream file as unavailable", async () => {
    await enableMediaPolicy();
    await seedGatewayLocators([3000024]);
    mediaBehaviour = () => ({ status: 404 });
    await expect(resolveOfapiMedia(app, principal, request("3000024"))).resolves.toMatchObject({ outcome: "unavailable", reason: "not_found" });
  });

  it("answers source_expired with a re-read hint once every known URL has expired", async () => {
    const envelope = syntheticMessagesReceived({ media: [photoMedia(3000025, expiresSignedUrl, new Date(Date.now() - 60_000))] });
    const created = await insertOfapiWebhookEvent(app.db, {
      idempotencyKey: `evt_${"b".repeat(40)}`, eventType: "messages.received", ofapiAccountId: MEDIA_ACCOUNT,
      payload: envelope as unknown as Record<string, unknown>,
    });
    await processOfapiWebhookEvent(app, created!.id);
    const result = await resolveOfapiMedia(app, principal, request("3000025", { surface: "thread" }));
    expect(result).toMatchObject({
      outcome: "source_expired", reason: "expired", url: null,
      reread: { kind: "message", chatId: String(MEDIA_FAN_ID), messageId: "2000001" },
    });
    const log = await testDb!.pool.query<{ had_free_url_expired: boolean }>("select had_free_url_expired from ofapi_media_fetch_log");
    expect(log.rows[0]?.had_free_url_expired).toBe(true);
    await expect(resolveOfapiMedia(app, principal, request("9999999"))).resolves.toMatchObject({ outcome: "source_expired", reason: "unknown_media" });
  });

  it("stops serving media of a deleted message", async () => {
    const envelope = syntheticMessagesReceived({ media: [photoMedia(3000026, expiresSignedUrl, new Date(Date.now() + 3_600_000))] });
    const received = await insertOfapiWebhookEvent(app.db, {
      idempotencyKey: `evt_${"c".repeat(40)}`, eventType: "messages.received", ofapiAccountId: MEDIA_ACCOUNT,
      payload: envelope as unknown as Record<string, unknown>,
    });
    await processOfapiWebhookEvent(app, received!.id);
    const deleted = await insertOfapiWebhookEvent(app.db, {
      idempotencyKey: `evt_${"d".repeat(40)}`, eventType: "messages.deleted", ofapiAccountId: MEDIA_ACCOUNT,
      payload: { event: "messages.deleted", account_id: MEDIA_ACCOUNT, payload: { id: 2000001 } },
    });
    await processOfapiWebhookEvent(app, deleted!.id);
    await expect(resolveOfapiMedia(app, principal, request("3000026"))).resolves.toMatchObject({ outcome: "refused", reason: "deleted" });
  });

  it("refuses an account that is not granted to the chatter", async () => {
    await expect(resolveOfapiMedia(app, { ...principal, assignedPageIds: [] }, request("3000001"))).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("media locators from the read gateway and the journal", () => {
  async function injectGallery(serverApp: Awaited<ReturnType<typeof buildApiServer>>) {
    return serverApp.inject({
      method: "GET",
      url: `/api/v1/ofapi/read/${MEDIA_ACCOUNT}/chats/${MEDIA_FAN_ID}/media?limit=40&offset=0`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
  }

  it("upserts locators synchronously on the capture-first path, before the response returns", async () => {
    app.config.ofapiMirrorInteractiveCaptureEnabled = true;
    await testDb!.pool.query(
      `insert into ofapi_credit_state (id, spend_day, last_balance, last_balance_at)
       values (1, current_date, 9000, now())
       on conflict (id) do update set last_balance = excluded.last_balance, last_balance_at = excluded.last_balance_at`);
    readBody = syntheticChatMediaPage([photoMedia(3000030, policySignedUrl, new Date(Date.now() + 6 * 3_600_000))]);
    const server = await buildApiServer(app);
    try {
      const response = await injectGallery(server);
      expect(response.statusCode, response.body).toBe(200);
    } finally {
      await server.close();
    }
    const observations = await testDb!.pool.query("select 1 from observations where kind = 'ofapi.interactive_response.v1'");
    expect(observations.rows).toHaveLength(1);
    const locators = await testDb!.pool.query<{ variant: string; source: string; sig_kind: string; chat_id: string; page_id: string }>(
      "select variant, source, sig_kind, chat_id, page_id::text from ofapi_media_locators where media_id = '3000030' order by variant");
    expect(locators.rows).toEqual([
      { variant: "full", source: "gateway", sig_kind: "policy", chat_id: String(MEDIA_FAN_ID), page_id: String(pageId) },
      { variant: "thumb", source: "gateway", sig_kind: "policy", chat_id: String(MEDIA_FAN_ID), page_id: String(pageId) },
    ]);
  });

  it("upserts locators on the proxy-read path too", async () => {
    app.config.ofapiMirrorInteractiveCaptureEnabled = false;
    readBody = syntheticChatMediaPage([photoMedia(3000031, policySignedUrl, new Date(Date.now() + 6 * 3_600_000))]);
    const server = await buildApiServer(app);
    try {
      const response = await injectGallery(server);
      expect(response.statusCode, response.body).toBe(200);
    } finally {
      await server.close();
    }
    const locators = await testDb!.pool.query("select 1 from ofapi_media_locators where media_id = '3000031'");
    expect(locators.rows).toHaveLength(2);
  });

  it("marks a media-context re-read on the capture path attempt", async () => {
    app.config.ofapiMirrorInteractiveCaptureEnabled = true;
    await testDb!.pool.query(
      `insert into ofapi_credit_state (id, spend_day, last_balance, last_balance_at)
       values (1, current_date, 9000, now())
       on conflict (id) do update set last_balance = excluded.last_balance, last_balance_at = excluded.last_balance_at`);
    readBody = syntheticChatMediaPage([photoMedia(3000032, policySignedUrl, new Date(Date.now() + 6 * 3_600_000))]);
    const server = await buildApiServer(app);
    try {
      const response = await server.inject({
        method: "GET",
        url: `/api/v1/ofapi/read/${MEDIA_ACCOUNT}/chats/${MEDIA_FAN_ID}/media?limit=40`,
        headers: { authorization: `Bearer ${chatterKey}`, "x-agency-hub-read-intent": "media-context-v1" },
      });
      expect(response.statusCode, response.body).toBe(200);
      const refused = await server.inject({
        method: "GET",
        url: `/api/v1/ofapi/read/${MEDIA_ACCOUNT}/chats?limit=10`,
        headers: { authorization: `Bearer ${chatterKey}`, "x-agency-hub-read-intent": "media-context-v1" },
      });
      expect(refused.statusCode).toBe(400);
    } finally {
      await server.close();
    }
    const media = await testDb!.pool.query<{ surface: string }>(
      `select distinct attempt.surface from ofapi_credit_ledger ledger
       join ofapi_request_attempts attempt on attempt.id = ledger.attempt_id`);
    expect(media.rows).toEqual([{ surface: "ofapi_gateway_chat_media:media_context" }]);
  });

  it("rebuilds locators from journaled webhook payloads without any vendor call", async () => {
    const envelope = syntheticMessagesReceived({ media: [photoMedia(3000033, expiresSignedUrl, new Date(Date.now() + 3_600_000))] });
    await insertOfapiWebhookEvent(app.db, {
      idempotencyKey: `evt_${"e".repeat(40)}`, eventType: "messages.received", ofapiAccountId: MEDIA_ACCOUNT,
      payload: envelope as unknown as Record<string, unknown>,
    });
    const result = await recoverOfapiMediaLocators(app, { hours: 1 });
    expect(result).toMatchObject({ webhookEvents: 1, locators: 2 });
    expect(upstreamRequests).toHaveLength(0);
    await expect(resolveOfapiMedia(app, principal, request("3000033"))).resolves.toMatchObject({ outcome: "free_url" });
  });

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
      expect(reports.json()).toEqual({ accepted: 1, duplicate: 0, unknown: 0 });
    } finally {
      await server.close();
    }
  });
});
