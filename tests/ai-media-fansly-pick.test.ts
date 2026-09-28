import { describe, expect, it } from "vitest";

import { pickFanslyImageLocation } from "../apps/runtime/src/services/ai-media-describe/fansly-source.ts";

// Fansly media: `locations` is the original; variant type 1 is a resize,
// type 3 a blurred copy (the shapes below are the ones seen in production
// captures on 2026-09-28).
const at = (tag: string) => [{ locationId: "1", location: `https://cdn3.fansly.com/${tag}.jpeg?Signature=s` }];
const variant = (type: number, width: number, height: number, tag: string) => ({
  type, mimetype: "image/jpeg", width, height, locations: at(tag),
});

describe("pickFanslyImageLocation", () => {
  it("takes a small photo's original, never its blurred copy", () => {
    const only = { mimetype: "image/jpeg", width: 636, height: 226, locations: at("orig"), variants: [variant(3, 636, 226, "blur")] };
    expect(pickFanslyImageLocation(only)).toContain("/orig.jpeg");
    const tie = {
      mimetype: "image/jpeg", width: 674, height: 310, locations: at("orig"),
      variants: [variant(1, 522, 240, "r240"), variant(3, 522, 240, "blur")],
    };
    expect(pickFanslyImageLocation(tie)).toContain("/orig.jpeg");
  });

  it("takes the smallest resize covering 1024 px of a large photo", () => {
    const big = {
      mimetype: "image/jpeg", width: 4284, height: 5712, locations: at("orig"),
      variants: [variant(1, 1080, 1440, "r1440"), variant(1, 720, 960, "r960"), variant(1, 240, 320, "r320"), variant(3, 240, 320, "blur")],
    };
    expect(pickFanslyImageLocation(big)).toContain("/r1440.jpeg");
  });

  it("never picks a blurred poster for a video", () => {
    const video = {
      mimetype: "video/mp4", width: 1080, height: 1920, locations: at("stream"),
      variants: [variant(1, 720, 1280, "poster"), variant(3, 1080, 1920, "blur")],
    };
    expect(pickFanslyImageLocation(video)).toContain("/poster.jpeg");
  });
});
