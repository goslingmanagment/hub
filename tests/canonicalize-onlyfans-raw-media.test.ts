// OnlyFans file facts for `raw_media`. OF has no filename anywhere, so the
// creation time and the full rendition's size are what matches a post to a file.
import { describe, expect, it } from "vitest";

import { onlyFansRawMediaDrafts } from "../apps/runtime/src/services/canonicalize/raw-media.ts";

const observation = {
  id: 7, source: "ofapi_capture", producer: "test", platform: "onlyfans", accountId: 8,
  kind: "ofapi.posts_page.v1", payload: {}, observedAt: null, receivedAt: new Date("2026-10-30T00:00:00Z"),
};

describe("OnlyFans raw media drafts", () => {
  it("keep OF's createdAt and the full rendition's dimensions and bytes, never a URL", () => {
    const [draft] = onlyFansRawMediaDrafts(observation, [{
      id: 4775743899, type: "video", duration: 12.5, createdAt: "2026-10-29T19:02:51+00:00",
      files: {
        full: { url: "https://cdn.example/full.mp4", width: 1080, height: 1920, size: 73400320 },
        preview: { url: "https://cdn.example/preview.jpg", width: 360, height: 640, size: 20000 },
      },
    }]);
    expect(draft!.data).toMatchObject({
      mediaRef: "4775743899", providerType: "video", durationMs: 12500,
      width: 1080, height: 1920, byteSize: 73400320, originalWidth: null, originalHeight: null,
      createdAtPlatform: "2026-10-29T19:02:51.000Z",
    });
    expect(JSON.stringify(draft!.data)).not.toContain("cdn.example");
  });

  it("leave what OF did not serve as null", () => {
    const [draft] = onlyFansRawMediaDrafts(observation, [{ id: "1", type: "photo", createdAt: "yesterday", files: {} }]);
    expect(draft!.data).toMatchObject({ width: null, height: null, byteSize: null, createdAtPlatform: null });
  });
});
