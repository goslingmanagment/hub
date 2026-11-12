import { describe, expect, it } from "vitest";

import type { OnlyfansVaultAlbumFile } from "@agency_hub_core/db";

import type { ApprovedForm } from "../apps/runtime/src/sync/fansly/publish/derive.ts";
import {
  buildVaultAlbumFiles,
  nextVaultAlbumFile,
  onlyfansKeyAllowsVault,
  onlyfansVaultAlbumAdmission,
  onlyfansVaultAlbumOutcome,
  onlyfansVaultAlbumPrice,
  onlyfansVaultExpectedOrder,
  onlyfansVaultRunSpent,
  vaultFailuresInARow,
  vaultStepReadFailed,
  vaultStepReadTurn,
  vaultUploadOutcome,
  ONLYFANS_VAULT_ALBUM_OVERHEAD_CREDITS,
} from "../apps/runtime/src/services/publications-onlyfans-vault.ts";
import { onlyfansVaultSpendCap } from "../apps/runtime/src/services/publications-onlyfans-vault-hold.ts";

// The executor of an OnlyFans vault album (8-docs 2026-11-12-of-vault-album,
// plan PR 4), its pure rules: what an album costs and when it starts, which
// file goes next and in what order the album should show them, how an upload
// job reads, and the album's outcome from its read back. The sending itself,
// one attempt per write, is in publications-onlyfans-vault.integration.

const NOW = new Date("2026-11-12T12:00:00Z");
const MIN = 60_000;
const MB = 1_000_000;

function form(count: number): Pick<ApprovedForm, "media"> {
  return {
    media: Array.from({ length: count }, (_, position) => ({
      role: "media" as const, position, source: "file" as const, mediaRef: null, fileId: 100 + position, fileSha256: `sha-${position}`, attachment: 0,
    })),
  };
}

function file(position: number, overrides: Partial<OnlyfansVaultAlbumFile> = {}): OnlyfansVaultAlbumFile {
  return {
    item: `media:${position}`, position, fileId: 100 + position, sha256: `sha-${position}`, bytes: MB, mimeType: "image/jpeg",
    name: `IMG_${position}.jpg`, credits: 3, state: "pending", jobId: null, mediaRef: null, uploadedAt: null, startedAt: null, reason: null,
    ...overrides,
  };
}

const admission = (overrides: Partial<Parameters<typeof onlyfansVaultAlbumAdmission>[0]> = {}) => onlyfansVaultAlbumAdmission({
  now: NOW, publishAt: new Date(NOW.getTime() - MIN), heldBefore: null, switchesHold: null, pageEnabled: true, keyAllowsVault: true,
  priceCredits: 100, dailyCredits: 1000, spentToday: 0, runningCredits: 0, balance: 10_000, reserve: 2000, ...overrides,
});

describe("an album's price", () => {
  it("is 3 credits a started MB for each new file, one read for a file the vault holds, nothing for one too big, and the album's own requests", () => {
    const facts = new Map([
      [100, { byteSize: 2 * MB + 1, mimeType: "image/jpeg", originalName: "a.jpg" }],
      [101, { byteSize: 5 * MB, mimeType: "video/mp4", originalName: "b.mp4" }],
      [102, { byteSize: 150 * MB, mimeType: "video/mp4", originalName: "big.mp4" }],
    ]);
    const files = buildVaultAlbumFiles(form(3), facts, new Map([["sha-1", { mediaRef: "555", uploadedAt: NOW }]]));
    expect(files.map((entry) => [entry.state, entry.credits, entry.mediaRef])).toEqual([
      ["pending", 7, null],
      ["pending", 1, "555"],
      ["too_big", 0, null],
    ]);
    expect(onlyfansVaultAlbumPrice(files)).toBe(7 + 1 + ONLYFANS_VAULT_ALBUM_OVERHEAD_CREDITS);
  });

  it("is spent by each upload's actual credits, its ceiling once sent without them, nothing before it leaves", () => {
    expect(onlyfansVaultRunSpent(4, [
      { cursor: { phase: "terminal", status: "completed", actualCredits: 12 }, dispatchCount: 1, maxCredits: 9 },
      { cursor: null, dispatchCount: 1, maxCredits: 30 },
      { cursor: null, dispatchCount: 0, maxCredits: 50 },
    ])).toBe(4 + 12 + 30);
  });

  it("may be passed by 10 % before the uploads stop", () => {
    expect(onlyfansVaultSpendCap(100)).toBe(110);
    expect(onlyfansVaultSpendCap(2740)).toBe(3014);
  });
});

describe("the admission", () => {
  it("starts an album whose whole price fits what is left of the day beside the albums running, above the reserve", () => {
    expect(admission()).toEqual({ kind: "go" });
    expect(admission({ spentToday: 600, runningCredits: 300 })).toEqual({ kind: "go" });
    expect(admission({ spentToday: 600, runningCredits: 301 })).toMatchObject({ kind: "wait", reason: expect.stringMatching(/^vault_credits_day_left/) });
    expect(admission({ balance: 2099 })).toMatchObject({ kind: "wait", reason: expect.stringMatching(/^balance_low/) });
    expect(admission({ balance: null })).toEqual({ kind: "wait", reason: "balance_unknown" });
  });

  it("returns an album dearer than a whole non-zero ceiling to a person; a ceiling of 0 is a pause", () => {
    expect(admission({ priceCredits: 1001 })).toMatchObject({ kind: "draft" });
    expect(admission({ priceCredits: 1001, dailyCredits: 0 })).toEqual({ kind: "wait", reason: "vault_credits_paused" });
    expect(admission({ dailyCredits: 0 })).toEqual({ kind: "wait", reason: "vault_credits_paused" });
  });

  it("waits for its time, its switches and the key; after 12 hours it is not sent, saying what held it", () => {
    expect(admission({ publishAt: new Date(NOW.getTime() + MIN) })).toEqual({ kind: "wait", reason: "not_yet" });
    expect(admission({ switchesHold: "vault_albums_off" })).toEqual({ kind: "wait", reason: "vault_albums_off" });
    expect(admission({ pageEnabled: false })).toEqual({ kind: "wait", reason: "page_publishing_off" });
    expect(admission({ keyAllowsVault: false })).toEqual({ kind: "wait", reason: "key_scope_no_vault" });
    const late = new Date(NOW.getTime() - 12 * 60 * MIN - 1);
    expect(admission({ publishAt: late, heldBefore: "held: vault_credits_paused" })).toEqual({ kind: "missed", reason: "not_sent:vault_credits_paused" });
    expect(admission({ publishAt: late })).toEqual({ kind: "missed", reason: "not_sent:window_passed" });
  });

  it("lets vault writes through on a key declared for them (or for uploads and commands together)", () => {
    expect(onlyfansKeyAllowsVault(null)).toBe(true);
    expect(onlyfansKeyAllowsVault(["reads", "webhooks", "links", "vault"])).toBe(true);
    expect(onlyfansKeyAllowsVault(["reads", "uploads", "commands"])).toBe(true);
    expect(onlyfansKeyAllowsVault(["reads", "uploads"])).toBe(false);
  });
});

describe("the uploads' order", () => {
  it("goes one at a time from the folder's end, following the one uploading first", () => {
    const files = [file(0), file(1), file(2, { state: "too_big" }), file(3)];
    expect(nextVaultAlbumFile(files)).toBe(3);
    expect(nextVaultAlbumFile([file(0), file(1, { state: "uploading" }), file(2)])).toBe(1);
    expect(nextVaultAlbumFile([file(0, { state: "uploaded" }), file(1, { state: "failed" })])).toBeNull();
  });

  it("expects the new files on top in the folder's order, then the files the page had before, newest first", () => {
    const files = [
      file(0, { state: "uploaded", mediaRef: "900" }),
      file(1, { state: "reused", mediaRef: "300", uploadedAt: "2026-11-01T00:00:00Z" }),
      file(2, { state: "uploaded", mediaRef: "901" }),
      file(3, { state: "in_album", mediaRef: "400", uploadedAt: "2026-11-05T00:00:00Z" }),
      file(4, { state: "failed" }),
      file(5, { state: "unknown" }),
    ];
    expect(onlyfansVaultExpectedOrder(files).map((entry) => entry.mediaRef)).toEqual(["900", "901", "400", "300"]);
  });

  it("stops the uploads after three failed or unknown ones in a row; a success starts the count anew", () => {
    let count = 0;
    count = vaultFailuresInARow(count, "failed");
    count = vaultFailuresInARow(count, "unknown");
    count = vaultFailuresInARow(count, "skipped");
    expect(count).toBe(2);
    expect(vaultFailuresInARow(count, "failed")).toBe(3);
    expect(vaultFailuresInARow(count, "done")).toBe(0);
  });
});

describe("a step's failed reads", () => {
  it("are tried again no sooner than 5 minutes later, and given up after the third", () => {
    const t0 = NOW.getTime();
    expect(vaultStepReadTurn(undefined, t0)).toBe("read");
    const first = vaultStepReadFailed(undefined, t0);
    expect(first.giveUp).toBe(false);
    expect(vaultStepReadTurn(first.reads, t0 + 4 * MIN)).toBe("wait");
    expect(vaultStepReadTurn(first.reads, t0 + 5 * MIN)).toBe("read");
    const second = vaultStepReadFailed(first.reads, t0 + 5 * MIN);
    const third = vaultStepReadFailed(second.reads, t0 + 10 * MIN);
    expect(second.giveUp).toBe(false);
    expect(third.giveUp).toBe(true);
    expect(vaultStepReadTurn(third.reads, t0 + 60 * MIN)).toBe("give_up");
  });
});

describe("an upload job as the album reads it", () => {
  const job = (overrides: Partial<Parameters<typeof vaultUploadOutcome>[0]> = {}) => vaultUploadOutcome({
    state: "ready", reasonCode: null, cursor: null, dispatchCount: 0, completedAt: null, ...overrides,
  });

  it("is a numeric media id once completed — even past its ceiling: the media is in the vault", () => {
    expect(job({ state: "complete", cursor: { status: "completed", mediaRef: "123" }, completedAt: NOW })).toEqual({ kind: "done", mediaRef: "123", at: NOW });
    expect(job({ state: "blocked", reasonCode: "upload_budget_exceeded", cursor: { status: "completed", mediaRef: "124" } })).toMatchObject({ kind: "done", mediaRef: "124" });
    expect(job({ state: "complete", cursor: { status: "completed", mediaRef: "ofapi_media_x" } })).toMatchObject({ kind: "unknown" });
  });

  it("is unknown when it may have gone without an answer Hub confirms; refused only on a definite no", () => {
    expect(job({ state: "blocked", reasonCode: "indeterminate", dispatchCount: 1 })).toEqual({ kind: "unknown", why: "indeterminate" });
    expect(job({ state: "blocked", reasonCode: "upload_http_500", dispatchCount: 1 })).toMatchObject({ kind: "unknown" });
    expect(job({ state: "blocked", reasonCode: "upload_start_contract_rejected", dispatchCount: 1 })).toMatchObject({ kind: "unknown" });
    expect(job({ state: "blocked", reasonCode: "upload_http_400", dispatchCount: 1 })).toEqual({ kind: "failed", why: "upload_http_400" });
    expect(job({ state: "blocked", reasonCode: "upload_failed", cursor: { phase: "terminal", status: "failed" }, dispatchCount: 1 })).toMatchObject({ kind: "failed" });
  });

  it("is stopped, not failed, when it never left for a reason that may lift; failed for one that will not", () => {
    expect(job({ state: "blocked", reasonCode: "vault_album_held" })).toEqual({ kind: "stopped", why: "vault_album_held" });
    expect(job({ state: "blocked", reasonCode: "scope_cap" })).toEqual({ kind: "stopped", why: "scope_cap" });
    expect(job({ state: "blocked", reasonCode: "media_source_unavailable" })).toEqual({ kind: "failed", why: "not_sent:media_source_unavailable" });
  });

  it("is waiting while queued or processing", () => {
    expect(job()).toEqual({ kind: "waiting", left: false });
    expect(job({ state: "retry_wait", cursor: { phase: "poll", uploadId: "ofapi_media_1" }, dispatchCount: 1 })).toEqual({ kind: "waiting", left: true });
  });
});

describe("the album's outcome", () => {
  const media = (id: string, overrides: Partial<{ isReady: boolean | null; hasError: boolean | null }> = {}) => ({
    id, type: "photo", isReady: true, hasError: false, createdAt: null, ...overrides,
  });
  const landed = [file(0, { state: "uploaded", mediaRef: "900" }), file(1, { state: "uploaded", mediaRef: "901" })];

  it("is published when every file is there, ready and in the order shown before «да»; others in the album do not count", () => {
    const outcome = onlyfansVaultAlbumOutcome({ files: landed, read: { ok: true, items: [media("900"), media("50"), media("901")] }, stopped: null });
    expect(outcome).toEqual({ to: "published", reason: null, notReady: [] });
  });

  it("names the files that did not land but still publishes what did", () => {
    const files = [...landed, file(2, { state: "failed", reason: "upload_http_400" }), file(3, { state: "unknown", reason: "indeterminate" }),
      file(4, { state: "too_big" }), file(5, { state: "not_tried" })];
    const outcome = onlyfansVaultAlbumOutcome({ files, read: { ok: true, items: [media("900"), media("901")] }, stopped: "price_exceeded" });
    expect(outcome.to).toBe("published");
    expect(outcome.reason).toBe("files_failed:1/6:IMG_2.jpg=upload_http_400;files_unknown:1/6:IMG_3.jpg=indeterminate;files_too_big:1:IMG_4.jpg;files_not_tried:1:price_exceeded:IMG_5.jpg");
  });

  it("is unknown when a file is missing, not ready, out of order, or the album was not read", () => {
    expect(onlyfansVaultAlbumOutcome({ files: landed, read: { ok: true, items: [media("900")] }, stopped: null }))
      .toMatchObject({ to: "unknown", reason: "files_missing:1:IMG_1.jpg" });
    expect(onlyfansVaultAlbumOutcome({ files: landed, read: { ok: true, items: [media("900"), media("901", { isReady: false })] }, stopped: null }))
      .toEqual({ to: "unknown", reason: "files_not_ready:1:IMG_1.jpg", notReady: ["media:1"] });
    expect(onlyfansVaultAlbumOutcome({ files: landed, read: { ok: true, items: [media("901"), media("900")] }, stopped: null }))
      .toMatchObject({ to: "unknown", reason: "order_differs:1:IMG_0.jpg" });
    expect(onlyfansVaultAlbumOutcome({ files: landed, read: { ok: false, reason: "vendor_http_500" }, stopped: null }))
      .toMatchObject({ to: "unknown", reason: "album_not_read:vendor_http_500" });
  });

  it("is refused when no file landed, unknown when one may have gone", () => {
    expect(onlyfansVaultAlbumOutcome({ files: [file(0, { state: "failed", reason: "upload_http_400" })], read: null, stopped: null }).to).toBe("rejected");
    expect(onlyfansVaultAlbumOutcome({ files: [file(0, { state: "unknown", reason: "indeterminate" })], read: null, stopped: null }).to).toBe("unknown");
  });
});
