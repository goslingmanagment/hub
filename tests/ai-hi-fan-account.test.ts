import { aiFeatureStreamBodySchema, type AiStreamCapability } from "@agency_hub_core/contracts";
import { describe, expect, it } from "vitest";

import {
  assertHiFanAccountRequestShape,
  fanslyFanIdentity,
  loadFanslyFanIdentity,
  type FanslyFanRecord,
} from "../apps/runtime/src/modules/ai/index.ts";
import { BadRequestError } from "../apps/runtime/src/services/errors.ts";

// Hi on Fansly: the fan's account as the page loaded it (`fanAccount`,
// `hi-fan-account-v1`) fills what the hub's record of a new follower lacks.

const HUB: FanslyFanRecord = { username: "hubuser", displayName: "Hub Name", savedName: "Saved", about: "hub bio" };
const PAGE = { username: "pageuser", displayName: "Page Name", about: "page bio" };

function hi(record: FanslyFanRecord | null, page?: typeof PAGE | Partial<typeof PAGE>, includesFanBio = true) {
  return fanslyFanIdentity({ feature: "hi-greeting", includesFanBio, record, page });
}

describe("the fan's identity with the page's account", () => {
  it("keeps every value the hub holds", () => {
    const merged = hi(HUB, PAGE);
    const { fromPage, ...identity } = merged;
    const { fromPage: _none, ...hubOnly } = hi(HUB);
    expect(identity).toEqual(hubOnly);
    expect(fromPage).toEqual({ username: false, displayName: false, bio: false });
  });

  it("fills only the values the hub lacks, an empty one included", () => {
    const merged = hi({ username: "hubuser", displayName: null, savedName: null, about: "   " }, PAGE);
    expect(merged.fanDisplayName).toBe("Page Name");
    expect(merged.nameSource).toBe("display_name");
    expect(merged.fanUsername).toBe("hubuser");
    expect(merged.fanBio).toBe("page bio");
    expect(merged.fanCustomName).toBeUndefined();
    expect(merged.fromPage).toEqual({ username: false, displayName: true, bio: true });
  });

  it("names a fan the hub holds no account of, rather than the fallback", () => {
    // Hi's opener draw reads `nameSource !== "fallback"` as a known name.
    expect(hi(null).nameSource).toBe("fallback");
    const merged = hi(null, { username: "John__2002" });
    expect(merged.nameSource).toBe("username");
    expect(merged.fanDisplayName).toBe("John__2002");
    expect(merged.fanUsername).toBe("John__2002");
    expect(merged.fanCustomName).toBeUndefined();
  });

  it("trims and bounds the page's values as the hub's, and drops a blank one", () => {
    const merged = hi(null, { username: "   ", displayName: "  Jayden  ", about: ` ${"x".repeat(6_000)} ` });
    expect(merged.fanDisplayName).toBe("Jayden");
    expect(merged.fanUsername).toBeUndefined();
    expect(merged.fanBio).toHaveLength(5_000);
    expect(hi(null, { displayName: "y".repeat(300) }).fanDisplayName).toHaveLength(200);
    expect(merged.fromPage).toEqual({ username: false, displayName: true, bio: true });
  });

  it("takes the page's bio only where the feature's policy reads one", () => {
    const merged = hi(null, PAGE, false);
    expect(merged.fanBio).toBeUndefined();
    expect(merged.fromPage.bio).toBe(false);
  });

  it("records which values came from the page only on a request that sent the account", async () => {
    const app = {
      db: {
        execute: async () => ({
          rows: [{
            username: "hubuser",
            display_name: null,
            page_alias: null,
            about: null,
            page_alias_synced_at: null,
            account_lookup_at: null,
          }],
        }),
      },
    } as never;
    const input = { pageId: 10, fanRef: "1", feature: "hi-greeting" as const, includesFanBio: true };
    const without = await loadFanslyFanIdentity(app, input);
    expect(without.manifest).not.toHaveProperty("fromPage");
    expect(without.identity).not.toHaveProperty("fromPage");
    const withPage = await loadFanslyFanIdentity(app, { ...input, fanAccount: { displayName: "Armand" } });
    expect(withPage.identity.fanDisplayName).toBe("Armand");
    expect(withPage.manifest).toMatchObject({
      known: true,
      name: "display_name",
      fromPage: { username: false, displayName: true, bio: false },
    });
  });
});

describe("where fanAccount is refused", () => {
  const capable = new Set<AiStreamCapability>(["hi-fan-account-v1"]);
  const lane = {
    feature: "hi-greeting" as const,
    isFanslyRequest: true,
    hasClientContext: false,
    capabilities: capable as ReadonlySet<AiStreamCapability>,
    fanAccount: { username: "adrIann__" },
  };
  const reason = (input: Partial<typeof lane> & { feature?: "hi-greeting" | "fast-reply" }) => {
    try {
      assertHiFanAccountRequestShape({ ...lane, ...input });
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestError);
      return (error as BadRequestError).reason;
    }
  };

  it("admits it on Hi, on a Fansly page, without clientContext, under the capability", () => {
    expect(reason({})).toBeNull();
  });

  it("refuses it on another feature, beside clientContext, on OnlyFans and without the capability", () => {
    expect(reason({ feature: "fast-reply" })).toBe("fan_account_not_allowed");
    expect(reason({ hasClientContext: true })).toBe("fan_account_not_allowed");
    expect(reason({ isFanslyRequest: false })).toBe("fan_account_not_allowed");
    expect(reason({ capabilities: new Set<AiStreamCapability>(["hi-start-proof-v1"]) })).toBe("capability_required");
    expect(reason({ capabilities: undefined })).toBe("capability_required");
  });

  it("passes a request without it on any lane", () => {
    expect(reason({ feature: "fast-reply", isFanslyRequest: false, hasClientContext: true, capabilities: undefined, fanAccount: undefined }))
      .toBeNull();
  });

  it("is bounded and strict in the contract", () => {
    const body = { conversationRef: "1", personaKey: "p" };
    const parse = (fanAccount: unknown) => aiFeatureStreamBodySchema.safeParse({ ...body, fanAccount });
    const ofField = (fanAccount: unknown) =>
      (parse(fanAccount).error?.issues ?? []).filter((issue) => issue.path[0] === "fanAccount");
    expect(ofField({ username: "a", displayName: "b", about: "c" })).toEqual([]);
    expect(ofField(undefined)).toEqual([]);
    for (const bad of [{ username: "a".repeat(201) }, { about: "a".repeat(5_001) }, { avatar: "x" }]) {
      expect(ofField(bad)).not.toEqual([]);
    }
  });
});
