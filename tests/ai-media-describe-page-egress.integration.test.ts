import { createRequire } from "node:module";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  ensureSyncPage,
  upsertAiMediaDescriptionCandidate,
  type AiMediaDescriptionRow,
  type AiMediaPlatform,
  type SyncPageMode,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import type {
  MediaDescribeClient,
  MediaDescribeProviderMessage,
} from "../apps/runtime/src/services/ai-media-describe/describer.ts";
import {
  downloadAiMediaThroughPageEgress,
  runAiMediaDescribeSweep,
  type AiMediaDescribeDeps,
  type AiMediaSource,
  type AiMediaSourceResolution,
} from "../apps/runtime/src/services/ai-media-describe/worker.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { startFakeFanslyNetwork, type FakeFanslyNetwork } from "./helpers/fansly-send-guard-network.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Step 4 S4-20: the describer's own download — every page without a `live`
// engine row — after the legacy Fansly send guard left it. The sweep runs with
// its REAL download (no `deps.download`): the page's egress from the resolver,
// the host policy, the fetch seam. Only the wire is local: the page's proxy is
// a CONNECT proxy on loopback, and the process's `fetch` is pointed from the
// CDN's host name at a local origin behind that proxy, keeping the dispatcher
// the download chose — so a tunnel through the proxy is the proof the request
// rode the page's egress, and no tunnel is the proof nothing was sent.
//
//  - an OnlyFans page's row downloads its URL through the page's egress and
//    is described (owner decision №13: OnlyFans stays on this path);
//  - a Fansly CDN URL on a Fansly page the engine does not run answers
//    `send_guard` with no request, no tunnel and no journal row: no legacy
//    sender is left for the page, and the row looks again later.

interface SharpChain {
  jpeg(): SharpChain;
  toBuffer(): Promise<Buffer>;
}
const sharp = createRequire(path.resolve("apps/runtime/package.json"))("sharp") as (
  input: { create: Record<string, unknown> },
) => SharpChain;

const SINCE = new Date("2026-09-28T10:00:00Z");
const NOW = new Date("2026-09-28T12:00:00Z");
const FAN = "700700700";
const ONLYFANS_URL = "https://cdn2.onlyfans.com/files/a/aa/photo-1.jpg?Expires=1790000000&Signature=secret";
const FANSLY_URL = "https://cdn3.fansly.com/photo-2.jpeg?Signature=secret";

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let network: FakeFanslyNetwork | null = null;
let image: Buffer;
/** Every call the download made to the process's fetch. */
let fetched: Array<{ url: string; init: RequestInit & { dispatcher?: unknown } }> = [];

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  image = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#aa2233" } }).jpeg().toBuffer();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  Object.assign(app.config, {
    aiMediaDescribeEnabled: true,
    aiMediaDescribePagePolicies: JSON.stringify({
      "of-page": { since: SINCE.toISOString() },
      "fansly-page": { since: SINCE.toISOString() },
    }),
    aiMediaDescribeModel: "anthropic:claude-sonnet-5",
    aiMediaDescribeDailyImageLimit: 150,
    aiMediaDescribeDailyMicroUsdLimit: 1_000_000,
    aiMediaDescribeModelMedia: "teasers",
    aiMediaDescribeLiveChatOnly: false,
  });
  network = await startFakeFanslyNetwork({
    respond: (_request, response) => {
      response.writeHead(200, { "content-type": "image/jpeg", "content-length": String(image.length) });
      response.end(image);
    },
  });
  fetched = [];
  const realFetch = globalThis.fetch;
  const origin = network.baseUrl;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    fetched.push({ url: url.toString(), init: init ?? {} });
    // The CDN's name resolves to the local origin; the dispatcher is the
    // download's own.
    return realFetch(`${origin}${url.pathname}${url.search}`, init);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await network?.close();
  network = null;
});

const CREATE_PAGE = { onlyfans: createOnlyFansPage, fansly: createFanslyPage } as const;

/** A page of `kind` whose stored proxy is the local CONNECT proxy. */
async function page(kind: AiMediaPlatform, label: string): Promise<number> {
  const model = await createModel(app.db, { slug: `model-${label}`, name: label });
  const created = await CREATE_PAGE[kind](app.db, { modelId: model!.id, label });
  await saveProxy(app, created!.id, { url: network!.proxyUrl });
  return created!.id;
}

async function candidate(pageId: number, platform: AiMediaPlatform, mediaRef: string): Promise<number> {
  const result = await upsertAiMediaDescriptionCandidate(app.db, {
    pageId,
    platform,
    mediaRef,
    variant: "full",
    mediaKind: "photo",
    senderRole: "fan",
    fanPlatformUserId: FAN,
    status: "pending",
    sourceObservationId: 1,
    link: {
      messageRef: `msg-${mediaRef}`,
      conversationRef: "9001900190019",
      fanPlatformUserId: FAN,
      senderRole: "fan",
      messageAt: new Date("2026-09-28T11:00:00Z"),
    },
    observedAt: NOW,
    now: NOW,
  });
  if (result.status !== "applied") throw new Error(`candidate not applied: ${result.status}`);
  return result.descriptionId;
}

/** The sweep's dependencies with the REAL download: a source that hands the
 *  row's URL and a provider that describes what it is shown. */
function realDownloadDeps(urls: Partial<Record<AiMediaPlatform, string>>) {
  const provider = { calls: 0 };
  const client: MediaDescribeClient = {
    async create(): Promise<MediaDescribeProviderMessage> {
      provider.calls += 1;
      return { id: "msg_x", stop_reason: "end_turn", content: [{ type: "text", text: "A red photo." }], usage: { input_tokens: 900, output_tokens: 12 } };
    },
  };
  const source = (platform: AiMediaPlatform): AiMediaSource => ({
    platform,
    async resolve(_app, _row: AiMediaDescriptionRow): Promise<AiMediaSourceResolution> {
      return { kind: "url", url: urls[platform]!, source: "test" };
    },
  });
  const deps: AiMediaDescribeDeps = {
    sources: new Map<AiMediaPlatform, AiMediaSource>([["onlyfans", source("onlyfans")], ["fansly", source("fansly")]]),
    clientFactory: () => client,
    now: () => NOW,
    sleep: async () => undefined,
  };
  return { deps, provider };
}

async function row(id: number) {
  const { rows } = await testDb!.pool.query("select status, description, error_code, next_attempt_at from ai_media_descriptions where id = $1", [id]);
  return rows[0] as { status: string; description: string | null; error_code: string | null; next_attempt_at: Date | null };
}

async function journaledSends(): Promise<number> {
  return (await testDb!.pool.query("select count(*)::int as n from fansly_send_log")).rows[0].n;
}

describe("the describer's own download, through the page's egress", () => {
  it("downloads an OnlyFans page's file through its proxy, with no credentials, and describes it", async () => {
    const pageId = await page("onlyfans", "of-page");
    const id = await candidate(pageId, "onlyfans", "photo-1");
    const { deps, provider } = realDownloadDeps({ onlyfans: ONLYFANS_URL });

    const result = await runAiMediaDescribeSweep(app, deps);

    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(await row(id)).toMatchObject({ status: "described", description: "A red photo." });
    expect(provider.calls).toBe(1);
    // One request, for the row's URL, on a dispatcher — the page's egress:
    // it tunnelled through the page's proxy to reach the origin.
    expect(fetched.map((entry) => entry.url)).toEqual([ONLYFANS_URL]);
    expect(fetched[0]!.init.dispatcher).toBeDefined();
    expect(fetched[0]!.init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
    expect(JSON.stringify(fetched[0]!.init.headers)).not.toMatch(/authorization|cookie/i);
    expect(network!.tunnels).toBe(1);
    expect(network!.arrivals.map((arrival) => arrival.path)).toEqual(["/files/a/aa/photo-1.jpg?Expires=1790000000&Signature=secret"]);
    // No Fansly send guard is asked for an OnlyFans file, now as before.
    expect(await journaledSends()).toBe(0);
  });

  it.each<[string, SyncPageMode | null]>([
    ["has no engine row", null],
    ["is off", "off"],
    ["is in shadow", "shadow"],
  ])("sends nothing for a Fansly file of a Fansly page that %s: send_guard, and the row looks again later", async (_label, mode) => {
    const pageId = await page("fansly", "fansly-page");
    if (mode !== null) {
      await ensureSyncPage(app.db, { pageId });
      await testDb!.pool.query("update sync_pages set mode = $2, mode_changed_by = 'test' where page_id = $1", [pageId, mode]);
    }
    const id = await candidate(pageId, "fansly", "photo-2");
    const { deps, provider } = realDownloadDeps({ fansly: FANSLY_URL });

    // The download itself: refused before any request.
    expect(await downloadAiMediaThroughPageEgress(app, { url: FANSLY_URL, pageId }))
      .toEqual({ ok: false, reason: "send_guard", httpStatus: null });

    // And the sweep over it: nothing wrong with the file, never a failure.
    const result = await runAiMediaDescribeSweep(app, deps);
    expect(result).toMatchObject({ claimed: 1, sent: 0, outcomes: { download_retry: 1 } });
    const after = await row(id);
    expect(after).toMatchObject({ status: "pending", description: null, error_code: "download_send_guard" });
    expect(after.next_attempt_at!.getTime()).toBe(NOW.getTime() + 10 * 60_000);

    expect(provider.calls).toBe(0);
    expect(fetched).toEqual([]);
    expect(network!.tunnels).toBe(0);
    expect(network!.arrivals).toEqual([]);
    // No capture of the page's legacy guard either: nothing is journaled.
    expect(await journaledSends()).toBe(0);
    expect((await testDb!.pool.query("select count(*)::int as n from fansly_page_send_guards where holder_token is not null")).rows[0].n).toBe(0);
  });

  it("refuses an OnlyFans file that redirects onto a Fansly CDN, after the one hop it may make", async () => {
    await network!.close();
    network = await startFakeFanslyNetwork({
      respond: (_request, response) => {
        response.writeHead(302, { location: FANSLY_URL });
        response.end();
      },
    });
    vi.restoreAllMocks();
    const realFetch = globalThis.fetch;
    const origin = network.baseUrl;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      fetched.push({ url: url.toString(), init: init ?? {} });
      return realFetch(`${origin}${url.pathname}${url.search}`, init);
    });
    const pageId = await page("onlyfans", "of-page");

    expect(await downloadAiMediaThroughPageEgress(app, { url: ONLYFANS_URL, pageId }))
      .toEqual({ ok: false, reason: "send_guard", httpStatus: null });
    expect(fetched.map((entry) => entry.url)).toEqual([ONLYFANS_URL]);
    expect(network.arrivals).toHaveLength(1);
  });
});
