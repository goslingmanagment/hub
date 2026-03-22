import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  FanIntelligenceMarkdown,
  FanIntelligenceMarkdownRenderer,
} from "../apps/dashboard/src/components/page/FanIntelligenceMarkdown.tsx";

function render(body: string): string {
  return renderToStaticMarkup(createElement(FanIntelligenceMarkdown, { body }));
}

describe("FanIntelligenceMarkdown", () => {
  it("exports FanIntelligenceMarkdownRenderer as ReactMarkdown", () => {
    expect(FanIntelligenceMarkdownRenderer).toBeDefined();
    expect(typeof FanIntelligenceMarkdownRenderer).toBe("function");
  });

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
