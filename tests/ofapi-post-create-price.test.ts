import { describe, expect, it } from "vitest";

import { ofapiActionSchema } from "@agency_hub_core/contracts";

import { ofapiPublishingRequest } from "../apps/runtime/src/services/ofapi-actions-publishing.ts";

// A price at creation is not in OnlyFansAPI's documented post schema (wall
// posts spec §6, §12). The owner's check of it goes as a saved-for-later post
// only: if OnlyFans dropped the price, a post fans see would be free.

const base = { action: "post_create", pageId: 1, text: "check", mediaFiles: ["4100001"], reuseProviderOperation: false } as const;

describe("OnlyFans post_create: price at creation", () => {
  it("is accepted only on a saved-for-later post with media, in whole dollars from $3 to $100", () => {
    expect(ofapiActionSchema.safeParse({ ...base, saveForLater: true, priceCents: 500 }).success).toBe(true);
    expect(ofapiActionSchema.safeParse({ ...base, priceCents: 500 }).success).toBe(false);
    expect(ofapiActionSchema.safeParse({ ...base, scheduledDate: "2030-01-01T00:00:00Z", priceCents: 500 }).success).toBe(false);
    expect(ofapiActionSchema.safeParse({ ...base, mediaFiles: undefined, saveForLater: true, priceCents: 500 }).success).toBe(false);
    expect(ofapiActionSchema.safeParse({ ...base, saveForLater: true, priceCents: 250 }).success).toBe(false);
    expect(ofapiActionSchema.safeParse({ ...base, saveForLater: true, priceCents: 550 }).success).toBe(false);
    expect(ofapiActionSchema.safeParse({ ...base, saveForLater: true, priceCents: 10100 }).success).toBe(false);
  });

  it("goes to OnlyFansAPI as a dollar price beside the saved-for-later flag", () => {
    const command = ofapiActionSchema.parse({ ...base, saveForLater: true, priceCents: 1200 });
    const request = ofapiPublishingRequest(command as never, "acct_1");
    expect(request).toMatchObject({ method: "POST", path: "/acct_1/posts", resultKind: "queue" });
    expect(request.body).toMatchObject({ saveForLater: true, price: 12, mediaFiles: [4100001] });
  });
});
