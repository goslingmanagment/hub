import { describe, expect, it } from "vitest";

import type { PublicationContentBody } from "@agency_hub_core/contracts";
import type { PagePublishingSettingsRecord, PublicationContent, PublicationPageFacts } from "@agency_hub_core/db";
import { canTransitionPublication } from "@agency_hub_core/shared";

import {
  evaluatePublicationFindings,
  normalizePublicationDraft,
  publicationApprovalForm,
  type PublicationCheckFacts,
} from "../apps/runtime/src/services/publications.ts";

// Publications (docs/plans/2026-10-23-wall-posts): the rules that keep a wrong
// post off a page — money (price range, mills), the model, the repeat window,
// the day's volume — and the approved form's fingerprint. The database half
// (approval under the page lock, edit → draft, the API) is in
// publications.integration.test.ts.

const NOW = new Date("2026-10-24T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const FANSLY: PublicationPageFacts = {
  id: 1, label: "lilly-1", platform: "fansly", status: "active", modelId: 7, username: "lilly",
  platformAccountRef: "acc-1", ofapiAccountRef: null, ofapiBindingGeneration: 1,
};
const ONLYFANS: PublicationPageFacts = {
  ...FANSLY, id: 2, label: "lora-of", platform: "onlyfans", platformAccountRef: "of-1", ofapiAccountRef: "acct_1",
};

function settings(overrides: Partial<PagePublishingSettingsRecord> = {}): PagePublishingSettingsRecord {
  return {
    pageId: 1, enabled: false, autostopReason: null, autostoppedAt: null,
    paidPriceMinMills: 5_000n, paidPriceMaxMills: 50_000n, repostThresholdDays: 30, dailyLimit: null,
    updatedByUserId: null, updatedAt: null, ...overrides,
  };
}

function body(overrides: Partial<PublicationContentBody> = {}): PublicationContentBody {
  return {
    kind: "fyp_post", text: "hi", media: [{ source: "vault", mediaRef: "m1" }], previews: [],
    publishAt: new Date(NOW.getTime() + DAY).toISOString(), expiresAt: null, wallRefs: [], tierRefs: [],
    priceMills: null, repost: false, pinWallRefs: [], replyLock: [], subscribersOnly: false, extraAttachments: [], ...overrides,
  };
}

const CONTEXT = {
  page: FANSLY,
  walls: [{ wallRef: "w-main", defaultWall: true }, { wallRef: "w-2", defaultWall: false }],
  files: new Map([[10, { id: 10, modelId: 7, contentSha256: "a".repeat(64), byteSize: 1_000, bytesDeletedAt: null }], [11, { id: 11, modelId: 8, contentSha256: "b".repeat(64), byteSize: 1_000, bytesDeletedAt: null }]]),
};

function facts(overrides: Partial<PublicationCheckFacts> = {}): PublicationCheckFacts {
  return {
    now: NOW, page: FANSLY, settings: settings(), files: CONTEXT.files, pageMediaRefs: new Set(["m1", "m2"]),
    walls: CONTEXT.walls, tierRefs: ["t1"], history: [], volume: { dayCount: 0, usualPerDay: 1 }, ...overrides,
  };
}

function codes(content: PublicationContent, overrides: Partial<PublicationCheckFacts> = {}) {
  return evaluatePublicationFindings(content, facts(overrides)).map((finding) => `${finding.code}:${finding.severity}`);
}

describe("publications: the draft's shape", () => {
  it("keeps a post's pins, reply lock and a paid post for subscribers of some tiers", () => {
    const pinned = normalizePublicationDraft(body({ pinWallRefs: ["w-main"], replyLock: ["subscribers", "followers"] }), CONTEXT);
    expect(pinned).toMatchObject({ wallRefs: ["w-main"], pinWallRefs: ["w-main"], replyLock: ["followers", "subscribers"], subscribersOnly: false });
    const forSubscribers = normalizePublicationDraft(body({ kind: "paid_post", priceMills: 12_500, subscribersOnly: true, tierRefs: ["t1"] }), CONTEXT);
    expect(forSubscribers).toMatchObject({ subscribersOnly: true, tierRefs: ["t1"], priceMills: 12_500n });
    expect(() => normalizePublicationDraft(body({ kind: "paid_post", priceMills: 12_500, tierRefs: ["t1"] }), CONTEXT)).toThrow(/tiers narrow/);
  });

  it("resolves an empty wall list to the page's default wall and keeps mills as mills", () => {
    const content = normalizePublicationDraft(body({ kind: "paid_post", priceMills: 12_500 }), CONTEXT);
    expect(content.wallRefs).toEqual(["w-main"]);
    expect(content.priceMills).toBe(12_500n);
  });

  it("refuses shapes the platform cannot take", () => {
    expect(() => normalizePublicationDraft(body({ kind: "fyp_post" }), { ...CONTEXT, page: ONLYFANS })).toThrow(/cannot publish fyp_post/);
    expect(() => normalizePublicationDraft(body({ kind: "story", media: [] }), CONTEXT)).toThrow(/exactly one file/);
    expect(() => normalizePublicationDraft(body({ kind: "paid_post", priceMills: null }), CONTEXT)).toThrow(/needs at least one file and a price/);
    expect(() => normalizePublicationDraft(body({ kind: "fyp_post", priceMills: 5_000 }), CONTEXT)).toThrow(/belong to a paid post/);
    // A subscriber post anyone else may buy: Fansly only, and only with a file to buy.
    expect(() => normalizePublicationDraft(body({ kind: "subscriber_post", priceMills: 5_000 }), { ...CONTEXT, page: ONLYFANS })).toThrow(/only a Fansly subscriber post/);
    expect(() => normalizePublicationDraft(body({ kind: "subscriber_post", priceMills: 5_000, media: [], text: "hi" }), CONTEXT)).toThrow(/needs at least one file/);
    // Pins, reply locks and paid posts for subscribers only: Fansly's, each where it belongs.
    expect(() => normalizePublicationDraft(body({ replyLock: ["subscribers"] }), { ...CONTEXT, page: ONLYFANS })).toThrow(/cannot publish fyp_post/);
    expect(() => normalizePublicationDraft(body({ kind: "subscriber_post", replyLock: ["subscribers"] }), { ...CONTEXT, page: ONLYFANS })).toThrow(/exist on Fansly only/);
    expect(() => normalizePublicationDraft(body({ kind: "story", pinWallRefs: [] , replyLock: ["followers"] }), CONTEXT)).toThrow(/neither pinned nor locked/);
    expect(() => normalizePublicationDraft(body({ kind: "subscriber_post", subscribersOnly: true }), CONTEXT)).toThrow(/only a paid post/);
    expect(() => normalizePublicationDraft(body({ pinWallRefs: ["w-other"] }), CONTEXT)).toThrow(/pinned only on walls it goes to/);
    expect(() => normalizePublicationDraft(body({ media: [{ source: "vault", mediaRef: "m1" }, { source: "vault", mediaRef: "m1" }] }), CONTEXT)).toThrow(/twice/);
    expect(() => normalizePublicationDraft(body({ media: [{ source: "file", fileId: 99 }] }), CONTEXT)).toThrow(/does not exist/);
  });
});

describe("publications: the checks (spec §8.1)", () => {
  it("prices: outside the range, no range, and OnlyFans paid posts are blocking", () => {
    const paid = normalizePublicationDraft(body({ kind: "paid_post", priceMills: 60_000 }), CONTEXT);
    expect(codes(paid)).toContain("price_out_of_range:blocking");
    expect(codes(paid, { settings: settings({ paidPriceMinMills: null, paidPriceMaxMills: null }) })).toContain("price_range_not_set:blocking");
    const inRange = normalizePublicationDraft(body({ kind: "paid_post", priceMills: 50_000 }), CONTEXT);
    expect(codes(inRange).filter((code) => code.startsWith("price"))).toEqual([]);
    // The price others pay for a subscriber post keeps to the same range; several tiers are a post's own (the contract §3).
    const buyable = normalizePublicationDraft(body({ kind: "subscriber_post", priceMills: 60_000, tierRefs: ["t1", "t2"] }), CONTEXT);
    expect(codes(buyable, { tierRefs: ["t1", "t2"] }).filter((code) => !code.startsWith("volume"))).toEqual(["price_out_of_range:blocking"]);
    const ofPaid = normalizePublicationDraft(body({ kind: "paid_post", priceMills: 10_000 }), { ...CONTEXT, page: ONLYFANS });
    expect(codes(ofPaid, { page: ONLYFANS })).toContain("paid_post_off_on_onlyfans:blocking");
  });

  it("a file of another model and a vault ref the page does not have are blocking", () => {
    const content = normalizePublicationDraft(body({ media: [{ source: "file", fileId: 11 }, { source: "vault", mediaRef: "elsewhere" }] }), CONTEXT);
    expect(codes(content)).toEqual(expect.arrayContaining(["file_of_another_model:blocking", "media_not_on_page:blocking"]));
    const own = normalizePublicationDraft(body({ media: [{ source: "file", fileId: 10 }] }), CONTEXT);
    // The page's browser uploads a new file on Fansly (plan PR 8): no finding.
    expect(codes(own)).toEqual([]);
  });

  it("a new file on OnlyFans goes up with the post up to 100 MB; a larger one is blocking (plan PR 4c)", () => {
    const ofContext = { ...CONTEXT, page: ONLYFANS };
    const content = normalizePublicationDraft(body({ kind: "subscriber_post", media: [{ source: "file", fileId: 10 }] }), ofContext);
    expect(codes(content, { page: ONLYFANS })).toEqual([]);
    const big = new Map([[10, { id: 10, modelId: 7, contentSha256: "a".repeat(64), byteSize: 100_000_001, bytesDeletedAt: null }]]);
    expect(codes(content, { page: ONLYFANS, files: big })).toEqual(["onlyfans_file_too_large:blocking"]);
  });

  it("a repeat closer than the threshold blocks unless marked as a repost; older is information", () => {
    const content = normalizePublicationDraft(body(), CONTEXT);
    const recent = [{ key: "vault:m1", lastPostedAt: new Date(NOW.getTime() - 10 * DAY), lastPostRef: "p1", nearestPublicationId: null, nearestPublicationAt: null }];
    expect(codes(content, { history: recent })).toEqual(["repost_within_threshold:blocking"]);
    const reposted = normalizePublicationDraft(body({ repost: true }), CONTEXT);
    expect(codes(reposted, { history: recent })).toEqual(["repost_within_threshold:warning"]);
    const booked = [{ key: "vault:m1", lastPostedAt: null, lastPostRef: null, nearestPublicationId: 5, nearestPublicationAt: new Date(NOW.getTime() + 20 * DAY) }];
    expect(codes(content, { history: booked })).toEqual(["repost_within_threshold:blocking"]);
    const old = [{ key: "vault:m1", lastPostedAt: new Date(NOW.getTime() - 40 * DAY), lastPostRef: "p0", nearestPublicationId: null, nearestPublicationAt: null }];
    expect(codes(content, { history: old })).toEqual(["posted_before:info"]);
  });

  it("volume warns at twice the usual day (never under 3) and the hard limit blocks", () => {
    const content = normalizePublicationDraft(body(), CONTEXT);
    expect(codes(content, { volume: { dayCount: 4, usualPerDay: 1 } })).toEqual([]);
    expect(codes(content, { volume: { dayCount: 5, usualPerDay: 1 } })).toEqual(["volume_high:warning"]);
    expect(codes(content, { volume: { dayCount: 5, usualPerDay: 4 } })).toEqual([]);
    expect(codes(content, { volume: { dayCount: 2, usualPerDay: 1 }, settings: settings({ dailyLimit: 2 }) })).toEqual(["daily_limit_exceeded:blocking"]);
    const story = normalizePublicationDraft(body({ kind: "story" }), CONTEXT);
    expect(codes(story, { volume: { dayCount: 50, usualPerDay: 1 }, settings: settings({ dailyLimit: 1 }) })).toEqual([]);
  });

  it("a past time, an unknown wall or tier, and no default wall are blocking", () => {
    const past = normalizePublicationDraft(body({ publishAt: new Date(NOW.getTime() - 1000).toISOString() }), CONTEXT);
    expect(codes(past)).toEqual(["publish_time_past:blocking"]);
    const walls = normalizePublicationDraft(body({ kind: "subscriber_post", wallRefs: ["w-x"], tierRefs: ["t-x"] }), CONTEXT);
    expect(codes(walls)).toEqual(["wall_not_on_page:blocking", "tier_not_on_page:blocking"]);
    const noDefault = normalizePublicationDraft(body(), { ...CONTEXT, walls: [] });
    expect(codes(noDefault, { walls: [] })).toEqual(["wall_default_unknown:blocking"]);
  });
});

describe("publications: the approved form", () => {
  const files = CONTEXT.files;
  const content = normalizePublicationDraft(body({ kind: "paid_post", priceMills: 9_990, media: [{ source: "file", fileId: 10 }] }), CONTEXT);

  it("is the same bytes for the same publication and changes with the price, the binding and the file's bytes", () => {
    const base = publicationApprovalForm({ publicationId: 3, content, page: FANSLY, files }).fingerprint;
    expect(publicationApprovalForm({ publicationId: 3, content: { ...content }, page: { ...FANSLY }, files }).fingerprint).toBe(base);
    expect(publicationApprovalForm({ publicationId: 3, content: { ...content, priceMills: 9_991n }, page: FANSLY, files }).fingerprint).not.toBe(base);
    expect(publicationApprovalForm({ publicationId: 3, content, page: { ...FANSLY, ofapiBindingGeneration: 2 }, files }).fingerprint).not.toBe(base);
    const otherBytes = new Map([[10, { id: 10, modelId: 7, contentSha256: "c".repeat(64), byteSize: 1_000, bytesDeletedAt: null }]]);
    expect(publicationApprovalForm({ publicationId: 3, content, page: FANSLY, files: otherBytes }).fingerprint).not.toBe(base);
  });

  it("names the options and the extra attachments only when there are any: a form approved before them keeps its bytes", () => {
    const { form } = publicationApprovalForm({ publicationId: 3, content, page: FANSLY, files });
    expect(Object.keys(form)).not.toEqual(expect.arrayContaining(["pinWallRefs"]));
    expect(form).not.toHaveProperty("extraAttachments");
    expect(form).not.toHaveProperty("replyLock");
    expect(form).not.toHaveProperty("subscribersOnly");
    expect((form.media as Array<Record<string, unknown>>)[0]).not.toHaveProperty("attachment");
    const extra = normalizePublicationDraft(body({
      kind: "subscriber_post", media: [{ source: "vault", mediaRef: "m1" }],
      extraAttachments: [{ access: "paid", media: [{ source: "vault", mediaRef: "m2" }], previews: [], tierRefs: [], priceMills: 9_000, subscribersOnly: false }],
    }), CONTEXT);
    const withExtra = publicationApprovalForm({ publicationId: 3, content: extra, page: FANSLY, files }).form;
    expect(withExtra.extraAttachments).toEqual([{ attachment: 1, access: "paid", tierRefs: [], priceMills: "9000", subscribersOnly: false }]);
    expect((withExtra.media as Array<Record<string, unknown>>).map((item) => item.attachment ?? 0)).toEqual([0, 1]);
  });
});

describe("publications: extra attachments of a Fansly post (the contract §12.2)", () => {
  const extra = (overrides: Partial<PublicationContentBody["extraAttachments"][number]>) => ({
    access: "everyone" as const, media: [{ source: "vault" as const, mediaRef: "m2" }], previews: [], tierRefs: [], priceMills: null, subscribersOnly: false, ...overrides,
  });

  it("numbers their files on from the post's own, each with its attachment, and keeps who sees each", () => {
    const content = normalizePublicationDraft(body({
      kind: "subscriber_post",
      extraAttachments: [
        extra({ access: "paid", priceMills: 9_000, media: [{ source: "vault", mediaRef: "m2" }, { source: "vault", mediaRef: "m3" }], previews: [{ source: "vault", mediaRef: "p2" }] }),
        extra({ access: "subscribers", tierRefs: ["t1"], media: [{ source: "vault", mediaRef: "m4" }] }),
      ],
    }), CONTEXT);
    expect(content.media.map((item) => `${item.role}:${item.position}@${item.attachment}=${item.platformMediaRef}`))
      .toEqual(["media:0@0=m1", "media:1@1=m2", "media:2@1=m3", "preview:1@1=p2", "media:3@2=m4"]);
    expect(content.extraAttachments).toEqual([
      { attachment: 1, access: "paid", tierRefs: [], priceMills: 9_000n, subscribersOnly: false },
      { attachment: 2, access: "subscribers", tierRefs: ["t1"], priceMills: null, subscribersOnly: false },
    ]);
    // Each price keeps to the page's range; each tier must be the page's.
    const wide = normalizePublicationDraft(body({ kind: "subscriber_post", extraAttachments: [extra({ access: "paid", priceMills: 60_000 }), extra({ access: "subscribers", tierRefs: ["t9"], media: [{ source: "vault", mediaRef: "m3" }] })] }), CONTEXT);
    expect(codes(wide, { pageMediaRefs: new Set(["m1", "m2", "m3"]) }).filter((code) => !code.startsWith("volume"))).toEqual(["price_out_of_range:blocking", "tier_not_on_page:blocking"]);
  });

  it("refuses what an attachment cannot be: everyone's with a price, a paid one without, previews of a free one, a file twice, on OnlyFans or a story", () => {
    const draft = (extras: ReturnType<typeof extra>[], overrides: Partial<PublicationContentBody> = {}) =>
      () => normalizePublicationDraft(body({ kind: "subscriber_post", extraAttachments: extras, ...overrides }), CONTEXT);
    expect(draft([extra({ priceMills: 5_000 })])).toThrow(/attachment 1: everyone's has no tiers or price/);
    expect(draft([extra({ access: "paid" })])).toThrow(/a paid one needs a price/);
    expect(draft([extra({ access: "subscribers", previews: [{ source: "vault", mediaRef: "p1" }] })])).toThrow(/previews belong to one with a price/);
    expect(draft([extra({ access: "paid", priceMills: 5_000, tierRefs: ["t1"] })])).toThrow(/tiers narrow/);
    expect(draft([extra({ access: "subscribers", subscribersOnly: true })])).toThrow(/only a paid one is for subscribers only/);
    expect(draft([extra({ media: [{ source: "vault", mediaRef: "m1" }] })])).toThrow(/the same file is attached twice/);
    expect(() => normalizePublicationDraft(body({ kind: "subscriber_post", extraAttachments: [extra({})] }), { ...CONTEXT, page: ONLYFANS })).toThrow(/belong to a Fansly post/);
    expect(draft([extra({})], { kind: "story" })).toThrow(/belong to a Fansly post/);
  });
});

describe("publications: who moves a status", () => {
  it("only a person approves or cancels; an agent can only return its edit to draft; outcomes are Hub's", () => {
    expect(canTransitionPublication("draft", "approved", "human")).toBe(true);
    expect(canTransitionPublication("draft", "approved", "agent")).toBe(false);
    expect(canTransitionPublication("draft", "approved", "hub")).toBe(false);
    expect(canTransitionPublication("approved", "draft", "agent")).toBe(true);
    expect(canTransitionPublication("approved", "cancelled", "agent")).toBe(false);
    expect(canTransitionPublication("approved", "submitting", "human")).toBe(false);
    expect(canTransitionPublication("submitting", "unknown", "hub")).toBe(true);
    // Absence from a read proves nothing: only a person says "it did not go out".
    expect(canTransitionPublication("unknown", "not_published", "hub")).toBe(false);
    expect(canTransitionPublication("unknown", "not_published", "human")).toBe(true);
  });
});
