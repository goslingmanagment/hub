import { describe, expect, it } from "vitest";
// Boundary rule (eslint no-restricted-imports): reach the migrated prompt unit
// through the ai module index, not a deep prompts/* path.
import {
  FEATURE_POLICIES,
  DEFAULT_FEATURE_MODELS,
  DEFAULT_FEATURE_REASONING,
} from "../apps/runtime/src/modules/ai/index.ts";

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
    expect(DEFAULT_FEATURE_MODELS["coach-chat"]).toBeTruthy();
    expect(DEFAULT_FEATURE_REASONING["coach-chat"]).toBe("medium");
  });

  it("moves the bio decision into policy", () => {
    expect(FEATURE_POLICIES["hi-greeting"].includesFanBio).toBe(true);
    expect(FEATURE_POLICIES["help-me"].includesFanBio).toBe(true); // owner: absence was a bug
    expect(FEATURE_POLICIES["fast-reply"].includesFanBio).toBe(false);
  });
});
