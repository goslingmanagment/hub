// The purchase marks of a Fansly transcript with the client's word over the
// hub's stores (`livePpvContext` on a Fansly page, `live-ppv-fansly-v1`):
// money — the model must never re-sell what the fan bought, and a PPV the fan
// did not buy must read `not purchased`, not `unknown`.

import { describe, expect, it } from "vitest";

import { aiLivePpvContextSchema } from "../packages/contracts/src/routes.ts";
import type { FanslyPurchaseFacts } from "../packages/db/src/repositories/media-plane.ts";
import {
  assertLivePpvRequestShape,
  fanslyClientPurchasesOf,
  fanslyPaidAttachmentsOf,
  fanslyPpvStateWithClient,
  markFanslyPaidAttachments,
  type FanslyTranscriptAttachment,
} from "../apps/runtime/src/modules/ai/index.ts";

const AT = "2026-10-20T12:00:00.000Z";
const PAID = [{ flags: 1, price: 20_000 }];
const FREE = [{ flags: 2, price: 0 }];

/** A stored message whose attachments the media plane recorded with these permission rows. */
function stored(messageRef: string, attachments: Array<{ ref: string; as: "media" | "bundle"; permissions: unknown[] }>) {
  return {
    row: { messageRef, mediaMetadata: attachments.map((item) => ({ id: item.ref, type: item.as === "bundle" ? "bundle" : "video/mp4" })) },
    attachments: attachments.map((item) => item.as === "bundle"
      ? { ref: item.ref, as: "bundle" as const }
      : { ref: item.ref, as: "media" as const, media: { mediaType: 2, mimeType: "video/mp4" } }),
    offers: new Map(attachments.map((item, ordinal) => [item.ref, { ordinal, contentType: item.as === "bundle" ? 2 : 1, permissionEntries: item.permissions }])),
  };
}

function facts(over: Partial<FanslyPurchaseFacts> = {}): FanslyPurchaseFacts {
  return { orders: [], walks: new Map(), ordersPending: new Set(), ...over };
}

describe("the client's word over the hub's purchase state", () => {
  it("purchased from either side stands; else the client's answer; else the hub's", () => {
    expect(fanslyPpvStateWithClient("purchased", false)).toBe("purchased");
    expect(fanslyPpvStateWithClient("unknown", true)).toBe("purchased");
    expect(fanslyPpvStateWithClient("not purchased", true)).toBe("purchased");
    expect(fanslyPpvStateWithClient("unknown", false)).toBe("not purchased");
    expect(fanslyPpvStateWithClient("unknown", undefined)).toBe("unknown");
    expect(fanslyPpvStateWithClient("not purchased", undefined)).toBe("not purchased");
  });

  it("one item saying bought makes the media bought; prices become mills", () => {
    const client = fanslyClientPurchasesOf([
      { platformMessageId: "101", contentKind: "media", contentRef: "900", priceUsd: 20, purchased: false },
      { platformMessageId: "102", contentKind: "media", contentRef: "900", priceUsd: 20, purchased: true },
      { platformMessageId: "103", contentKind: "bundle", contentRef: "950", purchased: false },
    ]);
    expect(client.bought).toEqual(new Map([["media:900", true], ["bundle:950", false]]));
    expect(client.offers).toEqual(new Map([["101/media:900", 20_000], ["102/media:900", 20_000], ["103/bundle:950", null]]));
  });
});

describe("Fansly transcript marks", () => {
  const sold = stored("201", [{ ref: "900", as: "media", permissions: PAID }]);
  const bundle = stored("202", [{ ref: "950", as: "bundle", permissions: [{ flags: 1, price: 0, metadata: JSON.stringify({ 1: JSON.stringify({ price: 25_000 }) }) }] }]);
  const free = stored("203", [{ ref: "960", as: "media", permissions: FREE }]);
  const media = {
    attachments: new Map<string, FanslyTranscriptAttachment[]>([
      ["201", sold.attachments],
      ["202", bundle.attachments],
      ["203", free.attachments],
      // A socket message the archive has not caught: no price in the hub.
      ["204", [{ ref: "970", as: "media" as const, media: null }]],
    ]),
    offers: new Map([["201", sold.offers], ["202", bundle.offers], ["203", free.offers]]),
  };
  const input = { stored: [sold.row, bundle.row, free.row], live: [{ messageRef: "204", attachments: [{ contentType: 1, contentId: "970" }] }] };
  const bodies = () => new Map([["201", ["Video"]], ["202", ["Media Bundle: 2 Videos"]], ["203", ["Video"]], ["204", ["Media"]]]);

  it("without the client's word a PPV nobody bought reads unknown (the regression)", () => {
    const { paid } = fanslyPaidAttachmentsOf(input, media, undefined);
    const labels = bodies();
    const marked = markFanslyPaidAttachments(paid, labels, facts(), undefined);
    expect(labels.get("201")).toEqual(["Video - PPV $20.00, unknown"]);
    expect(labels.get("204")).toEqual(["Media"]);
    expect(marked).toEqual({ ppv: { paid: 2, purchased: 0, notPurchased: 0, unknown: 2 }, client: null });
  });

  it("the client's word: not bought, bought, a socket message's PPV, the hub's purchase kept", () => {
    const client = fanslyClientPurchasesOf([
      { platformMessageId: "201", contentKind: "media", contentRef: "900", priceUsd: 20, purchased: false },
      { platformMessageId: "202", contentKind: "bundle", contentRef: "950", priceUsd: 25, purchased: true },
      { platformMessageId: "204", contentKind: "media", contentRef: "970", priceUsd: 15, purchased: false },
      // A message older than the served window.
      { platformMessageId: "150", contentKind: "media", contentRef: "800", priceUsd: 10, purchased: false },
    ]);
    const { paid } = fanslyPaidAttachmentsOf(input, media, client);
    const labels = bodies();
    // The hub holds the fan's order of 900: the client's «not bought» does not undo it.
    const hub = facts({ orders: [{ mediaOfferRef: "900", bundleRef: null, orderType: 1 }] });
    const marked = markFanslyPaidAttachments(paid, labels, hub, client);
    expect(labels.get("201")).toEqual(["Video - PPV $20.00, purchased"]);
    expect(labels.get("202")).toEqual(["Media Bundle: 2 Videos - PPV $25.00, purchased"]);
    expect(labels.get("203")).toEqual(["Video"]);
    expect(labels.get("204")).toEqual(["Media - PPV $15.00, not purchased"]);
    expect(marked).toEqual({
      ppv: { paid: 3, purchased: 2, notPurchased: 1, unknown: 0 },
      client: { sent: 4, changed: 2, matched: 1, ignored: 1 },
    });
  });

  it("a failed purchase read (no facts) still takes the client's word", () => {
    const client = fanslyClientPurchasesOf([{ platformMessageId: "201", contentKind: "media", contentRef: "900", priceUsd: 20, purchased: false }]);
    const { paid } = fanslyPaidAttachmentsOf(input, media, client);
    const labels = bodies();
    markFanslyPaidAttachments(paid, labels, null, client);
    expect(labels.get("201")).toEqual(["Video - PPV $20.00, not purchased"]);
    expect(labels.get("202")).toEqual(["Media Bundle: 2 Videos - PPV $25.00, unknown"]);
  });
});

describe("livePpvContext's shape", () => {
  const fansly = { platformMessageId: "201", contentKind: "media" as const, contentRef: "900", priceUsd: 20, purchased: true };
  const onlyfans = { platformMessageId: "201", priceUsd: 20, purchased: true };

  it("takes Fansly items on a Fansly page and OnlyFans items on an OnlyFans page only", () => {
    const shape = (isFanslyPage: boolean, items: never[]) => () =>
      assertLivePpvRequestShape({ feature: "fast-reply", isFanslyPage, hasClientContext: false, items });
    expect(shape(true, [fansly] as never[])).not.toThrow();
    expect(shape(false, [onlyfans] as never[])).not.toThrow();
    expect(shape(true, [onlyfans] as never[])).toThrow(/Fansly page/);
    expect(shape(false, [fansly] as never[])).toThrow(/OnlyFans page/);
  });

  it("an attachment once per message; the same media in two messages is two items", () => {
    expect(aiLivePpvContextSchema.safeParse({ capturedAt: AT, items: [fansly, { ...fansly, platformMessageId: "202" }] }).success).toBe(true);
    expect(aiLivePpvContextSchema.safeParse({ capturedAt: AT, items: [fansly, fansly] }).success).toBe(false);
    expect(aiLivePpvContextSchema.safeParse({ capturedAt: AT, items: [{ ...fansly, contentKind: "post" }] }).success).toBe(false);
  });
});
