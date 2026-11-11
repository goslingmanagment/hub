import { describe, expect, it } from "vitest";

import { plainNote } from "../packages/ui/src/shiftReports.ts";

/**
 * The team's agent writes its notes in Markdown out of habit. Workboard shows them as text, so the marks would show:
 * «**Фан / fan_1** (page-a) …». The emphasis and code marks go; the words, and any lone mark that is part of them, stay.
 */
describe("plainNote", () => {
  it("drops bold, underscore emphasis and code marks, keeps the words", () => {
    expect(plainNote("**Фан / fan_1** (page-a). Кастом `$400`, решает __владелец__.")).toBe("Фан / fan_1 (page-a). Кастом $400, решает владелец.");
  });

  it("keeps a lone asterisk, a snake_case name and a multiplication", () => {
    expect(plainNote("2 * 3 = 6, user_name_here, рейтинг 5*")).toBe("2 * 3 = 6, user_name_here, рейтинг 5*");
  });

  it("leaves plain text and an empty note as they are", () => {
    expect(plainNote("Обычный текст без разметки.")).toBe("Обычный текст без разметки.");
    expect(plainNote("   ")).toBe("");
  });

  it("handles several marks in one note and across lines", () => {
    expect(plainNote("**A** и **B**\n**C** на второй строке")).toBe("A и B\nC на второй строке");
  });
});
