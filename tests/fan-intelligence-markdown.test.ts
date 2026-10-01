import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  FanIntelligenceMarkdown,
} from "../apps/dashboard/src/components/page/FanIntelligenceMarkdown.tsx";
import { parseProfileSections } from "../apps/dashboard/src/lib/parseFanProfile.ts";

function render(body: string): string {
  return renderToStaticMarkup(createElement(FanIntelligenceMarkdown, { body }));
}

describe("FanIntelligenceMarkdown", () => {
  it("renders flat when no H2 headings are present", () => {
    const html = render("# Title\n\nSome content");
    expect(html).toContain('class="fan-intelligence-markdown"');
    expect(html).not.toContain("aria-expanded");
  });

  it("renders flat when a single H2 heading is present", () => {
    const html = render("## First profile\n\n- warm\n- engaged");
    expect(html).toContain('class="fan-intelligence-markdown"');
    expect(html).not.toContain("aria-expanded");
    expect(html).toContain("warm");
  });

  it("renders accordion when multiple H2 headings are present", () => {
    const html = render("## 1. ДОСЬЕ\n\nContent A\n\n## 2. ПОРТРЕТ\n\nContent B");
    expect(html).toContain("aria-expanded");
    expect(html).toContain("1. ДОСЬЕ");
    expect(html).toContain("2. ПОРТРЕТ");
  });

  it("preserves preamble above accordion sections", () => {
    const html = render("# Анна\n\nIntro text\n\n## A\n\nContent A\n\n## B\n\nContent B");
    expect(html).toContain("Intro text");
    // Preamble wrapped in fan-intelligence-markdown
    expect(html).toContain('class="fan-intelligence-markdown mb-3"');
    expect(html).toContain("aria-expanded");
  });

  it("renders all sections collapsed by default", () => {
    const html = render(
      "## 1. ДОСЬЕ\n\nD\n\n## 2. ПОРТРЕТ\n\nP\n\n## 3. СТРАТЕГИЯ\n\n- hook one",
    );
    expect(html).not.toContain('aria-expanded="true"');
    // Section content should not be rendered when collapsed
    expect(html).not.toContain("hook one");
  });
});

describe("parseProfileSections", () => {
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

    expect(parseProfileSections(body)).toEqual({
      preamble: "Preamble text",
      sections: [
        { heading: "1. ДОСЬЕ", content: "Dossier content here" },
        { heading: "2. ПОРТРЕТ", content: "Portrait content here" },
        { heading: "3. СТРАТЕГИЯ", content: "Strategy content here" },
      ],
    });
  });

  it("preserves H3 headings within H2 sections", () => {
    const { sections } = parseProfileSections("## Parent\n\n### Child\n\nNested content\n\n## Next");
    expect(sections).toHaveLength(2);
    expect(sections[0]?.content).toContain("### Child");
    expect(sections[0]?.content).toContain("Nested content");
  });

  it("handles ATX closing hashes in H2 headings", () => {
    expect(parseProfileSections("## Heading ##\n\nContent").sections[0]?.heading).toBe("Heading");
  });

  it("trims whitespace from heading text", () => {
    expect(parseProfileSections("##   Spaced Heading  \n\nContent").sections[0]?.heading).toBe("Spaced Heading");
  });
});
