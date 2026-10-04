// chat-extension H-10a (architecture.md D-15): Split for Ping and Hi behind the
// `split-all-v1` capability. The builder takes the gate as an input (`splitAll`);
// the gate itself (capability header AND the page's splitAll flag) is the
// feature service's and is pinned in tests/client-ai-split-all.integration.test.ts.
import { describe, expect, it } from "vitest";

import type { AiGatewayStreamFrame } from "@agency_hub_core/contracts";

import {
  FEATURE_POLICIES,
  OPERATION_FEATURES,
  PING_TEMPLATE,
  buildPrompt,
  describeSplitOutput,
  normalizeReplyParts,
  normalizeVariantReplyParts,
  type OperationFeature,
  type PromptBuildInput,
} from "../apps/runtime/src/modules/ai/index.ts";
import { AiGatewayTerminalStreamConsumer } from "../apps/runtime/src/services/ai-gateway.ts";
import { promptDigest, referencePrompts } from "./helpers/ai-prompt-references.ts";

const SPLIT_ALL_FEATURES: readonly OperationFeature[] = ["ping", "hi-greeting"];

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
  it("only Ping and Hi are supportsSplitAll, and neither splits on replyMode alone", () => {
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
