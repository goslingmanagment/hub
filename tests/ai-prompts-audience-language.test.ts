import { describe, expect, it } from "vitest";

import { buildPrompt, type PromptBuildInput } from "../apps/runtime/src/modules/ai/index.ts";

// Regression: the live Fan conversation is English, but nearly every other
// input a Russian-speaking chatter supplies is Russian. The generated prompt
// must distinguish those audiences, including in its final uncached task.
const base = {
  personality: { id: "language-fixture", name: "Persona", content: "Описание персоны по-русски.", updatedAt: 1 },
  platform: "fansly",
  fanDisplayName: "Fan",
  fanSpendingData: "",
  fanSubscriptionData: "",
  chatterQuestion: "Предложи, как ответить на последнее сообщение.",
  draftText: "В пятницу смогу, давай уточним время.",
  coachHistory: [{ question: "Как продолжить?", answer: "Предложи договориться о времени." }],
  recapAttach: { full: { body: "Фан спрашивал о пятнице.", ageMs: 1_000 }, short: null },
  fanProfile: { body: "Досье фана написано по-русски.", generatedAt: new Date("2026-09-01T00:00:00Z") },
} satisfies Omit<PromptBuildInput, "feature" | "transcript">;

const features = ["coach-chat", "help-me", "chat-review", "fast-reply", "improve-draft", "hi-greeting", "ping", "voice-script"] as const;
const fanMessages = [
  ["English", "Are you free on Friday?"],
  ["Spanish", "¿Estás libre el viernes?"],
  ["Russian-speaking fan", "Ты свободна в пятницу?"],
  ["unknown language", "👀"],
] as const;

describe("proposed fan messages are English regardless of context language", () => {
  for (const feature of features) {
    for (const [language, fanMessage] of fanMessages) {
      it(`${feature}: ${language} transcript with Russian auxiliary context`, () => {
        const transcript = `Fan: ${fanMessage}`;
        const built = buildPrompt({ ...base, feature, transcript });
        const staticBlock = built.userBlocks.find(block => block.cache === "1h")!.text;
        const dynamicText = built.userBlocks.filter(block => block.cache === "5m").map(block => block.text).join("\n");
        const finalTask = built.userBlocks.at(-1)!;

        // Actual assembled prompt, not just the .md: a future split/reducer
        // change must not strand the rule outside what the provider receives.
        expect(staticBlock).toContain("Write every proposed fan message entirely in English, regardless of the language of the fan or chatter.");
        expect(dynamicText).toContain(transcript);
        expect(finalTask.cache).toBe("none");
        expect(finalTask.text).toContain("in English");
        expect(built.user).not.toMatch(/(?:in|infer) the fan's language/iu);
        expect(finalTask.text).not.toMatch(/(?:^|[.!?]\s+)Write in Russian\./u);
        if (feature === "coach-chat") {
          expect(finalTask.text).toContain(base.chatterQuestion);
          expect(finalTask.text).toContain(base.draftText);
          expect(finalTask.text).toContain("Keep the explanation outside the fence.");
        }
      });
    }
  }

  it("the Russian situation preset keeps Russian advice outside both fan drafts", () => {
    const built = buildPrompt({ ...base, feature: "coach-chat", preset: "situation", transcript: "Fan: Are you free on Friday?" });
    const task = built.userBlocks.at(-1)!.text;
    expect(task).toContain("EXACTLY two draft fences");
    expect(task).toContain("Write the four advice blocks in Russian.");
    expect(task).toContain("Both draft fences contain only ready-to-send English text.");
    expect(task).not.toContain("Both in the fan's language");
    expect(task).toContain("Keep explanations, labels, and translations outside the draft fences.");
  });

  it("Review's Russian recommendations explicitly exclude quoted replacement messages", () => {
    const built = buildPrompt({ ...base, feature: "chat-review", transcript: "Fan: ¿Estás libre el viernes?" });
    const prompt = built.userBlocks.map(block => block.text).join("\n");
    expect(prompt).toContain("This English-only rule includes «как надо было» replacements and message examples inside recommendations");
    expect(prompt).toContain("Put the ready-to-send English wording in quotes and keep Russian labels, explanations, and translations outside those quotes.");
    expect(prompt).toContain("any proposed fan-message wording in quotes stays entirely in English");
    expect(prompt).not.toContain("Your recommendations here, in Russian.");
  });

  it("language rules survive the Coach budget reducer without caching fan language in the static prefix", () => {
    const oversized = { ...base, feature: "coach-chat" as const, coachHistory: Array.from({ length: 20 }, () => ({ question: "Вопрос ".repeat(200), answer: "Русский разбор. ".repeat(500) })) };
    const english = buildPrompt({ ...oversized, transcript: "Fan: Are you free on Friday?" });
    const spanish = buildPrompt({ ...oversized, transcript: "Fan: ¿Estás libre el viernes?" });
    expect(english.userBlocks[0]).toEqual(spanish.userBlocks[0]);
    expect(english.userBlocks[0]!.text).toContain("Write every proposed fan message entirely in English");
    expect(english.userBlocks.at(-1)!.text).toContain("entirely in English");
    expect(english.userBlocks.filter(block => block.cache === "5m").map(block => block.text).join("\n")).toContain("Fan: Are you free on Friday?");
  });

  it("the same audience boundary reaches the OnlyFans client", () => {
    const built = buildPrompt({ ...base, platform: "onlyfans", feature: "coach-chat", transcript: "Fan: Are you free on Friday?" });
    expect(built.userBlocks[0]!.text).toContain("Write every proposed fan message entirely in English");
    expect(built.userBlocks.at(-1)!.text).toContain("Keep the explanation outside the fence.");
  });
});
