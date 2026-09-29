import { describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";

// Owner decision 2026-09-29: one-off CloudFront signing tokens are stripped
// from Fansly pull bodies BEFORE they are journaled, for an explicit allowlist
// of kinds, and never for the kinds the AI media describer reads signed URLs
// from. The tokens (Policy, Signature, Key-Pair-Id, Expires) change on nearly
// every read, so a verbatim body made every hourly re-read of an unchanged
// page a new content-addressed object.
//
// The URLs below are SYNTHETIC: the shapes are the three forms seen on
// production, the token values are invented.

const captured = vi.hoisted(() => ({
  raws: [] as Array<{ endpoint: string; responsePayload: unknown; mapperVersion: string }>,
  observations: [] as Array<{ kind: string; payload: unknown; payloadHash: Buffer }>,
}));

vi.mock("@agency_hub_core/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    insertRawPayload: vi.fn(async (
      _db: unknown,
      input: { endpoint: string; responsePayload: unknown; mapperVersion: string },
    ) => {
      captured.raws.push(input);
      return { id: 1, capturedAt: new Date(0), payloadRefVanished: false };
    }),
    insertObservation: vi.fn(async (
      _db: unknown,
      input: { kind: string; payload: unknown; payloadHash: Buffer },
    ) => {
      captured.observations.push(input);
      return { inserted: true, observationId: 1, payloadRefVanished: false };
    }),
    recordSyncHttpAttemptResponseBodyBytes: vi.fn(async () => true),
  };
});

const {
  FANSLY_CDN_TOKENS_NEVER_STRIPPED_KINDS,
  FANSLY_CDN_TOKENS_STRIPPED_KINDS,
  FANSLY_CDN_TOKENS_STRIPPED_MAPPER_SUFFIX,
  stripFanslySignedCdnTokens,
} = await import("../apps/runtime/src/services/sync/fansly-cdn-tokens.ts");
const { persistRawPayload, retentionDate } = await import("../apps/runtime/src/services/sync/shared.ts");
const { scrubObservationPayload } = await import("../apps/runtime/src/modules/agent-read/observation-scrub.ts");

const POLICY_URL = "https://cdn3.fansly.com/700000000000000001/800000000000000001.jpeg"
  + "?ngsw-bypass=true&Policy=eyJTdGF0ZW1lbnQiOltdfQ__&Key-Pair-Id=KTESTPAIR01&Signature=abc~DEF_ghi-1";
const CANNED_URL = "https://cdn3.fansly.com/700000000000000001/800000000000000002.mp4"
  + "?ngsw-bypass=true&Expires=1790000000&Key-Pair-Id=KTESTPAIR01&Signature=xyz~UVW_rst-2";
const STREAM_URL = "https://cdn3.fansly.com/new/700000000000000001/800000000000000003/800000000000000003.m3u8";

function body(tag: string, expires: number) {
  return {
    success: true,
    response: {
      data: [{ id: "900000000000000001", amount: 5000, accountMediaId: "800000000000000001" }],
      aggregationData: {
        accountMedia: [{
          id: "800000000000000001",
          media: {
            id: "800000000000000001",
            mimetype: "image/jpeg",
            locations: [{ locationId: "1", location: POLICY_URL.replace("abc", `abc${tag}`) }],
            variants: [{
              id: "800000000000000002",
              locations: [
                { locationId: "1", location: CANNED_URL.replace("1790000000", String(expires)) },
                {
                  location: STREAM_URL,
                  metadata: { Policy: `policy-${tag}`, Signature: `sig-${tag}`, "Key-Pair-Id": "KTESTPAIR01" },
                  locationId: "102",
                },
              ],
            }],
          },
        }],
      },
    },
  };
}

const STRIPPED_POLICY_URL = "https://cdn3.fansly.com/700000000000000001/800000000000000001.jpeg?ngsw-bypass=true";
const STRIPPED_CANNED_URL = "https://cdn3.fansly.com/700000000000000001/800000000000000002.mp4?ngsw-bypass=true";

/** A `locations[]` entry as Fansly serves it: on production (2026-07..09) the
 *  ONE place a signed URL string occurs. */
function located(location: string) {
  return { locations: [{ locationId: "1", location }] };
}

function locationOf(value: unknown): unknown {
  return (value as { locations: Array<{ location: unknown }> }).locations[0]!.location;
}

describe("stripFanslySignedCdnTokens", () => {
  it("removes the signing params from both URL forms and keeps the rest byte-stable", () => {
    expect(locationOf(stripFanslySignedCdnTokens(located(POLICY_URL)))).toBe(STRIPPED_POLICY_URL);
    expect(locationOf(stripFanslySignedCdnTokens(located(CANNED_URL)))).toBe(STRIPPED_CANNED_URL);
    // Unrelated params keep their order and spelling; a fragment survives; a
    // query left empty loses its `?`.
    expect(locationOf(stripFanslySignedCdnTokens(located(
      "https://cdn3.fansly.com/a/b.jpeg?width=480&Policy=p&Signature=s&Key-Pair-Id=k&v=2%203#frag",
    )))).toBe("https://cdn3.fansly.com/a/b.jpeg?width=480&v=2%203#frag");
    expect(locationOf(stripFanslySignedCdnTokens(located(
      "https://cdn3.fansly.com/a/b.jpeg?Expires=1&Signature=s&Key-Pair-Id=k",
    )))).toBe("https://cdn3.fansly.com/a/b.jpeg");
  });

  it("removes the metadata form's keys and keeps the object and its other keys", () => {
    const location = {
      location: STREAM_URL,
      metadata: { Policy: "p", Signature: "s", "Key-Pair-Id": "k" },
      locationId: "102",
    };
    expect(stripFanslySignedCdnTokens({ locations: [location] }))
      .toEqual({ locations: [{ location: STREAM_URL, metadata: {}, locationId: "102" }] });
    expect(JSON.stringify(stripFanslySignedCdnTokens({ locations: [location] })))
      .toBe(`{"locations":[{"location":"${STREAM_URL}","metadata":{},"locationId":"102"}]}`);
  });

  it("makes two reads that differ only in tokens identical, and is idempotent", () => {
    const first = stripFanslySignedCdnTokens(body("A", 1790000000));
    const second = stripFanslySignedCdnTokens(body("B", 1790000060));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).not.toMatch(/Policy|Signature|Key-Pair-Id|Expires/);
    expect(JSON.stringify(stripFanslySignedCdnTokens(first))).toBe(JSON.stringify(first));
    // Ids, amounts and the paths themselves are untouched.
    expect(first.response.data).toEqual(body("A", 1).response.data);
    expect(JSON.stringify(first)).toContain(STRIPPED_POLICY_URL);
    expect(JSON.stringify(first)).toContain(STRIPPED_CANNED_URL);
    expect(JSON.stringify(first)).toContain(`"location":"${STREAM_URL}"`);
  });

  it("never mutates its input", () => {
    const input = body("A", 1790000000);
    const snapshot = JSON.stringify(input);
    const output = stripFanslySignedCdnTokens(input);
    expect(output).not.toBe(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("leaves everything that is not a CloudFront signature alone, by reference", () => {
    const untouched = [
      // Expires alone is not a signature.
      "https://example.com/report?Expires=1790000000&page=2",
      // Only a WHOLE string that is a URL is rewritten, never prose around one.
      `see ${POLICY_URL}`,
      "Signature=abc&Key-Pair-Id=k",
      { Policy: "house rules", Expires: "never" },
      { Signature: 12, note: "not a signing triple" },
      { list: [1, "two", null, true], nested: { url: "https://cdn3.fansly.com/a.jpeg?ngsw-bypass=true" } },
    ];
    for (const value of untouched) {
      expect(stripFanslySignedCdnTokens(value)).toBe(value);
    }
    expect(stripFanslySignedCdnTokens(null)).toBeNull();
    expect(stripFanslySignedCdnTokens(undefined)).toBeUndefined();
    expect(stripFanslySignedCdnTokens(42)).toBe(42);
  });

  it("leaves the agent-read scrub withholding the stripped URLs, with no tokens left to redact", () => {
    const before = scrubObservationPayload(body("A", 1790000000));
    const after = scrubObservationPayload(stripFanslySignedCdnTokens(body("A", 1790000000)));
    // `ngsw-bypass` survives the strip and is one of the scrub's signed-URL
    // markers, so the same two URLs are still withheld whole.
    expect(after.signedUrlsRemoved).toBe(before.signedUrlsRemoved);
    expect(after.signedUrlsRemoved).toBe(2);
    // The metadata form's `Signature` was the one secret-named key; it is gone.
    expect(before.secretsRedacted).toBe(1);
    expect(after.secretsRedacted).toBe(0);
    expect(JSON.stringify(after.payload)).not.toMatch(/Policy|Signature|Key-Pair-Id|Expires/);
    expect(JSON.stringify(after.payload)).toContain(`"location":"${STREAM_URL}"`);
  });

  it("keeps a served `__proto__` key as data", () => {
    const parsed = JSON.parse(`{"__proto__":${JSON.stringify(located(POLICY_URL))},"id":"1"}`) as unknown;
    const stripped = stripFanslySignedCdnTokens(parsed);
    expect(JSON.stringify(stripped)).toBe(`{"__proto__":${JSON.stringify(located(STRIPPED_POLICY_URL))},"id":"1"}`);
    expect(Object.getPrototypeOf(stripped)).toBe(Object.prototype);
  });
});

/** A `post_replies` observation envelope with one comment, as the lane journals it. */
function replies(content: string) {
  return {
    walk: { postId: "930000000000000001", before: null },
    response: {
      posts: [{ id: "940000000000000001", accountId: "700000000000000002", content, inReplyTo: "930000000000000001",
        createdAt: 1790000000, attachments: [] }],
      accountMedia: [],
      accounts: [],
    },
  };
}

// External review (PR #319): the walk used to rewrite ANY string that began
// with a URL, so a comment that opens with a signed link lost the rest of its
// text to the "Signature" value — in both journal copies, beyond replay.
describe("only a lone signed Fansly CDN URL at locations[].location is rewritten", () => {
  it("keeps every byte of a comment that starts with a signed URL", () => {
    const blue = "https://cdn3.fansly.com/x?Signature=s\nPlease make it blue";
    const red = "https://cdn3.fansly.com/x?Signature=s\nPlease make it red";
    for (const value of [replies(blue), located(blue), { content: `${POLICY_URL} please make it blue` }]) {
      const snapshot = JSON.stringify(value);
      expect(stripFanslySignedCdnTokens(value)).toBe(value);
      expect(JSON.stringify(stripFanslySignedCdnTokens(value))).toBe(snapshot);
    }
    expect(JSON.stringify(stripFanslySignedCdnTokens(replies(blue))))
      .not.toBe(JSON.stringify(stripFanslySignedCdnTokens(replies(red))));
  });

  it("strips a lone signed CDN URL in a locations[].location field", () => {
    expect(locationOf(stripFanslySignedCdnTokens(located(POLICY_URL)))).toBe(STRIPPED_POLICY_URL);
    expect(locationOf(stripFanslySignedCdnTokens(located(CANNED_URL)))).toBe(STRIPPED_CANNED_URL);
    expect(locationOf(stripFanslySignedCdnTokens(located(POLICY_URL.replace("cdn3.", "cdn.")))))
      .toBe(STRIPPED_POLICY_URL.replace("cdn3.", "cdn."));
  });

  it("leaves a signed URL on any host but a Fansly CDN host untouched", () => {
    const query = "?Policy=p&Key-Pair-Id=k&Signature=s";
    for (const url of [
      `https://example.com/a.jpeg${query}`,
      `https://d1234567890.cloudfront.net/a.jpeg${query}`,
      `https://fansly.com/a.jpeg${query}`,
      `https://apiv3.fansly.com/a.jpeg${query}`,
      `https://cdn3.fansly.com.example.com/a.jpeg${query}`,
      `https://cdn3.fansly.com@example.com/a.jpeg${query}`,
      `https://cdn3.fansly.com:8443/a.jpeg${query}`,
      `http://cdn3.fansly.com/a.jpeg${query}`,
    ]) {
      const value = located(url);
      expect(stripFanslySignedCdnTokens(value), url).toBe(value);
    }
  });

  it("leaves a lone signed CDN URL in a user-authored field untouched", () => {
    // The prose-bearing string keys of the stripped kinds on production, the
    // account profile's own `location` among them.
    const authored = [
      "content", "message", "about", "note", "title", "description", "name", "displayName", "label",
      "subscriptionBenefits", "subscriptionTierName", "badgeDescription", "filename", "customFilename", "location",
    ];
    for (const key of authored) {
      const value = { [key]: POLICY_URL };
      expect(stripFanslySignedCdnTokens(value), key).toBe(value);
    }
    // The shapes that surround those fields: a profile, a comment, an embedded
    // media record's unsigned `location` path.
    const account = { accounts: [{ id: "1", location: CANNED_URL, about: POLICY_URL, avatar: { location: POLICY_URL } }] };
    expect(stripFanslySignedCdnTokens(account)).toBe(account);
    const comment = replies(POLICY_URL);
    expect(stripFanslySignedCdnTokens(comment)).toBe(comment);
    const media = { accountMedia: [{ media: { location: POLICY_URL, variants: [{ location: CANNED_URL }] } }] };
    expect(stripFanslySignedCdnTokens(media)).toBe(media);
  });

  it("strips the signing metadata only in its locations[].metadata place", () => {
    const signing = { Policy: "p", Signature: "s", "Key-Pair-Id": "k" };
    const elsewhere = [
      { metadata: signing },
      { Signature: "s", "Key-Pair-Id": "k", note: "a user's own words" },
      { locations: { metadata: signing } },
    ];
    for (const value of elsewhere) {
      expect(stripFanslySignedCdnTokens(value)).toBe(value);
    }
    expect(stripFanslySignedCdnTokens({ locations: [{ location: STREAM_URL, metadata: signing, locationId: "102" }] }))
      .toEqual({ locations: [{ location: STREAM_URL, metadata: {}, locationId: "102" }] });
  });
});

describe("the strip allowlist", () => {
  it("never names a kind the AI media describer reads signed URLs from", () => {
    const stripped = new Set<string>(FANSLY_CDN_TOKENS_STRIPPED_KINDS);
    for (const kind of FANSLY_CDN_TOKENS_NEVER_STRIPPED_KINDS) {
      expect(stripped.has(kind), kind).toBe(false);
    }
    expect(FANSLY_CDN_TOKENS_NEVER_STRIPPED_KINDS).toEqual(expect.arrayContaining([
      "dm_messages",
      "purchase_history",
      "purchase_history_contract_probe",
      "purchase_history_contract_storm",
    ]));
  });

  it("covers the high-volume kinds that carry signed URLs on production", () => {
    expect(FANSLY_CDN_TOKENS_STRIPPED_KINDS).toEqual(expect.arrayContaining([
      "earnings_transactions",
      "notifications",
      "posts",
      "account_lookup",
      "account_me",
      "vault_media",
    ]));
  });
});

function row(endpoint: string, responsePayload: unknown) {
  return {
    platformAccountId: 7,
    endpoint,
    requestParams: {},
    responsePayload,
    mapperVersion: "fansly-phase1-v5",
    payloadKind: "mapping_critical" as const,
    retainUntil: retentionDate(),
  };
}

function reset() {
  captured.raws.length = 0;
  captured.observations.length = 0;
}

describe("persistRawPayload applies the strip", () => {
  it("journals a stripped earnings_transactions body in both envelopes and stamps the mapper version", async () => {
    reset();
    const input = body("A", 1790000000);
    const snapshot = JSON.stringify(input);
    await persistRawPayload({} as never, row("earnings_transactions", input), { platform: "fansly" });

    const [raw] = captured.raws;
    const [observation] = captured.observations;
    expect(raw!.mapperVersion).toBe(`fansly-phase1-v5${FANSLY_CDN_TOKENS_STRIPPED_MAPPER_SUFFIX}`);
    expect(FANSLY_CDN_TOKENS_STRIPPED_MAPPER_SUFFIX).toBe("+cdn-tokens-stripped-v1");
    expect(JSON.stringify(raw!.responsePayload)).toBe(JSON.stringify(stripFanslySignedCdnTokens(input)));
    // One object for both envelopes, so the catalog still does a single put.
    expect(observation!.payload).toBe(raw!.responsePayload);
    // The lane keeps parsing its in-memory response after the persist.
    expect(JSON.stringify(input)).toBe(snapshot);

    reset();
    await persistRawPayload({} as never, row("earnings_transactions", body("B", 1790000060)), { platform: "fansly" });
    expect(captured.observations[0]!.payloadHash.equals(observation!.payloadHash)).toBe(true);
  });

  it("strips a separate observation envelope as well", async () => {
    reset();
    const response = body("A", 1790000000);
    await persistRawPayload({} as never, row("post_replies", response), {
      platform: "fansly",
      observationPayload: { walk: { postId: "1" }, response },
    });
    expect(JSON.stringify(captured.raws[0]!.responsePayload)).not.toMatch(/Signature|Key-Pair-Id/);
    expect(JSON.stringify(captured.observations[0]!.payload)).not.toMatch(/Signature|Key-Pair-Id/);
    expect(captured.observations[0]!.payload).toMatchObject({ walk: { postId: "1" } });
  });

  it("journals a post_replies comment that starts with a signed URL byte for byte", async () => {
    const hashes: Buffer[] = [];
    for (const colour of ["blue", "red"]) {
      reset();
      const envelope = replies(`https://cdn3.fansly.com/x?Signature=s\nPlease make it ${colour}`);
      await persistRawPayload({} as never, row("post_replies", envelope.response), {
        platform: "fansly",
        observationPayload: envelope,
      });
      expect(captured.raws[0]!.responsePayload).toBe(envelope.response);
      expect(captured.observations[0]!.payload).toBe(envelope);
      expect(JSON.stringify(captured.observations[0]!.payload)).toContain(`Please make it ${colour}`);
      hashes.push(captured.observations[0]!.payloadHash);
    }
    expect(hashes[0]!.equals(hashes[1]!)).toBe(false);
  });

  it("leaves dm_messages, purchase_history, unlisted kinds and OnlyFans verbatim", async () => {
    const cases: Array<[string, { platform?: "fansly" | "onlyfans" }]> = [
      ["dm_messages", { platform: "fansly" }],
      ["purchase_history", { platform: "fansly" }],
      ["purchase_history_contract_probe", { platform: "fansly" }],
      ["group_detail", { platform: "fansly" }],
      ["some_future_kind", { platform: "fansly" }],
      ["posts", { platform: "onlyfans" }],
      // No platform named: fail closed.
      ["earnings_transactions", {}],
    ];
    for (const [endpoint, options] of cases) {
      reset();
      const input = body("A", 1790000000);
      await persistRawPayload({} as never, row(endpoint, input), options);
      expect(captured.raws[0]!.responsePayload, endpoint).toBe(input);
      expect(captured.raws[0]!.mapperVersion, endpoint).toBe("fansly-phase1-v5");
      expect(captured.observations[0]!.payload, endpoint).toBe(input);
      expect(JSON.stringify(captured.raws[0]!.responsePayload), endpoint).toContain("Signature=abcA");
    }
  });
});
