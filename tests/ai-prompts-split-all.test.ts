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
  COACH_DRAFT_CHARS_MAX,
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
  // A deliberate prompt change re-pins them in one step:
  //   npx vitest run tests/ai-prompts-split-all.test.ts -u
  // and the diff of this block then names every prompt that changed.
  it("every reference prompt keeps its pinned digest", () => {
    expect(Object.fromEntries(references.map(({ name, input }) => [name, digestOf(input)]))).toMatchInlineSnapshot(`
      {
        "fansly chat-review": "3af5dc4915dc7e48f266a82ccdb27e95d69920f61c54ff0e8f61519196d204ea",
        "fansly coach-chat preset": "b132464cc2587d3fabd21ef218a94b10f391aae137df0601354a3906ba3af342",
        "fansly coach-chat question": "2712b1621311dae15bc88c2e88f550ea7f0ac6bb2002ab4ccd0aaa3a3cbf7d2e",
        "fansly fan-notes-fill": "daf81f8c0f67247bc858abbab87a9461ac94a1ee3dc62b219bf933b1d3011806",
        "fansly fan-notes-fill merge": "a01e1ce9419be1a70e8a175a61137de978e83c11cac90888f1e51552eb79d6b5",
        "fansly fan-summary": "1c285faa27602905a5b32f8f6e746ba6f15ee3e70266b6bf53df86557658608c",
        "fansly fan-summary short": "be0c61ce3645909e4bbafe5339305b54c1e7556108feaa025bc047ad1ff116e7",
        "fansly fast-reply flirty": "8f1b197b5207568bd6959ad2b4996faeef1fe6cf6ec50f8e7a3a6cbbbcc2f493",
        "fansly fast-reply split": "402087adb4a1ac8e380160ed62ab346a37244658bd380bd650d454e19bad1d81",
        "fansly help-me": "81d6065a83a6ef9903dca2e70c9a7b36f1635c5492b29ffac2b7ec56a42b1514",
        "fansly hi-greeting 1 variant": "0eb083e9b5379e8e2fb28db769f953902fa90cc18061ec2596c29d994d0f3512",
        "fansly hi-greeting 3 variants": "afd51fdcc4b0cca51a722cc4b6e770d7933d56d3cabbb4ec88ad7d20d45f6b87",
        "fansly improve-draft": "3122e7cead34d75930ee05466faf8af68dd44737752ad352adfaf3245897af95",
        "fansly improve-draft split": "bc68d791c17ca35bef9ad0d5c31a8b8ecc906552246ccb4a613618ae3daa3a9e",
        "fansly ping active": "16ecfd3ef4905cd970f748622e80497585450a2cf0cf92a266fb9c6d2d2b754f",
        "fansly ping segment-a": "44e8fe1a396c519097dc1adc94808db8659445d49e45d8a26d93c27313eabeee",
        "fansly ping segment-b": "31955b05ad63764c323224373160233e61dad1ac56d998449e35831aec59f47a",
        "fansly voice-script": "414dbf45b2eb7ae59dac6b0d23abcff2651881f5d891e4d68531991b4c7b78c7",
        "onlyfans chat-review": "8e31eb3d71be31db2994a3ad744686a3c08f497fa1550c62819bd6a5897c907d",
        "onlyfans coach-chat preset": "62fa9d4f494654d401bea320495199d7e25090880f8dce6a7d439eaa5910301a",
        "onlyfans coach-chat question": "5f46fcc197a608aea6250e1a84998c91d6b637438d8317dc032e74fcd2092a79",
        "onlyfans fan-notes-fill": "e0db65c8d1c025b659f24b93a0ca65b489078c4eb0fa67737a7381097cb3854d",
        "onlyfans fan-notes-fill merge": "2f324f723f4da09538539285f59aa9f040df24779f49b11224130a5cf44573df",
        "onlyfans fan-summary": "cf9d764fa01021c3c7de5c80bfd4ee20e55ca7339f8407febd2fe9042d8c6aa3",
        "onlyfans fan-summary short": "5fc64de55801357755f223d3cd5f3e57a02ad6255baa71c6ac2a6c35e96db85f",
        "onlyfans fast-reply flirty": "3fe119000caf6a71e1d535d5e9e54ca69591696ebf0a1126ba10aee5d71289d6",
        "onlyfans fast-reply split": "b1ff376d2e4c3a67bf7d1c009656a89e8bc3931344610a7f55f3ac2a474bea42",
        "onlyfans help-me": "61ca6b6e41c1d465b41ee8e8a3c6c7928623199a4fbef0e39207b71a20dae50b",
        "onlyfans hi-greeting 1 variant": "061cb88da7106081454cdbfeeb7a206b3dcbd836936469037a60e9db2ac90db1",
        "onlyfans hi-greeting 3 variants": "7bcd178e5cad28af92e506b606ad7cfc9b24ce70b2d2daab4958e582d3470ad0",
        "onlyfans improve-draft": "5e2c29c4c80316cf203fd3527895cbd06758a1fc8c9e952fb79b028d28601604",
        "onlyfans improve-draft split": "6fd6bc599260e4c847b79308c9e2743960b0e975ab35ebc30bc56e10935ba031",
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
    expect(COACH_DRAFT_CHARS_MAX).toBe(1500);
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

    // <thinking> is the tag Opus 5.5 leaked in production; <reasoning> and an
    // unclosed bare tag on its own line are reasoning too.
    const thinking = "<thinking>a [VARIANT] b [NEXT] c</thinking>one [NEXT] two [VARIANT] three [NEXT] four [VARIANT] five [NEXT] six";
    expect(describeSplitOutput(thinking, 3)).toEqual({ variantsRequested: 3, partsPerVariant: [2, 2, 2], ok: true });
    expect(describeSplitOutput("<reasoning>x [NEXT] y</reasoning>one [NEXT] two", 1).partsPerVariant).toEqual([2]);
    expect(describeSplitOutput("one [NEXT] two\n<thinking>x [VARIANT] y [NEXT] z", 1))
      .toEqual({ variantsRequested: 1, partsPerVariant: [2], ok: true });
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
  /** The record of an answer with nothing of a draft left in the advice. */
  const clean = (draftsRequested: number | null, partsPerDraft: number[], ok: boolean) =>
    ({ draftsRequested, partsPerDraft, brokenDrafts: 0, strayMarkers: 0, ok });

  it("counts the [NEXT] parts inside each draft block: two or three is the ask", () => {
    expect(describeCoachSplitOutput(answer("hey you [NEXT] what's up"), null)).toEqual(clean(null, [2], true));
    // The marker on its own line, as a model tends to write it inside a fence.
    expect(describeCoachSplitOutput(answer("hey you\n[NEXT]\nwhat's up", "a\n[NEXT]\nb\n[NEXT]\nc"), null))
      .toEqual(clean(null, [2, 3], true));
    expect(describeCoachSplitOutput(answer("one message only"), null)).toEqual(clean(null, [1], false));
    expect(describeCoachSplitOutput(answer("a [NEXT] b", "c [NEXT] d [NEXT] e [NEXT] f"), null))
      .toEqual(clean(null, [2, 4], false));
  });

  it("a question turn may propose nothing; a preset turn must propose exactly two", () => {
    expect(describeCoachSplitOutput("Тут писать ничего не нужно, подожди его ответа.", null))
      .toEqual(clean(null, [], true));
    expect(describeCoachSplitOutput("Тут писать ничего не нужно.", COACH_PRESET_DRAFT_BLOCKS))
      .toEqual(clean(2, [], false));
    expect(describeCoachSplitOutput(answer("a [NEXT] b"), COACH_PRESET_DRAFT_BLOCKS)).toEqual(clean(2, [2], false));
    expect(describeCoachSplitOutput(answer("a [NEXT] b", "c [NEXT] d [NEXT] e"), COACH_PRESET_DRAFT_BLOCKS))
      .toEqual(clean(2, [2, 3], true));
    // More blocks than the template allows, on either kind of turn.
    const three = answer("a [NEXT] b", "c [NEXT] d", "e [NEXT] f");
    expect(describeCoachSplitOutput(three, null)).toEqual(clean(null, [2, 2, 2], false));
    expect(describeCoachSplitOutput(three, COACH_PRESET_DRAFT_BLOCKS).ok).toBe(false);
  });

  it("catches a model that opens one fence per part", () => {
    expect(describeCoachSplitOutput(answer("hey you", "what's up"), null)).toEqual(clean(null, [1, 1], false));
  });

  it("reads closed draft blocks only, by the grammar of the template", () => {
    // An opener before the closer abandons the block it interrupts.
    expect(describeCoachSplitOutput("```draft\na [NEXT] b\n```draft\nc [NEXT] d [NEXT] e\n```", null))
      .toEqual({ draftsRequested: null, partsPerDraft: [3], brokenDrafts: 1, strayMarkers: 1, ok: false });
    // Trailing blanks after a fence and CRLF line ends are still the grammar.
    expect(describeCoachSplitOutput("Совет.\r\n```draft \t\r\na [NEXT] b\r\n``` \r\nЕщё.", null))
      .toEqual(clean(null, [2], true));
    // An empty block is not a draft, and a client drops it; a part that is not insertable is not a part.
    expect(describeCoachSplitOutput(answer("  ", "a [NEXT] b [NEXT] ["), null)).toEqual(clean(null, [2], true));
    // A block with text and no insertable part is still a block a client lifts.
    expect(describeCoachSplitOutput(answer("[NEXT]"), null)).toEqual(clean(null, [0], false));
  });

  it("an answer whose drafts were not read is not the answer that proposes none", () => {
    const unread = (text: string, brokenDrafts: number, strayMarkers: number, draftsRequested: number | null = null) =>
      expect(describeCoachSplitOutput(text, draftsRequested), JSON.stringify(text))
        .toEqual({ draftsRequested, partsPerDraft: [], brokenDrafts, strayMarkers, ok: false });
    // The block never closes: the answer ran out of tokens, with or without a marker so far.
    unread("Совет.\n```draft\nhey [NEXT] you", 1, 1);
    unread("Совет.\n```draft\nhey you", 1, 0);
    // The closer is glued to the text, so the block never closes either.
    unread("```draft\na [NEXT] b```", 1, 1);
    // Fences are line-anchored and spelled one way: none of these opens a block.
    unread("1. Напиши так:\n   ```draft\n   a [NEXT] b\n   ```", 1, 1);
    unread("```Draft\na [NEXT] b\n```", 1, 1);
    unread("````draft\na [NEXT] b\n````", 1, 1);
    unread("```draft message\na [NEXT] b\n```", 1, 1);
    unread("See ```draft\na [NEXT] b\n```", 1, 1);
    // The same fences around a message the model did not split.
    unread("   ```draft\n   hey you\n   ```", 1, 0);
    // A message with its parts and no fence at all.
    unread("Напиши так:\nhey you [NEXT] what's up", 0, 1);
    // A fence that is not a draft: its markers are not parts of one.
    unread("```text\nx [NEXT] y [NEXT] z\n```", 0, 2);
    // A preset turn is held to the same.
    unread("СИТУАЦИЯ: тёплый.\n```draft\na [NEXT] b", 1, 1, COACH_PRESET_DRAFT_BLOCKS);
  });

  it("a marker in the advice is not ok, however good the drafts are", () => {
    expect(describeCoachSplitOutput(`Вариант такой [NEXT] или такой.\n${answer("a [NEXT] b")}`, null))
      .toEqual({ draftsRequested: null, partsPerDraft: [2], brokenDrafts: 0, strayMarkers: 1, ok: false });
    expect(describeCoachSplitOutput(`${answer("a [NEXT] b", "c [NEXT] d")}\n[NEXT]`, COACH_PRESET_DRAFT_BLOCKS))
      .toEqual({ draftsRequested: 2, partsPerDraft: [2, 2], brokenDrafts: 0, strayMarkers: 1, ok: false });
    // An unread draft next to a read one.
    expect(describeCoachSplitOutput(`${answer("a [NEXT] b")}\n  \`\`\`draft\nc [NEXT] d [NEXT] e\n\`\`\``, null))
      .toEqual({ draftsRequested: null, partsPerDraft: [2], brokenDrafts: 1, strayMarkers: 2, ok: false });
  });

  it("a block over the size limit stays in the advice with its markers, as a client leaves it", () => {
    const sized = (chars: number) => `${"a".repeat(chars - 9)} [NEXT] b`;
    expect(Array.from(sized(COACH_DRAFT_CHARS_MAX))).toHaveLength(1500);
    expect(describeCoachSplitOutput(answer(sized(COACH_DRAFT_CHARS_MAX)), null)).toEqual(clean(null, [2], true));
    expect(describeCoachSplitOutput(answer(sized(COACH_DRAFT_CHARS_MAX + 1)), null))
      .toEqual({ draftsRequested: null, partsPerDraft: [], brokenDrafts: 1, strayMarkers: 1, ok: false });
    expect(describeCoachSplitOutput(answer("a [NEXT] b", sized(COACH_DRAFT_CHARS_MAX + 1)), COACH_PRESET_DRAFT_BLOCKS))
      .toEqual({ draftsRequested: 2, partsPerDraft: [2], brokenDrafts: 1, strayMarkers: 1, ok: false });
    // Code points, as both readers measure: 800 emoji are 1600 UTF-16 units and fit.
    const emoji = `${"😘".repeat(800)} [NEXT] b`;
    expect(emoji.length).toBeGreaterThan(COACH_DRAFT_CHARS_MAX);
    expect(describeCoachSplitOutput(answer(emoji), null)).toEqual(clean(null, [2], true));
  });

  it("drops reasoning blocks before it looks for fences and markers", () => {
    const leaked = `<think>\n\`\`\`draft\nx [NEXT] y [NEXT] z\n\`\`\`\nor [NEXT] and an open \`\`\`draft\n</think>\n${answer("a [NEXT] b")}`;
    expect(describeCoachSplitOutput(leaked, null)).toEqual(clean(null, [2], true));
    expect(describeCoachSplitOutput(leaked.replace(/think>/g, "thinking>"), null)).toEqual(clean(null, [2], true));
    // A tag the advice only mentions, mid-line and never closed, cuts nothing.
    const mention = ["```draft\na [NEXT] b\n```", "He wrote <thinking> of you, so play along.", "```draft\nc [NEXT] d\n```"].join("\n\n");
    expect(describeCoachSplitOutput(mention, null)).toEqual(clean(null, [2, 2], true));
  });

  it("records counts and never the text", () => {
    const structure = describeCoachSplitOutput(`secret advice [NEXT]\n${answer("secret opener [NEXT] secret follow-up")}\n\`\`\`draft\nsecret cut`, null);
    expect(Object.keys(structure).sort()).toEqual(["brokenDrafts", "draftsRequested", "ok", "partsPerDraft", "strayMarkers"]);
    expect(structure).toMatchObject({ partsPerDraft: [2], brokenDrafts: 1, strayMarkers: 1 });
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
    expect(describeCoachSplitOutput(consumer.completionText, null)).toEqual(clean(null, [2, 3], true));
  });
});
