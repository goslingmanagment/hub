import { describe, expect, it } from "vitest";

import {
  AUTOMATED_MESSAGE_LABEL,
  MEDIA_NOTES_GUIDE,
  buildPrompt,
  markAutomatedMessages,
  type PromptFeature,
  type TranscriptMessage,
} from "../apps/runtime/src/modules/ai/index.ts";

// Prod prompts, 2026-10-20..23: the guide to the numbered media labels closed
// the transcript (2066 prompts), and Hi's welcome messages went unmarked.

const IMAGE_NOTE_FEATURES: PromptFeature[] = [
  "fast-reply",
  "improve-draft",
  "help-me",
  "chat-review",
  "ping",
  "hi-greeting",
  "coach-chat",
  "voice-script",
];

function build(feature: PromptFeature, mediaNotesGuide: boolean) {
  return buildPrompt({
    feature,
    personality: { id: "test", name: "Test", content: "You are Test." } as never,
    transcript: "--- 2026-10-23 ---\n[10:00] Fan: [Photo #1] hi",
    fanSpendingData: "",
    fanSubscriptionData: "",
    fanDisplayName: "fan",
    draftText: "a draft",
    chatterQuestion: "what now?",
    pingSegment: "segment-a",
    mediaNotesGuide,
  });
}

describe("the media notes guide", () => {
  it.each(IMAGE_NOTE_FEATURES)("%s: rides the cached part before the conversation, never inside it", (feature) => {
    const prompt = build(feature, true);
    const cached = prompt.userBlocks.filter((block) => block.cache === "1h").map((block) => block.text).join("");
    expect(cached).toContain(MEDIA_NOTES_GUIDE);
    const transcript = /<transcript>\n([\s\S]*?)\n<\/transcript>/.exec(prompt.user)?.[1];
    expect(transcript).toBe("--- 2026-10-23 ---\n[10:00] Fan: [Photo #1] hi");
    expect(build(feature, false).user).not.toContain("Image notes:");
  });

  it("holds no long dash", () => {
    expect(MEDIA_NOTES_GUIDE).not.toMatch(/[—–]/);
  });
});

describe("markAutomatedMessages", () => {
  const message = (id: string, sender: "Fan" | "Model", labels: string[] = []): TranscriptMessage => ({
    id,
    createdAtMs: 0,
    sender,
    text: "hi",
    labels,
  });

  it("marks the named Model messages first, once, and never a fan's", () => {
    const messages = [
      message("1", "Model", ["[Photo #1]"]),
      message("2", "Fan"),
      message("3", "Model", [AUTOMATED_MESSAGE_LABEL]),
      message("4", "Model"),
    ];
    const marked = markAutomatedMessages(messages, new Set(["1", "2", "3"]));
    expect(marked.marked).toBe(1);
    expect(marked.messages.map((item) => item.labels)).toEqual([
      [AUTOMATED_MESSAGE_LABEL, "[Photo #1]"],
      [],
      [AUTOMATED_MESSAGE_LABEL],
      [],
    ]);
  });
});
