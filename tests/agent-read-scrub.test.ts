import { describe, expect, it } from "vitest";

import {
  agentObservationPayloadAllowed,
  scrubObservationPayload,
} from "../apps/runtime/src/modules/agent-read/index.ts";

// Operation 9b's disclosure controls.

describe("agent read plane: the 9b payload allowlist is fail-closed", () => {
  it("refuses the kinds named as forbidden, and everything unknown", () => {
    // A denylist could not work here: the repository's own restricted set is
    // for tiering only, differs from the disclosure allowlist, and is
    // consulted only on the tiering path rather than on serving.
    for (const kind of [
      "ofapi_admin_accounts",
      "account_me",
      "account_lookup",
      "group_detail",
      "followers",
      "earnings_accounts",
      // WP-S1 widened this allowlist by eight kinds and deliberately left this
      // one out: `post_replies` bodies are ANOTHER ACCOUNT'S authored content
      // (fans' reply prose plus their profile sidecar). The projection is
      // served behind `read:messages` with an audit row; the raw journal body
      // is not, because the projection is what erasure can reach.
      "post_replies",
      // The payout pair, for the same "named refusal" reason.
      "payout_methods",
      "payout_requests",
      "some.kind.invented.next.year",
      "desktop.guard_audit",
    ]) {
      expect(agentObservationPayloadAllowed(kind), kind).toBe(false);
    }
  });

  it("refuses every error body, whatever the endpoint", () => {
    expect(agentObservationPayloadAllowed("dm_messages:failed")).toBe(false);
    expect(agentObservationPayloadAllowed("subscribers:failed")).toBe(false);
  });
});

describe("agent read plane: the signed-URL scrub", () => {
  it("removes a CloudFront-signed media address whole", () => {
    // Half a signed URL still leaks the policy document, and a stripped one is a
    // broken string pretending to be data. It goes entirely.
    const result = scrubObservationPayload({
      accountMedia: [{
        id: "m1",
        mimetype: "video/mp4",
        locations: [{
          locationId: "loc-1",
          location: "https://cdn.fansly.com/media/m1.mp4?Policy=abc&Signature=def&Key-Pair-Id=K1",
        }],
      }],
    });
    const media = result.payload?.accountMedia as Array<Record<string, unknown>>;
    const locations = media[0]?.locations as Array<Record<string, unknown>>;
    expect(locations[0]?.location).toBeNull();
    expect(locations[0]?.locationId).toBe("loc-1");
    expect(result.signedUrlsRemoved).toBe(1);
    expect(result.pathsRemoved).toContain("accountMedia[0].locations[0].location");
  });

  it("removes AWS SigV4 and SAS addresses too", () => {
    const result = scrubObservationPayload({
      a: "https://s3.example.com/x?X-Amz-Signature=aa&X-Amz-Credential=bb",
      b: "https://blob.example.com/x?sv=2020&sig=zz&se=2026",
    });
    expect(result.payload?.a).toBeNull();
    expect(result.payload?.b).toBeNull();
    expect(result.signedUrlsRemoved).toBe(2);
  });

  it("preserves ordinary non-secret text and unsigned links", () => {
    const result = scrubObservationPayload({
      messages: [{ id: "1", content: "did you get the custom? https://fansly.com/lora" }],
      total: 3,
      ok: true,
    });
    const messages = result.payload?.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.content).toBe("did you get the custom? https://fansly.com/lora");
    expect(result.payload?.total).toBe(3);
    expect(result.payload?.ok).toBe(true);
    expect(result.signedUrlsRemoved).toBe(0);
  });

  it("redacts secret-shaped keys by NAME, whatever the value looks like", () => {
    const result = scrubObservationPayload({
      authorization: "Bearer abc",
      checkoutKey: "ck_live_123",
      session: { token: "t" },
      username: "rick",
    });
    expect(result.payload?.authorization).toBeNull();
    expect(result.payload?.checkoutKey).toBeNull();
    expect(result.payload?.session).toBeNull();
    expect(result.payload?.username).toBe("rick");
    expect(result.secretsRedacted).toBe(3);
  });

  it("fails CLOSED on structure it does not understand", () => {
    // "Unknown shape, must be fine" is how a scrubber quietly stops scrubbing
    // when a vendor adds a field.
    let deep: Record<string, unknown> = { leaf: "https://cdn.example.com/x?Signature=1" };
    for (let depth = 0; depth < 40; depth += 1) {
      deep = { nested: deep };
    }
    const result = scrubObservationPayload(deep);
    expect(result.pathsRemoved.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.payload)).not.toContain("Signature");
  });

  it("removes a signed address EMBEDDED in a longer string", () => {
    // The previous revision only matched a value that WAS a url, and the test
    // suite PINNED that miss as if it were the design. A signed address inside a
    // caption or an HTML fragment is still a signed address; the old pin WAS the
    // bug, and this assertion replaces it.
    const result = scrubObservationPayload({
      caption: 'watch it here: https://cdn.fansly.com/m.mp4?Policy=a&Signature=b thanks!',
      html: '<img src="https://cdn.fansly.com/t.jpg?Key-Pair-Id=K1&Signature=z">',
    });
    expect(result.payload?.caption).toBeNull();
    expect(result.payload?.html).toBeNull();
    expect(result.signedUrlsRemoved).toBe(2);
  });

  it("a malformed percent escape is suspicious, not a crash", () => {
    // `decodeURIComponent("%ZZ")` throws, and a scrubber that throws on hostile
    // input is not fail-closed, it is fail-crashed.
    expect(() => scrubObservationPayload({
      url: "https://cdn.example.com/x?%ZZ=1&Signature=abc",
    })).not.toThrow();
    expect(scrubObservationPayload({
      url: "https://cdn.example.com/x?%ZZ=1&Signature=abc",
    }).payload?.url).toBeNull();
  });

  it("a non-object payload is WITHHELD, never served as an empty object", () => {
    // `{}` with no reason is a hole pretending to be an empty payload; the caller
    // turns `null` into an explicit `withheldReason`.
    expect(scrubObservationPayload("https://cdn.example.com/x?Signature=1").payload).toBeNull();
    expect(scrubObservationPayload([{ a: 1 }]).payload).toBeNull();
    expect(scrubObservationPayload(null).payload).toBeNull();
  });
});
