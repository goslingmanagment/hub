import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  fanslyPublishPermissions} from "@agency_hub_core/fansly";
import {
  buildFanslyWireBody,
  buildFanslyWireUrl,
  describeFanslyWrite,
  FANSLY_PUBLISH_WIRE_SPECS,
  FANSLY_PUBLISH_FACTS_VERIFIED,
  FANSLY_UPLOAD_BASE_URL,
  FANSLY_VERIFIED_WRITE_ROUTES,
  fanslyFypFlags,
  fanslyWritePermission,
  FANSLY_WIRE_IDS,
  fanslyWireMethod,
  fanslyWireSpec,
  fanslyWriteFingerprint,
  isFanslyWriteSendable,
  isFanslyWriteWireId,
  sendFanslyWireRequest,
  type FanslyWireId,
} from "@agency_hub_core/fansly";

import { isAnswerInMemory } from "../apps/runtime/src/sync/engine/commit.ts";
import { matchSiteRequest } from "../apps/runtime/src/sync/fansly/route-match.ts";

// Wall posts PR 6: the engine's write routes. Each is a POST whose body Hub
// builds of its parameters; its fingerprint (method, host class, path with
// query, the body's sha256) is what the command records before the send and
// the page's browser checks (PR 7). None is sendable before the stand's
// capture verifies its contract, none leaves through this process, and every
// answer is journaled before anything reads it.

const API = "https://apiv3.fansly.com/api/v1";
const WRITES = Object.keys(FANSLY_PUBLISH_WIRE_SPECS) as FanslyWireId[];

const POST_PARAMS = {
  content: "hello",
  attachments: [{ contentId: "900", contentType: 1 as const, pos: 0 }],
  scheduledForMs: 1_793_000_000_000,
  expiresAtMs: 0,
  wallIds: ["77"],
  fyp: true,
};

describe("the publishing routes", () => {
  it("are the POSTs of spec §5 and an upload's part (a PUT, PR 8), and nothing else in the table writes", () => {
    expect(WRITES.sort()).toEqual([
      "publish.account_media", "publish.account_media_bundle", "publish.post", "publish.post_cancel", "publish.post_delete",
      "publish.story", "publish.upload_complete", "publish.upload_create",
    ]);
    for (const id of FANSLY_WIRE_IDS) {
      expect(isFanslyWriteWireId(id), id).toBe(WRITES.includes(id) || id === "publish.upload_part");
      expect(fanslyWireMethod(id), id).toBe(WRITES.includes(id) ? "POST" : id === "publish.upload_part" ? "PUT" : "GET");
    }
  });

  it("an upload's part (PR 8) goes to the storage its create named, its answer a receipt never journaled; its status read is a journaled GET of the upload API; both verified by the contract §2", () => {
    const part = fanslyWireSpec("publish.upload_part");
    expect(part).toMatchObject({ host: "storage", method: "PUT", capture: "receipt", kind: null, writeContract: "verified" });
    expect(isAnswerInMemory("publish.upload_part")).toBe(true);
    expect(() => buildFanslyWireUrl("publish.upload_part", {} as never, API)).toThrow(RangeError);
    expect(part.parse({ status: 200, eTag: '"abc"' } as never, {} as never)).toEqual({ ok: true, value: { status: 200, eTag: '"abc"' } });
    expect(part.parse({ status: 200, eTag: "" } as never, {} as never)).toEqual({ ok: true, value: { status: 200, eTag: null } });
    const status = fanslyWireSpec("publish.upload_status");
    expect(status).toMatchObject({ host: "upload", kind: "publish_upload_status", writeContract: "verified" });
    expect(status.method).toBeUndefined();
    expect(buildFanslyWireUrl("publish.upload_status", { uploadId: "777" }, API)).toBe(`${FANSLY_UPLOAD_BASE_URL}/media/upload/777?ngsw-bypass=true`);
    for (const id of ["publish.upload_part", "publish.upload_status"] as const) expect(isFanslyWriteSendable(id), id).toBe(true);
  });

  it("are verified by the contract (2026-10-24), the upload's with the upload (plan PR 8)", () => {
    const verified = ["publish.account_media", "publish.account_media_bundle", "publish.post", "publish.post_cancel", "publish.post_delete", "publish.story", "publish.upload_complete", "publish.upload_create"];
    expect([...FANSLY_VERIFIED_WRITE_ROUTES].sort()).toEqual([...verified, "publish.upload_part", "publish.upload_status"].sort());
    for (const id of WRITES) {
      expect(fanslyWireSpec(id).writeContract, id).toBe(verified.includes(id) ? "verified" : "unverified");
      expect(isFanslyWriteSendable(id), id).toBe(verified.includes(id));
    }
    // A read is never a sendable write.
    expect(isFanslyWriteSendable("account.me")).toBe(false);
    expect(isFanslyWriteSendable("stories.list")).toBe(false);
    // Not captured: a post sent now, a scheduled post's id once out, the
    // schedule being whole. The story list is the contract's (§7).
    expect(FANSLY_PUBLISH_FACTS_VERIFIED).toEqual({ scheduleListWhole: false, scheduledPostKeepsId: false, storyListRead: true, immediatePost: false });
  });

  it("journal every answer before anything reads it (observation first, then parse)", () => {
    for (const id of WRITES) {
      const spec = fanslyWireSpec(id);
      expect(spec.kind, id).toMatch(/^publish_/);
      expect(spec.capture, id).toBeUndefined();
      expect(isAnswerInMemory(id), id).toBe(false);
      // The contract accepts whatever came: the command's apply reads it.
      expect(spec.parse({ anything: true } as never, {} as never)).toEqual({ ok: true, value: { anything: true } });
    }
  });

  it("upload on the upload API, everything else on the API", () => {
    expect(fanslyWireSpec("publish.upload_create").host).toBe("upload");
    expect(fanslyWireSpec("publish.upload_complete").host).toBe("upload");
    for (const id of ["publish.account_media", "publish.account_media_bundle", "publish.post", "publish.story", "publish.post_cancel", "publish.post_delete"] as const) {
      expect(fanslyWireSpec(id).host, id).toBe("api");
    }
  });

  it("are never the site's: its own POST /post, upload and cancel stay refused", () => {
    expect(matchSiteRequest("api", "POST", "/api/v1/post")).toEqual({ kind: "refused", reason: "write" });
    expect(matchSiteRequest("api", "POST", "/api/v1/post/scheduled/1/cancel")).toEqual({ kind: "refused", reason: "write" });
    expect(matchSiteRequest("api", "POST", "/api/v1/post/1/delete")).toEqual({ kind: "refused", reason: "write" });
    expect(matchSiteRequest("upload", "POST", "/api/v1/media/upload/create")).toEqual({ kind: "refused", reason: "write" });
    expect(matchSiteRequest("upload", "GET", "/api/v1/media/upload/1")).toEqual({ kind: "refused", reason: "not_a_route" });
  });
});

describe("a write's request and its fingerprint", () => {
  it("is method, host class, path with query and the sha256 of the body, one per line", () => {
    const write = describeFanslyWrite("publish.post", POST_PARAMS);
    expect(write).toMatchObject({ method: "POST", host: "api", pathAndQuery: "/api/v1/post?ngsw-bypass=true" });
    const bodySha = createHash("sha256").update(write.body).digest("hex");
    const expected = createHash("sha256").update(["fansly-write.v1", "POST", "api", "/api/v1/post?ngsw-bypass=true", bodySha].join("\n")).digest("hex");
    expect(write.fingerprint).toBe(expected);
    expect(fanslyWriteFingerprint({ method: "POST", host: "api", pathAndQuery: write.pathAndQuery, body: write.body })).toBe(expected);
  });

  it("moves with every byte of the body, the path and the host, and with nothing else", () => {
    const base = describeFanslyWrite("publish.post", POST_PARAMS).fingerprint;
    expect(describeFanslyWrite("publish.post", POST_PARAMS).fingerprint).toBe(base);
    expect(describeFanslyWrite("publish.post", { ...POST_PARAMS, content: "hello!" }).fingerprint).not.toBe(base);
    expect(describeFanslyWrite("publish.post", { ...POST_PARAMS, wallIds: ["78"] }).fingerprint).not.toBe(base);
    expect(describeFanslyWrite("publish.post", { ...POST_PARAMS, fyp: false }).fingerprint).not.toBe(base);
    expect(describeFanslyWrite("publish.post", { ...POST_PARAMS, scheduledForMs: POST_PARAMS.scheduledForMs + 1 }).fingerprint).not.toBe(base);
    const cancel = (postId: string) => describeFanslyWrite("publish.post_cancel", { postId });
    expect(cancel("1").body).toBe("");
    expect(cancel("1").pathAndQuery).toBe("/api/v1/post/scheduled/1/cancel?ngsw-bypass=true");
    expect(cancel("1").fingerprint).not.toBe(cancel("2").fingerprint);
    const upload = describeFanslyWrite("publish.upload_create", { fileSize: 10, mimeType: "image/jpeg", fileName: "a.jpg" });
    expect(upload).toMatchObject({ host: "upload", pathAndQuery: "/api/v1/media/upload/create?ngsw-bypass=true" });
    expect(fanslyWriteFingerprint({ method: "POST", host: "api", pathAndQuery: upload.pathAndQuery, body: upload.body })).not.toBe(upload.fingerprint);
  });

  it("carries who sees it and the price in mills in the permissions, as the site writes them (the contract §3)", () => {
    // The contract's own texts, byte for byte.
    const bundle = buildFanslyWireBody("publish.account_media_bundle", {
      media: [{ mediaId: "m1", previewId: "p1" }, { mediaId: "m2", previewId: null }], audience: { kind: "price", priceMills: 7_500 },
    })!;
    expect(bundle).toBe('{"previewId":null,"permissionFlags":0,"price":0,"accountMediaModels":[{"mediaId":"m1","previewId":"p1","permissionFlags":0,"price":0,"whitelist":[]},{"mediaId":"m2","previewId":null,"permissionFlags":0,"price":0,"whitelist":[]}],"whitelist":[],"permissions":{"permissionFlags":[{"type":0,"flags":1,"metadata":"{\\"1\\":\\"{\\\\\\"price\\\\\\":7500}\\"}","price":7500}]},"tags":[]}');
    const one = (audience: Parameters<typeof fanslyPublishPermissions>[0]) =>
      JSON.parse(buildFanslyWireBody("publish.account_media", { media: [{ mediaId: "m5", previewId: null }], audience })!);
    expect(one({ kind: "everyone" })).toEqual([{ mediaId: "m5", previewId: null, permissionFlags: 0, price: 0, whitelist: [], permissions: { permissionFlags: [] }, tags: [] }]);
    expect(one({ kind: "subscribers", tiers: [], priceMills: null })[0].permissions).toEqual({ permissionFlags: [{ flags: 4 }] });
    const tier = one({ kind: "subscribers", tiers: [{ id: "77", name: "Gold" }], priceMills: null })[0].permissions.permissionFlags[0];
    expect(tier).toEqual({ type: 0, flags: 4, metadata: '{"4":"{\\"subscriptionTierId\\":\\"77\\",\\"subscriptionTierName\\":\\"Gold\\",\\"before\\":0,\\"after\\":0}"}' });
    expect(JSON.parse(JSON.parse(tier.metadata)["4"])).toEqual({ subscriptionTierId: "77", subscriptionTierName: "Gold", before: 0, after: 0 });
    const paid = one({ kind: "price", priceMills: 3_000 })[0];
    expect(paid).toMatchObject({ permissionFlags: 0, price: 0 });
    expect(paid.permissions.permissionFlags).toEqual([{ type: 0, flags: 1, metadata: '{"1":"{\\"price\\":3000}"}', price: 3_000 }]);
    // Each entry is one way in (the site's "OR", captured 2026-10-25): several
    // tiers — an entry each; the subscribers of every tier free and anyone
    // else for a price — the site's advanced form, an empty tier then the price.
    const tierEntry = (id: string, name: string) => ({ type: 0, flags: 4, metadata: JSON.stringify({ 4: JSON.stringify({ subscriptionTierId: id, subscriptionTierName: name, before: 0, after: 0 }) }) });
    const priceEntry = (price: number) => ({ type: 0, flags: 1, metadata: JSON.stringify({ 1: JSON.stringify({ price }) }), price });
    expect(one({ kind: "subscribers", tiers: [{ id: "77", name: "Gold" }, { id: "78", name: "Main (nude ❤️)" }], priceMills: null })[0].permissions.permissionFlags)
      .toEqual([tierEntry("77", "Gold"), tierEntry("78", "Main (nude ❤️)")]);
    expect(one({ kind: "subscribers", tiers: [], priceMills: 5_000 })[0].permissions.permissionFlags).toEqual([tierEntry("", ""), priceEntry(5_000)]);
    expect(one({ kind: "subscribers", tiers: [{ id: "77", name: "Gold" }], priceMills: 2_500 })[0].permissions.permissionFlags).toEqual([tierEntry("77", "Gold"), priceEntry(2_500)]);
    expect(() => one({ kind: "subscribers", tiers: [{ id: "77", name: "Gold" }, { id: "77", name: "Gold" }], priceMills: null })).toThrow(RangeError);
    expect(() => one({ kind: "subscribers", tiers: [{ id: "77", name: " " }], priceMills: null })).toThrow(RangeError);
    // A zero or fractional price never makes a body.
    expect(() => one({ kind: "price", priceMills: 0 })).toThrow(RangeError);
    expect(() => one({ kind: "price", priceMills: 1.5 })).toThrow(RangeError);
  });

  it("an upload's create carries the site's form inputs as captured (the contract §2)", () => {
    expect(buildFanslyWireBody("publish.upload_create", { fileSize: 47_185_920, mimeType: "video/mp4", fileName: "test.mp4" }))
      .toBe('{"fileSize":47185920,"mimeType":"video/mp4","fileName":"test.mp4","uploadFormData":{"formInputs":[{"type":1001,"value":"false"},{"type":1002,"value":"false"},{"type":1003,"value":""},{"type":1004,"value":""},{"type":1005,"value":"\\"\\""}]}}');
  });

  it("the post as the site sends it, fypFlags set on every post (the contract §4, §6); the cancel with no body (§5)", () => {
    const body = JSON.parse(buildFanslyWireBody("publish.post", POST_PARAMS)!);
    expect(Object.keys(body)).toEqual(["content", "fypFlags", "inReplyTo", "quotedPostId", "attachments", "scheduledFor", "expiresAt", "postReplyPermissionFlags", "pinned", "wallIds", "pinWallIds"]);
    expect(body).toMatchObject({ fypFlags: 0, inReplyTo: null, quotedPostId: null, pinned: 0, pinWallIds: [], postReplyPermissionFlags: [], scheduledFor: POST_PARAMS.scheduledForMs });
    expect(fanslyFypFlags(true, "new set")).toBe(0);
    expect(fanslyFypFlags(true, "new set #fyp")).toBe(2);
    expect(fanslyFypFlags(false, "new set #fyp")).toBe(4);
    expect(fanslyFypFlags(false, "")).toBe(4);
    expect(buildFanslyWireBody("publish.post_cancel", { postId: "9" })).toBe("");
  });

  it("a published post's delete: its id in the path, no body, the withdraw permission (the contract §5)", () => {
    const remove = (postId: string) => describeFanslyWrite("publish.post_delete", { postId });
    expect(remove("970265084783775744")).toMatchObject({ method: "POST", host: "api", pathAndQuery: "/api/v1/post/970265084783775744/delete?ngsw-bypass=true", body: "" });
    // The fingerprint of an empty body: the sha256 of no bytes.
    const empty = createHash("sha256").update("").digest("hex");
    expect(remove("970265084783775744").fingerprint).toBe(createHash("sha256").update(["fansly-write.v1", "POST", "api", "/api/v1/post/970265084783775744/delete?ngsw-bypass=true", empty].join("\n")).digest("hex"));
    expect(remove("1").fingerprint).not.toBe(remove("2").fingerprint);
    expect(remove("1").fingerprint).not.toBe(describeFanslyWrite("publish.post_cancel", { postId: "1" }).fingerprint);
    expect(buildFanslyWireUrl("publish.post_delete", { postId: "9" }, API)).toBe(`${API}/post/9/delete?ngsw-bypass=true`);
    expect(() => describeFanslyWrite("publish.post_delete", { postId: " " })).toThrow(RangeError);
    expect(fanslyWritePermission("publish.post_delete")).toBe("withdraw");
    expect(fanslyWritePermission("publish.post_cancel")).toBe("withdraw");
    expect(fanslyWritePermission("publish.post")).toBe("create");
  });

  it("refuses a body no request may carry, before anything is built", () => {
    expect(() => describeFanslyWrite("publish.post", { ...POST_PARAMS, wallIds: [] })).toThrow(RangeError);
    expect(() => describeFanslyWrite("publish.post", { ...POST_PARAMS, expiresAtMs: POST_PARAMS.scheduledForMs })).toThrow(RangeError);
    expect(() => describeFanslyWrite("publish.story", { contentId: " ", contentType: 1 })).toThrow(RangeError);
    expect(() => describeFanslyWrite("publish.upload_complete", { uploadId: "1", uploadType: 1, partSize: 5, parts: [] })).toThrow(RangeError);
    expect(() => describeFanslyWrite("account.me", {} as never)).toThrow(/not a write/);
  });

  it("builds a write's URL under the API; the upload API on its own host", () => {
    expect(buildFanslyWireUrl("publish.post", POST_PARAMS, API)).toBe(`${API}/post?ngsw-bypass=true`);
    expect(buildFanslyWireUrl("publish.upload_create", { fileSize: 10, mimeType: "image/jpeg", fileName: "a.jpg" }, API))
      .toBe(`${FANSLY_UPLOAD_BASE_URL}/media/upload/create?ngsw-bypass=true`);
    // A read has no body.
    expect(buildFanslyWireBody("account.me", {})).toBeNull();
  });
});

describe("this process sends no write (spec §2.2: through the page's browser only)", () => {
  it("the wire send refuses a POST before the admission is asked and before any dispatch", async () => {
    let asked = 0;
    let dispatched = 0;
    const dispatcher = new Proxy({}, { get: () => () => { dispatched += 1; } }) as never;
    const write = describeFanslyWrite("publish.post", POST_PARAMS);
    const request = {
      spec: "publish.post" as const,
      method: write.method,
      url: buildFanslyWireUrl("publish.post", POST_PARAMS, API),
      headers: { "content-type": "application/json" },
      body: write.body,
      writeFingerprint: write.fingerprint,
      timeoutMs: 1_000,
    };
    const outcome = await sendFanslyWireRequest(dispatcher, request, { check: () => { asked += 1; return null; } }, new AbortController().signal);
    expect(outcome).toEqual({ kind: "aborted_before_send", refusal: "write_not_sendable" });
    expect(asked).toBe(0);
    expect(dispatched).toBe(0);
    // A body alone is refused too.
    const withBody = await sendFanslyWireRequest(dispatcher, { url: `${API}/account/me`, headers: {}, timeoutMs: 1_000, body: "{}" }, { check: () => null }, new AbortController().signal);
    expect(withBody).toEqual({ kind: "aborted_before_send", refusal: "write_not_sendable" });
    expect(dispatched).toBe(0);
  });
});
