import { describe, expect, it } from "vitest";

import { assertDraftPurposeRequestShape, buildPrompt, type PromptFeature } from "../apps/runtime/src/modules/ai/index.ts";

// chat-extension «Рассылка» (outreach-fix-v1): Fix rewrites the model's mass message for one fan.

const MASS = "ok this one is SPECIAL, first time with a DRAGON. 6 minutes, full post here";

function build(draftPurpose?: "outreach") {
  return buildPrompt({
    feature: "improve-draft",
    personality: { id: "test", name: "Test", content: "You are Test." } as never,
    transcript: "--- 2026-10-23 ---\n[10:00] Fan: hi",
    fanSpendingData: "",
    fanSubscriptionData: "",
    fanDisplayName: "Gordon",
    draftText: MASS,
    ...(draftPurpose === undefined ? {} : { draftPurpose }),
  });
}

describe("Fix for a mass message", () => {
  it("asks for a personal version of the mass message with the content attached, in the uncached task only", () => {
    const outreach = build("outreach");
    const plain = build();
    const task = outreach.user.slice(outreach.user.lastIndexOf("## Your Task"));
    expect(task).toContain("mass message");
    expect(task).toContain("do not send him to a post, a link");
    expect(outreach.user).toContain(MASS);
    // The cached prefix is Fix's own, byte for byte; only the task differs.
    const cached = (prompt: ReturnType<typeof build>) => prompt.userBlocks.filter((block) => block.cache === "1h").map((block) => block.text).join("");
    expect(cached(outreach)).toBe(cached(plain));
    expect(plain.user).toContain("Rewrite the current draft into a stronger in-character message that still means the same thing");
    expect(plain.user).not.toContain("mass message");
  });

  it.each(["fast-reply", "ping", "hi-greeting", "coach-chat"] satisfies PromptFeature[])("%s refuses draftPurpose", (feature) => {
    expect(() => assertDraftPurposeRequestShape(feature, { draftPurpose: "outreach" })).toThrow(/does not accept draftPurpose/);
    expect(() => assertDraftPurposeRequestShape(feature, {})).not.toThrow();
  });

  it("Fix takes it", () => {
    expect(() => assertDraftPurposeRequestShape("improve-draft", { draftPurpose: "outreach" })).not.toThrow();
  });

  it("holds no long dash", () => {
    expect(build("outreach").user.slice(build("outreach").user.lastIndexOf("## Your Task"))).not.toMatch(/[—–]/);
  });
});
