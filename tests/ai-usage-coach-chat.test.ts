import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { aiUsageFeatures } from "@agency_hub_core/shared";

describe("coach-chat ledger registration", () => {
  it("is a ledger feature", () => {
    expect(aiUsageFeatures).toContain("coach-chat");
  });

  it("has a DB enum migration", () => {
    const sql = readFileSync(
      "packages/db/migrations/0105_ai_usage_feature_coach_chat.sql",
      "utf8",
    );
    expect(sql).toMatch(
      /alter type "ai_usage_feature" add value if not exists 'coach-chat';/i,
    );
  });
});
