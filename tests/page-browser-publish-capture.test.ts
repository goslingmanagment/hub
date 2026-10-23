import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { stripFanslySignedCdnTokens as standStrip } from "../apps/page-browser/src/capture/cdn-tokens.ts";
import { PUBLISH_CAPTURE_MARKER, publishCaptureBuilt } from "../apps/page-browser/src/capture/mode.ts";
import { captureClassOf, PublishCapture, type PublishLine } from "../apps/page-browser/src/capture/publish.ts";
import { bodyRedacted, headersRedacted, urlRedacted } from "../apps/page-browser/src/capture/redact.ts";
import { Journals } from "../apps/page-browser/src/logs/journal.ts";
import { ANY_METHOD, API_BASE, API_HOST, classifyCaptureHost, classifyHost, CLOSED_ROWS, decide, PUBLISH_CAPTURE_ROWS, UPLOAD_HOST, type CaptureRow, type MapDecision } from "../apps/page-browser/src/policy/operations.ts";
import { buildRules, CAPTURE_PRIORITY, PRIORITY } from "../apps/page-browser/src/policy/rules.ts";
import { NEVER_PATH, UNKNOWN_WRITE_PATH } from "../apps/page-browser/src/selftest/selftest.ts";
import { stripFanslySignedCdnTokens as hubStrip } from "../apps/runtime/src/sync/fansly/lib/cdn-tokens.ts";
import { dnrBlocks, dnrRule, type DnrRequest } from "./helpers/page-browser-dnr.ts";
import { FakeCdpPort } from "./helpers/page-browser-fakes.ts";

// The stand's publish capture (docs/plans/2026-10-23-wall-posts, plan PR
// 0.1): the site's own publishing requests go on the stand's image only.
// A production image has none of it — not a rule, not the marker, not the
// upload host at the proxy — and the image built for the stand opens
// exactly the publishing paths, the two layers (the rules extension and the
// operator's map) as one set; what it journals is cut of its secrets.

const prod = buildRules();
const capture = buildRules({ publishCapture: true });
const MODES = ["automation", "manual_login"] as const;
const url = (row: CaptureRow, path = row.example) => `https://${row.host}${API_BASE}${path}`;
const cdpType = (type: string | undefined) => ({ main_frame: "Document", sub_frame: "Document", ping: "Ping", other: "Other" })[type ?? "xmlhttprequest"] ?? "XHR";
const refused = (decision: MapDecision) => decision.action === "refuse";
const mapOf = (request: DnrRequest, on: boolean) => MODES.map((mode) => decide({ method: request.method, url: request.url, resourceType: cdpType(request.type) }, mode, on));

const tmp: string[] = [];
afterEach(() => {
  for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function build(capture: boolean, into?: string): { dir: string; rules: unknown[] } {
  const dir = into ?? mkdtempSync(join(tmpdir(), "pb-capture-build-"));
  if (into === undefined) tmp.push(dir);
  const policy = join(dir, "hub.json");
  if (!existsSync(policy)) copyFileSync("apps/page-browser/policies/hub.json", policy);
  execFileSync(process.execPath, ["--no-warnings", "apps/page-browser/extension/build.ts", "--out", join(dir, "dist"), "--policy", policy, ...(capture ? ["--capture", "publish"] : [])], { stdio: "pipe" });
  return { dir, rules: JSON.parse(readFileSync(join(dir, "dist", "rules.json"), "utf8")) as unknown[] };
}

describe("a production image has none of the publish capture", () => {
  it("its rules: the levels of the spec only, and every publishing request, the upload host and a part to a Fansly host are cancelled — and refused by the map", () => {
    expect([...new Set(prod.map((rule) => rule.priority))]).toEqual(Object.values(PRIORITY));
    for (const level of Object.values(CAPTURE_PRIORITY)) expect(prod.some((rule) => rule.priority === level)).toBe(false);
    const requests: DnrRequest[] = [
      ...PUBLISH_CAPTURE_ROWS.map((row) => ({ method: row.method, url: url(row) })),
      ...PUBLISH_CAPTURE_ROWS.map((row) => ({ method: row.method, url: `${url(row)}?ngsw-bypass=true` })),
      { method: "OPTIONS", url: `https://${UPLOAD_HOST}${API_BASE}/media/upload/create` },
      { method: "GET", url: `https://${UPLOAD_HOST}/` },
      { method: "PUT", url: "https://upload.fansly.com/bucket/key?partNumber=1&X-Amz-Signature=x" },
    ];
    for (const request of requests) {
      // A GET of the API is a read in every image; the upload host's is not.
      if (request.method === "GET" && request.url.startsWith(`https://${API_HOST}/`)) continue;
      expect(dnrBlocks(prod, request), `${request.method} ${request.url}`).toBe(true);
      for (const decision of mapOf(request, false)) expect(refused(decision), `${request.method} ${request.url}`).toBe(true);
    }
    expect(classifyHost(UPLOAD_HOST)).toBe("closed");
  });

  it("build.ts without --capture writes no marker and no capture rule; with it, both — and a build without it takes an old marker away", () => {
    const plain = build(false);
    expect(publishCaptureBuilt(join(plain.dir, "dist"))).toBe(false);
    expect(plain.rules).toHaveLength(prod.length);
    const stand = build(true);
    expect(publishCaptureBuilt(join(stand.dir, "dist"))).toBe(true);
    expect(stand.rules).toHaveLength(capture.length);
    build(false, stand.dir);
    expect(existsSync(join(stand.dir, "dist", PUBLISH_CAPTURE_MARKER))).toBe(false);
    expect(publishCaptureBuilt(join(stand.dir, "dist"))).toBe(false);
  });

  it("a marker that does not say so is no capture", () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-capture-marker-"));
    tmp.push(dir);
    expect(publishCaptureBuilt(dir)).toBe(false);
    writeFileSync(join(dir, PUBLISH_CAPTURE_MARKER), "{\"capture\":\"publish\"}");
    expect(publishCaptureBuilt(dir)).toBe(false);
    writeFileSync(join(dir, PUBLISH_CAPTURE_MARKER), "not json");
    expect(publishCaptureBuilt(dir)).toBe(false);
  });
});

describe("the stand's image: the capture's rules and the map in the capture are one set", () => {
  it("adds its two levels after the production rules, id for id the same", () => {
    expect(capture.slice(0, prod.length)).toEqual(prod);
    expect(new Set(capture.slice(prod.length).map((rule) => rule.priority))).toEqual(new Set([CAPTURE_PRIORITY.closed, CAPTURE_PRIORITY.open]));
    // Below the closed rows and the escapes, above what they open.
    expect(CAPTURE_PRIORITY.closed).toBeLessThan(PRIORITY.spelling);
    expect(CAPTURE_PRIORITY.open).toBeGreaterThan(PRIORITY.general);
  });

  it("each publishing request goes as a script's — its exact path, a trailing slash, any query — and is the map's capture", () => {
    for (const row of PUBLISH_CAPTURE_ROWS) {
      for (const target of [url(row), `${url(row)}/`, `${url(row)}?ngsw-bypass=true`, `${url(row)}#x`]) {
        const request = { method: row.method, url: target };
        expect(dnrRule(capture, request), `${row.method} ${target}`).toMatchObject({ priority: CAPTURE_PRIORITY.open, action: { type: "allow" } });
        for (const decision of mapOf(request, true)) expect(decision, `${row.method} ${target}`).toMatchObject({ action: "capture", platformData: false });
      }
    }
  });

  it("any other spelling, method, resource type, host or scheme of them is cancelled and refused", () => {
    for (const row of PUBLISH_CAPTURE_ROWS) {
      const path = row.example;
      const others: DnrRequest[] = [
        { method: row.method, url: url(row, path.toUpperCase()) },
        { method: row.method, url: url(row, path.replaceAll("/", "//")) },
        { method: row.method, url: url(row, `${path}//`) },
        { method: row.method, url: url(row, `${path.slice(0, -1)}%${path.charCodeAt(path.length - 1).toString(16)}`) },
        ...["main_frame", "sub_frame", "ping", "other"].map((type) => ({ method: row.method, url: url(row), type })),
        ...["PUT", "PATCH", "DELETE", row.method === "POST" ? "HEAD" : "POST"].map((method) => ({ method, url: url(row) })),
        { method: row.method, url: url(row).replace("https://", "http://") },
        { method: row.method, url: url(row).replace(row.host, `${row.host}:8443`) },
        { method: row.method, url: url(row).replace(row.host, `user@${row.host}`) },
        { method: row.method, url: `https://${row.host}/api/v2${path}` },
        // Hub's placeholder: Hub never takes these paths (the proxy refuses
        // the name besides: a special-use one).
        ...(row.host === API_HOST ? [{ method: row.method, url: url(row).replace(row.host, `${row.host}.pb-hold.invalid`) }] : []),
      ];
      for (const request of others) {
        const what = `${request.method} ${request.url} (${request.type ?? "xmlhttprequest"})`;
        expect(dnrBlocks(capture, request), what).toBe(true);
        for (const decision of mapOf(request, true)) expect(refused(decision), what).toBe(true);
      }
    }
  });

  it("the closed rows stay closed, the self-test's probes are still cancelled, and the upload host opens nothing but its paths", () => {
    const api = (path: string) => `https://${API_HOST}${API_BASE}${path}`;
    for (const row of CLOSED_ROWS) {
      for (const method of row.methods.includes(ANY_METHOD) ? ["GET", "POST", "PUT"] : row.methods) {
        const request = { method, url: api(row.example!) };
        expect(dnrRule(capture, request), `${method} ${row.example}`).toMatchObject({ priority: PRIORITY.closed, action: { type: "block" } });
        for (const decision of mapOf(request, true)) expect(refused(decision), `${method} ${row.example}`).toBe(true);
      }
    }
    for (const path of [NEVER_PATH, UNKNOWN_WRITE_PATH]) expect(dnrBlocks(capture, { method: "POST", url: `https://${API_HOST}${path}?pbst=x` }), path).toBe(true);
    for (const request of [
      { method: "POST", url: `https://${UPLOAD_HOST}${API_BASE}/emotes/upload/create` },
      { method: "GET", url: `https://${UPLOAD_HOST}${API_BASE}/media/other/1` },
      { method: "GET", url: `https://${UPLOAD_HOST}/` },
      { method: "POST", url: `https://${UPLOAD_HOST}/upload` },
      { method: "GET", url: `wss://${UPLOAD_HOST}/`, type: "websocket" },
    ]) {
      expect(dnrBlocks(capture, request), `${request.method} ${request.url}`).toBe(true);
      for (const decision of mapOf(request, true)) expect(refused(decision), `${request.method} ${request.url}`).toBe(true);
    }
    // Its preflights go (a preflight of a closed request is no write).
    const preflight = { method: "OPTIONS", url: `https://${UPLOAD_HOST}${API_BASE}/media/upload/create` };
    expect(dnrBlocks(capture, preflight)).toBe(false);
    for (const decision of mapOf(preflight, true)) expect(decision.action).toBe("preflight");
  });

  it("a part goes to a storage host under fansly.com or a third party's — never to Fansly's role hosts, never but from a script", () => {
    const part = "https://upload.fansly.com/bucket/key?partNumber=1&uploadId=abc&X-Amz-Signature=x";
    expect(dnrRule(capture, { method: "PUT", url: part })).toMatchObject({ priority: CAPTURE_PRIORITY.open, action: { type: "allow" } });
    for (const decision of mapOf({ method: "PUT", url: part }, true)) expect(decision.action).toBe("capture");
    for (const host of [API_HOST, "wsv3.fansly.com", "chatws.fansly.com", "metrics.fansly.com", UPLOAD_HOST, "cdn3.fansly.com", "cdn.fansly.com", "a.b.fansly.com", "fansly.com"]) {
      const request = { method: "PUT", url: `https://${host}/bucket/key` };
      expect(dnrBlocks(capture, request), host).toBe(true);
      for (const decision of mapOf(request, true)) expect(refused(decision), host).toBe(true);
    }
    for (const type of ["main_frame", "sub_frame", "other"]) {
      expect(dnrBlocks(capture, { method: "PUT", url: part, type }), type).toBe(true);
      for (const decision of mapOf({ method: "PUT", url: part, type }, true)) expect(refused(decision), type).toBe(true);
    }
    expect(dnrBlocks(capture, { method: "POST", url: part })).toBe(true);
    // A third party's storage is open in every image (decision №2).
    const s3 = { method: "PUT", url: "https://bucket.s3.us-east-1.amazonaws.com/key?partNumber=1" };
    for (const rules of [prod, capture]) expect(dnrBlocks(rules, s3)).toBe(false);
    for (const on of [false, true]) for (const decision of mapOf(s3, on)) expect(decision.action).toBe("pass");
  });

  it("the proxy of the stand's image tunnels the upload host; every other host is classed as ever", () => {
    expect(classifyCaptureHost(UPLOAD_HOST)).toBe("site");
    for (const host of [API_HOST, "wsv3.fansly.com", "chatws.fansly.com", "cdn3.fansly.com", "fansly.com", "upload.fansly.com", "example.com", "localhost", "10.0.0.1"]) expect(classifyCaptureHost(host), host).toBe(classifyHost(host));
  });
});

describe("what the capture writes is cut of its secrets", () => {
  const CDN = "https://cdn3.fansly.com/1/2.jpeg?ngsw-bypass=true&Policy=eyJ9&Key-Pair-Id=KTEST&Signature=abc~DEF";
  const samples: unknown[] = [
    { response: { locations: [{ locationId: "1", location: CDN }, { location: "https://cdn3.fansly.com/x.m3u8", metadata: { Policy: "p", Signature: "s", "Key-Pair-Id": "k", other: "o" } }] } },
    { response: [{ media: { locations: [{ location: `${CDN} trailing prose` }] } }] },
    { content: CDN, locations: "not a list" },
    { __proto__: { locations: [{ location: CDN }] } },
  ];

  it("strips Fansly's signed CDN tokens as Hub journals them", () => {
    for (const sample of samples) expect(standStrip(sample)).toEqual(hubStrip(sample));
    expect(JSON.stringify(standStrip(samples[0]))).not.toContain("Signature");
  });

  it("a URL keeps where it goes and for how long, not what signs it", () => {
    const s3 = "https://bucket.s3.amazonaws.com/k/1?partNumber=2&uploadId=u1&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2Fx&X-Amz-Date=20261024T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Security-Token=tok&X-Amz-Signature=deadbeef";
    const cut = urlRedacted(s3);
    for (const kept of ["partNumber=2", "uploadId=u1", "X-Amz-Date=20261024T000000Z", "X-Amz-Expires=3600", "X-Amz-Credential=[stripped]", "X-Amz-Signature=[stripped]", "X-Amz-Security-Token=[stripped]"]) expect(cut).toContain(kept);
    for (const gone of ["deadbeef", "AKIA", "tok&"]) expect(cut).not.toContain(gone);
    expect(urlRedacted(CDN)).not.toContain("abc~DEF");
    expect(urlRedacted("https://x.test/p?a=1#Signature=keep")).toBe("https://x.test/p?a=1#Signature=keep");
  });

  it("a body keeps its shape, ids, units and the person's text; never a secret field or an e-mail", () => {
    const body = {
      success: true,
      response: {
        id: "900000000000000001",
        content: "a test post, mail me at someone@example.com",
        scheduledFor: 1790000000000,
        fypFlags: 4,
        wallIds: ["1", "2"],
        parts: [{ index: 0, uploadUrl: "https://upload.fansly.com/b/k?partNumber=1&X-Amz-Signature=sig" }],
        accounts: [{ id: "1", username: "tester", email: "tester@example.com", token: "t0k3n", lastIp: "1.2.3.4" }],
        error: { code: 3, details: "x" },
      },
    };
    const out = JSON.stringify(bodyRedacted(body));
    for (const kept of ["900000000000000001", "1790000000000", "\"fypFlags\":4", "\"username\":\"tester\"", "partNumber=1", "\"code\":3", "a test post, mail me at [e-mail]"]) expect(out).toContain(kept);
    for (const gone of ["tester@example.com", "someone@example.com", "t0k3n", "1.2.3.4", "=sig"]) expect(out).not.toContain(gone);
  });

  it("headers: every name, the values of the session never", () => {
    const out = headersRedacted({ Authorization: "abc", "fansly-session-id": "1", "fansly-client-check": "2", Cookie: "c", "Content-Type": "application/json", Referer: "https://fansly.com/x?token=1", ETag: "\"e\"", ":authority": "x" });
    expect(out).toEqual({ authorization: "[not kept]", "fansly-session-id": "[not kept]", "fansly-client-check": "[not kept]", cookie: "[not kept]", "content-type": "application/json", referer: "https://fansly.com/x", etag: "\"e\"" });
  });
});

describe("the capture follows the site's publishing requests", () => {
  function world(operator = new Set<string>()) {
    const cdp = new FakeCdpPort();
    const lines: PublishLine[] = [];
    const bodies = new Map<string, unknown>();
    cdp.handlers.set("Network.getResponseBody", (command) => {
      const body = bodies.get(String(command.params.requestId));
      return body === undefined ? { error: { code: -32000, message: "No resource" } } : { body: JSON.stringify(body), base64Encoded: false };
    });
    cdp.handlers.set("Network.getRequestPostData", () => ({ postData: "{\"fileSize\":10,\"mimeType\":\"image/jpeg\",\"fileName\":\"a.jpg\"}" }));
    new PublishCapture({ cdp, isOperatorRequest: (id) => operator.has(id), write: (line) => lines.push(line), log: () => undefined });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    return { cdp, lines, bodies, settle };
  }

  it("a post: what it sent and what it got, redacted; a request of Hub's and a read of the account are not followed", async () => {
    const w = world(new Set(["hub-1"]));
    const sent = { content: "hello", scheduledFor: 0, expiresAt: 0, wallIds: ["7"], fypFlags: 0, attachments: [{ contentId: "5", contentType: 1, pos: 0 }] };
    w.bodies.set("p1", { success: true, response: { id: "11", accounts: [{ email: "me@example.com" }] } });
    w.cdp.emit("Network.requestWillBeSent", { requestId: "p1", type: "XHR", request: { method: "POST", url: `https://${API_HOST}${API_BASE}/post?ngsw-bypass=true`, headers: { authorization: "secret", "content-type": "application/json" }, hasPostData: true, postData: JSON.stringify(sent) } }, "S1");
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "p1", headers: { authorization: "secret", "fansly-client-check": "x", "content-type": "application/json" } }, "S1");
    w.cdp.emit("Network.responseReceived", { requestId: "p1", response: { status: 200, headers: { "content-type": "application/json" } } }, "S1");
    w.cdp.emit("Network.loadingFinished", { requestId: "p1", encodedDataLength: 120 }, "S1");
    for (const id of ["hub-1", "me"]) {
      w.cdp.emit("Network.requestWillBeSent", { requestId: id, type: "XHR", request: { method: "GET", url: `https://${API_HOST}${API_BASE}/account/me` } }, "S1");
      w.cdp.emit("Network.loadingFinished", { requestId: id, encodedDataLength: 10 }, "S1");
    }
    await w.settle();
    expect(w.lines).toHaveLength(1);
    const line = w.lines[0]!;
    expect(line).toMatchObject({ what: "publish", method: "POST", host: API_HOST, path: `${API_BASE}/post`, status: 200, blocked: false });
    expect(line.request.body?.json).toEqual(sent);
    expect(line.request.headers).toMatchObject({ authorization: "[not kept]", "fansly-client-check": "[not kept]", "content-type": "application/json" });
    expect(JSON.stringify(line)).not.toContain("me@example.com");
    expect(JSON.stringify(line)).not.toContain("secret");
    expect(line.response?.body?.json).toMatchObject({ response: { id: "11" } });
  });

  it("a part: its size only, never its bytes; its ETag kept; an upload's create read with its body", async () => {
    const w = world();
    w.cdp.emit("Network.requestWillBeSent", { requestId: "c1", type: "XHR", request: { method: "POST", url: `https://${UPLOAD_HOST}${API_BASE}/media/upload/create`, hasPostData: true } }, "S1");
    w.bodies.set("c1", { success: true, response: { id: "u1", partSize: 5242880, parts: [{ index: 0, uploadUrl: "https://upload.fansly.com/k?partNumber=1&X-Amz-Signature=sig" }] } });
    w.cdp.emit("Network.responseReceived", { requestId: "c1", response: { status: 200, headers: {} } }, "S1");
    w.cdp.emit("Network.loadingFinished", { requestId: "c1", encodedDataLength: 50 }, "S1");
    w.cdp.emit("Network.requestWillBeSent", { requestId: "put1", type: "XHR", request: { method: "PUT", url: "https://upload.fansly.com/k?partNumber=1&X-Amz-Signature=sig", hasPostData: true } }, "S1");
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "put1", headers: { "content-length": "5242880", "ngsw-bypass": "true" } }, "S1");
    w.cdp.emit("Network.responseReceivedExtraInfo", { requestId: "put1", statusCode: 200, headers: { ETag: "\"etag-1\"" } }, "S1");
    w.cdp.emit("Network.loadingFinished", { requestId: "put1", encodedDataLength: 300 }, "S1");
    await w.settle();
    const create = w.lines.find((line) => line.id === "c1");
    const part = w.lines.find((line) => line.id === "put1");
    expect(create).toMatchObject({ what: "publish", path: `${API_BASE}/media/upload/create`, status: 200 });
    expect(create!.request.body?.json).toEqual({ fileSize: 10, mimeType: "image/jpeg", fileName: "a.jpg" });
    expect(JSON.stringify(create)).not.toContain("=sig");
    expect(part).toMatchObject({ what: "publish", method: "PUT", host: "upload.fansly.com", status: 200, request: { body: { bytes: 5242880, sha256: null } }, response: { body: null } });
    expect(part!.response?.headers.etag).toBe("\"etag-1\"");
    expect(part!.url).toContain("X-Amz-Signature=[stripped]");
    // The single-request upload's form carries the file: its size only.
    w.cdp.emit("Network.requestWillBeSent", { requestId: "f1", type: "XHR", request: { method: "POST", url: `https://${UPLOAD_HOST}${API_BASE}/media`, headers: { "Content-Type": "multipart/form-data; boundary=x" }, hasPostData: true } }, "S1");
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "f1", headers: { "content-length": "777" } }, "S1");
    w.cdp.emit("Network.loadingFailed", { requestId: "f1", errorText: "net::ERR_FAILED" }, "S1");
    await w.settle();
    expect(w.lines.find((line) => line.id === "f1")).toMatchObject({ what: "publish", request: { body: { bytes: 777, sha256: null } } });
    expect(w.cdp.sent("Network.getRequestPostData").map((command) => command.params.requestId)).toEqual(["c1"]);
    expect(w.cdp.sent("Network.getResponseBody").map((command) => command.params.requestId)).toEqual(["c1"]);
  });

  it("any other write: what it was and how it ended — the rules' block too — never its bodies", async () => {
    const w = world();
    w.cdp.emit("Network.requestWillBeSent", { requestId: "m1", type: "XHR", request: { method: "POST", url: "https://metrics.fansly.com/event/track/v1/", hasPostData: true, postData: "{\"secret\":1}" } }, "S1");
    w.cdp.emit("Network.loadingFailed", { requestId: "m1", errorText: "net::ERR_BLOCKED_BY_CLIENT" }, "S1");
    w.cdp.emit("Network.requestWillBeSent", { requestId: "r1", type: "XHR", request: { method: "GET", url: `https://${API_HOST}${API_BASE}/post/scheduled?ngsw-bypass=true` } }, "S1");
    w.bodies.set("r1", { success: true, response: [] });
    w.cdp.emit("Network.responseReceived", { requestId: "r1", response: { status: 200, headers: {} } }, "S1");
    w.cdp.emit("Network.loadingFinished", { requestId: "r1", encodedDataLength: 20 }, "S1");
    await w.settle();
    const write = w.lines.find((line) => line.id === "m1");
    const read = w.lines.find((line) => line.id === "r1");
    expect(write).toMatchObject({ what: "write", blocked: true, status: null, response: null });
    expect(write!.request.body).toMatchObject({ note: expect.stringContaining("not kept") });
    expect(write!.request.body?.json).toBeUndefined();
    expect(read).toMatchObject({ what: "read", status: 200, response: { body: { json: { success: true, response: [] } } } });
  });

  it("classes: a story's and a cancel's write, an upload's poll, a part's preflight; nothing else of the API's reads", () => {
    expect(captureClassOf("POST", `https://${API_HOST}${API_BASE}/mediastories`, "XHR")?.what).toBe("publish");
    expect(captureClassOf("POST", `https://${API_HOST}${API_BASE}/post/scheduled/5/cancel`, "XHR")?.what).toBe("publish");
    expect(captureClassOf("GET", `https://${UPLOAD_HOST}${API_BASE}/media/upload/5`, "XHR")?.what).toBe("publish");
    expect(captureClassOf("OPTIONS", "https://upload.fansly.com/k", "Preflight")?.what).toBe("preflight");
    expect(captureClassOf("OPTIONS", `https://${API_HOST}${API_BASE}/post`, "Preflight")?.what).toBe("preflight");
    expect(captureClassOf("OPTIONS", `https://${API_HOST}${API_BASE}/account/me`, "Preflight")).toBeNull();
    expect(captureClassOf("GET", `https://${API_HOST}${API_BASE}/account/me`, "XHR")).toBeNull();
    expect(captureClassOf("GET", `https://${API_HOST}${API_BASE}/mediastories/following`, "XHR")).toBeNull();
    expect(captureClassOf("POST", `https://${API_HOST}${API_BASE}/POST`, "XHR")?.what).toBe("write");
  });

  it("its journal is the operator's `publish` one, scrubbed as every journal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-capture-journal-"));
    tmp.push(dir);
    const journals = new Journals({ dir });
    journals.publish({ what: "publish", request: { headers: { authorization: "Bearer abcdefghijklmnop" }, body: { json: { token: "t" } } } });
    expect(await journals.flushed()).toBe(true);
    await journals.close();
    const files = readdirSync(dir);
    expect(files).toEqual([expect.stringMatching(/^publish-\d{4}-\d{2}-\d{2}\.jsonl$/)]);
    const text = readFileSync(join(dir, files[0]!), "utf8");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).toContain('"token":"[secret]"');
  });
});
