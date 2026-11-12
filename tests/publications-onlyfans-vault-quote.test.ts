import { describe, expect, it } from "vitest";

import type { OnlyfansVaultAlbumFile, OnlyfansVaultListRow } from "@agency_hub_core/db";

import { albumRunWire, similarVaultAlbums, vaultAlbumQuoteOrder, vaultAlbumTitleKey } from "../apps/runtime/src/services/publications-onlyfans-vault-quote.ts";

// The price of an OnlyFans vault album before «да» (8-docs
// 2026-11-12-of-vault-album, PR 5): the album a title finds or resembles, and
// the order the album will take when it is not the folder's. The price itself
// is the executor's function (the integration test compares the two).

const at = new Date("2026-11-12T10:00:00Z");
const list = (listRef: string, name: string, extra: Partial<OnlyfansVaultListRow> = {}): OnlyfansVaultListRow => ({
  listRef, name, type: "custom", mediaCount: 3, firstSeenAt: at, lastSeenAt: at, missingSince: null, ...extra,
});

describe("a similar title", () => {
  it("is the same letters: case, spaces and emoji aside", () => {
    expect(vaultAlbumTitleKey("SEXTING Белый халат 🤍")).toBe(vaultAlbumTitleKey("sexting белыйхалат"));
    expect(vaultAlbumTitleKey("Red 👩🏽‍🦰 set")).toBe("redset");
    expect(vaultAlbumTitleKey("Red set 2")).not.toBe(vaultAlbumTitleKey("Red set"));
  });

  it("is offered up to five, never the exact title, a gone list or a system one", () => {
    const lists = [
      list("1", "White robe"),
      list("2", "white  robe 🤍"),
      list("3", "WHITE ROBE"),
      list("4", "White robe", { missingSince: at }),
      list("5", "whiterobe", { type: "posts" }),
      list("6", "White robes"),
      ...["7", "8", "9", "10"].map((ref) => list(ref, `White Robe${" ".repeat(Number(ref))}`)),
    ];
    const similar = similarVaultAlbums("White robe", lists).map((entry) => entry.listRef);
    expect(similar).toEqual(["2", "3", "7", "8", "9"]);
    expect(similarVaultAlbums("Nothing like it", lists)).toEqual([]);
  });
});

const file = (position: number, extra: Partial<OnlyfansVaultAlbumFile> = {}): OnlyfansVaultAlbumFile => ({
  item: `media:${position}`, position, fileId: position + 1, sha256: null, bytes: 1_000, mimeType: null, name: `IMG_${position}.jpg`,
  credits: 3, state: "pending", jobId: null, mediaRef: null, uploadedAt: null, startedAt: null, reason: null, ...extra,
});

describe("the order before «да»", () => {
  it("is the folder's when every file goes up new", () => {
    expect(vaultAlbumQuoteOrder([file(0), file(1), file(2)])).toBeNull();
  });

  it("puts a file Hub uploaded before below the new ones (its old date), and leaves a too-big one out", () => {
    const files = [file(0, { mediaRef: "500", uploadedAt: "2026-11-01T00:00:00Z", credits: 1 }), file(1), file(2, { state: "too_big", credits: 0 })];
    expect(vaultAlbumQuoteOrder(files)).toEqual([1, 0]);
    // Too big alone does not change the order of what goes up.
    expect(vaultAlbumQuoteOrder([file(0), file(1, { state: "too_big", credits: 0 }), file(2)])).toBeNull();
  });
});

describe("the card", () => {
  it("counts a run's files by outcome; a settled run's pending files were not tried", () => {
    const files = [
      file(0, { state: "uploaded" }), file(1, { state: "reused" }), file(2, { state: "in_album" }), file(3, { state: "failed" }),
      file(4, { state: "unknown" }), file(5, { state: "too_big" }), file(6, { state: "not_tried" }), file(7), file(8, { state: "uploading" }),
    ];
    const running = albumRunWire({ step: "uploads", files, estimateCredits: 40, spentCredits: 12, stopReason: null, account: null, linkMaxBytes: 1_000_000_000 });
    expect(running).toMatchObject({ files: 9, done: 1, reused: 2, refused: 1, unknown: 1, tooBig: 1, notTried: 1, currentFile: "IMG_8.jpg" });
    expect(albumRunWire({ step: "done", files: files.slice(0, 8), estimateCredits: 40, spentCredits: 12, stopReason: "three_failures", account: null, linkMaxBytes: 1_000_000_000 }).notTried).toBe(2);
  });
});
