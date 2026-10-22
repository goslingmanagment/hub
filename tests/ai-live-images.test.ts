import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  QUICK_FEATURE_MEDIA_NOTE_LIMITS,
  applyOnlyFansMediaNotes,
  liveImageLabels,
  liveImagesGuide,
  prepareLiveImages,
  type MediaNoteItem,
  type TranscriptMessage,
} from "../apps/runtime/src/modules/ai/index.ts";
import { buildAnthropicGatewayStreamRequest } from "../apps/runtime/src/services/ai-gateway-anthropic.ts";

// chat-extension live images: the fan's newest photos ride with one
// generation as images. The labels name them, a refused photo stays out, and
// the bytes reach the provider after every text block.

vi.mock("../apps/runtime/src/services/effective-config.ts", () => ({
  loadEffectiveConfig: async () => ({ aiLiveImagesEnabled: true }),
}));

const sharp = createRequire(path.resolve("apps/runtime/package.json"))("sharp") as (
  input: { create: Record<string, unknown> },
) => { jpeg(): { toBuffer(): Promise<Buffer> } };
const T0 = Date.parse("2026-10-22T06:00:00Z");

async function jpeg(width: number, height: number): Promise<string> {
  const bytes = await sharp({ create: { width, height, channels: 3, background: "#c33" } }).jpeg().toBuffer();
  return bytes.toString("base64");
}

function app(refused: string[] = []) {
  return {
    db: {
      execute: async () => ({ rows: refused.map((ref) => ({ media_ref: ref, variant: "full", status: "refused", description: null })) }),
    },
    config: {},
    logger: { warn: () => undefined },
  } as never;
}

const image = (mediaId: string, minute: number, data: string) => ({
  platformMessageId: `90${minute}`,
  mediaId,
  sentAt: new Date(T0 + minute * 60_000).toISOString(),
  mediaType: "image/jpeg" as const,
  data,
});

describe("live images", () => {
  it("numbers the photos oldest first and leaves out a refused or unreadable one", async () => {
    const photo = await jpeg(1600, 1200);
    const { attachments, manifest } = await prepareLiveImages(app(["66"]), {
      pageId: 1,
      platform: "onlyfans",
      images: [
        image("77", 3, photo),
        image("66", 2, photo),
        image("55", 1, photo),
        image("44", 4, Buffer.from("not an image").toString("base64")),
      ],
    });
    expect(attachments.map((item) => [item.n, item.mediaId])).toEqual([[1, "55"], [2, "77"]]);
    // Re-encoded within the describer's bounds.
    expect(attachments[0]!.image).toMatchObject({ mediaType: "image/jpeg", width: 1024, height: 768 });
    expect(manifest).toMatchObject({ received: 4, attached: 2, refused: 1, unreadable: 1 });
  });

  it("names an attached photo in its label and the rest by time", async () => {
    const photo = await jpeg(800, 600);
    const { attachments } = await prepareLiveImages(app(), {
      pageId: 1,
      platform: "onlyfans",
      images: [image("55", 1, photo), image("77", 3, photo)],
    });
    const messages: TranscriptMessage[] = [{ id: "901", createdAtMs: T0 + 60_000, sender: "Fan", text: "me", labels: ["[Photo]"] }];
    const items: MediaNoteItem[] = [{
      n: 1, placement: "inline", messageId: "901", sentAt: T0 + 60_000, sender: "fan", kind: "photo", mediaId: "55", paid: false,
    }];
    const applied = applyOnlyFansMediaNotes({
      messages,
      items,
      descriptions: [{ mediaRef: "55", variant: "full", status: "described", description: "A red square." }],
      limits: QUICK_FEATURE_MEDIA_NOTE_LIMITS,
      attached: liveImageLabels(attachments),
    });
    expect(applied.messages[0]!.labels).toEqual(["[Photo #1: attached image 1]"]);
    expect(applied.manifest).toMatchObject({ attached: 1, described: 0 });

    const guide = liveImagesGuide(attachments, new Set(["55"]));
    expect(guide).toContain("as images 1–2");
    expect(guide).toContain("Image 2 is a photo the fan sent at [06:03] on 2026-10-22.");
    expect(guide).not.toContain("Image 1 is");
  });

  it("sends the photos as base64 after every text block", () => {
    const request = buildAnthropicGatewayStreamRequest({
      clientRequestId: "00000000-0000-4000-8000-000000000000",
      feature: "fast-reply",
      pageLabel: "lora-of",
      platform: "onlyfans",
      platformUserId: "1",
      model: "anthropic:claude-opus-5-5",
      reasoningEffort: "low",
      isRegeneration: false,
      prompt: { systemBlocks: [{ text: "system", cache: "5m" }], userBlocks: [{ text: "user", cache: "none" }] },
      inlineImages: [{ mediaType: "image/jpeg", data: "AAAA", width: 10, height: 10, sha256: "x" }],
    } as never);
    expect(request.messages[0].content.at(-1)).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } });
  });
});
