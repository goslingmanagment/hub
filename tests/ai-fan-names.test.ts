import type { AiStreamCapability } from "@agency_hub_core/contracts";
import { describe, expect, it } from "vitest";

import { assertFanCustomNameRequestShape, buildPrompt, type FanNames, type PromptFeature } from "../apps/runtime/src/modules/ai/index.ts";
import { BadRequestError } from "../apps/runtime/src/services/errors.ts";

// Reply and Fix name the fan (the owner, 2026-10-30): with no name in the
// prompt, Fix turned a draft's «Коко» into "Koko" for a fan saved as
// «Coco/37/France», and the sent "Koko" then fed every later answer.

const COCO: FanNames = { name: "Coco", username: "u532021575", customName: "Coco/37/France" };

function build(feature: PromptFeature, fanNames?: FanNames, draftPurpose?: "outreach") {
  return buildPrompt({
    feature,
    personality: { id: "test", name: "Test", content: "You are Test." } as never,
    transcript: "--- 2026-10-29 ---\n[22:50] Fan: mmm",
    fanSpendingData: "",
    fanSubscriptionData: "",
    fanDisplayName: "Coco",
    ...(fanNames === undefined ? {} : { fanNames }),
    draftText: "так приятно коко",
    ...(draftPurpose === undefined ? {} : { draftPurpose }),
  });
}

const uncached = (prompt: ReturnType<typeof build>) => prompt.userBlocks.filter((block) => block.cache !== "1h").map((block) => block.text).join("");
const cached = (prompt: ReturnType<typeof build>) => prompt.userBlocks.filter((block) => block.cache === "1h").map((block) => block.text).join("");

describe("the Fan section of Reply and Fix", () => {
  it.each(["fast-reply", "improve-draft"] satisfies PromptFeature[])("%s names the fan in the uncached part, the cached prefix stays the same", (feature) => {
    const named = build(feature, COCO);
    expect(uncached(named)).toContain("## Fan\n\nProfile name: Coco\nUsername: u532021575\nName the chatter saved for this fan: Coco/37/France");
    expect(cached(named)).toBe(cached(build(feature)));
    expect(named.user).toContain("- His name:");
  });

  it("leaves the section out when nothing is known, and a username that repeats the name", () => {
    expect(build("fast-reply").user).not.toContain("## Fan\n");
    expect(build("fast-reply", { name: " ", username: "", customName: undefined }).user).not.toContain("## Fan\n");
    expect(build("improve-draft", { name: "coco", username: "Coco" }).user).toContain("## Fan\n\nProfile name: coco\n\n## Your Task");
  });

  it("is not repeated on Fix of a mass message, whose task names the fan", () => {
    expect(build("improve-draft", COCO, "outreach").user).not.toContain("## Fan\n");
  });
});

describe("fanCustomName in the body", () => {
  type Shape = Parameters<typeof assertFanCustomNameRequestShape>[0];
  const lane: Shape = {
    feature: "improve-draft",
    platform: "onlyfans",
    hasClientContext: false,
    capabilities: new Set<AiStreamCapability>(["fan-custom-name-v1"]),
    fanCustomName: "Coco/37/France",
  };
  const reason = (input: Partial<Shape>) => {
    try {
      assertFanCustomNameRequestShape({ ...lane, ...input });
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestError);
      return (error as BadRequestError).reason;
    }
  };

  it("is admitted on Reply, Fix, Hi and Ping of an OnlyFans page under the capability", () => {
    for (const feature of ["fast-reply", "improve-draft", "hi-greeting", "ping"] satisfies PromptFeature[]) {
      expect(reason({ feature })).toBeNull();
    }
  });

  it("is refused where it can never be read", () => {
    expect(reason({ feature: "coach-chat" })).toBe("fan_custom_name_not_allowed");
    expect(reason({ hasClientContext: true })).toBe("fan_custom_name_not_allowed");
    expect(reason({ platform: "fansly" })).toBe("fan_custom_name_not_allowed");
    expect(reason({ capabilities: undefined })).toBe("capability_required");
    expect(reason({ feature: "coach-chat", platform: "fansly", capabilities: undefined, fanCustomName: undefined })).toBeNull();
  });
});
