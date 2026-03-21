import { describe, expect, it } from "vitest";

import {
  parseProfileSections,
  isStrategySection,
} from "../apps/dashboard/src/lib/parseFanProfile";

describe("parseProfileSections", () => {
  it("returns full body as preamble when no H2 headings", () => {
    const body = "# Title\n\nSome content\n\n### Subheading\n\nMore content";
    const result = parseProfileSections(body);
    expect(result.preamble).toBe(body);
    expect(result.sections).toEqual([]);
  });

  it("splits body into sections by H2 headings", () => {
    const body = [
      "Preamble text",
      "",
      "## 1. ДОСЬЕ",
      "",
      "Dossier content here",
      "",
      "## 2. ПОРТРЕТ",
      "",
      "Portrait content here",
      "",
      "## 3. СТРАТЕГИЯ",
      "",
      "Strategy content here",
    ].join("\n");

    const result = parseProfileSections(body);
    expect(result.preamble).toBe("Preamble text");
    expect(result.sections).toHaveLength(3);
    expect(result.sections[0].heading).toBe("1. ДОСЬЕ");
    expect(result.sections[0].content).toContain("Dossier content here");
    expect(result.sections[1].heading).toBe("2. ПОРТРЕТ");
    expect(result.sections[1].content).toContain("Portrait content here");
    expect(result.sections[2].heading).toBe("3. СТРАТЕГИЯ");
    expect(result.sections[2].content).toContain("Strategy content here");
  });

  it("returns null preamble when H2 is the first line", () => {
    const body = "## Section One\n\nContent";
    const result = parseProfileSections(body);
    expect(result.preamble).toBeNull();
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].heading).toBe("Section One");
    expect(result.sections[0].content).toBe("Content");
  });

  it("handles single H2 section", () => {
    const body = "## Only Section\n\n- item one\n- item two";
    const result = parseProfileSections(body);
    expect(result.preamble).toBeNull();
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].content).toContain("- item one");
  });

  it("preserves H3 headings within H2 sections", () => {
    const body = "## Parent\n\n### Child\n\nNested content\n\n## Next";
    const result = parseProfileSections(body);
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].content).toContain("### Child");
    expect(result.sections[0].content).toContain("Nested content");
  });

  it("handles ATX closing hashes in H2 headings", () => {
    const body = "## Heading ##\n\nContent";
    const result = parseProfileSections(body);
    expect(result.sections[0].heading).toBe("Heading");
  });

  it("trims whitespace from heading text", () => {
    const body = "##   Spaced Heading  \n\nContent";
    const result = parseProfileSections(body);
    expect(result.sections[0].heading).toBe("Spaced Heading");
  });
});

describe("isStrategySection", () => {
  it("matches '3. СТРАТЕГИЯ'", () => {
    expect(isStrategySection("3. СТРАТЕГИЯ")).toBe(true);
  });

  it("matches 'СТРАТЕГИЯ' without prefix", () => {
    expect(isStrategySection("СТРАТЕГИЯ")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isStrategySection("Стратегия")).toBe(true);
  });

  it("matches English 'Strategy'", () => {
    expect(isStrategySection("Strategy")).toBe(true);
    expect(isStrategySection("3. Strategy")).toBe(true);
  });

  it("does not match unrelated headings", () => {
    expect(isStrategySection("1. ДОСЬЕ")).toBe(false);
    expect(isStrategySection("Portrait")).toBe(false);
  });
});
