import { describe, expect, it, vi } from "vitest";

import { dedupeOfapiMediaLocators, ofapiMediaLinksFromLocators, ofapiMediaTransferCredits, type Database } from "@agency_hub_core/db";
import { findOfapiReadDefinition, classifyOfapiCollectionOperation, OFAPI_COLLECTION_REGISTRY, OFAPI_READ_CATALOG } from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  decodeCloudFrontPolicy,
  ofapiMediaLocatorErrorFields,
  ofapiMediaLocatorsFromGatewayBody,
  ofapiMediaLocatorsFromWebhook,
  parseOfapiMediaUrl,
  recordOfapiGatewayMediaLocators,
  selectOfapiMediaVariantUrls,
} from "../apps/runtime/src/services/ofapi-media-locators.ts";
import {
  createOfapiMediaTransportLimiter,
  ofapiMediaDownloadPrice,
  OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_CREDITS,
} from "../apps/runtime/src/services/ofapi-media-resolve.ts";
import {
  expiresSignedUrl,
  fansapiCacheUrl,
  lockedMedia,
  MEDIA_ACCOUNT,
  MEDIA_FAN_ID,
  MEDIA_MESSAGE_ID,
  photoMedia,
  policySignedUrl,
  syntheticChatMediaPage,
  syntheticCloudFrontPolicy,
  syntheticMessagesReceived,
  syntheticVaultPage,
  videoMedia,
} from "./helpers/ofapi-media-fixtures.ts";

const EXPIRES = new Date("2026-09-28T03:00:00.000Z");

describe("media URL signature parser", () => {
  it("reads a canned (Expires) signature as a free, address-free locator", () => {
    const parsed = parseOfapiMediaUrl(expiresSignedUrl("a/aa/syn1/300x300_syn1.jpg", EXPIRES));
    expect(parsed).toMatchObject({ host: "onlyfans", sigKind: "expires", ipBound: false, fileExt: "jpg" });
    expect(parsed?.expiresAt?.toISOString()).toBe(EXPIRES.toISOString());
  });

  it("decodes a custom CloudFront policy and flags its address condition", () => {
    expect(decodeCloudFrontPolicy(syntheticCloudFrontPolicy(1790600400))).toEqual({
      expiresAt: new Date(1790600400 * 1000), ipBound: true,
    });
    expect(decodeCloudFrontPolicy(syntheticCloudFrontPolicy(1790600400, null))).toEqual({
      expiresAt: new Date(1790600400 * 1000), ipBound: false,
    });
    const parsed = parseOfapiMediaUrl(policySignedUrl("a/aa/syn1/300x300_syn1.jpg", EXPIRES));
    expect(parsed).toMatchObject({ host: "onlyfans", sigKind: "policy", ipBound: true });
    expect(parsed?.expiresAt?.toISOString()).toBe(EXPIRES.toISOString());
  });

  it("treats an unreadable policy as address-bound", () => {
    const parsed = parseOfapiMediaUrl("https://cdn2.onlyfans.com/files/a/aa/syn1/x.jpg?Policy=%%%&Signature=s&Key-Pair-Id=k");
    expect(parsed).toMatchObject({ sigKind: "policy", ipBound: true, expiresAt: null });
  });

  it("reads an OFAPI cache URL as presigned with its X-Amz expiry and the same file identity", () => {
    const signedAt = new Date("2026-09-27T14:03:00.000Z");
    const cache = parseOfapiMediaUrl(fansapiCacheUrl("a/aa/syn1/300x300_syn1.jpg", signedAt));
    const origin = parseOfapiMediaUrl(expiresSignedUrl("a/aa/syn1/300x300_syn1.jpg", EXPIRES));
    expect(cache).toMatchObject({ host: "fansapi", sigKind: "fansapi" });
    expect(cache?.expiresAt?.toISOString()).toBe("2026-09-27T15:03:00.000Z");
    // Same path → same identity (the OFAPI cache and the desktop cache key on it).
    expect(cache?.pathSha256).toBe(origin?.pathSha256);
  });

  it.each([
    ["http://cdn2.onlyfans.com/files/a/x.jpg?Expires=1&Signature=s"],
    ["https://public.onlyfans.com/files/a/x.jpg"],
    ["https://dl.fansapi.com/d/token/x.jpg"],
    ["https://user:pass@cdn2.onlyfans.com/files/a/x.jpg"],
    ["https://cdn2.onlyfans.com:8443/files/a/x.jpg"],
    ["https://cdn2.onlyfans.com/other/a/x.jpg"],
    ["not a url"],
    [42],
  ])("ignores %s", (raw) => {
    expect(parseOfapiMediaUrl(raw)).toBeNull();
  });
});

describe("variant rule (shared with the desktop)", () => {
  it("thumb is thumb → squarePreview → preview and never the full file", () => {
    const media = photoMedia(1, expiresSignedUrl, EXPIRES);
    expect(selectOfapiMediaVariantUrls(media).thumb).toContain("300x300_syn1.jpg");
    expect(selectOfapiMediaVariantUrls({ ...media, files: { ...media.files, thumb: { url: null } } }).thumb).toContain("960x960_syn1.jpg");
    expect(selectOfapiMediaVariantUrls({ files: { full: media.files.full, preview: media.files.preview } }).thumb).toContain("480x640_syn1.jpg");
    expect(selectOfapiMediaVariantUrls({ files: { full: media.files.full } }).thumb).toBeNull();
    expect(selectOfapiMediaVariantUrls(media).full).toContain("960x1280_syn1.jpg");
  });
});

describe("locator extraction", () => {
  const observedAt = new Date("2026-09-27T03:49:04.000Z");

  it("takes free Expires URLs and message provenance from a messages.received webhook", () => {
    const envelope = syntheticMessagesReceived({
      media: [photoMedia(3000001, expiresSignedUrl, EXPIRES), videoMedia(3000002, expiresSignedUrl, EXPIRES), lockedMedia(3000003)],
    });
    const rows = ofapiMediaLocatorsFromWebhook(envelope, { pageId: 7, observedAt });
    expect(rows.map((row) => `${row.mediaId}:${row.variant}`)).toEqual([
      "3000001:thumb", "3000001:full", "3000002:thumb", "3000003:thumb", "3000003:full",
    ]);
    const photoThumb = rows[0]!;
    expect(photoThumb).toMatchObject({
      ofapiAccountId: MEDIA_ACCOUNT, source: "webhook", pageId: 7, sigKind: "expires", mediaType: "photo",
      chatId: String(MEDIA_FAN_ID), messageId: String(MEDIA_MESSAGE_ID), vaultMedia: false, canView: true, isReady: true,
    });
    expect(photoThumb.url).toContain("300x300_syn3000001.jpg");
    // A video never gets a full locator; a locked item records access flags without a URL.
    expect(rows.find((row) => row.mediaId === "3000002" && row.variant === "full")).toBeUndefined();
    expect(rows.find((row) => row.mediaId === "3000003" && row.variant === "full")).toMatchObject({ url: null, canView: false });
  });

  it("ignores non-message webhooks", () => {
    expect(ofapiMediaLocatorsFromWebhook({ event: "tips.received", account_id: MEDIA_ACCOUNT, payload: {} }, { pageId: 7, observedAt })).toEqual([]);
  });

  it("takes Policy+IpAddress URLs and the chat id from a gateway chats/{id}/media page", () => {
    const rows = ofapiMediaLocatorsFromGatewayBody({
      operation: "ofapi_gateway_chat_media", ofapiAccountId: MEDIA_ACCOUNT, pageId: 7,
      pathname: `/${MEDIA_ACCOUNT}/chats/${MEDIA_FAN_ID}/media`,
      body: syntheticChatMediaPage([photoMedia(3000004, policySignedUrl, EXPIRES)]), observedAt,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ source: "gateway", sigKind: "policy", chatId: String(MEDIA_FAN_ID), messageId: "2000002", vaultMedia: false });
  });

  it("marks vault list items as vault media", () => {
    const rows = ofapiMediaLocatorsFromGatewayBody({
      operation: "ofapi_gateway_vault_media", ofapiAccountId: MEDIA_ACCOUNT, pageId: 7,
      pathname: `/${MEDIA_ACCOUNT}/media/vault`,
      body: syntheticVaultPage([photoMedia(3000005, policySignedUrl, EXPIRES), { id: 3000006, type: "video", isReady: false, files: {} }]),
      observedAt,
    });
    expect(rows.map((row) => [row.mediaId, row.variant, row.vaultMedia, row.isReady])).toEqual([
      ["3000005", "thumb", true, true], ["3000005", "full", true, true], ["3000006", "thumb", true, false],
    ]);
  });

  it("ignores reads that carry no media", () => {
    expect(ofapiMediaLocatorsFromGatewayBody({
      operation: "ofapi_gateway_chats", ofapiAccountId: MEDIA_ACCOUNT, pageId: 7, pathname: `/${MEDIA_ACCOUNT}/chats`,
      body: syntheticChatMediaPage([photoMedia(3000007, policySignedUrl, EXPIRES)]), observedAt,
    })).toEqual([]);
  });

  it("dedupes a batch by key, keeping the newest observation with a URL", () => {
    const row = ofapiMediaLocatorsFromWebhook(syntheticMessagesReceived({ media: [photoMedia(1, expiresSignedUrl, EXPIRES)] }), { pageId: 7, observedAt })[0]!;
    const deduped = dedupeOfapiMediaLocators([{ ...row, url: null }, row, { ...row, observedAt: new Date(0) }]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.url).toBe(row.url);
  });

  it("orders every batch by key, so concurrent upserts lock rows in one order", () => {
    const rows = ofapiMediaLocatorsFromWebhook(syntheticMessagesReceived({
      media: [photoMedia(30, expiresSignedUrl, EXPIRES), photoMedia(4, expiresSignedUrl, EXPIRES), videoMedia(200, expiresSignedUrl, EXPIRES)],
    }), { pageId: 7, observedAt });
    const keys = dedupeOfapiMediaLocators([...rows].reverse()).map((row) => `${row.mediaId}|${row.variant}`);
    expect(keys).toEqual(["200|thumb", "30|full", "30|thumb", "4|full", "4|thumb"]);
    expect(dedupeOfapiMediaLocators(rows).map((row) => `${row.mediaId}|${row.variant}`)).toEqual(keys);
  });

  it("derives one link per message and one per vault listing, newest first wins, key-ordered", () => {
    const message = ofapiMediaLocatorsFromWebhook(syntheticMessagesReceived({ media: [photoMedia(5, expiresSignedUrl, EXPIRES)] }), { pageId: 7, observedAt });
    const vault = ofapiMediaLocatorsFromGatewayBody({
      operation: "ofapi_gateway_vault_media", ofapiAccountId: MEDIA_ACCOUNT, pageId: 7, pathname: `/${MEDIA_ACCOUNT}/media/vault`,
      body: syntheticVaultPage([photoMedia(5, policySignedUrl, EXPIRES)]), observedAt: new Date(observedAt.getTime() + 1_000),
    });
    const links = ofapiMediaLinksFromLocators([...vault, ...message]);
    expect(links).toEqual([
      { ofapiAccountId: MEDIA_ACCOUNT, mediaId: "5", linkKey: `message:${MEDIA_MESSAGE_ID}`, pageId: 7,
        chatId: String(MEDIA_FAN_ID), messageId: String(MEDIA_MESSAGE_ID), observedAt },
      { ofapiAccountId: MEDIA_ACCOUNT, mediaId: "5", linkKey: "vault", pageId: 7, chatId: null, messageId: null,
        observedAt: new Date(observedAt.getTime() + 1_000) },
    ]);
  });

  it("never logs a failed locator write's message: it quotes signed URLs", async () => {
    const signed = expiresSignedUrl("a/aa/syn9/300x300_syn9.jpg", EXPIRES);
    const failure = Object.assign(new Error(`Failed query: insert into ofapi_media_locators ... params: ${signed}`), {
      name: "DrizzleQueryError", cause: Object.assign(new Error(`duplicate ... ${signed}`), { name: "DatabaseError", code: "40P01" }),
    });
    expect(ofapiMediaLocatorErrorFields(failure)).toEqual({ errorName: "DrizzleQueryError", causeName: "DatabaseError", errorCode: "40P01" });
    const warn = vi.fn();
    const db = { transaction: () => Promise.reject(failure) } as unknown as Database;
    const app = { db, logger: { warn, info: vi.fn() } } as unknown as Pick<AppContext, "db" | "logger">;
    await expect(recordOfapiGatewayMediaLocators(app, {
      operation: "ofapi_gateway_chat_media", ofapiAccountId: MEDIA_ACCOUNT, pageId: 7,
      pathname: `/${MEDIA_ACCOUNT}/chats/${MEDIA_FAN_ID}/media`,
      body: syntheticChatMediaPage([photoMedia(9, expiresSignedUrl, EXPIRES)]),
    })).resolves.toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).not.toContain("onlyfans.com");
    expect(logged).not.toContain("Signature");
    expect(logged).toContain("40P01");
  });
});

describe("media transport limiter", () => {
  it("runs at most `concurrency` hops at once and hands slots over in order", async () => {
    const limiter = createOfapiMediaTransportLimiter({ concurrency: 2, spacingMs: 0 });
    const first = await limiter.acquire(1_000);
    const second = await limiter.acquire(1_000);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(limiter.active()).toBe(2);
    const third = limiter.acquire(1_000);
    let granted = false;
    void third.then(() => { granted = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(granted).toBe(false);
    first!();
    expect(await third).not.toBeNull();
    expect(limiter.active()).toBe(2);
  });

  it("gives up after the bounded wait instead of queueing further", async () => {
    const limiter = createOfapiMediaTransportLimiter({ concurrency: 1, spacingMs: 0 });
    const held = await limiter.acquire(1_000);
    const started = Date.now();
    expect(await limiter.acquire(50)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    held!();
    // A timed-out waiter never takes a slot later.
    expect(limiter.active()).toBe(0);
    expect(await limiter.acquire(50)).not.toBeNull();
  });

  it("spaces starts", async () => {
    const limiter = createOfapiMediaTransportLimiter({ concurrency: 4, spacingMs: 60 });
    const started = Date.now();
    await limiter.acquire(1_000);
    await limiter.acquire(1_000);
    await limiter.acquire(1_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });
});

describe("media transport registration", () => {
  it("prices downloads at 3 credits per decimal MB, minimum 1", () => {
    expect(ofapiMediaDownloadPrice(21_821)).toBe(1);
    expect(ofapiMediaDownloadPrice(333_334)).toBe(2);
    expect(ofapiMediaDownloadPrice(1_000_000)).toBe(3);
    expect(ofapiMediaDownloadPrice(2_500_001)).toBe(8);
    expect(ofapiMediaTransferCredits(0)).toBe(1);
    // A click of unknown size is reserved at what its 5 MB guard can cost.
    expect(OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_CREDITS).toBe(15);
  });

  it("registers the free probe and the paid download under media_previews, outside the gateway catalog", () => {
    expect(findOfapiReadDefinition("ofapi_media_probe")).toMatchObject({ category: "media_previews", reservedCredits: 0 });
    expect(findOfapiReadDefinition("ofapi_media_download")).toMatchObject({ category: "media_previews" });
    expect(findOfapiReadDefinition("ofapi_media_download")?.reservedCredits).toBeUndefined();
    expect(classifyOfapiCollectionOperation("ofapi_media_probe")).toBe("media_previews");
    expect(classifyOfapiCollectionOperation("ofapi_media_download")).toBe("media_previews");
    expect(OFAPI_READ_CATALOG.some((row) => row.category === "media_previews")).toBe(false);
    expect(OFAPI_COLLECTION_REGISTRY.find((row) => row.id === "media_previews")).toMatchObject({
      modes: ["off", "on_demand"], baseline: false, priceUnit: "calls_and_bytes", supportsOneOff: false,
    });
  });
});
