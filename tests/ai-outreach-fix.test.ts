import { describe, expect, it } from "vitest";

import { assertDraftPurposeRequestShape, buildPrompt, type PromptFeature } from "../apps/runtime/src/modules/ai/index.ts";

// chat-extension «Рассылка» (outreach-fix-v1): Fix rewrites the model's mass message for one fan.

const MASS = "ok this one is SPECIAL, first time with a DRAGON. 6 minutes, full post here";

function build(draftPurpose?: "outreach", fanCustomName?: string) {
  return buildPrompt({
    feature: "improve-draft",
    personality: { id: "test", name: "Test", content: "You are Test." } as never,
    transcript: "--- 2026-10-23 ---\n[10:00] Fan: hi",
    fanSpendingData: "",
    fanSubscriptionData: "",
    fanDisplayName: "tomcat88",
    ...(fanCustomName === undefined ? {} : { fanCustomName }),
    draftText: MASS,
    ...(draftPurpose === undefined ? {} : { draftPurpose }),
  });
}

describe("Fix for a mass message", () => {
  it("asks for a personal version of the mass message that keeps its link, in the uncached task only", () => {
    const outreach = build("outreach");
    const plain = build();
    const task = outreach.user.slice(outreach.user.lastIndexOf("## Your Task"));
    expect(task).toContain("mass message");
    // The draft's link is its ask (a post to tip): it is copied as written, never dropped for an attachment.
    expect(task).toContain("copy every link character for character");
    expect(task).toContain("When the draft has no link, the content is attached");
    expect(outreach.user).toContain(MASS);
    // The cached prefix is Fix's own, byte for byte; only the task differs.
    const cached = (prompt: ReturnType<typeof build>) => prompt.userBlocks.filter((block) => block.cache === "1h").map((block) => block.text).join("");
    expect(cached(outreach)).toBe(cached(plain));
    expect(plain.user).toContain("Rewrite the current draft into a stronger in-character message that still means the same thing");
    expect(plain.user).not.toContain("mass message");
  });

  it("names the fan in the task: his username and the name the chatter saved, which the transcript may not show", () => {
    const outreach = build("outreach", "✅Tomas/UK/26");
    const task = outreach.user.slice(outreach.user.lastIndexOf("## Your Task"));
    expect(task).toContain("Fan username: tomcat88");
    expect(task).toContain("Name the chatter saved for this fan: ✅Tomas/UK/26");
    expect(task).toContain('never "hey you"');
    // A mass message: personal in how she talks to him, never a claim the content is his.
    expect(task).toContain("never say or hint that it was made for him");
    expect(build("outreach").user).not.toContain("Name the chatter saved");
    // Plain Fix names the fan in its own Fan section (`fanNames`, ai-fan-names.test.ts), never in the task.
    expect(build(undefined, "✅Tomas/UK/26").user).not.toContain("Tomas");
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
