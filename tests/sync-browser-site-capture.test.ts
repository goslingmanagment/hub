import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { siteResponseObservation, type SiteResponseEvent } from "../apps/runtime/src/sync/fansly/browser-site-capture.ts";

// The site's answers from an operator's buffer into `observations` (Project
// Browser stage 3 PR 13), against the PB audit of 2026-10-22, P2-3: a secret
// read's answer is never written, whatever operator sent it (one from before
// the map's secret reads keeps them as `site.other`), and a body kept as the
// site's loses the CDN's signing tokens as Hub's own reads do. The journal
// itself: tests/sync-browser-intake.integration.test.ts.

function event(path: string, overrides: Partial<SiteResponseEvent> = {}): SiteResponseEvent {
  return {
    seq: 7,
    atMono: 1,
    atWall: 1,
    kind: "site.response",
    siteRequestId: "r1",
    attemptId: 0,
    route: "site.other",
    method: "GET",
    path,
    query: "",
    status: 200,
    headers: { "content-type": "application/json" },
    body: { bodyId: "b1", decodedBytes: 1, sha256: "f".repeat(64) },
    complete: true,
    source: "network",
    sessionFingerprint: "s".repeat(64),
    ...overrides,
  };
}

const observe = (e: SiteResponseEvent, body: unknown) =>
  siteResponseObservation({ pageId: 1, bufferId: "buf", event: e, body: body === null ? null : Buffer.from(JSON.stringify(body)) });

describe("the site's answers into observations", () => {
  it("never writes a secret read's answer — whole, not whole, in any spelling — nor a mark of its hole", () => {
    const tokens = { success: true, response: [{ token: "t".repeat(71), sessionId: "1" }] };
    for (const path of ["/api/v1/management/managementsessions", "/api/v1/sessions", "/api/v1/idv/accountsessions", "/api/v1/login/password/status", "/api/v1/streaming/channel", "/api/v1/Management//ManagementSessions/"]) {
      expect(observe(event(path), tokens), path).toBeNull();
      expect(observe(event(path, { complete: false }), null), path).toBeNull();
      expect(observe(event(path, { source: "service_worker" }), tokens), path).toBeNull();
    }
    // Next to them, a read outside the catalogue is kept as before.
    expect(observe(event("/api/v1/mediastories/following"), { success: true, response: [] })).toMatchObject({ kind: "fansly.site.site.other", as: "site" });
    expect(observe(event("/api/v1/sessionsx", { complete: false }), null)).toMatchObject({ kind: "fansly.site.site.other:incomplete", as: "incomplete" });
  });

  it("strips the CDN's signing tokens from a body kept as the site's, as the codec does for Hub's own reads", () => {
    const signed = "https://cdn3.fansly.com/1/2.jpeg?ngsw-bypass=true&Policy=eyJ&Key-Pair-Id=K123&Signature=abc~";
    const body = {
      success: true,
      response: {
        accountMedia: [{ id: "9", media: { locations: [{ locationId: "1", location: signed, metadata: { "Key-Pair-Id": "K123", Signature: "abc~", Policy: "eyJ", width: "10" } }] } }],
        about: `see ${signed}`,
      },
    };
    const observation = observe(event("/api/v1/timeline/home", { query: "?before=0" }), body)!;
    expect(observation).toMatchObject({ kind: "fansly.site.site.other", as: "site" });
    const payload = observation.payload as { path: string; query: string; status: number; body: typeof body };
    expect(payload).toMatchObject({ path: "/api/v1/timeline/home", query: "?before=0", status: 200 });
    const location = payload.body.response.accountMedia[0]!.media.locations[0]!;
    expect(location.location).toBe("https://cdn3.fansly.com/1/2.jpeg?ngsw-bypass=true");
    expect(location.metadata).toEqual({ width: "10" });
    // Prose keeps every byte, as in the codec: only `locations[]` is rewritten.
    expect(payload.body.response.about).toBe(`see ${signed}`);
    expect(observation.payloadHash).toEqual(createHash("sha256").update(JSON.stringify(observation.payload)).digest());
  });
});
