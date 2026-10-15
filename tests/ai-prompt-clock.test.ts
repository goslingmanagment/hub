import { describe, expect, it } from "vitest";

import { aiFeatureStreamBodySchema } from "@agency_hub_core/contracts";
import {
  BUNDLED_LORA_PERSONALITY_ID,
  COACH_PROMPT_MAX_CHARS,
  buildPrompt,
  formatTranscript,
  formatTranscriptDayLine,
  formatTranscriptLine,
  personaLocalTime,
  promptTranscriptClock,
  transcriptMessagesOmittedByBudget,
  type PromptBuildInput,
  type PromptClock,
  type TranscriptMessage,
} from "../apps/runtime/src/modules/ai/index.ts";
import { referencePrompts } from "./helpers/ai-prompt-references.ts";

// Calendar context (Lora persona audit, 2026-10-15): a 100-message window
// often spans days or weeks, and `[HH:MM]` alone read as one day. On
// 2026-10-14 a draft asked a fan whether his plan for 1 October still held.
// The hub's transcript now opens every UTC day with a day line, and the task
// block of the fan-facing prompts opens with one `Now:` line.

function message(id: number, iso: string, sender: "Fan" | "Model" = "Fan", text = `message ${id}`): TranscriptMessage {
  return { id: String(id), createdAtMs: Date.parse(iso), sender, text, labels: [] };
}

const MINSK = { place: "Minsk", timeZone: "Europe/Minsk" };
const NOW = Date.parse("2026-10-15T04:12:30.000Z");

describe("day lines in the hub's transcript", () => {
  it("open each UTC day, across midnight", () => {
    expect(formatTranscript([
      message(1, "2026-10-13T23:58:00Z", "Fan", "still up?"),
      message(2, "2026-10-13T23:59:00Z", "Model", "always"),
      message(3, "2026-10-14T00:03:00Z", "Fan", "same"),
    ])).toBe([
      "--- 2026-10-13 ---",
      "[23:58] Fan: still up?",
      "[23:59] Model: always",
      "--- 2026-10-14 ---",
      "[00:03] Fan: same",
    ].join("\n"));
  });

  it("date a window of several weeks, one line per day that has messages", () => {
    expect(formatTranscript([
      message(1, "2026-09-28T10:00:00Z", "Fan", "giving the kittens away on Oct 1"),
      message(2, "2026-09-28T10:05:00Z", "Model", "aww"),
      message(3, "2026-10-01T18:00:00Z", "Fan", "they're gone"),
      message(4, "2026-10-14T09:30:00Z", "Fan", "hey"),
    ])).toBe([
      "--- 2026-09-28 ---",
      "[10:00] Fan: giving the kittens away on Oct 1",
      "[10:05] Model: aww",
      "--- 2026-10-01 ---",
      "[18:00] Fan: they're gone",
      "--- 2026-10-14 ---",
      "[09:30] Fan: hey",
    ].join("\n"));
  });

  it("carry the year across New Year", () => {
    expect(formatTranscript([message(1, "2025-12-31T23:59:00Z"), message(2, "2026-01-01T00:00:00Z")]).split("\n"))
      .toEqual(["--- 2025-12-31 ---", "[23:59] Fan: message 1", "--- 2026-01-01 ---", "[00:00] Fan: message 2"]);
  });

  it("leave the message lines and the empty transcript as they were", () => {
    const one = message(1, "2026-10-14T09:30:00Z", "Fan", "hi");
    expect(formatTranscriptLine(one)).toBe("[09:30] Fan: hi");
    expect(formatTranscriptDayLine(one.createdAtMs)).toBe("--- 2026-10-14 ---");
    expect(formatTranscript([one])).toBe("--- 2026-10-14 ---\n[09:30] Fan: hi");
    expect(formatTranscript([])).toBe("No conversation history.");
  });

  it("are UTC whatever the host's time zone", () => {
    const messages = [message(1, "2026-10-13T20:30:00Z"), message(2, "2026-10-13T21:30:00Z")];
    const utc = formatTranscript(messages);
    const before = process.env.TZ;
    try {
      // UTC+3: the second message is past local midnight.
      process.env.TZ = "Europe/Minsk";
      expect(new Date(messages[1]!.createdAtMs).getDate()).toBe(14);
      expect(formatTranscript(messages)).toBe(utc);
    } finally {
      if (before === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = before;
      }
    }
    expect(utc).toBe("--- 2026-10-13 ---\n[20:30] Fan: message 1\n[21:30] Fan: message 2");
  });
});

describe("the context frame's budget accounting with day lines", () => {
  // Three days, two messages each.
  const messages = [
    message(1, "2026-10-01T10:00:00Z"),
    message(2, "2026-10-01T11:00:00Z", "Model"),
    message(3, "2026-10-02T10:00:00Z"),
    message(4, "2026-10-02T11:00:00Z", "Model"),
    message(5, "2026-10-03T10:00:00Z"),
    message(6, "2026-10-03T11:00:00Z", "Model"),
  ];
  const transcript = formatTranscript(messages);
  const startOf = (index: number) => transcript.indexOf(formatTranscriptLine(messages[index]!));
  const omittedBy = (omittedChars: number) =>
    transcriptMessagesOmittedByBudget({ transcript, messages, omittedChars });

  it("counts a day's first message whole when the cut ends in its day line", () => {
    const dayLine = transcript.indexOf("--- 2026-10-02 ---");
    expect(dayLine).toBeGreaterThan(0);
    expect(omittedBy(dayLine)).toBe(2);
    expect(omittedBy(dayLine + 5)).toBe(2);
    expect(omittedBy(startOf(2))).toBe(2);
    expect(omittedBy(startOf(2) + 1)).toBe(3);
    expect(omittedBy(startOf(5) + 1)).toBe(6);
  });

  it("agrees with the Coach reducer on a transcript of many days", () => {
    // One message an hour for 1500 hours: about 62 day lines.
    const long = Array.from({ length: 1_500 }, (_, index) => ({
      id: String(index + 1),
      createdAtMs: Date.parse("2026-08-01T00:30:00Z") + index * 3_600_000,
      sender: index % 2 === 0 ? "Fan" as const : "Model" as const,
      text: `msg-${index + 1}-🎉 ${"y".repeat(300)}`,
      labels: [],
    }));
    const text = formatTranscript(long);
    expect(text.split("\n").filter((line) => line.startsWith("--- ")).length).toBe(63);
    const built = buildPrompt({
      feature: "coach-chat",
      personality: { content: "PERSONA", id: "p1", name: "Persona", updatedAt: 1 },
      transcript: text,
      fanSpendingData: "",
      fanSubscriptionData: "",
      fanDisplayName: "Bob",
      chatterQuestion: "what now?",
      clock: { nowMs: NOW, transcript: "utc", modelLocal: MINSK },
    });
    expect(text.length).toBeGreaterThan(COACH_PROMPT_MAX_CHARS);
    const omitted = transcriptMessagesOmittedByBudget({
      transcript: text,
      messages: long,
      omittedChars: built.coachTranscriptOmittedChars!,
    });
    expect(omitted).toBeGreaterThan(0);
    expect(omitted).toBeLessThan(long.length);
    expect(built.user).toContain(formatTranscriptLine(long[omitted]!));
    expect(built.user).not.toContain(formatTranscriptLine(long[omitted - 1]!));
  });
});

describe("the Now line", () => {
  const base = {
    personality: { content: "PERSONA", id: "p1", name: "Persona", updatedAt: 1 },
    transcript: "--- 2026-10-14 ---\n[09:30] Fan: hi",
    fanSpendingData: "",
    fanSubscriptionData: "",
    fanDisplayName: "Bob",
    draftText: "hey you",
    chatterQuestion: "what now?",
  } satisfies Omit<PromptBuildInput, "feature">;
  const hubClock: PromptClock = { nowMs: NOW, transcript: "utc", modelLocal: MINSK };
  const taskOf = (input: PromptBuildInput) => buildPrompt(input).userBlocks.at(-1)!.text;
  const lineOf = (clock: PromptClock) =>
    taskOf({ ...base, feature: "fast-reply", clock }).split("\n").find((line) => line.startsWith("Now: "));

  it("names the UTC date and time, the transcript's clock and the model's local time", () => {
    expect(lineOf(hubClock)).toBe(
      "Now: Thu 2026-10-15, 04:12 UTC. Transcript times and day lines are UTC. "
        + "The model's local time: Thu 07:12 (Minsk, UTC+3).",
    );
  });

  it("gives the local weekday when the model's day is already the next one", () => {
    expect(lineOf({ ...hubClock, nowMs: Date.parse("2026-10-14T22:30:00Z") })).toBe(
      "Now: Wed 2026-10-14, 22:30 UTC. Transcript times and day lines are UTC. "
        + "The model's local time: Thu 01:30 (Minsk, UTC+3).",
    );
  });

  it("says a client's transcript is in that device's clock", () => {
    expect(lineOf({ ...hubClock, transcript: "client" })).toBe(
      "Now: Thu 2026-10-15, 04:12 UTC. Transcript times come from the chatter's device clock, "
        + "which may be in another time zone. The model's local time: Thu 07:12 (Minsk, UTC+3).",
    );
  });

  it("names no local time for a persona the hub cannot place", () => {
    expect(lineOf({ nowMs: NOW, transcript: "utc" })).toBe(
      "Now: Thu 2026-10-15, 04:12 UTC. Transcript times and day lines are UTC.",
    );
  });

  it("writes the zone's own offset", () => {
    const local = (timeZone: string, nowMs = NOW) =>
      lineOf({ nowMs, transcript: "utc", modelLocal: { place: "X", timeZone } })!.split("local time: ")[1];
    expect(local("America/New_York")).toBe("Thu 00:12 (X, UTC-4).");
    expect(local("Asia/Kolkata")).toBe("Thu 09:42 (X, UTC+5:30).");
    expect(local("Europe/London", Date.parse("2026-01-15T12:00:00Z"))).toBe("Thu 12:00 (X, UTC).");
  });

  it("is one length every day of the week", () => {
    const lengths = new Set(Array.from({ length: 7 }, (_, day) => lineOf({ ...hubClock, nowMs: NOW + day * 86_400_000 })!.length));
    expect(lengths.size).toBe(1);
  });

  it("opens the task of every fan-facing feature, and of no other", () => {
    const opens = (input: PromptBuildInput) => taskOf({ ...input, clock: hubClock }).startsWith(`## Your Task\n\n${lineOf(hubClock)}\n`);
    const fanFacing: PromptBuildInput[] = [
      { ...base, feature: "fast-reply" },
      { ...base, feature: "improve-draft" },
      { ...base, feature: "ping", pingSegment: "segment-a", fanSilenceDays: 12 },
      { ...base, feature: "hi-greeting" },
      { ...base, feature: "help-me" },
      { ...base, feature: "coach-chat" },
      { ...base, feature: "fan-summary" },
      { ...base, feature: "fan-summary", summaryMode: "short" },
    ];
    for (const input of fanFacing) {
      expect(opens(input), `${input.feature} ${input.summaryMode ?? ""}`).toBe(true);
    }
    for (const feature of ["chat-review", "voice-script", "fan-notes-fill"] as const) {
      const prompt = buildPrompt({ ...base, feature, noteFields: ["Имя"], clock: hubClock });
      expect(`${prompt.system}${prompt.user}`, feature).not.toContain("Now: ");
    }
  });

  it("changes only the uncached task block, by exactly that line", () => {
    for (const { name, input } of referencePrompts()) {
      const without = buildPrompt(input);
      const withClock = buildPrompt({ ...input, clock: hubClock });
      const later = buildPrompt({ ...input, clock: { ...hubClock, nowMs: NOW + 3 * 86_400_000 + 7 * 60_000 } });
      expect(withClock.systemBlocks, name).toEqual(without.systemBlocks);
      expect(withClock.userBlocks.slice(0, -1), name).toEqual(without.userBlocks.slice(0, -1));
      expect(later.userBlocks.slice(0, -1), name).toEqual(without.userBlocks.slice(0, -1));
      const task = withClock.userBlocks.at(-1)!;
      expect(task.cache, name).toBe("none");
      expect(task.text.replace(`${lineOf(hubClock)}\n`, ""), name).toBe(without.userBlocks.at(-1)!.text);
    }
  });

  it("keeps the Coach's cached blocks byte-identical from one day to the next when the budget cuts", () => {
    const long = Array.from({ length: 1_500 }, (_, index) =>
      message(index + 1, new Date(Date.parse("2026-08-01T00:30:00Z") + index * 3_600_000).toISOString(),
        index % 2 === 0 ? "Fan" : "Model", `msg-${index + 1} ${"y".repeat(300)}`));
    const coach = (nowMs: number) => buildPrompt({
      ...base,
      feature: "coach-chat",
      transcript: formatTranscript(long),
      clock: { ...hubClock, nowMs },
    });
    const monday = coach(Date.parse("2026-10-12T09:00:00Z"));
    const wednesday = coach(Date.parse("2026-10-14T23:59:00Z"));
    expect(monday.coachTranscriptOmittedChars).toBeGreaterThan(0);
    expect(wednesday.coachTranscriptOmittedChars).toBe(monday.coachTranscriptOmittedChars);
    expect(wednesday.userBlocks.slice(0, -1)).toEqual(monday.userBlocks.slice(0, -1));
  });
});

describe("a client's transcript in UTC (fansly-chat E168)", () => {
  const clientContext = {
    transcript: "--- 2026-10-14 ---\n[21:30] Fan: good night",
    messageCount: 1,
    fanDisplayName: "Bob",
  };
  const wireBody = (extra: Record<string, unknown>) => ({
    clientRequestId: "5f0c9d5e-3b6a-4d3e-9a10-6a3d2b1c0e9f",
    pageLabel: "lora-1",
    platform: "fansly",
    conversationRef: "123",
    clientContext: { ...clientContext, ...extra },
  });

  it("is an optional contract field that takes utc only", () => {
    expect(aiFeatureStreamBodySchema.safeParse(wireBody({ transcriptClock: "utc" })).success).toBe(true);
    // A released client that never sends it stays valid.
    expect(aiFeatureStreamBodySchema.safeParse(wireBody({})).success).toBe(true);
    for (const transcriptClock of ["UTC", "device", "local", "", null, true]) {
      expect(aiFeatureStreamBodySchema.safeParse(wireBody({ transcriptClock })).success, String(transcriptClock)).toBe(false);
    }
  });

  it("makes the Now line call the client's transcript UTC; without it, the device's clock", () => {
    expect(promptTranscriptClock({})).toBe("utc");
    expect(promptTranscriptClock({ clientContext: { ...clientContext, fanSpendingData: "", fanSubscriptionData: "", transcriptClock: "utc" } })).toBe("utc");
    expect(promptTranscriptClock({ clientContext: { ...clientContext, fanSpendingData: "", fanSubscriptionData: "" } })).toBe("client");
  });
});

describe("persona local time", () => {
  it("places Lora in Minsk and guesses for no one else", () => {
    expect(personaLocalTime(BUNDLED_LORA_PERSONALITY_ID)).toEqual({ place: "Minsk", timeZone: "Europe/Minsk" });
    for (const key of ["ari", "lora", "", "__proto__", "toString", "constructor"]) {
      expect(personaLocalTime(key), key).toBeUndefined();
    }
  });
});
