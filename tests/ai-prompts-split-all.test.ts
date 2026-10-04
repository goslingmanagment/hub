// chat-extension H-10 (architecture.md D-15): Split for Ping and Hi (H-10a) and
// for the drafts of a Coach answer (H-10b) behind the `split-all-v1`
// capability. The builder takes the gate as an input (`splitAll`);
// the gate itself (capability header AND the page's splitAll flag) is the
// feature service's and is pinned in tests/client-ai-split-all.integration.test.ts.
import { describe, expect, it } from "vitest";

import type { AiGatewayStreamFrame } from "@agency_hub_core/contracts";

import {
  COACH_CHAT_TEMPLATE,
  COACH_DRAFT_BLOCKS_MAX,
  COACH_PRESET_DRAFT_BLOCKS,
  COACH_PROMPT_MAX_CHARS,
  FEATURE_POLICIES,
  OPERATION_FEATURES,
  PING_TEMPLATE,
  buildPrompt,
  describeCoachSplitOutput,
  describeSplitOutput,
  normalizeReplyParts,
  normalizeVariantReplyParts,
  type OperationFeature,
  type PromptBuildInput,
} from "../apps/runtime/src/modules/ai/index.ts";
import { AiGatewayTerminalStreamConsumer } from "../apps/runtime/src/services/ai-gateway.ts";
import { promptDigest, referencePrompts } from "./helpers/ai-prompt-references.ts";

const SPLIT_ALL_FEATURES: readonly OperationFeature[] = ["ping", "hi-greeting", "coach-chat"];

const digestOf = (input: PromptBuildInput) => promptDigest(buildPrompt(input));
const taskBlock = (input: PromptBuildInput) => buildPrompt(input).userBlocks.at(-1)!.text;

describe("reference prompts without the split-all gate", () => {
  const references = referencePrompts();

  it("covers every feature on both platforms", () => {
    expect(new Set(references.map((reference) => reference.name)).size).toBe(references.length);
    const featuresByPlatform = new Map<string, Set<OperationFeature>>();
    for (const { input } of references) {
      const platform = String(input.platform);
      const features = featuresByPlatform.get(platform) ?? new Set<OperationFeature>();
      featuresByPlatform.set(platform, features.add(input.feature));
    }
    expect([...featuresByPlatform.keys()].sort()).toEqual(["fansly", "onlyfans"]);
    for (const [platform, features] of featuresByPlatform) {
      expect(features, platform).toEqual(new Set(OPERATION_FEATURES));
    }
  });

  // The reference prompts (tests/helpers/ai-prompt-references.ts) as the builder
  // assembled them on hub main b8fac831, BEFORE the Split slot existed: a
  // request that does not pass the split-all gate must keep these bytes.
  //
  // A deliberate prompt change re-pins them in one step, in the same change as
  // prompt-manifest.json:
  //   npx vitest run tests/ai-prompts-split-all.test.ts -u
  // and the diff of this block then names every prompt that changed.
  it("every reference prompt keeps its pinned digest", () => {
    expect(Object.fromEntries(references.map(({ name, input }) => [name, digestOf(input)]))).toMatchInlineSnapshot(`
      {
        "fansly chat-review": "6240e3b616514fd6f66ac873a6fcce4dfe3d3719c4786f5d2ed90410fe8a30c3",
        "fansly coach-chat preset": "488dfe520c35bb99eb0c30639f2cc1df033b13ede3da96a78568fe0c1edf0f0b",
        "fansly coach-chat question": "fe39cdf6fcb00e332c5d89e690ab05a9873fd74e3eaeafb5393050e5471f36c9",
        "fansly fan-summary": "07025090eeedca83c29fca667ed963d88f5b50a1f46b050b39120f895d264ac4",
        "fansly fan-summary short": "20becc30ec4065fe08ae9d11da9afc8c8081eade975ba77b566fc2d795c7cb4f",
        "fansly fast-reply flirty": "56a25de19d807359f31430218f92b3b45bbaf826818295fa7e46ef6f7c03498a",
        "fansly fast-reply split": "e51613f6590f8c7d3f4cbbc6732965f8dac1f09d944a96322b8de216f686caee",
        "fansly help-me": "23f79158582e57b7c17e4e38cc024babf888f2a32e5b446d5d5d209f78d05d4f",
        "fansly hi-greeting 1 variant": "b26324d13b458f8aa2eaf40f0a63d9af827f5e2ee637d05f38bd65e839354182",
        "fansly hi-greeting 3 variants": "6c833e4e8bf6fbc62644fa5c64fb95a8739250223f466e25ba226d872622834f",
        "fansly improve-draft": "812a047aa8a4b45fbb63ae101b14c9f2a0a90b27373ae64ede43c5c9f6298f3e",
        "fansly improve-draft split": "15122138e152a5635d86c5ea0eba134fdcfa59ddc5ea46255cba1c9efa363ccf",
        "fansly ping active": "16ecfd3ef4905cd970f748622e80497585450a2cf0cf92a266fb9c6d2d2b754f",
        "fansly ping segment-a": "44e8fe1a396c519097dc1adc94808db8659445d49e45d8a26d93c27313eabeee",
        "fansly ping segment-b": "31955b05ad63764c323224373160233e61dad1ac56d998449e35831aec59f47a",
        "fansly voice-script": "414dbf45b2eb7ae59dac6b0d23abcff2651881f5d891e4d68531991b4c7b78c7",
        "onlyfans chat-review": "a568cca85dbe096c056971e54247f3ea6c4a0c60b385b5a3ea451c6b17b51fb7",
        "onlyfans coach-chat preset": "616a99096fb08a4ea556eaca9a9c5ece8afcf046ba4ad848945f396fa2ace7ee",
        "onlyfans coach-chat question": "210aa78a9273a9ca3050f2a20a82253df8e4b8b4da8078ec94378e5a21e02bfb",
        "onlyfans fan-summary": "b95609405cb8f722bb9d27374e86a6265f963ece64d2de5044140d02f2f690fd",
        "onlyfans fan-summary short": "b930dc1035c8f90ada5282132ce2a3db13ba37b6675716acc03cfb597bcd9d89",
        "onlyfans fast-reply flirty": "ec5cddb8defecb8b840d791e4125e0c6d096dd68b526403d3669cc9a8ee991cb",
        "onlyfans fast-reply split": "525eb4d6b08544de2517b7cac6cfd930856e64cdf9b7659889a50911038ea381",
        "onlyfans help-me": "446d81da33a798c8efb16a010e4d9e17de7a54fde4b273dbe87694cb974c1279",
        "onlyfans hi-greeting 1 variant": "fa80b6e751c827acaa2e7968f2bc4eae6592eda115d8517d8db57275d3bfe94b",
        "onlyfans hi-greeting 3 variants": "daa4b5361ba33ce78b7287e3049ad005bfb15e3c167c3cf9524a929eab40a907",
        "onlyfans improve-draft": "fc15e8107b65a1a3694bbb3938b84f1849f0bcdab1156e353554123875ea88aa",
        "onlyfans improve-draft split": "9b2a4e8ed74d76b1850b45663f13f00eadbb5f2eb89944c99ea757086a6d4a7e",
        "onlyfans ping active": "e794eb2f0566eca28c6e1c1c43ab9e61860f96c33ea8c7a3629fd37405fe6abb",
        "onlyfans ping segment-a": "17d4a6e0b94e6034502735bb06f8a3b63b2e3fefd7b766ec93700af86245b311",
        "onlyfans ping segment-b": "cf68618362fb25afe490144370117b53c9b645d8d43ed12fef7cfa59214454bd",
        "onlyfans voice-script": "6661bbc14a1a3f38ea1de7a5dcdd1ac23171357d27292327ee86090187998e83",
      }
    `);
  });

  for (const { name, input } of references) {
    it(`${name}: the gate input without the Split ask changes nothing`, () => {
      const reference = digestOf(input);
      // The gate input absent, false, or true without the Split ask: no change.
      expect(digestOf({ ...input, splitAll: false })).toBe(reference);
      expect(digestOf({ ...input, splitAll: true })).toBe(reference);
      if (input.replyMode === undefined) {
        expect(digestOf({ ...input, replyMode: "default", splitAll: true })).toBe(reference);
      }
    });
  }

  // Released clients send replyMode on every feature (the Fansly extension) and
  // never pass the gate: only Reply and Fix, which always split, may react.
  for (const { name, input } of references.filter((reference) => reference.input.replyMode === undefined)) {
    if (FEATURE_POLICIES[input.feature].supportsReplyMode) {
      continue;
    }
    it(`${name}: replyMode preferSplit alone changes nothing`, () => {
      const reference = digestOf(input);
      expect(digestOf({ ...input, replyMode: "preferSplit" })).toBe(reference);
      expect(digestOf({ ...input, replyMode: "preferSplit", splitAll: false })).toBe(reference);
    });
  }
});

describe("the two policy tables agree on Split by capability", () => {
  it("only Ping, Hi and Coach are supportsSplitAll, and none of them splits on replyMode alone", () => {
    const flagged = OPERATION_FEATURES.filter((feature) => FEATURE_POLICIES[feature].supportsSplitAll);
    expect(flagged).toEqual(SPLIT_ALL_FEATURES);
    for (const feature of flagged) {
      expect(FEATURE_POLICIES[feature].supportsReplyMode, feature).toBe(false);
    }
  });

  it("the builder honours the gate for exactly the features FEATURE_POLICIES flags", () => {
    for (const { name, input } of referencePrompts()) {
      const asked = { ...input, replyMode: "preferSplit" } satisfies PromptBuildInput;
      const changed = digestOf({ ...asked, splitAll: true }) !== digestOf(asked);
      expect(changed, name).toBe(FEATURE_POLICIES[input.feature].supportsSplitAll);
    }
  });
});

describe("Ping with the split-all gate", () => {
  const base = referencePrompts().find((reference) => reference.name === "onlyfans ping segment-a")!.input;
  const split = { ...base, replyMode: "preferSplit", splitAll: true } satisfies PromptBuildInput;

  it("adds the Split instructions to the end of the task line, before the final reread", () => {
    expect(taskBlock(split)).toBe(`## Your Task

Use this fan segment strategy:

Segment A. Earlier conversation: Reference specific past conversation topics, show you remember them, and create curiosity. Use the visible relationship context without making the time since the last message the reason to write.

Fan silence: the fan's last message was 12 days ago.

Write a personal outreach message from the model to the fan following that segment strategy. Output only the message text, in the fan's language (English by default).
- Split mode is on for this message.
- Deliver the message as separate short, text-like sends, separated by [NEXT].
- ALWAYS return at least 2 parts: split even a brief message into an opening send plus a natural follow-up.
- Use 3 parts only when the content genuinely needs the extra send - never more than 3.
- Keep each part brief and casual, like real back-to-back texts.
Before you send: reread it as the fan would. If it could have gone to any other fan, add the detail that makes it his.
`);
  });

  it("changes only the uncached task block: the cached prefix and the context are the same bytes", () => {
    const plain = buildPrompt(base);
    const built = buildPrompt(split);
    expect(built.systemBlocks).toEqual(plain.systemBlocks);
    expect(built.userBlocks).toHaveLength(3);
    expect(built.userBlocks[0]).toEqual(plain.userBlocks[0]);
    expect(built.userBlocks[0]!.cache).toBe("1h");
    expect(built.userBlocks[1]).toEqual(plain.userBlocks[1]);
    expect(built.userBlocks[2]!.cache).toBe("none");
    expect(built.userBlocks[2]!.text).not.toBe(plain.userBlocks[2]!.text);
    expect(plain.user).not.toContain("Split mode is on");
  });

  it("renders the empty slot byte-identical to the template before the slot existed", () => {
    expect(PING_TEMPLATE.split("{pingSplitInstructions}")).toHaveLength(2);
    const legacyTemplate = PING_TEMPLATE.replace("{pingSplitInstructions}", "");
    for (const input of [base, { ...base, replyMode: "preferSplit" }, { ...base, splitAll: true }] satisfies PromptBuildInput[]) {
      expect(buildPrompt(input)).toEqual(buildPrompt(input, { ping: legacyTemplate }));
    }
  });

  it("keeps the slot in the task block and never expands one typed into fan data", () => {
    expect(PING_TEMPLATE.indexOf("{pingSplitInstructions}")).toBeGreaterThan(PING_TEMPLATE.lastIndexOf("## Your Task"));
    const built = buildPrompt({ ...split, fanBio: "bio {pingSplitInstructions}", transcript: "Fan: {pingSplitInstructions}" });
    expect(built.userBlocks[1]!.text).toContain("Fan bio: bio {pingSplitInstructions}");
    expect(built.userBlocks[1]!.text).toContain("Fan: {pingSplitInstructions}");
    expect(built.user.match(/Split mode is on/g)).toHaveLength(1);
  });
});

describe("Hi with the split-all gate, 1 and 3 variants", () => {
  const base = referencePrompts().find((reference) => reference.name === "onlyfans hi-greeting 3 variants")!.input;
  const split = (greetingVariantCount: 1 | 3): PromptBuildInput =>
    ({ ...base, greetingVariantCount, replyMode: "preferSplit", splitAll: true });

  it("3 variants: [VARIANT] between the variants, [NEXT] parts inside each", () => {
    expect(taskBlock(split(3))).toBe(`## Your Task

Write exactly 3 different greeting variants separated by [VARIANT]. The chatter will pick the best one. Mix the styles: one playful or creative, one warm and simple ("hey babe, let's chat a little 💕"), one somewhere in between. Not every variant needs a clever hook, sometimes a direct, warm invitation to talk is the best opener. Split mode is on: deliver every variant as separate short, text-like sends, separated by [NEXT] inside the variant. ALWAYS give each variant at least 2 parts, an opening send plus a natural follow-up, and 3 parts only when the variant genuinely needs the extra send, never more than 3. Keep each part brief and casual, like real back-to-back texts. If there are existing fan messages, respond to the conversation, don't start over. Output only the message text, in the fan's language (English by default).
`);
  });

  it("1 variant: [NEXT] parts, still no [VARIANT]", () => {
    expect(taskBlock(split(1))).toBe(`## Your Task

Write exactly ONE ready-to-send greeting: no labels, no alternatives, no [VARIANT] markers. Split mode is on: deliver the greeting as separate short, text-like sends, separated by [NEXT]. ALWAYS return at least 2 parts, an opening send plus a natural follow-up, and 3 parts only when the greeting genuinely needs the extra send, never more than 3. Keep each part brief and casual, like real back-to-back texts. If there are existing fan messages, respond to the conversation, don't start over. Output only the message text, in the fan's language (English by default).
`);
  });

  it("the default variant count is 3, as without Split", () => {
    expect(taskBlock({ ...base, replyMode: "preferSplit", splitAll: true })).toBe(taskBlock(split(3)));
  });

  it("changes only the uncached task block, for both counts", () => {
    for (const greetingVariantCount of [1, 3] as const) {
      const plain = buildPrompt({ ...base, greetingVariantCount });
      const built = buildPrompt(split(greetingVariantCount));
      expect(built.systemBlocks).toEqual(plain.systemBlocks);
      expect(built.userBlocks).toHaveLength(3);
      expect(built.userBlocks[0]).toEqual(plain.userBlocks[0]);
      expect(built.userBlocks[0]!.cache).toBe("1h");
      expect(built.userBlocks[1]).toEqual(plain.userBlocks[1]);
      expect(built.userBlocks[2]!.cache).toBe("none");
      expect(plain.userBlocks[2]!.text).not.toContain("Split mode is on");
      expect(built.userBlocks[2]!.text).toContain("Split mode is on");
    }
  });

  it("the one-draft task without the gate still forbids both markers", () => {
    const text = taskBlock({ ...base, greetingVariantCount: 1, replyMode: "preferSplit" });
    expect(text).toContain("no [VARIANT] or [NEXT] markers");
  });
});

describe("Coach with the split-all gate", () => {
  const reference = (name: string) => referencePrompts().find((candidate) => candidate.name === name)!.input;
  // A question turn with the chatter's draft, a dialog, a dossier and both recaps; and a preset turn.
  const question = reference("onlyfans coach-chat question");
  const preset = reference("onlyfans coach-chat preset");
  const split = (input: PromptBuildInput): PromptBuildInput => ({ ...input, replyMode: "preferSplit", splitAll: true });

  const SPLIT_INSTRUCTIONS = `
- Split mode is on for the proposed fan messages.
- Inside each draft fence, deliver the message as separate short, text-like sends, separated by [NEXT]. The [NEXT] marker is the only thing other than message text allowed inside a draft fence.
- ALWAYS give each draft at least 2 parts: a main send plus a natural follow-up.
- Use 3 parts only when the draft genuinely needs the extra send - never more than 3.
- One proposal is one draft fence with all its parts inside: never open a separate fence for a part. The limits stand: at most two draft fences, each under 1500 characters with its parts together.
- Keep each part brief and casual, like real back-to-back texts. Never write [NEXT] outside a draft fence.`;

  it("adds the Split instructions to the end of the last task line", () => {
    expect(taskBlock(split({ ...question, draftText: undefined }))).toBe(`## Your Task

The chatter asks:

<chatter_question>
как продать ppv?
</chatter_question>



Answer the chatter now in the language they asked in. Use a draft fence for any proposed fan message, in the fan's language (English by default). Keep the explanation outside the fence.${SPLIT_INSTRUCTIONS}
`);
  });

  it("is the same addition on a turn with the chatter's draft and on a preset turn", () => {
    for (const input of [question, preset]) {
      const plain = taskBlock(input);
      expect(plain.endsWith("Keep the explanation outside the fence.\n"), input.chatterQuestion).toBe(true);
      expect(taskBlock(split(input)), input.chatterQuestion).toBe(`${plain.slice(0, -1)}${SPLIT_INSTRUCTIONS}\n`);
    }
    // The preset's own ask for two drafts stays, ahead of the Split instructions.
    const presetTask = taskBlock(split(preset));
    expect(presetTask.indexOf("EXACTLY two draft fences")).toBeGreaterThan(presetTask.indexOf("## Preset Turn"));
    expect(presetTask.indexOf("EXACTLY two draft fences")).toBeLessThan(presetTask.indexOf("- Split mode is on"));
    expect(taskBlock(split(question))).toContain("<chatter_draft>");
  });

  it("changes only the uncached task block: the 1h prefix, the transcript and the dialog are the same bytes", () => {
    for (const input of [question, preset]) {
      const plain = buildPrompt(input);
      const built = buildPrompt(split(input));
      expect(built.systemBlocks).toEqual(plain.systemBlocks);
      expect(built.userBlocks).toHaveLength(4);
      expect(built.userBlocks.map((block) => block.cache)).toEqual(["1h", "5m", "5m", "none"]);
      expect(built.userBlocks.slice(0, 3)).toEqual(plain.userBlocks.slice(0, 3));
      expect(built.userBlocks[3]!.text).not.toBe(plain.userBlocks[3]!.text);
      expect(plain.user).not.toContain("Split mode is on");
      expect(plain.user).not.toContain("[NEXT]");
      // What the builder reports about the surviving context does not move.
      expect(built.coachRecapSlots).toEqual(plain.coachRecapSlots);
      expect(built.coachDraftIncluded).toBe(plain.coachDraftIncluded);
      expect(built.coachDossierIncluded).toBe(plain.coachDossierIncluded);
    }
  });

  it("renders the empty slot byte-identical to the template before the slot existed", () => {
    expect(COACH_CHAT_TEMPLATE.split("{coachSplitInstructions}")).toHaveLength(2);
    expect(COACH_CHAT_TEMPLATE.endsWith("Keep the explanation outside the fence.{coachSplitInstructions}\n")).toBe(true);
    const legacyTemplate = COACH_CHAT_TEMPLATE.replace("{coachSplitInstructions}", "");
    for (const base of [question, preset]) {
      for (const input of [base, { ...base, replyMode: "preferSplit" }, { ...base, splitAll: true }] satisfies PromptBuildInput[]) {
        expect(buildPrompt(input)).toEqual(buildPrompt(input, { "coach-chat": legacyTemplate }));
      }
    }
  });

  it("keeps the slot in the task block and never expands one typed by the chatter or the fan", () => {
    expect(COACH_CHAT_TEMPLATE.indexOf("{coachSplitInstructions}")).toBeGreaterThan(COACH_CHAT_TEMPLATE.lastIndexOf("## Your Task"));
    const built = buildPrompt(split({
      ...question,
      transcript: "Fan: {coachSplitInstructions}",
      chatterQuestion: "question {coachSplitInstructions}",
      draftText: "draft {coachSplitInstructions}",
      coachHistory: [{ question: "earlier {coachSplitInstructions}", answer: "answer {coachSplitInstructions}" }],
    }));
    expect(built.userBlocks[1]!.text).toContain("Fan: {coachSplitInstructions}");
    expect(built.userBlocks[2]!.text).toContain("earlier {coachSplitInstructions}");
    expect(built.userBlocks[2]!.text).toContain("answer {coachSplitInstructions}");
    expect(built.userBlocks[3]!.text).toContain("question {coachSplitInstructions}");
    expect(built.userBlocks[3]!.text).toContain("draft {coachSplitInstructions}");
    expect(built.user.match(/Split mode is on/g)).toHaveLength(1);
  });

  it("restates the limits of the cached draft grammar, which the structure check reads back", () => {
    // The 1h prefix keeps the grammar: the Split text may only name its one exception.
    const rules = buildPrompt(split(question)).userBlocks[0]!.text;
    expect(rules).toContain("at most two\n  such blocks, each under 1500 characters");
    expect(rules).toContain("Never put anything except the ready-to-send fan message inside a\n  draft fence.");
    expect(SPLIT_INSTRUCTIONS).toContain("The [NEXT] marker is the only thing other than message text allowed inside a draft fence.");
    expect(SPLIT_INSTRUCTIONS).toContain("at most two draft fences, each under 1500 characters");
    expect(COACH_DRAFT_BLOCKS_MAX).toBe(2);
    expect(taskBlock(preset)).toContain("EXACTLY two draft fences");
    expect(COACH_PRESET_DRAFT_BLOCKS).toBe(2);
  });

  it("fits the worst legal prompt: the instructions and the question are never what the budget sheds", () => {
    const amp = "&";
    const built = buildPrompt(split({
      ...preset,
      personality: { ...preset.personality, content: amp.repeat(50_000) },
      transcript: `OLDEST_TRANSCRIPT_SENTINEL\n${amp.repeat(299_940)}\nNEWEST_TRANSCRIPT_SENTINEL`,
      fanSpendingData: amp.repeat(20_000),
      fanSubscriptionData: amp.repeat(20_000),
      fanBio: amp.repeat(5_000),
      chatterQuestion: `${amp.repeat(1_980)}QUESTION_SENTINEL`,
      draftText: amp.repeat(20_000),
      coachHistory: Array.from({ length: 20 }, (_, index) => ({
        question: `HISTORY_Q_${index}${amp.repeat(1_980)}`,
        answer: `HISTORY_A_${index}${amp.repeat(63_980)}`,
      })),
      recapAttach: {
        full: { body: `FULL_RECAP ${amp.repeat(40_000)}`, ageMs: 86_400_000 },
        short: { body: `SHORT_RECAP ${amp.repeat(40_000)}`, ageMs: 60_000 },
      },
      fanProfile: { body: `DOSSIER ${amp.repeat(19_990)}`, generatedAt: new Date("2026-07-01T00:00:00.000Z") },
    }));
    expect(built.system.length + built.user.length).toBeLessThanOrEqual(COACH_PROMPT_MAX_CHARS);
    const task = built.userBlocks.at(-1)!.text;
    expect(task).toContain("QUESTION_SENTINEL");
    expect(task).toContain("## Preset Turn");
    expect(task.endsWith(`${SPLIT_INSTRUCTIONS}\n`)).toBe(true);
    expect(built.user).toContain("NEWEST_TRANSCRIPT_SENTINEL");
    expect(built.user).not.toContain("OLDEST_TRANSCRIPT_SENTINEL");
  });
});

describe("output structure of a finished Split generation", () => {
  it("counts the parts of a Ping and a one-draft Hi: two or three is the ask", () => {
    expect(describeSplitOutput("hey you [NEXT] what's up", 1)).toEqual({ variantsRequested: 1, partsPerVariant: [2], ok: true });
    expect(describeSplitOutput("a [NEXT] b [NEXT] c", 1)).toEqual({ variantsRequested: 1, partsPerVariant: [3], ok: true });
    expect(describeSplitOutput("one message only", 1)).toEqual({ variantsRequested: 1, partsPerVariant: [1], ok: false });
    expect(describeSplitOutput("a [NEXT] b [NEXT] c [NEXT] d", 1)).toEqual({ variantsRequested: 1, partsPerVariant: [4], ok: false });
    // A stray variant marker where one draft was asked for.
    expect(describeSplitOutput("a [NEXT] b [VARIANT] c [NEXT] d", 1)).toEqual({ variantsRequested: 1, partsPerVariant: [2, 2], ok: false });
  });

  it("counts the parts of every Hi variant", () => {
    expect(describeSplitOutput("a [NEXT] b [VARIANT] c [NEXT] d [NEXT] e [VARIANT] f [NEXT] g", 3))
      .toEqual({ variantsRequested: 3, partsPerVariant: [2, 3, 2], ok: true });
    expect(describeSplitOutput("a [NEXT] b [VARIANT] c [VARIANT] f [NEXT] g", 3))
      .toEqual({ variantsRequested: 3, partsPerVariant: [2, 1, 2], ok: false });
    expect(describeSplitOutput("a [NEXT] b [VARIANT] c [NEXT] d", 3))
      .toEqual({ variantsRequested: 3, partsPerVariant: [2, 2], ok: false });
  });

  it("counts only insertable parts, like the clients' parser", () => {
    // Empty parts, bracket framing and a leaked meta line are not messages.
    expect(describeSplitOutput("a [NEXT]  [NEXT] b [NEXT] [", 1).partsPerVariant).toEqual([2]);
    expect(describeSplitOutput("a [NEXT] as an AI I cannot do that", 1).partsPerVariant).toEqual([1]);
    expect(describeSplitOutput("a [NEXT] b [VARIANT]  [VARIANT] c [NEXT] d", 3).partsPerVariant).toEqual([2, 2]);
    expect(describeSplitOutput("   ", 1)).toEqual({ variantsRequested: 1, partsPerVariant: [], ok: false });
  });

  it("drops reasoning blocks before it looks for markers, like the sanitizer", () => {
    // A provider that leaks its reasoning into the visible text may write the
    // markers there too; they are not variants or parts of the answer.
    const hi = "<think>plan: a [VARIANT] b [VARIANT] c</think>one [NEXT] two [VARIANT] three [NEXT] four [VARIANT] five [NEXT] six";
    expect(describeSplitOutput(hi, 3)).toEqual({ variantsRequested: 3, partsPerVariant: [2, 2, 2], ok: true });
    expect(normalizeVariantReplyParts(hi).map((variant) => normalizeReplyParts(variant).length)).toEqual([2, 2, 2]);

    const ping = "<think>x [VARIANT] y [NEXT] z</think>one [NEXT] two";
    expect(describeSplitOutput(ping, 1)).toEqual({ variantsRequested: 1, partsPerVariant: [2], ok: true });
    expect(normalizeReplyParts(ping)).toEqual(["one", "two"]);

    const fenced = "```thinking\nfirst [NEXT] then [VARIANT] maybe\n```\nhey [NEXT] you";
    expect(describeSplitOutput(fenced, 1)).toEqual({ variantsRequested: 1, partsPerVariant: [2], ok: true });
    // Only reasoning is dropped: a real stray variant still counts against the ask.
    expect(describeSplitOutput("<think>x</think>a [NEXT] b [VARIANT] c [NEXT] d", 1).ok).toBe(false);
  });

  it("records counts and never the text", () => {
    const structure = describeSplitOutput("secret opener [NEXT] secret follow-up", 1);
    expect(Object.keys(structure).sort()).toEqual(["ok", "partsPerVariant", "variantsRequested"]);
    expect(JSON.stringify(structure)).not.toContain("secret");
  });

  it("reads the final text: a marker cut by a chunk boundary still counts", () => {
    const frames = (chunks: readonly string[]): string => {
      const consumer = new AiGatewayTerminalStreamConsumer();
      for (const text of chunks) {
        const frame: AiGatewayStreamFrame = { type: "content_delta", text };
        // What a client receives chunk by chunk carries no whole marker.
        expect(consumer.note(frame).emit).toEqual([frame]);
      }
      return consumer.completionText;
    };
    const ping = ["hey you [NE", "XT] what's up"];
    expect(ping.some((chunk) => chunk.includes("[NEXT]"))).toBe(false);
    expect(describeSplitOutput(frames(ping), 1)).toEqual({ variantsRequested: 1, partsPerVariant: [2], ok: true });

    const hi = ["a [", "NEXT", "] b [VARI", "ANT] c [NEXT", "] d [VARIANT", "] e [NEXT] f"];
    expect(hi.some((chunk) => chunk.includes("[VARIANT]"))).toBe(false);
    expect(describeSplitOutput(frames(hi), 3)).toEqual({ variantsRequested: 3, partsPerVariant: [2, 2, 2], ok: true });
  });
});

describe("output structure of a finished Coach generation with Split", () => {
  /** A Coach answer: advice, the given draft blocks, advice again. */
  const answer = (...drafts: string[]) => [
    "Сначала ответь на его вопрос, потом предложи видео.",
    ...drafts.map((draft) => `\`\`\`draft\n${draft}\n\`\`\``),
    "Если промолчит, не дави.",
  ].join("\n\n");

  it("counts the [NEXT] parts inside each draft block: two or three is the ask", () => {
    expect(describeCoachSplitOutput(answer("hey you [NEXT] what's up"), null))
      .toEqual({ draftsRequested: null, partsPerDraft: [2], ok: true });
    // The marker on its own line, as a model tends to write it inside a fence.
    expect(describeCoachSplitOutput(answer("hey you\n[NEXT]\nwhat's up", "a\n[NEXT]\nb\n[NEXT]\nc"), null))
      .toEqual({ draftsRequested: null, partsPerDraft: [2, 3], ok: true });
    expect(describeCoachSplitOutput(answer("one message only"), null))
      .toEqual({ draftsRequested: null, partsPerDraft: [1], ok: false });
    expect(describeCoachSplitOutput(answer("a [NEXT] b", "c [NEXT] d [NEXT] e [NEXT] f"), null))
      .toEqual({ draftsRequested: null, partsPerDraft: [2, 4], ok: false });
  });

  it("a question turn may propose nothing; a preset turn must propose exactly two", () => {
    expect(describeCoachSplitOutput("Тут писать ничего не нужно, подожди его ответа.", null))
      .toEqual({ draftsRequested: null, partsPerDraft: [], ok: true });
    expect(describeCoachSplitOutput("Тут писать ничего не нужно.", COACH_PRESET_DRAFT_BLOCKS))
      .toEqual({ draftsRequested: 2, partsPerDraft: [], ok: false });
    expect(describeCoachSplitOutput(answer("a [NEXT] b"), COACH_PRESET_DRAFT_BLOCKS))
      .toEqual({ draftsRequested: 2, partsPerDraft: [2], ok: false });
    expect(describeCoachSplitOutput(answer("a [NEXT] b", "c [NEXT] d [NEXT] e"), COACH_PRESET_DRAFT_BLOCKS))
      .toEqual({ draftsRequested: 2, partsPerDraft: [2, 3], ok: true });
    // More blocks than the template allows, on either kind of turn.
    const three = answer("a [NEXT] b", "c [NEXT] d", "e [NEXT] f");
    expect(describeCoachSplitOutput(three, null)).toEqual({ draftsRequested: null, partsPerDraft: [2, 2, 2], ok: false });
    expect(describeCoachSplitOutput(three, COACH_PRESET_DRAFT_BLOCKS).ok).toBe(false);
  });

  it("catches a model that opens one fence per part", () => {
    expect(describeCoachSplitOutput(answer("hey you", "what's up"), null))
      .toEqual({ draftsRequested: null, partsPerDraft: [1, 1], ok: false });
  });

  it("reads closed draft blocks only, by the grammar of the template", () => {
    // A marker in the advice, and a fence that is not a draft, are not parts of a draft.
    const noisy = `Вариант такой [NEXT] или такой.\n\`\`\`text\nx [NEXT] y [NEXT] z\n\`\`\`\n${answer("a [NEXT] b")}`;
    expect(describeCoachSplitOutput(noisy, null).partsPerDraft).toEqual([2]);
    // A block that never closes is advice: the released reader leaves it in the prose.
    expect(describeCoachSplitOutput("Совет.\n```draft\na [NEXT] b", null).partsPerDraft).toEqual([]);
    // An opener before the closer abandons the block it interrupts.
    expect(describeCoachSplitOutput("```draft\na [NEXT] b\n```draft\nc [NEXT] d [NEXT] e\n```", null).partsPerDraft).toEqual([3]);
    // Fences are line-anchored: an indented or inline one opens nothing.
    expect(describeCoachSplitOutput("  ```draft\na [NEXT] b\n```\nSee ```draft\nc [NEXT] d\n```", null).partsPerDraft).toEqual([]);
    // Trailing blanks after a fence and CRLF line ends are still the grammar.
    expect(describeCoachSplitOutput("Совет.\r\n```draft \t\r\na [NEXT] b\r\n``` \r\nЕщё.", null).partsPerDraft).toEqual([2]);
    // An empty block is not a draft; a part that is not insertable is not a part.
    expect(describeCoachSplitOutput(answer("  ", "a [NEXT] b [NEXT] ["), null).partsPerDraft).toEqual([2]);
  });

  it("drops reasoning blocks before it looks for fences and markers", () => {
    const leaked = `<think>\n\`\`\`draft\nx [NEXT] y [NEXT] z\n\`\`\`\n</think>\n${answer("a [NEXT] b")}`;
    expect(describeCoachSplitOutput(leaked, null)).toEqual({ draftsRequested: null, partsPerDraft: [2], ok: true });
  });

  it("records counts and never the text", () => {
    const structure = describeCoachSplitOutput(answer("secret opener [NEXT] secret follow-up"), null);
    expect(Object.keys(structure).sort()).toEqual(["draftsRequested", "ok", "partsPerDraft"]);
    expect(JSON.stringify(structure)).not.toContain("secret");
    expect(JSON.stringify(structure)).not.toContain("вопрос");
  });

  it("reads the final text: a fence or a marker cut by a chunk boundary still counts", () => {
    const consumer = new AiGatewayTerminalStreamConsumer();
    const chunks = ["Совет.\n``", "`draft\nhey you [NE", "XT] what's up\n`", "``\nЕщё совет.\n```dra", "ft\na [NEXT", "] b [NE", "XT] c\n``", "`"];
    // What a client receives chunk by chunk carries no whole marker and no whole opener.
    expect(chunks.some((chunk) => chunk.includes("[NEXT]") || chunk.includes("```draft"))).toBe(false);
    for (const text of chunks) {
      consumer.note({ type: "content_delta", text });
    }
    expect(describeCoachSplitOutput(consumer.completionText, null))
      .toEqual({ draftsRequested: null, partsPerDraft: [2, 3], ok: true });
  });
});
