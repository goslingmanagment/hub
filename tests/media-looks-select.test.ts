import { describe, expect, it } from "vitest";

import { mediaLookFetchFailure } from "../apps/runtime/src/services/media-looks/index.ts";
import { findScheduledPostMedia } from "../apps/runtime/src/services/media-looks/schedule-source.ts";
import { selectMediaLookSource } from "../apps/runtime/src/services/media-looks/select.ts";
import {
  createMediaLookModule,
  isMediaLookImageAnswer,
  isMediaLookImageUrl,
  lookIdOfSubject,
  MEDIA_LOOK_SINK,
  mediaLookSubject,
} from "../apps/runtime/src/sync/fansly/resources/media-look.ts";

// What a media look fetches (owner 2026-11-11): a still image only — a
// video's thumbnail sheet or cover, a photo's resize — and never a video
// stream, a blurred copy, a playlist, a manifest or the video file itself;
// which file of a scheduled post an index names; and the engine sink's own
// refusal of an answer that is not an image.

const CDN = "https://cdn3.fansly.com";
const signed = (path: string) => `${CDN}/${path}?ngsw-bypass=true&Expires=4102444800&Key-Pair-Id=K&Signature=S`;
const at = (path: string) => [{ locationId: "1", location: signed(path) }];
const streamAt = (path: string) => [{ locationId: "2", location: `${CDN}/${path}`, metadata: { Policy: "P", Signature: "S", "Key-Pair-Id": "K" } }];

function video(overrides: { sprite?: Record<string, unknown> | null; variants?: Record<string, unknown>[] } = {}) {
  const sprite = overrides.sprite === null ? [] : [{
    id: "v4", type: 4, mimetype: "image/jpeg", width: 144, height: 256,
    metadata: JSON.stringify({ duration: 6.27, thumbnailDistance: 1, thumbnailCount: 7, thumbnailGrid: [3, 3], frameDistance: 30 }),
    locations: at("m1/sprite.jpeg"),
    ...overrides.sprite,
  }];
  return {
    id: "m1", mimetype: "video/mp4", width: 720, height: 1280, metadata: JSON.stringify({ duration: 6.266667 }),
    locations: at("m1/video.mp4"),
    variants: overrides.variants ?? [
      { id: "v1a", type: 1, mimetype: "image/jpeg", width: 480, height: 854, locations: at("m1/poster-480.jpeg") },
      { id: "v1b", type: 1, mimetype: "image/jpeg", width: 720, height: 1280, locations: at("m1/poster-720.jpeg") },
      { id: "v3", type: 3, mimetype: "image/jpeg", width: 1080, height: 1920, locations: at("m1/blurred.jpeg") },
      ...sprite,
      { id: "v302", type: 302, mimetype: "application/vnd.apple.mpegurl", width: 2160, height: 3840, locations: streamAt("m1/master.m3u8") },
      { id: "v303", type: 303, mimetype: "application/dash+xml", width: 2160, height: 3840, locations: streamAt("m1/manifest.mpd") },
    ],
  };
}

function photo(variants: Array<[type: number, width: number, height: number]>, mimetype = "image/jpeg") {
  return {
    id: "p1", mimetype, width: 3214, height: 5712, locations: at("p1/original.jpeg"),
    variants: variants.map(([type, width, height], index) => ({
      id: `pv${index}`, type, mimetype: "image/jpeg", width, height, locations: at(`p1/${type}-${width}.jpeg`),
    })),
  };
}

const pathOf = (url: string) => new URL(url).pathname;

describe("the media look's selector", () => {
  it("takes a video's thumbnail sheet, per second when its distance is one second", () => {
    const picked = selectMediaLookSource(video(), { cover: false });
    expect(picked).toMatchObject({
      ok: true, variant: "sprite", mediaType: "video", coverage: "per_second", durationMs: 6267,
      geometry: { gridA: 3, gridB: 3, cellWidth: 144, cellHeight: 256, count: 7, intervalMs: 1000 },
    });
    expect(pathOf((picked as { url: string }).url)).toBe("/m1/sprite.jpeg");
  });

  it("a long video's sheet is sampled, its interval said", () => {
    const long = video({
      sprite: { metadata: JSON.stringify({ duration: 386.17, thumbnailDistance: 3.2, thumbnailCount: 121, thumbnailGrid: [11, 11] }) },
    });
    expect(selectMediaLookSource(long, { cover: false })).toMatchObject({
      ok: true, variant: "sprite", coverage: "sampled", geometry: { count: 121, intervalMs: 3200 },
    });
  });

  it("takes the largest poster for the cover, when asked, without a sheet, or with a sheet that cannot be cut", () => {
    const covers = [
      selectMediaLookSource(video(), { cover: true }),
      selectMediaLookSource(video({ sprite: null }), { cover: false }),
      selectMediaLookSource(video(), { cover: false, spriteUnusable: true }),
      // A sheet whose facts cannot hold its frames: no guessing.
      selectMediaLookSource(video({ sprite: { metadata: JSON.stringify({ thumbnailDistance: 1, thumbnailCount: 10, thumbnailGrid: [3, 3] }) } }), { cover: false }),
      selectMediaLookSource(video({ sprite: { metadata: "{" } }), { cover: false }),
      // A sheet whose path is not an image's.
      selectMediaLookSource(video({ sprite: { locations: at("m1/sprite.mp4") } }), { cover: false }),
    ];
    for (const picked of covers) {
      expect(picked).toMatchObject({ ok: true, variant: "cover", mediaType: "video", coverage: "cover_only" });
      expect(pathOf((picked as { url: string }).url)).toBe("/m1/poster-720.jpeg");
    }
  });

  it("never a blurred copy, a stream or the video file itself", () => {
    const onlyForbidden = video({
      variants: [
        { type: 3, mimetype: "image/jpeg", width: 480, height: 854, locations: at("m1/blurred.jpeg") },
        { type: 302, mimetype: "application/vnd.apple.mpegurl", locations: streamAt("m1/master.m3u8") },
        { type: 303, mimetype: "application/dash+xml", locations: streamAt("m1/manifest.mpd") },
        // An "image" variant whose location is a stream: refused by its path.
        { type: 1, mimetype: "image/jpeg", width: 720, height: 1280, locations: at("m1/clip.mp4") },
        // Signed beside its URL (the streams' form): never assembled.
        { type: 1, mimetype: "image/jpeg", width: 720, height: 1280, locations: streamAt("m1/poster.jpeg") },
      ],
    });
    expect(selectMediaLookSource(onlyForbidden, { cover: false })).toEqual({ ok: false, reason: "no_image_variant" });
    expect(selectMediaLookSource(onlyForbidden, { cover: true })).toEqual({ ok: false, reason: "no_image_variant" });
    for (const cover of [false, true]) {
      const picked = selectMediaLookSource(video(), { cover });
      expect(picked.ok).toBe(true);
      const path = pathOf((picked as { url: string }).url);
      expect(path).toMatch(/\.jpeg$/);
      expect(path).not.toMatch(/blurred|\.mp4|\.m3u8|\.mpd/);
    }
  });

  it("a photo: the smallest resize of 512 px or more, else the largest; the original only with no resize", () => {
    const resizes: Array<[number, number, number]> = [[1, 1080, 1920], [1, 720, 1280], [1, 480, 854], [1, 360, 640], [1, 240, 426], [3, 240, 426]];
    const picked = selectMediaLookSource(photo(resizes), { cover: false });
    expect(picked).toMatchObject({ ok: true, variant: "image", mediaType: "image", coverage: "whole_image", durationMs: null });
    expect(pathOf((picked as { url: string }).url)).toBe("/p1/1-360.jpeg");
    const small = selectMediaLookSource(photo([[1, 240, 426], [1, 180, 320], [3, 240, 426]]), { cover: false });
    expect(pathOf((small as { url: string }).url)).toBe("/p1/1-240.jpeg");
    const bare = selectMediaLookSource(photo([[3, 240, 426]]), { cover: false });
    expect(pathOf((bare as { url: string }).url)).toBe("/p1/original.jpeg");
    expect(selectMediaLookSource(photo([[1, 480, 854]], "image/gif"), { cover: false })).toMatchObject({ ok: true, coverage: "first_frame" });
    expect(selectMediaLookSource({ ...photo([]), mimetype: "audio/mpeg" }, { cover: false })).toEqual({ ok: false, reason: "unsupported_media" });
  });
});

describe("the URL and the answer a look may carry", () => {
  it("only a Fansly media CDN URL of an image", () => {
    expect(isMediaLookImageUrl(new URL(signed("a/b.jpeg")))).toBe(true);
    expect(isMediaLookImageUrl(new URL(signed("a/b.mp4")))).toBe(false);
    expect(isMediaLookImageUrl(new URL(signed("a/b.m3u8")))).toBe(false);
    expect(isMediaLookImageUrl(new URL("https://example.com/a/b.jpeg"))).toBe(false);
    expect(isMediaLookImageUrl(new URL("http://cdn3.fansly.com/a/b.jpeg"))).toBe(false);
  });

  it("names its subject by the look, and refuses a video answer without storing it", async () => {
    expect(mediaLookSubject(37)).toBe("look:37");
    expect(lookIdOfSubject("look:37")).toBe(37);
    for (const subject of ["look:", "look:0", "look:x", "desc:37", ""]) expect(lookIdOfSubject(subject), subject).toBeNull();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(isMediaLookImageAnswer("image/jpeg", jpeg)).toBe(true);
    expect(isMediaLookImageAnswer(null, jpeg)).toBe(true);
    expect(isMediaLookImageAnswer("video/mp4", jpeg)).toBe(false);
    expect(isMediaLookImageAnswer("application/octet-stream", Buffer.from("ftypisom"))).toBe(false);
    // The sink answers before it touches the database.
    const refused = await MEDIA_LOOK_SINK.store(null as never, { pageId: 1, subjectId: 37, workId: 1, contentType: "video/mp4", bytes: jpeg, hops: 1 });
    expect(refused).toEqual({ ok: false, failure: "not_an_image" });
    const plan = await createMediaLookModule().plan({ subject: "desc:37" } as never, {} as never);
    expect(plan).toMatchObject({ kind: "done", reason: "bad_subject" });
  });

  it("a closed fetch's failure as the look's closed code", () => {
    expect(mediaLookFetchFailure({ failure: "http_status", httpStatus: 403 }, "subject_terminal:403")).toBe("fetch_http_403");
    expect(mediaLookFetchFailure({ failure: "not_an_image", httpStatus: 200 }, "download_failed")).toBe("fetch_not_an_image");
    expect(mediaLookFetchFailure(null, "superseded")).toBe("fetch_closed_superseded");
    expect(mediaLookFetchFailure(null, null)).toBe("fetch_not_answered");
  });
});

describe("which file of a scheduled post an index names", () => {
  const OWN = "731275363459538945";
  const media = (id: string) => ({ id: `90${id}`, accountId: OWN, mediaId: `70${id}`, media: { id: `70${id}`, accountId: OWN, mimetype: "image/jpeg" } });
  const body = {
    scheduledPosts: [
      {
        postId: "100", status: 1, accountId: OWN,
        // A template as Fansly serves it: a JSON string; attachments by `pos`.
        postTemplate: JSON.stringify({
          attachments: [
            { pos: 2, contentId: "300", contentType: 42001 },
            { pos: 1, contentId: "909", contentType: 1 },
            { pos: 0, contentId: "801", contentType: 2 },
          ],
        }),
      },
      { postId: "101", status: 1, postTemplate: { attachments: [{ pos: 0, contentId: "802", contentType: 2 }, { pos: 1, contentId: "909", contentType: 1 }] } },
      { postId: "102", status: 3, postTemplate: { attachments: [{ pos: 0, contentId: "909", contentType: 1 }] } },
    ],
    aggregationData: {
      accountMedia: [media("1"), media("2"), media("9")],
      accountMediaBundles: [{ id: "801", accountId: OWN, bundleContent: [{ pos: 1, accountMediaId: "902" }, { pos: 0, accountMediaId: "901" }] }],
    },
  };

  it("an album's files in its order, then the single files; a goal or a poll is no file", () => {
    expect(findScheduledPostMedia(body, "100", 0)).toMatchObject({ ok: true, accountMediaRef: "901", mediaRef: "701", ownerAccountRef: OWN });
    expect(findScheduledPostMedia(body, "100", 1)).toMatchObject({ ok: true, accountMediaRef: "902" });
    expect(findScheduledPostMedia(body, "100", 2)).toMatchObject({ ok: true, accountMediaRef: "909", media: { mimetype: "image/jpeg" } });
    expect(findScheduledPostMedia(body, "100", 3)).toEqual({ ok: false, reason: "attachment_not_found" });
  });

  it("an album the read does not carry ends what can be counted; a post not waiting is not in the schedule", () => {
    expect(findScheduledPostMedia(body, "101", 0)).toEqual({ ok: false, reason: "media_not_in_read" });
    expect(findScheduledPostMedia(body, "101", 1)).toEqual({ ok: false, reason: "media_not_in_read" });
    expect(findScheduledPostMedia(body, "102", 0)).toEqual({ ok: false, reason: "not_in_schedule" });
    expect(findScheduledPostMedia(body, "999", 0)).toEqual({ ok: false, reason: "not_in_schedule" });
    expect(findScheduledPostMedia(null, "100", 0)).toEqual({ ok: false, reason: "not_in_schedule" });
  });
});
