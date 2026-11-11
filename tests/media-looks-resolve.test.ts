import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { NO_FANSLY_PAGE_HOLDS } from "@agency_hub_core/shared";

import { publishedPostFile, vaultPageFile } from "../apps/runtime/src/services/media-looks/answer-files.ts";
import { mediaLookResolveFailure } from "../apps/runtime/src/services/media-looks/index.ts";
import { selectMediaLookSource } from "../apps/runtime/src/services/media-looks/select.ts";
import { onOutcome, type PageErrorState } from "../apps/runtime/src/sync/engine/errors.ts";
import { stripFanslySignedCdnTokens } from "../apps/runtime/src/sync/fansly/lib/cdn-tokens.ts";
import {
  mediaLookResolveModule,
  mediaLookResolveOutcome,
  parseMediaLookResolveParams,
  vaultPageCursorAt,
} from "../apps/runtime/src/sync/fansly/resources/media-look-resolve.ts";

// A look of a published post or a vault file (owner 2026-11-11): the engine's
// one read of the post (`posts.by_ids`) or of the vault page that starts at the
// file (`vault.media`), never retried; the file found in that answer the same
// way as in the schedule's; ONE selector for every source, which takes only a
// location signed in its own query — so the journal's copy (its tokens
// stripped) never yields a URL.

const CDN = "https://cdn3.fansly.com";
const OWN = "731275363459538945";
const signed = (path: string) => `${CDN}/${path}?ngsw-bypass=true&Expires=4102444800&Key-Pair-Id=K&Signature=S`;
const at = (path: string) => [{ locationId: "1", location: signed(path) }];

function videoMedia(id: string, accountId = OWN) {
  return {
    id, accountId, mimetype: "video/mp4", width: 720, height: 1280, metadata: JSON.stringify({ duration: 6.6 }),
    locations: at(`${id}/video.mp4`),
    variants: [
      { id: `${id}1`, type: 1, mimetype: "image/jpeg", width: 480, height: 854, locations: at(`${id}/poster.jpeg`) },
      { id: `${id}3`, type: 3, mimetype: "image/jpeg", width: 480, height: 854, locations: at(`${id}/blurred.jpeg`) },
      {
        id: `${id}4`, type: 4, mimetype: "image/jpeg", width: 144, height: 256,
        metadata: JSON.stringify({ thumbnailDistance: 1, thumbnailCount: 7, thumbnailGrid: [3, 3] }),
        locations: at(`${id}/sprite.jpeg`),
      },
    ],
  };
}

/** `GET /post?ids=` as Fansly answers it: the posts, their account media at the top level. */
const postAnswer = {
  posts: [{ id: "500", accountId: OWN, attachments: [{ pos: 1, contentId: "902", contentType: 1 }, { pos: 0, contentId: "800", contentType: 2 }] }],
  accountMediaBundles: [{ id: "800", accountId: OWN, accountMediaIds: ["901"] }],
  accountMedia: [
    { id: "901", accountId: OWN, mediaId: "701", media: videoMedia("701") },
    { id: "902", accountId: OWN, mediaId: "702", media: videoMedia("702") },
  ],
};

/** `GET /media/vaultnew` as Fansly answers it: the files themselves, and their album rows. */
const vaultAnswer = {
  media: [videoMedia("703"), videoMedia("704", "640000000000000001")],
  albumMedia: [{ id: "941543463445344263", albumId: "928408212237991937", mediaId: "703", accountId: OWN }],
};

describe("the file a look's read names", () => {
  it("a published post's file at its index, an album's files first by `pos`", () => {
    expect(publishedPostFile(postAnswer, "500", 0)).toMatchObject({ ok: true, accountMediaRef: "901", mediaRef: "701", ownerAccountRef: OWN });
    expect(publishedPostFile(postAnswer, "500", 1)).toMatchObject({ ok: true, mediaRef: "702" });
    expect(publishedPostFile(postAnswer, "500", 2)).toEqual({ ok: false, reason: "attachment_not_found" });
    expect(publishedPostFile(postAnswer, "501", 0)).toEqual({ ok: false, reason: "post_not_in_answer" });
  });

  it("a vault file among the page's `media`, with the account it belongs to", () => {
    expect(vaultPageFile(vaultAnswer, "703")).toMatchObject({ ok: true, mediaRef: "703", ownerAccountRef: OWN });
    expect(vaultPageFile(vaultAnswer, "704")).toMatchObject({ ok: true, ownerAccountRef: "640000000000000001" });
    expect(vaultPageFile(vaultAnswer, "705")).toEqual({ ok: false, reason: "media_not_in_read" });
  });

  it("the vault page that starts at the file's own membership row", () => {
    expect(vaultPageCursorAt("941543463445344263")).toBe("941543463445344264");
    expect(vaultPageCursorAt("999999999999999999")).toBe("1000000000000000000");
  });
});

describe("the one selector takes only a location signed in its own query", () => {
  it("the answer in memory gives the sheet; the journal's copy gives nothing to fetch", () => {
    const media = videoMedia("701");
    const live = selectMediaLookSource(media, { cover: false });
    expect(live).toMatchObject({ ok: true, variant: "sprite" });
    const journaled = stripFanslySignedCdnTokens(media);
    // The journal's copy: no URL a request could use…
    expect(selectMediaLookSource(journaled, { cover: false })).toEqual({ ok: false, reason: "no_image_variant" });
    expect(selectMediaLookSource(journaled, { cover: true })).toEqual({ ok: false, reason: "no_image_variant" });
    // … though a still image is there: what tells "stripped" from "none".
    expect(selectMediaLookSource(journaled, { cover: false, allowUnsigned: true })).toMatchObject({ ok: true, variant: "sprite" });
  });

  it("is one function, used by the schedule's look and the read's apply alike", () => {
    const root = join(__dirname, "..");
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (entry.endsWith(".ts")) files.push(relative(root, path));
      }
    };
    walk(join(root, "apps/runtime/src"));
    const defining = files.filter((file) => /function selectMediaLookSource\b/.test(readFileSync(join(root, file), "utf8")));
    expect(defining).toEqual(["apps/runtime/src/services/media-looks/select.ts"]);
    const using = files.filter((file) => /\bselectMediaLookSource\(/.test(readFileSync(join(root, file), "utf8"))).sort();
    expect(using).toEqual([
      "apps/runtime/src/services/media-looks/index.ts",
      "apps/runtime/src/services/media-looks/select.ts",
      "apps/runtime/src/sync/fansly/resources/media-look-resolve.ts",
    ]);
  });
});

describe("media-look.resolve: one read, never retried", () => {
  it("reads the post by its id, or the vault page that starts at the file", async () => {
    const post = { target: "post", postRef: "500", index: 1, cover: false };
    const vault = { target: "vault", mediaRef: "703", albumRef: "928408212237991937", before: "941543463445344264", cover: true };
    expect(parseMediaLookResolveParams(post)).toEqual(post);
    expect(parseMediaLookResolveParams(vault)).toEqual(vault);
    for (const bad of [{}, { ...post, postRef: "x" }, { ...post, index: 100 }, { ...vault, before: "" }, null]) {
      expect(parseMediaLookResolveParams(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(await mediaLookResolveModule.plan({ subject: "look:7", params: post } as never, {} as never))
      .toEqual({ kind: "request", request: { spec: "posts.by_ids", params: { ids: ["500"] } } });
    expect(await mediaLookResolveModule.plan({ subject: "look:7", params: vault } as never, {} as never))
      .toEqual({ kind: "request", request: { spec: "vault.media", params: { albumId: "928408212237991937", before: "941543463445344264" } } });
    expect(await mediaLookResolveModule.plan({ subject: "desc:7", params: post } as never, {} as never)).toMatchObject({ kind: "done", reason: "bad_subject" });
  });

  it("any answer but a success closes the read with its failure; the page's and the route's holds stand", () => {
    const page: PageErrorState = { holds: NO_FANSLY_PAGE_HOLDS, networkFailureStreak: 0, resourceHolds: {}, credentialsGeneration: "a".repeat(64) };
    const decide = (errorClass: Parameters<typeof onOutcome>[0]["errorClass"], httpStatus: number | null) => onOutcome({
      errorClass, now: new Date("2026-11-11T12:00:00Z"), resource: "media-look.resolve", subject: "look:7", httpStatus, retryAfterMs: null, page,
      ...(errorClass === "rate_limit" ? { route: { route: "posts.by_ids" as const, entry: null, attemptId: 1, jitter: () => 0 } } : {}),
      subjectState: { failureCount: 0, breakerUntil: null, blockedByVendorAt: null }, subjectQueue: false, recentFailedSubjects: 0,
    });
    const step = { request: { spec: "posts.by_ids" as const, params: { ids: ["500"] } }, outcome: "response" as const, fanslyErrorEnvelope: false };
    for (const [errorClass, httpStatus] of [["network", null], ["subject_failure", 500], ["auth", 401], ["rate_limit", 429]] as const) {
      const decided = decide(errorClass, httpStatus);
      const own = mediaLookResolveOutcome(decided, { ...step, httpStatus, outcome: httpStatus === null ? "transport_error" : "response" });
      expect(own.work, errorClass).toEqual({
        action: "close", closeReason: `resolve_failed:${errorClass}`, result: { failure: `resolve_${errorClass}`, httpStatus },
      });
      expect(own.pageHold, errorClass).toEqual(decided.pageHold);
      expect(own.routeHold, errorClass).toEqual(decided.routeHold);
    }
    const ok = decide("ok", 200);
    expect(mediaLookResolveOutcome(ok, { ...step, httpStatus: 200 })).toBe(ok);
    expect(mediaLookResolveFailure({ failure: "resolve_auth", httpStatus: 401 }, "resolve_failed:auth")).toBe("resolve_auth");
    expect(mediaLookResolveFailure({ failure: "bad_subject" }, "bad_subject")).toBe("resolve_bad_subject");
    expect(mediaLookResolveFailure(null, null)).toBe("resolve_not_answered");
  });
});
