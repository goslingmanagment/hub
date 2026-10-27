import type { AiStreamCapability } from "@agency_hub_core/contracts";
import { describe, expect, it } from "vitest";

import {
  COACH_PROMPT_MAX_CHARS,
  buildPrompt,
  describeCoachSplitOutput,
  formatTranscript,
  transcriptLineOffsets,
  transcriptMessagesOmittedByBudget,
  type CoachDepthInput,
  type TranscriptMessage,
} from "../apps/runtime/src/modules/ai/index.ts";
import { deepTranscriptRowsOf, mayReadDeepTranscript } from "../apps/runtime/src/services/ai-transcript-depth.ts";

// chat-extension `coach-depth-v1`: Coach reads as deep as the chatter chooses,
// is told how deep its transcript reaches, and may end its answer with a
// ```more note when older history would change its advice. A released client
// (no token) keeps its depth, its cost and its prompt.

const HOUR = 3_600_000;
const START = Date.UTC(2026, 2, 14, 9, 0);

function coachRequest(capabilities: AiStreamCapability[] | undefined, platform: "onlyfans" | "fansly" = "onlyfans") {
  return {
    feature: "coach-chat",
    platform,
    summaryMode: undefined,
    capabilities: capabilities === undefined ? undefined : new Set(capabilities),
  };
}

function messages(count: number, textChars = 40): TranscriptMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: String(100_000 + index),
    createdAtMs: START + index * HOUR,
    sender: index % 2 === 0 ? "Fan" as const : "Model" as const,
    text: `message ${index} ${"x".repeat(textChars)}`,
    labels: [],
  }));
}

function depthOf(list: TranscriptMessage[], storedCount: number | null, oldestAtMs: number | null): CoachDepthInput {
  const offsets = transcriptLineOffsets({ transcript: formatTranscript(list), messages: list });
  if (offsets === null) {
    throw new Error("test transcript does not render from its messages");
  }
  return { lines: offsets.map((offset, index) => ({ offset, atMs: list[index]!.createdAtMs })), storedCount, oldestAtMs };
}

function coachPrompt(list: TranscriptMessage[], coachDepth?: CoachDepthInput) {
  return buildPrompt({
    feature: "coach-chat",
    personality: { id: "test", name: "Test", content: "You are Test." } as never,
    transcript: formatTranscript(list),
    fanSpendingData: "",
    fanSubscriptionData: "",
    fanDisplayName: "tomcat88",
    chatterQuestion: "what did he buy before and for how much?",
    ...(coachDepth === undefined ? {} : { coachDepth }),
  });
}

const taskOf = (prompt: ReturnType<typeof coachPrompt>) => prompt.user.slice(prompt.user.lastIndexOf("## Your Task"));
const cachedOf = (prompt: ReturnType<typeof coachPrompt>) =>
  prompt.userBlocks.filter((block) => block.cache === "1h").map((block) => block.text).join("");

describe("Coach transcript depth", () => {
  it("reads past the 1500 cap only for a request that advertises coach-depth-v1 beside context-v1", () => {
    expect(mayReadDeepTranscript(coachRequest(["context-v1", "coach-depth-v1"]))).toBe(true);
    expect(mayReadDeepTranscript(coachRequest(["context-v1", "coach-depth-v1"], "fansly"))).toBe(true);
    expect(deepTranscriptRowsOf("coach-chat", 3000)).toBe(3000);
    // A released extension keeps the 1500 cap, and so its cost.
    expect(mayReadDeepTranscript(coachRequest(["context-v1"]))).toBe(false);
    expect(mayReadDeepTranscript(coachRequest(["coach-depth-v1"]))).toBe(false);
    expect(mayReadDeepTranscript(coachRequest(undefined))).toBe(false);
  });
});

describe("Coach history depth slot", () => {
  const list = messages(300);

  it("is empty without coach-depth-v1: the prompt ends as it always did", () => {
    const plain = coachPrompt(list);
    expect(plain.user).not.toContain("## History Depth");
    expect(plain.user.endsWith("Keep the explanation outside the fence.\n")).toBe(true);
  });

  it("names what the model sees and the archive's count, and offers the more note, when older history exists", () => {
    const plain = coachPrompt(list);
    const deep = coachPrompt(list, depthOf(list, 2431, START - 30 * 24 * HOUR));
    const task = taskOf(deep);
    expect(task).toContain("## History Depth");
    expect(task).toContain("the 300 most recent messages of this conversation (from 2026-03-14 to now)");
    expect(task).toContain("The archive holds 2431 messages");
    expect(task).toContain("```more");
    // The slot lives in the uncached task block only.
    expect(cachedOf(deep)).toBe(cachedOf(plain));
    expect(deep.user.slice(0, deep.user.lastIndexOf("## Your Task"))).toBe(plain.user.slice(0, plain.user.lastIndexOf("## Your Task")));
  });

  it("says there is nothing older and never mentions the note when the transcript holds all the archive has", () => {
    const task = taskOf(coachPrompt(list, depthOf(list, 300, START)));
    expect(task).toContain("the 300 most recent messages");
    expect(task).toContain("nothing older to read");
    expect(task).not.toContain("```more");
    expect(task).not.toContain("The archive holds");
  });

  it("keeps the note but names no count when the archive's count could not be read", () => {
    const task = taskOf(coachPrompt(list, depthOf(list, null, null)));
    expect(task).toContain("the 300 most recent messages");
    expect(task).toContain("```more");
    expect(task).not.toContain("The archive holds");
    expect(task).not.toContain("nothing older to read");
  });

  it("counts what the budget's cut left, as the context frame does", () => {
    // About 560k characters of transcript: the 300k ceiling cuts the oldest.
    const long = messages(4000, 120);
    const transcript = formatTranscript(long);
    const prompt = coachPrompt(long, depthOf(long, long.length, long[0]!.createdAtMs));
    const omittedChars = prompt.coachTranscriptOmittedChars ?? 0;
    expect(omittedChars).toBeGreaterThan(0);
    expect(prompt.system.length + prompt.user.length).toBeLessThanOrEqual(COACH_PROMPT_MAX_CHARS);
    const omitted = transcriptMessagesOmittedByBudget({ transcript, messages: long, omittedChars });
    const served = Number(/You see the (\d+) most recent messages/.exec(taskOf(prompt))?.[1]);
    expect(served).toBe(long.length - omitted);
    const oldestServed = new Date(long[omitted]!.createdAtMs).toISOString().slice(0, 10);
    expect(taskOf(prompt)).toContain(`(from ${oldestServed} to now)`);
    // The cut left older messages out, so the archive holds older history.
    expect(taskOf(prompt)).toContain(`The archive holds ${long.length} messages`);
  });
});

describe("Coach split telemetry with a more note", () => {
  it("reads the note as neither a draft nor a stray marker", () => {
    const answer = [
      "Offer him the bundle he asked about.",
      "```draft",
      "hey you[NEXT]got something for you",
      "```",
      "```more",
      "Не вижу, что он покупал раньше [NEXT] и по какой цене.",
      "```",
    ].join("\n");
    expect(describeCoachSplitOutput(answer, null)).toEqual({
      draftsRequested: null,
      partsPerDraft: [2],
      brokenDrafts: 0,
      strayMarkers: 0,
      ok: true,
    });
    expect(describeCoachSplitOutput("Just wait for him.\n```more\nНе вижу старых покупок.\n```", null)).toMatchObject({
      partsPerDraft: [],
      brokenDrafts: 0,
      strayMarkers: 0,
      ok: true,
    });
  });
});
