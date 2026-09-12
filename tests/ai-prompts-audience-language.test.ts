import { describe, expect, it } from "vitest";

import { buildPrompt, type PromptBuildInput } from "../apps/runtime/src/modules/ai/index.ts";

// Regression (Decision #201 amendment, then #283): nearly every input a
// Russian-speaking chatter supplies is Russian, while the fan may write
// English, Russian or anything else. The generated prompt must name the fan's
// own transcript lines as the ONLY language signal, English by default, and
// must say so both in the cached static prefix and in the final uncached task.
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

const FAN_LANGUAGE_RULE =
  "Write every proposed fan message in the fan's language. The fan's language is English unless the fan writes in another language: judge it only from the lines marked Fan: in the transcript, weighting the most recent ones; if those lines are in English or too short to tell, it is English. The chatter's draft, question, coach history, recaps, fan dossier, and persona notes are never a language signal: a Russian draft for an English-speaking fan becomes English.";

const features = ["coach-chat", "help-me", "chat-review", "fast-reply", "improve-draft", "hi-greeting", "ping", "voice-script"] as const;
const fanMessages = [
  ["English", "Are you free on Friday?"],
  ["Spanish", "¿Estás libre el viernes?"],
  ["Russian-speaking fan", "Ты свободна в пятницу?"],
  ["unknown language", "👀"],
] as const;

describe("proposed fan messages follow the fan's own language, English by default", () => {
  for (const feature of features) {
    for (const [language, fanMessage] of fanMessages) {
      it(`${feature}: ${language} transcript with Russian auxiliary context`, () => {
        const transcript = `Fan: ${fanMessage}`;
        const built = buildPrompt({ ...base, feature, transcript });
        const staticBlock = built.userBlocks.find(block => block.cache === "1h")!.text;
        const dynamicText = built.userBlocks.slice(1, -1).map(block => block.text).join("\n");
        const finalTask = built.userBlocks.at(-1)!;

        // Actual assembled prompt, not just the .md: a future split/reducer
        // change must not strand the rule outside what the provider receives.
        expect(staticBlock).toContain(FAN_LANGUAGE_RULE);
        expect(dynamicText).toContain(transcript);
        expect(finalTask.cache).toBe("none");
        expect(finalTask.text).toContain("in the fan's language (English by default)");
        // The pre-#283 blanket rule and the pre-#201-amendment free inference
        // are both gone: the fan's OWN lines decide, nothing else.
        expect(built.user).not.toContain("regardless of the language of the fan");
        expect(built.user).not.toContain("entirely in English");
        expect(built.user).not.toMatch(/infer the fan's language/iu);
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
    expect(task).toContain("Write every proposed fan message in the fan's language (English by default, judged only from the Fan: lines in the transcript).");
    expect(task).toContain("Both draft fences contain only ready-to-send text in the fan's language.");
    expect(task).not.toContain("Both in the fan's language");
    expect(task).toContain("Keep explanations, labels, and translations outside the draft fences.");
  });

  it("Review's Russian recommendations explicitly exclude quoted replacement messages", () => {
    const built = buildPrompt({ ...base, feature: "chat-review", transcript: "Fan: ¿Estás libre el viernes?" });
    const prompt = built.userBlocks.map(block => block.text).join("\n");
    expect(prompt).toContain("This fan-language rule includes «как надо было» replacements and message examples inside recommendations");
    expect(prompt).toContain("Put the ready-to-send wording in quotes and keep Russian labels, explanations, and translations outside those quotes.");
    expect(prompt).toContain("any proposed fan-message wording in quotes stays in the fan's language (English by default)");
    expect(prompt).not.toContain("Your recommendations here, in Russian.");
  });

  it("Fix names the chatter's Russian draft as a non-signal and shows a Russian-fan example", () => {
    const built = buildPrompt({ ...base, feature: "improve-draft", transcript: "Fan: Ты свободна в пятницу?" });
    expect(built.user).toContain("A Russian draft is not a reason to answer in Russian: only the fan's own lines decide.");
    expect(built.user).toContain("Draft (chatter, in Russian; the fan writes Russian):");
    expect(built.user).toContain("Draft (chatter, in Russian; the fan writes English):");
  });

  it("language rules survive the Coach budget reducer without caching fan language in the static prefix", () => {
    const oversized = { ...base, feature: "coach-chat" as const, coachHistory: Array.from({ length: 20 }, () => ({ question: "Вопрос ".repeat(200), answer: "Русский разбор. ".repeat(500) })) };
    const english = buildPrompt({ ...oversized, transcript: "Fan: Are you free on Friday?" });
    const spanish = buildPrompt({ ...oversized, transcript: "Fan: ¿Estás libre el viernes?" });
    expect(english.userBlocks[0]).toEqual(spanish.userBlocks[0]);
    expect(english.userBlocks[0]!.text).toContain(FAN_LANGUAGE_RULE);
    expect(english.userBlocks.at(-1)!.text).toContain("in the fan's language (English by default)");
    expect(english.userBlocks.filter(block => block.cache === "5m").map(block => block.text).join("\n")).toContain("Fan: Are you free on Friday?");
  });

  it("the same audience boundary reaches the OnlyFans client", () => {
    const built = buildPrompt({ ...base, platform: "onlyfans", feature: "coach-chat", transcript: "Fan: Are you free on Friday?" });
    expect(built.userBlocks[0]!.text).toContain(FAN_LANGUAGE_RULE);
    expect(built.userBlocks.at(-1)!.text).toContain("Keep the explanation outside the fence.");
  });
});
