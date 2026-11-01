import type { AiGatewayStreamFrame } from "@agency_hub_core/contracts";
import { openWordStart, plainLatinSpelling, respelledNameWords } from "@agency_hub_core/shared";
import { describe, expect, it } from "vitest";

import { buildPrompt, fanNameRespeller, type FanNames, type PromptFeature } from "../apps/runtime/src/modules/ai/index.ts";
import { rewriteWordsStream } from "../apps/runtime/src/services/ai-gateway-word-rewrite.ts";

// A fan's name in what the model writes to him is typed plain (owner,
// 2026-11-01): Reply copied «Çağlar Akmaz» from his Fansly profile into «so
// what brought you to me today, Çağlar?», and a name pasted with its marks
// shows the message was never typed.

describe("plainLatinSpelling", () => {
  it("types Latin letters plain: marks off, fancy fonts folded, letters that hold their mark spelled out", () => {
    expect(plainLatinSpelling("Çağlar Akmaz")).toBe("Caglar Akmaz");
    expect(plainLatinSpelling("kauê")).toBe("kaue");
    expect(plainLatinSpelling("paweł Żółć")).toBe("pawel Zolc");
    expect(plainLatinSpelling("Bjørn Strauß İlkay")).toBe("Bjorn Strauss Ilkay");
    expect(plainLatinSpelling("Nguyễn Đức")).toBe("Nguyen Duc");
    expect(plainLatinSpelling("𝓜𝓲𝓴𝓮 Ｊｏｈｎ ᴊᴏʜɴ")).toBe("Mike John john");
    expect(plainLatinSpelling("Çağlar")).toBe("Caglar");
  });

  it("leaves other scripts, digits, emoji and spacing as they were", () => {
    expect(plainLatinSpelling("Коля Йоханнес Алёна")).toBe("Коля Йоханнес Алёна");
    expect(plainLatinSpelling("й")).toBe("й");
    expect(plainLatinSpelling("Νίκος 王伟 محمد")).toBe("Νίκος 王伟 محمد");
    expect(plainLatinSpelling("Mike 🔥 / 35 / US")).toBe("Mike 🔥 / 35 / US");
  });
});

describe("respelledNameWords", () => {
  it("keeps only the words of his names that the plain spelling changes, lower-case", () => {
    expect([...respelledNameWords(["Çağlar Akmaz", "u5744358", undefined, null, "Çağlar 🐳 кит"])]).toEqual(["çağlar"]);
    expect(respelledNameWords(["John", "Коля", "É"]).size).toBe(0);
  });
});

describe("openWordStart", () => {
  it("finds the word a chunk ends inside", () => {
    expect(openWordStart("today, Ça")).toBe(7);
    expect(openWordStart("today, Çağlar?")).toBe(14);
    expect(openWordStart("[NEXT")).toBe(1);
    expect(openWordStart("hey привет")).toBe(10);
    expect(openWordStart("你好我很想你")).toBe(6);
    expect(openWordStart("hi 王Ça")).toBe(6);
    expect(openWordStart("hey \uD835")).toBe(4);
    expect(openWordStart("")).toBe(0);
  });
});

async function* framesOf(frames: AiGatewayStreamFrame[]): AsyncIterable<AiGatewayStreamFrame> {
  for (const frame of frames) yield frame;
}

const delta = (text: string): AiGatewayStreamFrame => ({ type: "content_delta", text });
const DONE: AiGatewayStreamFrame = { type: "done", stopReason: "end_turn" };

async function rewritten(frames: AiGatewayStreamFrame[], names: string[]) {
  const respell = fanNameRespeller({ feature: "fast-reply", fanDisplayName: names[0] ?? "fan", fanNames: { name: names[0] } });
  if (respell === null) throw new Error("no respeller");
  let count = -1;
  const out: AiGatewayStreamFrame[] = [];
  for await (const frame of rewriteWordsStream(framesOf(frames), respell, (n) => {
    count = n;
  })) {
    out.push(frame);
  }
  return { out, count, text: out.flatMap((frame) => (frame.type === "content_delta" ? [frame.text] : [])).join("") };
}

describe("rewriteWordsStream", () => {
  it("types his name plain even when a delta cuts it, and leaves the fan's language as it is", async () => {
    const { text, count, out } = await rewritten(
      [delta("sí, me gustó [NEXT]so what brought you to me today, Ça"), delta("ğ"), delta("lar? ÇAĞLAR"), DONE],
      ["Çağlar Akmaz"],
    );
    expect(text).toBe("sí, me gustó [NEXT]so what brought you to me today, Caglar? CAGLAR");
    expect(count).toBe(2);
    expect(out.at(-1)).toEqual(DONE);
  });

  it("lets reasoning through at once and sends the held word before usage, done or an error", async () => {
    const usage: AiGatewayStreamFrame = {
      type: "usage",
      usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, costMicroUsd: 1, costApproximate: false },
      providerResponseId: null,
      cacheHit: false,
    };
    const { out } = await rewritten([delta("hey kau"), { type: "reasoning_delta", text: "" }, delta("ê"), usage, DONE], ["kauê"]);
    expect(out).toEqual([delta("hey "), { type: "reasoning_delta", text: "" }, delta("kaue"), usage, DONE]);

    const error: AiGatewayStreamFrame = { type: "error", code: "provider_error", message: "boom", retryAfterMs: null };
    expect((await rewritten([delta("hi paweł"), error], ["paweł"])).out).toEqual([delta("hi "), delta("pawel"), error]);
  });
});

const build = (feature: PromptFeature, fanNames: FanNames) => buildPrompt({
  feature,
  personality: { id: "test", name: "Test", content: "You are Test." } as never,
  transcript: "--- 2026-11-01 ---\n[15:40] Fan: hi there",
  fanSpendingData: "",
  fanSubscriptionData: "",
  fanDisplayName: "Çağlar Akmaz",
  fanUsername: "çağlar_88",
  fanCustomName: "Çağlar кит",
  fanNames,
  draftText: "hey Çağlar",
});

describe("the prompt's names of the fan", () => {
  const names: FanNames = { name: "Çağlar Akmaz", username: "u5744358", customName: "Çağlar кит" };

  it.each(["fast-reply", "improve-draft", "hi-greeting", "ping", "coach-chat", "help-me", "voice-script"] satisfies PromptFeature[])(
    "%s names him typed plain, and rewrites a copy of his name in its answer",
    (feature) => {
      const prompt = build(feature, names);
      expect(prompt.user).not.toMatch(/Çağlar Akmaz|çağlar_88|Çağlar кит/u);
      expect(fanNameRespeller({ feature, fanDisplayName: "Çağlar Akmaz", fanNames: names })?.("Çağlar")).toBe("Caglar");
    },
  );

  it("Reply's Fan section reads the plain name", () => {
    expect(build("fast-reply", names).user).toContain("Profile name: Caglar Akmaz\nUsername: u5744358\nName the chatter saved for this fan: Caglar кит");
  });

  it.each(["fan-summary", "fan-notes-fill"] satisfies PromptFeature[])("%s keeps his name as his profile spells it", (feature) => {
    expect(fanNameRespeller({ feature, fanDisplayName: "Çağlar Akmaz" })).toBeNull();
  });

  it("rewrites nothing when no name of his changes", () => {
    expect(fanNameRespeller({ feature: "fast-reply", fanDisplayName: "John", fanNames: { name: "John" } })).toBeNull();
  });
});
