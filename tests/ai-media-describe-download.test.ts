import { describe, expect, it } from "vitest";

import {
  MEDIA_DOWNLOAD_MAX_BYTES,
  downloadMediaForDescribe,
  isAllowedMediaHost,
} from "../apps/runtime/src/services/egress/media-download.ts";

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
    const result = await downloadMediaForDescribe({ url: "https://cdn3.fansly.com/a.jpeg?Signature=s", dispatcher: null, fetchImpl: impl });
    expect(result).toMatchObject({ ok: true, contentType: "image/jpeg" });
    expect(seen[0]!.init).toMatchObject({ redirect: "manual", credentials: "omit" });
    expect(JSON.stringify(seen[0]!.init.headers)).not.toMatch(/authorization|cookie/i);
  });

  it("follows a redirect only onto the allowlist", async () => {
    const ok = fakeFetch([
      () => new Response(null, { status: 302, headers: { location: "https://cdn5.fansly.com/b.jpeg" } }),
      () => new Response(Buffer.from("x"), { status: 200 }),
    ]);
    await expect(downloadMediaForDescribe({ url: "https://cdn3.fansly.com/a", dispatcher: null, fetchImpl: ok.impl })).resolves.toMatchObject({ ok: true });
    expect(ok.seen.map((entry) => entry.url)).toEqual(["https://cdn3.fansly.com/a", "https://cdn5.fansly.com/b.jpeg"]);

    const bad = fakeFetch([() => new Response(null, { status: 302, headers: { location: "https://attacker.example/x" } })]);
    await expect(downloadMediaForDescribe({ url: "https://cdn3.fansly.com/a", dispatcher: null, fetchImpl: bad.impl }))
      .resolves.toEqual({ ok: false, reason: "redirect_not_allowed", httpStatus: 302 });
    expect(bad.seen).toHaveLength(1);
  });

  it("stops at 5 MB whether declared or streamed", async () => {
    const declared = fakeFetch([() => new Response("x", { status: 200, headers: { "content-length": String(MEDIA_DOWNLOAD_MAX_BYTES + 1) } })]);
    await expect(downloadMediaForDescribe({ url: "https://cdn3.fansly.com/a", dispatcher: null, fetchImpl: declared.impl }))
      .resolves.toMatchObject({ ok: false, reason: "too_large" });
    const streamed = fakeFetch([() => new Response(Buffer.alloc(2048), { status: 200 })]);
    await expect(downloadMediaForDescribe({ url: "https://cdn3.fansly.com/a", dispatcher: null, fetchImpl: streamed.impl, maxBytes: 1024 }))
      .resolves.toMatchObject({ ok: false, reason: "too_large" });
  });

  it("reports a refused host without any request", async () => {
    const none = fakeFetch([]);
    await expect(downloadMediaForDescribe({ url: "https://example.com/a.jpg", dispatcher: null, fetchImpl: none.impl }))
      .resolves.toEqual({ ok: false, reason: "host_not_allowed", httpStatus: null });
    expect(none.seen).toHaveLength(0);
  });

  it("maps an expired link to an http status failure", async () => {
    const expired = fakeFetch([() => new Response("denied", { status: 403 })]);
    await expect(downloadMediaForDescribe({ url: "https://cdn3.fansly.com/a", dispatcher: null, fetchImpl: expired.impl }))
      .resolves.toEqual({ ok: false, reason: "http_status", httpStatus: 403 });
  });
});
