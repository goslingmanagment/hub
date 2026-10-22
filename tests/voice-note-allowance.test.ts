import { describe, expect, it } from "vitest";

import { voiceCharBudgetDay } from "@agency_hub_core/db";
import { createLogger } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { computeVoiceNoteAllowance } from "../apps/runtime/src/services/voice-char-budget.ts";
import type { StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// GET /api/v1/pages/:pageLabel/voice-notes/allowance: a page's voice-note
// limits and what is left of today's characters. The two counters come from
// readVoiceCharBudgetSpent (the reserve's scopes and UTC day); the math over
// them and the route's place in the router are pinned here, with no database.

const EFFECTIVE = {
  voiceNotesScriptMaxChars: 600,
  voiceNotesDailyCharBudget: 5000,
  voiceNotesGlobalDailyCharBudget: 20_000,
};
const NOON = new Date("2026-10-22T12:00:00.000Z");

function allowance(pageSpentChars: number, globalSpentChars: number, now = NOON) {
  return computeVoiceNoteAllowance({ effective: EFFECTIVE, spent: { pageSpentChars, globalSpentChars }, now });
}

describe("voice-note allowance", () => {
  it("leaves the smaller of the page's and the account's headroom, never below zero, until the next UTC midnight", () => {
    // Nothing spent today (no counter row reads as 0): the page's whole ceiling.
    expect(allowance(0, 0)).toEqual({
      scriptMaxChars: 600,
      dailyChars: 5000,
      remainingChars: 5000,
      resetsAt: "2026-10-23T00:00:00.000Z",
    });
    // The page's own headroom is the smaller one.
    expect(allowance(4800, 6000).remainingChars).toBe(200);
    // The account's is: other pages spent most of the global day.
    expect(allowance(100, 19_950).remainingChars).toBe(50);
    // A counter above its ceiling (a render settled to the vendor's count, a
    // ceiling lowered live) leaves nothing, never a negative count.
    expect(allowance(5200, 5200).remainingChars).toBe(0);
    expect(allowance(0, 20_400).remainingChars).toBe(0);

    // The counters' day ends at UTC midnight: its last instant still counts on
    // it, the next instant starts a fresh day, which resets a day later.
    expect(voiceCharBudgetDay(new Date("2026-10-22T23:59:59.999Z")))
      .toEqual({ utcDay: "2026-10-22", resetsAt: new Date("2026-10-23T00:00:00.000Z") });
    expect(voiceCharBudgetDay(new Date("2026-10-23T00:00:00.000Z")))
      .toEqual({ utcDay: "2026-10-23", resetsAt: new Date("2026-10-24T00:00:00.000Z") });
    expect(allowance(0, 0, new Date("2026-12-31T23:59:59.999Z")).resetsAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("routes …/voice-notes/allowance to its own route, ahead of a voice note's numeric id", async () => {
    const server = await buildApiServer(createTestAppContext({
      db: {} as never,
      pool: {} as never,
      logger: createLogger("silent"),
    } as unknown as StartedTestDatabase));
    const matched: Record<string, string | undefined> = {};
    server.addHook("onResponse", async (request) => {
      matched[request.url] = request.routeOptions.config.hubAuthPolicy?.key;
    });
    try {
      for (const url of [
        "/api/v1/pages/lora-of/voice-notes/allowance",
        "/api/v1/pages/lora-of/voice-notes/12",
        "/api/v1/pages/lora-of/voice-notes/12/audio",
      ]) {
        // No credentials: the auth hook answers before any handler or read.
        expect((await server.inject({ method: "GET", url })).statusCode, url).toBe(401);
      }
    } finally {
      await server.close();
    }
    expect(matched).toEqual({
      "/api/v1/pages/lora-of/voice-notes/allowance": "voiceNoteAllowance",
      "/api/v1/pages/lora-of/voice-notes/12": "voiceNoteStatus",
      "/api/v1/pages/lora-of/voice-notes/12/audio": "voiceNoteAudio",
    });
  });
});
