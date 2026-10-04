import { afterAll, describe, expect, it } from "vitest";

import {
  MEDIA_DOWNLOAD_MAX_BYTES,
  downloadMediaForDescribe,
  isAllowedMediaHost,
  isFanslyCdnUrl,
} from "../apps/runtime/src/services/egress/media-download.ts";
import { createRequestDispatcher } from "../packages/shared/src/http-client.ts";

// The fake fetches below never use the dispatcher; it stands for the page's
// egress.
const pageDispatcher = createRequestDispatcher();
afterAll(async () => {
  await pageDispatcher.destroy();
});

/** A download through a page's egress, as the describer makes it. */
function download(input: { url: string; fetchImpl: typeof fetch; maxBytes?: number }) {
  return downloadMediaForDescribe({ ...input, dispatcher: pageDispatcher });
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
    const result = await download({ url: "https://cdn2.onlyfans.com/a.jpeg?Signature=s", fetchImpl: impl });
    expect(result).toMatchObject({ ok: true, contentType: "image/jpeg" });
    expect(result.ok && result.bytes.toString()).toBe("jpeg-bytes");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init).toMatchObject({ redirect: "manual", credentials: "omit" });
    expect(JSON.stringify(seen[0]!.init.headers)).not.toMatch(/authorization|cookie/i);
  });

  it("downloads the same way without a page egress (the OFAPI cache CDN)", async () => {
    const { impl, seen } = fakeFetch([() => new Response(Buffer.from("x"), { status: 200 })]);
    await expect(downloadMediaForDescribe({ url: "https://cdn.fansapi.com/y", dispatcher: null, fetchImpl: impl }))
      .resolves.toMatchObject({ ok: true });
    expect(seen.map((entry) => entry.url)).toEqual(["https://cdn.fansapi.com/y"]);
  });

  it("follows a redirect only onto the allowlist", async () => {
    const ok = fakeFetch([
      () => new Response(null, { status: 302, headers: { location: "https://cdn5.onlyfans.com/b.jpeg" } }),
      () => new Response(Buffer.from("x"), { status: 200 }),
    ]);
    await expect(download({ url: "https://cdn2.onlyfans.com/a", fetchImpl: ok.impl })).resolves.toMatchObject({ ok: true });
    expect(ok.seen.map((entry) => entry.url)).toEqual(["https://cdn2.onlyfans.com/a", "https://cdn5.onlyfans.com/b.jpeg"]);

    const bad = fakeFetch([() => new Response(null, { status: 302, headers: { location: "https://attacker.example/x" } })]);
    await expect(download({ url: "https://cdn2.onlyfans.com/a", fetchImpl: bad.impl }))
      .resolves.toEqual({ ok: false, reason: "redirect_not_allowed", httpStatus: 302 });
    expect(bad.seen).toHaveLength(1);
  });

  it("follows two redirects at most", async () => {
    const hop = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });
    const loop = fakeFetch([hop("https://cdn2.onlyfans.com/b"), hop("https://cdn2.onlyfans.com/c"), hop("https://cdn2.onlyfans.com/d")]);
    await expect(download({ url: "https://cdn2.onlyfans.com/a", fetchImpl: loop.impl }))
      .resolves.toEqual({ ok: false, reason: "too_many_redirects", httpStatus: 302 });
    expect(loop.seen).toHaveLength(3);
  });

  it("stops at 5 MB whether declared or streamed", async () => {
    const declared = fakeFetch([() => new Response("x", { status: 200, headers: { "content-length": String(MEDIA_DOWNLOAD_MAX_BYTES + 1) } })]);
    await expect(download({ url: "https://cdn2.onlyfans.com/a", fetchImpl: declared.impl }))
      .resolves.toMatchObject({ ok: false, reason: "too_large" });
    const streamed = fakeFetch([() => new Response(Buffer.alloc(2048), { status: 200 })]);
    await expect(download({ url: "https://cdn2.onlyfans.com/a", fetchImpl: streamed.impl, maxBytes: 1024 }))
      .resolves.toMatchObject({ ok: false, reason: "too_large" });
  });

  it("reports a refused host without any request", async () => {
    const none = fakeFetch([]);
    await expect(download({ url: "https://example.com/a.jpg", fetchImpl: none.impl }))
      .resolves.toEqual({ ok: false, reason: "host_not_allowed", httpStatus: null });
    await expect(download({ url: "not a url", fetchImpl: none.impl }))
      .resolves.toEqual({ ok: false, reason: "host_not_allowed", httpStatus: null });
    expect(none.seen).toHaveLength(0);
  });

  it("maps an expired link to an http status failure", async () => {
    const expired = fakeFetch([() => new Response("denied", { status: 403 })]);
    await expect(download({ url: "https://cdn2.onlyfans.com/a", fetchImpl: expired.impl }))
      .resolves.toEqual({ ok: false, reason: "http_status", httpStatus: 403 });
  });

  it("tells a timeout from a transport failure", async () => {
    const broken = fakeFetch([() => {
      throw new TypeError("fetch failed");
    }]);
    await expect(download({ url: "https://cdn2.onlyfans.com/a", fetchImpl: broken.impl }))
      .resolves.toEqual({ ok: false, reason: "transport", httpStatus: null });
    const slow = fakeFetch([() => {
      throw new DOMException("The operation timed out", "TimeoutError");
    }]);
    await expect(download({ url: "https://cdn2.onlyfans.com/a", fetchImpl: slow.impl }))
      .resolves.toEqual({ ok: false, reason: "timeout", httpStatus: null });
  });
});

// Plan §2.4: a Fansly CDN hop is a request of its page, and a page has one
// sender — its actor (`media-download.fetch`). Since step 4 (S4-20) nothing
// else can send one: the legacy send guard this download once captured is not
// asked any more, and the host is refused before anything is sent.
describe("AI media download never sends a Fansly request", () => {
  it.each([
    ["through a page's egress", pageDispatcher],
    ["without an egress", null],
  ])("refuses a Fansly CDN URL %s, before any request", async (_label, dispatcher) => {
    const none = fakeFetch([]);
    await expect(downloadMediaForDescribe({ url: "https://cdn3.fansly.com/a.jpeg?Signature=s", dispatcher, fetchImpl: none.impl }))
      .resolves.toEqual({ ok: false, reason: "send_guard", httpStatus: null });
    expect(none.seen).toHaveLength(0);
  });

  it.each([
    ["through a page's egress", pageDispatcher],
    ["without an egress", null],
  ])("refuses a redirect onto a Fansly CDN %s, before the hop", async (_label, dispatcher) => {
    const hop = fakeFetch([() => new Response(null, { status: 302, headers: { location: "https://cdn3.fansly.com/b" } })]);
    await expect(downloadMediaForDescribe({ url: "https://cdn2.onlyfans.com/a", dispatcher, fetchImpl: hop.impl }))
      .resolves.toEqual({ ok: false, reason: "send_guard", httpStatus: null });
    expect(hop.seen.map((entry) => entry.url)).toEqual(["https://cdn2.onlyfans.com/a"]);
  });

  it("keeps the Fansly CDN on the allowlist for the engine's own download", () => {
    // `media-download.fetch` admits its hops by this predicate.
    expect(isFanslyCdnUrl(new URL("https://cdn3.fansly.com/a.jpeg"))).toBe(true);
    expect(isFanslyCdnUrl(new URL("https://cdn2.onlyfans.com/a.jpeg"))).toBe(false);
    expect(isFanslyCdnUrl(new URL("https://fansly.com/a.jpeg"))).toBe(false);
  });
});
