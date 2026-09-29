import { describe, expect, it } from "vitest";

import {
  cloudFrontExpiry,
  pickFanslyImageLocation,
} from "../apps/runtime/src/services/ai-media-describe/fansly-source.ts";

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

// A LANDSCAPE photo behind CloudFront signed URLs, shaped as the DM captures
// serve it (the same fixture ai-media-fansly.integration.test.ts journals).
const FAN = "700700700";

function policyUrl(host: string, epochSeconds: number, tag: string) {
  const policy = Buffer.from(JSON.stringify({
    Statement: [{ Resource: `https://${host}/*`, Condition: { DateLessThan: { "AWS:EpochTime": epochSeconds } } }],
  })).toString("base64").replace(/\+/g, "-").replace(/=/g, "_").replace(/\//g, "~");
  return `https://${host}/${tag}.jpeg?ngsw-bypass=true&Policy=${policy}&Key-Pair-Id=K1&Signature=sig`;
}

function photoMedia(id: string, expiresAt: number, price = 0) {
  return {
    id,
    accountId: FAN,
    mediaId: `file-${id}`,
    previewId: null,
    permissions: { permissionFlags: [{ price }] },
    media: {
      id: `file-${id}`,
      type: 1,
      mimetype: "image/jpeg",
      width: 4032,
      height: 2268,
      locations: [{ locationId: "1", location: policyUrl("cdn3.fansly.com", expiresAt, `${id}-orig`) }],
      variants: [
        { type: 1, mimetype: "image/jpeg", width: 1920, height: 1080, locations: [{ locationId: "1", location: policyUrl("cdn3.fansly.com", expiresAt, `${id}-1080`) }] },
        { type: 1, mimetype: "image/jpeg", width: 1280, height: 720, locations: [{ locationId: "1", location: policyUrl("cdn3.fansly.com", expiresAt, `${id}-720`) }] },
        { type: 1, mimetype: "image/jpeg", width: 854, height: 480, locations: [{ locationId: "1", location: policyUrl("cdn3.fansly.com", expiresAt, `${id}-480`) }] },
      ],
    },
  };
}

describe("Fansly source helpers", () => {
  it("picks the smallest image variant covering 1024 px and decodes CloudFront expiry", () => {
    const media = photoMedia("m", 1_900_000_000).media;
    expect(pickFanslyImageLocation(media)).toContain("m-720");
    expect(cloudFrontExpiry(pickFanslyImageLocation(media)!)?.getTime()).toBe(1_900_000_000_000);
    const video = {
      mimetype: "video/mp4",
      variants: [
        { mimetype: "image/jpeg", width: 480, height: 854, locations: [{ location: "https://cdn3.fansly.com/poster.jpeg" }] },
        { mimetype: "application/vnd.apple.mpegurl", width: 2160, height: 3840, locations: [{ location: "https://cdn3.fansly.com/v.m3u8" }] },
      ],
    };
    expect(pickFanslyImageLocation(video)).toBe("https://cdn3.fansly.com/poster.jpeg");
  });
});
