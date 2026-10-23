import { describe, expect, it } from "vitest";

import { PausedRequests, type PausedDecision, type PausedRequest } from "../apps/page-browser/src/cdp/paused.ts";
import { checkedPath, decideChecked, describeChecked } from "../apps/page-browser/src/intercept/checked.ts";
import { BODY_CHECKS, checkDeliveredMark, MARK_BODY_MAX, MARK_IDS_MAX } from "../apps/page-browser/src/policy/body-checks.ts";
import type { OperatorMode } from "../apps/page-browser/src/policy/operations.ts";
import { FakeCdpPort } from "./helpers/page-browser-fakes.ts";

// The writes the map opens by their body (owner decision 2026-10-23): the
// site's delivered mark goes, its read marks do not — on the same path. The
// rules extension cannot read a body, so this check is the only thing
// between a read mark and the chatters' unread: here, every way a body can
// fail it, and the operator's decision on a paused request from it.

const ACK = "https://apiv3.fansly.com/api/v1/message/ack";
const SITE_ACK = `${ACK}?ngsw-bypass=true`;
const ID = "123456789012345678";
const ids = (n: number) => Array.from({ length: n }, (_, i) => String(BigInt(ID) + BigInt(i)));
const mark = (type: unknown, messageIds: unknown = [ID]) => JSON.stringify({ messageIds, type });
const bytes = (text: string) => Buffer.from(text, "utf8");

describe("the delivered mark's check of a body", () => {
  it("passes the site's own delivered mark: 1 to 25 ids as strings of digits, type 1, as JSON.stringify writes it — in either order of its keys", () => {
    for (const body of [mark(1), mark(1, ids(MARK_IDS_MAX)), mark(1, ["0", "7", ID, ID]), JSON.stringify({ type: 1, messageIds: [ID] })]) {
      const verdict = checkDeliveredMark(bytes(body));
      expect(verdict, body).toEqual({ ok: true, note: expect.stringMatching(/^a delivered mark \(type 1\) of \d+ message id\(s\), its body checked$/) });
    }
    expect(checkDeliveredMark(bytes(mark(1, ids(25))))).toMatchObject({ note: expect.stringContaining("of 25 message id(s)") });
    expect(BODY_CHECKS.delivered_mark).toBe(checkDeliveredMark);
  });

  it.each([
    ["a read mark of a chat opened", mark(2), "a read mark (type 2)"],
    ["a read mark as it came", mark(3), "a read mark (type 3)"],
    ["an unread mark", mark(4), "an unread mark (type 4)"],
    ["type 0", mark(0), "a mark of type 0"],
    ["type -1", mark(-1), "a mark of type -1"],
    ["a huge type", mark(1e300), "a mark of another type"],
    ["a fraction", mark(1.5), "a mark of another type"],
    ["type as a string", mark("1"), "no number (string)"],
    ["type null", mark(null), "no number (null)"],
    ["type true", mark(true), "no number (boolean)"],
    ["type as a list", mark([1]), "no number (object)"],
    ["type 1.0", `{"messageIds":["${ID}"],"type":1.0}`, "not as the site writes it"],
    ["type 1e0", `{"messageIds":["${ID}"],"type":1e0}`, "not as the site writes it"],
    ["no type", JSON.stringify({ messageIds: [ID] }), "1 key(s)"],
    ["no ids", JSON.stringify({ type: 1 }), "1 key(s)"],
    ["a key more", JSON.stringify({ messageIds: [ID], type: 1, groupId: "1" }), "3 key(s)"],
    ["a key in another case", JSON.stringify({ messageIds: [ID], Type: 1 }), "not exactly messageIds and type"],
    ["__proto__ beside", `{"messageIds":["${ID}"],"type":1,"__proto__":{"type":3}}`, "3 key(s)"],
    ["no key at all", "{}", "0 key(s)"],
    ["type repeated, the last one 1", `{"messageIds":["${ID}"],"type":3,"type":1}`, "a repeated key"],
    ["type repeated, the last one 3", `{"messageIds":["${ID}"],"type":1,"type":3}`, "a read mark (type 3)"],
    ["type spelled with an escape beside it", `{"messageIds":["${ID}"],"typ\\u0065":3,"type":1}`, "a repeated key"],
    ["type spelled with an escape", `{"messageIds":["${ID}"],"typ\\u0065":1}`, "an escape"],
    ["ids repeated", `{"messageIds":["${ID}"],"messageIds":["1"],"type":1}`, "a repeated key"],
    ["whitespace", `{"messageIds": ["${ID}"], "type": 1}`, "whitespace"],
    ["a trailing newline", `${mark(1)}\n`, "not as the site writes it"],
    ["a leading space", ` ${mark(1)}`, "not as the site writes it"],
    ["a digit escaped in an id", `{"messageIds":["\\u0031"],"type":1}`, "not as the site writes it"],
    ["a BOM", `\uFEFF${mark(1)}`, "no JSON"],
    ["a form", `messageIds=${ID}&type=1`, "no JSON"],
    ["two objects", `${mark(1)}${mark(3)}`, "no JSON"],
    ["a list", `[${mark(1)}]`, "no JSON object"],
    ["null", "null", "no JSON object"],
    ["a string", '"x"', "no JSON object"],
    ["a number", "1", "no JSON object"],
    ["ids as a string", mark(1, ID), "no list"],
    ["ids as an object", mark(1, { 0: ID }), "no list"],
    ["no id", mark(1, []), "0 message ids"],
    ["26 ids", mark(1, ids(26)), "26 message ids"],
    ["an id as a number", mark(1, [123]), "no string of digits"],
    ["an empty id", mark(1, [""]), "no string of digits"],
    ["an id with a letter", mark(1, ["12a"]), "no string of digits"],
    ["a negative id", mark(1, ["-1"]), "no string of digits"],
    ["an id with a space", mark(1, [" 1"]), "no string of digits"],
    ["an id with a fraction", mark(1, ["1.5"]), "no string of digits"],
    ["an id of other digits", mark(1, ["١٢"]), "no string of digits"],
    ["an id as null", mark(1, [null]), "no string of digits"],
    ["a good id beside a bad one", mark(1, [ID, "x"]), "no string of digits"],
  ])("refuses %s", (_, body, why) => {
    const verdict = checkDeliveredMark(bytes(body));
    expect(verdict.ok, body).toBe(false);
    expect(verdict.ok ? null : verdict.why, body).toContain(why);
  });

  it("refuses no body, a body that is no UTF-8, and one longer than a mark ever is — before reading it", () => {
    expect(checkDeliveredMark(Buffer.alloc(0))).toEqual({ ok: false, why: "no body" });
    expect(checkDeliveredMark(Buffer.from([0x7b, 0xff, 0x7d]))).toEqual({ ok: false, why: "a body that is no UTF-8" });
    expect(checkDeliveredMark(Buffer.from(`{"messageIds":["${ID}\u00ff"],"type":1}`, "latin1"))).toEqual({ ok: false, why: "a body that is no UTF-8" });
    // A mark of 25 64-bit ids fits well within the limit; a padded body of
    // the right shape does not pass by its size alone.
    expect(bytes(mark(1, Array.from({ length: 25 }, () => "18446744073709551615"))).length).toBeLessThan(700);
    const padded = mark(1, [ID.padEnd(MARK_BODY_MAX, "0")]);
    expect(checkDeliveredMark(bytes(padded))).toEqual({ ok: false, why: `a body of ${bytes(padded).length} bytes, over the ${MARK_BODY_MAX} a mark takes` });
  });

  it("tells nothing of the body in its words but the type of a mark", () => {
    const secret = "S3CRET";
    for (const body of [JSON.stringify({ messageIds: [ID], [secret]: 1 }), mark(secret), mark(1, [secret]), `${secret}`, JSON.stringify({ messageIds: [ID], type: 1, x: secret })]) {
      const verdict = checkDeliveredMark(bytes(body));
      expect(verdict.ok).toBe(false);
      expect(verdict.ok ? "" : verdict.why).not.toContain(secret);
    }
  });
});

/** A paused request of Chrome's, as Fetch gives it at its request stage. */
interface Pause {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  resourceType?: string;
  postData?: string;
  entries?: Array<{ bytes?: string }>;
  hasPostData?: boolean;
  redirectedRequestId?: string;
  replayed?: boolean;
}

function world(mode: OperatorMode = "automation") {
  const cdp = new FakeCdpPort();
  const decided: Array<{ request: PausedRequest; decision: PausedDecision }> = [];
  new PausedRequests(cdp, {
    log: () => undefined,
    readsBody: (request) => checkedPath(request.url),
    decide: (request) => decideChecked(request, mode) ?? { action: "fail", reason: "Aborted", why: "not a checked path's" },
    onDecided: (request, decision) => decided.push({ request, decision }),
  });
  let n = 0;
  const pause = (init: Pause = {}) => {
    const requestId = `I${++n}`;
    const method = init.method ?? "POST";
    const body = init.postData;
    cdp.emit(
      "Fetch.requestPaused",
      {
        requestId,
        networkId: `N${n}`,
        frameId: "F1",
        resourceType: init.resourceType ?? "XHR",
        ...(init.redirectedRequestId === undefined ? {} : { redirectedRequestId: init.redirectedRequestId }),
        request: {
          url: init.url ?? SITE_ACK,
          method,
          headers: init.headers ?? { "Content-Type": "application/json", authorization: "token-x" },
          ...(body === undefined ? {} : { postData: body }),
          ...(init.entries !== undefined ? { postDataEntries: init.entries } : body === undefined ? {} : { postDataEntries: [{ bytes: Buffer.from(body).toString("base64") }] }),
          ...(init.hasPostData !== undefined ? { hasPostData: init.hasPostData } : body === undefined ? {} : { hasPostData: true }),
        },
      },
      undefined,
      init.replayed ?? false,
    );
    const resolved = cdp.commands.filter((command) => command.params.requestId === requestId);
    expect(resolved, `${requestId}: resolved at once, once`).toHaveLength(1);
    const last = decided.at(-1)!;
    return { command: resolved[0]!, decision: last.decision, request: last.request };
  };
  return { cdp, decided, pause };
}

const continued = (requestId: string) => ({ id: expect.any(Number), method: "Fetch.continueRequest", params: { requestId } });
const failed = (requestId: string) => ({ id: expect.any(Number), method: "Fetch.failRequest", params: { requestId, errorReason: "BlockedByClient" } });

describe("the operator's decision on a paused request on the delivered mark's path", () => {
  it.each(["automation", "manual_login"] as const)("%s: lets the site's delivered mark go unchanged, and fails its read marks — the same in both modes", (mode) => {
    const w = world(mode);
    // The site's own: XHR, the site's query, its body attached.
    const delivered = w.pause({ postData: mark(1, ids(3)) });
    expect(delivered.command).toEqual(continued("I1"));
    expect(delivered.decision).toEqual({ action: "continue", note: "a delivered mark (type 1) of 3 message id(s), its body checked" });
    expect(delivered.request.body).toEqual(bytes(mark(1, ids(3))));
    for (const [n, type] of [[2, 2], [3, 3], [4, 4]] as const) {
      const refused = w.pause({ postData: mark(type) });
      expect(refused.command).toEqual(failed(`I${n}`));
      expect(refused.decision).toMatchObject({ action: "fail", reason: "BlockedByClient", why: expect.stringContaining(type === 4 ? "an unread mark (type 4)" : `a read mark (type ${type})`) });
    }
    // 25 ids go; 26 do not.
    expect(w.pause({ postData: mark(1, ids(25)) }).command.method).toBe("Fetch.continueRequest");
    expect(w.pause({ postData: mark(1, ids(26)) }).command.method).toBe("Fetch.failRequest");
  });

  it("reads the body Fetch attached — its entries' bytes before the text — and refuses one it did not attach whole", () => {
    const w = world();
    const good = mark(1);
    // Entries alone, as Chrome may give them (the text is deprecated).
    expect(w.pause({ entries: [{ bytes: Buffer.from(good).toString("base64") }], hasPostData: true }).command.method).toBe("Fetch.continueRequest");
    // In parts: the bytes go together.
    const half = Math.floor(good.length / 2);
    expect(w.pause({ entries: [{ bytes: Buffer.from(good.slice(0, half)).toString("base64") }, { bytes: Buffer.from(good.slice(half)).toString("base64") }], hasPostData: true }).command.method).toBe("Fetch.continueRequest");
    // The text alone, with no entries.
    expect(w.pause({ postData: good, entries: [] }).command.method).toBe("Fetch.continueRequest");
    // The entries are what goes: a text that says otherwise does not count.
    expect(w.pause({ postData: good, entries: [{ bytes: Buffer.from(mark(3)).toString("base64") }] }).decision).toMatchObject({ action: "fail", why: expect.stringContaining("a read mark (type 3)") });
    // A part without its bytes (a file, a stream): the text, part of the
    // body, is not taken for the whole.
    const partial = w.pause({ postData: good, entries: [{ bytes: Buffer.from(good).toString("base64") }, {}] });
    expect(partial.command.method).toBe("Fetch.failRequest");
    expect(partial.decision).toMatchObject({ why: expect.stringContaining("a body Fetch did not attach whole") });
    expect(partial.request.body).toBeNull();
    // A body Chrome did not attach at all.
    expect(w.pause({ hasPostData: true }).decision).toMatchObject({ action: "fail", why: expect.stringContaining("a body Fetch did not attach whole") });
    expect(w.pause({ hasPostData: true, entries: [{}] }).decision).toMatchObject({ action: "fail", why: expect.stringContaining("a body Fetch did not attach whole") });
    // No body.
    const none = w.pause({});
    expect(none.decision).toMatchObject({ action: "fail", why: expect.stringContaining("no body") });
    expect(none.request.body).toEqual(Buffer.alloc(0));
    // Nothing waited: no decision was held, no other CDP command was sent.
    expect(w.decided.every(({ decision }) => decision.action === "continue" || decision.action === "fail")).toBe(true);
    expect(w.cdp.commands.every((command) => command.method === "Fetch.continueRequest" || command.method === "Fetch.failRequest")).toBe(true);
  });

  it("goes only by the map's word on the request: the exact spelling, a script's POST, the site's query — its preflight and its reads as unpaused, the rest failed", () => {
    const w = world();
    const good = mark(1);
    const go = (pause: Pause) => w.pause(pause).command.method === "Fetch.continueRequest";
    expect(go({ url: ACK, postData: good })).toBe(true);
    expect(go({ url: SITE_ACK, postData: good, resourceType: "Fetch" })).toBe(true);
    // Another query, another method, another resource type, a redirect's hop.
    expect(go({ url: `${ACK}?type=3`, postData: good })).toBe(false);
    expect(go({ url: `${SITE_ACK}&x=1`, postData: good })).toBe(false);
    expect(go({ url: `${ACK}?`, postData: good })).toBe(false);
    for (const method of ["PUT", "PATCH", "DELETE"]) expect(go({ method, postData: good }), method).toBe(false);
    for (const resourceType of ["Document", "Ping", "Other", ""]) expect(go({ resourceType, postData: good }), resourceType).toBe(false);
    expect(go({ postData: good, redirectedRequestId: "I1" })).toBe(false);
    // Its CORS preflight goes when its request would be checked: the body
    // comes with the request, at its own pause.
    const preflight = (asked: string, url = SITE_ACK) => go({ method: "OPTIONS", url, headers: { "Access-Control-Request-Method": asked, "Access-Control-Request-Headers": "authorization,content-type" } });
    expect(preflight("POST")).toBe(true);
    expect(preflight("PUT")).toBe(false);
    expect(preflight("POST", `${ACK}?type=3`)).toBe(false);
    expect(go({ method: "OPTIONS", headers: {} })).toBe(false);
    // A read of the path is a read of the map, as unpaused; HEAD is closed on the API.
    expect(go({ method: "GET" })).toBe(true);
    expect(preflight("GET")).toBe(true);
    expect(go({ method: "HEAD" })).toBe(false);
    // Every failure is the client's block: the site sees what the extension's would show it.
    expect(w.cdp.sent("Fetch.failRequest").every((command) => command.params.errorReason === "BlockedByClient")).toBe(true);
  });

  it("a pause from a previous operator instance fails whatever its body; other paths are not this path's, and their bodies are never kept", () => {
    const w = world();
    expect(w.pause({ postData: mark(1), replayed: true }).decision).toEqual({ action: "fail", reason: "BlockedByClient", why: "paused under a previous operator instance" });
    for (const url of [`${ACK}/all`, `${ACK}/`, "https://apiv3.fansly.com/API/v1/message/ack", "https://apiv3.fansly.com/api/v1/message/typing?ngsw-bypass=true", "https://apiv3.fansly.com.pb-hold.invalid/api/v1/message/ack", "https://apiv3.fansly.com/api/v1/login"]) {
      const other = w.pause({ url, postData: mark(1) });
      expect(other.decision, url).toEqual({ action: "fail", reason: "Aborted", why: "not a checked path's" });
      expect(other.request.body, url).toBeUndefined();
      expect(describeChecked(other.request), url).toBeNull();
    }
    expect(decideChecked(w.decided[1]!.request, "automation")).toBeNull();
    const ours = w.pause({ postData: mark(1) });
    expect(describeChecked(ours.request)).toMatch(/opened by its body/);
    // The response stage is never asked for, nor decided here.
    expect(decideChecked({ ...ours.request, stage: "response" }, "automation")).toBeNull();
  });
});
