import { describe, expect, it } from "vitest";

import {
  fansSearchQuerySchema,
  pageSpenderAutoListQuerySchema,
  pageSpenderAutoListsQuerySchema,
  spenderBatchBodySchema,
  spenderDetailQuerySchema,
  spenderListQuerySchema,
  spenderSeriesQuerySchema,
} from "../packages/contracts/src/routes.ts";

// Audit B5: Zod 4's `.merge()` silently dropped every `superRefine` from the
// composed spender schemas, so the documented 400s never fired. These tests
// pin the cross-field rules on the composed (exported) schemas — the only
// place the rules can be lost again.

const issuePaths = (result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) =>
  result.success ? [] : result.error!.issues.map((issue) => issue.path.join("."));

describe("spender scope cross-field rules", () => {
  it("requires pageLabel for page scope", () => {
    const result = spenderListQuerySchema.safeParse({ scope: "page", period: "7d" });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("pageLabel");
  });

  it("requires modelSlug and platform for model scope", () => {
    const result = spenderListQuerySchema.safeParse({ scope: "model", period: "7d" });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toEqual(expect.arrayContaining(["modelSlug", "platform"]));
  });

  it("requires platform for agency scope", () => {
    const result = spenderListQuerySchema.safeParse({ scope: "agency", period: "7d" });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("platform");
  });

  it("enforces scope rules on fans search (lost by the old merge chain)", () => {
    const result = fansSearchQuerySchema.safeParse({ scope: "page", query: "buyer" });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("pageLabel");
  });

  it("still requires a search query", () => {
    const result = fansSearchQuerySchema.safeParse({ scope: "page", pageLabel: "lana" });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("query");
  });
});

describe("spender period cross-field rules", () => {
  const requiredPeriodSchemas = {
    spenderListQuerySchema,
    spenderDetailQuerySchema,
    spenderSeriesQuerySchema,
  } as const;

  for (const [name, schema] of Object.entries(requiredPeriodSchemas)) {
    it(`${name} rejects period=custom without bounds (was a live 500)`, () => {
      const result = schema.safeParse({ scope: "page", pageLabel: "lana", period: "custom" });
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toEqual(expect.arrayContaining(["from", "to"]));
    });

    it(`${name} rejects from/to on a non-custom period (was a live 200)`, () => {
      const result = schema.safeParse({
        scope: "page",
        pageLabel: "lana",
        period: "7d",
        from: "2026-01-01",
        to: "2026-01-31",
      });
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain("period");
    });

    it(`${name} rejects custom bounds with from after to`, () => {
      const result = schema.safeParse({
        scope: "page",
        pageLabel: "lana",
        period: "custom",
        from: "2026-02-01",
        to: "2026-01-01",
      });
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain("to");
    });

    it(`${name} accepts a valid custom window`, () => {
      const result = schema.safeParse({
        scope: "page",
        pageLabel: "lana",
        period: "custom",
        from: "2026-01-01",
        to: "2026-01-31",
      });
      expect(result.success).toBe(true);
    });
  }

  it("spenderBatchBodySchema enforces the custom rules on its optional period", () => {
    const fans = [{ platform: "fansly", platformUserId: "fan-001" }];

    expect(spenderBatchBodySchema.safeParse({
      scope: "page",
      pageLabel: "lana",
      fans,
    }).success).toBe(true);

    const missingBounds = spenderBatchBodySchema.safeParse({
      scope: "page",
      pageLabel: "lana",
      period: "custom",
      fans,
    });
    expect(missingBounds.success).toBe(false);
    expect(issuePaths(missingBounds)).toEqual(expect.arrayContaining(["from", "to"]));

    const strayBounds = spenderBatchBodySchema.safeParse({
      scope: "page",
      pageLabel: "lana",
      period: "30d",
      from: "2026-01-01",
      to: "2026-01-31",
      fans,
    });
    expect(strayBounds.success).toBe(false);
    expect(issuePaths(strayBounds)).toContain("period");
  });

  it("auto-list query schemas enforce the custom rules", () => {
    const missingBounds = pageSpenderAutoListsQuerySchema.safeParse({ period: "custom" });
    expect(missingBounds.success).toBe(false);
    expect(issuePaths(missingBounds)).toEqual(expect.arrayContaining(["from", "to"]));

    const strayBounds = pageSpenderAutoListQuerySchema.safeParse({
      period: "30d",
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(strayBounds.success).toBe(false);
    expect(issuePaths(strayBounds)).toContain("period");
  });
});
