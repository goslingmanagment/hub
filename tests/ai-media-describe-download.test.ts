import { afterAll, describe, expect, it } from "vitest";

import {
  MEDIA_DOWNLOAD_MAX_BYTES,
  downloadMediaForDescribe,
  isAllowedMediaHost,
} from "../apps/runtime/src/services/egress/media-download.ts";
import { createRequestDispatcher } from "../packages/shared/src/http-client.ts";
import { createTestFanslySendGuards } from "./helpers/fansly-send-guard.ts";

// The fake fetches below never use the dispatcher; it stands for the page's
// egress, which a Fansly hop must have (never direct).
const pageDispatcher = createRequestDispatcher();
afterAll(async () => {
  await pageDispatcher.destroy();
});

/** The page's send guard on an in-memory journal (S = 0: these tests are not
 *  about pacing; tests/fansly-send-guard-senders.test.ts is). */
function pageGuard() {
  const { registry, store } = createTestFanslySendGuards();
  return { guard: registry.forPage(7, "media_download"), store, registry };
}

function fansly(input: { url: string; fetchImpl: typeof fetch; maxBytes?: number }) {
  const { guard, store } = pageGuard();
  return {
    store,
    result: downloadMediaForDescribe({ ...input, dispatcher: pageDispatcher, fanslySendGuard: guard }),
  };
}

function fakeFetch(responses: Array<(url: string) => Response>) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next(url);
  }) as typeof fetch;
  return { impl, seen };
}

describe("AI media download", () => {
  it("allows only the platforms' https media CDNs", () => {
    for (const ok of ["https://cdn3.fansly.com/a.jpeg", "https://cdn2.onlyfans.com/x.jpg", "https://cdn.fansapi.com/y"]) {
      expect(isAllowedMediaHost(new URL(ok)), ok).toBe(true);
    }
    for (const bad of [
      "http://cdn3.fansly.com/a.jpeg",
      "https://fansly.com/api/v1/account",
      "https://apiv3.fansly.com/x",
      "https://cdn3.fansly.com.evil.example/a",
      "https://user:pw@cdn3.fansly.com/a",
      "https://cdn3.fansly.com:8443/a",
      "https://dl.fansapi.com/paid",
    ]) {
      expect(isAllowedMediaHost(new URL(bad)), bad).toBe(false);
    }
  });

  it("downloads without credentials and returns the bytes", async () => {
    const { impl, seen } = fakeFetch([() => new Response(Buffer.from("jpeg-bytes"), { status: 200, headers: { "content-type": "image/jpeg" } })]);
    const download = fansly({ url: "https://cdn3.fansly.com/a.jpeg?Signature=s", fetchImpl: impl });
    expect(await download.result).toMatchObject({ ok: true, contentType: "image/jpeg" });
    // One hop, one capture of the page's guard, completed with its status.
    expect(download.store.journal.map((row) => [row.source, row.operation, row.outcome, row.httpStatus]))
      .toEqual([["media_download", "media_download", "response", 200]]);
    expect(seen[0]!.init).toMatchObject({ redirect: "manual", credentials: "omit" });
    expect(JSON.stringify(seen[0]!.init.headers)).not.toMatch(/authorization|cookie/i);
  });

  it("follows a redirect only onto the allowlist", async () => {
    const ok = fakeFetch([
      () => new Response(null, { status: 302, headers: { location: "https://cdn5.fansly.com/b.jpeg" } }),
      () => new Response(Buffer.from("x"), { status: 200 }),
    ]);
    const followed = fansly({ url: "https://cdn3.fansly.com/a", fetchImpl: ok.impl });
    await expect(followed.result).resolves.toMatchObject({ ok: true });
    expect(ok.seen.map((entry) => entry.url)).toEqual(["https://cdn3.fansly.com/a", "https://cdn5.fansly.com/b.jpeg"]);
    // Each hop is its own capture.
    expect(followed.store.journal.map((row) => [row.outcome, row.httpStatus])).toEqual([["response", 302], ["response", 200]]);

    const bad = fakeFetch([() => new Response(null, { status: 302, headers: { location: "https://attacker.example/x" } })]);
    const refused = fansly({ url: "https://cdn3.fansly.com/a", fetchImpl: bad.impl });
    await expect(refused.result).resolves.toEqual({ ok: false, reason: "redirect_not_allowed", httpStatus: 302 });
    expect(bad.seen).toHaveLength(1);
    expect(refused.store.journal).toHaveLength(1);
  });

  it("stops at 5 MB whether declared or streamed", async () => {
    const declared = fakeFetch([() => new Response("x", { status: 200, headers: { "content-length": String(MEDIA_DOWNLOAD_MAX_BYTES + 1) } })]);
    await expect(fansly({ url: "https://cdn3.fansly.com/a", fetchImpl: declared.impl }).result)
      .resolves.toMatchObject({ ok: false, reason: "too_large" });
    const streamed = fakeFetch([() => new Response(Buffer.alloc(2048), { status: 200 })]);
    const cancelled = fansly({ url: "https://cdn3.fansly.com/a", fetchImpl: streamed.impl, maxBytes: 1024 });
    await expect(cancelled.result).resolves.toMatchObject({ ok: false, reason: "too_large" });
    // Completed once the body was cancelled.
    expect(cancelled.store.journal.map((row) => [row.outcome, row.httpStatus])).toEqual([["response", 200]]);
  });

  it("reports a refused host without any request", async () => {
    const none = fakeFetch([]);
    const refused = fansly({ url: "https://example.com/a.jpg", fetchImpl: none.impl });
    await expect(refused.result).resolves.toEqual({ ok: false, reason: "host_not_allowed", httpStatus: null });
    expect(none.seen).toHaveLength(0);
    expect(refused.store.journal).toEqual([]);
  });

  it("maps an expired link to an http status failure", async () => {
    const expired = fakeFetch([() => new Response("denied", { status: 403 })]);
    await expect(fansly({ url: "https://cdn3.fansly.com/a", fetchImpl: expired.impl }).result)
      .resolves.toEqual({ ok: false, reason: "http_status", httpStatus: 403 });
  });
});

describe("AI media download under the page's send guard (plan §2.5)", () => {
  it("never sends a Fansly hop without a guard or without the page's egress", async () => {
    const none = fakeFetch([]);
    await expect(downloadMediaForDescribe({
      url: "https://cdn3.fansly.com/a", dispatcher: pageDispatcher, fanslySendGuard: null, fetchImpl: none.impl,
    })).resolves.toEqual({ ok: false, reason: "send_guard", httpStatus: null });
    const { guard, store } = pageGuard();
    await expect(downloadMediaForDescribe({
      url: "https://cdn3.fansly.com/a", dispatcher: null, fanslySendGuard: guard, fetchImpl: none.impl,
    })).resolves.toEqual({ ok: false, reason: "send_guard", httpStatus: null });
    expect(none.seen).toHaveLength(0);
    expect(store.journal).toEqual([]);
  });

  it("refuses a redirect onto Fansly when there is no guard, before the hop", async () => {
    const hop = fakeFetch([() => new Response(null, { status: 302, headers: { location: "https://cdn3.fansly.com/b" } })]);
    await expect(downloadMediaForDescribe({
      url: "https://cdn2.onlyfans.com/a", dispatcher: null, fanslySendGuard: null, fetchImpl: hop.impl,
    })).resolves.toEqual({ ok: false, reason: "send_guard", httpStatus: null });
    expect(hop.seen.map((entry) => entry.url)).toEqual(["https://cdn2.onlyfans.com/a"]);
  });

  it("downloads other CDNs without touching the guard", async () => {
    const other = fakeFetch([() => new Response(Buffer.from("x"), { status: 200 })]);
    const { guard, store } = pageGuard();
    await expect(downloadMediaForDescribe({
      url: "https://cdn2.onlyfans.com/a", dispatcher: null, fanslySendGuard: guard, fetchImpl: other.impl,
    })).resolves.toMatchObject({ ok: true });
    expect(store.journal).toEqual([]);
  });

  it("sends nothing while the page is closed (a holder past its lease)", async () => {
    const none = fakeFetch([]);
    const { guard, store } = pageGuard();
    store.seed(7, { lastCompletedAt: Date.now() - 60_000, nextU: 0 });
    Object.assign(store.rows.get(7)!, { holderToken: "33333333-3333-4333-8333-333333333333", leaseUntil: Date.now() - 1 });
    await expect(downloadMediaForDescribe({
      url: "https://cdn3.fansly.com/a", dispatcher: pageDispatcher, fanslySendGuard: guard, fetchImpl: none.impl,
    })).resolves.toEqual({ ok: false, reason: "send_guard", httpStatus: null });
    expect(none.seen).toHaveLength(0);
  });

  it("completes a hop that failed in transport", async () => {
    const broken = fakeFetch([() => {
      throw new TypeError("fetch failed");
    }]);
    const download = fansly({ url: "https://cdn3.fansly.com/a", fetchImpl: broken.impl });
    await expect(download.result).resolves.toEqual({ ok: false, reason: "transport", httpStatus: null });
    expect(download.store.journal.map((row) => [row.outcome, row.httpStatus])).toEqual([["transport_error", null]]);
  });
});
