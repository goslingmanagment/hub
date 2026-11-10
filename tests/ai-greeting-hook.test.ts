import { describe, expect, it } from "vitest";

import type { AiGatewayStreamFrame, AiGatewayUsage } from "@agency_hub_core/contracts";

import {
  asksNameOrNick,
  buildPrompt,
  finishGreeting,
  greetingFinisher,
  greetingOpenersManifest,
  greetingProfileKey,
  keepsOpener,
  readGreetingHookLine,
  type GreetingFanProfile,
} from "../apps/runtime/src/modules/ai/index.ts";
import { finishedCompletionStream } from "../apps/runtime/src/services/ai-gateway.ts";

// Hi's personal question (owner, 2026-11-10): the opener's question gives way
// to a question about the fan only when his profile holds a real hook. With no
// hook the opener goes out as the owner wrote it; a question about his name or
// about what his nick means never goes out.

const DAY = "heyy, thanks for the follow :) i never know how to start these, so i'll just ask: how's your day going?";
const RUN = "heyy, thanks for the follow, just back from a run and still out of breath haha. do you run too?";
const ZONE = "hi :) thanks for the follow, i'm in lisbon so i'm curious, what time is it for you?";

function fan(profile: Partial<GreetingFanProfile> & { displayName: string }): GreetingFanProfile {
  return { nameKnown: true, hasAvatar: false, ...profile };
}

const CONNOR = fan({ displayName: "connor512" });
const DJ = fan({ displayName: "DJMarko16" });
const SOCKS = fan({ displayName: "Angry_socks", bio: "Just vibing." });

describe("the hook line", () => {
  it("is cut from the answer and read", () => {
    expect(readGreetingHookLine("HOOK: none\nheyy connor, thanks")).toEqual({ declared: true, hook: null, text: "heyy connor, thanks" });
    expect(readGreetingHookLine('\nhook: interest: "DJ"\n\nheyy marko')).toEqual({
      declared: true,
      hook: { kind: "interest", quote: "DJ" },
      text: "heyy marko",
    });
    expect(readGreetingHookLine("HOOK: place: Zulia\nhi :)").hook).toEqual({ kind: "place", quote: "Zulia" });
  });

  it("is not invented when the answer starts with the message", () => {
    expect(readGreetingHookLine("heyy connor, thanks for the follow")).toEqual({
      declared: false,
      hook: null,
      text: "heyy connor, thanks for the follow",
    });
  });
});

describe("a fan with no hook", () => {
  it("gets the opener as written, his name in the greeting aside", () => {
    const named = `HOOK: none\n${DAY.replace("heyy,", "heyy connor,")}`;
    expect(finishGreeting({ completion: named, openers: [DAY], fan: CONNOR })).toEqual({
      text: DAY.replace("heyy,", "heyy connor,"),
      hook: null,
      questions: ["opener"],
    });
    const greeting = ZONE.replace("hi :)", "hi mateo :)");
    expect(finishGreeting({ completion: `HOOK: none\n${greeting}`, openers: [ZONE], fan: fan({ displayName: "Mateo204" }) }).text)
      .toBe(greeting);
  });

  it("keeps the opener's question whatever the model wrote in its place", () => {
    const rewritten = "HOOK: none\nheyy connor, thanks for the follow :) i never know how to start these, so i'll just ask: is it connor or con?";
    expect(finishGreeting({ completion: rewritten, openers: [DAY], fan: CONNOR })).toEqual({
      text: DAY,
      hook: null,
      questions: ["opener"],
    });
    const nick = "HOOK: none\nheyy, thanks for the follow, but first i need to know what makes socks angry?";
    expect(finishGreeting({ completion: nick, openers: [RUN], fan: SOCKS }).text).toBe(RUN);
  });

  it("has no hook when the model names none, or names words his profile does not hold", () => {
    const noLine = finishGreeting({ completion: "heyy, so are you actually a dj?", openers: [DAY], fan: DJ });
    expect(noLine).toEqual({ text: DAY, hook: null, questions: ["opener"], note: "no-line" });

    const invented = finishGreeting({
      completion: "HOOK: interest: football\nheyy connor, thanks for the follow :) are you a big football fan?",
      openers: [DAY],
      fan: CONNOR,
    });
    expect(invented).toEqual({ text: DAY, hook: null, questions: ["opener"], note: "not-in-profile" });
  });

  it("does not take the platform's own bio line for a hook", () => {
    const stock = fan({ displayName: "tomasz5541x", bio: "Hey, I am using Fansly." });
    const finished = finishGreeting({
      completion: "HOOK: bio: using Fansly\nheyy tomasz, thanks for the follow :) how long have you been on fansly?",
      openers: [DAY],
      fan: stock,
    });
    expect(finished.hook).toBeNull();
    expect(finished.text).toBe(DAY);
  });
});

describe("a fan with a hook", () => {
  const personal = "heyy marko, thanks for the follow :) i never know how to start these, so i'll just ask: are you actually a dj?";

  it("gets one personal question in place of the opener's", () => {
    expect(finishGreeting({ completion: `HOOK: interest: DJ\n${personal}`, openers: [DAY], fan: DJ })).toEqual({
      text: personal,
      hook: { kind: "interest", quote: "DJ" },
      questions: ["personal"],
    });
  });

  it("finds the words of a bio whatever the punctuation between them", () => {
    const bio = fan({ displayName: "user100200300400500600", bio: "Trucker 🚛 | fishing & hiking, Texas" });
    const finished = finishGreeting({
      completion: "HOOK: bio: fishing and hiking\nheyy, thanks for the follow :) what was your best catch?",
      openers: [DAY],
      fan: bio,
    });
    expect(finished.hook).toBeNull();
    expect(finishGreeting({
      completion: "HOOK: bio: fishing & hiking\nheyy, thanks for the follow :) what was your best catch?",
      openers: [DAY],
      fan: bio,
    }).questions).toEqual(["personal"]);
  });

  it.each([
    "heyy, thanks for the follow :) so what's your name?",
    "heyy, thanks for the follow :) what should i call you?",
    "heyy marko, thanks for the follow :) your name's marko, right?",
    "heyy, thanks for the follow :) is it marko or markus?",
    "heyy, thanks for the follow :) what do you go by?",
    "heyy, thanks for the follow :) what does DJMarko even mean?",
    "heyy, thanks for the follow :) what's the story behind your username?",
    "heyy, thanks for the follow :) where does the nick come from?",
    "heyy, thanks for the follow :) how did you come up with that name?",
  ])("never sends a question about his name or his nick: %s", (asked) => {
    expect(asksNameOrNick(asked, DJ)).toBe(true);
    expect(finishGreeting({ completion: `HOOK: interest: DJ\n${asked}`, openers: [DAY], fan: DJ })).toEqual({
      text: DAY,
      hook: { kind: "interest", quote: "DJ" },
      questions: ["opener"],
    });
  });

  it.each([
    personal,
    "hi :) thanks for the follow, i'm in lisbon so zulia in your name caught my eye, is that the one in venezuela?",
    "heyy, thanks for the follow :) is it morning or evening where you are?",
    "heyy, thanks for the follow :) do you actually drive a truck?",
  ])("lets a question about the hook through: %s", (asked) => {
    expect(asksNameOrNick(asked, DJ)).toBe(false);
  });

  it("counts a variant that kept the opener's question as the opener's", () => {
    const finished = finishGreeting({
      completion: `HOOK: interest: DJ\n${DAY}\n[VARIANT]\nheyy marko, thanks for the follow, just back from a run and still out of breath haha. do you dj at clubs?`,
      openers: [DAY, RUN],
      fan: DJ,
    });
    expect(finished.questions).toEqual(["opener", "personal"]);
    expect(finished.text.split("\n[VARIANT]\n")).toHaveLength(2);
  });
});

describe("a regenerated greeting", () => {
  it("keeps the hook an earlier draft found, whatever the model's line says now", () => {
    const again = finishGreeting({
      completion: "HOOK: none\nheyy marko, thanks for the follow :) i never know how to start these, so i'll just ask: what do you spin?",
      openers: [DAY],
      fan: DJ,
      prior: { kind: "interest", quote: "DJ" },
    });
    expect(again.hook).toEqual({ kind: "interest", quote: "DJ" });
    expect(again.questions).toEqual(["personal"]);
  });

  it("keeps a fan with no hook on the opener", () => {
    const again = finishGreeting({
      completion: "HOOK: interest: connor\nheyy connor, thanks for the follow :) is connor a family name?",
      openers: [DAY],
      fan: CONNOR,
      prior: null,
    });
    expect(again).toEqual({ text: DAY, hook: null, questions: ["opener"] });
  });

  it("knows the profile by its names and bio, not by the picture", () => {
    expect(greetingProfileKey(DJ)).toBe(greetingProfileKey({ ...DJ, displayName: " djmarko16 ", hasAvatar: true }));
    expect(greetingProfileKey(DJ)).not.toBe(greetingProfileKey({ ...DJ, bio: "house and techno" }));
  });
});

describe("what a text keeps of its opener", () => {
  it("allows the name in the greeting and nothing else", () => {
    expect(keepsOpener(DAY, DAY)).toBe(true);
    expect(keepsOpener("hey you, welcome ♡ so what are you up to babe?", "hey mat, welcome ♡ so what are you up to babe?")).toBe(true);
    expect(keepsOpener(DAY, DAY.replace("how's your day going?", "how's your night going?"))).toBe(false);
    expect(keepsOpener(DAY, "")).toBe(false);
  });
});

describe("the generation's record", () => {
  const draw = (asWritten: boolean) => ({
    openers: [{ id: 2, body: DAY } as never],
    fan: asWritten ? "bare" as const : "named" as const,
    asWritten,
  });

  it("says a fan who got the opener without the model has no hook", () => {
    expect(greetingOpenersManifest("mia", draw(true), "abc")).toEqual({
      personaKey: "mia",
      ids: [2],
      fan: "bare",
      mode: "as-written",
      profile: "abc",
      hook: null,
      hookQuote: null,
      questions: ["opener"],
    });
  });

  it("gets the hook and what each variant asks once the model answered", () => {
    const base = greetingOpenersManifest("mia", draw(false), "abc");
    expect(base).not.toHaveProperty("hook");
    const finish = greetingFinisher({ openers: [DAY], fan: DJ, prior: undefined, manifest: base });
    expect(finish("HOOK: interest: DJ\nheyy marko, thanks for the follow :) are you actually a dj?")).toEqual({
      text: "heyy marko, thanks for the follow :) are you actually a dj?",
      manifest: {
        greetingOpeners: { ...base, hook: "interest", hookQuote: "DJ", questions: ["personal"] },
      },
    });
  });
});

describe("the prompt of a greeting from an opener", () => {
  function task(greetingHook?: { kind: "bio" | "place" | "interest"; quote: string } | null) {
    const prompt = buildPrompt({
      feature: "hi-greeting",
      personality: { id: "test", name: "Test", content: "You are Test." } as never,
      transcript: "",
      fanSpendingData: "",
      fanSubscriptionData: "",
      fanDisplayName: "DJMarko16",
      greetingVariantCount: 1,
      greetingOpeners: [DAY],
      ...(greetingHook === undefined ? {} : { greetingHook }),
    });
    return prompt.user.slice(prompt.user.indexOf("## Your Task"));
  }

  it("asks the model to decide the hook, and hands an earlier decision back", () => {
    expect(task()).toContain('"HOOK: none"');
    expect(task()).toContain("First decide his hook");
    expect(task({ kind: "interest", quote: "DJ" })).toContain('Your first line is exactly "HOOK: interest: DJ"');
    expect(task({ kind: "interest", quote: "DJ" })).not.toContain("First decide his hook");
    expect(task(null)).toContain('Your first line is exactly "HOOK: none"');
  });
});

describe("finishedCompletionStream", () => {
  const USAGE: AiGatewayUsage = {
    inputTokens: 900,
    outputTokens: 40,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    costMicroUsd: 5_000,
    costApproximate: false,
  };

  async function collect(frames: AiGatewayStreamFrame[], finish: (text: string) => string) {
    async function* source(): AsyncIterable<AiGatewayStreamFrame> {
      for (const frame of frames) yield frame;
    }
    const out: AiGatewayStreamFrame[] = [];
    for await (const frame of finishedCompletionStream(source(), finish)) out.push(frame);
    return out;
  }

  const cut = (text: string) => readGreetingHookLine(text).text;

  it("holds the content back and sends the finished text before the usage", async () => {
    const out = await collect([
      { type: "reasoning_delta", text: "thinking" },
      { type: "content_delta", text: "HOOK: no" },
      { type: "content_delta", text: "ne\nheyy connor" },
      { type: "usage", usage: USAGE, providerResponseId: "msg_1", cacheHit: false },
      { type: "done", stopReason: "end_turn" },
    ], cut);
    expect(out).toEqual([
      { type: "reasoning_delta", text: "thinking" },
      { type: "content_delta", text: "heyy connor" },
      { type: "usage", usage: USAGE, providerResponseId: "msg_1", cacheHit: false },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("never lets the hook line out of a failed answer, and leaves an empty one alone", async () => {
    const failed = await collect([
      { type: "content_delta", text: "HOOK: none\nheyy" },
      { type: "error", code: "provider_stream_failed", message: "boom" } as AiGatewayStreamFrame,
    ], cut);
    expect(failed[0]).toEqual({ type: "content_delta", text: "heyy" });
    expect(failed).toHaveLength(2);

    const empty = await collect([{ type: "done", stopReason: "end_turn" }], () => "never");
    expect(empty).toEqual([{ type: "done", stopReason: "end_turn" }]);
  });

  it("sends the answer as written when finishing throws", async () => {
    const out = await collect([
      { type: "content_delta", text: "heyy" },
      { type: "done", stopReason: "end_turn" },
    ], () => {
      throw new Error("no");
    });
    expect(out[0]).toEqual({ type: "content_delta", text: "heyy" });
  });
});
