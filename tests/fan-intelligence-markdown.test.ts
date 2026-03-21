import { describe, expect, it } from "vitest";

import {
  FanIntelligenceMarkdown,
  FanIntelligenceMarkdownRenderer,
} from "../apps/dashboard/src/components/page/FanIntelligenceMarkdown";

describe("FanIntelligenceMarkdown", () => {
  it("wraps markdown in a styled div without passing className to ReactMarkdown", () => {
    const body = "## Fan Summary\n\n- High spender";
    const element = FanIntelligenceMarkdown({ body }) as {
      type: unknown;
      props: {
        className?: string;
        children: {
          type: unknown;
          props: Record<string, unknown>;
        };
      };
    };

    expect(element.type).toBe("div");
    expect(element.props.className).toBe("fan-intelligence-markdown");
    expect(element.props.children.type).toBe(FanIntelligenceMarkdownRenderer);
    expect(element.props.children.props.children).toBe(body);
    expect(element.props.children.props).not.toHaveProperty("className");
  });
});
