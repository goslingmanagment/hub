import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildFanslyWireBody,
  buildFanslyWireRequest,
  describeFanslyWrite,
  FANSLY_PUBLISH_WIRE_SPECS,
  FANSLY_UPLOAD_BASE_URL,
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
  it("are the POSTs of spec §5, and nothing else in the table writes", () => {
    expect(WRITES.sort()).toEqual([
      "publish.account_media", "publish.account_media_bundle", "publish.post", "publish.post_cancel",
      "publish.story", "publish.upload_complete", "publish.upload_create",
    ]);
    for (const id of FANSLY_WIRE_IDS) {
      expect(isFanslyWriteWireId(id), id).toBe(WRITES.includes(id));
      expect(fanslyWireMethod(id), id).toBe(WRITES.includes(id) ? "POST" : "GET");
    }
  });

  it("are unverified until the stand's capture, and the engine may send none of them", () => {
    for (const id of WRITES) {
      expect(fanslyWireSpec(id).writeContract, id).toBe("unverified");
      expect(isFanslyWriteSendable(id), id).toBe(false);
    }
    // A read is never a sendable write.
    expect(isFanslyWriteSendable("account.me")).toBe(false);
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
    for (const id of ["publish.account_media", "publish.account_media_bundle", "publish.post", "publish.story", "publish.post_cancel"] as const) {
      expect(fanslyWireSpec(id).host, id).toBe("api");
    }
  });

  it("are never the site's: its own POST /post, upload and cancel stay refused", () => {
    expect(matchSiteRequest("api", "POST", "/api/v1/post")).toEqual({ kind: "refused", reason: "write" });
    expect(matchSiteRequest("api", "POST", "/api/v1/post/scheduled/1/cancel")).toEqual({ kind: "refused", reason: "write" });
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
    expect(cancel("1").pathAndQuery).toBe("/api/v1/post/scheduled/1/cancel?ngsw-bypass=true");
    expect(cancel("1").fingerprint).not.toBe(cancel("2").fingerprint);
    const upload = describeFanslyWrite("publish.upload_create", { fileSize: 10, mimeType: "image/jpeg", fileName: "a.jpg" });
    expect(upload).toMatchObject({ host: "upload", pathAndQuery: "/api/v1/media/upload/create?ngsw-bypass=true" });
    expect(fanslyWriteFingerprint({ method: "POST", host: "api", pathAndQuery: upload.pathAndQuery, body: upload.body })).not.toBe(upload.fingerprint);
  });

  it("carries the price in mills and the audience as Hub decided them", () => {
    const paid = JSON.parse(buildFanslyWireBody("publish.account_media_bundle", {
      accountMediaIds: ["1", "2"], audience: { kind: "price", priceMills: 7_500 }, previewMediaId: "3",
    })!);
    expect(paid).toMatchObject({ accountMediaIds: ["1", "2"], previewId: "3" });
    expect(paid.permissions.permissionFlags).toHaveLength(1);
    expect(paid.permissions.permissionFlags[0]).toMatchObject({ price: 7_500 });
    const free = JSON.parse(buildFanslyWireBody("publish.account_media", { mediaIds: ["5"], audience: { kind: "everyone" } })!);
    expect(free).toEqual([{ mediaId: "5", permissions: { permissionFlags: [], accountPermissionFlags: { flags: 0, metadata: "" } } }]);
    // A zero or fractional price never makes a body.
    expect(() => buildFanslyWireBody("publish.account_media", { mediaIds: ["5"], audience: { kind: "price", priceMills: 0 } })).toThrow(RangeError);
    expect(() => buildFanslyWireBody("publish.account_media", { mediaIds: ["5"], audience: { kind: "price", priceMills: 1.5 } })).toThrow(RangeError);
  });

  it("refuses a body no request may carry, before anything is built", () => {
    expect(() => describeFanslyWrite("publish.post", { ...POST_PARAMS, wallIds: [] })).toThrow(RangeError);
    expect(() => describeFanslyWrite("publish.post", { ...POST_PARAMS, expiresAtMs: POST_PARAMS.scheduledForMs })).toThrow(RangeError);
    expect(() => describeFanslyWrite("publish.story", { contentId: " ", contentType: 1 })).toThrow(RangeError);
    expect(() => describeFanslyWrite("publish.upload_complete", { uploadId: "1", uploadType: 1, partSize: 5, parts: [] })).toThrow(RangeError);
    expect(() => describeFanslyWrite("account.me", {} as never)).toThrow(/not a write/);
  });

  it("builds a session request with its method, body and fingerprint; the upload API on its own host", () => {
    const session = { authorization: "synthetic" };
    const post = buildFanslyWireRequest("publish.post", POST_PARAMS, { baseUrl: API, session, timeoutMs: 1_000 });
    const write = describeFanslyWrite("publish.post", POST_PARAMS);
    expect(post).toMatchObject({ method: "POST", url: `${API}/post?ngsw-bypass=true`, body: write.body, writeFingerprint: write.fingerprint });
    expect(post.headers["content-type"]).toBe("application/json");
    const upload = buildFanslyWireRequest("publish.upload_create", { fileSize: 10, mimeType: "image/jpeg", fileName: "a.jpg" }, { baseUrl: API, session, timeoutMs: 1_000 });
    expect(upload.url).toBe(`${FANSLY_UPLOAD_BASE_URL}/media/upload/create?ngsw-bypass=true`);
    // A read stays a bare GET.
    const read = buildFanslyWireRequest("account.me", {}, { baseUrl: API, session, timeoutMs: 1_000 });
    expect(read.method).toBeUndefined();
    expect(read.body).toBeUndefined();
  });
});

describe("this process sends no write (spec §2.2: through the page's browser only)", () => {
  it("the wire send refuses a POST before the admission is asked and before any dispatch", async () => {
    let asked = 0;
    let dispatched = 0;
    const dispatcher = new Proxy({}, { get: () => () => { dispatched += 1; } }) as never;
    const request = buildFanslyWireRequest("publish.post", POST_PARAMS, { baseUrl: API, session: { authorization: "x" }, timeoutMs: 1_000 });
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
