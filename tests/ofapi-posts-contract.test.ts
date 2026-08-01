import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  parseOfapiJsonBytes,
  parseStrictOfapiPostPage,
} from "../apps/runtime/src/services/ofapi-capture-contract.ts";

const FIXTURE_URL = new URL("./fixtures/ofapi-posts-page.json", import.meta.url);

describe("OFAPI posts capture contract", () => {
  it("parses the vendored data.list family and accounts overlap/anchor rows", async () => {
    const bytes = await readFile(FIXTURE_URL);
    const decoded = parseOfapiJsonBytes(bytes);
    const page = parseStrictOfapiPostPage(decoded.body, {
      requiredOverlapId: "102",
      stopAtPostId: "101",
    });

    expect(decoded).toMatchObject({
      validJson: true,
      creditsUsed: 1,
      balanceAfter: 999,
    });
    expect(page).toMatchObject({
      accepted: true,
      rawCount: 4,
      boundaryDuplicateCount: 1,
      explicitlyIrrelevantCount: 1,
      headPostId: "103",
      tailPostId: "100",
      stopReached: true,
      hasNextPage: true,
    });
    if (page.accepted) {
      expect(page.acceptedItems.map((item) => String(item.id))).toEqual(["103", "101"]);
    }
  });

  it("accepts a prior-run stop anchor for edits but excludes a same-job verification stop", async () => {
    const bytes = await readFile(FIXTURE_URL);
    const decoded = parseOfapiJsonBytes(bytes);
    const incremental = parseStrictOfapiPostPage(decoded.body, {
      requiredOverlapId: "102",
      stopAtPostId: "101",
      acceptStopItem: true,
    });
    const verification = parseStrictOfapiPostPage(decoded.body, {
      requiredOverlapId: "102",
      stopAtPostId: "101",
      acceptStopItem: false,
    });

    if (!incremental.accepted || !verification.accepted) {
      throw new Error("fixture unexpectedly failed the strict posts contract");
    }
    expect(incremental.acceptedItems.map((item) => String(item.id))).toEqual(["103", "101"]);
    expect(incremental).toMatchObject({
      boundaryDuplicateCount: 1,
      explicitlyIrrelevantCount: 1,
    });
    expect(verification.acceptedItems.map((item) => String(item.id))).toEqual(["103"]);
    expect(verification).toMatchObject({
      boundaryDuplicateCount: 2,
      explicitlyIrrelevantCount: 1,
    });
  });

  it("fails closed on generic list envelopes and missing overlap", () => {
    expect(parseStrictOfapiPostPage({
      data: [{ id: 1, postedAt: "2026-08-01T00:00:00Z", rawText: "post" }],
      _pagination: { next_page: null },
    })).toMatchObject({ accepted: false, reason: "data_list_missing" });

    expect(parseStrictOfapiPostPage({
      data: {
        list: [{ id: 2, postedAt: "2026-08-01T00:00:00Z", rawText: "post" }],
        hasMore: false,
      },
    }, { requiredOverlapId: "1" })).toMatchObject({
      accepted: false,
      reason: "page_overlap_missing",
    });
  });

  it("rejects false terminal pages with invalid items or ordering", () => {
    expect(parseStrictOfapiPostPage({
      data: {
        list: [{ id: 1, postedAt: "not-a-date", rawText: "post" }],
        hasMore: false,
      },
    })).toMatchObject({ accepted: false, reason: "post_item_invalid" });

    expect(parseStrictOfapiPostPage({
      data: {
        list: [
          { id: 1, postedAt: "2026-08-01T00:00:00Z", rawText: "older" },
          { id: 2, postedAt: "2026-08-02T00:00:00Z", rawText: "newer" }
        ],
        hasMore: false,
      },
    })).toMatchObject({ accepted: false, reason: "post_order_invalid" });
  });

  it("accepts media-only posts but rejects non-string text drift", () => {
    expect(parseStrictOfapiPostPage({
      data: {
        list: [{ id: 1, postedAt: "2026-08-01T00:00:00Z" }],
        hasMore: false,
      },
    })).toMatchObject({ accepted: true, rawCount: 1 });

    expect(parseStrictOfapiPostPage({
      data: {
        list: [{ id: 1, postedAt: "2026-08-01T00:00:00Z", rawText: { html: "no" } }],
        hasMore: false,
      },
    })).toMatchObject({ accepted: false, reason: "post_item_invalid" });
  });
});
