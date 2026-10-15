import { describe, expect, it } from "vitest";
// Boundary rule (eslint no-restricted-imports): reach the migrated prompt unit
// through the ai module index, not a deep prompts/* path.
import {
  FEATURE_POLICIES,
  DEFAULT_FEATURE_MODELS,
  DEFAULT_FEATURE_REASONING,
  OPERATION_FEATURES,
} from "../apps/runtime/src/modules/ai/index.ts";

describe("text feature model defaults", () => {
  it.each(OPERATION_FEATURES)("routes %s to Opus 5.5 at high effort through its model delegation", (feature) => {
    expect(DEFAULT_FEATURE_MODELS[FEATURE_POLICIES[feature].modelFeature]).toBe("anthropic:claude-opus-5-5");
    expect(DEFAULT_FEATURE_REASONING[FEATURE_POLICIES[feature].modelFeature]).toBe("high");
  });

  it("routes fan-notes-fill through its own model row", () => {
    expect(FEATURE_POLICIES["fan-notes-fill"].modelFeature).toBe("fan-notes-fill");
  });
});

describe("coach-chat feature policy", () => {
  it("registers coach-chat with the agreed policy", () => {
    const p = FEATURE_POLICIES["coach-chat"];
    expect(p).toMatchObject({
      surface: "panel-tab",
      promptMode: "analysis",
      timeoutBucket: "quick",
      messageCountBucket: "quick",
      modelFeature: "coach-chat",
      includesEarnings: true,
      usesFanProfile: true,
      includesFanBio: true,
      supportsReplyMode: false,
      supportsReplyTone: false,
      requiresDraft: false,
      usesPingSegment: false,
    });
    expect(DEFAULT_FEATURE_MODELS["coach-chat"]).toBe("anthropic:claude-opus-5-5");
    expect(DEFAULT_FEATURE_REASONING["coach-chat"]).toBe("high");
  });

  it("moves the bio decision into policy", () => {
    expect(FEATURE_POLICIES["hi-greeting"].includesFanBio).toBe(true);
    expect(FEATURE_POLICIES["help-me"].includesFanBio).toBe(true); // owner: absence was a bug
    expect(FEATURE_POLICIES["fast-reply"].includesFanBio).toBe(false);
    expect(FEATURE_POLICIES.ping.includesFanBio).toBe(true); // Decision 290: the bio is a ping hook
  });
});
