import { createHash } from "node:crypto";

import type { PromptBuildInput, PromptPayload } from "../../apps/runtime/src/modules/ai/index.ts";

// Reference prompts: one fixed input per feature and request shape, on both
// platforms. A prompt is identified by the digest of its blocks, text and
// cache hints, which is exactly what the provider receives. The desktop twin
// the Stage 30 parity harness compared against is gone, so pinned digests are
// what proves a builder change left a released client's prompt byte-identical.

const PERSONALITY = {
  id: "reference-persona",
  name: "Reference Persona",
  content: "## Who you are\nYou are the reference persona on OnlyFans. Keep replies warm and short.",
  updatedAt: 1_751_000_000_000,
};

const TRANSCRIPT = [
  "[10:00] Fan: hey babe, missed you",
  "[10:05] Model: hey you 😘 where have you been",
  "[10:10] Fan: [Tip: $5.00] sent you a little something <3",
  "[10:12] Fan: [Photo - PPV $15.00, purchased] that was so worth it",
].join("\n");

const BASE = {
  personality: PERSONALITY,
  transcript: TRANSCRIPT,
  fanSpendingData: "Total spent: $120.00 (subscriptions $30.00, tips $40.00, messages $50.00)",
  fanSubscriptionData: "Subscribed: yes (since 2026-06-01, renews)",
  fanDisplayName: "Big Spender",
} satisfies Omit<PromptBuildInput, "feature">;

const DOSSIER = { body: "## Facts\nLikes hiking & anime.", generatedAt: new Date("2026-09-01T00:00:00Z") };

const PING = {
  ...BASE,
  feature: "ping",
  fanBio: "into gym and anime, from Texas",
  fanCustomName: "Jake VIP",
  fanProfile: DOSSIER,
} satisfies PromptBuildInput;

const HI = {
  ...BASE,
  feature: "hi-greeting",
  fanBio: "into gym and anime, from Texas",
  fanUsername: "jake77",
  fanCustomName: "Jake VIP",
} satisfies PromptBuildInput;

const COACH = {
  ...BASE,
  feature: "coach-chat",
  fanBio: "into gym and anime, from Texas",
  fanProfile: DOSSIER,
  transcriptCoverage: "window",
} satisfies PromptBuildInput;

/** One fixed input per feature and request shape, in the stored OnlyFans wording. */
const SHAPES: ReadonlyArray<readonly [name: string, input: PromptBuildInput]> = [
  ["fast-reply flirty", { ...BASE, feature: "fast-reply", replyTone: "flirty", fanProfile: DOSSIER }],
  ["fast-reply split", { ...BASE, feature: "fast-reply", replyTone: "none", replyMode: "preferSplit" }],
  ["improve-draft", { ...BASE, feature: "improve-draft", draftText: "hey love, wanna see more? xx" }],
  ["improve-draft split", { ...BASE, feature: "improve-draft", draftText: "hey love, wanna see more? xx", replyMode: "preferSplit" }],
  ["help-me", { ...BASE, feature: "help-me", fanBio: "into gym and anime, from Texas" }],
  ["fan-summary", { ...BASE, feature: "fan-summary", transcriptCoverage: "full-history" }],
  ["fan-summary short", { ...BASE, feature: "fan-summary", summaryMode: "short", transcriptCoverage: "window" }],
  ["chat-review", { ...BASE, feature: "chat-review" }],
  ["ping segment-a", { ...PING, pingSegment: "segment-a", fanSilenceDays: 12 }],
  ["ping segment-b", { ...PING, pingSegment: "segment-b", fanSilenceDays: 75 }],
  ["ping active", { ...PING, pingSegment: "active", fanSilenceDays: 0 }],
  ["hi-greeting 3 variants", { ...HI }],
  ["hi-greeting 1 variant", { ...HI, greetingVariantCount: 1 }],
  ["coach-chat question", {
    ...COACH,
    chatterQuestion: "как продать ppv?",
    draftText: "hey, wanna see what I filmed today?",
    coachHistory: [{ question: "с чего начать?", answer: "Спроси про выходные." }],
    recapAttach: {
      full: { body: "FULL RECAP", ageMs: 3 * 86_400_000 },
      short: { body: "SHORT RECAP", ageMs: 10 * 60_000 },
    },
  }],
  ["coach-chat preset", { ...COACH, chatterQuestion: "Разбери текущую ситуацию.", preset: "situation" }],
  ["voice-script", { ...BASE, feature: "voice-script", draftText: "hey love, wanna see more? xx", replyTone: "spicy" }],
];

export interface ReferencePrompt {
  /** `<platform> <feature and shape>`: the key of its pinned digest. */
  name: string;
  input: PromptBuildInput;
}

export function referencePrompts(): ReferencePrompt[] {
  return (["onlyfans", "fansly"] as const).flatMap((platform) =>
    SHAPES.map(([name, input]) => ({ name: `${platform} ${name}`, input: { ...input, platform } })));
}

/** What the provider receives: every block's text and cache hint, in order. */
export function promptDigest(payload: Pick<PromptPayload, "systemBlocks" | "userBlocks">): string {
  return createHash("sha256")
    .update(JSON.stringify([payload.systemBlocks, payload.userBlocks]))
    .digest("hex");
}
